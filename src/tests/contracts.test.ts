// Unit tests: budget, store round-trip fidelity, tool failure conventions.
// The suite is the contract — same as nm-memory-layer's doctrine.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.SESSION_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "nmfa-t-")), "s.db");
process.env.MEMORY_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "nmfa-m-"));

const { PromptMemory } = await import("../memory.js");
const { MEMORY_CHAR_LIMIT } = await import("../config.js");
const { SQLiteSessionStore: SessionStore } = await import("../store.js");

// --- PromptMemory budget -------------------------------------------------------

test("prompt memory: empty load renders empty string", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nmfa-"));
  const m = new PromptMemory(path.join(dir, "MEMORY.md"), path.join(dir, "USER.md"));
  assert.equal(m.load(), "");
  assert.equal(m.totalChars(), 0);
});

test("prompt memory: add/replace/remove round-trip with rendered block", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nmfa-"));
  const mp = path.join(dir, "MEMORY.md");
  const up = path.join(dir, "USER.md");
  const m = new PromptMemory(mp, up);
  assert.match(m.add("memory", "Shipping SVG via express"), /OK: MEMORY\.md/);
  assert.match(m.add("user", "Gordon prefers terse diffs"), /OK: USER\.md/);
  const block = m.load();
  assert.match(block, /^<agent_memory>/);
  assert.match(block, /-- MEMORY\.md/);
  assert.match(block, /Shipping SVG via express/);
  assert.match(block, /-- USER\.md/);
  assert.match(block, /Gordon prefers terse diffs/);

  // replace: full-string in place
  assert.match(m.replace("memory", "Shipping SVG via express", "Shipping SVG via agentdb"), /OK/);
  assert.match(fs.readFileSync(mp, "utf8"), /agentdb/);

  // remove
  assert.match(m.remove("user", "Gordon prefers terse diffs"), /OK/);
  assert.doesNotMatch(m.load(), /terse diffs/);
});

test("prompt memory: budget is shared across BOTH files and denials use 'Rejected:'", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nmfa-"));
  const m = new PromptMemory(path.join(dir, "MEMORY.md"), path.join(dir, "USER.md"));
  assert.match(m.add("memory", "x".repeat(MEMORY_CHAR_LIMIT)), /OK/);
  assert.equal(m.totalChars(), MEMORY_CHAR_LIMIT);
  // No room left for USER.md — the budget is combined
  const res = m.add("user", "y");
  assert.match(res, /^Rejected:.*budget/);
  // Error:-prefix would be fatal for the loop — forbidden here.
  assert.ok(!res.startsWith("Error:"));
});

// --- SessionStore fidelity ------------------------------------------------------

interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

test("store: round-trip preserves tool_calls + tool_call_id (provider validity)", async () => {
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "nmfa-"));
  const store = new SessionStore(path.join(dbDir, "t.db"));
  const sid = store.newSessionId();
  const call: ToolCall = { id: "call_01", name: "execute", args: { command: "ls" } };
  store.appendTurn(sid, [
    { role: "user", content: "hello" },
    { role: "assistant", content: "", tool_calls: [call] },
    { role: "tool", content: "Output:\nfile.txt", tool_call_id: "call_01", name: "execute" },
    { role: "assistant", content: "done" },
  ]);
  const loaded = store.loadSession(sid);
  assert.equal(loaded.length, 4);
  assert.deepEqual((loaded[1] as ChatLike).tool_calls, [call]);
  assert.equal(loaded[2].tool_call_id, "call_01");
  assert.equal(loaded[2].name, "execute");
  store.close();
});

test("store: search falls back AND → OR/phrase → LIKE (structured hits)", async () => {
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "nmfa-"));
  const store = new SessionStore(path.join(dbDir, "t.db"));
  const sid = store.newSessionId();
  store.appendTurn(sid, [
    { role: "user", content: "discussed backtest Sharpe ratios" },
  ]);
  store.appendTurn(store.newSessionId(), [
    { role: "user", content: "vector index tuning notes" },
  ]);
  // Provide LIKE-fallback fodder so the degraded chain is actually retrievable
  store.appendTurn(store.newSessionId(), [
    { role: "user", content: "broken AND unbalanced FTS syntax handled" },
  ]);
  const hits = store.search("Sharpe", 5);
  assert.equal(hits.length, 1);
  assert.match(hits[0].snippet, /Sharpe/);
  assert.equal(hits[0].retriever, "fts");
  // exact-AND phrasing hits as well
  assert.equal(store.search("Sharpe ratios", 5).length, 1);
  // invalid FTS syntax must fall through to LIKE, not throw
  const invalid = store.search('"broken AND', 5);
  assert.ok(invalid.length === 1, `expected exactly one LIKE fallback hit, got ${invalid.length}`);
  assert.match(invalid[0].snippet, /broken/);
  // nothing matches → [] (the empty sentinel is the tool's job)
  assert.deepEqual(store.search("zzz-nothing-zzz", 5), []);
  store.close();
});

interface ChatLike {
  role: string;
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

// --- tool conventions ------------------------------------------------------------

test("tools: failures speak 'Error:' only for fatal, 'Rejected:' for recoverable", async () => {
  const { memory_manage } = await import("../tools/memory_manage.js");
  const denied = await memory_manage.execute({ operation: "replace", target: "memory", old: "no such phrase", text: "x" });
  assert.ok(denied.startsWith("Rejected:"), "recoverable denial must not be fatal");
  const emptyAdd = await memory_manage.execute({ operation: "add", target: "memory", text: "  " });
  assert.ok(emptyAdd.startsWith("Rejected:"));
  const missingFile = await (await import("../tools/fs.js")).read_file.execute({ file_path: "/nonexistent-xyz" });
  assert.ok(missingFile.startsWith("Rejected:"), "wrong-path failures are recoverable, not turn-fatal");
});

test("tools: execute returns stderr/exit codes without Error: unless timed out", async () => {
  const { execute } = await import("../tools/shell.js");
  const failedCmd = await execute.execute({ command: "exit 3" });
  assert.match(failedCmd, /Exit code: 3/);
  assert.ok(!failedCmd.startsWith("Error:"));
  const ok = await execute.execute({ command: "echo hi" });
  assert.match(ok, /hi/);
});

test("store: session titles — fallback set/get, refine overwrite, listSessions joins summary", async () => {
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "nmfa-"));
  const store = new SessionStore(path.join(dbDir, "t.db"));
  const sid = store.newSessionId();
  store.appendTurn(sid, [{ role: "user", content: "backtest the FVG strategy" }]);
  assert.equal(store.getSessionTitle(sid), null);
  assert.equal(store.listSessions().find((r) => r.session_id === sid)?.summary ?? null, null);

  store.setSessionTitle(sid, "backtest the FVG strategy", "fallback");
  assert.equal(store.getSessionTitle(sid), "backtest the FVG strategy");
  assert.equal(store.getSessionTitleModel(sid), "fallback");
  assert.equal(store.listSessions().find((r) => r.session_id === sid)?.summary, "backtest the FVG strategy");

  // refine overwrites same row (one title, never regenerated)
  store.setSessionTitle(sid, "FVG backtest replication on EUR/USD", "openrouter/poolside/laguna-xs-2.1:free");
  assert.equal(store.getSessionTitle(sid), "FVG backtest replication on EUR/USD");
  assert.equal(store.getSessionTitleModel(sid), "openrouter/poolside/laguna-xs-2.1:free");
  assert.equal(store.listSessions().find((r) => r.session_id === sid)?.summary, "FVG backtest replication on EUR/USD");
  store.close();
});

test("titler: fallbackTitle truncation + word cleanup", async () => {
  const { fallbackTitle } = await import("../titler.js");
  assert.equal(fallbackTitle("short msg"), "short msg");
  assert.equal(fallbackTitle("  spaced\n\ttext  "), "spaced text");
  const long = fallbackTitle("x".repeat(100), 60);
  assert.ok(long.length <= 60 && long.endsWith("…") === true || long.length === 60);
  assert.equal(fallbackTitle("a".repeat(59), 60).length, 59);
  assert.equal(fallbackTitle("a".repeat(61), 60).length, 60);
});
