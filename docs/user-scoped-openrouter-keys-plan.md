# User-scoped OpenRouter keys — planning document

**Status:** decisions locked by the owner (2026-10-25, §10); Phase 1 implemented —
`src/llm-keys.ts`, per-user resolution in `chat()`, `LLM_KEY_POLICY` /
`LLM_KEY_REQUIRE_USER_AFTER` / `USER_LLM_KEY_SECRET` knobs, key + usage routes,
"Model & key" settings tab, `llm_usage` table with a per-user summary;
focused tests in `src/tests/llm-keys.test.ts` (suite 216/216). Per-user main/
summarizer model preferences and the free-model risk warning landed 2026-10-29.
Deployment values decided: the VM ships `require_user` + a 7-day warn window + a generated
`USER_LLM_KEY_SECRET` (see deploy-2026-10-25-agent-cron-sse-ui.md §5b).
**Date:** 2026-10-25
**Ask:** each SSO user provides their own OpenRouter API key in the UI; the
harness bills that user's key for their turns (chat, deep research, scheduled
cron fires) instead of the operator's server-wide `OPENROUTER_API_KEY`.
**Related:** [`agent-cron-plan.md`](./agent-cron-plan.md) (scheduled fires are
the biggest per-user spend), [`per-user-memories-plan.md`](./per-user-memories-plan.md)
(per-user state conventions), [`vm-deployment-runbook.md`](./vm-deployment-runbook.md).

---

## 1. Context

Today `src/llm.ts` reads one module-level `OPENROUTER_API_KEY` and stamps
`Authorization: Bearer …` on every call — main turns, summarizer, titler,
compression, followups, nudge, deep research, and every cron fire. On the EC2
deployment that is the operator's key: a single scheduled NFLX run cost
~3.4M prompt tokens, and any SSO user's chat session draws on the same credit
pool. User-scoped keys fix the incentive problem and cap the operator's
exposure, and OpenRouter gives us the full API surface to do it properly.

## 2. What OpenRouter gives us (verified against the live OpenAPI spec)

| Endpoint | Purpose for this feature |
|---|---|
| `GET /api/v1/key` | Validate a key **without spend**: returns `label`, `usage`, `limit`, `is_free_tier`, rate-limit info. The natural "is this key good?" check |
| `GET /api/v1/credits` | Remaining credits for the key — drives a UI "credits left" widget |
| `POST /api/v1/keys` (+ `GET/PATCH/DELETE /keys/{hash}`) | **Provisioning API**: create derived keys programmatically with `name`, `limit`, `limit_reset: "monthly"`, `expires_at` — requires a provisioning key |
| `POST /api/v1/auth/keys/code` → `POST /api/v1/auth/keys` | **OAuth PKCE flow**: the harness creates an authorization code (`callback_url`, `code_challenge`, optional `limit`), the user authorizes in the browser, the harness exchanges `code + code_verifier` for an API key — no copy-paste, user never pastes a secret into our UI |
| BYOK endpoints (`CreateBYOKKeyRequest`) | Users can attach third-party provider keys (openai/…) under their OpenRouter account — future multi-provider angle |

Onboarding keys default to a $100 credit limit and expire after 180 days;
[OpenRouter recommends a credit limit on every key](https://openrouter.ai).

## 3. Where the change lands in this harness

- **One resolution point**: `chat()` in `src/llm.ts` builds the
  `Authorization` header for every LLM call in the process (the agent loop's
  `chatFn`, summarizer, titler, compression, followups, nudge, and the whole
  research module all funnel through it). Resolving the key per-call there
  covers every role with **zero call-site changes**.
- **The user is already in scope**: requests run inside the
  `runInWorkspace(user)` AsyncLocalStorage scope (auth middleware), and cron
  fires already execute inside `runInWorkspace(job.user_id, …)` — so
  `currentUserId()` resolves correctly at every `chat()` call, including
  unattended fires. The titler/nudge async continuations inherit the scope
  (ALS propagates the creation context).
- **Storage precedent**: per-user files under
  `state/users/<login-id>/…` with `0700` dirs / `0600` files and atomic
  tmp+rename writes — exactly the `mcp-user-state.ts` pattern, reused for a
  `llm.json`.

## 4. Design

**Storage** (`src/llm-keys.ts`): `SKILLS_STATE_DIR/users/<id>/llm.json` →

```json
{
  "openrouter": {
    "key_enc": "<base64 iv|tag|ciphertext>",
    "label": "gordon's key", "masked": "sk-or-v1-…e4f2",
    "added_at": 1793…, "last_checked": 1793…, "last_usage_usd": 0.42
  },
  "models": {
    "main": "z-ai/glm-5.3-flash",
    "summarizer": "poolside/laguna-xs-2.1:free"
  }
}
```

`models` is optional; blank fields clear the override and fall back to the
workspace defaults.

- Encryption at rest: AES-256-GCM with a master secret from env
  `USER_LLM_KEY_SECRET`; if unset, fall back to plaintext `0600` + a boot
  warning (documented downgrade, same trade the runbook already makes for
  `/etc/nm-finance-agent.env`).
- Masking rule everywhere except the fire path: first 10 + last 4 chars.

**Resolution** (`chat()`): resolve `currentUserId()` → read the user's key →
`Authorization: Bearer <userKey>`, else the server key per policy. Add a small
per-key last-used cache to avoid a file read per LLM call (mtime check).

**Policy knob** (`LLM_KEY_POLICY`):

- `prefer_user` (default, backwards compatible): user key if present, else the
  server key — nobody is locked out on day one.
- `require_user`: no server fallback — a turn without a user key fails with a
  clear, UI-actionable error ("add your OpenRouter key in Settings"). This is
  the operator-spend-protection end state; flip it when ready.
- `server_only`: feature off (dev boxes).

**HTTP surface** (per-user, SSO-gated; `AUTH_MODE=off` hides the feature and
uses the server key):

```
POST   /api/user/llm-key   { key }  → validate via GET /api/v1/key, store,
                                      return { masked, label, usage_usd, limit }
GET    /api/user/llm-key            → { present, masked, label, usage_usd, limit,
                                      last_checked, models } — never the key itself
PUT    /api/user/llm-models         { main_model, summarizer_model } → replace
                                      per-user overrides; blank clears
DELETE /api/user/llm-key            → remove
```

**UI**: a third tab in the settings modal ("Model & key"): password-style key
input, validation status (valid/invalid + label + credits), Save/Remove, and a
"no key configured — using the server key / chat is disabled" banner depending
on policy. The sidebar model row can show a subtle ⚠ when
`LLM_KEY_POLICY=require_user` and no key is set.

## 5. Key-entry UX — three options, in order of effort

1. **Paste key** (Phase 1): user copies from openrouter.ai/keys, the server
   validates via `GET /api/v1/key` before storing. Simple, works everywhere.
2. **OAuth PKCE** (Phase 2, best UX): harness mints an authorization code
   (`POST /auth/keys/code` with our callback URL + PKCE challenge + optional
   default `limit`), redirects the user, exchanges the code server-side. No
   user-handled secret at all — OpenRouter's own "sign in with OpenRouter"
   pattern. Needs the callback route + state/verifier storage.
3. **Provisioning-key minting** (Phase 3): the operator stores ONE
   provisioning key; the harness mints each user a derived key with a hard
   credit limit and `limit_reset: "monthly"` — spend control enforced
   by OpenRouter itself, per-user keys revocable from the operator's
   OpenRouter dashboard. Strongest operator protection; requires trusting the
   harness with the provisioning key (encrypt like user keys).

## 6. Interplay with existing subsystems

- **Cron fires**: already wrapped in `runInWorkspace(job.user_id)`, so a fire
  resolves its owner's key automatically — a job then bills its owner, not the
  operator. Under `require_user`, a fire whose owner has no key records
  `failed` with the actionable error in the run ledger (visible in Scheduled).
- **LangSmith traces**: inputs/outputs never include headers — no key leakage
  path exists today; keep it that way (the resolution happens in the fetch
  headers only).
- **Logs**: OpenRouter errors are body-text; make sure error wrapping never
  echoes the Authorization value (it doesn't today — keep the 300-char slice).
- **Rate limiting**: `MIN_INTERVAL_MS` is process-global; per-user keys make
  per-user fair queueing conceivable but unnecessary in v1 (single-tenant
  reality).
- **Free models**: the summarizer/titler already run on a `:free` model; a user
  key with zero credits can still serve those roles. Per-user model
  preferences are now supported; the UI shows a dismissible risk warning when
  an entered/selected model carries the `:free` variant.

## 7. Security notes

- Keys cross the wire once, over Caddy TLS, to the harness; the browser never
  holds them after submission (no localStorage).
- Origin guard + SSO cookie already protect `/api/*` mutations; key routes
  inherit it.
- The operator cannot read user keys (only ciphertext on disk); the harness
  decrypts only in the fire path. Conversely, users cannot see or spend the
  server key except through their own turns under `prefer_user` — flipping to
  `require_user` is the operator's lever.
- Never log keys: audit `llm.ts`, `logger.ts`, and trace payloads once at
  implementation time.

## 8. Test plan

- Unit: storage roundtrip (enc/no-secret fallback), masking, policy resolution
  (`prefer_user`/`require_user`/`server_only`), ALS resolution for cron fires.
- Route tests: validate-and-store with mocked OpenRouter fetch (valid, 401,
  network error), DELETE, foreign-user access.
- Loop integration: stub `fetch` asserting the `Authorization` header equals
  the user key when one is set and the server key when not.
- Manual on the VM: real key validation, a cheap turn, credits widget.

## 9. Rollout phases

1. **Phase 1**: storage + resolution + policy knob + paste-key UI tab +
   validation endpoint. Deliverable: users bill their own key; operator key is
   the fallback.
2. **Phase 2**: credits widget (`/api/v1/credits`), `require_user`
   enforcement, OAuth PKCE entry.
3. **Phase 3**: provisioning-key minting with per-user credit limits and BYOK
   multi-provider; per-user model preference is implemented.

## 10. Decisions (owner, 2026-10-25)

1. **Master-secret bootstrap**: dedicated `USER_LLM_KEY_SECRET` env (documented
   generator command; unset = plaintext-at-rest fallback with a boot warning).
2. **`require_user` timing**: warn-only for one week — the VM deploy sets
   `LLM_KEY_POLICY=require_user` + `LLM_KEY_REQUIRE_USER_AFTER=<+7d>`; until
   that date the server key still backs turns and the UI shows the deadline.
3. **Key deletion mid-session**: allowed — resolution is per call, so the
   in-flight turn finishes on its already-resolved header; documented.
4. **Per-user spend**: harness-side `llm_usage` table (per-call rows: model,
   tokens, cost) + a summary endpoint and a usage block in the settings tab —
   the operator wants central reporting. OpenRouter-side limits remain the
   hard spend control.

## 11. Deployment-agent checklist — per-user model preferences

Implemented in `0a9f9eb` (backend + UI). No database migration and no new
environment variables are required. The frontend and backend must be deployed
together: the new UI expects the `models` object from `GET /api/user/llm-key`.

### Before restart

- [ ] Confirm `SKILLS_STATE_DIR` is the persistent data volume (normally
      `/var/lib/nm-finance-agent/state`). Model preferences live at
      `state/users/<login-id>/llm.json`.
- [ ] Confirm the frontend build is included in the deploy
      (`npm --prefix frontend ci && npm --prefix frontend run build`).
- [ ] `npm run check && npm test` pass; current suite is **216 tests**.
- [ ] The existing key files need no migration: `models` is optional, so a file
      containing only `openrouter` is valid.
- [ ] `USER_LLM_KEY_SECRET` is still required only for encrypting the key. Model
      IDs are not secrets and are stored as plain JSON.
- [ ] `OPENROUTER_MODEL_MAIN` / `OPENROUTER_MODEL_SUMMARIZER` remain the
      workspace defaults; a user override takes precedence.

### After restart + hard refresh

Check the UI path **Settings → Model & key → Model preferences**:

- [ ] Both inputs show the stored overrides, or are blank with the workspace
      defaults as placeholders.
- [ ] Effective main and summarizer values are displayed.
- [ ] Saving a known main/summarizer ID returns success and survives a page
      reload.
- [ ] Clearing both fields and saving restores the workspace defaults.
- [ ] A `:free` ID shows the dismissible free-model risk banner; **Dismiss**
      hides it, and Save still succeeds.
- [ ] The old **Ask/Key** flows still work; the key remains encrypted and is
      never shown again.

### API contract (authenticated browser session)

Use the signed-in app UI/DevTools; do not paste cookies or keys into logs.

```http
GET /api/user/llm-key
```

The response now includes, alongside the existing key status:

```json
{
  "models": {
    "main": "z-ai/glm-5.3-flash",
    "summarizer": "poolside/laguna-xs-2.1:free",
    "default_main": "z-ai/glm-5.3-flash",
    "default_summarizer": "poolside/laguna-xs-2.1:free",
    "effective_main": "z-ai/glm-5.3-flash",
    "effective_summarizer": "poolside/laguna-xs-2.1:free",
    "main_free": false,
    "summarizer_free": true
  }
}
```

`main` / `summarizer` are `null` when the user has not set an override.
`*_free` describes the effective model, not necessarily a user override.

```http
PUT /api/user/llm-models
Content-Type: application/json

{"main_model":"z-ai/glm-5.3-flash","summarizer_model":"poolside/laguna-xs-2.1:free"}
```

- Blank strings clear the corresponding override.
- Invalid IDs (whitespace/control characters or format violations) return
  `400` with an actionable `detail`.
- Model IDs are **format-validated only**, not checked against OpenRouter's
  entire catalog. Use exact IDs from `openrouter.ai/models`; a well-formed but
  nonexistent ID fails on the next call.

### Verify the model actually used

Use one test user at a time so the process-wide log line is attributable:

```bash
sudo journalctl -u nm-finance-agent -f | grep --line-buffered '\[llm\] POST'
```

- Start a chat turn. The main call should log
  `model=<effective_main>`.
- The first-turn title refinement is a summarizer call; it should log
  `model=<effective_summarizer>`.
- In LangSmith, inspect the `agent-turn` / `llm:*` metadata and
  `session-title` / `session-search-summarize` metadata; they should carry the
  effective model.
- If enabled, run one scheduled job owned by the test user and one research
  turn: cron inherits the owner's ALS scope, and research roles use the same
  effective main/summarizer values.

### State-file spot check

Models are not secret, but do not print `key_enc`/`key_plain`:

```bash
sudo -u nmagent jq '.models' \
  /var/lib/nm-finance-agent/state/users/<login-id>/llm.json
```

Expected after a save:

```json
{"main":"<model-id>","summarizer":"<model-id>"}
```

The file/dir permissions should remain `0600`/`0700`; the key entry must remain
unchanged.

### Isolation and failure checks

- [ ] Save different model IDs for two test logins; confirm each
      `state/users/<id>/llm.json` has its own `models` and the other user's
      chat logs/traces show their own selection.
- [ ] Under `LLM_KEY_POLICY=require_user`, a user with no key still gets the
      existing key-required error (model selection does not bypass it).
- [ ] A bad-but-well-formed model ID fails at OpenRouter with a visible error;
      correct it in the UI and confirm the next turn recovers.
- [ ] A free model may return 429/timeouts; the warning is advisory, not an
      availability guarantee.

### Rollback

- No schema migration is involved. Reverting the app code is safe; old code
  ignores the `models` field.
- Deploying **new frontend against old backend** is not safe: the UI expects
  `models` in the key-status response. Roll back both together, or leave the
  model UI hidden during a staggered rollback.
- To reset a user without reverting code, save two blank fields via the UI (or
  remove `models` from their `llm.json` while the service is stopped).
