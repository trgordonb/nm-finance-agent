// Worker + Durable Object in front of the mirror container (Cloudflare
// Containers, `durable_object` scheduling policy — see wrangler.jsonc).
//
//   client ──HTTPS──▶ Worker (auth) ──▶ DO "mirror" ──▶ container :8080
//
// The DO owns the lifecycle: it starts the container on the first data
// request (cold start ≈ container boot + model load), keeps it warm for
// WARM_MS after the last request, and snapshots the writable disk ~5s after
// upserts settle. The snapshot ref (id + source image) lives in DO SQLite
// storage; the next boot restores from the newest one, falling back to a
// fresh image when it is missing, expired (30-day TTL) or image-mismatched —
// in which case replay the archive with container/rebuild.mjs.
//
// Only this Worker is network-exposed; the container port lives behind the DO.

import { DurableObject } from "cloudflare:workers";

interface Env {
  MIRROR: DurableObjectNamespace;
  /** wrangler secret put MIRROR_TOKEN */
  MIRROR_TOKEN: string;
  /** optional var; HNSW preallocation hint passed to the container */
  AGENTDB_MAX_ELEMENTS?: string;
}

const PORT = 8080;
const INSTANCE = "standard-1"; // ½ vCPU / 4 GiB / 8 GB disk — see platform limits
const WARM_MS = 15 * 60 * 1000; // inactivity window that keeps the container up
const SNAPSHOT_DEBOUNCE_MS = 5_000; // settle time after the last /upsert
const READY_TIMEOUT_MS = 150_000; // model load budget on a cold instance
const READY_POLL_MS = 750;

interface SnapshotRef {
  id: string;
  image: string;
  at: number;
}

// ctx.container / container API typings come from the deploy-time worker
// types; this file stays self-contained (`any` keeps editors quiet locally).
type ContainerCtl = any;

export class MirrorContainer extends DurableObject<Env> {
  private starting: Promise<void> | null = null;
  private dirty = false;

  private container(): ContainerCtl {
    const c = (this.ctx as unknown as { container?: unknown }).container;
    if (!c) throw new Error("no container configured for this Durable Object");
    return c;
  }

  private async ensureRunning(): Promise<void> {
    const c = this.container();
    if (c.running) return;
    if (!this.starting) {
      this.starting = this.startContainer(c).finally(() => {
        this.starting = null;
      });
    }
    await this.starting;
  }

  private async startContainer(c: ContainerCtl): Promise<void> {
    const image: string = c.images?.base ?? "";
    const snapshot = await this.ctx.storage.get<SnapshotRef>("snapshot");
    const base = {
      instance: INSTANCE,
      enableInternet: false, // everything (model, index) is baked in; no egress
      env: {
        AGENTDB_PATH: "/data/agent-mirror.db",
        PORT: String(PORT),
        AGENTDB_MAX_ELEMENTS: this.env.AGENTDB_MAX_ELEMENTS ?? "100000",
      },
    };
    // Snapshots are tied to the image they were created from; drop stale ones.
    if (snapshot && image && snapshot.image === image) {
      try {
        c.start({ ...base, containerSnapshot: { id: snapshot.id } });
      } catch (e) {
        console.warn("mirror: snapshot restore rejected, starting from image", e);
        c.start({ ...base, image });
      }
    } else {
      c.start({ ...base, image });
    }
    await c.setInactivityTimeout(WARM_MS);
    this.ctx.waitUntil(
      c.monitor().catch((e: unknown) => console.error("mirror container exited:", e))
    );
    try {
      await this.waitReady(c);
    } catch (e) {
      // A container that never becomes ready is useless to everyone; tear it
      // down so the next request starts fresh.
      await c.destroy("readiness timeout").catch(() => undefined);
      throw e;
    }
  }

  private async waitReady(c: ContainerCtl): Promise<void> {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    let last = "no response";
    while (Date.now() < deadline) {
      try {
        const res = await c.getTcpPort(PORT).fetch("http://container/health");
        if (res.ok) {
          const body = (await res.json()) as { ready?: boolean; error?: string | null };
          if (body.ready) return;
          // A terminal boot failure (engine load, embedding sanity) will never
          // heal — fail now instead of burning the full readiness budget.
          if (body.error) throw new Error(`engine error: ${body.error}`);
          last = "engine loading";
        } else {
          last = `health ${res.status}`;
        }
      } catch (e) {
        last = String((e as Error)?.message ?? e);
      }
      await new Promise((resolve) => setTimeout(resolve, READY_POLL_MS));
    }
    throw new Error(`container not ready within ${READY_TIMEOUT_MS}ms (${last})`);
  }

  /** Cheap state probe — does NOT start the container. */
  private async status(): Promise<Response> {
    const c = this.container();
    const snapshot = await this.ctx.storage.get<SnapshotRef>("snapshot");
    const out: Record<string, unknown> = {
      ok: true,
      running: !!c.running,
      snapshot: snapshot ? { id: snapshot.id, at: snapshot.at } : null,
      dirty: this.dirty,
    };
    if (c.running) {
      try {
        const res = await c.getTcpPort(PORT).fetch("http://container/stats");
        if (res.ok) out.stats = await res.json();
      } catch {
        /* container restarting — status is best-effort */
      }
    }
    return Response.json(out);
  }

  private async markDirty(): Promise<void> {
    this.dirty = true;
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + SNAPSHOT_DEBOUNCE_MS);
    }
  }

  /** Fires after upserts settle; snapshots the writable disk. */
  async alarm(): Promise<void> {
    if (!this.dirty) return;
    const c = this.container();
    if (!c.running) return; // nothing to snapshot; the last good one stands
    try {
      const snap = await c.snapshotContainer({ name: `mirror-${Date.now()}` });
      const ref: SnapshotRef = { id: snap.id, image: c.images?.base ?? "", at: Date.now() };
      await this.ctx.storage.put("snapshot", ref);
      this.dirty = false;
      console.log(`mirror: snapshot stored (${snap.size} bytes)`);
    } catch (e) {
      // Don't hot-loop on failure; the next upsert re-arms the alarm.
      this.dirty = false;
      console.error("mirror: snapshot failed:", e);
    }
  }

  async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === "/status") return this.status();
    try {
      await this.ensureRunning();
    } catch (e) {
      return Response.json(
        { ok: false, error: `container unavailable: ${String((e as Error)?.message ?? e)}` },
        { status: 503 }
      );
    }
    const init: RequestInit = { method: request.method };
    if (request.method !== "GET" && request.method !== "HEAD") {
      init.body = request.body;
      init.headers = { "content-type": request.headers.get("content-type") ?? "application/json" };
    }
    const proxied = await this.container().getTcpPort(PORT).fetch(new Request(`http://container${pathname}`, init));
    if (pathname === "/upsert" && proxied.ok) this.ctx.waitUntil(this.markDirty());
    return proxied;
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const got = request.headers.get("authorization") ?? "";
    if (!env.MIRROR_TOKEN || got !== `Bearer ${env.MIRROR_TOKEN}`) {
      return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
    }
    return env.MIRROR.get(env.MIRROR.idFromName("mirror")).fetch(request);
  },
};
