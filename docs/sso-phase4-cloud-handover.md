# Phase 4 handover — deploy SSO authentication on the EC2 VM

**Audience:** the OpenCode agent running **on the cloud VM**, with the owner for the password and
secret handoff.
**Prepared:** 2026-10-23 (laptop session)
**Status:** phases 1–3 complete and validated on the laptop. This is the only remaining rollout.
**Read first:** [`docs/sso-integration-plan.md`](./sso-integration-plan.md) (design + decisions),
[`docs/cloud-deployment-report.md`](./cloud-deployment-report.md) (current host/state),
[`docs/vm-deployment-runbook.md`](./vm-deployment-runbook.md) (base deploy procedure).

> **You are the cloud agent.** This document is the handover. Follow it in order. If a
> precondition is false, **stop and report** — do not improvise around an auth layer, and never
> disable Cloudflare Access to “make it work”. The existing VM constraints still apply: no secret
> printing, ports `3001`/`8080` loopback-only, the Caddy site address stays `:8080` with
> `bind 127.0.0.1`, and the app runs as `nmagent`.

---

## 0. What is being deployed

The app becomes a **backend-for-frontend (BFF) client** of the Neural-Matrix SSO server:

```text
Browser
  │ HTTPS + Cloudflare Access (unchanged)
  ▼
Caddy 127.0.0.1:8080
  ├─ /        → frontend/dist (SPA with login screen)
  └─ /api/*   → Express 127.0.0.1:3001
                  ├─ cookie nm_auth → auth.db (server-side session)
                  └─ HTTPS + pinned cert → https://2.24.91.212:8443
                       /api/v1/auth/{login,refresh,logout,introspect}
```

What changes in the app:

| Area | Change |
|---|---|
| `GET /api/health` | still public; now includes `auth: {mode, required_permission}` |
| `POST /api/auth/login` | public; proxies SSO login, sets the `nm_auth` cookie |
| `POST /api/auth/logout` | public; revokes the SSO session, clears the cookie |
| `GET /api/auth/me` | session cookie; returns the user, `allowed`, `required_permission` |
| every other `/api/*` route | requires a live session **and** `application.nmfinance` |
| CORS | the wildcard `Access-Control-Allow-Origin: *` is gone (cookie auth, same origin) |
| Storage | `AUTH_DB_PATH` (`/var/lib/nm-finance-agent/state/auth.db`), mode 600, refresh tokens inside |
| Dependencies | **none added** (no `npm ci` surprises from new packages) |

`AUTH_MODE=off` keeps the old open behaviour and is the rollback switch. `AUTH_MODE=sso` turns the
gate on. The frontend reads `/api/health.auth.mode`, so it skips the login screen when auth is off
or when an older backend has no `auth` block.

`sso_permissions.json` is the app's permission declaration for the SSO import API; the app never
reads it. The real grant (`application.nmfinance` → owner) is made in the SSO admin UI, not by
deploying this repo.

### Guardrails for this rollout

- Do **not** add CORS or switch to a direct browser→SSO flow: the BFF is deliberate (self-signed
  IP cert, no CORS on the SSO, tokens never reach JavaScript).
- Do **not** change the Caddy site address (`:8080` + `bind 127.0.0.1`) or expose `3001`/`8080`.
- Do **not** create/rotate the ServiceClient or grant permissions as part of the deploy unless the
  owner explicitly asks; those are SSO-side admin actions.
- Do **not** modify the SSO server, its database, or its certificate.
- Do **not** enable `AUTH_MODE=sso` before the new frontend build is in place — the old UI has no
  login screen.
- Do **not** commit `auth.db`, `certs/`, the pinned certificate, or any secret.

---

## 1. Preconditions — do not start until all are true

| # | Precondition | How to confirm |
|---|---|---|
| 1 | **The laptop has committed and pushed** the auth work to the branch the VM deploys. | `sudo -u deploy git -C /opt/nm-finance-agent log -1 --format='%H %s'` shows the auth commit; `src/auth/config.ts` exists after pull. If not, stop and ask the owner to push. |
| 2 | The SSO has **`application.nmfinance`** and the owner's account holds it. | SSO admin UI → Permissions / user grants. Fallback: a native login on the VM, with the password entered at a prompt (never inline in a shell command or history); the response should show `application.nmfinance` in `user.perms`. |
| 3 | ServiceClient **`nm-finance-agent`** is active and its secret is available to the VM. | The secret is in `/etc/nm-finance-agent.env` as `SSO_CLIENT_SECRET` **or** in a file referenced by `SSO_CLIENT_SECRET_FILE`. Do not print either. If neither exists, the **owner** must add it securely before step 5. |
| 4 | The VM can reach the SSO. | `curl -sS --max-time 5 -k https://2.24.91.212:8443/healthz` → `{"status":"ok"}`. `-k` is only for this pre-check; the app uses the pinned certificate. |
| 5 | The SSO certificate matches the expected fingerprint. | Step 4's cert: SHA-256 `32:91:54:35:C1:53:BE:0D:F8:4D:0E:72:F4:A9:9F:A9:F1:02:BC:D5:13:98:5D:45:96:3E:83:CD:FB:4F:F6:CD`; expires **2027-10-21**. |
| 6 | Cloudflare Access is still enabled and the tunnel is healthy. | `systemctl status cloudflared --no-pager`; the dashboard/Access login still gates the hostname. |
| 7 | `/var/lib/nm-finance-agent/state` exists and is writable by `nmagent`. | `sudo ls -ld /var/lib/nm-finance-agent/state` → `nmagent:nmagent`. |

**Owner-only steps:** #1 (push), #2 (grant + password), #3 (secret transfer if missing), and the
browser acceptance test in §7. **Cloud-agent steps:** everything else.

---

## 2. Snapshot the current state (rollback point)

Record, do not change:

```bash
date -u
sudo -u deploy git -C /opt/nm-finance-agent log -1 --format='%H %s'
sudo -u deploy git -C /opt/nm-finance-agent status --short
systemctl is-active nm-finance-agent caddy cloudflared
curl -sS -H 'Host: agent.neuralmatrix.site' http://127.0.0.1:8080/api/health
```

Back up the environment file (this preserves the mode; it contains secrets — **never cat it**):

```bash
sudo cp -p /etc/nm-finance-agent.env "/etc/nm-finance-agent.env.bak.$(date +%Y%m%d-%H%M%S)"
sudo ls -l /etc/nm-finance-agent.env*
```

If `auth.db` already exists from a previous attempt, back it up too:

```bash
sudo ls -l /var/lib/nm-finance-agent/state/auth.db* 2>/dev/null || true
```

**Stop if `/opt/nm-finance-agent` has uncommitted changes.** Do not `git pull` over them. The
previous deployment left docs changes in the *home* clone (`/home/ec2-user/nm-finance-agent`), not
in `/opt`; leave that clone alone for this rollout.

---

## 3. Pull and build

Run as `deploy` (the deployed-tree owner):

```bash
sudo -u deploy git -C /opt/nm-finance-agent branch --show-current
# expect main (or the known deploy branch); if not, stop and report
sudo -u deploy git -C /opt/nm-finance-agent status --short
# expect clean; if not, stop — do not pull over local changes
sudo -u deploy git -C /opt/nm-finance-agent pull --ff-only
sudo -u deploy git -C /opt/nm-finance-agent log -1 --format='%H %s'
```

Verify the auth files are present (all must exist):

```bash
for f in \
  src/auth/config.ts src/auth/client-ip.ts src/auth/sso.ts src/auth/store.ts \
  src/auth/session.ts src/auth/middleware.ts src/auth/routes.ts \
  frontend/src/auth.ts frontend/src/components/Login.tsx \
  frontend/src/components/AuthScreens.tsx sso_permissions.json \
  docs/sso-integration-plan.md docs/sso-phase4-cloud-handover.md; do
  sudo -u deploy test -f "/opt/nm-finance-agent/$f" || echo "MISSING: $f"
done
```

If anything is missing, **stop** — the push is incomplete.

Build and check (no new dependencies, but `npm ci` keeps the tree honest):

```bash
sudo -u deploy bash -lc 'cd /opt/nm-finance-agent && npm ci'
sudo -u deploy bash -lc 'cd /opt/nm-finance-agent/frontend && npm ci && npm run build'
sudo -u deploy bash -lc 'cd /opt/nm-finance-agent && npm run check'
sudo -u deploy bash -lc 'cd /opt/nm-finance-agent && OPENROUTER_API_KEY=presence-only npm test'
```

Expected: `npm run check` clean; **141/141 tests pass**. The auth tests run with `AUTH_MODE=off`
internally and need no SSO secrets. If a test fails only because a real LLM key is absent, use the
same presence-only pattern the previous deployment used and note it; the auth tests must pass.

**Do not restart yet.** The env is still `AUTH_MODE` unset/off, which keeps the old UI working while
we prepare the rest.

---

## 4. Install the pinned SSO certificate

Fetch it **on the VM** (do not copy the laptop's `certs/`), verify the fingerprint, install it:

```bash
cd /tmp
openssl s_client -connect 2.24.91.212:8443 -servername 2.24.91.212 </dev/null 2>/dev/null \
  | openssl x509 -outform PEM > sso-ca.pem

openssl x509 -in sso-ca.pem -noout -subject -issuer -dates -fingerprint -sha256
# Expected subject: CN=2.24.91.212  (SAN: IP:2.24.91.212, DNS:localhost, IP:127.0.0.1)
# Expected notAfter: Oct 21 06:38:44 2027 GMT
# Expected SHA-256: 32:91:54:35:C1:53:BE:0D:F8:4D:0E:72:F4:A9:9F:A9:F1:02:BC:D5:13:98:5D:45:96:3E:83:CD:FB:4F:F6:CD

sudo install -o root -g nmagent -m 644 /tmp/sso-ca.pem /etc/nm-finance-agent/sso-ca.pem
rm -f /tmp/sso-ca.pem
sudo ls -l /etc/nm-finance-agent/sso-ca.pem
```

**If the fingerprint or expiry differs, stop.** A changed certificate means either a legitimate
renewal (update the expected fingerprint and proceed only with owner confirmation) or an
interception (do not trust it).

---

## 5. Configure `/etc/nm-finance-agent.env`

### 5.1 Check what is already there (names only, never values)

```bash
sudo sed -nE 's/^([A-Z0-9_]+)=.*/\1/p' /etc/nm-finance-agent.env \
  | grep -E '^(AUTH_|SSO_)' | sort | uniq -c
```

You need exactly **one** of:

- `SSO_CLIENT_SECRET` (inline, already the existing pattern), **or**
- `SSO_CLIENT_SECRET_FILE` (preferred; the app reads the file as `nmagent`).

If neither exists, **ask the owner** to add it securely. Do not paste the secret into chat, a
command line that is logged, or a file `cat` output. Preferred owner path:

```bash
# Owner, on the VM, without echoing the value or putting it in history:
read -rs -p 'SSO client secret: ' SECRET && echo
printf '%s' "$SECRET" | sudo tee /etc/nm-finance-agent/sso-client-secret >/dev/null
unset SECRET
sudo chown root:nmagent /etc/nm-finance-agent/sso-client-secret
sudo chmod 640 /etc/nm-finance-agent/sso-client-secret
```

and set `SSO_CLIENT_SECRET_FILE=/etc/nm-finance-agent/sso-client-secret`. The app gives the file
precedence if both are present.

### 5.2 Remove stale auth keys, then append the block

This preserves `SSO_CLIENT_SECRET` / `SSO_CLIENT_SECRET_FILE` and all non-auth keys; it only removes
the keys the block below owns (avoids duplicate-key confusion — `dotenv` is loaded with
`override: true`, so a duplicate silently wins by position).

```bash
sudo sed -i -E '/^(AUTH_MODE|SSO_BASE_URL|SSO_CLIENT_ID|SSO_CA_FILE|SSO_TIMEOUT_MS|SSO_RETRIES|SSO_CACHE_TTL_SECONDS|SSO_TRUSTED_PROXIES|SSO_CLIENT_IP_HEADER|AUTH_REQUIRED_PERMISSION|AUTH_SESSION_TTL_DAYS|AUTH_COOKIE_NAME|AUTH_COOKIE_SECURE|AUTH_DB_PATH|AUTH_ALLOWED_ORIGINS)=/d' /etc/nm-finance-agent.env

sudo tee -a /etc/nm-finance-agent.env >/dev/null <<'EOF'

# --- SSO authentication (BFF) — docs/sso-integration-plan.md -----------------
AUTH_MODE=sso
SSO_BASE_URL=https://2.24.91.212:8443
SSO_CLIENT_ID=nm-finance-agent
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
AUTH_ALLOWED_ORIGINS=https://agent.neuralmatrix.site
# One of the following must already exist (do not add a second copy):
# SSO_CLIENT_SECRET=...
# SSO_CLIENT_SECRET_FILE=/etc/nm-finance-agent/sso-client-secret
EOF
```

Notes:

- `AUTH_COOKIE_SECURE=1` is required: the browser reaches the app over HTTPS (Cloudflare), even
  though Caddy→Express is HTTP on loopback.
- `SSO_TRUSTED_PROXIES=127.0.0.1,::1` is correct for `cloudflared → Caddy → Express`; the real
  browser IP arrives in `CF-Connecting-IP`. Do **not** add public CIDRs here.
- `AUTH_ALLOWED_ORIGINS` is belt-and-braces; the same-origin check also compares the `Origin` host
  with Caddy's `Host`.
- Do not add the SSO host to CORS; the BFF is server-to-server. No `SSO_CORS_ALLOWED_ORIGINS`
  change is needed on the SSO.

### 5.3 Validate the file without printing it

```bash
sudo sed -nE 's/^([A-Z0-9_]+)=.*/\1/p' /etc/nm-finance-agent.env \
  | grep -E '^(AUTH_|SSO_)' | sort | uniq -c
```

Every key must appear exactly once; one secret key must be present. Check the mode/owner:

```bash
sudo ls -l /etc/nm-finance-agent.env /etc/nm-finance-agent/sso-ca.pem
# env: root:nmagent 640 (unchanged); ca: root:nmagent 644
```

If using the file secret, `sudo ls -l /etc/nm-finance-agent/sso-client-secret` must be
`root:nmagent 640`.

---

## 6. Restart and machine-level verification

```bash
sudo systemctl restart nm-finance-agent
sleep 2
systemctl status nm-finance-agent --no-pager
sudo journalctl -u nm-finance-agent -n 80 --no-pager
```

Expect in the log:

```text
auth: SSO reachable at https://2.24.91.212:8443
nm-finance-agent listening on http://127.0.0.1:3001
```

Must **not** appear:

```text
auth: SSO unreachable at boot
auth: AUTH_COOKIE_SECURE is off
AUTH_MODE=sso: ...            (config error / refused boot)
```

Health through Caddy with the public Host (this is the exact check from the deployment report):

```bash
curl -sS -H 'Host: agent.neuralmatrix.site' http://127.0.0.1:8080/api/health \
  | python3 -c 'import sys,json; d=json.load(sys.stdin); print({k:d.get(k) for k in ("status","auth","model","skills","mcp_connected")})'
```

Expected:

```text
{'status': 'ok', 'auth': {'mode': 'sso', 'required_permission': 'application.nmfinance'}, ...}
```

Unauthenticated API must be rejected:

```bash
curl -s -o /dev/null -w 'sessions=%{http_code}\n' \
  -H 'Host: agent.neuralmatrix.site' http://127.0.0.1:8080/api/sessions
# expect 401
curl -s -o /dev/null -w 'health=%{http_code}\n' \
  -H 'Host: agent.neuralmatrix.site' http://127.0.0.1:8080/api/health
# expect 200
```

Session DB:

```bash
sudo ls -l /var/lib/nm-finance-agent/state/auth.db*
# expect -rw------- nmagent nmagent (shm/wal may exist while running)
```

Caddy regression check (must still be `200`, `text/html`, non-zero length):

```bash
curl -sI -H 'Host: agent.neuralmatrix.site' http://127.0.0.1:8080/ | head -6
```

Listeners stay loopback-only:

```bash
ss -ltn | grep -E ':(3001|8080)\b'
```

---

## 7. Browser acceptance test (owner + cloud agent)

Go through Cloudflare Access to `https://agent.neuralmatrix.site`.

| # | Check | Expected |
|---|---|---|
| 1 | Page load | SSO login card (`Sign in`, `Username or email`), not the app and not a blank page |
| 2 | Log in with the granted account | app loads: sidebar sessions, `+ New chat`, user chip with the username |
| 3 | Reload the page | still signed in (the `nm_auth` cookie + server session) |
| 4 | Send a chat message | SSE streams incrementally; tool rows appear; Stop cancels |
| 5 | Open a session / Wiki tab / MCP toggle | works as before |
| 6 | DevTools → Application → Cookies → `nm_auth` | `HttpOnly` ✓, `Secure` ✓, `SameSite=Strict`, `Path=/` |
| 7 | DevTools → Network → `POST /api/auth/login` response | only `user`, `allowed`, `required_permission`; **no** `access_token`/`refresh_token` |
| 8 | Sign out (sidebar) | returns to login; reload stays on login |
| 9 | Wrong password | `Wrong username or password.` (no account enumeration) |
| 10 | Account without the grant (optional) | `Access required` card showing `application.nmfinance` |
| 11 | SSO login/audit log | the reported client IP is the browser's public IP, **not** `127.0.0.1` |

Check #11 matters if the SSO runs `SSO_IP_BINDING_MODE=WARNING` or `ENFORCE`: if the login log shows
`127.0.0.1`, `CF-Connecting-IP` is not reaching Express. Stop and inspect the tunnel/Caddy headers
before declaring success; otherwise the IP binding is self-consistent but meaningless.

If the app shows `Access required` for the owner's account, the grant is missing — create/grant
`application.nmfinance` in the SSO admin UI, then reload (the next introspection picks it up within
30 s). Do not disable auth to work around it.

---

## 8. Rollback

Fast rollback (keeps the new build; the UI detects `off` and skips the login screen):

```bash
sudo sed -i 's/^AUTH_MODE=.*/AUTH_MODE=off/' /etc/nm-finance-agent.env
sudo systemctl restart nm-finance-agent
curl -s -H 'Host: agent.neuralmatrix.site' http://127.0.0.1:8080/api/health \
  | python3 -c 'import sys,json; print(json.load(sys.stdin).get("auth"))'
# {'mode': 'off', 'required_permission': None}
curl -s -o /dev/null -w '%{http_code}\n' -H 'Host: agent.neuralmatrix.site' http://127.0.0.1:8080/api/sessions
# 200 (Cloudflare Access is still the outer gate)
```

Full rollback (also restores the previous env file):

```bash
sudo cp -p /etc/nm-finance-agent.env.bak.<timestamp> /etc/nm-finance-agent.env
sudo systemctl restart nm-finance-agent
```

If the service refuses to boot, `journalctl -u nm-finance-agent -n 50 --no-pager` shows the config
error (missing secret, unreadable CA, bad URL). Fix it or use the `AUTH_MODE=off` rollback; do not
leave the unit in a restart loop.

`auth.db` contains refresh tokens. On a permanent rollback, either leave it (idle, expires in 7
days) or destroy it deliberately:

```bash
sudo systemctl stop nm-finance-agent
sudo shred -u /var/lib/nm-finance-agent/state/auth.db*
sudo systemctl start nm-finance-agent
```

Never delete it without deciding what happens to the backup copies.

---

## 9. Post-deploy housekeeping

1. **Update `docs/cloud-deployment-report.md`** with a new section:
   - date, deployed commit SHA, `AUTH_MODE=sso`, `AUTH_REQUIRED_PERMISSION=application.nmfinance`;
   - cert fingerprint and expiry;
   - the §6/§7 results (health, 401, cookie flags, SSE, browser);
   - any deviation and the rollback test (if performed).
2. **Update `docs/vm-deployment-runbook.md`** with the auth env block, the cert step, and the health
   check from §6. Keep the existing Caddy/unit fixes intact.
3. Commit/push the docs from whichever clone has git credentials (the previous deployment left docs
   uncommitted in the home clone; don't clobber that work). If the VM cannot push, leave the edits
   in place and report the paths.
4. **Monitor** the `t4g.small`: `free -h`, swap, `journalctl -u nm-finance-agent | grep -i oom`.
   Auth adds one SQLite row per login and one introspection call per active session per 30 s; it
   should not change the memory profile materially.
5. **Backups:** `auth.db` is secret material (refresh tokens). If/when a backup job is added,
   either include it with encryption or exclude it and accept that users re-login after a restore.
6. **Certificate renewal:** when the SSO certificate is renewed (currently 2027-10-21), replace
   `/etc/nm-finance-agent/sso-ca.pem` and restart. The app logs a warning when <30 days remain.
   Pinning the leaf means any renewal needs this step.

---

## 10. Troubleshooting

| Symptom | Likely cause | Action |
|---|---|---|
| `/api/health` shows `auth.mode=off` after setting sso | key typo/duplicate; env file not loaded | check key names (§5.1), `systemctl restart`, journal |
| Service exits at boot, journal mentions `AUTH_MODE=sso:` | missing `SSO_BASE_URL`/client id/secret, unreadable CA | fix the named key; do not start with a half config |
| Login returns `503 sso_unavailable` | SSO unreachable, cert mismatch, timeout | `curl -k https://2.24.91.212:8443/healthz` from the VM; re-check the fingerprint/CA path |
| Login returns `502 sso_client_rejected` | wrong/inactive ServiceClient or wrong secret | verify `nm-finance-agent` in the SSO admin; owner re-copies the secret |
| Login returns `401 invalid_credentials` | wrong user password | expected; try again (SSO throttles 5/min/user) |
| Login returns `403 account_inactive` | user suspended | SSO admin unsuspend |
| Login succeeds, UI shows `Access required` | `application.nmfinance` not granted | create/grant it, reload |
| API returns `403 permission_denied` | same grant missing | same |
| API returns `401` immediately after login | cookie rejected: `AUTH_COOKIE_SECURE`/HTTPS mismatch, or SSO IP mismatch in ENFORCE | check cookie flags, browser HTTPS, SSO IP mode/log |
| Every API returns `503 sso_unavailable` after working | SSO down; fail-closed introspection | restore SSO; streams already open continue |
| Blank white page | stale `frontend/dist` (login shell not built) | rebuild frontend, hard refresh; check Caddy Host header |
| `403 origin_not_allowed` on login | `Origin` host ≠ `Host` (proxy rewrote Host) | check `AUTH_ALLOWED_ORIGINS` and Caddy forwarding |
| `EACCES` on `auth.db` | state dir/DB owner | `sudo chown -R nmagent:nmagent /var/lib/nm-finance-agent/state` |
| `MaxListenersExceededWarning` in the browser | pre-existing Wiki graph warning | ignore (documented in the deployment report) |

Diagnostics that are safe to run: `journalctl -u nm-finance-agent`, `/api/health`, `ss -ltn`,
`ls -l` on the DB/cert, `curl` to the SSO `healthz`. **Never** print `/etc/nm-finance-agent.env`,
`/etc/cloudflared/token`, or any `auth.db` row (refresh/access tokens).

---

## 11. Definition of done

- [ ] Code pulled at a known commit; build/check/tests green on the VM.
- [ ] `sso-ca.pem` installed and fingerprint-verified; expires 2027-10-21.
- [ ] `/etc/nm-finance-agent.env` has exactly one of each auth key; mode unchanged.
- [ ] Service active, no restart loop; journal shows `auth: SSO reachable`.
- [ ] `/api/health` returns `auth.mode=sso` + `application.nmfinance`.
- [ ] `/api/health` 200 without auth; `/api/sessions` 401 without auth.
- [ ] `auth.db` exists at `/var/lib/nm-finance-agent/state/auth.db`, mode 600, owner `nmagent`.
- [ ] Browser: login → app → reload → logout; wrong password error; cookie flags correct.
- [ ] SSE chat, Stop, session reload, Wiki, MCP toggle smoke-tested.
- [ ] SSO login log shows the browser's public IP (not loopback).
- [ ] Rollback (`AUTH_MODE=off`) tested or at least verified by reading the health response after a
      temporary toggle (if a maintenance window allows).
- [ ] Deployment report + runbook updated; docs committed or handed back with paths.

---

## 12. Report back template

```text
Phase 4 — SSO auth on EC2

Status: PASS / FAIL / PARTIAL
Deployed commit: <sha> <subject>
Health: <status/auth/model/skills/mcp_connected>
Unauth /api/sessions: <code>
Journal: <the auth: SSO reachable line, or the error>
auth.db: <path, mode, owner, exists>
Browser: login=<ok/fail> reload=<ok/fail> logout=<ok/fail> sse=<ok/fail> wiki=<ok/fail> mcp=<ok/fail>
Cookie flags: HttpOnly=<y/n> Secure=<y/n> SameSite=<value>
SSO login IP: <public IP / 127.0.0.1 / not checked>
Rollback tested: <yes/no/not performed>
Docs: <report/runbook updated? committed? paths>
Deviations: <none / list>
Open items: <none / list>
```

The laptop agent can then update the main report from this block.
