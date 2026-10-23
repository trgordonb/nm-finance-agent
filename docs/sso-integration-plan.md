# SSO integration plan — nm-finance-agent as an SSO client

**Status:** phases 1–3 validated 2026-10-23 · phase 4 handover: [`docs/sso-phase4-cloud-handover.md`](./sso-phase4-cloud-handover.md)
**Target SSO:** `Neural-Matrix-LLC/SSO-server` v1.3d (`main`)
**Read:** [SSO client library design](https://github.com/Neural-Matrix-LLC/SSO-server/blob/main/docs/SSO-CLIENT-LIBRARY-DESIGN.md),
[API Reference Manual](https://github.com/Neural-Matrix-LLC/SSO-server/blob/main/docs/API-REFERENCE-MANUAL.md),
[ecosystem integration design](https://github.com/Neural-Matrix-LLC/SSO-server/blob/main/docs/ECOSYSTEM-INTEGRATION.md).

This note plans the first authentication layer for the harness. It is deliberately scoped to
**login + identity + permission enforcement**; it does **not** implement multi-tenant data
isolation (see `docs/per-user-workspace-and-r2.md`, deferred).

---

## 1. Decision in one paragraph

Use the **BFF (backend-for-frontend) pattern**, not the browser-cookie pattern from
`examples/frontend/auth.js`. The Express server owns the SSO conversation: the browser posts
username/password to our own `/api/auth/login`, the server calls the SSO with the registered
`ServiceClient` (HTTP Basic) and the browser's IP, stores the access + refresh tokens **server-side**
in SQLite, and gives the browser only an opaque `HttpOnly` session cookie. Every `/api/*` request
is then authorised server-side by calling SSO **introspection** (cached ≤ 30 s, keyed by token hash
+ IP) and checking `application.nmfinance`. No token ever reaches browser JavaScript, no CORS is needed,
and the self-signed certificate on the SSO origin is a server-to-server concern only.

The Python `sso-client` library is not usable here (Node/TypeScript), but the design maps 1:1:
client-IP derivation from the socket peer + trusted proxies, fail-closed introspection, 30 s
active-only cache, `require` → 403, inactive/IP mismatch → 401, SSO down → 503.

---

## 2. Live checks against the deployed SSO (2026-10-23)

These were run from this laptop against the values already in `.env`. They shape the plan.

| Check | Result |
|---|---|
| `SSO_BASE_URL` | `https://2.24.91.212:8443` |
| TLS certificate | **self-signed**, `CN=2.24.91.212`, SAN `IP:2.24.91.212, DNS:localhost, IP:127.0.0.1`, valid to 2027-10-21 |
| `GET /healthz` | `200 {"status":"ok"}` |
| `GET /.well-known/jwks.json` | 200, one kid `d76d6e1d3e4001db`, `Cache-Control: max-age=3600` |
| `POST /api/v1/auth/service-token` with `nm-finance-agent` creds | **200** — client is registered and the secret in `.env` is valid |
| Service-token claims | `subscription`: `client_id=nm-finance-agent`, `aud=myfin-services`, **`app=null`, `perms=[]`** |
| Discovery `issuer` | `https://2.24.91.212` — **no `:8443`**, and `jwks_uri` points at port 443 |
| Token `iss` | `https://2.24.91.212` (same mismatch) |
| CORS preflight from `https://agent.neuralmatrix.site` | 200 but **no `Access-Control-Allow-Origin`** — the app origin is not in `SSO_CORS_ALLOWED_ORIGINS` |

Consequences:

1. **BFF is the right call.** A browser calling `https://2.24.91.212:8443` directly would hit a
   self-signed certificate and missing CORS. Server-side calls only need certificate trust, which
   is local to our process.
2. **The issuer is inconsistent with the base URL.** This does not affect introspection-only
   validation (we never verify `iss` ourselves), but it will break any standards-based JWT verifier
   and should be fixed on the SSO side (see §9.1).
3. **The ServiceClient is not app-bound and has no permissions.** Introspection still works
   (the client only authenticates the call; `allowed` is computed from the *user's* permissions),
   but the app permission must exist and be granted to the human user before login can succeed.
4. **No CORS work is required** because the browser never talks to the SSO.

---

## 3. Target architecture

```text
Browser (SPA on agent.neuralmatrix.site)
  │  same-origin fetch, cookie nm_auth (HttpOnly)
  ▼
Caddy 127.0.0.1:8080
  ├─ /        → SPA
  └─ /api/*   → Express 127.0.0.1:3001
                  │
                  ├─ auth middleware: cookie → session row → (refresh if needed)
                  │                    → introspect(token, client_ip, require)
                  │
                  └─ server-side HTTPS (pinned CA) ──► SSO
                                                      POST /api/v1/auth/login
                                                      POST /api/v1/auth/refresh
                                                      POST /api/v1/auth/logout
                                                      POST /api/v1/auth/introspect
```

Key properties:

- The browser sees one origin. No CORS, no SSO cookies, no tokens in JS or `localStorage`.
- The SSO sees one well-known client (`nm-finance-agent`) and the **real browser IP** on every
  login/refresh/logout/introspect, so `cip` binding and per-IP throttles behave as designed.
- Tokens live in SQLite on the VM (`auth.db`), mode 600, owned by `nmagent`. The DB becomes
  secret material (a refresh token is a 7-day credential).
- Cloudflare Tunnel remains the network ingress. Cloudflare Access was removed on
  2026-10-23; the app's SSO is the only application identity layer. Access can be
  re-enabled as optional defense-in-depth, but it adds a second login.

---

## 4. Flows

### 4.1 Login

```text
POST /api/auth/login {username,password}
  Express: client_ip = deriveClientIp(req)
  → SSO POST /api/v1/auth/login  (Basic client_id:secret)
      {"username","password","client":"native","client_ip":...}
  ← 200 {access_token, refresh_token, expires_in, user{id,username,email,perms,...}}
  Express: create random 32-byte session id
           store sha256(id) → {sub, username, refresh_token, access_token, expires_at, ip, sid}
           Set-Cookie: nm_auth=<id>; HttpOnly; SameSite=Strict; Secure; Path=/; Max-Age=604800
  ← 200 {user:{id,username,email,perms}}
```

`client:"native"` is required: browser mode would put the refresh token in a cookie on the SSO
origin that we cannot read. Native mode returns it in the body for the BFF to store.

### 4.2 Authenticated request

```text
GET /api/sessions  (cookie)
  → load session row by sha256(cookie)
  → if access token expires in < 60 s: refresh (serialised per session)
  → if last introspect > 30 s: POST /api/v1/auth/introspect {token, ip, require}
       active=false            → 401, destroy session
       allowed=false           → 403
       active=true             → attach req.user, serve
  → SSO unreachable after retries → 503 + Retry-After: 5 (fail closed)
```

Cache key is `sha256(access_token) + ":" + client_ip`; only `active:true` answers are cached;
TTL is capped at 30 s and at the token `exp`. The cache is in-process (one Node process).

### 4.3 Refresh and logout

- **Refresh** is proactive (60 s before `expires_in`) and reactive (introspect says inactive).
  Body: `{"refresh_token": ...}`, Basic auth, `client_ip`. The SSO rotates the refresh token on
  every use; the new pair replaces the old row in one transaction. A per-session promise lock
  prevents two concurrent refreshes — reuse of an old refresh token >10 s after rotation revokes
  the whole SSO session.
- **Logout**: `POST /api/auth/logout` → SSO `/api/v1/auth/logout` with the refresh token + Basic +
  `client_ip` (204), delete the local row, clear the cookie. A failed SSO logout still deletes the
  local session; the SSO token expires on its own.
- **Revocation** (admin suspend / logout-all) is seen at the next introspection (≤ 30 s) or at the
  next refresh. Access tokens already issued remain valid at the SSO for ≤ 15 min, but our
  introspection check makes them unusable here within the cache window.

### 4.4 Client IP derivation (must match SSO semantics)

Pure function, no framework dependency, port of `sso_client.get_client_ip`:

1. Normalise the socket peer (`::ffff:1.2.3.4` → `1.2.3.4`, strip port/brackets/zone).
2. If the peer is **not** in `SSO_TRUSTED_PROXIES`, return the peer and ignore every header.
3. If `SSO_CLIENT_IP_HEADER` is set (`cf-connecting-ip` in the cloud) and the peer is trusted,
   use it when it contains a valid IP.
4. Otherwise walk `X-Forwarded-For` right → left and return the first untrusted valid address.

Cloud path: `cloudflared` connects to Caddy from `127.0.0.1`, Caddy to Express from `127.0.0.1`, and
Cloudflare sets `CF-Connecting-IP` to the real browser address. Trusted list in the VM env:
`127.0.0.1,::1`. Local path: Vite proxy / direct :3001, peer `127.0.0.1` or `::1`, no CF header —
stable across login and later calls, so IP binding still matches itself. Normalise `::1` → `127.0.0.1`
for loopback so a `localhost` (IPv6) login cannot mismatch a `127.0.0.1` call.

**Never** set Express `trust proxy` or use `req.ip`: Express would trust headers on its own terms
and could disagree with this function.

---

## 5. Configuration

New keys (documented in `.env.example`; secrets never committed):

| Key | Default | Notes |
|---|---|---|
| `AUTH_MODE` | `off` | `off` \| `sso`. `sso` requires the rest and **fails fast at boot** if incomplete. Set explicitly in both `.env` and `/etc/nm-finance-agent.env`. |
| `SSO_BASE_URL` | — | Already present: `https://2.24.91.212:8443` |
| `SSO_CLIENT_ID` | — | Already present: `nm-finance-agent` |
| `SSO_CLIENT_SECRET` / `SSO_CLIENT_SECRET_FILE` | — | File wins when both are set (VM-friendly) |
| `SSO_CA_FILE` | — | **Required** (decided: pin the leaf certificate, §9.1). Empty would fall back to Node's trust store. |
| `SSO_TIMEOUT_MS` | `2000` | Per attempt |
| `SSO_RETRIES` | `1` | Connect errors, timeouts, 502/503/504 only; never 4xx |
| `SSO_CACHE_TTL_SECONDS` | `30` | Active-only introspection cache; capped at 30 |
| `SSO_TRUSTED_PROXIES` | `127.0.0.1,::1` | Peers allowed to supply client-IP headers |
| `SSO_CLIENT_IP_HEADER` | `cf-connecting-ip` | Empty locally to use XFF only |
| `AUTH_REQUIRED_PERMISSION` | `application.nmfinance` | Checked on every user request |
| `AUTH_SESSION_TTL_DAYS` | `7` | Matches the SSO refresh lifetime |
| `AUTH_COOKIE_NAME` | `nm_auth` | |
| `AUTH_COOKIE_SECURE` | `1` in the VM env, `0` locally | Must be `1` behind Cloudflare |
| `AUTH_DB_PATH` | `./auth.db` | VM: `/var/lib/nm-finance-agent/state/auth.db` |
| `AUTH_ALLOWED_ORIGINS` | same host | Optional extra origins for the POST Origin check |

No new npm dependencies are required if introspection-only is used: `node:https` with `ca` handles
the pinned certificate, Express already provides `res.cookie`, and the cookie header is parsed with
~10 lines. (`jose` is present only as a transitive dependency; do not import it without declaring
it. Local JWKS verification is a later optimisation, not part of this plan.)

---

## 6. File-level implementation plan

### New files

| File | Contents |
|---|---|
| `src/auth/config.ts` | Reads/validates the keys above; `AUTH_MODE=sso` + missing/invalid config throws at import; warns loudly when `off`. |
| `src/auth/client-ip.ts` | `normalizeIp`, `parseTrusted`, `getClientIp(peer, headers, trusted, header)`. Pure, unit-tested. |
| `src/auth/sso.ts` | `login`, `refresh`, `logout`, `introspect` using `node:https`; Basic auth; `SSO_CA_FILE`; timeout + retry; typed errors (`SSOUnavailable`, `SSOProtocolError`, `InvalidCredentials`, `RateLimited`); never logs tokens/secrets. One structured log line per call. |
| `src/auth/store.ts` | `AuthStore` on `auth.db` (`node:sqlite`, WAL): table `auth_sessions(id_hash PK, sub, username, email, perms, access_token, refresh_token, access_expires_at, ip, sid, created_at, last_seen_at, last_introspect_at)`. `get`, `put`, `touch`, `delete`, `deleteExpired`. |
| `src/auth/session.ts` | Session cookie issue/clear, id generation, per-session refresh lock, `resolveSession(cookie, clientIp)` (refresh → introspect) and the introspection cache. |
| `src/auth/middleware.ts` | `requireAuth`, `requirePermission`, JSON errors with `WWW-Authenticate`; `503 + Retry-After: 5` on SSO outage; Origin check for state-changing requests. |
| `src/auth/routes.ts` | `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me`, `POST /api/auth/refresh` (optional; the middleware refreshes anyway). |
| `src/tests/client-ip.test.ts` | IPv4/IPv6, mapped addresses, spoofed XFF from untrusted peer, CF header only when trusted, right-to-left walk. |
| `src/tests/auth.test.ts` | Login/session/refresh/logout against a fake SSO (`node:http`), expired token, 401/403/503 matrix, cookie flags, cache TTL. |

### Modified files

| File | Change |
|---|---|
| `src/index.ts` | Remove the `Access-Control-Allow-Origin: *` middleware (cookie auth; same-origin only). Mount `/api/auth/*` and `/api/health` before the gate, then `app.use("/api", requireAuth)` for everything else. Add `auth_mode` to `/api/health` (no user data). |
| `src/config.ts` | Re-export `AUTH_*`/`SSO_*` from `src/auth/config.ts` (or import there) so the rest of the app sees one config module. |
| `frontend/src/api.ts` | Central 401 handler (`onUnauthorized` callback) for `fetchJSON` and `streamChat`; same-origin credentials are the default, no token header. |
| `frontend/src/App.tsx` | Auth gate: `loading → me() → user | login`; on 401 return to login; render the user chip/logout. |
| `frontend/src/components/Login.tsx` | Username/password form; generic error; 429 `Retry-After` countdown; disabled while submitting. |
| `frontend/src/components/Sidebar.tsx` | Show `username` and a logout button. |
| `frontend/src/styles.css` | Login screen + user chip styles. |
| `.env.example` | Document every new key, no values. |
| `README.md` | Short "Authentication" section: BFF, cookie, how to run with `AUTH_MODE`. |

### Optional (small, recommended)

| File | Change |
|---|---|
| `sso_permissions.json` | App permission declaration for the SSO import API (`app_codename: nmfinance`, `permissions: []` beyond the implicit app access). Keeps the app's permission source in-repo. |
| `docs/vm-deployment-runbook.md` | Add the auth env block, CA file install, and the verification commands. |

---

## 7. API surface after the change

| Route | Auth | Notes |
|---|---|---|
| `GET /api/health` | public | Ops probe through Caddy; add `auth_mode` only |
| `POST /api/auth/login` | public (rate-limited) | Sets the cookie; proxies SSO errors |
| `POST /api/auth/logout` | cookie | Revokes at SSO, clears cookie |
| `GET /api/auth/me` | cookie | `{id, username, email, perms}` |
| `GET /api/sessions*`, `/api/memory`, `/api/followups*`, `/api/skills*`, `/api/mcp*`, `/api/wiki/*`, `/api/yahoo/*` | cookie | 401 without a session, 403 without the permission |
| `POST /api/chat`, `/api/chat/cancel`, `/api/uploads/wiki`, `/api/mcp/reload`, `/api/research/*` | cookie | Same gate; SSE gets the check once at connect |

Error shapes: `401 {"detail":"not_authenticated"}` with `WWW-Authenticate: Bearer`; `401
{"detail":"token_inactive","reason":...}`; `403 {"detail":"permission_denied","missing":[...]}`;
`503 {"detail":"sso_unavailable"}` + `Retry-After: 5`. Login and `/api/auth/me` also return
`allowed` and `required_permission`, so the UI can show the "access required" screen without
guessing the codename.

---

## 8. Frontend behaviour

- On load: `GET /api/auth/me`. 200 → app; 401 → login screen. No flash of content.
- Login errors: `invalid_credentials` → "Wrong username or password"; `account_inactive` →
  "Account suspended"; `rate_limited` → countdown from `Retry-After`; `503` → "Sign-in service
  unavailable, retry shortly".
- Any 401 from any API call (including the SSE fetch) clears the auth state and shows login.
  403 shows a permission message, not a logout.
- Logout clears the query state and returns to login.
- No token storage, no `localStorage`, no auth header construction in the browser.
- Deep links/session ids are preserved across login where practical (the current app has no router;
  keep the current session selection in memory only).

Implemented in `frontend/src/auth.ts`, `components/Login.tsx`, `components/AuthScreens.tsx`, the
auth shell at the bottom of `App.tsx`, and the global 401 handler in `api.ts`. The shell reads
`/api/health.auth.mode`: `off` (or an older backend with no `auth` block) skips the login screen
entirely, so local `AUTH_MODE=off` development and short controlled rollback keep working. On the
public VM, `off` is unauthenticated because Access has been removed; see §13.

---

## 9. SSO-side prerequisites (before code lands)

### 9.1 Keep the IP and pin the certificate (decided 2026-10-23)

The SSO stays at `https://2.24.91.212:8443`; no hostname migration now. The BFF trusts the
self-signed certificate through `SSO_CA_FILE`, so browsers never see it (they only talk to our
origin). This also keeps the SSO-independent browser flow free of CORS.

Fetch and install the pinned leaf certificate:

```bash
# Inspect the fingerprint before trusting it.
openssl s_client -connect 2.24.91.212:8443 -servername 2.24.91.212 </dev/null 2>/dev/null \
  | openssl x509 -outform PEM > sso-ca.pem
openssl x509 -in sso-ca.pem -noout -subject -issuer -dates -fingerprint -sha256
```

Expected: `CN=2.24.91.212`, SAN `IP:2.24.91.212, DNS:localhost, IP:127.0.0.1`,
`notAfter=Oct 21 06:38:44 2027 GMT`.

Verified locally on 2026-10-23 — SHA-256 fingerprint:
`32:91:54:35:C1:53:BE:0D:F8:4D:0E:72:F4:A9:9F:A9:F1:02:BC:D5:13:98:5D:45:96:3E:83:CD:FB:4F:F6:CD`.

- Local: point `SSO_CA_FILE` at the file (gitignored; do not commit it).
- VM: `/etc/nm-finance-agent/sso-ca.pem`, `root:nmagent 644`.

Operational notes:

- Pinning the **leaf** means a certificate renewal (even with the same CN) requires replacing the
  file and restarting. The certificate expires **2027-10-21**; the boot probe should log a warning
  when fewer than 30 days remain.
- The discovery/`iss` mismatch (`https://2.24.91.212` without `:8443`) is harmless while validation
  is introspection-only — we never verify `iss` ourselves. If local JWKS verification is added
  later, fix `SSO_ISSUER` to `https://2.24.91.212:8443` first.
- No CORS changes are needed for the BFF.

### 9.2 Create the application permission and grant it

- Create `application.nmfinance` (admin UI → Permissions, or `create_app_permission nmfinance "Can
  use nm-finance-agent"`).
- Grant it to the owner's user (directly or via a group). **Login succeeds without it, but every
  API call will 403** — this is the most likely first-run failure.
- Optionally set the ServiceClient's `app_codename=nmfinance` (admin UI → Services → edit) so the
  app can import its own permission declarations later. Do **not** rotate the secret; it is
  already in `.env` and on the VM.

### 9.3 Confirm the SSO IP-binding mode

`NOIP` (default) needs nothing. `WARNING` logs mismatches but allows. `ENFORCE` revokes the session
on a mismatch, so `CF-Connecting-IP` derivation must be exactly right — the plan implements it, but
verify with one real login through the tunnel before enabling `ENFORCE`.

### 9.4 CORS

Nothing to do for the BFF. If a future direct-browser flow is ever added, add
`https://agent.neuralmatrix.site` to `SSO_CORS_ALLOWED_ORIGINS`; today it is absent.

---

## 10. Security notes

| Topic | Decision |
|---|---|
| Token storage | Server-side SQLite; browser holds only an opaque session id. No `localStorage`/`sessionStorage`. |
| Cookie | `HttpOnly`, `SameSite=Strict`, `Secure` in the cloud, `Path=/`, 7-day expiry, rotated id on login. |
| CSRF | SameSite=Strict + `Origin` check on every state-changing request; no cross-origin CORS. |
| Brute force | SSO throttles login per IP and per username; pass the real IP. Local limiter on `/api/auth/login` (10/min/IP) plus a Cloudflare WAF rate-limit rule (Free: 5 req/10 s per IP, Block 10 s; configured and trigger-verified 2026-10-23). |
| Secrets | `SSO_CLIENT_SECRET` server-side only; never logged, never sent to the browser. Token values only appear as `sha256[:12]` in logs. |
| Fail mode | Closed: SSO unreachable → 503, never "allow because we cannot check". |
| Session DB | `auth.db` is secret material (refresh tokens); mode 600, owner `nmagent`; include in backups or accept re-login after restore. |
| Cloudflare Access | Removed 2026-10-23; the Tunnel remains and SSO is the only application gate. Re-enabling Access is optional defense-in-depth and adds a second login. |
| Long-running SSE | Authorised once at connect. A turn may outlive the access token and, in principle, a suspension. Accepted for now; signed webhooks (`user.suspended`) are the later fix. |
| SSO outage | Existing streams continue; new requests 503. The Tunnel still serves the static login page, but login/API need the SSO. |

---

## 11. Failure matrix

| Situation | Behaviour |
|---|---|
| No cookie / bad cookie | 401 `not_authenticated` |
| Wrong password | 401 from SSO, surfaced as a generic login error; no user enumeration |
| Account suspended | 403 `account_inactive` at login; existing session dies at next introspect |
| Permission missing | 403 `permission_denied`; user stays logged in |
| Access token expired | Silent refresh; retry the request once |
| Refresh token expired/revoked | Destroy session → 401 → login screen |
| Refresh reuse race | Serialised server-side; lock prevents the SSO's reuse detector from firing |
| IP mismatch (ENFORCE) | SSO returns `active:false`; 401, session destroyed, user logs in again |
| SSO timeout/5xx | 1 retry, then 503 + `Retry-After: 5`; no unverified fallback |
| SSO 429 | Honour `Retry-After`; login shows a countdown; API returns 503/429 to the caller |
| Invalid auth config (missing secret, bad URL, unreadable CA) | Import-time throw → process exits (fail fast) |
| SSO unreachable at boot | Warning logged; login/API answer 503 until it recovers |

---

## 12. Testing plan

1. **Unit:** client IP (spoofing, IPv6, mapped, trusted/untrusted), cookie parsing/flags, session
   store expiry, refresh lock, introspection cache TTL/cap.
2. **Fake SSO:** a `node:http` server implementing login/refresh/logout/introspect with scripted
   responses (active, inactive, allowed=false, 429, 503, slow). No real network in CI.
3. **Route tests:** `/api/health` open; `/api/sessions` 401; login sets cookie; `/api/auth/me`
   returns the user; logout clears; 403 when the permission is missing; 503 when the fake SSO is
   down.
4. **Manual against the cloud SSO:** one real login locally (`AUTH_MODE=sso`, `SSO_CA_FILE`), one
   through the tunnel; verify `CF-Connecting-IP` reaches introspect, SSE survives >15 min, upload
   and wiki proxy work, and an admin `logout-all` kills the session within 30 s.
5. **Regression:** `npm run check`, the existing 111 tests (auth defaults to `off`; no HTTP tests
   bind the app today).

---

## 13. Rollout phases

| Phase | Work | Exit criterion |
|---|---|---|
| **0. SSO admin** | Create `application.nmfinance`, grant the user, install/verify the pinned cert, confirm IP mode | A native `curl` login returns a user with `application.nmfinance` in `perms` |
| **1. Server core** | `src/auth/*`, config, store, routes, middleware, tests | ✅ done — 30 auth tests, full suite 141/141, `AUTH_MODE=off` unchanged |
| **2. Frontend** | Login screen, auth gate, 401 handling, logout, user chip | ✅ done — headless Chromium: login → app → logout, wrong-password error, no-permission screen, mid-app 401 → login |
| **3. Local validation** | Real login, SSE, uploads, wiki, MCP toggles, session restore; test SSO-down behaviour | ✅ validated by the owner against the cloud SSO (2026-10-23) |
| **4. Cloud deploy** | Add auth env + CA file to `/etc/nm-finance-agent.env`; restart; verify through the tunnel; update the runbook/report | Handover: [`docs/sso-phase4-cloud-handover.md`](./sso-phase4-cloud-handover.md) |
| **5. Hardening (optional)** | Signed webhook receiver for `user.suspended`, local JWKS pre-check, per-user workspace/session keying | Later; triggered by a second human user or SSO latency |

**Rollback:** set `AUTH_MODE=off` and restart `nm-finance-agent` only for a brief,
controlled test. With Cloudflare Access removed, `off` leaves the app publicly
unauthenticated; it is **not** a safe long-lived rollback. Re-enable Access or
stop the service for a longer rollback.

**Deployment mechanics:** the code deploy is the existing procedure (`git pull --ff-only` as
`deploy`, `npm ci`, frontend build, restart). The new pieces are the env block and the CA file:

```bash
sudo install -o root -g nmagent -m 644 sso-ca.pem /etc/nm-finance-agent/sso-ca.pem
# /etc/nm-finance-agent.env additions (no secrets in the repo):
#   AUTH_MODE=sso
#   SSO_CA_FILE=/etc/nm-finance-agent/sso-ca.pem
#   SSO_TRUSTED_PROXIES=127.0.0.1,::1
#   SSO_CLIENT_IP_HEADER=cf-connecting-ip
#   AUTH_REQUIRED_PERMISSION=application.nmfinance
#   AUTH_COOKIE_SECURE=1
#   AUTH_DB_PATH=/var/lib/nm-finance-agent/state/auth.db
sudo systemctl restart nm-finance-agent
```

Caddy does not change: `CF-Connecting-IP` is passed through by the tunnel, and Caddy's own XFF
append does not matter because the peer is loopback and the header takes precedence.

---

## 14. Explicit non-goals for this phase

- **No per-user data isolation.** `sessions.db`, `workspace/`, `memories/`, skills state, and MCP
  toggles stay global. The deferred design (`docs/per-user-workspace-and-r2.md`) is the reference
  for what changes when a second human appears. This phase records `sub` on the auth session only.
- **No webhook receiver.** Suspension is detected by introspection within 30 s; running SSE turns
  finish.
- **No local JWT/JWKS verification.** Introspection is the single check. Local verification can be
  added later as a pre-filter; it would also make the issuer fix matter.
- **No direct browser→SSO flow, no SSO-hosted login page** (the SSO does not have one yet).
- **No service tokens / on-behalf-of.** Not needed for a user-facing SPA.
- **No change to Cloudflare Tunnel, Caddy, MCP, or the skills registry.** (Cloudflare Access was
  removed afterward; see the deployment report §15.)

---

## 15. Decisions locked (2026-10-23)

1. **App codename:** `application.nmfinance`. Create it in the SSO and grant it to the owner's
   user before phase 3.
2. **SSO identity:** keep `https://2.24.91.212:8443` and pin the leaf certificate via
   `SSO_CA_FILE` (§9.1). No hostname migration, no CORS work.
3. **Session lifetime:** 7 days, matching the SSO refresh lifetime
   (`AUTH_SESSION_TTL_DAYS=7`, cookie `Max-Age=604800`).
4. **`/api/health`:** stays public as today; add only `auth_mode` (no user data).

Still deferred: whether a second human user is expected soon. If so, decide between per-user
directories (option B) and one container per user (option C) in
`docs/per-user-workspace-and-r2.md` **before** exposing login to them; this phase keeps all data
global and records only `sub` on the auth session.
