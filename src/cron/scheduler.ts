// In-process agent-cron scheduler (docs/agent-cron-plan.md §3/§7). One tick
// every CRON_TICK_MS inside the existing service process: claim due fires
// transactionally (never double-fire, never re-fire a long-running job), then
// execute each fire as a normal agent turn in the owning user's context.
//
// Scheduled runs are marked with an AsyncLocalStorage flag the tool policy
// consults — scheduled sessions cannot create new cron jobs (loop prevention,
// Hermes `cron.allow_agent_scheduling` parity) without racing other turns.

import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import {
  CRON_CATCH_UP_MISSED,
  CRON_FAILURE_PAUSE_STREAK,
  CRON_MAX_PARALLEL,
  CRON_MISFIRE_GRACE_MIN,
  CRON_TICK_MS,
} from "../config.js";
import { log } from "../logger.js";
import type { AgentLoop } from "../agent.js";
import type { AgentDbMirror } from "../agentdb-mirror.js";
import type { CronJobRow, CronRunRow, SQLiteSessionStore } from "../store.js";
import { runInWorkspace } from "../workspace.js";
import { nextFire, type ScheduleKind } from "./parse.js";
import { executeCronJob } from "./execute.js";

const scheduledRunScope = new AsyncLocalStorage<true>();

/** True inside a scheduler-fired turn — the tool policy hides cron_manage. */
export function isScheduledRun(): boolean {
  return scheduledRunScope.getStore() === true;
}

/** The next slot after a fire, or null for one-shot jobs (nothing follows). */
export function advanceAfter(job: CronJobRow, fromMs: number): number | null {
  const kind = job.schedule_kind as ScheduleKind;
  if (kind === "once") return null;
  // Advance in the job's timezone; otherwise a midnight-HKT job advances to
  // midnight UTC (08:00 HKT) and fires twice per local day.
  return nextFire(kind, job.schedule_expr, fromMs, job.timezone);
}

export interface CronDeps {
  store: SQLiteSessionStore;
  /** Shared agent loop — scheduled turns are ordinary turns in the owner's
   *  ALS context (workspace/tools/memory all resolve per-call). */
  loop: AgentLoop;
  mirror?: AgentDbMirror | null;
  /** Awaited before firing so MCP/skills are assembled (chat-route parity). */
  getRuntime?: () => Promise<void>;
  /** Test seams. */
  now?: () => number;
  execute?: typeof executeCronJob;
}

export class CronScheduler {
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;

  constructor(private readonly deps: CronDeps) {}

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  /** Boot reconciliation + ticker. Safe to call once at module init. */
  start(): void {
    const { interrupted, catchups } = this.reconcile();
    if (interrupted || catchups) {
      log.info(`cron: reconciled on boot — ${interrupted} interrupted run(s), ${catchups} catch-up job(s)`);
    }
    this.timer = setInterval(() => {
      try {
        this.tick();
      } catch (e) {
        log.warn(`cron tick failed: ${String((e as Error).message).slice(0, 200)}`);
      }
    }, CRON_TICK_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  reconcile(): { interrupted: number; catchups: number } {
    return this.deps.store.reconcileCronOnBoot(
      this.now(),
      CRON_MISFIRE_GRACE_MIN * 60_000,
      CRON_CATCH_UP_MISSED,
      (job) => nextFire(job.schedule_kind as ScheduleKind, job.schedule_expr, this.now()),
    );
  }

  /** One scheduler pass: claim and launch every due fire within the parallel cap. */
  tick(): void {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = this.now();
      const slots = CRON_MAX_PARALLEL - this.deps.store.runningCronCount();
      if (slots <= 0) return;
      const due = this.deps.store.dueCronJobs(now, 25);
      let launched = 0;
      for (const job of due) {
        if (launched >= slots) break;
        const fireAt = job.next_run_at as number;
        const next = advanceAfter(job, fireAt);
        const runId = randomUUID();
        const claimed = this.deps.store.claimCronFire(job, fireAt, next, runId);
        if (!claimed) {
          // Previous run still active — record the skip and move past the slot.
          this.deps.store.recordCronSkipped(job, fireAt, next, randomUUID());
          continue;
        }
        launched++;
        void this.fire(job, claimed).catch((e) =>
          log.warn(`cron job ${job.name} fire failed: ${String((e as Error).message).slice(0, 200)}`),
        );
      }
    } finally {
      this.ticking = false;
    }
  }

  /** Manual "run now": immediate fire through the same claim path. Returns the
   *  run id, or null when the job is disabled/already running. */
  runJobNow(job: CronJobRow): string | null {
    const now = this.now();
    const next = advanceAfter(job, now);
    const runId = randomUUID();
    const claimed = this.deps.store.claimCronFire(job, now, next, runId);
    if (!claimed) return null;
    void this.fire(job, claimed).catch((e) =>
      log.warn(`cron job ${job.name} manual fire failed: ${String((e as Error).message).slice(0, 200)}`),
    );
    return runId;
  }

  /** Execute one claimed fire. Public for tests: claim via the store, then
   *  await this for deterministic completion. Runs inside the owner's
   *  workspace/user scope (per-user tools, memory, session ownership) plus
   *  the scheduled-run flag the tool policy consults (loop prevention). */
  async fire(job: CronJobRow, run: CronRunRow): Promise<void> {
    this.deps.store.markCronRunRunning(run.id);
    if (this.deps.getRuntime) await this.deps.getRuntime();
    const execute = this.deps.execute ?? executeCronJob;
    try {
      const result = await runInWorkspace(job.user_id, () =>
        scheduledRunScope.run(true, () =>
          execute(this.deps.store, this.deps.loop, this.deps.mirror ?? null, job, run),
        ),
      );
      const finished = this.deps.store.finishCronRun(run.id, {
        status: result.failed ? "failed" : "completed",
        iterations: result.iterations,
        prompt_tokens: result.usage.prompt_tokens,
        completion_tokens: result.usage.completion_tokens,
        error: result.error ?? null,
        result_excerpt: result.excerpt,
      });
      if (job.schedule_kind === "once" && finished) {
        this.deps.store.updateCronJob(job.id, { enabled: 0 });
      }
      this.maybeAutoPause(job.name, finished);
    } catch (e) {
      const finished = this.deps.store.finishCronRun(run.id, {
        status: "failed",
        error: String((e as Error).message).slice(0, 300),
      });
      this.maybeAutoPause(job.name, finished);
    }
  }

  /** Consecutive-failure circuit breaker: pause the job (UI shows it in
   *  "paused (failing)") once the streak hits CRON_FAILURE_PAUSE_STREAK. */
  private maybeAutoPause(name: string, finished: CronJobRow | null): void {
    if (!finished || !finished.enabled || finished.failure_streak < CRON_FAILURE_PAUSE_STREAK) return;
    this.deps.store.updateCronJob(finished.id, {
      enabled: 0,
      last_error: `auto-paused after ${finished.failure_streak} consecutive failures — last: ${finished.last_error ?? "unknown"}`,
    });
    log.warn(`cron: auto-paused job ${name} after ${finished.failure_streak} failures`);
  }
}
