// Per-user skill toggles: the working copy is shared, the disabled list is not.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.SESSION_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "nmfa-sku-")), "s.db");
process.env.MEMORY_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "nmfa-sku-m-"));
process.env.WORKSPACE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "nmfa-sku-w-"));
const skillsDir = fs.mkdtempSync(path.join(os.tmpdir(), "nmfa-sku-sk-"));
process.env.SKILLS_DIR = skillsDir;
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nmfa-sku-st-"));
process.env.SKILLS_STATE_DIR = stateDir;
delete process.env.WORKSPACE_USER;

const { SkillLibrary } = await import("../skills/library.js");
const { runInWorkspace } = await import("../workspace.js");

function seed(): void {
  const lib = new SkillLibrary(skillsDir);
  lib.createSkill("alpha", "alpha skill", "A");
  lib.createSkill("beta", "beta skill", "B");
}

test("skill toggles are per user; the working copy is shared", () => {
  seed();
  runInWorkspace("alice", () => {
    const lib = new SkillLibrary(skillsDir);
    assert.match(lib.setEnabled("alpha", false), /^OK: disabled skill/);
    assert.deepEqual(lib.listSkills().map((s) => s.name), ["beta"]);
    assert.equal(lib.listAll().find((s) => s.name === "alpha")?.enabled, false);
  });

  const aliceState = path.join(stateDir, "users", "alice", "skills.json");
  assert.match(fs.readFileSync(aliceState, "utf8"), /alpha/);

  runInWorkspace("bob", () => {
    const lib = new SkillLibrary(skillsDir);
    assert.deepEqual(lib.listSkills().map((s) => s.name), ["alpha", "beta"]);
    assert.match(lib.setEnabled("beta", false), /^OK: disabled skill/);
    assert.deepEqual(lib.listSkills().map((s) => s.name), ["alpha"]);
    assert.match(lib.setEnabled("beta", true), /^OK: enabled skill/);
    assert.deepEqual(lib.listSkills().map((s) => s.name), ["alpha", "beta"]);
  });

  runInWorkspace("alice", () => {
    const lib = new SkillLibrary(skillsDir);
    assert.deepEqual(lib.listSkills().map((s) => s.name), ["beta"]);
  });
});
