// MCP tab: mcp_servers.json listing with per-server enable/disable toggles.
// Port of langgraph-demo's McpTab. Backend: GET /api/mcp (config +
// last-assembly status), POST /api/mcp/{name}/enabled (atomic config
// rewrite), POST /api/mcp/reload (re-assemble; 409 while turns stream).
// Toggles apply after Reload on the server, or at the next session.

import { useCallback, useEffect, useMemo, useState } from "react";
import { getMcpServers, reloadMcp, setMcpServerEnabled } from "../api";
import type { McpServerInfo } from "../types";

export default function McpTab() {
  const [servers, setServers] = useState<McpServerInfo[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  const [reloading, setReloading] = useState(false);

  const refresh = useCallback(() => {
    getMcpServers()
      .then((body) => {
        setServers(body.servers);
        setLoadError(null);
      })
      .catch((err) => setLoadError(err instanceof Error ? err.message : String(err)));
  }, []);

  useEffect(refresh, [refresh]);

  const toggle = useCallback(
    async (server: McpServerInfo) => {
      if (busy) return;
      const next = !server.enabled;
      setBusy(server.name);
      setBanner(null);
      setServers((prev) => prev?.map((s) => (s.name === server.name ? { ...s, enabled: next } : s)) ?? prev);
      try {
        await setMcpServerEnabled(server.name, next);
      } catch (err) {
        setServers((prev) => prev?.map((s) => (s.name === server.name ? { ...s, enabled: !next } : s)) ?? prev);
        setBanner(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(null);
      }
    },
    [busy],
  );

  const reload = useCallback(async () => {
    setReloading(true);
    setBanner(null);
    try {
      const body = await reloadMcp();
      setBanner(`${body.status} — ${body.mcp_tools} MCP tool(s) bound`);
      refresh();
    } catch (err) {
      setBanner(err instanceof Error ? err.message : String(err));
    } finally {
      setReloading(false);
    }
  }, [refresh]);

  const enabledCount = useMemo(() => servers?.filter((s) => s.enabled).length ?? 0, [servers]);

  const statusLine = (s: McpServerInfo) => {
    if (!s.enabled) return "disabled";
    if (s.error) return s.error;
    if (s.connected === null) return "not assembled yet";
    if (!s.connected) return s.connect_error ?? "connection failed";
    return `${s.tool_count} tool(s) bound`;
  };

  return (
    <main className="skills">
      <div className="skills-inner">
        <div className="skills-head">
          <div>
            <div className="skills-title">MCP servers</div>
            <div className="skills-count">
              {servers ? `${enabledCount} enabled · ${servers.length - enabledCount} disabled` : "loading…"}
            </div>
          </div>
          <div className="skills-actions">
            <button className="skills-refresh" onClick={refresh}>↻ Refresh</button>
            <button className="skills-refresh" onClick={reload} disabled={reloading}>
              {reloading ? "Reloading…" : "⟳ Reload runtime"}
            </button>
          </div>
        </div>

        {banner && (
          <div className="skills-error" onClick={() => setBanner(null)} title="click to dismiss">
            {banner} — click to dismiss
          </div>
        )}

        {loadError ? (
          <div className="skills-error">
            {loadError} — <button className="skills-retry" onClick={refresh}>retry</button>
          </div>
        ) : (
          <div className="skills-list">
            {servers === null && <div className="skills-empty">loading…</div>}
            {servers !== null && servers.length === 0 && (
              <div className="skills-empty">
                No MCP servers configured — add entries to mcp_servers.json.
              </div>
            )}
            {servers?.map((s) => (
              <div key={s.name} className={`skill-row${s.enabled ? "" : " disabled"}`}>
                <div className="skill-info">
                  <div className="skill-row-head">
                    <span className="skill-name">{s.name}</span>
                    <span className="mcp-transport">{s.transport}</span>
                  </div>
                  {s.description && <div className="skill-desc">{s.description}</div>}
                  <div
                    className={`mcp-status${
                      s.enabled ? (s.connected === false || s.error ? " bad" : "") : ""
                    }`}
                  >
                    {statusLine(s)}
                  </div>
                </div>
                <button
                  className={`toggle${s.enabled ? " on" : ""}`}
                  role="switch"
                  aria-checked={s.enabled}
                  aria-label={`${s.enabled ? "Disable" : "Enable"} MCP server ${s.name}`}
                  disabled={busy !== null}
                  onClick={() => toggle(s)}
                >
                  <span className="knob" />
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="skills-note">
          Toggles edit mcp_servers.json and apply after Reload runtime (server) or at the next
          session (CLI) — the tool list is bound once per assembled runtime
        </div>
      </div>
    </main>
  );
}
