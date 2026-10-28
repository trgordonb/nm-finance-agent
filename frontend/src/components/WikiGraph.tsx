// WikiGraph: the current scope's link graph, derived client-side from page
// bodies ([[wikilinks]] — which includes the compiler's "## Sources" rows) —
// llmwiki has no graph endpoint. Rendering: graphology + forceatlas2 + sigma,
// dynamically imported so they load only when the graph is opened (the same
// pattern as the vela charts). Reference: the python-era frontend's
// WikiGraph.tsx (docs/wiki-tab-plan.md); sigma is pinned to v3 for that API.

import { useCallback, useEffect, useRef, useState } from "react";
import { LoaderCircle, Maximize, ZoomIn, ZoomOut } from "lucide-react";
import type Graph from "graphology";
import type Sigma from "sigma";
import { getWikiPage } from "../api";
import type { WikiGist, WikiScope } from "../types";
import { useTheme, type ResolvedTheme } from "../theme";

export interface GraphPageRef extends WikiGist {
  domain: string;
}

interface Props {
  refs: GraphPageRef[];
  /** Which wiki the refs came from; page bodies must be read from the same one. */
  scope: WikiScope;
  onOpen: (ref: GraphPageRef) => void;
}

// Sigma paints to a canvas, so CSS variables don't apply — node/edge colors
// come from per-theme palettes and are re-applied to the live instance on
// theme change (no rebuild, so page bodies are never refetched).
interface GraphPalette {
  TYPE_COLORS: Record<string, string>;
  DEFAULT_NODE: string;
  MISSING_NODE: string;
  EDGE: string;
  EDGE_HOVER: string;
  LABEL: string;
  DIM: string;
}

const PALETTES: Record<ResolvedTheme, GraphPalette> = {
  dark: {
    TYPE_COLORS: {
      concept: "#58a6ff",
      entity: "#3fb950",
      source: "#39c5cf",
      overview: "#d29922",
    },
    DEFAULT_NODE: "#c4c0cc",
    MISSING_NODE: "#30363d",
    EDGE: "rgba(230, 237, 243, 0.10)",
    EDGE_HOVER: "rgba(133, 185, 201, 0.85)",
    LABEL: "#8b949e",
    DIM: "#232a33",
  },
  light: {
    TYPE_COLORS: {
      concept: "#0969da",
      entity: "#1a7f37",
      source: "#0f8f99",
      overview: "#9a6700",
    },
    DEFAULT_NODE: "#8c959f",
    MISSING_NODE: "#d1d9e0",
    EDGE: "rgba(31, 35, 40, 0.12)",
    EDGE_HOVER: "rgba(9, 105, 218, 0.85)",
    LABEL: "#59636e",
    DIM: "#d8dee4",
  },
};

function nodeColor(kind: string, palette: GraphPalette): string {
  if (kind === "missing") return palette.MISSING_NODE;
  return palette.TYPE_COLORS[kind] ?? palette.DEFAULT_NODE;
}

function bodyOf(markdown: string): string {
  return markdown.replace(/^---\n[\s\S]*?\n---[ ]*\n?/, "");
}

/** Wikilink targets in a page body; `[[sources/<id>|label]]` normalizes to
 *  the source-note page id it addresses. */
function linkTargets(markdown: string): string[] {
  const targets = new Set<string>();
  for (const match of bodyOf(markdown).matchAll(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g)) {
    const target = match[1].trim().replace(/^sources\//, "");
    // `#anchor` links are intra-page fragments, not pages
    if (target && !target.startsWith("#")) targets.add(target);
  }
  return [...targets];
}

export default function WikiGraph({ refs, scope, onOpen }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const sigmaRef = useRef<Sigma | null>(null);
  const graphRef = useRef<Graph | null>(null);
  const hoveredRef = useRef<string | null>(null);
  const onOpenRef = useRef(onOpen);
  onOpenRef.current = onOpen;
  const { resolved: theme } = useTheme();
  // Reducers run on every refresh, so they must always read the current palette.
  const paletteRef = useRef(PALETTES[theme]);
  paletteRef.current = PALETTES[theme];
  const [building, setBuilding] = useState(true);
  const [error, setError] = useState<string | null>(null);

  /** Re-applies the current palette to the mounted instance; no-op pre-mount. */
  const applyPalette = useCallback(() => {
    const sigma = sigmaRef.current;
    const graph = graphRef.current;
    if (!sigma || !graph) return;
    const palette = paletteRef.current;
    sigma.setSetting("labelColor", { color: palette.LABEL });
    sigma.setSetting("defaultNodeColor", palette.DEFAULT_NODE);
    sigma.setSetting("defaultEdgeColor", palette.EDGE);
    graph.forEachNode((node, attrs) => {
      graph.setNodeAttribute(node, "color", nodeColor(String(attrs.kind ?? ""), palette));
    });
    graph.forEachEdge((edge) => {
      graph.setEdgeAttribute(edge, "color", palette.EDGE);
    });
    sigma.refresh();
  }, []);

  useEffect(() => {
    applyPalette();
  }, [theme, applyPalette]);

  // Camera controls for the overlay buttons; no-ops while the graph mounts.
  const zoomGraph = (direction: 1 | -1) => {
    const camera = sigmaRef.current?.getCamera();
    if (!camera) return;
    const opts = { duration: 200 };
    void (direction === 1 ? camera.animatedZoom(opts) : camera.animatedUnzoom(opts));
  };

  const fitGraph = () => {
    void sigmaRef.current?.getCamera().animatedReset({ duration: 200 });
  };

  useEffect(() => {
    let cancelled = false;
    const container = containerRef.current;
    if (!container) return;
    if (!refs.length) {
      setBuilding(false);
      setError(null);
      return;
    }

    (async () => {
      setBuilding(true);
      setError(null);
      try {
        const [{ default: GraphCtor }, { default: fa2 }, { default: SigmaCtor }, pages] =
          await Promise.all([
            import("graphology"),
            import("graphology-layout-forceatlas2"),
            import("sigma"),
            Promise.all(
              refs.map(async (ref) => {
                try {
                  return { ref, markdown: await getWikiPage(ref.slug, ref.domain, scope) };
                } catch {
                  // an unreadable page is a nodeless entry, not a failed graph
                  return { ref, markdown: "" };
                }
              }),
            ),
          ]);
        if (cancelled) return;

        const refByKey = new Map<string, GraphPageRef>();
        const graph: Graph = new GraphCtor();

        for (const { ref } of pages) {
          const key = `${ref.domain}:${ref.slug}`;
          refByKey.set(key, ref);
          graph.addNode(key, {
            label: ref.title || ref.slug,
            size: 4,
            color: nodeColor(ref.type, paletteRef.current),
            kind: ref.type,
            x: Math.random() * 100,
            y: Math.random() * 100,
          });
        }

        const seenEdges = new Set<string>();
        const missing = (target: string) => {
          const key = `missing:${target}`;
          if (!graph.hasNode(key)) {
            graph.addNode(key, {
              label: target,
              size: 3,
              color: nodeColor("missing", paletteRef.current),
              kind: "missing",
              x: Math.random() * 100,
              y: Math.random() * 100,
            });
          }
          return key;
        };

        for (const { ref, markdown } of pages) {
          const from = `${ref.domain}:${ref.slug}`;
          for (const target of linkTargets(markdown)) {
            if (target === ref.slug) continue;
            let to = `${ref.domain}:${target}`;
            if (!graph.hasNode(to)) {
              // links are not domain-namespaced: same domain first, then any
              // other domain in scope, then a dim "missing" node.
              to = [...refByKey.keys()].find((k) => k.endsWith(`:${target}`)) ?? missing(target);
            }
            const edgeKey = `${from}->${to}`;
            if (from !== to && !seenEdges.has(edgeKey)) {
              seenEdges.add(edgeKey);
              graph.addEdgeWithKey(edgeKey, from, to, {
                size: 0.5,
                color: paletteRef.current.EDGE,
              });
            }
          }
        }

        graph.forEachNode((node) => {
          const degree = graph.degree(node);
          graph.setNodeAttribute(
            node,
            "size",
            Math.max(3, Math.min(14, 3 + Math.sqrt(degree) * 1.8)),
          );
        });

        fa2.assign(graph, {
          iterations: 250,
          settings: { gravity: 1, scalingRatio: 12, adjustSizes: true, slowDown: 4 },
        });
        if (cancelled) return;

        const sigma = new SigmaCtor(graph, container, {
          allowInvalidContainer: true,
          renderLabels: true,
          renderEdgeLabels: false,
          labelColor: { color: paletteRef.current.LABEL },
          labelSize: 11,
          labelRenderedSizeThreshold: 6,
          defaultEdgeColor: paletteRef.current.EDGE,
          defaultNodeColor: paletteRef.current.DEFAULT_NODE,
          stagePadding: 40,
          // Keep wheel + button zoom within sane bounds (ratio: smaller = closer).
          minCameraRatio: 0.05,
          maxCameraRatio: 10,
          nodeReducer(node, data) {
            const active = hoveredRef.current;
            const res = { ...data };
            if (active) {
              const isActive = node === active;
              const isNeighbor = graph.hasEdge(active, node) || graph.hasEdge(node, active);
              if (isActive) {
                res.zIndex = 2;
                res.size = (res.size ?? 4) * 1.35;
              } else if (isNeighbor) {
                res.zIndex = 1;
              } else {
                res.color = paletteRef.current.DIM;
                res.label = "";
              }
            }
            return res;
          },
          edgeReducer(edge, data) {
            const active = hoveredRef.current;
            const res = { ...data };
            if (active) {
              const source = graph.source(edge);
              const target = graph.target(edge);
              if (source === active || target === active) {
                res.color = paletteRef.current.EDGE_HOVER;
                res.size = 1;
              } else {
                res.hidden = true;
              }
            }
            return res;
          },
        });
        sigmaRef.current = sigma;
        graphRef.current = graph;
        setBuilding(false);
        // Enforce the current palette even if the theme flipped mid-build.
        applyPalette();

        sigma.on("enterNode", ({ node }) => {
          hoveredRef.current = node;
          container.style.cursor = "pointer";
          sigma.refresh();
        });
        sigma.on("leaveNode", () => {
          hoveredRef.current = null;
          container.style.cursor = "default";
          sigma.refresh();
        });
        sigma.on("clickNode", ({ node }) => {
          const ref = refByKey.get(node);
          if (ref) onOpenRef.current(ref);
        });
      } catch (err) {
        if (!cancelled) {
          setError(`graph build failed: ${(err as Error).message}`);
          setBuilding(false);
        }
      }
    })();

    return () => {
      cancelled = true;
      hoveredRef.current = null;
      sigmaRef.current?.kill();
      sigmaRef.current = null;
      graphRef.current = null;
    };
  }, [refs, scope]);

  return (
    <div className="wiki-graph">
      <div ref={containerRef} className="wiki-graph-canvas" />
      <div className="wiki-graph-controls">
        <button
          className="wiki-graph-btn"
          title="Zoom in"
          aria-label="Zoom in"
          disabled={building}
          onClick={() => zoomGraph(1)}
        >
          <ZoomIn size={14} />
        </button>
        <button
          className="wiki-graph-btn"
          title="Zoom out"
          aria-label="Zoom out"
          disabled={building}
          onClick={() => zoomGraph(-1)}
        >
          <ZoomOut size={14} />
        </button>
        <button
          className="wiki-graph-btn"
          title="Fit view"
          aria-label="Fit view"
          disabled={building}
          onClick={fitGraph}
        >
          <Maximize size={14} />
        </button>
      </div>
      {building && (
        <div className="wiki-status wiki-graph-overlay">
          <LoaderCircle className="wiki-spin" size={16} /> building graph ({refs.length} pages)…
        </div>
      )}
      {error && <div className="wiki-error wiki-graph-overlay">{error}</div>}
      {!building && !error && refs.length === 0 && (
        <div className="wiki-status wiki-graph-overlay">nothing to graph yet</div>
      )}
    </div>
  );
}
