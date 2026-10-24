// AgentDbMirror: client side of the mirror sidecar (mirror-child.ts) or, when
// AGENTDB_REMOTE_URL is set, of the container mirror (container/README.md) —
// two transports, one contract. The SQLite archive stays the authoritative
// store (acknowledged gaps G1/G3 of the migration study); the mirror only
// ADDS what the archive lacks — per-message embeddings for semantic session
// recall — enabling dual-source hybrid search before any cutover decision.
//
// Both natives are carried ONLY by the sidecar process: ruvector HNSW
// preallocates for its maxElements hint — capped by mirror-child via
// AGENTDB_MAX_ELEMENTS (default 100k ≈ 1.4GB VA; the wrapper default of 10M
// ≈ 35GB VA makes fork()/spawn fail ENOMEM, verified live 2026-10-10 and
// reproduced 2026-10-18) — plus onnxruntime (~1GB for MiniLM). The Express
// server imports neither. See mirror-child.ts for the JSON-lines protocol.
//
// Failure semantics: initialize() degrades (mirror off, reason recorded);
// recordTurn()/search() are no-throw. The archive never depends on the mirror.

import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { log } from "./logger.js";
import { currentUserId } from "./workspace.js";
import type { ChatMessage } from "./types.js";

export interface MirrorStatus {
  enabled: boolean;
  reason?: string;
  model?: string;
  path?: string;
  records?: number;
}

export interface MirrorHit {
  sessionId: string;
  createdAt: string;
  content: string;
  role: string;
  similarity: number;
  userId?: string;
}

interface SidecarMsg {
  id?: number;
  ok?: boolean;
  count?: number;
  records?: number;
  error?: string;
  hits?: MirrorHit[];
}

type RemoteMsg = SidecarMsg & {
  ready?: boolean;
  running?: boolean;
  stats?: { records?: number; stored?: number | null; ready?: boolean };
};

const MODEL = "Xenova/all-MiniLM-L6-v2";
const REQUEST_TIMEOUT_MS = Number(process.env.AGENTDB_REQUEST_TIMEOUT_MS ?? "180000");
const SIDECAR_READY_TIMEOUT_MS = Number(process.env.AGENTDB_SIDECAR_READY_MS ?? "120000");
// Remote container mirror (Cloudflare — see container/README.md): when the URL
// is set the local sidecar is skipped entirely; the same JSON protocol rides
// HTTPS. The boot probe is cheap and does NOT start the container — the first
// data call pays the cold start (within REQUEST_TIMEOUT_MS).
const REMOTE_URL = (process.env.AGENTDB_REMOTE_URL ?? "").trim().replace(/\/+$/, "");
const REMOTE_TOKEN = (process.env.AGENTDB_REMOTE_TOKEN ?? "").trim();
const REMOTE_STATUS_TIMEOUT_MS = Number(process.env.AGENTDB_REMOTE_STATUS_MS ?? "10000");

interface Waiter {
  resolve: (m: SidecarMsg) => void;
  reject: (e: Error) => void;
}

export class AgentDbMirror {
  readonly status: MirrorStatus = { enabled: false, reason: "not initialized" };
  private initialized = false;
  private child: ChildProcess | null = null;
  private nextId = 1;
  private inflight = new Map<number, Waiter>();
  private records = 0;
  private buffer = "";
  private ready = false;
  private readyResolve?: () => void;
  private readyFail?: (e: Error) => void;
  private readonly dbPath: string;
  private readonly remoteUrl: string;

  constructor(dbPath?: string) {
    const p = dbPath ?? process.env.AGENTDB_PATH ?? "./agent-mirror.db";
    this.dbPath = path.isAbsolute(p) ? p : path.resolve(process.cwd(), p);
    this.remoteUrl = REMOTE_URL;
  }

  /** Async init — degrades to a disabled no-op when the sidecar can't start.
   *  Idempotent: a second call returns the settled status instead of spawning
   *  a second sidecar (the phase-4-era double-boot fired a stale 120s timer
   *  that logged a phantom "mirror off" at +2 min). */
  async initialize(): Promise<MirrorStatus> {
    if (this.child || this.initialized) {
      // already initialized (or initializing): just report
      return this.status;
    }
    if ((process.env.AGENTDB_MIRROR ?? "auto") === "0") {
      this.initialized = true;
      this.status.reason = "disabled by env";
      return this.status;
    }
    if (this.remoteUrl) {
      return this.initializeRemote();
    }
    try {
      this.startSidecar();
      await this.waitReady();
      const init = await this.request({ req: "init", path: this.dbPath });
      if (!init.ok) throw new Error(init.error ?? "init failed");
      this.status.enabled = true;
      this.status.reason = undefined;
      this.status.model = MODEL;
      this.status.path = this.dbPath;
      this.status.records = this.records;
      log.info(`agentdb mirror ready (sidecar): ${this.dbPath}`);
      this.initialized = true;
      return this.status;
    } catch (e) {
      this.status.enabled = false;
      this.status.reason = `engine unavailable: ${errLine(e)}`;
      // TS narrows this.child to never here (control-flow doesn't see the
      // assignment inside startSidecar) — use an explicit cast.
      (this.child as ChildProcess | null)?.kill?.();
      this.child = null;
      this.initialized = true;
      return this.status;
    }
  }

  /** Remote container mirror: a /status probe only — the container may be
   *  asleep and must not be woken at boot (first use pays the cold start).
   *  Same degradation contract as the sidecar path. */
  private async initializeRemote(): Promise<MirrorStatus> {
    try {
      const st = await this.remote("/status", { timeoutMs: REMOTE_STATUS_TIMEOUT_MS });
      const stored = Number(st.stats?.stored ?? st.stats?.records ?? 0) || 0;
      this.records = stored;
      this.status.enabled = true;
      this.status.reason = undefined;
      this.status.model = MODEL;
      this.status.path = this.remoteUrl;
      this.status.records = stored;
      log.info(
        `agentdb mirror ready (remote): ${this.remoteUrl}${st.running ? "" : " — container asleep, cold start on first use"}`
      );
      this.initialized = true;
      return this.status;
    } catch (e) {
      this.status.enabled = false;
      this.status.reason = `engine unavailable (remote): ${errLine(e)}`;
      this.initialized = true;
      return this.status;
    }
  }

  getFastStatus(): MirrorStatus {
    return { ...this.status, records: this.records };
  }

  /** Archive-first dual-write: mirror records for one completed turn. */
  async recordTurn(sessionId: string, turnNumber: number, messages: ChatMessage[]): Promise<void> {
    if (!this.status.enabled || (!this.child && !this.remoteUrl)) return;
    try {
      const recs = messages.map((m, i) => ({
        id: `${sessionId.slice(0, 30)}#:t${turnNumber}#m${i}`,
        turn: turnNumber,
        msg_index: i,
        session_id: sessionId,
        user_id: currentUserId(),
        role: m.role,
        content: String(m.content ?? "").slice(0, 8000),
        created_at: new Date().toISOString(),
        tool_call_id: m.tool_call_id ?? null,
        tool_name: m.name ?? null,
      }));
      const res = this.remoteUrl
        ? await this.remote("/upsert", { body: { recs } })
        : await this.request({ req: "upsert", recs });
      if (!res.ok) throw new Error(res.error ?? "upsert failed");
      this.records += Number(res.count ?? 0);
      this.status.records = this.records;
    } catch (e) {
      // degradation, never fatal: the archive already owns the truth
      log.warn(`agentdb mirror write failed (degraded): ${errLine(e)}`);
    }
  }

  /** Dense semantic recall for the hybrid fusion. [] on any failure. */
  async search(query: string, limit: number = 6): Promise<MirrorHit[]> {
    if (!this.status.enabled || (!this.child && !this.remoteUrl)) return [];
    try {
      const text = query.slice(0, 2000);
      const userId = currentUserId();
      const k = Math.max(limit * 2, 8);
      const res = this.remoteUrl
        ? await this.remote("/query", { body: { text, k, user_id: userId } })
        : await this.request({ req: "query", text, k, user_id: userId });
      if (!res.ok) throw new Error(res.error ?? "query failed");
      return res.hits ?? [];
    } catch (e) {
      log.warn(`agentdb mirror search failed (degraded): ${errLine(e)}`);
      return [];
    }
  }

  async close(): Promise<void> {
    if (this.remoteUrl) return; // remote: nothing to tear down locally
    try {
      this.child?.stdin?.write(JSON.stringify({ req: "bye", id: 0 }) + "\n");
      setTimeout(() => {
        try {
          this.child?.kill();
        } catch {
          /* already dead */
        }
      }, 1500);
    } catch {
      try {
        this.child?.kill();
      } catch {
        /* already dead */
      }
    }
    this.child = null;
  }

  // --- sidecar plumbing -----------------------------------------------------

  private startSidecar(): void {
    // Paths are pinned to the MODULE location, not process.cwd(): the server
    // may be started from any directory (a cwd-relative node_modules/bin or
    // src/ path would silently fail to spawn and just time out).
    // import.meta.url points at <repo>/src/agentdb-mirror.ts → one '..' up.
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const script = path.join(repoRoot, "src", "mirror-child.ts");
    const tsxCli = path.join(repoRoot, "node_modules", ".bin", "tsx");
    const dbPath = path.isAbsolute(this.dbPath) ? this.dbPath : path.resolve(repoRoot, "./agent-mirror.db");
    const child = spawn(tsxCli, [script], {
      cwd: repoRoot,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
    this.child = child;
    if (child.stderr) {
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (d: string) => log.info(`[mirror-sidecar] ${d.trim().slice(0, 200)}`));
    }
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => this.onChunk(chunk));
    // Spawn-level failures (nothing to exec) must fail readiness fast —
    // otherwise waitReady can hang to its full timeout.
    child.on("error", (e) => {
      log.warn(`mirror sidecar spawn error: ${String(e).slice(0, 160)}`);
      this.readyFail?.(new Error(`sidecar spawn error: ${e}`));
    });
    child.on("exit", (code) => this.onExit(code));
  }

  private onChunk(chunk: string): void {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      let msg: SidecarMsg & { ready?: boolean };
      try {
        msg = JSON.parse(line) as SidecarMsg & { ready?: boolean };
      } catch {
        continue; // skip malformed lines
      }
      if (msg.ready) {
        this.readyResolve?.();
        continue;
      }
      const waiter = this.inflight.get(msg.id ?? -1);
      if (waiter) {
        this.inflight.delete(msg.id ?? -1);
        waiter.resolve(msg);
      }
    }
  }


  private waitReady(): Promise<void> {
    if (this.ready) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.readyResolve = undefined;
        reject(new Error("sidecar not ready (model/env load timeout)"));
      }, SIDECAR_READY_TIMEOUT_MS);
      this.readyResolve = () => {
        clearTimeout(timer);
        this.readyResolve = undefined;
        resolve();
      };
    });
  }

  private onExit(code: number | null): void {
    this.status.enabled = false;
    this.status.reason = `sidecar exited code=${code}`;
    for (const [, w] of this.inflight) w.reject(new Error(this.status.reason));
    this.inflight.clear();
  }

  private request(body: Record<string, unknown>): Promise<SidecarMsg> {
    const id = this.nextId++;
    return new Promise<SidecarMsg>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.inflight.delete(id);
        reject(new Error("mirror sidecar timeout"));
      }, REQUEST_TIMEOUT_MS);
      this.inflight.set(id, {
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      try {
        this.child?.stdin?.write(JSON.stringify({ ...body, id }) + "\n");
      } catch (e) {
        this.inflight.delete(id);
        reject(e as Error);
      }
    });
  }

  /** HTTP transport for the container mirror (see container/README.md).
   *  Throws on any failure — callers degrade; the archive stays the truth. */
  private async remote(
    pathname: string,
    init?: { body?: unknown; timeoutMs?: number }
  ): Promise<RemoteMsg> {
    const res = await fetch(`${this.remoteUrl}${pathname}`, {
      method: init?.body === undefined ? "GET" : "POST",
      headers: {
        ...(init?.body === undefined ? {} : { "content-type": "application/json" }),
        ...(REMOTE_TOKEN ? { authorization: `Bearer ${REMOTE_TOKEN}` } : {}),
      },
      body: init?.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(init?.timeoutMs ?? REQUEST_TIMEOUT_MS),
    });
    const msg = (await res.json()) as RemoteMsg;
    if (!res.ok || msg.ok === false) throw new Error(msg.error ?? `HTTP ${res.status}`);
    return msg;
  }
}

function errLine(e: unknown): string {
  return String(e instanceof Error ? e.message : e).slice(0, 120);
}
