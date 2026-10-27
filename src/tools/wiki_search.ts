// wiki_search: the fast, first-class path into the user's private llmwiki
// (and, on explicit request, the shared/common wiki).
//
// The llm-wiki SKILL remains the capture/admin interface. This tool exists
// because retrieval must be visible on the wire without an extra load_skill
// step: a question about a term or claim from an ingested article should route
// here before public web/scholar search.
//
// Security posture mirrors execute(): a per-user short-lived assertion, never
// the static admin token. The assertion is created and consumed inside this
// module and is never logged or returned.

import { WIKI_API_URL, WIKI_PROXY_TIMEOUT_MS } from "../config.js";
import { log } from "../logger.js";
import type { ToolDef } from "../types.js";
import { mintWikiAssertion, wikiAssertionsEnabled } from "../wiki-auth.js";
import { currentUserId } from "../workspace.js";

const DEFAULT_K = 8;
const MAX_K = 10;
const EXCERPT_CHARS = 500;

type WikiScope = "private" | "common";

interface SearchHit {
  id?: unknown;
  score?: unknown;
  origin?: unknown;
  text?: unknown;
  slug?: unknown;
  source_id?: unknown;
  metadata?: unknown;
  domain?: unknown;
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function metaOf(hit: SearchHit): Record<string, unknown> {
  return hit.metadata && typeof hit.metadata === "object"
    ? (hit.metadata as Record<string, unknown>)
    : {};
}

function clampK(value: unknown): number {
  if (value === undefined || value === null || (typeof value === "string" && !value.trim())) {
    return DEFAULT_K;
  }
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_K;
  return Math.min(MAX_K, Math.max(1, Math.trunc(n)));
}

function excerpt(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > EXCERPT_CHARS ? `${flat.slice(0, EXCERPT_CHARS)}…` : flat;
}

function formatHit(hit: SearchHit, index: number): string {
  const meta = metaOf(hit);
  const domain = str(hit.domain) || "general";
  const slug = str(hit.slug);
  const sourceId = str(hit.source_id) || str(meta.source_id);
  const page = slug || sourceId || str(hit.id) || "(unknown)";
  const title = str(meta.title) || slug || sourceId || str(hit.id) || "(untitled)";
  const origin = str(hit.origin) === "wiki" ? "wiki" : "chunk";
  const score =
    typeof hit.score === "number" && Number.isFinite(hit.score)
      ? ` | score ${hit.score.toFixed(2)}`
      : "";
  const lines = [
    `${index + 1}. [${origin}]${score} | page: ${domain}/${page} | title: ${title}`,
  ];

  const url = str(meta.url);
  const sources = Array.isArray(meta.sources)
    ? meta.sources.map((s) => str(s)).filter(Boolean).slice(0, 3)
    : [];
  const sourceRef = [sourceId, ...sources, url].filter(
    (value, i, all) => value && all.indexOf(value) === i,
  );
  if (sourceRef.length) lines.push(`   source: ${sourceRef.join(" · ")}`);

  const text = excerpt(str(hit.text) || str(meta.text));
  if (text) lines.push(`   excerpt: ${text}`);
  return lines.join("\n");
}

export const wiki_search: ToolDef = {
  name: "wiki_search",
  description:
    "Search the user's private knowledge base (My Wiki) for a term, acronym, concept, claim, paper, " +
    "article, or saved note that may have been ingested. Call this FIRST for such questions, before " +
    "internet_search or scholar-search. Scope is private by default; use scope \"common\" only when the " +
    "user explicitly asks about the shared wiki. Returns ranked page/chunk excerpts with citations; " +
    "if the private wiki has no match it says so, so the model can fall back explicitly.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query." },
      scope: {
        type: "string",
        enum: ["private", "common"],
        description: "private (My Wiki, default) or common (shared wiki).",
      },
      domain: { type: "string", description: "Optional domain filter." },
      k: { type: "number", description: "Max hits (default 8, max 10)." },
    },
    required: ["query"],
  },
  async execute(args) {
    const query = str(args.query);
    if (!query) return "Rejected: wiki_search requires a non-empty query.";

    const rawScope = str(args.scope).toLowerCase() || "private";
    if (rawScope !== "private" && rawScope !== "common") {
      return "Rejected: scope must be \"private\" or \"common\".";
    }
    const scope = rawScope as WikiScope;
    const domain = str(args.domain);
    const k = clampK(args.k);
    const started = Date.now();

    if (!wikiAssertionsEnabled()) {
      return "Rejected: wiki search is not configured (WIKI_ASSERTION_SECRET missing).";
    }

    let assertion: string;
    try {
      assertion = mintWikiAssertion({ username: currentUserId() });
    } catch {
      return "Rejected: wiki search is not configured (WIKI_ASSERTION_SECRET missing).";
    }

    const params = new URLSearchParams({ q: query, scope, k: String(k) });
    if (domain) params.set("domain", domain);

    let res: Response;
    try {
      res = await fetch(`${WIKI_API_URL.replace(/\/+$/, "")}/search?${params.toString()}`, {
        headers: { authorization: `Bearer ${assertion}` },
        signal: AbortSignal.timeout(WIKI_PROXY_TIMEOUT_MS),
      });
    } catch (error) {
      // Never log the query or URL: only the failure class is safe.
      const name = error instanceof Error ? error.name : "fetch error";
      log.warn(`wiki_search scope=${scope} unreachable ${Date.now() - started}ms (${name})`);
      return "Rejected: llmwiki is unreachable/cold; retry once.";
    }

    const elapsed = Date.now() - started;
    if (!res.ok) {
      log.warn(`wiki_search scope=${scope} status=${res.status} ${elapsed}ms`);
      if (res.status === 401 || res.status === 403) {
        return "Rejected: llmwiki rejected the user assertion; check WIKI_ASSERTION_SECRET/scope.";
      }
      if (res.status === 429) {
        return "Rejected: llmwiki rate-limited the search (HTTP 429); retry once.";
      }
      if (res.status === 404) {
        return `Rejected: wiki domain not found${domain ? `: ${domain}` : ""}.`;
      }
      if (res.status === 502 || res.status === 503 || res.status === 504) {
        return "Rejected: llmwiki is unreachable/cold; retry once.";
      }
      if (res.status >= 500) {
        return `Rejected: llmwiki is unavailable (HTTP ${res.status}); retry once.`;
      }
      return `Rejected: wiki search failed (HTTP ${res.status}).`;
    }

    let body: unknown;
    try {
      body = await res.json();
    } catch {
      log.warn(`wiki_search scope=${scope} unreadable-json status=${res.status} ${elapsed}ms`);
      return "Rejected: llmwiki returned an unreadable search response; retry once.";
    }
    if (!Array.isArray(body)) {
      log.warn(`wiki_search scope=${scope} unexpected-body status=${res.status} ${elapsed}ms`);
      return "Rejected: llmwiki returned an unexpected search response.";
    }

    const hits = body as SearchHit[];
    log.info(`wiki_search scope=${scope} status=${res.status} hits=${hits.length} ${elapsed}ms`);

    if (!hits.length) {
      const where = scope === "common" ? "the shared wiki" : "My Wiki";
      return `No relevant pages in ${where} for ${JSON.stringify(query)} (scope=${scope}).`;
    }

    const noun = hits.length === 1 ? "hit" : "hits";
    return `Wiki search (${scope}, ${hits.length} ${noun}):\n${hits
      .map((hit, i) => formatHit(hit, i))
      .join("\n")}`;
  },
};
