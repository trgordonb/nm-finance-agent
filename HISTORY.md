# HISTORY.md — nm-finance-agent

Track of significant changes. Dates are implementation dates.
The general build order (and the substrate discussion behind it) lives in the
conversation history of the nm-memory-layer comparison; this file tracks the
repo itself.

## 2026-10-09 — ground-up TS harness (all of today's increments)

The repo is the TypeScript rebuild of langgraph-demo's harness, bootstrapped by
reading only `main.py` + `server.py`, deliberately not bounded to LangGraph, and
designed to eventually adopt `ruvector-core::AgenticDB` as the memory
substrate.

- **Agentic loop + prompt memory + basic tools + REST (step 1).** `src/agent.ts`
  flattens the LangGraph `agent ↔ execute_tool` StateGraph into an explicit
  async loop (same semantics: multi-call support, `Error:`-prefixed tool result
  ends the turn, max-iterations guard). `src/memory.ts` ports
  `nm_memory_layer.PromptMemory` (MEMORY.md/USER.md, 3,575-char combined budget,
  add/replace/remove, `Rejected:`-not-`Error:` denials, edits take effect next
  session). Stack: Express + Node 24 built-in `node:sqlite` (FTS5
  verified built-in, zero native deps) + `fetch` against the OpenAI-compatible
  endpoint with the langgraph-demo retry/rate-limit policy ported verbatim.
  Tools: `ls/read_file/write_file/edit_file/glob/grep`, `execute` (30s timeout,
  nonzero exits are model-facing info, not fatal — Python parity),
  `web_to_markdown` (Jina Reader), `internet_search`, `memory_manage`,
  `session_search`.
- **Session store with provider-valid round-trips.** `src/store.ts`: turn-rows
  in plain SQLite (WAL), assistant `tool_calls` + `tool_call_id` + **tool_name**
  persisted so resumed histories never carry dangling tool results; search =
  FTS5 strict AND → OR → LIKE-words fallback (newest-first), the same chain as
  nm-memory-layer. First-pass bug caught in tests + live: external-content
  FTS5's snippet column index (0, not 1) threw on every search and fell through
  to a whole-string LIKE — now pinned by `contracts.test.ts`.
- **Web UI (Chat tab only).** Chat-only adaptation of langgraph-demo's React
  frontend (Vite + plugin-react; Tailwind dropped after confirming no actual
  usage in styles.css): Sidebar session buckets, streaming Feed with tool rows
  and collapsible tool results, Composer, `cancelTurn`. Wiki tab, Skills/MCP
  settings, followups, vela-chart renderer all pushed to later increments.
  Backend grew real mid-turn cancel: `AgentLoop.runTurn` takes `shouldStop`
  (checked between LLM calls and between tool executions); on cancel the server
  persists only the provider-valid prefix (ported `_valid_prefix_len`) and
  emits a `cancelled` SSE event.
- **internet_search → Tavily.** Jina's `s.jina.ai` search broke on the
  existing key; search moved to `POST api.tavily.com/search` (Bearer
  `TAVILY_API_KEY`, topics general/news/finance, results annotated with
  relevance score + published_date, same output format + `Error:` failure
  semantics). `web_to_markdown` stays on Jina Reader (keyless-optional, still
  working).
- **LangSmith tracing without the SDK.** `src/tracing.ts` implements the REST
  runs flow (POST `/runs` + PATCH `/runs/{id}`, `x-api-key`): per turn a
  `agent-turn` chain root, `llm:1..n` children (inputs = rendered messages,
  outputs = generations incl. token usage), one `tool` child per executed call
  (args → result, `error` set exactly on `Error:`-prefixed outcomes). Fire is
  non-blocking with a 5s timeout — tracing failing can never break a turn.
  Verified live: zero client-side errors and the project's
  `last_run_start_time` updated to the traced minute (runs-query endpoints are
  405-restricted on this API-key plane; the UI is the reader).
- **Workspace discipline (option C: convention → mechanism).** After rescuing
  the python-repo practice from its "gitignore archaeology" failure mode:
  `WORKSPACE_DIR` (default `./workspace`, gitignored, auto-created) is what
  relative fs-tool paths and `execute`'s cwd resolve against — artifacts land
  in one place by construction, `ls` echoes its absolute dir as evidence.
  `guardWorkspaceWrite` rejects writes into harness internals (`src/`,
  `frontend/src`, `.env`, package files) with recoverable `Rejected:` denials
  (`allow_outside=true` to override; hard-jail env for future
  network-exposed servers). 13/13 tests; live pass: relative write + `pwd` in
  workspace, absolute `src/` write denied. First live verify exposed a stale
  pre-workspace server on 3001 serving old code — the EADDRINUSE-orphan class
  of failure; killed, re-verified clean (and removed the stray `sanity.md`
  from repo root).
- **Contract tests.** `npm test` pins the invariants that made nm-memory-layer
  trustworthy: combined budget enforcement + `Rejected:` convention, tool-call
  round-trip fidelity, search fallback chain, `Error:` fatality matrix,
  workspace resolution/guards.
