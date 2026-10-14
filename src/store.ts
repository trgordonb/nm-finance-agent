// SessionStore: episodic archive in plain SQLite (node:sqlite, WAL).
// Turn-structured like nm_memory_layer.store: one row per completed agent turn,
// full assistant tool_calls + tool_call_id persisted so loadSession() rebuilds
// provider-valid histories (dangling ToolMessage would break providers).
//
// Derived from the langgraph-demo harness conventions:
//   - CWD-relative db path (the archive belongs to the consuming agent's cwd)
//   - FTS5 over vectors (exact/keyword recall now; semantic comes later)

import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import { DB_PATH } from "./config.js";
import type { ChatMessage } from "./types.js";
import type { SessionDriver, SessionHit, SessionRow } from "./driver.js";

export type { SessionRow } from "./driver.js";

/** One deep-research run row (`/research` mode). Keyed by session_id — the
 *  session's latest run; the archive keeps the actual conversation. */
export interface ResearchRunRow {
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

export class SQLiteSessionStore implements SessionDriver {
  readonly name = "sqlite";
  readonly dbPath: string;
  private db: DatabaseSync;

  constructor(dbPath: string = DB_PATH) {
    this.dbPath = dbPath;
    this.db = new DatabaseSync(this.dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.migrate();
  }

  private migrate(): void {
    // pre-existing archives got schema v1 without the usage column
    const cols = (this.db.prepare(`PRAGMA table_info(turns)`).all() as Array<{ name: string }>).map((c) => c.name);
    if (fs.existsSync(this.dbPath) && cols.length && !cols.includes("usage")) {
      this.db.exec("ALTER TABLE turns ADD COLUMN usage TEXT");
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS turns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        turn_number INTEGER NOT NULL,
        message_index INTEGER NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        tool_calls TEXT,
        tool_call_id TEXT,
        tool_name TEXT,
        usage TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE INDEX IF NOT EXISTS idx_turns_session ON turns(session_id, turn_number, message_index);
      CREATE VIRTUAL TABLE IF NOT EXISTS turns_fts USING fts5(
        content, content='turns', content_rowid='id'
      );
      CREATE TRIGGER IF NOT EXISTS turns_fts_insert AFTER INSERT ON turns BEGIN
        INSERT INTO turns_fts(rowid, content) VALUES (new.id, new.content);
      END;
      CREATE TRIGGER IF NOT EXISTS turns_fts_delete AFTER DELETE ON turns BEGIN
        INSERT INTO turns_fts(turns_fts, rowid, content) VALUES ('delete', old.id, old.content);
      END;

      CREATE TABLE IF NOT EXISTS compressions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        summary TEXT NOT NULL,
        first_turn INTEGER NOT NULL,
        last_turn INTEGER NOT NULL,
        original_count INTEGER NOT NULL,
        model TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE INDEX IF NOT EXISTS idx_compressions_session ON compressions(session_id);
      CREATE TABLE IF NOT EXISTS session_titles (
        session_id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        model TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );

      CREATE TABLE IF NOT EXISTS research_runs (
        session_id    TEXT PRIMARY KEY,
        status        TEXT NOT NULL,
        step          TEXT,
        question      TEXT NOT NULL,
        clarification TEXT,
        report        TEXT,
        error         TEXT,
        started_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        finished_at   TEXT
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  newSessionId(): string {
    return crypto.randomUUID();
  }

  appendTurn(sessionId: string, messages: ChatMessage[]): number {
    const insert = this.db.prepare(
      `INSERT INTO turns (session_id, turn_number, message_index, role, content, tool_calls, tool_call_id, tool_name, usage)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const turnNumberRow = this.db
        .prepare(`SELECT COALESCE(MAX(turn_number), 0) + 1 AS n FROM turns WHERE session_id = ?`)
        .get(sessionId) as { n: number };
      const turnNumber = turnNumberRow.n;
      messages.forEach((m, i) => {
        insert.run(
          sessionId,
          turnNumber,
          i,
          m.role,
          m.content,
          m.tool_calls ? JSON.stringify(m.tool_calls) : null,
          m.tool_call_id ?? null,
          m.name ?? null,
          m.usage ? JSON.stringify(m.usage) : null,
        );
      });
      this.db.exec("COMMIT");
      return turnNumber;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  loadSession(sessionId: string): ChatMessage[] {
    const rows = this.db
      .prepare(`SELECT role, content, tool_calls, tool_call_id, tool_name, usage FROM turns WHERE session_id = ? ORDER BY id`)
      .all(sessionId) as Array<{
      role: string;
      content: string;
      tool_calls: string | null;
      tool_call_id: string | null;
      tool_name: string | null;
      usage: string | null;
    }>;
    return rows.map((r) => {
      const msg: ChatMessage = {
        role: r.role as ChatMessage["role"],
        content: r.content,
      };
      if (r.tool_calls) {
        try {
          const calls = JSON.parse(r.tool_calls) as ToolCallLike[];
          if (Array.isArray(calls) && calls.length) msg.tool_calls = calls;
        } catch {
          /* tolerate corrupt json, drop the field */
        }
      }
      if (r.role === "tool") {
        msg.tool_call_id = r.tool_call_id ?? "unknown";
        msg.name = r.tool_name ?? undefined;
      }
      if (r.role === "assistant" && r.usage && r.usage !== "null") {
        try {
          msg.usage = JSON.parse(r.usage) as ChatMessage["usage"];
        } catch {
          /* tolerate corrupt usage, drop it */
        }
      }
      return msg;
    });
  }

  listSessions(): SessionRow[] {
    return this.db
      .prepare(
        `SELECT t.session_id,
                MIN(t.created_at) AS created_at,
                COUNT(DISTINCT t.turn_number) AS turn_count,
                COUNT(*) AS message_count,
                st.title AS summary,
                rr.status AS research_status
         FROM turns t
         LEFT JOIN session_titles st ON st.session_id = t.session_id
         LEFT JOIN research_runs rr ON rr.session_id = t.session_id
         GROUP BY t.session_id ORDER BY created_at DESC`,
      )
      .all() as unknown as SessionRow[];
  }

  recordCompression(
    sessionId: string,
    meta: { summary: string; firstTurn: number; lastTurn: number; originalCount: number; model: string },
  ): void {
    this.db
      .prepare(
        `INSERT INTO compressions (session_id, summary, first_turn, last_turn, original_count, model)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(sessionId, meta.summary, meta.firstTurn, meta.lastTurn, meta.originalCount, meta.model);
  }

  listCompressions(sessionId: string): Array<{
    id: number;
    first_turn: number;
    last_turn: number;
    summary: string;
    model: string;
    created_at: string;
  }> {
    return this.db
      .prepare(
        `SELECT id, first_turn, last_turn, summary, model, created_at
         FROM compressions WHERE session_id = ? ORDER BY id`,
      )
      .all(sessionId) as never;
  }

  /** Title persistence: sync fallback rows and refined titles share the table. */
  setSessionTitle(sessionId: string, title: string, model: string): void {
    this.db
      .prepare(
        `INSERT INTO session_titles (session_id, title, model)
         VALUES (?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET title = excluded.title, model = excluded.model`,
      )
      .run(sessionId, title, model);
  }

  getSessionTitle(sessionId: string): string | null {
    const row = this.db
      .prepare(`SELECT title FROM session_titles WHERE session_id = ?`)
      .get(sessionId) as { title: string } | undefined;
    return row?.title ?? null;
  }

  /** The model label that produced the current title (for provenance/debug). */
  getSessionTitleModel(sessionId: string): string | null {
    const row = this.db
      .prepare(`SELECT model FROM session_titles WHERE session_id = ?`)
      .get(sessionId) as { model: string } | undefined;
    return row?.model ?? null;
  }

  search(query: string, limit: number = 5): SessionHit[] {
    const tokens = query.split(/\s+/).filter(Boolean).map(sanitizeFts);
    if (!tokens.length) return [];
    const phrase = tokens.map((t) => `"${t}"`).join(" AND ");
    const joined = tokens.join(" OR ");
    let hits = queryFts(this.db, phrase, limit);
    if (!hits.length) hits = queryFts(this.db, joined, limit);
    if (!hits.length) hits = queryLike(this.db, query, limit);
    return hits;
  }

  deleteSession(sessionId: string): void {
    this.db.prepare(`DELETE FROM turns WHERE session_id = ?`).run(sessionId);
  }

  // --- deep research runs (/research) ----------------------------------------

  /** Start (or restart) a session's research run row. */
  startResearchRun(sessionId: string, question: string): void {
    this.db
      .prepare(
        `INSERT INTO research_runs (session_id, status, step, question, clarification, report, error, started_at, finished_at)
         VALUES (?, 'running', 'scope', ?, NULL, NULL, NULL, ?, NULL)
         ON CONFLICT(session_id) DO UPDATE SET
           status = 'running', step = 'scope', question = excluded.question,
           clarification = NULL, report = NULL, error = NULL,
           started_at = excluded.started_at, finished_at = NULL`,
      )
      .run(sessionId, question, new Date().toISOString());
  }

  /** Resume a paused (awaiting_clarification) run — question/started_at kept. */
  resumeResearchRun(sessionId: string): void {
    this.db
      .prepare(
        `UPDATE research_runs SET status = 'running', step = 'scope',
           clarification = NULL, error = NULL, finished_at = NULL
         WHERE session_id = ?`,
      )
      .run(sessionId);
  }

  /** Per-stage progress for the status endpoint (best-effort). */
  updateResearchStep(sessionId: string, step: string): void {
    this.db.prepare(`UPDATE research_runs SET step = ? WHERE session_id = ?`).run(step, sessionId);
  }

  /** Pause the run on a clarifying question (resumable; finished_at stays NULL). */
  awaitResearchRun(sessionId: string, clarification: string): void {
    this.db
      .prepare(
        `UPDATE research_runs SET status = 'awaiting_clarification', step = 'scope',
           clarification = ?
         WHERE session_id = ?`,
      )
      .run(clarification, sessionId);
  }

  /** Terminal transition (completed / failed / cancelled / interrupted). */
  finishResearchRun(
    sessionId: string,
    patch: { status: "completed" | "failed" | "cancelled" | "interrupted"; report?: string; error?: string },
  ): void {
    this.db
      .prepare(
        `UPDATE research_runs SET status = ?, report = COALESCE(?, report),
           error = ?, finished_at = ?
         WHERE session_id = ?`,
      )
      .run(patch.status, patch.report ?? null, patch.error ?? null, new Date().toISOString(), sessionId);
  }

  getResearchRun(sessionId: string): ResearchRunRow | null {
    const row = this.db
      .prepare(
        `SELECT session_id, status, step, question, clarification, report, error, started_at, finished_at
         FROM research_runs WHERE session_id = ?`,
      )
      .get(sessionId) as ResearchRunRow | undefined;
    return row ?? null;
  }

  /** Boot sweep: runs that were mid-flight when the process died can never
   *  resume (no task survives a restart); mark them interrupted. */
  markStaleResearchRunsInterrupted(): number {
    const res = this.db
      .prepare(`UPDATE research_runs SET status = 'interrupted', finished_at = ? WHERE status = 'running'`)
      .run(new Date().toISOString());
    return Number(res.changes ?? 0);
  }
}

function sanitizeFts(token: string): string {
  // Quote-wrap to stay within FTS5 phrase syntax; fall through to LIKE on
  // invalid queries (e.g. user text containing quotes) is handled by callers.
  return token.replace(/"/g, '""');
}

function queryFts(db: DatabaseSync, match: string, limit: number): SessionHit[] {
  try {
    const rows = db
      .prepare(
        // external-content FTS5 has a single column (content, index 0)
        `SELECT t.session_id, t.created_at, t.content, snippet(turns_fts, 0, '', '', ' … ', 32) AS snip
         FROM turns_fts f JOIN turns t ON t.id = f.rowid
         WHERE turns_fts MATCH ?
         ORDER BY t.created_at DESC LIMIT ?`,
      )
      .all(match, limit) as Array<{ session_id: string; created_at: string; content: string; snip: string }>;
    return rows.map((r, i) => ({
      session_id: r.session_id,
      created_at: r.created_at,
      snippet: r.snip || r.content.slice(0, 400),
      retriever: "fts" as const,
      rank: i,
    }));
  } catch {
    return [];
  }
}

function queryLike(db: DatabaseSync, query: string, limit: number): SessionHit[] {
  // Last resort for FTS-invalid queries: match on individual significant words.
  const words = query.split(/\s+/).filter((w) => w.length >= 3).slice(0, 5);
  if (!words.length) return [];
  const clauses = words.map(() => `content LIKE ?`).join(" OR ");
  try {
    const rows = db
      .prepare(
        `SELECT session_id, created_at, content
         FROM turns WHERE ${clauses}
         ORDER BY created_at DESC LIMIT ?`,
      )
      .all(...words.map((w) => `%${w.replace(/[%_]/g, "")}%`), limit) as Array<{
      session_id: string;
      created_at: string;
      content: string;
    }>;
    return rows.map((r, i) => ({
      session_id: r.session_id,
      created_at: r.created_at,
      snippet: r.content.slice(0, 400),
      retriever: "fts" as const,
      rank: i,
    }));
  } catch {
    return [];
  }
}

interface ToolCallLike {
  id: string;
  name: string;
  args: Record<string, unknown>;
}
