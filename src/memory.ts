// PromptMemory: always-on MEMORY.md / USER.md behind a shared char budget.
// Port of nm_memory_layer.prompt_memory semantics: load ONCE per session into
// the system prompt (stable prefix, prompt-cache friendly); memory_manage edits
// take effect from the NEXT session, never mid-conversation.
//
// Denials use the "Rejected:" prefix (deliberately not "Error:") because
// agent-loop convention treats "Error:"-prefixed tool results as fatal;
// budget rejections are recoverable and must route back through the model.

import fs from "node:fs";
import fsPath from "node:path";
import { MEMORY_DIR, MEMORY_CHAR_LIMIT, MEMORY_MD_PATH, USER_MD_PATH } from "./config.js";

export type MemoryTarget = "memory" | "user";

function readFileSafe(p: string): string {
  try {
    return fs.readFileSync(p, "utf8").trim();
  } catch {
    return "";
  }
}

function writeFileSafe(p: string, body: string): void {
  fs.mkdirSync(fsPath.dirname(p), { recursive: true });
  fs.writeFileSync(p, body ? `${body}\n` : "", "utf8");
}

export class PromptMemory {
  readonly memoryPath: string;
  readonly userPath: string;

  constructor(memoryPath: string = MEMORY_MD_PATH, userPath: string = USER_MD_PATH) {
    this.memoryPath = memoryPath;
    this.userPath = userPath;
  }

  /** Rendered <agent_memory> block for the system prompt. "" when empty. */
  load(): string {
    const mem = readFileSafe(this.memoryPath);
    const usr = readFileSafe(this.userPath);
    if (!mem && !usr) return "";
    const parts: string[] = [];
    if (mem) parts.push(`\n-- MEMORY.md\n\n${mem}`);
    if (usr) parts.push(`\n-- USER.md\n\n${usr}`);
    return `<agent_memory>${parts.join("")}\n</agent_memory>`;
  }

  /** Combined budget usage across BOTH files. */
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
        `${name} write rejected — combined budget ${MEMORY_CHAR_LIMIT} chars, ` +
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
