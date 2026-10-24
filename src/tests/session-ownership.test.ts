// Session ownership: the archive is per-SSO-user. Legacy rows are backfilled
// to the previous default user (trgordonb); a second login sees none of them
// and cannot append to, load, search, or inspect their research runs.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

process.env.SESSION_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "nmfa-so-")), "s.db");
process.env.MEMORY_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "nmfa-so-m-"));
process.env.WORKSPACE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "nmfa-so-w-"));
delete process.env.WORKSPACE_USER;

const { SQLiteSessionStore, SessionOwnershipError } = await import("../store.js");
const { runInWorkspace } = await import("../workspace.js");

function tempDb(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "nmfa-so-db-")), "s.db");
}

test("sessions are visible only to their owner", () => {
  const store = new SQLiteSessionStore(tempDb());
  let aliceSid = "";
  let bobSid = "";

  runInWorkspace("alice", () => {
    aliceSid = store.newSessionId();
    store.appendTurn(aliceSid, [{ role: "user", content: "alice secret alpha" }]);
  });
  runInWorkspace("bob", () => {
    bobSid = store.newSessionId();
    store.appendTurn(bobSid, [{ role: "user", content: "bob secret beta" }]);
  });

  runInWorkspace("alice", () => {
    assert.deepEqual(store.listSessions().map((s) => s.session_id), [aliceSid]);
    assert.equal(store.loadSession(bobSid).length, 0);
    assert.equal(store.ownsSession(aliceSid), true);
    assert.equal(store.ownsSession(bobSid), false);
    assert.ok(store.search("secret").every((h) => h.session_id === aliceSid), "FTS recall is owner-scoped");
    assert.throws(
      () => store.appendTurn(bobSid, [{ role: "user", content: "hijack" }]),
      SessionOwnershipError,
    );
  });

  runInWorkspace("bob", () => {
    assert.deepEqual(store.listSessions().map((s) => s.session_id), [bobSid]);
  });
  assert.equal(store.totalSessions(), 2);
  store.close();
});

test("research runs are owner-scoped", () => {
  const store = new SQLiteSessionStore(tempDb());
  let sid = "";
  runInWorkspace("alice", () => {
    sid = store.newSessionId();
    store.startResearchRun(sid, "alice question");
  });
  runInWorkspace("bob", () => {
    assert.equal(store.getResearchRun(sid), null);
    assert.equal(store.ownsSession(sid), false);
  });
  runInWorkspace("alice", () => {
    assert.equal(store.getResearchRun(sid)?.question, "alice question");
  });
  store.close();
});

test("legacy archive rows are backfilled to trgordonb", () => {
  const dbPath = tempDb();
  const legacy = new DatabaseSync(dbPath);
  legacy.exec(`
    CREATE TABLE turns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      turn_number INTEGER NOT NULL,
      message_index INTEGER NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      tool_calls TEXT,
      tool_call_id TEXT,
      tool_name TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    INSERT INTO turns (session_id, turn_number, message_index, role, content)
      VALUES ('legacy-1', 1, 0, 'user', 'old conversation');
  `);
  legacy.close();

  const store = new SQLiteSessionStore(dbPath);
  assert.equal(store.listSessions("trgordonb").length, 1);
  assert.equal(store.listSessions("alice").length, 0);
  assert.equal(store.ownsSession("legacy-1", "trgordonb"), true);
  store.close();

  // A turn written after the one-time backfill (e.g. by an old process) must
  // stay unowned rather than being silently claimed by trgordonb.
  const late = new DatabaseSync(dbPath);
  late
    .prepare(`INSERT INTO turns (session_id, turn_number, message_index, role, content) VALUES (?, 1, 0, 'user', ?)`)
    .run("legacy-2", "late write from an old process");
  late.close();
  const reopened = new SQLiteSessionStore(dbPath);
  assert.equal(reopened.listSessions("trgordonb").length, 1);
  assert.equal(reopened.totalSessions(), 1);
  reopened.close();
});
