// Agent-loop empty-response guard: a provider can return HTTP 200 with an
// empty assistant message (GLM reasoning-only output). The loop must retry
// once, then fail loudly instead of silently ending the turn.

import { test } from "node:test";
import assert from "node:assert/strict";

process.env.LANGSMITH_TRACING = "0";
process.env.SKILLS_DIR = process.env.SKILLS_DIR ?? new URL("../../skills", import.meta.url).pathname;

const { AgentLoop } = await import("../agent.js");

function textResponse(content: string, usage = { prompt_tokens: 10, completion_tokens: 2 }) {
  return { content, toolCalls: [], usage, model: "stub", raw: {}, provider: "Stub", finishReason: "stop" };
}

function emptyResponse(usage = { prompt_tokens: 10, completion_tokens: 2 }) {
  return { content: "", toolCalls: [], usage, model: "stub", raw: {}, provider: "Stub", finishReason: "stop" };
}

function makeLoop(chatFn: any) {
  const memory = { load: () => "", totalChars: () => 0 } as any;
  return new AgentLoop({ memory, store: {} as any, tools: [], chatFn });
}

function tool(name: string) {
  return {
    name,
    description: "",
    parameters: { type: "object" as const, properties: {} },
    execute: () => "ok",
  };
}

test("agent loop: per-user tool policy filters the wire list", async () => {
  const seen: string[][] = [];
  const chatFn: any = async (_messages: any[], tools: any[]) => {
    seen.push((tools ?? []).map((t: any) => t.name));
    return textResponse("ok");
  };
  const loop = new AgentLoop({
    memory: { load: () => "", totalChars: () => 0 } as any,
    store: {} as any,
    tools: [tool("a"), tool("b")],
    chatFn,
  });
  loop.setToolPolicy((name) => name !== "b");
  const result = await loop.runTurn([], "hi");
  assert.equal(result.fatal, undefined);
  assert.deepEqual(seen[0], ["a"]);
  assert.equal(loop.isToolEnabled("b"), false);
});

test("agent loop: a disabled tool is rejected if the model emits it anyway", async () => {
  let calls = 0;
  const chatFn: any = async () => {
    calls++;
    if (calls === 1) {
      return {
        ...textResponse(""),
        toolCalls: [{ id: "call-1", name: "b", args: {} }],
      };
    }
    return textResponse("done");
  };
  const loop = new AgentLoop({
    memory: { load: () => "", totalChars: () => 0 } as any,
    store: {} as any,
    tools: [tool("a"), tool("b")],
    chatFn,
  });
  loop.setToolPolicy((name) => name !== "b");
  const result = await loop.runTurn([], "hi");
  const toolMsg = result.messages.find((m) => m.role === "tool");
  assert.match(String(toolMsg?.content), /Rejected: tool b is disabled for this user/);
});

test("agent loop: empty assistant response retries once at low effort", async () => {
  const calls: Array<{ opts: any; messages: any[] }> = [];
  const chatFn = async (messages: any[], _tools: any, opts: any) => {
    calls.push({ opts, messages });
    return calls.length === 1 ? emptyResponse() : textResponse("hello");
  };
  const loop = makeLoop(chatFn);

  const result = await loop.runTurn([], "hi");

  assert.equal(result.fatal, undefined);
  assert.equal(result.iterations, 1);
  assert.equal(result.messages.at(-1)?.content, "hello");
  assert.equal(calls.length, 2);
  assert.equal(calls[1].opts.reasoningEffort, "low");
  // The retry carries the nudge, but it is not persisted in the new slice.
  assert.match(String(calls[1].messages.at(-1)?.content), /previous response was empty/);
  assert.equal(result.messages.length, 1);
});

test("agent loop: two empty responses fail loudly, no empty assistant row", async () => {
  const loop = makeLoop(async () => emptyResponse());

  const result = await loop.runTurn([], "hi");

  assert.match(String(result.fatal), /empty response twice/);
  assert.equal(result.messages.length, 0);
});

test("agent loop: cancel aborts an in-flight LLM call as cancelled", async () => {
  const ctrl = new AbortController();
  const chatFn = async (_messages: any[], _tools: any, opts: any) => {
    await new Promise((_resolve, reject) => {
      const onAbort = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      if (opts?.signal?.aborted) onAbort();
      else opts?.signal?.addEventListener("abort", onAbort, { once: true });
    });
    return textResponse("never");
  };
  const loop = makeLoop(chatFn);
  setTimeout(() => ctrl.abort(), 20);

  const result = await loop.runTurn([], "hi", undefined, { signal: ctrl.signal });

  assert.equal(result.cancelled, true);
  assert.equal(result.fatal, undefined);
  assert.equal(result.messages.length, 0);
});
