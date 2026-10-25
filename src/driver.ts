// SessionDriver: the storage seam the harness talks to. The SQLite archive
// (store.ts) is the default/authoritative driver; agentdb-mirror.ts embeds the
// same turns into a ruvector VectorDB as a semantic recall sidecar (dual-write,
// archive-first). The future AgenticDB full-cutover would land here.

import type { ChatMessage } from "./types.js";

export interface SessionRow {
  session_id: string;
  created_at: string;
  turn_count: number;
  message_count: number;
  /** One-line session title (LLM-refined fallback truncated first user
   *  message); null until the first turn's titler pass. */
  summary?: string | null;
  /** Deep-research run status when the session has one (research_runs join);
   *  null for ordinary chat sessions. */
  research_status?: string | null;
  /** Owning agent-cron job name when the session belongs to a scheduled job
   *  (cron_jobs join); null for ordinary sessions. */
  cron_name?: string | null;
}

/** One ranked recall hit — retriever-tagged for the hybrid fusion step. */
export interface SessionHit {
  session_id: string;
  created_at: string;
  /** Display snippet (truncated excerpt of the matched message). */
  snippet: string;
  retriever: "fts" | "semantic";
  /** Rank position within its own retriever's list (0-based, for RRF). */
  rank: number;
}

export interface SessionDriver {
  /** Human label for logging/health ("sqlite", …). */
  readonly name: string;
  newSessionId(): string;
  /** Persist one completed agent turn; returns the turn number (1-based). */
  appendTurn(sessionId: string, messages: ChatMessage[]): number;
  loadSession(sessionId: string): ChatMessage[];
  /** True when the current login owns the session id. */
  ownsSession(sessionId: string): boolean;
  listSessions(): SessionRow[];
  /** Recall hits for a free-text query (may be []). */
  search(query: string, limit?: number): SessionHit[];
  close(): void;
}
