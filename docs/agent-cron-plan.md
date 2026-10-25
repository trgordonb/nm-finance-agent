# Agent cron — scheduled workflows with UI run history — planning document

**Status:** Phase 1 + Phase 2 implemented; per-job timezones shipped (2026-10-25,
pulled forward from Phase 3 — the EC2 VM is us-east-1 while the user is UTC+8, so
recurring cron expressions without an explicit tz would land at the wrong local
time). Tool + routes + UI accept IANA `timezone`; cron expressions parse under it
(cron-parser `tz`), naive one-shot timestamps convert two-pass DST-safe; next-fire
confirmations render in the job's zone. — `src/cron/` (`parse.ts`,
`scheduler.ts`, `execute.ts`, `tool.ts`), `cron_jobs`/`cron_runs` tables in
`store.ts`, `cron_manage` tool bound when `CRON_ENABLED=1` (default), scheduler
ticker started at boot, per-job REST routes under `/api/cron/jobs`. Phase 2:
`frontend/src/components/CronTab.tsx` ("Scheduled" right-pane view — job cards,
run-now/pause/resume/edit/delete, expandable run histories, session links,
5 s polling), `cron_name` tag on job sessions in the sidebar, per-job `running`
flag on the jobs listing, and a `runInWorkspace` wrap on the fire path (per-user
scope for scheduled turns). 12 tests in `src/tests/cron.test.ts`; suite 179/179.
Phase 3 (timezones, context chaining, delivery webhooks, model pins) not started.
**Date:** 2026-10-25
**Ask:** Hermes Agent / OpenClaw-style cron: the user asks the agent to schedule a
workflow — either distilled from a successful run in the session or provided
verbatim — and active tasks are visible in the UI with per-job run histories.
**Related:** [`docs/todo-chat-sse-reliability.md`](./todo-chat-sse-reliability.md)
(SSE hardening — prerequisite for long scheduled turns seen from the UI),
[`docs/vm-deployment-runbook.md`](./vm-deployment-runbook.md) (single systemd
unit, AL2023, 2 vCPU / 2 GB),
[`skills/stock-price-mover/SKILL.md`](../skills/stock-price-mover/SKILL.md)
(`daily.sh` + auto-run mode is today's stopgap).

---

## 1. Context

Today the only way to run the agent unattended is the `daily.sh` shell script:
host crontab/launchd → headless POST `/api/chat` with an "auto-run" prompt. It
works but lives outside the product: no visibility, no run history, no per-user
ownership, no pause/resume, and it cannot be created *by the agent in
conversation*. Both reference frameworks solve this with an in-agent scheduler;
this plan ports that idea to this harness.

Goals:

- The agent can create/list/pause/resume/remove/run-now scheduled jobs through a
  tool, from a normal conversation (including "schedule what we just did").
- A schedule is a first-class object: persisted per user, with computed next
  run, last status/error, and a per-job run history.
- The UI shows active jobs and their run histories (right-pane view, plus a
  badge on sessions produced by jobs).
- Scheduled runs execute with the owning user's context (tools, workspace,
  budget) and are capped by the same iteration budget as chat turns.

Non-goals (v1): delivery to external channels (Telegram/Slack/webhooks),
script-only jobs (`no_agent`), condition/webhook/event triggers, cross-user
shared jobs, cluster/distributed scheduling (the VM is a single systemd unit).

## 2. Prior art — what Hermes and OpenClaw teach us

**[Hermes Agent](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/cron.md)**
([scheduler](https://github.com/NousResearch/hermes-agent/blob/main/cron/scheduler.py)):
a single unified tool `cronjob_manage` (actions `create/list/update/pause/
resume/run/remove`); schedule kinds = one-shot delay (`in 30m`), interval
(`every 2h`), natural language (`every monday 9am`), cron expressions, ISO
timestamps, compiled via `croniter`; **fresh session per run** with a
self-contained prompt; 60 s tick in the daemon with a file lock; jobs.json +
an execution ledger (`claimed → running → completed/failed/unknown`);
overlapping dispatch refused; missed runs catch up **once** per outage;
transient failures retry 5/15/30 min; failure-streak alerting; `context_from`
chains upstream job outputs; per-job model pins; **loop prevention — cron-run
sessions cannot create cron jobs by default** (`cron.allow_agent_scheduling`).

**[OpenClaw automations](https://docs.openclaw.ai/automation/cron-jobs)**
([CLI](https://docs.openclaw.ai/cli/cron)): gateway-persisted jobs; one-shot,
cron, interval and webhook triggers; payload kinds (agent turn / command /
script); session modes (main vs **isolated** vs custom) with an "unattended run
contract"; delivery to channels/webhook/none; per-job **run history queryable
via CLI** (`automations runs <job-id>`); retry + failure notifications; run
reconciliation on restart.

**Lessons adopted here:** one action-based tool (matches this repo's
`memory_manage` style); schedules normalized to a structured form with the
*calling LLM* doing natural-language → cron translation and the tool echoing
the computed next-run for confirmation; fresh isolated session per run with
self-contained prompts; an execution ledger separate from the job row; refuse
overlap; catch-up-once on restart; loop prevention by default; run history as a
first-class queryable object (OpenClaw) surfaced in the UI.

## 3. Design overview

An **in-process scheduler** inside the existing Express service (same systemd
unit — no new daemon), ticking every 30–60 s:

```
tick (setInterval, guarded)
  ├─ load due jobs (SQLite: next_run_at <= now, enabled)
  ├─ skip jobs already running (claimed) or over max_parallel
  ├─ claim run row (status=claimed → running)        [transactional]
  ├─ fire: runInWorkspace(userKey, () => executeJob(job))
  │    └─ AgentLoop.runTurn(fresh history, payload, budget, tool policy w/o cron_manage)
  ├─ persist turn via the same path as /api/chat (appendTurn + mirror + titler)
  ├─ update run row (completed/failed, usage, excerpt) + job (next_run_at, last_status)
  └─ one-shot jobs: disabled/removed after their single fire
```

- **Persistence**: two new SQLite tables in `sessions.db` via the existing
  `store.ts` migration pattern (`schema_meta` versioning), NOT a JSON file —
  matches repo convention, gives us transactions for the claim step.
- **Fresh session per run** (Hermes): each job owns a persistent *job session*
  (`cron_jobs.session_id`) created lazily on first fire; every run appends one
  user turn + its messages there. The session appears in the normal sidebar
  (with a `scheduled` tag like the research tag) so users can open and read
  anything a job did. Continuity is opt-in later (`context_from`-style) — v1
  prompts must be self-contained, which the skill's auto-run mode already is.
- **Per-user context**: scheduled runs execute inside
  `runInWorkspace(userKey, …)` so `currentUserId()`, workspace root, per-user
  tool policy and memory resolve exactly as in a request-scoped turn. The job
  row carries `user_id`; ownership is enforced on every API route (same
  `ownsSession` pattern).
- **Loop prevention**: scheduled runs get a tool policy that hides
  `cron_manage` (extend `ToolContext`/runTurn meta with `scheduled: true` →
  the loop's `toolPolicy` composes it). Opt-in flag on the job
  (`allow_scheduling: 0/1`) can lift this later, default off.
- **Budget & landing**: scheduled turns use the normal
  `BUDGET_TOOL_MAX_ITERATIONS` and the wrap-up nudge, so overruns persist state
  and end cleanly instead of dying mid-step.
- **Tracing**: every fire is an ordinary `agent-turn` LangSmith trace (free —
  it is `runTurn`), tagged `scheduled:<job-name>` for filtering.

## 4. Data model (`sessions.db`)

```sql
CREATE TABLE cron_jobs (
  id TEXT PRIMARY KEY,               -- uuid
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,                -- unique per user, human-usable (Hermes-style name addressing)
  schedule_kind TEXT NOT NULL,       -- 'cron' | 'interval' | 'once'
  schedule_expr TEXT NOT NULL,       -- '0 9 * * 1-5' | '24h' | ISO timestamp / ISO-ish delay
  payload TEXT NOT NULL,             -- self-contained prompt (the workflow)
  session_id TEXT,                   -- job's own session (lazy)
  created_from_session TEXT,         -- where the user asked (provenance)
  enabled INTEGER NOT NULL DEFAULT 1,
  allow_scheduling INTEGER NOT NULL DEFAULT 0,   -- loop-guard opt-in
  max_iterations INTEGER,            -- null = global default
  timezone TEXT,                     -- v1: server-local; column reserved
  next_run_at INTEGER,               -- epoch ms; null for paused
  last_run_at INTEGER,
  last_status TEXT,                  -- 'ok' | 'error' | 'skipped' | null
  last_error TEXT,
  failure_streak INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE cron_runs (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  session_id TEXT,                   -- = job session (denormalized for the UI)
  fire_at INTEGER NOT NULL,          -- scheduled time (vs started_at for lag)
  started_at INTEGER,
  finished_at INTEGER,
  status TEXT NOT NULL,              -- 'claimed' | 'running' | 'completed' | 'failed' | 'skipped' | 'interrupted'
  iterations INTEGER,
  prompt_tokens INTEGER, completion_tokens INTEGER,
  error TEXT,
  result_excerpt TEXT                -- last assistant message, first ~500 chars (UI history)
);
```

Boot reconciliation mirrors the research-run pattern: `running`/`claimed` rows
from a crashed process become `interrupted` (audit-only, never auto-rerun), and
`next_run_at` in the past catches up **once** per job (config
`CRON_CATCH_UP_MISSED=1`, default on) or re-anchors (`=0`).

## 5. Schedules

- `cron`: standard 5-field expressions, parsed/advanced with `cron-parser`
  (tiny, dependency-light, handles DST via tz option later). Day-of-month/
  day-of-week OR semantics documented in the tool description (Hermes lesson).
- `interval`: `Nd`/`Nh`/`Nm` or bare minutes; next = last fire + interval.
- `once`: ISO timestamp or relative delay (`in 90m`); single fire, then the
  job is auto-disabled with `last_status='ok'` (OpenClaw's `--delete-after-run`
  kept as an explicit `remove_after_run` flag instead of a delete — history
  stays visible).
- **Natural language** ("every weekday 9am", "in 30 minutes") is translated by
  the calling model into one of the three kinds at `create` time; the tool
  replies with the parsed schedule **and the computed next 2 run times** so the
  model can confirm to the user in the same turn ("that's tomorrow 09:00 local").
  Times are server-local (VM local time); per-job timezone is a reserved column.

## 6. Tool API — `cron_manage` (one tool, action-based)

| action | params | returns |
|---|---|---|
| `create` | name, schedule_kind, schedule_expr, payload, max_iterations?, allow_scheduling? | job incl. computed `next_run_at` + next 2 fires |
| `list` | — | user's jobs: name, schedule, enabled, next_run, last_status |
| `get` | name-or-id | job + last run |
| `update` | name-or-id, any create field | updated job |
| `pause` / `resume` | name-or-id | job (`next_run_at` cleared/recomputed) |
| `remove` | name-or-id | ok (history rows kept) |
| `runs` | name-or-id, limit≤20 | recent `cron_runs` rows |
| `run` | name-or-id, prompt_override? | run id — **async**, result lands in the job's session (Hermes parity: refused if already running) |

Validation is strict and self-describing: name uniqueness per user, prompt
non-empty, schedule parses, `next_run_at` finite. Errors are
`Rejected:`-prefixed (repo convention) so the model can self-correct in-turn.
The tool description tells the model the workflow rules: prompts must be
self-contained (fresh session; reference skills by name, e.g. auto-run the
stock-price-mover flow), the loop guard, and that `create` from a successful
session means *writing the full workflow into `payload`*, not a pointer to the
conversation.

## 7. Execution path & policies

- **Claim**: `UPDATE cron_runs SET status='running' … WHERE status='claimed'`
  in a transaction — the concurrency guard is the database, not hope. A due job
  whose previous run is still `running` records a `skipped` run row (visible in
  history) instead of queueing (Hermes/OpenClaw parity).
- **max parallel**: `CRON_MAX_PARALLEL` (default 2) — a 2 GB VM runs at most
  two scheduled turns concurrently; further due jobs stay claimed-pending until
  the next tick.
- **Failure policy**: `failure_streak` increments on `failed`; at
  `CRON_FAILURE_PAUSE_STREAK` (default 5) the job auto-pauses with
  `last_error` set — the UI shows it in a "paused (failing)" state and the user
  resumes manually. Success resets the streak.
- **Fire-time context**: optional transient `run_context` parameter on
  `run` (Hermes `## Run Context` parity) — v1 scope: only via manual run-now.
- **Delivery**: v1 delivers into the job's session only (UI-visible). A future
  phase can add webhook/`done`-notification surfaces; `[SILENT]`-style markers
  are noted as precedent but not implemented.

## 8. API surface (all per-user, SSO-checked)

```
GET    /api/cron/jobs                 list (jobs + last run + next fire)
POST   /api/cron/jobs                 create (also used by a future UI form)
GET    /api/cron/jobs/:id             job + recent runs
PATCH  /api/cron/jobs/:id             update / pause / resume (action field)
DELETE /api/cron/jobs/:id             remove
POST   /api/cron/jobs/:id/run         run now (async; 409 if running)
GET    /api/cron/jobs/:id/runs?limit= run history
```

The chat tool `cron_manage` and these routes share one `src/cron/` module
(`scheduler.ts`, `store.ts` extensions, `parse.ts`, `execute.ts`) — the tool is
a thin shell over the same functions the routes call, exactly like the
research module (`src/research/` + `runResearchTurn`) is today.

## 9. UI

- **New right-pane view "Scheduled"** (tab next to Chat/Wiki — the pane has
  room since the settings view became a modal). Content: job cards — name,
  schedule (human-rendered: "every weekday 09:00"), enabled toggle, next fire
  countdown, last status chip (ok/error/skipped/paused-failing), and an
  expandable **run history** list (time, duration, iterations, status, excerpt,
  link that opens the job's session in Chat). Card actions: Run now, Pause/
  Resume, Edit (inline schedule/prompt), Delete (confirm).
- **Sessions produced by jobs** carry a `scheduled` tag in the sidebar (the
  research-tag mechanism; `cron_runs.session_id` → `sessions` join or a
  `session_source` column).
- **Live indicator**: while a scheduled run is active, the existing
  research-strip-style element (or a sidebar badge on the job's session) shows
  "scheduled · <job name> running" — reuse the polling pattern from
  `GET /api/research/:sessionId`.
- The agent creating a job in conversation confirms with the computed next
  fire ("Scheduled **AAPL daily brief** — every weekday 09:00, next run
  tomorrow 09:00 (in 14h). Say 'run it now' to test it immediately.").

## 10. Security & ownership

- Jobs belong to the SSO user; every route and every fire checks ownership
  (`user_id`), mirroring session ownership. AUTH_MODE=off maps everything to
  the default user.
- Scheduled runs inherit the owner's **current** per-user tool/skill policy at
  fire time, minus the loop guard. Prompt-injection surface is the job's own
  payload (owner-authored) — same trust level as the owner typing it.
- Shell/file tools run inside the owner's workspace root (existing scoping);
  `cron_manage` is excluded from scheduled runs unless `allow_scheduling=1`.
- The tool is registered in `buildToolRegistry` but filtered for unauthenticated
  users only under future multi-tenant hardening — v1 ships enabled for all
  signed-in users (single-tenant reality today).

## 11. Config knobs (env, following `config.ts` conventions)

`CRON_ENABLED` (default `1`; `0` = tool hidden, ticker off, tables idle),
`CRON_TICK_MS` (30000), `CRON_MAX_PARALLEL` (2), `CRON_CATCH_UP_MISSED` (1),
`CRON_FAILURE_PAUSE_STREAK` (5), `CRON_MISFIRE_GRACE_MIN` (10), default
`BUDGET_TOOL_MAX_ITERATIONS` applies per run unless the job overrides.

## 12. Test plan

- `parse.ts`: cron/interval/once → next-fire computation incl. DST-ish edge
  (server-local), OR semantics note; validation errors.
- Scheduler with a fake clock: claim/transaction exclusivity, overlap skip row,
  max-parallel deferral, one-shot auto-disable, catch-up-once after simulated
  restart, failure-streak auto-pause, loop-guard hides `cron_manage` in
  scheduled runs.
- Routes: ownership 404s, pause/resume, run-now 409-while-running.
- UI: manual (render build), plus API-shape tests for the list payload.

## 13. Rollout phases

1. **Phase 1 — core**: `src/cron/` module, tables + migrations, `cron_manage`
   tool, scheduler ticker + fire path, API routes, catch-up + failure policies.
   Deliverable: schedule from chat, runs appear as sessions in the sidebar.
2. **Phase 2 — UI**: "Scheduled" view, run histories, live indicator, session
   tag. Deliverable: the user's ask — visible active tasks with histories.
3. **Phase 3 — hardening & extras**: per-job timezone, `context_from` chaining,
   run-now with prompt override in UI, delivery webhooks, per-job model pin,
   `allow_scheduling` opt-in, `doctor`-style health row in `/api/health`.

Effort intuition: Phase 1 is a `src/research/`-sized module (~1k lines + tests)
because the turn machinery, budget, tracing, per-user scoping and persistence
already exist; the genuinely new logic is schedule parsing, the tick/claim
loop, and the tool.

## 14. Open questions

1. **lib**: `cron-parser` (npm, active, tz-aware) vs hand-rolled minimal
   cron (no dependency, less coverage). Recommend `cron-parser`.
2. **Timezone UX**: server-local only in v1, or accept IANA tz per job at
   create (the column is reserved)? Recommend deferring.
3. **"Schedule this run" ergonomics**: agent-only composition (v1) vs a UI
   button on a completed session that prefills a `cron_manage` payload draft
   (Phase 2/3). The agent path is enough for the user's stated ask.
4. **Stop semantics**: allow the UI to cancel a running scheduled turn via the
   existing `/api/chat/cancel` (needs ACTIVE_TURNS registration per fire) —
   recommended for Phase 2.
5. **Cost guardrails**: per-job monthly token cap? Not before there's usage
   data to size it.
