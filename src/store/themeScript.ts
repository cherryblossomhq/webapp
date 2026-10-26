/**
 * Read by `themeScript` before first paint and by themeStore afterwards. The
 * tscircuit editor `/app` used to serve stored its choice under the same key
 * and values, so a preference set there carried over.
 */
export const THEME_KEY = "theme"

/**
 * Inline script for the host page's `<head>`, so the first paint already has the
 * right colours; src/store/themeStore.ts keeps it in sync afterwards.
 */
export const themeScript = `try {
  const pref = localStorage.getItem(${JSON.stringify(THEME_KEY)})
  const dark = pref === "dark" || (pref !== "light" && matchMedia("(prefers-color-scheme: dark)").matches)
  document.documentElement.dataset.theme = dark ? "dark" : "light"
  document.documentElement.style.colorScheme = dark ? "dark" : "light"
} catch {}`
