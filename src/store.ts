// SessionStore: episodic archive in plain SQLite (node:sqlite, WAL).
// Turn-structured like nm_memory_layer.store: one row per completed agent turn,
// full assistant tool_calls + tool_call_id persisted so loadSession() rebuilds
// provider-valid histories (dangling ToolMessage would break providers).
//
// Derived from the langgraph-demo harness conventions:
//   - CWD-relative db path (the archive belongs to the consuming agent's cwd)
//   - FTS5 over vectors (exact/keyword recall now; semantic comes later)

import { DatabaseSync } from "node:sqlite";
import { DB_PATH } from "./config.js";
import type { ChatMessage } from "./types.js";
import type { SessionDriver, SessionHit, SessionRow } from "./driver.js";

export type { SessionRow } from "./driver.js";

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
      `INSERT INTO turns (session_id, turn_number, message_index, role, content, tool_calls, tool_call_id, tool_name)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
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
      .prepare(`SELECT role, content, tool_calls, tool_call_id, tool_name FROM turns WHERE session_id = ? ORDER BY id`)
      .all(sessionId) as Array<{
      role: string;
      content: string;
      tool_calls: string | null;
      tool_call_id: string | null;
      tool_name: string | null;
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
      return msg;
    });
  }

  listSessions(): SessionRow[] {
    return this.db
      .prepare(
        `SELECT session_id,
                MIN(created_at) AS created_at,
                COUNT(DISTINCT turn_number) AS turn_count,
                COUNT(*) AS message_count
         FROM turns GROUP BY session_id ORDER BY created_at DESC`,
      )
      .all() as unknown as SessionRow[];
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
