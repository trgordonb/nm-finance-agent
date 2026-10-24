// session_search: hybrid episodic recall.
// Base leg: the driver's keyword search (SQLite FTS5 chain: strict AND → OR →
// LIKE). Optional semantic leg: the agentdb mirror's dense recall. Lists fuse
// via Reciprocal Rank Fusion (k=60, the same constant as nm-memory-layer's
// wiki hybrid), dedupe near-identical hits, and each result block carries
// retriever tags so consumers can A/B the legs. Failure semantics preserved:
// the tool never throws; empty fused list → explicit empty sentinel.

import type { ToolDef } from "../types.js";
import type { SessionDriver, SessionHit } from "../driver.js";
import type { AgentDbMirror, MirrorHit } from "../agentdb-mirror.js";
import type { SearchSummarizer } from "../summarizer.js";

const RRF_K = 60;

interface RankedHit {
  sessionId: string;
  createdAt: string;
  snippet: string;
  retrievers: string; // "fts" | "semantic(0.83)" | "fts+semantic"
  score: number;
}

function mergeTag(map: Map<string, RankedHit>, hit: RankedHit, leg: string): void {
  const key = `${hit.sessionId}|${hit.createdAt}|${hit.snippet.slice(0, 80).replace(/\s+/g, " ")}`;
  const cur = map.get(key) ?? { ...hit, retrievers: "", score: 0 };
  if (!cur.retrievers.includes(leg.split("(")[0])) {
    cur.retrievers = cur.retrievers ? `${cur.retrievers}+${leg}` : leg;
  }
  cur.score += 1 / (RRF_K + hit.score + 1);
  map.set(key, cur);
}

function fuse(fts: SessionHit[], semantic: MirrorHit[], limit: number): RankedHit[] {
  const map = new Map<string, RankedHit>();
  fts.forEach((h, rank) => {
    mergeTag(map, {
      sessionId: h.session_id,
      createdAt: h.created_at,
      snippet: h.snippet,
      retrievers: "",
      score: rank,
    }, "fts");
  });
  semantic.forEach((h, rank) => {
    if (!h.sessionId || !h.content) return;
    mergeTag(map, {
      sessionId: h.sessionId,
      createdAt: h.createdAt,
      snippet: h.content.slice(0, 400),
      retrievers: "",
      score: rank,
    }, `semantic(${h.similarity.toFixed(2)})`);
  });
  return [...map.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}

function format(hits: RankedHit[]): string {
  return hits
    .map(
      (h, i) =>
        `[${i + 1}] session=${h.sessionId.slice(0, 8)} (${h.createdAt})` +
        (h.retrievers ? ` · ${h.retrievers}` : "") +
        `\n  ${h.snippet.slice(0, 400)}`,
    )
    .join("\n");
}

export function createSessionSearchTool(
  driver: SessionDriver,
  mirror?: AgentDbMirror | null,
  summarizer?: SearchSummarizer | null,
): ToolDef {
  return {
    name: "session_search",
    description:
      "Search YOUR archived past sessions (previous conversations). Call BEFORE redoing work when the " +
      "user's request may relate to prior decisions, findings, errors and fixes, or procedures you already " +
      "worked out. Hybrid keyword+semantic recall returns short excerpts, not full transcripts — cheap to consult.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Free-text search (keywords win over prose)." },
        limit: { type: "number", description: "Max results, default 5." },
      },
      required: ["query"],
    },
    async execute(args, ctx) {
      try {
        const limit = Math.max(1, Math.min(Number(args.limit ?? 5) || 5, 20));
        const query = String(args.query ?? "");
        const fetchLimit = Math.max(limit * 2, 8); // extra candidates per leg for the fusion
        const fts = driver.search(query, fetchLimit);
        const semanticAll = mirror?.status.enabled ? await mirror.search(query, fetchLimit) : [];
        // The mirror is process-wide; keep only sessions this login owns.
        const semantic = semanticAll.filter((h) => h.sessionId && driver.ownsSession(h.sessionId));
        if (!fts.length && !semantic.length) return "No past session matches found.";

        // RRF fusion runs over both legs (a single leg degenerates to its
        // own ordering) — one ordered candidate list for summarizer + output.
        const fused = fuse(fts, semantic, Math.max(limit, 8));
        if (!fused.length) return "No past session matches found.";

        // Hermes-style: the condensed form walks one cheap LLM pass over the
        // fused extras (>=8) with an observability header. Any failure
        // silently falls back to the raw fused list — search never breaks
        // because the summarizer did; "none relevant" also decays to raw.
        if (summarizer) {
          try {
            const s = await summarizer.summarize(query, fused.map((h) => ({
              session_id: h.sessionId,
              created_at: h.createdAt,
              snippet: h.snippet,
              retriever: "fts" as const,
              rank: 0,
            })), ctx?.signal);
            if (s.text && !/^none relevant/i.test(s.text.trim())) {
              return (
                `[session_search: condensed by ${s.modelLabel} in ${s.elapsedMs}ms from ${fused.length} raw excerpts]\n\n` +
                s.text
              );
            }
          } catch {
            /* silent fallback below */
          }
        }
        return format(fused.slice(0, limit));
      } catch (e) {
        return `Error: session_search failed: ${(e as Error).message}`;
      }
    },
  };
}
