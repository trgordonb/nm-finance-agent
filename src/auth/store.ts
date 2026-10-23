// Server-side auth sessions. One row per browser login; the browser only ever
// holds the opaque id, and the row's primary key is sha256(id) so a leaked DB
// does not yield usable cookies. Tokens in this table are bearer credentials:
// the file is chmod 600 and must be treated as secret material.

import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

export interface AuthSession {
  /** sha256(raw cookie value), hex. */
  idHash: string;
  sub: string;
  username: string;
  email: string | null;
  perms: string[];
  accessToken: string;
  refreshToken: string;
  /** epoch ms */
  accessExpiresAt: number;
  /** client IP observed at login; introspection uses the request's current IP */
  ip: string | null;
  sid: string | null;
  /** epoch ms */
  createdAt: number;
  lastSeenAt: number;
  lastIntrospectAt: number;
  /** result of the last permission-bearing introspection */
  lastAllowed: boolean;
}

interface AuthSessionRow {
  id_hash: string;
  sub: string;
  username: string;
  email: string | null;
  perms: string;
  access_token: string;
  refresh_token: string;
  access_expires_at: number;
  ip: string | null;
  sid: string | null;
  created_at: number;
  last_seen_at: number;
  last_introspect_at: number;
  last_allowed: number;
}

export class AuthStore {
  readonly dbPath: string;
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
    if (dbPath !== ":memory:") {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.migrate();
    if (dbPath !== ":memory:") {
      try {
        fs.chmodSync(dbPath, 0o600);
      } catch {
        /* best effort; the volume's ownership is the real control */
      }
    }
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS auth_sessions (
        id_hash            TEXT PRIMARY KEY,
        sub                TEXT NOT NULL,
        username           TEXT NOT NULL,
        email              TEXT,
        perms              TEXT NOT NULL DEFAULT '[]',
        access_token       TEXT NOT NULL,
        refresh_token      TEXT NOT NULL,
        access_expires_at  INTEGER NOT NULL,
        ip                 TEXT,
        sid                TEXT,
        created_at         INTEGER NOT NULL,
        last_seen_at       INTEGER NOT NULL,
        last_introspect_at INTEGER NOT NULL DEFAULT 0,
        last_allowed       INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX IF NOT EXISTS idx_auth_sessions_created
        ON auth_sessions(created_at);
    `);
  }

  get(idHash: string): AuthSession | null {
    const row = this.db
      .prepare("SELECT * FROM auth_sessions WHERE id_hash = ?")
      .get(idHash) as AuthSessionRow | undefined;
    return row ? fromRow(row) : null;
  }

  put(session: AuthSession): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO auth_sessions
           (id_hash, sub, username, email, perms, access_token, refresh_token,
            access_expires_at, ip, sid, created_at, last_seen_at,
            last_introspect_at, last_allowed)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        session.idHash,
        session.sub,
        session.username,
        session.email,
        JSON.stringify(session.perms),
        session.accessToken,
        session.refreshToken,
        session.accessExpiresAt,
        session.ip,
        session.sid,
        session.createdAt,
        session.lastSeenAt,
        session.lastIntrospectAt,
        session.lastAllowed ? 1 : 0,
      );
  }

  delete(idHash: string): void {
    this.db.prepare("DELETE FROM auth_sessions WHERE id_hash = ?").run(idHash);
  }

  /** Delete rows created before `cutoffMs` (session TTL expiry). */
  deleteExpired(cutoffMs: number): number {
    const result = this.db
      .prepare("DELETE FROM auth_sessions WHERE created_at < ?")
      .run(cutoffMs);
    return Number(result.changes ?? 0);
  }

  close(): void {
    this.db.close();
  }
}

function fromRow(row: AuthSessionRow): AuthSession {
  let perms: string[] = [];
  try {
    const parsed = JSON.parse(row.perms);
    if (Array.isArray(parsed)) perms = parsed.filter((p): p is string => typeof p === "string");
  } catch {
    /* corrupt row: no permissions */
  }
  return {
    idHash: row.id_hash,
    sub: row.sub,
    username: row.username,
    email: row.email ?? null,
    perms,
    accessToken: row.access_token,
    refreshToken: row.refresh_token,
    accessExpiresAt: Number(row.access_expires_at),
    ip: row.ip ?? null,
    sid: row.sid ?? null,
    createdAt: Number(row.created_at),
    lastSeenAt: Number(row.last_seen_at),
    lastIntrospectAt: Number(row.last_introspect_at),
    lastAllowed: Number(row.last_allowed) === 1,
  };
}
