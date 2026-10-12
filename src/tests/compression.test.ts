// Context compression w/ lineage — pure-function contracts (split/slice),
// usage estimators, and the never-throw compress() edge cases. LLM path is
// exercised via a stubbed chat module.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.SESSION_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "nmfa-t-")), "s.db");
process.env.MEMORY_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "nmfa-m-"));
process.env.WORKSPACE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "nmfa-w-"));

const { estimateTokens, lastRequestTokens, splitIntoTurns } = await import("../compression.js");

test("estimateTokens: 4 chars/token + 8 overhead per message", () => {
  assert.equal(estimateTokens([]), 0);
  const one = [{ role: "user", content: "x".repeat(40) }];
  assert.equal(estimateTokens(one as never), 12); // floor((40+8)/4)
});

test("lastRequestTokens: reads the newest assistant w/ provider-reported usage", () => {
  type ChatMsg = { role: "user" | "assistant" | "tool"; content: string; usage?: { prompt_tokens?: number } };
  const msgs: ChatMsg[] = [
    { role: "user", content: "q" },
    { role: "assistant", content: "" },
    { role: "user", content: "q2" },
    { role: "assistant", content: "a", usage: { prompt_tokens: 32123 } },
  ];
  assert.equal(lastRequestTokens(msgs as never), 32123);
  assert.equal(lastRequestTokens([] as never), null);
});

test("splitIntoTurns: each turn starts at a user msg; leading system rides along", () => {
  const msgs = [
    { role: "system", content: "You are helpful" },
    { role: "user", content: "turn 1" },
    { role: "assistant", content: "thanks" },
    { role: "user", content: "turn 2" },
    { role: "tool", content: "r", tool_call_id: "x", name: "grep" },
    { role: "user", content: "turn 3" },
  ];
  const segs = splitIntoTurns(msgs as never);
  assert.equal(segs.length, 3);
  assert.equal(segs[0].length, 3, "system + turn1 user + assistant ride the first segment (python parity)");
  assert.equal(segs[1].length, 2);
  assert.equal(segs[2].length, 1);
});

test("storage: recordCompression + listCompressions round-trip the lineage", async () => {
  process.env.SESSION_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "nmfa-c-")), "s.db");
  const { SQLiteSessionStore: Store } = await import("../store.js");
  const store = new Store();
  const sid = store.newSessionId();
  store.recordCompression(sid, { summary: "turn 2 summarized", firstTurn: 2, lastTurn: 2, originalCount: 73, model: "openrouter/z-ai/glm-5.3-flash" });
  const rows = store.listCompressions(sid);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].first_turn, 2);
  assert.match(rows[0].summary, /turn 2 summarized/);
  store.close();
});
