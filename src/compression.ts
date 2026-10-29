// Context compression with lineage (Hermes-style Phase 5, python parity).
//
// Before the hard context limit is hit, a pre-flight usage check flags long
// conversations; an LLM call then summarizes the MIDDLE turns of the
// conversation — never dropping them — while the first turn (the original
// task) and the most recent N turns stay verbatim. The summary is injected
// as a system message at the compression point; lineage (turn range +
// summary + model) is persisted in the archive so earlier context stays
// traceable and the verbatim transcript remains searchable via
// session_search.
//
// Usage measure: the provider-reported prompt_tokens of the LAST assistant
// message (includes system prompt + tool schemas — matching what the
// provider actually processed), with the ~4 chars/token estimate as
// fallback. Live per run: after restart/resume the fully-archived history
// is re-evaluated and may be re-compressed (idempotent outcome).
//
// Env (python parity):
//   COMPRESSION_ENABLED=true|1|yes|on    (default off)
//   COMPRESSION_TOKEN_THRESHOLD=24000
//   COMPRESSION_KEEP_RECENT_TURNS=2
//
// Failure semantics: model errors, empty summaries, or edge cases abort
// compression and the original message list is returned untouched —
// compression must never break the agent.

import type { ChatMessage } from "./types.js";
import { chat } from "./llm.js";
import { resolveUserModel } from "./llm-keys.js";
import { log } from "./logger.js";
import { flattenTranscript } from "./nudge.js";
import { trace, llmRunMetadata, llmRunOutputs } from "./tracing.js";

export const DEFAULT_COMPRESSION_TOKEN_THRESHOLD = 24000;
export const DEFAULT_COMPRESSION_KEEP_RECENT = 2;
const MAX_SUMMARY_CHARS = 1500;

const SUMMARY_SYSTEM_PROMPT =
  "You compress a slice of an AI agent's conversation history so future turns " +
  "fit the context window. Produce a terse, information-dense summary of the " +
  "transcript below. Preserve: the user's goals and decisions, procedures and " +
  "tool commands used (with exact file paths), key results and numbers, and " +
  "any errors with their fixes. Plain text only — never emit tool-call syntax. " +
  "Do not add outside knowledge.";

const PSEUDO_TOOL_RE = /\[\s*(summarize|answer|condense|search)\s*\(/i;

/** ~4-chars-per-token estimate (no tokenizer dependency). */
export function estimateTokens(messages: ChatMessage[]): number {
  let total = 0;
  for (const m of messages) total += m.content.length + 8;
  return total >> 2;
}

/** Provider-reported prompt_tokens of the most recent LLM response. */
export function lastRequestTokens(messages: ChatMessage[]): number | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "assistant" && m.usage?.prompt_tokens) {
      return m.usage.prompt_tokens;
    }
  }
  return null;
}

/** Group messages into turns; each turn starts at a user message.
 *  Non-user messages before the first user stay attached to the first turn
 *  (injected system messages, mirrored python parity). */
export function splitIntoTurns(messages: ChatMessage[]): ChatMessage[][] {
  const segments: ChatMessage[][] = [];
  let current: ChatMessage[] = [];
  for (const message of messages) {
    if (message.role === "user" && current.length) {
      segments.push(current);
      current = [message];
    } else {
      current.push(message);
    }
  }
  if (current.length) segments.push(current);
  if (segments.length >= 2 && !segments[0].some((m) => m.role === "user")) {
    segments[1] = [...segments[0], ...segments[1]];
    segments.splice(0, 1);
  }
  return segments;
}

export interface CompressResult {
  compressed: boolean;
  reason: string;
  compressedMessages: ChatMessage[];
  summary: string;
  summarizedFirstTurn: number;
  summarizedLastTurn: number;
  originalCount: number;
  compressedCount: number;
  elapsedMs: number;
  modelLabel: string;
}

function noop(reason: string, messages: ChatMessage[]): CompressResult {
  return {
    compressed: false,
    reason,
    compressedMessages: [...messages],
    summary: "",
    summarizedFirstTurn: 0,
    summarizedLastTurn: 0,
    originalCount: messages.length,
    compressedCount: messages.length,
    elapsedMs: 0,
    modelLabel: "",
  };
}

export interface CompressorOpts {
  tokenThreshold?: number;
  keepRecentTurns?: number;
}

export class ConversationCompressor {
  readonly tokenThreshold: number;
  readonly keepRecentTurns: number;

  /** Dynamic: the summarizer is shared across users, while the model is not. */
  get label(): string {
    return `openrouter/${resolveUserModel("main")}`;
  }

  constructor(opts: CompressorOpts = {}) {
    this.tokenThreshold = Math.max(1, opts.tokenThreshold ?? DEFAULT_COMPRESSION_TOKEN_THRESHOLD);
    this.keepRecentTurns = Math.max(1, opts.keepRecentTurns ?? DEFAULT_COMPRESSION_KEEP_RECENT);
  }

  private currentUsage(messages: ChatMessage[]): number {
    return Math.max(lastRequestTokens(messages) ?? 0, estimateTokens(messages));
  }

  shouldCompress(messages: ChatMessage[]): boolean {
    const segments = splitIntoTurns(messages);
    if (segments.length < this.keepRecentTurns + 2) return false;
    return this.currentUsage(messages) >= this.tokenThreshold;
  }

  /** One-shot compress-or-return-original. Never throws. */
  async compress(messages: ChatMessage[]): Promise<CompressResult> {
    if (!messages.length) return noop("empty", messages);
    const segments = splitIntoTurns(messages);
    const usage = this.currentUsage(messages);
    if (segments.length < this.keepRecentTurns + 2) {
      if (usage >= this.tokenThreshold) {
        log.info(
          `context compression skipped: usage ${usage} tokens is over the ${this.tokenThreshold} threshold, ` +
            `but the history has only ${segments.length} turn(s) — need >= ${this.keepRecentTurns + 2} ` +
            `(first + middle + KEEP_RECENT_TURNS=${this.keepRecentTurns}). Fires at a later turn's pre-flight.`,
        );
      }
      return noop("no middle turns", messages);
    }
    if (usage < this.tokenThreshold) return noop("below threshold", messages);

    const keptFirst = segments[0];
    const middle = segments.slice(1, -this.keepRecentTurns);
    const keptRecent = segments.slice(-this.keepRecentTurns);
    if (!middle.length) return noop("no middle turns", messages);

    const transcript = flattenTranscript(middle.flat());
    const start = Date.now();
    // LangSmith: the (otherwise invisible) compaction call gets its own
    // run tree — root chain "context-compression" + llm child.
    const rootRun = trace.create({
      name: "context-compression",
      runType: "chain",
      inputs: {
        turns: segments.length,
        middle_turns: middle.length,
        messages: messages.length,
        estimated_usage_tokens: usage,
        threshold: this.tokenThreshold,
      },
      tags: ["nm-finance-agent", "compression"],
    });
    const payload: ChatMessage[] = [
      { role: "system", content: SUMMARY_SYSTEM_PROMPT },
      { role: "user", content: `TRANSCRIPT SLICE (${middle.length} turns):\n\n${transcript}\n\nSummarize now.` },
    ];
    const mainModel = resolveUserModel("main");
    const label = `openrouter/${mainModel}`;
    const llmRun = trace.create({
      name: `summarize[${label}]`,
      runType: "llm",
      inputs: { messages: payload },
      parent: rootRun,
      tags: ["nm-finance-agent", "compression"],
      metadata: llmRunMetadata(mainModel),
    });
    try {
      const response = await chat(payload, undefined, { modelRole: "main", noReasoning: true });
      const elapsedMs = Date.now() - start;
      trace.update(llmRun, {
        outputs: llmRunOutputs(response.content, {
          usage: response.usage,
          message: { role: "assistant", content: response.content },
        }),
        metadata: llmRunMetadata(response.model, response.usage),
      });
      let summary = response.content.replace(/<\|[^|>]*\|>/g, "").trim();
      if (!summary || PSEUDO_TOOL_RE.test(summary)) {
        log.warn("context compression got empty/pseudo-tool output — keeping original history");
        trace.update(rootRun, { outputs: { reason: "empty or malformed model output" }, error: "empty or malformed model output" });
        return noop("empty or malformed model output", messages);
      }
      if (summary.length > MAX_SUMMARY_CHARS) {
        summary = `${summary.slice(0, MAX_SUMMARY_CHARS - 4).trimEnd()} [...]`;
      }
      // python labels: segment 0 == turn 1 (kept verbatim) → middle starts at 2
      const firstTurn = 2;
      const lastTurn = 1 + middle.length;
      const summaryMessage: ChatMessage = {
        role: "system",
        content:
          `<conversation_summary turns="${firstTurn}-${lastTurn}">\n${summary}\n` +
          `</conversation_summary>\n` +
          `(Turns ${firstTurn}-${lastTurn} were compressed into this summary. ` +
          `The verbatim transcript remains in the session archive — search it with session_search.)`,
      };
      const compressed = [...keptFirst, summaryMessage, ...keptRecent.flat()];
      log.info(
        `context compression [${label}]: ${elapsedMs}ms, turns ${firstTurn}-${lastTurn} summarized, ` +
          `${messages.length} -> ${compressed.length} messages, summary ${summary.length} chars`,
      );
      trace.update(rootRun, {
        outputs: {
          reason: "compressed",
          turns: `${firstTurn}-${lastTurn}`,
          original: messages.length,
          compressed: compressed.length,
          summary_chars: summary.length,
          elapsed_ms: elapsedMs,
        },
      });
      return {
        compressed: true,
        reason: "compressed",
        compressedMessages: compressed,
        summary,
        summarizedFirstTurn: firstTurn,
        summarizedLastTurn: lastTurn,
        originalCount: messages.length,
        compressedCount: compressed.length,
        elapsedMs,
        modelLabel: label,
      };
    } catch (e) {
      const msg = String(e).slice(0, 200);
      log.warn(`context compression failed (${msg}) — keeping original history`);
      trace.update(llmRun, { error: msg });
      trace.update(rootRun, { outputs: { reason: "model error" }, error: msg });
      return noop("model error", messages);
    }
  }
}

/** Env-gated factory (python create_openrouter_compressor parity). */
export function createCompressor(): ConversationCompressor | null {
  const flag = (process.env.COMPRESSION_ENABLED ?? "").trim().toLowerCase();
  if (!["1", "true", "yes", "on"].includes(flag)) return null;
  return new ConversationCompressor({
    tokenThreshold: Number(process.env.COMPRESSION_TOKEN_THRESHOLD ?? "24000") || DEFAULT_COMPRESSION_TOKEN_THRESHOLD,
    keepRecentTurns: Number(process.env.COMPRESSION_KEEP_RECENT_TURNS ?? "2") || DEFAULT_COMPRESSION_KEEP_RECENT,
  });
}
