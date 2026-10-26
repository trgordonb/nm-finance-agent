// Thin OpenAI-compatible chat client using global fetch (no SDK dep).
// Ports the langgraph-demo retry wrapper: min 4s between calls, up to 5
// attempts, exponential backoff on 5xx/429/dial errors, hard-fail otherwise.

import {
  OPENROUTER_BASE_URL,
  OPENROUTER_MODEL_MAIN,
  OPENROUTER_PROVIDER_ORDER,
  OPENROUTER_PROVIDER_IGNORE,
  OPENROUTER_PROVIDER_FALLBACKS,
  OPENROUTER_REASONING,
  MAX_COMPLETION_TOKENS,
} from "./config.js";
import type { ChatMessage } from "./types.js";
import { resolveAuthorizationKey, recordLlmUsage } from "./llm-keys.js";
import { currentUserId } from "./workspace.js";

const MIN_INTERVAL_MS = Number(process.env.LLM_MIN_INTERVAL_MS ?? "4000");
const MAX_ATTEMPTS = Number(process.env.LLM_MAX_ATTEMPTS ?? "5");

let lastCallAt = 0;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function abortError(): Error {
  const err = new Error("aborted by caller");
  err.name = "AbortError";
  return err;
}

const RETRYABLE = [
  "500",
  "502",
  "503",
  "504",
  "connection",
  "timeout",
  "timed out",
  "429",
  "rate",
  "socket",
  "fetch failed",
  "econnreset",
  "network",
];

function retryable(errStr: string): boolean {
  const s = errStr.toLowerCase();
  return RETRYABLE.some((code) => s.includes(code));
}

interface ChatPart {
  role: string;
  content?: string | null;
  tool_calls?: Array<{
    id: string;
    type: string;
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
  name?: string;
}

export interface ChatUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  /** OpenRouter-reported USD cost for this call (when the model exposes it). */
  cost?: number;
  /** OpenRouter/OpenAI usage detail; reasoning is the hidden thinking spend. */
  completion_tokens_details?: { reasoning_tokens?: number };
}

export interface ChatResponse {
  content: string;
  toolCalls: Array<{ id: string; name: string; args: Record<string, unknown> }>;
  raw: ChatPart;
  usage?: ChatUsage;
  model: string;
  /** Provider that served the request (OpenRouter `provider` field). */
  provider?: string;
  /** Provider finish reason — "length" flags a truncated/degenerate output. */
  finishReason?: string;
}

export interface ChatOpts {
  /** Override model — secondary calls (titler, future summarizer) use the
   *  cheap OPENROUTER_MODEL_SUMMARIZER model. */
  model?: string;
  /** Omit the reasoning block (tiny free models bill/deduplicate badly). */
  noReasoning?: boolean;
  /** Lower max_tokens for short-extraction calls (OpenRouter reasoning
   *  models count reasoning tokens against the cap and can return empty
   *  content with finish_reason=length; python parity max_tokens=512). */
  maxTokens?: number;
  /** Caller-supplied abort (deep-research cancel): kills the in-flight
   *  request immediately and stops the retry loop. */
  signal?: AbortSignal;
  /** Override the global min-interval between calls — deep-research runs
   *  make bursts of parallel calls and use a tighter spacing. */
  minIntervalMs?: number;
  /** Reasoning effort (OpenRouter unified `reasoning.effort`) — verified
   *  accepted by z-ai/glm-5.3-flash. Applies only when the reasoning block
   *  is sent (ignored under noReasoning). */
  reasoningEffort?: "low" | "medium" | "high";
  /** Per-request HTTP timeout. Research writer calls use a longer budget than
   *  the 4s-spacing chat loop; a 20K-token GLM generation can exceed 300s. */
  timeoutMs?: number;
  /** Per-call retry cap (defaults to LLM_MAX_ATTEMPTS / 5). */
  maxAttempts?: number;
  /** When false, a request that hit its own timeout is not retried: the
   *  generation almost certainly completed server-side, so retrying repeats
   *  the whole spend. Defaults to true (transient-network behavior). */
  retryOnTimeout?: boolean;
}

export async function chat(
  messages: ChatMessage[],
  tools?: Array<{ name: string; description: string; parameters: unknown }>,
  opts: ChatOpts = { },
): Promise<ChatResponse> {
  // Per-user key resolution (docs/user-scoped-openrouter-keys-plan.md): the
  // caller's ALS scope picks the user's key when configured, else the server
  // key per LLM_KEY_POLICY. Resolved once per call, not per attempt.
  const auth = resolveAuthorizationKey();
  if (!auth.key) throw new Error(auth.error ?? "no OpenRouter API key available");
  const model = opts.model || OPENROUTER_MODEL_MAIN;
  // Provider steering is for the MAIN model only: the summarizer/cheap roles
  // use a different model that may not be served by those providers.
  const isMainModel = model === OPENROUTER_MODEL_MAIN;
  const reasoning = OPENROUTER_REASONING && !opts.noReasoning;
  // Rate limit: enforce minimum interval between calls (shared across turns).
  // Deep-research runs override with a tighter interval via opts.minIntervalMs.
  const minInterval = opts.minIntervalMs ?? MIN_INTERVAL_MS;
  const elapsed = Date.now() - lastCallAt;
  if (elapsed < minInterval) {
    await sleep(minInterval - elapsed);
  }
  if (opts.signal?.aborted) throw abortError();

  const body: Record<string, unknown> = {
    model,
    max_tokens: opts.maxTokens ?? MAX_COMPLETION_TOKENS,
    temperature: 1.0,
    messages: messages.map((m) => {
      if (m.tool_calls) {
        return {
          role: "assistant",
          content: m.content || null,
          tool_calls: m.tool_calls.map((c) => ({
            id: c.id,
            type: "function",
            function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) },
          })),
        };
      }
      if (m.role === "tool") {
        return { role: "tool", content: m.content, tool_call_id: m.tool_call_id, name: m.name };
      }
      return { role: m.role, content: m.content };
    }),
  };
  if (tools && tools.length) {
    body.tools = tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
  }
  // OpenRouter specifics (user example): preferred provider order + fallbacks,
  // optional reasoning block for reasoning-capable models.
  if (isMainModel && (OPENROUTER_PROVIDER_ORDER.length || OPENROUTER_PROVIDER_IGNORE.length)) {
    body.provider = {
      ...(OPENROUTER_PROVIDER_ORDER.length ? { order: OPENROUTER_PROVIDER_ORDER } : {}),
      allow_fallbacks: OPENROUTER_PROVIDER_FALLBACKS,
      ...(OPENROUTER_PROVIDER_IGNORE.length ? { ignore: OPENROUTER_PROVIDER_IGNORE } : {}),
    };
  }
  if (reasoning) {
    body.reasoning = opts.reasoningEffort
      ? { enabled: true, effort: opts.reasoningEffort }
      : { enabled: true };
  }

  const rawAttempts = opts.maxAttempts ?? MAX_ATTEMPTS;
  const maxAttempts = Number.isFinite(rawAttempts) ? Math.max(1, Math.floor(rawAttempts)) : MAX_ATTEMPTS;
  const rawTimeout = opts.timeoutMs ?? Number(process.env.LLM_TIMEOUT_MS ?? "300000");
  const timeoutMs = Number.isFinite(rawTimeout) ? Math.max(1_000, Math.floor(rawTimeout)) : 300_000;
  let lastErr: Error | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const providerLabel = isMainModel
        ? OPENROUTER_PROVIDER_ORDER.join(",") || "auto"
        : "auto";
      const ignoreLabel = isMainModel
        ? OPENROUTER_PROVIDER_IGNORE.join(",") || "-"
        : "-";
      console.error(
        `[llm] POST ${OPENROUTER_BASE_URL}/chat/completions model=${model} attempt=${attempt}/${maxAttempts} timeout=${timeoutMs}ms provider=${providerLabel} ignore=${ignoreLabel}`,
      );
      lastCallAt = Date.now();
      const timeoutSignal = AbortSignal.timeout(timeoutMs);
      // A caller-supplied abort (deep-research cancel) kills the in-flight
      // request immediately, not just at the next loop boundary.
      const requestSignal = opts.signal ? AbortSignal.any([timeoutSignal, opts.signal]) : timeoutSignal;
      const res = await fetch(`${OPENROUTER_BASE_URL.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${auth.key}`,
        },
        body: JSON.stringify(body),
        signal: requestSignal,
      });
      if (!res.ok) {
        const text = await res.text();
        const err = new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
        if (retryable(`${res.status} ${text.slice(0, 100)}`)) throw err;
        throw Object.assign(new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`), { fatal: true });
      }
      const data = (await res.json()) as {
        model: string;
        provider?: string;
        usage?: ChatUsage;
        choices: Array<{ message: ChatPart; finish_reason?: string }>;
      };
      const choice = data.choices?.[0];
      const msg = choice?.message;
      if (!msg) throw new Error("Response has no message");
      // Per-user spend ledger (docs/user-scoped-openrouter-keys-plan.md §10.4)
      // — bookkeeping only, never breaks the call.
      try {
        recordLlmUsage({
          userId: currentUserId(),
          model: data.model || model,
          prompt_tokens: data.usage?.prompt_tokens ?? 0,
          completion_tokens: data.usage?.completion_tokens ?? 0,
          cost_usd: typeof data.usage?.cost === "number" ? data.usage.cost : null,
          // key is non-null here (the null case threw above), so no "none"
          source: auth.source as "user" | "server",
          created_at: Date.now(),
        });
      } catch {
        /* ignore */
      }
      return {
        content: msg.content || "",
        toolCalls: (msg.tool_calls || []).map((tc) => ({
          id: tc.id || `call_${Math.random().toString(36).slice(2)}`,
          name: tc.function?.name,
          args: safeJson(tc.function?.arguments),
        })),
        raw: msg,
        usage: data.usage,
        model: data.model || model,
        provider: data.provider,
        finishReason: choice?.finish_reason,
      };
    } catch (e) {
      const err = e as Error & { fatal?: boolean };
      lastErr = err;
      if (opts.signal?.aborted) break; // caller cancelled — no retries
      if (err.fatal) break;
      const isTimeout = err.name === "TimeoutError" || /timed? ?out|timeout/i.test(err.message || "");
      if (isTimeout && opts.retryOnTimeout === false) {
        console.error(`[llm] timeout after ${timeoutMs}ms — not retrying (retryOnTimeout=false)`);
        break;
      }
      if (!retryable(err.message || String(e))) break;
      const wait = 2000 * Math.pow(2, attempt - 1);
      console.error(`[llm] retry ${attempt}/${maxAttempts} after ${wait / 1000}s: ${err.message.slice(0, 120)}`);
      await sleep(wait);
    }
  }
  throw lastErr ?? new Error("LLM call failed");
}

function safeJson(argStr?: string): Record<string, unknown> {
  if (!argStr) return {};
  try {
    return JSON.parse(argStr) as Record<string, unknown>;
  } catch {
    return {};
  }
}
