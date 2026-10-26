import type { CustomPartSpec, FootprintDef } from "./types"

/**
 * The package a placed part's body is drawn from, read when the 3D view draws it so parts placed
 * before packages were kept get it too: the name its land carries (`FootprintDef.package`), else,
 * for a KiCad part on its own footprint, the footprint its source names (`Package_SO:SOIC-8_3.9x4.9mm_P1.27mm`
 * is the package `SOIC-8_3.9x4.9mm_P1.27mm`), else, for a part made from a supplier's record before
 * lands kept a package, the family a project land's own name starts with (`qfn24_c1234-1a2b3c` is
 * `qfn24`; a footprinter's `qfn24` has no hash and is not read, it is the footprint rules' to draw).
 * The stored package is the part's own footprint's: a component switched to another footprint
 * (an NCS2325D on `dip8`) falls through to that footprint's rules instead of wearing the old body.
 * Library parts have none: their footprint strings are read as ever.
 */
export function packageOf(footprint: Pick<FootprintDef, "name" | "package">, spec: Pick<CustomPartSpec, "source" | "footprint"> | undefined): string | undefined {
  if (footprint.package) return footprint.package
  const database = spec?.source?.database
  if (database?.origin === "kicad" && database.footprint && footprint.name === spec?.footprint) return database.footprint.slice(database.footprint.indexOf(":") + 1)
  if (!spec) return undefined
  const family = footprint.name.match(/^([a-z]+\d*(?:_\d)?)_[a-z0-9_]+-[0-9a-z]{6}$/)?.[1]
  return family && family !== "land" ? family : undefined
}
