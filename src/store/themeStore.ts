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

const systemScheme = (): Scheme => (media()?.matches ? "dark" : "light")
const resolve = (pref: ThemePref): Scheme => (pref === "system" ? systemScheme() : pref)

function apply(scheme: Scheme) {
  if (typeof document === "undefined") return
  const root = document.documentElement
  root.dataset.theme = scheme
  root.style.colorScheme = scheme
}

interface ThemeState {
  pref: ThemePref
  /** What is showing. */
  scheme: Scheme
  /** What the OS asks for, which "system" follows. */
  system: Scheme
  setPref: (pref: ThemePref) => void
}

export const useTheme = create<ThemeState>((set) => {
  const pref = readPref()
  const scheme = resolve(pref)
  apply(scheme)
  return {
    pref,
    scheme,
    system: systemScheme(),
    setPref: (pref) => {
      try {
        if (pref === "system") localStorage.removeItem(THEME_KEY)
        else localStorage.setItem(THEME_KEY, pref)
      } catch {
        // storage blocked; the choice lasts for this page only
      }
      const scheme = resolve(pref)
      apply(scheme)
      set({ pref, scheme, system: systemScheme() })
    },
  }
})

/** Follow the OS setting, and changes made in another tab or the compare page's frames. */
export function watchTheme() {
  const sync = () => {
    const pref = readPref()
    const scheme = resolve(pref)
    apply(scheme)
    useTheme.setState({ pref, scheme, system: systemScheme() })
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

const flip = (s: Scheme): Scheme => (s === "dark" ? "light" : "dark")

/**
 * The theme a click on the theme button picks: from "system" the opposite of what the OS shows,
 * then the other one, then back to "system". The first click always changes the colours, and the
 * only click that doesn't is the one onto "system" from the scheme the OS already shows.
 */
export const nextThemePref = (pref: ThemePref, system: Scheme): ThemePref =>
  pref === "system" ? flip(system) : pref === system ? "system" : flip(pref)

export const cycleTheme = () => {
  const { pref, setPref } = useTheme.getState()
  setPref(nextThemePref(pref, systemScheme()))
}
