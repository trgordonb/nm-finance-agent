// Minimal SSO server client for the BFF. No third-party HTTP/JWT dependency:
// introspection is the single source of truth (the Python sso-client's optional
// local JWKS pre-check is deliberately not ported yet), so the only things we
// need are POST /login, /refresh, /logout, /introspect and GET /healthz.
//
// The SSO origin is currently a self-signed IP certificate; `caPem` pins it.
// Tokens and secrets must never be logged.

import { X509Certificate } from "node:crypto";
import http from "node:http";
import https from "node:https";
import type { IncomingHttpHeaders, OutgoingHttpHeaders } from "node:http";

import type { SsoConfig } from "./config.js";

const MAX_RESPONSE_BYTES = 1_048_576;

export interface SsoUser {
  id: number | string;
  username: string;
  email?: string | null;
  first_name?: string;
  last_name?: string;
  is_staff?: boolean;
  groups?: string[];
  perms?: string[];
}

export interface LoginResponse {
  access_token: string;
  refresh_token: string;
  token_type?: string;
  expires_in: number;
  user: SsoUser;
}

export interface IntrospectResponse {
  active: boolean;
  sub?: string;
  username?: string;
  email?: string | null;
  is_staff?: boolean;
  groups?: string[];
  perms?: string[];
  sid?: string;
  ip_binding?: string;
  ip_match?: boolean | null;
  allowed?: boolean;
  token_type?: string;
  iat?: number;
  exp?: number;
  reason?: string;
}

// --- error taxonomy ---------------------------------------------------------

export class SsoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Network error, timeout, or 5xx. */
export class SsoUnavailable extends SsoError {
  constructor(
    message: string,
    readonly retryable = true,
  ) {
    super(message);
  }
}

export class SsoRateLimited extends SsoError {
  constructor(readonly retryAfterSeconds: number) {
    super("sso_rate_limited");
  }
}

export class SsoCredentialsError extends SsoError {}
export class SsoClientError extends SsoError {}
export class SsoAccountInactive extends SsoError {}
export class SsoTokenInvalid extends SsoError {}
export class SsoProtocolError extends SsoError {}

// --- HTTP plumbing ----------------------------------------------------------

interface HttpResult<T> {
  status: number;
  headers: IncomingHttpHeaders;
  body: T | null;
  raw: string;
}

interface RequestOptions {
  path: string;
  method?: "GET" | "POST";
  body?: unknown;
  basic?: boolean;
}

interface ErrorBody {
  error?: string;
  detail?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorCode(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const code = (body as ErrorBody).error;
  return typeof code === "string" ? code : undefined;
}

function retryAfterSeconds(headers: IncomingHttpHeaders): number {
  const raw = headers["retry-after"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 5;
  return Math.min(parsed, 300);
}

function parseBody(raw: string): unknown {
  if (!raw.trim()) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function requestJson<T>(cfg: SsoConfig, opts: RequestOptions): Promise<HttpResult<T>> {
  const url = new URL(opts.path, cfg.baseUrl);
  const isHttps = url.protocol === "https:";
  // http and https expose the same call signature for our purposes; the cast
  // avoids TypeScript's union-of-overloads complaint.
  const transport: typeof https = isHttps ? https : (http as unknown as typeof https);

  const payload =
    opts.body === undefined ? null : Buffer.from(JSON.stringify(opts.body), "utf8");
  const headers: OutgoingHttpHeaders = { Accept: "application/json" };
  if (payload) {
    headers["Content-Type"] = "application/json";
    headers["Content-Length"] = payload.length;
  }
  if (opts.basic) {
    headers.Authorization = `Basic ${Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString("base64")}`;
  }

  return new Promise<HttpResult<T>>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };

    const req = transport.request(
      url,
      {
        method: opts.method ?? (payload ? "POST" : "GET"),
        headers,
        timeout: cfg.timeoutMs,
        ...(isHttps && cfg.caPem ? { ca: cfg.caPem } : {}),
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_RESPONSE_BYTES) {
            finish(() => reject(new Error("response_too_large")));
            req.destroy();
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          finish(() =>
            resolve({
              status: res.statusCode ?? 0,
              headers: res.headers,
              body: parseBody(raw) as T | null,
              raw,
            }),
          );
        });
        res.on("error", (err) => finish(() => reject(err)));
      },
    );

    req.on("timeout", () => {
      finish(() => reject(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })));
      req.destroy();
    });
    req.on("error", (err) => finish(() => reject(err)));

    if (payload) req.write(payload);
    req.end();
  });
}

function mapLoginError(res: HttpResult<unknown>): SsoError {
  const code = errorCode(res.body);
  if (res.status === 401 && code === "invalid_credentials") {
    return new SsoCredentialsError("invalid_credentials");
  }
  if (res.status === 401 && code === "invalid_client") {
    return new SsoClientError("invalid_client");
  }
  if (res.status === 403 && code === "account_inactive") {
    return new SsoAccountInactive("account_inactive");
  }
  return new SsoProtocolError(`sso login failed: ${res.status}${code ? ` ${code}` : ""}`);
}

function mapTokenError(res: HttpResult<unknown>): SsoError {
  const code = errorCode(res.body);
  if (res.status === 401 && code === "token_invalid") return new SsoTokenInvalid("token_invalid");
  if (res.status === 401 && code === "invalid_client") return new SsoClientError("invalid_client");
  if (res.status === 403 && code === "account_inactive") {
    return new SsoAccountInactive("account_inactive");
  }
  return new SsoProtocolError(`sso token call failed: ${res.status}${code ? ` ${code}` : ""}`);
}

// --- client -----------------------------------------------------------------

export class SsoClient {
  constructor(private readonly cfg: SsoConfig) {}

  private async call<T>(opts: RequestOptions): Promise<HttpResult<T>> {
    let lastError: unknown = null;
    for (let attempt = 0; attempt <= this.cfg.retries; attempt++) {
      try {
        let res: HttpResult<T>;
        try {
          res = await requestJson<T>(this.cfg, opts);
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          throw new SsoUnavailable(`sso request failed${code ? ` (${code})` : ""}`, true);
        }
        if (res.status === 429) throw new SsoRateLimited(retryAfterSeconds(res.headers));
        if (res.status >= 500) {
          throw new SsoUnavailable(
            `sso ${res.status}`,
            res.status === 502 || res.status === 503 || res.status === 504,
          );
        }
        return res;
      } catch (err) {
        lastError = err;
        const retryable = err instanceof SsoUnavailable && err.retryable;
        if (!retryable || attempt === this.cfg.retries) throw err;
        await sleep(100 * 2 ** attempt + Math.floor(Math.random() * 100));
      }
    }
    throw lastError instanceof Error ? lastError : new SsoUnavailable("sso unavailable");
  }

  async healthz(): Promise<void> {
    const res = await this.call<{ status?: string }>({ path: "/healthz", basic: false });
    if (res.status !== 200) throw new SsoProtocolError(`sso healthz: ${res.status}`);
    const status = res.body?.status;
    if (typeof status === "string" && status !== "ok") {
      throw new SsoProtocolError(`sso healthz: ${status}`);
    }
  }

  async login(username: string, password: string, clientIp: string | null): Promise<LoginResponse> {
    const body: Record<string, unknown> = { username, password, client: "native" };
    if (clientIp) body.client_ip = clientIp;

    const res = await this.call<LoginResponse>({
      path: "/api/v1/auth/login",
      basic: true,
      body,
    });
    if (res.status !== 200 || !isLoginResponse(res.body)) throw mapLoginError(res);
    return res.body;
  }

  async refresh(refreshToken: string, clientIp: string | null): Promise<LoginResponse> {
    const body: Record<string, unknown> = { refresh_token: refreshToken };
    if (clientIp) body.client_ip = clientIp;

    const res = await this.call<LoginResponse>({
      path: "/api/v1/auth/refresh",
      basic: true,
      body,
    });
    if (res.status !== 200 || !isLoginResponse(res.body)) throw mapTokenError(res);
    return res.body;
  }

  /** Idempotent: a token the SSO already considers invalid is fine. */
  async logout(refreshToken: string, clientIp: string | null): Promise<void> {
    const body: Record<string, unknown> = { refresh_token: refreshToken };
    if (clientIp) body.client_ip = clientIp;

    const res = await this.call<unknown>({
      path: "/api/v1/auth/logout",
      basic: true,
      body,
    });
    if (res.status === 204 || res.status === 200) return;
    if (res.status === 401 && errorCode(res.body) === "token_invalid") return;
    throw mapTokenError(res);
  }

  async introspect(
    token: string,
    clientIp: string | null,
    require: string[] = [],
  ): Promise<IntrospectResponse> {
    const body: Record<string, unknown> = { token };
    if (clientIp) body.ip = clientIp;
    if (require.length) body.require = require;

    const res = await this.call<IntrospectResponse>({
      path: "/api/v1/auth/introspect",
      basic: true,
      body,
    });
    if (res.status !== 200 || !res.body || typeof res.body.active !== "boolean") {
      const code = errorCode(res.body);
      if (res.status === 401 && code === "invalid_client") {
        throw new SsoClientError("invalid_client");
      }
      throw new SsoProtocolError(
        `sso introspect failed: ${res.status}${code ? ` ${code}` : ""}`,
      );
    }
    return res.body;
  }
}

function isLoginResponse(body: unknown): body is LoginResponse {
  if (!body || typeof body !== "object") return false;
  const value = body as Partial<LoginResponse>;
  return (
    typeof value.access_token === "string" &&
    typeof value.refresh_token === "string" &&
    typeof value.expires_in === "number" &&
    !!value.user &&
    typeof value.user.username === "string" &&
    (typeof value.user.id === "number" || typeof value.user.id === "string")
  );
}

export function createSsoClient(cfg: SsoConfig): SsoClient {
  return new SsoClient(cfg);
}

/** Days until the pinned certificate expires, for a boot warning. */
export function certificateDaysRemaining(caPem: string | null): number | null {
  if (!caPem) return null;
  try {
    const cert = new X509Certificate(caPem);
    const end = Date.parse(cert.validTo);
    if (!Number.isFinite(end)) return null;
    return (end - Date.now()) / 86_400_000;
  } catch {
    return null;
  }
}
