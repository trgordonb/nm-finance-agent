// Wiki-first routing is a prompt-level contract: the model must see the
// private Wiki as the first retrieval path for personal/ingested context, and
// the tool must be directly visible on the wire.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.SKILLS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "nmfa-wiki-prompt-"));
process.env.LANGSMITH_TRACING = "0";

const { buildSystemPrompt } = await import("../agent.js");
const { buildToolRegistry, toWire } = await import("../tools/index.js");

test("system prompt routes personal/ingested context through private wiki_search first", () => {
  const prompt = buildSystemPrompt("", "/tmp/workspace");
  assert.match(prompt, /WIKI-FIRST ROUTING/);
  assert.match(prompt, /wiki_search/);
  assert.match(prompt, /scope "private".*before internet_search or scholar-search/);
  assert.match(prompt, /Use scope "common" only when the user explicitly asks/);
  assert.match(prompt, /If the private wiki has nothing relevant, say so/);
  assert.match(prompt, /not an unconditional wiki search on every question/);
});

test("wiki_search is in the base wire tool list", () => {
  const tools = buildToolRegistry({} as never);
  assert.ok(tools.some((tool) => tool.name === "wiki_search"));
  const wire = toWire(tools);
  const entry = wire.find((tool) => tool.name === "wiki_search");
  assert.ok(entry);
  assert.match(entry.description, /private knowledge base/i);
  assert.match(entry.description, /scope "common" only/i);
});
