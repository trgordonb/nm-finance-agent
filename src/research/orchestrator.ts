// Deep research orchestrator: the top-level pipeline — scope → (pause for
// clarification | brief → outline) → supervisor fan-out → final report. A
// flattened, LangGraph-free port of the thinkdepth-ai research_agent_full.py
// + research_agent_scope.py (docs/deep-research-plan.md).
//
// Latency/API notes:
// - Research LLM calls use the single OPENROUTER_MODEL_MAIN and a tighter
//   min-interval (RESEARCH_LLM_MIN_INTERVAL_MS) — the 4s global guard would
//   serialize the parallel researcher loops.
// - The whole engine is dependency-injected (deps.chat, deps.runSupervisor,
//   deps.runResearcher) so the contract tests run fully offline.

import {
  OPENROUTER_MODEL_MAIN,
  OPENROUTER_MODEL_SUMMARIZER,
  RESEARCH_DEADLINE_MINUTES,
  RESEARCH_LLM_MIN_INTERVAL_MS,
  RESEARCH_MAX_CONCURRENT,
  RESEARCH_MAX_RESEARCHER_TURNS,
  RESEARCH_MAX_SUPERVISOR_ITERATIONS,
  RESEARCH_PAGE_CONTEXT_CHARS,
  RESEARCH_SEARCH_MAX_RESULTS,
  RESEARCH_TOKEN_BUDGET,
} from "../config.js";
import { chat } from "../llm.js";
import { flattenTranscript } from "../nudge.js";
import { trace, llmRunMetadata, llmRunOutputs } from "../tracing.js";
import type { ChatMessage } from "../types.js";
import {
  clarify_with_user_instructions,
  draft_report_generation_prompt,
  final_report_generation_with_helpfulness_insightfulness_hit_citation_prompt,
  transform_messages_into_research_topic_human_msg_prompt,
} from "./prompts.js";
import { runResearcher } from "./researcher.js";
import { runSupervisor } from "./supervisor.js";
import { createResearchTools, tavilySearch } from "./tools.js";
import { ResearchCancelled } from "./types.js";
import type { ChatFn, ResearchDeps, ResearchOutcome, ResearchUsage } from "./types.js";
import { addUsage, ensureNotStopped, extractJson, fillPrompt, getTodayStr } from "./util.js";

function jsonInstruction(key: string): string {
  return `\nYou must respond with valid JSON in this exact format:\n{\n    "${key}": "Your ${key} here"\n}`;
}

/** Default dependency set; tests override `chat` / stage runners. */
export function buildResearchDeps(overrides: Partial<ResearchDeps> = {}): ResearchDeps {
  // Sanitize numeric env knobs: a NaN/zero cap (maxConcurrent especially)
  // would otherwise break loop arithmetic.
  const positive = (value: number, fallback: number): number =>
    Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
  const limits = {
    maxConcurrent: positive(RESEARCH_MAX_CONCURRENT, 3),
    maxSupervisorIterations: positive(RESEARCH_MAX_SUPERVISOR_ITERATIONS, 15),
    maxResearcherTurns: positive(RESEARCH_MAX_RESEARCHER_TURNS, 8),
    tokenBudget: Number.isFinite(RESEARCH_TOKEN_BUDGET) && RESEARCH_TOKEN_BUDGET > 0 ? RESEARCH_TOKEN_BUDGET : 0,
    searchMaxResults: positive(RESEARCH_SEARCH_MAX_RESULTS, 3),
    pageContextChars: positive(RESEARCH_PAGE_CONTEXT_CHARS, 60_000),
    deadlineMs: Number.isFinite(RESEARCH_DEADLINE_MINUTES) && RESEARCH_DEADLINE_MINUTES > 0 ? RESEARCH_DEADLINE_MINUTES * 60_000 : 0,
    minCallIntervalMs: Number.isFinite(RESEARCH_LLM_MIN_INTERVAL_MS) ? Math.max(0, RESEARCH_LLM_MIN_INTERVAL_MS) : 1200,
  };
  // Single-model decision: every research role runs on the main model; the
  // summarizer fallback keeps the repo's existing cheap summarizer role.
  const roles = {
    toolLoop: OPENROUTER_MODEL_MAIN,
    writer: OPENROUTER_MODEL_MAIN,
    summarizer: OPENROUTER_MODEL_SUMMARIZER,
  };
  const base: ResearchDeps = {
    chat,
    researchTools: createResearchTools({
      search: tavilySearch,
      chatFn: chat,
      summarizerModel: roles.summarizer,
      maxResults: limits.searchMaxResults,
      minIntervalMs: limits.minCallIntervalMs,
    }),
    limits,
    roles,
    emit: () => undefined,
    shouldStop: () => false,
    startedAt: Date.now(),
    runResearcher,
    runSupervisor,
  };
  return { ...base, ...overrides };
}

export interface RunDeepResearchOptions {
  /** Cleaned question (the `/research` prefix is stripped by the caller). */
  question: string;
  /** Prior session messages; continuations include the clarification Q/A. */
  history?: ChatMessage[];
  deps?: Partial<ResearchDeps>;
}

/** Wrap the chat client so every research LLM call is a LangSmith run child
 *  of the research root (fire-and-forget; tracing never breaks the run).
 *  Payloads follow the SDK conventions: full messages in, a generations
 *  output with the assistant message, usage_metadata + ls_model_name in
 *  metadata (token/cost panels). */
function tracedChat(base: ChatFn, parent: string, fallbackModel: string): ChatFn {
  let callIndex = 0;
  return async (messages, tools, opts) => {
    callIndex++;
    const model = opts?.model ?? fallbackModel;
    const runId = trace.create({
      name: `llm:research:${callIndex}`,
      runType: "llm",
      inputs: {
        messages,
        ...(tools?.length ? { tools: tools.map((tool) => tool.name) } : {}),
      },
      parent,
      tags: ["nm-finance-agent", "deep-research"],
      metadata: llmRunMetadata(model),
    });
    try {
      const response = await base(messages, tools, opts);
      trace.update(runId, {
        outputs: llmRunOutputs(response.content, {
          usage: response.usage,
          message: { role: "assistant", content: response.content, tool_calls: response.toolCalls },
        }),
        metadata: llmRunMetadata(response.model || model, response.usage),
      });
      return response;
    } catch (e) {
      trace.update(runId, { error: String((e as Error).message).slice(0, 400) });
      throw e;
    }
  };
}

export async function runDeepResearch(opts: RunDeepResearchOptions): Promise<ResearchOutcome> {
  const base = buildResearchDeps(opts.deps);
  const usage: ResearchUsage = { prompt_tokens: 0, completion_tokens: 0 };
  const messages: ChatMessage[] = [];
  // One root run per research run; every llm/tool call nests under it (the
  // agent-turn pattern, extended across the whole pipeline).
  const rootId = trace.create({
    name: "deep-research",
    runType: "chain",
    inputs: { question: opts.question },
    tags: ["nm-finance-agent", "deep-research"],
    metadata: { model: base.roles.toolLoop },
  });
  const deps: ResearchDeps = {
    ...base,
    chat: tracedChat(base.chat, rootId, base.roles.toolLoop),
    traceParent: rootId,
  };
  const callOpts = {
    model: deps.roles.toolLoop,
    signal: deps.signal,
    minIntervalMs: deps.limits.minCallIntervalMs,
  };
  const finish = (outcome: ResearchOutcome): ResearchOutcome => {
    trace.update(rootId, {
      outputs: {
        status: outcome.status,
        report_chars: outcome.report?.length ?? 0,
        usage: outcome.usage,
      },
    });
    return outcome;
  };

  try {
    // 1) Scope: does the request need clarification? (json + fallback)
    deps.emit({ status: "running", step: "scope", detail: "checking whether the request needs clarification" });
    const transcript = flattenTranscript([...(opts.history ?? []), { role: "user", content: opts.question }]);
    const clarifyResponse = await deps.chat(
      [{ role: "user", content: fillPrompt(clarify_with_user_instructions, { messages: transcript, date: getTodayStr() }) }],
      undefined,
      callOpts,
    );
    addUsage(usage, clarifyResponse.usage);
    const clarifyJson = extractJson<{ need_clarification?: boolean; question?: string; verification?: string }>(
      clarifyResponse.content,
    );
    let needClarification = false;
    let verification = "";
    if (clarifyJson) {
      needClarification = clarifyJson.need_clarification === true;
      verification = String(clarifyJson.verification ?? "");
    } else {
      // Python fallback: unparseable JSON → proceed, raw text as verification.
      verification = clarifyResponse.content;
    }
    if (needClarification) {
      const question = String(clarifyJson?.question ?? clarifyResponse.content);
      deps.emit({ status: "running", step: "scope", detail: "clarification needed — pausing for the user's answer" });
      const clarificationMessage: ChatMessage = { role: "assistant", content: question };
      messages.push(clarificationMessage);
      deps.onMessage?.(clarificationMessage);
      return finish({ status: "awaiting_clarification", clarification: question, messages, usage });
    }
    if (verification) {
      const verificationMessage: ChatMessage = { role: "assistant", content: verification };
      messages.push(verificationMessage);
      deps.onMessage?.(verificationMessage);
    }

    ensureNotStopped(deps);

    // 2) Research brief: a detailed, assumption-free statement of the ask.
    deps.emit({ status: "running", step: "brief", detail: "writing the research brief" });
    const briefResponse = await deps.chat(
      [
        {
          role: "user",
          content:
            fillPrompt(transform_messages_into_research_topic_human_msg_prompt, { messages: transcript, date: getTodayStr() }) +
            jsonInstruction("research_brief"),
        },
      ],
      undefined,
      callOpts,
    );
    addUsage(usage, briefResponse.usage);
    const briefJson = extractJson<{ research_brief?: string }>(briefResponse.content);
    const brief = briefJson?.research_brief ?? briefResponse.content;

    ensureNotStopped(deps);

    // 3) Pre-research knowledge outline (baseline + gaps, no citations).
    deps.emit({ status: "running", step: "outline", detail: "drafting the pre-research knowledge outline" });
    const draftResponse = await deps.chat(
      [
        {
          role: "user",
          content:
            fillPrompt(draft_report_generation_prompt, { research_brief: brief, date: getTodayStr() }) +
            jsonInstruction("draft_report"),
        },
      ],
      undefined,
      { ...callOpts, model: deps.roles.writer },
    );
    addUsage(usage, draftResponse.usage);
    const draftJson = extractJson<{ draft_report?: string }>(draftResponse.content);
    const draftReport = draftJson?.draft_report ?? draftResponse.content;

    ensureNotStopped(deps);

    // 4) Supervisor loop: parallel researcher fan-out + draft refinement.
    deps.emit({ status: "running", step: "supervisor", detail: "starting the supervisor research loop" });
    const supervised = await deps.runSupervisor({ brief, draftReport }, deps);
    addUsage(usage, supervised.usage);

    ensureNotStopped(deps);

    // 5) Final report (writer tier; ≤3,000-word + citation contract in-prompt).
    deps.emit({
      status: "running",
      step: "final_report",
      detail: `writing the final report from ${supervised.notes.length} finding block(s)`,
    });
    const finalMessages: ChatMessage[] = [
      {
        role: "user",
        content: fillPrompt(final_report_generation_with_helpfulness_insightfulness_hit_citation_prompt, {
          research_brief: brief,
          findings: supervised.notes.join("\n"),
          date: getTodayStr(),
          draft_report: supervised.draftReport,
        }),
      },
    ];
    // Writer-tier cap parity with the Python original (32k); reasoning tokens
    // count against max_tokens on OpenRouter. The final report runs at
    // reduced reasoning effort (FINAL_REPORT_THINKING=low parity) — a full-
    // thinking final call timed out at 5 min and then returned empty content
    // live (2026-10-14 DAL run); low effort bounds the burn.
    const finalResponse = await deps.chat(finalMessages, undefined, {
      ...callOpts,
      model: deps.roles.writer,
      maxTokens: 32000,
      reasoningEffort: "low",
    });
    addUsage(usage, finalResponse.usage);
    let report = finalResponse.content;
    if (!report.trim()) {
      // Documented OpenRouter failure mode: a reasoning model can burn the
      // whole max_tokens budget thinking and return empty content
      // (finish_reason=length). One retry with reasoning off.
      deps.emit({
        status: "running",
        step: "final_report",
        detail: "final report came back empty (reasoning-token exhaustion?) — retrying without reasoning",
      });
      const retry = await deps.chat(finalMessages, undefined, {
        ...callOpts,
        model: deps.roles.writer,
        maxTokens: 32000,
        noReasoning: true,
      });
      addUsage(usage, retry.usage);
      report = retry.content;
      if (!report.trim()) {
        throw new Error("final report generation returned empty content twice (reasoning-token exhaustion?)");
      }
    }

    const reportMessage: ChatMessage = { role: "assistant", content: report };
    messages.push(reportMessage);
    deps.onMessage?.(reportMessage);
    return finish({ status: "completed", report, messages, usage });
  } catch (e) {
    if (e instanceof ResearchCancelled || deps.shouldStop()) {
      return finish({ status: "cancelled", messages, usage });
    }
    trace.update(rootId, { error: String((e as Error).message).slice(0, 400) });
    throw e;
  }
}
