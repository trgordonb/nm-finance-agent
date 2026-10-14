// Research-only tools: tavily_search (raw content + Exa/LLM page summaries,
// per-URL cache) and think_tool — ported from the thinkdepth-ai utils.py
// search pipeline (docs/deep-research-plan.md). These are bound only inside
// researcher loops; they never enter the main agent's flat registry.

import { EXA_API_KEY, EXA_SUMMARIZER_ENABLED, RESEARCH_PAGE_CONTEXT_CHARS } from "../config.js";
import type { ToolDef } from "../types.js";
import { summarize_webpage_prompt } from "./prompts.js";
import type { ChatFn, SearchFn, SearchResult } from "./types.js";
import { extractJson, fillPrompt, getTodayStr } from "./util.js";

const EXA_SUMMARY_INSTRUCTION =
  "Summarize this webpage for a downstream research agent. Preserve the " +
  "main topic, all key facts, statistics, dates, names, and 2-5 important " +
  "verbatim quotes. Keep lists and step-by-step instructions intact. Aim " +
  "for 25-30% of the original length.";

// Structured summary schema mirroring summarize_webpage_prompt's JSON contract
// (verified live against Exa's /contents endpoint in the Python original).
const EXA_SUMMARY_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    key_excerpts: { type: "array", items: { type: "string" } },
  },
  required: ["summary", "key_excerpts"],
};

/** Tavily search with raw page content — the researcher's search backend
 *  (include_raw_content feeds the summarizer, python parity). */
export const tavilySearch: SearchFn = async (query, { maxResults, topic }) => {
  const key = process.env.TAVILY_API_KEY ?? "";
  if (!key) throw new Error("TAVILY_API_KEY is not set — deep research needs a Tavily key");
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      query,
      topic,
      max_results: maxResults,
      include_answer: false,
      include_raw_content: true,
    }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Tavily search failed (HTTP ${res.status}): ${text.slice(0, 300)}`);
  }
  const data = (await res.json()) as { results?: SearchResult[] };
  return data.results ?? [];
};

// --- page summaries: Exa first, LLM fallback, snippet last -------------------

// URL -> rendered summary; null marks a page Exa could not summarize
// (permanent: unfetchable/error status) so a run never pays for it twice.
// Transient request errors are NOT cached (next caller retries) — parity.
const exaCache = new Map<string, string | null>();
const EXA_CACHE_MAX = 1024;

function formatPageSummary(summaryText: string, excerpts: string[] | string): string {
  const rendered = Array.isArray(excerpts) ? excerpts.map((e) => `- ${e}`).join("\n") : excerpts;
  return `<summary>\n${summaryText}\n</summary>\n\n<key_excerpts>\n${rendered}\n</key_excerpts>`;
}

/** Render an Exa structured summary (JSON string or object) into the standard
 *  <summary>/<key_excerpts> block; non-JSON responses degrade to plain text. */
export function parseExaSummary(raw: unknown): string {
  if (raw && typeof raw === "object") {
    const obj = raw as { summary?: unknown; key_excerpts?: unknown };
    if (typeof obj.summary === "string") {
      const excerpts = Array.isArray(obj.key_excerpts)
        ? (obj.key_excerpts as string[])
        : String(obj.key_excerpts ?? "");
      return formatPageSummary(obj.summary, excerpts);
    }
  }
  const text = String(raw ?? "").trim();
  const parsed = extractJson<{ summary?: string; key_excerpts?: string[] | string }>(text);
  if (parsed && typeof parsed.summary === "string") {
    return formatPageSummary(parsed.summary, parsed.key_excerpts ?? "");
  }
  return formatPageSummary(text, "");
}

/** Exa server-side structured summary (~$0.001/page). Returns null when the
 *  summarizer is disabled/unconfigured, the page is unfetchable, or the
 *  request errors — callers fall back to the LLM summarizer in those cases. */
export async function exaSummarizeUrl(url: string): Promise<string | null> {
  if (!EXA_SUMMARIZER_ENABLED || !EXA_API_KEY) return null;
  if (exaCache.has(url)) return exaCache.get(url) ?? null;

  let rendered: string | null;
  try {
    const res = await fetch("https://api.exa.ai/contents", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": EXA_API_KEY },
      body: JSON.stringify({
        urls: [url],
        summary: { query: EXA_SUMMARY_INSTRUCTION, schema: EXA_SUMMARY_SCHEMA },
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) return null; // transient — do not cache
    const data = (await res.json()) as { results?: Array<{ summary?: unknown }> };
    const raw = data.results?.[0]?.summary;
    rendered = raw ? parseExaSummary(raw) : null;
  } catch {
    return null; // transient — do not cache
  }

  if (exaCache.size >= EXA_CACHE_MAX) {
    const oldest = exaCache.keys().next().value;
    if (oldest !== undefined) exaCache.delete(oldest);
  }
  exaCache.set(url, rendered);
  return rendered;
}

export interface PageSummaryDeps {
  chatFn: ChatFn;
  /** Summarizer model for the LLM fallback path. */
  model: string;
  signal?: AbortSignal;
  minIntervalMs?: number;
}

/** LLM summarizer fallback over capped raw content (summarize_webpage_prompt
 *  contract: {summary, key_excerpts}); failure degrades to a raw truncate. */
export async function llmSummarizePage(text: string, deps: PageSummaryDeps): Promise<string> {
  const capped = text.slice(0, RESEARCH_PAGE_CONTEXT_CHARS);
  try {
    const response = await deps.chatFn(
      [
        {
          role: "user",
          content: fillPrompt(summarize_webpage_prompt, {
            webpage_content: capped,
            date: getTodayStr(),
          }),
        },
      ],
      undefined,
      {
        model: deps.model,
        noReasoning: true,
        maxTokens: 2048,
        signal: deps.signal,
        minIntervalMs: deps.minIntervalMs,
      },
    );
    const parsed = extractJson<{ summary?: string; key_excerpts?: string[] | string }>(
      response.content,
    );
    if (parsed && typeof parsed.summary === "string") {
      return formatPageSummary(parsed.summary, parsed.key_excerpts ?? "");
    }
    return formatPageSummary(response.content, "");
  } catch {
    return capped.length > 1000 ? `${capped.slice(0, 1000)}...` : capped;
  }
}

export interface SearchOutputDeps extends PageSummaryDeps {}

/** Dedupe search results by URL and summarize each page: Exa → LLM over raw
 *  content → Tavily snippet (python process_search_results parity). */
export async function formatSearchOutput(
  results: SearchResult[],
  deps: SearchOutputDeps,
): Promise<string> {
  const unique = new Map<string, SearchResult>();
  for (const result of results) {
    if (result.url && !unique.has(result.url)) unique.set(result.url, result);
  }
  if (!unique.size) {
    return "No valid search results found. Please try different search queries or use a different search API.";
  }

  const parts: string[] = ["Search results: \n"];
  let index = 1;
  for (const [url, result] of unique) {
    let summary = await exaSummarizeUrl(url);
    if (summary === null) {
      summary = result.raw_content
        ? await llmSummarizePage(result.raw_content, deps)
        : result.content;
    }
    parts.push(
      `\n\n--- SOURCE ${index}: ${result.title} ---\n` +
        `URL: ${url}\n\n` +
        `SUMMARY:\n${summary}\n\n` +
        `${"-".repeat(80)}\n`,
    );
    index++;
  }
  return parts.join("");
}

/** The researcher's tool surface: tavily_search + think_tool.
 *  Only `query` is exposed to the model (max_results/topic are injected —
 *  python InjectedToolArg parity). */
export function createResearchTools(deps: {
  search: SearchFn;
  chatFn: ChatFn;
  summarizerModel: string;
  maxResults: number;
  signal?: AbortSignal;
  minIntervalMs?: number;
}): ToolDef[] {
  const tavily_search: ToolDef = {
    name: "tavily_search",
    description:
      "Fetch results from Tavily search API with content summarization. Returns ranked " +
      "sources with per-page summaries. Pass one query per call; call it multiple times " +
      "in parallel for independent queries.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "A single search query to execute" },
      },
      required: ["query"],
    },
    async execute(args) {
      const query = String(args.query ?? "").trim();
      if (!query) return "Rejected: empty search query — pass a non-empty `query`.";
      const results = await deps.search(query, { maxResults: deps.maxResults, topic: "general" });
      return await formatSearchOutput(results, {
        chatFn: deps.chatFn,
        model: deps.summarizerModel,
        signal: deps.signal,
        minIntervalMs: deps.minIntervalMs,
      });
    },
  };

  const think_tool: ToolDef = {
    name: "think_tool",
    description:
      "Tool for strategic reflection on research progress and decision-making. Use it after " +
      "each search: what did you find, what is missing, do you have enough, should you search " +
      "more or conclude.",
    parameters: {
      type: "object",
      properties: {
        reflection: {
          type: "string",
          description:
            "Your detailed reflection on research progress, findings, gaps, and next steps",
        },
      },
      required: ["reflection"],
    },
    execute(args) {
      return `Reflection recorded: ${String(args.reflection ?? "")}`;
    },
  };

  return [tavily_search, think_tool];
}
