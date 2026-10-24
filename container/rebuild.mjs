// Rebuild the remote mirror from the authoritative archive (sessions.db).
//
// The mirror is additive/rebuildable: after an image update, an expired
// snapshot (30-day TTL), or a fresh instance with an empty disk, replay the
// archive into the container mirror:
//
//   AGENTDB_REMOTE_URL=https://… AGENTDB_REMOTE_TOKEN=… \
//     node container/rebuild.mjs [path/to/sessions.db]
//
// Record ids match the live mirror's format (`<session>#:t<turn>#m<index>`),
// so later live turns for the same message land on the same ids. Runs
// locally with Node 24 (built-in node:sqlite); batching via REBUILD_BATCH
// (default 32; keep small on a cold/small instance). Waits for /health, then
// retries transient resets/429/5xx per batch — the first request after an
// image deploy wakes a fresh container and can be reset by the edge.
// Resume after a timeout with REBUILD_START=<last completed row>.

import { DatabaseSync } from "node:sqlite";

const url = (process.env.AGENTDB_REMOTE_URL ?? "").replace(/\/+$/, "");
const token = process.env.AGENTDB_REMOTE_TOKEN ?? "";
const dbPath = process.argv[2] ?? process.env.SESSION_DB_PATH ?? "./sessions.db";
const batchSize = Math.max(1, Number(process.env.REBUILD_BATCH ?? "32") || 32);
const startAt = Math.max(0, Number(process.env.REBUILD_START ?? "0") || 0);
const READY_TIMEOUT_MS = Number(process.env.REBUILD_READY_TIMEOUT_MS ?? "300000");
const MAX_ATTEMPTS = Math.max(1, Number(process.env.REBUILD_RETRIES ?? "5") || 5);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

if (!url) {
  console.error("AGENTDB_REMOTE_URL is required");
  process.exit(2);
}

const db = new DatabaseSync(dbPath);
const baseSelect = `session_id, turn_number, message_index, role, content,
            tool_call_id, tool_name, created_at`;
let rows;
try {
  // Attribution comes from the session ownership table when present.
  rows = db
    .prepare(
      `SELECT t.session_id, t.turn_number, t.message_index, t.role, t.content,
              t.tool_call_id, t.tool_name, t.created_at,
              COALESCE(s.user_id, 'trgordonb') AS user_id
         FROM turns t
         LEFT JOIN sessions s ON s.session_id = t.session_id
        WHERE t.content IS NOT NULL AND length(trim(t.content)) > 0
        ORDER BY t.id`
    )
    .all();
} catch {
  // Pre-ownership archive: everything belongs to the legacy default user.
  rows = db
    .prepare(
      `SELECT ${baseSelect}
         FROM turns
        WHERE content IS NOT NULL AND length(trim(content)) > 0
        ORDER BY id`
    )
    .all();
}
db.close();
console.log(`[rebuild] ${rows.length} messages from ${dbPath}`);

const auth = token ? { authorization: `Bearer ${token}` } : {};

async function waitReady() {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let last = "no response";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/health`, {
        headers: auth,
        signal: AbortSignal.timeout(15000),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok && body.ready) {
        console.log("[rebuild] mirror ready");
        return;
      }
      last = body.error ?? `health ${res.status}`;
    } catch (e) {
      last = String(e);
    }
    console.log(`[rebuild] waiting for mirror: ${last}`);
    await sleep(2000);
  }
  throw new Error(`mirror not ready within ${Math.round(READY_TIMEOUT_MS / 1000)}s (${last})`);
}

async function upsertBatch(recs) {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(`${url}/upsert`, {
        method: "POST",
        headers: { "content-type": "application/json", ...auth },
        body: JSON.stringify({ recs }),
        signal: AbortSignal.timeout(180000),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok && body.ok !== false) return body;
      const err = new Error(body.error ?? `HTTP ${res.status}`);
      if (res.status === 400 || res.status === 401 || res.status === 403) {
        err.nonRetryable = true;
      }
      throw err;
    } catch (e) {
      if (e?.nonRetryable || attempt === MAX_ATTEMPTS) throw e;
      const delay = Math.min(15000, 1000 * 2 ** (attempt - 1));
      console.warn(
        `[rebuild] batch failed (${String(e).slice(0, 160)}); retry ${attempt}/${MAX_ATTEMPTS} in ${delay / 1000}s`,
      );
      await sleep(delay);
    }
  }
  throw new Error("unreachable");
}

await waitReady();
let sent = 0;
if (startAt) console.log(`[rebuild] resuming at row ${startAt}`);
for (let i = startAt; i < rows.length; i += batchSize) {
  const recs = rows.slice(i, i + batchSize).map((r) => ({
    id: `${String(r.session_id).slice(0, 30)}#:t${r.turn_number}#m${r.message_index}`,
    turn: r.turn_number,
    msg_index: r.message_index,
    session_id: r.session_id,
    user_id: r.user_id ?? "trgordonb",
    role: r.role,
    content: String(r.content).slice(0, 8000),
    created_at: r.created_at,
    tool_call_id: r.tool_call_id ?? null,
    tool_name: r.tool_name ?? null,
  }));
  try {
    const body = await upsertBatch(recs);
    sent += Number(body.count ?? 0);
  } catch (e) {
    console.error(`[rebuild] failed at row ${i}: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
  console.log(`[rebuild] ${Math.min(i + batchSize, rows.length)}/${rows.length}`);
  await sleep(100);
}

const stats = await fetch(`${url}/stats`, { headers: auth })
  .then((r) => r.json())
  .catch((e) => ({ error: String(e) }));
console.log(`[rebuild] done: pushed ${sent} records; mirror reports ${JSON.stringify(stats)}`);
