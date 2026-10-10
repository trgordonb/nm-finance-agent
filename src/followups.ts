// Session follow-ups ("next steps" tips) for the web UI.
// Faithful port of langgraph-demo's followups.py: recent models close turns
// with actionable suggestions ("Natural next steps: (a)…", "want me to run
// X?"). We extract those from each turn's FINAL assistant message and store
// them so the web UI can show a to-do strip above the composer.
//
// Mirrors the session-titler pattern: a free regex pre-filter on the closing
// message, then one cheap secondary-LLM call (OPENROUTER_MODEL_SUMMARIZER)
// — never blocks the turn and never raises; unconfigured → inactive.
//
// Storage deviation (documented): python kept this OUT of sessions.db
// because nm_memory_layer owned that schema. Our TS archive is repo-owned,
// so followups is a table in the same SQLite file — one store, no second db
// path. (FOLLOWUPS_DB_PATH override no longer meaningful; FOLLOWUPS_ENABLED
// disables the extractor, same as python.)

import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { chat } from "./llm.js";
import { OPENROUTER_MODEL_SUMMARIZER } from "./config.js";
import { DB_PATH } from "./config.js";
import { log } from "./logger.js";
import type { ChatMessage } from "./types.js";

// Marks a closing message as worth an extraction pass — tuned on 25 real
// sessions (~56% hit rate); the LLM call only fires when this matches.
const TIP_MARKER_RE =
  /next step|follow[- ]?up|would you like|want me to|if you('| a)?d? ?like|say the word|worth a (skim|look|noting)|natural next|i can (also|now)|you can (now|also)|then you can|optional next/i;
const MIN_CONTENT_CHARS = 80;
const MAX_ITEMS = 4;
const MAX_ITEM_CHARS = 160;

const EXTRACTION_SYSTEM_PROMPT =
  "You extract follow-up to-do suggestions from the FINAL message of an " +
  "AI-assistant conversation, for a to-do list shown to the user.\n" +
  'Suggestions live in the LAST paragraph: questions addressed to the user ' +
  '("Want me to X, Y, or Z?"), "next steps" lists, and offers ("I can ' +
  'also X", "just say the word"). Convert each into one short imperative ' +
  'sentence (max ~12 words), self-contained, no markdown, no quotes.\n' +
  "Only concrete, actionable next steps the USER might take (run/try/check/" +
  "compare/file something) or concrete offers the assistant made. Do not " +
  "invent items and do not restate the answer.\n" +
  "Reply with ONLY a JSON array of strings, at most 4 items; [] if there are " +
  "none.\n\n" +
  'Example 1 — a closing offer/question:\n' +
  'FINAL ASSISTANT MESSAGE: "...the chart is live. Want me to pull the ' +
  'exact numbers, or save an offline HTML copy?"\n' +
  'JSON: ["Pull the exact numbers", "Save an offline HTML copy"]\n\n' +
  'Example 2 — a next-steps list:\n' +
  'FINAL ASSISTANT MESSAGE: "...Natural next steps if you want them: ' +
  '(a) run a head-to-head, or (b) extend the falsifier window."\n' +
  'JSON: ["Run a head-to-head", "Extend the falsifier window"]\n\n' +
  'Example 3 — a pure summary with nothing actionable:\n' +
  'FINAL ASSISTANT MESSAGE: "...nothing overbought or oversold in play."\n' +
  "JSON: []";

// --- storage -------------------------------------------------------------------

let db: DatabaseSync | null = null;

function connect(): DatabaseSync {
  if (db) return db;
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  db = new DatabaseSync(DB_PATH);
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec(
    `CREATE TABLE IF NOT EXISTS followups (
       session_id TEXT PRIMARY KEY,
       items_json TEXT NOT NULL,
       dismissed_json TEXT NOT NULL DEFAULT '[]',
       model TEXT,
       created_at REAL
     )`,
  );
  return db;
}

export function setFollowups(sessionId: string, items: string[], model?: string): void {
  const d = connect();
  d.prepare(
    `INSERT INTO followups (session_id, items_json, dismissed_json, model, created_at)
     VALUES (?, ?, '[]', ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET
       items_json = excluded.items_json, dismissed_json = '[]',
       model = excluded.model, created_at = excluded.created_at`,
  ).run(sessionId, JSON.stringify(items), model ?? null, Date.now() / 1000);
}

export interface FollowupsRow {
  session_id: string;
  items: string[];
  dismissed: number[];
  model?: string | null;
  created_at?: number | null;
}

export function getFollowups(sessionId: string): FollowupsRow | null {
  const d = connect();
  const row = d
    .prepare(`SELECT items_json, dismissed_json, model, created_at FROM followups WHERE session_id = ?`)
    .get(sessionId) as { items_json: string; dismissed_json: string; model: string | null; created_at: number } | undefined;
  if (!row) return null;
  return {
    session_id: sessionId,
    items: JSON.parse(row.items_json) as string[],
    dismissed: JSON.parse(row.dismissed_json) as number[],
    model: row.model,
    created_at: row.created_at,
  };
}

/** Live (non-dismissed) tip counts per session — the sidebar badges. Counts
 *  reflect remaining work: acting on a tip shrinks the count; a new
 *  extraction replaces the list. */
export function followupCounts(): Record<string, number> {
  const d = connect();
  const rows = d.prepare(`SELECT session_id, items_json, dismissed_json FROM followups`).all() as Array<{
    session_id: string;
    items_json: string;
    dismissed_json: string;
  }>;
  const out: Record<string, number> = {};
  for (const r of rows) {
    const live = (JSON.parse(r.items_json) as string[]).length - (JSON.parse(r.dismissed_json) as number[]).length;
    if (live > 0) out[r.session_id] = live;
  }
  return out;
}

/** Mark one item dismissed; returns the updated dismissed list, or null when
 *  the session has no follow-ups row (404 at the REST layer). */
export function dismissFollowup(sessionId: string, index: number): number[] | null {
  const d = connect();
  const row = d
    .prepare(`SELECT items_json, dismissed_json FROM followups WHERE session_id = ?`)
    .get(sessionId) as { items_json: string; dismissed_json: string } | undefined;
  if (!row) return null;
  const items = JSON.parse(row.items_json) as string[];
  const dismissed = JSON.parse(row.dismissed_json) as number[];
  if (index >= 0 && index < items.length && !dismissed.includes(index)) {
    dismissed.push(index);
    d.prepare(`UPDATE followups SET dismissed_json = ? WHERE session_id = ?`).run(
      JSON.stringify(dismissed),
      sessionId,
    );
  }
  return dismissed;
}

// --- extraction --------------------------------------------------------------------

/** Pull a JSON string array out of a model reply; [] on anything else. */
export function parseFollowups(raw: string, cap: number = MAX_ITEMS): string[] {
  const match = /\[[\s\S]*\]/.exec(raw);
  if (!match) return [];
  let data: unknown;
  try {
    data = JSON.parse(match[0]);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const item of Array.isArray(data) ? data : []) {
    if (typeof item !== "string") continue;
    const cleaned = item.replace(/\s+/g, " ").trim();
    if (cleaned.length < 4) continue;
    out.push(cleaned.slice(0, MAX_ITEM_CHARS));
    if (out.length >= cap) break;
  }
  return out;
}

/** Free pre-filter: substantive closing text with a suggestion-shaped tail.
 *  Checks the LAST 2000 chars only (the suggestions live in the tail). */
export function looksLikeFollowups(closingText: string): boolean {
  const text = String(closingText ?? "");
  if (text.length < MIN_CONTENT_CHARS) return false;
  return TIP_MARKER_RE.test(text.slice(-2000));
}

async function invokeExtractor(closingText: string, instruction: string): Promise<string[]> {
  const response = await chat(
    [
      { role: "system", content: EXTRACTION_SYSTEM_PROMPT },
      {
        role: "user",
        content: `FINAL ASSISTANT MESSAGE:\n${closingText.trim().slice(-2000)}\n\n${instruction}`,
      },
    ],
    undefined,
    { model: OPENROUTER_MODEL_SUMMARIZER, noReasoning: true, maxTokens: 512 },
  );
  return parseFollowups(response.content);
}

async function extractFollowups(closingText: string): Promise<string[]> {
  const items = await invokeExtractor(closingText, "JSON array:");
  if (items.length) return items;
  // Small models sometimes answer [] lazily even when the pre-filter saw
  // suggestion-shaped text — one firm retry before giving up (python parity).
  return invokeExtractor(
    closingText,
    "The message above ends with suggestions or offers to the user. " +
      "List them as a JSON array of short imperative sentences. " +
      "Reply [] only if there is truly nothing actionable.",
  );
}

/** Post-turn hook: extract and store follow-ups for the closing message.
 *  Fire-and-forget async and never raises — cosmetics, same contract as the
 *  session titler. Only fires when the pre-filter matches AND the extractor
 *  is active (FOLLOWUPS_ENABLED=false or no summarizer model → inactive). */
export function maybeExtractFollowups(sessionId: string, newMessages: ChatMessage[]): void {
  try {
    if (process.env.FOLLOWUPS_ENABLED === "0") return;
    const closing = [...newMessages]
      .reverse()
      .find((m) => m.role === "assistant" && m.content?.trim());
    if (!closing || !looksLikeFollowups(closing.content)) return;
    const closingText = closing.content;
    void extractFollowups(closingText)
      .then((items) => {
        if (!items.length) return;
        setFollowups(sessionId, items, `openrouter:${OPENROUTER_MODEL_SUMMARIZER}`);
        log.info(`followups [${sessionId.slice(0, 8)}]: ${items.length} item(s) stored`);
      })
      .catch((e) => log.warn(`Followups extraction failed: ${String(e).slice(0, 160)}`));
  } catch (e) {
    log.warn(`Followups hook failed: ${String(e).slice(0, 160)}`);
  }
}
