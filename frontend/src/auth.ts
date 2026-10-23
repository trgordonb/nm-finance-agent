// Auth API for the SSO BFF. These calls deliberately bypass apiFetch: a 401
// from /api/auth/me means "not signed in", not "session expired", and must not
// trigger the global logout handler.

export interface AuthUser {
  id: string;
  username: string;
  email: string | null;
  perms: string[];
}

export interface AuthStatus {
  user: AuthUser;
  allowed: boolean;
  required_permission: string;
}

export class AuthApiError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(detail || `auth request failed: ${status}`);
    this.name = "AuthApiError";
  }
}

function retryAfter(res: Response): number | undefined {
  const parsed = Number.parseInt(res.headers.get("retry-after") ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

async function body(res: Response): Promise<Record<string, unknown>> {
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Current session, or null when unauthenticated (401). */
export async function getMe(): Promise<AuthStatus | null> {
  const res = await fetch("/api/auth/me", { headers: { Accept: "application/json" } });
  if (res.status === 401) return null;
  const data = await body(res);
  if (!res.ok) {
    throw new AuthApiError(res.status, String(data.detail ?? "me_failed"), retryAfter(res));
  }
  return data as unknown as AuthStatus;
}

export async function login(username: string, password: string): Promise<AuthStatus> {
  const res = await fetch("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const data = await body(res);
  if (!res.ok) {
    throw new AuthApiError(res.status, String(data.detail ?? "login_failed"), retryAfter(res));
  }
  return data as unknown as AuthStatus;
}

/** Revokes the server-side session and clears the HttpOnly cookie. */
export async function logout(): Promise<void> {
  await fetch("/api/auth/logout", { method: "POST", headers: { Accept: "application/json" } });
}
