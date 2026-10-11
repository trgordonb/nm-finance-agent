// Nudge (Phase 4): policy counting, transcript flattening, prompt contract.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.SESSION_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "nmfa-t-")), "s.db");
process.env.MEMORY_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "nmfa-m-"));
process.env.WORKSPACE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "nmfa-w-"));

const { NudgePolicy, buildNudgePrompt, flattenTranscript } = await import("../nudge.js");
const { MEMORY_CHAR_LIMIT } = await import("../config.js");

test("nudge policy fires every N completed turns, then resets", () => {
  const p = new NudgePolicy(3);
  p.recordTurn("s1");
  p.recordTurn("s1");
  assert.equal(p.shouldNudge("s1"), false);
  assert.equal(p.turnsPending("s1"), 2);
  p.recordTurn("s1");
  assert.equal(p.shouldNudge("s1"), true);
  p.markNudged("s1");
  assert.equal(p.shouldNudge("s1"), false);
  assert.equal(p.turnsPending("s1"), 0);
  // per-session isolation
  p.recordTurn("s2");
  assert.equal(p.shouldNudge("s2"), false);
  assert.equal(new NudgePolicy(0).interval, 1, "interval clamped >= 1");
});

test("nudge prompt: silence bias + skills binding + budget accounting", () => {
  const prompt = buildNudgePrompt(1200, MEMORY_CHAR_LIMIT);
  assert.match(prompt, /Silence is a valid and expected outcome/);
  assert.match(prompt, /skill_manage/);
  assert.match(prompt, /1200 already used/);
  assert.match(prompt, /MEMORY\.md/);
});

test("flattenTranscript: tool calls narrated, tool results labeled, no pairing constraints", () => {
  const out = flattenTranscript([
    { role: "user", content: "run the vol regime probe" },
    {
      role: "assistant",
      content: "",
      tool_calls: [{ id: "call_1", name: "execute", args: { command: "echo hi" } }],
    },
    { role: "tool", content: "hi", tool_call_id: "call_1", name: "execute" },
    { role: "assistant", content: "done" },
  ]);
  assert.match(out, /^user: run the vol regime probe/);
  assert.match(out, /\[called execute\(\{"command":"echo hi"\}\)\]/);
  assert.match(out, /tool result \(execute\): hi/);
  assert.match(out, /assistant: done$/);
});
