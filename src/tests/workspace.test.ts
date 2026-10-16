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

test("fs tools: missing required args are recoverable and never touch 'undefined'", async () => {
  const { edit_file, write_file, read_file, glob, grep } = await import("../tools/fs.js");

  // The live miss (2026-10-16): edit_file called with only old/new strings —
  // previously resolved a literal workspace/undefined path as a fatal ENOENT.
  const edit = String(await edit_file.execute({ old_string: "a", new_string: "b" }));
  assert.match(edit, /^Rejected: edit_file requires.*file_path/);
  assert.match(edit, /old_string, new_string/);
  assert.ok(!edit.startsWith("Error:"), "missing arg must not end the turn");

  // Key-alias hint re-routes a path-vs-file_path mix-up in the same turn.
  const alias = String(await edit_file.execute({ path: "x.py", old_string: "a", new_string: "b" }));
  assert.match(alias, /Did you mean 'path' instead of 'file_path'\?/);

  // write_file must never create workspace/undefined for a missing file_path.
  const w = String(await write_file.execute({ content: "oops" }));
  assert.match(w, /^Rejected: write_file requires.*file_path/);
  assert.ok(!fs.existsSync(path.join(WORKSPACE_DIR, "undefined")), "no 'undefined' file may be created");
  // missing content is rejected; an explicit empty string is allowed
  assert.match(String(await write_file.execute({ file_path: "empty.txt" })), /^Rejected: write_file requires.*content/);
  assert.match(String(await write_file.execute({ file_path: "empty.txt", content: "" })), /^Successfully wrote/);

  assert.match(String(await read_file.execute({})), /^Rejected: read_file requires.*file_path/);
  assert.match(String(await glob.execute({})), /^Rejected: glob requires.*pattern/);
  assert.match(String(await grep.execute({})), /^Rejected: grep requires.*pattern/);
});

test("fs tools: missing-file and directory paths are recoverable (not Error:)", async () => {
  const { edit_file, read_file, grep } = await import("../tools/fs.js");
  // edit_file on a nonexistent file — was the fatal ENOENT class
  const edit = String(await edit_file.execute({ file_path: "no/such/file.py", old_string: "x", new_string: "y" }));
  assert.match(edit, /^Rejected: file does not exist/);
  assert.ok(!edit.startsWith("Error:"));
  // read_file pointed at a directory → EISDIR → recoverable
  const dir = String(await read_file.execute({ file_path: "." }));
  assert.match(dir, /^Rejected: .*directory/);
  // grep with a missing path → recoverable
  const g = String(await grep.execute({ pattern: "z", path: "no/such/dir" }));
  assert.match(g, /^Rejected: path does not exist/);
});
