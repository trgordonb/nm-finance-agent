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

test("skills: trailing space on the closing fence tolerated (tradedesk-dukascopy case)", () => {
  const md =
    '---\nname: tradedesk-dukascopy\ndescription: This skill enables an agent to fetch new market data from dukascopy to use in backtests.\nlicense: MIT\nmetadata:\n  author: radiusred.uk\n--- \n\n# SKILL title follows.\n';
  fs.mkdirSync(path.join(skillsDir, "data", "tradedesk-dukascopy"), { recursive: true });
  fs.writeFileSync(path.join(skillsDir, "data", "tradedesk-dukascopy", "SKILL.md"), md, "utf8");
  lib.refresh();
  const entry = lib.resolve("tradedesk-dukascopy")!;
  assert.match(entry.description, /^This skill enables an agent to fetch new market data/);
  // nested metadata map must not bleed into description
  assert.ok(!entry.description.includes("author"));
  fs.rmSync(path.join(skillsDir, "data"), { recursive: true, force: true });
  lib.refresh();
});

test("execute: foreground timeouts are recoverable (Rejected + background hint)", async () => {
  const { execFile } = await import("node:child_process");
  // Self-contained fixture: the old absolute /tmp path was a stale local
  // artifact that broke the suite on every other machine.
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "nmfa-exec-"));
  const fixture = path.join(fixtureDir, "exec-timeout.mts");
  const shellPath = new URL("../tools/shell.ts", import.meta.url).pathname;
  fs.writeFileSync(
    fixture,
    `import { execute } from ${JSON.stringify(shellPath)};\n` +
      `const out = await execute.execute({ command: "sleep 5" });\n` +
      `console.log("RESULT:", out);\n`,
    "utf8",
  );
  const out = await new Promise<string>((resolve) => {
    execFile(
      process.execPath,
      ["node_modules/.bin/tsx", fixture],
      { env: { ...process.env, EXECUTE_TIMEOUT_MS: "300" }, timeout: 30000 },
      (err, stdout) => resolve(stdout || String(err)),
    );
  });
  fs.rmSync(fixtureDir, { recursive: true, force: true });
  assert.match(out, /RESULT: Rejected: command timed out after 1s/);
  assert.ok(!out.includes("Error: Command timed out"), "timeouts must NOT end the turn");
});

test("execute: signal-killed commands are recoverable (Rejected + pkill self-match hint)", async () => {
  const { execute } = await import("../tools/shell.js");
  // `kill -TERM $$` makes the command's own bash die by SIGTERM — exactly the
  // shape a `pkill -f <pattern>` self-match produces (live miss 2026-10-16).
  const result = String(await execute.execute({ command: "kill -TERM $$" }));
  assert.match(result, /^Rejected: the command was killed by SIGTERM/, "signal death is recoverable");
  assert.match(result, /\[p\]attern/, "teaches the bracket trick");
  assert.ok(!result.startsWith("Error:"), "signal deaths must NOT end the turn");
});

test("execute: stderr on a zero exit is non-fatal, not 'Error output'", async () => {
  const { execute } = await import("../tools/shell.js");
  const ok = String(await execute.execute({ command: "echo hello; echo progress >&2" }));
  assert.match(ok, /Output:\nhello/);
  assert.match(ok, /Stderr \(non-fatal\):\nprogress/);
  assert.doesNotMatch(ok, /Error output:/);

  const bad = String(await execute.execute({ command: "echo bad >&2; exit 3" }));
  assert.match(bad, /Error output:\nbad/);
  assert.match(bad, /Exit code: 3/);
});

test("execute: turn abort signal kills the foreground child", async () => {
  const { execute } = await import("../tools/shell.js");
  const ctrl = new AbortController();
  const running = execute.execute({ command: "sleep 10" }, { signal: ctrl.signal });
  setTimeout(() => ctrl.abort(), 100);
  const out = String(await running);
  assert.match(out, /Rejected: cancelled by user/, "cancel kills the child promptly");
});

test("summarizer: env-gated factory + pseudo-tool guard + header shape", async () => {
  process.env.SEARCH_SUMMARIZER_ENABLED = "";
  const { createSessionSearchSummarizer } = await import("../summarizer.js");
  assert.equal(createSessionSearchSummarizer(), null, "off by default");
  process.env.SEARCH_SUMMARIZER_ENABLED = "true";
  try {
    const s = createSessionSearchSummarizer();
    assert.ok(s, "enabled with the key present");
    // condensed header shape: this is the python parity exact format
    const header = `[session_search: condensed by ${"openrouter/poolside/laguna-xs-2.1:free"} in 42ms from 8 raw excerpts]`;
    assert.match(header, /^\[session_search: condensed by openrouter\/[^\]]+ in \d+ms from \d+ raw excerpts\]$/);
  } finally {
    process.env.SEARCH_SUMMARIZER_ENABLED = "";
  }
});

test("summarizer: session_search condenses with header, silent-fallback unaffected", async () => {
  const { SQLiteSessionStore: SessionStore } = await import("../store.js");
  const { createSessionSearchTool } = await import("../tools/session_search.js");
  process.env.SESSION_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "nmfa-sz-")), "s.db");
  const store = new SessionStore();
  const sid = store.newSessionId();
  store.appendTurn(sid, [
    { role: "user", content: "asked about seasonal commodity futures DVR vs SSA backtest windows" },
    { role: "assistant", content: "the deep read summary with 15 liquid commodity futures, monthly returns, Jan 2016 OOS window, Newey-West SEs" },
  ]);
  class FakeSummarizer {
    label = "openrouter/poolside/laguna-xs-2.1:free";
    capturedSignal?: AbortSignal;
    async summarize(
      _query: string,
      hits: unknown[],
      signal?: AbortSignal,
    ): Promise<{ text: string; modelLabel: string; elapsedMs: number; excerptCount: number }> {
      void hits;
      this.capturedSignal = signal;
      return {
        text: "Summary: the seasonal-futures run used monthly returns with a fixed pre-OOS screen.",
        modelLabel: this.label,
        elapsedMs: 42,
        excerptCount: 8,
      };
    }
  }
  const fake = new FakeSummarizer();
  const tool = createSessionSearchTool(store, null, fake as never);
  const ctrl = new AbortController();
  const res = await tool.execute({ query: "seasonal futures", limit: 5 }, { signal: ctrl.signal });
  assert.equal(fake.capturedSignal, ctrl.signal, "session_search forwards the turn abort signal");
  assert.match(res, /^\[session_search: condensed by openrouter\/[^\]]+ in \d+ms from \d+ raw excerpts\]/);
  assert.match(res, /seasonal-futures run/);
  // "none relevant" → decay to raw list
  class EmptySummarizer {
    label = "openrouter/poolside/laguna-xs-2.1:free";
    async summarize() { return { text: "none relevant", modelLabel: this.label, elapsedMs: 9, excerptCount: 3 }; }
  }
  // "none relevant" merges back into raw fused hits for an actually-matching query
  const fallback = await createSessionSearchTool(store, null, new EmptySummarizer() as never).execute({ query: "seasonal futures", limit: 5 });
  assert.ok(!fallback.includes("condensed by"), "none-relevant output does not masquerade as a condensation");
  assert.match(fallback, /seasonal/i);
  // python sentinel parity: unrelated query = no matches (not a silent empty)
  assert.deepEqual(
    await createSessionSearchTool(store, null, new EmptySummarizer() as never).execute({ query: "zzz-nothing", limit: 5 }),
    "No past session matches found.",
  );
  store.close();
});
