// Thin OpenAI-compatible chat client using global fetch (no SDK dep).
// Ports the langgraph-demo retry wrapper: min 4s between calls, up to 5
// attempts, exponential backoff on 5xx/429/dial errors, hard-fail otherwise.

import {
  OPENAI_API_KEY,
  OPENAI_BASE_URL,
  OPENAI_MODEL_ID,
  MAX_COMPLETION_TOKENS,
} from "./config.js";
import type { ChatMessage } from "./types.js";

const MIN_INTERVAL_MS = Number(process.env.LLM_MIN_INTERVAL_MS ?? "4000");
const MAX_ATTEMPTS = Number(process.env.LLM_MAX_ATTEMPTS ?? "5");

let lastCallAt = 0;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
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

export interface ChatResponse {
  content: string;
  toolCalls: Array<{ id: string; name: string; args: Record<string, unknown> }>;
  raw: ChatPart;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  model: string;
}

export async function chat(
  messages: ChatMessage[],
  tools?: Array<{ name: string; description: string; parameters: unknown }>,
): Promise<ChatResponse> {
  if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not set");
  // Rate limit: enforce minimum interval between calls (shared across turns).
  const elapsed = Date.now() - lastCallAt;
  if (elapsed < MIN_INTERVAL_MS) {
    await sleep(MIN_INTERVAL_MS - elapsed);
  }

  const body: Record<string, unknown> = {
    model: OPENAI_MODEL_ID,
    max_tokens: MAX_COMPLETION_TOKENS,
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

  let lastErr: Error | null = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      console.error(
        `[llm] POST ${OPENAI_BASE_URL}chat/completions model=${OPENAI_MODEL_ID} attempt=${attempt}/${MAX_ATTEMPTS}`,
      );
      lastCallAt = Date.now();
      const res = await fetch(`${OPENAI_BASE_URL.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${OPENAI_API_KEY}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(Number(process.env.LLM_TIMEOUT_MS ?? "300000")),
      });
      if (!res.ok) {
        const text = await res.text();
        const err = new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
        if (retryable(`${res.status} ${text.slice(0, 100)}`)) throw err;
        throw Object.assign(new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`), { fatal: true });
      }
      const data = (await res.json()) as {
        model: string;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
        choices: Array<{ message: ChatPart }>;
      };
      const msg = data.choices?.[0]?.message;
      if (!msg) throw new Error("Response has no message");
      return {
        content: msg.content || "",
        toolCalls: (msg.tool_calls || []).map((tc) => ({
          id: tc.id || `call_${Math.random().toString(36).slice(2)}`,
          name: tc.function?.name,
          args: safeJson(tc.function?.arguments),
        })),
        raw: msg,
        usage: data.usage,
        model: data.model || OPENAI_MODEL_ID,
      };
    } catch (e) {
      const err = e as Error & { fatal?: boolean };
      lastErr = err;
      if (err.fatal) break;
      if (!retryable(err.message || String(e))) break;
      const wait = 2000 * Math.pow(2, attempt - 1);
      console.error(`[llm] retry ${attempt}/${MAX_ATTEMPTS} after ${wait / 1000}s: ${err.message.slice(0, 120)}`);
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
