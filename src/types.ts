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

export interface ToolDef {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, ToolParam>;
    required?: string[];
  };
  execute(args: Record<string, unknown>): Promise<string> | string;
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
}

// One completed agent turn as persisted in the archive (turn row in SQLite).
export interface Turn {
  sessionId: string;
  turnNumber: number;
  messages: ChatMessage[];
}
