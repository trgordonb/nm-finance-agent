// REST server (Express) exposing the agentic harness. Port of server.py's
// contract, step-1 scope: no wiki / followups / MCP — sessions, memory, chat
// over SSE, turn abort.
//
//   GET  /api/health               model + memory budget + tool count
//   GET  /api/sessions             archived sessions
//   GET  /api/sessions/:id         full message history
//   GET  /api/memory               MEMORY.md/USER.md rendered block + usage
//   POST /api/chat                 one agent turn as an SSE event stream
//   POST /api/chat/cancel          abort an active turn ({turn_id})
//
// SSE events: session / message / tool / nudge-free/error / done — mirrors
// the Python server's event vocabulary where applicable.

import express, { type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import {
  serverHost,
  serverPort,
  OPENROUTER_MODEL_MAIN,
  OPENROUTER_BASE_URL,
  OPENROUTER_PROVIDER_ORDER,
  OPENROUTER_PROVIDER_FALLBACKS,
  OPENROUTER_REASONING,
  MEMORY_CHAR_LIMIT,
} from "./config.js";
import { PromptMemory } from "./memory.js";
import { SQLiteSessionStore } from "./store.js";
import { AgentDbMirror } from "./agentdb-mirror.js";
import { AgentLoop } from "./agent.js";
import { buildToolRegistry } from "./tools/index.js";
import { enabled as tracingEnabled, TRACE_PROJECT } from "./tracing.js";
import { log } from "./logger.js";
import { fallbackTitle, refineSessionTitle } from "./titler.js";
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

type McpReport = McpStatus[];

// --- runtime assembly ---------------------------------------------------------

const store = new SQLiteSessionStore();
const memory = new PromptMemory();
// AgentDB mirror (phase-in, dual-write): the archive stays authoritative; a
// local ruvector vector db mirrors turn messages for dense semantic recall.
// initialize() degrades to a no-op mirror when the engine/embedder is
// unavailable — never fatal, logged with reason.
const mirror = new AgentDbMirror();
void mirror
  .initialize()
  .then((status) => {
    if (!status.enabled) log.info(`agentdb mirror off — ${status.reason}`);
  })
  .catch(() => undefined);
const loop = new AgentLoop({ memory, store, mirror });

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
  return buildToolRegistry(store, mirror);
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

app.get("/api/memory", (_req, res) => {
  res.json({
    block: memory.load(),
    usage: memory.totalChars(),
    budget: MEMORY_CHAR_LIMIT,
  });
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
      const history = store.loadSession(sessionId);
      write("session", { session_id: sessionId, turn_id: turnId, resumed: history.length > 0 });
      const turn = await loop.runTurn(
        history,
        message,
        () => controller.signal.aborted,
        { sessionId },
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
