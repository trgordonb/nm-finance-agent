// SSE wire parsing shared by the chat stream reader (api.ts) and the backend
// tests. One block = lines up to a blank separator; `event:` sets the type,
// `data:` accumulates the payload. Comment lines (`: ping` keepalives) carry
// no data and parse to null, so they are transparent to consumers.

export type SseHandler = (event: string, data: Record<string, unknown>) => void;

export interface SseBlock {
  event: string;
  data: string[];
}

export function parseSseBlock(block: string): SseBlock | null {
  let event = "message";
  const data: string[] = [];
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
  }
  return data.length === 0 ? null : { event, data };
}

/**
 * Drain an SSE body. A transport error after the terminal `done` event is
 * swallowed (idle proxy cut, backgrounded tab — the turn completed
 * server-side); any earlier error propagates to the caller.
 */
export async function consumeSseStream(
  body: ReadableStream<Uint8Array>,
  onEvent: SseHandler,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let sawDone = false;

  while (true) {
    let chunk: Uint8Array;
    try {
      const read = await reader.read();
      if (read.done) break;
      chunk = read.value;
    } catch (e) {
      if (sawDone) return;
      throw e;
    }
    buffer += decoder.decode(chunk, { stream: true });

    let sep: number;
    while ((sep = buffer.indexOf("\n\n")) !== -1) {
      const block = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const parsed = parseSseBlock(block);
      if (!parsed) continue; // keepalive comment or empty block
      if (parsed.event === "done") sawDone = true;
      try {
        onEvent(parsed.event, JSON.parse(parsed.data.join("\n")));
      } catch {
        onEvent("error", { error: "unparseable SSE event" });
      }
    }
  }
}
