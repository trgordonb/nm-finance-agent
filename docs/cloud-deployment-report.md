# Cloud Deployment Report — NM Finance Agent

**Status:** deployed and operational; SSO authentication enabled (Phase 4)  
**Deployment completed:** 2026-10-22 (UTC)  
**SSO rollout:** 2026-10-23 (UTC)  
**Report date:** 2026-10-23 10:09 UTC  
**Public URL:** <https://agent.neuralmatrix.site>  
**Deployed commit:** `7167222` (`feat(auth): SSO BFF login and session gate; add Phase 4 cloud handover`)  
**Auth mode:** `sso` — required permission `application.nmfinance`  
**Deployment runbook:** [`docs/vm-deployment-runbook.md`](./vm-deployment-runbook.md)

> This report contains no secret values. The live secret file is
> `/etc/nm-finance-agent.env` (mode `640`, `root:nmagent`). Do not print it,
> copy it into `/opt`, or commit it. The Cloudflare tunnel token is in
> `/etc/cloudflared/token` (mode `600`, `root:root`) and must not be printed.

## 1. Summary

The app is deployed on a single AWS EC2 instance and is reachable through
Cloudflare Tunnel + Cloudflare Access at the public URL above. Caddy serves the
built SPA and proxies `/api/*` to the Express/SSE app on loopback. All three
systemd units are active and enabled.

This was a fresh deployment: no data migration was performed. The sessions
visible in the sidebar are validation artifacts from deployment and browser
testing (including a `vol-regime-detector` skill test and a workspace listing).

On 2026-10-23, Phase 4 enabled SSO authentication. The browser now signs in
against the Neural Matrix SSO through a server-side BFF; the only browser
credential is an `HttpOnly` `nm_auth` cookie. Application `/api/*` routes require
a session whose SSO introspection includes `application.nmfinance`; only
`/api/auth/*` and `/api/health` are public. See §14 for the rollout details and
verification.

The deployment and SSO rollout are **working**; the owner confirmed that
`https://agent.neuralmatrix.site/` loads after Access login and completed the
browser acceptance checks. The earlier Caddy `Host`-matching bug that produced a
blank white page is fixed, and the runbook has been updated.

## 2. Architecture

```text
Browser
  │  HTTPS + Cloudflare Access
  ▼
Cloudflare edge (zone: neuralmatrix.site)
  │  Cloudflare Tunnel
  ▼
cloudflared on EC2 (outbound; no inbound app ports)
  │  Host: agent.neuralmatrix.site
  ▼
Caddy 127.0.0.1:8080
  ├─ /            → /opt/nm-finance-agent/frontend/dist (SPA fallback; login screen)
  └─ /api/*       → 127.0.0.1:3001 (Express + SSE; flush_interval -1)
                          │
                          ├─ /api/auth/*  → SSO BFF login/logout/me (public)
                          ├─ /api/health  → public health probe
                          ├─ other /api/* → nm_auth session + application.nmfinance
                          │                  │ HTTPS + pinned CA
                          │                  ▼
                          │            SSO https://2.24.91.212:8443
                          ▼
                    nm-finance-agent.service (user: nmagent)
                          ├─ code: /opt/nm-finance-agent
                          ├─ data: /var/lib/nm-finance-agent
                          └─ skills registry: s3://neuralmatrix
```

- Public hostname: `agent.neuralmatrix.site`
- Tunnel ingress: `agent.neuralmatrix.site` → `http://127.0.0.1:8080`
- Cloudflare Access team domain: `long-truth-2746.cloudflareaccess.com`
- Access policy: single-user email policy configured by the owner
- TLS terminates at Cloudflare; the origin is HTTP on loopback only
- Auth: `AUTH_MODE=sso`; cookie `nm_auth` (`HttpOnly`, `Secure`,
  `SameSite=Strict`, `Path=/`); required permission `application.nmfinance`
- SSO endpoint: `https://2.24.91.212:8443`; pinned leaf CA at
  `/etc/nm-finance-agent/sso-ca.pem`
- Cloudflare account/tunnel IDs are intentionally omitted from this report;
  retrieve them from the dashboard or `cloudflared` logs if needed

## 3. Host and runtime inventory

| Item | Value |
|---|---|
| Instance type | `t4g.small` (2 vCPU, arm64) |
| Availability zone | `us-east-1f` |
| OS | Amazon Linux 2023.12.20261021 |
| Kernel | `6.18.51-120.163.amzn2023.aarch64` |
| RAM | 1.8 GiB total |
| Swap | 2.0 GiB (`/swapfile`) |
| Disk | 50 GB, 9.5 GB used, 41 GB free |
| Node.js | v24.22.1 (`/usr/local/bin/node`) |
| npm | 11.19.1 |
| uv | 0.13.5 |
| Caddy | 2.10.0 |
| cloudflared | 2026.10.3 |
| nm-skills-registry | v0.1.7 (installed under `/var/lib/nm-finance-agent/.local/bin`) |
| SELinux | Permissive |
| Automatic updates | `dnf-automatic` enabled |

**Memory note:** this instance is below the runbook's 4 GiB minimum. The owner
accepted `t4g.small` with 2 GiB swap. At the time of this report:

- RAM: ~979 MiB used, ~688 MiB available
- Swap: ~203 MiB used

Watch for OOM conditions under concurrent research/chart workloads. If memory
pressure becomes a problem, resize to `t4g.medium` (4 GiB) rather than removing
swap.

## 4. Services and listeners

| Unit | User | Listener / role | State | Enabled |
|---|---|---|---|---|
| `nm-finance-agent.service` | `nmagent` | `127.0.0.1:3001` Express + SSE | active | yes |
| `caddy.service` | `caddy` | `127.0.0.1:8080` SPA + API proxy | active | yes |
| `cloudflared.service` | root | outbound tunnel only | active | yes |

Verified listeners:

```text
LISTEN 127.0.0.1:3001
LISTEN 127.0.0.1:8080
```

Ports `3001` and `8080` are **not** exposed on the public interface. The tunnel
is outbound; no inbound web ports are required on the instance. SSH password
authentication is disabled (`PasswordAuthentication no`); use key-based SSH.

`cloudflared` currently runs as root because it reads a root-only token file.
This is functional but can be hardened later (dedicated user + group-readable
token) after the token is rotated.

## 5. Filesystem layout and permissions

| Path | Owner / mode | Purpose |
|---|---|---|
| `/opt/nm-finance-agent` | `deploy:nmagent 750` | deployed code, `node_modules`, built frontend |
| `/opt/nm-finance-agent/frontend/dist` | `deploy:deploy 755` | Vite production build served by Caddy |
| `/var/lib/nm-finance-agent` | `nmagent:nmagent 700` | data root / `HOME` |
| `/var/lib/nm-finance-agent/{workspace,skills,state,memories,logs,backups,wiki}` | `nmagent` | runtime data and skill mirror |
| `/var/lib/nm-finance-agent/state/auth.db` | `nmagent:nmagent 600` | SSO session DB (secret; WAL/SHM may be 644 while running) |
| `/var/lib/nm-finance-agent/mcp_servers.json` | `nmagent:nmagent 640` | MCP server config |
| `/etc/nm-finance-agent.env` | `root:nmagent 640` | live environment/secrets, including the SSO block |
| `/etc/nm-finance-agent.env.bak.20261023-094655` | `root:nmagent 640` | pre-Phase 4 env backup (secret) |
| `/etc/nm-finance-agent/` | `root:root 755` | pinned SSO certificate directory |
| `/etc/nm-finance-agent/sso-ca.pem` | `root:nmagent 644` | pinned SSO leaf certificate (expires 2027-10-21) |
| `/etc/cloudflared/token` | `root:root 600` | tunnel token |
| `/etc/caddy/Caddyfile` | `root:root 644` | reverse proxy / SPA config |
| `/etc/systemd/system/nm-finance-agent.service` | `root:root 644` | app unit |
| `/etc/systemd/system/caddy.service` | `root:root 644` | Caddy unit |
| `/etc/systemd/system/cloudflared.service` | `root:root 644` | tunnel unit |

The app unit sets:

```ini
User=nmagent
Group=nmagent
WorkingDirectory=/opt/nm-finance-agent
EnvironmentFile=/etc/nm-finance-agent.env
Environment=HOME=/var/lib/nm-finance-agent
Environment=PATH=/usr/local/bin:/usr/bin:/bin
ExecStart=/usr/local/bin/npm run start
```

## 6. Configuration and VM-specific changes

These differ from a literal first pass through the runbook and are intentional:

1. **Caddy site address fixed.** `/etc/caddy/Caddyfile` uses:

   ```caddyfile
   :8080 {
       bind 127.0.0.1
       ...
   }
   ```

   It must **not** be changed back to `http://127.0.0.1:8080`. See
   [Troubleshooting](#9-troubleshooting-history) for why.

2. **App unit has an `[Install]` section.** The original runbook unit omitted
   it, so `systemctl enable nm-finance-agent` would fail. The live unit has:

   ```ini
   [Install]
   WantedBy=multi-user.target
   ```

   The runbook snippet has been updated to match.

3. **Environment overrides.** `/etc/nm-finance-agent.env` was generated from
   the repository's `.env` with VM path overrides, including:
   - `HOME`-style data paths under `/var/lib/nm-finance-agent`
   - `WIKI_DIR=/var/lib/nm-finance-agent/wiki`
   - `AGENTDB_PATH=/var/lib/nm-finance-agent/workspace/agentdb-mcp.db`

   No `.env` was copied into `/opt`.

4. **MCP config.** `/var/lib/nm-finance-agent/mcp_servers.json` is a copy of
   the repo MCP config with `agent_browser` disabled. The app currently reports
   two connected MCP servers and 36 MCP tools.

5. **Caddy bound to loopback.** `bind 127.0.0.1` prevents Caddy from listening
   on the public interface. This was added after an earlier `*:8080` bind was
   found.

6. **Caddy backup.** The pre-fix Caddyfile is preserved at
   `/etc/caddy/Caddyfile.bak.20261022-135532`.

7. **Phase 4 SSO overrides.** `/etc/nm-finance-agent.env` now has
   `AUTH_MODE=sso`, the SSO endpoint/client/CA settings, the
   `application.nmfinance` permission, and the `nm_auth` cookie/DB settings. The
   existing inline `SSO_CLIENT_SECRET` was preserved (exactly one secret key;
   no second secret file). See §14.

## 7. Verification performed

### Build and tests (on the VM, before service start)

- `npm ci` completed (root and frontend).
- Frontend `npm run build` completed (typecheck + Vite build).
- `npm run check` passed.
- Test suite: **141/141 passed** with `OPENROUTER_API_KEY=presence-only`.
  Plain `npm test` without any `OPENROUTER_API_KEY` fails one env-gated test by
  design.
- Phase 4 rebuild (2026-10-23) repeated the same sequence and passed.

Current production build assets (Phase 4):

```text
/assets/index-3pfl-QS1.js   (438,630 bytes; SPA entry)
/assets/index-DWUsslk9.css  ( 24,071 bytes)
/assets/index-DzRU-pht.js   (973,350 bytes; lazy chunk)
```

### Health endpoint

`GET /api/health` through Caddy with the public Host header:

```text
status=ok
model=z-ai/glm-5.3-flash
skills=18
skills_required=true
skills_backend.mode=s3
skills_backend.registry=s3://neuralmatrix
skills_backend.degraded=false
skills_backend.skillCount=18
mirror.enabled=true
mirror.records=3
mcp_connected=2
mcp_tools=36
sessions=5
memory_chars=0
memory_budget=3575
auth.mode=sso
auth.required_permission=application.nmfinance
```

### Functional checks

- SSE streams incrementally through Caddy (not buffered).
- `execute` tool works and runs in `/var/lib/nm-finance-agent/workspace`.
- `load_skill vol-regime-detector` returns the real `SKILL.md`.
- Wiki tab loads domains/concepts and the link graph renders in headless
  Chromium (graph is slow, ~10 s, with 7 WebGL canvases).
- Chat UI renders in headless Chromium: sidebar, sessions, composer, no fatal
  console errors.
- SSO browser acceptance (2026-10-23): login, reload, logout, SSE/Stop, Wiki,
  and MCP all passed; cookie flags and no-token login response verified. See §14.
- Unauthenticated `/api/sessions` returns `401` through Caddy; `/api/health`
  remains `200`.

### Public edge

Unauthenticated requests are redirected to Access, as expected:

| Path | Unauthenticated result |
|---|---|
| `/` | `302` → Access login |
| `/api/health` | `302` → Access login |
| `/assets/index-3pfl-QS1.js` | `302` → Access login |

The Access login page itself returns `200` with title
`Sign in ・ Cloudflare Access`.

### Caddy / tunnel Host check

```bash
curl -sI -H 'Host: agent.neuralmatrix.site' http://127.0.0.1:8080/
```

must return `200`, `Content-Type: text/html`, and a non-zero
`Content-Length`. Before the fix it returned `200`, `Content-Length: 0`, and no
`Content-Type`.

## 8. Cloudflare configuration

- DNS: `agent.neuralmatrix.site` is proxied through Cloudflare.
- Tunnel public hostname: `agent.neuralmatrix.site` → `http://127.0.0.1:8080`.
- Access application covers the hostname and all paths (including `/assets/*`).
  Logged-in requests reach Caddy; unauthenticated requests get a `302` to the
  Access login.
- Rocket Loader is **off**.
- Auto Minify is no longer available in the Cloudflare dashboard (removed by
  Cloudflare); do not spend time looking for it.
- Cloudflare cache purge, if ever needed: use the dashboard search box and
  search for **Purge Cache**, or go to the zone's **Caching → Configuration →
  Purge Cache → Purge Everything**.

## 9. Troubleshooting history

### Blank white page through the tunnel (fixed)

**Symptom:** `https://agent.neuralmatrix.site/` showed a completely white page.
In Firefox the document rendered as plain text:

```text
title=""
bodyText=""
css="resource://content-accessible/plaintext.css"
resources=[]
```

**Root cause:** Caddy's site block was `http://127.0.0.1:8080`. In Caddy, that
is a site address with a **host matcher**, not a bind directive. The tunnel
forwards `Host: agent.neuralmatrix.site`, so Caddy did not match the site block
and returned an empty `200` response with no `Content-Type`. Firefox rendered
the empty untyped body as plain text — the white page.

This was masked by testing `curl http://127.0.0.1:8080/` directly, which sent
the matching `Host: 127.0.0.1` and returned the correct HTML.

**Fix:** use `:8080` (matches any Host) plus `bind 127.0.0.1` (keeps the
listener on loopback). The runbook now contains the corrected snippet and a
Host-header verification command. The pre-fix Caddyfile is backed up at
`/etc/caddy/Caddyfile.bak.20261022-135532`.

### `MaxListenersExceededWarning` (benign)

The warning:

```text
MaxListenersExceededWarning: Possible EventEmitter memory leak detected.
11 close listeners added.
```

comes from the `events` polyfill bundled with `graphology`/`sigma`, which are
loaded only for the Wiki link graph. It is a warning, not a crash, and is not
the cause of the blank page. The graph renders (slowly) in headless Chromium.
It can be silenced later by raising the event-emitter limit or reducing
listener churn, but that is cosmetic.

### `cloudflared tunnel info` unavailable

The tunnel is token-managed. `cloudflared tunnel info` requires an origin
certificate (`cert.pem`) and fails without one. This is expected; use the
Cloudflare dashboard or `journalctl -u cloudflared` for tunnel status.

## 10. Known issues and open items

1. **Rotate the Cloudflare Tunnel token.** The token was pasted into chat
   during setup. Rotate it in Zero Trust → Networks → Tunnels, then update
   `/etc/cloudflared/token` (mode `600`, `root:root`) and restart `cloudflared`.
2. **Reboot test not performed.** All units are enabled, but a reboot has not
   been used to confirm that app, Caddy, and cloudflared return automatically.
   Schedule a brief maintenance window for this.
3. **Backups/T10 skipped.** No automated backup or restore test has been done.
   The data directory is `/var/lib/nm-finance-agent`; the skills registry is
   remote (`s3://neuralmatrix`), but local state/memories/sessions are not
   backed up. `state/auth.db` contains refresh tokens, so any backup must treat
   it as secret material (encrypted at rest; never commit or print it).
4. **Memory headroom.** `t4g.small` + 2 GiB swap is below the runbook's 4 GiB
   minimum. Monitor `free -h`, swap use, and OOM messages. Resize to
   `t4g.medium` if needed.
5. **SELinux is Permissive**, not Enforcing. This was the deployment state; do
   not change it without testing the app, Caddy, and cloudflared under
   Enforcing.
6. **Wiki tab cold load / graph latency.** The Wiki tab loads domains and
   concepts from the remote `llmwiki` service; a cold start can take longer
   than the initial UI wait, and the graph takes ~10 s to settle. Not a
   deployment blocker.
7. **Validation sessions exist.** They are safe to delete if a clean sidebar is
   desired.
8. **SQLite WAL/SHM modes.** `auth.db` is `600 nmagent:nmagent`, but while the
   service is running SQLite creates `auth.db-wal` and `auth.db-shm` as `644`.
   The `state` directory is `750 nmagent:nmagent`, so access is limited to
   `nmagent`, its group (which includes Caddy), and root. If stricter isolation
   is wanted, add `UMask=0077` to the app unit and retest, or chmod the WAL/SHM
   files; SQLite may recreate them on restart.
9. **SSO certificate renewal.** `/etc/nm-finance-agent/sso-ca.pem` pins the SSO
   leaf certificate, which expires **2027-10-21**. Replace it with the renewed
   leaf, re-verify the SHA-256 fingerprint, and restart the app. Pinning a leaf
   makes renewal a manual step.

## 11. Operations cheat sheet

### Status

```bash
systemctl status nm-finance-agent caddy cloudflared --no-pager
sudo journalctl -u nm-finance-agent -n 100 --no-pager
sudo journalctl -u caddy -n 100 --no-pager
sudo journalctl -u cloudflared -n 100 --no-pager
```

### Health

```bash
curl -sS -H 'Host: agent.neuralmatrix.site' \
  http://127.0.0.1:8080/api/health
```

### Authentication checks

```bash
curl -sS -H 'Host: agent.neuralmatrix.site' \
  http://127.0.0.1:8080/api/health | jq '.auth'

curl -s -o /dev/null -w 'sessions=%{http_code}\n' \
  -H 'Host: agent.neuralmatrix.site' http://127.0.0.1:8080/api/sessions
# expect sessions=401

sudo sh -c 'ls -l /var/lib/nm-finance-agent/state/auth.db*'
# expect auth.db mode 600, owner nmagent
```

### Restart / reload

```bash
sudo systemctl restart nm-finance-agent
sudo systemctl reload caddy
sudo systemctl restart cloudflared
```

### Temporary SSO rollback

Use only in an agreed maintenance window. Cloudflare Access remains enabled.

```bash
sudo sed -i 's/^AUTH_MODE=.*/AUTH_MODE=off/' /etc/nm-finance-agent.env
sudo chown root:nmagent /etc/nm-finance-agent.env
sudo chmod 640 /etc/nm-finance-agent.env
sudo systemctl restart nm-finance-agent
# verify auth.mode=off and /api/sessions=200

# restore
sudo sed -i 's/^AUTH_MODE=.*/AUTH_MODE=sso/' /etc/nm-finance-agent.env
sudo chown root:nmagent /etc/nm-finance-agent.env
sudo chmod 640 /etc/nm-finance-agent.env
sudo systemctl restart nm-finance-agent
# verify auth.mode=sso and /api/sessions=401
```

### Validate a Caddyfile change before reloading

```bash
sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
sudo systemctl reload caddy
curl -sI -H 'Host: agent.neuralmatrix.site' http://127.0.0.1:8080/
```

### Redeploy application code

Run as `deploy`, then restart the app:

```bash
sudo -u deploy git -C /opt/nm-finance-agent pull --ff-only
sudo -u deploy bash -lc '
  cd /opt/nm-finance-agent &&
  npm ci &&
  cd frontend &&
  npm ci &&
  npm run build
'
sudo systemctl restart nm-finance-agent
```

After a frontend rebuild, hard-refresh the browser; the asset hashes change.
Do not copy the repository `.env` into `/opt`; the live environment file is
`/etc/nm-finance-agent.env`.

## 12. Do not

- Do not expose `3001` or `8080` on `0.0.0.0`; both must stay loopback-only.
- Do not run the app as root; it runs as `nmagent`.
- Do not disable Cloudflare Access or put the app on a public port to “make it
  work.”
- Do not commit `.env`, `auth.db`, databases, session data, or the `skills/`
  mirror.
- Do not change the Caddy site address back to `http://127.0.0.1:8080`; use
  `:8080` with `bind 127.0.0.1`.
- Do not disable `AUTH_MODE=sso` or Cloudflare Access to troubleshoot; use the
  documented rollback only in a maintenance window.
- Do not print `/etc/nm-finance-agent.env`, `/etc/cloudflared/token`, or
  `auth.db` rows.

## 13. Handoff checklist for the laptop agent

- [x] Phase 4 SSO deployed at `7167222`; machine and browser acceptance passed.
- [x] `https://agent.neuralmatrix.site` loads after Access login; owner tested
      login/reload/logout, SSE/Stop, Wiki, and MCP.
- [x] Phase 4 docs committed with this report (cloud report + VM runbook).
- [ ] Rotate the tunnel token that was pasted into chat.
- [ ] Schedule and perform a reboot test.
- [ ] Decide on backups/restore testing (T10); treat `auth.db` as secret.
- [ ] Monitor memory/swap on `t4g.small`.
- [ ] Replace the pinned SSO certificate before 2027-10-21.
- [ ] Optional: tighten WAL/SHM modes (`UMask=0077`) and silence the Wiki graph
      `MaxListenersExceededWarning`.

## 14. SSO authentication rollout (Phase 4 — 2026-10-23)

**Status:** PASS. This records the rollout described in
[`docs/sso-phase4-cloud-handover.md`](./sso-phase4-cloud-handover.md).

### Deployed state

- Code commit: `7167222` (`feat(auth): SSO BFF login and session gate; add
  Phase 4 cloud handover`).
- Auth mode: `AUTH_MODE=sso`.
- Required permission: `application.nmfinance`.
- SSO base URL: `https://2.24.91.212:8443`.
- Cookie: `nm_auth` — `HttpOnly`, `Secure`, `SameSite=Strict`, `Path=/`.
- Session DB: `/var/lib/nm-finance-agent/state/auth.db`
  (`600 nmagent:nmagent`).
- Pinned CA: `/etc/nm-finance-agent/sso-ca.pem` (`root:nmagent 644`).
- Certificate SHA-256:
  `32:91:54:35:C1:53:BE:0D:F8:4D:0E:72:F4:A9:9F:A9:F1:02:BC:D5:13:98:5D:45:96:3E:83:CD:FB:4F:F6:CD`;
  `notAfter=Oct 21 06:38:44 2027 GMT`.
- The existing inline `SSO_CLIENT_SECRET` was preserved; no secret value was
  printed or changed. The env file still has exactly one SSO secret key.
- Env backup: `/etc/nm-finance-agent.env.bak.20261023-094655` (`640`); secret.
- No Caddy changes were needed: `:8080` with `bind 127.0.0.1` remains, and
  Cloudflare Access stayed enabled throughout.

### Preconditions verified

- Remote `main` contained the auth commit; `/opt/nm-finance-agent` was clean at
  `f997b75` and fast-forwarded to `7167222`.
- `SSO_CLIENT_SECRET` was present and accepted by SSO introspection
  (`HTTP 200 {"active":false}`); no value was printed.
- SSO `/healthz` returned `{"status":"ok"}`; the certificate matched the
  expected fingerprint and expiry.
- The public hostname returned `302` to Access; `cloudflared` was active.
- `/var/lib/nm-finance-agent/state` was writable by `nmagent`; the owner
  confirmed the `application.nmfinance` grant.

### Verification

| Check | Result |
|---|---|
| Root/frontend `npm ci`, frontend build, `npm run check` | pass |
| Test suite | **141/141 passed** |
| `GET /api/health` through Caddy | `status=ok`, `auth.mode=sso`, `auth.required_permission=application.nmfinance`, `skills=18`, `mcp_connected=2` |
| Unauthenticated `GET /api/sessions` | `401` |
| Unauthenticated `GET /api/health` | `200` |
| Unauthenticated `GET /api/auth/me` | `401` |
| Caddy `/` | `200`, `text/html`, non-zero content |
| Listeners | `127.0.0.1:3001`, `127.0.0.1:8080` only |
| `auth.db` | `600 nmagent:nmagent` |
| Rollback test | `AUTH_MODE=off` → `auth.mode=off`, sessions `200`; restored `sso` → sessions `401` |
| Browser acceptance | login, reload, logout, SSE/Stop, Wiki, MCP all passed |
| Cookie flags | `HttpOnly`, `Secure`, `SameSite=Strict`, `Path=/` |
| Login response | no access/refresh token exposed to JavaScript |
| Wrong-password message | `Wrong username or password.` |
| SSO login log | owner public IP, not `127.0.0.1` |

The login screen also rendered correctly in headless Chromium against the local
origin: title `NM Finance Agent`, username/password inputs, no fatal console
errors.

### Deviations and notes

1. The handover assumed `/etc/nm-finance-agent/` existed; it did not. Created it
   as `root:root 755` and installed the certificate there.
2. The secret was already inline in `/etc/nm-finance-agent.env`; it was kept
   inline. No `SSO_CLIENT_SECRET_FILE` was added.
3. `auth.db` is `600`, but SQLite creates `auth.db-wal` and `auth.db-shm` as
   `644` while running. The `state` directory is `750 nmagent:nmagent`, limiting
   traversal to `nmagent`, its group, and root. See §10 for optional hardening.
4. The app was restarted once with `AUTH_MODE=off` for the rollback test, then
   restored. The final live state is `AUTH_MODE=sso`.
5. No values from `/etc/nm-finance-agent.env`, `auth.db`, or the tunnel token
   were printed during the rollout.

### Follow-ups

- Replace the pinned SSO leaf before **2027-10-21**.
- Consider `UMask=0077` for the app unit to cover WAL/SHM files.
- Complete the remaining open items in §10: tunnel-token rotation, reboot test,
  and backups/restore (with `auth.db` treated as secret).
