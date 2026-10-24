# CLAUDE.md — nm-finance-agent

Ground-up TypeScript agent harness (REST-only), rebuilt from the Python
LangGraph repo (`~/projects/langgraph-demo`) without the LangGraph dependency.
Financial research agent on OpenRouter. The memory substrate is deliberately
seamed so the future `ruvector-core::AgenticDB` swap lands behind
`SessionDriver` — the loop only knows `loadSession / recordTurn / search /
listSessions / recordCompression`; hybrid recall already runs as the mirror.

## Current status (2026-10-14)

Full Hermes-order memory stack ported and live:
loop+prompt memory+tools → titler → MCP → hybrid recall mirror → followups →
skills (4 phases, R2 live) → context compression. UI: Chat + settings
(Skills | MCP), streaming feed, to-do strip, badges, titler.
Deep research (`/research`): thinkdepth-ai port complete (stages 1–4) —
engine + CLI + server routing (prefix detection, research SSE events, cancel,
`research_runs` status endpoint) + frontend (feed trail, progress strip,
session tags, reconnect recovery) + gated `deep_research` tool
(`RESEARCH_AS_TOOL`) + LangSmith tracing + durable logs
(docs/deep-research-plan.md).

## Layout

```
nm-finance-agent/
├── src/
│   ├── index.ts          # Express server: /api/health, /api/sessions*, /api/memory,
│   │                     #   /api/mcp*, /api/skills*, followups, /api/yahoo/*,
│   │                     #   POST /api/chat (SSE incl. compression/nudge/research
│   │                     #   events; /research prefix → deep research turn),
│   │                     #   /api/research/:sessionId run status, /api/chat/cancel;
│   │                     #   runtime assembly (lazy+lock, reloadable)
│   ├── agent.ts          # AgentLoop: explicit agent↔tool cycle; onMessage streaming;
│   │                     #   per-turn LangSmith run tree; usage metadata attached to
│   │                     #   assistant messages (compression trigger fodder)
│   ├── llm.ts            # OpenRouter client (provider steering + reasoning block);
│   │                     #   ChatOpts {model, noReasoning, maxTokens}; retry/rate-limit
│   ├── memory.ts         # PromptMemory: MEMORY.md/USER.md, 3575-char shared budget
│   ├── store.ts          # SQLiteSessionStore (SessionDriver): turn rows incl. usage,
│   │                     #   FTS5 fallback chain, titles, followups, compressions
│   ├── hybrid + mirror   # driver.ts (SessionDriver seam) + agentdb-mirror.ts
│   │                     #   (sidecar client) + mirror-child.ts (sidecar: redb/
│   │                     #   ruvector VectorDB + onnx MiniLM — natives isolated from
│   │                     #   the server process: native VA = fork/ENOMEM class)
│   ├── compression.ts    # Phase-5 pre-flight compression (provider-reported usage
│   │                     #   persisted per assistant row; verbatim anchors; lineage)
│   ├── nudge.ts          # NudgePolicy + prompt + flattenTranscript + run (tool loop)
│   ├── titler.ts         # sync fallback + async refine (summarizer model, once)
│   ├── reflexion.ts      # per-turn reflexion auto-store: ONE cheap review
│   │                     #   of the flattened transcript post-turn; a
│   │                     #   lesson-worthy turn calls agentdb_reflexion_
│   │                     #   store (Gate-1, escalation-validated). Separate
│   │                     #   from the nudge (prompt memory) by design
│   ├── followups.ts      # regex prefilter → cheap LLM extraction → to-do strip
│   ├── skills/           # library.ts (SkillLibrary core over skills/ working copy;
│   │                     #   js-yaml frontmatter; toggles in SKILLS_STATE_DIR) +
│   │                     #   sync.ts (R2 lifecycle: uv→nm-skills CLI boot pull+push,
│   │                     #   debounced curation push; CLI `sync` bug fixed in
│   │                     #   registry v0.1.7 — boot still runs pull+push)
│   ├── mcp-config.ts     # mcp_servers.json loader: ${VAR} fail-closed interpolation,
│   │                     #   atomic toggles, keep_tools exact/suffix
│   ├── mcp-tools.ts      # per-server binding via @modelcontextprotocol/sdk
│   │                     #   (stdio/streamable_http/sse); one bad server skips
│   ├── tracing.ts        # LangSmith REST runs client (no SDK, fire-and-forget);
│   │                     #   SDK-parity payload helpers (full messages,
│   │                     #   usage_metadata, ls_provider/ls_model_name)
│   ├── workspace.ts      # workspace-rooted path resolution + harness write guard
│   ├── config.ts         # all env (dotenv override=true); logger.ts: stderr-only
│   ├── research/         # deep research engine (/research, stages 1–4):
│   │                     #   orchestrator (clarify→brief→outline→supervisor→
│   │                     #   final), researcher/supervisor loops, near-verbatim
│   │                     #   prompts, tavily_search w/ Exa→LLM summaries,
│   │                     #   cli.ts + reports.ts + tool.ts (gated deep_research)
│   ├── tools/            # fs (workspace-rooted), shell (execute: $SKILLS_DIR env,
│   │                     #   skill-path redirect, recoverable timeouts), web (Jina
│   │                     #   Reader→Tavily Extract fallback; Tavily search),
│   │                     #   memory_manage, skill_tools (skill_manage/load_skill),
│   │                     #   session_search (hybrid), registry
│   └── tests/            # 76 contract tests across 11 files
├── frontend/             # Vite React app: Chat feed (+ vela-chart cards), settings
│   └── src/charts/       #   (Skills|MCP), Yahoo fetch via proxy, @luxalgo/vela lazy
├── mcp_servers.json      # git-tracked MCP config
├── skills/               # local working copy (gitignored mirror of the R2 bucket)
├── memories/ state/      # local-only, gitignored
├── workspace/<login-id>/ # per-SSO-user scratch area, gitignored
├── sessions.db           # the archive (turns+FTS5+titles+followups+compressions)
└── agent-mirror.db       # ruvector redb sidecar store (rebuildable from archive)
```

## Contracts (the suite is the contract — `npm test`, 76 tests)

- **`Error:` is fatal, `Rejected:` is recoverable.** `Error:` ends the turn —
  reserved for system failures (spawn errors, unreadable I/O). Everything the
  model can route out of speaks `Rejected:` with guidance baked in: unknown
  tool (with closest-name hint), edit_file old_string not found (after
  exact→trimmed→whitespace-flexible matching), ENOENT reads/ls (with
  "Actually on disk at:" when the path belongs to skills/), execute
  timeouts (with the nohup-background recipe), memory budget, workspace
  guard. Nonzero exits and stderr are information, not errors.
- **3,575-char combined budget** across MEMORY.md + USER.md.
- **Provider-valid round-trips + every completed turn persisted** — tool_calls
  + tool_call_id + tool_name + usage persisted; cancel persists only the
  valid prefix (dangling groups dropped); single-reply turns archive too
  (persist gate >=1 on the new slice; user row prepended at append).
- **Hybrid search**: FTS5 chain (AND→OR→LIKE) ⊕ mirror dense leg, RRF k=60,
  retriever-tagged blocks, empty sentinel preserved.
- **Compression never breaks the agent**: threshold 24k provider-reported
  tokens (fallback chars/4), first + KEEP_RECENT(2) verbatim, middle
  summarized into `<conversation_summary turns=N-M>`; lineage in
  `compressions`; idempotent on resume.
- **Titles once; followups cosmetic**: sync fallback then async refine
  (summarizer model, model-labeled); followups only fire on the tuned regex
  prefilter, fire-and-forget, never block.
- **Workspace scope**: with `AUTH_MODE=sso`, `WORKSPACE_DIR/<login-id>/`
  (auto-created on login) is the root for relative tool paths and `execute`;
  `$WORKSPACE_DIR` is exported to shells. Local folders are path separation,
  not isolation (`execute` can read other users in the same process).
- **Session ownership**: `sessions` maps `session_id → user_id`; list, load,
  search, research runs and followups are filtered by the current login.
  Pre-SSO rows are backfilled to `trgordonb` once (guarded by `schema_meta`).
- **Skills**: disabled = invisible to the agent surface, visible to admin;
  curation writes through to R2 via debounced push; push failures surface
  as Rejected-grade advisories in skill_manage results (conflict UX).
- **Tracing never breaks the turn**; mirror never breaks the turn; bridge
  never blocks turns (local-only degradation with health-visible reason).

## Tool surface (flat registry; loop never special-cases)

Core: `ls read_file write_file edit_file glob grep execute web_to_markdown
internet_search memory_manage skill_manage load_skill session_search`
(session_search is hybrid + condensable via the SEARCH_SUMMARIZER_ENABLED
gate; the tool's context command references the condensed header).
`deep_research` joins the registry only with `RESEARCH_AS_TOOL=1` (40-min
runs — off by default).
MCP: `<server>_<tool>` entries (agent_browser 29, luxalgo 13 keep_tools,
agentdb 14 keep_tools; finance_toolkit dormant streamable_http).

## Environment

Full inventory with defaults in `.env.example`. Highlights:
- OpenRouter: `OPENROUTER_API_KEY/BASE_URL/MODEL_MAIN/MODEL_SUMMARIZER/`
  `MAIN_MODEL_PROVIDER` (+FALLBACKS/REASONING toggles)
- Compression: `COMPRESSION_ENABLED` (default off), `_TOKEN_THRESHOLD=24000`,
  `_KEEP_RECENT_TURNS=2`
- Nudge: `NUDGE_INTERVAL=5`
- Mirror: `AGENTDB_MIRROR=0` off, `AGENTDB_PATH`, `AGENTDB_MAX_ELEMENTS`
  (HNSW preallocation hint), `AGENTDB_REMOTE_URL/_TOKEN` (Cloudflare
  Container mirror — `container/README.md`), embed/sidecar timeouts
- Skills: `SKILLS_REGISTRY` (`s3://neuralmatrix`), `SKILLS_DIR`,
  `SKILLS_STATE_DIR`, `SKILLS_USER_ID` (toggle profile),
  `NM_SKILLS_REGISTRY_HOME`, `SKILLS_CLI` (installed binary; skips
  `uv run --directory`), `SKILLS_CLI_BRIDGE=0`,
  `SKILLS_REQUIRED=1` (fail boot on a failed/empty pull),
  `SKILLS_PUSH_DEBOUNCE_MS` — deploy recipe in
  `docs/skills-registry-deploy.md`
- MCP: `MCP_SERVERS_FILE`, connect/call timeouts
- Workspace: `WORKSPACE_DIR` (root; each SSO login gets
  `<root>/<login-id>/`), `WORKSPACE_USER` (`AUTH_MODE=off` fallback; empty =
  flat root), `WORKSPACE_HARD_JAIL` (confine writes to the scoped root)
- Server: `SERVER_HOST/PORT` (127.0.0.1:3001)

## Design decisions

- **node:sqlite** (Node 24, FTS5 built-in, WAL; zero native deps).
- **fetch over SDK** for OpenRouter (retry policy is the main.py port).
- **Sidecar isolation for natives**: the natives make a process fork-hostile
  (re-measured 2026-10-18: the ruvector wrapper's default HNSW preallocation
  of 10M vectors ≈ 35GB VA + onnx ~1GB; spawn/fork from such a process fails
  ENOMEM) — both live ONLY in `mirror-child.ts` (JSON-lines stdio; never
  forks after load), and the HNSW hint is bounded via `AGENTDB_MAX_ELEMENTS`
  (default 100k ≈ 1.4GB, index auto-grows). The server forks freely (execute
  tool) without ENOMEM risk. Same trap killed the mirror in an in-server
  build (documented at 2026-10-10).
- **agentdb npm alpha wrappers unreliable** (sync/await bugs; RvfBackend not
  exported) — the mirror drives the ruvector core directly; the MCP pilot
  runs agentdb legacy SQLite mode. RVF containers NOT used (see HISTORY).
- **Error/Rejected asymmetry** (installed across the porting sessions) is the
  loop's core self-recovery mechanism — every failure class returns guidance.
- **python-provider quirks carried**: OpenRouter reasoning-token cap on
  extraction calls (max_tokens not max_completion_tokens), Yahoo UA rule,
  keep_tools suffix matching, `${VAR}` fail-closed interpolation.
- **Deviations from python, deliberate**: skills index re-renders per turn
  (toggles apply next turn vs next session); followups live in the
  repo-owned archive (no schema-rental constraint); mirror is additive
  (archive stays authoritative) pending the AgenticDB evaluation.

## Roadmap (Hermes-order)

1-2. ✓ loop/prompt-memory/tools/REST/SSE · titler · MCP · followups ·
     skills Phases 1-4 · usage/persist + compression
3. ~~Search condensation ✓ 2026-10-13~~: secondary-LLM condensation over
   hybrid recall (summarizer.ts): SEARCH_SUMMARIZER_ENABLED (default off),
   one cheap model call over ≥8 fused candidates, python-parity observability
   header, silent-fallback-to-raw semantics; LangSmith'd like every
   secondary call. Note runtime-reload wiring: buildToolRegistry keeps the
   summarizer through assembleRuntime.
4. Nudge-hardening candidates: reflexion-store escalation via the bound
   agentdb MCP tools (python Gate-1), context-size aware nudging.
5. Deep research (`/research`): Stages 1–4 ✓ 2026-10-14 (engine + CLI +
   server wiring + frontend + polish: session tags, reconnect recovery,
   gated `deep_research` tool; docs/deep-research-plan.md).
6. `SessionDriver` → full AgenticDB sweep (RVF witness chains, COW
   branches, learned ranking) — pending agentdb alpha stability; the
   mirror already covers recall.
7. (Deferred) vela offline HTML vendor step; skills registry drift doctor
   in the UI.

## Dev

```bash
npm install && npm run start   # backend on :3001 (env from ./.env)
cd frontend && npm run dev     # web UI on :5173 (proxies /api)
npm test                       # 76 contract tests
npm run research -- "question" # deep research CLI (saves to workspace/research/)
```
