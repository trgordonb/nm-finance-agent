// chat() response-shape failures: an OpenRouter 200 with no choices is a
// provider glitch, not a fatal turn-ender on the first attempt. Retry once,
// then surface the model and response shape instead of "Response has no message".

import { test } from "node:test";
import assert from "node:assert/strict";

process.env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY ?? "server-key-test";
process.env.LANGSMITH_TRACING = "0";

const { chat } = await import("../llm.js");

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const valid = {
  model: "test/model",
  choices: [{ message: { content: "ok", role: "assistant" }, finish_reason: "stop" }],
};

test("chat: retries one empty-choices response, then succeeds", async () => {
  const calls: number[] = [];
  let n = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    n++;
    calls.push(n);
    return n === 1 ? json({ choices: [] }) : json(valid);
  }) as typeof fetch;
  try {
    const res = await chat([{ role: "user", content: "hi" }], undefined, {
      model: "test/model",
      minIntervalMs: 0,
      maxAttempts: 3,
    });
    assert.equal(res.content, "ok");
    assert.equal(calls.length, 2);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("chat: a persistent empty response names the model and choice count", async () => {
  let calls = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    calls++;
    return json({ choices: [] });
  }) as typeof fetch;
  try {
    await assert.rejects(
      () =>
        chat([{ role: "user", content: "hi" }], undefined, {
          model: "test/model",
          minIntervalMs: 0,
          maxAttempts: 3,
        }),
      (err: Error) => {
        assert.match(err.message, /OpenRouter returned no message/);
        assert.match(err.message, /model=test\/model/);
        assert.match(err.message, /choices=0/);
        return true;
      },
    );
    assert.equal(calls, 2, "one empty response is retried, the second is surfaced");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("chat: a 200 error payload is surfaced and not treated as a message", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    json({ error: { code: 502, message: "upstream provider failed" } })) as typeof fetch;
  try {
    await assert.rejects(
      () =>
        chat([{ role: "user", content: "hi" }], undefined, {
          model: "test/model",
          minIntervalMs: 0,
          maxAttempts: 2,
        }),
      /OpenRouter error 502: upstream provider failed/,
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});
