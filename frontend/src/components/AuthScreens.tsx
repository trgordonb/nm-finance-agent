// Small full-screen states used by the auth shell: boot splash and the
// "signed in but not entitled" screen.

import type { AuthUser } from "../auth";

export function AuthSplash() {
  return (
    <div className="login-screen">
      <div className="auth-splash">
        <img src="/logo-mark.png" alt="" className="login-logo" />
        <div className="auth-splash-text">connecting…</div>
      </div>
    </div>
  );
}

interface NoAccessProps {
  user: AuthUser;
  requiredPermission: string;
  onLogout: () => void;
}

export function NoAccess({ user, requiredPermission, onLogout }: NoAccessProps) {
  return (
    <div className="login-screen">
      <div className="login-card">
        <img src="/logo-mark.png" alt="" className="login-logo" />
        <div className="login-kicker">NM Finance Agent</div>
        <h1 className="login-title">Access required</h1>
        <p className="login-sub">
          Signed in as <strong>{user.username}</strong>, but this account does not have the
          application permission.
        </p>
        <div className="no-access-perm">{requiredPermission}</div>
        <p className="login-sub">
          Ask an SSO administrator to grant it to your account or group, then reload this page.
        </p>
        <button type="button" className="login-submit" onClick={onLogout}>
          Sign out
        </button>
        <div className="login-foot">Protected by the Neural Matrix SSO</div>
      </div>
    </div>
  );
}
