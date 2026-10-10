// Tool registry — the flat ToolDef surface (no special cases in the loop).
// Step-1 core: filesystem ops, shell execution, web fetch/search, always-on
// prompt memory, episodic session search (now hybrid via the AgentDB mirror).
// Skills, wiki, MCP binding, nudge/compression plug in later as plain entries.

import type { ToolDef } from "../types.js";
import { ls, read_file, write_file, edit_file, glob, grep } from "./fs.js";
import { execute } from "./shell.js";
import { web_to_markdown, internet_search } from "./web.js";
import { memory_manage } from "./memory_manage.js";
import { skill_manage, load_skill } from "./skill_tools.js";
import { createSessionSearchTool } from "./session_search.js";
import type { SessionDriver } from "../driver.js";
import type { AgentDbMirror } from "../agentdb-mirror.js";

export function buildToolRegistry(
  driver: SessionDriver,
  mirror?: AgentDbMirror | null,
): ToolDef[] {
  return [
    ls,
    read_file,
    write_file,
    edit_file,
    glob,
    grep,
    execute,
    web_to_markdown,
    internet_search,
    memory_manage,
    skill_manage,
    load_skill,
    createSessionSearchTool(driver, mirror),
  ];
}

/** OpenAI wire format for a tool list. */
export function toWire(tools: ToolDef[]) {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }));
}
