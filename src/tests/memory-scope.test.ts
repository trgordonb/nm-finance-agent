// Per-user prompt memory + read-only shared project memory.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.SESSION_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "nmfa-mem-")), "s.db");
process.env.MEMORY_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "nmfa-mem-dir-"));
process.env.WORKSPACE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "nmfa-mem-w-"));
delete process.env.WORKSPACE_USER;

const sharedDir = path.join(process.env.MEMORY_DIR, "_shared");
fs.mkdirSync(sharedDir, { recursive: true });
const sharedPath = path.join(sharedDir, "MEMORY.md");
const sharedText = "shared project fact";
fs.writeFileSync(sharedPath, sharedText);

const { PromptMemory } = await import("../memory.js");
const { MEMORY_CHAR_LIMIT, SHARED_MEMORY_CHAR_LIMIT } = await import("../config.js");
const { runInWorkspace } = await import("../workspace.js");
const { memory_manage } = await import("../tools/memory_manage.js");

test("per-user memory is isolated; shared is visible to all", () => {
  runInWorkspace("alice", () => {
    const m = new PromptMemory();
    assert.match(m.add("memory", "alice fact"), /^OK/);
    assert.match(m.add("user", "alice pref"), /^OK/);
    const block = m.load();
    assert.match(block, /SHARED MEMORY\.md \(read-only\)/);
    assert.match(block, /shared project fact/);
    assert.match(block, /-- MEMORY\.md/);
    assert.match(block, /-- USER\.md/);
    assert.match(block, /alice fact/);
    assert.match(block, /alice pref/);
    assert.equal(m.totalChars(), "alice fact".length + "alice pref".length);
  });

  runInWorkspace("bob", () => {
    const m = new PromptMemory();
    assert.equal(m.totalChars(), 0);
    const block = m.load();
    assert.match(block, /shared project fact/);
    assert.equal(block.includes("alice fact"), false);
    assert.match(m.add("memory", "bob fact"), /^OK/);
  });

  runInWorkspace("alice", () => {
    const m = new PromptMemory();
    assert.equal(m.load().includes("bob fact"), false);
    assert.equal(m.totalChars(), "alice fact".length + "alice pref".length);
  });
});

test("the 3,575-char budget is per user", () => {
  runInWorkspace("carol", () => {
    const m = new PromptMemory();
    assert.match(m.add("memory", "x".repeat(MEMORY_CHAR_LIMIT)), /^OK/);
    assert.match(m.add("memory", "y"), /^Rejected:/);
  });
  runInWorkspace("dave", () => {
    const m = new PromptMemory();
    assert.match(m.add("memory", "dave fact"), /^OK/);
  });
});

test("memory_manage writes the active user's file, never the shared one", async () => {
  await runInWorkspace("erin", async () => {
    const res = await memory_manage.execute({ operation: "add", target: "memory", text: "erin fact" });
    assert.match(res, /^OK/);
  });
  const file = path.join(process.env.MEMORY_DIR as string, "erin", "MEMORY.md");
  assert.match(fs.readFileSync(file, "utf8"), /erin fact/);
  assert.equal(fs.readFileSync(sharedPath, "utf8"), sharedText);
});

test("memory_manage refuses to edit shared memory", async () => {
  const res = await memory_manage.execute({ operation: "add", target: "shared", text: "nope" });
  assert.match(res, /^Rejected: shared memory is read-only/);
  assert.equal(fs.readFileSync(sharedPath, "utf8"), sharedText);
});

test("explicit paths keep the single-user/test contract", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nmfa-mem-explicit-"));
  const m = new PromptMemory(path.join(dir, "MEMORY.md"), path.join(dir, "USER.md"));
  runInWorkspace("frank", () => {
    assert.match(m.add("memory", "explicit fact"), /^OK/);
    assert.match(fs.readFileSync(path.join(dir, "MEMORY.md"), "utf8"), /explicit fact/);
    assert.equal(fs.existsSync(path.join(process.env.MEMORY_DIR as string, "frank", "MEMORY.md")), false);
  });
});

test("shared memory has its own budget and an explicit truncation marker", () => {
  const original = fs.readFileSync(sharedPath, "utf8");
  try {
    fs.writeFileSync(sharedPath, "s".repeat(SHARED_MEMORY_CHAR_LIMIT + 10));
    const m = new PromptMemory();
    assert.equal(m.sharedChars(), SHARED_MEMORY_CHAR_LIMIT + 10);
    assert.equal(m.sharedOverBudget(), true);
    assert.match(m.load(), /shared memory truncated at/);
    assert.equal(m.totalChars(), 0, "shared bytes do not consume the per-user budget");
  } finally {
    fs.writeFileSync(sharedPath, original);
  }
});
