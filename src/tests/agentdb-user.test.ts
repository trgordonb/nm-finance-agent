// Per-user agentdb MCP store paths (reflexion/skills/patterns).

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.SESSION_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "nmfa-adb-")), "s.db");
process.env.MEMORY_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "nmfa-adb-m-"));
process.env.WORKSPACE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "nmfa-adb-w-"));
process.env.SKILLS_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "nmfa-adb-s-"));
delete process.env.AGENTDB_MCP_DIR;

const { agentdbUserDbPath } = await import("../mcp-tools.js");
const { AGENTDB_MCP_DIR } = await import("../config.js");

test("agentdb MCP dir defaults under the skills state dir", () => {
  assert.equal(AGENTDB_MCP_DIR, path.join(process.env.SKILLS_STATE_DIR as string, "agentdb"));
});

test("each login gets a distinct, sanitised agentdb DB path", () => {
  assert.equal(
    agentdbUserDbPath("trgordonb"),
    path.join(AGENTDB_MCP_DIR, "trgordonb", "agentdb-mcp.db"),
  );
  assert.equal(
    agentdbUserDbPath("User@Example.com"),
    path.join(AGENTDB_MCP_DIR, "user_example.com", "agentdb-mcp.db"),
  );
  assert.equal(agentdbUserDbPath(""), path.join(AGENTDB_MCP_DIR, "default", "agentdb-mcp.db"));
  assert.notEqual(agentdbUserDbPath("alice"), agentdbUserDbPath("bob"));
});
