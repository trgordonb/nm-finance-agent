// Trimmed for step-1 scope: only the shapes the Chat tab consumes.
// Backend adapter for nm-finance-agent's Express API (not the FastAPI one):
// sessions carry ISO `created_at` strings and `turn_count`, health carries a
// tool list instead of skills/mcp/wiki flags.

export type Role = "user" | "assistant" | "tool";

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

/** One rendered row in the conversation feed. */
export type FeedItem = MessageItem | SystemItem | NoticeItem;

export interface MessageItem {
  kind: "message";
  id: string;
  role: Role;
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  toolName?: string;
  status?: string;
}

/** Dim inline status rows (turn complete / cancelled). */
export interface SystemItem {
  kind: "system";
  id: string;
  text: string;
  tone: "info" | "warn";
}

/** Persistent banner across the top of the feed (errors). */
export interface NoticeItem {
  kind: "notice";
  id: string;
  text: string;
  tone: "info" | "warn";
}

/** Omit that distributes over unions — id-less FeedItem for queueing new rows. */
export type NewItem = DistributiveOmit<FeedItem, "id">;
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export interface SessionInfo {
  session_id: string;
  /** ISO timestamp string (SQLite strftime output). */
  created_at: string;
  turn_count: number;
  message_count: number;
  /** One-line title (fallback truncated first user message, LLM-refined). */
  summary?: string | null;
  /** Deep-research run state when the session has one (running,
   *  awaiting_clarification, completed, failed, cancelled, interrupted). */
  research_status?: string | null;
  /** Owning agent-cron job name when the session belongs to a scheduled job. */
  cron_name?: string | null;
}

/** One agent-cron job (GET /api/cron/jobs). Booleans arrive as SQLite ints. */
export interface CronJobInfo {
  id: string;
  name: string;
  schedule_kind: "cron" | "interval" | "once";
  schedule_expr: string;
  payload: string;
  session_id: string | null;
  enabled: number;
  next_run_at: number | null;
  last_run_at: number | null;
  last_status: string | null;
  last_error: string | null;
  failure_streak: number;
  timezone: string | null;
  running?: boolean;
}

/** One recorded fire of a cron job. */
export interface CronRunInfo {
  id: string;
  fire_at: number;
  started_at: number | null;
  finished_at: number | null;
  status: string;
  iterations: number | null;
  error: string | null;
  result_excerpt: string | null;
}

export interface Health {
  status: string;
  model: string;
  base_url: string;
  memory_chars: number | null;
  memory_budget: number;
  shared_memory_chars?: number;
  /** Tool names bound into the agent loop. */
  tools: string[];
  sessions: number;
  skills?: number;
  /** Skills R2 lifecycle status (src/skills/sync.ts bridge). */
  skills_backend?: {
    mode: "s3" | "local";
    registry?: string;
    cliAvailable?: boolean;
    lastSync?: { at: string; pulled: number; removed: number; unchanged: number; pushed?: number; error?: string };
    lastPush?: { at: string; uploaded: number; pruned: number; error?: string };
    pendingPush?: boolean;
    error?: string;
  };
  /** Auth layer (src/auth/config.ts): `off` = no login, `sso` = cookie session. */
  auth?: {
    mode: "off" | "sso";
    required_permission: string | null;
  };
}

/** Admin view of a registry skill (GET /api/skills — includes disabled ones). */
export interface SkillInfo {
  name: string;
  description: string;
  path: string;
  relDir: string;
  enabled: boolean;
}

/** One MCP server from mcp_servers.json (GET /api/mcp). */
export interface McpServerInfo {
  name: string;
  enabled: boolean;
  /** Admin baseline from mcp_servers.json; false cannot be enabled per-user. */
  global_enabled?: boolean;
  description?: string;
  transport?: string;
  error?: string | null;
  connected?: boolean | null;
  tool_count?: number | null;
  connect_error?: string | null;
}

export interface McpListResponse {
  assembled: boolean;
  servers: McpServerInfo[];
}

/** Extracted "next steps" tips for a session (followups parity). `dismissed`
 *  indexes into `items`; dismissed items stay in the payload. */
export interface Followups {
  session_id: string;
  items: string[];
  dismissed: number[];
  model?: string | null;
  created_at?: number | null;
}

export interface ApiMessage {
  role: Role;
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  tool_name?: string;
  name?: string;
  status?: string;
}

/** Wiki-tab partition: the signed-in user's private wiki or the shared one. */
export type WikiScope = "private" | "common";

/** Wiki tab: one registered llmwiki domain (GET /api/wiki/domains). */
export interface WikiDomain {
  name: string;
  description: string;
  created: string | null;
}

/** Wiki tab: one page row of the progressive-disclosure index
 *  (GET /api/wiki/concepts?domain=). */
export interface WikiGist {
  slug: string;
  title: string;
  type: string;
  gist: string;
  sources: string[];
  updated: string | null;
  version: number;
}

/** Wiki tab: one retrieval result (GET /api/wiki/search). Wiki-origin hits
 *  carry `slug`; chunk-origin hits carry `source_id` (its source-note page). */
export interface WikiSearchHit {
  id: string;
  score: number;
  origin: "wiki" | "chunk";
  text: string;
  slug: string | null;
  source_id: string | null;
  metadata: Record<string, unknown>;
  domain: string;
}

/** GET /api/user/llm-key — status only; the raw key never leaves the server. */
export interface UserLlmKeyStatus {
  present: boolean;
  policy: string;
  require_user_enforced: boolean;
  require_user_warn_deadline: number | null;
  masked: string | null;
  label: string | null;
  usage_usd: number | null;
  limit: number | null;
  is_free_tier: boolean | null;
}

/** GET /api/user/llm-usage — harness-side per-user spend ledger. */
export interface LlmUsageSummary {
  totals: { calls: number; prompt_tokens: number; completion_tokens: number; cost_usd: number | null };
  days: Array<{ day: string; calls: number; prompt_tokens: number; completion_tokens: number; cost_usd: number | null }>;
}
