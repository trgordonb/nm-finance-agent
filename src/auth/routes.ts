// /api/auth/*: the only routes reachable without a session. The browser posts
// credentials here; the server talks to the SSO and returns an HttpOnly cookie.
// No token is ever serialised to the client.

import { Router, type CookieOptions, type Request, type Response } from "express";

import { log } from "../logger.js";
import type { AuthConfig } from "./config.js";
import { clientIpFor, createRequireAuth, readCookie, type AuthedRequest } from "./middleware.js";
import type { SessionManager } from "./session.js";
import {
  SsoAccountInactive,
  SsoClient,
  SsoClientError,
  SsoCredentialsError,
  SsoProtocolError,
  SsoRateLimited,
  SsoTokenInvalid,
  SsoUnavailable,
} from "./sso.js";

export interface AuthRouterDeps {
  config: AuthConfig;
  manager: SessionManager;
  sso: SsoClient;
}

export function createAuthRouter({ config, manager, sso }: AuthRouterDeps): Router {
  const router = Router();
  const limiter = createLoginLimiter();
  const requireSession = createRequireAuth(config, manager, { permission: false });

  router.post("/login", async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { username?: unknown; password?: unknown };
    if (
      typeof body.username !== "string" ||
      typeof body.password !== "string" ||
      !body.username.trim() ||
      !body.password
    ) {
      res.status(400).json({ detail: "username and password required" });
      return;
    }
    if (body.username.length > 254 || body.password.length > 4096) {
      res.status(400).json({ detail: "invalid_request" });
      return;
    }

    const ip = clientIpFor(req, config);
    const retryAfter = limiter.hit(ip ?? req.socket.remoteAddress ?? "unknown");
    if (retryAfter !== null) {
      res.setHeader("Retry-After", String(retryAfter));
      res.status(429).json({ detail: "rate_limited" });
      return;
    }

    try {
      const result = await sso.login(body.username, body.password, ip);
      const raw = manager.create(result, ip);
      res.cookie(config.cookieName, raw, cookieOptions(config));
      res.setHeader("Cache-Control", "no-store");
      res.json({
        user: publicUser(result.user),
        allowed: (result.user.perms ?? []).includes(config.requiredPermission),
        required_permission: config.requiredPermission,
      });
    } catch (err) {
      if (err instanceof SsoCredentialsError) {
        res.status(401).json({ detail: "invalid_credentials" });
        return;
      }
      if (err instanceof SsoAccountInactive) {
        res.status(403).json({ detail: "account_inactive" });
        return;
      }
      if (err instanceof SsoRateLimited) {
        res.setHeader("Retry-After", String(err.retryAfterSeconds));
        res.status(429).json({ detail: "rate_limited" });
        return;
      }
      if (err instanceof SsoUnavailable) {
        res.setHeader("Retry-After", "5");
        res.status(503).json({ detail: "sso_unavailable" });
        return;
      }
      if (err instanceof SsoClientError) {
        log.error("auth: login failed — SSO rejected the ServiceClient credentials");
        res.status(502).json({ detail: "sso_client_rejected" });
        return;
      }
      if (err instanceof SsoProtocolError) {
        log.error(`auth: login protocol error (${String(err.message).slice(0, 160)})`);
        res.status(502).json({ detail: "sso_protocol_error" });
        return;
      }
      log.error(`auth: login failed (${String(err).slice(0, 200)})`);
      res.status(500).json({ detail: "login_failed" });
    }
  });

  router.post("/logout", async (req: Request, res: Response) => {
    const raw = readCookie(req.headers.cookie, config.cookieName);
    if (raw) {
      const row = manager.get(raw);
      if (row) {
        try {
          await sso.logout(row.refreshToken, clientIpFor(req, config));
        } catch (err) {
          // The local session is destroyed regardless; the SSO token expires
          // on its own. Only genuinely unexpected failures are logged.
          if (!(err instanceof SsoTokenInvalid) && !(err instanceof SsoAccountInactive)) {
            log.warn(`auth: SSO logout failed (${String(err).slice(0, 140)})`);
          }
        }
      }
      manager.destroy(raw);
    }
    res.clearCookie(config.cookieName, clearOptions(config));
    res.setHeader("Cache-Control", "no-store");
    res.status(204).end();
  });

  router.get("/me", requireSession, (req: Request, res: Response) => {
    const session = (req as AuthedRequest).auth;
    if (!session) {
      res.status(401).json({ detail: "not_authenticated" });
      return;
    }
    res.setHeader("Cache-Control", "no-store");
    res.json({
      user: {
        id: session.sub,
        username: session.username,
        email: session.email,
        perms: session.perms,
      },
      allowed: session.lastAllowed,
      required_permission: config.requiredPermission,
    });
  });

  return router;
}

interface PublicUser {
  id: string;
  username: string;
  email: string | null;
  perms: string[];
}

function publicUser(user: { id: number | string; username: string; email?: string | null; perms?: string[] }): PublicUser {
  return {
    id: String(user.id),
    username: user.username,
    email: user.email ?? null,
    perms: user.perms ?? [],
  };
}

function cookieOptions(config: AuthConfig): CookieOptions {
  return {
    httpOnly: true,
    sameSite: "strict",
    secure: config.cookieSecure,
    path: "/",
    maxAge: config.sessionTtlDays * 86_400_000,
  };
}

function clearOptions(config: AuthConfig): CookieOptions {
  return {
    httpOnly: true,
    sameSite: "strict",
    secure: config.cookieSecure,
    path: "/",
  };
}

/** Best-effort local login throttle; the SSO applies stricter per-IP/user limits. */
function createLoginLimiter(limit = 10, windowMs = 60_000) {
  const hits = new Map<string, { count: number; resetAt: number }>();
  return {
    hit(key: string, now = Date.now()): number | null {
      if (hits.size > 2048) {
        for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
      }
      const entry = hits.get(key);
      if (!entry || entry.resetAt <= now) {
        hits.set(key, { count: 1, resetAt: now + windowMs });
        return null;
      }
      entry.count += 1;
      if (entry.count > limit) return Math.ceil((entry.resetAt - now) / 1000);
      return null;
    },
  };
}
