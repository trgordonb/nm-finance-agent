# HISTORY.md — nm-finance-agent

Track of significant changes. Dates are implementation dates.
The general build order (and the substrate discussion behind it) lives in the
conversation history of the nm-memory-layer comparison; this file tracks the
repo itself.

## 2026-10-10 — MCP port (config, binding, UI) + titler + streaming fixes

- **MCP ported from langgraph-demo** (mcp_config.py + server.py endpoints +
  McpTab UI): `mcp_servers.json` (git-tracked, `${VAR}` interpolation
  fail-closed, atomic toggle rewrites, `keep_tools` exact/suffix filter),
  per-server binding via `@modelcontextprotocol/sdk` (stdio verified live on
  agent-blog `agentdb` npm + `agent-browser` Rust CLI + luxalgo npx; the
  agentdb alpha wrapper's sync/await bugs avoided — SDK client calls are
  awaited), tools namespaced `<server>_<tool>`. One bad server warns+skips.
  Runtime assembly is lazy with a lock (python parity), re-runnable via
  POST /api/mcp/reload (409 while turns stream; in-flight turns keep their
  registry). Verified live: 3 servers → 56 MCP tools (29+13+14, keep_tools
  exact) + 11 base = 67 bound; luxalgo_trackers_ticker used by the agent in a
  real turn; disable→reload (67→42) →re-enable→reload (back to 56).
  Frontend: McpTab (python parity listing/toggles/reload) + settings-tab +
  sidebar gear icon. `finance_toolkit` streamable_http entry carried over
  (dormant), transport implemented.

- **Skills Phase 3: SkillsTab UI** (python SkillsTab parity, adapted:
  relDir badge; skills_backend sync line — s3 mode shows the registry URL +
  last pull/push counts, sync failures render error-styled). Settings view
  now hosts Skills | MCP sub-tabs (sidebar gear lands on Skills). REST
  toggles verified live (disable -> enabled:false -> re-enable). One
  behavioral deviation, intentional: our skills index re-renders per turn
  so toggles apply from the agent's NEXT TURN — python's index was baked
  once per session.

- **Skills Phase 4: nudge curation + CAS conflict UX** (closes the
  approved four-phase skills plan). The nudge loop itself is now TS:
  `src/nudge.ts` (NudgePolicy prompt/flatten/run port with the
  silence-bias + skills-vs-facts split; memory_manage AND skill_manage
  bound — the Gate-1 escalation shape, now native) wired post-turn with
  the `nudge` SSE event (python event vocabulary); interval NUDGE
  _INTERVAL default 5. Push-boundary conflict UX:
  `SkillsCliBridge.lastPushFailure` consults surface in skill_manage
  results (Rejected-grade advisory on the working-copy vs bucket
  divergence before further edits; pushes re-attempt at the next
  curation op). Live: NUDGE_INTERVAL=2 fired the nudge on the second
  turn of one session without blocking `done`. Tests: 43.

## 2026-10-11 — vela-charts inline rendering (project detour)

- **Yahoo proxy** (server.py parity): GET /api/yahoo/* CORS bridge in the
  Express app — 60s TTL cache (YAHOO_PROXY_TTL), query2 fallback,
  statuses pass through verbatim (429s included), plain Mozilla/5.0 UA
  only (verified: full Chrome UA strings from non-browser clients trip
  Yahoo's 429 fingerprinting). Cache verified live (miss → hit on repeat).
- **Charts module ported** (frontend/src/charts/): yahoo.ts (fetch/normalize,
  adjclose-folding + intraday caps clamp), VelaChart.tsx (imperative
  mount; lazy @luxalgo/vela import — no AGPL vela-pinets), ChartCard.tsx
  (picker, expand-to-fullscreen, StrictMode-safe destroy), plus Feed.tsx
  wiring: ```vela-chart fenced blocks in assistant messages render as live
  cards; blocks in user bodies render too. CSS carried over from the
  styles.css verbatim (chart-card + indicator pop grid).
- **Skill assets**: skills/vela-charts/scripts + references copied from
  the langgraph-demo working copy (they were absent from the R2 pull).
  Vendor step for the OFFLINE html path: copy
  frontend/node_modules/@luxalgo/vela/dist/vela.global.min.js →
  workspace/charts/vendor/ (script-tag gotcha: class is window.Vela.
  Vela — the ESM import used by React is unaffected).
- Verified: proxy 200 + cache-hit on repeat, frontend build passes,
  live turn emits the exact fenced block the renderer consumes.

## 2026-10-11 — Phase 5: context compression w/ persisted lineage

- **Ported from nm_memory_layer/compression.py** (src/compression.ts):
  pre-flight usage check (provider-reported prompt_tokens of the last
  assistant message — now PERSISTED in the turns table; chars/4
  estimate as fallback — live debugging exposed the divergence: the
  provider processes ~57-60k tokens incl. the 56-tool schema block
  while the content-only estimate sees ~1.2k), throttle via
  COMPRESSION_TOKEN_THRESHOLD (default 24000), middle turns summarized
  into one <conversation_summary turn="N-M"> system message; first +
  KEEP_RECENT_TURNS(2) verbatim; idempotent on resume; hard
  never-raise / original history untouched on model errors and empty
  or pseudo-tool outputs.
- **Lineage persisted in the archive** (`compressions` table:
  summary + turn range + model + count; listCompressions for trace),
  and the SSE `compression` event surfaces the op to the UI
  (python event vocabulary).
- **Live evidence** (threshold lowered to 15k to force early firing):
  skipped at 3 turns (structure gate logs cleanly), then on turn 5's
  pre-flight: 16 → 13 messages, turns 2-2 summarized, 274-char
  summary stored w/ model label `openrouter/z-ai/glm-5.3-flash`.
- Usage metadata on assistant messages: live-per-turn only, not
  persisted BEFORE this fix (resume falls back to estimate, python
  parity). NOT stored in tool_call JSON — separate column, nullable.
  Tests: 46.

## 2026-10-10 — streaming fixes, recovery semantics, OpenRouter cutover, hybrid recall

- **Incremental SSE streaming.** The chat endpoint was buffering everything
  until the turn finished; the UI saw the full tool sequence in one burst at
  `done`. `AgentLoop.runTurn` gained an `onMessage` callback fired the moment
  each assistant/tool message lands in the slice; the REST layer emits
  `message` events incrementally (timestamps verified: tool events spread
  across a 30s turn). LangGraph `astream(values)` parity.
- **Recovery semantics refined after a live failure.** A research session was
  cut short by `edit_file`'s `Error: '...' not found in file` — a wrong-args
  denial wrongly classified as fatal. Contract sharpened: `Error:` = world
  broke (system, I/O, timeout); `Rejected:` = model's args were wrong
  (edit_file not-found, missing file/dir via ENOENT, budget denials,
  workspace guard). `edit_file` gained exact → trimmed → whitespace-flexible
  matching (indentation drift was the top rejection class — the failing
  snippet had drifted indentation). Live cycle verified: Rejected → model
  self-corrects → succeeds → turn completes.
- **OpenRouter for all models.** Config layer moved to `OPENROUTER_*`:
  `OPENROUTER_API_KEY`, `OPENROUTER_MODEL_MAIN` (z-ai/glm-5.3-flash),
  `OPENROUTER_MODEL_SUMMARIZER` (liquid/lfm-2.5-2.6b:free, for the upcoming
  nudge/summarizer increments), and `OPENROUTER_MAIN_MODEL_PROVIDER`
  steering (`provider.order = [relace, open-inference/fp4, novita/fp8]` +
  `allow_fallbacks`) + the `reasoning: {enabled}` block, both from the user's
  example call and env-togglable (`OPENROUTER_PROVIDER_FALLBACKS=0`,
  `OPENROUTER_REASONING=0`). `/api/health` exposes the live knobs so env
  propagation is observable, not assumed.
- **web_to_markdown double-leg fallback.** Jina account balance ran dry
  (`InsufficientBalanceError`, HTTP 402 on every Reader call): Jina-side
  failures now fall back per-URL to **Tavily Extract** (same working key as
  search), with honest two-leg failure notes (`jina HTTP 402; tavily: ...`).
  Verified on the exact failing URLs (FVG substack + secuora) via tool call
  and full chat turn.
- **Session titler (python maybe_title_session parity) + a persistence-gate
  bug caught in verification.** Sidebar one-liners now exist: sync fallback
  (truncated first user message) stored on the first completed turn, then an
  async refine via the summarizer model (`liquid/lfm-2.5-2.6b:free`,
  model-labeled, once-only). `session_titles` table lives in the archive;
  `listSessions()` LEFT-JOINs it as `summary`; sidebar tooltip + inline
  truncated title added. Verification exposed that **plain no-tool turns were
  never archived** — the persist gate had copied python's `valid >= 2`
  (which counted the human message inside its slice) while our slice excludes
  the user row; gate now `>= 1`. Titles verified live: fallback within 1s,
  refine overwrite ~8s, second-chat regeneration blocked.
- **Titler displayed nothing in the UI** (post-verification debugging): the
  backend refined titles correctly but the frontend never re-fetched — the
  chat-only App port had dropped python's timed refetch that exists precisely
  for the async refine landing *after* the turn-complete event. Restored as
  two hops (5s + 12s; free-tier models can exceed 5s). Also: free-tier
  summarizer intermittently returns HTTP 200 with an EMPTY body
  (`session titler failed: empty title response` in the WARN log, fallback
  title silently surviving) — `refineSessionTitle` now retries once after
  2s; both noRecovery strings verified live ("Robust Title Verification
  Completed" within the refetch window). Docs + UI title span styling in the
  sidebar.


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
