# CLAUDE.md — nm-finance-agent

Ground-up TypeScript agent harness (REST-only), rebuilt from the Python
LangGraph repo (`~/projects/langgraph-demo`) without the LangGraph/LangChain
dependency. Financial research agent. Designed so the memory substrate can
later be swapped to `ruvector-core::AgenticDB` behind the `SessionStore`
interface — the loop only knows `loadSession / recordTurn / search / listSessions`.

## Current status

**Step 1 + five hardening increments complete.** A working agentic loop with
always-on prompt memory, the basic tool set, a session archive with
provider-valid round-trips, the Chat-tab web UI, live turn cancel, Tavily
search, non-SDK LangSmith tracing, and workspace-enforcement. Next increments
(session titler, nudge curation, search condensation, compression w/ lineage,
skills) follow the Hermes-order from nm-memory-layer — see the Roadmap.

## Layout

```
nm-finance-agent/
├── src/
│   ├── index.ts          # Express server: /api/health, /api/sessions*, /api/memory,
│   │                     #   POST /api/chat (SSE), POST /api/chat/cancel; CORS + proxy target
│   ├── agent.ts          # AgentLoop: explicit agent ↔ tool cycle (no graph lib),
│   │                     #   buildSystemPrompt(), per-turn LangSmith run tree
│   ├── llm.ts            # OpenAI-compatible client via fetch; retry/rate-limit
│   │                     #   port of langgraph-demo main.py (4s spacing, 5 attempts)
│   ├── memory.ts         # PromptMemory: MEMORY.md/USER.md, shared budget, load-once
│   ├── store.ts          # SessionStore: turn-rows, tool-call fidelity, FTS5 fallback chain
│   ├── tracing.ts        # LangSmith REST runs client (no SDK; fire-and-forget)
│   ├── workspace.ts      # resolveInWorkspace() + guardWorkspaceWrite()
│   ├── config.ts         # All env vars; dotenv(override=true)
│   ├── types.ts          # ToolDef, ChatMessage, ToolCall
│   ├── tools/            # fs.ts, shell.ts, web.ts (Jina Reader + Tavily),
│   │                     #   memory_manage.ts, session_search.ts, index.ts (registry)
│   └── tests/            # contracts.test.ts + workspace.test.ts (13 tests)
├── frontend/             # Chat-only React app (ported from langgraph-demo; vite proxy → :3001)
├── memories/             # MEMORY.md + USER.md (local-only, agent-curated)
└── workspace/            # Agent scratch area (gitignored) — all artifacts land here
```

## Contracts (the suite is the contract — `npm test`, 13 tests)

- **`Error:`-prefix is fatal, `Recovered:`-able denials never use it.** Tool
  results starting with `Error:` end the agent turn (system failures, wrong
  args, timeouts). Recoverable policy denials (memory budget over,
  workspace-under-source writes) speak `Rejected:` so the model can retry.
  Nonzero shell exits and stderr are *information*, not errors (Python parity).
- **3,575-char combined budget** over MEMORY.md + USER.md, enforced on every
  `memory_manage` write across BOTH files.
- **Provider-valid round-trips.** `recordTurn`→`loadSession()` preserves
  assistant `tool_calls`, `tool_call_id`, and tool name; cancel mid-turn
  persists only the provider-valid prefix (dangling tool_call groups dropped,
  ported from server.py `_valid_prefix_len`).
- **Search fallback chain** — FTS5 strict AND → OR phrase → LIKE words,
  newest-first. External-content FTS5 has one column (`content`, index 0);
  snippet(col 1) throws silently → caught → fallback (pinned by test).
- **Tracing never breaks the turn** — fire-and-forget, 5s timeout, no-op client
  when key absent.
- **Workspace writes guarded, reads never.** see Workspace section.

## Tool surface (flat registry, no special cases in the loop)

`ls`, `read_file`, `write_file` (allow_outside), `edit_file` (allow_outside),
`glob`, `grep`, `execute` (30s timeout, cwd=workspace),
`web_to_markdown` (Jina Reader), `internet_search` (Tavily:
general/news/finance, score+date annotations), `memory_manage`
(add/replace/remove × memory/user), `session_search` (episodic FTS5).

Every tool is `ToolDef {name, description, parameters, execute}`; later
increments (skills, wiki, MCP clients, nudge-bound tools) plug in as plain
registry entries or post-turn hooks — mirroring `assemble_agent_runtime`
composition.

## Workspace

`WORKSPACE_DIR` (default `./workspace`, gitignored, auto-created). Relative
paths in fs tools + `execute` cwd resolve there; absolute paths for real
sources. Writes into harness internals (`src/`, `frontend/src`, `.env`,
`tsconfig.json`, package files) → `Rejected:` denial (`allow_outside=true`
overrides; `WORKSPACE_HARD_JAIL=1` confines ALL writes for network-exposed
servers).

## Environment (see .env.example)

- LLM: `OPENAI_API_KEY`, `OPENAI_MODEL_ID` (default glm-5.3-flash),
  `OPENAI_BASE_URL`, `MAX_COMPLETION_TOKENS`.
- Retrieval: `TAVILY_API_KEY` (search; required), `JINA_API_KEY` (Jina Reader
  fetch; optional). The s.jina.ai search API broke on the old key — search is
  Tavily now; Reader unchanged.
- Tracing: `LANGSMITH_API_KEY` (or legacy `LANGCHAIN_API_KEY`) enables
  LangSmith; `LANGCHAIN_PROJECT` (default `default`), `LANGSMITH_TRACING=0`
  disables.
- Storage: `SESSION_DB_PATH` (default `./sessions.db`, CWD-relative),
  `MEMORY_DIR` (default `./memories`), `WORKSPACE_DIR`, `WORKSPACE_HARD_JAIL`.
- Server: `SERVER_HOST`/`SERVER_PORT` (default 127.0.0.1:3001).

## Design decisions

- **Node 24 built-in `node:sqlite`** — FTS5 works out of the box, zero native
  deps (no better-sqlite3 build). WAL mode + busy_timeout, same single-writer
  discipline as nm-memory-layer.
- **fetch over SDK** — the OpenAI-compatible endpoint is one POST; the
  retry policy (rate-limit spacing + transient backoff) ports verbatim and
  stays auditable in 40 lines.
- **Redis-modeled on the python harness contracts, not its code** — the
  LangGraph StateGraph became an explicit loop; the LangChain tool factories
  became a flat `ToolDef` registry; `BaseMessage` became `ChatMessage`. What
  transferred was the semantics: turn structure, `Error:` fatality,
  budget/curation conventions, cancel-with-valid-prefix.
- **Flat ToolDef surface is deliberate** — the AgenticDB swap (roadmap step
  6) touches only `SessionStore` and `store.ts`; nothing in the loop or tools
  needs to change.
- **The web UI is a consumers' thin client** — all state lives in the REST
  server; the React app holds only ephemeral view state (mirrors server.py
  relationship to its frontend).

## Roadmap (Hermes-order, from nm-memory-layer doctrine)

1. ~~Agentic loop + prompt memory + basic tools + SSE REST~~ ✓ 2026-10-09
2. Session titler + nudge policy (secondary-LLM curation, silence-bias)
3. Secondary-LLM search condensation (observability header, silent fallback)
4. Pre-flight context compression with persisted lineage
5. Skills: agentskills.io SKILL.md files, progressive disclosure,
   per-user enable/disable (port nm-skills-registry client)
6. Memory substrate swap evaluation (`ruvector-core::AgenticDB`) behind
   `SessionStore` — hybrid recall + feedback learning then come from the
   substrate instead of hand-rolled FTS5 upgrades
7. (Deferred) Yahoo proxy + vela-chart rendering for the finance surface

## Dev

```bash
npm install && npm run start   # backend on :3001
cd frontend && npm run dev     # web UI on :5173 (proxies /api)
npm test                       # 13 contract tests
```
