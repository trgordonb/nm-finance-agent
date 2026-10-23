// Client-IP derivation, ported from the SSO server's sso_client.get_client_ip
// (docs/SSO-CLIENT-LIBRARY-DESIGN.md §3). The SSO binds a token to the IP the
// BFF reports, so this must be identical on login, refresh and introspect.
//
// Rules:
//   1. normalise the socket peer; if it is not a trusted proxy, headers are
//      ignored entirely (a spoofed X-Forwarded-For from an untrusted peer can
//      never change the answer);
//   2. a configured header (cf-connecting-ip behind Cloudflare) is read with
//      the same right-to-left walk;
//   3. otherwise X-Forwarded-For is walked right-to-left; the first untrusted
//      address wins, an invalid entry stops the walk at the last good address.
//
// Pure functions only: no Express, no I/O.

import net from "node:net";

export type HeaderBag = Record<string, string | string[] | undefined>;

/**
 * Canonicalise an address (peer or header entry) to the form the SSO will
 * hash. Strips ports/brackets/zone ids, maps IPv4-mapped IPv6 to IPv4, and
 * normalises IPv6 spelling. `::1` is folded to `127.0.0.1` so a `localhost`
 * (IPv6) login cannot mismatch a `127.0.0.1` API call.
 */
export function normalizeIp(value: unknown): string | null {
  if (typeof value !== "string") return null;
  let v = value.trim();
  if (!v) return null;

  // [IPv6]:port or [IPv6]
  if (v.startsWith("[")) {
    const end = v.indexOf("]");
    if (end === -1) return null;
    v = v.slice(1, end);
  } else if (net.isIP(v) === 0) {
    // IPv4:port (a bare IPv6 has more than one colon and fails isIP above,
    // but must not be truncated).
    const hostPort = /^([^:]+):(\d{1,5})$/.exec(v);
    if (hostPort) v = hostPort[1];
  }

  // IPv6 zone id (fe80::1%eth0)
  const zone = v.indexOf("%");
  if (zone !== -1) v = v.slice(0, zone);

  // IPv4-mapped IPv6 (::ffff:203.0.113.7) → IPv4
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(v);
  if (mapped && net.isIPv4(mapped[1])) v = mapped[1];

  let family = net.isIP(v);
  if (!family) return null;

  if (family === 6) {
    try {
      const host = new URL(`http://[${v}]/`).hostname; // WHATWG returns "[…]"
      v = host.startsWith("[") ? host.slice(1, -1) : host;
    } catch {
      v = v.toLowerCase();
    }
    family = 6;
  }

  if (v === "::1") return "127.0.0.1";
  return family === 6 ? v.toLowerCase() : v;
}

/**
 * Parse a comma-separated IP/CIDR list into a BlockList. Invalid entries are
 * ignored (trust nothing you cannot parse).
 */
export function parseTrusted(spec: string): net.BlockList {
  const list = new net.BlockList();
  for (const raw of String(spec ?? "").split(",")) {
    const item = raw.trim();
    if (!item) continue;

    const slash = item.indexOf("/");
    if (slash !== -1) {
      const ip = normalizeIp(item.slice(0, slash));
      const prefix = Number.parseInt(item.slice(slash + 1), 10);
      if (!ip || !Number.isInteger(prefix) || prefix < 0) continue;
      if (net.isIPv4(ip)) {
        list.addSubnet(ip, Math.min(prefix, 32), "ipv4");
      } else if (net.isIPv6(ip)) {
        list.addSubnet(ip, Math.min(prefix, 128), "ipv6");
      }
    } else {
      const ip = normalizeIp(item);
      if (!ip) continue;
      if (net.isIPv4(ip)) list.addAddress(ip, "ipv4");
      else if (net.isIPv6(ip)) list.addAddress(ip, "ipv6");
    }
  }
  return list;
}

export function isTrusted(list: net.BlockList, ip: string): boolean {
  if (net.isIPv4(ip)) return list.check(ip, "ipv4");
  if (net.isIPv6(ip)) return list.check(ip, "ipv6");
  return false;
}

function headerValue(headers: HeaderBag, name: string): string | undefined {
  const wanted = name.toLowerCase();
  const direct = headers[wanted];
  if (direct !== undefined) return Array.isArray(direct) ? direct.join(",") : direct;
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() !== wanted) continue;
    const value = headers[key];
    return Array.isArray(value) ? value.join(",") : value;
  }
  return undefined;
}

function splitList(value: string): string[] {
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Walk right → left. Returns the first untrusted address; if every entry is
 * trusted, the leftmost one; if an entry is invalid, the last good address
 * before it (`invalid` is set so a custom header can be ignored entirely).
 */
function pickFromRight(
  entries: string[],
  trusted: net.BlockList,
): { ip: string | null; invalid: boolean } {
  let lastGood: string | null = null;
  let leftmost: string | null = null;
  for (let i = entries.length - 1; i >= 0; i--) {
    const ip = normalizeIp(entries[i]);
    if (!ip) return { ip: lastGood, invalid: true };
    leftmost = ip;
    if (!isTrusted(trusted, ip)) return { ip, invalid: false };
    lastGood = ip;
  }
  return { ip: leftmost, invalid: false };
}

/**
 * Derive the end-user IP as the SSO expects it.
 *
 * @param peerAddr socket peer (`req.socket.remoteAddress`); null → null
 * @param headers  request headers (case-insensitive)
 * @param trusted  result of `parseTrusted(SSO_TRUSTED_PROXIES)`
 * @param clientIpHeader optional trusted-proxy header, e.g. `cf-connecting-ip`
 */
export function getClientIp(
  peerAddr: string | null | undefined,
  headers: HeaderBag,
  trusted: net.BlockList,
  clientIpHeader = "",
): string | null {
  const peer = normalizeIp(peerAddr);
  if (!peer) return null;
  if (!isTrusted(trusted, peer)) return peer;

  const header = clientIpHeader.trim();
  if (header) {
    const value = headerValue(headers, header);
    if (value) {
      const picked = pickFromRight(splitList(value), trusted);
      // A half-invalid custom header is untrustworthy → fall through to XFF.
      if (picked.ip && !picked.invalid) return picked.ip;
    }
  }

  const xff = headerValue(headers, "x-forwarded-for");
  if (xff) {
    const picked = pickFromRight(splitList(xff), trusted);
    if (picked.ip) return picked.ip;
  }

  return peer;
}
