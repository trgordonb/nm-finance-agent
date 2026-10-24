// Per-user MCP server toggles.
//
// `mcp_servers.json` remains the tracked admin baseline: which servers exist
// and whether they are globally enabled. A login can disable any globally
// enabled server for itself; overrides live in
// `SKILLS_STATE_DIR/users/<login-id>/mcp.json` as { disabled: [...] }.
// Tools stay bound globally; the AgentLoop filters the per-turn tool list and
// the MCP wrapper re-checks before every call.

import fs from "node:fs";
import path from "node:path";
import { SKILLS_STATE_DIR } from "./config.js";
import { currentUserId, sanitizeUserId } from "./workspace.js";

export interface UserMcpState {
  disabled: string[];
}

export function userMcpStatePath(userId: string = currentUserId()): string {
  return path.join(SKILLS_STATE_DIR, "users", sanitizeUserId(userId) || "default", "mcp.json");
}

export function readUserMcpState(userId: string = currentUserId()): UserMcpState {
  try {
    const doc = JSON.parse(fs.readFileSync(userMcpStatePath(userId), "utf8")) as Partial<UserMcpState>;
    return {
      disabled: Array.isArray(doc.disabled) ? doc.disabled.map(String) : [],
    };
  } catch {
    return { disabled: [] };
  }
}

export function writeUserMcpState(state: UserMcpState, userId: string = currentUserId()): void {
  const file = userMcpStatePath(userId);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 1)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* best effort */
  }
}

export function disabledMcpServers(userId: string = currentUserId()): Set<string> {
  return new Set(readUserMcpState(userId).disabled);
}

/** Effective per-user state (global enablement is handled by the binding). */
export function mcpServerEnabledForUser(server: string, userId: string = currentUserId()): boolean {
  return !disabledMcpServers(userId).has(server);
}

export function setMcpServerEnabledForUser(
  server: string,
  enabled: boolean,
  userId: string = currentUserId(),
): { status: string } {
  const name = String(server ?? "").trim();
  if (!name) return { status: "Rejected: MCP server name is required" };
  const state = readUserMcpState(userId);
  const next = new Set(state.disabled);
  if (enabled) next.delete(name);
  else next.add(name);
  writeUserMcpState({ disabled: [...next].sort() }, userId);
  return {
    status: `OK: ${enabled ? "enabled" : "disabled"} MCP server ${JSON.stringify(name)} for ${JSON.stringify(sanitizeUserId(userId) || "default")}`,
  };
}
