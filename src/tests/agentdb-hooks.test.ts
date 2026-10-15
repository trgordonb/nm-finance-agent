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
