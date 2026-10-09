# nm-finance-agent – ground-up REST agent harness

Rebuild of the langgraph-demo harness without Python/LangGraph: an explicit
agentic loop over the OpenAI-compatible chat API, always-on prompt memory
(MEMORY.md / USER.md), and the basic tool set, exposed only as a REST API
(Express + SSE). Designed to grow into a memory layer that will ultimately
adopt `ruvector-core::AgenticDB` as its substrate.

**Status (2026-10-09):** step 1 + five hardening increments — working agent
loop, session archive with provider-valid round-trips + live turn cancel,
Chat-tab web UI, Tavily search, LangSmith tracing (no SDK), workspace
discipline. Hashed details per increment in `HISTORY.md`; agent-facing
doctrine (contracts, env vars, roadmap) in `CLAUDE.md`.

## Stack decisions

- **Express** (vs Fastify/others): ubiquitous, built-in SSE friendliness, zero
  plugin ceremony for the streams we need. Fastify is a fine later swap — the
  HTTP layer is deliberately thin (`src/index.ts`, ~200 lines).
- **node:sqlite** (Node 24 built-in, FTS5 available): zero native deps — no
  better-sqlite3 build step. WAL mode. Same "CWD-relative db" doctrine as
  nm-memory-layer.
- **No LLM SDK**: `fetch` against the OpenAI-compatible endpoint, with the
  langgraph-demo retry/rate-limit policy ported verbatim (4s spacing,
  5 attempts, exponential backoff on 5xx/429/socket errors).

**Scheduled for later increments** beyond the step-1 surface: skills, wiki,
MCP, nudge + context compression, session titler.

## LangSmith tracing

Every agent turn persists a run tree to LangSmith via the REST runs API
(no SDK, no LangChain): one `agent-turn` chain root per turn, `llm:1..n`
children per model call (with token usage in outputs), and one `tool` child
per executed call (args → result, error flagged on `Error:`-prefixed outcomes).
Enabled automatically when `LANGSMITH_API_KEY` (or legacy `LANGCHAIN_API_KEY`)
is present; `LANGSMITH_TRACING=0` forces it off; project from
`LANGCHAIN_PROJECT` (default `default`). Non-blocking with a 5s timeout —
tracing failing can never break a turn. `GET /api/health` exposes the active
project under `tracing`.

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
npm test                 # 7 contract tests (repo root)
```

The frontend is the Chat-only adaptation of langgraph-demo's React app
(sidebar sessions, streaming feed with collapsible tool results, Stop =
turn cancel): wiki tab, skills/MCP settings screens, and followups are
pushed to later increments. Its vite dev server proxies `/api` to the
Express backend, so no CORS handling is needed in dev; the backend also
sends permissive CORS headers for any other origin.

## API (step-1 scope)

| Endpoint | Notes |
|---|---|
| `GET /api/health` | model, base_url, memory usage, tool list |
| `GET /api/sessions` | archived sessions |
| `GET /api/sessions/:id` | full message history (resumable) |
| `GET /api/memory` | rendered `<agent_memory>` block + budget usage |
| `POST /api/chat` `{message, session_id?}` | **SSE**: `session` → `message`* → (`error`)? → `done` |
| `POST /api/chat/cancel` `{turn_id}` | aborts the active turn |

`POST /api/chat` example:

```bash
curl -N -X POST http://127.0.0.1:3001/api/chat \
  -H 'Content-Type: application/json' \
  -d '{"message":"list the src directory and summarise"}'
```

## Workspace (python-repo practice, carried + hardened)

`./workspace` (gitignored, auto-created; `WORKSPACE_DIR` to move it) is the
agent's scratch area, via mechanism rather than convention:

- `ls`/`read_file`/`write_file`/`edit_file`/`glob`/`grep`/`execute` all resolve
  **relative paths against the workspace**; `execute` spawns with
  `cwd = WORKSPACE_DIR`, so script outputs land there by construction
  (relative-path `ls` even echoes its absolute dir for the model).
- Absolute paths remain allowed for reading real sources (repo files,
  sessions.db, datasets elsewhere).
- Writes into harness internals (`src/`, `frontend/src`, `.env`,
  `tsconfig.json`, package files) are **rejected** with a `Rejected:` denial
  (model-recoverable — never the fatal `Error:` prefix). Other
  outside-workspace writes pass loudly in GOTCHA mode; set
  `WORKSPACE_HARD_JAIL=1` to confine writes to the workspace entirely when the
  server is network-exposed.

## Tools (step 1)

`ls`, `read_file`, `write_file`, `edit_file`, `glob`, `grep`, `execute`
(30s timeout), `web_to_markdown` (Jina Reader), `internet_search` (Tavily),
`memory_manage` (add/replace/remove over memory|user), `session_search`
(FTS5 over the archive, fallback chain, newest-first).

## Tool surface is deliberately flat

Every tool is a `ToolDef {name, description, parameters, execute}` in one
registry — the loop never special-cases a tool. Later increments (skills,
wiki, MCP clients, the memory nudge, context compression) plug in as plain
registry entries or post-turn hooks, exactly like main.py's
`assemble_agent_runtime` shape.

## Roadmap (hermes-order, matching nm-memory-layer's doctrine)

1. ~~Agentic loop + prompt memory + basic tools + SSE REST~~ ✓ step 1
2. Session titler + nudge policy (curation loop; secondary LLM, silence-bias)
3. Secondary-LLM search condensation with observability header + silent fallback
4. Pre-flight context compression with persisted lineage
5. Skills: agentskills.io SKILL.md files, progressive disclosure,
   per-user enable/disable (port nm-skills-registry client)
6. Memory-node substrate swap evaluation (`ruvector-core::AgenticDB`) behind
   the `SessionStore` interface — the loop only knows `store.loadSession /
   recordTurn / search`
