// Read-only passthrough to the llmwiki service, for the Wiki tab.
//
// The service sends no CORS headers, so the browser cannot call :8010
// directly; the UI talks to this proxy instead. The allow-list below is the
// security posture: only the read surface is forwardable — the write and admin
// endpoints (ingest, upload, compile, domain mutation, lint) can never be
// reached from the UI, regardless of what it asks for.
//
// Pure path/query logic lives here (tested in src/tests/wiki-proxy.test.ts);
// the HTTP glue is a few lines in index.ts.

const ALLOWED_ROOTS = new Set(["domains", "concepts", "page", "search", "healthz"]);
const SLUG_RE = /^[a-z0-9][a-z0-9._-]*$/i;
const QUERY_KEYS = ["domain", "prefix", "q", "k", "scope"] as const;

export type WikiTarget = { path: string } | { error: string };

/** Map an /api/wiki/* splat + query onto an upstream llmwiki path. */
export function buildWikiTarget(splat: string, query: Record<string, unknown>): WikiTarget {
  const clean = String(splat ?? "")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
  if (!clean) return { error: "missing wiki path" };

  const segments = clean.split("/");
  const root = segments[0];
  if (!ALLOWED_ROOTS.has(root)) return { error: `wiki path not allowed: ${root}` };
  if (root === "page") {
    if (segments.length !== 2 || !SLUG_RE.test(segments[1])) {
      return { error: "invalid page slug" };
    }
  } else if (segments.length !== 1) {
    return { error: "invalid wiki path" };
  }

  const params = new URLSearchParams();
  for (const key of QUERY_KEYS) {
    const value = query[key];
    if (typeof value === "string" && value.trim()) params.set(key, value);
  }
  const qs = params.toString();
  return { path: `/${clean}${qs ? `?${qs}` : ""}` };
}

export interface WikiFetchResult {
  status: number;
  contentType: string;
  body: string;
}

export interface WikiFetchOptions {
  /** Hard timeout. Cold starts on a remote host need more than localhost. */
  timeoutMs?: number;
  /** Static bearer for the service; empty means "send no Authorization". */
  token?: string;
}

/** Fetch one upstream path with a hard timeout; a throw means "service down". */
export async function fetchWiki(
  baseUrl: string,
  path: string,
  options: WikiFetchOptions = {},
): Promise<WikiFetchResult> {
  const { timeoutMs = 60_000, token = "" } = options;
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  const resp = await fetch(`${baseUrl.replace(/\/+$/, "")}${path}`, {
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  });
  return {
    status: resp.status,
    contentType: resp.headers.get("content-type") ?? "application/octet-stream",
    body: await resp.text(),
  };
}
