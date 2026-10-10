// Mirror sidecar — the ONLY process that touches native memory-hogs.
//
// Why: both native layers reserve colossal virtual-address mappings —
// onnxruntime's arena ~40GB and the ruvector HNSW lib ~12GB in guards — and a
// process carrying such reservations cannot fork() (child candidates die with
// spawn ENOMEM; verified live 2026-10-10). The Express server must therefore
// never import either. This child forks early while small, loads ruvector +
// onnx, serves JSON-lines, and never spawns anything.
//
// Protocol (stdin/stdout, one JSON object per line):
//   ready1400: {"ready":true}
//   main → {"req":"init","id":N,"path":"..."}         → {"id":N,"ok":true}
//          {"req":"upsert","id":N,"recs":[{id,turn,msg_index,session_id,role,content,created_at,tool_call_id,tool_name}]}
//                                                   → {"id":N,"ok":true,"count":K}
//          {"req":"query","id":N,"text":"...","k":8} → {"id":N,"ok":true,"hits":[{...MirrorHit}]}
//          {"req":"stats","id":N}                    → {"id":N,"ok":true,"records":K}
//          {"req":"bye","id":N}                      → exits 0
//   failures: {"id":N,"ok":false,"error":"..."}
//
// The parent embeds nothing, searches nothing natively — it talks protocol.

import { createInterface } from "node:readline";

interface UpsertRec {
  id: string;
  turn: number;
  msg_index: number;
  session_id: string;
  role: string;
  content: string;
  created_at: string;
  tool_call_id?: string | null;
  tool_name?: string | null;
}

interface Hit {
  sessionId: string;
  createdAt: string;
  content: string;
  role: string;
  similarity: number;
}

async function main(): Promise<void> {
  process.stdout.write(JSON.stringify({ ready: true }) + "\n");
  const rl = createInterface({ input: process.stdin });

  let embed: ((t: string) => Promise<number[]>) | null = null;
  let db: RustDb | null = null;
  let records = 0;
  const MODEL = process.env.AGENTDB_EMBED_MODEL || "Xenova/all-MiniLM-L6-v2";
  const DIM = 384;

  const write = (obj: unknown) => process.stdout.write(JSON.stringify(obj) + "\n");

  for await (const line of rl) {
    let req: { req?: string; id?: number; path?: string; recs?: UpsertRec[]; text?: string; k?: number };
    try {
      req = JSON.parse(line);
    } catch {
      continue;
    }
    const id = req.id ?? 0;
    try {
      if (req.req === "bye") break;

      if (req.req === "init") {
        // load both native stacks once
        const ruv = await import("ruvector");
        const VectorDB = ruv.VectorDB;
        if (!VectorDB) throw new Error("no VectorDB export in ruvector");
        db = new VectorDB({ dimensions: DIM, distanceMetric: "cosine", storagePath: String(req.path ?? "./agent-mirror.db") }) as unknown as RustDb;
        const { EmbeddingService } = await import("agentdb/controllers/EmbeddingService");
        const svc = new EmbeddingService({
          model: MODEL,
          dimension: DIM,
          provider: "transformers",
          rolePolicy: { kind: "symmetric" } as never,
        } as never) as unknown as { initialize(): Promise<void>; embed(t: string): Promise<Float32Array | number[]> };
        await svc.initialize();
        embed = (t: string) => svc.embed(t).then((v) => Array.from(v));
        write({ id, ok: true });
        continue;
      }

      if (req.req === "stats") {
        write({ id, ok: true, records });
        continue;
      }

      if (req.req === "upsert") {
        if (!embed || !db) throw new Error("not initialized");
        let count = 0;
        for (const rec of req.recs ?? []) {
          if (!rec?.content?.trim()) continue;
          const vec = await embed(rec.content.slice(0, 4000));
          await db.insert({
            id: rec.id,
            vector: Float32Array.from(vec),
            metadata: {
              session_id: rec.session_id,
              turn: rec.turn,
              msg_index: rec.msg_index,
              role: rec.role,
              content: rec.content.slice(0, 8000),
              created_at: rec.created_at,
              tool_call_id: rec.tool_call_id ?? null,
              tool_name: rec.tool_name ?? null,
            },
          });
          count++;
          records++;
        }
        write({ id, ok: true, count });
        continue;
      }

      if (req.req === "query") {
        if (!embed || !db) throw new Error("not initialized");
        const qvec = await embed(String(req.text ?? "").slice(0, 2000));
        const raw = await db.search({ vector: Float32Array.from(qvec), k: Math.max(Number(req.k ?? 8), 1) });
        const rows: Array<{ id: string; score?: number; distance?: number; metadata?: Record<string, unknown> }> =
          Array.isArray(raw) ? raw : (raw.results ?? []);
        const hits: Hit[] = rows.map((r) => {
          const meta = (r.metadata ?? {}) as Partial<RecMetaDump>;
          return {
            sessionId: String(meta.session_id ?? ""),
            createdAt: String(meta.created_at ?? ""),
            content: String(meta.content ?? ""),
            role: String(meta.role ?? "unknown"),
            similarity: Math.max(0, Math.min(1, 1 - (r.score ?? r.distance ?? 0))),
          };
        });
        write({ id, ok: true, hits });
        continue;
      }
    } catch (e) {
      write({ id, ok: false, error: String(e instanceof Error ? e.message : e).slice(0, 200) });
    }
  }
  process.exit(0);
}

interface RustDb {
  insert(rec: { id: string; vector: Float32Array; metadata: Record<string, unknown> }): Promise<unknown>;
  search(q: { vector: Float32Array; k: number }): Promise<
    Array<{ id: string; score?: number; distance?: number; metadata?: Record<string, unknown> }> | { results?: Array<{ id: string; score?: number; distance?: number; metadata?: Record<string, unknown> }> }
  >;
}

interface RecMetaDump {
  session_id?: string;
  created_at?: string;
  content?: string;
  role?: string;
}

main().catch((e) => {
  process.stderr.write(`mirror sidecar fatal: ${String(e).slice(0, 200)}\n`);
  process.exit(1);
});
