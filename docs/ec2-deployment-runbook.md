# nm-finance-agent — EC2 deployment runbook (coding-agent contract)

**Status:** 2026-10-27. This is the canonical runbook for a **new** EC2
deployment. It supersedes `docs/vm-deployment-runbook.md` (2026-10-23) for
current work; the older file is retained as the deployment history for the
existing `agent.neuralmatrix.site` instance.

**Audience:** a coding agent running **on the target EC2 instance** with
`sudo`, plus the owner who supplies secrets, DNS, and SSO/R2 access. If you are
running off-instance, use AWS Systems Manager Session Manager or SSH; the
on-host steps are identical.

**Target:** one Amazon Linux 2023 EC2 instance running the native Node 24
process under systemd, Caddy on loopback, and either a Cloudflare Tunnel
(recommended) or public Caddy TLS. The app is an SSO **backend-for-frontend
(BFF)**; it is not an OAuth client in the browser.

**Current feature set being deployed:** agent loop and SSE chat, sessions,
per-user workspaces/memory, skills via the R2 registry, MCP, AgentDB semantic
mirror, deep research, cron (`Scheduled` UI), user-scoped OpenRouter keys, and
the P3 Wiki tab (private/shared wiki switch through the remote `llmwiki`
service).

---

## 0. Agent operating contract

Read this section before running anything.

### 0.1 Rules

1. **Ask the owner, never guess** for: domain/DNS, AWS resource IDs, SSO
   endpoint/client/secret, R2 credentials, `llmwiki` assertion secret, the
   target git ref, whether to migrate data, whether to enable optional MCP
   servers/skills, and whether to use a Cloudflare Tunnel or public TLS.
2. **Never print a secret.** Do not `cat` the environment file, `auth.db`,
   `state/users/**/llm.json`, the SSO client secret, Cloudflare Tunnel token,
   R2 keys, `WIKI_ASSERTION_SECRET`, or `USER_LLM_KEY_SECRET`.
   Redact listings with `sed 's/=.*/=<redacted>/'`.
3. **Do not run the app as root.** Code is built by `deploy`, the service runs
   as `nmagent`.
4. **Never expose `3001` or `8080` publicly.** Only Caddy or the tunnel is
   public. The app binds `127.0.0.1`.
5. **Do not disable `AUTH_MODE=sso` to make something work.** On a
   public/tunnel deployment, `AUTH_MODE=off` is an unauthenticated public app.
   Use the documented maintenance rollback only and restore SSO immediately.
6. **Do not create `/opt/nm-finance-agent/.env`.** `src/config.ts` calls
   `dotenv.config({ override: true })`; a repo `.env` silently overrides the
   systemd environment file and duplicates secrets. The only authoritative
   environment is `/etc/nm-finance-agent.env`.
7. **Never deploy uncommitted code.** A fresh EC2 clone only sees pushed
   commits. If the owner wants the current local P3/P2 work deployed, it must
   be committed and pushed first. Record the exact SHA in the handover.
8. **Stop and report** on a failed build/test, a certificate fingerprint
   mismatch, an unseeded skills bucket, a missing SSO grant, a port conflict, or
   an `AUTH_MODE=sso` configuration error. Include the command, exit code, and
   `journalctl -u nm-finance-agent -n 100 --no-pager`.
9. **Idempotence:** prefer `install -d`, `systemctl enable --now`, and
   `rsync`/`install` over ad-hoc edits. Record every deviation from this
   runbook.
10. **This is a single-process, trusted-SSO-user deployment.** Per-user
    workspace/Wiki separation is path/index separation, not a hostile-tenant
    boundary. `execute` can read the app's environment, including
    `WIKI_ASSERTION_SECRET`. Per-user agent containers are a separate project.

### 0.2 Task sequence

Run top-to-bottom. Every task has commands, an acceptance check, and sometimes
a STOP condition.

| Task | Outcome |
|---|---|
| T0 | Inputs and preflight complete |
| T1 | EC2 host, EBS, networking, IAM |
| T2 | OS baseline, Node 24, Caddy/tunnel tooling |
| T3 | Users, directories, code checkout |
| T4 | Build, typecheck, tests |
| T5 | Skills registry and MCP |
| T6 | Environment file and SSO certificate |
| T7 | Optional data migration |
| T8 | systemd service |
| T9 | Caddy/TLS/tunnel edge |
| T10 | SSO rollout and verification |
| T11 | `llmwiki` P3 integration |
| T12 | Functional and security acceptance |
| T13 | Backups, monitoring, update/rollback |
| T14 | Handover report |

### 0.3 Current reference deployment (do not copy secrets)

The existing live instance is the reference for names and choices, not a
template for a new host:

| Item | Current reference (2026-10-27) |
|---|---|
| Public hostname | `agent.neuralmatrix.site` |
| Ingress | Cloudflare Tunnel → Caddy `127.0.0.1:8080` |
| Region / OS | `us-east-1`, Amazon Linux 2023 |
| Instance | `t4g.small` (2 vCPU / 1.8 GiB) + 2 GiB swap — **below this runbook's 4 GiB minimum** |
| Node | v24.22.1 |
| App unit | `nm-finance-agent.service` as `nmagent` |
| App listener | `127.0.0.1:3001` |
| Caddy | `127.0.0.1:8080`; site address `:8080` + `bind 127.0.0.1` |
| Code | `/opt/nm-finance-agent` (`deploy:nmagent 750`) |
| Data | `/var/lib/nm-finance-agent` (`nmagent:nmagent 700`) |
| Auth | `AUTH_MODE=sso`, permission `application.nmfinance`, `nm_auth` cookie |
| SSO | `https://2.24.91.212:8443`; pinned leaf expires **2027-10-21** |
| Skills | R2 `s3://neuralmatrix`, `nm-skills` v0.1.7 |
| AgentDB | remote Cloudflare Containers mirror |
| llmwiki | remote `https://llmwiki.iamlegacydevelop.workers.dev` |

A new deployment should use **at least 4 GiB RAM** (`t3.medium`, `t4g.medium`,
or larger) unless the owner explicitly accepts swap pressure. The existing
`t4g.small` works but is memory-tight under research/chart workloads.

> **Code status, 2026-10-27.** The development checkout currently has
> uncommitted P3 Wiki-tab changes in `nm-finance-agent` and uncommitted P2/P3
> changes in `llm-wiki-svc`. A fresh EC2 clone sees only pushed commits. Before
> asking the EC2 agent to deploy, commit/push the intended ref and record the
> SHA. Never copy a laptop working tree to `/opt` as a deployment shortcut.

---

## 1. Architecture

```
Browser
  │ HTTPS
  ▼
Cloudflare edge / Tunnel  (recommended: no inbound 80/443 on the EC2 host)
  │
  ▼
Caddy 127.0.0.1:8080
  ├─ /                  → /opt/nm-finance-agent/frontend/dist  (SPA fallback)
  └─ /api/*             → Express 127.0.0.1:3001                (SSE, no buffering)
                              │
                              ├─ app SSO BFF → SSO server (HTTPS, pinned cert)
                              │                 HttpOnly cookie nm_auth
                              │                 server-side tokens in auth.db
                              ├─ R2 ←→ nm-skills CLI (boot pull, curated push)
                              ├─ remote AgentDB mirror (Cloudflare Container)
                              ├─ remote llmwiki service (P3 private/common wikis)
                              ├─ OpenRouter / Tavily / Exa / Jina / LangSmith
                              └─ in-process cron scheduler (SQLite)
```

### 1.1 Why these choices

- **Native Node, not Docker, for the app.** `npm start` is `tsx src/index.ts`;
  the app owns SQLite files and `execute` processes. The `container/Dockerfile`
  in this repo is for the **remote AgentDB mirror**, not the full app.
- **Caddy serves the frontend.** Express has no static handler. Vite is
  dev-only. Caddy serves `frontend/dist` and proxies `/api/*` so the browser
  uses same-origin relative URLs and cookies.
- **App binds loopback.** Caddy or the tunnel is the only public surface. The
  EC2 Security Group must enforce the same rule.
- **SSO BFF, not browser OAuth.** The browser posts credentials to
  `/api/auth/login`; access/refresh tokens stay in `auth.db`; the browser only
  gets an `HttpOnly`, `SameSite=Strict`, `Secure` cookie.
- **Single process.** Domain/cron/workspace coordination is in-process. The
  cron scheduler is not a separate systemd timer. A restart marks in-flight
  research runs interrupted and missed cron fires catch up once.
- **Data on a separate EBS volume.** Code updates never touch
  `/var/lib/nm-finance-agent`; snapshots/backups target the data volume.

### 1.2 What must be true before first boot

- A pushed git ref (commit/tag), not a dirty tree.
- A seeded R2 skills bucket and credentials.
- SSO ServiceClient + `application.nmfinance` grant.
- A reachable `llmwiki` service and the shared `WIKI_ASSERTION_SECRET`.
- A reachable AgentDB mirror, or an explicit decision to use the local sidecar.
- Domain/TLS/tunnel decision.
- A data-migration decision.
- A backup/restore decision.

---

## 2. T0 — Inputs and preflight

Ask the owner for these and write the answers into the handover report.

| Input | Default / notes |
|---|---|
| Repo / ref | `https://github.com/trgordonb/nm-finance-agent.git`; exact tag/commit to deploy |
| AWS region / AZ | e.g. `us-east-1` / `us-east-1a` |
| AMI | Amazon Linux 2023 x86_64 or arm64; record AMI ID |
| Instance type | ≥4 GiB RAM: `t3.medium` (x86) or `t4g.medium` (arm64) recommended |
| Root volume | ≥30 GB gp3 |
| Data volume | ≥60 GB gp3, encrypted, mounted at `/var/lib/nm-finance-agent` |
| Ingress | Cloudflare Tunnel (recommended) or public Caddy TLS |
| Public hostname | e.g. `agent.example.com` |
| DNS | Cloudflare (tunnel) or Route53/other A record (public Caddy) |
| SSO base URL | current reference `https://2.24.91.212:8443`; verify with owner |
| SSO client | `nm-finance-agent`; ServiceClient secret handed over securely |
| SSO permission | `application.nmfinance`; owner confirms the grant |
| SSO cert | fingerprint/expiry; current leaf expires 2027-10-21 |
| R2 | bucket/endpoint/access key/secret; `SKILLS_REGISTRY` |
| Skills bucket seeded? | **must be yes**; `nm-skills doctor` |
| AgentDB | remote URL/token (recommended) or local sidecar decision |
| llmwiki | URL + `WIKI_ASSERTION_SECRET`; **no admin token** |
| LLM policy | server key and/or per-user keys; `LLM_KEY_POLICY` |
| Optional keys | Tavily, Exa, Jina, LangSmith, InstaBox |
| Data migration | yes/no; source paths and downtime window |
| Backups | EBS/DLM, app SQLite, R2/S3/restic; encryption decision |
| MCP | `agent_browser` off unless Chromium is requested; `vibe_trading` optional |
| Browser acceptance | owner available for SSO login |

### 2.1 Preflight commands

Run on the target host once it exists, or on the owner's machine before handoff:

```bash
# Target ref is reachable and clean
git ls-remote https://github.com/trgordonb/nm-finance-agent.git refs/heads/main
# The deployment target must be a pushed SHA/tag. Do not deploy a dirty tree.

# DNS / edge decision
getent hosts agent.example.com || true

# R2 bucket reachability is checked after credentials are installed (T5).

# SSO reachability (owner-approved; -k only for this probe)
curl -sS --max-time 5 -k https://2.24.91.212:8443/healthz
```

**STOP** if the ref is only a local dirty tree, the skills bucket is unseeded,
or the owner cannot supply the SSO grant/secret. You may continue with the
baseline build while inputs are gathered, but do not start the app with a
half-configured auth layer.

---

## 3. T1 — EC2 host, storage, IAM, networking

If the instance already exists, record the IDs and skip to T2. If not, the
following is the owner-assisted AWS shape. A coding agent **on** the instance
normally cannot create EC2 resources; use the console/owner-run AWS CLI, or an
instance profile with the minimum permissions.

### 3.1 IAM instance profile

Attach an instance profile with:

- `AmazonSSMManagedInstanceCore` (SSM Session Manager; no inbound SSH needed).
- `CloudWatchAgentServerPolicy` only if the CloudWatch agent is used.
- Optional backup policy: `ec2:CreateSnapshot`, `ec2:DescribeVolumes`,
  `ec2:CreateTags` for an in-instance snapshot script; otherwise use AWS Backup
  with its own service role.

Do **not** put long-lived AWS access keys on the host. The app's R2 keys are
separate application secrets.

### 3.2 Security Group

| Direction | Rule |
|---|---|
| Inbound | **No 3001, no 8080, ever** |
| Inbound | `22/tcp` from the owner's IP **only if SSH is used**; otherwise none |
| Inbound | `80/tcp` and `443/tcp` **only** for public Caddy; not needed for Tunnel |
| Outbound | All (LLM/search/R2/SSO/tunnel), or `443/tcp` + `7844/tcp` + `7844/udp` for Tunnel |

Tunnel mode needs no inbound web ports. Public-Caddy mode needs 80/443 for
Let's Encrypt and the browser.

```bash
# Example, owner-run. Replace the group/region/CIDRs.
aws ec2 create-security-group \
  --group-name nm-finance-agent \
  --description "nm-finance-agent EC2" \
  --vpc-id vpc-xxxxxxxx

aws ec2 authorize-security-group-ingress --group-id sg-xxxxxxxx \
  --protocol tcp --port 443 --cidr 0.0.0.0/0
aws ec2 authorize-security-group-ingress --group-id sg-xxxxxxxx \
  --protocol tcp --port 80 --cidr 0.0.0.0/0
# SSH only if used, from the owner's IP:
aws ec2 authorize-security-group-ingress --group-id sg-xxxxxxxx \
  --protocol tcp --port 22 --cidr 203.0.113.7/32
```

### 3.3 Instance and EBS

- Amazon Linux 2023, x86_64 (`t3.medium`) or arm64 (`t4g.medium`).
- Root gp3 ≥30 GB; data gp3 ≥60 GB, **encrypted**, in the same AZ.
- IMDSv2 required (`HttpTokens=required`).
- Tag `Name=nm-finance-agent`, plus owner/cost tags.
- Attach the instance profile.
- Associate an Elastic IP only for public Caddy TLS; Tunnel mode does not need
  one.

```bash
# Owner-run shape; replace AMI/subnet/SG/role.
aws ec2 run-instances \
  --image-id ami-xxxxxxxx \
  --instance-type t3.medium \
  --iam-instance-profile Name=nm-finance-agent-ec2 \
  --security-group-ids sg-xxxxxxxx \
  --subnet-id subnet-xxxxxxxx \
  --metadata-options HttpTokens=required,HttpEndpoint=enabled \
  --block-device-mappings '[
    {"DeviceName":"/dev/xvda","Ebs":{"VolumeSize":30,"VolumeType":"gp3","Encrypted":true,"DeleteOnTermination":true}}
  ]' \
  --tag-specifications 'ResourceType=instance,Tags=[{Key=Name,Value=nm-finance-agent}]'
```

Attach the data volume **before** creating the service user (T2/T3). Confirm
the device with `lsblk`; never format the root device.

```bash
lsblk
sudo file -s /dev/nvme1n1          # "data" = unformatted and safe to mkfs
sudo mkfs.ext4 /dev/nvme1n1
sudo mkdir -p /var/lib/nm-finance-agent
echo "UUID=$(sudo blkid -s UUID -o value /dev/nvme1n1) /var/lib/nm-finance-agent ext4 defaults,nofail 0 2" \
  | sudo tee -a /etc/fstab
sudo mount -a
findmnt /var/lib/nm-finance-agent
```

If the instance already created `/var/lib/nm-finance-agent`, `chown` it after
mounting.

### 3.4 Session access

Prefer SSM:

```bash
aws ssm start-session --target i-xxxxxxxxxxxxxxxxx --region us-east-1
```

Verify on the instance:

```bash
systemctl status amazon-ssm-agent --no-pager
```

If SSH is used: keys only, password authentication disabled, and the Security
Group restricted to the owner's IP. Do not leave `22/tcp 0.0.0.0/0`.

### T1 acceptance

```bash
cat /etc/os-release                 # Amazon Linux 2023
nproc && free -h && df -h /
findmnt /var/lib/nm-finance-agent   # separate data volume, if used
curl -sS -m 3 http://169.254.169.254/latest/meta-data/instance-id  # IMDSv2 may require token; optional
```

**STOP** if the data volume is not the intended one, the root device was
formatted, or `3001`/`8080` is reachable from the Internet.

---

## 4. T2 — OS baseline (Amazon Linux 2023)

### 4.1 Packages and time

```bash
sudo timedatectl set-timezone UTC
sudo dnf upgrade --refresh -y
# Reboot if the kernel/glibc changed; ask the owner for a window.

# AL2023 ships curl-minimal. Do NOT `dnf install curl` (it conflicts).
sudo dnf install -y git jq unzip tar xz rsync bzip2 \
  gcc gcc-c++ make python3.11 python3.11-pip ca-certificates \
  dnf-automatic
sudo dnf install -y sqlite || sudo dnf install -y sqlite3 || true
sudo dnf install -y ripgrep || true
```

### 4.2 Node 24

The app requires **Node ≥24** (`package.json engines`). Install the official
tarball into `/usr/local`; do not use Node 20/22.

```bash
NODE_VERSION=24.22.1          # check https://nodejs.org/dist/latest-v24.x/
ARCH=x64                      # arm64 for Graviton
curl -fsSLO "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${ARCH}.tar.xz"
sudo tar -xJf "node-v${NODE_VERSION}-linux-${ARCH}.tar.xz" -C /usr/local --strip-components=1
rm "node-v${NODE_VERSION}-linux-${ARCH}.tar.xz"

node -v && command -v node    # expect v24.x and /usr/local/bin/node
npm -v && command -v npm
```

### 4.3 uv

`uv` provisions Python for the skills CLI and the optional `vibe_trading` MCP:

```bash
curl -LsSf https://astral.sh/uv/install.sh | sudo env UV_INSTALL_DIR=/usr/local/bin sh
uv --version
```

### 4.4 Caddy and cloudflared (static binaries)

```bash
CADDY_VERSION=2.10.0
CADDY_ARCH=amd64               # arm64 for Graviton
curl -fsSL "https://github.com/caddyserver/caddy/releases/download/v${CADDY_VERSION}/caddy_${CADDY_VERSION}_linux_${CADDY_ARCH}.tar.gz" \
  -o /tmp/caddy.tgz
tar -xzf /tmp/caddy.tgz -C /tmp caddy
sudo install -m 755 /tmp/caddy /usr/local/bin/caddy

# Cloudflare Tunnel only if that ingress was chosen:
CLOUDFLARED_ARCH=amd64         # arm64 for Graviton
curl -L "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${CLOUDFLARED_ARCH}" \
  -o /tmp/cloudflared
sudo install -m 755 /tmp/cloudflared /usr/local/bin/cloudflared
```

For public Caddy TLS, Caddy obtains certificates automatically from Let's
Encrypt; allow inbound 80/443.

### 4.5 Swap and automatic updates

If RAM ≤4 GiB, add 2 GiB swap:

```bash
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

Enable security updates:

```bash
sudo sed -i 's/^apply_updates = no/apply_updates = yes/' /etc/dnf/automatic.conf
sudo systemctl enable --now dnf-automatic.timer
```

### T2 acceptance

```bash
node -v                       # v24.x
command -v node               # /usr/local/bin/node
npm -v
uv --version
caddy version
cloudflared --version || true
sqlite3 --version || true
free -h
```

**STOP** if Node is not 24.x.

---

## 5. T3 — Users, directories, checkout

### 5.1 Service and deploy users

```bash
# Runtime user: owns data, runs the app and execute.
sudo useradd -m -d /var/lib/nm-finance-agent -s /bin/bash nmagent 2>/dev/null || true
sudo chown nmagent:nmagent /var/lib/nm-finance-agent

# Build/deploy user: owns code; no sudo.
sudo useradd -m -s /bin/bash deploy 2>/dev/null || true

sudo install -d -o deploy  -g nmagent -m 750 /opt/nm-finance-agent
sudo install -d -o nmagent -g nmagent -m 700 \
  /var/lib/nm-finance-agent/{workspace,skills,state,memories,logs,backups}
```

### 5.2 Clone

```bash
sudo -u deploy git clone https://github.com/trgordonb/nm-finance-agent.git \
  /opt/nm-finance-agent
sudo -u deploy git -C /opt/nm-finance-agent checkout <ref>
sudo -u deploy git -C /opt/nm-finance-agent status --short
# Must be clean. Record the SHA.
sudo -u deploy git -C /opt/nm-finance-agent log -1 --format='%H %s'
```

If a clone already exists in the login user's home, do **not** create a second
divergent copy. Move it to `/opt/nm-finance-agent` or clone fresh there, then
`chown -R deploy:nmagent`.

### 5.3 Critical: no repo `.env`

```bash
test ! -e /opt/nm-finance-agent/.env && echo "OK: no repo .env"
```

`src/config.ts` calls `dotenv.config({ override: true })`. A `.env` here would
override the systemd environment and duplicate secrets. If one exists, stop and
ask the owner; do not delete a file you did not create without checking.

### T3 acceptance

```bash
id nmagent && id deploy
ls -ld /opt/nm-finance-agent /var/lib/nm-finance-agent
sudo -u deploy test -f /opt/nm-finance-agent/package.json
test ! -e /opt/nm-finance-agent/.env
```

---

## 6. T4 — Build, typecheck, test

Run as `deploy`. `tsx` is a **devDependency** and is the runtime; never install
with `--omit=dev`.

```bash
sudo -u deploy bash -lc 'cd /opt/nm-finance-agent && npm ci'
sudo -u deploy bash -lc 'cd /opt/nm-finance-agent/frontend && npm ci'
sudo -u deploy bash -lc 'cd /opt/nm-finance-agent/frontend && npm run build'
sudo -u deploy bash -lc 'cd /opt/nm-finance-agent && npm run check'
```

Run the offline suite with an isolated test data directory so the test run does
not create databases in `/opt`:

```bash
sudo -u deploy mkdir -p /tmp/nm-test/{workspace,memories}
sudo -u deploy env \
  AUTH_MODE=off \
  OPENROUTER_API_KEY=presence-only \
  SESSION_DB_PATH=/tmp/nm-test/sessions.db \
  WORKSPACE_DIR=/tmp/nm-test/workspace \
  MEMORY_DIR=/tmp/nm-test/memories \
  AUTH_DB_PATH=/tmp/nm-test/auth.db \
  AGENTDB_PATH=/tmp/nm-test/agent-mirror.db \
  bash -lc 'cd /opt/nm-finance-agent && npm test'
```

The suite is offline; `OPENROUTER_API_KEY=presence-only` satisfies presence
checks without spending tokens. On the 2026-10-27 tree the suite is **190
passing**. Treat a future count as informational; **stop on a non-zero exit or
a real failure**, not on a different count.

### T4 acceptance

```bash
test -f /opt/nm-finance-agent/frontend/dist/index.html
sudo -u deploy bash -lc 'cd /opt/nm-finance-agent && npm run check'
# npm test exit 0 (current suite 190)
```

**STOP** on a TypeScript error, failed test, or a native-module build failure.
The baseline packages include `gcc`, `gcc-c++`, `make`, and Python 3.11; re-run
`npm ci` after fixing the missing toolchain.

---

## 7. T5 — Skills registry and MCP

### 7.1 Skills CLI

The `skills/` directory is deliberately gitignored; the R2 bucket is the source
of truth. Install the pinned CLI as `nmagent`.

```bash
sudo -u nmagent bash -lc \
  'uv tool install "git+https://github.com/trgordonb/nm-skills-registry@v0.1.7"'
sudo -u nmagent bash -lc 'uv tool dir --bin'
# Record the path, e.g. /var/lib/nm-finance-agent/.local/bin
```

Set `SKILLS_CLI` to `<that path>/nm-skills` in the env file. Do not rely on
`uv run --directory` on the VM; the systemd sandbox and `ProtectSystem` make a
committed, installed binary simpler.

Alternative (checkout mode): clone the registry at the same tag under
`/opt/nm-skills-registry`, run `uv sync --frozen`, set
`NM_SKILLS_REGISTRY_HOME=/opt/nm-skills-registry`, and leave `SKILLS_CLI`
unset. Pick one mode, not both.

### 7.2 Skills preflight

After T6 creates the env file, run as `nmagent`:

```bash
sudo -u nmagent bash -lc '
  set -a; . /etc/nm-finance-agent.env; set +a
  "$SKILLS_CLI" doctor
  "$SKILLS_CLI" pull "$SKILLS_DIR"
  find "$SKILLS_DIR" -name SKILL.md | wc -l
'
```

Expected: the bucket/prefix reports healthy, pull succeeds, and the `SKILL.md`
count is non-zero. **STOP** if `doctor` fails or the count is zero. With
`SKILLS_REQUIRED=1`, an unseeded bucket is a deliberate crash loop, not a
silent empty agent.

`SKILLS_DIR`'s basename is the bucket prefix (`/var/lib/nm-finance-agent/skills`
→ `skills/`) unless `SKILLS_REGISTRY` carries an explicit path. Keep it named
`skills`.

### 7.3 MCP configuration

The repo's `mcp_servers.json` is the admin baseline. The runtime reads the
writable copy in the data dir:

```bash
sudo cp /opt/nm-finance-agent/mcp_servers.json \
  /var/lib/nm-finance-agent/mcp_servers.json
sudo jq '.servers.agent_browser.enabled = false' \
  /var/lib/nm-finance-agent/mcp_servers.json \
  | sudo tee /tmp/mcp.json >/dev/null
sudo mv /tmp/mcp.json /var/lib/nm-finance-agent/mcp_servers.json
sudo chown nmagent:nmagent /var/lib/nm-finance-agent/mcp_servers.json
sudo chmod 640 /var/lib/nm-finance-agent/mcp_servers.json
```

- Disable `agent_browser` unless the owner explicitly wants Chromium. If
  enabled, install Chrome/Chromium and its sandbox dependencies, then test.
- `vibe_trading` is optional. It needs Python ≥3.11:

  ```bash
  sudo -u nmagent bash -lc \
    'uv tool install vibe-trading-ai==0.1.18'
  sudo ln -sf /var/lib/nm-finance-agent/.local/bin/vibe-trading-mcp /usr/local/bin/
  ```

  Merge the `vibe_trading` entry from the repo copy into the live copy, then
  restart. Never copy secrets into `mcp_servers.json`.
- Keep the live file on the data volume: per-user MCP toggles live under
  `SKILLS_STATE_DIR/users/<login>/mcp.json`, not in the baseline.
- A bad MCP server is skipped at boot with a warning; check
  `journalctl` and `/api/health` (`mcp_connected`, `mcp_tools`).

### T5 acceptance

```bash
sudo -u nmagent bash -lc '
  set -a; . /etc/nm-finance-agent.env; set +a
  "$SKILLS_CLI" doctor
  find "$SKILLS_DIR" -name SKILL.md | wc -l
'
```

**STOP** if the bucket is unseeded, the CLI is missing, or the skeleton count
is zero. Continue after the owner seeds/imports the bucket.

---

## 8. T6 — Environment and SSO certificate

### 8.1 Create the env file

Create `/etc/nm-finance-agent.env`, **mode `640 root:nmagent`**, using plain
`KEY=value` lines. systemd `EnvironmentFile` does not accept `export`, and an
inline trailing `#` is not a reliable comment; keep comments on their own
lines.

```bash
sudo install -d -o root -g root -m 755 /etc/nm-finance-agent
sudo install -m 640 -o root -g nmagent /dev/null /etc/nm-finance-agent.env
sudo -e /etc/nm-finance-agent.env       # owner/agent editor; do not cat it
```

Use this template, replacing `<...>` with owner-supplied values. Never paste a
real secret into this document or a chat message.

```ini
# --- app / server ------------------------------------------------------------
NODE_ENV=production
SERVER_HOST=127.0.0.1
SERVER_PORT=3001
LANGCHAIN_PROJECT=nm-finance-agent

# --- persistent data ---------------------------------------------------------
SESSION_DB_PATH=/var/lib/nm-finance-agent/sessions.db
WORKSPACE_DIR=/var/lib/nm-finance-agent/workspace
MEMORY_DIR=/var/lib/nm-finance-agent/memories
SKILLS_DIR=/var/lib/nm-finance-agent/skills
SKILLS_STATE_DIR=/var/lib/nm-finance-agent/state
AGENTDB_MCP_DIR=/var/lib/nm-finance-agent/state/agentdb
WORKSPACE_HARD_JAIL=1

# --- LLM (OpenRouter) --------------------------------------------------------
OPENROUTER_API_KEY=<server key>
OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
OPENROUTER_MODEL_MAIN=z-ai/glm-5.3-flash
OPENROUTER_MODEL_SUMMARIZER=poolside/laguna-xs-2.1:free
OPENROUTER_MAIN_MODEL_PROVIDER=open-inference/fp4,novita/fp8
OPENROUTER_PROVIDER_IGNORE=relace
# OPENROUTER_PROVIDER_FALLBACKS=1
# OPENROUTER_REASONING=1

# --- user-scoped OpenRouter keys (recommended on a multi-user host) ----------
# prefer_user (default) | require_user | server_only
LLM_KEY_POLICY=require_user
# Warn-only window before require_user is enforced; omit to enforce now.
LLM_KEY_REQUIRE_USER_AFTER=<ISO-8601, e.g. 2026-11-03T00:00:00Z>
# Required to encrypt per-user keys at rest. Generate; never reuse another key.
USER_LLM_KEY_SECRET=<openssl rand -hex 32>

# --- search / research -------------------------------------------------------
TAVILY_API_KEY=<...>
JINA_API_KEY=<...>
EXA_API_KEY=<...>

# --- tracing (optional) ------------------------------------------------------
LANGSMITH_API_KEY=<...>
# LANGSMITH_TRACING=0

# --- skills registry (R2) ----------------------------------------------------
SKILLS_REGISTRY=s3://neuralmatrix
R2_BUCKET=neuralmatrix
R2_ENDPOINT_URL=https://<account>.r2.cloudflarestorage.com
R2_ACCESS_KEY_ID=<...>
R2_SECRET_ACCESS_KEY=<...>
SKILLS_CLI=/var/lib/nm-finance-agent/.local/bin/nm-skills
SKILLS_REQUIRED=1
SKILLS_PUSH_DEBOUNCE_MS=5000
# Alternative checkout mode:
# NM_SKILLS_REGISTRY_HOME=/opt/nm-skills-registry

# --- AgentDB mirror ----------------------------------------------------------
# Remote is recommended: no ONNX/native sidecar on the EC2 host.
AGENTDB_REMOTE_URL=https://<mirror-worker>
AGENTDB_REMOTE_TOKEN=<...>
AGENTDB_REMOTE_STATUS_MS=10000
AGENTDB_REQUEST_TIMEOUT_MS=180000
# Local fallback (only if no remote):
# AGENTDB_MIRROR=0
# AGENTDB_PATH=/var/lib/nm-finance-agent/agent-mirror.db
# AGENTDB_MAX_ELEMENTS=100000

# --- llmwiki (P3 Wiki tab + llm-wiki skill) ----------------------------------
WIKI_API_URL=https://llmwiki.<subdomain>.workers.dev
WIKI_ASSERTION_SECRET=<the service's LLMWIKI_ASSERTION_SECRET>
WIKI_ASSERTION_TTL_SECONDS=600
WIKI_PROXY_TIMEOUT_MS=60000
# WIKI_API_TOKEN must stay empty on a user-facing host: no admin token.
LLMWIKI_URL=https://llmwiki.<subdomain>.workers.dev

# --- SSO BFF authentication --------------------------------------------------
AUTH_MODE=sso
SSO_BASE_URL=https://2.24.91.212:8443
SSO_CLIENT_ID=nm-finance-agent
SSO_CLIENT_SECRET_FILE=/etc/nm-finance-agent/sso-client-secret
# Or inline exactly one: SSO_CLIENT_SECRET=<...>
SSO_CA_FILE=/etc/nm-finance-agent/sso-ca.pem
SSO_TIMEOUT_MS=2000
SSO_RETRIES=1
SSO_CACHE_TTL_SECONDS=30
SSO_TRUSTED_PROXIES=127.0.0.1,::1
SSO_CLIENT_IP_HEADER=cf-connecting-ip
AUTH_REQUIRED_PERMISSION=application.nmfinance
AUTH_SESSION_TTL_DAYS=7
AUTH_COOKIE_NAME=nm_auth
AUTH_COOKIE_SECURE=1
AUTH_DB_PATH=/var/lib/nm-finance-agent/state/auth.db
# Exact public origin, no trailing slash. Replace for a new hostname.
AUTH_ALLOWED_ORIGINS=https://agent.example.com

# --- MCP / cron --------------------------------------------------------------
MCP_SERVERS_FILE=/var/lib/nm-finance-agent/mcp_servers.json
CRON_ENABLED=1
CRON_TICK_MS=30000
CRON_MAX_PARALLEL=2
CRON_CATCH_UP_MISSED=1
CRON_MISFIRE_GRACE_MIN=10
CRON_FAILURE_PAUSE_STREAK=5
CRON_WRAPUP_REMAINING=10

# --- optional skills ---------------------------------------------------------
# INSTABOX_API_KEY=<...>
```

### 8.2 Notes that prevent silent outages

- **`WIKI_API_TOKEN` must be empty.** The agent mints per-user assertions from
  `WIKI_ASSERTION_SECRET`. Do not copy the llmwiki admin token to the agent.
- **`WIKI_ASSERTION_SECRET` must exactly match** the llmwiki service's
  `LLMWIKI_ASSERTION_SECRET`. A mismatch makes the Wiki tab and skill return
  401 while the rest of the app is healthy.
- **`LLMWIKI_URL` is for the skill subprocess**; `WIKI_API_URL` is for the
  server-side proxy. They normally point at the same service.
- **`AUTH_COOKIE_SECURE=1`** is required behind HTTPS. `NODE_ENV=production`
  defaults it on, but set it explicitly.
- **`AUTH_ALLOWED_ORIGINS`** must exactly match the public origin. The
  same-origin guard also compares `Origin` with `Host`.
- **`SSO_CLIENT_IP_HEADER=cf-connecting-ip`** for Cloudflare Tunnel. For direct
  public Caddy without Cloudflare, set `x-forwarded-for` and verify the SSO
  login audit log shows the browser's public IP. `SSO_TRUSTED_PROXIES` must be
  only the local proxy addresses, never public CIDRs.
- **`SKILLS_DIR` must be absolute** and persistent. `SKILLS_STATE_DIR` must be
  writable by `nmagent`.
- **`USER_LLM_KEY_SECRET`** encrypts `state/users/*/llm.json`. If you lose it,
  users must re-enter their keys. If you migrate `state/users`, reuse the same
  secret.
- **No `.env`** in `/opt`; systemd is the only source.
- **`MCP_SERVERS_FILE`** must be absolute and on the writable data volume.

### 8.3 SSO certificate

Fetch the leaf on the VM, verify it with the owner, and install it:

```bash
openssl s_client -connect 2.24.91.212:8443 -servername 2.24.91.212 </dev/null 2>/dev/null \
  | openssl x509 -outform PEM > /tmp/sso-ca.pem
openssl x509 -in /tmp/sso-ca.pem -noout -subject -issuer -dates -fingerprint -sha256
```

Current reference values (verify; do not blindly trust a changed certificate):

```text
subject=CN=2.24.91.212
notAfter=Oct 21 06:38:44 2027 GMT
SHA256=32:91:54:35:C1:53:BE:0D:F8:4D:0E:72:F4:A9:9F:A9:F1:02:BC:D5:13:98:5D:45:96:3E:83:CD:FB:4F:F6:CD
```

Install:

```bash
sudo install -o root -g nmagent -m 644 /tmp/sso-ca.pem /etc/nm-finance-agent/sso-ca.pem
rm -f /tmp/sso-ca.pem
```

**STOP** if the fingerprint/expiry differs from the owner's expectation. A
changed certificate may be a legitimate renewal or an interception; do not
proceed without owner confirmation.

### 8.4 SSO client secret

Preferred: a file readable by `nmagent`:

```bash
# Run as the owner, not the coding agent, and do not echo the value.
read -rs -p 'SSO client secret: ' SECRET && echo
printf '%s' "$SECRET" | sudo tee /etc/nm-finance-agent/sso-client-secret >/dev/null
unset SECRET
sudo chown root:nmagent /etc/nm-finance-agent/sso-client-secret
sudo chmod 640 /etc/nm-finance-agent/sso-client-secret
```

Set `SSO_CLIENT_SECRET_FILE=/etc/nm-finance-agent/sso-client-secret`. If the
owner's existing env file uses inline `SSO_CLIENT_SECRET`, keep exactly **one**
of the two; do not add both.

### 8.5 Validate the env without printing it

```bash
sudo ls -l /etc/nm-finance-agent.env /etc/nm-finance-agent/sso-client-secret /etc/nm-finance-agent/sso-ca.pem
sudo sed -nE 's/^([A-Z0-9_]+)=.*/\1/p' /etc/nm-finance-agent.env | sort | uniq -c
sudo grep -cE '^SSO_CLIENT_SECRET=' /etc/nm-finance-agent.env || true
sudo grep -cE '^SSO_CLIENT_SECRET_FILE=' /etc/nm-finance-agent.env || true
# Exactly one of the two secret-key counts must be 1; the other 0.
```

Check the env parses as a systemd file by starting the unit later and reading
the journal. `EnvironmentFile` values with spaces must be quoted. `#` comments
must be whole lines.

### 8.6 MCP copy

See T5.3. `MCP_SERVERS_FILE` in the env must point at the data copy.

### T6 acceptance

- `/etc/nm-finance-agent.env` exists, `640 root:nmagent`.
- Exactly one SSO secret source.
- SSO CA installed and fingerprint-verified.
- `SKILLS_CLI` path exists and is executable.
- `MCP_SERVERS_FILE` exists and is readable by `nmagent`.
- `WIKI_API_TOKEN` is absent/empty.

---

## 9. T7 — Optional data migration

Do this only if the owner asked. Migration is **not** required for a fresh
deployment.

### 9.1 What to copy

From the old host/laptop, with the old service stopped:

```
/var/lib/nm-finance-agent/
  sessions.db, sessions.db-wal, sessions.db-shm
  auth.db, auth.db-wal, auth.db-shm          # secret; see below
  workspace/                                  # per-user scratch
  memories/                                   # per-user MEMORY.md/USER.md + _shared
  state/                                      # skills/mcp toggles, auth, per-user keys, agentdb
  mcp_servers.json                            # live baseline
  agent-mirror.db                             # only for a local mirror
```

Do **not** copy:

- `/opt/nm-finance-agent/.env` or any `.env` (recreate `/etc` env only).
- `node_modules`, `frontend/node_modules`, `.cache`, logs, backups.
- `skills/` — hydrate from R2 (T5), unless the owner explicitly chooses a
  one-time local import because the bucket is missing.

### 9.2 Stop, copy, verify

```bash
# On the OLD host:
sudo systemctl stop nm-finance-agent
sudo rsync -a --numeric-ids --progress --ignore-missing-args \
  /var/lib/nm-finance-agent/{sessions.db*,auth.db*,workspace,memories,state,mcp_servers.json} \
  <user>@<new-host>:/tmp/nm-migrate/
```

If the old service cannot be stopped, use `sqlite3 .backup` for a consistent
copy; copy the WAL/SHM siblings with it.

```bash
# On the NEW host, with the app NOT yet started:
sudo install -d -o nmagent -g nmagent -m 700 /var/lib/nm-finance-agent
sudo rsync -a --chown=nmagent:nmagent /tmp/nm-migrate/ /var/lib/nm-finance-agent/
sudo chown -R nmagent:nmagent /var/lib/nm-finance-agent
sudo -u nmagent sqlite3 /var/lib/nm-finance-agent/sessions.db 'PRAGMA integrity_check;'
sudo -u nmagent sqlite3 /var/lib/nm-finance-agent/state/auth.db 'PRAGMA integrity_check;'
```

- Copy `sessions.db-wal` and `sessions.db-shm` with the db; without the WAL the
  last turns are lost.
- `auth.db` holds refresh/access tokens. Treat it as secret: mode `600`,
  encrypted backups only, never print rows. On a **new hostname**, existing
  browser cookies will not be sent, so migrating it is optional; users can
  re-login.
- `state/users/<id>/llm.json` is encrypted with `USER_LLM_KEY_SECRET`. If you
  migrate it, reuse the exact old secret; otherwise omit it and users re-enter
  their keys.
- `state/users/<id>/{skills,mcp}.json` are user toggles; copy `state/` as a
  whole.
- `memories/` contains per-user dirs and `_shared/MEMORY.md`; preserve modes.
- `workspace/` can be large; copy only if the owner wants the
  history/scratch.
- `skills/` comes from R2; do not copy stale local skills over the pull.
- `agent-mirror.db` only if `AGENTDB_REMOTE_URL` is unset and the local sidecar
  is chosen.

### T7 acceptance

```bash
sudo -u nmagent sqlite3 /var/lib/nm-finance-agent/sessions.db 'PRAGMA integrity_check;'
sudo namei -l /var/lib/nm-finance-agent/state/auth.db
# auth.db 600 nmagent:nmagent (WAL/SHM may be created while running)
```

**STOP** if `integrity_check` is not `ok`, ownership is wrong, or the old
`.env` was copied into `/opt`.

---

## 10. T8 — systemd service

### 10.1 Unit

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
UMask=0077
ExecStart=/usr/local/bin/npm run start
Restart=always
RestartSec=3
TimeoutStopSec=20
KillSignal=SIGTERM

# Hardening: code is read-only, data is writable.
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

# Optional on a 4 GiB host; omit or raise on 8 GiB:
# MemoryMax=6G

[Install]
WantedBy=multi-user.target
```

Why `UMask=0077`: SQLite WAL/SHM files for `auth.db` otherwise inherit a
permissive mode while the service runs.

If `SKILLS_DIR`, `MCP_SERVERS_FILE`, or any path lives outside
`/var/lib/nm-finance-agent`, add it to `ReadWritePaths` only if it is genuinely
data, not code.

### 10.2 Start and inspect

Do **not** start until T5/T6 are green. `SKILLS_REQUIRED=1` intentionally
crash-loops on an unseeded bucket.

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now nm-finance-agent
systemctl status nm-finance-agent --no-pager
sudo journalctl -u nm-finance-agent -n 100 --no-pager
```

Expected boot evidence:

- `runtime assembled: N tools (... MCP server(s))`
- `skills sync — N pulled ...`
- `auth: SSO reachable at https://...`
- `nm-finance-agent listening on http://127.0.0.1:3001`
- no `AUTH_MODE=sso:` configuration error
- no `SKILLS_REQUIRED` exit

Common failures:

| Symptom | Cause/fix |
|---|---|
| `Cannot find module 'tsx'` | `npm ci` ran with `--omit=dev`; re-run without it |
| `EADDRINUSE` | another process on 3001; `ss -ltnp \| grep 3001` |
| exit loop with `SKILLS_REQUIRED=1` | skills preflight failed; fix T5 |
| `AUTH_MODE=sso: ... is required` | missing env key; fix T6 |
| `AUTH_MODE=sso: SSO_CA_FILE is unreadable` | cert path/mode; reinstall |
| `EACCES` under `/var/lib` | ownership; `chown -R nmagent:nmagent` |
| `ProtectSystem` denial | journal names the path; add only data paths to `ReadWritePaths` |

### T8 acceptance

```bash
systemctl is-active nm-finance-agent
curl -fsS http://127.0.0.1:3001/api/health | jq '{status,auth,skills,skills_backend,mirror,mcp_connected}'
ss -ltn | grep 3001   # 127.0.0.1:3001 only
```

---

## 11. T9 — Caddy, TLS, and the public edge

### 11.1 Option A (recommended): Caddy + Cloudflare Tunnel

No inbound 80/443 is required. Caddy listens only on loopback; `cloudflared`
makes an outbound tunnel.

Create `/etc/caddy/Caddyfile`:

```caddyfile
:8080 {
	bind 127.0.0.1
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

Why `:8080` and not `http://127.0.0.1:8080`: Caddy treats the latter as a
host matcher; the tunnel forwards `Host: agent.example.com`, so the site would
not match and return an empty 200. `:8080` matches any host; `bind` keeps it
loopback-only.

Install the Caddy service:

```ini
# /etc/systemd/system/caddy.service
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

```bash
sudo useradd --system --home-dir /var/lib/caddy --shell /usr/sbin/nologin caddy 2>/dev/null || true
sudo install -d -o caddy -g caddy -m 750 /var/lib/caddy /etc/caddy
sudo systemctl daemon-reload
sudo systemctl enable --now caddy
sudo usermod -aG nmagent caddy
sudo systemctl restart caddy
sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
```

Caddy must be able to read `/opt/nm-finance-agent/frontend/dist`. The
`unix group` membership plus the `deploy:nmagent 750` tree is sufficient; if
you use a different layout, grant read access explicitly.

Install the tunnel with an owner-supplied token:

```bash
# Do not paste the token into chat or a committed file. The owner supplies it;
# install it during the maintenance window, then clear the variable.
read -rs -p 'Cloudflare Tunnel token: ' TUNNEL_TOKEN && echo
sudo cloudflared service install "$TUNNEL_TOKEN"
unset TUNNEL_TOKEN
sudo systemctl enable --now cloudflared
systemctl status cloudflared --no-pager
```

Cloudflare dashboard (owner):

- Zero Trust → Networks → Tunnels → create/select the tunnel.
- Public hostname `agent.example.com` → `http://127.0.0.1:8080`.
- Optional Access application; the app SSO alone is the current production
  posture. If Access is enabled, it is a second login, not a replacement for
  app SSO.
- Cloudflare WAF rate-limit rule for `/api/auth/login` is optional but
  recommended on a public edge: 5 requests / 10 s per IP, block 10 s.

Verify through Caddy with the public Host before involving the tunnel:

```bash
curl -sI -H 'Host: agent.example.com' http://127.0.0.1:8080/ | head -5
# expect 200, text/html, non-zero Content-Length
curl -sS -H 'Host: agent.example.com' http://127.0.0.1:8080/api/health \
  | jq '{status,auth,skills,mcp_connected}'
```

### 11.2 Option B: public Caddy + Elastic IP + Let's Encrypt

Use this only if the owner does not want a Cloudflare Tunnel. Attach an Elastic
IP and point the DNS A record at it. Security Group: 80/443 inbound.

```caddyfile
agent.example.com {
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

- Do not add `encode` to `/api`; compression buffers SSE.
- Optional Caddy `basic_auth` can sit in front, but it is a second login. App
  SSO is still required.
- If there is no Cloudflare in front, set
  `SSO_CLIENT_IP_HEADER=x-forwarded-for` and keep
  `SSO_TRUSTED_PROXIES=127.0.0.1,::1`. Caddy sets `X-Forwarded-For` from the
  browser. Verify the SSO login audit shows the public IP, not `127.0.0.1`.
- If Cloudflare proxies a public Caddy, keep `cf-connecting-ip` and ensure
  Caddy forwards it.

### 11.3 SSE and assets

- `/api/*`: `flush_interval -1`; no gzip/encode; no proxy buffering.
- `/`: static `frontend/dist`, SPA fallback `index.html`.
- Caddy should not cache API responses.
- After a frontend rebuild, asset hashes change; hard-refresh the browser.

### T9 acceptance

```bash
curl -sI -H 'Host: agent.example.com' http://127.0.0.1:8080/ | head -5
ss -ltn | grep -E ':(3001|8080)\b'   # loopback only
systemctl is-active caddy cloudflared
```

For public Caddy, also:

```bash
curl -sI https://agent.example.com/ | head -5
```

**STOP** if `3001` or `8080` is listening on a public interface, or if the
tunnel proxies directly to 3001 (it must go through Caddy).

---

## 12. T10 — SSO rollout

### 12.1 Preconditions

- `AUTH_MODE=sso` env block in place (T6).
- SSO CA installed and fingerprint-verified.
- Exactly one SSO client secret source.
- Owner confirmed the `nm-finance-agent` ServiceClient and
  `application.nmfinance` grant.
- The new frontend build includes the login screen.
- `AUTH_COOKIE_SECURE=1` and `AUTH_ALLOWED_ORIGINS` match the public origin.

### 12.2 Restart and check

```bash
sudo systemctl restart nm-finance-agent
sleep 3
sudo journalctl -u nm-finance-agent -n 100 --no-pager
```

Expected log:

```text
auth: SSO reachable at https://2.24.91.212:8443
```

Must not show:

```text
auth: SSO unreachable at boot
auth: AUTH_COOKIE_SECURE is off
AUTH_MODE=sso: ...
```

Health through Caddy (Host header for tunnel mode):

```bash
curl -sS -H 'Host: agent.example.com' http://127.0.0.1:8080/api/health \
  | jq '{status,auth,model,skills,skills_required,skills_backend,mirror,mcp_connected}'
```

Expect `auth.mode=sso` and `required_permission=application.nmfinance`.
`/api/health` stays unauthenticated; every other `/api/*` route requires the
cookie.

```bash
curl -s -o /dev/null -w 'sessions=%{http_code}\n' \
  -H 'Host: agent.example.com' http://127.0.0.1:8080/api/sessions   # 401
curl -s -o /dev/null -w 'health=%{http_code}\n' \
  -H 'Host: agent.example.com' http://127.0.0.1:8080/api/health     # 200
```

### 12.3 Browser acceptance (owner present)

1. Open the public URL; the app login card renders (not blank).
2. Log in with the granted account; the app loads.
3. Reload; the session persists.
4. Send a chat turn; SSE streams incrementally; Stop cancels.
5. Open a session, the Wiki tab, and a settings/MCP toggle.
6. Check `nm_auth` cookie: `HttpOnly`, `Secure`, `SameSite=Strict`, `Path=/`.
7. Check the login response has no `access_token`/`refresh_token`.
8. Sign out → login; reload stays logged out.
9. Wrong password → `Wrong username or password.` (no account enumeration).
10. SSO audit log shows the browser's public IP, not `127.0.0.1`. If it shows
    loopback, the client-IP header/trusted-proxy configuration is wrong; stop
    and fix it before declaring done (SSO IP binding may be enforced).
11. An account without the grant gets `Access required` and API 403; grant
    `application.nmfinance` in the SSO admin UI, wait ≤30 s for introspection,
    reload.

### 12.4 Rollback warning

`AUTH_MODE=off` is only safe when the app is not publicly reachable. With a
Tunnel/public Caddy it exposes the entire app. For a short controlled test:
switch to `off`, verify, and immediately restore `sso`; for a longer rollback,
stop the service or re-enable Cloudflare Access. Never leave `AUTH_MODE=off`
on a public host.

### T10 acceptance

- `systemctl is-active nm-finance-agent`
- `auth.mode=sso` in `/api/health`
- `/api/sessions` 401 unauthenticated, `/api/health` 200
- `auth.db` mode 600, owner `nmagent`
- Browser login/reload/logout/SSE/Wiki/MCP pass
- Cookie flags correct
- SSO audit IP correct

---

## 13. T11 — llmwiki P3 integration (Wiki tab + skill)

This app is a client of the remote `llm-wiki-svc`; do not deploy that service
on this host. The service's P3 deployment provides private/shared wikis and
short-lived user assertions.

### 13.1 Required values

```ini
WIKI_API_URL=https://llmwiki.<subdomain>.workers.dev
WIKI_ASSERTION_SECRET=<llmwiki service LLMWIKI_ASSERTION_SECRET>
WIKI_ASSERTION_TTL_SECONDS=600
WIKI_PROXY_TIMEOUT_MS=60000
LLMWIKI_URL=https://llmwiki.<subdomain>.workers.dev
# WIKI_API_TOKEN=            # leave empty
```

- `WIKI_ASSERTION_SECRET` is a **root credential for user-scope wikis**. Keep
  the env file `640 root:nmagent`; do not put it in a user shell or repo.
- The agent mints a short-lived HS256 assertion in `src/wiki-auth.ts`; the
  service verifies it with the same secret. No SSO token goes to the wiki.
- `WIKI_API_TOKEN` is the legacy/local admin credential; **do not set it** on a
  user-facing host.
- `WIKI_API_URL` defaults to `http://127.0.0.1:8010`, which is wrong on EC2.
  Always set the remote URL.
- `LLMWIKI_URL` is read by the `llm-wiki` skill subprocess. Set it to the same
  service.
- The Wiki tab defaults to **My wiki** (private). The shared common wiki is an
  explicit switch. Common writes require an admin grant in the llmwiki
  registry; the agent has no admin token.

### 13.2 Verification

After login in the browser:

1. Open **Wiki**. The switch shows **My wiki / Shared wiki**; private is
   selected.
2. The private domain list loads (first read initializes the private wiki).
3. Search a known private page and open it.
4. Switch to **Shared wiki**; search a known common page.
5. The graph reads page bodies from the same scope.
6. Ask the agent about a page; the prefill names the scope and `--common` for
   shared pages.

From a shell, without exposing the cookie, the app-level endpoint is
authenticated; use the UI rather than trying to mint the app cookie. A 401 on
`/api/wiki/*` from the browser usually means:

- `WIKI_ASSERTION_SECRET` empty/mismatched with the service;
- `WIKI_API_URL` wrong;
- the service Worker/Container is down or cold (wait/retry; proxy budget 60 s);
- the user is not signed in to the app.

A 403 `common_write_denied` from the skill means the user has no common-write
grant; capture to private or ask the llmwiki admin to grant it. A 429
`source quota reached` is the llmwiki per-user source cap, not an nm-finance
error.

### 13.3 Admin grants and quotas (llmwiki side)

These are run against the llmwiki service's R2/local data, not this host:

```bash
cd ~/projects/llm-wiki-svc
python scripts/users.py list
python scripts/users.py grant <owner>
python scripts/users.py quota <owner> --monthly-usd 5 --sources 200
python scripts/users.py disable <owner>
```

The app's skill defaults to private; `--common` is the explicit shared read or
granted write. The Wiki tab is read-only.

### T11 acceptance

- Wiki tab private/common switch works.
- Private and shared searches return the expected isolated pages.
- `llm-wiki` skill `whoami`/`init` works from a chat turn.
- No `WIKI_API_TOKEN` is present.

---

## 14. T12 — Functional and security acceptance

Run all of these before handover.

### 14.1 Service and health

```bash
systemctl is-active nm-finance-agent caddy
# Tunnel mode only:
systemctl is-active cloudflared 2>/dev/null || true

curl -fsS http://127.0.0.1:3001/api/health \
  | jq '{status,auth,model,base_url,skills,skills_required,skills_backend,mirror,mcp_connected,mcp_tools,research,time}'
```

Expected:

- `status=ok`
- `auth.mode=sso` and `required_permission=application.nmfinance`
- `skills > 0`, `skills_backend.degraded=false`
- `mirror.enabled=true` (remote) or the documented local state
- `mcp_connected` matches the servers you enabled
- `research.enabled=true`

### 14.2 Edge and auth

```bash
curl -sI -H 'Host: agent.example.com' http://127.0.0.1:8080/ | head -5
curl -s -o /dev/null -w 'health=%{http_code}\n' \
  -H 'Host: agent.example.com' http://127.0.0.1:8080/api/health
curl -s -o /dev/null -w 'sessions=%{http_code}\n' \
  -H 'Host: agent.example.com' http://127.0.0.1:8080/api/sessions
ss -ltn | grep -E ':(3001|8080)\b'
```

Expect root 200 HTML, health 200, sessions 401, and both listeners loopback
only. For public Caddy, verify `https://agent.example.com/` and the same API
codes.

### 14.3 Agent behavior

From the browser UI:

- Chat streams incrementally; Stop cancels; a reload restores the session.
- Ask: `run pwd and ls -la`; output must show
  `/var/lib/nm-finance-agent/workspace/<login-id>`.
- Ask it to load a known skill; `load_skill` returns a real `SKILL.md`.
- Open **Scheduled**; create a one-shot job 2 minutes out; it fires within one
  tick (~30 s), produces a `scheduled` session, and disables itself. Delete it.
- Open **Wiki**; private/common switch works (T11).
- Settings → Model & key shows the per-user key policy; if
  `require_user` is enforced, add a key or confirm the grace window.
- Optional: a `/research` question (slow, real spend) or a known MCP tool.

### 14.4 Security

```bash
sudo namei -l /var/lib/nm-finance-agent/state/auth.db
sudo ls -l /etc/nm-finance-agent.env /etc/nm-finance-agent/sso-client-secret \
  /etc/nm-finance-agent/sso-ca.pem
sudo grep -RIl 'OPENROUTER_API_KEY=.*[^=]' /opt/nm-finance-agent --exclude-dir=node_modules || true
getenforce || true
```

- `auth.db` 600 `nmagent:nmagent`; env file 640 `root:nmagent`.
- No real secrets in git or `/opt`.
- Security Group has no 3001/8080 inbound.
- `AUTH_MODE=sso`; `AUTH_COOKIE_SECURE=1`.
- `WORKSPACE_HARD_JAIL=1`.
- `SKILLS_REQUIRED=1`.
- `agent_browser` disabled unless explicitly requested.
- `WIKI_API_TOKEN` empty.
- SELinux left in its default/enforcing posture; investigate denials, never
  `setenforce 0`.

---

## 15. Cron and timezone

Cron is **in-process**; do not add a systemd timer or host crontab.

```ini
CRON_ENABLED=1
CRON_TICK_MS=30000
CRON_MAX_PARALLEL=2
CRON_CATCH_UP_MISSED=1
CRON_MISFIRE_GRACE_MIN=10
CRON_FAILURE_PAUSE_STREAK=5
CRON_WRAPUP_REMAINING=10
```

- Server timezone is UTC (`get /api/cron/jobs` reports `server_timezone`).
- Jobs accept an IANA `timezone`. If the owner works in UTC+8, create jobs with
  `Asia/Hong_Kong` rather than assuming the server clock.
- A restart marks in-flight runs `interrupted`; missed fires catch up once
  within the grace window, then re-anchor.
- Five consecutive failed fires auto-pause a job; history remains.
- Scheduled runs execute with the owner's workspace/tool policy and cannot
  create more cron jobs (loop prevention).
- Test with a throwaway one-shot; delete it after.

---

## 16. T13 — Backups, monitoring, updates

### 16.1 Backups

Use **both**:

1. **EBS snapshots** (AWS Backup/DLM) of the encrypted data volume, daily,
   retained 7–30 days. This is the disaster-recovery baseline.
2. **App-consistent SQLite copies** to `/var/backups/nm-finance-agent` and,
   optionally, encrypted S3/R2/restic. The live DBs may be in WAL mode.

```bash
sudo install -d -o nmagent -g nmagent -m 700 /var/backups/nm-finance-agent
sudo -u nmagent sqlite3 /var/lib/nm-finance-agent/sessions.db \
  ".backup '/var/backups/nm-finance-agent/sessions.db'"
sudo -u nmagent sqlite3 /var/lib/nm-finance-agent/state/auth.db \
  ".backup '/var/backups/nm-finance-agent/auth.db'"
```

- `auth.db` contains refresh/access tokens; `state/users/*/llm.json` contains
  encrypted keys. Treat backups as secret material; encrypt at rest or exclude
  them and require re-login/re-entry.
- If you back up `state/users`, keep `USER_LLM_KEY_SECRET` in a secrets manager;
  without it the key files cannot be decrypted.
- Do not mix backups with the skills bucket.
- Test a restore before handover: restore to `/tmp`, run
  `PRAGMA integrity_check`, inspect workspace/memories, then delete the test
  copy.

A simple systemd timer:

```ini
# /etc/systemd/system/nm-backup.service
[Unit]
Description=nm-finance-agent SQLite backup
[Service]
Type=oneshot
User=nmagent
EnvironmentFile=-/etc/nm-backup.env
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

A minimal `nm-backup.sh` (install as `root:root 755`; it contains no secrets —
the restic credentials live in `/etc/nm-backup.env`; `auth.db` is secret
material, so the optional off-host copy must be encrypted):

```bash
#!/usr/bin/env bash
set -euo pipefail
DATA=/var/lib/nm-finance-agent
STAGE=/var/backups/nm-finance-agent
install -d -m 700 "$STAGE"

# Consistent SQLite snapshots; never `cp` a live WAL database.
sqlite3 "$DATA/sessions.db" ".backup '$STAGE/sessions.db'"
sqlite3 "$DATA/state/auth.db" ".backup '$STAGE/auth.db'"

# Optional: encrypted off-host copy (configure in /etc/nm-backup.env, 640 root:nmagent).
# Do not source an unencrypted backup of auth.db or state/users onto a shared box.
if [ -n "${RESTIC_REPOSITORY:-}" ]; then
  restic backup "$DATA" "$STAGE" \
    --exclude "$DATA/sessions.db" --exclude "$DATA/sessions.db-wal" \
    --exclude "$DATA/sessions.db-shm" \
    --exclude "$DATA/state/auth.db" --exclude "$DATA/state/auth.db-wal" \
    --exclude "$DATA/state/auth.db-shm" \
    --exclude "$STAGE/auth.db" \
    --tag nm-finance-agent
  restic forget --keep-daily 7 --keep-weekly 4 --prune
fi
```

If `auth.db` is excluded from off-host backups, users simply re-login after a
restore. If it is included, encrypt the repository and treat the restic
password as a production secret. The same applies to
`state/users/*/llm.json` and `USER_LLM_KEY_SECRET`.

### 16.2 Monitoring

- CloudWatch agent (optional) for CPU, disk, memory, and `/var/log/messages`;
  alarms for status-check failure, disk >80%, memory pressure, and OOM.
- App logs stay in journald; use `journalctl -u nm-finance-agent` and SSM.
- Health probe: `GET /api/health` from a local/CloudWatch synthetic or a
  CloudWatch alarm on a custom metric.
- `journalctl` retention: configure `SystemMaxUse` if disk is small.
- Watch `free -h`, swap, `dmesg -T | grep -i oom`, and `df -h`.
- A 2 GiB instance is not recommended; resize rather than removing swap.

### 16.3 Updates

```bash
# 1. Backup first.
sudo -u deploy git -C /opt/nm-finance-agent fetch --tags
sudo -u deploy git -C /opt/nm-finance-agent checkout <new-tag-or-sha>
sudo -u deploy git -C /opt/nm-finance-agent status --short   # clean

# 2. Build the exact tree.
sudo -u deploy bash -lc 'cd /opt/nm-finance-agent && npm ci'
sudo -u deploy bash -lc 'cd /opt/nm-finance-agent/frontend && npm ci && npm run build'
sudo -u deploy bash -lc 'cd /opt/nm-finance-agent && npm run check'
sudo -u deploy mkdir -p /tmp/nm-test/{workspace,memories}
sudo -u deploy env AUTH_MODE=off OPENROUTER_API_KEY=presence-only \
  SESSION_DB_PATH=/tmp/nm-test/sessions.db WORKSPACE_DIR=/tmp/nm-test/workspace \
  MEMORY_DIR=/tmp/nm-test/memories AUTH_DB_PATH=/tmp/nm-test/auth.db \
  AGENTDB_PATH=/tmp/nm-test/agent-mirror.db \
  bash -lc 'cd /opt/nm-finance-agent && npm test'

# 3. Restart and verify.
sudo systemctl restart nm-finance-agent
sudo journalctl -u nm-finance-agent -n 80 --no-pager
```

- There are no destructive migrations; tables are additive.
- `/var/lib/nm-finance-agent` is never touched by a code checkout.
- Rollback = previous tag + `npm ci` + frontend build + restart. The DB may
  contain newer additive tables; older code ignores them.
- Frontend changes require the Vite build; hard-refresh after deploy.
- Skills CLI upgrade is separate and pinned: install the new tag as `nmagent`,
  update `SKILLS_CLI` if the path changes, restart.

---

## 17. Security checklist

- [ ] EC2 Security Group: no 3001/8080; 22 only from admin IP; 80/443 only for
      public Caddy; outbound all or 443 + 7844 TCP/UDP for Tunnel.
- [ ] App listens on `127.0.0.1:3001`; Caddy on `127.0.0.1:8080`.
- [ ] App runs as `nmagent`, not root; code owned by `deploy`.
- [ ] `/etc/nm-finance-agent.env` is `640 root:nmagent`; no repo `.env`.
- [ ] `AUTH_MODE=sso`; `application.nmfinance` confirmed; `AUTH_COOKIE_SECURE=1`.
- [ ] `auth.db` mode 600; `UMask=0077`; backups encrypted or excluded.
- [ ] SSO leaf pinned; fingerprint/expiry recorded; renewal owner assigned.
- [ ] SSO client secret file `640 root:nmagent` or inline env; exactly one.
- [ ] `WIKI_API_TOKEN` empty; `WIKI_ASSERTION_SECRET` matches the service;
      service admin token never reaches user shells.
- [ ] `WORKSPACE_HARD_JAIL=1`; `SKILLS_REQUIRED=1`.
- [ ] `agent_browser` disabled unless Chromium was explicitly installed.
- [ ] `USER_LLM_KEY_SECRET` set if per-user keys are enabled; encryption tested.
- [ ] R2 credentials scoped to the skills bucket; backups use a separate bucket.
- [ ] EBS encrypted; IMDSv2 required; SSM/SSH restricted.
- [ ] SELinux not disabled; no `setenforce 0`.
- [ ] WAF/app login rate limiting considered on a public edge.
- [ ] Install and test `dnf-automatic`/patching.
- [ ] Single-process trust model understood: path separation, not hostile
      tenant isolation; per-user containers are out of scope.

---

## 18. Troubleshooting

| Symptom | Check / action |
|---|---|
| Service exits immediately | `journalctl -u nm-finance-agent -n 100`; Node 24; env parse; port; permissions |
| `Cannot find module 'tsx'` | `npm ci` with devDependencies; `tsx` is the runtime |
| `EADDRINUSE` | `ss -ltnp \| grep 3001`; stop the other process |
| Env changes ignored | remove `/opt/nm-finance-agent/.env`; `dotenv` overrides systemd; restart |
| `skills_backend.degraded=true` | run `"$SKILLS_CLI" doctor` as `nmagent`; check R2, `SKILLS_DIR`, CLI path |
| Crash loop with `SKILLS_REQUIRED=1` | expected on an unseeded bucket; fix T5, restart |
| `auth: SSO unreachable at boot` | SSO down/cert/timeout; `curl -k .../healthz`; check CA path/fingerprint |
| Login 503 `sso_unavailable` | SSO network/cert/timeout; inspect `journalctl` |
| Login 502 `sso_client_rejected` | wrong/inactive ServiceClient or secret; owner fixes |
| Login 401 `invalid_credentials` | wrong password; expected |
| Login 403 `account_inactive` | SSO account suspended |
| UI `Access required` / API 403 | missing `application.nmfinance` grant; grant and wait ≤30 s |
| 401 immediately after login | cookie rejected: `AUTH_COOKIE_SECURE` vs HTTPS, `AUTH_ALLOWED_ORIGINS`, SSO IP binding |
| Every API 503 after working | SSO fail-closed; restore SSO |
| Blank page through tunnel | Caddy site must be `:8080` + `bind 127.0.0.1`; test with public Host header |
| SSE arrives all at once | Caddy `flush_interval -1`; no `encode`/gzip on `/api`; app is proxied |
| 502 from Caddy | app not listening on 3001; `systemctl status`; `ss` |
| Wiki 401 | `WIKI_API_URL`, `WIKI_ASSERTION_SECRET` mismatch, not signed in, service cold |
| Wiki private empty | expected for a new private wiki; switch Shared or initialize/ingest |
| Common write 403 | no llmwiki `common_write` grant; use private or ask admin |
| Source quota 429 | llmwiki `quota.sources`; admin raises/clears |
| Skills/MCP missing | `nm-skills doctor`; MCP config path; `agent_browser`/vibe executable |
| AgentDB mirror degraded | remote URL/token; or local `AGENTDB_MIRROR=0`; memory pressure |
| Cron never fires | `CRON_ENABLED=1`, service active, tick; server timezone vs job timezone |
| Cron job paused (failing) | inspect run history/last_error; five failures auto-pause; resume |
| `execute` fails | workspace ownership; `ls -ld /var/lib/.../workspace`; `WORKSPACE_HARD_JAIL` |
| OOM / slow | `free -h`, swap, `dmesg`; resize to 4 GiB+; don't remove swap blindly |
| Disk full | `df -h`, journald, logs, workspace; clean logs/artifacts |
| Cert warning <30 days | replace pinned SSO leaf, restart, re-verify |
| WAF 429/1015 on login | Cloudflare rate limit; wait 10 s; app limiter 10/min |
| SSH locked out | use SSM Session Manager (instance profile) |
| EBS not mounted | `/etc/fstab` UUID + `nofail`; `findmnt`; re-check device |
| `AUTH_MODE=off` unexpectedly public | stop; restore SSO or re-enable Access; never leave public without auth |

---

## 19. Definition of done and handover

Done when all are true:

1. `systemctl is-active nm-finance-agent caddy` (and `cloudflared` in tunnel
   mode) is `active`; units are enabled.
2. `/api/health` is `status=ok`; `auth.mode=sso`; skills >0 and not degraded;
   mirror and MCP states match the chosen configuration.
3. `/api/health` is 200 without auth; `/api/sessions` is 401.
4. Browser login/reload/logout; SSE/Stop; sessions; Wiki private/shared; cron
   test; skills; MCP; workspace.
5. `execute` lands in `/var/lib/nm-finance-agent/workspace/<login>`.
6. `llmwiki` Wiki tab works for private and shared; no admin token in the
   agent.
7. SSO audit shows the public browser IP; cookie flags correct.
8. `auth.db` 600; env 640; no `.env` in `/opt`; no secret in git.
9. Backups configured and a restore of `sessions.db` tested; `auth.db`/per-user
   key backup decision recorded.
10. Update/rollback procedure exercised or at least documented with the
    previous ref.
11. Reboot test: app, Caddy, and tunnel return (if safe).
12. No 3001/8080 public exposure.

Handover report template:

```md
## nm-finance-agent EC2 deployment — <date>
- Host / region / AZ / OS / size:
- Repo ref: <sha/tag> <subject>; clean tree: yes/no
- Paths: APP_DIR=/opt/nm-finance-agent DATA_DIR=/var/lib/nm-finance-agent ENV=/etc/nm-finance-agent.env
- Node / npm / uv / Caddy / cloudflared:
- Ingress: Tunnel + Caddy | public Caddy + EIP
- Public hostname:
- App listeners: 127.0.0.1:3001; Caddy 127.0.0.1:8080
- Auth: SSO BFF, permission, cookie flags, auth.db mode
- SSO certificate: subject / notAfter / SHA256
- Skills: N, registry, degraded=false, CLI path
- Mirror: remote|local, enabled=...
- MCP: servers/tools; agent_browser disabled yes/no
- llmwiki: URL, P3 private/shared verified; WIKI_API_TOKEN empty
- LLM key policy: prefer_user|require_user|server_only; require-after; secret set
- Cron: enabled/tick/timezone; test job result
- Backups: EBS/DLM + SQLite; restore tested yes/no; auth/key handling
- Tests: npm run check; npm test (N pass)
- Security: SG, AUTH_COOKIE_SECURE, WORKSPACE_HARD_JAIL, no public 3001/8080
- Deviations:
- Open items:
```

---

## Appendix A — environment key index

```
Server/data: NODE_ENV SERVER_HOST SERVER_PORT LANGCHAIN_PROJECT
SESSION_DB_PATH WORKSPACE_DIR MEMORY_DIR SKILLS_DIR SKILLS_STATE_DIR
AGENTDB_MCP_DIR WORKSPACE_HARD_JAIL
LLM: OPENROUTER_API_KEY OPENROUTER_BASE_URL OPENROUTER_MODEL_MAIN
OPENROUTER_MODEL_SUMMARIZER OPENROUTER_MAIN_MODEL_PROVIDER
OPENROUTER_PROVIDER_IGNORE OPENROUTER_PROVIDER_FALLBACKS OPENROUTER_REASONING
User keys: LLM_KEY_POLICY LLM_KEY_REQUIRE_USER_AFTER USER_LLM_KEY_SECRET
Search/research: TAVILY_API_KEY JINA_API_KEY EXA_API_KEY RESEARCH_* 
Tracing: LANGSMITH_API_KEY LANGSMITH_TRACING LANGCHAIN_PROJECT
Skills: SKILLS_REGISTRY R2_BUCKET R2_ENDPOINT_URL R2_ACCESS_KEY_ID
R2_SECRET_ACCESS_KEY SKILLS_CLI SKILLS_REQUIRED SKILLS_PUSH_DEBOUNCE_MS
NM_SKILLS_REGISTRY_HOME
Mirror: AGENTDB_REMOTE_URL AGENTDB_REMOTE_TOKEN AGENTDB_REMOTE_STATUS_MS
AGENTDB_REQUEST_TIMEOUT_MS AGENTDB_MIRROR AGENTDB_PATH AGENTDB_MAX_ELEMENTS
llmwiki: WIKI_API_URL WIKI_ASSERTION_SECRET WIKI_ASSERTION_TTL_SECONDS
WIKI_PROXY_TIMEOUT_MS LLMWIKI_URL (WIKI_API_TOKEN empty)
Auth: AUTH_MODE SSO_BASE_URL SSO_CLIENT_ID SSO_CLIENT_SECRET
SSO_CLIENT_SECRET_FILE SSO_CA_FILE SSO_TIMEOUT_MS SSO_RETRIES
SSO_CACHE_TTL_SECONDS SSO_TRUSTED_PROXIES SSO_CLIENT_IP_HEADER
AUTH_REQUIRED_PERMISSION AUTH_SESSION_TTL_DAYS AUTH_COOKIE_NAME
AUTH_COOKIE_SECURE AUTH_DB_PATH AUTH_ALLOWED_ORIGINS
MCP/cron: MCP_SERVERS_FILE CRON_ENABLED CRON_TICK_MS CRON_MAX_PARALLEL
CRON_CATCH_UP_MISSED CRON_MISFIRE_GRACE_MIN CRON_FAILURE_PAUSE_STREAK
CRON_WRAPUP_REMAINING
Optional: INSTABOX_API_KEY
```

## Appendix B — current reference values (verify, do not copy secrets)

| Item | 2026-10-27 reference |
|---|---|
| Public URL | `https://agent.neuralmatrix.site` |
| SSO base | `https://2.24.91.212:8443` |
| SSO client | `nm-finance-agent` |
| Required permission | `application.nmfinance` |
| SSO cert | `CN=2.24.91.212`; expires 2027-10-21; SHA256 `32:91:54:35:C1:53:BE:0D:F8:4D:0E:72:F4:A9:9F:A9:F1:02:BC:D5:13:98:5D:45:96:3E:83:CD:FB:4F:F6:CD` |
| Skills registry | `s3://neuralmatrix` |
| Skills CLI | `nm-skills` v0.1.7 |
| AgentDB mirror | remote Cloudflare Container (see `container/README.md`) |
| llmwiki | `https://llmwiki.iamlegacydevelop.workers.dev` |
| Existing instance | `t4g.small`, 1.8 GiB + 2 GiB swap (below new-host minimum) |
| Existing units | `nm-finance-agent`, `caddy`, `cloudflared` |
| Cookie | `nm_auth`; HttpOnly, Secure, SameSite=Strict, Path=/ |
| Test suite at this date | 190 passing |

## Appendix C — Ubuntu 24.04 differences

The app is OS-neutral; the runbook is AL2023-first. On Ubuntu 24.04:

- Use `apt-get`; install `git jq unzip tar xz-utils rsync build-essential
  python3 python3-venv sqlite3 ca-certificates`; use the Node 24 tarball (or
  NodeSource) and the Caddy/cloudflared static binaries.
- Use `ufw` only if the owner wants a host firewall; mirror the Security Group.
- `unattended-upgrades` replaces `dnf-automatic`.
- Paths, users, systemd unit, Caddyfile, env keys, SSO, R2, and llmwiki steps
  are unchanged.
- SELinux is not present; AppArmor may be. Do not disable it blindly.

## Appendix D — intentionally out of scope

- Multi-host/HA, Kubernetes, ECS/EKS.
- Per-user containers or hostile-tenant isolation.
- Deploying the llmwiki service locally (use the remote service).
- Deploying the AgentDB mirror container (see `container/README.md`).
- OAuth2 browser flows / token-in-JS; the BFF is deliberate.
- `agent_browser`/Chromium unless explicitly requested.
- Local LLM servers.
- Express static serving; Caddy owns static assets.
- Backups of unencrypted `auth.db`/per-user key material.
