// One scheduled fire = one ordinary agent turn in the owning user's context.
// The scheduler calls this inside runInWorkspace(user) + the scheduled-run ALS
// flag, so workspace/tools/memory and the loop-guard policy all resolve here.
// Persistence mirrors the /api/chat route: provider-valid prefix only, user
// row prepended, semantic mirror recorded, fallback title on the first turn.

import { validPrefixLen } from "../agent.js";
import { fallbackTitle } from "../titler.js";
import { CRON_WRAPUP_REMAINING } from "../config.js";
import type { AgentLoop } from "../agent.js";
import type { AgentDbMirror } from "../agentdb-mirror.js";
import type { CronJobRow, CronRunRow, SQLiteSessionStore } from "../store.js";

export interface CronFireResult {
  sessionId: string;
  failed: boolean;
  error?: string;
  iterations: number;
  usage: { prompt_tokens: number; completion_tokens: number };
  /** Last assistant message, first 500 chars — the UI run history. */
  excerpt: string;
}

export async function executeCronJob(
  store: SQLiteSessionStore,
  loop: AgentLoop,
  mirror: AgentDbMirror | null,
  job: CronJobRow,
  _run: CronRunRow,
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

  const turn = await loop.runTurn(
    [],
    job.payload,
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
      { role: "user", content: job.payload },
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

  return {
    sessionId,
    failed: Boolean(turn.fatal),
    error: turn.fatal,
    iterations: turn.iterations,
    usage: turn.usage,
    excerpt: (lastAssistant?.content ?? "").slice(0, 500),
  };
}
