// memory_manage: edit always-on MEMORY.md / USER.md (add / replace / remove).
// recovery convention: denials use "Rejected:" (recoverable), hard failures
// "Error:" (fatal for the turn).

import { MEMORY_CHAR_LIMIT } from "../config.js";
import { PromptMemory } from "../memory.js";
import type { ToolDef } from "../types.js";

const memory = new PromptMemory();

export const memory_manage: ToolDef = {
  name: "memory_manage",
  description:
    "Edit your persistent prompt memory files. Two layers:\n" +
    '- target="memory" → MEMORY.md: facts, decisions, project knowledge needed EVERY future session\n' +
    '- target="user" → USER.md: who the user is, their preferences, working style\n' +
    `Combined budget: ${MEMORY_CHAR_LIMIT} chars across both files. Operations:\n` +
    "  add (target, text) — append a line\n" +
    "  replace (target, old, text) — rewrite an existing entry in place\n" +
    "  remove (target, old) — delete a line by exact phrase\n" +
    "Turbo rules: replace/remove take the exact phrase as saved. Keep entries terse, " +
    "consolidate instead of accumulating. Do NOT store topic-specific findings; leave " +
    "those to the session archive. Edits take effect from the NEXT session.",
  parameters: {
    type: "object",
    properties: {
      operation: { type: "string", description: "add | replace | remove", enum: ["add", "replace", "remove"] },
      target: { type: "string", description: "memory | user", enum: ["memory", "user"] },
      text: { type: "string", description: "For 'add'/'replace': the new text. For 'replace': the full new entry." },
      old: { type: "string", description: "For 'replace'/'remove': the exact phrase as currently saved." },
    },
    required: ["operation", "target"],
  },
  execute(args) {
    const op = String(args.operation ?? "add");
    const target = (args.target === "user" ? "user" : "memory") as "user" | "memory";
    const text = String(args.text ?? "");
    const old = String(args.old ?? "");
    try {
      if (op === "add") return memory.add(target, text);
      if (op === "replace") return memory.replace(target, old, text);
      if (op === "remove") return memory.remove(target, old);
      return `Rejected: unknown operation ${op}`;
    } catch (e) {
      return `Error: ${(e as Error).message}`;
    }
  },
};

export const memoryStatus = (memory: PromptMemory) => () => ({
  usage: memory.totalChars(),
  budget: MEMORY_CHAR_LIMIT,
});

export { memory };
