// Session lifecycle: create on login, resolve on every request (refresh near
// expiry, then introspect at most once per SSO_CACHE_TTL), destroy on logout.
//
// Refresh is serialised per session. The SSO rotates the refresh token and
// treats reuse of an old one (>10 s) as token theft, revoking the whole SSO
// session — a second concurrent refresh would log the user out everywhere.

import { createHash, randomBytes } from "node:crypto";

import type { AuthConfig } from "./config.js";
import type { AuthSession, AuthStore } from "./store.js";
import {
  SsoAccountInactive,
  SsoClient,
  SsoTokenInvalid,
  type IntrospectResponse,
  type LoginResponse,
} from "./sso.js";

export class SessionExpiredError extends Error {
  constructor(readonly reason: string) {
    super(`session expired: ${reason}`);
    this.name = "SessionExpiredError";
  }
}

export interface ResolvedSession {
  session: AuthSession;
  /** result of the last permission-bearing introspection */
  allowed: boolean;
}

export interface SessionManagerDeps {
  config: AuthConfig;
  store: AuthStore;
  sso: SsoClient;
  /** injectable clock for tests */
  now?: () => number;
}

export class SessionManager {
  private readonly now: () => number;
  private readonly refreshLocks = new Map<string, Promise<AuthSession>>();

  constructor(private readonly deps: SessionManagerDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  private hash(raw: string): string {
    return createHash("sha256").update(raw).digest("hex");
  }

  private ttlMs(): number {
    return this.deps.config.sessionTtlDays * 86_400_000;
  }

  /** Persist a fresh SSO login and return the raw cookie value. */
  create(login: LoginResponse, ip: string | null): string {
    const raw = randomBytes(32).toString("base64url");
    const now = this.now();
    const perms = login.user.perms ?? [];
    const session: AuthSession = {
      idHash: this.hash(raw),
      sub: String(login.user.id),
      username: login.user.username,
      email: login.user.email ?? null,
      perms,
      accessToken: login.access_token,
      refreshToken: login.refresh_token,
      accessExpiresAt: now + (Number(login.expires_in) || 900) * 1000,
      ip,
      sid: null,
      createdAt: now,
      lastSeenAt: now,
      lastIntrospectAt: 0,
      lastAllowed: perms.includes(this.deps.config.requiredPermission),
    };
    this.deps.store.put(session);
    return raw;
  }

  get(raw: string): AuthSession | null {
    return this.deps.store.get(this.hash(raw));
  }

  destroy(raw: string): void {
    this.deps.store.delete(this.hash(raw));
  }

  /**
   * Resolve a cookie to a live session. Throws SessionExpiredError when the
   * session is gone/revoked; SsoUnavailable propagates (fail closed → 503).
   */
  async resolve(raw: string, ip: string | null): Promise<ResolvedSession> {
    const idHash = this.hash(raw);
    let row = this.deps.store.get(idHash);
    if (!row) throw new SessionExpiredError("unknown");

    const now = this.now();
    if (now - row.createdAt > this.ttlMs()) {
      this.deps.store.delete(idHash);
      throw new SessionExpiredError("expired");
    }

    // Refresh shortly before the 15-minute access token expires.
    if (row.accessExpiresAt - now < 60_000) {
      row = await this.refresh(row, ip);
    }

    const cacheMs = this.deps.config.sso.cacheTtlSeconds * 1000;
    const stale = cacheMs === 0 || row.lastIntrospectAt === 0 || now - row.lastIntrospectAt >= cacheMs;
    if (stale) {
      row = await this.introspectWithFallback(row, ip);
    }

    return { session: row, allowed: row.lastAllowed };
  }

  /**
   * Introspection is revocation-aware. If it says inactive, try one refresh:
   * an expired access token recovers, while a revoked session fails there and
   * is deleted. This also absorbs small clock skew.
   */
  private async introspectWithFallback(row: AuthSession, ip: string | null): Promise<AuthSession> {
    const require = [this.deps.config.requiredPermission];
    let result = await this.deps.sso.introspect(row.accessToken, ip, require);
    if (result.active) return this.applyIntrospection(row, result);

    const refreshed = await this.refresh(row, ip);
    result = await this.deps.sso.introspect(refreshed.accessToken, ip, require);
    if (!result.active) {
      this.deps.store.delete(row.idHash);
      throw new SessionExpiredError(result.reason ?? "inactive");
    }
    return this.applyIntrospection(refreshed, result);
  }

  private applyIntrospection(row: AuthSession, result: IntrospectResponse): AuthSession {
    const now = this.now();
    const perms = result.perms ?? row.perms;
    const allowed =
      typeof result.allowed === "boolean"
        ? result.allowed
        : perms.includes(this.deps.config.requiredPermission);

    const updated: AuthSession = {
      ...row,
      username: result.username ?? row.username,
      email: result.email ?? row.email,
      perms,
      sid: result.sid ?? row.sid,
      lastSeenAt: now,
      lastIntrospectAt: now,
      lastAllowed: allowed,
    };
    this.deps.store.put(updated);
    return updated;
  }

  private async refresh(row: AuthSession, ip: string | null): Promise<AuthSession> {
    const key = row.idHash;
    const inFlight = this.refreshLocks.get(key);
    if (inFlight) return inFlight;

    const task = (async () => {
      // Another request may have refreshed between our read and the lock.
      const current = this.deps.store.get(key) ?? row;
      if (
        current.accessToken !== row.accessToken &&
        current.accessExpiresAt - this.now() > 60_000
      ) {
        return current;
      }

      try {
        const next = await this.deps.sso.refresh(current.refreshToken, ip);
        const now = this.now();
        const perms = next.user?.perms ?? current.perms;
        const updated: AuthSession = {
          ...current,
          accessToken: next.access_token,
          refreshToken: next.refresh_token,
          accessExpiresAt: now + (Number(next.expires_in) || 900) * 1000,
          username: next.user?.username ?? current.username,
          email: next.user?.email ?? current.email,
          perms,
          // Fresh credentials must be re-checked for revocation/permissions.
          lastIntrospectAt: 0,
          lastAllowed: perms.includes(this.deps.config.requiredPermission),
        };
        this.deps.store.put(updated);
        return updated;
      } catch (err) {
        if (err instanceof SsoTokenInvalid || err instanceof SsoAccountInactive) {
          this.deps.store.delete(key);
          throw new SessionExpiredError(
            err instanceof SsoAccountInactive ? "account_inactive" : "token_invalid",
          );
        }
        throw err;
      }
    })();

    this.refreshLocks.set(key, task);
    try {
      return await task;
    } finally {
      this.refreshLocks.delete(key);
    }
  }
}
