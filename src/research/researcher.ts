// Researcher sub-loop: an isolated context window that runs the tool loop
// (tavily_search / think_tool) and then compresses its findings — a flattened
// port of the thinkdepth-ai research_agent.py
// (llm_call → tool_node → compress_research). Parallel tool calls execute
// concurrently with their result order preserved (ThreadPoolExecutor parity),
// and the per-researcher token budget force-routes to compression.

import type { ChatMessage } from "../types.js";
import { toWire } from "../tools/index.js";
import { trace } from "../tracing.js";
import {
  compress_research_human_message,
  compress_research_system_prompt,
  research_agent_prompt,
} from "./prompts.js";
import type { ResearchDeps, ResearcherResult, ResearchUsage } from "./types.js";
import { addUsage, ensureNotStopped, fillPrompt, getTodayStr, totalTokens } from "./util.js";

export async function runResearcher(topic: string, deps: ResearchDeps): Promise<ResearcherResult> {
  const usage: ResearchUsage = { prompt_tokens: 0, completion_tokens: 0 };
  const toolMap = new Map(deps.researchTools.map((tool) => [tool.name, tool]));
  const wire = toWire(deps.researchTools);
  const messages: ChatMessage[] = [{ role: "user", content: topic }];
  const systemPrompt = fillPrompt(research_agent_prompt, { date: getTodayStr() });
  let tokens = 0;
  let searches = 0;

  for (let turn = 0; turn < deps.limits.maxResearcherTurns; turn++) {
    ensureNotStopped(deps);
    const response = await deps.chat([{ role: "system", content: systemPrompt }, ...messages], wire, {
      model: deps.roles.toolLoop,
      signal: deps.signal,
      minIntervalMs: deps.limits.minCallIntervalMs,
      reasoningEffort: deps.limits.reasoningEffort,
      timeoutMs: deps.limits.llmTimeoutMs,
      maxAttempts: deps.limits.llmMaxAttempts,
      retryOnTimeout: true,
    });
    addUsage(usage, response.usage);
    tokens += totalTokens(response.usage);

    if (!response.toolCalls.length) {
      // Final answer — the Python router sends this straight to compress.
      messages.push({ role: "assistant", content: response.content });
      break;
    }

    messages.push({
      role: "assistant",
      content: response.content || "",
      tool_calls: response.toolCalls,
    });

    // Execute this turn's tool calls in parallel, preserving call order.
    const observations = await Promise.all(
      response.toolCalls.map(async (call) => {
        ensureNotStopped(deps);
        if (call.name === "tavily_search") {
          searches++;
          if (searches > deps.limits.maxResearcherSearches) {
            // Recoverable denial: the loop breaks after this turn and the
            // researcher compresses from the findings it already has.
            return `Rejected: search budget exhausted (${deps.limits.maxResearcherSearches} searches). Synthesize from the findings already collected.`;
          }
        }
        const tool = toolMap.get(call.name);
        if (!tool) {
          // Recoverable denial (harness convention): the model re-routes.
          return `Rejected: unknown tool ${JSON.stringify(call.name)}. Bound tools: ${[...toolMap.keys()].join(", ")}`;
        }
        const toolRun = deps.traceParent
          ? trace.create({
              name: `tool:${call.name}`,
              runType: "tool",
              inputs: (call.args ?? {}) as Record<string, unknown>,
              parent: deps.traceParent,
              tags: ["nm-finance-agent", "deep-research"],
            })
          : "";
        try {
          const observation = await tool.execute(call.args ?? {});
          if (toolRun) trace.update(toolRun, { outputs: { result: observation } });
          return observation;
        } catch (e) {
          const failure = `Error: tool ${call.name} failed: ${String((e as Error).message).slice(0, 300)}`;
          if (toolRun) trace.update(toolRun, { error: failure.slice(0, 400) });
          return failure;
        }
      }),
    );
    response.toolCalls.forEach((call, index) => {
      messages.push({
        role: "tool",
        content: observations[index] ?? "",
        tool_call_id: call.id,
        name: call.name,
      });
    });

    // Search budget is the hard stop: the prompt says 5 searches; the code
    // enforces a ceiling so turns with parallel searches cannot run away.
    if (searches >= deps.limits.maxResearcherSearches) break;
    // Token budget is the hard stop: over budget → compress immediately
    // (RESEARCH_TOKEN_BUDGET parity) instead of draining the shared quota.
    if (deps.limits.tokenBudget > 0 && tokens >= deps.limits.tokenBudget) break;
  }

  // compress_research: writer-tier cleanup that must lose zero facts/sources.
  ensureNotStopped(deps);
  const compressMessages: ChatMessage[] = [
    { role: "system", content: fillPrompt(compress_research_system_prompt, { date: getTodayStr() }) },
    ...messages,
    { role: "user", content: fillPrompt(compress_research_human_message, { research_topic: topic }) },
  ];
  const compressOpts = {
    model: deps.roles.writer,
    signal: deps.signal,
    minIntervalMs: deps.limits.minCallIntervalMs,
    reasoningEffort: deps.limits.reasoningEffort,
    timeoutMs: deps.limits.llmTimeoutMs,
    maxAttempts: deps.limits.llmMaxAttempts,
    retryOnTimeout: false,
    // ≤1,500-word contract; 32k cap parity with the Python compress tier.
    maxTokens: 32000,
  };
  const compressResponse = await deps.chat(compressMessages, undefined, compressOpts);
  addUsage(usage, compressResponse.usage);
  let compressed = compressResponse.content;
  if (!compressed.trim()) {
    // Same reasoning-exhaustion failure mode as refine; one low-effort retry.
    const retry = await deps.chat(compressMessages, undefined, compressOpts);
    addUsage(usage, retry.usage);
    compressed = retry.content;
  }

  // Raw notes: assistant + tool contents (python filter_messages tool+ai).
  const rawNotes = messages
    .filter((m) => m.role === "assistant" || m.role === "tool")
    .map((m) => m.content)
    .join("\n");

  return { topic, compressed, rawNotes, usage };
}
