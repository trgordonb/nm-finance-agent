// skill_manage + load_skill tools — the agent's procedural-memory surface.
// Docstring is ported verbatim from nm_memory_layer.skills (it teaches the
// model when to create skills and why patch > edit).

import type { ToolDef } from "../types.js";
import { SkillLibrary } from "../skills/library.js";
import type { SkillsCliBridge } from "../skills/sync.js";

let skillLibrary: SkillLibrary | null = null;
let bridge: SkillsCliBridge | null = null;

/** Bridge init — index.ts injects the R2 lifecycle client. */
export function initSkills(newLibrary: SkillLibrary, newBridge?: SkillsCliBridge | null): void {
  skillLibrary = newLibrary;
  bridge = newBridge ?? null;
}

function notifyCuration(result: string): string {
  if (result.startsWith("OK:") && bridge) bridge.notifyChange();
  return result;
}

function lib(): SkillLibrary {
  if (!skillLibrary) skillLibrary = new SkillLibrary();
  return skillLibrary;
}

export function getSkillLibrary(): SkillLibrary {
  return lib();
}

export const skill_manage: ToolDef = {
  name: "skill_manage",
  description:
    "Create and update reusable skill files (procedural memory) under skills/.\n\n" +
    "A skill is a SKILL.md capturing a workflow that worked, so future sessions " +
    "can follow it instead of re-deriving it. Create one when: a task needed 5+ " +
    "tool calls, you recovered from an error, the user corrected your approach, " +
    "or a non-obvious workflow turned out to work.\n\n" +
    "PREFER patch over edit: it replaces one exact string (safe + token-cheap), " +
    "while edit rewrites the whole body and risks breaking working content.",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        description:
          "create (name+description+content [+category]) | patch (name+old_content+content, " +
          "exact-string replacement) | edit (name+content, full body rewrite) | delete (name) | " +
          "write_file/remove_file (name+relative_path [+content]) | enable/disable (name).",
        enum: ["create", "patch", "edit", "delete", "write_file", "remove_file", "enable", "disable"],
      },
      name: { type: "string", description: "Skill slug (lowercase letters/digits/-/_)." },
      description: { type: "string", description: "One sentence: WHEN to use it (shown in the index)." },
      content: {
        type: "string",
        description: "New text (create body / edit body / write_file contents / patch replacement).",
      },
      old_content: { type: "string", description: "Exact existing text to replace (patch only)." },
      relative_path: { type: "string", description: "Path inside the skill dir (write_file/remove_file)." },
      category: { type: "string", description: "Optional group directory for create (e.g. 'devops')." },
    },
    required: ["action", "name"],
  },
  execute(args) {
    return execSkillManage(args);
  },
};

function execSkillManage(args: Record<string, unknown>): string {
    const action = String(args.action ?? "");
    const name = String(args.name ?? "");
    const description = String(args.description ?? "");
    const content = String(args.content ?? "");
    const oldContent = String(args.old_content ?? "");
    const relativePath = String(args.relative_path ?? "");
    const category = String(args.category ?? "") || null;
    switch (action) {
      case "create":
        return notifyCuration(lib().createSkill(name, description, content, category));
      case "patch":
        return notifyCuration(lib().patchSkill(name, oldContent, content));
      case "edit":
        return notifyCuration(lib().editSkill(name, content));
      case "delete":
        return notifyCuration(lib().deleteSkill(name));
      case "write_file":
        return notifyCuration(lib().writeSkillFile(name, relativePath, content));
      case "remove_file":
        return notifyCuration(lib().removeSkillFile(name, relativePath));
      case "enable":
        return notifyCuration(lib().setEnabled(name, true));
      case "disable":
        return notifyCuration(lib().setEnabled(name, false));
      default:
        return `Rejected: unknown action ${JSON.stringify(action)}`;
    }
}

export const load_skill: ToolDef = {
  name: "load_skill",
  description:
    "Load the FULL instructions of a skill from the skills index.\n\n" +
    "Call this BEFORE doing a task when a listed skill matches it, then follow " +
    "the loaded instructions with your regular tools. The index only shows " +
    "names/descriptions; this returns the complete SKILL.md (steps, tool calls, " +
    "references to other files inside the skill).",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "Skill name from the skills index." },
    },
    required: ["name"],
  },
  execute(args) {
    return lib().loadSkill(String(args.name ?? ""));
  },
};
