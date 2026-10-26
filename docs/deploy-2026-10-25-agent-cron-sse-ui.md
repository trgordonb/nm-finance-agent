# Deployment — agent cron, chat SSE reliability, UI rework, vibe_trading MCP

**Date:** 2026-10-25
**Audience:** the coding agent on the EC2 VM (`us-east-1`, AL2023, single
`nm-finance-agent.service`, app at `/opt/nm-finance-agent`, state at
`/var/lib/nm-finance-agent`). Read this before deploying.
**Runbook:** the general procedures live in
[`vm-deployment-runbook.md`](./vm-deployment-runbook.md); this document is the
increment on top — what changed, what is new on the VM, and what to verify.

---

## 1. What ships in this deploy

| Change | Files | VM impact |
|---|---|---|
| **Agent cron** (Phase 1+2 + per-job timezones) — scheduled jobs created from chat via a `cron_manage` tool, persisted per user, fired by an in-process ticker, run histories, "Scheduled" UI view | `src/cron/*`, `src/store.ts`, `src/agent.ts`, `src/index.ts`, `frontend/src/components/CronTab.tsx`, `frontend/src/sse.ts` | New dependency `cron-parser`; new SQLite tables (additive, auto-migrated at boot); ticker runs inside the existing service |
| **Chat SSE reliability** — 15 s keepalive comments on `/api/chat`, abort-on-client-disconnect (persists the valid prefix), frontend ignores stream errors after `done` | `src/index.ts`, `frontend/src/api.ts`, `frontend/src/sse.ts` | Kills the "Error in input stream" UI error on long silent turns. Caddy needs no change (`flush_interval -1` already set) |
| **UI rework** — right-pane tabbar is Chat / Wiki / Scheduled; Skills+MCP moved into a large modal opened from the sidebar gear; sidebar footer reordered (model+gear on top, user+logout at the bottom) | `frontend/src/App.tsx`, `components/Sidebar.tsx`, `styles.css` | None |
| **Wrap-up nudge** — near the tool-iteration cap the loop injects a one-time "persist state and land" directive; per-turn budget override | `src/agent.ts`, `src/config.ts` | Makes long unattended runs end gracefully instead of dying at the cap |
| **vibe_trading MCP** (from the previous deploy's config) — SEC 13F + research tools; **executable must be installed on the VM** (see §3) | `mcp_servers.json` | stdio MCP server `vibe-trading-mcp`, needs Python ≥ 3.11 via `uv` |
| **InstaBox remote mode** (optional, §4) — `stock-price-mover` runs its torch/Kronos steps on an on-demand 4 vCPU / 8 GiB sandbox instead of this 2 GB VM | `skills/instabox-sandbox` | Requires the `instabox` CLI + an API key, else that skill's remote steps fail |

The skills registry syncs at boot (R2 pull), so the updated `stock-price-mover`
(includes the heavy-compute mode and staged-turn discipline) and the new
`instabox-sandbox` skill arrive without any file copy.

## 2. Deploy steps

```bash
cd /opt/nm-finance-agent && sudo -u deploy git pull

sudo -u deploy bash -lc '
  cd /opt/nm-finance-agent &&
  npm ci &&
  cd frontend && npm ci && npm run build
'
sudo -u deploy bash -lc '
  cd /opt/nm-finance-agent &&
  npm run check &&
  OPENROUTER_API_KEY=presence-only npm test
'
sudo systemctl restart nm-finance-agent
sleep 3
sudo journalctl -u nm-finance-agent -n 80 --no-pager
```

Notes:

- `npm ci` is required (not just build): this deploy adds the `cron-parser`
  dependency.
- `npm test` needs at least a presence-only `OPENROUTER_API_KEY` in the env
  (same as the runbook's acceptance gate). The suite is fully offline; 182
  tests are expected green.
- The boot log should include the SSO line from the runbook plus, on first
  boot after this deploy, the SQLite auto-migration creating the cron tables
  (no manual DB step — additive `CREATE TABLE IF NOT EXISTS`, existing data
  untouched).
- Rollback: `git revert` + `npm ci` + restart. The cron tables are additive and
  harmless to older code.

## 3. vibe_trading MCP activation (skip if already done)

The runtime reads `/var/lib/nm-finance-agent/mcp_servers.json` (NOT the repo
copy). If the `vibe_trading` entry is not yet active there:

```bash
# 1. server + entrypoint (uv manages Python 3.12; AL2023 system python is too old)
sudo -iu nmagent bash -lc 'curl -LsSf https://astral.sh/uv/install.sh | sh && \
  ~/.local/bin/uv tool install vibe-trading-ai==0.1.18 && ~/.local/bin/vibe-trading-mcp --help'
# 2. the systemd unit pins PATH=/usr/local/bin:/usr/bin:/bin — link the entrypoint in
sudo ln -sf /var/lib/nm-finance-agent/.local/bin/vibe-trading-mcp /usr/local/bin/
# 3. merge the vibe_trading entry from the deployed repo copy into the live config
sudo python3 - <<'EOF'
import json
live = json.load(open("/var/lib/nm-finance-agent/mcp_servers.json"))
repo = json.load(open("/opt/nm-finance-agent/mcp_servers.json"))
live["servers"]["vibe_trading"] = repo["servers"]["vibe_trading"]
json.dump(live, open("/var/lib/nm-finance-agent/mcp_servers.json", "w"), indent=2)
print("servers:", list(live["servers"]))
EOF
# 4. restart and verify
sudo systemctl restart nm-finance-agent
curl -s http://127.0.0.1:3001/api/health | grep -i degraded   # expect no output
```

No `VIBE_*`/`TRADING_*` env keys are needed: the entry has no `${…}`
placeholders and the keep_tools allowlist (22 read-only research tools) is
keyless. `trading_*`/order tools and the shell tools are intentionally absent.

## 4. InstaBox remote mode (optional — recommended for this VM)

The `stock-price-mover` skill switches to **heavy-compute mode** when the local
machine has < 6 GiB RAM — which is always true on this 2 GB VM — so its torch
and Kronos steps will try to run on an InstaBox sandbox. Without the CLI/key
those steps fail (the rest of the workflow still runs).

```bash
# CLI (static binary, no deps) — as nmagent or into /usr/local/bin
curl -fsSL https://api.instabox.sh/install.sh | sh
# API key: create it from a signed-in machine, NOT on the VM:
#   instabox keys create --name ec2-nmagent \
#     --scope machines:read --scope machines:write --scope machines:delete \
#     --scope images:read --scope images:write
# (secret printed once → into the env file below, never into chat or the repo)
echo 'INSTABOX_API_KEY=ibk_…' | sudo tee -a /etc/nm-finance-agent.env
```

Quota context: the account allows 5 concurrent machines, 5 snapshots, 200 GiB
stored; the base image `spm-base-v1` (Debian 13, causal-ts + torch + yfinance +
gs-quant + Kronos weights + hola-opt) already exists, so jobs start from it and
no model download happens on the VM. Free-tier runtime cap is 480 min/machine.

## 5. New env knobs (all optional; defaults are sane)

| Var | Default | Meaning |
|---|---|---|
| `CRON_ENABLED` | `1` | `0` hides the `cron_manage` tool and stops the ticker |
| `CRON_TICK_MS` | `30000` | scheduler cadence (fires land within one tick) |
| `CRON_MAX_PARALLEL` | `2` | concurrent scheduled fires (2 GB VM — keep at 2) |
| `CRON_CATCH_UP_MISSED` | `1` | after a restart, a missed fire catches up once |
| `CRON_FAILURE_PAUSE_STREAK` | `5` | consecutive failures → job auto-pauses |
| `CRON_WRAPUP_REMAINING` | `10` | scheduled runs get the "persist and land" nudge with this many iterations left (chat turns use 5) |
| `LLM_KEY_POLICY` | `prefer_user` | user-scoped OpenRouter keys (see §5b): `prefer_user` / `require_user` / `server_only` |
| `LLM_KEY_REQUIRE_USER_AFTER` | — | with `require_user`: ISO date until which the server key still backs turns (warn-only window). **Recommended here: set to deploy date + 7 days** |
| `USER_LLM_KEY_SECRET` | — | AES-256-GCM master secret for user LLM keys at rest — generate with `openssl rand -hex 32`. **Required** for encrypted storage; unset = plaintext fallback + boot warning |
| `INSTABOX_API_KEY` | — | only for §4 |

Add keys to `/etc/nm-finance-agent.env` (systemd `EnvironmentFile` syntax:
plain `KEY=value`, no `export`). Do not invent keys; do not duplicate secrets
elsewhere.

### 5b. User-scoped OpenRouter keys (ships in this deploy)

Each SSO user can add their own OpenRouter key in **Settings → Model & key**
(validated against `GET /api/v1/key` without token spend, encrypted at rest
with `USER_LLM_KEY_SECRET`, stored per user under
`/var/lib/nm-finance-agent/state/users/<id>/llm.json` at mode 0600). chat()
resolves the caller's key per call: user key first, server key per policy.
Every successful LLM call is recorded into a per-user `llm_usage` table
(auto-migrated); `GET /api/user/llm-usage?days=30` returns the per-user
summary shown in the settings tab.

Recommended env additions for this VM (owner decision: warn-only week):

```bash
echo "LLM_KEY_POLICY=require_user" | sudo tee -a /etc/nm-finance-agent.env
echo "LLM_KEY_REQUIRE_USER_AFTER=$(date -u -d '+7 days' +%Y-%m-%dT%H:%M:%SZ)" | sudo tee -a /etc/nm-finance-agent.env
echo "USER_LLM_KEY_SECRET=$(openssl rand -hex 32)" | sudo tee -a /etc/nm-finance-agent.env
sudo systemctl restart nm-finance-agent   # env file is read per restart
```

Until the deadline the UI shows a warn banner and the server key still backs
turns; after it, a signed-in user without their own key gets an actionable
error instead of a billed server turn.

## 6. Timezones (important on this VM)

The VM clock is UTC but the user works in UTC+8. Every cron job carries an
optional IANA `timezone` (e.g. `Asia/Hong_Kong`): cron expressions and
offset-less one-shot timestamps are interpreted in it, the `cron_manage` tool
description tells the model the server zone and to set the parameter when the
user names a clock time, and create/update responses echo the computed next
fires rendered in that zone. `GET /api/cron/jobs` reports `server_timezone`
(this VM: `UTC`). Jobs created without a timezone keep firing in the server
zone — existing behaviour.

## 7. Verification checklist

1. `curl -s http://127.0.0.1:3001/api/health` — no `degraded` flags; skills
   index includes `stock-price-mover` and `instabox-sandbox`.
2. Authenticated `GET /api/cron/jobs` → `{"jobs": [...], "server_timezone":
   "UTC"}` (empty list is fine).
3. UI: right-pane tabs are **Chat / Wiki / Scheduled**; the sidebar gear opens
   the Skills/MCP modal; the sidebar footer shows model+gear above the user
   chip.
4. Scheduled view: create a throwaway job ("once in 2 minutes, say hello") —
   it must fire within one tick (~30 s), land a session with a `scheduled` tag
   in the sidebar, show a `completed` run with an excerpt in Run history, and
   disable itself (`once`). Delete it afterwards.
5. `cron_manage` smoke from chat: "schedule a reminder in 1 hour to check the
   AAPL quote" → the agent confirms the computed fire time.
6. SSE: start a deliberately long turn (>2 min silent); the UI must stay
   connected (15 s keepalives) with no `Error in input stream`.
7. If §3 ran: a chat turn hitting a 13F question (e.g. "which funds hold MU")
   uses `vibe_trading_get_institutional_holdings`.
8. If §4 ran: a chat turn "remotely: what drives X" drives an InstaBox sandbox
   (`instabox ls` shows the run sandbox during the turn; it is removed after).

## 8. Behaviour notes worth knowing

- A `once` job disables itself after its single fire **even on failure** —
  history and session remain; Resume + Run now retries it.
- Five consecutive failed fires auto-pause a job (`last_error` explains);
  Resume clears the streak.
- Scheduled runs get the owner's current tool/skill policy minus
  `cron_manage` (loop prevention) and their turns persist into the job's own
  session, tagged `scheduled` in the sidebar.
- A restart kills in-flight runs (marked `interrupted`, never auto-rerun);
  missed fires catch up once within `CRON_MISFIRE_GRACE_MIN` (10 min default).
- Long scheduled turns land gracefully: with `CRON_WRAPUP_REMAINING`
  iterations left, the model is told to persist state (skills write
  `argusdesk_state.md`) and finish with a summary.
