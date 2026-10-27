// wiki_search tool: private-first retrieval through the llmwiki service.
// The tests stub global fetch; no service or network is involved.

import { test } from "node:test";
import assert from "node:assert/strict";

process.env.WORKSPACE_USER = "alice";
process.env.WIKI_ASSERTION_SECRET =
  process.env.WIKI_ASSERTION_SECRET || "test-assertion-secret";

const { wiki_search } = await import("../tools/wiki_search.js");

type FetchCall = { url: string; init?: RequestInit };

function stubFetch(
  handler: (url: string, init?: RequestInit) => Promise<Response> | Response,
): { calls: FetchCall[]; restore: () => void } {
  const original = globalThis.fetch;
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    return handler(url, init);
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function authPayload(init?: RequestInit): Record<string, unknown> {
  const headers = (init?.headers ?? {}) as Record<string, string>;
  const value = headers.authorization ?? "";
  assert.match(value, /^Bearer .+\..+\..+$/);
  const payload = value.slice("Bearer ".length).split(".")[1];
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<
    string,
    unknown
  >;
}

test("wiki_search defaults to private, mints the user assertion and formats hits", async () => {
  const adminToken = "admin-token-must-not-leak";
  process.env.WIKI_API_TOKEN = adminToken;
  const hits = [
    {
      id: "orpo",
      score: 0.823,
      origin: "wiki",
      text: "ORPO here means On-Policy Reflective Policy Optimization.",
      slug: "orpo",
      source_id: null,
      metadata: { title: "ORPO and RPO" },
      domain: "algotrade",
    },
    {
      id: "source-chunk:0",
      score: 0.612,
      origin: "chunk",
      text: "x".repeat(700),
      slug: null,
      source_id: "source-chunk",
      metadata: {
        title: "The article that mentioned ORPO",
        url: "https://example.com/article",
      },
      domain: "general",
    },
  ];
  const stub = stubFetch(() => json(hits));
  try {
    const out = await wiki_search.execute({ query: "What is ORPO?" });
    assert.equal(stub.calls.length, 1);
    const url = new URL(stub.calls[0].url);
    assert.equal(url.pathname, "/search");
    assert.equal(url.searchParams.get("q"), "What is ORPO?");
    assert.equal(url.searchParams.get("scope"), "private");
    assert.equal(url.searchParams.get("k"), "8");
    assert.equal(url.searchParams.get("domain"), null);

    const payload = authPayload(stub.calls[0].init);
    assert.equal(payload.username, "alice");
    const auth = (stub.calls[0].init?.headers as Record<string, string>).authorization;
    assert.equal(auth.includes(adminToken), false, "the admin token is never sent");

    assert.match(out, /Wiki search \(private, 2 hits\):/);
    assert.match(out, /\[wiki\] \| score 0\.82 \| page: algotrade\/orpo \| title: ORPO and RPO/);
    assert.match(out, /ORPO here means On-Policy Reflective Policy Optimization/);
    assert.match(out, /\[chunk\] \| score 0\.61 \| page: general\/source-chunk/);
    assert.match(out, /source: source-chunk · https:\/\/example\.com\/article/);
    assert.equal(out.includes(adminToken), false);
    const excerptLine = out
      .split("\n")
      .find((line) => line.includes("excerpt: x"));
    assert.ok(excerptLine);
    assert.ok(excerptLine.length <= 520, "excerpts are truncated to ~500 chars");
  } finally {
    stub.restore();
  }
});

test("wiki_search forwards explicit common scope and clamps k", async () => {
  const stub = stubFetch(() => json([]));
  try {
    const out = await wiki_search.execute({
      query: "shared topic",
      scope: "common",
      domain: "finance",
      k: 99,
    });
    const url = new URL(stub.calls[0].url);
    assert.equal(url.searchParams.get("scope"), "common");
    assert.equal(url.searchParams.get("domain"), "finance");
    assert.equal(url.searchParams.get("k"), "10");
    assert.match(out, /No relevant pages in the shared wiki/);
    assert.match(out, /scope=common/);
  } finally {
    stub.restore();
  }
});

test("wiki_search rejects invalid scope instead of silently choosing common", async () => {
  const stub = stubFetch(() => json([]));
  try {
    const out = await wiki_search.execute({ query: "x", scope: "shared" });
    assert.match(out, /^Rejected: scope must be "private" or "common"\./);
    assert.equal(stub.calls.length, 0);
  } finally {
    stub.restore();
  }
});

test("wiki_search clamps k below the minimum and defaults invalid k", async () => {
  const stub = stubFetch(() => json([]));
  try {
    await wiki_search.execute({ query: "x", k: 0 });
    await wiki_search.execute({ query: "x", k: "not-a-number" });
    assert.equal(new URL(stub.calls[0].url).searchParams.get("k"), "1");
    assert.equal(new URL(stub.calls[1].url).searchParams.get("k"), "8");
  } finally {
    stub.restore();
  }
});

test("wiki_search reports a missing assertion secret without fetching", async () => {
  const previous = process.env.WIKI_ASSERTION_SECRET;
  process.env.WIKI_ASSERTION_SECRET = "";
  const stub = stubFetch(() => json([]));
  try {
    const out = await wiki_search.execute({ query: "x" });
    assert.equal(
      out,
      "Rejected: wiki search is not configured (WIKI_ASSERTION_SECRET missing).",
    );
    assert.equal(stub.calls.length, 0);
  } finally {
    stub.restore();
    process.env.WIKI_ASSERTION_SECRET = previous;
  }
});

test("wiki_search maps upstream auth/rate-limit/5xx failures to recoverable results", async () => {
  for (const [status, expected] of [
    [401, /rejected the user assertion/],
    [429, /rate-limited/],
    [500, /unavailable \(HTTP 500\)/],
  ] as const) {
    const stub = stubFetch(() => json({ detail: "upstream failure" }, status));
    try {
      const out = await wiki_search.execute({ query: "x" });
      assert.match(out, /^Rejected:/);
      assert.match(out, expected);
    } finally {
      stub.restore();
    }
  }
});

test("wiki_search maps a timeout to the cold-service message", async () => {
  const stub = stubFetch(() => {
    throw new DOMException("The operation timed out.", "TimeoutError");
  });
  try {
    const out = await wiki_search.execute({ query: "x" });
    assert.equal(out, "Rejected: llmwiki is unreachable/cold; retry once.");
  } finally {
    stub.restore();
  }
});
