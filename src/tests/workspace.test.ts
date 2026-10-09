// Workspace discipline (option C): relative paths workspace-rooted, absolute
// paths pass through, repo-internal writes rejected as recoverable denials,
// and the read side stays unguarded.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.SESSION_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "nmfa-t-")), "s.db");
process.env.MEMORY_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "nmfa-m-"));
process.env.WORKSPACE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "nmfa-w-"));

const { resolveInWorkspace, guardWorkspaceWrite } = await import("../workspace.js");
const { WORKSPACE_DIR } = await import("../config.js");

test("workspace: relative paths resolve under WORKSPACE_DIR, '.' = workspace", async () => {
  assert.equal(resolveInWorkspace(""), WORKSPACE_DIR);
  assert.equal(resolveInWorkspace("."), WORKSPACE_DIR);
  assert.equal(resolveInWorkspace("reports/x.md"), path.join(WORKSPACE_DIR, "reports/x.md"));
  // escape via .. stays allowed for reads
  const outside = resolveInWorkspace("../src/agent.ts");
  assert.match(outside, /src\/agent\.ts$/);
});

test("workspace: absolute paths pass through untouched", async () => {
  const abs = path.join(os.tmpdir(), "somewhere", "data.csv");
  assert.equal(resolveInWorkspace(abs), abs);
});

test("workspace: writes into harness internals are denied (recoverable), others pass", async () => {
  const denySource = guardWorkspaceWrite(path.resolve(process.cwd(), "src/agent.ts"));
  assert.match(denySource, /^Rejected:.*harness/);
  assert.ok(!denySource.startsWith("Error:"), "denial must not be fatal");
  const denyEnv = guardWorkspaceWrite(path.resolve(process.cwd(), ".env"));
  assert.match(denyEnv, /^Rejected:/);
  // workspace writes pass
  assert.equal(guardWorkspaceWrite(path.join(WORKSPACE_DIR, "out.csv")), "");
  // outside-workspace path allowed in GOTCHA mode (no HARD_JAIL)
  assert.equal(guardWorkspaceWrite(path.join(os.tmpdir(), "other", "x.txt")), "");
});

test("workspace tools: write_file lands in workspace via relative path", async () => {
  const { write_file, ls, read_file } = await import("../tools/fs.js");
  const res = await write_file.execute({ file_path: "reports/test-w.md", content: "hello workspace" });
  assert.match(res, /Successfully wrote/);
  assert.equal(fs.readFileSync(path.join(WORKSPACE_DIR, "reports/test-w.md"), "utf8"), "hello workspace");
  // ls('.') = workspace listing now
  const listing = await ls.execute({});
  assert.match(listing, /reports/);
  // relative read round-trips
  assert.equal(await read_file.execute({ file_path: "reports/test-w.md" }), "hello workspace");
});

test("workspace tools: execute spawns with workspace cwd", async () => {
  const { execute } = await import("../tools/shell.js");
  const out = await execute.execute({ command: "pwd" });
  assert.ok(out.includes(process.env.WORKSPACE_DIR as string), `expected workspace cwd, got: ${out}`);
});

test("workspace tools: repo-internal write via absolute path is guarded", async () => {
  const { write_file } = await import("../tools/fs.js");
  // In a deployed install the workspace sits inside the repo, so "../src"
  // escapes to repo source; the guard is exercised here via the absolute form.
  const abs = path.resolve(process.cwd(), "src/evil.mjs");
  const sneaky = await write_file.execute({ file_path: abs, content: "bad" });
  assert.match(sneaky, /^Rejected/);
  assert.ok(!fs.existsSync(abs));
});
