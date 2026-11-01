// One scheduled fire = one ordinary agent turn in the owning user's context.
// The scheduler calls this inside runInWorkspace(user) + the scheduled-run ALS
// flag, so workspace/tools/memory and the loop-guard policy all resolve here.
// Persistence mirrors the /api/chat route: provider-valid prefix only, user
// row prepended, semantic mirror recorded, fallback title on the first turn.

import { validPrefixLen } from "../agent.js";
import { cleanupSessionSandboxes } from "../instabox.js";
import { fallbackTitle } from "../titler.js";
import { CRON_WRAPUP_REMAINING } from "../config.js";
import fs from "node:fs";
import path from "node:path";
import type { AgentLoop } from "../agent.js";
import type { AgentDbMirror } from "../agentdb-mirror.js";
import type { CronJobRow, CronRunRow, SQLiteSessionStore } from "../store.js";
import { currentWorkspaceRoot } from "../workspace.js";

export interface CronFireResult {
  sessionId: string;
  failed: boolean;
  error?: string;
  iterations: number;
  usage: { prompt_tokens: number; completion_tokens: number };
  /** Last assistant message, first 500 chars — the UI run history. */
  excerpt: string;
  /** Full final assistant message — archived verbatim in report.md. */
  response: string;
  /** Workspace-relative report path (response + artifact pointers) — the
   *  wiki-ingest entry point for this fire. */
  report_path?: string;
}

function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "job";
}

/** Deterministic per-fire folder in the owner's workspace: the payload gets
 *  a Run-logistics block pointing here, and report.md lands here after the
 *  turn — response + pointers to everything the fire produced. */
export function runFolderFor(jobName: string, runId: string, fireAt: number): string {
  const day = new Date(fireAt).toISOString().slice(0, 10);
  return path.join("cron", sanitizeName(jobName), `${day}-${runId.slice(0, 8)}`);
}

/** Append the per-fire logistics block to the job payload (Hermes "Run
 *  Context" parity): where artifacts go, what this run is, where the report
 *  will appear. The fire reads it as part of its own prompt. */
function withLogistics(payload: string, job: CronJobRow, run: CronRunRow, runFolder: string): string {
  return (
    payload.trim() +
    `\n\n---\n\n## Run logistics (appended by the harness)\n` +
    `- Job: ${job.name} (${job.schedule_kind} ${job.schedule_expr}${job.timezone ? `, ${job.timezone}` : ""})\n` +
    `- Run id: ${run.id}\n` +
    `- Save every artifact under the workspace folder: \`${runFolder}/artifacts/\` (create it if needed).\n` +
    `- When you finish, the harness archives your final response at \`${runFolder}/report.md\` and links the artifacts from there — mention anything the reader should open.`
  );
}

/** Write report.md: full harness response + metadata + artifact pointers. */
function writeRunReport(
  job: CronJobRow,
  run: CronRunRow,
  runFolder: string,
  result: CronFireResult,
): string | null {
  try {
    const root = currentWorkspaceRoot();
    const absDir = path.join(root, runFolder);
    fs.mkdirSync(absDir, { recursive: true });
    const fmt = (ms: number | null | undefined) =>
      ms ? new Date(ms).toISOString() : "—";
    const artifactsRel = path.join(runFolder, "artifacts");
    const artifactsAbs = path.join(root, artifactsRel);
    const files: string[] = [];
    const walk = (dir: string, depth: number) => {
      if (depth > 3 || files.length >= 50) return;
      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        const rel = path.join(dir, e.name);
        if (e.isDirectory()) walk(rel, depth + 1);
        else {
          let size = 0;
          try {
            size = fs.statSync(rel).size;
          } catch {
            /* raced */
          }
          files.push(`- \`${path.relative(root, rel)}\` (${(size / 1024).toFixed(1)} KB)`);
        }
      }
    };
    if (fs.existsSync(artifactsAbs)) walk(artifactsAbs, 0);
    const artifactSection = files.length
      ? files.join("\n")
      : "_no files under the run artifact folder — the response above names whatever was produced_";

    const report = [
      "---",
      `job: ${job.name}`,
      `run: ${run.id}`,
      `session: ${result.sessionId}`,
      `fired: ${new Date(run.fire_at).toISOString()}`,
      `finished: ${new Date().toISOString()}`,
      `status: ${result.failed ? "failed" : "completed"}`,
      `usage: ${result.usage.prompt_tokens} prompt / ${result.usage.completion_tokens} completion tokens`,
      "---",
      "",
      "# Run response",
      "",
      result.response?.trim() || "(empty final response)",
      "",
      "# Artifacts",
      "",
      artifactSection,
      "",
      "# Pointers",
      "",
      `- Job session: \`${result.sessionId}\` — open it from the Scheduled view (this fire's full turn).`,
      `- Run folder: \`${runFolder}/\` (workspace-relative).`,
      `- Job: ${job.name} · schedule ${job.schedule_kind} ${job.schedule_expr}${job.timezone ? ` (${job.timezone})` : ""}.`,
      "",
    ].join("\n");
    const reportPath = path.join(absDir, "report.md");
    fs.writeFileSync(reportPath, report, { encoding: "utf8", mode: 0o600 });
    return path.join(runFolder, "report.md");
  } catch (e) {
    console.error(`[cron] report.md write failed for ${job.name}: ${String((e as Error).message).slice(0, 160)}`);
    return null;
  }
}

export async function executeCronJob(
  store: SQLiteSessionStore,
  loop: AgentLoop,
  mirror: AgentDbMirror | null,
  job: CronJobRow,
  run: CronRunRow,
): Promise<CronFireResult> {
  // Lazy job session: created on first fire, reused for every later run so the
  // user can open one thread and read everything the job ever did. Registered
  // in the archive immediately (empty) — "Open session" must work mid-run, and
  // appendTurn registers only at completion.
  let sessionId = job.session_id ?? store.newSessionId();
  if (sessionId !== job.session_id) {
    store.registerSession(sessionId);
    store.updateCronJob(job.id, { session_id: sessionId });
  }

  // Per-fire run folder + logistics block appended to the payload: the fire
  // learns where artifacts go and where its response will be archived.
  const runFolder = runFolderFor(job.name, run.id, run.fire_at);
  const payload = withLogistics(job.payload, job, run, runFolder);

  const turn = await loop.runTurn(
    [],
    payload,
    () => false,
    {
      sessionId,
      // Per-job budget (the agent may set a tighter cap at create time) and a
      // wider wrap-up margin than chat: unattended runs must land gracefully,
      // persisting state, instead of dying at the hard cap mid-step.
      maxIterations: job.max_iterations ?? undefined,
      wrapupRemaining: CRON_WRAPUP_REMAINING,
    },
  );

  const valid = turn.cancelled ? validPrefixLen(turn.messages) : turn.messages.length;
  const persistable = turn.messages.slice(0, valid);
  if (persistable.length >= 1) {
    const turnNumber = store.appendTurn(sessionId, [
      { role: "user", content: payload },
      ...persistable,
    ]);
    if (mirror) {
      void mirror.recordTurn(sessionId, turnNumber, persistable).catch(() => undefined);
    }
    try {
      if (store.getSessionTitle(sessionId) === null) {
        store.setSessionTitle(sessionId, fallbackTitle(job.payload), "fallback");
      }
    } catch {
      /* cosmetic */
    }
  }

  const lastAssistant = [...turn.messages]
    .reverse()
    .find((m) => m.role === "assistant" && m.content.trim());

  const result: CronFireResult = {
    sessionId,
    failed: Boolean(turn.fatal),
    error: turn.fatal,
    iterations: turn.iterations,
    usage: turn.usage,
    excerpt: (lastAssistant?.content ?? "").slice(0, 500),
    response: lastAssistant?.content ?? "",
  };

  // report.md: full response + artifact pointers — the wiki-ingest entry.
  const reportPath = writeRunReport(job, run, runFolder, result);
  if (reportPath) result.report_path = reportPath;

  // Session-spawned sandboxes die with the fire (artifacts were pulled or
  // remain reproducible from the snapshot).
  void cleanupSessionSandboxes(sessionId);

  return result;
}
