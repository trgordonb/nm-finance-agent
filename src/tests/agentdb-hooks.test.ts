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

test("reflexion autostore: parseEpisodeArgs + lesson/no-lesson routing", async () => {
  const { maybeStoreReflexion, parseEpisodeArgs } = await import("../reflexion.js");
  // JSON-in-text path
  assert.ok(parseEpisodeArgs('blah { "task": "pdf conversion", "reward": 0.9 } end'), "plain JSON block parses");
  assert.equal(parseEpisodeArgs("no json"), null);
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
