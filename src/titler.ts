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
import { trace } from "./tracing.js";
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
  const prompt: Array<{ role: "system" | "user"; content: string }> = [
    { role: "system", content: TITLE_SYSTEM },
    {
      role: "user",
      content:
        `User asked: ${firstUserMessage.slice(0, 500)}\n\n` +
        `Agent's first reply (excerpt): ${(firstAssistantReply || "(empty)").slice(0, 300)}\n\n` +
        "One-line title:",
    },
  ];
  // Free-tier models occasionally return HTTP 200 with an empty body — one
  // spaced retry, then surface the failure (the fallback title stays).
  let lastErr: Error | null = null;
  const rootRun = trace.create({
    name: "session-title",
    runType: "chain",
    inputs: { user_message: firstUserMessage.slice(0, 280), reply_excerpt: firstAssistantReply.slice(0, 200) },
    tags: ["nm-finance-agent", "titler"],
  });
  for (let attempt = 1; attempt <= 2; attempt++) {
    const llmRun = trace.create({
      name: `title-attempt${attempt}`,
      runType: "llm",
      inputs: { messages: prompt, model: OPENROUTER_MODEL_SUMMARIZER },
      parent: rootRun,
      tags: ["nm-finance-agent", "titler"],
    });
    try {
      const response = await chat(prompt, undefined, {
        model: OPENROUTER_MODEL_SUMMARIZER,
        noReasoning: true,
      });
      trace.update(llmRun, { outputs: { model: response.model, usage: response.usage, text: response.content } });
      const title = response.content
        .trim()
        .replace(/^["'“”]+|["'“”]+$/g, "")
        .replace(/\.$/, "")
        .slice(0, 80)
        .trim();
      if (!title || title.length < 4) throw new Error("empty title response");
      trace.update(rootRun, { outputs: { title, model: response.model } });
      return { title, model: `openrouter/${OPENROUTER_MODEL_SUMMARIZER}` };
    } catch (e) {
      const msg = String(e).slice(0, 160);
      trace.update(llmRun, { error: msg });
      if (attempt === 2) trace.update(rootRun, { outputs: { error: msg }, error: msg });
      lastErr = e as Error;
      if (attempt === 1) await new Promise((r) => setTimeout(r, 2000));
    }
  }
  throw lastErr ?? new Error("title refine failed");
}
