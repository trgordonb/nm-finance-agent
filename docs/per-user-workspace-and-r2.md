# Per-user workspaces, isolation, and R2 — deferred decision record

**Status:** **decided (2026-10-24)** — per-user **local folders** under
`WORKSPACE_DIR/<login-id>/`, implemented in `src/workspace.ts` (AsyncLocalStorage
scope, auto-created on SSO login). R2 remains backup-only; per-user containers
are still the isolation step if users become untrusted.
**Relates to:** [`docs/cloudflare-sandbox-compat.md`](./cloudflare-sandbox-compat.md) — the Cloudflare
Sandbox study, deferred in favour of a plain cloud VM.

This note exists so the decision can be picked up cold, months from now, without the
conversation that produced it. It records what was decided, what the real problem is, the
options, the recommendation, and the triggers that should force a revisit.

---

## TL;DR for future me

1. **R2 cannot be the live workspace.** It is a durable store, a backup, and a VM-to-VM handoff.
   The live workspace must be a real local filesystem (or block volume).
2. **Separating storage is not separating users.** The current workspace guard blocks *writes*
   only; reads are deliberately open. Two users on one process can read each other's files and
   the harness `.env` via `execute`.
3. **The chosen model is one local folder per SSO login id** under one process
   (implemented 2026-10-24). One container per user remains the target if users
   become untrusted or need real isolation.
4. **For a single user / trusted collaborators**, per-user directories under one process are
   enough hygiene for now, and the code change is ~40 lines (see §7).
5. **Per-user containers remain deferred**; the workspace decision is settled.

---

## 0. Implemented (2026-10-24)

- `src/workspace.ts` scopes every relative path with `AsyncLocalStorage`; the
  `/api` middleware sets it from `req.auth.username` (fallback `sub`), and the
  login route creates `WORKSPACE_DIR/<sanitised-id>/`.
- `WORKSPACE_USER` is the `AUTH_MODE=off` fallback (empty = flat root).
- `execute` exports `$WORKSPACE_DIR` and uses the scoped root as cwd; the system
  prompt names the absolute root; skills use `$WORKSPACE_DIR/...`.
- Migration: existing `workspace/` contents moved to `workspace/trgordonb/`.
- `sessions.db` now carries a `sessions` ownership table (legacy rows
  backfilled to `trgordonb` once; marker in `schema_meta`). List/load/search/
  research/followups are owner-filtered; a second login sees none of the old
  sessions. Still global: `memories/` (planned:
  [`per-user-memories-plan.md`](./per-user-memories-plan.md)),
  `state/users/<SKILLS_USER_ID>/`, and the `agentdb` MCP database. `execute`
  can read other users' folders in one process — local folders are path
  separation, not a security boundary.

## 1. Context and decisions already taken

| Decision | Status | Consequence for this note |
|---|---|---|
| `agent_browser` MCP skill | **discard** | Removes the one hard blocker to running the whole harness in a sandbox/container. |
| Skills registry (`uv` + sibling repo) | **re-haul planned** | Removes the other hard blocker; a future design can be container-friendly. |
| Authentication | **own OAuth2 implementation** | Multi-user is now a design goal; the workspace model must follow it. |
| Deployment target | **cloud VM** (not Cloudflare Sandbox for now) | Docker is available; no 6 h inactivity limits, no image-scoped snapshots, no 30-day TTL. |
| Cloudflare Sandbox | **deferred** | Revisit only if managed per-user isolation beats self-hosted Docker. See the sandbox doc. |

The rest of this note assumes: one Linux VM, Docker available, the harness runs as a Node
process (or one process per user), and OAuth2 will identify the user.

---

## 2. The actual problem: two independent axes

"Keep users' workspaces separate" hides two questions that have different answers:

| Axis | Question | Solved by |
|---|---|---|
| **Storage** | Where does each user's files live, and how do they survive a dead VM? | Local dirs / volumes + R2 |
| **Execution** | Can user A's agent process read user B's files or the host? | Containers / VMs / OS users |

R2 only answers the first. Buying storage separation and assuming it gives execution
separation is the trap.

### Why the current guard is not a boundary

`src/workspace.ts` says it explicitly:

> "Absolute paths stay allowed (single-user local agent reads real sources…). Read paths are
> never blocked: the guard is about _writes_, not visibility."

`WORKSPACE_HARD_JAIL=1` only changes the write guard. With one shared process:

```
execute: cat /srv/nm/.env
execute: cat /srv/nm/users/<other-user>/workspace/notes.md
read_file: /srv/nm/users/<other-user>/workspace/...
```

all succeed. `ToolContext` (`src/types.ts`) carries only `signal`; there is no user identity in
the tool layer at all. The session tables (`src/store.ts`) are keyed by `session_id` only —
no `user_id` column anywhere.

---

## 3. Options

### A. Status quo — one process, one workspace
No change. Correct only while the deployment is single-user.

### B. One process, per-user directories
`WORKSPACE_ROOT=/srv/nm/workspaces/<user_id>` resolved from the authenticated request.
Cheap (~40 lines), keeps one `sessions.db` with a future `user_id` column. **Hygiene, not
security**: `execute` escapes the jail by reading absolute paths.

### C. One container per user on the VM — **recommended target**
Each user gets a container with only their volume mounted:

```
/srv/nm/users/<uid>/data  →  /data   (workspace, sessions.db, memories, skills state)
docker run --cpus 2 --memory 3g --pids-limit 512 \
  -v /srv/nm/users/<uid>/data:/data \
  nm-agent:latest
```

- Real filesystem/process isolation; no cross-user reads; the host `.env` is not mounted.
- Each user owns their `sessions.db` → no multi-tenant migration of every table.
- `WORKSPACE_DIR=/data/workspace` stays a constant; the per-user path plumbing disappears.
- Resource limits per user are trivial.
- R2 becomes purely backup/restore.
- Same shape as the Cloudflare Sandbox blueprint, so a later move is a deployment change, not
  an app change.

Caveats:
- Docker shares the host kernel — strong for accidental/deliberate file access, not a
  hostile-tenant boundary (gVisor / Firecracker / per-user VM if that day comes).
- **Secrets:** if the whole harness runs inside each container, every user can read the shared
  LLM/search keys from `.env`. Acceptable for trusted users; for untrusted ones use per-user
  keys or a credential-injecting proxy (the `interceptOutboundHttps` pattern from the sandbox
  doc).
- N containers = N Node processes. The mirror can stay remote (`AGENTDB_REMOTE_URL`) so you
  don't pay ONNX memory per user.

### D. Per-user VM / Cloudflare Sandbox per user
The strongest boundary and the least ops only if someone else runs it. Overkill now; the
natural escalation from C when users become untrusted or numerous. Revisit the sandbox doc.

### E. R2 mounted as the live workspace
**Rejected.** See §4.

---

## 4. Why R2 is not a live filesystem

An agent workspace is a machine's scratch disk. `execute` runs `git clone`, `pip install`,
`npm install`, virtualenvs, SQLite, `mmap`, file locks, `rename`, symlinks, and permission
changes. Object-store FUSE mounts break or badly degrade all of them. Cloudflare's own Sandbox
docs state it directly for R2 mounts — "renames, locks, and permissions do not work as they do
on a local disk" — and point to snapshots for a continuing workspace.

- `s3fs` / `goofys`: not viable for this workload.
- `rclone mount --vfs-cache-mode full`: works, but it is a local cache with write-back. You
  have rebuilt "local disk + sync" with more failure modes and less control.
- Per-syscall latency to R2 makes `node_modules`/venv operations pathological.

### What R2 *is* good for

| Role | Verdict |
|---|---|
| Durable per-user store (`nm-workspaces/<uid>/…`) | ✅ |
| Backup / DR / restore points | ✅ |
| VM-to-VM handoff (hydrate a replacement host) | ✅ |
| Read-only shared datasets (market data, papers, PDFs) | ✅ (mount or download on demand) |
| Presigned browser uploads/downloads | ✅ |
| Live workspace | ❌ |

---

## 5. Recommended target architecture (option C)

```
browser
  │  OAuth2
  ▼
gateway (Caddy / oauth2-proxy / app-level)
  │  X-User-Id
  ▼
router (tiny: uid → container)
  ├── nm-agent-<uid>  ── volume /srv/nm/users/<uid>/data
  │      /data/workspace  /data/sessions.db  /data/memories
  │      AGENTDB_REMOTE_URL → existing Cloudflare mirror
  ├── nm-agent-<uid2> ── volume /srv/nm/users/<uid2>/data
  └── …
                 │
                 └── rclone / restic ──▶ R2  nm-workspaces/<uid>/
```

- **Gateway** terminates OAuth2 and is the only public surface.
- **Router** maps an authenticated user to a container (start on demand, stop when idle).
- **Volume** is the live workspace and DB. Local disk is fine; an attached block volume if the
  VM's root disk is small or ephemeral.
- **R2** holds backups and the migration copy. It is never in the request path.

If the whole per-user-container step is too much at first, option B is a valid intermediate —
just be explicit that it is not isolation.

---

## 6. Threat model cheat-sheet

| Threat | B (per-user dirs) | C (per-user container) | D (per-user VM/Sandbox) |
|---|---|---|---|
| Accidental cross-user write | ✅ (scoped root) | ✅ | ✅ |
| Deliberate cross-user read via `execute` | ❌ | ✅ | ✅ |
| Harness `.env` / host secrets read | ❌ | ⚠️ shared keys inside each container | ✅ (if keys stay outside) |
| Host filesystem / other processes | ❌ | ⚠️ shared kernel | ✅ |
| CPU / memory / fork-bomb exhaustion | ❌ | ✅ `--cpus --memory --pids-limit` | ✅ |
| Disk exhaustion | ⚠️ quota needed | ✅ volume quota | ✅ |

---

## 7. Implementation sketch (option B — the cheap intermediate)

Everything funnels through `resolveInWorkspace()`, so the change is small:

| File | Change |
|---|---|
| `src/config.ts` | add `WORKSPACE_ROOT` (defaults to today's `WORKSPACE_DIR`); create the root, not one dir, at boot |
| `src/workspace.ts` | `resolveInWorkspace()` reads the current root from `AsyncLocalStorage`; `guardWorkspaceWrite()` uses the same root; add `runInWorkspace(root, fn)` |
| `src/index.ts` | wrap `/api/chat` and `/api/uploads/wiki` in `runInWorkspace(rootFor(userId), …)`; uploads use the scoped root instead of `WORKSPACE_DIR` (line ~326) |
| `src/research/reports.ts` | replace the direct `WORKSPACE_DIR` use (line ~30) with the resolver |
| `src/tools/fs.ts`, `src/tools/shell.ts` | **no change** — both already go through `resolveInWorkspace` |
| `src/research/cli.ts` | no change — single-user CLI keeps the default root |
| `src/types.ts` | optional: add `userId` to `ToolContext` if tools ever need it directly |

Sketch:

```ts
// workspace.ts
const scope = new AsyncLocalStorage<{ root: string }>();

export function runInWorkspace<T>(root: string, fn: () => T): T {
  return scope.run({ root }, fn);
}

export function currentWorkspaceRoot(): string {
  return scope.getStore()?.root ?? WORKSPACE_DIR;
}

export function resolveInWorkspace(p: string): string {
  const root = currentWorkspaceRoot();
  const raw = String(p ?? "").trim();
  if (!raw) return root;
  return path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(root, raw);
}
```

For option C this whole layer is unnecessary — each container has one user and
`WORKSPACE_DIR=/data/workspace` is a constant again. That is one reason C is the better target:
it deletes a problem rather than adding a resolver.

---

## 8. R2 design, when it is needed

### Layout

```
nm-workspaces/
  <user_id>/
    workspace/…          # rclone tree mirror (incremental)
    state/               # sessions.db copy, memories, skills state
    snapshots/…          # restic repo, optional, weekly
```

Tree mirror vs archive: a tree is incremental and cheap to update, but one object per file
(10k files = 10k PUTs on first sync, ~$0.05; listings need `--fast-list`). A single
`tar.zst`/restic snapshot is one object and gives versioned restore points, but re-uploads
more. Pragmatic combo: **rclone for the hot mirror, restic weekly for history**.

### Commands (directional)

```bash
# hydrate (download) — never deletes local extras
rclone copy r2:nm-workspaces/$UID/workspace /srv/nm/users/$UID/data/workspace \
  --fast-list --transfers 8 --checkers 16

# snapshot (upload) — mirror, deletes files removed locally
rclone sync /srv/nm/users/$UID/data/workspace r2:nm-workspaces/$UID/workspace \
  --checksum --fast-list --transfers 8 --checkers 16 \
  --exclude 'node_modules/**' --exclude '.venv/**' --exclude '__pycache__/**' \
  --exclude '.cache/**' --exclude '*.log' --exclude 'repro_src/**'
```

### Timing and consistency

- **Quiesce first.** Sync only when no turn and no `execute` child is active (you already track
  `ACTIVE_TURNS`; add a per-user busy counter). A file caught mid-write is a torn file in R2.
- **When:** after a turn settles (debounced 60 s), on idle (5 min), on `SIGTERM`, and before a
  host migration. Not continuously.
- **SQLite:** never sync a live `sessions.db`. Use `node:sqlite`'s `backup()` into a checkpoint
  directory, then sync that.
- **Excludes are mandatory.** `workspace/repro_src` alone is 1.3 GB in this repo; without
  excludes every sync is minutes and most of the bytes are rebuildable.

### Multi-host safety (only if you ever run two VMs)

One writer per user. Either a row `workspace_leases(user_id, host, expires_at)` in the DB, or
an R2 conditional `PUT leases/<uid>` with `If-None-Match: *` (R2 supports conditional writes).
Acquire before hydrate, release on evict.

### Cost and latency

- Storage: $0.015/GB-month, **zero egress**. 10 users × 1 GB ≈ $0.15/month.
- Hydration: ~1 GB ≈ 8 s at 1 Gbps, ~80 s at 100 Mbps, ~2.7 min at 50 Mbps. Keep active
  users hot on local disk; hydrate cold users on demand.

---

## 9. Decision triggers — when to actually do this

Pick the option when any of these becomes true:

- OAuth2 ships and a **second human** uses the deployment → choose B or C (C if they are not
  fully trusted).
- The VM disk is **ephemeral** or the host can be replaced → R2 (or a block volume) becomes
  mandatory, not optional.
- A second VM is added, or users must be able to resume on another host → need a lease + R2.
- Any user is **untrusted** (public signup, contractor) → C minimum, D if hostile.
- A workspace exceeds ~5–10 GB or sync takes >2 min → move to a block volume; use R2 for
  backups only.
- Users ask for **restore points** ("go back to yesterday") → restic.
- Managed isolation becomes cheaper than running Docker yourself → revisit the CF Sandbox doc.

## 10. Open questions to settle at decision time

1. Does each user get their own **LLM keys** (billing boundary) or share the deployment's?
   This decides whether per-user containers can hold `.env` or need a credential proxy.
2. Is the VM's disk persistent and backed up? If not, R2 is on the critical path.
3. Do users need to **share** artifacts with each other? A read-only `shared/` prefix or R2
   presigned links is easier than cross-user filesystem access.
4. What is the per-user workspace quota, and what happens when it is hit?
5. Does the OAuth2 identity map 1:1 to a workspace (`sub` claim), or can one human have
   multiple workspaces (per-project)? This changes the key from `user_id` to `workspace_id`.

---

## 11. Appendix — measurements from this repo (2026-10-20)

| Thing | Value |
|---|---|
| `workspace/` | 1.3 GB, 1,097 files (`repro_src/` is 1.3 GB of it) |
| `sessions.db` + WAL | 3.3 MB + 4.2 MB |
| `agent-mirror.db` | 4.4 MB |
| `skills/` + `state/` + `memories/` | ~3.5 MB |
| Tool surface touching the workspace | `src/tools/fs.ts` (7 sites), `src/tools/shell.ts` (cwd), `src/index.ts` upload, `src/research/reports.ts` |
| Guard semantics | writes only; reads deliberately unguarded (`src/workspace.ts`) |
| Session schema | keyed by `session_id`; no `user_id` (`src/store.ts`) |
| `ToolContext` | `{ signal?: AbortSignal }` only (`src/types.ts`) |
