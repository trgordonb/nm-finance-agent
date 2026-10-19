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
// (default 128). Stops at the first failed batch — re-run after fixing.

import { DatabaseSync } from "node:sqlite";

const url = (process.env.AGENTDB_REMOTE_URL ?? "").replace(/\/+$/, "");
const token = process.env.AGENTDB_REMOTE_TOKEN ?? "";
const dbPath = process.argv[2] ?? process.env.SESSION_DB_PATH ?? "./sessions.db";
const batchSize = Math.max(1, Number(process.env.REBUILD_BATCH ?? "128") || 128);

if (!url) {
  console.error("AGENTDB_REMOTE_URL is required");
  process.exit(2);
}

const db = new DatabaseSync(dbPath);
const rows = db
  .prepare(
    `SELECT session_id, turn_number, message_index, role, content,
            tool_call_id, tool_name, created_at
       FROM turns
      WHERE content IS NOT NULL AND length(trim(content)) > 0
      ORDER BY id`
  )
  .all();
db.close();
console.log(`[rebuild] ${rows.length} messages from ${dbPath}`);

const auth = token ? { authorization: `Bearer ${token}` } : {};
let sent = 0;
for (let i = 0; i < rows.length; i += batchSize) {
  const recs = rows.slice(i, i + batchSize).map((r) => ({
    id: `${String(r.session_id).slice(0, 30)}#:t${r.turn_number}#m${r.message_index}`,
    turn: r.turn_number,
    msg_index: r.message_index,
    session_id: r.session_id,
    role: r.role,
    content: String(r.content).slice(0, 8000),
    created_at: r.created_at,
    tool_call_id: r.tool_call_id ?? null,
    tool_name: r.tool_name ?? null,
  }));
  const res = await fetch(`${url}/upsert`, {
    method: "POST",
    headers: { "content-type": "application/json", ...auth },
    body: JSON.stringify({ recs }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.ok === false) {
    console.error(`[rebuild] failed at row ${i}: ${body.error ?? `HTTP ${res.status}`}`);
    process.exit(1);
  }
  sent += Number(body.count ?? 0);
  console.log(`[rebuild] ${Math.min(i + batchSize, rows.length)}/${rows.length}`);
}

const stats = await fetch(`${url}/stats`, { headers: auth })
  .then((r) => r.json())
  .catch((e) => ({ error: String(e) }));
console.log(`[rebuild] done: pushed ${sent} records; mirror reports ${JSON.stringify(stats)}`);
