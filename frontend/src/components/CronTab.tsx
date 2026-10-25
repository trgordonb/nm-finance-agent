// Scheduled view (docs/agent-cron-plan.md §9): the user's agent-cron jobs as
// cards — schedule, next fire, last status, actions (run now / pause / resume
// / edit / delete) — with expandable per-job run histories that link into the
// job's session. Polls GET /api/cron/jobs every 5 s while mounted.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  getCronJobRuns,
  getCronJobs,
  createCronJob,
  patchCronJob,
  runCronJobNow,
  deleteCronJob,
} from "../api";
import type { CronJobInfo, CronRunInfo } from "../types";

function fmtMs(ms: number): string {
  return new Date(ms).toLocaleString();
}

function countdown(ms: number | null): string {
  if (ms === null) return "—";
  const diff = ms - Date.now();
  if (diff <= 0) return "due";
  const m = Math.round(diff / 60_000);
  if (m < 60) return `in ${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `in ${h}h ${m % 60}m`;
  return `in ${Math.round(h / 24)}d`;
}

function duration(started: number | null, finished: number | null): string {
  if (started === null) return "—";
  const end = finished ?? Date.now();
  const s = Math.max(0, Math.round((end - started) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

const STATUS_TONE: Record<string, string> = {
  ok: "ok",
  completed: "ok",
  error: "err",
  failed: "err",
  skipped: "dim",
  interrupted: "dim",
  running: "live",
};

interface Props {
  onOpenSession: (sessionId: string) => void;
}

export default function CronTab({ onOpenSession }: Props) {
  const [jobs, setJobs] = useState<CronJobInfo[] | null>(null);
  const [serverTz, setServerTz] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [runs, setRuns] = useState<Record<string, CronRunInfo[]>>({});
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [busy, setBusy] = useState(false);
  const jobsRef = useRef<CronJobInfo[] | null>(null);

  const load = useCallback(() => {
    getCronJobs()
      .then((d) => {
        setJobs(d.jobs);
        setServerTz(d.server_timezone);
        setError(null);
      })
      .catch((e) => setError(String(e instanceof Error ? e.message : e).slice(0, 160)));
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);

  const act = useCallback(
    async (fn: () => Promise<unknown>) => {
      setBusy(true);
      try {
        await fn();
        load();
      } catch (e) {
        setError(String(e instanceof Error ? e.message : e).slice(0, 160));
      } finally {
        setBusy(false);
      }
    },
    [load],
  );

  const expandRuns = useCallback(
    async (job: CronJobInfo) => {
      const next = !expanded[job.id];
      setExpanded((p) => ({ ...p, [job.id]: next }));
      if (next && !runs[job.id]) {
        try {
          const d = await getCronJobRuns(job.id);
          setRuns((p) => ({ ...p, [job.id]: d.runs }));
        } catch {
          setRuns((p) => ({ ...p, [job.id]: [] }));
        }
      }
    },
    [expanded, runs],
  );

  const anyRunning = (jobs ?? []).some((j) => j.running);
  jobsRef.current = jobs;

  return (
    <main className="skills">
      <div className="skills-inner cron">
        <div className="skills-head">
          <h2>Scheduled jobs</h2>
          <button className="cron-new" onClick={() => setEditing(editing === "new" ? null : "new")}>
            + New job
          </button>
        </div>
        <div className="cron-sub">
          Jobs run in their own session with this exact prompt, on this machine's clock.
        </div>
        {anyRunning && (
          <div className="cron-live" aria-label="scheduled run active">
            <span className="research-strip-dot" /> a scheduled job is running — its output lands
            in its session below
          </div>
        )}
        {error && <div className="cron-err">{error}</div>}
        {jobs === null && <div className="session-empty">loading…</div>}
        {jobs !== null && jobs.length === 0 && editing === null && (
          <div className="session-empty">
            No scheduled jobs yet — ask the agent in chat (“check AAPL every weekday at 9am, auto-run
            mode”) or create one here.
          </div>
        )}
        {editing === "new" && (
          <CronForm
            serverTz={serverTz}
            onCancel={() => setEditing(null)}
            onSaved={() => {
              setEditing(null);
              load();
            }}
          />
        )}
        {(jobs ?? []).map((job) =>
          editing === job.id ? (
            <CronForm
              key={job.id}
              job={job}
              serverTz={serverTz}
              onCancel={() => setEditing(null)}
              onSaved={() => {
                setEditing(null);
                load();
              }}
            />
          ) : (
            <div className={`cron-card${job.enabled ? "" : " paused"}`} key={job.id}>
              <div className="cron-card-head">
                <span className="cron-name" title={job.id}>
                  {job.name}
                </span>
                <span className={`cron-chip ${STATUS_TONE[job.last_status ?? "dim"] ?? "dim"}`}>
                  {job.running ? "running" : (job.last_status ?? job.enabled ? "idle" : "paused")}
                </span>
                <span className="cron-chip dim">{job.failure_streak > 0 ? `${job.failure_streak}× failed` : ""}</span>
              </div>
              <div className="cron-meta">
                <span className="cron-schedule">
                  {job.schedule_kind === "cron" ? `cron ${job.schedule_expr}` : job.schedule_kind === "interval" ? `every ${job.schedule_expr}` : `once · ${job.schedule_expr}`}
                </span>
                <span>next {countdown(job.next_run_at)}</span>
                {job.last_run_at !== null && <span>last {fmtMs(job.last_run_at)}</span>}
                <span>tz: {job.timezone || serverTz || "server"}</span>
              </div>
              <div className="cron-payload" title={job.payload}>
                {job.payload}
              </div>
              {job.last_error && <div className="cron-err">⚠ {job.last_error}</div>}
              <div className="cron-actions">
                <button disabled={busy} onClick={() => act(() => runCronJobNow(job.id))}>
                  Run now
                </button>
                <button
                  disabled={busy}
                  onClick={() => act(() => patchCronJob(job.id, { action: job.enabled ? "pause" : "resume" }))}
                >
                  {job.enabled ? "Pause" : "Resume"}
                </button>
                <button disabled={busy} onClick={() => setEditing(job.id)}>
                  Edit
                </button>
                <button
                  disabled={busy}
                  className="cron-danger"
                  onClick={() => {
                    if (window.confirm(`Delete scheduled job "${job.name}"? Its session and history stay.`)) {
                      void act(() => deleteCronJob(job.id));
                    }
                  }}
                >
                  Delete
                </button>
                {job.session_id && (
                  <button className="cron-link" onClick={() => onOpenSession(job.session_id as string)}>
                    Open session →
                  </button>
                )}
                <button className="cron-link" onClick={() => void expandRuns(job)}>
                  {expanded[job.id] ? "Hide runs" : "Run history"}
                </button>
              </div>
              {expanded[job.id] && (
                <div className="cron-runs">
                  {(runs[job.id] ?? []).length === 0 && <div className="session-empty">no runs recorded yet</div>}
                  {(runs[job.id] ?? []).map((r) => (
                    <div className="cron-run" key={r.id}>
                      <span className={`cron-chip ${STATUS_TONE[r.status] ?? "dim"}`}>{r.status}</span>
                      <span className="cron-run-when">{fmtMs(r.fire_at)}</span>
                      <span className="cron-run-dur">{duration(r.started_at, r.finished_at)}</span>
                      {r.iterations !== null && <span className="cron-run-dur">{r.iterations} iter</span>}
                      {r.result_excerpt && (
                        <span className="cron-run-excerpt" title={r.result_excerpt}>
                          {r.result_excerpt}
                        </span>
                      )}
                      {r.error && <span className="cron-run-excerpt err">{r.error}</span>}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ),
        )}
      </div>
    </main>
  );
}

/** Create / edit form. `job` absent → create mode (name field shown). */
function CronForm({
  job,
  serverTz,
  onSaved,
  onCancel,
}: {
  job?: CronJobInfo;
  serverTz?: string;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(job?.name ?? "");
  const [kind, setKind] = useState<string>(job?.schedule_kind ?? "interval");
  const [expr, setExpr] = useState(job?.schedule_expr ?? "24h");
  const [timezone, setTimezone] = useState(job?.timezone ?? "");
  const [payload, setPayload] = useState(job?.payload ?? "");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      const tz = timezone.trim() || null;
      if (job) {
        await patchCronJob(job.id, { schedule_kind: kind, schedule_expr: expr, payload, timezone: tz });
      } else {
        await createCronJob({ name, schedule_kind: kind, schedule_expr: expr, payload, timezone: tz });
      }
      onSaved();
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e).slice(0, 200));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="cron-card cron-form">
      <div className="cron-form-row">
        {!job && (
          <input
            placeholder="job name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            aria-label="Job name"
          />
        )}
        <select value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Schedule kind">
          <option value="interval">every…</option>
          <option value="cron">cron expression</option>
          <option value="once">once</option>
        </select>
        <input
          placeholder={kind === "cron" ? "0 9 * * 1-5" : kind === "once" ? "2026-12-01T09:00:00" : "24h"}
          value={expr}
          onChange={(e) => setExpr(e.target.value)}
          aria-label="Schedule expression"
        />
        <input
          placeholder={`tz (server: ${serverTz || "?"})`}
          value={timezone}
          onChange={(e) => setTimezone(e.target.value)}
          aria-label="IANA timezone"
          title="IANA timezone the schedule's times are interpreted in — e.g. Asia/Hong_Kong. Empty = server timezone."
        />
      </div>
      <textarea
        placeholder="The prompt each fire executes — self-contained: the run has no memory of this chat (reference skills by name, e.g. 'use the stock-price-mover skill in auto-run mode for AAPL')"
        value={payload}
        onChange={(e) => setPayload(e.target.value)}
        rows={4}
        aria-label="Job payload"
      />
      {err && <div className="cron-err">{err}</div>}
      <div className="cron-actions">
        <button disabled={busy || !payload.trim() || (!job && !name.trim())} onClick={() => void submit()}>
          {job ? "Save" : "Create"}
        </button>
        <button onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}
