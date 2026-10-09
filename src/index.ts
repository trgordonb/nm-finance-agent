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
  OPENAI_MODEL_ID,
  OPENAI_BASE_URL,
  MEMORY_CHAR_LIMIT,
} from "./config.js";
import { PromptMemory } from "./memory.js";
import { SessionStore } from "./store.js";
import { AgentLoop } from "./agent.js";
import { enabled as tracingEnabled, TRACE_PROJECT } from "./tracing.js";
import type { ChatMessage } from "./types.js";

// --- runtime assembly ---------------------------------------------------------

const store = new SessionStore();
const memory = new PromptMemory();
const loop = new AgentLoop({ memory, store });

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
    model: OPENAI_MODEL_ID,
    base_url: OPENAI_BASE_URL,
    memory_chars: memory.totalChars(),
    memory_budget: MEMORY_CHAR_LIMIT,
    tools: [...loop.tools.keys()],
    sessions: store.listSessions().length,
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
      const history = store.loadSession(sessionId);
      write("session", { session_id: sessionId, turn_id: turnId, resumed: history.length > 0 });
      const turn = await loop.runTurn(history, message, () => controller.signal.aborted, {
        sessionId,
      });
      // Cancel mid-turn: persist only the provider-valid prefix (a dangling
      // assistant tool_call group would be rejected on resume) — ported from
      // server.py's finally-block persistence.
      const valid = turn.cancelled ? validPrefixLen(turn.messages) : turn.messages.length;
      const persistable = turn.messages.slice(0, valid);
      if (persistable.length >= 2) {
        store.appendTurn(sessionId, [{ role: "user", content: message }, ...persistable]);
      }
      for (const msg of persistable) {
        write("message", msg);
      }
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
