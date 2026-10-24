# Cloud upgrade: user-scoped workspace, sessions, memory, AgentDB, skills/MCP toggles

**Audience:** OpenCode agent running on the AWS EC2 instance (Amazon Linux 2023).
**Target:** `main` at **`32a7616`** or later (the user-scoping stack).
**What this is:** an **in-place upgrade** of the previously deployed app — not a
fresh install. Fresh-install steps live in `docs/vm-deployment-runbook.md`.

**Downtime:** one service restart; the migration itself is minutes. An optional
mirror replay can take ~15 minutes.

---

## 0. Agent contract

- Work top-to-bottom. Every section has a verification; **STOP** on a failed
  verification and report the command + last log lines.
- **Ask the user** (do not guess) for:
  1. confirmation that **`trgordonb` is the only legacy user with meaningful
     history** (see §11 — this is the one irreversible attribution choice);
  2. whether to install a shared `memories/_shared/MEMORY.md` (the user must
     `scp` it to `/tmp/nm-shared-MEMORY.md` first);
  3. whether `agent-browser` is installed/wanted on this VM;
  4. whether to replay the cloud archive into the existing remote mirror.
- **Never print secrets** (`AUTH_*`, `AGENTDB_REMOTE_TOKEN`, API keys). Use
  `grep ... | sed 's/=.*/=<set>/'`.
- **Do not** run `wrangler`/Docker on this VM: the remote mirror container was
  already deployed and rebuilt from the dev machine. This runbook does not
  touch it.
- **Do not** start the app between the data moves and the env update; the old
  code writes a flat layout and would recreate files in the wrong place.
- Record `PREV_COMMIT`, `TARGET_COMMIT`, backup path, and verification output
  in the final report.

---

## 1. Assumptions and variables

| Item | Value |
|---|---|
| App | `/opt/nm-finance-agent` |
| Data | `/var/lib/nm-finance-agent` |
| Env | `/etc/nm-finance-agent.env` |
| Service | `nm-finance-agent` |
| Code user | `deploy` |
| Service/data user | `nmagent` |
| Legacy owner | **`trgordonb`** (must match `LEGACY_SESSION_OWNER` in `src/store.ts`) |
| Auth | already `AUTH_MODE=sso`; `auth.db` is preserved |
| Skills CLI | already installed (`SKILLS_CLI`), bucket seeded |
| Remote mirror | already updated and populated; no deploy from this VM |

```bash
APP=/opt/nm-finance-agent
DATA=/var/lib/nm-finance-agent
ENV=/etc/nm-finance-agent.env
SVC=nm-finance-agent
LEGACY=trgordonb
```

The command blocks below re-declare the variables they need, so they can be run
one at a time in fresh shells. If a block refers to `$BK`, it re-reads the
backup path from `/var/backups/nm-finance-agent/LAST_PRE_USER_SCOPE`.

The paths above are the ones from `docs/vm-deployment-runbook.md`. Confirm
`SESSION_DB_PATH`, `WORKSPACE_DIR`, `MEMORY_DIR`, `SKILLS_DIR`, and
`SKILLS_STATE_DIR` in §2; if any points outside `$DATA`, **STOP** and adjust the
commands (or report the mismatch) before migrating anything.

If the cloud's primary login id is not `trgordonb`, **STOP**: the session
backfill constant is hard-coded to `trgordonb` and changing it is a code change,
not a migration step.

---

## 2. Preflight

```bash
APP=/opt/nm-finance-agent
DATA=/var/lib/nm-finance-agent
ENV=/etc/nm-finance-agent.env
SVC=nm-finance-agent
LEGACY=trgordonb

sudo systemctl is-active "$SVC"
sudo -u deploy git -C "$APP" status --short --branch
sudo -u deploy git -C "$APP" log -1 --format='%H %ci %s'
node -v
for c in sqlite3 jq tar curl; do command -v "$c" || echo "MISSING: $c"; done
df -h "$DATA" /opt

# confirm the env roots (redacted)
sudo grep -E '^(SESSION_DB_PATH|WORKSPACE_DIR|MEMORY_DIR|SKILLS_DIR|SKILLS_STATE_DIR|SKILLS_REQUIRED|MCP_SERVERS_FILE|AGENTDB_MCP_DIR|AGENTDB_REMOTE_URL|AUTH_DB_PATH)=' "$ENV" \
  | sed 's/=.*/=<set>/'

# skills CLI + mirror reachability (optional but useful)
sudo -u nmagent bash -lc '
  set -a; . /etc/nm-finance-agent.env; set +a
  if [ -n "${SKILLS_CLI:-}" ]; then
    "$SKILLS_CLI" doctor
  elif [ -n "${NM_SKILLS_REGISTRY_HOME:-}" ]; then
    uv run --directory "$NM_SKILLS_REGISTRY_HOME" nm-skills doctor
  else
    echo "ERROR: neither SKILLS_CLI nor NM_SKILLS_REGISTRY_HOME is set"
    exit 4
  fi
' | tail -5
sudo -u nmagent bash -lc '
  set -a; . /etc/nm-finance-agent.env; set +a
  if [ -z "${AGENTDB_REMOTE_URL:-}" ]; then echo "{\"mode\":\"local-sidecar\"}"; exit 0; fi
  curl -sS -m 20 -H "authorization: Bearer ${AGENTDB_REMOTE_TOKEN:-}" "$AGENTDB_REMOTE_URL/status"
' | jq .
```

**STOP** if:
- `git status` is dirty (stash/restore the user's changes first);
- `LEGACY` ≠ `trgordonb`;
- `sqlite3`, `jq`, `tar`, or `curl` is missing;
- free space on `$DATA` is < 5 GB;
- neither `SKILLS_CLI` nor `NM_SKILLS_REGISTRY_HOME` is configured, or
  `doctor` fails (the app boots with `SKILLS_REQUIRED=1` and will crash-loop);
- the remote mirror is unreachable **and** `AGENTDB_REMOTE_URL` is set (the app
  would degrade, but investigate before proceeding).

---

## 3. Stop and back up

```bash
APP=/opt/nm-finance-agent
DATA=/var/lib/nm-finance-agent
ENV=/etc/nm-finance-agent.env
SVC=nm-finance-agent

sudo systemctl stop "$SVC"
sudo systemctl status "$SVC" --no-pager || true
sudo pgrep -u nmagent -af 'agentdb mcp start|mirror-child' || true
```

If MCP/mirror children survive the stop, kill only the service user's:
`sudo pkill -u nmagent -f 'agentdb mcp start'` / `...mirror-child` — then
re-check `pgrep`.

```bash
APP=/opt/nm-finance-agent
DATA=/var/lib/nm-finance-agent

sudo install -d -m 700 /var/backups/nm-finance-agent
BK=/var/backups/nm-finance-agent/pre-user-scope-$(date +%Y%m%d-%H%M%S)
sudo install -d -m 700 "$BK"

# state/auth.db is deliberately excluded: it holds refresh tokens, is unchanged
# by this upgrade, and must not land in an unencrypted tarball. Do not delete it.
# /etc/nm-finance-agent.env is not backed up at all: it contains API keys and the
# SSO client secret. Only non-secret paths were changed by this upgrade.
sudo tar --ignore-failed-read --exclude='state/auth.db*' -czf "$BK/data.tgz" \
  -C "$DATA" sessions.db sessions.db-wal sessions.db-shm workspace memories state
sudo tar --ignore-failed-read -czf "$BK/config.tgz" \
  -C "$DATA" mcp_servers.json
sudo chmod 600 "$BK"/*

sudo -u deploy git -C "$APP" rev-parse HEAD | sudo tee "$BK/PREV_COMMIT"
echo "$BK" | sudo tee /var/backups/nm-finance-agent/LAST_PRE_USER_SCOPE
sudo du -sh "$BK"
```

**Acceptance:** `$BK/data.tgz` exists and is non-trivial in size; `PREV_COMMIT`
is recorded; the service is stopped. `auth.db` remains in place and is **not**
in the backup.

---

## 4. Update code and build

```bash
APP=/opt/nm-finance-agent
BK=$(sudo cat /var/backups/nm-finance-agent/LAST_PRE_USER_SCOPE)

sudo -u deploy git -C "$APP" fetch --tags origin
sudo -u deploy git -C "$APP" checkout main
sudo -u deploy git -C "$APP" pull --ff-only

TARGET=$(sudo -u deploy git -C "$APP" rev-parse HEAD)
echo "$TARGET" | sudo tee "$BK/TARGET_COMMIT"
sudo -u deploy git -C "$APP" merge-base --is-ancestor 32a7616 "$TARGET" \
  && echo "contains the user-scope stack" \
  || { echo "STOP: target does not contain 32a7616"; exit 3; }

sudo -u deploy npm --prefix "$APP" ci
sudo -u deploy npm --prefix "$APP/frontend" ci
sudo -u deploy npm --prefix "$APP/frontend" run build
sudo -u deploy npm --prefix "$APP" run check
sudo -u deploy npm --prefix "$APP" test
```

**Acceptance:** `npm run check` exits 0; tests report **162 passing** (or more);
`$APP/frontend/dist/index.html` exists.

**STOP** on any TypeScript/test failure. Do not touch production data yet.

---

## 5. Data migration

All data moves run as `nmagent` (the owner). The service is stopped.

### 5.1 Workspace → `workspace/trgordonb/`

```bash
sudo -u nmagent bash -s <<'EOF'
set -euo pipefail
DATA=/var/lib/nm-finance-agent
LEGACY=trgordonb
mkdir -p "$DATA/workspace"
cd "$DATA/workspace"

if [ -d "$LEGACY" ] && [ -n "$(find "$LEGACY" -mindepth 1 -print -quit)" ]; then
  echo "STOP: workspace/$LEGACY already exists and is not empty"; exit 3
fi
mkdir -p "$LEGACY"
find . -mindepth 1 -maxdepth 1 \
  ! -name "$LEGACY" \
  ! -name 'agentdb-mcp.db' ! -name 'agentdb-mcp.db-wal' ! -name 'agentdb-mcp.db-shm' \
  -exec mv -t "$LEGACY" -- {} +
EOF
```

Verify: `sudo find "$DATA/workspace" -mindepth 1 -maxdepth 1 -printf '%f\n'` →
only `trgordonb` (plus no stray files).

### 5.2 Memories → `memories/trgordonb/` + `_shared/`

```bash
sudo -u nmagent bash -s <<'EOF'
set -euo pipefail
DATA=/var/lib/nm-finance-agent
LEGACY=trgordonb
mkdir -p "$DATA/memories"
cd "$DATA/memories"

if [ -d "$LEGACY" ] && [ -n "$(find "$LEGACY" -mindepth 1 -print -quit)" ]; then
  echo "STOP: memories/$LEGACY already exists and is not empty"; exit 3
fi
mkdir -p "$LEGACY" _shared
if [ -s "_shared/MEMORY.md" ]; then
  echo "STOP: memories/_shared/MEMORY.md already has content; inspect/merge"; exit 3
fi

for f in MEMORY.md USER.md; do
  [ -e "$f" ] && mv "$f" "$LEGACY/"
done
EOF
```

Shared memory — **ask the user**:

```bash
DATA=/var/lib/nm-finance-agent
LEGACY=trgordonb
sudo install -d -o nmagent -g nmagent -m 755 "$DATA/memories/_shared"

if [ -s /tmp/nm-shared-MEMORY.md ]; then
  # The user scp'd the dev shared file.
  sudo install -m 444 -o nmagent -g nmagent /tmp/nm-shared-MEMORY.md "$DATA/memories/_shared/MEMORY.md"
else
  # Default: empty shared layer; ask the user before proceeding.
  sudo install -m 444 -o nmagent -g nmagent /dev/null "$DATA/memories/_shared/MEMORY.md"
fi

sudo chmod 700 "$DATA/memories/$LEGACY"
sudo chmod 600 "$DATA/memories/$LEGACY/MEMORY.md" "$DATA/memories/$LEGACY/USER.md" 2>/dev/null || true
```

If the user provides the dev shared file, warn that the old
`trgordonb/MEMORY.md` may duplicate project facts; the agent may leave it as-is
or ask the user to prune it. **Do not** auto-copy per-user memory into shared.

### 5.3 Skills toggles → `state/users/trgordonb/skills.json`

```bash
sudo -u nmagent bash -s <<'EOF'
set -euo pipefail
DATA=/var/lib/nm-finance-agent
LEGACY=trgordonb
mkdir -p "$DATA/state/users"
cd "$DATA/state/users"

if [ -f "default/mcp.json" ]; then
  echo "STOP: state/users/default/mcp.json exists (partial per-user deploy?)"; exit 3
fi
if [ -f "default/skills.json" ]; then
  if [ -f "$LEGACY/skills.json" ]; then
    echo "STOP: both default and $LEGACY skills.json exist; merge disabled arrays manually"; exit 3
  fi
  mkdir -p "$LEGACY"
  mv default/skills.json "$LEGACY/skills.json"
  rmdir default 2>/dev/null || true
fi
EOF
```

Per-user MCP overrides start empty: every user inherits the global
`mcp_servers.json` baseline.

### 5.4 Old global AgentDB MCP DB → `state/agentdb/trgordonb/`

The old config pointed at `workspace/agentdb-mcp.db`; check the known
candidates:

```bash
sudo -u nmagent bash -s <<'EOF'
set -euo pipefail
DATA=/var/lib/nm-finance-agent
LEGACY=trgordonb
TARGET="$DATA/state/agentdb/$LEGACY"
if [ -d "$TARGET" ] && [ -n "$(find "$TARGET" -mindepth 1 -print -quit)" ]; then
  echo "STOP: state/agentdb/$LEGACY already exists and is not empty"; exit 3
fi
mkdir -p "$TARGET"

CANDIDATES=(
  "$DATA/workspace/agentdb-mcp.db"
  "$DATA/state/agentdb-mcp.db"
  "$DATA/state/agentdb/agentdb-mcp.db"
  "$DATA/agentdb-mcp.db"
)
FOUND=()
for c in "${CANDIDATES[@]}"; do [ -f "$c" ] && FOUND+=("$c"); done
if [ "${#FOUND[@]}" -gt 1 ]; then
  echo "STOP: multiple legacy agentdb DBs:"; printf '  %s\n' "${FOUND[@]}"; exit 3
fi
if [ "${#FOUND[@]}" -eq 1 ]; then
  OLD="${FOUND[0]}"
  for ext in "" "-wal" "-shm"; do
    [ -f "$OLD$ext" ] && mv "$OLD$ext" "$TARGET/"
  done
fi

chmod 700 "$TARGET"
chmod 600 "$TARGET"/* 2>/dev/null || true
EOF
```

If the old DB is elsewhere, `sudo find "$DATA" -maxdepth 3 -name 'agentdb-mcp.db' -print`
and move it manually; do **not** move per-user DBs under
`state/agentdb/<user>/`.

The per-user MCP client initializes missing tables on connect, so an older
schema is acceptable.

### 5.5 Refresh the MCP config copy

The repo's `mcp_servers.json` now uses `${AGENTDB_MCP_DIR}` for the discovery
DB. The VM keeps its own copy in `$DATA`.

```bash
APP=/opt/nm-finance-agent
DATA=/var/lib/nm-finance-agent

# If the old data copy has custom servers not in the repo, STOP and merge.
if [ -f "$DATA/mcp_servers.json" ]; then
  EXTRA=$(comm -23 \
    <(sudo jq -r '.servers|keys[]' "$DATA/mcp_servers.json" | sort) \
    <(sudo jq -r '.servers|keys[]' "$APP/mcp_servers.json" | sort))
  if [ -n "$EXTRA" ]; then
    echo "STOP: custom MCP servers in the old data copy:"; printf '  %s\n' "$EXTRA"; exit 3
  fi

  # Refresh command/args/keep_tools from the repo, but preserve the old global
  # enable flags and per-server env (which may contain the user's credentials).
  sudo jq --slurpfile old "$DATA/mcp_servers.json" '
    .servers |= with_entries(
      .key as $k
      | .value.enabled = (
          if ($old[0].servers[$k].enabled != null)
          then $old[0].servers[$k].enabled
          else .value.enabled
          end
        )
      | .value.env = (($old[0].servers[$k].env // {}) + (.value.env // {}))
    )
    | .servers.agentdb.env.AGENTDB_PATH = "${AGENTDB_MCP_DIR}/_discovery/agentdb-mcp.db"
  ' "$APP/mcp_servers.json" | sudo tee "$DATA/mcp_servers.json.new" >/dev/null
else
  sudo jq '.' "$APP/mcp_servers.json" | sudo tee "$DATA/mcp_servers.json.new" >/dev/null
fi
if [ ! -s "$DATA/mcp_servers.json.new" ]; then
  echo "STOP: failed to build mcp_servers.json"; exit 3
fi
sudo mv "$DATA/mcp_servers.json.new" "$DATA/mcp_servers.json"

# Match the VM's browser policy (ask the user if unsure):
if ! sudo -u nmagent bash -lc 'command -v agent-browser' >/dev/null 2>&1; then
  sudo jq '.servers.agent_browser.enabled = false' "$DATA/mcp_servers.json" \
    | sudo tee "$DATA/mcp_servers.json.new" >/dev/null
  [ -s "$DATA/mcp_servers.json.new" ] && sudo mv "$DATA/mcp_servers.json.new" "$DATA/mcp_servers.json"
fi
sudo chown nmagent:nmagent "$DATA/mcp_servers.json"
sudo chmod 640 "$DATA/mcp_servers.json"
```

Verify the discovery path is the placeholder, not the old workspace path:

```bash
sudo jq '.servers.agentdb.env.AGENTDB_PATH' "$DATA/mcp_servers.json"
# expect "${AGENTDB_MCP_DIR}/_discovery/agentdb-mcp.db"
```

### 5.6 Ownership

```bash
DATA=/var/lib/nm-finance-agent
LEGACY=trgordonb

sudo chown -R nmagent:nmagent "$DATA/workspace" "$DATA/memories" "$DATA/state/users" "$DATA/state/agentdb"
sudo chmod 700 "$DATA/state/users/$LEGACY" "$DATA/state/agentdb/$LEGACY"
sudo chmod 600 "$DATA/state/users/$LEGACY"/* "$DATA/state/agentdb/$LEGACY"/* 2>/dev/null || true
```

---

## 6. Update the env file

Add/confirm only these keys; **do not** touch `AUTH_*`, `AGENTDB_REMOTE_*`,
API keys, or `SERVER_*`:

```bash
sudo bash -s <<'EOF'
set -euo pipefail
ENV=/etc/nm-finance-agent.env
DATA=/var/lib/nm-finance-agent
set_kv() {
  local k="$1" v="$2"
  if grep -q "^${k}=" "$ENV"; then
    sed -i "s|^${k}=.*|${k}=${v}|" "$ENV"
  else
    printf '%s=%s\n' "$k" "$v" >> "$ENV"
  fi
}
set_kv SHARED_MEMORY_CHAR_LIMIT 2000
set_kv AGENTDB_MCP_DIR "$DATA/state/agentdb"
set_kv MCP_SERVERS_FILE "$DATA/mcp_servers.json"
set_kv WORKSPACE_DIR "$DATA/workspace"
set_kv MEMORY_DIR "$DATA/memories"
set_kv SKILLS_DIR "$DATA/skills"
set_kv SKILLS_STATE_DIR "$DATA/state"
set_kv SKILLS_REQUIRED 1
EOF

sudo chmod 640 /etc/nm-finance-agent.env
sudo chown root:nmagent /etc/nm-finance-agent.env
sudo grep -E '^(SHARED_MEMORY_CHAR_LIMIT|AGENTDB_MCP_DIR|MCP_SERVERS_FILE|WORKSPACE_DIR|MEMORY_DIR|SKILLS_DIR|SKILLS_STATE_DIR|SKILLS_REQUIRED)=' /etc/nm-finance-agent.env
```

`AGENTDB_MCP_DIR` is also what `mcp_servers.json` interpolates; the app's config
publishes it at boot even if it is only set here.

---

## 7. Start the app (automatic session migration)

```bash
SVC=nm-finance-agent
sudo systemctl start "$SVC"
sleep 3
sudo systemctl status "$SVC" --no-pager
sudo journalctl -u "$SVC" -n 150 --no-pager
```

The new `SQLiteSessionStore` migration runs on boot:

- creates `sessions(session_id, user_id, created_at)` and `schema_meta`;
- backfills **all pre-existing sessions** to `trgordonb`;
- writes the one-time `session_owner_backfill` marker.

Look for `runtime assembled`, `skills sync — … N SKILL.md`, and no fatal
`Error:`/`FATAL:` lines. If the service exits with `SKILLS_REQUIRED=1`, fix the
skills CLI/bucket before continuing.

**Do not** restart repeatedly before verifying the marker — the marker is
idempotent, but a misread of the logs wastes time.

---

## 8. Verification

### 8.1 Sessions

```bash
DATA=/var/lib/nm-finance-agent
sudo -u nmagent sqlite3 "$DATA/sessions.db" \
  "select user_id, count(*) from sessions group by user_id order by user_id;"
sudo -u nmagent sqlite3 "$DATA/sessions.db" \
  "select count(*) as unowned from (select distinct session_id from turns where session_id not in (select session_id from sessions));"
sudo -u nmagent sqlite3 "$DATA/sessions.db" \
  "select key, value from schema_meta;"
```

Expected: all old sessions under `trgordonb`; `unowned = 0`;
`session_owner_backfill` present.

### 8.2 Paths

```bash
DATA=/var/lib/nm-finance-agent
sudo find "$DATA/workspace" -mindepth 1 -maxdepth 1 -printf '%f\n' | sort
sudo find "$DATA/memories" -mindepth 1 -maxdepth 2 -printf '%M %8s %p\n' | sort
sudo find "$DATA/state/users" -mindepth 1 -maxdepth 2 -printf '%M %8s %p\n' | sort
sudo find "$DATA/state/agentdb" -mindepth 1 -maxdepth 2 -printf '%M %8s %p\n' | sort
```

Expected:

```
workspace/trgordonb
memories/trgordonb/{MEMORY.md,USER.md}
memories/_shared/MEMORY.md (0444)
state/users/trgordonb/skills.json
state/agentdb/trgordonb/agentdb-mcp.db
state/agentdb/_discovery/agentdb-mcp.db   # boot-time discovery DB
```

No root `memories/MEMORY.md`, no `state/users/default`, no old
`workspace/agentdb-mcp.db`.

### 8.3 Health and mirror

```bash
curl -s http://127.0.0.1:3001/api/health \
  | jq '{auth, skills, skills_backend, mirror, memory_chars, shared_memory_chars, sessions}'
```

Expected: `auth.mode="sso"`, `skills > 0`, `skills_backend.degraded=false`,
`mirror.enabled=true`, `shared_memory_chars=1888` (or 0 if no shared file).

```bash
sudo -u nmagent bash -lc '
  set -a; . /etc/nm-finance-agent.env; set +a
  if [ -z "${AGENTDB_REMOTE_URL:-}" ]; then echo "{\"mode\":\"local-sidecar\"}"; exit 0; fi
  curl -sS -m 60 -H "authorization: Bearer ${AGENTDB_REMOTE_TOKEN:-}" "$AGENTDB_REMOTE_URL/status"
' | jq .
```

No mirror redeploy is needed. The remote `/status` may be asleep; `/stats`
wakes it. If `AGENTDB_REMOTE_URL` is unset, the app is using its local sidecar;
skip §9.

### 8.4 UI and per-user behavior (user-assisted)

Ask the user to:

1. Log in as **trgordonb** and confirm the old sessions, workspace artifacts,
   memory, and skill toggles are present.
2. Log in as a **new SSO user** and confirm:
   - sessions list is empty,
   - workspace is created under `workspace/<login-id>/`,
   - `memories/<login-id>/` is created on the first memory write,
   - skills default to enabled,
   - MCP defaults to the global baseline.
3. As that new user, disable one skill and one MCP server in Settings.
   Then verify:

```bash
DATA=/var/lib/nm-finance-agent
sudo find "$DATA/state/users" -maxdepth 2 \( -name 'skills.json' -o -name 'mcp.json' \)
sudo cat "$DATA/state/users/<new-id>/mcp.json"
```

   The other users' files must be unchanged, and the disabled MCP tools must
   disappear from the new user's next turn.
4. Run one turn as the new user; then check:

```bash
DATA=/var/lib/nm-finance-agent
sudo ls -la "$DATA/state/agentdb/<new-id>/"
sudo -u nmagent sqlite3 "$DATA/state/agentdb/<new-id>/agentdb-mcp.db" \
  "select name from sqlite_master where type='table' and name in ('episodes','skills','reasoning_patterns');"
```

   The per-user agentdb DB is created on first use and initialized by the
   client. No `no such table: episodes` in `journalctl`.

### 8.5 Frontend

Hard-refresh the browser (the asset hashes changed). The new MCP tab labels
servers “disabled for you” vs “globally disabled”, and the skills note says the
toggles are per-user.

---

## 9. Optional: replay the cloud archive into the remote mirror

The remote mirror was already rebuilt from the **dev** archive. The **cloud**
archive may contain turns that are not in it. This step is recommended if the
cloud has valuable old sessions; skip if not.

Run after the app has started (so `sessions` exists) and as `nmagent`:

```bash
sudo -u nmagent bash -lc '
  set -a; . /etc/nm-finance-agent.env; set +a
  if [ -z "${AGENTDB_REMOTE_URL:-}" ]; then echo "skip: AGENTDB_REMOTE_URL is unset (local sidecar)"; exit 0; fi
  cd /opt/nm-finance-agent
  REBUILD_BATCH=32 node container/rebuild.mjs /var/lib/nm-finance-agent/sessions.db
'
```

- Takes ~15 min for ~40 sessions on a small mirror; use `tmux`/`nohup`.
- On a shell timeout, resume with `REBUILD_START=<last completed row>`.
- The mirror is shared with the dev machine; records are keyed by `user_id`.
  Cloud turns become `trgordonb`'s (all legacy sessions were backfilled to it).
- `session_search` still double-checks local session ownership, so a user sees
  only semantic hits for sessions in this deployment's archive.

Verify with a `/query` for `trgordonb` and a second login; hits should be
tagged `userId` and must not cross users.

---

## 10. Rollback

If verification fails, restore the pre-upgrade state **and** the old code:

```bash
APP=/opt/nm-finance-agent
DATA=/var/lib/nm-finance-agent
ENV=/etc/nm-finance-agent.env
SVC=nm-finance-agent

sudo systemctl stop "$SVC"
BK=$(sudo cat /var/backups/nm-finance-agent/LAST_PRE_USER_SCOPE)
PREV=$(sudo cat "$BK/PREV_COMMIT")

sudo tar -tzf "$BK/data.tgz" >/dev/null || { echo "STOP: backup archive is unreadable"; exit 3; }

sudo -u deploy git -C "$APP" checkout "$PREV"
sudo -u deploy npm --prefix "$APP" ci
sudo -u deploy npm --prefix "$APP/frontend" ci
sudo -u deploy npm --prefix "$APP/frontend" run build

# Remove the migrated layout first; tar extraction alone would leave the new
# per-user dirs behind for the old global code to see.
sudo rm -rf "$DATA/workspace" "$DATA/memories" "$DATA/state/users" "$DATA/state/agentdb"
sudo rm -f "$DATA/sessions.db" "$DATA/sessions.db-wal" "$DATA/sessions.db-shm"

# restore data + configs; auth.db is preserved in place
sudo tar -xzf "$BK/data.tgz" -C "$DATA"
if [ -s "$BK/config.tgz" ]; then
  sudo tar -xzf "$BK/config.tgz" -C "$DATA"
else
  sudo cp "$APP/mcp_servers.json" "$DATA/mcp_servers.json"
  sudo chown nmagent:nmagent "$DATA/mcp_servers.json"
  sudo chmod 640 "$DATA/mcp_servers.json"
fi

# The env file was not backed up (secrets). The old code ignores the two new
# keys; if you want the old file shape, remove them:
sudo sed -i -E '/^(SHARED_MEMORY_CHAR_LIMIT|AGENTDB_MCP_DIR)=/d' "$ENV"

sudo systemctl start "$SVC"
```

The data tar is the **pre-migration flat layout**, so the old code sees its
files again. Do not roll back only the code: the old app would look at
`workspace/` and miss `workspace/trgordonb/`. `state/auth.db` is untouched, so
SSO sessions keep working; if they do not, log in again.

> **Warning:** this rollback discards anything written **after** the upgrade
> (new-user sessions, workspaces, memories, per-user AgentDBs). Export those
> first if they matter.

---

## 11. The one irreversible decision: legacy attribution

The code backfills **all** pre-scoping sessions to `trgordonb` (and the data
migration does the same for workspace, memories, skill toggles and the global
agentdb MCP DB). There is no per-turn owner data in the old archive, so it
cannot be reconstructed.

**Before §3, ask the user:**

> Was `trgordonb` the only login with meaningful history, or were other SSO
> users active on the old deployment?

- If **yes** (single user): proceed.
- If **no** (other real users): STOP. Options are:
  - accept that all old history becomes `trgordonb`'s (privacy/attribution
    issue), or
  - leave legacy sessions unowned/quarantined instead of backfilled (requires a
    code change plus a manual `sessions`/marker setup; not part of this
    runbook), or
  - restore the pre-upgrade backup and schedule a separate attribution project.

New users always start empty; only the legacy data is ambiguous.

---

## 12. Final report

Include:

```md
## Cloud user-scope upgrade — <date>
- Host / AMI:
- PREV_COMMIT / TARGET_COMMIT:
- Backup: <BK path>
- Sessions by owner: <sqlite output>
- Unowned sessions: 0
- Workspace/memories/state layout: verified
- Health: skills=N, degraded=false, mirror=..., shared_chars=...
- Trgordonb login: old data verified
- New login: empty sessions/workspace; shared memory only
- Skill toggle <name>: per-user file verified
- MCP toggle <name>: per-user file verified
- Agentdb per-user DB: tables/episodes verified
- Remote mirror: status/stats, user-scoped query
- Optional archive replay: skipped | rows pushed
- Deviations / open items:
```
