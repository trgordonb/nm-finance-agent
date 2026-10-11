// Periodic nudge: agent-curated memory (the learning loop's curation step).
// Port of nm_memory_layer/nudge.py + langgraph-demo main.py's nudge plumbing:
// every `interval` completed turns the harness fires an internal LLM call —
// no user input — asking the agent to review the turn and decide what to keep:
//   memory_manage → prompt memory (facts needed EVERY future session)
//   skill_manage  → procedural memory turn-creations (Gate-1-style binding)
//   nothing → episodic detail already lives in the session archive
//
// The nudge sees the turn as a flattened plain-text transcript (different
// toolset bound: no tool_call/tool_result pairing constraints), with current
// memory contents + skills index inline. Bias toward silence by design; the
// nudge call itself is never written to the archive.

import type { ChatMessage } from "./types.js";
import { MEMORY_CHAR_LIMIT } from "./config.js";
import { chat } from "./llm.js";
import { PromptMemory } from "./memory.js";
import type { ToolDef } from "./types.js";

export const DEFAULT_NUDGE_INTERVAL = 5;

/** Turns-since-last-nudge per session; fires every `interval` turns. */
export class NudgePolicy {
  readonly interval: number;
  private since = new Map<string, number>();

  constructor(interval: number = DEFAULT_NUDGE_INTERVAL) {
    this.interval = Math.max(1, interval);
  }

  recordTurn(sessionId: string): void {
    this.since.set(sessionId, (this.since.get(sessionId) ?? 0) + 1);
  }

  shouldNudge(sessionId: string): boolean {
    return (this.since.get(sessionId) ?? 0) >= this.interval;
  }

  markNudged(sessionId: string): void {
    this.since.set(sessionId, 0);
  }

  turnsPending(sessionId: string): number {
    return this.since.get(sessionId) ?? 0;
  }
}

/** System prompt for the internal nudge LLM call (python parity). */
export function buildNudgePrompt(charsUsed: number, charBudget: number = MEMORY_CHAR_LIMIT): string {
  return (
    "You are the memory curator inside an AI agent. You are reviewing one " +
    "completed conversation turn — no user is present and nothing is asked of the user.\n\n" +
    "Decide what, if anything, is worth persisting for FUTURE sessions, using the " +
    "memory_manage tool:\n" +
    '1. target="memory" — facts, decisions, environment quirks, or procedures that ' +
    "will matter in EVERY future session (one terse line per entry).\n" +
    '2. target="user" — durable user preferences or working style observed in the turn.\n' +
    "3. Nothing — task-specific and episodic detail already lives in the session " +
    "archive (searchable via session_search) and must NOT be duplicated here.\n\n" +
    "SKILLS: if the turn crossed a skill-creation trigger — 5+ tool calls, recovery " +
    "from an error, a user correction, or a non-obvious workflow that worked — " +
    'capture it with the skill_manage tool instead (action="create" with a terse ' +
    'step-by-step body; action="patch" for updates to an existing skill). Skills ' +
    "are procedures; prompt memory is facts. Do not duplicate one in the other.\n\n" +
    "Rules:\n" +
    "- Most turns produce NO writes. Silence is a valid and expected outcome; write " +
    "only what clears the bar of 'useful in a future session'.\n" +
    "- Never re-add what is already recorded — current memory contents and the " +
    "skills index are shown below.\n" +
    `- Keep memory entries terse. Combined MEMORY.md + USER.md budget is ${charBudget} chars ` +
    `(${charsUsed} already used); writes over budget are rejected.\n` +
    "- You may call memory_manage / skill_manage multiple times. When finished — or " +
    "immediately, if nothing is worth keeping — reply with a one-line summary (e.g. " +
    "'No memory updates.' or 'Saved 1 entry to MEMORY.md.').\n"
  );
}

/** Render messages as a plain-text transcript safe to send with a different
 *  toolset bound (no tool_call/tool_result pairing constraints). */
export function flattenTranscript(messages: ChatMessage[]): string {
  const lines: string[] = [];
  for (const message of messages) {
    // plain-text roles (tool results rendered as labeled narration)
    const role =
      message.role === "tool"
        ? `tool result (${message.name || "tool"})`
        : message.role;
    let content = String(message.content ?? "").trim();
    if (message.tool_calls?.length && !content) {
      content = message.tool_calls
        .map((call) => `[called ${call.name}(${JSON.stringify(call.args)})]`)
        .join("; ");
    }
    if (content) lines.push(`${role}: ${content}`);
  }
  return lines.join("\n\n");
}

interface NudgeTool {
  name: string;
  description: string;
  parameters: unknown;
  execute(args: Record<string, unknown>): Promise<string> | string;
}

/** One internal curation review over a completed turn (no user input).
 *  Tools are maintained by the caller (memory_manage + skill_manage + any
 *  cognitive-memory extras bound). Returns the one-line summary; never throws. */
export async function run_memory_nudge(
  recentMessages: ChatMessage[],
  memory: PromptMemory,
  nudgeTools: NudgeTool[],
  mainModelChat: typeof chat,
): Promise<string> {
  if (!recentMessages.length) return "No memory updates.";
  const toolMap = new Map(nudgeTools.map((t) => [t.name, t]));
  const wire = nudgeTools.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }));

  const convo: ChatMessage[] = [
    {
      role: "system",
      content: buildNudgePrompt(memory.totalChars(), MEMORY_CHAR_LIMIT),
    },
    {
      role: "system",
      content: `Current memory contents:\n${memory.load() || "(empty)"}`,
    },
    {
      role: "user",
      content: `RECENT CONVERSATION TURN:\n\n${flattenTranscript(recentMessages)}\n\nReview it now and persist anything that clears the bar.`,
    },
  ];

  const maxIters = 3; // python run_memory_nudge parity
  let summary: string | undefined;
  for (let i = 0; i < maxIters; i++) {
    try {
      const response = await mainModelChat(convo, wire);
      if (!response.toolCalls?.length) {
        summary = (response.content || "No memory updates.").trim().slice(0, 200) || "No memory updates.";
        break;
      }
      convo.push({ role: "assistant", content: response.content, tool_calls: response.toolCalls });
      for (const call of response.toolCalls) {
        const tool = toolMap.get(call.name);
        let result: string;
        if (!tool) {
          result = `Rejected: unknown tool ${call.name} during nudge`;
        } else {
          try {
            result = await tool.execute(call.args ?? {});
          } catch (e) {
            result = `${call.name} failed: ${String(e).slice(0, 200)}`;
          }
        }
        convo.push({ role: "tool", content: result, tool_call_id: call.id, name: call.name });
      }
    } catch (e) {
      // never raises by contract: nudge failures are log-only
      return `nudge failed: ${String(e).slice(0, 160)}`;
    }
  }
  if (summary === undefined) summary = "Nudge reached its tool-call limit.";
  return summary.slice(0, 200);
}
