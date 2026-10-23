import { useState } from "react";
import { ChevronRight, LogOut, Settings } from "lucide-react";
import type { AuthUser } from "../auth";
import type { Health, SessionInfo } from "../types";

function relativeTime(iso: string): string {
  const epoch = Date.parse(iso) / 1000;
  const diff = Date.now() / 1000 - epoch;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.round(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.round(diff / 3600)}h ago`;
  return new Date(epoch * 1000).toLocaleDateString();
}

const DAY_MS = 86_400_000;

interface SessionGroup {
  label: string;
  sessions: SessionInfo[];
}

/** Calendar-day buckets: Today / Last 7 days / Last 30 days / Older. */
function groupSessions(sessions: SessionInfo[]): SessionGroup[] {
  const todayStart = new Date().setHours(0, 0, 0, 0);
  const buckets: SessionGroup[] = [
    { label: "Today", sessions: [] },
    { label: "Last 7 days", sessions: [] },
    { label: "Last 30 days", sessions: [] },
    { label: "Older", sessions: [] },
  ];
  for (const session of sessions) {
    const ms = Date.parse(session.created_at) || 0;
    if (ms >= todayStart) buckets[0].sessions.push(session);
    else if (ms >= todayStart - 7 * DAY_MS) buckets[1].sessions.push(session);
    else if (ms >= todayStart - 30 * DAY_MS) buckets[2].sessions.push(session);
    else buckets[3].sessions.push(session);
  }
  return buckets.filter((bucket) => bucket.sessions.length > 0);
}

/** Older buckets start collapsed for a focused list; expand on demand. */
const DEFAULT_COLLAPSED: Record<string, boolean> = {
  "Last 30 days": true,
  Older: true,
};

interface Props {
  health: Health | null;
  sessions: SessionInfo[];
  activeId: string | null;
  streaming: boolean;
  settingsOpen: boolean;
  /** Unseen follow-up tip counts per session id (sidebar badges). */
  followupCounts: Record<string, number>;
  /** Signed-in user; null/absent when AUTH_MODE=off. */
  user?: AuthUser | null;
  onLogout?: () => void;
  onNewChat: () => void;
  onSelect: (sessionId: string) => void;
  onOpenSettings: () => void;
}

export default function Sidebar({
  health,
  sessions,
  activeId,
  streaming,
  settingsOpen,
  followupCounts,
  user,
  onLogout,
  onNewChat,
  onSelect,
  onOpenSettings,
}: Props) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(DEFAULT_COLLAPSED);
  const groups = groupSessions(sessions);

  const toggle = (label: string) =>
    setCollapsed((prev) => ({ ...prev, [label]: !prev[label] }));

  return (
    <aside className="sidebar">
      <div className="brand">
        <img src="/logo-mark.png" alt="" className="brand-logo" />
        <span className="brand-name">NM Finance Agent</span>
        <span className="brand-sub">web</span>
      </div>

      <button className="new-chat" onClick={onNewChat} disabled={streaming}>
        + New chat
      </button>

      <div className="section-label">Sessions</div>
      <div className="session-list">
        {groups.length === 0 && <div className="session-empty">No sessions yet</div>}
        {groups.map((group) => {
          const isCollapsed = collapsed[group.label] ?? false;
          return (
            <div className="session-group" key={group.label}>
              <button
                className="session-group-header"
                onClick={() => toggle(group.label)}
                aria-expanded={!isCollapsed}
                title={isCollapsed ? `Show ${group.label.toLowerCase()}` : `Hide ${group.label.toLowerCase()}`}
              >
                <ChevronRight size={12} className={`chevron${isCollapsed ? "" : " open"}`} />
                <span>
                  {group.label} · {group.sessions.length}
                </span>
              </button>
              {!isCollapsed &&
                group.sessions.map((s) => (
                  <button
                    key={s.session_id}
                    className={`session-row${s.session_id === activeId ? " active" : ""}`}
                    onClick={() => onSelect(s.session_id)}
                    disabled={streaming}
                    title={s.summary || s.session_id}
                  >
                    <span className="session-turns">
                      {s.turn_count === 1 ? "1-turn" : `${s.turn_count}-turns`}
                    </span>
                    <span className="session-time">{relativeTime(s.created_at)}</span>
                    {s.research_status && (
                      <span
                        className={`session-tag${s.research_status === "running" ? " live" : ""}`}
                        title={`deep research: ${s.research_status}`}
                      >
                        research
                      </span>
                    )}
                    {s.summary && <span className="session-title-text">{s.summary}</span>}
                    {(followupCounts[s.session_id] ?? 0) > 0 && s.session_id !== activeId && (
                      <span
                        className="followup-badge"
                        title={`${followupCounts[s.session_id]} follow-up suggestion(s) to review`}
                      >
                        {followupCounts[s.session_id]}
                      </span>
                    )}
                  </button>
                ))}
            </div>
          );
        })}
      </div>

      <div className="sidebar-footer">
        {user && (
          <div className="sidebar-user">
            <span className="user-avatar" aria-hidden="true">
              {(user.username[0] ?? "?").toUpperCase()}
            </span>
            <span className="user-name" title={user.email ?? user.username}>
              {user.username}
            </span>
            {onLogout && (
              <button className="signout" onClick={onLogout} title="Sign out" aria-label="Sign out">
                <LogOut size={14} />
              </button>
            )}
          </div>
        )}
        {health ? (
          <>
            <div className="footer-row">
              <span className="dot ok" /> {health.model}
              <button
                className={`gear${settingsOpen ? " active" : ""}`}
                aria-label="Settings — MCP servers"
                title="MCP server settings"
                onClick={onOpenSettings}
              >
                <Settings size={14} />
              </button>
            </div>
            <div className="footer-row dim">
              memory {health.memory_chars}/{health.memory_budget} · {health.tools.length} tools
            </div>
          </>
        ) : (
          <div className="footer-row dim">connecting…</div>
        )}
      </div>
    </aside>
  );
}
