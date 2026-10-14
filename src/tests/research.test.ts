// Deep research engine contract tests (Stage 1, docs/deep-research-plan.md):
// prompt helpers, /research mode detection, and the researcher/supervisor/
// orchestrator loops with stubbed models. Fully offline — no network.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Must precede the config import chain: force the page-summarizer fallback so
// nothing in these tests ever touches the live Exa API — and mute LangSmith
// so the engine's per-run traces don't pollute the real tracing project.
process.env.EXA_SUMMARIZER = "off";
process.env.LANGSMITH_TRACING = "0";
// Sandbox file writes (reports) — config reads WORKSPACE_DIR at import time.
process.env.WORKSPACE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "nmfa-ws-"));

const { fillPrompt, extractJson } = await import("../research/util.js");
const { detectResearchMode, cleanResearchQuestion } = await import("../research/mode.js");
const { buildResearchDeps, runDeepResearch } = await import("../research/orchestrator.js");
const { runResearcher } = await import("../research/researcher.js");
const { runSupervisor } = await import("../research/supervisor.js");
const { formatSearchOutput, parseExaSummary } = await import("../research/tools.js");
const prompts = await import("../research/prompts.js");

// --- stubs --------------------------------------------------------------------

type StubResponse = {
  content: string;
  toolCalls?: Array<{ id: string; name: string; args: Record<string, unknown> }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
};

/** Scripted chat stub: returns script[i], repeating the last entry when
 *  exhausted; records every call for inspection. */
function stubChat(
  script: Array<StubResponse | ((messages: unknown[], tools: unknown, opts: unknown) => StubResponse)>,
) {
  const calls: Array<{ messages: any[]; tools: any; opts: any }> = [];
  let index = 0;
  const fn = async (messages: any[], tools?: any, opts?: any) => {
    calls.push({ messages, tools, opts });
    const item = script[Math.min(index, script.length - 1)];
    index++;
    const response = typeof item === "function" ? item(messages, tools, opts) : item;
    return {
      content: response.content,
      toolCalls: response.toolCalls ?? [],
      usage: response.usage ?? {},
      model: "stub",
      raw: {},
    };
  };
  return { fn, calls };
}

function stubTool(name: string, exec: (args: Record<string, unknown>) => string): any {
  return {
    name,
    description: `stub ${name}`,
    parameters: { type: "object", properties: {} },
    execute: exec,
  };
}

// --- helpers ------------------------------------------------------------------

test("util: fillPrompt replaces known keys and leaves unknown braces alone", () => {
  assert.equal(fillPrompt("A {x} B {unknown} {y}", { x: "1", y: "2" }), "A 1 B {unknown} 2");
});

test("util: extractJson handles raw, ```json-fenced, ```-fenced and garbage", () => {
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('```\n{"a":1}\n```'), { a: 1 });
  assert.equal(extractJson("not json at all"), undefined);
});

test("/research prefix detection and cleaning", () => {
  assert.equal(detectResearchMode("/research q"), true);
  assert.equal(detectResearchMode("  /research q"), true);
  assert.equal(detectResearchMode("/research"), true);
  assert.equal(detectResearchMode("/researchx q"), false);
  assert.equal(detectResearchMode("tell me about /research"), false);
  assert.equal(cleanResearchQuestion("/research   q here "), "q here");
  assert.equal(cleanResearchQuestion("plain question"), "plain question");
});

test("ported prompts keep the upstream hard contracts", () => {
  assert.match(prompts.final_report_generation_with_helpfulness_insightfulness_hit_citation_prompt, /3,000 words/);
  assert.match(prompts.compress_research_system_prompt, /1,500 words/);
  assert.match(prompts.draft_report_generation_prompt, /1200 words/);
  assert.match(prompts.research_agent_prompt, /5 search tool calls/);
  assert.match(prompts.lead_researcher_with_multiple_steps_diffusion_double_check_prompt, /ResearchComplete/);
  assert.match(prompts.clarify_with_user_instructions, /\{messages\}/);
});

// --- researcher ---------------------------------------------------------------

test("researcher: tool loop, parallel calls keep order, then compress", async () => {
  const executed: string[] = [];
  const tools = [
    stubTool("tavily_search", (args) => {
      executed.push(String(args.query));
      return `SEARCH(${args.query})`;
    }),
    stubTool("think_tool", (args) => `Reflection recorded: ${args.reflection}`),
  ];
  const { fn, calls } = stubChat([
    {
      content: "",
      toolCalls: [
        { id: "c1", name: "tavily_search", args: { query: "q1" } },
        { id: "c2", name: "think_tool", args: { reflection: "r1" } },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    },
    { content: "final answer", usage: { prompt_tokens: 20, completion_tokens: 10 } },
    { content: "COMPRESSED", usage: { prompt_tokens: 30, completion_tokens: 15 } },
  ]);
  const deps = buildResearchDeps({ chat: fn as any, researchTools: tools });
  const result = await runResearcher("topic X", deps);

  assert.equal(result.compressed, "COMPRESSED");
  assert.deepEqual(executed, ["q1"]);
  assert.equal(calls.length, 3);

  // Second call carries both tool results with their tool_call_ids matched.
  const second = calls[1].messages;
  assert.equal(second[second.length - 2].tool_call_id, "c1");
  assert.equal(second[second.length - 1].tool_call_id, "c2");
  assert.equal(second[second.length - 1].content, "Reflection recorded: r1");

  // Compress call carries the lossless-cleanup contract + the topic.
  const compress = calls[2].messages;
  assert.match(compress[0].content, /1,500 words/);
  assert.match(String(compress[compress.length - 1].content), /RESEARCH TOPIC: topic X/);

  assert.equal(result.usage.prompt_tokens, 60);
  assert.equal(result.usage.completion_tokens, 30);
});

test("researcher: token budget forces compression early", async () => {
  const tools = [stubTool("tavily_search", () => "S")];
  const { fn, calls } = stubChat([
    {
      content: "",
      toolCalls: [{ id: "c1", name: "tavily_search", args: { query: "q" } }],
      usage: { prompt_tokens: 60, completion_tokens: 60 },
    },
    { content: "EARLY COMPRESS", usage: {} },
  ]);
  const base = buildResearchDeps();
  const deps = {
    ...base,
    chat: fn as any,
    researchTools: tools,
    limits: { ...base.limits, tokenBudget: 100 },
  };
  const result = await runResearcher("t", deps);

  assert.equal(result.compressed, "EARLY COMPRESS");
  assert.equal(calls.length, 2); // tool round + forced compress; no second tool-loop call
});

test("researcher: unknown tool is a recoverable 'Rejected:' message", async () => {
  const { fn, calls } = stubChat([
    { content: "", toolCalls: [{ id: "c1", name: "not_a_tool", args: {} }] },
    { content: "ok" },
    { content: "C" },
  ]);
  const deps = buildResearchDeps({ chat: fn as any, researchTools: [] });
  const result = await runResearcher("t", deps);

  const second = calls[1].messages;
  assert.match(String(second[second.length - 1].content), /^Rejected: unknown tool/);
  assert.equal(result.compressed, "C");
});

// --- supervisor ---------------------------------------------------------------

test("supervisor: ConductResearch fans out; ResearchComplete ends with tool-message notes", async () => {
  const topics: string[] = [];
  const { fn, calls } = stubChat([
    {
      content: "",
      toolCalls: [
        { id: "c1", name: "ConductResearch", args: { research_topic: "topic A" } },
        { id: "c2", name: "ConductResearch", args: { research_topic: "topic B" } },
      ],
    },
    { content: "", toolCalls: [{ id: "c3", name: "ResearchComplete", args: {} }] },
  ]);
  const deps = buildResearchDeps({
    chat: fn as any,
    runResearcher: async (topic) => {
      topics.push(topic);
      return {
        topic,
        compressed: `FINDINGS(${topic})`,
        rawNotes: "",
        usage: { prompt_tokens: 0, completion_tokens: 0 },
      };
    },
  });
  const result = await runSupervisor({ brief: "BRIEF", draftReport: "DRAFT" }, deps);

  assert.deepEqual(topics.sort(), ["topic A", "topic B"]);
  assert.equal(result.notes.length, 2);
  assert.match(result.notes[0], /FINDINGS/);

  // The supervisor's first call sees the draft + brief as its user messages.
  const first = calls[0].messages;
  assert.match(String(first[1].content), /Here is the draft report: DRAFT/);
  assert.match(String(first[2].content), /BRIEF/);

  // The second call sees the research tool results appended.
  const second = calls[1].messages;
  assert.match(String(second[second.length - 2].content), /FINDINGS/);
});

test("supervisor: iteration cap ends a runaway loop (exceeded round is not dispatched)", async () => {
  const { fn, calls } = stubChat([
    { content: "thinking", toolCalls: [{ id: "c1", name: "think_tool", args: { reflection: "r" } }] },
  ]);
  const base = buildResearchDeps();
  const deps = { ...base, chat: fn as any, limits: { ...base.limits, maxSupervisorIterations: 2 } };
  const result = await runSupervisor({ brief: "B", draftReport: "D" }, deps);

  assert.equal(calls.length, 2);
  assert.equal(result.notes.length, 1); // only the first round's tool call was dispatched
});

test("supervisor: refine_draft_report runs an inline writer call with the prior findings + draft", async () => {
  const { fn, calls } = stubChat([
    { content: "", toolCalls: [{ id: "c1", name: "refine_draft_report", args: {} }] },
    { content: "REFINED", usage: { prompt_tokens: 5, completion_tokens: 5 } },
    { content: "", toolCalls: [{ id: "c2", name: "ResearchComplete", args: {} }] },
  ]);
  const deps = buildResearchDeps({ chat: fn as any });
  const result = await runSupervisor({ brief: "BRIEF", draftReport: "DRAFT-0" }, deps);

  assert.equal(result.draftReport, "REFINED");
  assert.equal(result.notes[0], "REFINED");
  const refinePrompt = String(calls[1].messages[0].content);
  assert.match(refinePrompt, /DRAFT-0/);
  assert.match(refinePrompt, /BRIEF/);
});

// --- orchestrator -------------------------------------------------------------

test("orchestrator: happy path emits steps in order and returns the report", async () => {
  const steps: string[] = [];
  const seenMessages: string[] = [];
  const { fn, calls } = stubChat([
    { content: JSON.stringify({ need_clarification: false, question: "", verification: "Starting research." }) },
    { content: JSON.stringify({ research_brief: "BRIEF-X" }) },
    { content: JSON.stringify({ draft_report: "OUTLINE-X" }) },
    { content: "FINAL REPORT" },
  ]);
  const deps = buildResearchDeps({
    chat: fn as any,
    emit: (event) => steps.push(event.step),
    onMessage: (message) => seenMessages.push(message.content),
    runSupervisor: async () => ({
      notes: ["N1"],
      draftReport: "D",
      rawNotes: [],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }),
  });
  const outcome = await runDeepResearch({ question: "q?", deps });

  assert.equal(outcome.status, "completed");
  assert.equal(outcome.report, "FINAL REPORT");
  assert.deepEqual(steps, ["scope", "brief", "outline", "supervisor", "final_report"]);
  assert.equal(outcome.messages.length, 2); // verification + report
  assert.equal(outcome.messages[0].content, "Starting research.");
  // onMessage fires for each user-visible message as it is produced.
  assert.deepEqual(seenMessages, ["Starting research.", "FINAL REPORT"]);

  // The final report prompt carries the supervisor's notes + the length contract.
  const finalPrompt = String(calls[3].messages[0].content);
  assert.match(finalPrompt, /N1/);
  assert.match(finalPrompt, /3,000 words/);
});

test("orchestrator: clarification pauses before any research", async () => {
  const { fn } = stubChat([
    { content: JSON.stringify({ need_clarification: true, question: "Which market?", verification: "" }) },
  ]);
  let supervisorCalled = false;
  const deps = buildResearchDeps({
    chat: fn as any,
    runSupervisor: async () => {
      supervisorCalled = true;
      throw new Error("must not run");
    },
  });
  const outcome = await runDeepResearch({ question: "research this", deps });

  assert.equal(outcome.status, "awaiting_clarification");
  assert.equal(outcome.clarification, "Which market?");
  assert.equal(supervisorCalled, false);
  assert.equal(outcome.messages.length, 1);
  assert.equal(outcome.messages[0].content, "Which market?");
});

test("orchestrator: unparseable clarify output proceeds (python fallback)", async () => {
  const { fn } = stubChat([
    { content: "I think we can proceed." },
    { content: JSON.stringify({ research_brief: "B" }) },
    { content: JSON.stringify({ draft_report: "D" }) },
    { content: "R" },
  ]);
  const deps = buildResearchDeps({
    chat: fn as any,
    runSupervisor: async () => ({
      notes: [],
      draftReport: "D",
      rawNotes: [],
      usage: { prompt_tokens: 0, completion_tokens: 0 },
    }),
  });
  const outcome = await runDeepResearch({ question: "q", deps });

  assert.equal(outcome.status, "completed");
  assert.equal(outcome.messages[0].content, "I think we can proceed.");
});

test("orchestrator: stop flag cancels between stages and keeps the prefix", async () => {
  let calls = 0;
  const { fn } = stubChat([
    { content: JSON.stringify({ need_clarification: false, question: "", verification: "ok" }) },
  ]);
  const wrapped = async (...args: any[]) => {
    calls++;
    return (fn as any)(...args);
  };
  const deps = buildResearchDeps({ chat: wrapped as any, shouldStop: () => calls >= 1 });
  const outcome = await runDeepResearch({ question: "q", deps });

  assert.equal(outcome.status, "cancelled");
  assert.equal(calls, 1);
  assert.equal(outcome.messages.length, 1); // the verification produced before the stop
});

// --- search output ------------------------------------------------------------

test("tools: formatSearchOutput dedupes URLs and prints SOURCE blocks", async () => {
  const out = await formatSearchOutput(
    [
      { title: "T1", url: "https://a.example", content: "snippet A" },
      { title: "T1-duplicate", url: "https://a.example", content: "snippet A2" },
      { title: "T2", url: "https://b.example", content: "snippet B" },
    ],
    { chatFn: (async () => ({ content: "x" })) as any, model: "m" },
  );
  assert.match(out, /SOURCE 1: T1/);
  assert.match(out, /SOURCE 2: T2/);
  assert.doesNotMatch(out, /T1-duplicate/);
  assert.match(out, /snippet A\n/);
});

test("tools: raw content goes through the LLM summarizer when Exa is off", async () => {
  const chatFn = async () => ({
    content: JSON.stringify({ summary: "SUM", key_excerpts: ["E1", "E2"] }),
    toolCalls: [],
    usage: {},
    model: "stub",
    raw: {},
  });
  const out = await formatSearchOutput(
    [{ title: "T", url: "https://c.example", content: "snip", raw_content: "RAW PAGE" }],
    { chatFn: chatFn as any, model: "m" },
  );
  assert.match(out, /<summary>\nSUM\n<\/summary>/);
  assert.match(out, /- E1/);
});

test("tools: parseExaSummary renders JSON strings, objects, and plain text", () => {
  assert.match(parseExaSummary('{"summary":"S","key_excerpts":["a","b"]}'), /<summary>\nS\n<\/summary>/);
  assert.match(parseExaSummary({ summary: "S2", key_excerpts: ["x"] }), /S2/);
  assert.match(parseExaSummary("plain text"), /plain text/);
});

// --- Stage 2: run persistence + report saving ----------------------------------

test("store: research_runs round-trip, pause/resume, stale sweep", async () => {
  const { SQLiteSessionStore } = await import("../store.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nmfa-rr-"));
  const store = new SQLiteSessionStore(path.join(dir, "t.db"));
  const sid = store.newSessionId();

  store.startResearchRun(sid, "why X?");
  let row = store.getResearchRun(sid);
  assert.equal(row?.status, "running");
  assert.equal(row?.step, "scope");
  assert.equal(row?.question, "why X?");

  store.updateResearchStep(sid, "supervisor");
  store.awaitResearchRun(sid, "Which market?");
  row = store.getResearchRun(sid);
  assert.equal(row?.status, "awaiting_clarification");
  assert.equal(row?.clarification, "Which market?");
  assert.equal(row?.step, "scope");
  assert.equal(row?.finished_at, null); // a paused run is not finished

  store.resumeResearchRun(sid);
  assert.equal(store.getResearchRun(sid)?.status, "running");
  assert.equal(store.getResearchRun(sid)?.clarification, null);

  store.finishResearchRun(sid, { status: "completed", report: "# done" });
  row = store.getResearchRun(sid);
  assert.equal(row?.status, "completed");
  assert.equal(row?.report, "# done");
  assert.ok(row?.finished_at);

  // The sidebar join: listSessions carries the research status alongside the
  // turn-derived session summary (stage-4 session tag).
  store.appendTurn(sid, [{ role: "user", content: "hi" }]);
  const listed = store.listSessions().find((s) => s.session_id === sid);
  assert.equal(listed?.research_status, "completed");

  // Boot sweep marks only *running* rows interrupted.
  const sid2 = store.newSessionId();
  store.startResearchRun(sid2, "q2");
  assert.equal(store.markStaleResearchRunsInterrupted(), 1);
  assert.equal(store.getResearchRun(sid2)?.status, "interrupted");
  assert.equal(store.getResearchRun(sid)?.status, "completed");
  store.close();
});

test("reports: slug is deterministic and an explicit out path is written", async () => {
  const { saveResearchReport, slugify } = await import("../research/reports.js");
  assert.equal(slugify("Analysts on the latest XOM guidance!"), "analysts-on-the-latest-xom-guidance");
  assert.equal(slugify("///"), "report");
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "nmfa-rp-")), "r.md");
  const written = saveResearchReport({ question: "q", report: "# R", out });
  assert.equal(written, out);
  assert.equal(fs.readFileSync(out, "utf8"), "# R");
});

// --- Stage 4: deep_research as a main-agent tool --------------------------------

test("deep_research tool: report pass-through, clarification relay, cancel + guards", async () => {
  const { createDeepResearchTool } = await import("../research/tool.js");
  const makeOutcome = (patch: Record<string, unknown>) => ({
    status: "completed",
    messages: [],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
    ...patch,
  });

  // Happy path: the report text is the tool result + the saved-file note.
  const okTool = createDeepResearchTool((async () =>
    makeOutcome({ report: "# Report\nFindings." })) as never);
  const out = await okTool.execute({ question: "why X?" });
  assert.match(out, /# Report/);
  assert.match(out, /Deep research report saved to/);

  // Clarification: a recoverable `Rejected:` with the question relayed.
  const clarTool = createDeepResearchTool((async () =>
    makeOutcome({ status: "awaiting_clarification", clarification: "Which market?" })) as never);
  const clar = await clarTool.execute({ question: "q" });
  assert.match(clar, /^Rejected: .*Which market\?/);

  // Cancelled mid-run: fatal (`Error:`), the turn ends.
  const cancelTool = createDeepResearchTool((async () =>
    makeOutcome({ status: "cancelled" })) as never);
  assert.match(await cancelTool.execute({ question: "q" }), /^Error: .*cancelled/);

  // Guards: empty question, and a pre-aborted turn never starts the engine.
  const neverTool = createDeepResearchTool((async () => {
    throw new Error("must not run");
  }) as never);
  assert.match(await neverTool.execute({ question: "  " }), /^Rejected:/);
  const ctrl = new AbortController();
  ctrl.abort();
  assert.match(await neverTool.execute({ question: "q" }, { signal: ctrl.signal }), /^Rejected:/);
});
