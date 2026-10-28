import { useSyncExternalStore } from "react";

/**
 * Light (the default) or the black-and-magenta dark theme. The choice is
 * kept on this device; index.html applies it before the first paint so a
 * dark page never flashes white. Everything else follows the CSS tokens in
 * index.css, so switching is a class on <html>.
 */
export type Theme = "light" | "dark";

const KEY = "routeoptima:theme";
const listeners = new Set<() => void>();

function stored(): Theme {
  try { return localStorage.getItem(KEY) === "dark" ? "dark" : "light"; } catch { return "light"; }
}

let current: Theme = typeof window === "undefined" ? "light" : stored();

function apply(theme: Theme) {
  const root = document.documentElement;
  root.classList.toggle("dark", theme === "dark");
  root.style.colorScheme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme === "dark" ? "#030303" : "#0B0F1A");
  document.querySelector('link[rel="icon"]')?.setAttribute("href", theme === "dark" ? "/favicon-dark.svg" : "/favicon.svg");
}

if (typeof window !== "undefined") apply(current);

export function setTheme(theme: Theme) {
  current = theme;
  try { localStorage.setItem(KEY, theme); } catch { /* private window: this visit only */ }
  apply(theme);
  listeners.forEach(l => l());
}

export function useTheme(): Theme {
  return useSyncExternalStore(
    (l) => { listeners.add(l); return () => { listeners.delete(l); }; },
    () => current,
    () => "light",
  );
}
