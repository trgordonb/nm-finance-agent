// session_search + session archive: the episodic store is wired into the same
// registry so the agent can consult prior sessions. (Kept simple; secondary-LLM
// condensation is a later increment.)

import { SessionStore } from "../store.js";
import type { ToolDef } from "../types.js";

export function createSessionSearchTool(store: SessionStore): ToolDef {
  return {
    name: "session_search",
    description:
      "Search YOUR archived past sessions (previous conversations). Call BEFORE redoing work when the " +
      "user's request may relate to prior decisions, findings, errors and fixes, or procedures you already " +
      "worked out. Returns short excerpts, not full transcripts — cheap to consult.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Free-text search (keywords win over prose)." },
        limit: { type: "number", description: "Max results, default 5." },
      },
      required: ["query"],
    },
    execute(args) {
      try {
        const limit = Math.max(1, Math.min(Number(args.limit ?? 5) || 5, 20));
        return store.search(String(args.query ?? ""), limit);
      } catch (e) {
        return `Error: session_search failed: ${(e as Error).message}`;
      }
    },
  };
}
