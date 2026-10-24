// Mirror container server — the ONLY process that touches native memory-hogs.
//
// Containerized twin of src/mirror-child.ts: same engine (ruvector VectorDB +
// agentdb EmbeddingService / onnx MiniLM), same record-building rules, but
// over HTTP instead of stdin/stdout — a Cloudflare Container has no parent
// process to pipe to. One instance, one writer (the Durable Object serializes
// requests; the busy guard below covers accidental direct hits).
//
// Endpoints (JSON):
//   GET  /health -> { ok, ready, model, error }
//   GET  /stats  -> { ok, records, stored, ready }   stored = rows on disk
//   GET  /status -> { ok, running: true, stats }     client boot probe
//   POST /init   -> { ok }                           awaits engine load
//   POST /upsert -> { ok, count }  { recs: [record…] }   (record.user_id set)
//   POST /query  -> { ok, hits }   { text, k, user_id }
//
// The engine loads in the background at boot; data endpoints answer 503
// {ok:false} until ready so callers degrade (the mirror is additive).

import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const PORT = Number(process.env.PORT ?? "8080");
const MODEL = process.env.AGENTDB_EMBED_MODEL || "Xenova/all-MiniLM-L6-v2";
const DIM = 384;
// HNSW preallocation hint (the index auto-grows past it; see mirror-child.ts
// for the full story — the wrapper's own fallback reserves for 10M vectors,
// ~35GB VA at dims=384).
const MAX_ELEMENTS = Math.max(1, Number(process.env.AGENTDB_MAX_ELEMENTS ?? "100000") || 100000);
const DB_PATH = process.env.AGENTDB_PATH || "/data/agent-mirror.db";
const BODY_LIMIT = 8 * 1024 * 1024; // a turn's upsert batch is orders below this

let embed = null;
let db = null;
let ready = false;
let bootError = null;
let records = 0; // inserts during THIS process lifetime
let busy = false; // single in-flight upsert

const send = (res, code, obj) => {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  res.end(body);
};

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > BODY_LIMIT) throw new Error("body too large");
    chunks.push(chunk);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

async function storedCount() {
  try {
    return db && typeof db.len === "function" ? await db.len() : null;
  } catch {
    return null;
  }
}

function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

// agentdb swallows model-load failures and falls back to *mock* embeddings —
// vectors of the right shape that carry no semantics. Probe two related
// sentences against an unrelated one and fail the boot loudly instead of
// quietly poisoning the mirror with garbage recall.
async function assertSemanticEmbeddings() {
  const [a, b, c] = await Promise.all([
    embed("The cat sat on the warm mat."),
    embed("A feline rested on a cozy rug."),
    embed("Central banks repriced duration risk after the inflation print."),
  ]);
  const related = cosine(a, b);
  if (!(related > 0.3 && related > cosine(a, c) && related > cosine(b, c))) {
    throw new Error(`embedding sanity check failed (related=${related.toFixed(3)}) — mock/fallback embeddings?`);
  }
}

async function init() {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const ruv = await import("ruvector");
  const VectorDB = ruv.VectorDB;
  if (!VectorDB) throw new Error("no VectorDB export in ruvector");
  db = new VectorDB({
    dimensions: DIM,
    distanceMetric: "cosine",
    storagePath: DB_PATH,
    // hnswConfig is the wrapper's only capacity knob (options.maxElements is
    // ignored): documented HNSW defaults + a bounded maxElements.
    hnswConfig: { m: 32, efConstruction: 200, efSearch: 100, maxElements: MAX_ELEMENTS },
  });
  const { EmbeddingService } = await import("agentdb/controllers/EmbeddingService");
  const svc = new EmbeddingService({
    model: MODEL,
    dimension: DIM,
    provider: "transformers",
    rolePolicy: { kind: "symmetric" },
  });
  await svc.initialize();
  embed = (text) => svc.embed(text).then((v) => Array.from(v));
  await assertSemanticEmbeddings();
  ready = true;
  console.log(`[mirror] engine ready (db=${DB_PATH}, maxElements=${MAX_ELEMENTS})`);
}

const initPromise = init().catch((e) => {
  bootError = String(e instanceof Error ? e.message : e).slice(0, 300);
  console.error(`[mirror] engine load failed: ${bootError}`);
});

async function upsert(recs) {
  let count = 0;
  for (const rec of recs ?? []) {
    if (!rec?.content?.trim()) continue;
    const vec = await embed(String(rec.content).slice(0, 4000));
    await db.insert({
      id: rec.id,
      vector: Float32Array.from(vec),
      metadata: {
        session_id: rec.session_id,
        user_id: rec.user_id ?? null,
        turn: rec.turn,
        msg_index: rec.msg_index,
        role: rec.role,
        content: String(rec.content).slice(0, 8000),
        created_at: rec.created_at,
        tool_call_id: rec.tool_call_id ?? null,
        tool_name: rec.tool_name ?? null,
      },
    });
    count++;
    records++;
  }
  return count;
}

function toHits(rows, userId, limit) {
  const list = Array.isArray(rows) ? rows : rows?.results ?? [];
  return list
    .filter((row) => {
      const owner = String(row.metadata?.user_id ?? "trgordonb");
      return !userId || owner === userId;
    })
    .slice(0, limit)
    .map((row) => {
      const meta = row.metadata ?? {};
      return {
        sessionId: String(meta.session_id ?? ""),
        createdAt: String(meta.created_at ?? ""),
        content: String(meta.content ?? ""),
        role: String(meta.role ?? "unknown"),
        similarity: Math.max(0, Math.min(1, 1 - (row.score ?? row.distance ?? 0))),
        userId: String(meta.user_id ?? "trgordonb"),
      };
    });
}

const server = http.createServer(async (req, res) => {
  try {
    const { pathname } = new URL(req.url ?? "/", "http://container");
    if (req.method === "GET" && pathname === "/health") {
      return send(res, 200, { ok: true, ready, model: MODEL, error: bootError });
    }
    if (req.method === "GET" && pathname === "/stats") {
      return send(res, 200, { ok: true, records, stored: await storedCount(), ready });
    }
    if (req.method === "GET" && pathname === "/status") {
      return send(res, 200, { ok: true, running: true, stats: { records, stored: await storedCount(), ready } });
    }
    if (req.method === "POST" && pathname === "/init") {
      await initPromise;
      if (bootError) return send(res, 503, { ok: false, error: `engine load failed: ${bootError}` });
      return send(res, 200, { ok: true });
    }
    if (req.method === "POST" && pathname === "/upsert") {
      await initPromise;
      if (!ready) return send(res, 503, { ok: false, error: bootError ? `engine load failed: ${bootError}` : "initializing" });
      if (busy) return send(res, 429, { ok: false, error: "busy" });
      busy = true;
      try {
        const body = await readBody(req);
        const count = await upsert(body.recs);
        return send(res, 200, { ok: true, count });
      } finally {
        busy = false;
      }
    }
    if (req.method === "POST" && pathname === "/query") {
      await initPromise;
      if (!ready) return send(res, 503, { ok: false, error: bootError ? `engine load failed: ${bootError}` : "initializing" });
      const body = await readBody(req);
      const qvec = await embed(String(body.text ?? "").slice(0, 2000));
      const want = Math.max(Number(body.k ?? 8), 1);
      const userId = String(body.user_id ?? "").trim();
      // HNSW has no metadata filter: over-fetch, drop other users, then trim.
      const raw = await db.search({ vector: Float32Array.from(qvec), k: Math.max(want * 4, 32) });
      return send(res, 200, { ok: true, hits: toHits(raw, userId, want) });
    }
    return send(res, 404, { ok: false, error: "not found" });
  } catch (e) {
    return send(res, 500, { ok: false, error: String(e instanceof Error ? e.message : e).slice(0, 300) });
  }
});

server.listen(PORT, "0.0.0.0", () => console.log(`[mirror] listening on :${PORT} (engine loading…)`));

// The platform sends SIGTERM before stopping an instance (up to 15 min of
// grace); no flush is needed here — the Durable Object snapshots the disk.
for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    console.log(`[mirror] ${sig} — closing`);
    server.close(() => process.exit(0));
    // Keep-alive connections would otherwise hold the process open past close().
    server.closeAllConnections?.();
    setTimeout(() => process.exit(0), 10_000);
  });
}
