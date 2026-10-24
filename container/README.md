# Container mirror (Cloudflare Containers)

Runs the exact local mirror engine — ruvector VectorDB + agentdb
EmbeddingService (onnx MiniLM) — as a Cloudflare Container, so the harness
keeps its full stack while the sidecar lives off-machine. On-demand start,
sleep when idle, disk snapshots for persistence.

```
client (src/agentdb-mirror.ts)
  └─ HTTPS + bearer token ─▶ Worker (container/worker.ts)
                               └─ Durable Object "mirror"
                                    ├─ start / sleep / snapshot lifecycle
                                    └─ container :8080 (container/server.mjs)
                                         ├─ ruvector HNSW (disk: /data/agent-mirror.db)
                                         └─ onnx MiniLM   (baked into the image)
```

Only the Worker is network-exposed; the container port lives behind the
Durable Object. The image is `linux/amd64`, CPU-only, and fully offline
(`enableInternet: false`) — embeddings run inside the container.

**User scoping:** every record carries `user_id`; `/query` over-fetches and
drops hits from other logins. Records written before this field existed are
treated as `trgordonb`. `container/rebuild.mjs` joins `sessions.user_id` when
replaying the archive.

## Deploy

Prereqs: Workers **Paid** plan, Docker running locally (wrangler builds and
pushes the image), `npx wrangler login`.

```bash
# 1. stash the embedding model into the build context (repo root):
./container/pack-model.sh

# 2. build + deploy from this directory (first build is slow; later builds
#    reuse layers; the image is pruned to ~445MB — see "Image size" below):
npx wrangler deploy

# 3. the shared secret the Worker checks (after the first deploy):
npx wrangler secret put MIRROR_TOKEN      # paste e.g. `openssl rand -hex 32`
```

After the **first** deploy, wait several minutes — Cloudflare provisions the
container application before instances can serve traffic.

## Wire the local harness

`.env` in the repo root:

```ini
AGENTDB_REMOTE_URL=https://nm-finance-mirror.<your-subdomain>.workers.dev
AGENTDB_REMOTE_TOKEN=<the token from step 2>
```

`AgentDbMirror.initialize()` then probes `GET /status` (cheap; does **not**
start the container) and switches to the HTTPS transport. With
`AGENTDB_REMOTE_URL` unset it keeps spawning the local stdio sidecar,
unchanged. The first `recordTurn`/`search` after a sleep pays the cold start
(measured live: 46s on the very first start — one-time edge image pull — then
**3.1s** for snapshot-restore wakes; the client's request budget is 180s,
`AGENTDB_REQUEST_TIMEOUT_MS`).

## Endpoints (all JSON, all bearer-guarded)

| Endpoint | Notes |
|---|---|
| `GET /status` | worker-local: `running`, last snapshot, `dirty`; answers while asleep |
| `GET /health` | container: `{ok, ready, model, error}` |
| `GET /stats` | container: `{ok, records, stored, ready}` (`stored` = rows on disk) |
| `POST /init` | awaits engine load (idempotent; the client doesn't need it) |
| `POST /upsert` | `{recs:[record…]}` → `{ok, count}` (each record carries `user_id`) |
| `POST /query` | `{text, k, user_id}` → `{ok, hits}` (over-fetches, drops other users) |

## Lifecycle + persistence (the knobs you'll tune)

| Constant (`container/worker.ts`) | Value | Meaning |
|---|---|---|
| `WARM_MS` | 15 min | keep-warm window after the last request |
| `SNAPSHOT_DEBOUNCE_MS` | 5 s | settle time after the last `/upsert` before snapshotting |
| `READY_TIMEOUT_MS` | 150 s | model-load budget before the instance is torn down |
| `INSTANCE` | `standard-1` | ½ vCPU / 4 GiB / 8 GB disk |

- **On-demand:** nothing runs while idle; billing starts when a request needs
  the container and stops when it sleeps. `setInactivityTimeout(WARM_MS)`
  keeps bursts of turns on one warm instance.
- **Disk is ephemeral** on Cloudflare. The DO snapshots the writable root
  filesystem ~5s after upserts settle (`snapshotContainer()`), stores
  `{id, image, at}` in DO SQLite, and restores via `containerSnapshot` on the
  next boot. Snapshots: 20 GB max, 30-day TTL (refreshed by each restore),
  tied to the image they came from — after an image update the next boot
  starts fresh.
- **Rebuild fallback:** if a snapshot is missing/expired/mismatched, the
  mirror comes up empty; replay the archive:

  ```bash
  AGENTDB_REMOTE_URL=… AGENTDB_REMOTE_TOKEN=… node container/rebuild.mjs
  # optional first arg: path to sessions.db (default ./sessions.db)
  # REBUILD_BATCH=32 (default) — keep small on the ½-vCPU instance
  # REBUILD_START=<row> — resume after a timeout (the script prints progress)
  ```

  The script waits for `/health`, retries transient resets/429/5xx with
  backoff, and prints `N/1135` progress. A full replay takes ~14 minutes at
  batch 32 on `standard-1`; run it in `tmux`/`nohup` if your shell has a
  10-minute cap. Replaying is safe: same-id inserts are idempotent in the
  current ruvector build (re-pushing a batch did not grow the store).

- Prefer R2 over snapshots? Push `agent-mirror.db` to R2 on a debounce and on
  SIGTERM (the platform grants up to 15 min of grace), and restore it in the
  entrypoint. That also works with the stable `default` scheduling policy,
  but the flush is then yours to own.

## Image size & pruning

`wrangler deploy` builds the image locally and uploads every layer, so size
is deploy latency. The stock tree is ~1.1GB; `container/prune-node-modules.sh`
cuts it to a ~139MB install layer, plus the ~91MB model — final image
**≈443MB uncompressed**, of which ~230MB is the `node:24-slim` base (shared
and cached across deploys). The npm tarball cache is cleared in the same
step (~190MB otherwise). Prune + cache-clean run in the **same Docker layer**
as `npm ci` — deleting files in a later layer would leave their bytes inside
the earlier layer's blob anyway (whiteouts hide files from the merged view,
not from the registry).

Two traps encoded here:
- `sharp`/`@img` stay: transformers' node build imports sharp at load; when
  that import fails, agentdb silently falls back to **mock embeddings**
  (plausible vector shape, zero semantics). `server.mjs` probes
  related-vs-unrelated sentences at boot and refuses readiness on garbage.
- Validate any prune-list edit against a hardlink clone + the smoke test
  (recipe in the script header); the known-good ranking is
  `rate cuts` → the matching note on top at ≈0.76.

## Ops

```bash
npx wrangler containers list            # instance status
npx wrangler containers images list     # pushed images
npx wrangler tail nm-finance-mirror     # worker logs (observability is on)
```

- Costs at personal scale: sleep-first usage lands in the cents/month range
  on top of the $5 Workers Paid plan (included: 375 vCPU-min, 25 GiB-hr,
  200 GB-hr; then $0.00002/vCPU-s, $0.0000025/GiB-s, $0.00000007/GB-s, billed
  per 10 ms running). Keep-warm is the cost driver — leave `WARM_MS` modest.
- Health surface: `/status` reports `running`, the last snapshot, and — when
  running — the container's `/stats`.

## Gotchas

- `scheduling_policy: "durable_object"` is **public beta** (snapshots exist
  only there). If that's a problem, switch to `default` + R2 persistence.
- Image must be `linux/amd64`; `wrangler deploy` needs local Docker.
- Snapshot size is reported by `snapshotContainer()` on the first run —
  keep `node_modules`/model in image layers and the db in `/data`.
- The mirror stays **additive**: any remote failure degrades (client logs
  `agentdb mirror … degraded`) and the archive remains authoritative.
- A snapshot captures the writable root filesystem only — never memory or
  processes; a restored container runs its entrypoint again (which is fine:
  model + code are in the image).
