// PromptMemory: always-on MEMORY.md / USER.md behind a per-user char budget.
// Port of nm_memory_layer.prompt_memory semantics: load ONCE per session into
// the system prompt (stable prefix, prompt-cache friendly); memory_manage edits
// take effect from the NEXT session, never mid-conversation.
//
// Per-SSO-user since 2026-10-24: MEMORY_DIR/<login-id>/{MEMORY.md,USER.md}.
// A read-only MEMORY_DIR/_shared/MEMORY.md is composed into every prompt with
// its own SHARED_MEMORY_CHAR_LIMIT budget; memory_manage cannot edit it.
// The class stays stateless per call, so the two instances (index.ts and
// tools/memory_manage.ts) always resolve the same active user.
//
// Denials use the "Rejected:" prefix (deliberately not "Error:") because
// agent-loop convention treats "Error:"-prefixed tool results as fatal;
// budget rejections are recoverable and must route back through the model.

import fs from "node:fs";
import fsPath from "node:path";
import { MEMORY_DIR, MEMORY_CHAR_LIMIT, SHARED_MEMORY_CHAR_LIMIT } from "./config.js";
import { currentUserId, sanitizeUserId } from "./workspace.js";

export type MemoryTarget = "memory" | "user";

export interface MemoryPaths {
  dir: string;
  memoryPath: string;
  userPath: string;
}

/** Per-user memory paths; an empty/invalid id falls back to "default". */
export function memoryPathsFor(userId: string = currentUserId()): MemoryPaths {
  const dir = fsPath.join(MEMORY_DIR, sanitizeUserId(userId) || "default");
  return {
    dir,
    memoryPath: fsPath.join(dir, "MEMORY.md"),
    userPath: fsPath.join(dir, "USER.md"),
  };
}

/** Read-only project memory shared by every login. */
export function sharedMemoryPath(): string {
  return fsPath.join(MEMORY_DIR, "_shared", "MEMORY.md");
}

function readFileSafe(p: string): string {
  try {
    return fs.readFileSync(p, "utf8").trim();
  } catch {
    return "";
  }
}

/** Atomic write: a crash cannot leave a truncated memory file. */
function writeFileSafe(p: string, body: string): void {
  const dir = fsPath.dirname(p);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${p}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, body ? `${body}\n` : "", { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, p);
  try {
    fs.chmodSync(p, 0o600);
  } catch {
    /* best effort on filesystems without chmod */
  }
}

export class PromptMemory {
  private readonly explicit?: MemoryPaths;

  constructor(memoryPath?: string, userPath?: string) {
    // Explicit paths keep the single-user/test contract; otherwise resolve the
    // active login on every call from AsyncLocalStorage.
    if (memoryPath && userPath) {
      this.explicit = { dir: fsPath.dirname(memoryPath), memoryPath, userPath };
    }
  }

  private paths(): MemoryPaths {
    return this.explicit ?? memoryPathsFor();
  }

  get memoryPath(): string {
    return this.paths().memoryPath;
  }

  get userPath(): string {
    return this.paths().userPath;
  }

  /** Rendered <agent_memory> block for the system prompt. "" when empty. */
  load(): string {
    const shared = this.loadShared();
    const mem = readFileSafe(this.memoryPath);
    const usr = readFileSafe(this.userPath);
    if (!shared && !mem && !usr) return "";
    const parts: string[] = [];
    if (shared) parts.push(`\n-- SHARED MEMORY.md (read-only)\n\n${shared}`);
    if (mem) parts.push(`\n-- MEMORY.md\n\n${mem}`);
    if (usr) parts.push(`\n-- USER.md\n\n${usr}`);
    return `<agent_memory>${parts.join("")}\n</agent_memory>`;
  }

  /** Shared project memory, capped at its own budget with a visible marker. */
  loadShared(): string {
    const raw = readFileSafe(sharedMemoryPath());
    if (!raw) return "";
    if (raw.length <= SHARED_MEMORY_CHAR_LIMIT) return raw;
    return `${raw.slice(0, SHARED_MEMORY_CHAR_LIMIT)}\n[shared memory truncated at ${SHARED_MEMORY_CHAR_LIMIT} chars]`;
  }

  /** Full shared file length (before the prompt cap). */
  sharedChars(): number {
    return readFileSafe(sharedMemoryPath()).length;
  }

  sharedOverBudget(): boolean {
    return this.sharedChars() > SHARED_MEMORY_CHAR_LIMIT;
  }

  /** Combined PER-USER budget usage across MEMORY.md + USER.md (shared excluded). */
  totalChars(): number {
    return readFileSafe(this.memoryPath).length + readFileSafe(this.userPath).length;
  }

  private fileFor(target: MemoryTarget): { path: string; name: string } {
    return target === "memory"
      ? { path: this.memoryPath, name: "MEMORY.md" }
      : { path: this.userPath, name: "USER.md" };
  }

  add(target: MemoryTarget, text: string): string {
    const { path: file, name } = this.fileFor(target);
    const addition = text.trim();
    if (!addition) return rejection("add requires non-empty text");
    const body = readFileSafe(file);
    return this.commit(file, name, body, body ? `${body}\n${addition}` : addition);
  }

  replace(target: MemoryTarget, oldPhrase: string, text: string): string {
    const { path: file, name } = this.fileFor(target);
    if (!oldPhrase) return rejection("replace requires the old phrase");
    const body = readFileSafe(file);
    if (!body.includes(oldPhrase)) return rejection(`replace: phrase not found in ${name}`);
    return this.commit(file, name, body, body.replace(oldPhrase, text));
  }

  remove(target: MemoryTarget, oldPhrase: string): string {
    const { path: file, name } = this.fileFor(target);
    if (!oldPhrase) return rejection("remove requires the old phrase");
    const body = readFileSafe(file);
    if (!body.includes(oldPhrase)) return rejection(`remove: phrase not found in ${name}`);
    return this.commit(file, name, body, body.replace(oldPhrase, ""));
  }

  private commit(file: string, name: string, oldBody: string, newBody: string): string {
    newBody = newBody.trim();
    const budgetWithoutThisFile = this.totalChars() - oldBody.length;
    const newTotal = budgetWithoutThisFile + newBody.length;
    if (newTotal > MEMORY_CHAR_LIMIT) {
      return rejection(
        `${name} write rejected — combined per-user budget ${MEMORY_CHAR_LIMIT} chars, ` +
          `this edit would push it to ${newTotal}; consolidate or shorten instead of accumulating.`,
      );
    }
    try {
      writeFileSafe(file, newBody);
    } catch (e) {
      return rejection(`write failed: ${(e as Error).message}`);
    }
    return `OK: ${name} now ${newBody.length} chars (${newTotal}/${MEMORY_CHAR_LIMIT} budget)`;
  }
}

function rejection(msg: string): string {
  return `Rejected: ${msg}`;
}
