// User-scoped OpenRouter keys (docs/user-scoped-openrouter-keys-plan.md).
//
// Storage: SKILLS_STATE_DIR/users/<id>/llm.json — same per-user conventions as
// mcp-user-state (0700 dir, 0600 file, atomic tmp+rename). The key is
// encrypted at rest (AES-256-GCM with USER_LLM_KEY_SECRET); when that env is
// unset the state degrades to plaintext 0600 with the flag visible to callers
// so the boot log can warn.
//
// The three knobs (LLM_KEY_POLICY, LLM_KEY_REQUIRE_USER_AFTER,
// USER_LLM_KEY_SECRET) are read lazily from process.env rather than config.ts
// consts: tests vary the policy per case, and the encryption secret can be
// rotated without confusing two sources of truth.
//
// chat() resolves the Authorization key through resolveAuthorizationKey() —
// per call, in the caller's ALS scope, so requests and cron fires both bill
// their own user.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { OPENROUTER_API_KEY, OPENROUTER_BASE_URL, SKILLS_STATE_DIR } from "./config.js";
import { currentUserId, sanitizeUserId } from "./workspace.js";

const OPENROUTER_KEY_URL = `${OPENROUTER_BASE_URL.replace(/\/$/, "")}/key`;

export type LlmKeyPolicy = "prefer_user" | "require_user" | "server_only";

export function llmKeyPolicy(): LlmKeyPolicy {
  const v = (process.env.LLM_KEY_POLICY ?? "prefer_user").trim().toLowerCase();
  return v === "require_user" || v === "server_only" ? (v as LlmKeyPolicy) : "prefer_user";
}

/** ISO date: with LLM_KEY_POLICY=require_user, the server key still backs
 *  turns until this instant (warn-only window). Empty = enforced now. */
export function llmKeyRequireUserAfter(): number | null {
  const raw = (process.env.LLM_KEY_REQUIRE_USER_AFTER ?? "").trim();
  if (!raw) return null;
  const t = Date.parse(raw);
  return Number.isNaN(t) ? null : t;
}

export function requireUserEnforced(now = Date.now()): boolean {
  if (llmKeyPolicy() !== "require_user") return false;
  const after = llmKeyRequireUserAfter();
  return after === null || now >= after;
}

/** Non-null during the warn-only week (require_user policy, deadline ahead). */
export function requireUserWarnDeadline(now = Date.now()): number | null {
  if (llmKeyPolicy() !== "require_user") return null;
  const after = llmKeyRequireUserAfter();
  return after !== null && now < after ? after : null;
}

export function maskKey(key: string): string {
  if (key.length <= 14) return "…";
  return `${key.slice(0, 10)}…${key.slice(-4)}`;
}

// --- encryption --------------------------------------------------------------

function secretBytes(): Buffer | null {
  const s = process.env.USER_LLM_KEY_SECRET?.trim();
  if (!s) return null;
  return crypto.createHash("sha256").update(s).digest();
}

export function keyEncryptionActive(): boolean {
  return secretBytes() !== null;
}

function encryptKey(plain: string): string | undefined {
  const k = secretBytes();
  if (!k) return undefined; // plaintext fallback, flagged by keyEncryptionActive()
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", k, iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return `v1.${iv.toString("base64")}.${cipher.getAuthTag().toString("base64")}.${ct.toString("base64")}`;
}

function decryptKey(enc: string): string | null {
  try {
    const [v, iv, tag, ct] = enc.split(".");
    if (v !== "v1") return null;
    const k = secretBytes();
    if (!k) return null;
    const d = crypto.createDecipheriv("aes-256-gcm", k, Buffer.from(iv, "base64"));
    d.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([d.update(Buffer.from(ct, "base64")), d.final()]).toString("utf8");
  } catch {
    return null;
  }
}

// --- per-user state ----------------------------------------------------------

export interface UserLlmKeyEntry {
  key_enc?: string; // set when USER_LLM_KEY_SECRET is active
  key_plain?: string; // set only in the plaintext fallback
  masked: string;
  label?: string;
  usage_usd?: number;
  limit?: number | null;
  is_free_tier?: boolean;
  added_at: number;
  last_checked: number;
}

export interface UserLlmKeyState {
  openrouter?: UserLlmKeyEntry;
}

export function llmKeyStatePath(userId: string = currentUserId()): string {
  return path.join(SKILLS_STATE_DIR, "users", sanitizeUserId(userId) || "default", "llm.json");
}

function readState(userId: string): UserLlmKeyState {
  try {
    return JSON.parse(fs.readFileSync(llmKeyStatePath(userId), "utf8")) as UserLlmKeyState;
  } catch {
    return {};
  }
}

function writeState(state: UserLlmKeyState, userId: string): void {
  const file = llmKeyStatePath(userId);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 1)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** The user's OpenRouter key, decrypted — one small file read per LLM call
 *  (microseconds against seconds of LLM latency), no cache: mid-session
 *  save/clear must take effect on the very next call. */
export function getUserOpenRouterKey(userId: string = currentUserId()): string | null {
  let entry: UserLlmKeyEntry | undefined;
  try {
    entry = readState(userId).openrouter;
  } catch {
    return null;
  }
  if (!entry) return null;
  return entry.key_enc ? decryptKey(entry.key_enc) : entry.key_plain ?? null;
}

export function setUserOpenRouterKey(
  userId: string,
  key: string,
  meta: { label?: string; usage_usd?: number; limit?: number | null; is_free_tier?: boolean },
): UserLlmKeyEntry {
  const state = readState(userId);
  const entry: UserLlmKeyEntry = {
    key_enc: encryptKey(key),
    ...(keyEncryptionActive() ? {} : { key_plain: key }),
    masked: maskKey(key),
    label: meta.label,
    usage_usd: meta.usage_usd,
    limit: meta.limit ?? null,
    is_free_tier: meta.is_free_tier,
    added_at: state.openrouter?.added_at ?? Date.now(),
    last_checked: Date.now(),
  };
  state.openrouter = entry;
  writeState(state, userId);
  return entry;
}

export function clearUserOpenRouterKey(userId: string = currentUserId()): void {
  const state = readState(userId);
  delete state.openrouter;
  writeState(state, userId);
}

/** The Authorization value chat() should use for this user, per policy. */
export function resolveAuthorizationKey(userId: string = currentUserId()): {
  key: string | null;
  source: "user" | "server" | "none";
  error?: string;
} {
  const policy = llmKeyPolicy();
  if (policy === "server_only") {
    return { key: OPENROUTER_API_KEY || null, source: "server" };
  }
  const userKey = getUserOpenRouterKey(userId);
  if (userKey) return { key: userKey, source: "user" };
  if (policy === "require_user" && requireUserEnforced()) {
    return {
      key: null,
      source: "none",
      error:
        "no OpenRouter key configured for this user — add yours in Settings → Model & key " +
        "(LLM_KEY_POLICY=require_user is enforced)",
    };
  }
  return { key: OPENROUTER_API_KEY || null, source: "server" };
}

// --- key validation (no spend: GET /key returns metadata only) ---------------

export interface OpenRouterKeyInfo {
  label: string | null;
  usage_usd: number | null;
  limit: number | null;
  is_free_tier: boolean;
}

export async function validateOpenRouterKey(key: string): Promise<OpenRouterKeyInfo | null> {
  const res = await fetch(OPENROUTER_KEY_URL, {
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) return null;
  const doc = (await res.json()) as { data?: Record<string, unknown> };
  const d = doc.data ?? {};
  return {
    label: typeof d.label === "string" ? d.label : null,
    usage_usd: typeof d.usage === "number" ? d.usage : null,
    limit: typeof d.limit === "number" ? d.limit : null,
    is_free_tier: Boolean(d.is_free_tier),
  };
}

// --- usage recording (harness-side per-user spend, owner decision §10.4) -----

export interface LlmUsageEntry {
  userId: string;
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
  cost_usd: number | null;
  source: "user" | "server";
  created_at: number;
}

let usageRecorder: ((entry: LlmUsageEntry) => void) | null = null;

/** index.ts registers the SQLite writer; chat() records every successful call. */
export function setLlmUsageRecorder(fn: ((entry: LlmUsageEntry) => void) | null): void {
  usageRecorder = fn;
}

export function recordLlmUsage(entry: LlmUsageEntry): void {
  try {
    usageRecorder?.(entry);
  } catch {
    /* usage bookkeeping must never break a call */
  }
}
