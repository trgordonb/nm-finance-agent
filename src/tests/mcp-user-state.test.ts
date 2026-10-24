// Per-user MCP server toggles (state/users/<id>/mcp.json).

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.SESSION_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "nmfa-mu-")), "s.db");
process.env.MEMORY_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "nmfa-mu-m-"));
process.env.WORKSPACE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "nmfa-mu-w-"));
process.env.SKILLS_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "nmfa-mu-s-"));
delete process.env.WORKSPACE_USER;

const { runInWorkspace } = await import("../workspace.js");
const {
  mcpServerEnabledForUser,
  setMcpServerEnabledForUser,
  userMcpStatePath,
  readUserMcpState,
} = await import("../mcp-user-state.js");

test("MCP toggles are per user and default to enabled", () => {
  runInWorkspace("alice", () => {
    assert.equal(mcpServerEnabledForUser("luxalgo"), true);
    assert.match(setMcpServerEnabledForUser("luxalgo", false).status, /^OK: disabled/);
    assert.equal(mcpServerEnabledForUser("luxalgo"), false);
    assert.equal(mcpServerEnabledForUser("agentdb"), true);
  });

  assert.equal(
    userMcpStatePath("alice"),
    path.join(process.env.SKILLS_STATE_DIR as string, "users", "alice", "mcp.json"),
  );
  assert.deepEqual(readUserMcpState("alice"), { disabled: ["luxalgo"] });

  runInWorkspace("bob", () => {
    assert.equal(mcpServerEnabledForUser("luxalgo"), true);
    assert.match(setMcpServerEnabledForUser("luxalgo", true).status, /^OK: enabled/);
    assert.equal(mcpServerEnabledForUser("luxalgo"), true);
  });

  runInWorkspace("alice", () => {
    assert.equal(mcpServerEnabledForUser("luxalgo"), false);
    assert.match(setMcpServerEnabledForUser("luxalgo", true).status, /^OK: enabled/);
    assert.equal(mcpServerEnabledForUser("luxalgo"), true);
  });

  assert.ok(fs.existsSync(path.join(process.env.SKILLS_STATE_DIR as string, "users", "alice", "mcp.json")));
});
