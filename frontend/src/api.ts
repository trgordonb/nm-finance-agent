// API client for the Express backend (src/index.ts). Trimmed to step-1 scope:
// health, sessions, chat streaming, turn cancel. Everything identical to the
// langgraph-demo client except session/health field names and no followups.

import type {
  ApiMessage,
  Followups,
  Health,
  McpListResponse,
  SessionInfo,
  SkillInfo,
  WikiDomain,
  WikiGist,
  WikiSearchHit,
} from "./types";

/** A 401 from a protected API means the server session is gone. The app shell
 *  registers a handler that drops back to the login screen. */
export class UnauthorizedError extends Error {
  constructor() {
    super("not_authenticated");
    this.name = "UnauthorizedError";
  }
}

let unauthorizedHandler: (() => void) | null = null;

export function setUnauthorizedHandler(handler: (() => void) | null): void {
  unauthorizedHandler = handler;
}

async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(path, init);
  if (res.status === 401) {
    unauthorizedHandler?.();
    throw new UnauthorizedError();
  }
  return res;
}

async function fetchJSON<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await apiFetch(path, init);
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

/** Deep-research run state for a session (404s when it has no run — callers
 *  catch and treat as null). Used for reload/reconnect recovery. */
export interface ResearchRunStatus {
  session_id: string;
  status: string;
  step: string | null;
  question: string;
  clarification: string | null;
  report: string | null;
  error: string | null;
  started_at: string;
  finished_at: string | null;
}

export const getResearchRun = (sessionId: string) =>
  fetchJSON<ResearchRunStatus>(`/api/research/${encodeURIComponent(sessionId)}`);

/** Admin view: every skill in the registry, including disabled ones. */
export const getSkills = () => fetchJSON<SkillInfo[]>("/api/skills");

/** Hermes-style toggle. Our skills index re-renders per turn, so this
 *  applies to the NEXT tool call rather than only the next session. */
export async function setSkillEnabled(skill: string, enabled: boolean): Promise<void> {
  await fetchJSON<{ status: string }>(
    `/api/skills/${encodeURIComponent(skill)}/enabled`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
    },
  );
}

/** MCP servers (mcp_servers.json): list, toggle, reload the assembled runtime. */
export const getMcpServers = () => fetchJSON<McpListResponse>("/api/mcp");

export async function setMcpServerEnabled(name: string, enabled: boolean): Promise<void> {
  await fetchJSON<{ status: string }>(
    `/api/mcp/${encodeURIComponent(name)}/enabled`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
    },
  );
}

export const reloadMcp = () =>
  fetchJSON<{ status: string; mcp_tools: number }>("/api/mcp/reload", { method: "POST" });

/** Extracted "next steps" tips shown as a to-do strip above the composer. */
export const getFollowups = (sessionId: string) =>
  fetchJSON<Followups>(`/api/sessions/${encodeURIComponent(sessionId)}/followups`);

/** Unseen follow-up counts per session id — sidebar badges. Fetching a
 *  session's followups marks it seen, which drops it from here. */
export const getFollowupCounts = () =>
  fetchJSON<{ counts: Record<string, number> }>("/api/followups/counts");

export async function dismissFollowup(sessionId: string, index: number): Promise<void> {
  await fetchJSON<{ dismissed: number[] }>(
    `/api/sessions/${encodeURIComponent(sessionId)}/followups/dismiss`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ index }),
    },
  );
}

export async function cancelTurn(turnId: string): Promise<void> {
  await apiFetch("/api/chat/cancel", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ turn_id: turnId }),
  });
}

export interface WikiUpload {
  /** Workspace-relative path the agent's llm-wiki upload consumes. */
  path: string;
  filename: string;
  bytes: number;
}

/** Save one PDF into the agent workspace for wiki ingestion (raw request body —
 *  the backend has no multipart parser; the name rides the query string). */
export async function uploadWikiPdf(file: File): Promise<WikiUpload> {
  const res = await apiFetch(`/api/uploads/wiki?name=${encodeURIComponent(file.name)}`, {
    method: "POST",
    headers: { "Content-Type": "application/pdf" },
    body: file,
  });
  if (!res.ok) {
    let detail = `${res.status}`;
    try {
      const body = (await res.json()) as { detail?: string };
      detail = body.detail ?? detail;
    } catch {
      /* non-JSON error body */
    }
    throw new Error(detail);
  }
  return (await res.json()) as WikiUpload;
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
  const res = await apiFetch("/api/chat", {
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

/* --- Wiki tab (read-only llmwiki passthrough via /api/wiki/*) --------------- */

export const getWikiDomains = () => fetchJSON<WikiDomain[]>("/api/wiki/domains");

export const getWikiConcepts = (domain: string) =>
  fetchJSON<WikiGist[]>(`/api/wiki/concepts?domain=${encodeURIComponent(domain)}`);

/** One compiled page as raw markdown (the proxy forwards text/plain, not JSON). */
export async function getWikiPage(slug: string, domain: string): Promise<string> {
  const path = `/api/wiki/page/${encodeURIComponent(slug)}?domain=${encodeURIComponent(domain)}`;
  const res = await apiFetch(path);
  if (!res.ok) {
    let detail = `${res.status}`;
    try {
      const body = (await res.json()) as { detail?: string };
      detail = body.detail ?? detail;
    } catch {
      /* non-JSON error body */
    }
    throw new Error(`GET page ${slug} failed: ${detail}`);
  }
  return res.text();
}

/** Hybrid wiki-first search; no domain = every registered domain (the
 *  service's QUERY_DOMAIN_POLICY=all), each hit carries its own `domain`. */
export const searchWiki = (q: string, domain: string | null, k = 8) => {
  const params = new URLSearchParams({ q, k: String(k) });
  if (domain) params.set("domain", domain);
  return fetchJSON<WikiSearchHit[]>(`/api/wiki/search?${params.toString()}`);
};
