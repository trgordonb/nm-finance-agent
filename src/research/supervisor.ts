// Supervisor loop: coordinates parallel researchers and draft refinement — a
// flattened port of the thinkdepth-ai multi_agent_supervisor.py
// (supervisor → supervisor_tools → …). ConductResearch calls fan out to
// researcher sub-loops; refine_draft_report is executed inline as a
// writer-tier LLM call; ResearchComplete / no tool calls / the iteration cap
// end the loop; `notes` = every ToolMessage content (python parity).

import type { ChatMessage } from "../types.js";
import {
  lead_researcher_with_multiple_steps_diffusion_double_check_prompt,
  report_generation_with_draft_insight_prompt,
} from "./prompts.js";
import type { ResearchDeps, ResearchUsage, SupervisorResult } from "./types.js";
import { addUsage, ensureNotStopped, fillPrompt, getTodayStr } from "./util.js";

// Wire schemas for the supervisor's tool surface (mirrors the Python
// ConductResearch / ResearchComplete pydantic tools + think_tool +
// refine_draft_report — the latter two are handled inline, not bound
// as executable tools).
const SUPERVISOR_TOOLS = [
  {
    name: "ConductResearch",
    description:
      "Delegate a research task to a specialized sub-agent. Give a single topic described " +
      "in high detail (at least a paragraph) — sub-agents cannot see other agents' work.",
    parameters: {
      type: "object",
      properties: {
        research_topic: {
          type: "string",
          description:
            "The topic to research. Should be a single topic, and should be described in high detail (at least a paragraph).",
        },
      },
      required: ["research_topic"],
    },
  },
  {
    name: "ResearchComplete",
    description:
      "Indicate that the research process is complete — only based on the ConductResearch findings' completeness.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "think_tool",
    description:
      "For reflection and strategic planning: use it before calling ConductResearch or " +
      "refine_draft_report to plan, and after each call to assess progress.",
    parameters: {
      type: "object",
      properties: {
        reflection: {
          type: "string",
          description:
            "Your detailed reflection on research progress, findings, gaps, and next steps",
        },
      },
      required: ["reflection"],
    },
  },
  {
    name: "refine_draft_report",
    description:
      "Refine the draft report with the findings collected so far. The findings and the " +
      "current draft are supplied automatically; call it after each research round.",
    parameters: { type: "object", properties: {} },
  },
];

function truncate(text: string, max = 90): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** refine_draft_report's real work: one writer-tier LLM call over
 *  (research_brief, findings-so-far, current draft). */
export async function refineDraftReport(
  input: { brief: string; findings: string; draftReport: string },
  deps: ResearchDeps,
  usage: ResearchUsage,
): Promise<string> {
  const prompt = fillPrompt(report_generation_with_draft_insight_prompt, {
    research_brief: input.brief,
    findings: input.findings,
    draft_report: input.draftReport,
    date: getTodayStr(),
  });
  const opts = {
    model: deps.roles.writer,
    signal: deps.signal,
    minIntervalMs: deps.limits.minCallIntervalMs,
    reasoningEffort: deps.limits.reasoningEffort,
    timeoutMs: deps.limits.llmTimeoutMs,
    maxAttempts: deps.limits.llmMaxAttempts,
    retryOnTimeout: false,
    // Refined draft ≤4,000 words; 12k cap parity with the Python refine tier.
    maxTokens: 12000,
  };
  const response = await deps.chat([{ role: "user", content: prompt }], undefined, opts);
  addUsage(usage, response.usage);
  if (response.content.trim()) return response.content;

  // Reasoning-token exhaustion (finish_reason=length) can return empty
  // content. Retry once at low effort; if it still fails, keep the previous
  // draft rather than overwriting it with "".
  const retry = await deps.chat([{ role: "user", content: prompt }], undefined, opts);
  addUsage(usage, retry.usage);
  return retry.content.trim() ? retry.content : input.draftReport;
}

export async function runSupervisor(
  input: { brief: string; draftReport: string },
  deps: ResearchDeps,
): Promise<SupervisorResult> {
  const usage: ResearchUsage = { prompt_tokens: 0, completion_tokens: 0 };
  const systemPrompt = fillPrompt(lead_researcher_with_multiple_steps_diffusion_double_check_prompt, {
    date: getTodayStr(),
    max_concurrent_research_units: deps.limits.maxConcurrent,
    max_researcher_iterations: deps.limits.maxSupervisorIterations,
  });

  // write_draft_report seeds the supervisor with the draft + the brief.
  const messages: ChatMessage[] = [
    { role: "user", content: "Here is the draft report: " + input.draftReport },
    { role: "user", content: input.brief },
  ];
  let draftReport = input.draftReport;
  const rawNotes: string[] = [];
  let iterations = 0;
  let researchRounds = 0;
  let softNoticeSent = false;
  let fallbackResearchTried = false;

  // Soft deadline: at 70% of the wall-clock budget, stop launching new
  // research and let the supervisor wrap up. The hard deadline (AbortSignal
  // in the orchestrator) remains the backstop.
  const softDeadlineHit = (): boolean =>
    deps.limits.deadlineMs > 0 &&
    Date.now() - deps.startedAt >= deps.limits.deadlineMs * 0.7;

  for (;;) {
    ensureNotStopped(deps);
    iterations++;
    if (softDeadlineHit() && !softNoticeSent) {
      softNoticeSent = true;
      messages.push({
        role: "user",
        content:
          "TIME BUDGET: at least 70% of the research deadline has elapsed. Do not launch another research round; call ResearchComplete now so the final report can be written.",
      });
      deps.emit({
        status: "running",
        step: "supervisor",
        detail: "soft deadline reached — asking the supervisor to wrap up",
        iteration: iterations,
      });
    } else {
      deps.emit({
        status: "running",
        step: "supervisor",
        detail: `supervisor call ${iterations} (${researchRounds}/${deps.limits.maxResearchRounds} research rounds): planning next steps`,
        iteration: iterations,
      });
    }

    const response = await deps.chat(
      [{ role: "system", content: systemPrompt }, ...messages],
      SUPERVISOR_TOOLS,
      {
        model: deps.roles.toolLoop,
        signal: deps.signal,
        minIntervalMs: deps.limits.minCallIntervalMs,
        reasoningEffort: deps.limits.reasoningEffort,
        timeoutMs: deps.limits.llmTimeoutMs,
        maxAttempts: deps.limits.llmMaxAttempts,
        retryOnTimeout: true,
      },
    );
    addUsage(usage, response.usage);

    const calls = response.toolCalls;
    messages.push({
      role: "assistant",
      content: response.content || "",
      tool_calls: calls,
    });

    const researchComplete = calls.some((call) => call.name === "ResearchComplete");
    const exceeded = iterations >= deps.limits.maxSupervisorIterations;
    if (researchComplete || !calls.length || exceeded) {
      // Safety net: never end the supervisor with zero research. A malformed
      // provider response (HTTP 200 + no tool calls) used to produce a
      // "completed" run that researched nothing (2026-10-19 META trace).
      if (!messages.some((m) => m.role === "tool") && !fallbackResearchTried) {
        fallbackResearchTried = true;
        deps.emit({
          status: "running",
          step: "researchers",
          detail: "supervisor returned no research calls — launching a fallback researcher from the brief",
          iteration: iterations,
        });
        const fallbackTopic = input.brief.length > 4_000 ? input.brief.slice(0, 4_000) : input.brief;
        const result = await deps.runResearcher(fallbackTopic, deps);
        addUsage(usage, result.usage);
        rawNotes.push(result.rawNotes);
        messages.push({
          role: "tool",
          content: result.compressed || "Error synthesizing research report",
          tool_call_id: "fallback-researcher",
          name: "ConductResearch",
        });
      }
      break;
    }

    // Dispatch. ConductResearch calls run as parallel researcher sub-loops
    // (chunked to RESEARCH_MAX_CONCURRENT even if the model over-asks);
    // think_tool echoes; refine_draft_report runs inline.
    const conduct = calls
      .map((call, index) => ({ call, index }))
      .filter(({ call }) => call.name === "ConductResearch");
    const results = new Array<string>(calls.length).fill("");
    const skipNewResearch = conduct.length > 0 && softDeadlineHit();
    if (skipNewResearch) {
      for (const { index } of conduct) {
        results[index] =
          "Skipped: research time budget exhausted. Use the findings already collected.";
      }
      deps.emit({
        status: "running",
        step: "supervisor",
        detail: "soft deadline reached — skipping new research and wrapping up",
        iteration: iterations,
      });
    } else if (conduct.length) {
      researchRounds++;
      const topics = conduct.map(({ call }) => String(call.args?.research_topic ?? ""));
      deps.emit({
        status: "running",
        step: "researchers",
        detail: `research round ${researchRounds}/${deps.limits.maxResearchRounds}: launching ${topics.length} researcher(s): ${truncate(topics.join(" · "), 180)}`,
        iteration: iterations,
      });
      for (let start = 0; start < conduct.length; start += deps.limits.maxConcurrent) {
        const chunk = conduct.slice(start, start + deps.limits.maxConcurrent);
        await Promise.all(
          chunk.map(async ({ call, index }) => {
            const topic = String(call.args?.research_topic ?? "");
            const result = await deps.runResearcher(topic, deps);
            addUsage(usage, result.usage);
            results[index] = result.compressed || "Error synthesizing research report";
            rawNotes.push(result.rawNotes);
            deps.emit({
              status: "running",
              step: "researchers",
              detail: `researcher finished: ${truncate(topic)}`,
              iteration: iterations,
              topic,
            });
          }),
        );
      }
    }

    for (let i = 0; i < calls.length; i++) {
      const call = calls[i];
      if (call.name === "think_tool") {
        results[i] = `Reflection recorded: ${String(call.args?.reflection ?? "")}`;
      } else if (call.name === "refine_draft_report") {
        if (softDeadlineHit()) {
          results[i] = "Skipped: research time budget exhausted. Keep the current draft.";
          continue;
        }
        // Findings = prior tool messages (python get_notes_from_tool_calls
        // runs before this batch's tool messages are appended — parity).
        const findings = messages
          .filter((m) => m.role === "tool")
          .map((m) => m.content)
          .join("\n");
        deps.emit({
          status: "running",
          step: "refine",
          detail: `refining the draft report with ${findings.length} chars of findings`,
          iteration: iterations,
        });
        draftReport = await refineDraftReport({ brief: input.brief, findings, draftReport }, deps, usage);
        results[i] = draftReport;
      }
    }

    calls.forEach((call, index) => {
      messages.push({
        role: "tool",
        content: results[index] ?? "",
        tool_call_id: call.id,
        name: call.name,
      });
    });

    if (skipNewResearch) break;
    if (researchRounds >= deps.limits.maxResearchRounds) {
      deps.emit({
        status: "running",
        step: "supervisor",
        detail: `research round cap (${deps.limits.maxResearchRounds}) reached — wrapping up`,
        iteration: iterations,
      });
      break;
    }
  }

  const notes = messages.filter((m) => m.role === "tool").map((m) => m.content);
  return { notes, draftReport, rawNotes, usage };
}
