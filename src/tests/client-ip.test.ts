// Contract tests for client-IP derivation. The SSO binds a token to the IP the
// BFF reports, so these cases are security-relevant: a spoofed header from an
// untrusted peer must never change the result.

import { test } from "node:test";
import assert from "node:assert/strict";

import { getClientIp, normalizeIp, parseTrusted } from "../auth/client-ip.js";

const loopback = parseTrusted("127.0.0.1,::1");
const lan = parseTrusted("127.0.0.1,10.0.0.0/8");

test("normalizeIp canonicalises addresses and rejects junk", () => {
  assert.equal(normalizeIp("203.0.113.7"), "203.0.113.7");
  assert.equal(normalizeIp("203.0.113.7:443"), "203.0.113.7");
  assert.equal(normalizeIp(" 203.0.113.7 "), "203.0.113.7");
  assert.equal(normalizeIp("::ffff:203.0.113.7"), "203.0.113.7");
  assert.equal(normalizeIp("[2001:db8::1]:443"), "2001:db8::1");
  assert.equal(normalizeIp("2001:0db8:0:0::1"), "2001:db8::1");
  assert.equal(normalizeIp("fe80::1%eth0"), "fe80::1");
  assert.equal(normalizeIp("::1"), "127.0.0.1");
  assert.equal(normalizeIp("::ffff:127.0.0.1"), "127.0.0.1");
  assert.equal(normalizeIp("not-an-ip"), null);
  assert.equal(normalizeIp(""), null);
  assert.equal(normalizeIp(undefined), null);
  assert.equal(normalizeIp(null), null);
});

test("untrusted peers ignore every forwarding header", () => {
  assert.equal(
    getClientIp("198.51.100.9", { "x-forwarded-for": "1.2.3.4" }, loopback),
    "198.51.100.9",
  );
  assert.equal(
    getClientIp("198.51.100.9", { "cf-connecting-ip": "1.2.3.4" }, loopback, "cf-connecting-ip"),
    "198.51.100.9",
  );
});

test("trusted peers use X-Forwarded-For right-to-left", () => {
  assert.equal(
    getClientIp("127.0.0.1", { "x-forwarded-for": "203.0.113.7" }, loopback),
    "203.0.113.7",
  );
  assert.equal(
    getClientIp("127.0.0.1", { "x-forwarded-for": "203.0.113.7, 127.0.0.1" }, loopback),
    "203.0.113.7",
  );
  // rightmost untrusted hop wins (the nearest proxy's client)
  assert.equal(
    getClientIp("127.0.0.1", { "x-forwarded-for": "1.2.3.4, 198.51.100.9" }, loopback),
    "198.51.100.9",
  );
});

test("all-trusted chains return the leftmost address", () => {
  assert.equal(
    getClientIp("127.0.0.1", { "x-forwarded-for": "10.0.0.5, 10.0.0.6" }, lan),
    "10.0.0.5",
  );
});

test("an invalid XFF entry stops at the last good address", () => {
  assert.equal(
    getClientIp("127.0.0.1", { "x-forwarded-for": "203.0.113.7, garbage" }, loopback),
    "127.0.0.1",
  );
  assert.equal(
    getClientIp("127.0.0.1", { "x-forwarded-for": "garbage, 203.0.113.7" }, loopback),
    "203.0.113.7",
  );
});

test("cf-connecting-ip is used only from a trusted peer, then falls back to XFF", () => {
  assert.equal(
    getClientIp(
      "127.0.0.1",
      { "cf-connecting-ip": "203.0.113.9", "x-forwarded-for": "127.0.0.1" },
      loopback,
      "cf-connecting-ip",
    ),
    "203.0.113.9",
  );
  // case-insensitive header lookup
  assert.equal(
    getClientIp("127.0.0.1", { "CF-Connecting-IP": "203.0.113.9" }, loopback, "cf-connecting-ip"),
    "203.0.113.9",
  );
  // invalid custom header → fall back to XFF
  assert.equal(
    getClientIp(
      "127.0.0.1",
      { "cf-connecting-ip": "garbage", "x-forwarded-for": "203.0.113.7" },
      loopback,
      "cf-connecting-ip",
    ),
    "203.0.113.7",
  );
  // absent custom header → XFF
  assert.equal(
    getClientIp("127.0.0.1", { "x-forwarded-for": "203.0.113.7" }, loopback, "cf-connecting-ip"),
    "203.0.113.7",
  );
});

test("loopback IPv6 and IPv4 resolve identically", () => {
  assert.equal(getClientIp("::1", {}, loopback), "127.0.0.1");
  assert.equal(
    getClientIp("::1", { "x-forwarded-for": "203.0.113.7" }, loopback),
    "203.0.113.7",
  );
});

test("missing peer yields null", () => {
  assert.equal(getClientIp(undefined, {}, loopback), null);
  assert.equal(getClientIp("", {}, loopback), null);
});
