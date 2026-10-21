# Running the whole harness in a Cloudflare Sandbox — compatibility study

**Question:** can `nm-finance-agent` run *everything* — the Express/SSE harness, `sessions.db`,
skills, the mirror and the whole `workspace/` — inside a Cloudflare Sandbox (Containers,
Durable Object scheduling policy), with the Worker as the only public door?

**Date:** 2026-10-20 · **Platform docs read:** sandbox (concepts/lifetime, security, files,
commands, previews, coding-agents), containers (limits, pricing, DO API, snapshots,
scheduling policy, local dev), Workers limits. **Platform versions:** `@cloudflare/sandbox`
1.0.2, Wrangler 4.151.2.

**Status (2026-10-20):** study only — the decision was **deferred** in favour of a plain cloud
VM. The multi-user/workspace side is tracked separately in
[`per-user-workspace-and-r2.md`](./per-user-workspace-and-r2.md).

---

## TL;DR

**Yes, it is technically compatible — and this project is an unusually good fit** because it
already has: `SERVER_HOST`/`SERVER_PORT` env knobs, env-configurable data paths, zero native
deps in the main process, a stateless HTTP surface, an SSE heartbeat, and a working Cloudflare
Container deployment (`container/`) to copy the plumbing from.

**But "run everything" moves three problems from "solved" to "yours":**

1. **Persistence.** The container disk is deleted when the instance stops. The whole-workspace
   requirement means snapshot + R2 choreography, not a volume.
2. **Deploys.** A snapshot is tied to the image it was taken from. `wrangler deploy` with a
   rebuilt image invalidates the snapshot → next boot starts empty. The workspace and DB must
   be restorable from R2, or every deploy wipes the agent's world.
3. **Dev loop.** No `tsx watch`, no Vite HMR inside the sandbox: code changes mean an image
   rebuild (`wrangler dev` only hot-reloads the Worker, not the container).

Everything else is a checklist, not a blocker. The two items that will actually *break* rather
than degrade are the **`agent_browser` MCP server** (needs a Chrome/Chromium binary and a
browser profile in the image) and the **skills-registry bridge** (needs `uv` + the sibling
`../nm-skills-registry` repo).

Recommended posture: **the container is cattle, R2 is the source of truth, snapshots are only a
warm-start cache.** Adopt that and the design is clean. Skip it and you will lose the workspace
on a deploy or a 30-day idle.

---

## 1. The platform model that decides this

| Fact | Consequence for this project |
|---|---|
| A container is started by a Durable Object (`ctx.container.start()`); only the Worker is public. | Fits: the harness already expects one public HTTP origin. |
| `getTcpPort(port).fetch(request)` proxies HTTP, including streamed bodies, WebSockets. | Express/SSE is reachable as-is; server must bind `0.0.0.0`. |
| The instance lives while the **DO** is active (request / streamed response / WebSocket). `setInactivityTimeout()` ≤ **6 h**; the docs state no maximum *total* instance lifetime. | A 20–40 min `/research` SSE keeps it alive. Code running inside the container does **not**. Design for restarts regardless (deploys, runtime updates, crashes). |
| Stopping an instance deletes its disk. `snapshotContainer()` saves the writable root fs (not memory/processes, not mounts). | The workspace needs snapshots or R2. A restored container re-runs its entrypoint. |
| Snapshots are **tied to the image version**, TTL **30 days** (refreshed by restore), max 20 GB, created only under the `durable_object` policy. | Image rebuild ⇒ snapshot unusable ⇒ restore from R2. 30-day idle ⇒ restore from R2. |
| A pending DO alarm keeps the DO active; alarms are capped at **15 min wall time**. | Alarm is the right tool for "keep working while a background job runs" and for periodic backups. |
| `start({env})` env is visible to the main process only; `exec()` children get **only PATH** unless you pass `env`. | If the app is started with `exec`, pass the env explicitly. |
| Deploying a Worker restarts every DO; in-flight streams end. Runtime updates drain streams for up to **20 min**. | A deploy or a rare platform update can cut a long research run. The harness already marks runs `interrupted`. |
| `enableInternet: false` by default; `true` allows egress; `interceptOutboundHttps()` lets the Worker inject credentials. | LLM/search APIs need `enableInternet: true`, or intercepted egress with the keys kept in the Worker. |
| DO memory is 128 MB; stream, don't buffer. | Proxy returns the container `Response` untouched (the existing `container/worker.ts` already does this). |
| Instance sizes: `standard-1` ½ vCPU / 4 GiB / 8 GB; `standard-2` 1 vCPU / 6 GiB / 12 GB; `standard-3` 2 / 8 / 16. | 2.7 GB of repo+workspace fits `standard-1`; `standard-2` is the comfortable choice. |

Costs (Workers Paid, $5/mo, includes 25 GiB-h, 375 vCPU-min, 200 GB-h): see §6.

---

## 2. What has to fit (measured on this repo)

| Item | Size / shape | Notes |
|---|---|---|
| `node_modules` | **1.2 GB** | image layer; the mirror's prune script gets the install layer to ~139 MB |
| `frontend/` | 178 MB (`dist` exists) | build at image time, serve statically |
| `workspace/` | **1.3 GB / 1,097 files** (1.3 GB is `repro_src/`) | writable disk + backups |
| `sessions.db` (+ WAL) | 3.3 + 4.2 MB | SQLite, FTS5, WAL — consistent-copy problem |
| `agent-mirror.db` | 4.4 MB | ruvector/redb; or keep the existing remote mirror |
| `skills/` + `state/` + `memories/` | ~3.5 MB | writable disk |
| Harness | one Node 24 process, Express + SSE, `tsx` in devDeps | compiles cleanly with `tsc` (576 KB `dist`) |
| External I/O | OpenRouter, Tavily, Jina, Exa, LangSmith, Yahoo, llmwiki, MCP | egress + one localhost dependency (llmwiki) |

Turn shape: a normal turn is seconds-to-minutes; `/research` is **20–40 min** with an SSE
heartbeat every 20 s (good — it doubles as a keep-alive through the proxy).

---

## 3. Target architecture (lift-and-shift)

```
browser
  │  HTTPS (+ Cloudflare Access or bearer)
  ▼
Worker  ──auth──▶  DO "agent"  ──proxy :3001──▶  container (standard-2, 12 GB)
                     │                              ├─ /app   (image: code, deps, frontend/dist)
                     ├─ snapshot ref (DO SQLite)     ├─ /data  (writable: db, workspace, skills…)
                     ├─ R2 backup records            └─ /data/logs/app.log
                     └─ alarm: checkpoint / backup
                          │
                          └─ R2 bucket (durable source of truth)
```

**Lifecycle in the DO**

```
on request:
  if !container.running:
      snap = storage.snapshot, valid only if snap.image == images.base
      start({ image | containerSnapshot, instance: "standard-2",
              enableInternet: true, env: {...} })
      setInactivityTimeout(10–30 min)          # post-turn work window
      monitor()                                # restart/observability
      if started from image and R2 backup exists:
          DirectoryBackup.restore(/data)       # new image / expired snapshot
      exec(setsid node /app/dist/index.js > /data/logs/app.log, { env })
      poll GET /api/health until 200
  proxy request → container:3001
  if path mutates (chat/research/uploads/skills):
      markDirty → alarm(+60 s)
alarm:
  POST /internal/checkpoint   # app writes a consistent DB copy into /data/checkpoint
  DirectoryBackup.backup(/data/checkpoint)     # small, consistent
  every N min: DirectoryBackup.backup(/data/workspace) with excludes
  snapshotContainer()                          # warm-start cache, best effort
```

**Data layout**

```
/app     read-only image       dist/  node_modules/  frontend/dist/  sandbox-shim
/data    writable (8–16 GB)    sessions.db  agent-mirror.db  workspace/  skills/
                               state/  memories/  logs/  checkpoint/
```

Env (all already supported by `src/config.ts`):

```ini
SERVER_HOST=0.0.0.0          # required: getTcpPort cannot reach 127.0.0.1
SERVER_PORT=3001
SESSION_DB_PATH=/data/sessions.db
WORKSPACE_DIR=/data/workspace
SKILLS_DIR=/data/skills
SKILLS_STATE_DIR=/data/state
MEMORY_DIR=/data/memories
AGENTDB_PATH=/data/agent-mirror.db
WORKSPACE_HARD_JAIL=1        # the container is now a security boundary
```

**Deploy flow** (the one process that must become a habit):

```
curl -X POST https://<worker>/admin/checkpoint   # DO → app → sqlite backup → R2
npx wrangler deploy
# first request: image changed → restore /data from R2 → start app
```

**Why the app is a child process, not the entrypoint:** a restored container re-runs its
entrypoint *before* the DO can restore `/data`. If Express is the entrypoint it opens
`sessions.db` before the restore and keeps using the replaced inode (documented behaviour of
`DirectoryBackup.restore()`). Entrypoint `sleep infinity` + DO-driven restore + `exec` of the
app avoids that. Use the `setsid` recipe from the "run a server in the background" docs.

---

## 4. Compatibility matrix

| Subsystem | Today | In the sandbox | Verdict | Work |
|---|---|---|---|---|
| Node 24 runtime | `tsx src/index.ts` | `tsc` emit verified (`576 KB dist`); or keep `tsx` in prod | ✅ | change `mirror-child` spawn to `node dist/mirror-child.js` |
| Express REST | binds `127.0.0.1:3001` | `SERVER_HOST=0.0.0.0` already supported | ✅ | env only |
| SSE `/api/chat`, `/research` | `res.write` + 20 s heartbeat | proxied body stream; DO duration unlimited | ✅ *(smoke-test)* | none |
| Turn cancel | second request, same process | concurrent requests to the same DO | ✅ | none |
| Frontend | Vite dev server + `/api` proxy | relative `/api` paths; `dist` exists | ✅ | ~15 lines static + SPA fallback in Express |
| `node:sqlite` + FTS5 + WAL | Node 24 built-in | same Node build in `node:24-slim`; verify FTS5 | ✅ | boot assertion |
| Workspace paths | cwd-relative defaults | env vars already exist | ✅ | env only |
| 1.3 GB workspace | local disk | 8 GB (`standard-1`) tight → 12 GB (`standard-2`) | ✅ | size choice |
| Persistence | disk | **ephemeral**; snapshot + R2 | ⚠️ | checkpoint/restore layer |
| Deploy / image update | `npm start` restart | snapshot invalidated by image | ⚠️ | startup restore path |
| Post-turn work (titler, followups, nudge, mirror upsert) | in-process, after SSE | needs inactivity window ≥ work time | ⚠️ | `setInactivityTimeout(10–30 min)` |
| `nohup` background jobs (`execute`) | survive indefinitely | killed when the instance sleeps | ⚠️ | keep-alive alarm while jobs run |
| `npm run research` CLI | host shell | no HTTP activity → instance sleeps | ⚠️ | run via `exec`/SSH + alarm, or drive it over HTTP |
| Mirror sidecar (ruvector + ONNX) | local stdio sidecar | runs in-container (already proven) **or** keep `AGENTDB_REMOTE_URL` | ✅ | prefer remote: smaller image, no natives |
| MCP `agentdb`, `luxalgo` | stdio / `npx -y` | need npm cache or global install at build | ✅ | bake the cache |
| MCP `agent_browser` | local Chrome + session | needs a Chrome/Chromium binary + profile in the image; the "local session" assumption breaks | ❌ | disable or re-implement headless |
| Skills registry | `uv run` + `../nm-skills-registry` | sibling repo absent, `uv` absent | ⚠️ | vendor or accept local-only mode |
| llmwiki | `http://127.0.0.1:8010` | localhost is the container | ⚠️ | point at the deployed llmwiki |
| Secrets | `.env` on disk | `start({env})`; agent can `cat` them either way | ⚠️ | Access + optional egress injection |
| **Auth** | none; binds loopback | public workers.dev = open shell + keys | ❌ **until fixed** | Cloudflare Access or bearer gate |
| Dev loop | `tsx watch` + Vite HMR | image rebuild (`r` in `wrangler dev`) | ⚠️ DX | keep local dev; sandbox for prod |
| Logs | stdout | `wrangler tail` / container logs | ✅ | — |
| Deploy during a run | keeps running | streams end, DO restarts | ⚠️ | accept; runs already marked `interrupted` |

Legend: ✅ compatible · ⚠️ compatible with design work · ❌ blocker for that subsystem.

---

## 5. Sharp edges, in the order they will bite

1. **`wrangler deploy` + image + snapshot.** The single most important constraint. With the
   `durable_object` policy the image is part of the Worker version; snapshots are
   image-scoped. Treat R2 as authoritative and the snapshot as a cache, or the first code
   deploy silently empties the workspace. The existing `container/README.md` already documents
   this for the mirror ("after an image update the next boot starts fresh") and ships
   `rebuild.mjs`; the harness needs the equivalent, but with real user data.

2. **SQLite consistency.** A filesystem snapshot of a live WAL database is *probably* fine
   (crash-consistent), but `DirectoryBackup` explicitly warns that a file changing during a
   backup can be saved half-old/half-new. Do **not** back up `sessions.db` that way. Use
   `node:sqlite`'s `backup()` (available in Node 24: the module exports `backup`) into
   `/data/checkpoint/`, then back up that directory. Verify one restore end-to-end before
   trusting it.

3. **Background work vs sleep.** "Code that runs inside the instance does not count as
   activity." The titler/followups/nudge/mirror-upsert run *after* the SSE closes; a 10–30 min
   inactivity window covers them. Agent-launched `nohup` jobs (backtests, downloads) do not —
   either arm a 1-minute alarm while a job registry says work is pending, or accept that long
   jobs die at idle.

4. **Auth.** There is no auth in the harness today because it binds loopback. Lifting it to
   `*.workers.dev` publishes an agent with `execute` and LLM keys. Put it behind Cloudflare
   Access (free tier is enough for one user) or a bearer token checked in the Worker, and set
   `WORKSPACE_HARD_JAIL=1`.

5. **Secrets.** With the whole harness in the box, OpenRouter/Tavily/Jina/LangSmith keys must
   live in the container, and the agent can read them (`execute` + absolute paths). That is
   already true locally, but the blast radius changes once the box has internet egress.
   Options: `interceptOutboundHttps()` on each API host and inject the key in the Worker (keeps
   keys out of the sandbox; needs the container to trust the platform CA), or accept the status
   quo and rely on the VM boundary.

6. **Cold start.** Their measured numbers: first-ever start 46 s (edge image pull), snapshot
   restore **3.1 s**. Add Node boot, SQLite open, MCP `npx` assembly, optional skills sync:
   expect ~5–15 s warm, ~30–60 s cold. The UI should not assume instant responses; the
   frontend already tolerates a slow first event.

7. **Image size → deploy latency.** Their 443 MB mirror image takes ~2m13s to upload. A harness
   image with pruned deps + frontend + Python tooling can reach 0.7–1.5 GB. Keep code in a
   thin layer, bake dependencies, prune aggressively (`container/prune-node-modules.sh` is a
   good starting point), and expect minutes per deploy.

8. **The 15-minute alarm cap.** A snapshot copies the writable layer (not the image), but at
   2–3 GB it may still be slow; the alarm that triggers it is capped at 15 min. Keep `/data`
   lean, snapshot on a debounce rather than every turn, and treat failure as non-fatal (the R2
   backup still stands).

9. **`exec()` env.** If the app is launched with `exec`, it gets only `PATH`. Pass the full env
   map explicitly, or launch via a wrapper script that reads `/data/env` (not the image).

10. **`tsx` in prod.** `agentdb-mirror.ts` spawns `node_modules/.bin/tsx src/mirror-child.ts`.
    `npm ci --omit=dev` removes it. Compile with `tsc` and spawn `node dist/mirror-child.js`,
    or keep `tsx` as a prod dependency.

---

## 6. Cost model

Rates: memory $0.0000025/GiB-s, CPU $0.00002/vCPU-s, disk $0.00000007/GB-s, egress 1 TB
included (North America/Europe; 500 GB elsewhere). Included monthly: 25 GiB-h, 375 vCPU-min,
200 GB-h. CPU is billed on **active** use only; the table assumes 25 % of provisioned vCPU
while running (I/O-bound workload).

| Hours running / month | standard-1 (4 GiB) | standard-2 (6 GiB) | standard-3 (8 GiB) |
|---|---|---|---|
| 60 h (~2 h/day) | $2.10 | $3.78 | $6.00 |
| 120 h (~4 h/day) | $4.92 | $8.28 | $12.72 |
| 240 h (~8 h/day) | $10.56 | $17.28 | $26.16 |
| 730 h (24/7) | $33.60 | $54.04 | $81.06 |

Plus the $5 Workers Paid plan (already paid for the mirror) and R2 storage (~$0.015/GB-month;
1.3 GB × a handful of backups is cents). Keep-warm dominates: every idle hour at 6 GiB costs
≈ $0.054. Set `WARM_MS`/`setInactivityTimeout` to the shortest window that still covers
post-turn work.

For comparison: a small always-on VPS (2 vCPU / 4 GB) is ~$5–12/month. Cloudflare wins on
sleep-to-zero and isolation; it loses on price if you keep it warm 24/7, and on DX.

---

## 7. Alternatives (and when they win)

**A. Full lift-and-shift — this document.** One container holds harness + workspace + DB.
Cheapest code path (the app barely changes), best "one disposable machine" story, remote access
for free. Cost: persistence/deploy choreography, heavy deploy loop, browser MCP dies.

**B. Split executor — harness stays home, only `execute`/fs in a sandbox.** The harness keeps
`sessions.db`, secrets and SSE locally; a `sandbox` transport routes `execute` and the fs tools
to a container that owns the workspace. Much better security (keys never enter the sandbox) and
no DB-persistence problem at all. Cost: every fs tool becomes a remote call
(`src/tools/fs.ts` is 366 lines, `shell.ts` 142), plus a container API with streaming and
cancel. ~2–4 days more code than A, but far less ops risk. **This is the better long-term
architecture if the motivation is isolation rather than remote hosting.**

**C. Hybrid — harness in the container, mirror stays remote, workspace on R2 mount.** Keeps the
image small. But R2 mounts have no POSIX locks/renames and the docs warn about SQLite-style
usage, so the DB still needs the checkpoint path. Not simpler than A.

**D. Do nothing / VPS.** A $6 VPS runs the current stack unchanged, with a real disk and
`tsx watch`. If the only goal is "not on my laptop", this is the rational baseline.

---

## 8. Recommendation

**Go with A, but stage it, and treat the sandbox as disposable from day one.** The project is
compatible enough that the risky part is operations, not code; a one-day spike answers the two
questions that matter (SSE through the port proxy, and snapshot/restore of a 2–3 GB `/data`).

### Phase 0 — spike (0.5–1 day)
- Dockerfile: `node:24-slim`, `npm ci`, `tsc`, `frontend build`, `sandbox-shim`, `sleep infinity`.
- Minimal Worker/DO (adapt `container/worker.ts`): start, `getTcpPort(3001)` proxy, `/api/health`.
- Verify: boot time, `GET /api/health`, a chat turn streaming through the Worker, a 40-min
  `/research` surviving, `execute` writing to `/data/workspace`.
- **Kill criteria:** SSE buffers or stalls; snapshot/restore of 2–3 GB takes >2 min.

### Phase 1 — MVP (2–3 days)
- App changes: static frontend + SPA fallback; `/internal/checkpoint`; SIGTERM handler;
  compiled `mirror-child` spawn; `WORKSPACE_HARD_JAIL=1`.
- DO: readiness poll, `setInactivityTimeout(15 min)`, snapshot-on-debounce, `monitor()`.
- Auth: Cloudflare Access in front (or bearer gate in the Worker).
- Env via `start({env})`; no `.env` in the image.

### Phase 2 — durability (2–3 days)
- R2 bucket + `DirectoryBackup` (needs `@cloudflare/sandbox` 1.0.x, `nodejs_compat`,
  `DirectoryBackupGateway`, `sandbox-shim` in the image).
- `/internal/checkpoint` → `node:sqlite` `backup()` → `/data/checkpoint` → R2.
- Image-change detection → restore-before-start; `admin/checkpoint` endpoint; deploy wrapper.
- Alarm keep-alive for long background jobs (job registry).

### Phase 3 — hardening (2–4 days)
- Egress: either `enableInternet: true` with keys in the container (accept), or
  `interceptOutboundHttps()` for OpenRouter/Tavily/Jina/LangSmith (better).
- MCP: bake the npm cache; disable `agent_browser` or replace with headless Chromium.
- Skills: vendor `nm-skills-registry` + `uv`, or run in local-only mode.
- Point `WIKI_API_URL` at the deployed llmwiki.
- Cost/keep-warm tuning; logs; a restore drill in CI.

**Total: ~5–10 focused days.** Phase 0 alone tells you whether to continue.

### Acceptance tests (write these before Phase 1)
1. Cold boot from image < 60 s; snapshot wake < 10 s.
2. `POST /api/chat` streams tokens through the Worker; abort mid-turn works.
3. 40-min `/research` completes; the DO stayed active; report saved.
4. Kill the container mid-turn → restart → `GET /api/sessions` intact, run marked `interrupted`.
5. `execute` runs a Python script; output lands in `/data/workspace`.
6. Deploy a new image → `/data` restored from R2, sessions + workspace intact.
7. Sleep 30 min → wake → data intact; 31-day-old snapshot → R2 fallback works.
8. Two tabs: concurrent chat + cancel.
9. Unauthenticated request is rejected.
10. One week of real use: cost within the §6 estimate.

---

## 9. Open questions for the spike

- Does `getTcpPort().fetch()` forward SSE chunks without buffering, both to a browser and
  through a `*.workers.dev` hostname? (Expected yes; the docs' proxy examples and DO duration
  limits allow it, but there is no explicit SSE-through-port example.)
- Does the official `node:24-slim` SQLite build include FTS5? (Host Node 24.13 does; assert at
  boot either way.)
- How long does `snapshotContainer()` take for ~2–3 GB, and does it stay under the 15-min
  alarm cap?
- How long does `DirectoryBackup` of the 1.3 GB workspace (with caches excluded) take, and what
  does it compress to?
- Does npm/npx MCP assembly still boot acceptably with the npm cache baked in?
- What does `wrangler deploy` do to image digests when only the Worker changed — is the
  snapshot reliably invalidated? (Assume yes; measure.)
