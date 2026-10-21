/**
 * Display preferences: the theme and whether the sidebar is collapsed. Kept
 * in cookies (read by the root layout) so the server renders them on the
 * first byte; changing one updates the page at once and the cookie for the
 * next load. Purely cosmetic — nothing here is a secret or reaches the data.
 */

export const THEME_COOKIE = "theme";
export const SIDEBAR_COOKIE = "sidebar";

export type Theme = "light" | "dark";

const YEAR = 60 * 60 * 24 * 365;

export function writePreference(name: string, value: string): void {
  document.cookie = `${name}=${value}; path=/; max-age=${YEAR}; samesite=lax`;
}

/** Switches the theme, cross-fading where the browser supports it. */
export function applyTheme(theme: Theme): void {
  writePreference(THEME_COOKIE, theme);
  const swap = () => {
    document.documentElement.dataset.theme = theme;
  };
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!reduce && "startViewTransition" in document) document.startViewTransition(swap);
  else swap();
}
