// Session titler: one-line titles for UI session lists (python parity of
// main.py's maybe_title_session + create_openrouter_titler).
//
// After the FIRST completed turn:
//   1. synchronous fallback — truncated first user message — is stored
//      immediately so UI lists always have something;
//   2. an async refine via the secondary (cheap) OpenRouter model overwrites
//      the fallback with a proper one-liner, tagged with its model label.
// Titles are written once and never regenerated. Never raises — titles are
// cosmetic and must not touch the turn path.

import { chat } from "./llm.js";
import { OPENROUTER_MODEL_SUMMARIZER } from "./config.js";
export function fallbackTitle(text: string, limit: number = 60): string {
  const cleaned = String(text ?? "").replace(/\s+/g, " ").trim();
  if (cleaned.length <= limit) return cleaned;
  return `${cleaned.slice(0, limit - 1).trimEnd()}…`;
}

const TITLE_SYSTEM =
  "You write one-line session titles for a conversation list UI. " +
  "Answer with ONLY the title: 5-9 words, no quotes, no trailing period, " +
  "capitalize like a headline, concrete over generic (" +
  '"FVG backtest replication on EUR/USD", not "Trading research conversation").';

export async function refineSessionTitle(
  firstUserMessage: string,
  firstAssistantReply: string,
): Promise<{ title: string; model: string }> {
  const response = await chat(
    [
      { role: "system", content: TITLE_SYSTEM },
      {
        role: "user",
        content:
          `User asked: ${firstUserMessage.slice(0, 500)}\n\n` +
          `Agent's first reply (excerpt): ${(firstAssistantReply || "(empty)").slice(0, 300)}\n\n` +
          "One-line title:",
      },
    ],
    undefined,
    { model: OPENROUTER_MODEL_SUMMARIZER, noReasoning: true, },
  );
  const title = response.content.trim().replace(/^["“']|["”']\.*$/g, "").slice(0, 80).trim();
  if (!title || title.length < 4) throw new Error("empty title response");
  return { title, model: `openrouter/${OPENROUTER_MODEL_SUMMARIZER}` };
}
