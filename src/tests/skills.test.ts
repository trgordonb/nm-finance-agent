// Skills library contract tests — adapted from nm_memory_layer/skills parity
// suite (message contracts, resolve ordering, guards, toggles).

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.SESSION_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "nmfa-t-")), "s.db");
process.env.MEMORY_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "nmfa-m-"));
process.env.WORKSPACE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "nmfa-w-"));
const skillsDir = fs.mkdtempSync(path.join(os.tmpdir(), "nmfa-sk-"));
process.env.SKILLS_DIR = skillsDir;
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nmfa-sk-state-"));
process.env.SKILLS_STATE_DIR = stateDir;

const { SkillLibrary } = await import("../skills/library.js");
const lib = new SkillLibrary(skillsDir);

test("skills: create + frontmatter template + index rendering", () => {
  assert.match(lib.createSkill("fvg-backtest", "Fair Value Gap backtest workflow from the 1247-setup study", "# Steps\n1. fetch data"), /OK: created skill/);
  const md = fs.readFileSync(path.join(skillsDir, "fvg-backtest", "SKILL.md"), "utf8");
  assert.match(md, /---\nname: fvg-backtest\ndescription: "Fair Value Gap backtest workflow from the 1247-setup study"\nversion: 1\.0\.0\n---/);
  assert.equal(lib.renderIndex(), "<skills_index>\n- fvg-backtest: Fair Value Gap backtest workflow from the 1247-setup study\n</skills_index>");
});

test("skills: create rejections (slug, dup, empty body, category)", () => {
  assert.match(lib.createSkill("Bad Name", "x", "body"), /^Rejected: skill name must match/);
  assert.match(lib.createSkill("fvg-backtest", "x", "dup body"), /^Rejected: skill .* already exists/);
  assert.match(lib.createSkill("ok-slug", "x", "   "), /^Rejected: skill body is empty/);
  assert.match(lib.createSkill("ok-slug-2", "x", "body", "Bad Cat"), /^Rejected: category must be a slug/);
});

test("skills: resolve by frontmatter name / dir name / basename; load returns full file", () => {
  assert.equal(lib.resolve("fvg-backtest")?.relDir, "fvg-backtest");
  fs.mkdirSync(path.join(skillsDir, "devops", "deploy-k8s"), { recursive: true });
  fs.writeFileSync(
    path.join(skillsDir, "devops", "deploy-k8s", "SKILL.md"),
    '---\nname: deploy-k8s\ndescription: "Ship the service"\n---\n\nDeploy steps here.\n',
    "utf8",
  );
  lib.refresh();
  assert.equal(lib.resolve("deploy-k8s")?.relDir, "devops/deploy-k8s");
  assert.match(lib.loadSkill("deploy-k8s"), /Deploy steps here\./);
  assert.match(lib.loadSkill("deploy-k8s"), /^---\nname: deploy-k8s/);
  assert.match(lib.loadSkill("missing-skill"), /^Rejected: no skill named/);
});

test("skills: patch is exact-string; edit rewrites body keeping frontmatter", () => {
  assert.match(lib.patchSkill("fvg-backtest", "1. fetch data", "1. fetch OHLCV data"), /OK: patched/);
  assert.match(lib.loadSkill("fvg-backtest"), /fetch OHLCV data/);
  assert.match(lib.patchSkill("fvg-backtest", "not present", "x"), /^Rejected: old_text not found/);
  assert.match(lib.editSkill("fvg-backtest", "brand new body"), /OK: patched/);
  const md = lib.loadSkill("fvg-backtest");
  assert.match(md, /^---\nname: fvg-backtest/);
  assert.match(md, /brand new body/);
});

test("skills: file helpers with traversal guards", () => {
  assert.match(lib.writeSkillFile("fvg-backtest", "references/notes.md", "n"), /OK: wrote/);
  assert.match(lib.removeSkillFile("fvg-backtest", "references/notes.md"), /OK: removed/);
  assert.match(lib.writeSkillFile("fvg-backtest", "../../escape.md", "x"), /^Rejected: invalid relative path/);
  assert.match(lib.writeSkillFile("no-such", "ref.md", "x"), /^Rejected: no skill named/);
  assert.match(lib.removeSkillFile("fvg-backtest", "references/notes.md"), /^Rejected: .* not found/);
});

test("skills: toggles are Hermes-style invisible-if-disabled", () => {
  assert.match(lib.setEnabled("fvg-backtest", false), /OK: disabled skill/);
  assert.equal(lib.resolve("fvg-backtest"), null, "disabled = invisible to the agent surface");
  assert.doesNotMatch(lib.renderIndex(), /fvg-backtest/, "disabled skill vanishes from the index");
  assert.match(lib.renderIndex(), /deploy-k8s/, "other skills remain");
  assert.match(lib.loadSkill("fvg-backtest"), /^Rejected: no skill named/);
  assert.equal(lib.listAll().find((s) => s.name === "fvg-backtest")?.enabled, false, "admin view still sees it");
  assert.match(lib.setEnabled("fvg-backtest", true), /OK: enabled skill/);
  assert.match(lib.renderIndex(), /fvg-backtest/);
  assert.match(lib.setEnabled("ghost", true), /^Rejected: no skill named/);
  // re-enable via rel_dir path also works
  assert.match(lib.setEnabled("deploy-k8s", false), /disabled skill/);
  assert.match(lib.setEnabled("devops/deploy-k8s", true), /enabled skill/);
});

test("skills: unknown tool actions are recoverable denials", async () => {
  const { skill_manage } = await import("../tools/skill_tools.js");
  const res = await skill_manage.execute({ action: "rename", name: "x" });
  assert.match(res, /^Rejected: unknown action "rename"/);
});

test("skills: folded/literal YAML block scalars in description parse fully (paper-claim-repro case)", () => {
  const md = [
    "---",
    "name: paper-claim-repro",
    "description: >",
    "  Reproduce the empirical claims of a quantitative-trading paper: extract its strategy into a",
    '  machine-readable spec. Use this when a paper (arXiv ID, PDF, or link) is provided — e.g. "does',
    '  the Sharpe hold up?". Not for free-form strategy ideas.',
    "version: 1.0.0",
    "---",
    "",
    "Body starts here.",
  ].join("\n");
  fs.mkdirSync(path.join(skillsDir, "research", "paper-claim-repro"), { recursive: true });
  fs.writeFileSync(path.join(skillsDir, "research", "paper-claim-repro", "SKILL.md"), md, "utf8");
  lib.refresh();
  const entry = lib.resolve("paper-claim-repro")!;
  assert.ok(entry.description.startsWith("Reproduce the empirical claims"), `description was: ${entry.description.slice(0, 20)}`);
  assert.ok(!entry.description.includes("\n") && entry.description.includes("paper"), "folded into one line");
  assert.match(lib.renderIndex(), /paper-claim-repro: Reproduce the empirical claims/);
  // literal block scalar variant too
  const md2 = md.replace("description: >", "description: |");
  fs.writeFileSync(path.join(skillsDir, "research", "paper-claim-repro", "SKILL.md"), md2, "utf8");
  lib.refresh();
  const lit = lib.resolve("paper-claim-repro")!;
  assert.ok(!lit.description.startsWith(">"), "literal block scalars parse as text, not a bare '>'");
  fs.rmSync(path.join(skillsDir, "research"), { recursive: true, force: true });
  lib.refresh();
});
