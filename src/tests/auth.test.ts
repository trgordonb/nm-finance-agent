// Auth core tests: server-side session store, refresh/introspection lifecycle,
// and the /api/auth + gate wiring against a fake SSO (no real network).

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import express from "express";

import type { AuthConfig } from "../auth/config.js";
import type { AuthSession } from "../auth/store.js";
import type { IntrospectResponse, LoginResponse } from "../auth/sso.js";

// auth/config.ts reads process.env at import; keep it out of whatever the
// developer's shell exported (the test config is built explicitly below).
process.env.AUTH_MODE = "off";
const { loadAuthConfig } = await import("../auth/config.js");

import { AuthStore } from "../auth/store.js";
import { SessionManager, SessionExpiredError } from "../auth/session.js";
import { createAuthRouter } from "../auth/routes.js";
import {
  createOriginGuard,
  createRequireAuth,
  type AuthedRequest,
} from "../auth/middleware.js";
import {
  SsoClient,
  SsoCredentialsError,
  SsoTokenInvalid,
  SsoUnavailable,
} from "../auth/sso.js";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nmfa-auth-"));
let dbCounter = 0;

function makeConfig(overrides: Partial<AuthConfig> = {}): AuthConfig {
  const base = loadAuthConfig({
    AUTH_MODE: "sso",
    SSO_BASE_URL: "http://127.0.0.1:9",
    SSO_CLIENT_ID: "test-client",
    SSO_CLIENT_SECRET: "test-secret",
    SSO_ALLOW_HTTP: "1",
    AUTH_COOKIE_SECURE: "0",
    AUTH_DB_PATH: path.join(tempDir, `auth-${++dbCounter}.db`),
    AUTH_ALLOWED_ORIGINS: "",
    SSO_CACHE_TTL_SECONDS: "0",
    SSO_TRUSTED_PROXIES: "127.0.0.1,::1",
    SSO_CLIENT_IP_HEADER: "",
  });
  return { ...base, ...overrides };
}

class FakeSso {
  loginCalls = 0;
  refreshCalls = 0;
  logoutCalls = 0;
  introspectCalls = 0;
  active = true;
  allowed = true;
  perms = ["application.nmfinance"];
  loginExpiresIn = 900;
  loginError: Error | null = null;
  refreshError: Error | null = null;
  introspectError: Error | null = null;
  inactiveOnce = false;
  private inactiveConsumed = false;

  async login(username: string, _password: string, _ip: string | null): Promise<LoginResponse> {
    this.loginCalls += 1;
    if (this.loginError) throw this.loginError;
    return {
      access_token: "access-1",
      refresh_token: "refresh-1",
      expires_in: this.loginExpiresIn,
      user: { id: 42, username, email: "alice@example.com", perms: this.perms },
    };
  }

  async refresh(_token: string, _ip: string | null): Promise<LoginResponse> {
    this.refreshCalls += 1;
    if (this.refreshError) throw this.refreshError;
    return {
      access_token: `access-${this.refreshCalls + 1}`,
      refresh_token: `refresh-${this.refreshCalls + 1}`,
      expires_in: 900,
      user: { id: 42, username: "alice", perms: this.perms },
    };
  }

  async logout(): Promise<void> {
    this.logoutCalls += 1;
  }

  async introspect(
    _token: string,
    _ip: string | null,
    _require: string[],
  ): Promise<IntrospectResponse> {
    this.introspectCalls += 1;
    if (this.introspectError) throw this.introspectError;
    if (this.inactiveOnce && !this.inactiveConsumed) {
      this.inactiveConsumed = true;
      return { active: false };
    }
    if (!this.active) return { active: false };
    return {
      active: true,
      sub: "42",
      username: "alice",
      email: "alice@example.com",
      perms: this.perms,
      sid: "sid-1",
      allowed: this.allowed,
      ip_match: true,
    };
  }

  async healthz(): Promise<void> {}
}

function setup(overrides: Partial<AuthConfig> = {}, clock?: () => number) {
  const config = makeConfig(overrides);
  const store = new AuthStore(config.dbPath);
  const fake = new FakeSso();
  const manager = new SessionManager({
    config,
    store,
    sso: fake as unknown as SsoClient,
    ...(clock ? { now: clock } : {}),
  });
  return { config, store, fake, manager };
}

function sampleSession(idHash = "a".repeat(64)): AuthSession {
  return {
    idHash,
    sub: "42",
    username: "alice",
    email: "alice@example.com",
    perms: ["application.nmfinance"],
    accessToken: "access-1",
    refreshToken: "refresh-1",
    accessExpiresAt: 1_000_000_000_000 + 900_000,
    ip: "127.0.0.1",
    sid: "sid-1",
    createdAt: 1_000_000_000_000,
    lastSeenAt: 1_000_000_000_000,
    lastIntrospectAt: 0,
    lastAllowed: true,
  };
}

// --- store ------------------------------------------------------------------

test("auth store round-trips a session and purges expired rows", () => {
  const store = new AuthStore(path.join(tempDir, "store.db"));
  const a = sampleSession();

  store.put(a);
  assert.deepEqual(store.get(a.idHash), a);

  const b = sampleSession("b".repeat(64));
  b.createdAt = 100;
  store.put(b);

  assert.equal(store.deleteExpired(500), 1);
  assert.equal(store.get(b.idHash), null);
  assert.ok(store.get(a.idHash));

  store.delete(a.idHash);
  assert.equal(store.get(a.idHash), null);
  store.close();
});

// --- session lifecycle ------------------------------------------------------

test("login creates a resolvable session and introspection grants access", async (t) => {
  const { store, fake, manager } = setup();
  t.after(() => store.close());

  const raw = manager.create(await fake.login("alice", "x", null), "127.0.0.1");
  assert.ok(manager.get(raw));

  const resolved = await manager.resolve(raw, "127.0.0.1");
  assert.equal(resolved.session.username, "alice");
  assert.equal(resolved.allowed, true);
  assert.equal(fake.introspectCalls, 1);
});

test("a logged-in user without the app permission is allowed=false, not logged out", async (t) => {
  const { store, fake, manager } = setup();
  t.after(() => store.close());

  const raw = manager.create(await fake.login("alice", "x", null), "127.0.0.1");
  fake.allowed = false;

  const resolved = await manager.resolve(raw, "127.0.0.1");
  assert.equal(resolved.allowed, false);
  assert.ok(manager.get(raw));
});

test("near-expiry access tokens refresh before introspection", async (t) => {
  const { store, fake, manager } = setup();
  t.after(() => store.close());

  fake.loginExpiresIn = 30;
  const raw = manager.create(await fake.login("alice", "x", null), "127.0.0.1");

  const resolved = await manager.resolve(raw, "127.0.0.1");
  assert.equal(fake.refreshCalls, 1);
  assert.equal(resolved.session.accessToken, "access-2");
});

test("concurrent resolves share one refresh (SSO reuse detection safe)", async (t) => {
  const { store, fake, manager } = setup();
  t.after(() => store.close());

  fake.loginExpiresIn = 30;
  const raw = manager.create(await fake.login("alice", "x", null), "127.0.0.1");

  const [a, b] = await Promise.all([
    manager.resolve(raw, "127.0.0.1"),
    manager.resolve(raw, "127.0.0.1"),
  ]);
  assert.equal(fake.refreshCalls, 1);
  assert.equal(a.session.accessToken, b.session.accessToken);
});

test("inactive introspection recovers with a refresh, then re-introspects", async (t) => {
  const { store, fake, manager } = setup();
  t.after(() => store.close());

  const raw = manager.create(await fake.login("alice", "x", null), "127.0.0.1");
  fake.inactiveOnce = true;

  const resolved = await manager.resolve(raw, "127.0.0.1");
  assert.equal(fake.refreshCalls, 1);
  assert.equal(fake.introspectCalls, 2);
  assert.equal(resolved.allowed, true);
});

test("revoked refresh token destroys the local session", async (t) => {
  const { store, fake, manager } = setup();
  t.after(() => store.close());

  const raw = manager.create(await fake.login("alice", "x", null), "127.0.0.1");
  fake.active = false;
  fake.refreshError = new SsoTokenInvalid("token_invalid");

  await assert.rejects(() => manager.resolve(raw, "127.0.0.1"), SessionExpiredError);
  assert.equal(manager.get(raw), null);
});

test("SSO outage fails closed but keeps the session", async (t) => {
  const { store, fake, manager } = setup();
  t.after(() => store.close());

  const raw = manager.create(await fake.login("alice", "x", null), "127.0.0.1");
  fake.introspectError = new SsoUnavailable("down");

  await assert.rejects(() => manager.resolve(raw, "127.0.0.1"), SsoUnavailable);
  assert.ok(manager.get(raw));
});

test("sessions expire after AUTH_SESSION_TTL_DAYS (absolute, not sliding)", async (t) => {
  let now = 1_000_000_000_000;
  const { store, fake, manager } = setup(
    { sessionTtlDays: 1 },
    () => now,
  );
  t.after(() => store.close());

  const raw = manager.create(await fake.login("alice", "x", null), "127.0.0.1");
  await manager.resolve(raw, "127.0.0.1");

  now += 2 * 86_400_000;
  await assert.rejects(() => manager.resolve(raw, "127.0.0.1"), SessionExpiredError);
  assert.equal(manager.get(raw), null);
});

// --- routes + gate ----------------------------------------------------------

test("login, me, gate, permission denial and logout", async (t) => {
  const { config, store, fake, manager } = setup();
  const app = express();
  app.use(express.json());
  app.use("/api", createOriginGuard(config));
  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok" });
  });
  app.use(
    "/api/auth",
    createAuthRouter({ config, manager, sso: fake as unknown as SsoClient }),
  );
  app.use("/api", createRequireAuth(config, manager, { permission: true }));
  app.get("/api/protected", (req, res) => {
    res.json({ ok: true, user: (req as AuthedRequest).auth?.username });
  });

  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  const url = (p: string) => `http://127.0.0.1:${port}${p}`;
  t.after(() => {
    server.closeAllConnections();
    server.close();
    store.close();
  });

  // health stays public
  assert.equal((await fetch(url("/api/health"))).status, 200);
  // no cookie → 401
  assert.equal((await fetch(url("/api/protected"))).status, 401);

  const login = await fetch(url("/api/auth/login"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "alice", password: "correct" }),
  });
  assert.equal(login.status, 200);
  const setCookie = login.headers.get("set-cookie");
  assert.ok(setCookie);
  assert.ok(setCookie.startsWith(`${config.cookieName}=`));
  const cookie = setCookie.split(";")[0];
  const loginBody = (await login.json()) as {
    user: { username: string };
    allowed: boolean;
    required_permission: string;
  };
  assert.equal(loginBody.user.username, "alice");
  assert.equal(loginBody.allowed, true);
  assert.equal(loginBody.required_permission, "application.nmfinance");

  const me = await fetch(url("/api/auth/me"), { headers: { cookie } });
  assert.equal(me.status, 200);
  const meBody = (await me.json()) as { allowed: boolean };
  assert.equal(meBody.allowed, true);

  const protectedRes = await fetch(url("/api/protected"), { headers: { cookie } });
  assert.equal(protectedRes.status, 200);
  assert.equal(((await protectedRes.json()) as { user: string }).user, "alice");

  fake.allowed = false;
  const denied = await fetch(url("/api/protected"), { headers: { cookie } });
  assert.equal(denied.status, 403);
  assert.equal(((await denied.json()) as { detail: string }).detail, "permission_denied");
  // /me still works so the UI can explain the missing grant
  assert.equal((await fetch(url("/api/auth/me"), { headers: { cookie } })).status, 200);

  const logout = await fetch(url("/api/auth/logout"), { method: "POST", headers: { cookie } });
  assert.equal(logout.status, 204);
  assert.equal(fake.logoutCalls, 1);
  assert.equal((await fetch(url("/api/auth/me"), { headers: { cookie } })).status, 401);
});

test("login errors map to the documented statuses; origin guard rejects cross-site POSTs", async (t) => {
  const { config, store, fake, manager } = setup();
  const app = express();
  app.use(express.json());
  app.use("/api", createOriginGuard(config));
  app.use(
    "/api/auth",
    createAuthRouter({ config, manager, sso: fake as unknown as SsoClient }),
  );
  app.use("/api", createRequireAuth(config, manager, { permission: true }));

  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  const url = (p: string) => `http://127.0.0.1:${port}${p}`;
  t.after(() => {
    server.closeAllConnections();
    server.close();
    store.close();
  });

  const post = (body: unknown, headers: Record<string, string> = {}) =>
    fetch(url("/api/auth/login"), {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });

  fake.loginError = new SsoCredentialsError("invalid_credentials");
  assert.equal((await post({ username: "alice", password: "wrong" })).status, 401);

  fake.loginError = new SsoUnavailable("down", false);
  const unavailable = await post({ username: "alice", password: "correct" });
  assert.equal(unavailable.status, 503);
  assert.equal(unavailable.headers.get("retry-after"), "5");

  fake.loginError = null;
  const crossSite = await post(
    { username: "alice", password: "correct" },
    { origin: "https://evil.example" },
  );
  assert.equal(crossSite.status, 403);

  const sameSite = await post(
    { username: "alice", password: "correct" },
    { origin: `http://127.0.0.1:${port}` },
  );
  assert.equal(sameSite.status, 200);
});
