// SSO client contract tests against a local fake server (no real network).
// Covers the request shapes the SSO expects (Basic auth, client_ip, require)
// and the error taxonomy the BFF relies on.

import { after, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";

import {
  SsoClient,
  SsoCredentialsError,
  SsoRateLimited,
  SsoTokenInvalid,
  SsoUnavailable,
  type IntrospectResponse,
} from "../auth/sso.js";
import type { SsoConfig } from "../auth/config.js";

let loginMode: "ok" | "bad-password" | "rate-limited" | "flaky" = "ok";
let loginAttempts = 0;
let lastLoginBody: Record<string, unknown> | null = null;
let lastLoginAuth: string | null = null;
let lastIntrospectBody: Record<string, unknown> | null = null;
let lastRefreshBody: Record<string, unknown> | null = null;

const server = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    const raw = Buffer.concat(chunks).toString("utf8");
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    const send = (status: number, payload?: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "Content-Type": "application/json", ...headers });
      res.end(payload === undefined ? "" : JSON.stringify(payload));
    };

    if (req.method === "GET" && req.url === "/healthz") {
      send(200, { status: "ok" });
      return;
    }

    if (req.method === "POST" && req.url === "/api/v1/auth/login") {
      loginAttempts += 1;
      lastLoginBody = body;
      lastLoginAuth = req.headers.authorization ?? null;
      if (loginMode === "bad-password") {
        send(401, { error: "invalid_credentials", detail: "bad" });
        return;
      }
      if (loginMode === "rate-limited") {
        send(429, { error: "rate_limited" }, { "Retry-After": "7" });
        return;
      }
      if (loginMode === "flaky" && loginAttempts === 1) {
        send(503, { error: "server_error" });
        return;
      }
      send(200, {
        access_token: "access-1",
        refresh_token: "refresh-1",
        token_type: "Bearer",
        expires_in: 900,
        user: { id: 42, username: "alice", email: "alice@example.com", perms: ["application.nmfinance"] },
      });
      return;
    }

    if (req.method === "POST" && req.url === "/api/v1/auth/refresh") {
      lastRefreshBody = body;
      if (body.refresh_token === "revoked") {
        send(401, { error: "token_invalid", detail: "revoked" });
        return;
      }
      send(200, {
        access_token: "access-2",
        refresh_token: "refresh-2",
        expires_in: 900,
        user: { id: 42, username: "alice", perms: ["application.nmfinance"] },
      });
      return;
    }

    if (req.method === "POST" && req.url === "/api/v1/auth/logout") {
      if (body.refresh_token === "revoked") {
        send(401, { error: "token_invalid" });
        return;
      }
      send(204);
      return;
    }

    if (req.method === "POST" && req.url === "/api/v1/auth/introspect") {
      lastIntrospectBody = body;
      const result: IntrospectResponse =
        body.token === "expired"
          ? { active: false }
          : {
              active: true,
              sub: "42",
              username: "alice",
              email: "alice@example.com",
              perms: ["application.nmfinance"],
              sid: "sid-1",
              allowed: true,
              ip_match: true,
            };
      send(200, result);
      return;
    }

    send(404, { error: "not_found" });
  });
});

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address() as AddressInfo;
const baseUrl = `http://127.0.0.1:${address.port}`;

after(() => {
  server.close();
});

function config(retries = 0): SsoConfig {
  return {
    baseUrl,
    clientId: "test-client",
    clientSecret: "test-secret",
    caPem: null,
    caFile: null,
    timeoutMs: 2000,
    retries,
    cacheTtlSeconds: 30,
    trustedProxies: "127.0.0.1",
    clientIpHeader: "",
  };
}

test("healthz succeeds against a healthy server", async () => {
  await new SsoClient(config()).healthz();
});

test("login sends native mode, client_ip and Basic auth", async () => {
  loginMode = "ok";
  loginAttempts = 0;
  const result = await new SsoClient(config()).login("alice", "correct", "203.0.113.7");
  assert.equal(result.user.username, "alice");
  assert.equal(lastLoginBody?.client, "native");
  assert.equal(lastLoginBody?.client_ip, "203.0.113.7");
  assert.equal(lastLoginAuth, `Basic ${Buffer.from("test-client:test-secret").toString("base64")}`);
});

test("wrong credentials map to SsoCredentialsError", async () => {
  loginMode = "bad-password";
  await assert.rejects(
    () => new SsoClient(config()).login("alice", "wrong", "203.0.113.7"),
    SsoCredentialsError,
  );
});

test("429 maps to SsoRateLimited with Retry-After", async () => {
  loginMode = "rate-limited";
  await assert.rejects(
    () => new SsoClient(config()).login("alice", "correct", "203.0.113.7"),
    (err: unknown) => err instanceof SsoRateLimited && err.retryAfterSeconds === 7,
  );
});

test("5xx retries once, then succeeds", async () => {
  loginMode = "flaky";
  loginAttempts = 0;
  const result = await new SsoClient(config(1)).login("alice", "correct", "203.0.113.7");
  assert.equal(result.access_token, "access-1");
  assert.equal(loginAttempts, 2);
});

test("5xx without retries maps to SsoUnavailable", async () => {
  loginMode = "flaky";
  loginAttempts = 0;
  await assert.rejects(
    () => new SsoClient(config(0)).login("alice", "correct", "203.0.113.7"),
    SsoUnavailable,
  );
});

test("refresh sends the rotating token and client_ip", async () => {
  const result = await new SsoClient(config()).refresh("refresh-1", "203.0.113.7");
  assert.equal(result.refresh_token, "refresh-2");
  assert.equal(lastRefreshBody?.refresh_token, "refresh-1");
  assert.equal(lastRefreshBody?.client_ip, "203.0.113.7");
});

test("revoked refresh token maps to SsoTokenInvalid", async () => {
  await assert.rejects(
    () => new SsoClient(config()).refresh("revoked", "203.0.113.7"),
    SsoTokenInvalid,
  );
});

test("introspect sends token, ip and require", async () => {
  const result = await new SsoClient(config()).introspect("access-1", "203.0.113.7", [
    "application.nmfinance",
  ]);
  assert.equal(result.active, true);
  assert.equal(result.allowed, true);
  assert.equal(lastIntrospectBody?.token, "access-1");
  assert.equal(lastIntrospectBody?.ip, "203.0.113.7");
  assert.deepEqual(lastIntrospectBody?.require, ["application.nmfinance"]);
});

test("introspect returns active:false without throwing", async () => {
  const result = await new SsoClient(config()).introspect("expired", null);
  assert.equal(result.active, false);
  assert.equal(lastIntrospectBody?.ip, undefined);
});

test("logout treats an already-invalid token as success", async () => {
  await new SsoClient(config()).logout("revoked", "203.0.113.7");
});
