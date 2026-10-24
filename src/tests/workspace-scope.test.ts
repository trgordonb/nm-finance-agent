// User-scoped workspaces: with SSO each login gets WORKSPACE_DIR/<login-id>/.
// The resolver is AsyncLocalStorage-based, so tools and `execute` inherit the
// request's scope without threading a user id through every tool signature.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import type { AddressInfo } from "node:net";

process.env.SESSION_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "nmfa-t-")), "s.db");
process.env.MEMORY_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "nmfa-m-"));
process.env.WORKSPACE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "nmfa-w-"));
delete process.env.WORKSPACE_USER; // flat fallback for the no-scope assertions

const {
  sanitizeUserId,
  workspaceUserKey,
  workspaceRootFor,
  ensureWorkspaceFor,
  runInWorkspace,
  resolveInWorkspace,
  currentWorkspaceRoot,
  guardWorkspaceWrite,
} = await import("../workspace.js");
const { WORKSPACE_DIR } = await import("../config.js");

test("user ids become one safe lowercase path segment", () => {
  assert.equal(sanitizeUserId("trgordonb"), "trgordonb");
  assert.equal(sanitizeUserId("User@Example.com"), "user_example.com");
  assert.equal(sanitizeUserId("../../etc/passwd"), "etc_passwd");
  assert.equal(sanitizeUserId("  "), "");
  assert.equal(sanitizeUserId(".."), "");
});

test("login id, then subject, then a safe default", () => {
  assert.equal(workspaceUserKey("trgordonb", "42"), "trgordonb");
  assert.equal(workspaceUserKey("", "42"), "42");
  assert.equal(workspaceUserKey("", ""), "user");
});

test("scoped resolution, jail and nesting", () => {
  const alice = path.join(WORKSPACE_DIR, "alice");
  runInWorkspace("Alice", () => {
    assert.equal(currentWorkspaceRoot(), alice);
    assert.equal(resolveInWorkspace(""), alice);
    assert.equal(resolveInWorkspace("reports/x.md"), path.join(alice, "reports/x.md"));
    assert.equal(guardWorkspaceWrite(path.join(alice, "ok.csv")), "");

    const bob = runInWorkspace("bob", () => {
      assert.equal(currentWorkspaceRoot(), path.join(WORKSPACE_DIR, "bob"));
      return resolveInWorkspace("x");
    });
    assert.equal(bob, path.join(WORKSPACE_DIR, "bob", "x"));
    // nested scope unwinds to Alice
    assert.equal(currentWorkspaceRoot(), alice);
  });
  // outside any scope: flat legacy root (WORKSPACE_USER unset)
  assert.equal(currentWorkspaceRoot(), WORKSPACE_DIR);
  assert.equal(resolveInWorkspace("x"), path.join(WORKSPACE_DIR, "x"));
});

test("ensureWorkspaceFor creates the folder; empty id keeps the flat root", () => {
  const carol = ensureWorkspaceFor("carol");
  assert.equal(carol, path.join(WORKSPACE_DIR, "carol"));
  assert.ok(fs.existsSync(carol));
  assert.equal(workspaceRootFor(""), WORKSPACE_DIR);
});

test("execute inherits cwd and $WORKSPACE_DIR from the active scope", async () => {
  const { execute } = await import("../tools/shell.js");
  await runInWorkspace("dave", async () => {
    const root = path.join(WORKSPACE_DIR, "dave");
    const out = await execute.execute({ command: 'pwd; printf "env=%s" "$WORKSPACE_DIR"' });
    assert.ok(out.includes(root), `expected cwd ${root}, got: ${out}`);
    assert.ok(out.includes(`env=${root}`), `expected $WORKSPACE_DIR=${root}, got: ${out}`);
  });
});

test("express middleware scope reaches async route handlers", async () => {
  const express = (await import("express")).default;
  const app = express();
  app.use((_req, _res, next) => runInWorkspace("erin", next));
  app.get("/", (_req, res) => {
    void (async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      res.json({ root: currentWorkspaceRoot() });
    })();
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const port = (server.address() as AddressInfo).port;
    const body = (await (await fetch(`http://127.0.0.1:${port}/`)).json()) as { root: string };
    assert.equal(body.root, path.join(WORKSPACE_DIR, "erin"));
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
