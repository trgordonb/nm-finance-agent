// Agent cron Phase 1 (docs/agent-cron-plan.md): schedule parsing, the store
// claim transaction, scheduler fire/skip/failure policies, boot reconciliation
// and the cron_manage tool's ownership + validation.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

process.env.LANGSMITH_TRACING = "0";

import type { CronJobRow } from "../store.js";

const { SQLiteSessionStore } = await import("../store.js");
const { CronScheduler, isScheduledRun } = await import("../cron/scheduler.js");
const {
  nextFire,
  nextFires,
  validateSchedule,
  intervalToMs,
  relativeDelayToMs,
  describeSchedule,
  isValidTimezone,
  formatInTz,
} = await import("../cron/parse.js");
const { createCronManageTool } = await import("../cron/tool.js");
const { executeCronJob } = await import("../cron/execute.js");
const { runInWorkspace } = await import("../workspace.js");

function tempStore(): InstanceType<typeof SQLiteSessionStore> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cron-test-"));
  return new SQLiteSessionStore(path.join(dir, "sessions.db"));
}

function makeJob(over: Partial<CronJobRow> = {}): CronJobRow {
  const now = Date.now();
  return {
    id: randomUUID(),
    user_id: "alice",
    name: "daily-brief",
    schedule_kind: "interval",
    schedule_expr: "1h",
    payload: "run the daily brief",
    session_id: null,
    created_from_session: null,
    enabled: 1,
    allow_scheduling: 0,
    max_iterations: null,
    timezone: null,
    next_run_at: now - 1000, // due
    last_run_at: null,
    last_status: null,
    last_error: null,
    failure_streak: 0,
    created_at: now,
    updated_at: now,
    ...over,
  };
}

// --- parse --------------------------------------------------------------------

test("cron parse: cron expressions advance from the reference time", () => {
  const from = Date.parse("2026-10-25T10:00:00Z"); // Sunday
  const t = nextFire("cron", "0 9 * * 1-5", from); // weekdays 09:00
  assert.equal(new Date(t as number).getUTCDay(), 1); // Monday
  const fires = nextFires("cron", "0 9 * * 1-5", from, 3);
  assert.equal(fires.length, 3);
  assert.ok(fires[0] < fires[1] && fires[1] < fires[2]);
});

test("cron parse: intervals and one-shots", () => {
  assert.equal(intervalToMs("6h"), 6 * 3_600_000);
  assert.equal(intervalToMs("30"), 30 * 60_000);
  assert.equal(intervalToMs("1d30m"), (24 * 60 + 30) * 60_000);
  assert.equal(relativeDelayToMs("in 90m"), 90 * 60_000);
  const from = Date.parse("2026-10-25T10:00:00Z");
  assert.equal(nextFire("interval", "2h", from), from + 7_200_000);
  assert.equal(nextFire("once", "in 30m", from), from + 1_800_000);
  assert.equal(nextFire("once", "2027-02-01T16:00:00Z", from), Date.parse("2027-02-01T16:00:00Z"));
  assert.equal(validateSchedule("cron", "99 * * * *")?.includes("invalid"), true);
  assert.equal(validateSchedule("interval", "sometimes"), "invalid interval \"sometimes\" — use Nd / Nh / Nm (e.g. \"6h\") or bare minutes");
  assert.equal(validateSchedule("once", "not a date")?.includes("invalid"), true);
  assert.equal(validateSchedule("cron", "0 9 * * 1-5"), null);
  assert.equal(describeSchedule("interval", "6h"), "every 6h");
});

test("cron parse: timezone scopes cron expressions and naive one-shots", () => {
  const from = Date.parse("2026-10-25T10:00:00Z"); // Sunday 10:00Z
  // 09:00 weekdays in Hong Kong = 01:00Z (HKT = UTC+8, no DST)
  const t = nextFire("cron", "0 9 * * 1-5", from, "Asia/Hong_Kong");
  assert.equal(new Date(t as number).getUTCHours(), 1);
  assert.equal(new Date(t as number).getUTCDay(), 1); // Monday 01:00Z = Mon 09:00 HKT
  // The same expression without tz fires at 09:00 server-local — a different instant.
  assert.equal(nextFire("once", "2026-12-01T09:00:00", from, "Asia/Hong_Kong"), Date.parse("2026-12-01T01:00:00Z"));
  // An explicit offset timestamp is timezone-independent.
  assert.equal(
    nextFire("once", "2026-12-01T09:00:00+08:00", from, "America/New_York"),
    Date.parse("2026-12-01T01:00:00Z"),
  );
  assert.equal(validateSchedule("cron", "0 9 * * 1-5", "Asia/Hong_Kong"), null);
  assert.match(String(validateSchedule("cron", "0 9 * * 1-5", "Mars/Olympus")), /invalid timezone/);
  assert.equal(isValidTimezone("America/New_York"), true);
  assert.equal(isValidTimezone("nope/zone"), false);
  assert.equal(formatInTz(Date.parse("2026-12-01T01:00:00Z"), "Asia/Hong_Kong"), "2026-12-01T09:00:00+08:00");
  // interval durations are tz-free by construction
  assert.equal(nextFire("interval", "1h", from, "Asia/Hong_Kong"), from + 3_600_000);
});

// --- store claim + ownership --------------------------------------------------

test("cron store: claim is exclusive and advances the slot", () => {
  const store = tempStore();
  const job = store.createCronJob(makeJob());
  const run = store.claimCronFire(job, job.next_run_at as number, (job.next_run_at as number) + 3_600_000, randomUUID());
  assert.ok(run);
  assert.equal(run.status, "claimed");
  // A concurrent claim for the same slot is refused.
  assert.equal(store.claimCronFire(job, job.next_run_at as number, null, randomUUID()), null);
  assert.equal(store.getCronJobById(job.id)?.next_run_at, (job.next_run_at as number) + 3_600_000);
  // Ownership: another user cannot see or claim by name.
  assert.equal(store.getCronJobForUser("bob", "daily-brief"), null);
  assert.equal(store.getCronJobForUser("alice", "daily-brief")?.id, job.id);
});

// --- scheduler ----------------------------------------------------------------

test("cron scheduler: due job fires, persists a session, advances the slot", async () => {
  const store = tempStore();
  const job = store.createCronJob(makeJob());
  const fired: string[] = [];
  const scheduler = new CronScheduler({
    store,
    loop: {} as never,
    now: () => Date.now(),
    execute: async (_store, _loop, _mirror, j) => {
      fired.push(j.name);
      // simulate the real persistence contract
      const sid = j.session_id ?? store.newSessionId();
      store.updateCronJob(j.id, { session_id: sid });
      store.appendTurn(sid, [
        { role: "user", content: j.payload },
        { role: "assistant", content: "brief done" },
      ]);
      return {
        sessionId: sid, failed: false, iterations: 1,
        usage: { prompt_tokens: 10, completion_tokens: 5 }, excerpt: "brief done",
      };
    },
  });
  scheduler.tick();
  await waitFor(() => fired.length === 1);
  const after = store.getCronJobById(job.id) as CronJobRow;
  assert.equal(after.last_status, "ok");
  assert.equal(after.failure_streak, 0);
  assert.equal(after.next_run_at, (job.next_run_at as number) + 3_600_000);
  const runs = store.listCronRuns(job.id, 5);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, "completed");
  assert.equal(runs[0].result_excerpt, "brief done");
  // The fire ran in the owner's ALS scope: the session is owned by alice, so
  // reading it as another user returns nothing (ownership scoping works).
  assert.equal(after.session_id ? store.loadSession(after.session_id).length : -1, 0);
  const session = after.session_id
    ? runInWorkspace("alice", () => store.loadSession(after.session_id as string))
    : [];
  assert.equal(session.length, 2);
  // The sidebar list tags the session with its owning cron job (Phase 2 UI).
  const listed = store.listSessions("alice").find((s) => s.session_id === after.session_id);
  assert.equal(listed?.cron_name, "daily-brief");
  assert.equal(session[0].role, "user");
});

test("cron scheduler: fire while previous run is active records a skip", async () => {
  const store = tempStore();
  const job = store.createCronJob(makeJob({ schedule_expr: "1m" }));
  store.insertCronRun({
    id: randomUUID(), job_id: job.id, session_id: null, fire_at: Date.now(),
    started_at: Date.now(), finished_at: null, status: "running",
    iterations: null, prompt_tokens: null, completion_tokens: null, error: null, result_excerpt: null,
  });
  let executed = 0;
  const scheduler = new CronScheduler({
    store, loop: {} as never, now: () => Date.now(),
    execute: async () => { executed++; return { sessionId: "s", failed: false, iterations: 0, usage: { prompt_tokens: 0, completion_tokens: 0 }, excerpt: "" }; },
  });
  scheduler.tick();
  const runs = store.listCronRuns(job.id, 5);
  assert.equal(executed, 0);
  assert.equal(runs.filter((r) => r.status === "skipped").length, 1);
  assert.ok((store.getCronJobById(job.id)?.next_run_at ?? 0) > Date.now()); // advanced past the skipped slot
});

test("cron scheduler: failures streak and auto-pause at the threshold", async () => {
  const store = tempStore();
  const job = store.createCronJob(makeJob({ failure_streak: 4 })); // one more failure pauses
  const scheduler = new CronScheduler({
    store, loop: {} as never, now: () => Date.now(),
    execute: async () => { throw new Error("provider down"); },
  });
  const run = store.claimCronFire(job, Date.now(), Date.now() + 60_000, randomUUID());
  if (!run) throw new Error("claim failed");
  await scheduler.fire(job, run);
  const after = store.getCronJobById(job.id) as CronJobRow;
  assert.equal(after.enabled, 0); // auto-paused at streak 5
  assert.equal(after.failure_streak, 5);
  assert.match(after.last_error ?? "", /auto-paused/);
  const runs = store.listCronRuns(job.id, 5);
  assert.equal(runs[0].status, "failed");
});

test("cron scheduler: one-shot jobs disable themselves after the fire", async () => {
  const store = tempStore();
  const job = store.createCronJob(makeJob({ schedule_kind: "once", schedule_expr: new Date(Date.now() - 1000).toISOString() }));
  const scheduler = new CronScheduler({
    store, loop: {} as never, now: () => Date.now(),
    execute: async () => ({ sessionId: "s", failed: false, iterations: 0, usage: { prompt_tokens: 0, completion_tokens: 0 }, excerpt: "one-shot done" }),
  });
  const run = store.claimCronFire(job, Date.now(), null, randomUUID());
  assert.ok(run);
  await scheduler.fire(job, run as NonNullable<typeof run>);
  const after = store.getCronJobById(job.id) as CronJobRow;
  assert.equal(after.enabled, 0); // single fire done, history stays visible
  assert.equal(after.last_status, "ok");
});

test("cron scheduler: boot reconciliation catches up once and interrupts dead runs", () => {
  const store = tempStore();
  const overdue = store.createCronJob(makeJob({ name: "overdue", next_run_at: Date.now() - 5 * 60_000 })); // within grace
  const farMissed = store.createCronJob(
    makeJob({ name: "far-missed", schedule_kind: "once", schedule_expr: new Date(Date.now() - 3 * 3_600_000).toISOString(), next_run_at: Date.now() - 3 * 3_600_000 }),
  );
  const staleJob = store.createCronJob(makeJob({ name: "stale" }));
  const staleRunId = randomUUID();
  store.claimCronFire(staleJob, Date.now(), Date.now() + 60_000, staleRunId);
  const { interrupted, catchups } = new CronScheduler({ store, loop: {} as never }).reconcile();
  assert.equal(interrupted, 1);
  assert.equal(store.listCronRuns(staleJob.id, 5)[0].status, "interrupted");
  // overdue caught up: re-anchored to "now" (fires on the next tick)
  assert.ok(Math.abs((store.getCronJobById(overdue.id)?.next_run_at ?? 0) - Date.now()) < 5000);
  // once-job missed beyond grace: disabled, no surprise fire
  const after = store.getCronJobById(farMissed.id) as CronJobRow;
  assert.equal(after.enabled, 0);
  assert.equal(after.last_status, "skipped");
  assert.equal(catchups >= 1, true);
});

// --- tool ---------------------------------------------------------------------

test("cron scheduler: fires run inside the scheduled-run scope (loop guard)", async () => {
  const store = tempStore();
  const job = store.createCronJob(makeJob());
  let inScope: boolean | null = null;
  const scheduler = new CronScheduler({
    store, loop: {} as never, now: () => Date.now(),
    execute: async () => {
      inScope = isScheduledRun();
      return { sessionId: "s", failed: false, iterations: 0, usage: { prompt_tokens: 0, completion_tokens: 0 }, excerpt: "" };
    },
  });
  const run = store.claimCronFire(job, Date.now(), null, randomUUID());
  if (!run) throw new Error("claim failed");
  await scheduler.fire(job, run);
  assert.equal(inScope, true);
  assert.equal(isScheduledRun(), false); // scope ends with the fire
});

test("cron execute: per-job max_iterations and scheduled wrap-up margin reach runTurn", async () => {
  const store = tempStore();
  const job = store.createCronJob(makeJob({ max_iterations: 55 }));
  let captured: any = null;
  let midTurnRegistered: boolean | null = null;
  const stubLoop: any = {
    runTurn: async (_history: unknown[], _input: string, _stop: unknown, meta: Record<string, unknown>) => {
      captured = meta;
      // The job session is registered at fire START — "Open session" works
      // while the run is still in flight (mid-turn, zero turns persisted).
      midTurnRegistered = store.ownsSession(String(meta.sessionId));
      return {
        messages: [{ role: "assistant", content: "done" }],
        iterations: 1,
        fatal: undefined,
        cancelled: false,
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      };
    },
  };
  const run = store.claimCronFire(job, Date.now(), null, randomUUID());
  if (!run) throw new Error("claim failed");
  await runInWorkspace("alice", () => executeCronJob(store, stubLoop, null, job, run));
  assert.ok(captured);
  assert.equal(captured!.maxIterations, 55);
  assert.equal(captured!.wrapupRemaining, 10);
  // session created lazily: meta carries the new id and the job row persists it
  assert.equal(typeof captured!.sessionId, "string");
  assert.equal(store.getCronJobById(job.id)?.session_id, captured!.sessionId);
  assert.equal(midTurnRegistered, true);
});

test("cron tool: create/list/get are user-scoped and validate input", async () => {
  const store = tempStore();
  const scheduler = new CronScheduler({ store, loop: {} as never });
  const tool = createCronManageTool(store, scheduler);

  const created = JSON.parse(
    String(
      await runInWorkspace("alice", () =>
        tool.execute({ action: "create", name: "brief", schedule_kind: "interval", schedule_expr: "1h", payload: "do the thing" }, {}),
      ),
    ),
  );
  assert.equal(created.ok, true);
  assert.equal(created.next_runs.length, 2);

  // duplicate name is rejected; so is a bad schedule
  const dup = await runInWorkspace("alice", () =>
    tool.execute({ action: "create", name: "brief", schedule_kind: "interval", schedule_expr: "1h", payload: "x" }, {}),
  );
  assert.match(String(dup), /already exists/);
  const bad = await runInWorkspace("alice", () =>
    tool.execute({ action: "create", name: "bad", schedule_kind: "cron", schedule_expr: "99 * * * *", payload: "x" }, {}),
  );
  assert.match(String(bad), /invalid cron expression/);

  // bob has an empty list; name addressing is per user
  const bobList = JSON.parse(String(await runInWorkspace("bob", () => tool.execute({ action: "list" }, {}))));
  assert.deepEqual(bobList.jobs, []);
  const bobGet = await runInWorkspace("bob", () => tool.execute({ action: "get", name: "brief" }, {}));
  assert.match(String(bobGet), /no scheduled job/);

  const list = JSON.parse(String(await runInWorkspace("alice", () => tool.execute({ action: "list" }, {}))));
  assert.equal(list.jobs.length, 1);
  assert.equal(list.jobs[0].schedule, "every 1h");
});

test("cron tool: run-now goes through the claim path", async () => {
  const store = tempStore();
  const scheduler = new CronScheduler({
    store, loop: {} as never, now: () => Date.now(),
    execute: async () => ({ sessionId: "s", failed: false, iterations: 0, usage: { prompt_tokens: 0, completion_tokens: 0 }, excerpt: "" }),
  });
  const tool = createCronManageTool(store, scheduler);
  await runInWorkspace("alice", () =>
    tool.execute({ action: "create", name: "j", schedule_kind: "once", schedule_expr: "in 1h", payload: "p" }, {}),
  );
  const out = JSON.parse(String(await runInWorkspace("alice", () => tool.execute({ action: "run", name: "j" }, {}))));
  assert.equal(out.ok, true);
  await waitFor(() => store.listCronRuns(store.getCronJobForUser("alice", "j")?.id ?? "", 1).length === 1);
  const runs = store.listCronRuns(store.getCronJobForUser("alice", "j")?.id ?? "", 5);
  assert.equal(runs[0].status, "completed");
});

// --- helpers ------------------------------------------------------------------

function waitFor(cond: () => boolean, ms = 2000): Promise<boolean> {
  const end = Date.now() + ms;
  return (async () => {
    while (Date.now() < end) {
      if (cond()) return true;
      await new Promise((r) => setTimeout(r, 20));
    }
    return cond();
  })();
}
