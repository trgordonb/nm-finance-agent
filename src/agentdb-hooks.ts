// AgentDB cognitive-memory hooks (Gate-1 escalation, python main.py port):
//   B) session-end — the nudge gains reflexion_store + skill_create bindings
//      so the curation loop persists structured episodes (never archived).
//   C) pre-flight — episode recall: the runtime retrieves similar prior
//      episodes per user turn and injects `<episode_context>` into the
//      system prompt (traces showed the model never calls reflexion_retrieve
//      itself — session_search always wins the retrieval habit). Live per
//      turn with a one-slot cache keyed by the user message.
//
// Similarity gating: parse "Similarity: x.x" markers out of the retrieve
// output (agentdb reflexion_retrieve format); below-threshold recall is a
// silent no-injection. All calls are no-throw — episodes never break turns.

import type { ToolDef } from "./types.js";
import { log } from "./logger.js";

export const NUDGE_AGENTDB_TOOLS = (process.env.NUDGE_AGENTDB_TOOLS ?? "reflexion_store,skill_create")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

export const AGENTDB_RECALL_K = Number(process.env.AGENTDB_RECALL_K ?? "3");
export const AGENTDB_RECALL_MIN_SIMILARITY = Number(process.env.AGENTDB_RECALL_MIN_SIMILARITY ?? "0.35");

/** Gate-1 escalation B: which bound MCP tools the nudge may write through. */
export function cognitiveNudgeTools(registry: Map<string, ToolDef>): ToolDef[] {
  const wanted = new Set(NUDGE_AGENTDB_TOOLS);
  const out: ToolDef[] = [];
  for (const [name, tool] of registry) {
    if (wanted.has(name)) out.push(tool);
  }
  return out;
}

/** Parse "Similarity: x.x" markers (agentdb reflexion_retrieve format). */
export function parseSimilarities(raw: string): number[] {
  const out: number[] = [];
  for (const m of raw.matchAll(/Similarity:\s*([0-9.]+)/g)) {
    const v = Number(m[1]);
    if (Number.isFinite(v)) out.push(v);
  }
  return out;
}

/** Gate-1 escalation C: the pre-flight episode-recall block ("" when the
 *  recall is disabled, fails, or nothing clears the similarity threshold). */
export async function episodeRecallContext(
  task: string,
  epTool: ToolDef | null,
  opts: { k?: number; minSim?: number } = {},
): Promise<string> {
  if (process.env.AGENTDB_RECALL_ENABLED === "0") return "";
  if (!epTool) return "";
  const k = opts.k ?? AGENTDB_RECALL_K;
  const minSim = opts.minSim ?? AGENTDB_RECALL_MIN_SIMILARITY;
  let raw = "";
  try {
    raw = String(await epTool.execute({ task, k })).trim();
  } catch (e) {
    log.warn(`reflexion_retrieve failed: ${String(e).slice(0, 150)}`);
    return "";
  }
  const sims = parseSimilarities(raw);
  if (!sims.length || Math.max(...sims) < minSim) return "";
  log.info(`episode recall: ${sims.length} episode(s), max similarity ${Math.max(...sims).toFixed(2)}`);
  return (
    "<episode_context>\n" +
    "Reflexion episodes from the agentdb store resemble this request — higher " +
    "similarity means closer prior experience; heed their critiques when " +
    `choosing an approach:\n${raw}\n` +
    "</episode_context>\n"
  );
}

/** One-slot cache (python `_episode_recall_cache`): the newest user message
 *  is the key, so mid-turn model calls reuse the same block. */
export class EpisodeRecallCache {
  private key: string | null = null;
  private block = "";

  get(task: string | null): string | null {
    if (task === null || this.key !== task) return null;
    return this.block;
  }

  set(task: string, block: string): void {
    this.key = task;
    this.block = block;
  }
}

/** The python Gate-1 teaching block: instructs the model on the agentdb
 *  cognitive-memory surface (python main.py verbatim). Empty unless the
 *  reflexion_store tool is bound. */
export function agentdbCognitiveBlock(hasReflexionStore: boolean): string {
  if (!hasReflexionStore) return "";
  return (
    "\nAGENTDB COGNITIVE MEMORY (experimental, self-learning):\n" +
    "The reflexion_store / reflexion_retrieve / agentdb_pattern_store / " +
    "agentdb_pattern_search / skill_create / skill_search / reward_signal / " +
    "learning_feedback tools reach a separate bandit-tuned memory store. " +
    "Before starting a task that resembles a past episode (same site, file " +
    "type, or pipeline), call agentdb_reflexion_retrieve(task=<the task>) FIRST — " +
    "with only_failures=true when obstacles are likely — and let its " +
    "critiques shape the approach. After a turn that needed error recovery, " +
    "drew a user correction, or worked out a non-obvious workflow, persist " +
    "ONE episode via agentdb_reflexion_store(session_id=<short slug for this task>, " +
    "task phrased as a retrievable query, reward in [0,1], success, " +
    "critique) and score the outcome via reward_signal(success=...); " +
    "consult agentdb_pattern_search before retrying an approach that " +
    "failed before.\n"
  );
}
