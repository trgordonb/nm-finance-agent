// Tabbed shell (Chat | Wiki | MCP). Same conversation-feed behavior as the
// langgraph-demo frontend: SSE-driven feed, tool-call rows, collapsible tool
// results, turn cancel, session restore. The Wiki tab is the native llmwiki
// browser (docs/wiki-tab-plan.md), read-only over the /api/wiki/* proxy.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  cancelTurn,
  dismissFollowup,
  getFollowupCounts,
  getFollowups,
  getHealth,
  getResearchRun,
  getSessionMessages,
  getSessions,
  setUnauthorizedHandler,
  streamChat,
  UnauthorizedError,
} from "./api";
import { getMe, logout, type AuthStatus, type AuthUser } from "./auth";
import Login from "./components/Login";
import { AuthSplash, NoAccess } from "./components/AuthScreens";
import type { FeedItem, Followups, Health, NewItem, SessionInfo, ToolCall } from "./types";
import Sidebar from "./components/Sidebar";
import SkillsTab from "./components/SkillsTab";
import CronTab from "./components/CronTab";
import McpTab from "./components/McpTab";
import WikiTab from "./components/WikiTab";
import Feed from "./components/Feed";
import Composer from "./components/Composer";

let idCounter = 0;
const nextId = () => `item-${++idCounter}`;

/** mm:ss for the deep-research progress strip. */
function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms)) return "";
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

interface AgentAppProps {
  user: AuthUser | null;
  onLogout?: () => void;
}

function AgentApp({ user, onLogout }: AgentAppProps) {
  const [view, setView] = useState<"chat" | "wiki" | "cron">("chat");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<"skills" | "mcp">("skills");

  // Close the settings modal with Escape.
  useEffect(() => {
    if (!settingsOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSettingsOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [settingsOpen]);
  const [health, setHealth] = useState<Health | null>(null);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [items, setItems] = useState<FeedItem[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [followups, setFollowups] = useState<Followups | null>(null);
  const [followupCounts, setFollowupCounts] = useState<Record<string, number>>({});
  const [draft, setDraft] = useState<{ text: string; n: number }>({ text: "", n: 0 });
  // the follow-up tip currently sitting in the composer (dismissed on submit)
  const [pendingTip, setPendingTip] = useState<{ sid: string; index: number; text: string } | null>(null);
  // Live deep-research progress (driven by `research` SSE events; null when no
  // run is active). nowTick re-renders the elapsed clock while it runs.
  const [researchLive, setResearchLive] = useState<{ detail: string; since: number } | null>(null);
  const [nowTick, setNowTick] = useState<number>(() => Date.now());
  // Recovered run state for the OPEN session (page reloaded mid-run): polled
  // from GET /api/research/:sid; cleared when the run is terminal or a live
  // stream takes over.
  const [sessionResearch, setSessionResearch] = useState<{
    status: string;
    step: string | null;
    sinceMs: number;
  } | null>(null);
  // mirror of sessionId for stale async followups fetches
  const sessionIdRef = useRef<string | null>(null);
  // track streaming for stale guards
  const turnIdRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const refreshSessions = useCallback(() => {
    getSessions()
      .then(setSessions)
      .catch(() => undefined);
  }, []);

  const refreshFollowupCounts = useCallback(() => {
    getFollowupCounts()
      .then((r) => setFollowupCounts(r.counts))
      .catch(() => undefined);
  }, []);

  const refreshFollowups = useCallback((sid: string | null, attempt = 0) => {
    if (!sid) {
      setFollowups(null);
      return;
    }
    getFollowups(sid)
      .then((f) => {
        if (sessionIdRef.current !== sid) return; // user moved to another session
        setFollowups(f);
        const live = f.items.filter((_, i) => !f.dismissed.includes(i));
        // extraction runs after `done` — secondary-LLM latency (~2-10s), so
        // poll until it lands or the window closes (python parity)
        if (attempt < 6 && live.length === 0) {
          window.setTimeout(() => {
            if (sessionIdRef.current === sid) void refreshFollowups(sid, attempt + 1);
          }, 5000);
        }
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    getHealth()
      .then(setHealth)
      .catch(() => undefined);
    refreshSessions();
    refreshFollowupCounts();
  }, [refreshSessions, refreshFollowupCounts]);

  // ticking clock while a deep-research run is live (or recovered from reload)
  useEffect(() => {
    if (!researchLive && !sessionResearch) return;
    const t = window.setInterval(() => setNowTick(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [researchLive, sessionResearch]);

  const push = useCallback((item: NewItem) => {
    setItems((prev) => [...prev, { id: nextId(), ...item } as FeedItem]);
  }, []);

  const handleEvent = useCallback(
    (event: string, data: Record<string, unknown>) => {
      switch (event) {
        case "session": {
          turnIdRef.current = String(data.turn_id);
          setSessionId(String(data.session_id));
          sessionIdRef.current = String(data.session_id);
          break;
        }
        case "message": {
          const role = (data.role as string | undefined) ?? "assistant";
          push({
            kind: "message",
            // The express serializer sends tool name as `name` (LangGraph's
            // backend used `tool_name`); accept both during the transition.
            toolName: ((data.tool_name ?? data.name) as string | undefined) ?? undefined,
            role: role === "user" || role === "assistant" || role === "tool" ? role : "assistant",
            content: String(data.content ?? ""),
            toolCalls: Array.isArray(data.tool_calls) ? (data.tool_calls as ToolCall[]) : undefined,
            toolCallId: (data.tool_call_id as string | undefined) ?? undefined,
            status: (data.status as string | undefined) ?? undefined,
          });
          break;
        }
        case "compression":
          push({
            kind: "system",
            text: `context compression — turns ${data.first}-${data.last} summarized by ${data.model} (${data.original} → ${data.compressed} messages, ${data.elapsed_ms}ms)`,
            tone: "info",
          });
          break;
        case "research": {
          // Deep-research progress (docs/deep-research-plan.md, stage 3): a
          // durable system row for the feed trail + the live progress strip.
          const detail = String(data.detail ?? data.step ?? "working");
          setResearchLive((prev) => ({ detail, since: prev?.since ?? Date.now() }));
          setNowTick(Date.now());
          push({ kind: "system", text: `research · ${detail}`, tone: "info" });
          break;
        }
        case "cancelled":
          setResearchLive(null);
          push({ kind: "system", text: "turn cancelled — partial state saved", tone: "warn" });
          break;
        case "error":
          setResearchLive(null);
          push({ kind: "notice", text: `error: ${data.error}`, tone: "warn" });
          setStreaming(false);
          break;
        case "done": {
          setResearchLive(null);
          if (data.messages !== -1) {
            const at = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
            const isResearch = data.mode === "research";
            const clarification = typeof data.clarification === "string" ? data.clarification : "";
            const reportPath = typeof data.report_path === "string" ? data.report_path : "";
            const usage = (data.usage ?? {}) as { prompt_tokens?: number; completion_tokens?: number };
            const tokens = (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0);
            push({
              kind: "system",
              text: isResearch
                ? clarification
                  ? `research paused — answer the question above ∙ ${at}`
                  : `research complete ∙ ${at}${tokens ? ` ∙ ${(tokens / 1000).toFixed(1)}k tokens` : ""}`
                : `turn complete ∙ ${at}`,
              tone: "info",
            });
            if (reportPath) {
              // absolute server path → short workspace-relative form
              push({
                kind: "system",
                text: `report saved ∙ ${reportPath.replace(/^.*?(workspace\/)/, "$1")}`,
                tone: "info",
              });
            }
          }
          setStreaming(false);
          refreshSessions();
          if (data.mode !== "research") {
            refreshFollowups(String(data.session_id ?? ""), 0);
            // extraction lands up to ~10s after done — badge refresh then
            window.setTimeout(refreshFollowupCounts, 12000);
          }
          // The session titler refines the fallback title asynchronously
          // (secondary LLM lands ~2-8s after the first turn) — re-fetch so the
          // sidebar picks up the refined one-liner without a manual reload
          // (python App.tsx parity). Free-tier models can exceed 5s: two hops.
          window.setTimeout(refreshSessions, 5000);
          window.setTimeout(refreshSessions, 12000);
          break;
        }
      }
    },
    [push, refreshSessions],
  );

  const send = useCallback(
    async (text: string) => {
      if (streaming || !text.trim()) return;
      setStreaming(true);
      push({ kind: "message", role: "user", content: text });
      // submitting a follow-up tip = acting on it: dismiss it from the list
      if (pendingTip && pendingTip.sid === sessionIdRef.current) {
        const acted = text === pendingTip.text || text.startsWith(pendingTip.text.slice(0, 24));
        if (acted) {
          const sid = pendingTip.sid;
          dismissFollowup(sid, pendingTip.index)
            .then(() => refreshFollowupCounts())
            .catch(() => undefined);
          setFollowups((f) =>
            f && f.session_id === sid ? { ...f, dismissed: [...f.dismissed, pendingTip.index] } : f,
          );
        }
        setPendingTip(null);
      }
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        await streamChat(text, sessionId, controller.signal, handleEvent);
      } catch (err) {
        const aborted = err instanceof DOMException && err.name === "AbortError";
        if (!aborted && !(err instanceof UnauthorizedError)) {
          push({
            kind: "notice",
            text: `error: ${err instanceof Error ? err.message : String(err)}`,
            tone: "warn",
          });
        }
      } finally {
        abortRef.current = null;
        setStreaming(false);
        refreshSessions();
      }
    },
    [streaming, sessionId, handleEvent, push, refreshSessions, pendingTip, refreshFollowupCounts],
  );

  const stop = useCallback(() => {
    if (turnIdRef.current) {
      cancelTurn(turnIdRef.current).catch(() => undefined);
    }
  }, []);

  // Render one session's archive into the feed — shared by opening a session
  // and the reconnect poll that picks up a report written while away.
  const renderSessionMessages = useCallback(async (sid: string) => {
    const { messages } = await getSessionMessages(sid);
    setItems(
      messages.map((m) => ({
        kind: "message" as const,
        id: nextId(),
        role: m.role,
        content: m.content,
        toolCalls: m.tool_calls,
        toolCallId: m.tool_call_id,
        toolName: m.tool_name ?? m.name,
        status: m.status,
      })),
    );
  }, []);

  const loadSession = useCallback(
    async (sid: string) => {
      if (streaming) return;
      try {
        await renderSessionMessages(sid);
        setSessionId(sid);
        sessionIdRef.current = sid;
        setPendingTip(null);
        // load the tips for this session into the to-do strip (python
        // loadSession parity; was dropped in the chat-only port — the badge
        // showed but the strip never populated on open/reload)
        refreshFollowups(sid, 0);
        // opening the session marks its tips seen — the badge clears
        setFollowupCounts((prev) => {
          if (!prev[sid]) return prev;
          const next = { ...prev };
          delete next[sid];
          return next;
        });
      } catch (err) {
        if (err instanceof UnauthorizedError) return;
        push({
          kind: "notice",
          text: `error: ${err instanceof Error ? err.message : String(err)}`,
          tone: "warn",
        });
      }
    },
    [streaming, push, refreshFollowups, renderSessionMessages],
  );

  // Reconnect recovery: a page reload mid-run loses the live SSE stream — pull
  // the run state from GET /api/research/:sid, poll while it is in flight, and
  // reload the archived messages once it finishes (server-side the report
  // lands in the archive).
  useEffect(() => {
    if (!sessionId || streaming) {
      setSessionResearch(null);
      return;
    }
    let cancelled = false;
    let timer: number | undefined;
    let sawActive = false;
    const check = async () => {
      try {
        const row = await getResearchRun(sessionId);
        if (cancelled) return;
        const active = row.status === "running" || row.status === "awaiting_clarification";
        if (active) {
          sawActive = true;
          setSessionResearch({
            status: row.status,
            step: row.step,
            sinceMs: Date.parse(row.started_at),
          });
          timer = window.setTimeout(check, 12000);
        } else {
          setSessionResearch(null);
          if (sawActive && row.status === "completed") {
            await renderSessionMessages(sessionId);
            refreshSessions();
          }
        }
      } catch {
        if (!cancelled) setSessionResearch(null); // 404: no research run
      }
    };
    void check();
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [sessionId, streaming, renderSessionMessages, refreshSessions]);

  const newChat = useCallback(() => {
    if (streaming) return;
    setSessionId(null);
    sessionIdRef.current = null;
    setFollowups(null);
    setPendingTip(null);
    setItems([]);
  }, [streaming]);

  const dismissFollowupItem = useCallback(
    (index: number) => {
      const sid = sessionIdRef.current;
      if (!sid) return;
      dismissFollowup(sid, index)
        .then(() => {
          setFollowups((f) => (f ? { ...f, dismissed: [...f.dismissed, index] } : f));
          refreshFollowupCounts();
        })
        .catch(() => undefined);
    },
    [refreshFollowupCounts],
  );

  const prefillComposer = useCallback(
    (text: string, followupIndex?: number) => {
      const sid = sessionIdRef.current;
      setDraft((d) => ({ text, n: d.n + 1 }));
      setPendingTip(followupIndex != null && sid ? { sid, index: followupIndex, text } : null);
    },
    [],
  );

  const liveFollowups = followups
    ? followups.items
        .map((text, idx) => ({ idx, text }))
        .filter((it) => !followups.dismissed.includes(it.idx))
    : [];

  // Strip source: the live SSE stream when present, else the recovered run
  // state polled for the open session.
  const researchStrip = researchLive
    ? { text: `research · ${researchLive.detail}`, since: researchLive.since }
    : sessionResearch
      ? {
          text:
            sessionResearch.status === "awaiting_clarification"
              ? "research · paused — answer the question above"
              : `research · running on the server — last step: ${sessionResearch.step ?? "…"}`,
          since: sessionResearch.sinceMs,
        }
      : null;

  return (
    <div className="app">
      <Sidebar
        health={health}
        sessions={sessions}
        activeId={sessionId}
        streaming={streaming}
        settingsOpen={settingsOpen}
        followupCounts={followupCounts}
        user={user}
        onLogout={onLogout}
        onNewChat={newChat}
        onSelect={loadSession}
        onOpenSettings={() => setSettingsOpen(true)}
      />
      <div className="content">
        <div className="tabbar" role="tablist">
          <button
            className={`tab${view === "chat" ? " active" : ""}`}
            role="tab"
            aria-selected={view === "chat"}
            onClick={() => setView("chat")}
          >
            Chat
          </button>
          <button
            className={`tab${view === "wiki" ? " active" : ""}`}
            role="tab"
            aria-selected={view === "wiki"}
            onClick={() => setView("wiki")}
          >
            Wiki
          </button>
          <button
            className={`tab${view === "cron" ? " active" : ""}`}
            role="tab"
            aria-selected={view === "cron"}
            onClick={() => setView("cron")}
          >
            Scheduled
          </button>
        </div>
        {view === "chat" ? (
        <main className="main">
          <div className="feed" aria-live="polite">
            {items.length === 0 && (
              <div className="empty">
                <img src="/logo-hero.jpg" alt="NM Finance Agent" className="empty-logo" />
                <div className="empty-sub">
                  Ask anything — market data, filing research, local files. The agent streams
                  tool calls and answers here; anything risky stays on your machine.
                </div>
              </div>
            )}
            <Feed items={items} streaming={streaming} />
          </div>
          {liveFollowups.length > 0 && (
            <div className="followups" aria-label="Next steps">
              <div className="followups-title">next steps</div>
              {liveFollowups.map(({ idx, text }) => (
                <div key={idx} className="followup" onClick={() => prefillComposer(text, idx)}>
                  <span className="followup-text">{text}</span>
                  <button
                    className="followup-x"
                    title="dismiss"
                    onClick={(e) => {
                      e.stopPropagation();
                      dismissFollowupItem(idx);
                    }}
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}
          {researchStrip && (
            <div className="research-strip" aria-label="Research progress">
              <span className="research-strip-dot" />
              <span className="research-strip-text" title={researchStrip.text}>
                {researchStrip.text}
              </span>
              <span className="research-strip-time">{formatElapsed(nowTick - researchStrip.since)}</span>
            </div>
          )}
          <Composer streaming={streaming} onSend={send} onStop={stop} draft={draft} />
        </main>
        ) : view === "wiki" ? (
          <WikiTab
            onAsk={(text) => {
              prefillComposer(text);
              setView("chat");
            }}
          />
        ) : (
          <CronTab
            onOpenSession={(sid) => {
              void loadSession(sid);
              setView("chat");
            }}
          />
        )}
      </div>
      {settingsOpen && (
        <div className="modal-overlay" onClick={() => setSettingsOpen(false)}>
          <div
            className="modal settings-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Settings — skills and MCP servers"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-head">
              <div className="tabbar" role="tablist" aria-label="Settings sections">
                <button
                  className={`tab${settingsSection === "skills" ? " active" : ""}`}
                  role="tab"
                  aria-selected={settingsSection === "skills"}
                  onClick={() => setSettingsSection("skills")}
                >
                  Skills
                </button>
                <button
                  className={`tab${settingsSection === "mcp" ? " active" : ""}`}
                  role="tab"
                  aria-selected={settingsSection === "mcp"}
                  onClick={() => setSettingsSection("mcp")}
                >
                  MCP
                </button>
              </div>
              <button className="modal-x" aria-label="Close settings" onClick={() => setSettingsOpen(false)}>
                ✕
              </button>
            </div>
            <div className="modal-body">
              {settingsSection === "skills" ? <SkillsTab health={health} /> : <McpTab />}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// --- auth shell --------------------------------------------------------------
// The rest of the app only mounts after auth resolves. That keeps every API
// effect in AgentApp from firing (and 401-ing) behind the login screen.

type AuthState =
  | { status: "loading" }
  | { status: "disabled" }
  | { status: "anonymous" }
  | {
      status: "authenticated";
      user: AuthUser;
      allowed: boolean;
      requiredPermission: string;
    };

export default function App() {
  const [auth, setAuth] = useState<AuthState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;

    // Any 401 from a protected API drops the UI back to login. The server
    // session is already gone by the time this fires.
    setUnauthorizedHandler(() => {
      if (!cancelled) setAuth({ status: "anonymous" });
    });

    void (async () => {
      const health = await getHealth().catch(() => null);
      if (cancelled) return;

      // Old backend (no `auth` block) or AUTH_MODE=off: keep the open UI.
      if (health && health.auth?.mode !== "sso") {
        setAuth({ status: "disabled" });
        return;
      }

      try {
        const me = await getMe();
        if (cancelled) return;
        setAuth(
          me
            ? {
                status: "authenticated",
                user: me.user,
                allowed: me.allowed,
                requiredPermission: me.required_permission,
              }
            : { status: "anonymous" },
        );
      } catch {
        if (!cancelled) setAuth({ status: "anonymous" });
      }
    })();

    return () => {
      cancelled = true;
      setUnauthorizedHandler(null);
    };
  }, []);

  const handleLogin = useCallback((status: AuthStatus) => {
    setAuth({
      status: "authenticated",
      user: status.user,
      allowed: status.allowed,
      requiredPermission: status.required_permission,
    });
  }, []);

  const handleLogout = useCallback(() => {
    // Immediate UI logout; the POST still carries the cookie to revoke the
    // server session. A failure leaves an idle server row until it expires.
    setAuth({ status: "anonymous" });
    void logout().catch(() => undefined);
  }, []);

  if (auth.status === "loading") return <AuthSplash />;
  if (auth.status === "anonymous") return <Login onSuccess={handleLogin} />;
  if (auth.status === "disabled") return <AgentApp user={null} />;
  if (!auth.allowed) {
    return (
      <NoAccess
        user={auth.user}
        requiredPermission={auth.requiredPermission}
        onLogout={handleLogout}
      />
    );
  }
  return <AgentApp user={auth.user} onLogout={handleLogout} />;
}
