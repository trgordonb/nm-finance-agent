// Deep research engine types. The pipeline is a flattened, LangGraph-free
// port of the thinkdepth-ai research mode (see docs/deep-research-plan.md):
// scope → brief → outline → supervisor fan-out → researchers → compress →
// refine → final report.

import type { ChatMessage, ToolDef } from "../types.js";
import type { ChatOpts, ChatResponse } from "../llm.js";

/** The chat client signature (src/llm.ts), injectable so the whole engine
 *  tests offline with stubbed models. */
export type ChatFn = (
  messages: ChatMessage[],
  tools?: Array<{ name: string; description: string; parameters: unknown }>,
  opts?: ChatOpts,
) => Promise<ChatResponse>;

/** Run lifecycle (persisted by the server layer in Stage 2). */
export type ResearchRunStatus =
  | "running"
  | "awaiting_clarification"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

export type ResearchStep =
  | "scope"
  | "brief"
  | "outline"
  | "supervisor"
  | "researchers"
  | "refine"
  | "final_report";

/** Progress event emitted for the CLI logs / SSE stream. */
export interface ResearchEvent {
  status: "running";
  step: ResearchStep;
  detail: string;
  iteration?: number;
  researcher?: number;
  topic?: string;
}

export interface ResearchUsage {
  prompt_tokens: number;
  completion_tokens: number;
}

export interface ResearchLimits {
  /** Max parallel researcher sub-loops per fan-out chunk. */
  maxConcurrent: number;
  /** Supervisor tool-call iterations before a forced stop (prompt's max_researcher_iterations). */
  maxSupervisorIterations: number;
  /** ConductResearch batches before the supervisor is forced to wrap up. */
  maxResearchRounds: number;
  /** Hard per-researcher tool turns before compress (upstream had no cap). */
  maxResearcherTurns: number;
  /** Hard per-researcher Tavily searches before compression is forced. */
  maxResearcherSearches: number;
  /** Per-researcher input+output token budget (0 = unlimited). */
  tokenBudget: number;
  /** Tavily results per search call. */
  searchMaxResults: number;
  /** Cap on raw page text fed to summarization (MAX_CONTEXT_LENGTH parity). */
  pageContextChars: number;
  /** Whole-run wall-clock cap; 0 = off. */
  deadlineMs: number;
  /** Min spacing between research LLM calls (relaxes the 4s global guard). */
  minCallIntervalMs: number;
  /** Reasoning effort for every research role (GLM "thinks" even at low). */
  reasoningEffort: "low" | "medium" | "high";
  /** Per-request HTTP timeout for research LLM calls. */
  llmTimeoutMs: number;
  /** Retry attempts for research LLM calls (1 = no retry). */
  llmMaxAttempts: number;
}

/** Model roles. Main roles default to the per-user main model (workspace
 *  default OPENROUTER_MODEL_MAIN); the summarizer role defaults to the
 *  per-user summarizer model. The seam stays so a future role split is a
 *  config change, not a refactor. */
export interface ResearchRoles {
  toolLoop: string;
  writer: string;
  summarizer: string;
}

export interface SearchResult {
  title: string;
  url: string;
  content: string;
  score?: number;
  published_date?: string;
  raw_content?: string | null;
}

export type SearchFn = (
  query: string,
  opts: { maxResults: number; topic: "general" | "news" | "finance" },
) => Promise<SearchResult[]>;

export interface ResearcherResult {
  topic: string;
  compressed: string;
  rawNotes: string;
  usage: ResearchUsage;
}

export interface SupervisorResult {
  notes: string[];
  draftReport: string;
  rawNotes: string[];
  usage: ResearchUsage;
}

export interface ResearchDeps {
  chat: ChatFn;
  /** Research-only tool surface bound inside researcher loops. */
  researchTools: ToolDef[];
  limits: ResearchLimits;
  roles: ResearchRoles;
  emit: (event: ResearchEvent) => void;
  /** Called as user-visible assistant messages are produced (verification,
   *  clarification question, final report) — the server streams/persists
   *  these; optional (CLI ignores it). */
  onMessage?: (message: ChatMessage) => void;
  shouldStop: () => boolean;
  signal?: AbortSignal;
  /** LangSmith root run id — llm/tool child runs attach to it (optional). */
  traceParent?: string;
  startedAt: number;
  /** Stage runners, injectable for tests (defaults wired in orchestrator). */
  runResearcher: (topic: string, deps: ResearchDeps) => Promise<ResearcherResult>;
  runSupervisor: (
    input: { brief: string; draftReport: string },
    deps: ResearchDeps,
  ) => Promise<SupervisorResult>;
}

export interface ResearchOutcome {
  status: "completed" | "awaiting_clarification" | "cancelled";
  report?: string;
  clarification?: string;
  /** Assistant-visible messages produced (verification / clarification / report). */
  messages: ChatMessage[];
  usage: ResearchUsage;
}

/** Internal control-flow error: the run must stop (cancel or deadline). */
export class ResearchCancelled extends Error {
  constructor(message = "research cancelled") {
    super(message);
    this.name = "ResearchCancelled";
  }
}
