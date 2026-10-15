// Per-turn reflexion auto-store (python Gate-1 parity, escalation-validated).
//
// The python harness teaches the agent to persist ONE reflexion episode
// whenever a turn carries a lesson (error recovery, user corrections, 5+
// tool calls, non-obvious workflow) — but its own traces proved the model
// under-fires on that (14 genuine sessions → 0 episodes is what triggered
// Gate-1 escalation B in the first place). This closes the loop
// deterministically: after EVERY completed turn, one cheap model review of
// the flattened transcript; if the turn is lesson-worthy, it calls the
// bound agentdb_reflexion_store tool. Fire-and-forget, never raises —
// episodes land in the agentdb store (never the archive).
//
// A related but different loop is the periodic NUDGE (every NUDGE_INTERVAL
// turns), which persists curated prompt-memory; this hook is strictly
// per-turn episodes.

import type { ChatMessage, ToolDef } from "./types.js";
import { chat } from "./llm.js";
import { log } from "./logger.js";
import { trace } from "./tracing.js";
import { flattenTranscript } from "./nudge.js";

const REVIEW_SYSTEM_PROMPT =
  "You audit a completed AI-agent turn for lessons worth persisting for " +
  "future sessions. A lesson is: an error the agent recovered from (with " +
  "its fix), a correction the user made to the agent's approach, a " +
  "non-obvious workflow that turned out to work, or a discrete outcome " +
  "worth replaying on a similar future task. If the turn has such a " +
  "lesson, call the agentdb_reflexion_store tool ONCE with: session_id " +
  "(short stable slug for the task), task (phrased like a retrievable " +
  "query describing the kind of task), reward (0-1 overall success), " +
  "success (boolean), critique (one terse paragraph on what to do/avoid " +
  "next time). If the turn has NO lesson, reply exactly: no episode";

export async function maybeStoreReflexion(
  sessionId: string,
  newMessages: ChatMessage[],
  storeTool: ToolDef | null,
  chatFn: typeof chat = chat,
): Promise<void> {
  if (process.env.AGENTDB_REFLEXION_AUTOSTORE === "0") return;
  if (!storeTool) return;
  const rootRun = trace.create({
    name: "reflexion-autostore",
    runType: "chain",
    inputs: { session: sessionId, messages: newMessages.length },
    tags: ["nm-finance-agent", "reflexion", "per-turn"],
  });
  const payload: ChatMessage[] = [
    { role: "system", content: REVIEW_SYSTEM_PROMPT },
    {
      role: "user",
      content:
        `RECENT TURN:\n\n${flattenTranscript(newMessages)}\n\n` +
        "Audit now (call agentdb_reflexion_store once, or reply: no episode).",
    },
  ];
  const llmRun = trace.create({
    name: "reflexion-review[llm]",
    runType: "llm",
    inputs: { messages: payload },
    parent: rootRun,
    tags: ["nm-finance-agent", "reflexion"],
  });
  try {
    const response = await chatFn(payload, undefined, { noReasoning: true });
    trace.update(llmRun, { outputs: { model: response.model, usage: response.usage, text: response.content } });
    const text = response.content.trim();
    if (/^no episode\b/i.test(text) || /\bno episode\b/i.test(text.slice(0, 30))) {
      trace.update(rootRun, { outputs: { stored: false, reason: "no lesson judged" } });
      return;
    }
    // accept either a tool call (provider tool calling) or a JSON payload
    const fromCalls = response.toolCalls.find((c) => /reflexion_store/i.test(c.name));
    const args = fromCalls ? fromCalls.args : parseEpisodeArgs(text);
    if (!args) {
      trace.update(rootRun, { outputs: { stored: false, reason: "no episode args" } });
      return;
    }
    const toolRun = trace.create({
      name: storeTool.name,
      runType: "tool",
      inputs: args,
      parent: rootRun,
      tags: ["nm-finance-agent", "reflexion"],
    });
    const result = String(await storeTool.execute(args));
    trace.update(toolRun, {
      outputs: { result: result.slice(0, 300) },
      error: result.startsWith("Error:") ? result.slice(0, 200) : undefined,
    });
    trace.update(rootRun, { outputs: { stored: true, result: result.slice(0, 160) } });
    log.info(`reflexion autostore [${sessionId.slice(0, 8)}]: ${result.slice(0, 120)}`);
  } catch (e) {
    trace.update(rootRun, { outputs: { error: String(e).slice(0, 160) }, error: String(e).slice(0, 160) });
    log.warn(`reflexion autostore failed: ${String(e).slice(0, 160)}`);
  }
}

/** Pull episode args from a raw JSON block in the model text, if present. */
export function parseEpisodeArgs(text: string): {
  session_id?: string;
  task?: string;
  reward?: number;
  success?: boolean;
  critique?: string;
} | null {
  const m = /\{[\s\S]*"task"[\s\S]*\}/i.exec(text);
  if (!m) return null;
  try {
    const obj = JSON.parse(m[0]) as Record<string, unknown>;
    if (obj && typeof obj.task === "string") return obj as never;
    return null;
  } catch {
    return null;
  }
}
