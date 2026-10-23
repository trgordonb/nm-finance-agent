// Login screen for the SSO BFF. Credentials go to our own /api/auth/login;
// the server talks to the SSO and returns an HttpOnly cookie. Nothing is
// stored in localStorage.

import { useEffect, useState, type FormEvent } from "react";

import { AuthApiError, login, type AuthStatus } from "../auth";

interface Props {
  onSuccess: (status: AuthStatus) => void;
}

interface ErrorState {
  text: string;
  retryAfter?: number;
}

function describe(err: unknown): ErrorState {
  if (err instanceof AuthApiError) {
    if (err.status === 401 && err.detail === "invalid_credentials") {
      return { text: "Wrong username or password." };
    }
    if (err.status === 403 && err.detail === "account_inactive") {
      return { text: "This account is suspended." };
    }
    if (err.status === 429) {
      return {
        text: "Too many attempts. Try again shortly.",
        retryAfter: err.retryAfterSeconds ?? 60,
      };
    }
    if (err.status === 503 || err.status === 502) {
      return { text: "Sign-in is temporarily unavailable. Try again shortly." };
    }
    if (err.status === 400) return { text: err.detail || "Enter a username and password." };
    return { text: "Sign-in failed. Try again." };
  }
  return { text: "Could not reach the server. Check your connection and try again." };
}

export default function Login({ onSuccess }: Props) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<ErrorState | null>(null);
  const [busy, setBusy] = useState(false);
  const [retryIn, setRetryIn] = useState(0);

  useEffect(() => {
    if (retryIn <= 0) return;
    const timer = window.setTimeout(() => setRetryIn((n) => Math.max(0, n - 1)), 1000);
    return () => window.clearTimeout(timer);
  }, [retryIn]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || retryIn > 0) return;
    setBusy(true);
    setError(null);
    try {
      const status = await login(username.trim(), password);
      onSuccess(status);
    } catch (err) {
      const next = describe(err);
      setError(next);
      if (next.retryAfter) setRetryIn(next.retryAfter);
    } finally {
      setBusy(false);
    }
  }

  const disabled = busy || retryIn > 0 || !username.trim() || !password;

  return (
    <div className="login-screen">
      <form className="login-card" onSubmit={submit}>
        <img src="/logo-mark.png" alt="" className="login-logo" />
        <div className="login-kicker">NM Finance Agent</div>
        <h1 className="login-title">Sign in</h1>
        <p className="login-sub">Use your Neural Matrix SSO account.</p>

        <label className="login-field">
          <span>Username or email</span>
          <input
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            autoFocus
            spellCheck={false}
            disabled={busy}
          />
        </label>

        <label className="login-field">
          <span>Password</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            disabled={busy}
          />
        </label>

        {error && (
          <div className="login-error" role="alert">
            {error.text}
          </div>
        )}

        <button type="submit" className="login-submit" disabled={disabled}>
          {busy ? "Signing in…" : retryIn > 0 ? `Wait ${retryIn}s` : "Sign in"}
        </button>

        <div className="login-foot">Protected by the Neural Matrix SSO</div>
      </form>
    </div>
  );
}
