// MCP server configuration: ``mcp_servers.json`` with per-server enable/disable.
// Faithful port of langgraph-demo's mcp_config.py (see MCP_TOGGLE_PLAN.md).
//
// Machine-local, git-tracked config — unlike skills, this never goes near the
// object registry: a stdio ``command`` is meaningless off this machine.
// Secrets are ``${VAR}``-interpolated from the environment at load time and
// never stored in the file; an unresolved placeholder disables that server
// with a warning (fail-closed), never a crash and never a leaked literal.
// Toggles rewrite the file atomically (``.tmp`` + rename) and apply at the
// next runtime assembly (CLI: next session; server: reload endpoint).

import fs from "node:fs";
import path from "node:path";
const ALLOWED_TRANSPORTS = new Set(["stdio", "streamable_http", "sse"]);

const PLACEHOLDER = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
const PASSTHROUGH_KEYS = ["transport", "command", "args", "env", "url", "headers"] as const;

export interface ServerStatus {
  name: string;
  enabled: boolean;
  description?: string;
  transport?: string;
  error?: string | null;
  connected?: boolean | null;
  tool_count?: number | null;
  connect_error?: string | null;
}

export interface McpServerCfg {
  transport: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

export interface McpLoadResult {
  /** Enabled, successfully interpolated servers, keyed by name. */
  clientServers: Record<string, McpServerCfg>;
  /** Every configured server's status (enabled flag + fail-closed errors). */
  statuses: ServerStatus[];
  /** Raw per-server config (keep_tools lives here, not in the passthrough). */
  raw: Record<string, { keep_tools?: string[] }>;
}

export function defaultMcpServersPath(): string {
  return path.resolve(process.env.MCP_SERVERS_FILE || "mcp_servers.json");
}

function interpolate(value: unknown, name: string, missing: string[]): unknown {
  if (typeof value === "string") {
    return value.replace(PLACEHOLDER, (_, v: string) => {
      const fromEnv = process.env[v];
      if (fromEnv === undefined) {
        missing.push(v);
        return "";
      }
      return fromEnv;
    });
  }
  if (Array.isArray(value)) return value.map((v) => interpolate(v, name, missing));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = interpolate(v, name, missing);
    return out;
  }
  return value;
}

export function loadMcpServers(mcpPath?: string): McpLoadResult {
  const p = mcpPath ? path.resolve(mcpPath) : defaultMcpServersPath();
  const statuses: ServerStatus[] = [];
  const raw: McpLoadResult["raw"] = {};
  if (!fs.existsSync(p) || !fs.statSync(p).isFile()) {
    return { clientServers: {}, statuses, raw };
  }
  let doc: any;
  try {
    doc = JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (e) {
    // The config file itself is unreadable/unparseable — surface loudly.
    throw new Error(`mcp config ${p}: unparseable JSON: ${(e as Error).message}`);
  }
  const servers = doc?.servers ?? {};
  if (typeof servers !== "object" || Array.isArray(servers)) {
    throw new Error(`mcp config ${p}: 'servers' must be an object`);
  }
  const clientServers: Record<string, McpServerCfg> = {};
  for (const [name, rawCfg] of Object.entries(servers) as Array<[string, any]>) {
    if (typeof rawCfg !== "object" || rawCfg === null || Array.isArray(rawCfg)) {
      statuses.push({ name, enabled: false, error: "invalid entry (not an object)" });
      continue;
    }
    raw[name] = rawCfg;
    const description = String(rawCfg.description ?? "");
    const transport = String(rawCfg.transport ?? "");
    const enabled = Boolean(rawCfg.enabled ?? false);
    const status: ServerStatus = { name, enabled, description, transport };
    if (!ALLOWED_TRANSPORTS.has(transport)) {
      status.error = `unsupported transport ${JSON.stringify(transport)}`;
    } else if (!enabled) {
      // deliberately off — normal state, not an error
    } else {
      const missing: string[] = [];
      const passthrough: Record<string, unknown> = {};
      for (const k of PASSTHROUGH_KEYS) if (k in rawCfg) passthrough[k] = interpolate(rawCfg[k], name, missing);
      if (missing.length) {
        status.error =
          "unresolved env vars: " + [...new Set(missing)].sort().join(", ") +
          " (server skipped, fail-closed)";
      } else {
        clientServers[name] = passthrough as unknown as McpServerCfg;
      }
    }
    statuses.push(status);
  }
  return { clientServers, statuses, raw };
}

export interface SetEnabledResult {
  status: string; // "OK: ..." | "Rejected: ..."
  notFound?: boolean;
}

/** Atomically flip one server's enabled flag. Status-message shaped for REST. */
export function setServerEnabled(name: string, enabled: boolean, mcpPath?: string): SetEnabledResult {
  const p = mcpPath ? path.resolve(mcpPath) : defaultMcpServersPath();
  let doc: any;
  try {
    doc = JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (e) {
    return { status: `Rejected: mcp config unparseable: ${(e as Error).message}`, notFound: true };
  }
  const servers = doc?.servers ?? {};
  if (!(name in servers)) return { status: `Rejected: no MCP server named ${JSON.stringify(name)}`, notFound: true };
  servers[name].enabled = Boolean(enabled);
  const tmp = path.join(path.dirname(p), `.${path.basename(p)}.tmp-${process.pid}`);
  fs.writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, p);
  const verb = enabled ? "enabled" : "disabled";
  return { status: `OK: ${verb} MCP server ${JSON.stringify(name)}` };
}

/**
 * Filter bound tools by a server's keep_tools list. Tools are namespaced as
 * `<server>_<tool>`, and tool names are themselves multi-word
 * (``library_get_source_code``), so match on exact name or ``_<tool>`` suffix —
 * never on the last underscore segment (python parity).
 */
export function keepToolsFilter(keep: string[] | undefined | null) {
  if (!keep || !keep.length) return () => true;
  return (toolName: string): boolean =>
    keep.some((k) => toolName === k || toolName.endsWith(`_${k}`));
}

