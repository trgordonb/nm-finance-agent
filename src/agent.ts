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
import { MEMORY_CHAR_LIMIT, OPENROUTER_MODEL_MAIN, BUDGET_WRAPUP_REMAINING } from "./config.js";
import type { ChatMessage, ToolDef, ToolCall } from "./types.js";
import type { SessionDriver } from "./driver.js";
import type { AgentDbMirror } from "./agentdb-mirror.js";
import { trace, llmRunMetadata, llmRunOutputs } from "./tracing.js";
import { getSkillLibrary } from "./tools/skill_tools.js";
import { agentdbCognitiveBlock } from "./agentdb-hooks.js";
import type { SearchSummarizer } from "./summarizer.js";

import { currentWorkspaceRoot } from "./workspace.js";

export function buildSystemPrompt(memoryBlock: string, workspaceRoot: string): string {
  const base =
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
    "WORKSPACE (yours: `" + workspaceRoot + "`):\n" +
    "All your file tools and shell commands are workspace-rooted — relative paths and " +
    "script outputs land in this folder automatically. Put every artifact you " +
    "produce (reports, downloads, datasets, scripts) there; use absolute paths only to " +
    "read outside sources. Writes into the harness's own source dirs are rejected.\n" +
    "`$WORKSPACE_DIR` is exported to your shells and points at this folder; use it " +
    "when a SKILL.md command needs an absolute path.\n" +
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
  /** Per-turn visibility policy (MCP per-user toggles); null = all bound. */
  private toolPolicy: ((name: string) => boolean) | null = null;
  /** Injectable for contract tests; production uses the shared chat client. */
  private chatFn: typeof chat;

  constructor(opts: {
    memory: PromptMemory;
    store: SessionDriver;
    tools?: ToolDef[];
    mirror?: AgentDbMirror | null;
    summarizer?: SearchSummarizer | null;
    maxIterations?: number;
    chatFn?: typeof chat;
  }) {
    this.memory = opts.memory;
    this.maxIterations = opts.maxIterations ?? Number(process.env.BUDGET_TOOL_MAX_ITERATIONS ?? "25");
    this.chatFn = opts.chatFn ?? chat;
    const base = opts.tools ?? buildToolRegistry(opts.store, opts.mirror, opts.summarizer);
    this.tools = new Map<string, ToolDef>(base.map((t) => [t.name, t]));
  }

  /** Replace the bound tool set (MCP runtime reload). New list applies to
   *  every subsequent turn; in-flight turns keep their own registry. */
  setTools(tools: ToolDef[]): void {
    this.tools = new Map<string, ToolDef>(tools.map((t) => [t.name, t]));
  }

  /** Install/remove the per-turn tool visibility policy. */
  setToolPolicy(policy: ((name: string) => boolean) | null): void {
    this.toolPolicy = policy;
  }

  isToolEnabled(name: string): boolean {
    return !this.toolPolicy || this.toolPolicy(name);
  }

  private enabledTools(): ToolDef[] {
    return [...this.tools.values()].filter((t) => this.isToolEnabled(t.name));
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
    meta?: { sessionId?: string; signal?: AbortSignal; episodeContext?: string },
    onMessage?: (msg: ChatMessage) => void,
  ): Promise<TurnResult> {
    const messages: ChatMessage[] = [...history, { role: "user", content: userInput }];
    const episodeContext = meta?.episodeContext ?? "";
    const enabledTools = this.enabledTools();
    const hasReflexion = enabledTools.some(
      (t) => t.name === "reflexion_store" || t.name.endsWith("_reflexion_store"),
    );
    const systemPrompt =
      buildSystemPrompt(this.memory.load(), currentWorkspaceRoot()) +
      agentdbCognitiveBlock(hasReflexion) +
      (episodeContext ? `\n${episodeContext}` : "");
    const wire = toWire(enabledTools);
    const toolNames = enabledTools.map((t) => t.name);
    const newSlice: ChatMessage[] = [];
    let iterations = 0;
    let fatal: string | undefined;
    let cancelled = false;
    let wrapupInjected = false;
    const usage = { prompt_tokens: 0, completion_tokens: 0 };

    const skillsList = getSkillLibrary().listSkills().map((s) => s.name);
    const promptEpisodeContext = meta?.episodeContext ?? "";
    const turnRun = trace.create({
      name: "agent-turn",
      runType: "chain",
      inputs: {
        message: userInput,
        // surrounding context the model actually saw (user-visible gap:
        // only the query was recorded before)
        history_messages: history.length,
        memory_chars: this.memory.totalChars(),
        skills: skillsList,
        skills_index_chars: skillsList.length ? getSkillLibrary().renderIndex().length : 0,
        episode_context_chars: promptEpisodeContext.length,
        tool_count: enabledTools.length,
      },
      tags: ["nm-finance-agent"],
      metadata: {
        session_id: meta?.sessionId ?? "",
      },
    });

    let result: TurnResult | undefined;

    for (let i = 0; i < this.maxIterations; i++) {
      if (shouldStop?.()) {
        cancelled = true;
        break;
      }
      iterations = i + 1;
      // Budget wrap-up: with only a few iterations left, tell the model once
      // to land the turn (persist state, end with a summary) instead of dying
      // at the hard cap mid-step. Injected into messages only — like the
      // empty-retry nudge below, it is not part of the persisted slice.
      const remaining = this.maxIterations - i;
      if (remaining === BUDGET_WRAPUP_REMAINING && !wrapupInjected) {
        wrapupInjected = true;
        messages.push({
          role: "user",
          content:
            `Tool budget: ${remaining} of ${this.maxIterations} iterations left. Wrap up now: ` +
            "finish or safely stop the current step, persist anything needed to resume in a later " +
            "turn (files on disk), and end this turn with a brief summary of what was completed " +
            "and what remains. Do not start new multi-step work.",
        });
      }
      const llmRun = trace.create({
        name: `llm:${i + 1}`,
        runType: "llm",
        inputs: { messages: [{ role: "system", content: systemPrompt }, ...messages], tools: toolNames },
        parent: turnRun,
        tags: ["nm-finance-agent"],
        metadata: llmRunMetadata(OPENROUTER_MODEL_MAIN),
      });
      const isAbort = (e: unknown): boolean =>
        Boolean(meta?.signal?.aborted) || (e as Error)?.name === "AbortError";
      let response: Awaited<ReturnType<typeof chat>>;
      try {
        response = await this.chatFn(
          [{ role: "system", content: systemPrompt }, ...messages],
          wire,
          meta?.signal ? { signal: meta.signal } : undefined,
        );
      } catch (e) {
        if (isAbort(e)) {
          cancelled = true;
          break;
        }
        throw e;
      }
      if (response.usage) {
        usage.prompt_tokens += response.usage.prompt_tokens ?? 0;
        usage.completion_tokens += response.usage.completion_tokens ?? 0;
      }
      const completionMeta = (resp: typeof response): Record<string, unknown> => ({
        ...llmRunMetadata(resp.model, resp.usage),
        ...(resp.provider ? { provider: resp.provider } : {}),
        ...(resp.finishReason ? { finish_reason: resp.finishReason } : {}),
      });
      trace.update(llmRun, {
        outputs: llmRunOutputs(response.content, {
          usage: response.usage,
          message: { role: "assistant", content: response.content, tool_calls: response.toolCalls },
        }),
        metadata: completionMeta(response),
      });

      // A provider can return an empty assistant message after spending its
      // output budget on reasoning (GLM live 2026-10-20: 737 reasoning tokens,
      // no content, no tool calls). Without this guard the turn silently ends
      // with an empty assistant row. Retry once at low effort, then fail loudly.
      if (!response.toolCalls.length && !response.content.trim()) {
        if (shouldStop?.()) {
          cancelled = true;
          break;
        }
        const retryNudge: ChatMessage = {
          role: "user",
          content:
            "Your previous response was empty. If the task requires a tool, call it now; otherwise give a concise answer.",
        };
        const retryRun = trace.create({
          name: `llm:${i + 1}:empty-retry`,
          runType: "llm",
          inputs: {
            messages: [{ role: "system", content: systemPrompt }, ...messages, retryNudge],
            tools: toolNames,
          },
          parent: turnRun,
          tags: ["nm-finance-agent"],
          metadata: llmRunMetadata(OPENROUTER_MODEL_MAIN),
        });
        let retry: Awaited<ReturnType<typeof chat>>;
        try {
          retry = await this.chatFn(
            [{ role: "system", content: systemPrompt }, ...messages, retryNudge],
            wire,
            { reasoningEffort: "low", ...(meta?.signal ? { signal: meta.signal } : {}) },
          );
        } catch (e) {
          if (isAbort(e)) {
            cancelled = true;
            break;
          }
          throw e;
        }
        if (retry.usage) {
          usage.prompt_tokens += retry.usage.prompt_tokens ?? 0;
          usage.completion_tokens += retry.usage.completion_tokens ?? 0;
        }
        trace.update(retryRun, {
          outputs: llmRunOutputs(retry.content, {
            usage: retry.usage,
            message: { role: "assistant", content: retry.content, tool_calls: retry.toolCalls },
          }),
          metadata: completionMeta(retry),
        });
        if (!retry.toolCalls.length && !retry.content.trim()) {
          fatal = "model returned an empty response twice (reasoning-token exhaustion?)";
          result = { messages: newSlice, iterations, cancelled, fatal, usage };
          break;
        }
        response = retry;
      }

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
        if (tool && !this.isToolEnabled(call.name)) {
          resultStr = `Rejected: tool ${call.name} is disabled for this user`;
        } else if (!tool) {
          // Unknown tool name is a wrong-args denial (models occasionally use
          // another harness's vocabulary, e.g. `write` for `write_file`) —
          // recoverable: tell the model what IS bound and continue.
          resultStr = unknownToolMessage(call.name, toolNames);
        } else {
          try {
            resultStr = await tool.execute(call.args ?? {}, { signal: meta?.signal });
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
