import { create } from "zustand"
import { THEME_KEY } from "./themeScript"

export type ThemePref = "system" | "light" | "dark"
export type Scheme = "light" | "dark"

const media = () => (typeof window !== "undefined" && window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null)

function readPref(): ThemePref {
  try {
    const v = localStorage.getItem(THEME_KEY)
    return v === "light" || v === "dark" ? v : "system"
  } catch {
    return "system"
  }
}

const resolve = (pref: ThemePref): Scheme => (pref === "system" ? (media()?.matches ? "dark" : "light") : pref)

function apply(scheme: Scheme) {
  if (typeof document === "undefined") return
  const root = document.documentElement
  root.dataset.theme = scheme
  root.style.colorScheme = scheme
}

interface ThemeState {
  pref: ThemePref
  scheme: Scheme
  setPref: (pref: ThemePref) => void
}

export const useTheme = create<ThemeState>((set) => {
  const pref = readPref()
  const scheme = resolve(pref)
  apply(scheme)
  return {
    pref,
    scheme,
    setPref: (pref) => {
      try {
        if (pref === "system") localStorage.removeItem(THEME_KEY)
        else localStorage.setItem(THEME_KEY, pref)
      } catch {
        // storage blocked; the choice lasts for this page only
      }
      const scheme = resolve(pref)
      apply(scheme)
      set({ pref, scheme })
    },
  }
})

/** Follow the OS setting, and changes made in another tab or the compare page's frames. */
export function watchTheme() {
  const sync = () => {
    const pref = readPref()
    const scheme = resolve(pref)
    apply(scheme)
    useTheme.setState({ pref, scheme })
  }
  const mq = media()
  mq?.addEventListener("change", sync)
  const onStorage = (e: StorageEvent) => {
    if (e.key === THEME_KEY || e.key === null) sync()
  }
  window.addEventListener("storage", onStorage)
  return () => {
    mq?.removeEventListener("change", sync)
    window.removeEventListener("storage", onStorage)
  }
}

/** Light and dark flip; from "system" this picks the opposite of what is showing. */
export const toggleTheme = () => {
  const { scheme, setPref } = useTheme.getState()
  setPref(scheme === "dark" ? "light" : "dark")
}
