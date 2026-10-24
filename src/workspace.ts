// Workspace path discipline (user-scoped since 2026-10-24):
//  - with AUTH_MODE=sso, each login gets WORKSPACE_DIR/<sanitised-login-id>/;
//  - relative paths in the fs tools and `execute` resolve against that root;
//  - absolute paths stay allowed for reading real sources. The process is
//    shared, so this is path separation, not a security boundary: `execute`
//    can still read another user's folder. Per-user containers are the
//    isolation step (docs/per-user-workspace-and-r2.md);
//  - AUTH_MODE=off falls back to WORKSPACE_USER, or the flat WORKSPACE_DIR
//    when that is unset (tests / single-user dev);
//  - writes outside the scoped root into repo internals are guarded;
//    HARD_JAIL=1 confines writes to the scoped root.

import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import path from "node:path";
import { WORKSPACE_DIR, WORKSPACE_HARD_JAIL, WORKSPACE_USER } from "./config.js";

export interface WorkspaceScope {
  userId: string;
  root: string;
}

const scope = new AsyncLocalStorage<WorkspaceScope>();

/** Filesystem-safe, lowercase login id (always one path segment). */
export function sanitizeUserId(raw: string | null | undefined): string {
  return String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "_")
    .replace(/^[._-]+|[._-]+$/g, "")
    .slice(0, 64);
}

/** Login id + subject → a non-empty, safe folder key for authenticated users. */
export function workspaceUserKey(username?: string | null, sub?: string | null): string {
  return sanitizeUserId(username) || sanitizeUserId(sub) || "user";
}

/** Absolute root for a user; an empty id keeps the flat legacy root. */
export function workspaceRootFor(userId?: string | null): string {
  const id = sanitizeUserId(userId);
  return id ? path.join(WORKSPACE_DIR, id) : WORKSPACE_DIR;
}

/** Create (if needed) and return a user's workspace root. */
export function ensureWorkspaceFor(userId: string): string {
  const root = workspaceRootFor(userId);
  fs.mkdirSync(root, { recursive: true });
  return root;
}

/** Run `fn` with the user's workspace as the active root (async-safe). */
export function runInWorkspace<T>(userId: string, fn: () => T): T {
  const id = sanitizeUserId(userId);
  const root = id ? ensureWorkspaceFor(id) : WORKSPACE_DIR;
  return scope.run({ userId: id, root }, fn);
}

/** The active scope, or the auth-off fallback. */
export function currentWorkspace(): WorkspaceScope {
  const active = scope.getStore();
  if (active) return active;
  const id = sanitizeUserId(WORKSPACE_USER);
  if (!id) return { userId: "", root: WORKSPACE_DIR };
  return { userId: id, root: ensureWorkspaceFor(id) };
}

export function currentWorkspaceRoot(): string {
  return currentWorkspace().root;
}

/** The active session owner: SSO login id, else WORKSPACE_USER, else "default". */
export function currentUserId(): string {
  const active = scope.getStore();
  if (active?.userId) return active.userId;
  return sanitizeUserId(WORKSPACE_USER) || "default";
}

/** Resolve a user/tool-supplied path: relative → the active workspace root. */
export function resolveInWorkspace(p: string): string {
  const root = currentWorkspaceRoot();
  const raw = String(p ?? "").trim();
  if (!raw) return root;
  return path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(root, raw);
}

/** Paths that contain the harness itself — artifacts must not land here. */
const REPO_INTERNALS = [
  path.resolve(process.cwd(), "src"),
  path.resolve(process.cwd(), "frontend/src"),
  path.resolve(process.cwd(), "frontend/node_modules"),
];

const REPO_INTERNAL_FILES = new Set([
  path.resolve(process.cwd(), ".env"),
  path.resolve(process.cwd(), "tsconfig.json"),
  path.resolve(process.cwd(), "package.json"),
  path.resolve(process.cwd(), "package-lock.json"),
]);

/**
 * Non-fatal by convention: returns "Rejected: ..." (model-recoverable) inline,
 * never "Error:" — a blocked write is a policy denial, not a system failure.
 */
export function guardWorkspaceWrite(p: string): string {
  const abs = path.resolve(String(p ?? ""));
  const root = currentWorkspaceRoot();
  if (REPO_INTERNAL_FILES.has(abs) || REPO_INTERNALS.some((dir) => abs.startsWith(dir + path.sep))) {
    return `Rejected: ${abs} is harness config/source — write artifacts to the workspace (relative paths land there); pass allow_outside=true if this edit is really intended.`;
  }
  if (WORKSPACE_HARD_JAIL && !abs.startsWith(root + path.sep) && abs !== root) {
    return `Rejected: WORKSPACE_HARD_JAIL=1 — writes are confined to ${root}.`;
  }
  return "";
}
