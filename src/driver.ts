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
  listSessions(): SessionRow[];
  /** Recall hits for a free-text query (may be []). */
  search(query: string, limit?: number): SessionHit[];
  close(): void;
}
