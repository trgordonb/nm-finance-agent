// Tool registry — step 1 surface mirrors the langgraph-demo harness core:
// filesystem ops, shell execution, web fetch/search, always-on prompt memory,
// episodic session search. MCP binding, skills, wiki, nudge/compression are
// later increments (design keeps ToolDef flat so they plug in as plain
// registry entries, no special cases in the loop).

import type { ToolDef } from "../types.js";
import { ls, read_file, write_file, edit_file, glob, grep } from "./fs.js";
import { execute } from "./shell.js";
import { web_to_markdown, internet_search } from "./web.js";
import { memory_manage } from "./memory_manage.js";
import { createSessionSearchTool } from "./session_search.js";
import { SessionStore } from "../store.js";

export function buildToolRegistry(store: SessionStore): ToolDef[] {
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
    createSessionSearchTool(store),
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
