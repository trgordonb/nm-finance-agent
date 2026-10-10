// AgentDbMirror: client side of the mirror sidecar (mirror-child.ts).
// The SQLite archive stays the authoritative store (acknowledged gaps G1/G3
// of the migration study); the mirror only ADDS what the archive lacks —
// per-message embeddings for semantic session recall — enabling dual-source
// hybrid search before any cutover decision.
//
// Both natives (onnx arena ~40GB VA, ruvector HNSW ~12GB guards) are carried
// ONLY by the sidecar process: a process with those reservations cannot
// fork() (spawn ENOMEM — verified live 2026-10-10), so the Express server
// imports neither. See mirror-child.ts for the JSON-lines protocol.
//
// Failure semantics: initialize() degrades (mirror off, reason recorded);
// recordTurn()/search() are no-throw. The archive never depends on the mirror.

import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { log } from "./logger.js";
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
}

interface SidecarMsg {
  id?: number;
  ok?: boolean;
  count?: number;
  records?: number;
  error?: string;
  hits?: MirrorHit[];
}

const MODEL = "Xenova/all-MiniLM-L6-v2";
const REQUEST_TIMEOUT_MS = Number(process.env.AGENTDB_REQUEST_TIMEOUT_MS ?? "180000");
const SIDECAR_READY_TIMEOUT_MS = Number(process.env.AGENTDB_SIDECAR_READY_MS ?? "120000");

interface Waiter {
  resolve: (m: SidecarMsg) => void;
  reject: (e: Error) => void;
}

export class AgentDbMirror {
  readonly status: MirrorStatus = { enabled: false, reason: "not initialized" };
  private child: ChildProcess | null = null;
  private nextId = 1;
  private inflight = new Map<number, Waiter>();
  private records = 0;
  private buffer = "";
  private ready = false;
  private readyResolve?: () => void;
  private readyFail?: (e: Error) => void;
  private readonly dbPath: string;

  constructor(dbPath?: string) {
    const p = dbPath ?? process.env.AGENTDB_PATH ?? "./agent-mirror.db";
    this.dbPath = path.isAbsolute(p) ? p : path.resolve(process.cwd(), p);
  }

  /** Async init — degrades to a disabled no-op when the sidecar can't start. */
  async initialize(): Promise<MirrorStatus> {
    if ((process.env.AGENTDB_MIRROR ?? "auto") === "0") {
      this.status.reason = "disabled by env";
      return this.status;
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
      return this.status;
    } catch (e) {
      this.status.enabled = false;
      this.status.reason = `engine unavailable: ${errLine(e)}`;
      this.child?.kill();
      this.child = null;
      return this.status;
    }
  }

  getFastStatus(): MirrorStatus {
    return { ...this.status, records: this.records };
  }

  /** Archive-first dual-write: mirror records for one completed turn. */
  async recordTurn(sessionId: string, turnNumber: number, messages: ChatMessage[]): Promise<void> {
    if (!this.status.enabled || !this.child) return;
    try {
      const recs = messages.map((m, i) => ({
        id: `${sessionId.slice(0, 30)}#:t${turnNumber}#m${i}`,
        turn: turnNumber,
        msg_index: i,
        session_id: sessionId,
        role: m.role,
        content: String(m.content ?? "").slice(0, 8000),
        created_at: new Date().toISOString(),
        tool_call_id: m.tool_call_id ?? null,
        tool_name: m.name ?? null,
      }));
      const res = await this.request({ req: "upsert", recs });
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
    if (!this.status.enabled || !this.child) return [];
    try {
      const res = await this.request({ req: "query", text: query.slice(0, 2000), k: Math.max(limit * 2, 8) });
      if (!res.ok) throw new Error(res.error ?? "query failed");
      return res.hits ?? [];
    } catch (e) {
      log.warn(`agentdb mirror search failed (degraded): ${errLine(e)}`);
      return [];
    }
  }

  async close(): Promise<void> {
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
}

function errLine(e: unknown): string {
  return String(e instanceof Error ? e.message : e).slice(0, 120);
}
