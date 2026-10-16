// Gate-1 hooks: cognitiveNudgeTools picker, similarity parse/gate, cache reuse.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.SESSION_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "nmfa-ah-")), "s.db");
process.env.MEMORY_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "nmfa-ahm-"));
process.env.WORKSPACE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "nmfa-ahw-"));

const hooks = await import("../agentdb-hooks.js");
const hooks_storeToolFake = (name: string, exec: (a: any) => string) => ({
  name, description: "", parameters: { type: "object" as const, properties: {} }, execute: async (a: any) => exec(a),
});

const fakeTool = (name: string, execute: () => string | Promise<string>) => ({
  name, description: "", parameters: { type: "object" as const, properties: {} }, execute,
});


test("cognitiveNudgeTools: picks only the configured agentdb tools from the bound registry", () => {
  const registry = new Map([
    ["execute", fakeTool("execute", () => "")],
    ["reflexion_store", fakeTool("reflexion_store", () => "")],
    ["skill_create", fakeTool("skill_create", () => "")],
    ["reflexion_retrieve", fakeTool("reflexion_retrieve", () => "")],
    ["memory_manage", fakeTool("memory_manage", () => "")],
  ]);
  const picked = hooks.cognitiveNudgeTools(registry).map((t) => t.name);
  assert.deepEqual(picked.sort(), ["skill_create", "reflexion_store"].sort(), "retrieve stays UNBOUND to the nudge (python: NUDGE_AGENTDB_TOOLS)");
});

test("parseSimilarities: reads agentdb reflexion_retrieve markers", () => {
  assert.deepEqual(hooks.parseSimilarities("Similarity: 0.42\nSimilarity: 0.91"), [0.42, 0.91]);
  assert.deepEqual(hooks.parseSimilarities("no markers"), []);
});

test("episodeRecallContext: threshold gate + injected block + disable switch", async () => {
  process.env.AGENTDB_RECALL_ENABLED = "1";
  const tool = fakeTool("reflexion_retrieve", async () =>
    "Episode session=abc | task: trend-follow replication\nSimilarity: 0.51\ncritique: keep the OOS window fixed",
  );
  const block = await hooks.episodeRecallContext("replicate the trend study", tool);
  assert.match(block, /<episode_context>/);
  assert.match(block, /Similarity: 0\.51/);
  const below = await hooks.episodeRecallContext("replicate the trend study", tool, { minSim: 0.99 });
  assert.equal(below, "");
  process.env.AGENTDB_RECALL_ENABLED = "0";
  assert.equal(await hooks.episodeRecallContext("replicate", tool), "");
  process.env.AGENTDB_RECALL_ENABLED = "1";
  // failing tool → silent no-injection
  assert.equal(await hooks.episodeRecallContext("x", fakeTool("reflexion_retrieve", async () => { throw new Error("boom"); })), "");
});

test("EpisodeRecallCache: one-slot keyed by user message (python _episode_recall_cache)", () => {
  const cache = new hooks.EpisodeRecallCache();
  assert.equal(cache.get("task"), null);
  cache.set("task", "<episode_context>x</episode_context>");
  assert.equal(cache.get("task"), "<episode_context>x</episode_context>", "same task → cache hit");
  assert.equal(cache.get("other"), null, "different task → miss");
});

test("buildRecallQuery: previous request + assistant tail enrich an anaphoric follow-up", () => {
  const history = [
    { role: "user" as const, content: "search OpenAlex for papers on arbitrage" },
    { role: "assistant" as const, content: "found ten papers" },
    { role: "user" as const, content: "Let's start with #4 first. Extract the strategy." },
    { role: "assistant" as const, content: "…long report…Want me to extract another paper from the list?" },
  ];
  const q = hooks.buildRecallQuery("Now do the same to paper #5", history);
  // the LAST prior user message is the referent — not the first one
  assert.match(q, /Earlier request: Let's start with #4 first/);
  assert.doesNotMatch(q, /search OpenAlex/);
  assert.match(q, /What the agent was doing: .*extract another paper from the list\?/);
  assert.match(q, /Now do the same to paper #5$/);
  // bare fallback with no history
  assert.equal(hooks.buildRecallQuery("hello", []), "hello");
  // caps: long priors are truncated to 300 chars each side
  const long = hooks.buildRecallQuery("m", [
    { role: "user" as const, content: "u".repeat(500) },
    { role: "assistant" as const, content: "a".repeat(500) },
  ]);
  assert.ok(!long.includes("u".repeat(301)), "prior user capped at 300 chars");
  assert.ok(!long.includes("a".repeat(301)), "assistant tail capped at 300 chars");
});

test("reflexion autostore: parseEpisodeArgs + lesson/no-lesson routing", async () => {
  const { maybeStoreReflexion, parseEpisodeArgs } = await import("../reflexion.js");
  // JSON-in-text path
  assert.ok(parseEpisodeArgs('blah { "task": "pdf conversion", "reward": 0.9 } end'), "plain JSON block parses");
  assert.equal(parseEpisodeArgs("no json"), null);
  // textual <tool_call> XML path (GLM emitted this live when no tools were bound)
  const xml =
    "<tool_call>agentdb_reflexion_store" +
    "<arg_key>critique</arg_key><arg_value>install into a dedicated uv venv</arg_value>" +
    "<arg_key>task</arg_key><arg_value>dukascopy export setup</arg_value>" +
    "<arg_key>reward</arg_key><arg_value>0.9</arg_value>" +
    "<arg_key>success</arg_key><arg_value>true</arg_value>";
  const xmlParsed = parseEpisodeArgs(xml);
  assert.ok(xmlParsed, "textual <arg_key>/<arg_value> tool call parses");
  assert.equal(xmlParsed.task, "dukascopy export setup");
  assert.equal(xmlParsed.reward, 0.9);
  assert.equal(xmlParsed.success, true);
  assert.match(String(xmlParsed.critique), /uv venv/);
  assert.equal(parseEpisodeArgs("<arg_key>critique</arg_key><arg_value>x</arg_value>"), null, "no task → rejected");
  // lesson-worthy turn: tool invoked with parsed args
  process.env.AGENTDB_REFLEXION_AUTOSTORE = "1";
  let calls: unknown[] = [];
  const storeTool = hooks_storeToolFake("agentdb_reflexion_store", (a) => { calls.push(a); return "OK: stored episode #9"; });

  const realStub = (text: string) => async () => ({
    content: text, toolCalls: [], usage: {}, model: "stub", raw: { role: "assistant" },
  });
  await maybeStoreReflexion(
    "sess-z",
    [
      { role: "user", content: "convert the SSRN paper" },
      { role: "assistant", content: "", tool_calls: [{ id: "c1", name: "execute", args: { command: "ls" } }] },
      { role: "tool", content: "ok", tool_call_id: "c1", name: "execute" },
    ],
    storeTool,
    realStub(JSON.stringify({ task: "pdf to markdown conversion", reward: 0.85, success: true, critique: "headless chrome needs the fixed window", session_id: "pdf-md" })),
  );
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(calls.length, 1, "store tool invoked exactly once");
  assert.match(String((calls[0] as { task?: string }).task), /pdf to markdown/);
  // no-lesson turn: store tool untouched
  calls = [];
  const noLessonStub = realStub("no episode");
  await maybeStoreReflexion("sess-z", [{ role: "user", content: "hi" }, { role: "assistant", content: "a pure greeting with nothing reusable to persist" }], storeTool, noLessonStub);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(calls.length, 0, "no-lesson path leaves the store untouched");
  process.env.AGENTDB_REFLEXION_AUTOSTORE = "";
  let untouched = true;
  await maybeStoreReflexion("sess-z", [{ role: "user", content: "convert paper" }, { role: "assistant", content: '{ "task": "pdf to markdown", "reward": 0.9, "success": true, "session_id": "z" }' }], storeTool, realStub("no episode"));
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(calls.length, 0, "env kill-switch: no store call");
  assert.equal(untouched, true);
  void untouched;
});

test("reflexion autostore: provider tool call path + store tool binding", async () => {
  const { maybeStoreReflexion } = await import("../reflexion.js");
  process.env.AGENTDB_REFLEXION_AUTOSTORE = "1";
  const calls: unknown[] = [];
  const storeTool = hooks_storeToolFake("agentdb_reflexion_store", (a) => {
    calls.push(a);
    return "OK: stored episode #10";
  });
  let boundTools: Array<{ name: string }> = [];
  const stubWithCall = (async (_messages: unknown, tools?: Array<{ name: string }>) => {
    boundTools = tools ?? [];
    return {
      content: "",
      toolCalls: [
        { id: "c9", name: "agentdb_reflexion_store", args: { task: "alpha", reward: 0.5, critique: "beta" } },
      ],
      usage: {},
      model: "stub",
      raw: {},
    };
  }) as never;
  await maybeStoreReflexion(
    "sess-t",
    [
      { role: "user", content: "do the thing" },
      { role: "assistant", content: "done" },
    ],
    storeTool,
    stubWithCall,
  );
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(boundTools.length, 1, "review call binds the store tool");
  assert.equal(boundTools[0].name, "agentdb_reflexion_store");
  assert.equal(calls.length, 1, "provider tool call → store invoked exactly once");
  assert.equal((calls[0] as { task?: string }).task, "alpha");
  process.env.AGENTDB_REFLEXION_AUTOSTORE = "";
});
