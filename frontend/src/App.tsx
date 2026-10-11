// Chat-only shell (step 1): no wiki tab, no settings screens, no followups.
// Same conversation-feed behavior as the langgraph-demo frontend: SSE-driven
// feed, tool-call rows, collapsible tool results, turn cancel, session restore.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  cancelTurn,
  dismissFollowup,
  getFollowupCounts,
  getFollowups,
  getHealth,
  getSessionMessages,
  getSessions,
  streamChat,
} from "./api";
import type { FeedItem, Followups, Health, NewItem, SessionInfo, ToolCall } from "./types";
import Sidebar from "./components/Sidebar";
import SkillsTab from "./components/SkillsTab";
import McpTab from "./components/McpTab";
import Feed from "./components/Feed";
import Composer from "./components/Composer";

let idCounter = 0;
const nextId = () => `item-${++idCounter}`;

export default function App() {
  const [view, setView] = useState<"chat" | "settings">("chat");
  const [settingsSection, setSettingsSection] = useState<"skills" | "mcp">("skills");
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
        case "cancelled":
          push({ kind: "system", text: "turn cancelled — partial state saved", tone: "warn" });
          break;
        case "error":
          push({ kind: "notice", text: `error: ${data.error}`, tone: "warn" });
          setStreaming(false);
          break;
        case "done":
          if (data.messages !== -1) {
            const at = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
            push({ kind: "system", text: `turn complete ∙ ${at}`, tone: "info" });
          }
          setStreaming(false);
          refreshSessions();
          refreshFollowups(String(data.session_id ?? ""), 0);
          // extraction lands up to ~10s after done — badge refresh then
          window.setTimeout(refreshFollowupCounts, 12000);
          // The session titler refines the fallback title asynchronously
          // (secondary LLM lands ~2-8s after the first turn) — re-fetch so the
          // sidebar picks up the refined one-liner without a manual reload
          // (python App.tsx parity). Free-tier models can exceed 5s: two hops.
          window.setTimeout(refreshSessions, 5000);
          window.setTimeout(refreshSessions, 12000);
          break;
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
        if (!aborted) {
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

  const loadSession = useCallback(
    async (sid: string) => {
      if (streaming) return;
      try {
        const { messages } = await getSessionMessages(sid);
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
      } catch (err) {
        push({
          kind: "notice",
          text: `error: ${err instanceof Error ? err.message : String(err)}`,
          tone: "warn",
        });
      }
    },
    [streaming, push, refreshFollowups],
  );

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

  return (
    <div className="app">
      <Sidebar
        health={health}
        sessions={sessions}
        activeId={sessionId}
        streaming={streaming}
        settingsOpen={view === "settings"}
        followupCounts={followupCounts}
        onNewChat={newChat}
        onSelect={loadSession}
        onOpenSettings={() => setView("settings")}
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
            className={`tab${view === "settings" ? " active" : ""}`}
            role="tab"
            aria-selected={view === "settings"}
            onClick={() => setView("settings")}
          >
            MCP
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
          <Composer streaming={streaming} onSend={send} onStop={stop} draft={draft} />
        </main>
        ) : (
          <div className="settings">
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
            {settingsSection === "skills" ? <SkillsTab health={health} /> : <McpTab />}
          </div>
        )}
      </div>
    </div>
  );
}
