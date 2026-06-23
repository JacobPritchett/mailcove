// Dark-mode helper. Respects the system preference by default and persists an
// explicit user choice to localStorage. The active theme is reflected as a
// `.dark` class on <html> (the shadcn slate tokens key off `.dark`).

export type Theme = "light" | "dark";

const STORAGE_KEY = "mailcove-theme";

/** Read the persisted choice, or null if the user hasn't chosen one. */
function stored(): Theme | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === "light" || v === "dark" ? v : null;
  } catch {
    return null;
  }
}

/** The OS-level preference. */
function systemTheme(): Theme {
  return typeof matchMedia === "function" &&
    matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

/** The theme to show now: explicit choice if any, else the system preference. */
export function resolveTheme(): Theme {
  return stored() ?? systemTheme();
}

/** Toggle `.dark` on <html> to match `theme`. */
export function applyTheme(theme: Theme): void {
  document.documentElement.classList.toggle("dark", theme === "dark");
}

/** Persist + apply an explicit user choice. */
export function setTheme(theme: Theme): void {
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // Ignore storage failures (private mode, quota) — still apply for the session.
  }
  applyTheme(theme);
}

/** Apply the resolved theme on boot (call once before/at first render). */
export function initTheme(): Theme {
  const theme = resolveTheme();
  applyTheme(theme);
  return theme;
}
