# Cloud VM deployment runbook (AWS EC2 · Amazon Linux 2023)

**Audience:** an OpenCode agent running **on the target EC2 instance**, inside a
clone of `https://github.com/trgordonb/nm-finance-agent` (`main`; this runbook
was added in `bced3ed`).
**Target OS:** Amazon Linux 2023 (AL2023, `dnf`). AL2 differences are called out
in §4; do not mix the two package managers.
**Goal:** a single-user, internet-reachable deployment with HTTPS/auth, the R2
skills registry live, the AgentDB mirror remote, and backups.

**Status:** 2026-10-22. The app is single-user until OAuth2 lands; the interim
auth is Cloudflare Access (or Caddy basic auth). Per-user containers are
deliberately out of scope — see `docs/per-user-workspace-and-r2.md`.

---

## 0. How to use this runbook (agent contract)

Work top-to-bottom. Every task has an ID, commands, an acceptance check, and
sometimes a **STOP** condition.

- **Ask the user, never guess**, for: domain/DNS, auth method, secrets, whether
  to migrate existing data, whether to install optional components.
- **Never print secret values.** Redact with `sed 's/=.*/=<redacted>/'`.
  Never `cat` `/etc/nm-finance-agent.env`.
- **Never expose port 3001.** It must stay on `127.0.0.1`; only the reverse
  proxy is public.
- **Do not run the app as root.** It runs as `nmagent`.
- **Do not commit** `.env`, `/etc` files, databases, or `skills/`.
- **Do not disable auth** to "make it work". If auth blocks you, stop and ask.
- **Stop and report** if a command fails: include the command, exit code, and
  `journalctl -u <unit> -n 100 --no-pager` where relevant.
- If `sudo` prompts for a password, ask the user to run that command or unlock
  the session. Never store or echo the password.
- Prefer idempotent commands (`install -d`, `systemctl enable --now`).
- Record every deviation from this runbook in the final handover report.

Companion docs (read, don't duplicate):

| Doc | Why |
|---|---|
| `CLAUDE.md` | contracts, env vars, architecture |
| `docs/skills-registry-deploy.md` | full skills registry detail (§5A/§5B there) |
| `container/README.md` | the already-deployed remote AgentDB mirror |
| `docs/per-user-workspace-and-r2.md` | deferred multi-user design |
| `docs/cloudflare-sandbox-compat.md` | why this is a VM, not CF Sandbox |

---

## 1. Target architecture

```
Internet
  │  HTTPS + Cloudflare Access (or Caddy basic auth)
  ▼
cloudflared tunnel  ──▶  Caddy 127.0.0.1:8080
                           ├─ /            frontend/dist (SPA fallback)
                           └─ /api/*       reverse_proxy 127.0.0.1:3001 (SSE flush)
                                                  │
                                          nm-finance-agent (nmagent)
                                                  ├─ /opt/nm-finance-agent        code + node_modules + dist
                                                  ├─ /var/lib/nm-finance-agent    db, workspace, skills, state, memories
                                                  ├─ $SKILLS_CLI                  nm-skills (uv tool, v0.1.7)
                                                  └─ R2                           skills authority + backups
```

**Why Caddy serves the frontend:** Express has no static handler. The Vite dev
server is dev-only. Caddy serves `frontend/dist` and proxies `/api/*`, so the
browser's relative `/api/...` URLs keep working same-origin.

**Why the app is not the TLS terminator:** it binds `127.0.0.1:3001` and has no
auth yet. The proxy is the only public surface.

---

## 2. Inputs to collect before touching anything

Ask the user for these; write the answers into the handover report.

| Input | Default / notes |
|---|---|
| Repo URL | `https://github.com/trgordonb/nm-finance-agent.git` |
| Ref to deploy | `main` (latest; this runbook was added in `bced3ed`) |
| AMI / OS | Amazon Linux 2023 (x86_64); record the AMI ID |
| Instance type | `t3.medium` minimum (2 vCPU / 4 GiB); `t3.large` (2 / 8) recommended |
| Root + data EBS | root ≥ 30 GB gp3; `/var/lib` on a separate ≥ 60 GB volume if possible |
| Region / AZ | record it (backups and latency) |
| Security Group | inbound 22 from your IP; 80/443 only for public Caddy; **never** 3001/8080 |
| `APP_DIR` | `/opt/nm-finance-agent` — **not** a home directory |
| `DATA_DIR` | `/var/lib/nm-finance-agent` |
| Domain | e.g. `agent.example.com` (or "LAN only") |
| Auth | Cloudflare Access (recommended) / Caddy basic auth / none (LAN only) |
| Tunnel vs public IP | Tunnel if a domain is on Cloudflare; otherwise Caddy + TLS + Elastic IP |
| Secrets | the user's existing `.env` (never recreate from memory) |
| Skills bucket seeded? | must be **yes** before first boot (T4 + §8 preflight) |
| Data migration? | yes/no; if yes, user must provide the files |
| Mirror | remote `AGENTDB_REMOTE_URL` (recommended) or local sidecar |
| llmwiki | remote `WIKI_API_URL` (the existing CF service) or local Docker |
| agent-browser | disabled unless the user explicitly asks for Chromium |
| VM size | `nproc`, `free -h`, `df -h` — record them |

**STOP** if the user cannot provide the secrets or a seeded skills bucket.
Continue with the baseline while they gather them, but do not start the app.

---

## 3. Pre-flight on the dev machine (user-assisted, not on the VM)

Confirm these before the VM boots the app:

```bash
# 1. the commit is on GitHub (run on the dev machine)
git -C ~/projects/nm-finance-agent push origin main
git -C ~/projects/nm-finance-agent status --short --branch   # main...origin/main, clean

# 2. the skills bucket has the corpus (one-time; safe to re-run)
uv run --directory ~/projects/nm-skills-registry nm-skills doctor
uv run --directory ~/projects/nm-skills-registry nm-skills import skills
```

If migrating data, the user should stop the local server first, then copy
`sessions.db*`, `workspace/`, `memories/`, `state/` (§9).

---

## 4. T1 — VM baseline (Amazon Linux 2023)

```bash
# OS + time
cat /etc/os-release          # expect Amazon Linux 2023
sudo timedatectl set-timezone UTC
sudo dnf upgrade --refresh -y
# if the kernel/glibc updated, reboot before continuing (ask the user)

# core tools (AL2023 ships curl-minimal; do NOT `dnf install curl` — it conflicts)
sudo dnf install -y git jq unzip tar xz rsync bzip2 \
  gcc gcc-c++ make python3.11 python3.11-pip ca-certificates \
  dnf-automatic
sudo dnf install -y sqlite || sudo dnf install -y sqlite3 \
  || echo "sqlite CLI unavailable — install it before T10"
sudo dnf install -y ripgrep || echo "ripgrep unavailable — optional (harness grep is JS-based)"

# Node 24 — official tarball into /usr/local (no NodeSource/apt repo on AL2023)
NODE_VERSION=24.13.0         # check https://nodejs.org/dist/latest-v24.x/
curl -fsSLO "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz"
sudo tar -xJf "node-v${NODE_VERSION}-linux-x64.tar.xz" -C /usr/local --strip-components=1
rm "node-v${NODE_VERSION}-linux-x64.tar.xz"

# uv (skills CLI)
curl -LsSf https://astral.sh/uv/install.sh | sudo env UV_INSTALL_DIR=/usr/local/bin sh

# automatic security updates (AL2023 equivalent of unattended-upgrades)
sudo sed -i 's/^apply_updates = no/apply_updates = yes/' /etc/dnf/automatic.conf
sudo systemctl enable --now dnf-automatic.timer

node -v && command -v node   # /usr/local/bin/node, v24.x
npm -v  && command -v npm    # /usr/local/bin/npm
uv --version
python3.11 --version
sqlite3 --version
```

**Acceptance:** `node -v` starts with `v24.` and `command -v node` is
`/usr/local/bin/node`; `npm` resolves to `/usr/local/bin/npm`; `uv`, `jq`,
`sqlite3`, `git` are present. **STOP** if Node is older; do not continue with
Node 20/22.

If `python3.11` is not in the AL2023 repo you have, let `uv` provision it:
`uv python install 3.11` (and use `uv run` for Python skills). Do not replace
the system `python3` — dnf depends on it.

**AL2 (Amazon Linux 2) differences:** replace `dnf` with `yum`; the Node
tarball, `/usr/local` PATH, uv and systemd steps are identical; `dnf-automatic`
becomes `yum-cron` or a cron entry. Do not mix AL2 instructions into AL2023.

**Graviton/arm64:** substitute `linux-arm64` for the Node tarball, Caddy and
restic assets, and `cloudflared-linux-arm64` for the tunnel binary.

If RAM ≤ 4 GiB, add 2 GiB swap:

```bash
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

### T1b (optional) — EBS data volume for `/var/lib`

AL2023 AMIs often start with a small root volume. If you attached a separate
EBS volume for the data dir, mount it **before** T2 (the service user's home is
`/var/lib/nm-finance-agent`). **Confirm the device first** — never format the
root device.

```bash
lsblk
sudo file -s /dev/nvme1n1          # "data" = unformatted and safe to mkfs
sudo mkfs.ext4 /dev/nvme1n1
sudo mkdir -p /var/lib/nm-finance-agent
echo "UUID=$(sudo blkid -s UUID -o value /dev/nvme1n1) /var/lib/nm-finance-agent ext4 defaults,nofail 0 2" \
  | sudo tee -a /etc/fstab
sudo mount -a
df -h /var/lib/nm-finance-agent
```

If T2 already created the service user, run
`sudo chown nmagent:nmagent /var/lib/nm-finance-agent` after mounting. Skip
this section if the root volume is already ≥ 60 GB.

---

## 5. T2 — Users and directories

```bash
# service user (owns data, runs the app and execute)
sudo useradd -m -d /var/lib/nm-finance-agent -s /bin/bash nmagent
sudo chown nmagent:nmagent /var/lib/nm-finance-agent

# deploy user (owns code; runs git/npm; no sudo)
sudo useradd -m -s /bin/bash deploy

# code + data
sudo install -d -o deploy  -g nmagent -m 750 /opt/nm-finance-agent
sudo install -d -o nmagent -g nmagent -m 750 \
  /var/lib/nm-finance-agent/{workspace,skills,state,memories,logs,backups}

id nmagent && id deploy
df -h /opt /var/lib
```

**Acceptance:** both users exist; `/var/lib/nm-finance-agent` is owned by
`nmagent`; `/opt/nm-finance-agent` is `deploy:nmagent`.

**Note:** the code is deploy-owned but readable by `nmagent`, so the agent
cannot rewrite its own source through `execute`. Updates go through `deploy`.

---

## 6. T3 — Clone, install, build

```bash
sudo -u deploy git clone https://github.com/trgordonb/nm-finance-agent.git \
  /opt/nm-finance-agent

cd /opt/nm-finance-agent
sudo -u deploy npm ci                    # includes devDeps: tsx is the runtime
sudo -u deploy npm --prefix frontend ci
sudo -u deploy npm --prefix frontend run build
sudo -u deploy npm run check
sudo -u deploy npm test                  # expect 111 passing
```

**Why `npm ci` without `--omit=dev`:** `npm start` is `tsx src/index.ts`, and
`src/agentdb-mirror.ts` spawns `node_modules/.bin/tsx src/mirror-child.ts`.

If OpenCode already cloned the repo somewhere else (e.g. the login user's home),
do **not** run a second divergent copy: either `sudo mv` that clone to
`/opt/nm-finance-agent` or clone fresh there, then
`sudo chown -R deploy:nmagent /opt/nm-finance-agent` before `npm ci`.

**Acceptance:** `frontend/dist/index.html` exists; `npm run check` exits 0;
`npm test` reports 111 pass. **STOP** on a TypeScript error.

If a native dependency fails to build, `build-essential`/`python3` are already
installed — re-run `npm ci` and report the failing package.

---

## 7. T4 — Skills registry

Use **option A** (installed binary; no source checkout, fits systemd hardening).

```bash
sudo -u nmagent uv tool install \
  "git+https://github.com/trgordonb/nm-skills-registry@v0.1.7"
sudo -u nmagent uv tool dir --bin        # record this path, e.g. /var/lib/nm-finance-agent/.local/bin
```

Set `SKILLS_CLI=<that path>/nm-skills` in the env file (§8). No
`NM_SKILLS_REGISTRY_HOME` is needed in this mode.

**Fallback (option B):** clone `/opt/nm-skills-registry` at `v0.1.7`,
`sudo -u nmagent uv sync --directory /opt/nm-skills-registry --frozen`, set
`NM_SKILLS_REGISTRY_HOME=/opt/nm-skills-registry`, leave `SKILLS_CLI` unset.
See `docs/skills-registry-deploy.md` §5.

The bucket/prefix check runs after the env file exists — see the preflight at
the end of §8. **STOP** if it fails; do not boot with `SKILLS_REQUIRED=1` until
it is green.

---

## 8. T5 — Environment file

Create `/etc/nm-finance-agent.env`, mode `640 root:nmagent`. Use the user's
existing `.env` values; **do not invent keys**. Plain `KEY=value` only (systemd
`EnvironmentFile` syntax — no `export`, no inline `#`).

```ini
# --- app ---
SERVER_HOST=127.0.0.1
SERVER_PORT=3001
NODE_ENV=production
LANGCHAIN_PROJECT=nm-finance-agent

# --- data (persistent) ---
SESSION_DB_PATH=/var/lib/nm-finance-agent/sessions.db
WORKSPACE_DIR=/var/lib/nm-finance-agent/workspace
MEMORY_DIR=/var/lib/nm-finance-agent/memories
SKILLS_DIR=/var/lib/nm-finance-agent/skills
SKILLS_STATE_DIR=/var/lib/nm-finance-agent/state
WORKSPACE_HARD_JAIL=1

# --- skills registry ---
SKILLS_REGISTRY=s3://neuralmatrix
R2_BUCKET=neuralmatrix
R2_ENDPOINT_URL=https://<account>.r2.cloudflarestorage.com
R2_ACCESS_KEY_ID=<from user>
R2_SECRET_ACCESS_KEY=<from user>
SKILLS_CLI=/var/lib/nm-finance-agent/.local/bin/nm-skills
SKILLS_REQUIRED=1

# --- mirror: remote (recommended) ---
AGENTDB_REMOTE_URL=https://nm-finance-mirror.<subdomain>.workers.dev
AGENTDB_REMOTE_TOKEN=<from user>

# --- mirror: local fallback (only if the remote is unset) ---
# AGENTDB_PATH=/var/lib/nm-finance-agent/agent-mirror.db
# AGENTDB_MAX_ELEMENTS=100000

# --- llm ---
OPENROUTER_API_KEY=<from user>
OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
OPENROUTER_MODEL_MAIN=z-ai/glm-5.3-flash
OPENROUTER_MODEL_SUMMARIZER=poolside/laguna-xs-2.1:free
OPENROUTER_MAIN_MODEL_PROVIDER=open-inference/fp4,novita/fp8
OPENROUTER_PROVIDER_IGNORE=relace

# --- search / research ---
TAVILY_API_KEY=<from user>
JINA_API_KEY=<from user>
EXA_API_KEY=<from user>

# --- tracing ---
LANGSMITH_API_KEY=<from user>

# --- wiki (remote CF service; the localhost default is wrong on a VM) ---
WIKI_API_URL=https://llmwiki.<subdomain>.workers.dev
WIKI_API_TOKEN=<from user>
LLMWIKI_URL=https://llmwiki.<subdomain>.workers.dev

# --- MCP (VM-specific copy; agent_browser disabled) ---
MCP_SERVERS_FILE=/var/lib/nm-finance-agent/mcp_servers.json
```

Write it without echoing secrets:

```bash
sudo install -m 640 -o root -g nmagent /dev/null /etc/nm-finance-agent.env
sudo -e /etc/nm-finance-agent.env        # or a heredoc the user provides
sudo sed 's/=.*/=<redacted>/' /etc/nm-finance-agent.env
```

Values with spaces must be quoted (`KEY="a b"`); `#` starts a comment only at
the beginning of a line. One `KEY=value` per line — systemd does not parse
`export`.

MCP copy (keeps the repo clean; lives on the writable data dir so the UI can
still toggle servers):

```bash
sudo cp /opt/nm-finance-agent/mcp_servers.json \
  /var/lib/nm-finance-agent/mcp_servers.json
sudo jq '.servers.agent_browser.enabled = false' \
  /var/lib/nm-finance-agent/mcp_servers.json | sudo tee /tmp/mcp.json >/dev/null
sudo mv /tmp/mcp.json /var/lib/nm-finance-agent/mcp_servers.json
sudo chown nmagent:nmagent /var/lib/nm-finance-agent/mcp_servers.json
sudo chmod 640 /var/lib/nm-finance-agent/mcp_servers.json
```

**Important:** do **not** create `/opt/nm-finance-agent/.env`. `src/config.ts`
uses `dotenv.config({ override: true })`; a repo `.env` would silently override
the systemd environment and duplicate the secrets.

**Acceptance:** the file exists, is `640 root:nmagent`, and
`sudo -u nmagent bash -lc 'set -a; . /etc/nm-finance-agent.env; set +a; echo ${SKILLS_DIR:-unset}'`
prints the data path.

### Skills preflight (before first boot)

```bash
sudo -u nmagent bash -lc '
  set -a; . /etc/nm-finance-agent.env; set +a
  "$SKILLS_CLI" doctor
  "$SKILLS_CLI" pull "$SKILLS_DIR"
  find "$SKILLS_DIR" -name SKILL.md | wc -l
'
```

Expected: the bucket/prefix, `N pulled` > 0, and a non-zero `SKILL.md` count.
**STOP** if `doctor` fails or the count is 0 — the bucket is unseeded or the
creds/prefix are wrong.

---

## 9. T6 — Data migration (only if the user asked for it)

Run on the **dev machine** (user-assisted), with the local server stopped:

```bash
rsync -av --progress \
  --exclude '__pycache__' --exclude '.venv' --exclude 'node_modules' \
  --exclude '.cache' --exclude '*.log' \
  ~/projects/nm-finance-agent/sessions.db* \
  ~/projects/nm-finance-agent/workspace/ \
  ~/projects/nm-finance-agent/memories/ \
  ~/projects/nm-finance-agent/state/ \
  user@vm:/tmp/nm-migrate/
```

(`sessions.db*` picks up the db and, when present, its `-wal`/`-shm` siblings.
If the local server did not stop cleanly, the WAL is mandatory.)

Then on the VM:

```bash
sudo install -d -o nmagent -g nmagent -m 750 /var/lib/nm-finance-agent
sudo rsync -a --chown=nmagent:nmagent /tmp/nm-migrate/ /var/lib/nm-finance-agent/
sudo chown -R nmagent:nmagent /var/lib/nm-finance-agent
sudo -u nmagent sqlite3 /var/lib/nm-finance-agent/sessions.db 'PRAGMA integrity_check;'
```

- Copy `sessions.db-wal` **and** `sessions.db-shm` with the db; a db without
  its WAL loses the last turns.
- Do **not** copy `skills/`; it comes from R2 (the §8 preflight). If the bucket
  is not seeded, copy `skills/` and run `nm-skills import skills` from the VM,
  then re-run the §8 preflight.
- `agent-mirror.db`: skip when using `AGENTDB_REMOTE_URL`; copy it only for the
  local sidecar (with the app stopped).
- **STOP** if `integrity_check` is not `ok`.

---

## 10. T7 — systemd service

Create `/etc/systemd/system/nm-finance-agent.service`:

```ini
[Unit]
Description=nm-finance-agent (Express + SSE agent harness)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=nmagent
Group=nmagent
WorkingDirectory=/opt/nm-finance-agent
EnvironmentFile=/etc/nm-finance-agent.env
Environment=HOME=/var/lib/nm-finance-agent
Environment=PATH=/usr/local/bin:/usr/bin:/bin
ExecStart=/usr/local/bin/npm run start
Restart=always
RestartSec=3
TimeoutStopSec=20
KillSignal=SIGTERM

# hardening (works with the /opt + /var/lib layout)
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=/var/lib/nm-finance-agent
ProtectKernelTunables=true
ProtectControlGroups=true
RestrictSUIDSGID=true
LockPersonality=true
TasksMax=4096
# MemoryMax=6G   # uncomment on an 8 GiB VM; omit on 4 GiB
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now nm-finance-agent
systemctl status nm-finance-agent --no-pager
journalctl -u nm-finance-agent -n 60 --no-pager
```

**Acceptance:** `active (running)`, and the log shows
`runtime assembled: N tools`, `skills sync — N pulled ... N SKILL.md`, and the
listening line on `127.0.0.1:3001`.

**Common failures:**
- `Cannot find module 'tsx'` → `npm ci` was run with `--omit=dev`; re-run.
- `EADDRINUSE` → another process on 3001 (`ss -ltnp | grep 3001`).
- exit loop with `SKILLS_REQUIRED=1` → skills preflight; fix §8 and restart.
- `ProtectSystem` denial → check `journalctl`; add the path to `ReadWritePaths`
  only if it is genuinely data.

---

## 11. T8 — Reverse proxy, TLS, auth

### Option A (recommended): Caddy + Cloudflare Tunnel + Access

```bash
# Caddy is not in the AL2023 repos — use the official static binary.
CADDY_VERSION=2.10.0        # check https://github.com/caddyserver/caddy/releases
curl -fsSL "https://github.com/caddyserver/caddy/releases/download/v${CADDY_VERSION}/caddy_${CADDY_VERSION}_linux_amd64.tar.gz" \
  -o /tmp/caddy.tgz
tar -xzf /tmp/caddy.tgz -C /tmp caddy
sudo install -m 755 /tmp/caddy /usr/local/bin/caddy

sudo useradd --system --home-dir /var/lib/caddy --shell /usr/sbin/nologin caddy 2>/dev/null || true
sudo install -d -o caddy -g caddy -m 750 /var/lib/caddy /etc/caddy
```

Create `/etc/systemd/system/caddy.service`:

```ini
[Unit]
Description=Caddy
After=network-online.target
Wants=network-online.target

[Service]
User=caddy
Group=caddy
Environment=HOME=/var/lib/caddy
ExecStart=/usr/local/bin/caddy run --environ --config /etc/caddy/Caddyfile
ExecReload=/usr/local/bin/caddy reload --config /etc/caddy/Caddyfile --force
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=true
ReadWritePaths=/var/lib/caddy

[Install]
WantedBy=multi-user.target
```

Then create the Caddyfile and start it:

```caddyfile
http://127.0.0.1:8080 {
	root * /opt/nm-finance-agent/frontend/dist

	@api path /api/*
	handle @api {
		reverse_proxy 127.0.0.1:3001 {
			flush_interval -1
		}
	}

	handle {
		encode zstd gzip
		try_files {path} /index.html
		file_server
	}
}
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now caddy
sudo usermod -aG nmagent caddy      # read frontend/dist
sudo systemctl restart caddy
curl -sI http://127.0.0.1:8080/ | head -3
```

Install the tunnel **with a token from the Zero Trust dashboard** (headless;
no interactive login):

1. Zero Trust → Networks → Tunnels → Create → copy the token.
2. Public hostname: `agent.example.com` → `http://127.0.0.1:8080`.
3. Access → Applications → add `agent.example.com`, policy = the user's email.

```bash
# AL2023: use the static binary (no Debian/apt repo)
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 \
  -o /tmp/cloudflared
sudo install -m 755 /tmp/cloudflared /usr/local/bin/cloudflared
sudo cloudflared service install "<TOKEN>"
sudo systemctl enable --now cloudflared
systemctl status cloudflared --no-pager
```

**STOP** and ask the user to complete the dashboard steps (tunnel, DNS,
Access policy) if you don't have the token. Do not open 80/443.

**EC2 Security Group — the real boundary** (AL2023 has no `ufw`; do not install
one Debian-style):

| Direction | Rule |
|---|---|
| Inbound | `22/tcp` from the user's IP (never `0.0.0.0/0` if avoidable) |
| Inbound | `80/tcp`, `443/tcp` **only** for Option B (public Caddy) |
| Inbound | nothing else — no `3001`, no `8080` |
| Outbound | all (LLM/search/R2 and the tunnel); or `443/tcp` + `7844` TCP/UDP to Cloudflare |

A host firewall is optional; if the user wants one, mirror the SG:

```bash
sudo dnf install -y firewalld
sudo systemctl enable --now firewalld
sudo firewall-cmd --permanent --add-service=ssh
# Option B only:
sudo firewall-cmd --permanent --add-service=http --add-service=https
sudo firewall-cmd --reload
```

### Option B: public IP + Caddy TLS + basic auth

Attach an **Elastic IP** and point an `A` record at it, so the address (and the
Let's Encrypt certificate) survives instance stop/start.

```caddyfile
agent.example.com {
	basic_auth {
		gordon $2a$14$<bcrypt-from-caddy-hash-password>
	}
	root * /opt/nm-finance-agent/frontend/dist

	@api path /api/*
	handle @api {
		reverse_proxy 127.0.0.1:3001 {
			flush_interval -1
		}
	}
	handle {
		encode zstd gzip
		try_files {path} /index.html
		file_server
	}
}
```

```bash
/usr/local/bin/caddy hash-password --plaintext '<user-chosen>'   # paste into Caddyfile
# Security Group: allow inbound 80/443 (from the user's IPs, or 0.0.0.0/0)
sudo systemctl restart caddy
```

**Never** put `encode` on the `/api` handler: compression buffers SSE.

---

## 12. T9 — Verification

```bash
# 1. service + health (loopback; bypasses the proxy)
curl -fsS http://127.0.0.1:3001/api/health \
  | jq '{model, skills, skills_required, skills_backend, mirror, mcp_connected}'

# 2. SSE through the proxy (should print events incrementally)
curl -sN -X POST http://127.0.0.1:8080/api/chat \
  -H 'content-type: application/json' \
  -d '{"message":"reply with the single word ok"}'

# 3. frontend + auth through the public edge (adjust host)
curl -sI https://agent.example.com/ | head -5
```

Expected health: `skills` > 0, `skills_backend.mode = "s3"`,
`skills_backend.degraded = false`, `skills_required = true`, `mirror.enabled = true`,
`mcp_connected >= 1`.

Then, from the UI or a chat turn:

- ask it to `run pwd and ls -la` → output must show
  `/var/lib/nm-finance-agent/workspace`;
- ask it to load one known skill (`load_skill` on a name from the index);
- confirm the frontend loads over HTTPS and the auth challenge appears.

**STOP** if SSE arrives all at once at the end (buffering) — check
`flush_interval -1` and that `encode` is not on `/api`.

---

## 13. T10 — Backups

Nightly, to `/var/backups` + R2 via restic. Create a **separate** R2 bucket or
prefix for backups; do not mix with the skills bucket.

```bash
# AL2023 may not carry restic in its repos — fall back to the static binary.
sudo dnf install -y restic || {
  RESTIC_VERSION=0.18.0     # check https://github.com/restic/restic/releases
  curl -L "https://github.com/restic/restic/releases/download/v${RESTIC_VERSION}/restic_${RESTIC_VERSION}_linux_amd64.bz2" \
    | bunzip2 | sudo tee /usr/local/bin/restic >/dev/null
  sudo chmod 755 /usr/local/bin/restic
}

sudo tee /usr/local/bin/nm-backup.sh >/dev/null <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
DATA=/var/lib/nm-finance-agent
STAGE=/var/backups/nm-finance-agent
install -d -m 700 "$STAGE"

# consistent SQLite copy; the live db files are excluded from the backup
sqlite3 "$DATA/sessions.db" ".backup '$STAGE/sessions.db'"

export AWS_ACCESS_KEY_ID="<backup-key>"
export AWS_SECRET_ACCESS_KEY="<backup-secret>"
export AWS_DEFAULT_REGION=auto
export RESTIC_REPOSITORY="s3:https://<account>.r2.cloudflarestorage.com/<backup-bucket>"
export RESTIC_PASSWORD="<restic-password>"

restic backup "$DATA" "$STAGE" \
  --exclude "$DATA/sessions.db" \
  --exclude "$DATA/sessions.db-wal" \
  --exclude "$DATA/sessions.db-shm" \
  --exclude '**/__pycache__' \
  --exclude '**/.venv' \
  --exclude '**/node_modules' \
  --exclude '**/.cache' \
  --exclude '**/*.log' \
  --tag nm-agent --host "$(hostname)"

restic forget --keep-daily 7 --keep-weekly 4 --prune
EOF
sudo chmod 700 /usr/local/bin/nm-backup.sh
```

The workspace is backed up in place (no 1.3 GB staging copy); only the SQLite
snapshot is staged. Restic deduplicates across runs.

Timer:

```ini
# /etc/systemd/system/nm-backup.service
[Unit]
Description=nm-finance-agent backup
[Service]
Type=oneshot
ExecStart=/usr/local/bin/nm-backup.sh
```

```ini
# /etc/systemd/system/nm-backup.timer
[Unit]
Description=Nightly nm-finance-agent backup
[Timer]
OnCalendar=*-*-* 03:30:00
Persistent=true
[Install]
WantedBy=timers.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now nm-backup.timer
sudo systemctl start nm-backup.service
journalctl -u nm-backup -n 40 --no-pager
```

Test one restore before declaring done (export the same `RESTIC_*` and `AWS_*`
variables the script uses):

```bash
restic snapshots
restic restore latest --target /tmp/nm-restore
ls -l /tmp/nm-restore/var/backups/nm-finance-agent/sessions.db
ls -l /tmp/nm-restore/var/lib/nm-finance-agent/workspace
```

**STOP** if the restore fails.

---

## 14. T11 — Updates and rollback

```bash
# app
sudo -u deploy git -C /opt/nm-finance-agent fetch --tags
sudo -u deploy git -C /opt/nm-finance-agent checkout <tag-or-commit>
sudo -u deploy npm --prefix /opt/nm-finance-agent ci
sudo -u deploy npm --prefix /opt/nm-finance-agent/frontend ci
sudo -u deploy npm --prefix /opt/nm-finance-agent/frontend run build
sudo systemctl restart nm-finance-agent

# skills CLI (option A)
sudo -u nmagent uv tool install --force \
  "git+https://github.com/trgordonb/nm-skills-registry@<new-tag>"
sudo systemctl restart nm-finance-agent
```

- Take a backup before every upgrade.
- There are no destructive DB migrations (schema is `CREATE TABLE IF NOT EXISTS`).
- Rollback = previous tag/commit + the same steps + restart.
- `/var/lib/nm-finance-agent` is never touched by code upgrades.

---

## 15. Troubleshooting

| Symptom | Check / fix |
|---|---|
| service exits immediately | `journalctl -u nm-finance-agent -n 100`; Node ≥ 24; env file parse; port |
| `skills_backend.degraded=true` | `sudo -u nmagent bash -lc 'set -a; . /etc/nm-finance-agent.env; set +a; "$SKILLS_CLI" doctor'`; check `SKILLS_REGISTRY`, `R2_*`, `SKILLS_CLI`, bucket seed |
| service crash-loops with `SKILLS_REQUIRED=1` | expected on an unseeded bucket; fix the §8 preflight, then `systemctl restart` |
| `Cannot find module 'tsx'` | `npm ci` ran with `--omit=dev`; re-run without it |
| mirror warnings / ONNX errors | prefer `AGENTDB_REMOTE_URL`; or `AGENTDB_MIRROR=0` to disable |
| SSE buffered | Caddy `flush_interval -1`; no `encode` on `/api` |
| 502 from Caddy | app not listening: `ss -ltnp \| grep 3001`; check service |
| Access redirect loop | Access app hostname ≠ tunnel hostname; fix in dashboard |
| `execute` fails | `nmagent` shell/permissions; `ls -ld /var/lib/nm-finance-agent/workspace` |
| MCP server fails at boot | `journalctl` names it; disable it in `/var/lib/nm-finance-agent/mcp_servers.json` |
| deep research slow | expected 10–40 min; check the LangSmith trace, not the process |
| `dnf: package not found` | AL2023 package names differ; `ripgrep` is optional, `curl` is `curl-minimal` (never install `curl` over it) |
| `node: command not found` / old Node | tarball must win: `command -v node` → `/usr/local/bin/node`; check `echo $PATH` |
| unit cannot find `npm` | tarball install is `/usr/local/bin/npm`; RPM install is `/usr/bin/npm` — match `ExecStart` |
| SELinux denial | `sudo ausearch -m avc -ts recent`; fix labels/booleans — **never** `setenforce 0` |
| Security Group blocks access | inbound 22 (+80/443 for Option B); outbound all, or 443 + 7844 TCP/UDP for the tunnel |
| EBS volume not mounted after reboot | `/etc/fstab` entry needs `nofail`; `findmnt /var/lib/nm-finance-agent` |

---

## 16. Security checklist

- [ ] SSH keys only; password auth disabled (`/etc/ssh/sshd_config.d/`, or `sshd_config` if the Include is absent) — **confirm key access first, then `sshd -t && systemctl reload sshd`**
- [ ] EC2 Security Group: 22 from your IP; 80/443 only for public Caddy; no 3001/8080
- [ ] optional `firewalld` mirrors the Security Group
- [ ] app on `127.0.0.1:3001`; never exposed
- [ ] Cloudflare Access or Caddy basic auth in front
- [ ] `/etc/nm-finance-agent.env` mode `640 root:nmagent`; no repo `.env`
- [ ] `WORKSPACE_HARD_JAIL=1`
- [ ] `SKILLS_REQUIRED=1`
- [ ] `agent_browser` disabled (or Chromium explicitly installed)
- [ ] `git status` in `/opt/nm-finance-agent` shows no secret files
- [ ] `dnf-automatic.timer` enabled
- [ ] SELinux left enabled (`getenforce`) — no `setenforce 0`
- [ ] EBS data volume mounted with `nofail` (if used)
- [ ] backup restore tested
- [ ] `journalctl` has no unhandled rejections after a full turn

---

## 17. Definition of done + handover report

Done when all of these are true:

1. `systemctl is-active nm-finance-agent` → `active`
2. `/api/health` → `skills > 0`, `degraded=false`, `mirror.enabled=true`
3. chat turn streams through the public URL, auth enforced
4. `execute` lands in `/var/lib/nm-finance-agent/workspace`
5. `load_skill` returns a real `SKILL.md`
6. `nm-backup.timer` fired once and a restore test succeeded
7. reboot test: both services come back (`systemctl is-enabled`)
8. no secrets in git; no port 3001 exposure

Handover report (write it in the final message):

```md
## VM deployment — <date>
- Host / OS / size:
- Repo ref: <commit/tag>
- Paths: APP_DIR=..., DATA_DIR=..., ENV=..., MCP=...
- Node / npm / uv / registry / skills CLI versions:
- Skills: N loaded, backend=s3, degraded=false
- Mirror: remote|local, enabled=...
- llmwiki: remote <host> | local | skipped
- Proxy: Caddy + Tunnel (hostname) | Caddy TLS + basic auth
- Backups: repo, schedule, last run, restore tested=yes/no
- Deviations from runbook:
- Open items: OAuth2, per-user containers, agent-browser, ...
```

---

## 18. Intentionally out of scope

- **OAuth2** — planned; the interim is Access/basic auth. Do not implement it
  during this deployment.
- **Per-user containers / workspace separation** — deferred; see
  `docs/per-user-workspace-and-r2.md`. This VM is single-user.
- **Cloudflare Sandbox** — deferred; see `docs/cloudflare-sandbox-compat.md`.
- **`agent_browser` / Chrome** — install only if the user explicitly asks.
- **Local llmwiki** — use the existing remote service; a local Docker compose
  stack is a separate deployment.
- **Frontend static serving inside Express** — Caddy serves `dist`; no app
  change is required for this deployment.

---

## Appendix A — env key list

```
SERVER_HOST SERVER_PORT NODE_ENV LANGCHAIN_PROJECT
SESSION_DB_PATH WORKSPACE_DIR MEMORY_DIR SKILLS_DIR SKILLS_STATE_DIR
WORKSPACE_HARD_JAIL
SKILLS_REGISTRY R2_BUCKET R2_ENDPOINT_URL R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY
SKILLS_CLI SKILLS_REQUIRED
AGENTDB_REMOTE_URL AGENTDB_REMOTE_TOKEN
OPENROUTER_API_KEY OPENROUTER_BASE_URL OPENROUTER_MODEL_MAIN
OPENROUTER_MODEL_SUMMARIZER OPENROUTER_MAIN_MODEL_PROVIDER OPENROUTER_PROVIDER_IGNORE
TAVILY_API_KEY JINA_API_KEY EXA_API_KEY LANGSMITH_API_KEY
WIKI_API_URL WIKI_API_TOKEN LLMWIKI_URL
MCP_SERVERS_FILE
```

## Appendix B — manual runs as the service user

```bash
sudo -u nmagent bash -lc '
  set -a; . /etc/nm-finance-agent.env; set +a
  cd /opt/nm-finance-agent
  npm run research -- "question"
'
```

Reports land under `$WORKSPACE_DIR/research/`.

## Appendix C — why these choices

- **`/opt` + `/var/lib`**: `ProtectSystem=strict` can make the code read-only
  while leaving the data writable through `ReadWritePaths`.
- **No repo `.env`**: `dotenv({ override: true })` would override systemd and
  duplicate secrets; one authoritative env file is easier to audit.
- **Caddy in front**: static SPA + SSE-aware API proxy + TLS/Access; the app
  stays loopback-only.
- **Installed `nm-skills`**: `SKILLS_CLI` avoids `uv run --directory` writing
  into `/opt` under the systemd sandbox.
- **Remote mirror**: no ONNX model download, no native sidecar, lower RAM and
  boot time; the existing CF Container already serves it.
- **Amazon Linux 2023**: `dnf` (not apt), Node from the official tarball into
  `/usr/local`, Security Groups as the firewall, SELinux left enabled, Caddy
  and cloudflared as static binaries.
- **AL2**: replace `dnf` with `yum`; `uv` provisions Python 3.11+; everything
  else (paths, systemd, Caddy/Tunnel) is identical.
