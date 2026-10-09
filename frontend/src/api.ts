// API client for the Express backend (src/index.ts). Trimmed to step-1 scope:
// health, sessions, chat streaming, turn cancel. Everything identical to the
// langgraph-demo client except session/health field names and no followups.

import type { ApiMessage, Health, SessionInfo } from "./types";

async function fetchJSON<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  if (!res.ok) {
    let detail = `${res.status}`;
    try {
      const body = await res.json();
      detail = body.detail ?? body.error ?? detail;
    } catch {
      /* non-JSON error body */
    }
    throw new Error(`${init?.method ?? "GET"} ${path} failed: ${detail}`);
  }
  return (await res.json()) as T;
}

export const getHealth = () => fetchJSON<Health>("/api/health");
export const getSessions = () => fetchJSON<SessionInfo[]>("/api/sessions");
export const getSessionMessages = (sessionId: string) =>
  fetchJSON<{ session_id: string; messages: ApiMessage[] }>(
    `/api/sessions/${encodeURIComponent(sessionId)}`,
  );

export async function cancelTurn(turnId: string): Promise<void> {
  await fetch("/api/chat/cancel", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ turn_id: turnId }),
  });
}

export type SseHandler = (event: string, data: Record<string, unknown>) => void;

/**
 * POST /api/chat and consume the SSE stream. EventSource cannot issue POST,
 * so the stream is parsed manually from the fetch body: blocks separated by
 * blank lines, each an `event:` line plus one or more `data:` lines.
 */
export async function streamChat(
  message: string,
  sessionId: string | null,
  signal: AbortSignal,
  onEvent: SseHandler,
): Promise<void> {
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, session_id: sessionId }),
    signal,
  });
  if (!res.ok || !res.body) {
    throw new Error(`chat failed: HTTP ${res.status}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let sep: number;
    while ((sep = buffer.indexOf("\n\n")) !== -1) {
      const block = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      let event = "message";
      const data: string[] = [];
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
      }
      if (data.length === 0) continue;
      try {
        onEvent(event, JSON.parse(data.join("\n")));
      } catch {
        onEvent("error", { error: "unparseable SSE event" });
      }
    }
  }
}
