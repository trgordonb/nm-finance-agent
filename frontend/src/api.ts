// API client for the Express backend (src/index.ts). Trimmed to step-1 scope:
// health, sessions, chat streaming, turn cancel. Everything identical to the
// langgraph-demo client except session/health field names and no followups.

import type {
  ApiMessage,
  CronJobInfo,
  CronRunInfo,
  LlmUsageSummary,
  UserLlmKeyStatus,
  Followups,
  Health,
  McpListResponse,
  SessionInfo,
  SkillInfo,
  WikiDomain,
  WikiGist,
  WikiSearchHit,
} from "./types";
import { consumeSseStream, type SseHandler } from "./sse";

export type { SseHandler };

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

/** Agent cron: list jobs (with live running flag), run one now, patch or
 *  delete. See docs/agent-cron-plan.md — the UI reads the same routes the
 *  agent's cron_manage tool writes. */
export const getCronJobs = () =>
  fetchJSON<{ jobs: CronJobInfo[]; server_timezone: string }>("/api/cron/jobs");

export const getCronJobRuns = (id: string) =>
  fetchJSON<{ runs: CronRunInfo[] }>(`/api/cron/jobs/${encodeURIComponent(id)}/runs?limit=10`);

export const createCronJob = (body: {
  name: string;
  schedule_kind: string;
  schedule_expr: string;
  payload: string;
  timezone?: string | null;
}) =>
  fetchJSON<{ job: CronJobInfo; next_runs: number[] }>("/api/cron/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

export const patchCronJob = (
  id: string,
  body: {
    action?: "pause" | "resume";
    payload?: string;
    schedule_kind?: string;
    schedule_expr?: string;
    timezone?: string | null;
  },
) =>
  fetchJSON<{ job: CronJobInfo }>(`/api/cron/jobs/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

export const runCronJobNow = (id: string) =>
  fetchJSON<{ run_id: string }>(`/api/cron/jobs/${encodeURIComponent(id)}/run`, { method: "POST" });

export const deleteCronJob = (id: string) =>
  apiFetch(`/api/cron/jobs/${encodeURIComponent(id)}`, { method: "DELETE" });

/** User-scoped OpenRouter key (docs/user-scoped-openrouter-keys-plan.md). */
export const getUserLlmKeyStatus = () => fetchJSON<UserLlmKeyStatus>("/api/user/llm-key");

export const saveUserLlmKey = (key: string) =>
  fetchJSON<{ ok: boolean; masked: string; label: string | null; usage_usd: number | null; limit: number | null; is_free_tier: boolean | null }>(
    "/api/user/llm-key",
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key }) },
  );

export const deleteUserLlmKey = () =>
  apiFetch("/api/user/llm-key", { method: "DELETE" }).then(() => undefined);

export const getLlmUsage = (days = 30) =>
  fetchJSON<LlmUsageSummary>(`/api/user/llm-usage?days=${days}`);

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

/**
 * POST /api/chat and consume the SSE stream. EventSource cannot issue POST,
 * so the stream is parsed manually from the fetch body; the wire parsing and
 * the post-`done` error tolerance live in ./sse (shared with backend tests).
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
  await consumeSseStream(res.body, onEvent);
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
