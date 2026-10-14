// REST server (Express) exposing the agentic harness. Port of server.py's
// contract, step-1 scope: no wiki / followups / MCP — sessions, memory, chat
// over SSE, turn abort.
//
//   GET  /api/health               model + memory budget + tool count
//   GET  /api/sessions             archived sessions
//   GET  /api/sessions/:id         full message history
//   GET  /api/memory               MEMORY.md/USER.md rendered block + usage
//   POST /api/uploads/wiki         raw PDF body → workspace, for llm-wiki ingest
//   GET  /api/wiki/*               read-only llmwiki passthrough (Wiki tab)
//   POST /api/chat                 one agent turn as an SSE event stream
//   POST /api/chat/cancel          abort an active turn ({turn_id})
//
// SSE events: session / message / tool / nudge-free/error / done — mirrors
// the Python server's event vocabulary where applicable.

import express, { type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  serverHost,
  serverPort,
  OPENROUTER_MODEL_MAIN,
  OPENROUTER_BASE_URL,
  OPENROUTER_PROVIDER_ORDER,
  OPENROUTER_PROVIDER_FALLBACKS,
  OPENROUTER_REASONING,
  MEMORY_CHAR_LIMIT,
  WORKSPACE_DIR,
  WIKI_API_URL,
  EXA_API_KEY,
  RESEARCH_AS_TOOL,
  RESEARCH_MAX_CONCURRENT,
  RESEARCH_MODE_ENABLED,
  RESEARCH_SAVE_REPORTS,
} from "./config.js";
import { looksLikePdf, saveWikiUpload } from "./uploads.js";
import { buildWikiTarget, fetchWiki } from "./wiki-proxy.js";
import { PromptMemory } from "./memory.js";
import { SQLiteSessionStore } from "./store.js";
import { AgentDbMirror } from "./agentdb-mirror.js";
import { AgentLoop } from "./agent.js";
import { buildToolRegistry } from "./tools/index.js";
import { enabled as tracingEnabled, TRACE_PROJECT } from "./tracing.js";
import { log } from "./logger.js";
import { fallbackTitle, refineSessionTitle } from "./titler.js";
import { NudgePolicy, run_memory_nudge } from "./nudge.js";
import { createCompressor, type ConversationCompressor } from "./compression.js";
import { createSessionSearchSummarizer } from "./summarizer.js";
import { memory_manage } from "./tools/memory_manage.js";
import { skill_manage } from "./tools/skill_tools.js";
import { loadMcpServers, setServerEnabled, type ServerStatus as McpStatus } from "./mcp-config.js";
import { bindMcpTools, closeOpenClients } from "./mcp-tools.js";
import type { ToolDef, ChatMessage } from "./types.js";
import { initSkills, getSkillLibrary } from "./tools/skill_tools.js";
import { SkillsCliBridge } from "./skills/sync.js";
import {
  maybeExtractFollowups,
  getFollowups,
  followupCounts,
  dismissFollowup,
} from "./followups.js";
import { detectResearchMode, cleanResearchQuestion } from "./research/mode.js";
import { runDeepResearch } from "./research/orchestrator.js";
import { saveResearchReport } from "./research/reports.js";
import { createDeepResearchTool } from "./research/tool.js";
import type { ResearchEvent, ResearchOutcome } from "./research/types.js";

type McpReport = McpStatus[];

// --- runtime assembly ---------------------------------------------------------

const store = new SQLiteSessionStore();
// Runs mid-flight when the process last died can never resume (no task
// survives a restart) — mark them interrupted for the status API.
const staleRuns = store.markStaleResearchRunsInterrupted();
if (staleRuns) log.info(`research: marked ${staleRuns} stale running run(s) as interrupted`);
const memory = new PromptMemory();
const mirror = new AgentDbMirror();
// Secondary-LLM search condensation (Hermes-style): SEARCH_SUMMARIZER_ENABLED
// toggles the cheap-model filter over hybrid recall results (raw fallback).
const searchSummarizer = createSessionSearchSummarizer();
const loop = new AgentLoop({ memory, store, mirror, summarizer: searchSummarizer });

// Skills R2 lifecycle (Phase 2): the CLI (uv + nm-skills-registry) is the
// object-store authority tool; boot sync pulls the bucket into skills/ before
// the first session indexes it, curation pushes are debounced client-side.
const skillsBridge = new SkillsCliBridge();
initSkills(getSkillLibrary(), skillsBridge);

// MCP runtime assembly (python `_load_mcp_tools` + `assemble_agent_runtime`
// parity): base registry + per-server bound MCP tools; re-runnable for the
// reload endpoint. One bad server is skipped with a warning, never fatal.
let mcpReport: McpReport | null = null;
let runtimeReady: Promise<void> | null = null;

// Pre-flight context compression (Hermes Phase 5): env-toggled compressor
// (COMPRESSION_ENABLED=true w/ token threshold + keep-recent); the archive
// stays verbatim — lineage is recorded per compression, and the LIVE x-row
// window is the compressed view (idempotent on resume).
const compressor: ConversationCompressor | null = createCompressor();
if (compressor) log.info("context compression enabled");

// Periodic nudge (learning loop curation; python maybe_nudge parity).
import { chat } from "./llm.js";
const nudgeInterval = Number(process.env.NUDGE_INTERVAL || "5");
const nudgePolicy = new NudgePolicy(nudgeInterval);

async function maybeNudge(sessionId: string, newMessages: ChatMessage[]): Promise<string | undefined> {
  nudgePolicy.recordTurn(sessionId);
  if (!nudgePolicy.shouldNudge(sessionId)) return undefined;
  nudgePolicy.markNudged(sessionId);
  const skillTool = loop.tools.get("skill_manage") ?? skill_manage;
  const tools: Array<typeof memory_manage> = [memory_manage, skillTool].filter(
    (t, i, arr) => arr.findIndex((x) => x.name === t.name) === i,
  ) as never;
  return run_memory_nudge(newMessages, memory, tools as never, chat);
}

async function assembleRuntime(): Promise<McpReport> {
  const base = buildBaseRegistry();
  const load = loadMcpServers();
  const { tools, report } = await bindMcpTools(load);
  const all: ToolDef[] = [...base, ...tools];
  loop.setTools(all);
  log.info(`runtime assembled: ${all.length} tools (${tools.length} from ${Object.keys(load.clientServers).length} MCP server(s))`);
  return report;
}

/** The always-bound core registry (fs/shell/web/memory/session_search). */
function buildBaseRegistry() {
  const tools = buildToolRegistry(store, mirror, searchSummarizer);
  // Optional integration: expose the research engine to the main agent
  // (RESEARCH_AS_TOOL, default off — a run takes 20-40 min and real spend).
  if (RESEARCH_MODE_ENABLED && RESEARCH_AS_TOOL) tools.push(createDeepResearchTool());
  return tools;
}

function getRuntime(): Promise<void> {
  if (!runtimeReady) {
    runtimeReady = (async () => {
      // skill mirror must reflect the bucket before the first index/render
      await skillsBridge.syncAtBoot();
      mcpReport = await assembleRuntime();
    })().catch((e) => {
      // keep the server alive, toolless MCP; base tools remain bound
      log.error(`runtime assembly failed (base tools only): ${String(e).slice(0, 200)}`);
    });
  }
  return runtimeReady;
}

void mirror_initializeGracefully();

function mirror_initializeGracefully(): Promise<void> {
  return mirror
    .initialize()
    .then((status) => {
      if (!status.enabled) log.info(`agentdb mirror off — ${status.reason}`);
      return getRuntime(); // MCP binds after the mirror sidecar decision
    })
    .catch(() => getRuntime());
}

const app = express();
app.use(express.json({ limit: "4mb" }));
app.use((_req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (_req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }
  next();
});

const ACTIVE_TURNS = new Map<string, AbortController>();

function sse(event: string, payload: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}

// --- endpoints ----------------------------------------------------------------

app.get("/api/health", (_req: Request, res: Response) => {
  res.json({
    status: "ok",
    model: OPENROUTER_MODEL_MAIN,
    base_url: OPENROUTER_BASE_URL,
    provider_order: OPENROUTER_PROVIDER_ORDER,
    provider_fallbacks: OPENROUTER_PROVIDER_FALLBACKS,
    reasoning: OPENROUTER_REASONING,
    memory_chars: memory.totalChars(),
    memory_budget: MEMORY_CHAR_LIMIT,
    tools: [...loop.tools.keys()],
    skills: getSkillLibrary().listAll().length,
    skills_backend: skillsBridge.info,
    sessions: store.listSessions().length,
    mirror: mirror.getFastStatus(),
    mcp_connected: mcpReport ? mcpReport.filter((r) => r.connected && r.enabled).length : null,
    mcp_tools: [...loop.tools.keys()].filter((n) => n.includes("_")).length,
    tracing: tracingEnabled() ? TRACE_PROJECT : null,
    research: {
      enabled: RESEARCH_MODE_ENABLED,
      model: OPENROUTER_MODEL_MAIN,
      tavily: !!process.env.TAVILY_API_KEY,
      exa: !!EXA_API_KEY,
      max_concurrent: RESEARCH_MAX_CONCURRENT,
    },
    time: Date.now() / 1000,
  });
});

app.get("/api/sessions", (_req, res) => {
  res.json(store.listSessions());
});

// Longest prefix of a (possibly partial) turn that is safe to archive — mirror
// of server.py _valid_prefix_len: every assistant tool_call must be answered by
// its tool result before the next assistant message; a dangling group (cancel
// mid-tool) is dropped.
function validPrefixLen(messages: ChatMessage[]): number {
  let valid = 0;
  let pending = 0;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === "assistant") {
      if (pending > 0) break;
      const calls = m.tool_calls ?? [];
      pending = calls.filter((c) => c.id).length;
      if (pending === 0) valid = i + 1;
    } else if (m.role === "tool") {
      if (pending <= 0) break;
      pending -= 1;
      if (pending === 0) valid = i + 1;
    } else {
      if (pending > 0) break;
      valid = i + 1;
    }
  }
  return valid;
}

app.get("/api/sessions/:sessionId", (req, res) => {
  const messages = store.loadSession(req.params.sessionId);
  if (!messages.length) {
    res.status(404).json({ detail: `session not found: ${req.params.sessionId}` });
    return;
  }
  res.json({ session_id: req.params.sessionId, messages });
});

// Deep-research run state for a session (reconnect / status polling; the live
// stream carries the same steps as `research` SSE events).
app.get("/api/research/:sessionId", (req, res) => {
  const row = store.getResearchRun(req.params.sessionId);
  if (!row) {
    res.status(404).json({ detail: `no research run for session: ${req.params.sessionId}` });
    return;
  }
  res.json(row);
});

app.get("/api/memory", (_req, res) => {
  res.json({
    block: memory.load(),
    usage: memory.totalChars(),
    budget: MEMORY_CHAR_LIMIT,
  });
});

// --- wiki PDF upload (Chat UI attach → agent-side llm-wiki ingest) -----------
// The browser posts the PDF as the raw request body (the tree has no multipart
// parser); the filename rides the query string. The file lands under the
// workspace so the agent can hand it to the llm-wiki service, which cannot see
// host paths. The response is what the composer folds into the turn message.

app.post(
  "/api/uploads/wiki",
  express.raw({ type: ["application/pdf", "application/octet-stream"], limit: "25mb" }),
  (req, res) => {
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!body.length) {
      res.status(400).json({ detail: "empty body (POST the PDF as the raw request body)" });
      return;
    }
    if (!looksLikePdf(body)) {
      res.status(415).json({ detail: "not a PDF (no %PDF- header in the first KiB)" });
      return;
    }
    const name = String((req.query as Record<string, unknown>).name ?? "upload.pdf");
    const saved = saveWikiUpload(path.join(WORKSPACE_DIR, "uploads"), body, name);
    res.json({ path: `uploads/${saved.fileName}`, filename: saved.fileName, bytes: saved.bytes });
  },
);

// --- wiki read proxy (Wiki tab) ----------------------------------------------
// Read-only, allow-listed passthrough to the llmwiki service (see
// wiki-proxy.ts). The UI structurally cannot reach ingest/upload/compile
// through this route — only the read surface is forwardable.

app.get("/api/wiki/*", async (req, res) => {
  const splat = (req.params as { 0?: string })[0] ?? "";
  const built = buildWikiTarget(splat, req.query as Record<string, unknown>);
  if ("error" in built) {
    res.status(400).json({ detail: built.error });
    return;
  }
  try {
    const upstream = await fetchWiki(WIKI_API_URL, built.path);
    res.status(upstream.status).type(upstream.contentType).send(upstream.body);
  } catch (err) {
    res.status(502).json({
      detail: `llmwiki unreachable at ${WIKI_API_URL}: ${String(err).slice(0, 160)}`,
    });
  }
});

interface ChatRequest {
  message: string;
  session_id?: string;
}

app.post("/api/chat", (req, res) => {
  const { message, session_id } = (req.body ?? {}) as ChatRequest;
  if (!message || !message.trim()) {
    res.status(400).json({ detail: "message must be non-empty" });
    return;
  }

  const turnId = randomUUID();
  const controller = new AbortController();
  ACTIVE_TURNS.set(turnId, controller);

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  const sessionId = session_id && session_id.trim() ? session_id.trim() : store.newSessionId();

  let abandoned = false;
  const abortListener = () => {
    abandoned = true;
  };
  controller.signal.addEventListener("abort", abortListener);

  const write = (event: string, payload: unknown) => {
    if (!abandoned || event === "cancelled") res.write(sse(event, payload));
  };

  (async () => {
    try {
      await getRuntime(); // lazy runtime assembly (python getRuntime parity)
      let history = store.loadSession(sessionId);
      write("session", { session_id: sessionId, turn_id: turnId, resumed: history.length > 0 });

      // --- deep research (/research) ---------------------------------------
      // Prefix-detected, or the continuation of a run paused on a clarifying
      // question (no prefix needed) — python app.py parity.
      const pendingRun = store.getResearchRun(sessionId);
      const wantsResearch = detectResearchMode(message);
      const resumesResearch = !wantsResearch && pendingRun?.status === "awaiting_clarification";
      if (wantsResearch || resumesResearch) {
        const cleanedQuestion = cleanResearchQuestion(message);
        if (!RESEARCH_MODE_ENABLED) {
          write("error", { error: "deep research is disabled (RESEARCH_MODE_ENABLED=0)" });
          write("done", { session_id: sessionId, messages: -1, mode: "research" });
        } else if (!process.env.TAVILY_API_KEY) {
          write("error", { error: "deep research needs TAVILY_API_KEY — add it to .env" });
          write("done", { session_id: sessionId, messages: -1, mode: "research" });
        } else if (!cleanedQuestion) {
          write("error", { error: "empty research question — type /research followed by your question" });
          write("done", { session_id: sessionId, messages: -1, mode: "research" });
        } else if (pendingRun?.status === "running") {
          write("error", { error: "a research run is already in progress for this session" });
          write("done", { session_id: sessionId, messages: -1, mode: "research" });
        } else {
          await runResearchTurn({
            sessionId,
            cleanedQuestion,
            history,
            turnId,
            controller,
            write,
            ping: () => {
              if (!abandoned && !res.writableEnded && !res.destroyed) res.write(": ping\n\n");
            },
            resumed: resumesResearch,
          });
        }
        return;
      }

      if (compressor && history.length) {
        const res = await compressor.compress(history);
        if (res.compressed) {
          store.recordCompression(sessionId, {
            summary: res.summary,
            firstTurn: res.summarizedFirstTurn,
            lastTurn: res.summarizedLastTurn,
            originalCount: res.originalCount,
            model: res.modelLabel,
          });
          history = res.compressedMessages;
          write("compression", {
            first: res.summarizedFirstTurn,
            last: res.summarizedLastTurn,
            original: res.originalCount,
            compressed: res.compressedCount,
            elapsed_ms: res.elapsedMs,
            model: res.modelLabel,
          });
        }
      }
      const turn = await loop.runTurn(
        history,
        message,
        () => controller.signal.aborted,
        { sessionId, signal: controller.signal },
        // Stream each message as it lands — the UI sees tool calls/results
        // incrementally, not as one burst at `done` (python astream parity).
        (msg) => write("message", msg),
      );
      // Cancel mid-turn: persist only the provider-valid prefix (a dangling
      // assistant tool_call group would be rejected on resume) — ported from
      // server.py's finally-block persistence.
      const valid = turn.cancelled ? validPrefixLen(turn.messages) : turn.messages.length;
      const persistable = turn.messages.slice(0, valid);
      let recordedTurn: number | null = null;
      // Gate at 1: a plain no-tool turn yields exactly one assistant message
      // (the user row is prepended at append time). Copying python's >=2 gate
      // here silently dropped every single-reply turn from the archive.
      if (persistable.length >= 1) {
        recordedTurn = store.appendTurn(sessionId, [{ role: "user", content: message }, ...persistable]);
        // Mirror the persisted turn into the semantic sidecar (no-throw).
        void mirror.recordTurn(sessionId, recordedTurn, persistable).catch(() => undefined);
        maybeTitleSession(sessionId, message, persistable);
        maybeExtractFollowups(sessionId, persistable);
        try {
          const nudgeSummary = await maybeNudge(sessionId, persistable);
          if (nudgeSummary) write("nudge", { summary: nudgeSummary });
        } catch (e) {
          log.warn(`Memory nudge failed: ${String(e).slice(0, 160)}`);
        }
      }
      // (messages were already streamed live via the onMessage callback)
      if (turn.cancelled) {
        write("cancelled", {
          turn_id: turnId,
          persisted: persistable.length >= 2 ? 1 : 0,
        });
      }
      if (turn.fatal) write("error", { error: turn.fatal });
      write("done", {
        session_id: sessionId,
        messages: history.length + persistable.length + 1,
        usage: turn.usage,
      });
    } catch (e) {
      if (!abandoned) {
        write("error", { error: String((e as Error).message).slice(0, 500) });
        write("done", { session_id: sessionId, messages: -1 });
      }
    } finally {
      controller.signal.removeEventListener("abort", abortListener);
      ACTIVE_TURNS.delete(turnId);
      res.end();
    }
  })();
});

// Session titler (python main.py maybe_title_session parity): after the FIRST
// completed turn, a sync fallback (truncated first user message) is stored so
// UI lists always have something; an async refine via the cheap summarizer
// model overwrites it with the model label. Never raises — cosmetic.
function maybeTitleSession(sessionId: string, userMessage: string, newMessages: ChatMessage[]): void {
  try {
    if (store.getSessionTitle(sessionId) !== null) return;
    store.setSessionTitle(sessionId, fallbackTitle(userMessage), "fallback");
    const firstAssistant = newMessages.find((m) => m.role === "assistant" && m.content.trim());
    void refineSessionTitle(userMessage, firstAssistant?.content ?? "")
      .then(({ title, model }) => store.setSessionTitle(sessionId, title, model))
      .catch((e) => log.warn(`session titler failed: ${String(e).slice(0, 140)}`));
  } catch (e) {
    log.warn(`session title fallback failed: ${String(e).slice(0, 140)}`);
  }
}

// --- deep research turn (/research) -------------------------------------------
// Streams step events (`research`) + produced messages over the same SSE
// channel as chat; the run is not tied to the HTTP connection (a client
// disconnect only stops writes — same as normal turns). The research_runs row
// + archive keep the state for reconnect via GET /api/research/:sessionId.

interface ResearchTurnArgs {
  sessionId: string;
  cleanedQuestion: string;
  history: ChatMessage[];
  turnId: string;
  controller: AbortController;
  write: (event: string, payload: unknown) => void;
  ping: () => void;
  resumed: boolean;
}

async function runResearchTurn(args: ResearchTurnArgs): Promise<void> {
  const { sessionId, cleanedQuestion, history, turnId, controller, write, ping, resumed } = args;
  const startedAt = Date.now();

  if (resumed) store.resumeResearchRun(sessionId);
  else store.startResearchRun(sessionId, cleanedQuestion);

  // Persist the user turn up front so a crash/restart mid-run keeps the
  // question row; the sidebar title lands immediately.
  const userMessage: ChatMessage = { role: "user", content: cleanedQuestion };
  const userTurn = store.appendTurn(sessionId, [userMessage]);
  void mirror.recordTurn(sessionId, userTurn, [userMessage]).catch(() => undefined);
  maybeTitleSession(sessionId, cleanedQuestion, []);

  const produced: ChatMessage[] = [];
  let outcome: ResearchOutcome | null = null;
  let failure: string | null = null;

  const heartbeat = setInterval(ping, 20_000);
  try {
    outcome = await runDeepResearch({
      question: cleanedQuestion,
      history,
      deps: {
        emit: (event: ResearchEvent) => {
          try {
            store.updateResearchStep(sessionId, event.step);
          } catch {
            /* progress tracking is best-effort */
          }
          write("research", event);
        },
        onMessage: (message) => {
          produced.push(message);
          write("message", message);
        },
        shouldStop: () => controller.signal.aborted,
        signal: controller.signal,
      },
    });
  } catch (e) {
    failure = String((e as Error).message).slice(0, 500);
  } finally {
    clearInterval(heartbeat);
  }

  // Persist the assistant-visible messages produced (clarification question /
  // verification / final report); the user row is already in the archive.
  if (produced.length) {
    const turnNumber = store.appendTurn(sessionId, produced);
    void mirror.recordTurn(sessionId, turnNumber, produced).catch(() => undefined);
  }
  const messageCount = store.loadSession(sessionId).length;

  if (failure) {
    store.finishResearchRun(sessionId, { status: "failed", error: failure });
    write("error", { error: failure });
    write("done", { session_id: sessionId, messages: -1, mode: "research" });
    return;
  }

  const result = outcome as ResearchOutcome;
  if (result.status === "completed") {
    let reportPath: string | null = null;
    if (result.report && RESEARCH_SAVE_REPORTS) {
      try {
        reportPath = saveResearchReport({
          question: cleanedQuestion,
          report: result.report,
          tag: sessionId.slice(0, 8),
        });
      } catch (e) {
        log.warn(`research report save failed: ${String(e).slice(0, 160)}`);
      }
    }
    store.finishResearchRun(sessionId, { status: "completed", report: result.report ?? "" });
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
    const tokens = result.usage.prompt_tokens + result.usage.completion_tokens;
    log.info(
      `research completed: ${sessionId.slice(0, 8)} — ${elapsed}s, ${tokens} tokens${reportPath ? `, report ${reportPath}` : ""}`,
    );
    write("done", {
      session_id: sessionId,
      messages: messageCount,
      usage: result.usage,
      mode: "research",
      report_path: reportPath,
    });
    return;
  }
  if (result.status === "awaiting_clarification") {
    store.awaitResearchRun(sessionId, result.clarification ?? "");
    write("done", {
      session_id: sessionId,
      messages: messageCount,
      usage: result.usage,
      mode: "research",
      clarification: result.clarification ?? null,
    });
    return;
  }
  // cancelled (Stop button) — whatever was produced is already persisted.
  store.finishResearchRun(sessionId, { status: "cancelled" });
  write("cancelled", { turn_id: turnId, persisted: produced.length ? 1 : 0 });
  write("done", { session_id: sessionId, messages: messageCount, usage: result.usage, mode: "research" });
}

// --- MCP surface (python server.py parity) -----------------------------------
// Toggles rewrite mcp_servers.json atomically and apply at the next assembly:
// the reload endpoint re-assembles eagerly (409 while turns are in flight —
// an in-flight turn keeps its own registry and finishes unaffected).

app.get("/api/mcp", (_req, res) => {
  const { statuses } = loadMcpServersSafe();
  const lastReport = new Map((mcpReport ?? []).map((r: McpStatus) => [r.name, r]));
  const servers = statuses.map((s) => {
    const r: Partial<McpStatus> = lastReport.get(s.name) ?? {};
    return { ...s, connected: r.connected ?? null, tool_count: r.tool_count ?? null, connect_error: r.connect_error ?? null };
  });
  res.json({ assembled: mcpReport !== null, servers });
});

function loadMcpServersSafe() {
  try {
    return loadMcpServers();
  } catch (e) {
    log.warn(`mcp config unreadable: ${String(e).slice(0, 120)}`);
    return { clientServers: {}, statuses: [], raw: {} };
  }
}

app.post("/api/mcp/:name/enabled", (req, res) => {
  const enabled = (req.body ?? {}) as { enabled?: boolean };
  if (typeof enabled.enabled !== "boolean") {
    res.status(400).json({ detail: "enabled must be boolean" });
    return;
  }
  const result = setServerEnabled(req.params.name, enabled.enabled);
  if (result.notFound) {
    res.status(404).json({ detail: result.status });
    return;
  }
  res.json({ status: result.status });
});

app.post("/api/mcp/reload", async (req, res) => {
  if (ACTIVE_TURNS.size > 0) {
    res.status(409).json({ detail: "turns in flight — try again when idle" });
    return;
  }
  try {
    // drop stale MCP clients, re-bind fresh ones, keep the base registry
    closeOpenClients();
    mcpReport = await assembleRuntime();
    const tools = [...loop.tools.keys()];
    res.json({
      status: "OK: runtime re-assembled",
      mcp_tools: tools.length - buildBaseRegistry().length,
      mcp_report: mcpReport,
    });
  } catch (e) {
    res.status(502).json({ detail: `re-assembly failed: ${String(e).slice(0, 200)}` });
  }
});

// --- session follow-ups ("next steps" tips, followups.py parity) -------------

app.get("/api/sessions/:sessionId/followups", (req, res) => {
  res.json(
    getFollowups(req.params.sessionId) ?? {
      session_id: req.params.sessionId,
      items: [],
      dismissed: [],
    },
  );
});

app.get("/api/followups/counts", (_req, res) => {
  res.json({ counts: followupCounts() });
});

app.post("/api/sessions/:sessionId/followups/dismiss", (req, res) => {
  const { index } = (req.body ?? {}) as { index?: number };
  if (typeof index !== "number") {
    res.status(400).json({ detail: "index must be a number" });
    return;
  }
  const dismissed = dismissFollowup(req.params.sessionId, index);
  if (dismissed === null) {
    res.status(404).json({ detail: `no followups for session: ${req.params.sessionId}` });
    return;
  }
  res.json({ dismissed });
});

// --- skills (Hermes-style toggles; python server.py parity) --------------------

app.get("/api/skills", (_req, res) => {
  res.json(getSkillLibrary().listAll());
});

app.post("/api/skills/:name/enabled", (req, res) => {
  const enabled = (req.body ?? {}) as { enabled?: boolean };
  if (typeof enabled.enabled !== "boolean") {
    res.status(400).json({ detail: "enabled must be boolean" });
    return;
  }
  const result = getSkillLibrary().setEnabled(req.params.name, enabled.enabled);
  if (result.startsWith("Rejected")) {
    res.status(404).json({ detail: result });
    return;
  }
  if (result.startsWith("ERROR")) {
    res.status(409).json({ detail: result });
    return;
  }
  res.json({ status: result });
});

// --- Yahoo Finance proxy (/api/yahoo) — server.py parity ----------------------
// Yahoo chart API sends no CORS headers, so browsers cannot call it directly;
// this same-origin forwarder covers the vela chart blocks. Friendly to Yahoo
// by design (it rate-limits with HTTP 429): a gentle TTL cache answers repeat
// polls, query2 backs up query1, and upstream statuses (429 included) pass
// through verbatim so callers can back off. Plain UA only — verified
// (2026-10-11): Yahoo fingerprints the client, a full Chrome UA from a
// non-browser client is an instant 429; bare token passes.

const YAHOO_HOSTS = ["https://query1.finance.yahoo.com", "https://query2.finance.yahoo.com"];
const YAHOO_UA = "Mozilla/5.0";
const YAHOO_CACHE_MAX = 256;
const yahooCache = new Map<string, { expiresAt: number; status: number; body: string }>();

const yahoo_upstream = async (upstream: string) => {
  let lastError: unknown = null;
  for (const host of YAHOO_HOSTS) {
    try {
      const resp = await fetch(`${host}${upstream}`, {
        headers: { "User-Agent": YAHOO_UA },
        signal: AbortSignal.timeout(15000),
      });
      if (resp.status >= 500) {
        lastError = new Error(`HTTP ${resp.status}`);
        continue;
      }
      return { status: resp.status, body: await resp.text() };
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError ?? new Error("no yahoo host reachable");
};

app.get("/api/yahoo/*", async (req, res) => {
  const basePath = (req.params as { 0?: string })[0] ?? "";
  const query = new URLSearchParams(req.query as Record<string, string>).toString();
  const url = `/${basePath}${query ? `?${query}` : ""}`;
  const ttl = Math.max(0, Number(process.env.YAHOO_PROXY_TTL ?? "60")) * 1000;
  const cached = yahooCache.get(url);
  if (ttl && cached && cached.expiresAt > Date.now()) {
    res
      .status(cached.status)
      .set({ "X-Yahoo-Cache": "hit" })
      .type("application/json")
      .send(cached.body);
    return;
  }
  let result: { status: number; body: string };
  try {
    result = await yahoo_upstream(url);
  } catch (err) {
    res.status(502).json({ detail: `yahoo unreachable: ${String(err).slice(0, 200)}` });
    return;
  }
  if (ttl && result.status === 200) {
    if (yahooCache.size >= YAHOO_CACHE_MAX) {
      const exp = [...yahooCache.entries()].find(([, v]) => v.expiresAt <= Date.now());
      const toEvict = exp?.[0] ?? yahooCache.keys().next().value;
      if (toEvict) yahooCache.delete(toEvict);
    }
    yahooCache.set(url, { expiresAt: Date.now() + ttl, status: result.status, body: result.body });
  }
  res.status(result.status).set({ "X-Yahoo-Cache": "miss" }).type("application/json").send(result.body);
});

app.post("/api/chat/cancel", (req, res) => {
  const turnId = (req.body ?? {}) as { turn_id: string };
  const target = ACTIVE_TURNS.get(turnId.turn_id);
  if (!target) {
    res.json({ cancelled: false, detail: "turn not active (already finished?)" });
    return;
  }
  target.abort();
  res.json({ cancelled: true });
});

app.listen(serverPort, serverHost, () => {
  console.error(`nm-finance-agent listening on http://${serverHost}:${serverPort}`);
  console.error(`  tools: ${[...loop.tools.keys()].join(", ")}`);
  console.error(`  memory: ${memory.totalChars()}/${MEMORY_CHAR_LIMIT} chars`);
});
