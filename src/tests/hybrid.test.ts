// Hybrid session_search fusion + AgentDbMirror contract tests.
// The mirror/tests never import ruvector — injectable fake DB/embedder keeps
// the suite light; the real engine is exercised in live smoke runs only.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.SESSION_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "nmfa-t-")), "s.db");
process.env.MEMORY_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "nmfa-m-"));
process.env.WORKSPACE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "nmfa-w-"));
process.env.AGENTDB_MIRROR = "0"; // suite never spins up the real embedder

const { SQLiteSessionStore: SessionStore } = await import("../store.js");
const { createSessionSearchTool } = await import("../tools/session_search.js");
const { AgentDbMirror } = await import("../agentdb-mirror.js");

// --- FakeMirror: the injectable double (shape-compatible w/ AgentDbMirror) ----

// A tiny injectable double: mimic AgentDbMirror.search + status shape.
class FakeMirror {
  status = { enabled: true };
  records: Array<{ sessionId: string; createdAt: string; content: string; role: string; similarity: number }> = [];

  async search(query: string, limit = 6): Promise<Array<{ sessionId: string; createdAt: string; content: string; role: string; similarity: number }>> {
    const q = query.toLowerCase();
    return this.records
      .map((r) => ({ ...r, similarity: this.similarity(q, r.content.toLowerCase()) }))
      .filter((r) => this.tokens(q).some((tok) => r.content.toLowerCase().includes(tok)))
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, limit);
  }

  private tokens(q: string): string[] {
    return q.split(/\s+/).filter((t) => t.length > 2);
  }

  private similarity(q: string, content: string): number {
    const overlap = this.tokens(q).filter((t) => content.includes(t)).length;
    return Math.min(1, overlap / Math.max(1, this.tokens(q).length));
  }
}

test("fusion: both legs rank identical hit first (RRF sum), tags fuse to fts+semantic", async () => {
  const store = new SessionStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "nmfa-")), "t.db"));
  const sid = store.newSessionId();
  store.appendTurn(sid, [
    { role: "user", content: "discussed backtest Sharpe ratio calibration" },
    { role: "tool", content: "Output:\n== [2] unrelated noise marker", tool_call_id: "call_X" },
  ]);
  const fake = new FakeMirror();
  // same content as the archived row → the dedup key matches → true fusion
  fake.records.push({
    sessionId: sid,
    createdAt: store.listSessions()[0].created_at,
    content: "discussed backtest Sharpe ratio calibration",
    role: "user",
    similarity: 0.9,
  });

  const tool = createSessionSearchTool(store, fake as never);
  const res = await tool.execute({ query: "Sharpe ratio calibration", limit: 5 });
  const first = res.split("\n")[0];
  assert.match(first, /\[1\]/, "top block must be rank 1");
  assert.match(first, /fts\+semantic/, "top hit should carry fused retriever tag");
  assert.match(res, /semantic\(\d\.\d{2}\)/);
  assert.match(res, /Sharpe/);
  store.close();
});

test("fusion: semantic-only hit survives when FTS leg is empty", async () => {
  const store = new SessionStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "nmfa-")), "t.db"));
  const fake = new FakeMirror();
  fake.records.push({
    sessionId: store.newSessionId(),
    createdAt: "2026-10-09T00:00:00Z",
    content: "portfolio risk parity notes from an old session",
    role: "user",
    similarity: 0.73,
  });
  const tool = createSessionSearchTool(store, fake as never);
  // FTS5 needs a stem-typable keyword; "risk parity notes" is absent from archive rows
  const res = await tool.execute({ query: "risk parity portfolio construction", limit: 5 });
  assert.match(res, /semantic\(\d\.\d{2}\)/);
  assert.match(res, /risk parity/);
  store.close();
});

test("fusion: empty both legs keeps the explicit sentinel string", async () => {
  const store = new SessionStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "nmfa-")), "t.db"));
  const tool = createSessionSearchTool(store, new FakeMirror() as never);
  assert.equal(await tool.execute({ query: "zzz-nothing-zzz", limit: 3 }), "No past session matches found.");
  store.close();
});

test("mirror: disabled mirror (env off) leaves search single-leg", async () => {
  const store = new SessionStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "nmfa-")), "t.db"));
  const sid = store.newSessionId();
  store.appendTurn(sid, [{ role: "user", content: "mentions momentum seasonality" }]);
  const mirror = new AgentDbMirror();
  mirror.status.enabled = false;
  const tool = createSessionSearchTool(store, mirror);
  const res = await tool.execute({ query: "momentum seasonality", limit: 3 });
  assert.match(res, /momentum/);
  assert.doesNotMatch(res, /semantic|fts\+semantic/, "no retriever tags on single-leg output");
  store.close();
});

test("mirror: recordTurn/search are no-throw without an initialized engine", async () => {
  const mirror = new AgentDbMirror("");
  await mirror.recordTurn("sid", 1, [{ role: "user", content: "x" }]);
  assert.deepEqual(await mirror.search("q", 3), []);
  await mirror.close();
});

test("edit_file: not-found old_string is recoverable, whitespace-flexible fallback applies", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nmfa-"));
  const file = path.join(dir, "target.py");
  fs.writeFileSync(file, "def run():\n    df, trades = run(df, p)\n    return df\n", "utf8");
  const { edit_file } = await import("../tools/fs.js");
  // drifting indentation within old_string → flexible match still lands
  const ok = await edit_file.execute({
    file_path: file,
    old_string: "df,  trades = run(df,   p)",
    new_string: "df, trades = run(df, p, dt)",
  });
  assert.match(ok, /Successfully edited/);
  assert.match(fs.readFileSync(file, "utf8"), /run\(df, p, dt\)/);
  // genuinely absent text → recoverable Rejected (no Error:, turn continues)
  const denied = await edit_file.execute({
    file_path: file,
    old_string: "old text that is nowhere",
    new_string: "x",
  });
  assert.match(denied, /^Rejected: old_string not found/);
});
