// Schedule parsing/advancement for agent cron (docs/agent-cron-plan.md §5).
// Three kinds: 'cron' (5-field expression via cron-parser), 'interval'
// (Nd/Nh/Nm or bare minutes), 'once' (ISO timestamp or `in <delay>`).
// Natural-language input ("every weekday 9am") is normalized to one of these
// by the calling model at create time; the tool echoes the computed next
// fires so the model can confirm the interpretation in the same turn.

import { CronExpressionParser } from "cron-parser";

export type ScheduleKind = "cron" | "interval" | "once";

export const SCHEDULE_KINDS: readonly ScheduleKind[] = ["cron", "interval", "once"];

export function isScheduleKind(v: unknown): v is ScheduleKind {
  return typeof v === "string" && (SCHEDULE_KINDS as readonly string[]).includes(v);
}

const INTERVAL_RE = /^(?:(\d+)\s*d\s*)?(?:(\d+)\s*h\s*)?(?:(\d+)\s*m\s*)?$/i;

/** Interval expression → milliseconds. Bare digits mean minutes. */
export function intervalToMs(expr: string): number | null {
  const raw = expr.trim();
  if (/^\d+$/.test(raw)) {
    const minutes = Number(raw);
    return minutes > 0 ? minutes * 60_000 : null;
  }
  const m = INTERVAL_RE.exec(raw);
  if (!m || (!m[1] && !m[2] && !m[3])) return null;
  const d = Number(m[1] ?? 0);
  const h = Number(m[2] ?? 0);
  const min = Number(m[3] ?? 0);
  const ms = ((d * 24 + h) * 60 + min) * 60_000;
  return ms > 0 ? ms : null;
}

/** `in 90m` / `in 2h` / `in 1d` relative delay → milliseconds, or null. */
export function relativeDelayToMs(expr: string): number | null {
  const m = /^in\s+(\d+)\s*(d|h|m)$/i.exec(expr.trim());
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2].toLowerCase();
  const ms = unit === "d" ? n * 86_400_000 : unit === "h" ? n * 3_600_000 : n * 60_000;
  return ms > 0 ? ms : null;
}

/** A job's IANA timezone ("Asia/Hong_Kong"); null/empty = server-local. */
export function isValidTimezone(tz: string | null | undefined): boolean {
  if (!tz) return true;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The process timezone (what an unset job timezone means) — for confirmations. */
export function serverTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

/** Offset of `tz` at instant `ms`, in ms east of UTC (two-pass DST-safe). */
function tzOffsetMs(ms: number, tz: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const get = (type: string) =>
    Number(dtf.formatToParts(new Date(ms)).find((p) => p.type === type)?.value ?? 0);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"), get("second"));
  return asUtc - ms;
}

/** Render an instant as ISO-with-offset in the job's timezone ("…T22:00:00+08:00"). */
export function formatInTz(ms: number, tz: string | null | undefined): string {
  const zone = tz || serverTimezone();
  const off = tzOffsetMs(ms, zone);
  const sign = off < 0 ? "-" : "+";
  const abs = Math.abs(off);
  const o = `${sign}${String(Math.floor(abs / 3_600_000)).padStart(2, "0")}:${String(Math.floor((abs % 3_600_000) / 60_000)).padStart(2, "0")}`;
  return new Date(ms + off).toISOString().replace(/\.\d{3}Z$/, "") + o;
}

/** A naive (offset-less) ISO wall clock in `tz` → the true UTC instant.
 *  Two-pass so a DST boundary between guess and result settles correctly. */
function naiveInTzToUtc(naive: string, tz: string): number | null {
  const asUtc = Date.parse(/(?:Z|[+-]\d{2}:?\d{2})$/.test(naive) ? naive : `${naive}Z`);
  if (Number.isNaN(asUtc)) return null;
  const off1 = tzOffsetMs(asUtc, tz);
  const utc1 = asUtc - off1;
  const off2 = tzOffsetMs(utc1, tz);
  return off2 === off1 ? utc1 : asUtc - off2;
}

/** Validate a (kind, expr) pair; returns a human error for the model to fix.
 *  `timezone` (IANA) applies to cron expressions and offset-less one-shots. */
export function validateSchedule(
  kind: ScheduleKind,
  expr: string,
  timezone?: string | null,
): string | null {
  const trimmed = String(expr ?? "").trim();
  if (!trimmed) return "schedule_expr must be non-empty";
  if (timezone && !isValidTimezone(timezone)) {
    return `invalid timezone ${JSON.stringify(timezone)} — use an IANA name like "Asia/Hong_Kong"`;
  }
  if (kind === "cron") {
    try {
      CronExpressionParser.parse(trimmed, { tz: timezone || undefined });
      return null;
    } catch (e) {
      return `invalid cron expression ${JSON.stringify(trimmed)}: ${(e as Error).message}`;
    }
  }
  if (kind === "interval") {
    return intervalToMs(trimmed) === null
      ? `invalid interval ${JSON.stringify(trimmed)} — use Nd / Nh / Nm (e.g. "6h") or bare minutes`
      : null;
  }
  // once: relative delay or an ISO/parseable timestamp
  if (relativeDelayToMs(trimmed) !== null) return null;
  const t = Date.parse(trimmed);
  if (Number.isNaN(t)) {
    return `invalid one-shot schedule ${JSON.stringify(trimmed)} — use an ISO timestamp or "in <N>m/h/d"`;
  }
  return null;
}

/** Next fire strictly after `fromMs`, or null (unparseable — validated earlier).
 *  `timezone` scopes cron expressions and offset-less one-shot timestamps. */
export function nextFire(
  kind: ScheduleKind,
  expr: string,
  fromMs: number,
  timezone?: string | null,
): number | null {
  const trimmed = String(expr ?? "").trim();
  try {
    if (kind === "cron") {
      return CronExpressionParser.parse(trimmed, {
        currentDate: new Date(fromMs),
        tz: timezone || undefined,
      }).next().getTime();
    }
    if (kind === "interval") {
      const ms = intervalToMs(trimmed);
      return ms === null ? null : fromMs + ms; // absolute duration — tz-free
    }
    if (relativeDelayToMs(trimmed) !== null) {
      // Relative once-jobs anchor at creation/fire time, not validation time —
      // callers pass fromMs = the moment of anchoring.
      return fromMs + (relativeDelayToMs(trimmed) as number);
    }
    // Absolute one-shot: an offset/Z timestamp is already an instant; a naive
    // wall clock means the job's timezone (or the server's).
    if (timezone && !/(?:Z|[+-]\d{2}:?\d{2})$/.test(trimmed)) {
      return naiveInTzToUtc(trimmed, timezone);
    }
    const t = Date.parse(trimmed);
    return Number.isNaN(t) ? null : t;
  } catch {
    return null;
  }
}

/** The next `n` fires after `fromMs` (for create/update confirmation). */
export function nextFires(
  kind: ScheduleKind,
  expr: string,
  fromMs: number,
  n: number,
  timezone?: string | null,
): number[] {
  const out: number[] = [];
  if (kind !== "cron") {
    let t = nextFire(kind, expr, fromMs, timezone);
    for (let i = 0; i < n && t !== null; i++) {
      out.push(t);
      t = kind === "interval" ? nextFire(kind, expr, t, timezone) : null;
    }
    return out;
  }
  try {
    const it = CronExpressionParser.parse(expr.trim(), {
      currentDate: new Date(fromMs),
      tz: timezone || undefined,
    });
    for (let i = 0; i < n; i++) out.push(it.next().getTime());
    return out;
  } catch {
    /* validated earlier */
    return out;
  }
}

/** Human one-liner for the UI/confirmations. */
export function describeSchedule(
  kind: ScheduleKind,
  expr: string,
  timezone?: string | null,
): string {
  const tz = timezone ? ` (${timezone})` : "";
  if (kind === "cron") return `cron ${expr.trim()}${tz}`;
  if (kind === "interval") return `every ${expr.trim()}`;
  return `once at ${expr.trim()}${tz}`;
}
