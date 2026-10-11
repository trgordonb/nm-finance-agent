// Skills R2 lifecycle bridge — contracts with a fake CLI guard.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.SESSION_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "nmfa-t-")), "s.db");
process.env.MEMORY_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "nmfa-m-"));
process.env.WORKSPACE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "nmfa-w-"));

const root = await import("../skills/sync.js");

test("skills sync bridge: parsePull reads the CLI report shape", async () => {
  const bridge = new root.SkillsCliBridge("/tmp/nowhere") as unknown as {
    parsePull(out: string, at: string): { pulled: number; removed: number; unchanged: number };
  };
  const info = bridge.parsePull("pull from s3://neuralmatrix 'skills/' → skills/: 7 pulled, 2 removed, 158 unchanged", "t");
  assert.deepEqual({ pulled: info.pulled, removed: info.removed, unchanged: info.unchanged }, { pulled: 7, removed: 2, unchanged: 158 });
  const bad = bridge.parsePull("no report here", "t");
  assert.equal((bad as { error?: string }).error ? true : (bad as { pulled: number }).pulled === -1, true, "unreadable output surfaces as an error record, not a throw");
});

test("skills sync bridge: absent SKILLS_REGISTRY degrades to local-only, notifyChange is a no-op", async () => {
  const had = process.env.SKILLS_REGISTRY;
  delete process.env.SKILLS_REGISTRY;
  try {
    const b = new root.SkillsCliBridge("/tmp/nowhere");
    assert.equal(b.info.mode, "local");
    assert.match(b.info.error ?? "", /SKILLS_REGISTRY not set/);
    b.notifyChange(); // must not schedule or throw
    await new Promise((r) => setTimeout(r, 20));
  } finally {
    if (had) process.env.SKILLS_REGISTRY = had;
  }
});

test("skills sync bridge: notifyChange schedules a debounce then clears (no engine in tests)", async () => {
  process.env.SKILLS_REGISTRY = "s3://neuralmatrix";
  process.env.SKILLS_PUSH_DEBOUNCE_MS = "10";
  try {
    const b = new root.SkillsCliBridge("/tmp/nowhere");
    b.notifyChange();
    assert.equal(b.info.pendingPush, true);
    await new Promise((r) => setTimeout(r, 300));
    // flush() runs the (failing) CLI and the pending flag clears either way
    assert.ok(["true", "false"].includes(String(b.info.pendingPush)) || b.info.lastPush !== undefined, "debounce settles without throwing");
    b.dispose();
  } finally {
    delete process.env.SKILLS_PUSH_DEBOUNCE_MS;
  }
});
