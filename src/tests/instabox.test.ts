// InstaBox lifecycle sweep (src/instabox.ts): session-tagged sandboxes are
// removed at turn end; missing CLI, malformed output and per-sandbox rm
// failures are swallowed (best-effort by contract).

import { test } from "node:test";
import assert from "node:assert/strict";

const { cleanupSessionSandboxes, setInstaboxRunner } = await import("../instabox.js");

test("instabox sweep: removes every sandbox tagged with the session", async () => {
  const calls: Array<[string, string[]]> = [];
  setInstaboxRunner((file, args, cb) => {
    calls.push([file, args]);
    if (args[0] === "ls") {
      cb(null, JSON.stringify([{ id: "m_1" }, { machine_id: "m_3" }]));
    } else {
      cb(null, "");
    }
  });
  const removed = await cleanupSessionSandboxes("sess-1");
  assert.deepEqual(removed, ["m_1", "m_3"]);
  assert.equal(calls[0][1][0], "ls");
  assert.deepEqual(calls[0][1].slice(1, 3), ["--meta", "nm-session=sess-1"]);
  assert.deepEqual(calls[1][1], ["rm", "m_1", "--no-wait"]);
  assert.deepEqual(calls[2][1], ["rm", "m_3", "--no-wait"]);
});

test("instabox sweep: missing CLI is swallowed (no throw, no rm)", async () => {
  setInstaboxRunner((file, args, cb) => {
    const err = new Error("spawn instabox ENOENT") as Error & { code?: string };
    err.code = "ENOENT";
    cb(err, "");
  });
  const removed = await cleanupSessionSandboxes("sess-2");
  assert.deepEqual(removed, []);
});

test("instabox sweep: malformed listing parses to nothing", async () => {
  const rms: string[] = [];
  setInstaboxRunner((file, args, cb) => {
    if (args[0] === "ls") cb(null, "instabox: some warning\ndefinitely not json");
    else {
      rms.push(args[1]);
      cb(null, "");
    }
  });
  const removed = await cleanupSessionSandboxes("sess-3");
  assert.deepEqual(removed, []);
  assert.deepEqual(rms, []);
});

test("instabox sweep: one rm failure does not stop the rest", async () => {
  setInstaboxRunner((file, args, cb) => {
    if (args[0] === "ls") cb(null, JSON.stringify([{ id: "a" }, { id: "b" }]));
    else if (args[1] === "a") {
      cb(new Error("boom"), "");
      return;
    } else {
      cb(null, "");
      return;
    }
  });
  const removed = await cleanupSessionSandboxes("sess-4");
  assert.deepEqual(removed, ["b"]);
});

test("instabox sweep: empty session id is a no-op", async () => {
  let called = false;
  setInstaboxRunner((file, args, cb) => {
    called = true;
    cb(null, "[]");
  });
  assert.deepEqual(await cleanupSessionSandboxes(""), []);
  assert.equal(called, false);
});
