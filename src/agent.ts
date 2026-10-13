// Basic agentic loop — the LangGraph demo's StateGraph("agent" → tool →
// "agent" → …) flattened into an explicit async loop. Same semantics:
//   - system prompt = role + prompt-memory block (loaded once per session)
//   - model may return 0..n tool calls; all are executed, results appended,
//     loop repeats until a plain text response (or "Error:"-prefixed tool
//     result → turn ends, exactly like should_continue → END)
//   - returns the full new-message slice for the caller to persist + post-process

import { chat } from "./llm.js";
import { toWire, buildToolRegistry } from "./tools/index.js";
import { PromptMemory } from "./memory.js";
import { MEMORY_CHAR_LIMIT } from "./config.js";
import type { ChatMessage, ToolDef, ToolCall } from "./types.js";
import type { SessionDriver } from "./driver.js";
import type { AgentDbMirror } from "./agentdb-mirror.js";
import { trace } from "./tracing.js";
import { getSkillLibrary } from "./tools/skill_tools.js";
import type { SearchSummarizer } from "./summarizer.js";

export function buildSystemPrompt(memoryBlock: string): string {  const base =
    "You are an adaptable AI agent.\n" +
    "\n" +
    "SESSION MEMORY (episodic, on-demand):\n" +
    "session_search queries your archived past sessions. Call it BEFORE redoing work " +
    "when the user's request may relate to something from a previous conversation — " +
    "prior decisions, findings, errors and their fixes, or procedures you already " +
    "worked out. It returns short excerpts, not full transcripts.\n" +
    "\n" +
    "PROMPT MEMORY (always-on, self-curated):\n" +
    "memory_manage edits your MEMORY.md (facts/decisions relevant to EVERY future " +
    "session) and USER.md (who the user is, preferences, working style). Combined " +
    `budget: ${MEMORY_CHAR_LIMIT} chars — keep entries terse, consolidate instead of accumulating. ` +
    "Do NOT store topic-specific findings there; leave those to the session archive. " +
    "Memory edits take effect from the NEXT session, never mid-conversation.\n" +
    "\n" +
    "WORKSPACE:\n" +
    "All your file tools and shell commands are workspace-rooted — relative paths and " +
    "script outputs land in the workspace dir automatically. Put every artifact you " +
    "produce (reports, downloads, datasets, scripts) there; use absolute paths only to " +
    "read outside sources. Writes into the harness's own source dirs are rejected.\n" +
    "IMPORTANT: for skills/ scripts referenced in SKILL.md bodies, use their " +
    "ABSOLUTE paths — $SKILLS_DIR is exported to your shells and points at the " +
    "skills root (your commands run with the workspace as cwd, so bare " +
    "`skills/...` paths would miss). Wrong-file attempts return the exact " +
    "absolute path to re-run with.\n" +
    "\n" +
    "SKILLS (procedural memory, on demand):\n" +
    "The skills index below lists names + descriptions ONLY. If a listed skill " +
    "matches the task, call load_skill(name) FIRST and follow its loaded " +
    "instructions before falling back to generic approaches. You can curate " +
    "skills with skill_manage (create/patch/edit/delete/write_file/remove_file); " +
    "PREFER patch for updates — targeted and safe, unlike full rewrites.\n";

  let prompt = base;
  if (memoryBlock) prompt += `\n${memoryBlock}\n`;
  const skillsIndex = getSkillLibrary().renderIndex();
  if (skillsIndex) prompt += `${skillsIndex}\n`;
  return prompt;
}

export interface TurnResult {
  messages: ChatMessage[]; // the new slice (assistant/tool messages of this turn)
  iterations: number;
  fatal?: string; // set when a tool result or system error ended the turn
  cancelled?: boolean; // stop was requested mid-turn; messages may end dangling
  usage: { prompt_tokens: number; completion_tokens: number };
}

export class AgentLoop {
  tools: Map<string, ToolDef>;
  private memory: PromptMemory;
  private maxIterations: number;

  constructor(opts: { memory: PromptMemory; store: SessionDriver; tools?: ToolDef[]; mirror?: AgentDbMirror | null; summarizer?: SearchSummarizer | null; maxIterations?: number }) {
    this.memory = opts.memory;
    this.maxIterations = opts.maxIterations ?? Number(process.env.BUDGET_TOOL_MAX_ITERATIONS ?? "25");
    const base = opts.tools ?? buildToolRegistry(opts.store, opts.mirror, opts.summarizer);
    this.tools = new Map<string, ToolDef>(base.map((t) => [t.name, t]));
  }

  /** Replace the bound tool set (MCP runtime reload). New list applies to
   *  every subsequent turn; in-flight turns keep their own registry. */
  setTools(tools: ToolDef[]): void {
    this.tools = new Map<string, ToolDef>(tools.map((t) => [t.name, t]));
  }

  /** Memory block is rendered once per session by callers and passed in here.
   *  Tracing: one root "agent-turn" chain run per turn with llm/tool children
   *  (LangSmith REST runs API — fire-and-forget, never breaks the turn).
   *  onMessage fires the moment each assistant/tool message lands in the
   *  slice — the REST layer streams these as SSE events incrementally. */
  async runTurn(
    history: ChatMessage[],
    userInput: string,
    shouldStop?: () => boolean,
    meta?: { sessionId?: string },
    onMessage?: (msg: ChatMessage) => void,
  ): Promise<TurnResult> {
    const messages: ChatMessage[] = [...history, { role: "user", content: userInput }];
    const systemPrompt = buildSystemPrompt(this.memory.load());
    const wire = toWire([...this.tools.values()]);
    const toolNames = [...this.tools.keys()];
    const newSlice: ChatMessage[] = [];
    let iterations = 0;
    let fatal: string | undefined;
    let cancelled = false;
    const usage = { prompt_tokens: 0, completion_tokens: 0 };

    const turnRun = trace.create({
      name: "agent-turn",
      runType: "chain",
      inputs: { message: userInput },
      tags: ["nm-finance-agent"],
      metadata: {
        session_id: meta?.sessionId ?? "",
        memory_chars: this.memory.totalChars(),
        history_messages: history.length,
      },
    });

    let result: TurnResult | undefined;

    for (let i = 0; i < this.maxIterations; i++) {
      if (shouldStop?.()) {
        cancelled = true;
        break;
      }
      iterations = i + 1;
      const llmRun = trace.create({
        name: `llm:${i + 1}`,
        runType: "llm",
        inputs: { messages: [{ role: "system", content: systemPrompt }, ...messages], tools: toolNames },
        parent: turnRun,
        tags: ["nm-finance-agent"],
      });
      const response = await chat([{ role: "system", content: systemPrompt }, ...messages], wire);
      if (response.usage) {
        usage.prompt_tokens += response.usage.prompt_tokens ?? 0;
        usage.completion_tokens += response.usage.completion_tokens ?? 0;
      }
      trace.update(llmRun, {
        outputs: {
          generations: [
            {
              text: response.content,
              message: { role: "assistant", content: response.content, tool_calls: response.toolCalls },
              usage: response.usage ?? {},
            },
          ],
          model: response.model,
        },
      });

      if (!response.toolCalls.length) {
        if (shouldStop?.()) {
          cancelled = true;
          break;
        }
        const out: ChatMessage = {
          role: "assistant",
          content: response.content,
          usage: response.usage,
        };
        messages.push(out);
        newSlice.push(out);
        onMessage?.(out);
        result = { messages: newSlice, iterations, cancelled, usage };
        break;
      }

      const calls: ToolCall[] = response.toolCalls.map((c) => ({
        id: c.id,
        name: c.name,
        args: c.args ?? {},
      }));
      const assistantMsg: ChatMessage = {
        role: "assistant",
        content: response.content || "",
        tool_calls: calls,
        usage: response.usage,
      };
      messages.push(assistantMsg);
      newSlice.push(assistantMsg);
      onMessage?.(assistantMsg);

      for (const call of calls) {
        if (shouldStop?.()) {
          cancelled = true;
          break;
        }
        const toolRun = trace.create({
          name: call.name,
          runType: "tool",
          inputs: (call.args ?? {}) as Record<string, unknown>,
          parent: turnRun,
          tags: ["nm-finance-agent"],
        });
        const tool = this.tools.get(call.name);
        let resultStr: string;
        if (!tool) {
          // Unknown tool name is a wrong-args denial (models occasionally use
          // another harness's vocabulary, e.g. `write` for `write_file`) —
          // recoverable: tell the model what IS bound and continue.
          resultStr = unknownToolMessage(call.name, [...this.tools.keys()]);
        } else {
          try {
            resultStr = await tool.execute(call.args ?? {});
          } catch (e) {
            resultStr = `Error: tool ${call.name} raised: ${(e as Error).message}`.slice(0, 2000);
          }
        }
        trace.update(toolRun, {
          outputs: { result: resultStr },
          error: resultStr.startsWith("Error:") ? resultStr.slice(0, 400) : undefined,
        });
        const toolMsg: ChatMessage = {
          role: "tool",
          content: resultStr,
          tool_call_id: call.id,
          name: call.name,
        };
        messages.push(toolMsg);
        newSlice.push(toolMsg);
        onMessage?.(toolMsg);
        if (resultStr.startsWith("Error:")) {
          fatal = `${call.name}: ${resultStr.slice(0, 300)}`;
          break;
        }
      }
      if (fatal) break;
    }

    if (!result) {
      if (!cancelled && !fatal) fatal = "max tool iterations reached";
      result = { messages: newSlice, iterations, cancelled, fatal, usage };
    }

    trace.update(turnRun, {
      outputs: {
        final_message: newSlice[newSlice.length - 1]?.content ?? "",
        iterations,
        usage,
        cancelled,
      },
      error: fatal,
    });

    return result;
  }
}

/** Recoverable denial for a tool name outside the bound registry, with a
 *  vocabulary hint so the model re-routes on its own (e.g. write → write_file). */
export function unknownToolMessage(name: string, bound: string[]): string {
  const lower = name.toLowerCase();
  const suggestion = bound.find(
    (t) => t.toLowerCase().startsWith(lower) || t.toLowerCase().includes(lower),
  );
  return (
    `Rejected: unknown tool ${JSON.stringify(name)} — no tool with that name is bound.` +
    ` Bound tools: ${bound.join(", ")}.` +
    (suggestion ? ` Did you mean ${suggestion}?` : "")
  );
}
