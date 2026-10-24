// Skills tab: registry listing with Hermes-style enabled/disable toggles +
// the R2 sync status line (skills_backend from /api/health). Port of
// langgraph-demo's SkillsTab with backend-field adaptations (relDir,
// skills_backend) and one behavioral note difference: our skills index
// re-renders per turn, so toggles apply to the NEXT turn, not next session.

import { useCallback, useEffect, useMemo, useState } from "react";
import { getSkills, setSkillEnabled } from "../api";
import type { Health, SkillInfo } from "../types";

interface Props {
  health: Health | null;
}

export default function SkillsTab({ health }: Props) {
  const [skills, setSkills] = useState<SkillInfo[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [banner, setBanner] = useState<string | null>(null);

  const refresh = useCallback(() => {
    getSkills()
      .then((body) => {
        setSkills(body);
        setLoadError(null);
      })
      .catch((err) => setLoadError(err instanceof Error ? err.message : String(err)));
  }, []);

  useEffect(refresh, [refresh]);

  const toggle = useCallback(
    async (skill: SkillInfo) => {
      if (busy) return;
      const next = !skill.enabled;
      setBusy(skill.name);
      setBanner(null);
      setSkills((prev) => prev?.map((s) => (s.name === skill.name ? { ...s, enabled: next } : s)) ?? prev);
      try {
        await setSkillEnabled(skill.name, next);
      } catch (err) {
        setSkills((prev) => prev?.map((s) => (s.name === skill.name ? { ...s, enabled: !next } : s)) ?? prev);
        setBanner(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(null);
      }
    },
    [busy],
  );

  const enabledCount = useMemo(() => skills?.filter((s) => s.enabled).length ?? 0, [skills]);

  const backend = health?.skills_backend;
  const backendLine = !backend
    ? null
    : backend.mode === "s3"
      ? `${backend.registry} ` +
        (backend.lastSync && !backend.lastSync.error
          ? `— last sync ${backend.lastSync.pulled} pulled, ${backend.lastSync.removed} removed, ` +
            `${backend.lastSync.unchanged} unchanged` +
            (backend.lastSync.pushed !== undefined ? `, ${backend.lastSync.pushed} pushed` : "")
          : backend.lastSync?.error
            ? `— last sync FAILED: ${backend.lastSync.error}`
            : "— no sync yet")
      : backend.error ?? "local skills dir only";
  const backendError = !!backend?.lastSync?.error;

  return (
    <main className="skills">
      <div className="skills-inner">
        <div className="skills-head">
          <div>
            <div className="skills-title">Skills</div>
            <div className="skills-count">
              {skills ? `${enabledCount} enabled · ${skills.length - enabledCount} disabled` : "loading…"}
            </div>
          </div>
          <div className="skills-actions">
            <button className="skills-refresh" onClick={refresh}>↻ Refresh</button>
          </div>
        </div>

        {backendLine && (
          <div className={backendError ? "skills-error" : "skills-note"} style={{ marginBottom: 8 }}>
            {backendLine}
          </div>
        )}

        {banner && (
          <div className="skills-error" onClick={() => setBanner(null)} title="click to dismiss">
            {banner} — click to dismiss
          </div>
        )}

        {loadError ? (
          <div className="skills-error">
            {loadError} — <button className="skills-retry" onClick={refresh}>retry</button>
          </div>
        ) : (
          <div className="skills-list">
            {skills === null && <div className="skills-empty">loading…</div>}
            {skills !== null && skills.length === 0 && (
              <div className="skills-empty">
                No skills in the working copy — the agent can create skills with
                skill_manage, and boot sync pulls the bucket contents.
              </div>
            )}
            {skills?.map((s) => (
              <div key={s.relDir} className={`skill-row${s.enabled ? "" : " disabled"}`}>
                <div className="skill-info">
                  <div className="skill-row-head">
                    <span className="skill-name">{s.name}</span>
                    <span className="mcp-transport">{s.relDir}</span>
                  </div>
                  {s.description && <div className="skill-desc">{s.description}</div>}
                </div>
                <button
                  className={`toggle${s.enabled ? " on" : ""}`}
                  role="switch"
                  aria-checked={s.enabled}
                  aria-label={`${s.enabled ? "Disable" : "Enable"} skill ${s.name}`}
                  disabled={busy !== null}
                  onClick={() => toggle(s)}
                >
                  <span className="knob" />
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="skills-note">
          Toggles are per-user (state/users/&lt;you&gt;/skills.json) and apply from the
          agent's next turn; other users keep their own choices. Bucket changes sync
          via the nm-skills CLI (boot pull+push; debounced curation push).
        </div>
      </div>
    </main>
  );
}
