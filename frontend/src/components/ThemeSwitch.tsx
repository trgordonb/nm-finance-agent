// Light/dark pill switch for the sidebar user row: labels flank a sliding
// track, knob sits on the active side (styled after the day/night toggle the
// user picked). Picking a side stores it explicitly — "auto" only applies
// until the first flip.

import { useTheme } from "../theme";

export default function ThemeSwitch() {
  const { resolved, setSetting } = useTheme();
  const dark = resolved === "dark";
  return (
    <span className="theme-switch-group">
      <button
        className={`theme-switch-label${dark ? "" : " active"}`}
        aria-label="Light theme"
        onClick={() => setSetting("light")}
      >
        Light
      </button>
      <button
        className={`theme-switch${dark ? " dark" : ""}`}
        role="switch"
        aria-checked={dark}
        aria-label="Dark mode"
        title={dark ? "Switch to light theme" : "Switch to dark theme"}
        onClick={() => setSetting(dark ? "light" : "dark")}
      >
        <span className="theme-switch-knob" />
        <span className="theme-switch-dots" aria-hidden="true" />
      </button>
      <button
        className={`theme-switch-label${dark ? " active" : ""}`}
        aria-label="Dark theme"
        onClick={() => setSetting("dark")}
      >
        Dark
      </button>
    </span>
  );
}
