import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { convertSymbol, type KicadLandRow, type KicadPartRow, type SkipCode } from "./convert"
import { convertFootprint, type FootprintResult } from "./footprint"
import { parseSymbols, resolveExtends, type RawSymbol } from "./symbol"

// Reads KiCad's library directories and converts every symbol that has a footprint to match.
// Used by the tests, with the report of what converts and why the rest doesn't; nothing in the
// editor's bundle imports it, because it reads files and the editor runs in a browser. The parts
// database's import walks the libraries itself and calls `convertSymbol`.
//
// Layout of KiCad 10's libraries:
//   symbols/<Library>.kicad_symdir/<Symbol>.kicad_sym    (one symbol per file; a few libraries may still be one file)
//   footprints/<Library>.pretty/<Footprint>.kicad_mod

export interface ImportReport {
  release: string
  symbols: number
  symbolLibraries: number
  converted: number
  skipped: Record<SkipCode, number>
  /** A few examples of each reason, as `Library:Symbol (detail)`. */
  samples: Record<SkipCode, string[]>
  /** Why footprints were refused, with the pad numbers taken out so like reasons count together. */
  unsupportedFootprints: { reason: string; parts: number }[]
  lands: number
  courtyard: { courtyard: number; fab: number; none: number }
  /** Converted parts with at least one pad whose rounded corners are drawn square. */
  partsWithRoundedPads: number
  multiUnit: number
  withHiddenPins: number
  withAlternateFunctions: number
  exposedPinAdded: number
  withMountingPads: number
  byCategory: Record<string, number>
  /** Libraries with the most converted parts. */
  topLibraries: { library: string; converted: number; skipped: number }[]
}

export interface SkippedSymbol {
  key: string
  code: SkipCode
  detail: string
}

export interface Imported {
  parts: KicadPartRow[]
  lands: KicadLandRow[]
  /** Every symbol that was not converted, with why: the report's counts, one by one. */
  skipped: SkippedSymbol[]
  report: ImportReport
}

const SYMBOL_FILE = ".kicad_sym"
const FOOTPRINT_FILE = ".kicad_mod"

async function entries(dir: string) {
  return readdir(dir, { withFileTypes: true })
}

/** Every symbol of a library, by name: from its `.kicad_symdir` directory, or its one `.kicad_sym` file. */
async function readSymbolLibrary(path: string, isDir: boolean): Promise<Map<string, RawSymbol>> {
  const symbols = new Map<string, RawSymbol>()
  const files = isDir ? (await entries(path)).filter((e) => e.isFile() && e.name.endsWith(SYMBOL_FILE)).map((e) => join(path, e.name)) : [path]
  for (const file of files) {
    for (const symbol of parseSymbols(await readFile(file, "utf8"))) symbols.set(symbol.name, symbol)
  }
  return symbols
}

/** Normalises a refusal so the same reason on different pads counts once. */
const reasonKey = (reason: string) => reason.replace(/\b(pad|hole|pads) \S+/g, "$1 _").replace(/\(unnumbered\)/g, "_")

export async function convertLibraries({
  symbols: symbolsDir,
  footprints: footprintsDir,
  release,
  only,
}: {
  symbols: string
  footprints: string
  release: string
  /** Convert only these libraries (tests). */
  only?: string[]
}): Promise<Imported> {
  const footprintCache = new Map<string, FootprintResult | undefined>()
  const footprint = async (key: string): Promise<FootprintResult | undefined> => {
    if (footprintCache.has(key)) return footprintCache.get(key)
    const colon = key.indexOf(":")
    let result: FootprintResult | undefined
    if (colon > 0) {
      try {
        const text = await readFile(join(footprintsDir, `${key.slice(0, colon)}.pretty`, `${key.slice(colon + 1)}${FOOTPRINT_FILE}`), "utf8")
        result = convertFootprint(text, key)
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e
      }
    }
    footprintCache.set(key, result)
    return result
  }

  const report: ImportReport = {
    release,
    symbols: 0,
    symbolLibraries: 0,
    converted: 0,
    skipped: { power_symbol: 0, no_pins: 0, no_footprint: 0, footprint_missing: 0, footprint_unsupported: 0, pin_conflict: 0, pin_without_number: 0, pin_without_pad: 0, pad_without_pin: 0, bad_symbol: 0 },
    samples: { power_symbol: [], no_pins: [], no_footprint: [], footprint_missing: [], footprint_unsupported: [], pin_conflict: [], pin_without_number: [], pin_without_pad: [], pad_without_pin: [], bad_symbol: [] },
    unsupportedFootprints: [],
    lands: 0,
    courtyard: { courtyard: 0, fab: 0, none: 0 },
    partsWithRoundedPads: 0,
    multiUnit: 0,
    withHiddenPins: 0,
    withAlternateFunctions: 0,
    exposedPinAdded: 0,
    withMountingPads: 0,
    byCategory: {},
    topLibraries: [],
  }
  const unsupported = new Map<string, number>()
  const perLibrary = new Map<string, { converted: number; skipped: number }>()
  const parts: KicadPartRow[] = []
  const skipped: SkippedSymbol[] = []
  const lands = new Map<string, KicadLandRow>()
  const landStats = new Map<string, Extract<FootprintResult, { ok: true }>>()

  const libraries = (await entries(symbolsDir))
    .filter((e) => (e.isDirectory() && e.name.endsWith(".kicad_symdir")) || (e.isFile() && e.name.endsWith(SYMBOL_FILE)))
    .map((e) => ({ name: e.name.replace(/\.kicad_symdir$|\.kicad_sym$/, ""), path: join(symbolsDir, e.name), isDir: e.isDirectory() }))
    .filter((l) => !only || only.includes(l.name))
    .sort((a, b) => a.name.localeCompare(b.name, "en"))

  for (const lib of libraries) {
    report.symbolLibraries++
    const symbols = await readSymbolLibrary(lib.path, lib.isDir)
    const tally = { converted: 0, skipped: 0 }
    perLibrary.set(lib.name, tally)
    for (const raw of [...symbols.values()].sort((a, b) => a.name.localeCompare(b.name, "en"))) {
      report.symbols++
      const skip = (code: SkipCode, detail: string) => {
        report.skipped[code]++
        skipped.push({ key: `${lib.name}:${raw.name}`, code, detail })
        tally.skipped++
        if (report.samples[code].length < 8) report.samples[code].push(`${lib.name}:${raw.name}${detail ? ` (${detail})` : ""}`)
      }
      let symbol: RawSymbol
      try {
        symbol = resolveExtends(raw, (name) => symbols.get(name))
      } catch (e) {
        skip("bad_symbol", e instanceof Error ? e.message : String(e))
        continue
      }
      // Footprints are read on demand and cached, so the conversion itself stays synchronous.
      const wanted = (symbol.props.Footprint ?? "").trim()
      if (wanted) await footprint(wanted)
      const converted = convertSymbol(symbol, { library: lib.name, release, footprint: (key) => footprintCache.get(key) })
      if (!converted.ok) {
        skip(converted.code, converted.detail)
        if (converted.code === "footprint_unsupported") {
          const reason = reasonKey(converted.detail.slice(converted.detail.indexOf(": ") + 2))
          unsupported.set(reason, (unsupported.get(reason) ?? 0) + 1)
        }
        continue
      }
      report.converted++
      tally.converted++
      parts.push(converted.part)
      if (!lands.has(converted.land.key)) {
        lands.set(converted.land.key, converted.land)
        const fp = footprintCache.get(converted.part.footprintKey)
        if (fp?.ok) landStats.set(converted.land.key, fp)
      }
      const { stats } = converted
      const category = converted.part.category
      report.byCategory[category] = (report.byCategory[category] ?? 0) + 1
      if (converted.part.units > 1) report.multiUnit++
      if (stats.hiddenPins) report.withHiddenPins++
      if (stats.alternatePins) report.withAlternateFunctions++
      if (stats.exposedPinAdded) report.exposedPinAdded++
      if (stats.mountingPads) report.withMountingPads++
      const drawn = footprintCache.get(converted.part.footprintKey)
      if (drawn?.ok && drawn.stats.roundedCorners) report.partsWithRoundedPads++
    }
  }
  report.lands = lands.size
  for (const fp of landStats.values()) report.courtyard[fp.stats.courtyard]++
  report.unsupportedFootprints = [...unsupported].map(([reason, count]) => ({ reason, parts: count })).sort((a, b) => b.parts - a.parts).slice(0, 25)
  report.topLibraries = [...perLibrary]
    .map(([library, t]) => ({ library, ...t }))
    .sort((a, b) => b.converted - a.converted)
    .slice(0, 25)
  return { parts, lands: [...lands.values()], skipped, report }
}
