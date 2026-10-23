// Authentication configuration (SSO BFF). Read directly from process.env so
// this module can be imported by tests with an explicit env object; the app's
// `src/config.ts` loads dotenv before this module is evaluated.
//
// AUTH_MODE=off (default) keeps the historical no-auth behaviour. AUTH_MODE=sso
// validates everything up front and throws — a half-configured auth layer must
// never boot "open" by accident.

import fs from "node:fs";
import path from "node:path";

export type AuthMode = "off" | "sso";

export interface SsoConfig {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  /** PEM read from SSO_CA_FILE; null uses Node's default trust store. */
  caPem: string | null;
  caFile: string | null;
  timeoutMs: number;
  retries: number;
  cacheTtlSeconds: number;
  trustedProxies: string;
  clientIpHeader: string;
}

export interface AuthConfig {
  mode: AuthMode;
  requiredPermission: string;
  sessionTtlDays: number;
  cookieName: string;
  cookieSecure: boolean;
  dbPath: string;
  allowedOrigins: string[];
  sso: SsoConfig;
}

const TRUE = new Set(["1", "true", "yes", "on"]);

function boolEnv(value: string | undefined, fallback = false): boolean {
  if (value === undefined || value === "") return fallback;
  return TRUE.has(value.trim().toLowerCase());
}

function intEnv(
  name: string,
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`AUTH_MODE=sso: ${name} must be an integer (got "${value}")`);
  }
  return Math.min(max, Math.max(min, parsed));
}

function requiredEnv(name: string, value: string | undefined): string {
  const trimmed = (value ?? "").trim();
  if (!trimmed) throw new Error(`AUTH_MODE=sso: ${name} is required`);
  return trimmed;
}

function readSecretFile(file: string): string {
  const resolved = path.resolve(file);
  let value: string;
  try {
    value = fs.readFileSync(resolved, "utf8").trim();
  } catch {
    throw new Error(`AUTH_MODE=sso: SSO_CLIENT_SECRET_FILE is unreadable at ${resolved}`);
  }
  if (!value) throw new Error(`AUTH_MODE=sso: SSO_CLIENT_SECRET_FILE is empty (${resolved})`);
  return value;
}

function readCa(file: string): { caPem: string; caFile: string } {
  const resolved = path.resolve(file);
  let pem: string;
  try {
    pem = fs.readFileSync(resolved, "utf8");
  } catch {
    throw new Error(`AUTH_MODE=sso: SSO_CA_FILE is unreadable at ${resolved}`);
  }
  if (!pem.includes("BEGIN CERTIFICATE")) {
    throw new Error(`AUTH_MODE=sso: SSO_CA_FILE is not a PEM certificate (${resolved})`);
  }
  return { caPem: pem, caFile: resolved };
}

/** Parse and validate a full auth config. Exported so tests can inject env. */
export function loadAuthConfig(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  const rawMode = (env.AUTH_MODE ?? "off").trim().toLowerCase();
  if (rawMode !== "off" && rawMode !== "sso") {
    throw new Error(`AUTH_MODE must be "off" or "sso" (got "${env.AUTH_MODE}")`);
  }
  const mode: AuthMode = rawMode;

  const requiredPermission = (env.AUTH_REQUIRED_PERMISSION ?? "application.nmfinance").trim();
  if (!/^application\.[a-z][a-z0-9_]{1,62}$/.test(requiredPermission)) {
    throw new Error(
      `AUTH_REQUIRED_PERMISSION must look like application.<codename> (got "${requiredPermission}")`,
    );
  }

  const sessionTtlDays = intEnv("AUTH_SESSION_TTL_DAYS", env.AUTH_SESSION_TTL_DAYS, 7, 1, 30);
  const cookieName = (env.AUTH_COOKIE_NAME ?? "nm_auth").trim();
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(cookieName)) {
    throw new Error(`AUTH_COOKIE_NAME must be a simple cookie name (got "${cookieName}")`);
  }

  const cookieSecure =
    env.AUTH_COOKIE_SECURE === undefined || env.AUTH_COOKIE_SECURE.trim() === ""
      ? env.NODE_ENV === "production"
      : boolEnv(env.AUTH_COOKIE_SECURE);

  const dbPath = path.resolve((env.AUTH_DB_PATH ?? "./auth.db").trim() || "./auth.db");

  const allowedOrigins = (env.AUTH_ALLOWED_ORIGINS ?? "http://localhost:5173,http://127.0.0.1:5173")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  let baseUrl = "";
  let clientId = "";
  let clientSecret = "";
  let caPem: string | null = null;
  let caFile: string | null = null;
  let timeoutMs = 2000;
  let retries = 1;
  let cacheTtlSeconds = 30;
  let trustedProxies = "127.0.0.1,::1";
  let clientIpHeader = "cf-connecting-ip";

  if (mode === "sso") {
    baseUrl = requiredEnv("SSO_BASE_URL", env.SSO_BASE_URL).replace(/\/+$/, "");
    let parsed: URL;
    try {
      parsed = new URL(baseUrl);
    } catch {
      throw new Error(`AUTH_MODE=sso: SSO_BASE_URL is not a valid URL (${baseUrl})`);
    }
    if (parsed.protocol !== "https:" && !boolEnv(env.SSO_ALLOW_HTTP)) {
      throw new Error("AUTH_MODE=sso: SSO_BASE_URL must be https:// (SSO_ALLOW_HTTP=1 overrides)");
    }
    if (parsed.pathname !== "/" && parsed.pathname !== "") {
      throw new Error("AUTH_MODE=sso: SSO_BASE_URL must not include a path");
    }
    baseUrl = parsed.origin;

    clientId = requiredEnv("SSO_CLIENT_ID", env.SSO_CLIENT_ID);
    const secretFile = (env.SSO_CLIENT_SECRET_FILE ?? "").trim();
    clientSecret = secretFile
      ? readSecretFile(secretFile)
      : requiredEnv("SSO_CLIENT_SECRET", env.SSO_CLIENT_SECRET);

    const ca = (env.SSO_CA_FILE ?? "").trim();
    if (ca) ({ caPem, caFile } = readCa(ca));

    timeoutMs = intEnv("SSO_TIMEOUT_MS", env.SSO_TIMEOUT_MS, 2000, 250, 30_000);
    retries = intEnv("SSO_RETRIES", env.SSO_RETRIES, 1, 0, 3);
    cacheTtlSeconds = intEnv("SSO_CACHE_TTL_SECONDS", env.SSO_CACHE_TTL_SECONDS, 30, 0, 30);
    trustedProxies = (env.SSO_TRUSTED_PROXIES ?? "127.0.0.1,::1").trim();
    clientIpHeader = (env.SSO_CLIENT_IP_HEADER ?? "cf-connecting-ip").trim();
  }

  return {
    mode,
    requiredPermission,
    sessionTtlDays,
    cookieName,
    cookieSecure,
    dbPath,
    allowedOrigins,
    sso: {
      baseUrl,
      clientId,
      clientSecret,
      caPem,
      caFile,
      timeoutMs,
      retries,
      cacheTtlSeconds,
      trustedProxies,
      clientIpHeader,
    },
  };
}

/** The process config. Importing this with an invalid AUTH_MODE=sso throws. */
export const authConfig: AuthConfig = loadAuthConfig();
export const isAuthEnabled = authConfig.mode === "sso";
