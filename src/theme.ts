export type Theme = "light" | "dark";

const KEY = "margindocs-theme";

// Guarded for the Node test environment, which imports this transitively through
// src/keys/commands.ts; the app itself always runs in a webview and hits the real branches.
export function initialTheme(): Theme {
  if (typeof document === "undefined") return "light";
  const attr = document.documentElement.getAttribute("data-theme");
  if (attr === "light" || attr === "dark") return attr;
  const saved = typeof localStorage === "undefined" ? null : localStorage.getItem(KEY);
  if (saved === "light" || saved === "dark") return saved;
  return typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

export function applyTheme(theme: Theme) {
  if (typeof document === "undefined") return;
  document.documentElement.setAttribute("data-theme", theme);
  localStorage.setItem(KEY, theme);
}
