// User-scoped OpenRouter keys (docs/user-scoped-openrouter-keys-plan.md):
// storage encryption, policy resolution, chat() Authorization wiring, usage
// recording, and the per-user spend summary.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.LANGSMITH_TRACING = "0";
process.env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY ?? "server-key-test";
process.env.USER_LLM_KEY_SECRET = "test-master-secret";
process.env.LLM_KEY_POLICY = "prefer_user";
delete process.env.LLM_KEY_REQUIRE_USER_AFTER;
process.env.SKILLS_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "llmkeys-test-"));

const { SQLiteSessionStore } = await import("../store.js");
const {
  clearUserOpenRouterKey,
  getUserOpenRouterKey,
  keyEncryptionActive,
  maskKey,
  resolveAuthorizationKey,
  setLlmUsageRecorder,
  setUserOpenRouterKey,
} = await import("../llm-keys.js");
const { chat } = await import("../llm.js");
// config.ts loads the repo .env via dotenv (override: true), so the resolved
// server key comes from there — assert against it, not the literal test env.
const { OPENROUTER_API_KEY: SERVER_KEY } = await import("../config.js");
const { runInWorkspace } = await import("../workspace.js");

const ALICE_KEY = "sk-or-v1-alice-aaaaaaaaaaaaaaaaaaaa1111";
const USER_SECRET_UNUSED = "unused";

function chatResponse() {
  return new Response(
    JSON.stringify({
      model: "test-model",
      usage: { prompt_tokens: 12, completion_tokens: 3, cost: 0.02 },
      choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

test("llm keys: mask + encrypted-at-rest roundtrip", async () => {
  assert.equal(maskKey(ALICE_KEY), "sk-or-v1-a…1111");
  assert.equal(keyEncryptionActive(), true); // USER_LLM_KEY_SECRET is set

  await runInWorkspace("alice", () => setUserOpenRouterKey("alice", ALICE_KEY, { label: "alice" }));
  const raw = JSON.parse(
    fs.readFileSync(
      path.join(process.env.SKILLS_STATE_DIR as string, "users", "alice", "llm.json"),
      "utf8",
    ),
  ) as { openrouter: { key_enc?: string; key_plain?: string; masked: string } };
  assert.ok(raw.openrouter.key_enc, "key stored encrypted");
  assert.equal(raw.openrouter.key_plain, undefined);
  assert.equal(raw.openrouter.masked, "sk-or-v1-a…1111");
  assert.equal(await runInWorkspace("alice", () => getUserOpenRouterKey("alice")), ALICE_KEY);

  // plaintext fallback when no master secret is configured
  delete process.env.USER_LLM_KEY_SECRET;
  await runInWorkspace("bob", () => setUserOpenRouterKey("bob", USER_SECRET_UNUSED, {}));
  const rawBob = JSON.parse(
    fs.readFileSync(
      path.join(process.env.SKILLS_STATE_DIR as string, "users", "bob", "llm.json"),
      "utf8",
    ),
  ) as { openrouter: { key_enc?: string; key_plain?: string } };
  assert.equal(rawBob.openrouter.key_enc, undefined);
  assert.equal(rawBob.openrouter.key_plain, USER_SECRET_UNUSED);
  assert.equal(await runInWorkspace("bob", () => getUserOpenRouterKey("bob")), USER_SECRET_UNUSED);
  process.env.USER_LLM_KEY_SECRET = "test-master-secret";
});

test("llm keys: policy resolution (prefer_user / require_user / server_only)", async () => {
  // test 1 stored a bob key for the plaintext-fallback case — this test needs
  // bob keyless (he falls back to the server key).
  await runInWorkspace("bob", () => clearUserOpenRouterKey("bob"));
  await runInWorkspace("alice", () => setUserOpenRouterKey("alice", ALICE_KEY, {}));

  // prefer_user: alice bills her key, bob falls back to the server key
  process.env.LLM_KEY_POLICY = "prefer_user";
  const alice = await runInWorkspace("alice", () => resolveAuthorizationKey());
  assert.equal(alice.key, ALICE_KEY);
  assert.equal(alice.source, "user");
  const bob = await runInWorkspace("bob", () => resolveAuthorizationKey());
  assert.equal(bob.key, SERVER_KEY);
  assert.equal(bob.source, "server");

  // require_user with a future deadline: warn window, server key still backs
  process.env.LLM_KEY_POLICY = "require_user";
  process.env.LLM_KEY_REQUIRE_USER_AFTER = new Date(Date.now() + 86_400_000).toISOString();
  const warn = await runInWorkspace("bob", () => resolveAuthorizationKey());
  assert.equal(warn.key, SERVER_KEY);

  // enforced (deadline passed): no user key → actionable error
  process.env.LLM_KEY_REQUIRE_USER_AFTER = new Date(Date.now() - 1000).toISOString();
  const enforced = await runInWorkspace("bob", () => resolveAuthorizationKey());
  assert.equal(enforced.key, null);
  assert.match(String(enforced.error), /add yours in Settings/);
  // alice is unaffected — she has a key
  const aliceEnforced = await runInWorkspace("alice", () => resolveAuthorizationKey());
  assert.equal(aliceEnforced.key, ALICE_KEY);

  // server_only: user keys are ignored entirely
  process.env.LLM_KEY_POLICY = "server_only";
  const solo = await runInWorkspace("alice", () => resolveAuthorizationKey());
  assert.equal(solo.key, SERVER_KEY);
  assert.equal(solo.source, "server");

  process.env.LLM_KEY_POLICY = "prefer_user";
  delete process.env.LLM_KEY_REQUIRE_USER_AFTER;
});

test("chat: authorization header uses the caller's key; usage is recorded", async () => {
  await runInWorkspace("alice", () => setUserOpenRouterKey("alice", ALICE_KEY, {}));
  const headers: string[] = [];
  const recorded: Array<{ userId: string; model: string; cost_usd: number | null }> = [];
  setLlmUsageRecorder((e) => recorded.push({ userId: e.userId, model: e.model, cost_usd: e.cost_usd }));
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    headers.push(String(new Headers(init?.headers).get("Authorization")));
    return chatResponse();
  }) as typeof fetch;

  try {
    await runInWorkspace("alice", () => chat([{ role: "user", content: "hi" }], undefined, { minIntervalMs: 0 }));
    await runInWorkspace("bob", () => chat([{ role: "user", content: "hi" }], undefined, { minIntervalMs: 0 }));
  } finally {
    globalThis.fetch = realFetch;
  }

  assert.deepEqual(headers, [`Bearer ${ALICE_KEY}`, `Bearer ${SERVER_KEY}`]);
  assert.equal(recorded.length, 2);
  assert.equal(recorded[0].userId, "alice");
  assert.equal(recorded[0].cost_usd, 0.02);
  assert.equal(recorded[1].userId, "bob");
});

test("llm usage summary: per-day aggregation over the window", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llmusage-test-"));
  const store = new SQLiteSessionStore(path.join(dir, "sessions.db"));
  const day0 = Date.now() - 40 * 86_400_000; // outside a 30-day window
  for (const [ts, p, c] of [
    [Date.now(), 100, 10],
    [Date.now() - 86_400_000, 200, 20],
    [day0, 999, 999],
  ] as Array<[number, number, number]>) {
    store.recordLlmUsage({ user_id: "alice", model: "m", prompt_tokens: p, completion_tokens: c, cost_usd: 0.5, source: "user", created_at: ts });
  }
  const s30 = store.llmUsageSummary("alice", Date.now() - 30 * 86_400_000);
  assert.equal(s30.totals.calls, 2);
  assert.equal(s30.totals.prompt_tokens, 300);
  assert.equal(s30.totals.completion_tokens, 30);
  assert.equal(s30.totals.cost_usd, 1);
  const sAll = store.llmUsageSummary("alice", day0 - 1000);
  assert.equal(sAll.totals.calls, 3);
  assert.equal(store.llmUsageSummary("bob", Date.now() - 30 * 86_400_000).totals.calls, 0);
});

test("llm keys: clear falls back to the server key mid-session", async () => {
  await runInWorkspace("carol", () => setUserOpenRouterKey("carol", "sk-or-v1-carol", {}));
  const withKey = await runInWorkspace("carol", () => resolveAuthorizationKey());
  assert.equal(withKey.source, "user");
  await runInWorkspace("carol", () => clearUserOpenRouterKey("carol"));
  const afterClear = await runInWorkspace("carol", () => resolveAuthorizationKey());
  assert.equal(afterClear.source, "server"); // prefer_user fallback, documented
  assert.equal(afterClear.key, SERVER_KEY);
});
