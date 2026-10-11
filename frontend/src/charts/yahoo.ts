// Yahoo Finance data through the local /api/yahoo proxy (server.py) — the TS
// port of skills/vela-charts/scripts/render_chart.py's fetch/normalize, so the
// chat chart cards and the offline artifacts follow the exact same contract.

export type Bar = {
  time: number; // epoch ms, bar open
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

const RANGE_DAYS: Record<string, number> = {
  "1d": 1, "5d": 5, "1mo": 30, "3mo": 91, "6mo": 182,
  "1y": 365, "2y": 730, "5y": 1825, "10y": 3650,
};

// Yahoo serves bounded history per intraday interval — clamp like the skill script.
const INTERVAL_CAP_DAYS: Record<string, number> = {
  "1m": 7, "2m": 60, "5m": 60, "15m": 60, "30m": 60, "60m": 60, "90m": 60, "1h": 730,
};

// Yahoo interval → Vela timeframe vocabulary (drives spacing + axis labels).
export const VELA_TIMEFRAME: Record<string, string> = {
  "1m": "1", "2m": "2", "5m": "5", "15m": "15", "30m": "30",
  "60m": "60", "90m": "90", "1h": "1h", "1d": "1d", "5d": "5d",
  "1wk": "1w", "1mo": "1mo", "3mo": "3mo",
};

export type ChartSpec = {
  symbol: string;
  interval: string; // Yahoo vocabulary: 1m…3mo
  range?: string; // 1d…10y | ytd | max
  from?: string; // YYYY-MM-DD
  to?: string;
  indicators: IndicatorSpec[];
  visible?: number;
  extended: boolean;
};

export type IndicatorSpec = { type: string; inputs?: Record<string, number> };

export function parseIndicatorList(spec: string): IndicatorSpec[] {
  const out: IndicatorSpec[] = [];
  for (const part of spec.split(",")) {
    const token = part.trim();
    if (!token) continue;
    const [type, length] = token.split(":");
    const id = type.trim().toLowerCase();
    if (!/^[a-z][a-z0-9-]*$/.test(id)) continue;
    if (out.some((i) => i.type === id)) continue;
    const n = length ? parseInt(length, 10) : NaN;
    out.push(Number.isFinite(n) ? { type: id, inputs: { length: n } } : { type: id });
  }
  return out;
}

function resolveWindow(spec: ChartSpec): { period1: number; period2: number } {
  const now = Date.now();
  const end = spec.to ? new Date(spec.to + "T00:00:00Z").getTime() : now;
  let start: number;
  if (spec.from) {
    start = new Date(spec.from + "T00:00:00Z").getTime();
  } else if (spec.range === "max") {
    start = 0;
  } else if (spec.range === "ytd") {
    start = Date.UTC(new Date(end).getUTCFullYear(), 0, 1);
  } else {
    start = end - (RANGE_DAYS[spec.range ?? "1y"] ?? 365) * 86400_000;
  }
  return { period1: Math.floor(start / 1000), period2: Math.ceil(end / 1000) };
}

type YahooChartPayload = {
  chart: {
    error: { code?: string; description?: string } | null;
    result: Array<{
      timestamp?: number[];
      indicators: {
        quote: Array<Record<"open" | "high" | "low" | "close" | "volume", (number | null)[]>>;
        adjclose?: Array<{ adjclose: (number | null)[] }>;
      };
    }> | null;
  };
};

export async function fetchBars(spec: ChartSpec, signal?: AbortSignal): Promise<Bar[]> {
  const { period1, period2 } = resolveWindow(spec);
  let p1 = period1;
  const capDays = INTERVAL_CAP_DAYS[spec.interval];
  if (capDays && (period2 - period1) / 1000 > capDays * 86400) {
    p1 = period2 - capDays * 86400;
  }
  const params = new URLSearchParams({
    period1: String(p1),
    period2: String(period2),
    interval: spec.interval,
    includePrePost: spec.extended ? "true" : "false",
    events: "div,split",
  });
  const res = await fetch(
    `/api/yahoo/v8/finance/chart/${encodeURIComponent(spec.symbol)}?${params}`,
    { signal },
  );
  if (!res.ok) {
    if (res.status === 429) throw new Error("rate-limited by Yahoo (429) — retry in a minute");
    throw new Error(`proxy returned HTTP ${res.status}`);
  }
  const payload: YahooChartPayload = await res.json();
  const error = payload.chart.error;
  if (error) throw new Error(error.description ?? error.code ?? "yahoo error");
  const result = payload.chart.result?.[0];
  const timestamps = result?.timestamp;
  if (!result || !timestamps?.length) throw new Error("no bars returned — check the symbol or range");

  const quote = result.indicators.quote[0];
  const adj = result.indicators.adjclose?.[0]?.adjclose;
  const bars: Bar[] = [];
  const seen = new Set<number>();
  for (let i = 0; i < timestamps.length; i++) {
    const open = quote.open?.[i];
    const high = quote.high?.[i];
    const low = quote.low?.[i];
    const close = quote.close?.[i];
    if (open == null || high == null || low == null || close == null) continue; // null-padded rows
    let o = open, h = high, l = low, c = close;
    const a = adj?.[i];
    if (a != null && c !== 0) {
      // fold adjclose so OHLC stay mutually consistent (same policy as render_chart.py)
      const ratio = a / c;
      o *= ratio; h *= ratio; l *= ratio; c *= ratio;
    }
    const time = timestamps[i] * 1000;
    if (seen.has(time)) continue;
    seen.add(time);
    bars.push({ time, open: o, high: h, low: l, close: c, volume: quote.volume?.[i] ?? 0 });
  }
  bars.sort((a, b) => a.time - b.time);
  return bars;
}

// "NVDA interval=1d range=6mo indicators=rsi visible=60" — first token is the
// symbol, the rest are key=value pairs; unknown keys are ignored.
export function parseChartSpec(body: string): ChartSpec | null {
  const tokens = body.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;
  const spec: ChartSpec = {
    symbol: tokens[0],
    interval: "1d",
    range: "1y",
    indicators: [],
    extended: false,
  };
  for (const token of tokens.slice(1)) {
    const eq = token.indexOf("=");
    if (eq <= 0) continue;
    const key = token.slice(0, eq).toLowerCase();
    const value = token.slice(eq + 1);
    if (key === "interval") spec.interval = value;
    else if (key === "range") spec.range = value;
    else if (key === "from") { spec.from = value; spec.range = undefined; }
    else if (key === "to") spec.to = value;
    else if (key === "indicators") spec.indicators = parseIndicatorList(value);
    else if (key === "visible") spec.visible = parseInt(value, 10) || undefined;
    else if (key === "extended") spec.extended = value === "" || value === "true" || value === "1";
  }
  return spec;
}
