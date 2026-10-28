// First-login wiki onboarding notice: two setup steps (request common-wiki
// write access, create a personal domain). Dismissal persists in localStorage
// keyed by user id — per user, per browser. There is no server-side
// preferences store, so a fresh browser sees the notice once more.

import { useState } from "react";
import { FolderPlus, ShieldCheck, X } from "lucide-react";
import type { AuthUser } from "../auth";

function dismissedKey(user: AuthUser): string {
  return `nm.wiki-onboarding.${user.id}`;
}

function isDismissed(user: AuthUser): boolean {
  try {
    return localStorage.getItem(dismissedKey(user)) === "1";
  } catch {
    return false;
  }
}

export default function WikiOnboarding({ user }: { user: AuthUser }) {
  const [visible, setVisible] = useState(() => !isDismissed(user));
  if (!visible) return null;

  const dismiss = () => {
    try {
      localStorage.setItem(dismissedKey(user), "1");
    } catch {
      // private mode / storage disabled: the notice just reappears next load
    }
    setVisible(false);
  };

  return (
    <section className="wiki-onboarding" role="status">
      <div className="wiki-onboarding-body">
        <div className="wiki-onboarding-title">Set up your wiki</div>
        <ol className="wiki-onboarding-steps">
          <li>
            <ShieldCheck size={13} className="row-icon" aria-hidden="true" />
            Ask an admin to grant you <strong>write access to the common wiki</strong>.
          </li>
          <li>
            <FolderPlus size={13} className="row-icon" aria-hidden="true" />
            Create a <strong>domain of your choice in your personal wiki</strong>.
          </li>
        </ol>
      </div>
      <button className="wiki-onboarding-x" aria-label="Dismiss" title="Dismiss" onClick={dismiss}>
        <X size={14} />
      </button>
    </section>
  );
}
