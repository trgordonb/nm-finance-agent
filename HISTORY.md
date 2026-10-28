# HISTORY.md — nm-finance-agent

Track of significant changes. Dates are implementation dates.
The general build order (and the substrate discussion behind it) lives in the
conversation history of the nm-memory-layer comparison; this file tracks the
repo itself.

---

## Summary of record (2026-10-11) — what this repo now is

Twenty-two commits from empty (2026-10-09 → 10-11). The TS repo now carries
the whole Hermes-order memory stack from the python trio (langgraph-demo +
nm-memory-layer + nm-skills-registry), plus the detours. Headlines:

- **Loop + memory**: explicit AgentLoop (LangGraph-free), incremental SSE
  (onMessage), provider-valid persistence: every completed turn incl. single
  replies, tool fidelity, `usage` metadata persisted per assistant row.
- **Recovery doctrine**: `Error:` fatal vs `Rejected:` recoverable —
  installed across every failure class found live (unknown tool names,
  wrong edit strings w/ whitespace-flexible matching, ENOENT paths w/
  skills-root redirect, execute timeouts w/ nohup recipe, budget, workspace
  guard). Lots of "Error:-would-have-ended-the-turn" lives were saved.
- **Pods of memory**: prompt memory (3575 budget), titler (fallback+refine),
  followups (prefilter+cheap LLM+strip/badges), nudge (interval tool loop,
  memory_manage+skill_manage), compression (provider-usage threshold,
  verbatim anchors, persisted lineage).
- **Hybrid recall**: SQLiteSessionStore (FTS5 chain) + agentdb mirror sidecar
  (ruvector redb + onnx MiniLM; natives isolated in one sidecar — the
  fork/ENOMEM class), RRF k=60, retriever tags. Archive stays authoritative.
- **MCP**: mcp_servers.json port (interpolation fail-closed, atomic toggles,
  keep_tools), SDK binding (3 servers live, reloadable), McpTab + settings.
- **Skills**: 4-phase port per the approved C-strategy (TS core + nm-skills
  CLI R2 lifecycle, live bucket verification incl. an agent patch byte-identical
  on the bucket side), SkillsTab UI, frontmatter robustness fixes (js-yaml,
  trailing-space fences), conflict UX via push-failure advisories.
- **Surfacing**: titler + followups UI corrections (refetch-on-load,
  badge/strip sync), streaming-order fix, UI failure styling for in-band
  errors, vela-charts inline cards + Yahoo proxy (UA rule), skills-backend
  sync line, settings sub-tabs.
- **Hygiene**: orphan probe db removed + gitignored; env inventory reconciled
  both ways into .env.example.

Known deferred: full RVF/AgenticDB substrate sweep (agentdb alpha churn),
offline HTML vendor step, drift doctor in UI, search condensation polish.

## 2026-10-27 — EC2 deployment runbook for coding agents

Added `docs/ec2-deployment-runbook.md`, the current on-host/EC2 contract for a
new deployment. It treats the coding agent as the operator and covers:

- AL2023 + Node 24, EBS/data-volume layout, IAM/SSM, Security Groups, Caddy +
  Cloudflare Tunnel (recommended) or public Caddy TLS, and loopback-only app
  ports.
- The current environment contract: SSO BFF, per-user OpenRouter keys, R2
  skills, AgentDB mirror, cron, and the P3 `llmwiki` private/shared Wiki tab.
- `llmwiki` P3 assertion setup (`WIKI_ASSERTION_SECRET`, no admin token),
  common-write grants, source quotas, and the private/shared UI.
- Task IDs, acceptance checks, STOP conditions, secret-handling rules,
  migration/permissions, systemd hardening, backups/restore, monitoring,
  update/rollback, troubleshooting, and a handover report template.
- The current reference host values (SSO endpoint/fingerprint, R2 bucket,
  `llmwiki` URL) with explicit "verify, do not copy secrets" wording.

`docs/vm-deployment-runbook.md` is now marked historical for the original
2026-10-23 VM; `README.md` and `CLAUDE.md` point at the new canonical runbook.

## 2026-10-27 — llmwiki P3: Wiki-tab private/shared switch

- **`WikiTab`** now has a separate **My wiki** / **Shared wiki** switch and a
  domain filter. It defaults to the signed-in user's private wiki; the common
  wiki is an explicit click, not an implicit read. The empty private state
  links to the shared wiki.
- **`api.ts`** (`getWikiDomains`, `getWikiConcepts`, `getWikiPage`,
  `searchWiki`) takes a `WikiScope` and sends `scope` on every call. Wiki
  requests use a separate fetch path that does **not** run the app-session
  401 handler, so a missing/expired llmwiki assertion shows a tab error
  instead of logging the user out.
- **`WikiGraph`** receives the scope and reads page bodies from it, so a graph
  never mixes private and common pages. The "Ask the agent" handoff names the
  scope and tells the skill to use `--common` for shared pages.
- **`types.ts`** adds `WikiScope`; **`styles.css`** styles the switch.
- The proxy's legacy default remains `scope=common` for callers that omit it;
  the UI always sends a scope. No admin token is introduced into the agent.
- Tests: `tsc --noEmit` clean, 190 tests pass, and `npm run build` (Vite)
  succeeds. The live llmwiki P3 image/Worker are recorded in the service
  repo's `HISTORY.md`; the Wiki tab's private default uses the P2 assertion
  path and the service's P3 `scope` handling.

## 2026-10-26 — llmwiki P2: per-user wiki assertions + scoped skill

- **`src/wiki-auth.ts`** mints a short-lived HS256 assertion per request /
  `execute` command (`iss=nm-finance-agent`, `aud=llmwiki`, `sub`, `username`,
  `iat`, `exp`, `jti`; secret `WIKI_ASSERTION_SECRET`, default TTL 600 s). It
  reads the secret at call time so tests/local rotation do not need a re-import.
- **`execute`** injects `LLMWIKI_URL`, `LLMWIKI_ASSERTION` and
  `LLMWIKI_SCOPE=private`, and strips `WIKI_API_TOKEN` / `INGEST_API_TOKEN` /
  `LLMWIKI_TOKEN` from the child env. The model can still read `.env`; this is
  the trusted-user boundary documented in the llm-wiki plan (per-user agent
  containers are the escalation).
- **`/api/wiki/*`** mints the assertion for the signed-in user and now forwards
  the `scope` query key. The existing Wiki tab stays on `scope=common` until the
  P3 selector; the skill is where private reads happen in P2.
- **`skills/llm-wiki`**: helper supports `init` (`POST /users/me/wiki`),
  `whoami`, `--private`/`--common`/`--scope=`, and refuses to fall back to the
  static admin token on a remote URL. `SKILL.md` documents the two wikis,
  default-private captures, explicit common reads, and the init workflow.
- **`.env.example`**: `WIKI_ASSERTION_SECRET`, `WIKI_ASSERTION_TTL_SECONDS`;
  `WIKI_API_TOKEN` is marked legacy/local-only.
- Tests: `src/tests/wiki-auth.test.ts` (claims, signature, tamper, disabled),
  plus the proxy `scope` case; `tsc --noEmit` clean and 190 tests pass.
  Cross-language check verified a Node-minted assertion against the Python
  verifier.

## 2026-10-18 — mirror sidecar: HNSW preallocation bounded (`AGENTDB_MAX_ELEMENTS`)

- **Re-measure of the 2026-10-10 memory note.** The old comment figures
  (onnx arena ~40GB VA / ruvector ~12GB guards) were mis-attributed: the
  driver is the ruvector JS wrapper's default `hnswConfig`,
  `maxElements=10_000_000` → one ~35GB anonymous VA reservation at
  `new VectorDB` (≈3.6GB per 1M vectors at dims=384); onnx MiniLM adds only
  ~1GB. VmRSS stays <0.5GB throughout (reservations, not commits). The
  fork/ENOMEM claim reproduced: with the 10M default, spawn/fork from the
  loaded process fails ENOMEM; with 100k it succeeds.
- **Fix**: `mirror-child.ts` passes an explicit `hnswConfig` (m:32 /
  efConstruction:200 / efSearch:100) with `maxElements` from the new
  `AGENTDB_MAX_ELEMENTS` (default 100000). The native index auto-grows past
  the hint (verified 10→40 inserts), so this is a VA/commit trade, not a
  hard cap. Sidecar after-init VA 54.8GB → 20.8GB (rest: tsx/.ts + node +
  onnx); the override to 1M scales it to ~23GB.
- Comment figures corrected across `agentdb-mirror.ts` / `mirror-child.ts` /
  `CLAUDE.md`; knob recorded in `.env.example`. Tests: 89 pass.

## 2026-10-18 — container mirror scaffold (Cloudflare Containers)

- **`container/` scaffold**: `server.mjs` (HTTP twin of mirror-child.ts — same
  engine, `/health` `/status` `/stats` `/init` `/upsert` `/query`),
  `worker.ts` (Worker + Durable Object: on-demand start, 15-min keep-warm
  window, snapshot debounce into DO SQLite, image-mismatch fallback),
  `wrangler.jsonc` (durable_object scheduling policy + named image,
  build_context = repo root), `Dockerfile` (node:24-slim, lockfile deps,
  CUDA/TensorRT pruned, model baked), `README.md` (deploy/ops/persistence),
  `rebuild.mjs` (replay sessions.db when a fresh instance comes up empty),
  `pack-model.sh`, Docker build-context hygiene.
- **Client**: `AgentDbMirror` gains a remote transport — `AGENTDB_REMOTE_URL`
  (+`_TOKEN`) switches the same class to HTTPS; the boot probe is `/status`
  only (never wakes the container), same degrade/no-throw contract, archive
  stays authoritative. Unset = local sidecar path unchanged.
- **Deploy hardening after the first live attempt**: image pruning + npm
  cache cleanup in a SINGLE `npm ci` layer (deletions in a later layer still
  upload — CUDA .so + all-platform ORT binaries were being shipped; ~1.1GB
  tree → 139MB install layer; image 443MB incl. the 230MB base; build+smoke
  verified in a local run), with `sharp` kept after catching agentdb's silent
  **mock-embedding** fallback — now gated by a semantic sanity probe at boot
  (server refuses readiness) and the DO fails fast on health errors. SIGTERM
  closes keep-alive sockets.
- **Deployed 2026-10-18** (workers.dev route, paid account; image upload
  2m13s). Live external smoke passed: `/status` answers without waking the
  container; first cold start 46s (includes the first-ever edge image pull);
  semantic canary matched the local baseline exactly (0.548); the disk
  snapshot was stored ~5s after the upsert settled (id in DO storage); warm
  queries 45ms. Sleep/wake verified live: idle stop confirmed, then a wake
  from snapshot took **3.1s** (cold start #2 — the 46s first start was the
  one-time edge image pull) with `stored`=1 restored and the semantic canary
  identical (0.548). Also confirmed: a `/status` probe counts as DO activity
  and resets the inactivity timer.

## 2026-10-14 — deep research (/research) Stage 1: engine + CLI (thinkdepth-ai port)

Plan + decisions: docs/deep-research-plan.md. LangGraph-free explicit port of
the thinkdepth-ai Python/LangGraph research mode.

- **Engine** (`src/research/`): 10 prompts ported near-verbatim; researcher
  sub-loop (parallel tool fan-out, order-preserving, token-budget → lossless
  compress); supervisor loop (parallel ConductResearch fan-out, inline
  refine_draft_report writer call, ResearchComplete/iteration caps,
  tool-message notes); orchestrator (clarify → brief → pre-research outline →
  supervisor → final report) with clarification pause/cancel/deadline.
- **Tools**: research-only tavily_search (raw content → URL dedupe → Exa
  structured summary → cheap-LLM fallback → snippet, per-URL cache) +
  think_tool; bound only inside researcher loops.
- **CLI**: `npm run research -- "question" [--out f] [--quiet]`; report
  auto-save (RESEARCH_SAVE_REPORTS) to workspace/research/, durable per-run
  logs in workspace/research/logs/ (steps + outcome + stack + signal
  interrupts).
- **Config**: single z-ai/glm-5.3-flash for all research roles (roles seam
  kept); RESEARCH_* knobs; EXA_API_KEY first-choice summarizer; llm.ts gains
  signal/minIntervalMs/reasoningEffort opts.
- **Tracing**: root `deep-research` chain run + `llm:research:*` / `tool:*`
  children; LangSmith project switched default → nm-finance-agent.
- **Tests**: 17 offline contract tests (stubbed models; tracing muted).
- **Live**: first run (DAL) died at the final report — 5-min request timeout
  then empty content (reasoning-token exhaustion); fixed with final-report
  effort=low (FINAL_REPORT_THINKING parity), empty→retry, 32k/12k writer
  caps. Second run (XOM) completed: 35.2 min, 261k tokens, 2,277-word report,
  35 gap-free sources, full trace tree + log verified.
- **Stage 2 (server wiring)**: `POST /api/chat` routes `/research`
  (prefix-detected; a continuation after a clarification pause needs no
  prefix) to the engine; SSE gains `research` step events, `message` events
  for produced messages, and `done` payloads with `mode:"research"` +
  `report_path`; Stop/cancel aborts in-flight LLM calls via the AbortSignal;
  new `research_runs` table (status/step/question/clarification/report/error)
  with `GET /api/research/:sessionId` and a boot sweep marking stale
  `running` rows `interrupted`; report auto-save shares `reports.ts` with the
  CLI; health reports the research block. Live smoke on an isolated `:3099`
  instance: prefix routing + scope→brief→outline events, cancel → `cancelled`
  row (step preserved) + persisted user/verification rows, normal chat path
  untouched. Tests 75/75.
- **Stage 3 (frontend)**: `research` SSE events render as dim system rows
  (progress trail) + a live progress strip above the composer (current step,
  pulsing dot, elapsed mm:ss clock); `done` markers differentiate research
  complete/paused and surface `report_path` (workspace-relative); composer
  placeholder advertises `/research`; research turns skip followups polling.
  `npm run build` green. Deferred: session-list research tag, reconnect-time
  strip recovery.
- **Stage 4 (polish & integrations)**: session-list `research` tag
  (`research_status` via a research_runs join in listSessions + sidebar
  chip); reconnect recovery (an opened session with a non-terminal run polls
  `GET /api/research/:sid`, shows last-step + elapsed, and reloads the
  archive when the report lands); gated `deep_research` main-agent tool
  (`RESEARCH_AS_TOOL=1`, forwards the turn AbortSignal via the new
  `ToolDef.execute(args, ctx?)` seam); completion marker shows token spend;
  README repaired from a pre-existing "No change"-interleaved corruption
  (lossless strip; corrupted original in git history) + refreshed with a
  Deep-research section. Tests 76/76; smoke-verified tags (running →
  cancelled) and gated tool binding on an isolated :3099.
- **Trace payload enrichment** (follow-up to the SDK investigation — same
  wire protocol either way; the UI conventions were what we skipped): full
  message inputs, generations outputs carrying the assistant message,
  `usage_metadata` in both outputs and extra.metadata, plus
  `ls_provider`/`ls_model_name` for the token/cost panels; tool results
  uncapped; `trace.update` can now PATCH `extra.metadata`; helpers
  `usageMetadata`/`llmRunMetadata`/`llmRunOutputs` in tracing.ts. Payload
  verified stored through our own client (probe deleted). Tests 79/79.

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

- **Post-commit find: the SSE compression event was silently invisible**
  (user-reported 'no compression at turn 5' — the archive PROVED it had
  fired: lineage row `2-2, 73 messages → openrouter/z-ai/glm-5.3-flash`
  at 01:56:16Z w/ a dense arXiv-convert summary). Root cause: the chat-
  only App port had dropped the python `compression` handler — the event
  arrived but nothing rendered. Ported as python's dim system row:
  `context compression — turns N-M summarized by <model> (a → b msgs).
  Tests: 47 (lineage round-trip added).

## 2026-10-13 — Secondary-LLM search summarization (the last Hermes-order item)

- **Ported from nm_memory_layer/summarizer.py** (src/summarizer.ts):
  `SearchSummarizer` wraps ONE cheap OpenRouter call
  (OPENROUTER_MODEL_SUMMARIZER) over the fused hybrid-recall excerpts
  — python's Has-the-full-philanthropy (special-token strip +
  pseudo-tool-call guard) preserved; LangSmith'd
  (session-search-summarize chain + condense[...] llm child),
  model-labeled observational header
  `[session_search: condensed by <model> in <ms>ms from <n> raw excerpts]`.
- session_search executes: fuse both legs → condenser over ≥8 fused
  candidates → condensed text (python header parity, `[n]` refs kept) —
  silent fallback to raw fused list on failure / empty / none-relevant.
**Wiring bug found & fixed by live watch**: assembleRuntime called
`buildToolRegistry(store, mirror)` WITHOUT the summarizer — so the
runtime's setTools() silently DROPPED the summarizer after boot (the
tool ran raw); registry now carries the summarizer. Live verified:
the exact python-header condensation in a real turn (24264ms, 8
excerpts, 440 chars), stored into the archive; Tests: 49.

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

## 2026-10-15 — Reflexion Gate-1 complete: per-turn auto-store hooks

- User clarification verified against the pilot doc: python had
  reflexion_store per-turn (model-invoked under the Gate-1 teaching
  block; traces showed it under-fires — 14 sessions / 0 episodes
  triggered escalations A+B) and reflexion_retrieve programmatic
  pre-flight (escalation C). The TS port had B (nudge binding) and C
  (pre-flight recall) but no deterministic per-turn store.
- **src/reflexion.ts** — `maybeStoreReflexion`: after EVERY completed
  turn, ONE cheap model review of the flattened transcript; a
  lesson-worthy turn calls the bound agentdb_reflexion_store with
  parsed args (tool-call OR raw-JSON path); no-lesson turns never
  touch the store; fire-and-forget, never raises,
  AGENTDB_REFLEXION_AUTOSTORE=0 kill-switch; LangSmith tree
  (reflexion-autostore chain + review llm child + tool child).
- **Live**: an agent lesson (dukascopy venv/PEP668 install pitfall)
  produced episode #2 in workspace/agentdb-mcp.db via the auto-store
  within one turn; the recall pre-flight then serves it on matching
  turns. Nudge keeps prompt-memory curation; reflexion is per-turn.
- Tests: 84

## 2026-10-16 — Reflexion recall fix: context-enriched query + autostore parse

- **Diagnosis** (3-turn OpenAlex session): the pre-flight recall DID find the
  just-stored episode (top-1, reproduced to the digit against the live store)
  but scored it 0.205 — under the 0.35 gate. Root cause: the recall query was
  the raw user message, an anaphoric follow-up ("Now do the same to paper
  #5"); agentdb embeds `task + critique (+ output)` (verbatim self-query
  maxes at 0.733), so bare short queries sit far below the gate while
  irrelevant candidates stay ≤0.31. Not a store/retrieve bug.
- **Fix 1 — enriched recall query** (`buildRecallQuery` in
  src/agentdb-hooks.ts, wired through index.ts): previous user request
  (≤300 chars) + assistant-message tail (≤300) + current message; the recall
  cache still keys on the raw message. Measured live: bare 0.205 → enriched
  **0.593** (runner-up 0.306).
- **Fix 2 — autostore parse robustness** (src/reflexion.ts): the review call
  now binds the store tool (it was tools-less, so the provider tool-call path
  could never fire — turn 2 stored on a lucky JSON emission while turns 1+3
  emitted `<tool_call><arg_key>…` XML and were silently dropped);
  `parseEpisodeArgs` now also parses the textual `<arg_key>/<arg_value>`
  format; the prompt demands the tool interface.
- Tests 86 (buildRecallQuery composition/caps; XML parse; provider tool-call
  routing + store-tool binding assertion).

## 2026-10-16 — Followups extractor revival: reasoning-budget drift

- **Symptom**: every turn's `followups-extract` returned 0 items all day
  (last stored tips were Oct 13), with `output_tokens=512` on every
  `extract[llm]` call — content empty or cut mid-JSON.
- **Root cause** (replayed live against OpenRouter): the free summarizer
  model (liquid/lfm-2.5-2.6b:free) now spends 200-700 output tokens
  "thinking" before answering, and reasoning counts against `max_tokens`
  (512 → finish_reason=length, content "", reasoning_tokens 512/512;
  `noReasoning: true` only omits the request param — it can't stop the
  model). Model-side drift: Oct 15 was already marginal (2 of 5 failed).
- **Fix**: extraction cap 512 → 2048 (content needs ~100-200 tokens);
  `parseFollowups` also accepts object-format items (`{"action": …}` or
  first string value — observed 1-in-3 samples at temp 1.0); preventive
  bump on the search-condenser cap (1024 → 2048, same model/pattern).
  Live check: today's closing message that yielded 0 items now extracts 2
  through the real pipeline.
- Tests 86 (object/fenced-array parse cases).

## 2026-10-16 — execute: signal deaths are recoverable (pkill self-match)

- Live miss (session 121f1589 t3): the agent stopped its backgrounded
  backtest driver with `pkill -f shr_driver_holdout; sleep 1; cd … && grep …`
  — `pkill -f` matches full command lines, and execute runs the whole
  command as `bash -c "<cmd>"`, so the pattern sits in that shell's own
  argv: the shell was SIGTERM'd mid-command (the inspection tail never ran).
  Signal deaths carry `err.code = null, err.signal = SIGTERM`, which the
  old `!numericExit` check classified as fatal `Error:` — the turn aborted
  (first occurrence ever). The driver itself was stopped correctly.
- Fix: `err.signal` without a numeric exit → `Rejected:` with the bracket
  trick + pidfile recipe (+ partial output when present); `Error:` stays
  reserved for genuine spawn failures. The `execute` description teaches
  the safe stop recipe up front.
- Tests 87 (`kill -TERM $$` → Rejected + hint — a real signal death).

## 2026-10-16 — fs tools: required-arg denials + recoverable path errors

- Live miss (session 121f1589 t4): `edit_file` called with only old/new
  strings (no `file_path`) resolved a literal `workspace/undefined` path →
  ENOENT → fatal `Error:` → the turn aborted. The model had just tagged the
  edit into a long backtest thread and dropped one key.
- Fix (class-wide `requireArgs` guard on read_file / write_file / edit_file /
  glob / grep): missing/non-string/empty required args → `Rejected:` with the
  keys received plus a "did you mean 'path' instead of 'file_path'?" alias
  hint (camelCase variants included). Adjacent hazards closed: write_file can
  no longer silently create `workspace/undefined`, missing `content` is denied
  (explicit "" still allowed), edit_file ENOENT/EISDIR, read_file EISDIR and
  grep-on-missing-path are now `Rejected:` instead of fatal `Error:`.
- Tests 89 (missing-arg matrix incl. a no-'undefined'-file assertion;
  missing-file/directory recovery).

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

## 2026-10-19 — Deep research latency: reasoning-effort + retry amplification

Trace comparison (MSFT 2026-10-19, 108.4 min / 2.42M tokens vs the Python
thinkdepth-ai DAL run, 5.9 min / 188K tokens) showed the TS port had left GLM
at provider-default reasoning on every research role. 17 calls emitted >10K
output tokens; five compress calls hit the 300 s HTTP timeout and were retried
2-5 times (1,501 s = 5 x 300 s), and four `refine_draft_report` calls burned
~14K reasoning tokens and returned empty content, overwriting the draft.

- **P0**: all research roles now send `reasoning.effort=low`; outline capped at
  4K output; refine/compress retry once on empty and preserve the prior draft;
  `ChatOpts` gained per-call `timeoutMs`/`maxAttempts`/`retryOnTimeout`
  (research: 600 s, 2 attempts; writer-tier calls do not retry a timeout).
- **P1**: 15-min default wall-clock deadline wired as an `AbortSignal` (cancels
  in-flight calls, maps to `cancelled`); 2 ConductResearch rounds; 6 searches
  per researcher; 5 turns; 300K token budget; supervisor wrap-up notice at 70%
  of the deadline.
- **Provider hotfix (same day)**: the next META run researched nothing — the
  pinned Relace provider was returning HTTP 200 with degenerate text, so the
  brief/supervisor calls produced garbage with zero tool calls. Reproduced
  per-provider (Relace garbage at every reasoning effort; OpenInference/Novita
  valid). Order is now `open-inference/fp4,novita/fp8` plus
  `OPENROUTER_PROVIDER_IGNORE=relace`; added brief/outline JSON guards, a
  supervisor fallback researcher, a no-findings failure, an overlong-report
  retry, and provider/finish_reason trace metadata.
- **Live verification** (trace `eca45e89…`): 11.1 min / 160K tokens / 20 LLM
  calls / 17 searches / 3 researchers, all on OpenInference, no retries or
  empty content, 2,221-word report with 24 cited sources — versus 108.4 min /
  2.42M tokens before. Python reference: 5.9 min / 188K tokens.
- **P2 closed**: `runSupervisor` aggregates fallback/regular researcher usage
  into the run total (root used to report ~4x below the child sum); trace
  metadata records reasoning tokens (`output_token_details.reasoning`).
  Verified in the AMD trace `d39a0923…`: 9.3 min / 230K tokens / 1 round /
  16 searches, root usage exactly matching the 180,751 + 49,108 child sum.
- Plan + evidence: `docs/deep-research-latency-plan.md`. Offline tests 102/102.

## 2026-10-20 — Agent loop: empty assistant responses are retried, not dropped

Trace `e52383b1…` (session `ab90cb26…`, turn 2 "Please ingest #6 into wiki")
showed one LLM call with 43,261 prompt tokens, 752 output tokens (737
reasoning), **empty content and zero tool calls**. The loop treated "no tool
calls" as a final answer and persisted an empty assistant row, so the turn
silently disappeared.

- **Guard**: an empty assistant response now retries once at low effort with a
  "call a tool or answer" nudge; if the retry is also empty the turn ends with
  a visible `fatal` error instead of an empty message. Traced as
  `llm:N:empty-retry`.
- **Observability**: normal agent-turn LLM traces now record `provider` and
  `finish_reason` (plus reasoning tokens via `output_token_details`), so a
  future empty response is attributable to a provider.
- **Replay**: the exact 69-tool / 43K-token prompt returned
  `load_skill`/`execute` calls on replay, confirming the drop was a transient
  model response rather than a prompt/tool-overload failure.
- **Tests**: new `agent-loop.test.ts` (retry + fatal paths) and a
  self-contained execute-timeout fixture; suite 104/104.

## 2026-10-20 — Session-search summarizer hang + cancel propagation

Trace `967e52ae…` (session `ab90cb26…`, "Please ingest #6 into wiki") got as
far as an `execute` (9 ms) and then hung in `session_search` for 20+ minutes.
The `session-search-summarize` child was an open LLM run on
`liquid/lfm-2.5-2.6b:free`: the summarizer inherited the 300 s × 5 LLM
defaults, had no per-request timeout, and `session_search` dropped the turn
abort signal, so Stop could not cancel it.

- **Summarizer bound**: 20 s timeout, 2 attempts, `retryOnTimeout: false`;
  failures fall back to raw fused excerpts (enrichment must never hold a turn).
  New knobs `SEARCH_SUMMARIZER_TIMEOUT_MS` / `SEARCH_SUMMARIZER_MAX_ATTEMPTS`.
- **Cancel propagation**: `session_search.execute(args, ctx)` forwards
  `ctx.signal` to `SearchSummarizer.summarize(...)`; `execute` kills the
  foreground child on abort and returns `Rejected: cancelled by user`; an
  aborted in-flight agent LLM call now returns `cancelled` (not an error).
- **Tests**: signal forwarding + child-kill coverage; suite 105/105.
- **Action**: the stuck process predates this fix; restart the server to load
  it. The stuck turn ends with the restart.

## 2026-10-20 — Model config refresh

- **Summarizer**: `OPENROUTER_MODEL_SUMMARIZER` default is now
  `poolside/laguna-xs-2.1:free` (was `liquid/lfm-2.5-2.6b:free`, briefly
  `google/gemma-4-26b-a4b-it:free`). The free Gemma variant is served only by
  Google AI Studio, which rejects HK-located requests; Poolside is not
  location-blocked.
- **Main provider order**: `open-inference/fp4,deepinfra/fp4,novita/fp8`
  (plus `OPENROUTER_PROVIDER_IGNORE=relace`). Provider steering is now scoped
  to the main model only — the summarizer/cheap roles use default OpenRouter
  routing, since those providers do not necessarily serve the summarizer model.
- **Live checks**: main model served by OpenInference. The free Poolside
  variant is currently rate-limited upstream (429) in bursts, but the 20 s /
  2-attempt summarizer bound falls back to raw excerpts. The paid
  `poolside/laguna-xs-2.1` variant works reliably (1,359 reasoning + 23
  content tokens, ~$0.00017/call) if the free tier becomes noisy.
- Tests updated to the new model label; suite 106/106.

## 2026-10-20 — Live verification: LiveMACE wiki ingest

Trace `7956eed3…` (session `ab90cb26…`, "Please ingest #6 into wiki"):
3m11s, 7 LLM calls / 6 `execute` tools, all served by OpenInference. The agent
followed the `llm-wiki` skill exactly — health → domains → `ingest-url` →
`wait` → status retry → `wait` → search/concepts — and ingested LiveMACE
(`arxiv.org/abs/2610.09872`) as source
`53e3f761f6a0e8c3-livemace-process-aware-evaluation-of-llm` into the `llm`
domain: 7 chunks, 2 pages (`LiveMACEBench`, `Outcome-Capability Gap`), search
verification at 0.99. The first `wait` hit a transient worker 500
(`error code: 1101`); the agent retried `status` after 10 s and finished
normally. No empty responses, no hangs, no cancel needed. Post-turn followups
used the new summarizer and returned 2 items in 3.1 s.

- **Trace fidelity (2026-10-20)**: the pre-flight
  `agentdb_reflexion_retrieve` run recorded only `task.slice(0, 300)`, so
  LangSmith showed a mid-sentence cut even though the tool received the full
  recall query. The trace input now carries the exact `{task, k}` passed to the
  tool.

## 2026-10-20 — Wiki ingest turn: successful capture, failed verification

Trace `02b1a4be…` (session `c53c78b5…`, "Ingest #1 into wiki", BDH-CQ
arXiv:2608.09888): 6m30s, 19 LLM calls, 18 `execute` calls. The ingest itself
succeeded — source `16e54acc89ffba9e-bdh-cq-in-context-learning-with-recurren`
reached `state=done`, 8 chunks, page `bdh-cq` in domain `llm`. Verification then
went sideways:

- `llmwiki.sh page bdh-cq` 404'd because `/page` defaults to `general`; the
  page lives in `llm` and the domain argument was omitted.
- At 05:44 the remote Cloudflare service became unreachable (`curl` 000,
  `/healthz` 000). The agent ran `docker ps`, saw nothing, and concluded "no
  llmwiki container running" — but the service is on Cloudflare Containers,
  not local Docker. It ended with an incomplete "Testing again:" message.

Fixes: `skills/llm-wiki/SKILL.md` now states the Cloudflare/local split, says
not to inspect local Docker when `LLMWIKI_URL` is set, documents
`page <slug> <domain>`, and prescribes reporting the last known `status=done`
instead of chasing a remote outage. `WIKI_API_TOKEN` in `.env` was corrected to
the service's `INGEST_API_TOKEN` (the old 13-char value returned 401 from the
Worker). Verified live against the Worker: source `done`, `page/bdh-cq?domain=llm`
HTTP 200, search hit at 0.978. The local compose instance started during
diagnosis was stopped.

## 2026-10-20 — execute: non-fatal stderr no longer renders as a failed tool

Trace `af386450…` (session `2de29d4a…`, "Ingest #8 into wiki", Metis
arXiv:2607.26760) completed cleanly: 3m25s, 6 LLM calls, 5 `execute` + 1
`session_search`, source `8c71b7a…-metis-memory-foundation-model` reached
`state=done` with 7 chunks and 2 pages. But the UI marked the successful
`llmwiki wait` call as **failed** because the command writes compile progress
to stderr, and `execute` labelled every stderr block `Error output:` even on
exit 0.

`execute` now labels stderr as `Stderr (non-fatal):` when the exit code is 0,
and keeps `Error output:` for nonzero exits. The Feed heuristic
(`Feed.tsx`) stays keyed on `Error output:`/`Rejected:`/`Error:`/nonzero
`Exit code`, so successful progress logs render as success. Added a contract
test for both branches; suite 107/107.

---

## 2026-10-25 — Agent cron shipped (Phase 1+2+timezones): a scheduled NFLX run completed end-to-end

Per docs/agent-cron-plan.md: `cron_manage` (create/list/get/update/pause/
resume/remove/runs/run) as the agent's handle over per-user scheduled jobs;
`cron_jobs`/`cron_runs` tables; an in-process 30 s ticker with a
BEGIN IMMEDIATE claim (never double-fired, never re-fired while long); fires
execute as ordinary turns inside `runInWorkspace(owner)` plus a scheduled-run
ALS flag that hides `cron_manage` (loop prevention); per-job IANA timezones
(cron-parser `tz`, DST-safe naive-once conversion); "Scheduled" right-pane
view (job cards, run-now/pause/resume/edit/delete, expandable run histories)
with the job session tagged `scheduled` in the sidebar. Knobs: CRON_ENABLED,
CRON_TICK_MS, CRON_MAX_PARALLEL, CRON_CATCH_UP_MISSED,
CRON_FAILURE_PAUSE_STREAK, CRON_MISFIRE_GRACE_MIN, CRON_WRAPUP_REMAINING.

End-to-end validation (traces `84a7bc2e…` schedule, plus three fires):
- Schedule from chat: "run the NFLX flow at 22:00 HKT today" → one create call,
  NL normalized to a timezone-correct `once` instant, self-contained payload
  (skill auto-run, max_iterations 55), fire time confirmed in the same turn.
- Attempt 1 **failed at the 60-iteration cap** — found the per-job
  `max_iterations` never reached `runTurn` (fixed: `meta.maxIterations` +
  `meta.wrapupRemaining`, wider 10-iteration landing margin for unattended
  runs), and clicking "Open session" mid-run 404'd (fixed: fires register
  their session at fire start via `store.registerSession`; the sessions
  route returns an empty archive for a registered-but-empty session instead
  of 404).
- Attempt 2 killed by the owner's restart → boot reconcile marked it
  `interrupted` (audit-only) exactly as designed.
- Attempt 3 **completed**: 47/55 iterations, 15.5 min, graceful landing
  ("Everything is persisted"), resumed from attempt 1's `argusdesk_state.md`
  checkpoint, wrote `argusdesk_report.md`, and the `once` job auto-disabled
  itself. Verdict: nothing leads NFLX (fourth straight name).
- Caught by tests before shipping: bare-minute intervals didn't parse, claim
  exclusivity missed the `claimed` state, auto-pause dropped the explanatory
  error. Suite 187/187.

## 2026-10-25 — Chat SSE hardening + UI rework (deploy incident follow-up)

The browser showed `Error in input stream` during long turns (traces
`c3a5be8b…`, `b0c22d27…` — both succeeded server-side; the SSE reader died on
an idle cut). Per docs/todo-chat-sse-reliability.md: `/api/chat` now sends
15 s keepalive comments and aborts the turn on client disconnect (valid-prefix
persistence); the frontend SSE parser moved to `frontend/src/sse.ts` and
swallows stream errors after the terminal `done` event. UI rework in the same
deploy: right pane is Chat/Wiki/Scheduled, Skills|MCP|Model & key moved into a
settings modal from the sidebar gear, sidebar footer reordered (model+gear
above user+logout).

## 2026-10-25 — User-scoped OpenRouter keys Phase 1 + session gotchas

Per docs/user-scoped-openrouter-keys-plan.md (owner decisions §10: dedicated
`USER_LLM_KEY_SECRET`, warn-only `require_user` week, mid-session key deletion
allowed, harness-side usage ledger): `src/llm-keys.ts` stores per-user keys
encrypted (AES-256-GCM) under `state/users/<id>/llm.json`; `chat()` resolves
Authorization per call in the caller's ALS scope (user key → server key per
`LLM_KEY_POLICY`; cron fires bill their owner); routes
`POST/GET/DELETE /api/user/llm-key` validate via OpenRouter `GET /api/v1/key`
(no spend) and mask everywhere; every successful LLM call lands in the
per-user `llm_usage` ledger (`GET /api/user/llm-usage`); "Model & key" tab in
the settings modal. 8 tests; suite 187/187.

**Session gotchas worth remembering:**
- **skills/ direct edits are clobbered by the boot R2 pull** — push after
  editing: `uv run --directory ~/projects/nm-skills-registry nm-skills push
  <ABSOLUTE skills path>` (a relative path silently targets the registry's
  own mirror; `uv run --directory` changes cwd).
- `config.ts` loads `.env` with `dotenv.config({override: true})` — test env
  set before import is overridden by .env values; assert config-resolved
  values.
- The vibe_trading MCP stays inactive until `vibe-trading-mcp` is installed
  on the VM (uv, Python ≥3.11) and symlinked into `/usr/local/bin` (the unit
  pins PATH); its `list_skills`/`load_skill` doc tools are deliberately kept
  so agents can read the SignalEngine contract before writing backtest code.
- Kronos on CPU peaks at ~1.27 GiB RSS, ~640 MiB of which is importing the
  cu130 torch wheel — a CPU-only torch build would roughly halve it
  (docs/agent-cron-sse-ui… RESULTS addendum; memory re-run in
  mu-driver/run/kronos_memory.json).
- InstaBox remote mode (skills/instabox-sandbox) needs the CLI + key on the
  VM; exec transport gotchas (inline quoting, `&` stripping, binary stdout)
  are codified in that skill. Session-spawned sandboxes are now lifecycle-bound
  to the owning turn: created with `--meta nm-session=$NM_SESSION_ID`
  (shell tool exports it via ToolContext.sessionId), swept at turn end by
  `src/instabox.ts` (`ls --meta` → `rm`, best-effort, 5 tests). The stock-price-mover daily.sh scheduler is
  superseded by agent cron (auto-run mode + checkpoint file work as cron
  fires); daily.sh remains for external scheduling if wanted.

**What's left — user-scoped keys:** Phase 2 = OAuth PKCE key entry
(`POST /api/v1/auth/keys/code` + exchange; no copy-paste), credits widget
(`GET /api/v1/credits`), flip `require_user` enforcement after the warn-only
week (deadline lives in the VM env), per-model usage breakdown in the
Model & key tab. Phase 3 = provisioning-key minting (`POST /api/v1/keys`:
operator mints per-user derived keys with monthly credit limits), BYOK
multi-provider (`CreateBYOKKeyRequest`), per-user model preference.
**What's left — cron Phase 3:** live-stream in-flight fires, cancel running
fires (register in ACTIVE_TURNS), `context_from` chaining, per-job model
pins, `allow_scheduling` opt-in, cron doctor in /api/health.
