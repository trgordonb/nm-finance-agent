// cron_manage — the agent's single handle over its scheduled jobs
// (docs/agent-cron-plan.md §6). Action-based like memory_manage; Hermes
// `cronjob_manage` parity. The tool is excluded from scheduled runs by the
// loop policy (loop prevention), so it only ever runs in user conversation.

import { randomUUID } from "node:crypto";
import { currentUserId } from "../workspace.js";
import type { ToolDef } from "../types.js";
import type { CronJobRow, SQLiteSessionStore } from "../store.js";
import {
  describeSchedule,
  formatInTz,
  isScheduleKind,
  isValidTimezone,
  nextFire,
  nextFires,
  serverTimezone,
  validateSchedule,
  type ScheduleKind,
} from "./parse.js";
import type { CronScheduler } from "./scheduler.js";

function jobPublic(job: CronJobRow, opts?: { withPayload?: boolean }) {
  const base = {
    id: job.id,
    name: job.name,
    schedule: describeSchedule(job.schedule_kind as ScheduleKind, job.schedule_expr, job.timezone),
    timezone: job.timezone,
    enabled: Boolean(job.enabled),
    next_run_at: job.next_run_at,
    last_run_at: job.last_run_at,
    last_status: job.last_status,
    last_error: job.last_error,
    failure_streak: job.failure_streak,
    session_id: job.session_id,
  };
  return opts?.withPayload
    ? { ...base, payload: job.payload, max_iterations: job.max_iterations }
    : { ...base, payload_preview: job.payload.slice(0, 160) };
}

export function createCronManageTool(store: SQLiteSessionStore, scheduler: CronScheduler): ToolDef {
  return {
    name: "cron_manage",
    description:
      "Create, inspect, pause, resume, run or remove the user's scheduled agent jobs (cron). " +
      "Schedule kinds: 'cron' (standard 5-field expression, e.g. '0 9 * * 1-5'; day-of-month and " +
      "day-of-week combine with OR), 'interval' ('6h', '30m', '1d'), 'once' (ISO timestamp or " +
      "'in 90m'). Translate natural-language schedules into one of these kinds yourself. " +
      "The payload MUST be a self-contained prompt: every fire runs in a fresh session with no " +
      "memory of this conversation, so embed the complete workflow — reference skills by name " +
      "(e.g. 'use the stock-price-mover skill in auto-run mode for ticker X') rather than pointing " +
      "at this chat. create/update responses include the computed next fire times: confirm them " +
      "to the user before ending the turn.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["create", "list", "get", "update", "pause", "resume", "remove", "runs", "run"],
          description: "Operation on the user's scheduled jobs.",
        },
        name: { type: "string", description: "Job name (create: required, unique per user; otherwise name-or-id)." },
        schedule_kind: { type: "string", enum: ["cron", "interval", "once"], description: "create/update: schedule kind." },
        schedule_expr: { type: "string", description: "create/update: the expression for that kind." },
        payload: { type: "string", description: "create/update: the self-contained prompt each fire executes." },
        max_iterations: { type: "number", description: "create/update: per-run tool-call budget override." },
        timezone: {
          type: "string",
          description:
            "create/update: IANA timezone the schedule's times are interpreted in (e.g. 'Asia/Hong_Kong'). " +
            "Default: the server's timezone. Use it whenever the user names a clock time — their local zone " +
            "is usually not the server's (the server runs in " + serverTimezone() + ").",
        },
        limit: { type: "number", description: "runs: how many history rows (default 10, max 20)." },
      },
      required: ["action"],
    },
    async execute(args) {
      const a = args as Record<string, string | number | undefined>;
      const action = String(a.action ?? "");
      const user = currentUserId();

      if (action === "list") {
        const jobs = store.listCronJobs(user).map((j) => jobPublic(j));
        return JSON.stringify({ jobs });
      }

      if (action === "create") {
        const name = String(a.name ?? "").trim();
        const kind = a.schedule_kind;
        const expr = String(a.schedule_expr ?? "").trim();
        const payload = String(a.payload ?? "").trim();
        if (!name) return "Rejected: 'name' is required for create";
        if (name.length > 80) return "Rejected: 'name' must be 80 characters or fewer";
        if (!isScheduleKind(kind)) return "Rejected: 'schedule_kind' must be cron, interval or once";
        const invalid = validateSchedule(kind as ScheduleKind, expr);
        if (invalid) return `Rejected: ${invalid}`;
        if (!payload) return "Rejected: 'payload' is required — the prompt each fire executes (self-contained)";
        if (store.getCronJobForUser(user, name)) {
          return `Rejected: a job named ${JSON.stringify(name)} already exists — pick another name or update it`;
        }
        const now = Date.now();
        const next = nextFire(kind as ScheduleKind, expr, now);
        if (next === null) return `Rejected: could not compute the next fire for ${JSON.stringify(expr)}`;
        const maxIt = a.max_iterations != null ? Number(a.max_iterations) : null;
        const timezone = a.timezone != null ? String(a.timezone).trim() || null : null;
        if (!isValidTimezone(timezone)) {
          return `Rejected: invalid timezone ${JSON.stringify(timezone)} — use an IANA name like "Asia/Hong_Kong"`;
        }
        const nextRuns = nextFires(kind as ScheduleKind, expr, now, 2, timezone);
        const job = store.createCronJob({
          id: randomUUID(),
          user_id: user,
          name,
          schedule_kind: kind as ScheduleKind,
          schedule_expr: expr,
          payload,
          session_id: null,
          created_from_session: null,
          enabled: 1,
          allow_scheduling: 0,
          max_iterations: maxIt != null && Number.isFinite(maxIt) ? Math.floor(maxIt) : null,
          timezone,
          next_run_at: next,
          last_run_at: null,
          last_status: null,
          last_error: null,
          failure_streak: 0,
          created_at: now,
          updated_at: now,
        });
        return JSON.stringify({
          ok: true,
          job: jobPublic(job, { withPayload: true }),
          next_runs: nextRuns.map((t) => formatInTz(t, timezone)),
          server_timezone: serverTimezone(),
          note: "Scheduled. Each fire lands in the job's own session; runs and statuses are visible in the Scheduled view.",
        });
      }

      // Everything below addresses an existing job.
      const ref = String(a.name ?? "").trim();
      const job = ref ? store.getCronJobForUser(user, ref) : null;
      if (!job) return `Rejected: no scheduled job ${JSON.stringify(ref || String(a.name ?? ""))} for this user`;

      if (action === "get") {
        return JSON.stringify({ job: jobPublic(job, { withPayload: true }) });
      }

      if (action === "update") {
        const fields: Partial<CronJobRow> = {};
        if (a.payload != null) {
          const p = String(a.payload).trim();
          if (!p) return "Rejected: payload cannot be empty";
          fields.payload = p;
        }
        if (a.max_iterations != null) {
          const m = Number(a.max_iterations);
          fields.max_iterations = Number.isFinite(m) ? Math.floor(m) : null;
        }
        let tz = job.timezone;
        if (a.timezone != null) {
          tz = String(a.timezone).trim() || null;
          if (!isValidTimezone(tz)) {
            return `Rejected: invalid timezone ${JSON.stringify(tz)} — use an IANA name like "Asia/Hong_Kong"`;
          }
          fields.timezone = tz;
        }
        if (a.schedule_kind != null || a.schedule_expr != null || a.timezone != null) {
          const kind = (isScheduleKind(a.schedule_kind) ? a.schedule_kind : job.schedule_kind) as ScheduleKind;
          const expr = String(a.schedule_expr ?? job.schedule_expr).trim();
          const invalid = validateSchedule(kind, expr, tz);
          if (invalid) return `Rejected: ${invalid}`;
          fields.schedule_kind = kind;
          fields.schedule_expr = expr;
          if (job.enabled) fields.next_run_at = nextFire(kind, expr, Date.now(), tz);
        }
        const updated = store.updateCronJob(job.id, fields);
        const nextRuns =
          updated && updated.enabled && updated.next_run_at
            ? nextFires(
                updated.schedule_kind as ScheduleKind,
                updated.schedule_expr,
                Date.now(),
                2,
                updated.timezone,
              ).map((t) => formatInTz(t, updated.timezone))
            : [];
        return JSON.stringify({ ok: true, job: updated ? jobPublic(updated, { withPayload: true }) : null, next_runs: nextRuns });
      }

      if (action === "pause") {
        const updated = store.updateCronJob(job.id, { enabled: 0, next_run_at: null });
        return JSON.stringify({ ok: true, job: updated ? jobPublic(updated) : null });
      }

      if (action === "resume") {
        const kind = job.schedule_kind as ScheduleKind;
        const next = nextFire(kind, job.schedule_expr, Date.now(), job.timezone);
        const updated = store.updateCronJob(job.id, {
          enabled: 1,
          next_run_at: next ?? Date.now(),
          failure_streak: 0,
        });
        return JSON.stringify({ ok: true, job: updated ? jobPublic(updated) : null });
      }

      if (action === "remove") {
        store.deleteCronJob(job.id);
        return JSON.stringify({ ok: true, removed: job.name });
      }

      if (action === "runs") {
        const limit = Math.min(Math.max(Number(a.limit ?? 10) || 10, 1), 20);
        const runs = store.listCronRuns(job.id, limit).map((r) => ({
          id: r.id,
          fire_at: r.fire_at,
          started_at: r.started_at,
          finished_at: r.finished_at,
          status: r.status,
          iterations: r.iterations,
          error: r.error,
          excerpt: r.result_excerpt,
        }));
        return JSON.stringify({ job: jobPublic(job), runs });
      }

      if (action === "run") {
        const runId = scheduler.runJobNow(job);
        if (runId === null) {
          return `Rejected: job ${JSON.stringify(job.name)} is already running (or paused) — check the runs history`;
        }
        return JSON.stringify({
          ok: true,
          run_id: runId,
          note: "Fire started asynchronously — the result lands in the job's session and the runs history.",
        });
      }

      return `Rejected: unknown action ${JSON.stringify(action)}`;
    },
  };
}
