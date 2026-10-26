import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, sep } from "node:path"
import { describe, expect, it } from "vitest"
import { computeConnectivity, pinKey } from "../src/model/connectivity"
import { schematicPins } from "../src/model/instances"
import { importKicadSchematic } from "../src/model/kicad/schematic"
import { BUILT_EXTENSIONS } from "../src/model/kicad/schematic/needs"
import { readKicadSchematic } from "../src/model/kicad/schematic/read"
import type { Project } from "../src/model/types"
import { deriveNets } from "./kicad-census/netlist-sch.mjs"

// S11 over real files. No file of the corpus has a case of S11 (every wire end on a wire's side has a junction, nothing is a hair apart), so the real files are
// changed to have them, and the editor's nets are compared with the independent derivation of the changed file (`tests/kicad-census/netlist-sch.mjs`, which reads
// KiCad's rules from the raw text and shares no code with `src`):
//
//   - "no junctions": every `(junction ...)` is taken out, so each wire end that was on another wire's side now has no junction (KiCad joins nothing there);
//   - "nudged ends": one wire end in seven is moved 0.3 um along x, which KiCad keeps apart from the pin or wire it was on and the editor's three digits (12.7 um) would not.
//
// The first is KiCad's T rule at scale, the second its exact points. Each changed file is imported with S11 built and its pins' nets are compared, pin by pin.
//
//   KICAD_CORPUS=<corpus dir> npx vitest run tests/kicad-sch-s11-corpus.test.ts

const CORPUS = process.env.KICAD_CORPUS
const BUILT = new Set([...BUILT_EXTENSIONS, "S2", "S5", "S6", "S10"])

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) {
      if (name === "census") continue
      walk(p, out)
    } else if (name.endsWith(".kicad_sch")) out.push(p)
  }
  return out
}

/** The text with every list that starts with `(name` cut out, by balanced brackets (strings respected). */
function without(text: string, name: string): string {
  let out = ""
  let i = 0
  const head = `(${name}`
  while (i < text.length) {
    const at = text.indexOf(head, i)
    if (at < 0 || !/[\s()]/.test(text[at + head.length] ?? " ")) {
      if (at < 0) break
      out += text.slice(i, at + 1)
      i = at + 1
      continue
    }
    out += text.slice(i, at)
    let depth = 0
    let j = at
    let quoted = false
    for (; j < text.length; j++) {
      const ch = text[j]
      if (quoted) {
        if (ch === "\\") j++
        else if (ch === '"') quoted = false
      } else if (ch === '"') quoted = true
      else if (ch === "(") depth++
      else if (ch === ")" && --depth === 0) break
    }
    i = j + 1
  }
  return out + text.slice(i)
}

/** One wire end in seven moved 0.3 um along x (the second `xy` of each seventh wire). */
function nudged(text: string): string {
  let n = 0
  return text.replace(/\(wire\s+\(pts\s+\(xy ([-\d.]+) ([-\d.]+)\)\s+\(xy ([-\d.]+) ([-\d.]+)\)/g, (whole, _x1: string, _y1: string, x2: string, y2: string) => {
    if (n++ % 7 !== 3) return whole
    return whole.replace(`(xy ${x2} ${y2})`, `(xy ${(Number(x2) + 0.0003).toFixed(4)} ${y2})`)
  })
}

describe("S11 over the real files, changed to have its cases", () => {
  it.skipIf(!CORPUS)(
    "the editor's nets equal the independent derivation of every changed file",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "s11-corpus-"))
      let n = 0
      const rows: { mutation: string; files: number; changed: number; imported: number; flagged: number; equal: number; unflaggedWouldDiffer: number; problems: string[] }[] = []
      for (const [mutation, change] of [["no junctions", (t: string) => without(t, "junction")], ["nudged ends", nudged]] as const) {
        const row = { mutation, files: 0, changed: 0, imported: 0, flagged: 0, equal: 0, unflaggedWouldDiffer: 0, problems: [] as string[] }
        for (const path of walk(CORPUS!)) {
          let text: string
          try {
            text = readFileSync(path, "utf8")
            const { schematic } = readKicadSchematic(new Uint8Array(Buffer.from(text)))
            // flat sheets with wires: a hierarchy is read with its sheets, which the changed copy would not have
            if (schematic.sheets.length || schematic.buses.length || !schematic.wires.length) continue
          } catch {
            continue
          }
          row.files++
          const changed = change(text)
          if (changed === text) continue
          row.changed++
          const folder = join(dir, `t${n++}`)
          mkdirSync(folder)
          const file = join(folder, "root.kicad_sch")
          writeFileSync(file, changed)
          const imported = importKicadSchematic(new Uint8Array(Buffer.from(changed)), { built: BUILT })
          if (imported.status !== "imported") continue
          row.imported++
          const project = imported.project
          const flagged = !!project.sheets?.some((s) => s.kicadRules)
          if (flagged) row.flagged++
          // Every pin the editor has a port for, by the path KiCad gives its symbol and the pin's number, in the groups of the editor's connectivity and of the derivation
          // (the same comparison as the corpus test's: a pin of a unit is the unit symbol's own, not also the part's).
          const symOf = new Map([...imported.build.byRecord].map(([rec, c]) => [c.id, rec]))
          const universe: string[] = []
          const netOf = (p: Project) => {
            const { pinNet } = computeConnectivity(p)
            const members = new Map<string, string[]>()
            const of = new Map<string, string | undefined>()
            for (const c of p.components) {
              const rec = symOf.get(c.id)
              if (!rec) continue
              for (const pin of schematicPins(c)) {
                const k = `${rec.path}#${pin.pin}`
                const net = pinNet.get(pinKey(c.id, pin.pin))
                of.set(k, net)
                if (net) (members.get(net) ?? members.set(net, []).get(net)!).push(k)
              }
            }
            return (k: string) => (of.get(k) ? [...members.get(of.get(k)!)!].sort().join(" ") : k)
          }
          for (const c of project.components) {
            const rec = symOf.get(c.id)
            if (rec) for (const pin of schematicPins(c)) universe.push(`${rec.path}#${pin.pin}`)
          }
          const derived = deriveNets(file, { hiddenPower: true, localJoinsGlobal: "same" })
          const inUniverse = new Set(universe)
          const byGroup = new Map<number, string[]>()
          for (const [key, g] of derived.pins) for (const x of ([] as number[]).concat(g)) if (inUniverse.has(key)) (byGroup.get(x) ?? byGroup.set(x, []).get(x)!).push(key)
          const theirsOf = (k: string) => {
            const g = ([] as number[]).concat(derived.pins.get(k) ?? [])[0]
            return g === undefined ? k : [...new Set(byGroup.get(g)!)].sort().join(" ")
          }
          const mineOf = netOf(project)
          const same = universe.every((k) => mineOf(k) === theirsOf(k))
          const plainOf = netOf({ ...project, sheets: project.sheets?.map(({ kicadRules: _k, ...rest }) => rest) })
          const plainSame = universe.every((k) => plainOf(k) === theirsOf(k))
          if (same) row.equal++
          else row.problems.push(path.slice(CORPUS!.length + 1).split(sep).join("/"))
          if (flagged && !plainSame) row.unflaggedWouldDiffer++
        }
        rows.push(row)
      }
      const out = process.env.KICAD_CORPUS_OUT ?? dir
      mkdirSync(out, { recursive: true })
      writeFileSync(join(out, "s11-corpus-summary.json"), JSON.stringify(rows, null, 1))
      console.log(JSON.stringify(rows))
      for (const row of rows) {
        expect(row.problems, row.mutation).toEqual([])
        expect(row.imported, row.mutation).toBeGreaterThan(20)
        expect(row.flagged, row.mutation).toBeGreaterThan(0)
        expect(row.equal, row.mutation).toBe(row.imported)
      }
    },
    900_000,
  )
})
