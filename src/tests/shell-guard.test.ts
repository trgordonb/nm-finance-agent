// execute tool: empty-command + sync-spawn guards (live cron miss 2026-10-30 —
// a GLM tool-args slip emitted command:"" and exec("") threw synchronously,
// fatal "file cannot be empty" ending a scheduled run at iteration 5).

import { test } from "node:test";
import assert from "node:assert/strict";

process.env.LANGSMITH_TRACING = "0";

const { execute: shellTool } = await import("../tools/shell.js");

test("execute: empty command is a recoverable Rejected, not a fatal error", async () => {
  const out = String(await shellTool.execute({ command: "" }));
  assert.match(out, /Rejected: empty command/);
  const ws = String(await shellTool.execute({ command: "   " }));
  assert.match(ws, /Rejected: empty command/);
  const missing = String(await shellTool.execute({}));
  assert.match(missing, /Rejected: empty command/);
});

test("execute: sync spawn throw (e.g. unset cwd) is Rejected, not thrown", async () => {
  // cwd is process-level, so force the throw via a command shape that makes
  // child_process reject the file argument: an embedded NUL byte.
  const out = String(await shellTool.execute({ command: "echo ok\u0000rm -rf" }));
  assert.match(out, /Rejected: could not spawn|Output:/);
  assert.doesNotMatch(out, /^Error: tool/);
});

test("execute: normal commands still run", async () => {
  const out = String(await shellTool.execute({ command: "echo hello-cron" }));
  assert.match(out, /hello-cron/);
});
