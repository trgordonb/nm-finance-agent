// Load .env with override=true so exported shell vars never silently redirect the LLM.
import dotenv from "dotenv";
dotenv.config({ override: true });

import fs from "node:fs";
import path from "node:path";

export const MEMORY_CHAR_LIMIT = 3575; // combined MEMORY.md + USER.md budget PER USER (Hermes-style, matches nm-memory-layer)

export const MEMORY_DIR =
  process.env.MEMORY_DIR && process.env.MEMORY_DIR.trim()
    ? path.resolve(process.env.MEMORY_DIR.trim())
    : path.resolve("./memories");

// Read-only project memory composed into every user's prompt. Separate budget
// from the per-user MEMORY.md + USER.md pair; memory_manage cannot edit it.
export const SHARED_MEMORY_CHAR_LIMIT =
  Number(process.env.SHARED_MEMORY_CHAR_LIMIT ?? "2000") || 2000;

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

// Auth-off fallback for the user-scoped workspace (WORKSPACE_DIR/<id>).
// With AUTH_MODE=sso the SSO login id selects the folder instead. Empty =
// flat legacy workspace (tests / single-user dev).
export const WORKSPACE_USER = (process.env.WORKSPACE_USER ?? "").trim();

export const SKILLS_DIR =
  process.env.SKILLS_DIR && process.env.SKILLS_DIR.trim()
    ? path.resolve(process.env.SKILLS_DIR.trim())
    : path.resolve("./skills");

export const SKILLS_STATE_DIR =
  process.env.SKILLS_STATE_DIR && process.env.SKILLS_STATE_DIR.trim()
    ? path.resolve(process.env.SKILLS_STATE_DIR.trim())
    : path.resolve("./state");

// Per-user agentdb MCP stores (reflexion episodes, skills, patterns). Each
// login gets its own SQLite DB under this directory; the MCP client spawns a
// dedicated stdio server for the active user. mcp_servers.json interpolates
// this same variable for the boot-time discovery DB.
export const AGENTDB_MCP_DIR =
  process.env.AGENTDB_MCP_DIR && process.env.AGENTDB_MCP_DIR.trim()
    ? path.resolve(process.env.AGENTDB_MCP_DIR.trim())
    : path.join(SKILLS_STATE_DIR, "agentdb");
process.env.AGENTDB_MCP_DIR = AGENTDB_MCP_DIR;

// Per-user skill toggle profile (state/users/<id>/skills.json). The registry
// CLI reads the same variable. Sanitised to one path segment: the value will
// come from OAuth before long, and it must never traverse directories.
const RAW_SKILLS_USER_ID = (process.env.SKILLS_USER_ID ?? "").trim() || "default";
export const SKILLS_USER_ID = /^[a-zA-Z0-9._-]{1,64}$/.test(RAW_SKILLS_USER_ID)
  ? RAW_SKILLS_USER_ID
  : "default";

// SKILLS_REQUIRED=1 makes the boot pull a hard dependency: a failed pull or an
// empty working copy refuses to serve. On a fresh VM an unseeded bucket and a
// missing CLI both look like "healthy but skill-less" without this.
export const SKILLS_REQUIRED = ["1", "true", "yes", "on"].includes(
  (process.env.SKILLS_REQUIRED ?? "").toLowerCase(),
);

// The self-hosted llmwiki service the Wiki tab reads through /api/wiki/*
// (read-only, allow-listed passthrough — see src/wiki-proxy.ts). The llm-wiki
// skill's helper resolves the same service from its own .env; this is only the
// server-side default for the proxy.
export const WIKI_API_URL =
  (process.env.WIKI_API_URL ?? "").trim() || "http://127.0.0.1:8010";

// Bearer for the llmwiki service. Empty is right for the local Docker
// deployment, whose read routes are open; the Cloudflare Containers Worker
// gates reads too, so a remote service needs the same INGEST_API_TOKEN here.
export const WIKI_API_TOKEN = (process.env.WIKI_API_TOKEN ?? "").trim();

// The Wiki tab read is synchronous. 15 s was enough for localhost; a cold
// start behind Cloudflare Containers (boot + uvicorn) can take longer, so the
// proxy budget matches the skill's `wait` loop instead.
export const WIKI_PROXY_TIMEOUT_MS =
  Number(process.env.WIKI_PROXY_TIMEOUT_MS ?? 60_000) || 60_000;

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
  process.env.OPENROUTER_MODEL_SUMMARIZER || "poolside/laguna-xs-2.1:free";
// Preferred provider order for the main model ("a,b,c"), passed as
// provider:{order, allow_fallbacks} per OpenRouter API. Unknown/absent → undefined.
export const OPENROUTER_PROVIDER_ORDER = (process.env.OPENROUTER_MAIN_MODEL_PROVIDER ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
// Provider slugs to exclude entirely (OpenRouter provider.ignore). This is a
// content-quality guard: a provider can return HTTP 200 with degenerate text,
// which fallbacks cannot detect. Relace has done this live (2026-10-19).
export const OPENROUTER_PROVIDER_IGNORE = (process.env.OPENROUTER_PROVIDER_IGNORE ?? "")
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
// Iterations remaining at which the loop injects the one-time wrap-up nudge
// (persist state, end the turn) instead of letting the turn die at the hard cap.
export const BUDGET_WRAPUP_REMAINING = Number(process.env.BUDGET_WRAPUP_REMAINING ?? "5");
export const EXECUTE_TIMEOUT_MS = Number(process.env.EXECUTE_TIMEOUT_MS ?? "120000");

// Optional session-search condensation (Hermes-style). It is enrichment only:
// a slow free model must never hold a turn for the full LLM timeout. On
// timeout/abort the tool falls back to raw excerpts.
export const SEARCH_SUMMARIZER_TIMEOUT_MS = Number(
  process.env.SEARCH_SUMMARIZER_TIMEOUT_MS ?? "20000",
);
export const SEARCH_SUMMARIZER_MAX_ATTEMPTS = Number(
  process.env.SEARCH_SUMMARIZER_MAX_ATTEMPTS ?? "2",
);

// --- Deep research mode (/research) ------------------------------------------
// Port of thinkdepth-ai's research mode (docs/deep-research-plan.md). All
// research LLM roles run on the single OPENROUTER_MODEL_MAIN (glm-5.3-flash)
// through the existing chat() client — no per-role models, no multi-provider
// fan-out for now. The page-summary LLM fallback uses the existing summarizer
// model; Exa (EXA_API_KEY) is the first-choice summarizer.
export const RESEARCH_MODE_ENABLED = (process.env.RESEARCH_MODE_ENABLED ?? "1") !== "0";
export const RESEARCH_MAX_CONCURRENT = Number(process.env.RESEARCH_MAX_CONCURRENT ?? "3");
export const RESEARCH_MAX_SUPERVISOR_ITERATIONS = Number(process.env.RESEARCH_MAX_SUPERVISOR_ITERATIONS ?? "10");
// ConductResearch batches, not supervisor tool calls. Each round is minutes of
// parallel work; two rounds cover the brief without the 4-6 round tail the
// 2026-10-19 MSFT trace showed.
export const RESEARCH_MAX_RESEARCH_ROUNDS = Number(process.env.RESEARCH_MAX_RESEARCH_ROUNDS ?? "2");
export const RESEARCH_MAX_RESEARCHER_TURNS = Number(process.env.RESEARCH_MAX_RESEARCHER_TURNS ?? "5");
// Per-researcher search budget. The researcher prompt says "5 searches max";
// this is the enforceable ceiling (turns can issue several searches each).
export const RESEARCH_MAX_RESEARCHER_SEARCHES = Number(
  process.env.RESEARCH_MAX_RESEARCHER_SEARCHES ?? "6",
);
export const RESEARCH_TOKEN_BUDGET = Number(process.env.RESEARCH_TOKEN_BUDGET ?? "300000");
export const RESEARCH_SEARCH_MAX_RESULTS = Number(process.env.RESEARCH_SEARCH_MAX_RESULTS ?? "3");
export const RESEARCH_PAGE_CONTEXT_CHARS = Number(process.env.RESEARCH_PAGE_CONTEXT_CHARS ?? "60000");
export const RESEARCH_LLM_MIN_INTERVAL_MS = Number(process.env.RESEARCH_LLM_MIN_INTERVAL_MS ?? "1200");
export const RESEARCH_DEADLINE_MINUTES = Number(process.env.RESEARCH_DEADLINE_MINUTES ?? "15");
// GLM "always thinks"; low effort is the Python original's thinking="off"
// mapping. Provider-default reasoning produced 14-22K-token calls here.
const RESEARCH_REASONING_RAW = (process.env.RESEARCH_REASONING_EFFORT ?? "low").trim().toLowerCase();
export const RESEARCH_REASONING_EFFORT: "low" | "medium" | "high" =
  RESEARCH_REASONING_RAW === "medium" || RESEARCH_REASONING_RAW === "high"
    ? RESEARCH_REASONING_RAW
    : "low";
export const RESEARCH_LLM_TIMEOUT_MS = Number(
  process.env.RESEARCH_LLM_TIMEOUT_MS ?? "600000",
);
export const RESEARCH_LLM_MAX_ATTEMPTS = Number(
  process.env.RESEARCH_LLM_MAX_ATTEMPTS ?? "2",
);
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

// Per-user memory landed 2026-10-24; a leftover root MEMORY.md/USER.md is no
// longer read. Warn loudly so an old process or a partial migration is visible.
for (const legacy of ["MEMORY.md", "USER.md"]) {
  if (fs.existsSync(path.join(MEMORY_DIR, legacy))) {
    console.error(
      `WARN legacy global memory ${legacy} at ${MEMORY_DIR} is ignored — move it to ${MEMORY_DIR}/<login-id>/`,
    );
  }
}

if (!fs.existsSync(WORKSPACE_DIR)) {
  fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
}
