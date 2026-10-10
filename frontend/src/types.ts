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
}

export interface Health {
  status: string;
  model: string;
  base_url: string;
  memory_chars: number;
  memory_budget: number;
  /** Tool names bound into the agent loop. */
  tools: string[];
  sessions: number;
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
