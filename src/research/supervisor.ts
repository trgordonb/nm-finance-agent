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
  const response = await deps.chat([{ role: "user", content: prompt }], undefined, {
    model: deps.roles.writer,
    signal: deps.signal,
    minIntervalMs: deps.limits.minCallIntervalMs,
    // Refined draft ≤4,000 words; 12k cap parity with the Python refine tier.
    maxTokens: 12000,
  });
  addUsage(usage, response.usage);
  return response.content;
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

  for (;;) {
    ensureNotStopped(deps);
    iterations++;
    deps.emit({
      status: "running",
      step: "supervisor",
      detail: `research round ${iterations}: planning next steps`,
      iteration: iterations,
    });

    const response = await deps.chat(
      [{ role: "system", content: systemPrompt }, ...messages],
      SUPERVISOR_TOOLS,
      {
        model: deps.roles.toolLoop,
        signal: deps.signal,
        minIntervalMs: deps.limits.minCallIntervalMs,
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
    if (researchComplete || !calls.length || exceeded) break;

    // Dispatch. ConductResearch calls run as parallel researcher sub-loops
    // (chunked to RESEARCH_MAX_CONCURRENT even if the model over-asks);
    // think_tool echoes; refine_draft_report runs inline.
    const conduct = calls
      .map((call, index) => ({ call, index }))
      .filter(({ call }) => call.name === "ConductResearch");
    if (conduct.length) {
      const topics = conduct.map(({ call }) => String(call.args?.research_topic ?? ""));
      deps.emit({
        status: "running",
        step: "researchers",
        detail: `launching ${topics.length} researcher(s): ${truncate(topics.join(" · "), 180)}`,
        iteration: iterations,
      });
    }

    const results = new Array<string>(calls.length).fill("");
    for (let start = 0; start < conduct.length; start += deps.limits.maxConcurrent) {
      const chunk = conduct.slice(start, start + deps.limits.maxConcurrent);
      await Promise.all(
        chunk.map(async ({ call, index }) => {
          const topic = String(call.args?.research_topic ?? "");
          const result = await deps.runResearcher(topic, deps);
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

    for (let i = 0; i < calls.length; i++) {
      const call = calls[i];
      if (call.name === "think_tool") {
        results[i] = `Reflection recorded: ${String(call.args?.reflection ?? "")}`;
      } else if (call.name === "refine_draft_report") {
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
  }

  const notes = messages.filter((m) => m.role === "tool").map((m) => m.content);
  return { notes, draftReport, rawNotes, usage };
}
