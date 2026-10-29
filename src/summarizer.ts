// Secondary-LLM summarization of hybrid session-search results (Hermes-style,
// python summarizer.py port). Raw keyword+dense recall is cheap but noisy;
// with a summarizer attached, session_search passes the fused excerpts through
// ONE secondary-LLM call (the per-user summarizer model, workspace default
// OPENROUTER_MODEL_SUMMARIZER) which
// condenses them to only what is relevant to the current query before they
// enter the agent's context.
//
// Toggle: SEARCH_SUMMARIZER_ENABLED=true/1/yes/on (default off) so consumers
// can A/B compare. Failure semantics: misconfiguration, raised calls, or
// timeouts → session_search silently falls back to the raw excerpt list —
// search must never break because the summarizer did.
//
// Pseudo-tool guard: tiny free models leak chat-template special tokens or
// hallucinate tool-call syntax instead of answering — stripped/guarded
// (python parity).

import { chat } from "./llm.js";
import type { ChatMessage } from "./types.js";
import {
  SEARCH_SUMMARIZER_MAX_ATTEMPTS,
  SEARCH_SUMMARIZER_TIMEOUT_MS,
} from "./config.js";
import type { SessionHit } from "./driver.js";
import { log } from "./logger.js";
import { trace, llmRunMetadata, llmRunOutputs } from "./tracing.js";
import { resolveUserModel } from "./llm-keys.js";

const SPECIAL_TOKEN_RE = /<\|[^|>]*\|>/g;
const PSEUDO_TOOL_CALL_RE = /\[\s*(summarize|answer|condense|search)\s*\(/i;

const SUMMARIZER_SYSTEM_PROMPT =
  "You condense episodic session-search excerpts for an AI agent. You are " +
  "given the agent's query and numbered excerpts retrieved from past session " +
  "archives. Return ONLY the content relevant to the query, reorganized and " +
  "tersely rewritten. Keep the [n] excerpt references when a statement comes " +
  "from an excerpt. Drop irrelevant excerpts entirely. Never invent content " +
  "that is not in the excerpts. If nothing is relevant to the query, reply " +
  "exactly: none relevant.";

export interface SummarizedSearch {
  text: string;
  modelLabel: string;
  elapsedMs: number;
  excerptCount: number;
}

export class SearchSummarizer {
  /** Dynamic: the summarizer is shared across users, while the model is not. */
  get label(): string {
    return `openrouter/${resolveUserModel("summarizer")}`;
  }

  summarize(query: string, hits: SessionHit[], signal?: AbortSignal): Promise<SummarizedSearch> {
    const summarizerModel = resolveUserModel("summarizer");
    const excerpts = hits
      .map(
        (hit, i) =>
          `[${i + 1}] session=${hit.session_id.slice(0, 8)} role=${hit.retriever} at=${hit.created_at}\n${hit.snippet}`,
      )
      .join("\n\n");
    const messages: ChatMessage[] = [
      { role: "system", content: SUMMARIZER_SYSTEM_PROMPT },
      { role: "user", content: `QUERY: ${query}\n\nEXCERPTS:\n${excerpts}\n\nCondense now.` },
    ];
    const rootId = trace.create({
      name: "session-search-summarize",
      runType: "chain",
      inputs: { query: query.slice(0, 300), excerpts: hits.length },
      tags: ["nm-finance-agent", "search-summarizer"],
    });
    const llmId = trace.create({
      name: `condense[${this.label}]`,
      runType: "llm",
      inputs: { messages },
      parent: rootId,
      tags: ["nm-finance-agent", "search-summarizer"],
      metadata: llmRunMetadata(summarizerModel),
    });
    const start = Date.now();
    const run = chat(messages, undefined, {
      model: summarizerModel,
      modelRole: "summarizer",
      noReasoning: true,
      // 2048, not 1024: same reasoning-budget drift as followups (2026-10-16)
      // — this model spends hundreds of output tokens thinking before the
      // condensation text, and reasoning counts against max_tokens.
      maxTokens: 2048,
      // Enrichment only: bound the free model hard and let session_search
      // fall back to raw excerpts. A 300s x5 default held a live turn for
      // 20+ minutes (2026-10-20).
      timeoutMs: SEARCH_SUMMARIZER_TIMEOUT_MS,
      maxAttempts: SEARCH_SUMMARIZER_MAX_ATTEMPTS,
      retryOnTimeout: false,
      ...(signal ? { signal } : {}),
    }).then((response) => {
      const elapsedMs = Date.now() - start;
      trace.update(llmId, {
        outputs: llmRunOutputs(response.content, {
          usage: response.usage,
          message: { role: "assistant", content: response.content },
        }),
        metadata: llmRunMetadata(response.model, response.usage),
      });
      let text = response.content.replace(SPECIAL_TOKEN_RE, "").trim();
      if (PSEUDO_TOOL_CALL_RE.test(text)) {
        log.warn(
          `session_search summarizer [${this.label}] emitted a pseudo tool call instead of ` +
            "condensed text — treating as failure (tool falls back to raw excerpts)",
        );
        text = "";
        trace.update(llmId, { error: "pseudo tool call output" });
      }
      log.info(`session_search summarizer [${this.label}]: ${elapsedMs}ms, ${hits.length} excerpts, text ${text.length} chars`);
      trace.update(rootId, {
        outputs: { condensed_chars: text.length, elapsed_ms: elapsedMs },
        error: text ? undefined : "empty summarizer output",
      });
      return { text, modelLabel: this.label, elapsedMs, excerptCount: hits.length };
    }).catch((e) => {
      trace.update(llmId, { error: String(e).slice(0, 160) });
      trace.update(rootId, { outputs: { reason: "model error" }, error: String(e).slice(0, 160) });
      throw e;
    });
    return run;
  }
}

/** Env-gated factory (python create_openrouter_summarizer parity). Never
 *  raises; misconfiguration logs and deactivates (raw mode). */
export function createSessionSearchSummarizer(): SearchSummarizer | null {
  const flag = (process.env.SEARCH_SUMMARIZER_ENABLED ?? "").trim().toLowerCase();
  if (!["1", "true", "yes", "on"].includes(flag)) return null;
  if (!process.env.OPENROUTER_API_KEY) {
    log.warn("SEARCH_SUMMARIZER_ENABLED is on but OPENROUTER_API_KEY is not set — summarizer disabled");
    return null;
  }
  return new SearchSummarizer();
}
