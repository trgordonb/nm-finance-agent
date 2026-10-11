import { useCallback, useEffect, useMemo, useState } from "react";
import { Activity, Maximize2, Minimize2, RotateCw, Search, Trash2 } from "lucide-react";
import type { NativeIndicatorInfo } from "@luxalgo/vela";
import { fetchBars, type Bar, type ChartSpec, type IndicatorSpec } from "./yahoo";
import { VelaChart } from "./VelaChart";

type Props = { spec: ChartSpec };

function subtitle(spec: ChartSpec): string {
  const parts = [spec.interval, spec.from ?? spec.range ?? ""];
  if (spec.extended) parts.push("ext");
  return parts.filter(Boolean).join(" · ");
}

export function ChartCard({ spec }: Props) {
  // Markdown re-renders on every stream event; key the fetch and the chart
  // mount off the serialized spec so identity churn can't refetch or remount.
  const specKey = JSON.stringify(spec);
  const stableSpec = useMemo(() => JSON.parse(specKey) as ChartSpec, [specKey]);
  const [bars, setBars] = useState<Bar[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  // Picker-added / -removed indicators survive reloads (bars change) but reset
  // with a new spec, where the block's own `indicators=` list is authoritative.
  const [api, setApi] = useState<{ catalog: () => Promise<NativeIndicatorInfo[]> } | null>(null);
  const [userIndicators, setUserIndicators] = useState<IndicatorSpec[]>([]);
  const [removedTypes, setRemovedTypes] = useState<Set<string>>(new Set());
  useEffect(() => {
    setUserIndicators([]);
    setRemovedTypes(new Set());
  }, [specKey]);

  const effectiveIndicators = useMemo(() => {
    const merged: IndicatorSpec[] = [];
    const seen = new Set<string>();
    for (const ind of [...stableSpec.indicators, ...userIndicators]) {
      if (removedTypes.has(ind.type) || seen.has(ind.type)) continue;
      seen.add(ind.type);
      merged.push(ind);
    }
    return merged;
  }, [stableSpec, userIndicators, removedTypes]);

  useEffect(() => {
    const ctrl = new AbortController();
    setBars(null);
    setError(null);
    fetchBars(stableSpec, ctrl.signal)
      .then(setBars)
      .catch((e) => {
        if (!ctrl.signal.aborted) setError(e instanceof Error ? e.message : String(e));
      });
    return () => ctrl.abort();
  }, [stableSpec, reloadKey]);

  // --- indicator picker --------------------------------------------------------

  const [pickerOpen, setPickerOpen] = useState(false);
  const [catalog, setCatalog] = useState<NativeIndicatorInfo[] | null>(null);
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (!expanded && !pickerOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (pickerOpen) setPickerOpen(false);
      else setExpanded(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [expanded, pickerOpen]);

  const openPicker = () => {
    setPickerOpen(true);
    if (!catalog && api) {
      api
        .catalog()
        .then(setCatalog)
        .catch(() => setCatalog([]));
    }
  };

  const addIndicator = (info: NativeIndicatorInfo) => {
    setRemovedTypes((prev) => {
      if (!prev.has(info.type)) return prev;
      const next = new Set(prev);
      next.delete(info.type);
      return next;
    });
    setUserIndicators((prev) =>
      prev.some((i) => i.type === info.type) || stableSpec.indicators.some((i) => i.type === info.type)
        ? prev
        : [...prev, { type: info.type }],
    );
  };

  const removeIndicator = (type: string) => {
    setRemovedTypes((prev) => new Set(prev).add(type));
  };

  const titleOf = useCallback(
    (type: string) => catalog?.find((c) => c.type === type)?.title ?? type,
    [catalog],
  );

  const q = query.trim().toLowerCase();
  const pickableCatalog = (catalog ?? []).filter(
    (c) =>
      !effectiveIndicators.some((ind) => ind.type === c.type) &&
      (!q || c.title.toLowerCase().includes(q) || c.type.includes(q)),
  );

  const picker = pickerOpen && (
    <>
      <div className="indicator-backdrop" onClick={() => setPickerOpen(false)} />
      <div className="indicator-pop">
        <div className="indicator-pop-search">
          <Search size={12} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search indicators…"
            autoFocus
          />
        </div>
        {effectiveIndicators.length > 0 && (
          <>
            <div className="indicator-pop-label">on chart · {effectiveIndicators.length}</div>
            {effectiveIndicators.map((ind) => (
              <div key={ind.type} className="indicator-pop-row">
                <span>{titleOf(ind.type)}</span>
                <button
                  className="indicator-pop-x"
                  aria-label={`remove ${titleOf(ind.type)}`}
                  onClick={() => removeIndicator(ind.type)}
                >
                  <Trash2 size={12} />
                </button>
              </div>
            ))}
          </>
        )}
        <div className="indicator-pop-label">built-in</div>
        {catalog === null ? (
          <div className="indicator-pop-row dim">loading catalog…</div>
        ) : pickableCatalog.length === 0 ? (
          <div className="indicator-pop-row dim">no matches</div>
        ) : (
          pickableCatalog.map((info) => (
            <button
              key={info.type}
              className="indicator-pop-row add"
              disabled={!info.supported}
              onClick={() => addIndicator(info)}
            >
              <span>{info.title}</span>
              {!info.supported && <span className="unsupported">n/a</span>}
            </button>
          ))
        )}
      </div>
    </>
  );

  const head = (view: "inline" | "overlay") => {
    const pickerHere = (view === "overlay") === expanded;
    return (
      <div className="chart-card-head">
        <span className="sym">{stableSpec.symbol}</span>
        <span>{subtitle(stableSpec)}</span>
        {effectiveIndicators.length > 0 && (
          <span className="chart-ind-badge">
            {effectiveIndicators.map((i) => i.type).join(" · ")}
          </span>
        )}
        <button
          className="chart-btn indicator-btn"
          title="indicators"
          disabled={!api}
          onClick={() => (pickerOpen ? setPickerOpen(false) : openPicker())}
        >
          <Activity size={13} />
          Indicators
        </button>
        <button
          className="chart-btn"
          title="reload data"
          onClick={() => setReloadKey((k) => k + 1)}
        >
          <RotateCw size={13} />
        </button>
        <button
          className="chart-btn"
          title={expanded ? "collapse (Esc)" : "expand"}
          aria-label={expanded ? "collapse chart" : "expand chart"}
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
        </button>
        {pickerHere && picker}
      </div>
    );
  };

  const body = bars ? (
    <VelaChart
      className="chart-mount"
      bars={bars}
      interval={stableSpec.interval}
      indicators={effectiveIndicators}
      visible={stableSpec.visible}
      onApi={setApi}
    />
  ) : (
    <div className={`chart-state${error ? " error" : ""}`}>
      {error ?? `loading ${stableSpec.symbol}…`}
    </div>
  );

  return (
    <div className="chart-card">
      {head("inline")}
      <div className="chart-card-body">{expanded ? null : body}</div>
      {expanded && (
        <div
          className="chart-overlay"
          onClick={(e) => {
            if (e.target === e.currentTarget) setExpanded(false);
          }}
        >
          <div className="chart-card">
            {head("overlay")}
            <div className="chart-card-body">{body}</div>
          </div>
        </div>
      )}
    </div>
  );
}
