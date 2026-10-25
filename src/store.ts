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
import { currentUserId } from "./workspace.js";
import type { ChatMessage } from "./types.js";
import type { SessionDriver, SessionHit, SessionRow } from "./driver.js";

export type { SessionRow } from "./driver.js";

/** Pre-SSO archives belong to the previous default user. One-time backfill
 *  (idempotent via INSERT OR IGNORE); change only if that account is renamed. */
const LEGACY_SESSION_OWNER = "trgordonb";

/** A session id is already owned by another login. */
export class SessionOwnershipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionOwnershipError";
  }
}

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

/** One agent-cron job (docs/agent-cron-plan.md). Booleans are INTEGER columns. */
export interface CronJobRow {
  id: string;
  user_id: string;
  name: string;
  schedule_kind: string; // 'cron' | 'interval' | 'once'
  schedule_expr: string;
  payload: string;
  session_id: string | null; // the job's own session (lazy on first fire)
  created_from_session: string | null;
  enabled: number;
  allow_scheduling: number;
  max_iterations: number | null;
  timezone: string | null;
  next_run_at: number | null; // epoch ms
  last_run_at: number | null;
  last_status: string | null; // 'ok' | 'error' | 'skipped' | null
  last_error: string | null;
  failure_streak: number;
  created_at: number;
  updated_at: number;
}

/** One cron fire — the run ledger the UI history reads. */
export interface CronRunRow {
  id: string;
  job_id: string;
  session_id: string | null;
  fire_at: number;
  started_at: number | null;
  finished_at: number | null;
  status: string; // 'claimed' | 'running' | 'completed' | 'failed' | 'skipped' | 'interrupted'
  iterations: number | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  error: string | null;
  result_excerpt: string | null;
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

      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        user_id    TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id, created_at);

      CREATE TABLE IF NOT EXISTS cron_jobs (
        id                   TEXT PRIMARY KEY,
        user_id              TEXT NOT NULL,
        name                 TEXT NOT NULL,
        schedule_kind        TEXT NOT NULL,
        schedule_expr        TEXT NOT NULL,
        payload              TEXT NOT NULL,
        session_id           TEXT,
        created_from_session TEXT,
        enabled              INTEGER NOT NULL DEFAULT 1,
        allow_scheduling     INTEGER NOT NULL DEFAULT 0,
        max_iterations       INTEGER,
        timezone             TEXT,
        next_run_at          INTEGER,
        last_run_at          INTEGER,
        last_status          TEXT,
        last_error           TEXT,
        failure_streak       INTEGER NOT NULL DEFAULT 0,
        created_at           INTEGER NOT NULL,
        updated_at           INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_cron_jobs_user_name ON cron_jobs(user_id, name);
      CREATE INDEX IF NOT EXISTS idx_cron_jobs_due ON cron_jobs(enabled, next_run_at);

      CREATE TABLE IF NOT EXISTS cron_runs (
        id                TEXT PRIMARY KEY,
        job_id            TEXT NOT NULL,
        session_id        TEXT,
        fire_at           INTEGER NOT NULL,
        started_at        INTEGER,
        finished_at       INTEGER,
        status            TEXT NOT NULL,
        iterations        INTEGER,
        prompt_tokens     INTEGER,
        completion_tokens INTEGER,
        error             TEXT,
        result_excerpt    TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_cron_runs_job ON cron_runs(job_id, fire_at);
      CREATE INDEX IF NOT EXISTS idx_cron_runs_status ON cron_runs(status);

      CREATE TABLE IF NOT EXISTS schema_meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);

    // Ownership backfill (once): all pre-SSO sessions belong to the previous
    // default user. The marker keeps this from claiming sessions written later
    // by an unowned/legacy process (they stay invisible instead of leaking).
    const backfilled = this.db
      .prepare(`SELECT value FROM schema_meta WHERE key = 'session_owner_backfill'`)
      .get() as { value: string } | undefined;
    if (!backfilled) {
      this.db.exec(`
        INSERT OR IGNORE INTO sessions (session_id, user_id, created_at)
          SELECT session_id, '${LEGACY_SESSION_OWNER}', MIN(created_at)
          FROM turns GROUP BY session_id;
        INSERT OR IGNORE INTO sessions (session_id, user_id, created_at)
          SELECT session_id, '${LEGACY_SESSION_OWNER}', MIN(started_at)
          FROM research_runs GROUP BY session_id;
        INSERT OR IGNORE INTO sessions (session_id, user_id, created_at)
          SELECT session_id, '${LEGACY_SESSION_OWNER}', MIN(created_at)
          FROM session_titles GROUP BY session_id;
      `);
      const hasFollowups = this.db
        .prepare(`SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'followups'`)
        .get();
      if (hasFollowups) {
        this.db.exec(`
          INSERT OR IGNORE INTO sessions (session_id, user_id, created_at)
            SELECT session_id, '${LEGACY_SESSION_OWNER}',
                   COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', created_at, 'unixepoch'),
                            strftime('%Y-%m-%dT%H:%M:%fZ','now'))
            FROM followups;
        `);
      }
      this.db
        .prepare(`INSERT INTO schema_meta (key, value) VALUES ('session_owner_backfill', ?)`)
        .run(new Date().toISOString());
    }
  }

  close(): void {
    this.db.close();
  }

  newSessionId(): string {
    return crypto.randomUUID();
  }

  /** Claim/create the session row for the current login; refuse a foreign id. */
  private ensureSession(sessionId: string): void {
    const owner = currentUserId();
    const row = this.db
      .prepare(`SELECT user_id FROM sessions WHERE session_id = ?`)
      .get(sessionId) as { user_id: string } | undefined;
    if (row) {
      if (row.user_id !== owner) {
        throw new SessionOwnershipError(`session ${sessionId} belongs to another user`);
      }
      return;
    }
    const legacyTurn = this.db
      .prepare(`SELECT 1 AS x FROM turns WHERE session_id = ? LIMIT 1`)
      .get(sessionId);
    if (legacyTurn) {
      throw new SessionOwnershipError(`session ${sessionId} has no owner; refusing to claim it`);
    }
    this.db
      .prepare(`INSERT INTO sessions (session_id, user_id, created_at) VALUES (?, ?, ?)`)
      .run(sessionId, owner, new Date().toISOString());
  }

  ownsSession(sessionId: string, userId: string = currentUserId()): boolean {
    const row = this.db
      .prepare(`SELECT user_id FROM sessions WHERE session_id = ?`)
      .get(sessionId) as { user_id: string } | undefined;
    return !!row && row.user_id === userId;
  }

  /** True when the id already exists (owned or foreign); false = a new chat. */
  sessionExists(sessionId: string): boolean {
    if (this.db.prepare(`SELECT 1 AS x FROM sessions WHERE session_id = ?`).get(sessionId)) return true;
    return !!this.db.prepare(`SELECT 1 AS x FROM turns WHERE session_id = ? LIMIT 1`).get(sessionId);
  }

  totalSessions(): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS c FROM sessions`).get() as { c: number };
    return Number(row.c);
  }

  appendTurn(sessionId: string, messages: ChatMessage[]): number {
    const insert = this.db.prepare(
      `INSERT INTO turns (session_id, turn_number, message_index, role, content, tool_calls, tool_call_id, tool_name, usage)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.ensureSession(sessionId);
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
    if (!this.ownsSession(sessionId)) return [];
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

  listSessions(userId: string = currentUserId()): SessionRow[] {
    return this.db
      .prepare(
        `SELECT t.session_id,
                MIN(t.created_at) AS created_at,
                COUNT(DISTINCT t.turn_number) AS turn_count,
                COUNT(*) AS message_count,
                st.title AS summary,
                rr.status AS research_status,
                MAX(cj.name) AS cron_name
         FROM turns t
         JOIN sessions s ON s.session_id = t.session_id
         LEFT JOIN session_titles st ON st.session_id = t.session_id
         LEFT JOIN research_runs rr ON rr.session_id = t.session_id
         LEFT JOIN cron_jobs cj ON cj.session_id = t.session_id
         WHERE s.user_id = ?
         GROUP BY t.session_id ORDER BY created_at DESC`,
      )
      .all(userId) as unknown as SessionRow[];
  }

  recordCompression(
    sessionId: string,
    meta: { summary: string; firstTurn: number; lastTurn: number; originalCount: number; model: string },
  ): void {
    this.ensureSession(sessionId);
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
    if (!this.ownsSession(sessionId)) return [];
    return this.db
      .prepare(
        `SELECT id, first_turn, last_turn, summary, model, created_at
         FROM compressions WHERE session_id = ? ORDER BY id`,
      )
      .all(sessionId) as never;
  }

  /** Title persistence: sync fallback rows and refined titles share the table. */
  setSessionTitle(sessionId: string, title: string, model: string): void {
    if (!this.ownsSession(sessionId)) return;
    this.db
      .prepare(
        `INSERT INTO session_titles (session_id, title, model)
         VALUES (?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET title = excluded.title, model = excluded.model`,
      )
      .run(sessionId, title, model);
  }

  getSessionTitle(sessionId: string): string | null {
    if (!this.ownsSession(sessionId)) return null;
    const row = this.db
      .prepare(`SELECT title FROM session_titles WHERE session_id = ?`)
      .get(sessionId) as { title: string } | undefined;
    return row?.title ?? null;
  }

  /** The model label that produced the current title (for provenance/debug). */
  getSessionTitleModel(sessionId: string): string | null {
    if (!this.ownsSession(sessionId)) return null;
    const row = this.db
      .prepare(`SELECT model FROM session_titles WHERE session_id = ?`)
      .get(sessionId) as { model: string } | undefined;
    return row?.model ?? null;
  }

  search(query: string, limit: number = 5, userId: string = currentUserId()): SessionHit[] {
    const tokens = query.split(/\s+/).filter(Boolean).map(sanitizeFts);
    if (!tokens.length) return [];
    const phrase = tokens.map((t) => `"${t}"`).join(" AND ");
    const joined = tokens.join(" OR ");
    let hits = queryFts(this.db, phrase, limit, userId);
    if (!hits.length) hits = queryFts(this.db, joined, limit, userId);
    if (!hits.length) hits = queryLike(this.db, query, limit, userId);
    return hits;
  }

  deleteSession(sessionId: string): void {
    if (!this.ownsSession(sessionId)) return;
    this.db.prepare(`DELETE FROM turns WHERE session_id = ?`).run(sessionId);
  }

  // --- deep research runs (/research) ----------------------------------------

  /** Start (or restart) a session's research run row. */
  startResearchRun(sessionId: string, question: string): void {
    this.ensureSession(sessionId);
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
    if (!this.ownsSession(sessionId)) return;
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
    if (!this.ownsSession(sessionId)) return null;
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

  /** Register a session row for the ACTIVE login without appending a turn —
   *  agent-cron fires create their job session at fire start so the UI can
   *  open it while the run is still in flight (appendTurn registers only at
   *  completion). Ownership refusal matches appendTurn. */
  registerSession(sessionId: string): void {
    this.ensureSession(sessionId);
  }

  // --- agent cron (docs/agent-cron-plan.md) ---------------------------------
  // Epoch-ms timestamps; ownership via user_id on every read. The claim step
  // is a BEGIN IMMEDIATE transaction: enabled re-check + no running run for
  // the job + run-row insert + next_run_at advance commit atomically, so a
  // tick can never double-fire and a long run is never re-fired.

  createCronJob(job: CronJobRow): CronJobRow {
    this.db
      .prepare(
        `INSERT INTO cron_jobs
           (id, user_id, name, schedule_kind, schedule_expr, payload, session_id,
            created_from_session, enabled, allow_scheduling, max_iterations, timezone,
            next_run_at, last_run_at, last_status, last_error, failure_streak,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        job.id, job.user_id, job.name, job.schedule_kind, job.schedule_expr, job.payload,
        job.session_id, job.created_from_session, job.enabled, job.allow_scheduling,
        job.max_iterations, job.timezone, job.next_run_at, job.last_run_at,
        job.last_status, job.last_error, job.failure_streak, job.created_at, job.updated_at,
      );
    return this.getCronJobById(job.id) as CronJobRow;
  }

  getCronJobById(id: string): CronJobRow | null {
    return (
      (this.db.prepare(`SELECT * FROM cron_jobs WHERE id = ?`).get(id) as CronJobRow | undefined) ??
      null
    );
  }

  /** id-or-name lookup scoped to one user (tool + routes share this). */
  getCronJobForUser(userId: string, idOrName: string): CronJobRow | null {
    const byId = this.db
      .prepare(`SELECT * FROM cron_jobs WHERE id = ? AND user_id = ?`)
      .get(idOrName, userId) as CronJobRow | undefined;
    if (byId) return byId;
    return (
      (this.db
        .prepare(`SELECT * FROM cron_jobs WHERE user_id = ? AND lower(name) = lower(?)`)
        .get(userId, idOrName) as CronJobRow | undefined) ?? null
    );
  }

  listCronJobs(userId: string): CronJobRow[] {
    return this.db
      .prepare(
        `SELECT * FROM cron_jobs WHERE user_id = ?
         ORDER BY (next_run_at IS NULL), next_run_at, created_at`,
      )
      .all(userId) as unknown as CronJobRow[];
  }

  private CRON_UPDATE_FIELDS = [
    "name", "schedule_kind", "schedule_expr", "payload", "session_id", "enabled",
    "allow_scheduling", "max_iterations", "timezone", "next_run_at", "last_run_at",
    "last_status", "last_error", "failure_streak",
  ] as const;

  updateCronJob(id: string, fields: Partial<CronJobRow>): CronJobRow | null {
    const sets: string[] = [];
    const vals: Array<string | number | null> = [];
    for (const k of this.CRON_UPDATE_FIELDS) {
      if (k in fields) {
        sets.push(`${k} = ?`);
        vals.push(fields[k] as string | number | null);
      }
    }
    if (!sets.length) return this.getCronJobById(id);
    sets.push("updated_at = ?");
    vals.push(Date.now(), id);
    this.db.prepare(`UPDATE cron_jobs SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
    return this.getCronJobById(id);
  }

  deleteCronJob(id: string): void {
    this.db.prepare(`DELETE FROM cron_jobs WHERE id = ?`).run(id);
  }

  dueCronJobs(nowMs: number, limit: number): CronJobRow[] {
    return this.db
      .prepare(
        `SELECT * FROM cron_jobs
         WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?
         ORDER BY next_run_at LIMIT ?`,
      )
      .all(nowMs, limit) as unknown as CronJobRow[];
  }

  /** Live scheduled fires across all jobs (claimed or running) — the
   *  CRON_MAX_PARALLEL budget. */
  runningCronCount(): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM cron_runs WHERE status IN ('running', 'claimed')`)
      .get() as { n: number };
    return Number(row.n);
  }

  /** Any live run for the job — 'claimed' (queued this tick) or 'running' —
   *  both block a new fire. */
  hasActiveCronRun(jobId: string): boolean {
    return Boolean(
      this.db
        .prepare(`SELECT 1 AS x FROM cron_runs WHERE job_id = ? AND status IN ('running', 'claimed')`)
        .get(jobId),
    );
  }

  insertCronRun(run: CronRunRow): void {
    this.db
      .prepare(
        `INSERT INTO cron_runs
           (id, job_id, session_id, fire_at, started_at, finished_at, status,
            iterations, prompt_tokens, completion_tokens, error, result_excerpt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        run.id, run.job_id, run.session_id, run.fire_at, run.started_at, run.finished_at,
        run.status, run.iterations, run.prompt_tokens, run.completion_tokens,
        run.error, run.result_excerpt,
      );
  }

  /** Claim one fire: atomically re-check enabled + not-running, insert the run
   *  row as 'claimed', advance next_run_at. Returns null when the job may not
   *  fire (disabled or previous run still active). */
  claimCronFire(job: CronJobRow, fireAt: number, nextRunAt: number | null, runId: string): CronRunRow | null {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.getCronJobById(job.id);
      if (!current || !current.enabled) {
        this.db.exec("ROLLBACK");
        return null;
      }
      if (this.hasActiveCronRun(job.id)) {
        this.db.exec("ROLLBACK");
        return null;
      }
      const run: CronRunRow = {
        id: runId, job_id: job.id, session_id: current.session_id,
        fire_at: fireAt, started_at: null, finished_at: null,
        status: "claimed", iterations: null, prompt_tokens: null,
        completion_tokens: null, error: null, result_excerpt: null,
      };
      this.insertCronRun(run);
      this.updateCronJob(job.id, { next_run_at: nextRunAt, last_run_at: fireAt });
      this.db.exec("COMMIT");
      return run;
    } catch (e) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* already rolled back */
      }
      throw e;
    }
  }

  markCronRunRunning(runId: string): void {
    this.db
      .prepare(`UPDATE cron_runs SET status = 'running', started_at = ? WHERE id = ?`)
      .run(Date.now(), runId);
  }

  /** Record a fire that was skipped (previous run still active). The caller
   *  advances next_run_at so the same slot is not re-skipped every tick. */
  recordCronSkipped(job: CronJobRow, fireAt: number, nextRunAt: number | null, runId: string): void {
    this.insertCronRun({
      id: runId, job_id: job.id, session_id: job.session_id, fire_at: fireAt,
      started_at: Date.now(), finished_at: Date.now(), status: "skipped",
      iterations: null, prompt_tokens: null, completion_tokens: null,
      error: "previous run still active", result_excerpt: null,
    });
    this.updateCronJob(job.id, { next_run_at: nextRunAt, last_run_at: fireAt, last_status: "skipped" });
  }

  /** Finalize a run and fold the outcome into the job (status, streak). */
  finishCronRun(
    runId: string,
    patch: {
      status: "completed" | "failed" | "interrupted";
      iterations?: number | null;
      prompt_tokens?: number | null;
      completion_tokens?: number | null;
      error?: string | null;
      result_excerpt?: string | null;
    },
  ): CronJobRow | null {
    const run = this.db.prepare(`SELECT * FROM cron_runs WHERE id = ?`).get(runId) as
      | CronRunRow
      | undefined;
    if (!run) return null;
    this.db
      .prepare(
        `UPDATE cron_runs SET status = ?, finished_at = ?, iterations = ?,
           prompt_tokens = ?, completion_tokens = ?, error = ?, result_excerpt = ?
         WHERE id = ?`,
      )
      .run(
        patch.status, Date.now(), patch.iterations ?? null, patch.prompt_tokens ?? null,
        patch.completion_tokens ?? null, patch.error ?? null, patch.result_excerpt ?? null,
        runId,
      );
    const job = this.getCronJobById(run.job_id);
    if (!job) return null;
    const failed = patch.status === "failed";
    const streak = failed ? job.failure_streak + 1 : 0;
    return this.updateCronJob(job.id, {
      last_status: failed ? "error" : "ok",
      last_error: patch.error ?? null,
      failure_streak: streak,
    });
  }

  listCronRuns(jobId: string, limit: number = 20): CronRunRow[] {
    return this.db
      .prepare(
        `SELECT * FROM cron_runs WHERE job_id = ? ORDER BY fire_at DESC, id DESC LIMIT ?`,
      )
      .all(jobId, limit) as unknown as CronRunRow[];
  }

  /** Boot reconciliation: interrupted runs are audit-only (never rerun); a job
   *  whose fire time passed while the process was down catches up once when
   *  recompute is null (fire immediately) or re-anchors to the returned slot. */
  reconcileCronOnBoot(
    nowMs: number,
    graceMs: number,
    catchUpMissed: boolean,
    recompute: (job: CronJobRow) => number | null,
  ): { interrupted: number; catchups: number } {
    const res = this.db
      .prepare(
        `UPDATE cron_runs SET status = 'interrupted', finished_at = ?
         WHERE status IN ('running', 'claimed')`,
      )
      .run(nowMs);
    const interrupted = Number(res.changes ?? 0);
    let catchups = 0;
    const stale = this.db
      .prepare(
        `SELECT * FROM cron_jobs
         WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at < ?`,
      )
      .all(nowMs) as unknown as CronJobRow[];
    for (const job of stale) {
      const missedBy = nowMs - (job.next_run_at as number);
      if (job.schedule_kind === "once" && missedBy > graceMs) {
        this.updateCronJob(job.id, {
          enabled: 0, last_status: "skipped",
          last_error: `missed while offline (${Math.round(missedBy / 60000)} min)`,
        });
        continue;
      }
      if (missedBy > graceMs && !catchUpMissed) {
        this.updateCronJob(job.id, { next_run_at: recompute(job) });
        continue;
      }
      // Catch up once: fire at the next tick, then the normal advance applies.
      this.updateCronJob(job.id, { next_run_at: nowMs });
      catchups++;
    }
    return { interrupted, catchups };
  }
}

function sanitizeFts(token: string): string {
  // Quote-wrap to stay within FTS5 phrase syntax; fall through to LIKE on
  // invalid queries (e.g. user text containing quotes) is handled by callers.
  return token.replace(/"/g, '""');
}

function queryFts(db: DatabaseSync, match: string, limit: number, userId: string): SessionHit[] {
  try {
    const rows = db
      .prepare(
        // external-content FTS5 has a single column (content, index 0)
        `SELECT t.session_id, t.created_at, t.content, snippet(turns_fts, 0, '', '', ' … ', 32) AS snip
         FROM turns_fts f
         JOIN turns t ON t.id = f.rowid
         JOIN sessions s ON s.session_id = t.session_id
         WHERE turns_fts MATCH ? AND s.user_id = ?
         ORDER BY t.created_at DESC LIMIT ?`,
      )
      .all(match, userId, limit) as Array<{ session_id: string; created_at: string; content: string; snip: string }>;
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

function queryLike(db: DatabaseSync, query: string, limit: number, userId: string): SessionHit[] {
  // Last resort for FTS-invalid queries: match on individual significant words.
  const words = query.split(/\s+/).filter((w) => w.length >= 3).slice(0, 5);
  if (!words.length) return [];
  const clauses = words.map(() => `t.content LIKE ?`).join(" OR ");
  try {
    const rows = db
      .prepare(
        `SELECT t.session_id, t.created_at, t.content
         FROM turns t
         JOIN sessions s ON s.session_id = t.session_id
         WHERE s.user_id = ? AND (${clauses})
         ORDER BY t.created_at DESC LIMIT ?`,
      )
      .all(userId, ...words.map((w) => `%${w.replace(/[%_]/g, "")}%`), limit) as Array<{
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
