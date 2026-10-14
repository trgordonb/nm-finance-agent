// Shared helpers for the deep research engine: prompt filling, JSON
// extraction (the Python original's code-fence-stripping parse + fallback
// pattern), date formatting, usage accounting, and stop/deadline checks.

import { ResearchCancelled, type ResearchDeps, type ResearchUsage } from "./types.js";

/** Today's date in the Python original's format: "Wed Oct 14, 2026". */
export function getTodayStr(): string {
  const d = new Date();
  const wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getDay()] ?? "";
  const mo =
    ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][
      d.getMonth()
    ] ?? "";
  return `${wd} ${mo} ${d.getDate()}, ${d.getFullYear()}`;
}

/** Fill `{key}` placeholders; unknown placeholders stay untouched. */
export function fillPrompt(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : match,
  );
}

/** Parse a JSON object out of a model response, tolerating ```json fences.
 *  Returns undefined when the payload is not JSON (callers fall back to the
 *  raw text — parity with the Python `except json.JSONDecodeError` paths). */
export function extractJson<T = Record<string, unknown>>(text: string): T | undefined {
  let t = text.trim();
  if (t.startsWith("```json")) t = t.slice(7);
  else if (t.startsWith("```")) t = t.slice(3);
  if (t.endsWith("```")) t = t.slice(0, -3);
  t = t.trim();
  try {
    return JSON.parse(t) as T;
  } catch {
    return undefined;
  }
}

/** Accumulate provider usage onto a running total. */
export function addUsage(
  total: ResearchUsage,
  usage?: { prompt_tokens?: number; completion_tokens?: number },
): void {
  total.prompt_tokens += usage?.prompt_tokens ?? 0;
  total.completion_tokens += usage?.completion_tokens ?? 0;
}

export function totalTokens(usage?: { prompt_tokens?: number; completion_tokens?: number }): number {
  return (usage?.prompt_tokens ?? 0) + (usage?.completion_tokens ?? 0);
}

/** Throw ResearchCancelled when the caller asked to stop or the wall-clock
 *  deadline is exceeded — checked at every stage/tool-loop boundary. */
export function ensureNotStopped(deps: ResearchDeps): void {
  if (deps.shouldStop()) throw new ResearchCancelled("cancelled by caller");
  if (deps.limits.deadlineMs > 0 && Date.now() - deps.startedAt > deps.limits.deadlineMs) {
    throw new ResearchCancelled("research deadline exceeded");
  }
}
