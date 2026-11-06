import { describe, expect, it } from "vitest"
import { nextThemePref, type Scheme, type ThemePref } from "../src/store/themeStore"

const shown = (pref: ThemePref, system: Scheme): Scheme => (pref === "system" ? system : pref)

describe("the theme button's cycle", () => {
  it("goes system, the other scheme, the system's own, and back", () => {
    expect([nextThemePref("system", "dark"), nextThemePref("light", "dark"), nextThemePref("dark", "dark")]).toEqual(["light", "dark", "system"])
    expect([nextThemePref("system", "light"), nextThemePref("dark", "light"), nextThemePref("light", "light")]).toEqual(["dark", "light", "system"])
  })

  it("changes the colours on every click but the one onto system", () => {
    for (const system of ["light", "dark"] as const) {
      for (const pref of ["system", "light", "dark"] as const) {
        const next = nextThemePref(pref, system)
        expect(next).not.toBe(pref)
        if (next !== "system") expect(shown(next, system)).not.toBe(shown(pref, system))
      }
    }
  })
})
