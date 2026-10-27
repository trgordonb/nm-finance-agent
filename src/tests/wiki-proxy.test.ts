// Wiki proxy (src/wiki-proxy.ts): read-only allow-list, URL building, and the
// fetch helper. The allow-list is the Wiki tab's security posture — the write
// surface of the llmwiki service must stay unreachable from the UI.

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

const { buildWikiTarget, fetchWiki } = await import("../wiki-proxy.js");

test("wiki-proxy: read roots pass through with filtered query params", () => {
  assert.deepEqual(buildWikiTarget("domains", {}), { path: "/domains" });
  assert.deepEqual(buildWikiTarget("healthz", {}), { path: "/healthz" });
  assert.deepEqual(
    buildWikiTarget("concepts", { domain: "llm", prefix: "ai", evil: "x" }),
    { path: "/concepts?domain=llm&prefix=ai" },
    "only the known query keys survive",
  );
  assert.deepEqual(
    buildWikiTarget("search", { q: "paged attention", k: "8", domain: "llm" }),
    { path: "/search?domain=llm&q=paged+attention&k=8" },
  );
  assert.deepEqual(
    buildWikiTarget("search", { q: "paged attention", scope: "private" }),
    { path: "/search?q=paged+attention&scope=private" },
    "the wiki scope is a forwardable query key",
  );
});

test("wiki-proxy: page slugs are validated (traversal cannot reach other endpoints)", () => {
  assert.deepEqual(buildWikiTarget("page/the-50-50-spy-strategy", { domain: "llm" }), {
    path: "/page/the-50-50-spy-strategy?domain=llm",
  });
  for (const bad of ["page", "page/", "page/a/b", "page/../domains", "page/Bad Slug", "page/.hidden"]) {
    const target = buildWikiTarget(bad, {});
    assert.ok("error" in target, `expected rejection for ${JSON.stringify(bad)}`);
  }
});

test("wiki-proxy: write and admin paths are not forwardable", () => {
  for (const bad of ["", "ingest", "upload", "compile/abc", "lint", "domains/general", "worker"]) {
    const target = buildWikiTarget(bad, {});
    assert.ok("error" in target, `expected rejection for ${JSON.stringify(bad)}`);
  }
});

test("wiki-proxy: fetchWiki forwards status, content type and body", async () => {
  const server = http.createServer((req, res) => {
    if (req.url?.startsWith("/domains")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify([{ name: "general" }]));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}/`;
  try {
    const ok = await fetchWiki(base, "/domains");
    assert.equal(ok.status, 200);
    assert.equal(ok.contentType, "application/json");
    assert.match(ok.body, /general/);

    const missing = await fetchWiki(base, "/page/nope");
    assert.equal(missing.status, 404);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("wiki-proxy: fetchWiki sends the bearer for a remote service", async () => {
  const server = http.createServer((req, res) => {
    if (req.url === "/auth" && req.headers.authorization === "Bearer test-token") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ detail: "invalid or missing bearer token" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const authed = await fetchWiki(base, "/auth", { token: "test-token" });
    assert.equal(authed.status, 200);

    const anonymous = await fetchWiki(base, "/auth");
    assert.equal(anonymous.status, 401, "no token means no Authorization header");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("wiki-proxy: fetchWiki honors a custom timeout", async () => {
  const server = http.createServer((_req, res) => {
    setTimeout(() => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    }, 300);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    await assert.rejects(fetchWiki(base, "/slow", { timeoutMs: 50 }));
  } finally {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
