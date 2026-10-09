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

// HARD_JAIL=1 refuses all fs writes/executes outside the workspace — the
// posture for network-exposed deployments (SERVER_HOST=0.0.0.0 etc.).
export const WORKSPACE_HARD_JAIL = ["1", "true", "yes", "on"].includes(
  (process.env.WORKSPACE_HARD_JAIL ?? "").toLowerCase(),
);

export const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? "";
export const OPENAI_MODEL_ID = process.env.OPENAI_MODEL_ID || "glm-5.3-flash";
export const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL || "https://api.b.ai/v1/";

export const MAX_COMPLETION_TOKENS = Number(process.env.MAX_COMPLETION_TOKENS ?? "16384");
export const BUDGET_TOOL_MAX_ITERATIONS = Number(process.env.BUDGET_TOOL_MAX_ITERATIONS ?? "25");
export const EXECUTE_TIMEOUT_MS = Number(process.env.EXECUTE_TIMEOUT_MS ?? "30000");

export const serverHost = process.env.SERVER_HOST || "127.0.0.1";
export const serverPort = Number(process.env.SERVER_PORT || "3001");

// Create the memory dir when absent so add() works immediately.
if (!fs.existsSync(MEMORY_DIR)) {
  fs.mkdirSync(MEMORY_DIR, { recursive: true });
}

if (!fs.existsSync(WORKSPACE_DIR)) {
  fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
}
