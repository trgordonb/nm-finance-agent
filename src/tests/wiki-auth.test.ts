// P2: the agent mints short-lived HS256 assertions for the llmwiki service
// (llm-wiki-svc/docs/user-scoped-wikis-plan.md §4). The Python verifier is
// tested on the service side; this checks the wire shape and signature here.

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

process.env.WIKI_ASSERTION_SECRET = "test-assertion-secret";
process.env.WIKI_ASSERTION_TTL_SECONDS = "600";

const { mintWikiAssertion, wikiAssertionsEnabled } = await import("../wiki-auth.js");

function decode(part: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;
}

test("wiki-auth: mints a signed HS256 assertion with the user claims", () => {
  assert.equal(wikiAssertionsEnabled(), true);
  const token = mintWikiAssertion({ sub: "42", username: "alice" });
  const [headerPart, payloadPart, signaturePart] = token.split(".");
  assert.ok(headerPart && payloadPart && signaturePart);

  assert.deepEqual(decode(headerPart), { alg: "HS256", typ: "JWT" });
  const payload = decode(payloadPart);
  assert.equal(payload.iss, "nm-finance-agent");
  assert.equal(payload.aud, "llmwiki");
  assert.equal(payload.sub, "42");
  assert.equal(payload.username, "alice");
  assert.equal(Number(payload.exp) - Number(payload.iat), 600);

  const expected = crypto
    .createHmac("sha256", "test-assertion-secret")
    .update(`${headerPart}.${payloadPart}`)
    .digest();
  assert.equal(
    Buffer.from(signaturePart, "base64url").toString("hex"),
    expected.toString("hex"),
  );
});

test("wiki-auth: a tampered payload no longer matches the signature", () => {
  const token = mintWikiAssertion({ username: "alice" });
  const [headerPart, payloadPart, signaturePart] = token.split(".");
  const payload = decode(payloadPart);
  payload.username = "bob";
  const forged = Buffer.from(JSON.stringify(payload)).toString("base64url");

  const expected = crypto
    .createHmac("sha256", "test-assertion-secret")
    .update(`${headerPart}.${forged}`)
    .digest();
  assert.notEqual(
    Buffer.from(signaturePart, "base64url").toString("hex"),
    expected.toString("hex"),
  );
});

test("wiki-auth: minting is disabled without the shared secret", () => {
  const previous = process.env.WIKI_ASSERTION_SECRET;
  process.env.WIKI_ASSERTION_SECRET = "";
  try {
    assert.equal(wikiAssertionsEnabled(), false);
    assert.throws(() => mintWikiAssertion({ username: "alice" }), /WIKI_ASSERTION_SECRET/);
  } finally {
    process.env.WIKI_ASSERTION_SECRET = previous;
  }
});
