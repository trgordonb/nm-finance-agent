// Chat SSE reliability (docs/todo-chat-sse-reliability.md): keepalive comment
// blocks must not corrupt event parsing, a transport error after the terminal
// `done` must not surface as a failed turn, and an error before `done` must.

import { test } from "node:test";
import assert from "node:assert/strict";

const { consumeSseStream, parseSseBlock } = await import("../../frontend/src/sse.js");

function sseResponseStream(chunks: string[], errorAfter?: Error) {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      if (errorAfter) controller.error(errorAfter);
      else controller.close();
    },
  });
}

/** Chunk-per-pull stream whose terminal condition (error or close) fires only
 *  after a delay, so the consumer has actually read the preceding chunks —
 *  controller.error() would otherwise discard the whole queue at once. */
function delayedTerminalStream(
  chunks: string[],
  terminal: { kind: "error"; error: Error; afterMs: number } | { kind: "close" },
) {
  const encoder = new TextEncoder();
  let i = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(encoder.encode(chunks[i++]));
      } else if (terminal.kind === "error") {
        await new Promise((r) => setTimeout(r, terminal.afterMs));
        controller.error(terminal.error);
      } else {
        controller.close();
      }
    },
  });
}

test("sse parser: keepalive comments and empty blocks parse to null", () => {
  assert.equal(parseSseBlock(": ping"), null);
  assert.equal(parseSseBlock(""), null);
  const block = parseSseBlock("event: done\ndata: {\"messages\": 3}");
  assert.deepEqual(block, { event: "done", data: ['{"messages": 3}'] });
  assert.deepEqual(parseSseBlock("data: first\ndata: second"), {
    event: "message",
    data: ["first", "second"],
  });
});

test("sse reader: keepalives between events do not corrupt parsing", async () => {
  const events: Array<[string, Record<string, unknown>]> = [];
  const stream = sseResponseStream([
    ": ping\n\n",
    "event: session\ndata: {\"session_id\": \"s1\"}\n\n",
    ": ping\n: ping\n\n",
    "event: message\ndata: {\"role\": \"assistant\", \"content\": \"hi\"}\n\n",
    "event: done\ndata: {\"messages\": 3}\n\n",
  ]);
  await consumeSseStream(stream, (event, data) => events.push([event, data]));
  assert.deepEqual(
    events.map(([e]) => e),
    ["session", "message", "done"],
  );
  assert.deepEqual(events[0][1], { session_id: "s1" });
});

test("sse reader: transport error after done is swallowed (turn completed)", async () => {
  const events: Array<[string, Record<string, unknown>]> = [];
  const stream = delayedTerminalStream(
    ["event: session\ndata: {}\n\n", "event: done\ndata: {\"messages\": 3}\n\n"],
    { kind: "error", error: new Error("Error in input stream"), afterMs: 25 },
  );
  await assert.doesNotReject(consumeSseStream(stream, (event, data) => events.push([event, data])));
  assert.deepEqual(
    events.map(([e]) => e),
    ["session", "done"],
  );
});

test("sse reader: transport error before done propagates (turn incomplete)", async () => {
  const stream = delayedTerminalStream(["event: session\ndata: {}\n\n"], {
    kind: "error",
    error: new Error("cut"),
    afterMs: 25,
  });
  await assert.rejects(consumeSseStream(stream, () => undefined), /cut/);
});

test("sse reader: partial block across chunk boundary is buffered until complete", async () => {
  const events: Array<[string, Record<string, unknown>]> = [];
  const stream = sseResponseStream([
    "event: mess",
    "age\ndata: {\"content\": \"split",
    "\"}\n\nevent: done\ndata: {}\n\n",
  ]);
  await consumeSseStream(stream, (event, data) => events.push([event, data]));
  assert.deepEqual(events[0], ["message", { content: "split" }]);
  assert.equal(events[1][0], "done");
});
