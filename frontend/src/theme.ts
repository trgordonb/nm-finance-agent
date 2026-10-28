// Theme setting store: light / dark / auto, persisted in localStorage. "auto"
// follows the OS via prefers-color-scheme. The applied theme lands on
// <html data-theme> so CSS variables pick a palette; index.html carries an
// inline copy of this resolution that runs before first paint (no flash).

import { useSyncExternalStore } from "react";

export type ThemeSetting = "light" | "dark" | "auto";
export type ResolvedTheme = "light" | "dark";

const STORAGE_KEY = "nm.theme";

const listeners = new Set<() => void>();

// Declared before the initial resolve() below — module init calls resolve(),
// so this must be initialized first (function declarations hoist, consts don't).
const darkQuery =
  typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: dark)") : null;

let setting: ThemeSetting = readStored();
let resolved: ResolvedTheme = resolve(setting);

function readStored(): ThemeSetting {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw === "light" || raw === "dark" ? raw : "auto";
  } catch {
    return "auto";
  }
}

function resolve(setting: ThemeSetting): ResolvedTheme {
  if (setting !== "auto") return setting;
  return darkQuery?.matches ? "dark" : "light";
}

function emit() {
  for (const listener of listeners) listener();
}

// Idempotent with the index.html bootstrap; covers module use without that
// script (tests, hot reload after the attribute was stripped).
document.documentElement.dataset.theme = resolved;

// "auto" must track the OS live, not just at load time.
darkQuery?.addEventListener("change", () => {
  if (setting !== "auto") return;
  resolved = resolve(setting);
  document.documentElement.dataset.theme = resolved;
  emit();
});

export function getThemeSetting(): ThemeSetting {
  return setting;
}

export function getResolvedTheme(): ResolvedTheme {
  return resolved;
}

export function setThemeSetting(next: ThemeSetting): void {
  setting = next;
  resolved = resolve(setting);
  document.documentElement.dataset.theme = resolved;
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // private mode / storage disabled: theme just won't survive reloads
  }
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function useThemeSetting(): ThemeSetting {
  return useSyncExternalStore(subscribe, getThemeSetting);
}

/** Reactive theme state; re-renders on toggle and when "auto" flips with the OS. */
export function useTheme(): { setting: ThemeSetting; resolved: ResolvedTheme; setSetting: typeof setThemeSetting } {
  const setting = useThemeSetting();
  // `resolved` is module state updated before listeners fire, so any
  // re-render triggered by the store reads the fresh value.
  return { setting, resolved: resolve(setting), setSetting: setThemeSetting };
}
