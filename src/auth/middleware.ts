// Express glue: cookie parsing, same-origin enforcement and the auth gate.
//
// The gate resolves the cookie, refreshes/introspects through SessionManager,
// attaches `req.auth`, and maps failures to the SSO contract:
//   401 not_authenticated / token_inactive
//   403 permission_denied
//   503 sso_unavailable (+ Retry-After)

import type { NextFunction, Request, RequestHandler, Response } from "express";

import { log } from "../logger.js";
import { getClientIp, parseTrusted } from "./client-ip.js";
import type { AuthConfig } from "./config.js";
import {
  SessionExpiredError,
  SessionManager,
  type ResolvedSession,
} from "./session.js";
import {
  SsoClientError,
  SsoProtocolError,
  SsoRateLimited,
  SsoUnavailable,
} from "./sso.js";
import type { AuthSession } from "./store.js";

export type AuthedRequest = Request & { auth?: AuthSession };

export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    const raw = part.slice(eq + 1).trim();
    if (!raw) return null;
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return null;
}

export function clientIpFor(req: Request, config: AuthConfig): string | null {
  const trusted = parseTrusted(config.sso.trustedProxies);
  return getClientIp(
    req.socket.remoteAddress ?? null,
    req.headers,
    trusted,
    config.sso.clientIpHeader,
  );
}

/**
 * Cross-site request guard for state-changing methods. Same-origin requests
 * compare the Origin host with the Host header; configured extras (the Vite
 * dev server, which rewrites Host) are matched verbatim. Requests without an
 * Origin (curl, same-origin GET) pass.
 */
export function createOriginGuard(config: AuthConfig): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const method = req.method.toUpperCase();
    if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
      next();
      return;
    }

    const origin = req.headers.origin;
    if (!origin) {
      next();
      return;
    }
    if (config.allowedOrigins.includes(origin)) {
      next();
      return;
    }
    try {
      if (new URL(origin).host === req.headers.host) {
        next();
        return;
      }
    } catch {
      /* malformed Origin → reject below */
    }
    res.status(403).json({ detail: "origin_not_allowed" });
  };
}

export interface RequireAuthOptions {
  /** false for /api/auth/me, which must work even before the app grant. */
  permission?: boolean;
}

export function createRequireAuth(
  config: AuthConfig,
  manager: SessionManager,
  opts: RequireAuthOptions = {},
): RequestHandler {
  const trusted = parseTrusted(config.sso.trustedProxies);
  const enforcePermission = opts.permission !== false;

  return async (req: Request, res: Response, next: NextFunction) => {
    const raw = readCookie(req.headers.cookie, config.cookieName);
    if (!raw) {
      unauthorized(res);
      return;
    }

    let resolved: ResolvedSession;
    try {
      const ip = getClientIp(
        req.socket.remoteAddress ?? null,
        req.headers,
        trusted,
        config.sso.clientIpHeader,
      );
      resolved = await manager.resolve(raw, ip);
    } catch (err) {
      if (err instanceof SessionExpiredError) {
        unauthorized(res, err.reason);
        return;
      }
      if (err instanceof SsoRateLimited) {
        unavailable(res, err.retryAfterSeconds);
        return;
      }
      if (err instanceof SsoUnavailable) {
        unavailable(res, 5);
        return;
      }
      if (err instanceof SsoClientError) {
        log.error("auth: SSO rejected the ServiceClient credentials");
        res.status(502).json({ detail: "sso_client_rejected" });
        return;
      }
      if (err instanceof SsoProtocolError) {
        log.error(`auth: SSO protocol error (${String(err.message).slice(0, 160)})`);
        res.status(502).json({ detail: "sso_protocol_error" });
        return;
      }
      log.error(`auth: session resolve failed (${String(err).slice(0, 200)})`);
      res.status(500).json({ detail: "auth_error" });
      return;
    }

    (req as AuthedRequest).auth = resolved.session;

    if (enforcePermission && !resolved.allowed) {
      forbidden(res, [config.requiredPermission]);
      return;
    }
    next();
  };
}

function unauthorized(res: Response, reason?: string): void {
  res.setHeader("WWW-Authenticate", 'Bearer realm="nm-finance-agent"');
  if (!reason || reason === "unknown" || reason === "expired") {
    res.status(401).json({ detail: "not_authenticated" });
    return;
  }
  res.status(401).json({ detail: "token_inactive", reason });
}

function forbidden(res: Response, missing: string[]): void {
  res.status(403).json({ detail: "permission_denied", missing });
}

function unavailable(res: Response, retryAfterSeconds: number): void {
  res.setHeader("Retry-After", String(Math.max(1, Math.ceil(retryAfterSeconds))));
  res.status(503).json({ detail: "sso_unavailable" });
}
