// Load .env with override=true so exported shell vars never silently redirect the LLM.
import dotenv from "dotenv";
dotenv.config({ override: true });

import fs from "node:fs";
import path from "node:path";

export const MEMORY_CHAR_LIMIT = 3575; // combined MEMORY.md + USER.md budget (Hermes-style, matches nm-memory-layer)

export const MEMORY_DIR =
  process.env.MEMORY_DIR && process.env.MEMORY_DIR.trim()
    ? path.resolve(process.env.MEMORY_DIR.trim())
    : path.resolve("./memories");

export const MEMORY_MD_PATH = path.join(MEMORY_DIR, "MEMORY.md");
export const USER_MD_PATH = path.join(MEMORY_DIR, "USER.md");

export const DB_PATH =
  process.env.SESSION_DB_PATH && process.env.SESSION_DB_PATH.trim()
    ? path.resolve(process.env.SESSION_DB_PATH.trim())
    : path.resolve("./sessions.db");

// The agent's scratch area (outputs, downloads, datasets). Relative paths in
// the fs tools and `execute` resolve against this dir (python-repo workspace
// practice, carried over). Absolute paths stay allowed for reading real
// sources; writes outside the workspace hit the guard in tools/fs.ts.
export const WORKSPACE_DIR =
  process.env.WORKSPACE_DIR && process.env.WORKSPACE_DIR.trim()
    ? path.resolve(process.env.WORKSPACE_DIR.trim())
    : path.resolve("./workspace");

export const SKILLS_DIR =
  process.env.SKILLS_DIR && process.env.SKILLS_DIR.trim()
    ? path.resolve(process.env.SKILLS_DIR.trim())
    : path.resolve("./skills");

export const SKILLS_STATE_DIR =
  process.env.SKILLS_STATE_DIR && process.env.SKILLS_STATE_DIR.trim()
    ? path.resolve(process.env.SKILLS_STATE_DIR.trim())
    : path.resolve("./state");

// The self-hosted llmwiki service the Wiki tab reads through /api/wiki/*
// (read-only, allow-listed passthrough — see src/wiki-proxy.ts). The llm-wiki
// skill's helper resolves the same service from its own .env; this is only the
// server-side default for the proxy.
export const WIKI_API_URL =
  (process.env.WIKI_API_URL ?? "").trim() || "http://127.0.0.1:8010";

// HARD_JAIL=1 refuses all fs writes/executes outside the workspace — the
// posture for network-exposed deployments (SERVER_HOST=0.0.0.0 etc.).
export const WORKSPACE_HARD_JAIL = ["1", "true", "yes", "on"].includes(
  (process.env.WORKSPACE_HARD_JAIL ?? "").toLowerCase(),
);

export const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY ?? process.env.OPENAI_API_KEY ?? "";
export const OPENROUTER_BASE_URL = process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1";
// Main agent model (all loop LLM calls). Legacy OPENAI_MODEL_ID respected as fallback.
export const OPENROUTER_MODEL_MAIN =
  process.env.OPENROUTER_MODEL_MAIN || process.env.OPENROUTER_MODEL || process.env.OPENAI_MODEL_ID || "z-ai/glm-5.3-flash";
// Secondary/cheap model for future summarizer/nudge/compression increments.
export const OPENROUTER_MODEL_SUMMARIZER =
  process.env.OPENROUTER_MODEL_SUMMARIZER || "liquid/lfm-2.5-2.6b:free";
// Preferred provider order for the main model ("a,b,c"), passed as
// provider:{order, allow_fallbacks} per OpenRouter API. Unknown/absent → undefined.
export const OPENROUTER_PROVIDER_ORDER = (process.env.OPENROUTER_MAIN_MODEL_PROVIDER ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
export const OPENROUTER_PROVIDER_FALLBACKS =
  (process.env.OPENROUTER_PROVIDER_FALLBACKS ?? "1") !== "0";
// "reasoning": {enabled} matches the user's example call; disable with
// OPENROUTER_REASONING=0 (some flat models bill extra reasoning tokens).
export const OPENROUTER_REASONING = (process.env.OPENROUTER_REASONING ?? "1") !== "0";

export const MAX_COMPLETION_TOKENS = Number(process.env.MAX_COMPLETION_TOKENS ?? "16384");
export const BUDGET_TOOL_MAX_ITERATIONS = Number(process.env.BUDGET_TOOL_MAX_ITERATIONS ?? "25");
export const EXECUTE_TIMEOUT_MS = Number(process.env.EXECUTE_TIMEOUT_MS ?? "120000");

// --- Deep research mode (/research) ------------------------------------------
// Port of thinkdepth-ai's research mode (docs/deep-research-plan.md). All
// research LLM roles run on the single OPENROUTER_MODEL_MAIN (glm-5.3-flash)
// through the existing chat() client — no per-role models, no multi-provider
// fan-out for now. The page-summary LLM fallback uses the existing summarizer
// model; Exa (EXA_API_KEY) is the first-choice summarizer.
export const RESEARCH_MODE_ENABLED = (process.env.RESEARCH_MODE_ENABLED ?? "1") !== "0";
export const RESEARCH_MAX_CONCURRENT = Number(process.env.RESEARCH_MAX_CONCURRENT ?? "3");
export const RESEARCH_MAX_SUPERVISOR_ITERATIONS = Number(process.env.RESEARCH_MAX_SUPERVISOR_ITERATIONS ?? "15");
export const RESEARCH_MAX_RESEARCHER_TURNS = Number(process.env.RESEARCH_MAX_RESEARCHER_TURNS ?? "8");
export const RESEARCH_TOKEN_BUDGET = Number(process.env.RESEARCH_TOKEN_BUDGET ?? "2000000");
export const RESEARCH_SEARCH_MAX_RESULTS = Number(process.env.RESEARCH_SEARCH_MAX_RESULTS ?? "3");
export const RESEARCH_PAGE_CONTEXT_CHARS = Number(process.env.RESEARCH_PAGE_CONTEXT_CHARS ?? "60000");
export const RESEARCH_LLM_MIN_INTERVAL_MS = Number(process.env.RESEARCH_LLM_MIN_INTERVAL_MS ?? "1200");
export const RESEARCH_DEADLINE_MINUTES = Number(process.env.RESEARCH_DEADLINE_MINUTES ?? "0");
export const RESEARCH_SAVE_REPORTS = (process.env.RESEARCH_SAVE_REPORTS ?? "1") !== "0";
// Expose the research engine to the main agent as the `deep_research` tool
// (default off: a run takes 20-40 minutes and real spend — the /research
// prefix remains the primary invocation).
export const RESEARCH_AS_TOOL = ["1", "true", "yes", "on"].includes(
  (process.env.RESEARCH_AS_TOOL ?? "").trim().toLowerCase(),
);
export const EXA_API_KEY = process.env.EXA_API_KEY ?? "";
export const EXA_SUMMARIZER_ENABLED = (process.env.EXA_SUMMARIZER ?? "on") !== "off";

export const serverHost = process.env.SERVER_HOST || "127.0.0.1";
export const serverPort = Number(process.env.SERVER_PORT || "3001");

// Create the memory dir when absent so add() works immediately.
if (!fs.existsSync(MEMORY_DIR)) {
  fs.mkdirSync(MEMORY_DIR, { recursive: true });
}

if (!fs.existsSync(WORKSPACE_DIR)) {
  fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
}
