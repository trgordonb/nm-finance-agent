// Tool contract: JSON-schema tools, string results.
// Recovery convention kept from the LangGraph harness: results starting with
// "Error:" are fatal for the turn (providers/system-level failures, wrong args,
// timeouts). Everything else — including "Rejected:"-style recoverable denials —
// is handed back to the model to reason about and retry.

export type JsonSchemaType = "string" | "number" | "boolean" | "array" | "object";

export interface ToolParam {
  type: JsonSchemaType;
  description: string;
  enum?: string[];
  items?: { type: JsonSchemaType; description?: string };
}

/** Optional per-call execution context (passed by the loop; tools that don't
 *  need it ignore the second parameter). The signal carries turn cancellation
 *  — e.g. the deep_research tool aborts its run on Stop. */
export interface ToolContext {
  signal?: AbortSignal;
}

export interface ToolDef {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, ToolParam>;
    required?: string[];
  };
  /** Default true. When false, an `Error:` result is still shown to the model
   *  but does not end the turn. Use for optional side-effect tools such as
   *  AgentDB learning feedback. */
  fatalOnError?: boolean;
  execute(args: Record<string, unknown>, ctx?: ToolContext): Promise<string> | string;
}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

// Wire-format messages for the provider and for serialization to the archive.
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: ToolCall[]; // assistant only
  tool_call_id?: string; // tool only
  name?: string; // tool only — the tool's name
  /** Provider-observed usage on the assistant message that produced it —
   *  the truest current-usage measure for the compression trigger (live
   *  per run; not persisted — resume falls back to the chars/4 estimate). */
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

// One completed agent turn as persisted in the archive (turn row in SQLite).
export interface Turn {
  sessionId: string;
  turnNumber: number;
  messages: ChatMessage[];
}
