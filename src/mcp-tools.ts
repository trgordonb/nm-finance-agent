// MCP tool binding: connect each enabled, interpolated server independently,
// list its tools, and wrap them as flat ToolDef registry entries — one bad
// server logs a warning and is skipped, never takes the rest down (python
// `_load_mcp_tools` parity). Tool names namespace as `<server>_<tool>` with
// `keep_tools` filtering (exact + `_<tool>` suffix).
//
// Transports (per mcp_servers.json):
//   stdio            → StdioClientTransport (command + args + env)
//   streamable_http  → StreamableHTTPClientTransport (url + headers)
//   sse              → SSEClientTransport (url + headers)
//
// Failure semantics: binding happens at runtime assembly, before accepting
// turns; per-server errors land in the report row, never crash the process.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import fs from "node:fs";
import path from "node:path";
import { keepToolsFilter, type McpServerCfg, type McpLoadResult, type ServerStatus } from "./mcp-config.js";
import { log } from "./logger.js";
import { AGENTDB_MCP_DIR } from "./config.js";
import { currentUserId, sanitizeUserId } from "./workspace.js";
import { mcpServerEnabledForUser } from "./mcp-user-state.js";
import type { ToolDef, ToolCall as ChatToolCall } from "./types.js";

export type McpReport = ServerStatus[];

interface RawTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

const CONNECT_TIMEOUT_MS = Number(process.env.MCP_CONNECT_TIMEOUT_MS ?? "30000");
const CALL_TIMEOUT_MS = Number(process.env.MCP_CALL_TIMEOUT_MS ?? "120000");

/** Per-user agentdb MCP DB (reflexion episodes, skills, patterns). */
export function agentdbUserDbPath(userId: string): string {
  return path.join(AGENTDB_MCP_DIR, sanitizeUserId(userId) || "default", "agentdb-mcp.db");
}

/** Lazily connected stdio clients keyed by `agentdb:<user>` — one DB each. */
const USER_CLIENTS = new Map<string, Promise<Client>>();

/** Bound tool name → MCP server name (used by the per-turn tool policy). */
const TOOL_SERVERS = new Map<string, string>();

export function mcpServerForTool(toolName: string): string | null {
  return TOOL_SERVERS.get(toolName) ?? null;
}

async function agentdbClient(cfg: McpServerCfg, userId: string): Promise<Client> {
  const key = `agentdb:${sanitizeUserId(userId) || "default"}`;
  const existing = USER_CLIENTS.get(key);
  if (existing) return existing;
  if (cfg.transport !== "stdio" || !cfg.command) {
    throw new Error("agentdb per-user transport requires a stdio command");
  }
  const promise = (async () => {
    const dbPath = agentdbUserDbPath(userId);
    fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
    const transport = new StdioClientTransport({
      command: cfg.command as string,
      args: cfg.args ?? [],
      env: { ...process.env, ...cfg.env, AGENTDB_PATH: dbPath } as Record<string, string>,
      stderr: "ignore" as const,
    });
    const client = new Client({ name: "nm-finance-agent", version: "0.1.0" });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("agentdb per-user connect timeout 30s")),
        30_000,
      );
      timer.unref?.();
      client.connect(transport).then(
        () => {
          clearTimeout(timer);
          resolve();
        },
        (e) => {
          clearTimeout(timer);
          reject(e);
        },
      );
    }).catch(async (e) => {
      await client.close().catch(() => undefined);
      throw e;
    });

    // agentdb's packaged schema bootstrap is conditional on its schema files
    // resolving; a fresh per-user DB can otherwise stay empty (seen live:
    // "no such table: episodes"). Call the init tool for its CREATE-IF-NOT-
    // EXISTS side effect. It then reports isError from its own stats query
    // (`WHERE type="table"` is an identifier in SQLite), so the report is
    // ignored; a later tool fails loudly if the schema is genuinely missing.
    try {
      await client.callTool({ name: "agentdb_init", arguments: { db_path: dbPath } });
    } catch (e) {
      await client.close().catch(() => undefined);
      throw e;
    }
    return client;
  })();
  USER_CLIENTS.set(key, promise);
  promise.catch(() => USER_CLIENTS.delete(key));
  return promise;
}

async function connectServer(name: string, cfg: McpServerCfg): Promise<RawTool[]> {
  const client = new Client({ name: "nm-finance-agent", version: "0.1.0" });
  const timeout = <T>(p: Promise<T>, ms: number, what: string): Promise<T> =>
    Promise.race([
      p,
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`${what} timeout ${ms / 1000}s`)), ms)),
    ]);

  let transport;
  if (cfg.transport === "stdio") {
    if (!cfg.command) throw new Error("stdio transport requires command");
    if (cfg.env?.AGENTDB_PATH) {
      fs.mkdirSync(path.dirname(cfg.env.AGENTDB_PATH), { recursive: true });
    }
    transport = new StdioClientTransport({
      command: cfg.command,
      args: cfg.args ?? [],
      env: { ...process.env, ...cfg.env } as Record<string, string>,
      stderr: "ignore" as const,
    });
  } else if (cfg.transport === "streamable_http") {
    if (!cfg.url) throw new Error("streamable_http transport requires url");
    transport = new StreamableHTTPClientTransport(new URL(cfg.url), {
      requestInit: { headers: cfg.headers ?? {} },
    });
  } else if (cfg.transport === "sse") {
    if (!cfg.url) throw new Error("sse transport requires url");
    transport = new SSEClientTransport(new URL(cfg.url), {
      requestInit: { headers: cfg.headers ?? {} },
    });
  } else {
    throw new Error(`unsupported transport ${cfg.transport}`);
  }

  await timeout(client.connect(transport), CONNECT_TIMEOUT_MS, `${name} connect`);
  const listed = await timeout(client.listTools(), CONNECT_TIMEOUT_MS, `${name} listTools`);
  const rawTools = (listed.tools ?? []).map((t) => ({
    name: t.name,
    description: t.description ?? "",
    inputSchema: t.inputSchema,
  }));
  // The client stays connected: tool executions reuse this session.
  keepOpen(name, client);
  return rawTools;
}

/** Bound clients held open for the runtime's lifetime (closed on reload). */
const OPEN_CLIENTS = new Map<string, Client>();

function keepOpen(name: string, client: Client): void {
  OPEN_CLIENTS.set(name, client);
}

export function closeOpenClients(except?: Set<string>): void {
  for (const [name, c] of [...OPEN_CLIENTS.entries()]) {
    if (except?.has(name)) continue;
    OPEN_CLIENTS.delete(name);
    void c.close().catch(() => undefined);
  }
  if (except?.has("agentdb")) return;
  for (const [key, pending] of [...USER_CLIENTS.entries()]) {
    USER_CLIENTS.delete(key);
    void pending.then((c) => c.close()).catch(() => undefined);
  }
}

function flattenResult(result: unknown): string {
  // python _tool_text parity: the MCP result may be content blocks or contain
  // a nested output list — flatten text parts, never leak repr noise.
  const r = result as { content?: unknown[]; isError?: boolean; output?: unknown };
  let blocks: unknown[] | undefined = r?.content as unknown[];
  let isError = Boolean(r?.isError);
  if (
    !blocks &&
    typeof r === "object" &&
    (r as { output?: unknown }).output &&
    Array.isArray((r as { output: unknown[] }).output)
  ) {
    blocks = (r as { output: unknown[] }).output;
  }
  const parts = (blocks ?? [])
    .filter((b): b is { type: string; text?: string } => typeof b === "object" && b !== null && "text" in b)
    .map((b) => String(b.text ?? ""));
  const text = parts.length ? parts.join("\n") : JSON.stringify(result).slice(0, 400);
  return isError ? `Error: ${text}` : text;
}

interface BindResult {
  tools: ToolDef[];
  report: McpReport;
}

export async function bindMcpTools(load: McpLoadResult): Promise<BindResult> {
  const tools: ToolDef[] = [];
  const report: McpReport = load.statuses.map((s) => ({ ...s }));
  TOOL_SERVERS.clear();
  for (const [name, cfg] of Object.entries(load.clientServers)) {
    const status = report.find((r) => r.name === name)!;
    try {
      const rawTools = await connectServer(name, cfg);
      const keep = load.raw[name]?.keep_tools;
      const matches = keepToolsFilter(keep);
      let bound = 0;
      for (const raw of rawTools) {
        // self-prefixed tools (agentdb's own agentdb_* names) never double up
        const namespaced = raw.name.startsWith(`${name}_`) ? raw.name : `${name}_${raw.name}`;
        if (!matches(namespaced)) continue;
        bound++;
        TOOL_SERVERS.set(namespaced, name);
        tools.push(toToolDef(namespaced, name, raw, cfg));
      }
      status.connected = true;
      status.tool_count = bound;
      log.info(`MCP: bound ${bound} tools from ${JSON.stringify(name)}`);
    } catch (e) {
      status.connected = false;
      status.connect_error = String((e as Error).message).slice(0, 300);
      log.warn(`MCP server ${JSON.stringify(name)} failed, skipping: ${String(e).slice(0, 200)}`);
    }
  }
  return { tools, report };
}

function toToolDef(namespaced: string, server: string, raw: RawTool, cfg: McpServerCfg): ToolDef {
  return {
    name: namespaced,
    description:
      `[MCP:${server}] ${raw.description || namespaced}` +
      ` (bound at runtime assembly — reload to refresh)`,
    parameters:
      raw.inputSchema && typeof raw.inputSchema === "object"
        ? (raw.inputSchema as ToolDef["parameters"])
        : { type: "object" as const, properties: {} },
    async execute(args: ChatToolCall["args"]) {
      if (!mcpServerEnabledForUser(server)) {
        return `Rejected: MCP server ${JSON.stringify(server)} is disabled for this user`;
      }
      const userId = currentUserId();
      let client: Client | undefined;
      let callArgs: ChatToolCall["args"] = args ?? {};

      // agentdb: one SQLite DB + one MCP server per login. The boot-time
      // client only lists tools (discovery DB); data calls route here.
      if (server === "agentdb" && cfg.transport === "stdio") {
        try {
          client = await agentdbClient(cfg, userId);
          if (raw.name === "agentdb_pattern_store") {
            const meta =
              callArgs.metadata && typeof callArgs.metadata === "object" && !Array.isArray(callArgs.metadata)
                ? (callArgs.metadata as Record<string, unknown>)
                : {};
            callArgs = { ...callArgs, metadata: { ...meta, user_id: userId } };
          }
          if (raw.name === "agentdb_learning_start_session" && !callArgs.user_id) {
            callArgs = { ...callArgs, user_id: userId };
          }
          if (raw.name === "agentdb_init" && !callArgs.db_path) {
            callArgs = { ...callArgs, db_path: agentdbUserDbPath(userId) };
          }
        } catch (e) {
          log.warn(`MCP agentdb: per-user client failed for ${userId}: ${String(e).slice(0, 160)}`);
          return `Error: MCP ${namespaced} unavailable for ${userId}: ${(e as Error).message}`.slice(0, 800);
        }
      } else {
        client = OPEN_CLIENTS.get(server);
      }

      if (!client) return `Error: MCP server ${server} is not connected`;
      try {
        const result = await Promise.race([
          client.callTool({ name: raw.name, arguments: callArgs }),
          new Promise<never>((_, rej) =>
            setTimeout(() => rej(new Error("call timeout")), CALL_TIMEOUT_MS),
          ),
        ]);
        return flattenResult(result);
      } catch (e) {
        if (server === "agentdb" && cfg.transport === "stdio") {
          USER_CLIENTS.delete(`agentdb:${sanitizeUserId(userId) || "default"}`);
        }
        return `Error: MCP ${namespaced} failed: ${(e as Error).message}`.slice(0, 800);
      }
    },
  };
}
