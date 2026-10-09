// Workspace path discipline (option C, README):
//  - relative paths in the fs tools and execute resolve against WORKSPACE_DIR,
//    so artifacts land in one gitignored place instead of scattering in the
//    repo root;
//  - absolute paths stay allowed (single-user local agent reads real sources:
//    repo files, sessions.db, skills, datasets elsewhere on the box);
//  - writes outside the workspace into repo internals are guarded — GOTCHA-
//    mode by default (allowed, loudly), HARD_JAIL=1 rejects them outright.
//  Read paths are never blocked: the guard is about _writes_, not visibility.

import path from "node:path";
import { WORKSPACE_DIR, WORKSPACE_HARD_JAIL } from "./config.js";

/** Resolve a user/tool-supplied path: relative → workspace-rooted. */
export function resolveInWorkspace(p: string): string {
  const raw = String(p ?? "").trim();
  if (!raw) return WORKSPACE_DIR;
  return path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(WORKSPACE_DIR, raw);
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
  if (REPO_INTERNAL_FILES.has(abs) || REPO_INTERNALS.some((dir) => abs.startsWith(dir + path.sep))) {
    return `Rejected: ${abs} is harness config/source — write artifacts to the workspace (relative paths land there); pass allow_outside=true if this edit is really intended.`;
  }
  if (WORKSPACE_HARD_JAIL && !abs.startsWith(WORKSPACE_DIR + path.sep) && abs !== WORKSPACE_DIR) {
    return `Rejected: WORKSPACE_HARD_JAIL=1 — writes are confined to ${WORKSPACE_DIR}.`;
  }
  return "";
}
