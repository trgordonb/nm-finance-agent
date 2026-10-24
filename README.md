# nm-finance-agent – ground-up REST agent harness

Rebuild of the langgraph-demo harness without Python/LangGraph: an explicit
agentic loop over OpenRouter (main model + provider steering), always-on prompt
memory, and the basic tool set, exposed only as a REST API
(Express + SSE). Designed to grow into a memory layer that will ultimately
adopt `ruvector-core::AgenticDB` as its substrate.

**Status (2026-10-14):** the full Hermes-order stack is live — agent loop,
session archive with provider-valid round-trips + live turn cancel, hybrid
recall (FTS5 ⊕ agentdb mirror), prompt memory, titler, followups, nudge,
context compression, skills (R2-backed working copy), MCP, the Wiki tab
(llmwiki reader) and deep research (`/research`, the thinkdepth-ai port —
see below). `HISTORY.md` tracks increments; agent-facing doctrine
(contracts, env vars, roadmap) in `CLAUDE.md`.

## Stack decisions

- **Express** (vs Fastify/others): ubiquitous, built-in SSE friendliness, zero
  plugin ceremony for the streams we need. Fastify is a fine later swap — the
  HTTP layer is deliberately thin (`src/index.ts`).
- **node:sqlite** (Node 24 built-in, FTS5 available): zero native deps — no
  better-sqlite3 build step. WAL mode. Same "CWD-relative db" doctrine as
  nm-memory-layer.
- **No LLM SDK**: `fetch` against OpenRouter (`/chat/completions`), with the
  langgraph-demo retry/rate-limit policy ported verbatim (4s spacing,
  5 attempts, exponential backoff on 5xx/429/socket errors). Provider
  steering (`provider.order` + fallbacks) and the `reasoning` block flow
  from `.env` — surfaced in `/api/health`.

**Scheduled for later increments** beyond the step-1 surface: skills, wiki,
MCP, nudge + context compression, session titler. *All of those have since
landed — see `HISTORY.md`; deep research (`/research`) is the newest
addition, documented below.*

## LangSmith tracing

Every agent turn persists a run tree to LangSmith via the REST runs API
(no SDK, no LangChain): one `agent-turn` chain root per turn, `llm:1..n`
children per model call (with token usage in outputs), and one `tool` child
per executed call (args → result, error flagged on `Error:`-prefixed outcomes).
Enabled automatically when `LANGSMITH_API_KEY` (or legacy `LANGCHAIN_API_KEY`)
is present; `LANGSMITH_TRACING=0` forces it off; project from
`LANGCHAIN_PROJECT` (this repo's `.env` uses `nm-finance-agent`). Non-blocking
with a 5s timeout — tracing failing can never break a turn. `GET /api/health`
exposes the active project under `tracing`.

## Deep research (`/research`)

A port of the thinkdepth-ai research mode (Python/LangGraph) as an explicit,
LangGraph-free engine (`src/research/`; plan + decisions in
`docs/deep-research-plan.md`):

- **Invocation**: prefix a chat message with `/research` — e.g. `/research
  analysts on the latest NVDA earnings guidance`. The server runs the full
  pipeline (clarify → research brief → pre-research outline → supervisor
  fan-out to parallel researchers with Tavily search + Exa/LLM page summaries
  under a token budget → lossless compression → refinement → final cited
  report, ≤3,000 words with a gap-free numbered Sources list) and streams
  `research` progress events into the feed (step trail + live elapsed strip).
  Stop cancels mid-run; a run that pauses on a clarifying question resumes
  when you reply in the same session (no prefix needed).
- **CLI**: `npm run research -- "question" [--out report.md] [--quiet]` —
  headless runs with per-run logs under `$WORKSPACE_DIR/research/logs/`.
- **Outputs**: completed runs save the report to `$WORKSPACE_DIR/research/`
  (`RESEARCH_SAVE_REPORTS=0` disables), append it to the session archive, and
  trace the full tree (`deep-research` root + `llm:research:*` / `tool:*`
  children) to LangSmith. Run state lives in the `research_runs` table with
  `GET /api/research/:sessionId` for reload/reconnect; a server restart marks
  in-flight runs `interrupted` (no mid-run resume).
- **Cost/latency**: a run typically takes 20–40 minutes and many LLM + search
  calls; every research role uses the single `OPENROUTER_MODEL_MAIN`
  (z-ai/glm-5.3-flash). Budgets/caps in `.env.example` (`RESEARCH_*`).
  `RESEARCH_AS_TOOL=1` additionally exposes `deep_research` as a main-agent
  tool (default off — the `/research` prefix is the primary invocation).

## Contract parity pins (tested in `src/tests/contracts.test.ts`)

- Combined MEMORY.md+USER.md budget = **3,575 chars**; rejections speak
  `Rejected:` (recoverable) — never `Error:` (fatal, ends the turn).
- Turn archive preserves assistant `tool_calls` + `tool_call_id` + tool name →
  resumed histories are provider-valid.
- Tool results: system/fatal failures start with `Error:`, model-facing info
  (nonzero exits, stderr) does not.
- Search fallback chain: FTS5 strict AND → OR → LIKE words.

## Run

```bash
cp .env.example .env    # then fill in keys
npm install
npm run start            # backend  → http://127.0.0.1:3001
cd frontend && npm install && npm run dev   # web UI → http://localhost:5173 (proxies /api)
npm test                 # full suite (147 tests at the time of writing)
npm run research -- "question"   # deep research CLI (saves under $WORKSPACE_DIR/research/)
```

The frontend is the React app (sidebar sessions, streaming feed with
collapsible tool results, Stop = turn cancel, Wiki tab, settings for
Skills | MCP, deep-research progress strip). Its vite dev server proxies
`/api` to the Express backend, so no CORS handling is needed in dev (the
backend no longer sends wildcard CORS headers — see Authentication below).

## Authentication (SSO)

Off by default (`AUTH_MODE=off`). With `AUTH_MODE=sso` the app is a
backend-for-frontend client of the Neural-Matrix SSO server
(`Neural-Matrix-LLC/SSO-server`):

- the browser posts credentials to `POST /api/auth/login` and gets an
  `HttpOnly`, `SameSite=Strict` cookie; access/refresh tokens stay server-side
  in `auth.db` and never reach JavaScript;
- every `/api/*` route except `/api/health` and `/api/auth/*` requires a live
  session and the `application.nmfinance` permission; the server refreshes the
  15-minute access token and introspects it (≤30 s cache) for revocation and
  permission changes;
- the SSO must have the `nm-finance-agent` ServiceClient, the
  `application.nmfinance` permission, and (currently) the pinned self-signed
  certificate configured via `SSO_CA_FILE`.

The UI ships its own login screen (there is no SSO-hosted login page), a signed-in user chip with
Sign out in the sidebar, and an "access required" screen when the account lacks
`application.nmfinance`. With `AUTH_MODE=off` the login screen is skipped and the app behaves as
before.

Design and rollout notes: [`docs/sso-integration-plan.md`](docs/sso-integration-plan.md).
Local testing: set `AUTH_MODE=sso` and `SSO_CA_FILE=./certs/sso-ca.pem` in
`.env` after installing the certificate (see plan §9.1).

## API (step-1 scope)

| Endpoint | Notes |
|---|---|
| `GET /api/health` | model, base_url, memory usage, tool list |
| `GET /api/sessions` | archived sessions, **scoped to the authenticated login id** (each carries a `summary` one-liner: fallback truncated first user message → async LLM refine via the summarizer model) |
| `GET /api/sessions/:id` | full message history (resumable) |
| `GET /api/memory` | rendered `<agent_memory>` block + budget usage |
| `GET/POST /api/sessions/:sid/followups[/dismiss]` | extracted "next steps" tips (dismiss marks + badge counts) |
| `GET /api/followups/counts` | live tip counts per session (sidebar badges) |
| `GET /api/mcp` | mcp_servers.json listing + last-assembly connect status |
| `POST /api/mcp/{name}/enabled` | atomic toggle (404 unknown) |
| `POST /api/mcp/reload` | re-assemble runtime (409 while turns stream) |
| `POST /api/chat` `{message, session_id?}` | **SSE**: `session` → `message`* → (`research`)* → (`error`)? → `done`. Messages prefixed with `/research` run deep research: steps stream as `research` events and `done` carries `mode:"research"` |
| `GET /api/research/:sessionId` | deep-research run state (status/step/question/report/error) for reload/reconnect |
| `POST /api/chat/cancel` `{turn_id}` | aborts the active turn |

`POST /api/chat` example:

```bash
curl -N -X POST http://127.0.0.1:3001/api/chat \
  -H 'Content-Type: application/json' \
  -d '{"message":"list the src directory and summarise"}'
```

## Workspace (python-repo practice, carried + hardened)

`./workspace` (gitignored, auto-created; `WORKSPACE_DIR` to move it) is the
agent's scratch area. With `AUTH_MODE=sso`, each login id gets
`./workspace/<login-id>/` (auto-created on login; the system prompt names the
absolute root). `AUTH_MODE=off` keeps the flat `./workspace` unless
`WORKSPACE_USER` is set. Paths are scoped via `AsyncLocalStorage`, so tools and
shell commands inherit the request's user without extra parameters:

- `ls`/`read_file`/`write_file`/`edit_file`/`glob`/`grep`/`execute` all resolve
  **relative paths against the scoped workspace**; `execute` spawns with
  `cwd = <scoped root>` and exports `$WORKSPACE_DIR`, so script outputs land
  there by construction.
- Absolute paths remain allowed for reading real sources (repo files,
  sessions.db, datasets elsewhere). One process is shared, so this is path
  separation, not a security boundary (`execute` can read another user's
  folder); per-user containers are the isolation step.
- Writes into harness internals (`src/`, `frontend/src`, `.env`,
  `tsconfig.json`, package files) are **rejected** with a `Rejected:` denial
  (model-recoverable — never the fatal `Error:` prefix). Other
  outside-workspace writes pass loudly in GOTCHA mode; set
  `WORKSPACE_HARD_JAIL=1` to confine writes to the scoped workspace.

## Skills registry (R2)

`skills/` is a gitignored working copy; the R2 bucket (`SKILLS_REGISTRY`) is
authoritative. The agent reads and writes locally (`load_skill` / `skill_manage`);
the `nm-skills` CLI is invoked only by `src/skills/sync.ts` — pull+push at boot,
debounced `push --prune` after curation. Reads never touch R2.

`SKILLS_REQUIRED=1` turns a failed or empty boot pull into a fatal exit (the
fresh-VM trap), and `/api/health` reports `skills_backend.degraded`. Fresh-VM
recipe, version pinning and failure semantics: `docs/skills-registry-deploy.md`.

## AgentDB mirror (phase-in, additive)

The SQLite archive stays authoritative; a **mirror sidecar** adds what it
lacks — per-message embeddings for dense semantic `session_search` recall:
- `src/mirror-child.ts` — the only process loading natives (ruvector engine +
  onnx MiniLM both reserve colossal VA mappings that break fork); JSON-lines
  protocol: `init/upsert/query/stats/bye` (embeds internally, no vectors cross
  the pipe)
- `src/agentdb-mirror.ts` — client + degradation policy (`AGENTDB_MIRROR=0`
  off; missing engine → off with reason; archive never depends on the mirror)
- `src/tools/session_search.ts` — RRF fusion (k=60, wiki-hybrid convention)
  over the FTS5 leg ⊕ mirror's dense leg, retriever-tagged blocks
  (`· fts`, `· semantic(0.83)`, `· fts+semantic`), empty sentinel preserved
- `AGENTDB_PATH` (default `./agent-mirror.db`), `AGENTDB_REQUEST_TIMEOUT_MS`
- `AGENTDB_REMOTE_URL` (+`_TOKEN`) — run the same engine as a Cloudflare
  Container instead of the local sidecar (deploy/ops/persistence in
  `container/README.md`; unset = local sidecar unchanged)

Verified live: keyword-orthogonal queries reach seeded turns (semantic-only
tag), `execute` unaffected (the sidecar solves the fork/ENOMEM conflict),
contract tests include fusion + degradation paths.

## Tools (step 1)

`ls`, `read_file`, `write_file`, `edit_file`, `glob`, `grep`, `execute`,
`web_to_markdown` (Jina Reader → Tavily Extract fallback), `internet_search`
(Tavily), `memory_manage` (add/replace/remove over memory|user), `skill_manage`
+ `load_skill` (procedural memory over the skills working copy),
`session_search` (hybrid recall: FTS5 ⊕ agentdb mirror, RRF fusion).

## Tool surface is deliberately flat

Every tool is a `ToolDef {name, description, parameters, execute}` in one
registry — the loop never special-cases a tool. Later increments (skills,
wiki, MCP clients, the memory nudge, context compression, deep research via
`RESEARCH_AS_TOOL=1`) plug in as plain registry entries or post-turn hooks,
exactly like main.py's `assemble_agent_runtime` shape.

## Roadmap (hermes-order, matching nm-memory-layer's doctrine)

1. ~~Agentic loop + prompt memory + basic tools + SSE REST~~ ✓ step 1
2. Nudge policy (curation loop; secondary LLM, silence-bias). (Session
   titler ✓ — fallback + refine, sidebar `summary`; followups ✓ — to-do
   strip, dismiss semantics, badges)
3. Secondary-LLM search condensation with observability header + silent fallback
4. Pre-flight context compression with persisted lineage
5. Skills: agentskills.io SKILL.md files, progressive disclosure,
   per-user enable/disable (port nm-skills-registry client)
6. Memory-node substrate swap evaluation (`ruvector-core::AgenticDB`) behind
   the `SessionStore` interface — the loop only knows `store.loadSession /
   recordTurn / search`
7. Deep research (`/research`): thinkdepth-ai port, stages 1–3 live
   (`docs/deep-research-plan.md`)
