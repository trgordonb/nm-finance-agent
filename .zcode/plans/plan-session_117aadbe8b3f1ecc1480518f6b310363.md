# Theme system: Light / Dark / Auto (default Auto)

The app is already dark-only via `:root` CSS variables in `frontend/src/styles.css`. This plan adds a light theme, a 3-state toggle (Light / Dark / Auto), OS-preference following (default), persistence, and theme-aware charts.

## 1. `frontend/src/theme.ts` (new) — theme store + hook
- Types: `ThemeSetting = "light" | "dark" | "auto"` (persisted), `ResolvedTheme = "light" | "dark"` (applied to DOM).
- localStorage key `nm.theme` (no other LS usage exists; this is the first). Default `"auto"` → resolves via `matchMedia("(prefers-color-scheme: dark)")`.
- Tiny module store with `subscribe` + `useSyncExternalStore`-based `useTheme()` hook returning `{ setting, resolved, setSetting }`. Listens to OS `prefers-color-scheme` changes so Auto stays live. Sets `document.documentElement.dataset.theme` on every change. Sidebar, VelaChart, and WikiGraph all consume this hook — no prop drilling.

## 2. `frontend/index.html` — no-flash bootstrap
Inline `<script>` in `<head>` that reads `nm.theme`, resolves auto, and sets `data-theme` on `<html>` before first paint (same resolution logic, duplicated in ~8 lines because this runs before any bundle).

## 3. `frontend/src/styles.css` — light palette + token cleanup
- `:root { color-scheme: dark }` and a new `:root[data-theme="light"]` block overriding all 13 palette vars with a GitHub-light-family palette (`--bg: #ffffff`, `--bg-subtle: #f0f3f6`, `--panel: #ffffff`, `--border: #d5dbe1`, `--text: #1f2328`, `--text-dim: #59636e`, `--accent: #0969da`, `--cyan: #0f8f99`, `--warn: #9a6700`, `--err: #cf222e`, `--ok: #1a7f37`, `--user-bubble: #e7f0fa`).
- Introduce derived tokens so both themes control them: `--on-accent` (replaces hardcoded `color: #0d1117` on the send button ~line 1015 and followup badge ~1386), `--overlay` (modal backdrop ~876), `--surface-glass` (sticky bar ~1172), `--shadow-sm/-lg` (4 box-shadows).
- Replace the ~25 hardcoded `rgba(<palette rgb>, α)` accent/warn/err/ok tints (lines 594–2284, incl. the login gradient) with `color-mix(in srgb, var(--accent) X%, transparent)` so tints derive from whichever theme is active. (Evergreen-browser feature, fine for this stack.)

## 4. `frontend/src/components/Sidebar.tsx` — the toggle
Icon button in the sidebar footer row next to the existing gear button, styled like it. Cycles Auto → Light → Dark. Icon per setting: `Monitor` / `Sun` / `Moon` (lucide), `title`/`aria-label` like "Theme: Auto (dark) — switch to Light".

## 5. `frontend/src/charts/VelaChart.tsx`
Replace hardcoded `theme: "dark"` with the hook's `resolved` value and add it to the mount effect deps so the chart is destroyed/recreated on theme change.

## 6. `frontend/src/components/WikiGraph.tsx` — Sigma canvas colors
Split the color constants into per-theme palettes (light: `#0969da`/`#1a7f37`/`#0f8f99`/`#9a6700` type colors, `#8c959f` default node, `#d1d9e0` missing node, dark-ink edges/labels). On theme change, update the running Sigma instance in place (`setSetting` for label colors + `setNodeAttribute`/`setEdgeAttribute` recolor + `refresh()`) rather than remounting — avoids refetching page bodies over the network.

## 7. Verification
- `cd frontend && npm run build` (tsc typecheck + vite build) must pass.
- Best-effort visual check: run the Vite dev server and screenshot the login/chat surfaces in both themes via browser automation.

Optional polish included: minimal per-theme `.hljs-*` syntax-token colors (highlight.js runs with no theme CSS today, tokens currently inherit `--text`).