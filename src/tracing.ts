// LangSmith tracing via the REST runs API — no SDK, no LangChain.
// POST /runs to open a run, PATCH /runs/{id} to close it with outputs/error.
// Failure semantics mirror the memory-layer doctrine: tracing must never
// break the agent turn — every call is fire-and-forget with its own
// try/catch and short timeout, and the client degrades to a no-op when the
// key is absent or disabled.

import { randomUUID } from "node:crypto";

// Load order note: config.ts already ran dotenv(override) via index.ts.
const ENABLED =
  (process.env.LANGSMITH_TRACING ?? "1") !== "0" &&
  !!(process.env.LANGSMITH_API_KEY || process.env.LANGCHAIN_API_KEY);
const BASE_URL = (process.env.LANGSMITH_BASE_URL || "https://api.smith.langchain.com").replace(/\/$/, "");
const API_KEY = process.env.LANGSMITH_API_KEY || process.env.LANGCHAIN_API_KEY || "";
export const TRACE_PROJECT = process.env.LANGCHAIN_PROJECT || "default";
const HEADERS = {
  "Content-Type": "application/json",
  "x-api-key": API_KEY,
};
const TIMEOUT_MS = Number(process.env.LANGSMITH_TIMEOUT_MS ?? "5000");

export type RunType = "chain" | "llm" | "tool";

export interface RunSpec {
  name: string;
  runType: RunType;
  inputs: Record<string, unknown>;
  parent?: string | null;
  tags?: string[];
  metadata?: Record<string, unknown>;
  sessionName?: string;
}

export function enabled(): boolean {
  return ENABLED;
}

function create(spec: RunSpec): string {
  const id = randomUUID();
  const body: Record<string, unknown> = {
    id,
    name: spec.name,
    run_type: spec.runType,
    inputs: spec.inputs,
    start_time: new Date().toISOString(),
    session_name: spec.sessionName ?? TRACE_PROJECT,
  };
  if (spec.parent) body.parent_run_id = spec.parent;
  if (spec.tags?.length) body.tags = spec.tags;
  if (spec.metadata && Object.keys(spec.metadata).length) body.extra = { metadata: spec.metadata };
  fetch(`${BASE_URL}/runs`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }).catch((e) => console.error(`[langsmith] create ${spec.name} failed: ${String(e).slice(0, 120)}`));
  return id;
}

function update(id: string, patch?: outputsLayer): void {
  const body: Record<string, unknown> = { end_time: new Date().toISOString() };
  if (patch?.outputs !== undefined) body.outputs = patch.outputs;
  if (patch?.error) body.error = patch.error;
  // Completion-time metadata (e.g. usage_metadata) — PATCHed under
  // extra.metadata, same as the SDK's runTree.metadata updates.
  if (patch?.metadata !== undefined) body.extra = { metadata: patch.metadata };
  fetch(`${BASE_URL}/runs/${id}`, {
    method: "PATCH",
    headers: HEADERS,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }).catch((e) => console.error(`[langsmith] patch ${id} failed: ${String(e).slice(0, 120)}`));
}

export interface outputsLayer {
  outputs?: Record<string, unknown>;
  error?: string;
  /** Completion-time metadata (merged by the server into extra.metadata) —
   *  e.g. usage_metadata + ls_model_name once the response is known. */
  metadata?: Record<string, unknown>;
}

/** No-op tracer preserving the create/update API shape when disabled. */
class NullTrace {
  enabled = false;
  create(_spec: RunSpec): string {
    return "";
  }
  update(_id: string, _patch?: outputsLayer): void {}
}

class LangSmithTrace {
  enabled = true;
  create(spec: RunSpec): string {
    try {
      return create(spec);
    } catch {
      return "";
    }
  }
  update(id: string, patch?: outputsLayer): void {
    if (!id) return;
    try {
      update(id, patch);
    } catch {
      /* never break the turn */
    }
  }
}

const impl = ENABLED ? new LangSmithTrace() : new NullTrace();

/** Fire-and-forget run openers/closers; ids are "" when disabled. */
export const trace = {
  enabled: () => impl.enabled,
  create: (spec: RunSpec) => impl.create(spec),
  update: (id: string, patch?: outputsLayer) => impl.update(id, patch),
};

// --- LLM payload conventions (SDK parity) ------------------------------------
// The LangSmith UI renders LLM runs from full message inputs, a
// generations-shaped outputs (with the assistant message), and
// `usage_metadata` (+ ls_provider / ls_model_name) in the run metadata for its
// token-count and cost panels. These helpers keep every call site on the same
// shapes — the enrichment verified against the official SDK's captured
// payloads (docs/deep-research-plan.md, trace-payload investigation).

export interface RunUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
}

/** Provider usage → LangSmith `usage_metadata` (undefined when zero/absent). */
export function usageMetadata(usage?: RunUsage): Record<string, number> | undefined {
  const input = usage?.prompt_tokens ?? 0;
  const output = usage?.completion_tokens ?? 0;
  if (!input && !output) return undefined;
  return { input_tokens: input, output_tokens: output, total_tokens: input + output };
}

/** LLM-run metadata: model identity + usage (drives token/cost panels). */
export function llmRunMetadata(model: string, usage?: RunUsage): Record<string, unknown> {
  const metadata: Record<string, unknown> = { ls_provider: "openrouter", ls_model_name: model };
  const tokens = usageMetadata(usage);
  if (tokens) metadata.usage_metadata = tokens;
  return metadata;
}

/** LLM-run outputs: a generations entry carrying the assistant message, plus
 *  usage_metadata at the outputs level (the SDK sends it in both places). */
export function llmRunOutputs(
  text: string,
  opts?: { usage?: RunUsage; message?: Record<string, unknown> },
): Record<string, unknown> {
  const outputs: Record<string, unknown> = {
    generations: [{ text, ...(opts?.message ? { message: opts.message } : {}) }],
  };
  const tokens = usageMetadata(opts?.usage);
  if (tokens) outputs.usage_metadata = tokens;
  return outputs;
}
