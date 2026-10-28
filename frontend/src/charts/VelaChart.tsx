import { useCallback, useEffect, useRef } from "react";
import type { IndicatorHandle, NativeIndicatorInfo, Vela } from "@luxalgo/vela";
import type { Bar, IndicatorSpec } from "./yahoo";
import { VELA_TIMEFRAME } from "./yahoo";
import { useTheme } from "../theme";

type Props = {
  bars: Bar[];
  interval: string;
  indicators?: IndicatorSpec[];
  visible?: number;
  className?: string;
  /** Live chart access for host UI (indicator picker). Stable identity not required. */
  onApi?: (api: { catalog: () => Promise<NativeIndicatorInfo[]> } | null) => void;
};

// Imperative Vela mount: the ~1 MB renderer is dynamically imported so it only
// loads when a chart is actually shown. StrictMode double-mounts effects in
// dev — destroy() in cleanup makes that safe. The `indicators` prop is synced
// incrementally (add/remove in place) so picker edits never remount the chart.
export function VelaChart({ bars, interval, indicators = [], visible, className, onApi }: Props) {
  const elRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<Vela | null>(null);
  const handlesRef = useRef(new Map<string, IndicatorHandle>());
  const { resolved: theme } = useTheme();
  // Latest props for async/late consumers (mount completes after create; the
  // sync effect must see the newest list even if the chart isn't up yet).
  const latestRef = useRef({ indicators, visible });
  latestRef.current = { indicators, visible };
  const onApiRef = useRef(onApi);
  onApiRef.current = onApi;

  const syncIndicators = useCallback(async () => {
    const chart = chartRef.current;
    if (!chart) return; // still mounting — the mount path applies latestRef
    const wanted = latestRef.current.indicators;
    const wantedTypes = new Set(wanted.map((i) => i.type));
    for (const [type, handle] of [...handlesRef.current]) {
      if (wantedTypes.has(type)) continue;
      try {
        handle.remove();
      } catch (e) {
        console.warn(`indicator ${type} removal failed:`, e);
      }
      handlesRef.current.delete(type);
    }
    for (const spec of wanted) {
      if (handlesRef.current.has(spec.type)) continue;
      try {
        const handle = chart.addNativeIndicator(spec.type, spec.inputs ? { inputs: spec.inputs } : {});
        handlesRef.current.set(spec.type, handle);
      } catch (e) {
        console.warn(`indicator ${spec.type} failed:`, e);
      }
    }
  }, []);

  useEffect(() => {
    const el = elRef.current;
    if (!el || bars.length === 0) return;
    let alive = true;
    (async () => {
      const { Vela } = await import("@luxalgo/vela");
      if (!alive || !elRef.current) return;
      const chart = new Vela(elRef.current, {
        data: bars,
        timeframe: VELA_TIMEFRAME[interval] ?? interval,
        theme,
      });
      chartRef.current = chart;
      onApiRef.current?.({ catalog: () => chart.availableNativeIndicators() });
      await chart.ready();
      if (!alive) return;
      await syncIndicators();
      const vis = latestRef.current.visible;
      if (vis && bars.length > vis) {
        chart.setVisibleRange({ from: bars[bars.length - vis].time, to: bars[bars.length - 1].time });
      }
    })().catch((e) => console.warn("chart mount failed:", e));

    return () => {
      alive = false;
      onApiRef.current?.(null);
      handlesRef.current.clear();
      chartRef.current?.destroy();
      chartRef.current = null;
    };
  }, [bars, interval, theme, syncIndicators]);

  useEffect(() => {
    void syncIndicators();
  }, [indicators, syncIndicators]);

  return <div ref={elRef} className={className} />;
}
