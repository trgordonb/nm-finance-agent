// Short-lived user assertions for the llmwiki service (P2,
// llm-wiki-svc/docs/user-scoped-wikis-plan.md §4).
//
// The agent is already the SSO BFF: req.auth holds the signed-in user. It mints
// a compact HS256 JWT per request/skill command; the wiki verifies it with the
// shared WIKI_ASSERTION_SECRET. No SSO token ever leaves the agent, and the
// token can only name a user's private scope (never the admin/common token).

import crypto from "node:crypto";

const ISSUER = "nm-finance-agent";
const AUDIENCE = "llmwiki";

export interface WikiAssertionUser {
  sub?: string;
  username: string;
}

/** Whether the agent can mint user assertions (the shared secret is set). */
export function wikiAssertionsEnabled(): boolean {
  return assertionSecret().length > 0;
}

function assertionSecret(): string {
  return (process.env.WIKI_ASSERTION_SECRET ?? "").trim();
}

function assertionTtlSeconds(): number {
  return Number(process.env.WIKI_ASSERTION_TTL_SECONDS ?? 600) || 600;
}

function b64url(value: Buffer | string): string {
  return Buffer.from(value).toString("base64url");
}

/**
 * Mint one assertion for a user. Expiry is short by design: a token leaked by a
 * shell command (the model can read its own env) is useless within minutes and
 * grants only that user's private scope.
 */
export function mintWikiAssertion(user: WikiAssertionUser): string {
  const sharedSecret = assertionSecret();
  if (!sharedSecret) {
    throw new Error("WIKI_ASSERTION_SECRET is not configured");
  }
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "HS256", typ: "JWT" };
  const payload = {
    iss: ISSUER,
    aud: AUDIENCE,
    sub: user.sub ?? "",
    username: user.username,
    iat: now,
    exp: now + Math.max(60, assertionTtlSeconds()),
    jti: crypto.randomUUID(),
  };
  const headerPart = b64url(JSON.stringify(header));
  const payloadPart = b64url(JSON.stringify(payload));
  const signature = crypto
    .createHmac("sha256", sharedSecret)
    .update(`${headerPart}.${payloadPart}`)
    .digest();
  return `${headerPart}.${payloadPart}.${b64url(signature)}`;
}
