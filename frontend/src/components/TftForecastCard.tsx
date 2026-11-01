// Inline card for ```tft-forecast fenced blocks: renders a trained TFT
// model's artifacts (quantile path + history + walk-forward evaluation) from
// the user's workspace. Fetched through the scoped /api/workspace/json read —
// no raw HTML, everything rendered as React/data.

import { useEffect, useMemo, useState } from "react";
import { Maximize2, Minimize2 } from "lucide-react";
import { VelaChart } from "../charts/VelaChart";
import type { Bar } from "../charts/yahoo";

export interface TftForecastSpec {
  path: string; // forecast.json, workspace-relative
  evalPath?: string; // evaluation.json, workspace-relative
  ticker?: string;
}

interface ForecastPoint {
  date: string;
  q10: number;
  q50: number;
  q90: number;
}

interface ForecastPayload {
  ticker?: string;
  as_of?: string;
  last_close?: number;
  path: ForecastPoint[];
  history?: Array<{ time: number; open: number; high: number; low: number; close: number; volume?: number }>;
  smoke?: boolean;
}

interface EvalPayload {
  in_sample?: Record<string, Record<string, number>>;
  out_of_sample?: Record<string, Record<string, number>>;
}

const HORIZON_LABELS: Record<string, string> = {
  "1": "1 day", "5": "1 week", "21": "1 month", "63": "3 months", "126": "6 months", "252": "1 year",
};

/** History candles as-is; each forecast point becomes a bar whose close
 *  tracks the median (q50) path and whose wick spans the 10–90% band. */
function buildBars(payload: ForecastPayload): Bar[] {
  const bars: Bar[] = (payload.history ?? [])
    .filter((b) => b.close != null)
    .map((b) => ({ time: b.time, open: b.open, high: b.high, low: b.low, close: b.close }));
  bars.sort((a, b) => a.time - b.time);
  let prevClose = payload.last_close ?? bars[bars.length - 1]?.close ?? 0;
  for (const point of payload.path ?? []) {
    const t = Date.parse(`${point.date}T00:00:00Z`);
    if (Number.isNaN(t)) continue;
    bars.push({
      time: t,
      open: Math.round(prevClose * 100) / 100,
      high: Math.round(point.q90 * 100) / 100,
      low: Math.round(point.q10 * 100) / 100,
      close: Math.round(point.q50 * 100) / 100,
    });
    prevClose = point.q50;
  }
  return bars;
}

function evalRows(evaluation: EvalPayload | null): Array<{ split: string; horizon: string; m: Record<string, number> }> {
  const rows: Array<{ split: string; horizon: string; m: Record<string, number> }> = [];
  if (!evaluation) return rows;
  for (const [split, label] of [
    ["in_sample", "In-sample"],
    ["out_of_sample", "Out-of-sample"],
  ] as const) {
    const horizons = evaluation[split] ?? {};
    const byHorizon = (horizons as { by_horizon?: Record<string, Record<string, number>> }).by_horizon ?? horizons;
    for (const horizon of Object.keys(byHorizon).sort((a, b) => Number(a) - Number(b))) {
      rows.push({ split: label, horizon: HORIZON_LABELS[horizon] ?? horizon, m: byHorizon[horizon] });
    }
  }
  return rows;
}

export function TftForecastCard({ spec }: { spec: TftForecastSpec }) {
  const specKey = JSON.stringify(spec);
  const [forecast, setForecast] = useState<ForecastPayload | null>(null);
  const [evaluation, setEvaluation] = useState<EvalPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    const ctrl = new AbortController();
    setForecast(null);
    setEvaluation(null);
    setError(null);
    fetch(`/api/workspace/json?path=${encodeURIComponent(spec.path)}`, { signal: ctrl.signal })
      .then(async (r) => (r.ok ? r.json() : Promise.reject(new Error((await r.json()).detail ?? `HTTP ${r.status}`))))
      .then(setForecast)
      .catch((e) => !ctrl.signal.aborted && setError(e instanceof Error ? e.message : String(e)));
    if (spec.evalPath) {
      fetch(`/api/workspace/json?path=${encodeURIComponent(spec.evalPath)}`, { signal: ctrl.signal })
        .then(async (r) => (r.ok ? r.json() : null))
        .then(setEvaluation)
        .catch(() => undefined);
    }
    return () => ctrl.abort();
  }, [specKey]);

  const bars = useMemo(() => (forecast ? buildBars(forecast) : []), [forecast]);
  const rows = useMemo(() => evalRows(evaluation), [evaluation]);
  const ticker = (spec.ticker || forecast?.ticker || "TICKER").toUpperCase();
  const lastPoint = forecast?.path?.[forecast.path.length - 1];
  const firstPoint = forecast?.path?.[0];
  const lastClose = forecast?.last_close;

  const body = error ? (
    <div className="tft-err">{error}</div>
  ) : !forecast ? (
    <div className="tft-loading">loading forecast artifacts…</div>
  ) : (
    <>
      <div className="tft-summary">
        {forecast.smoke
          ? "⚠ smoke artifacts — not a usable forecast; re-train without --smoke."
          : `As of ${forecast.as_of ?? "?"}: last close $${lastClose?.toFixed(2) ?? "—"} → 1-year median $${lastPoint?.q50?.toFixed(2) ?? "—"} (10–90% band $${firstPoint?.q10?.toFixed(0) ?? "?"}–$${lastPoint?.q90?.toFixed(0) ?? "?"} on day 1).`}
      </div>
      {bars.length > 0 && <VelaChart className="tft-mount" bars={bars} interval="1d" />}
      {rows.length > 0 && (
        <table className="tft-table">
          <tr style={{ color: "#8b949e", textAlign: "left" }}>
            <th style={{ padding: "4px 12px" }}>Split</th>
            <th style={{ padding: "4px 12px" }}>Horizon</th>
            <th style={{ padding: "4px 12px" }}>Direction</th>
            <th style={{ padding: "4px 12px" }}>10–90% coverage</th>
            <th style={{ padding: "4px 12px" }}>Sharpe</th>
            <th style={{ padding: "4px 12px" }}>Max DD</th>
            <th style={{ padding: "4px 12px" }}>Trades</th>
          </tr>
          {rows.map((r, i) => (
            <tr key={i}>
              <td>{r.split}</td>
              <td>{r.horizon}</td>
              <td>{(r.m.directional_accuracy ?? 0) * 100}%</td>
              <td>{(r.m.quantile_coverage ?? 0) * 100}%</td>
              <td>{(r.m.sharpe ?? 0).toFixed(2)}</td>
              <td>{(r.m.max_drawdown ?? 0) * 100}%</td>
              <td>{r.m.n_trades ?? 0}</td>
            </tr>
          ))}
        </table>
      )}
    </>
  );

  return (
    <div className={`chart-card tft-card${expanded ? " expanded" : ""}`}>
      <div className="chart-card-head">
        <span className="sym">{ticker} · TFT</span>
        <span>forecast + walk-forward</span>
        <button
          className="chart-btn"
          title={expanded ? "collapse (Esc)" : "expand"}
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
        </button>
      </div>
      <div className="chart-card-body">{body}</div>
    </div>
  );
}
