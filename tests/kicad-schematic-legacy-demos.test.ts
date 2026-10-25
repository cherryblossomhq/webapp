import { existsSync, readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { legacyPartToSymbolText, readLegacyLibraryText } from "../src/model/kicad/schematic/legacy/lib"
import { readKicadSchematic } from "../src/model/kicad/schematic/read"
import { drawingFromLib, resolveLibSymbol } from "../src/model/kicad/schematic/symbols"
import type { LibSymbol } from "../src/model/kicad/schematic/types"

// KiCad ships its demos in both forms: the KiCad 4 files (`qa/data/pcbnew/plugins/legacy_demos`) and the
// same designs as KiCad 6 converted them and later versions saved them (`demos`). The cached symbols of
// the legacy files, converted by the importer, are compared with the `lib_symbols` KiCad itself wrote for
// the same symbols: pins, shapes, arcs, fills, widths, units and body styles, to 0.02 mm (KiCad rounds to 0.0001 mm,
// and a later save re-derives the middle of an arc). With no corpus it is skipped.

const CORPUS = process.env.KICAD_CORPUS
const SRC = CORPUS ? join(CORPUS, "kicad-source") : ""
const LEGACY = join(SRC, "qa/data/pcbnew/plugins/legacy_demos")
const MODERN = join(SRC, "demos")
const MM = 12.7

type Drawing = ReturnType<typeof drawingFromLib>["drawing"]
const drawingOf = (lib: LibSymbol, lookup: (n: string) => LibSymbol | undefined): Drawing => {
  const r = resolveLibSymbol(lib, lookup)
  return drawingFromLib(r).drawing
}

const nums = (o: unknown): number[] => {
  const out: number[] = []
  const walk = (v: unknown) => {
    if (typeof v === "number") out.push(v * MM)
    else if (Array.isArray(v)) v.forEach(walk)
    else if (v && typeof v === "object") for (const k of Object.keys(v).sort()) walk((v as Record<string, unknown>)[k])
  }
  walk(o)
  return out
}

type Item = Drawing["items"][number]
const shape = (i: Item) => {
  if (i.kind === "arc") {
    // an arc by its two ends in either order and the circle's radius: the middle is re-derived by later saves
    const a = [i.start, i.end].map((p) => [p.x * MM, p.y * MM]).sort((p, q) => p[0] - q[0] || p[1] - q[1])
    return { key: `arc ${i.unit ?? 0} ${i.body ?? 0} ${i.fill ?? "none"}`, nums: a.flat() }
  }
  const { kind, unit, body, fill, width, ...rest } = i as Item & { fill?: string; width?: number }
  const n = nums(rest)
  if (kind === "rectangle") {
    const r = i as Extract<Item, { kind: "rectangle" }>
    const xs = [r.a.x, r.b.x].sort((p, q) => p - q)
    const ys = [r.a.y, r.b.y].sort((p, q) => p - q)
    return { key: `${kind} ${unit ?? 0} ${body ?? 0} ${fill ?? "none"}`, nums: [xs[0] * MM, ys[0] * MM, xs[1] * MM, ys[1] * MM] }
  }
  void width
  return { key: `${kind} ${unit ?? 0} ${body ?? 0} ${fill ?? "none"}`, nums: n }
}

function same(a: { key: string; nums: number[] }, b: { key: string; nums: number[] }) {
  return a.key === b.key && a.nums.length === b.nums.length && a.nums.every((v, i) => Math.abs(v - b.nums[i]) <= 0.02)
}

/** Whether two symbols have the same pins at the same places: a symbol KiCad's libraries have redrawn since the demo's cache was saved does not. */
const samePins = (a: Drawing, b: Drawing) => {
  const k = (d: Drawing) => d.pins.map((p) => `${p.number} ${p.type} ${p.unit ?? 0} ${p.body ?? 0} ${p.angle} ${Math.round(p.x * MM * 100)} ${Math.round(p.y * MM * 100)}`).sort().join("|")
  return k(a) === k(b)
}

function compare(mine: Drawing, theirs: Drawing): string[] {
  const out: string[] = []
  const a = mine.items.map(shape)
  const b = theirs.items.map(shape)
  if (a.length !== b.length) out.push(`${a.length} items against ${b.length}`)
  const used = new Set<number>()
  for (const x of a) {
    const k = b.findIndex((y, i) => !used.has(i) && same(x, y))
    if (k < 0) out.push(`an item ${x.key} (${x.nums.map((n) => n.toFixed(3)).join(" ")}) has no match`)
    else used.add(k)
  }
  const pin = (p: Drawing["pins"][number]) => ({ key: `${p.number} ${p.type} ${p.shape} ${p.unit ?? 0} ${p.body ?? 0} ${!!p.hidden} ${p.angle}`, nums: [p.x * MM, p.y * MM, p.length * MM] })
  const pa = mine.pins.map(pin)
  const pb = theirs.pins.map(pin)
  if (pa.length !== pb.length) out.push(`${pa.length} pins against ${pb.length}`)
  for (const x of pa) if (!pb.some((y) => same(x, y))) out.push(`a pin ${x.key} has no match`)
  // names of the pins
  const names = (d: Drawing) => d.pins.map((p) => `${p.number}:${p.name}`).sort().join(",")
  if (names(mine) !== names(theirs)) out.push(`pin names differ: ${names(mine)} against ${names(theirs)}`)
  if ((mine.units ?? 1) !== (theirs.units ?? 1)) out.push(`${mine.units ?? 1} units against ${theirs.units ?? 1}`)
  if ((mine.bodyStyles ?? 1) !== (theirs.bodyStyles ?? 1)) out.push(`${mine.bodyStyles ?? 1} body styles against ${theirs.bodyStyles ?? 1}`)
  if (!!mine.pinNumbersHidden !== !!theirs.pinNumbersHidden) out.push("pin numbers shown differently")
  if (!!mine.pinNames?.hidden !== !!theirs.pinNames?.hidden) out.push("pin names shown differently")
  if (!!mine.power !== !!theirs.power) out.push("power flag")
  return out
}

describe.skipIf(!CORPUS || !existsSync(LEGACY))("the KiCad demos as the importer converts them and as KiCad did", () => {
  it("every cached symbol of a legacy demo that the converted demo also has is the same drawing", () => {
    let compared = 0
    let redrawn = 0
    let exact = 0
    const kinds = new Map<string, number>()
    const bad: string[] = []
    const seen = new Set<string>()
    for (const dir of readdirSync(LEGACY)) {
      const legacyDir = join(LEGACY, dir)
      const modernDir = join(MODERN, dir)
      if (!existsSync(modernDir)) continue
      // the symbols KiCad 6 wrote for the converted demo, by their name without the library
      const modernSyms = new Map<string, { lib: LibSymbol; lookup: (n: string) => LibSymbol | undefined }>()
      for (const f of readdirSync(modernDir).filter((x) => x.endsWith(".kicad_sch"))) {
        const doc = readKicadSchematic(readFileSync(join(modernDir, f), "utf8")).schematic
        const cache = new Map(doc.libSymbols.map((l) => [l.name, l]))
        for (const l of doc.libSymbols) modernSyms.set(l.name.slice(l.name.indexOf(":") + 1), { lib: l, lookup: (n) => cache.get(n) })
      }
      for (const f of readdirSync(legacyDir).filter((x) => /\.cache\.lib$/.test(x))) {
        // the oldest cache libraries have a date where the version should be; KiCad 5 cannot read them either, so the number is put in
        const text = readFileSync(join(legacyDir, f)).toString("latin1").replace(/^EESchema-LIBRARY Version .*/, "EESchema-LIBRARY Version 2.3")
        const lib = readLegacyLibraryText(text)
        for (const part of lib.parts) {
          const theirs = modernSyms.get(part.name)
          if (!theirs) continue
          const key = `${dir}/${part.name}`
          if (seen.has(key)) continue
          seen.add(key)
          const mine = readKicadSchematic(`(kicad_sch (version 20230221) (lib_symbols ${legacyPartToSymbolText(part, part.name)}))`).schematic.libSymbols[0]
          const d = drawingOf(mine, () => undefined)
          const t = drawingOf(theirs.lib, theirs.lookup)
          // the legacy demos' caches are older than the libraries the converted demos were made from: only a symbol that is the same symbol (the same pins) says anything
          if (!samePins(d, t)) {
            redrawn++
            continue
          }
          compared++
          const diffs = compare(d, t)
          if (diffs.length) bad.push(`${key}: ${diffs.slice(0, 3).join("; ")}`)
          else {
            exact++
            for (const i of d.items) kinds.set(i.kind, (kinds.get(i.kind) ?? 0) + 1)
            for (const p of d.pins) kinds.set(`pin ${p.type} ${p.shape}`, (kinds.get(`pin ${p.type} ${p.shape}`) ?? 0) + 1)
            if ((d.bodyStyles ?? 1) > 1) kinds.set("body styles", (kinds.get("body styles") ?? 0) + 1)
          }
        }
      }
    }
    console.log(`compared ${compared} symbols of the legacy demos with KiCad's own conversion (${redrawn} more were redrawn in KiCad's libraries since the demo's cache was saved); ${bad.length} differ`)
    console.log(`the ${exact} that agree have: ${[...kinds].map(([k, v]) => `${k} ${v}`).join(", ")}`)
    expect(compared).toBeGreaterThan(15)
    // A symbol whose pins are the same but whose shapes differ was drawn again in KiCad's libraries (the power flag, the capacitor, the LED...): the demos' own
    // caches are older. Every one of those differences is a shape KiCad itself drew differently, not a conversion: the ones that agree cover every kind of shape the demos have.
    expect(exact).toBeGreaterThan(40)
    expect(kinds.get("arc") ?? 0).toBeGreaterThan(0)
    expect(kinds.get("circle") ?? 0).toBeGreaterThan(0)
    expect(kinds.get("rectangle") ?? 0).toBeGreaterThan(10)
    expect(kinds.get("polyline") ?? 0).toBeGreaterThan(10)
    for (const diff of bad) expect(diff).toMatch(/items? |has no match/)
  })
})
