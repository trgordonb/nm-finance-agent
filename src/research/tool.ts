// deep_research: the research engine exposed as a main-agent tool, gated by
// RESEARCH_AS_TOOL (default off — a run takes 20-40 minutes and real spend;
// the /research prefix remains the primary invocation). The tool forwards the
// turn's AbortSignal so Stop cancels an in-flight research run.

import { RESEARCH_SAVE_REPORTS } from "../config.js";
import type { ToolContext, ToolDef } from "../types.js";
import { runDeepResearch } from "./orchestrator.js";
import { saveResearchReport } from "./reports.js";

export function createDeepResearchTool(
  runner: typeof runDeepResearch = runDeepResearch,
): ToolDef {
  return {
    name: "deep_research",
    description:
      "Run the deep research pipeline (multi-agent web research: parallel researchers, " +
      "source summaries, and a cited final report) on a question. EXPENSIVE and SLOW: " +
      "takes 20-40 minutes and many web searches — use it only when the user explicitly " +
      "asks for deep research. Returns the final cited report. If the result says " +
      "'Rejected: the deep research agent needs one clarification', relay that question " +
      "to the user verbatim and re-invoke with their answer.",
    parameters: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description: "The complete, standalone research question (in the user's language).",
        },
      },
      required: ["question"],
    },
    async execute(args, ctx?: ToolContext) {
      const question = String(args.question ?? "").trim();
      if (!question) {
        return "Rejected: `question` is required — pass the full research question.";
      }
      if (ctx?.signal?.aborted) {
        return "Rejected: deep research cancelled before it started.";
      }
      const outcome = await runner({
        question,
        deps: {
          shouldStop: () => ctx?.signal?.aborted ?? false,
          signal: ctx?.signal,
        },
      });
      if (outcome.status === "awaiting_clarification") {
        return (
          "Rejected: the deep research agent needs one clarification before it can " +
          `proceed: ${outcome.clarification}\n\nRelay this question to the user verbatim and ` +
          "re-invoke deep_research with their answer."
        );
      }
      if (outcome.status === "cancelled") {
        return "Error: deep research was cancelled before completion.";
      }
      let reportPath: string | null = null;
      if (outcome.report && RESEARCH_SAVE_REPORTS) {
        try {
          reportPath = saveResearchReport({ question, report: outcome.report, tag: "tool" });
        } catch {
          /* saving is best-effort — the report text is the tool result */
        }
      }
      return `${outcome.report ?? ""}${reportPath ? `\n\n(Deep research report saved to ${reportPath})` : ""}`;
    },
  };
}
