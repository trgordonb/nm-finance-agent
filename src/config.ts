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

export const serverHost = process.env.SERVER_HOST || "127.0.0.1";
export const serverPort = Number(process.env.SERVER_PORT || "3001");

// Create the memory dir when absent so add() works immediately.
if (!fs.existsSync(MEMORY_DIR)) {
  fs.mkdirSync(MEMORY_DIR, { recursive: true });
}

if (!fs.existsSync(WORKSPACE_DIR)) {
  fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
}
