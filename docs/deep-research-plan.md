# Deep research mode (`/research`) — port plan from thinkdepth-ai

Status: Stages 1–4 done 2026-10-14 — the /research feature is complete.
Stage 1 live-verified (XOM run: 35 min, 261k tokens, 2,277-word report, 35
gap-free sources, full LangSmith tree + durable log); Stage 2 server-wired +
smoke-verified (prefix routing, SSE `research` events, cancel, `research_runs`
+ status endpoint); Stage 3 frontend (feed trail, progress strip, pause/
complete markers, composer hint); Stage 4 polish (session tags, reconnect
recovery, gated `deep_research` tool, README/docs). Owner: agent + user.
Studied source: `~/projects/thinkdepth-ai` (2026-10-14).
Last updated: 2026-10-14.

## Goal

Port the **research mode** of the thinkdepth-ai deep research agent (Python,
LangGraph multi-agent) into nm-finance-agent as a first-class mode invoked by
typing **`/research` before a query** in the chat composer. Keep the TypeScript
harness's doctrine: no LangGraph dependency — an explicit orchestrator, like
`agent.ts` flattened the demo's `StateGraph`. Research runs execute in the
background, stream progress over the existing SSE channel, and land the final
report in the session archive.

The thinkdepth-ai **basic mode** is NOT part of this port — nm-finance-agent
already has its own agent loop (`AgentLoop` + flat tool registry + SSE).

## What the source research mode is (verified by reading the code)

Pipeline (top graph, `src/research_agent_full.py`):

```
START → clarify_with_user ──(needs clarification)──► clarification_pause → END
              │                                      (state checkpointed; user reply
              │                                       re-enters at START; the prompt
              │                                       then skips re-asking)
              ▼ (no clarification)
        write_research_brief → write_draft_report → supervisor_subgraph → final_report_generation → END
```

- **`clarify_with_user`** (`research_agent_scope.py`): one LLM call over the
  flattened message buffer; raw-JSON output `{need_clarification, question,
  verification}` (code-fence stripping + fallback). If clarification is needed
  the graph pauses and ends; the session shows the question and waits.
- **`write_research_brief`**: JSON `{research_brief}` — the detailed, deduped,
  assumption-free statement of the research ask (same language as the user).
- **`write_draft_report`**: a compact **pre-research knowledge outline**
  (≤ ~1200 words, headings + bullets, `[UNVERIFIED]` tags, "Confidence and
  gaps", "Research priorities" 3–6 sub-questions, no citations). Writer-tier
  model, thinking off, `max_tokens=4000`. Seeds the supervisor with two
  messages: `"Here is the draft report: …"` + the research brief.
- **Supervisor loop** (`multi_agent_supervisor.py`): LLM with tools
  `ConductResearch`, `ResearchComplete`, `think_tool`, `refine_draft_report`
  ("diffusion" prompt: generate gap questions → research → refine draft → repeat).
  - Up to `max_researcher_iterations = 15`, max `3` parallel researchers per round.
  - `ConductResearch` calls launch **parallel researcher subgraphs** (asyncio.gather).
  - `refine_draft_report` is not a real tool: the node executes a writer-tier
    LLM call over (research_brief, findings-so-far, current draft).
  - Exits on `ResearchComplete`, no tool calls, iteration cap, or exception.
    `notes` = every ToolMessage content from the supervisor history.
- **Researcher sub-loop** (`research_agent.py`, one isolated context per topic):
  prompt budget: broad searches first, narrower later, stop at 3+ good sources
  or after ~5 searches. Tools: `tavily_search` (results + Exa/LLM page
  summaries) and `think_tool` (reflection echo). Routing: tool calls →
  `tool_node` (parallel via ThreadPoolExecutor) → back to LLM; otherwise →
  `compress_research`. Hard stop when the per-researcher token budget
  (`RESEARCH_TOKEN_BUDGET`, default 2,000,000) is exceeded.
  - `compress_research`: writer-tier LLM call, contract ≤1500 words,
    *every distinct fact/number/quote + source survives*; outputs
    `compressed_research` + `raw_notes`.
- **`final_report_generation`** (`research_agent_full.py`): writer-tier call
  over (`research_brief`, `notes` joined, `draft_report`, date). Contract:
  ≤3000 words excluding Sources; inline `[Title](URL)` citations; numbered
  `### Sources` list; paragraphs (not bullet dumps), insight/helpfulness
  rules; same language as the user.
- **Search tool** (`utils.py`): Tavily search (max_results 3, topic
  general/news/finance, raw content) → dedupe by URL → per-URL summary:
  Exa server-side structured summary (schema `{summary, key_excerpts}`,
  ~$0.001/page, cached per URL) → else LLM summarizer over raw content (capped
  at `MAX_CONTEXT_LENGTH=60000` chars) → else the Tavily snippet. Formatted as
  `--- SOURCE n: title --- URL / SUMMARY` blocks.
- **Server semantics** (`app.py`): `question.startswith("/research")` selects
  research mode; `_clean_question` strips the prefix; POST returns a
  `session_id` immediately and the graph runs in a background task; GET polls
  `status/current_step/final_report/error/clarification`; kill cancels the
  asyncio task; clarification replies continue with the same `session_id`
  (no prefix required). Session metadata + history in SQLite (`db.py`);
  LangGraph checkpoints in an `AsyncSqliteSaver` on the same file.
- Typical wall time per README: **10–30 minutes**. It was the #1 open-source
  agent on DeepResearch Bench (Nov 2025) — the prompts are the battle-tested
  asset of this port.

Studied files: `src/{prompts,utils,research_agent,research_agent_scope,
research_agent_full,multi_agent_supervisor,state_*}.py`, `app.py`,
`run_research.py`, `db.py`, `CLAUDE.md`, `README.md`.

## What exists here and what's missing

| Capability needed | nm-finance-agent today | Verdict |
|---|---|---|
| Explicit agent loop + tool execution | `agent.ts` `AgentLoop.runTurn` | reuse pattern, not code |
| SSE turn streaming + cancel | `POST /api/chat`, `ACTIVE_TURNS`, `/api/chat/cancel` | reuse, add events + branch |
| Chat client / retry / provider steering | `llm.ts` `chat()` | extend (signal, interval, repo roles) |
| Session archive + restore + FTS | `store.ts` `SQLiteSessionStore` | extend (research_runs table) |
| Tavily search | `tools/web.ts` `internet_search` (snippets only) | new research variant (raw content + summaries) |
| Page-summarization pipeline (Exa→LLM→snippet) | none | port new (research module) |
| Structured JSON LLM stages (clarify/brief/draft) | none | port new |
| Supervisor + parallel researcher loops | none | port new |
| Role-based model config | single main + summarizer model | extend config |
| Tracing of sub-loops | `tracing.ts` chain/llm/tool | reuse |
| Workspace artifact saving | fs tools + execute | reuse for report files |

There is no research-related code in `src/` yet (verified by grep), and no
`/research` handling anywhere — the prefix is entirely new surface.

## Architecture decisions

1. **LangGraph-free explicit orchestrator** in a new `src/research/` module.
   The graph topology becomes plain async functions with explicit state
   objects; each LLM stage is one `chat()` call. This mirrors `agent.ts`
   (StateGraph → explicit loop) and keeps the repo's zero-LangChain doctrine.
2. **Invocation = server-side `/research` prefix detection** in `POST
   /api/chat` (parity with `_detect_mode`/`_clean_question`). The frontend
   sends the message untouched; the server routes, strips, and persists the
   cleaned question. Only the first message of a turn is inspected; the
   prefix must be `/research` followed by whitespace or end-of-string
   (tighter than Python's bare `startswith`, which also catches `/researchx`
   — documented deviation). No other slash commands.
3. **Execution model: background run + SSE forward + status endpoint.**
   POST starts a run registered in an in-memory map (AbortController in
   `ACTIVE_TURNS` so the existing Stop button/`/api/chat/cancel` works
   unchanged) and streams `research` progress events over the open SSE
   response. The run is not tied to the HTTP connection (client disconnect
   doesn't cancel it — same as today's turns). `GET /api/research/:sessionId`
   exposes run status/step/report for reconnects. Heartbeat comment lines
   (`: ping`) every 20s keep proxies from idling out a 10–30 min stream.
4. **Persistence**: a new `research_runs` table (status, step, question,
   report, error, timestamps) + the user-visible assistant messages
   (clarification question, verification, final report) appended to the
   normal `turns` archive when they land, so session restore renders the run
   as a conversation. On boot, stale `running` rows become `interrupted`
   (no mid-run resume — parity: the Python service also loses the background
   task on restart; LangGraph checkpointer replay is *not* ported).
5. **Research-only tools** (`tavily_search` with raw content + summaries,
   `think_tool`) and supervisor pseudo-tools (`ConductResearch`,
   `ResearchComplete`, `refine_draft_report`) are bound **only inside the
   research loops** — they never enter the main agent's flat registry, so the
   loop contract ("never special-cases") is untouched.
6. **Single model, one client** (user decision, 2026-10-14: "keep it
   simple"). Every research LLM role — scope, supervisor, researchers,
   compress, refine, final report — uses the existing `chat()` client with
   `OPENROUTER_MODEL_MAIN` (z-ai/glm-5.3-flash) and the existing
   reasoning/provider settings. The upstream's per-role model split and
   three-slot GLM provider pool (`FailoverChatModel`) are deliberately NOT
   ported for now. The role separation stays in the code as a `roles` seam
   (all fields default to the main model), so switching later is a config
   change, not a refactor. The page-summary LLM fallback keeps the existing
   cheap `OPENROUTER_MODEL_SUMMARIZER` role (Exa is the primary path —
   see decision 7).
7. **Exa is the first-choice page summarizer**; `EXA_API_KEY` is present in
   `.env` (added 2026-10-14). Chain: Exa structured summary → cheap
   summarizer model over Tavily raw content (capped) → Tavily snippet, with
   the per-URL cache — same precedence as the Python original;
   `EXA_SUMMARIZER=off` forces the fallback.
8. **Prompt fidelity over inventiveness**: port `src/prompts.py` essentially
   verbatim (including the ≤3000-word / ≤1500-word / ≤1200-word contracts,
   citation rules, round discipline, parallel-agent scaling rules). One
   deliberate micro-fix: `compress_research_human_message` ships with an
   unfilled `{research_topic}` placeholder in Python — we format it with the
   actual topic.
9. **Cost/latency guards are first-class**, because a run is inherently
   expensive: concurrency cap (default 3), supervisor iteration cap (15,
   parity), a new researcher turn cap (default 8 — Python relied only on
   prompt budgets + token budget), per-researcher token budget, an optional
   wall-clock deadline, and a research-scoped override of the LLM
   min-interval guard (the 4s global spacing in `llm.ts` would serialize
   parallel researchers into a crawl).
10. **Deviations from Python (documented)**:
    - Researcher hard turn cap (above).
    - A completed research session **can** continue as normal chat (the
      report is ≤3000 words ≈ ~4k tokens; compression exists). Python locks
      research sessions after completion.
    - Mid-run resume after restart: not ported (see decision 4).
    - Status is exposed via a JSON endpoint + SSE instead of poll-only.

## Stage 0 — config & decisions (small, do first)

- `src/config.ts`: new exports —
  `RESEARCH_MODE_ENABLED` (kill switch, default `1`),
  `RESEARCH_MAX_CONCURRENT` (3), `RESEARCH_MAX_SUPERVISOR_ITERATIONS` (15),
  (no new model knobs — single `OPENROUTER_MODEL_MAIN` for all research
  roles per the confirmed decision; `OPENROUTER_MODEL_SUMMARIZER` remains
  the page-summary fallback)
  `RESEARCH_MAX_RESEARCHER_TURNS` (8), `RESEARCH_TOKEN_BUDGET` (2000000),
  `RESEARCH_SEARCH_MAX_RESULTS` (3), `RESEARCH_PAGE_CONTEXT_CHARS` (60000),
  `RESEARCH_LLM_MIN_INTERVAL_MS` (default 1200 — replaces the 4s guard for
  research calls), `RESEARCH_DEADLINE_MINUTES` (default 0 = off),
  `RESEARCH_SAVE_REPORTS` (default 1), `EXA_API_KEY` (optional).
- `.env.example`: document all of the above.
- Decisions confirmed by the user (see Open decisions at the end).

Acceptance: `npm run check` passes; health endpoint shows research config
availability (`tavily: hasKey`, models) without leaking keys.

## Stage 1 — research engine (headless, no HTTP)

New module `src/research/` (all new files):

| File | Contents | ~LOC |
|---|---|---|
| `prompts.ts` | port of `src/prompts.py` (10 prompts/messages) | 450 |
| `types.ts` | `ResearchRunState`, `ResearchStep`, `ResearchEvent`, stage result types | 80 |
| `json.ts` | `extractJson()` (raw → ```json fence → ``` fence → null) + `parseOr()` fallbacks | 40 |
| `tools.ts` | research tools: `tavily_search` (Tavily raw → dedupe → Exa/LLM/snippet summary → SOURCE blocks; per-URL cache), `think_tool`; Exa client + LLM summarizer fallback | 260 |
| `researcher.ts` | researcher sub-loop: tool loop → compress; token accounting; raw-notes extraction; parallel tool execution preserving call order | 150 |
| `supervisor.ts` | supervisor loop + tool-call dispatch (think echo / ConductResearch fan-out / refine writer call / ResearchComplete), notes accumulation, caps | 210 |
| `orchestrator.ts` | top-level run: clarify → (pause | brief → outline) → supervisor → final report; emits `research` events; persists stops as cancelled | 280 |
| `cli.ts` | `npm run research -- "question"` — headless runner (mirrors `run_research.py`), writes `workspace/research/<slug>.md` | 80 |

Implementation notes:

- The orchestrator is **dependency-injected** (`chatFn`, `searchFn`, `emit`)
  so the whole pipeline unit-tests offline with stub models — the same trick
  `run_memory_nudge(recent, memory, tools, mainModelChat)` already uses.
- Researcher tool execution: `Promise.all` over tool calls, results mapped
  back by index (Python `executor.map` order parity); retry once on timeout
  errors; unknown tool → `Rejected:`-style message (loop continues).
- Tracking: one `research-run` chain run with `llm:*`/`tool:*` children via
  `trace.create/update` (per-stage and per-LLM-call granularity; the
  supervisor/researchers appear as nested chains).
- `source` tag `nm-finance-agent` + `research` on all runs.
- SSE-independent: the CLI prints step lines; the same `emit` callback feeds
  SSE in Stage 2.

Acceptance:
- `npm run research -- "…"` completes end-to-end against live APIs and
  writes a report that satisfies the contracts: ≤3000 words excl. Sources,
  inline citations, numbered Sources section, same language as the question.
- Offline unit tests (see Testing) pass; `npm run check` clean.
- A run stops cleanly when the abort flag flips (mid-stage and mid-loop).

## Stage 2 — server integration — implemented 2026-10-14

Changes (all landed; live smoke on an isolated `:3099` instance verified
prefix routing, SSE `research` events, cancel → `cancelled` row, archive
persistence, and an untouched normal chat path):

- `src/index.ts`:
  - `detectResearchMode(message)` + `cleanResearchQuestion(message)` (pure,
    exported for tests).
  - In `POST /api/chat`: after the `session` event, branch —
    (a) explicit `/research` prefix, or (b) the session has a run in
    `awaiting_clarification` (continuation, no prefix needed). Otherwise the
    existing path is untouched.
  - Research branch: create/`resume` a `research_runs` row, register
    `turnId` → AbortController in `ACTIVE_TURNS` (the existing Stop button /
    `/api/chat/cancel` works unchanged), heartbeat comment every 20s,
    `research` events per stage, `message` events for produced messages as
    they land, and `done` (payload gains `mode: "research"` +
    `report_path`). Errors → existing `error` event; cancel → `cancelled`
    event + `cancelled` run status. Implementation note: the orchestrator
    streams directly inside the request (the planned queue+drain emitter was
    unnecessary for a single-user local app) — the run still survives client
    disconnects exactly like normal turns, and reconnect state comes from
    the status endpoint.
  - The stop path needs the orchestrator to check `shouldStop` between
    stages/tool calls and pass an `AbortSignal` into in-flight `chat()` calls
    (new `signal` opt) so a kill doesn't wait out a 5-minute writer call.
- `src/llm.ts` (small): `ChatOpts` gains `signal?: AbortSignal` and
  `minIntervalMs?: number` (research calls use the research interval; main
  loop unchanged); combine the caller signal with the timeout via
  `AbortSignal.any`.
- `src/store.ts`: `research_runs` table + `startResearchRun`,
  `updateResearchRun`, `getResearchRun`, `listStaleRunningRuns` /
  `markInterrupted`; called once at boot.
- `GET /api/research/:sessionId` → `{status, step, question, report, error,
  started_at, finished_at}` (404 when unknown; used on session restore).
- `/api/health` gains `research: {enabled, model, writer_model,
  tavily: hasKey, exa: hasKey, max_concurrent}`.
- Persistence of turns: append `[user(cleaned), ...assistantMessages]`
  (clarification question, verification, final report) via `appendTurn` when
  each lands; titler fires on the first turn; **skip** followups/nudge for
  research turns in v1.
- Optional but recommended (`RESEARCH_SAVE_REPORTS=1`): write the report to
  `workspace/research/<session-id-8>-<slug>.md` and include the path in the
  `done` event.

Acceptance (manual smoke):
- `curl -N POST /api/chat {"message": "/research How to acquire good-quality
  intra-day market data …"}` streams `research` step events and ends with a
  `message` (report) + `done{mode:"research"}`.
- Stop mid-run → `cancelled`, run row `cancelled`; restart server → stale row
  reads `interrupted`.
- Clarification flow: ambiguous question → assistant question + run
  `awaiting_clarification`; next message in that session (no prefix) resumes
  and completes.
- Non-prefixed messages behave exactly as before (`npm test` unchanged).

Verification log (2026-10-14): prefix routing + scope→brief→outline events
seen live; cancel → row `cancelled` (step preserved) + user/verification
persisted (endpoint-checked); normal message → plain turn (no `research`
events, `done` without `mode`). The restart sweep and clarification-resume
paths are covered by unit tests (`store: research_runs round-trip,
pause/resume, stale sweep`); the full clarify→resume→complete flow awaits
the Stage 3 UI or a deliberate live pass.

## Stage 3 — frontend — implemented 2026-10-14

- `frontend/src/App.tsx`: `research` SSE events render as (a) dim system
  rows (`research · <detail>`) building a progress trail in the feed and
  (b) a live **progress strip** above the composer with the current step,
  a pulsing dot, and an elapsed mm:ss clock (1s ticker while active).
- `done` end markers: `research complete ∙ <time>` (+ a `report saved ∙
  workspace/research/…` row when `report_path` is present), `research paused
  — answer the question above ∙ <time>` when the run paused on a
  clarification; research turns skip the followups refetch.
- `Composer.tsx`: placeholder hint `Message the agent… (/research for deep
  research)`.
- Session restore: nothing new needed — report/clarification are archived
  messages (`/api/sessions/:id`), and the strip is live-only.
- Deferred: a `research` tag in the session list (needs `GET /api/sessions`
  to carry mode) and reconnect-time strip recovery from
  `GET /api/research/:sessionId`.

Acceptance: in `npm run dev`, typing `/research …` shows live step rows +
the elapsed strip, the final report renders as Markdown with working links,
Stop cancels, and the history reloads the conversation after a page refresh.
`npm run build` (tsc + vite) is green; the visual click-through is the
user's pass.

## Stage 4 — polish & integrations — implemented 2026-10-14

- **Session-list research tag**: `GET /api/sessions` rows carry
  `research_status` (a `research_runs` LEFT JOIN in `listSessions`); the
  sidebar renders a `research` chip, accent-bordered while `running`.
- **Reconnect recovery**: opening a session whose run is non-terminal
  (`running` / `awaiting_clarification`) polls `GET /api/research/:sid`
  every 12s, shows the recovered state in the progress strip (last step +
  elapsed), and reloads the archived messages when the run completes — the
  report appears without a manual refresh.
- **`deep_research` as a main-agent tool**: gated by `RESEARCH_AS_TOOL`
  (default off — 20–40 min + real spend per call; `/research` stays the
  primary invocation). The tool takes `{question}`, forwards the turn's
  AbortSignal (Stop cancels the run), relays clarification pauses as a
  recoverable `Rejected:`, and returns the cited report (+ saved path).
  Plumbing: `ToolDef.execute(args, ctx?: ToolContext)` — the loop passes
  `{signal}`; every existing tool ignores the optional second parameter.
- **Niceties**: the completion marker shows the run's token spend
  (`research complete ∙ 12:42 ∙ 261.6k tokens`).
- **Docs**: README refreshed (including a full Deep-research section) after
  repairing a pre-existing mechanical corruption — the committed README had
  the literal string "No change" prepended to every character; a global strip
  restored it losslessly (the corrupted original stays in git history).
- Tests 76/76; live smoke on the isolated `:3099` instance: gated tool bound
  (14 tools), `research_status` joins correctly (`running` → `cancelled`),
  cancel + status endpoint verified.

## Runtime contract (freeze before coding)

SSE events (added to the existing vocabulary):

```
event: research
data: { status: "running",
        step: "scope" | "brief" | "outline" | "supervisor" | "researchers"
             | "refine" | "final_report",
        detail: "human-readable line",
        iteration?: number,
        researcher?: number, topic?: string }

event: message     (unchanged; used for clarification/verification/report)
event: done        { session_id, messages, usage, mode: "research" }
event: error       (unchanged)
event: cancelled   (unchanged)
: ping             (comment heartbeat, not an event)
```

Run statuses: `running` → `completed` | `failed` | `cancelled` |
`interrupted` | `awaiting_clarification` (which can resume to `running`).

## Prompt inventory (port verbatim)

| Python constant (prompts.py) | Stage | Model role |
|---|---|---|
| `clarify_with_user_instructions` | scope | tool-loop |
| `transform_messages_into_research_topic_human_msg_prompt` | brief | tool-loop |
| `draft_report_generation_prompt` | outline | writer |
| `lead_researcher_with_multiple_steps_diffusion_double_check_prompt` | supervisor | tool-loop |
| `research_agent_prompt` | researcher loop | tool-loop |
| `compress_research_system_prompt` + `compress_research_human_message` | compress | writer |
| `report_generation_with_draft_insight_prompt` | refine | writer |
| `final_report_generation_with_helpfulness_insightfulness_hit_citation_prompt` | final | writer |
| `summarize_webpage_prompt` | page summary (LLM fallback) | summarizer |

## Testing

Offline unit/contract tests (`src/tests/research.test.ts`, injected stubs —
the suite is the contract, `npm test`):

1. prefix: `/research q` → research; ` /research  q` (leading space) →
   research; `/researchx` and mid-text mentions → normal chat.
2. `extractJson`: raw, fenced, fenced+prose, invalid → fallback objects
   (clarify defaults to `need_clarification:false` with raw verification,
   same as Python).
3. prompt contracts: ported prompts still contain the hard limits
   (3000/1500/1200-word clauses, citation rules, "at most 3 parallel").
4. researcher: budget exceeded → forced compress; turns cap → forced
   compress; tool calls preserve order; unknown tool → recoverable message;
   raw notes include assistant+tool content only.
5. supervisor: `ResearchComplete` → end with notes; no tool calls → end;
   iteration cap → end; batch of ConductResearch → parallel (stub counts
   concurrent starts) and tool messages carry `compressed_research`;
   `refine_draft_report` → writer stub called with (brief, findings, draft).
6. orchestrator happy path with a scripted stub model → statuses/steps in
   order; clarification path → `awaiting_clarification`, supervisor never
   called; stop flag → `cancelled`.
7. store: `research_runs` round-trip; boot marks `running` → `interrupted`.
8. search tool: URL dedupe; Exa-absent → summarizer stub; no raw content →
   snippet; SOURCE block format.

Live smoke (manual, documented in HISTORY): the thinkdepth README's own
question, plus one finance question (e.g. an equity factor or data-vendor
comparison); verify citations resolve, no fabricated URLs (spot check),
sources section numbered without gaps, runtime and token budget logged.

## Risks & mitigations

- **Cost & rate limits** — a run is tens to low-hundreds of LLM calls plus
  10–30 Tavily searches. Mitigate: concurrency 3, iteration/turn caps, token
  budget, deadline knob, research min-interval, stop button; log per-run
  usage (already returned in `done`).
- **Single OpenRouter key + single model vs parallel researchers** — all
  researcher loops call the same `glm-5.3-flash`; the existing 4s
  min-interval would serialize everything, so research calls use a tighter
  research-scoped interval (`RESEARCH_LLM_MIN_INTERVAL_MS`) and rely on the
  existing 429 retry/backoff. Worst case: temporarily lower
  `RESEARCH_MAX_CONCURRENT` to 2/1, or split roles onto other models later
  (the `roles` seam is already in the code).
- **Long SSE streams through proxies** — heartbeat + client-side reconnect
  via `GET /api/research/:sessionId`; run continues if the client drops.
- **JSON discipline of chat models** — same manual parse + fallback as
  Python; strict-mode `response_format` deliberately NOT used (provider
  variance; parity).
- **Crash mid-run** — run row `interrupted`; no resume (documented parity).
  Partial findings are not persisted (parity; only the conversation
  messages and run row).
- **Prompt drift** — verbatim port + prompt contract tests; prompts are the
  crown jewel of the source project.
- **`safeJson` silently returning `{}` for malformed tool args** — research
  loops surface a `Rejected:`-style message; acceptable.
- **Report stays in session history** — bounded (≤3000 words) by contract;
  compression covers growth. If it annoys, follow-up chat can be dropped
  later (one-line change).

## Effort & sequencing

1. Stage 0 (config) + Stage 1 engine + tests + CLI — the bulk: ~1.5–2 days.
2. Stage 2 server wiring + store + smoke tests: ~1 day.
3. Stage 3 frontend: ~0.5 day.
4. Docs (`CLAUDE.md` tool/commands sections, `README.md` usage, `HISTORY.md`
   entry, `.env.example`), live smoke, polish: ~0.5 day.

Suggested commit slices: (1) research engine + prompts + tests + CLI;
(2) store + server + SSE; (3) frontend; (4) docs.

## Decisions (confirmed by the user, 2026-10-14)

1. **Models**: one `OPENROUTER_MODEL_MAIN` (z-ai/glm-5.3-flash) for every
   research role — tool loops and writer tier alike. No per-role model knobs
   and no multi-provider/multi-slot fan-out for now ("keep it simple").
   The parallel *researcher loops* remain — that is the agent design, not
   model infrastructure; all of them call the same single model.
2. **Exa**: `EXA_API_KEY` added to `.env` → Exa is the first-choice page
   summarizer (chain in decision 7 above).
3. **Post-completion follow-ups**: allowed — a completed report stays in the
   session and normal chat continues from it.
4. **Reports auto-save** to `workspace/research/*.md`
   (`RESEARCH_SAVE_REPORTS`, default on).
5. **Clarification continuation**: any next message in the session counts as
   the answer (Python parity; no `/research` prefix required).

## Non-goals

- The thinkdepth **basic mode** (already covered by this repo's loop).
- LangGraph / LangChain / AsyncSqliteSaver / FailoverChatModel multi-slot
  providers / `nest_asyncio` / FastAPI / Exa search (rejected upstream).
- A dedicated "Research" monitor tab (feed-streamed progress suffices);
  a `deep_research` tool for the main agent (possible later, trivial once
  the engine exists); mid-run resume/replay; scheduling.
