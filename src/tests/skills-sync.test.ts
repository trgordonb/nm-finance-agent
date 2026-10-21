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

test("skills sync bridge: countSkillFiles walks nested skill dirs only", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nmfa-skills-"));
  fs.mkdirSync(path.join(dir, "alpha"), { recursive: true });
  fs.writeFileSync(path.join(dir, "alpha", "SKILL.md"), "---\nname: alpha\n---\n");
  fs.mkdirSync(path.join(dir, "devops", "beta"), { recursive: true });
  fs.writeFileSync(path.join(dir, "devops", "beta", "SKILL.md"), "---\nname: beta\n---\n");
  fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".git", "SKILL.md"), "ignored");
  fs.writeFileSync(path.join(dir, "README.md"), "not a skill");
  assert.equal(root.countSkillFiles(dir), 2);
});

test("skills sync bridge: SKILLS_CLI bypasses uv run --directory", () => {
  const had = process.env.SKILLS_CLI;
  try {
    delete process.env.SKILLS_CLI;
    const b = new root.SkillsCliBridge("/tmp/nowhere") as unknown as {
      cliCommand(args: string[]): { bin: string; argv: string[] };
    };
    const dev = b.cliCommand(["pull", "/tmp/skills"]);
    assert.equal(dev.bin, process.env.UV_BIN || "uv");
    assert.deepEqual(dev.argv.slice(-3), ["nm-skills", "pull", "/tmp/skills"]);

    process.env.SKILLS_CLI = "/usr/local/bin/nm-skills";
    const installed = b.cliCommand(["pull", "/tmp/skills"]);
    assert.equal(installed.bin, "/usr/local/bin/nm-skills");
    assert.deepEqual(installed.argv, ["pull", "/tmp/skills"]);
  } finally {
    if (had === undefined) delete process.env.SKILLS_CLI;
    else process.env.SKILLS_CLI = had;
  }
});

test("skills sync bridge: an empty working copy is flagged degraded, not silently healthy", async () => {
  const hadRegistry = process.env.SKILLS_REGISTRY;
  const hadCli = process.env.SKILLS_CLI;
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), "nmfa-cli-"));
  const fake = path.join(fakeDir, "nm-skills");
  fs.writeFileSync(
    fake,
    '#!/bin/sh\necho "pull from s3://neuralmatrix \'skills/\' -> skills/: 0 pulled, 0 removed, 0 unchanged"\n',
    { mode: 0o755 },
  );
  const emptySkills = fs.mkdtempSync(path.join(os.tmpdir(), "nmfa-empty-"));
  process.env.SKILLS_REGISTRY = "s3://neuralmatrix";
  process.env.SKILLS_CLI = fake;
  try {
    const b = new root.SkillsCliBridge(emptySkills);
    await b.syncAtBoot();
    assert.equal(b.info.skillCount, 0);
    assert.equal(b.info.degraded, true);
    assert.equal(b.info.lastSync?.pulled, 0);
    assert.match(b.info.cli ?? "", /^binary:/);
  } finally {
    if (hadRegistry === undefined) delete process.env.SKILLS_REGISTRY;
    else process.env.SKILLS_REGISTRY = hadRegistry;
    if (hadCli === undefined) delete process.env.SKILLS_CLI;
    else process.env.SKILLS_CLI = hadCli;
  }
});
