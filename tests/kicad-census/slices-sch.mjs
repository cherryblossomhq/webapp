// Which schematic extensions each `.kicad_sch` file needs to import exactly, and the share of
// the real files each schematic slice therefore imports without an approximation.
//
//   node tests/kicad-census/slices-sch.mjs <census-out>
//
// The same idea as `slices.mjs`. Every file with symbols needs S5 (each symbol's fields have their
// own place), S6 (symbol drawings use fills and strokes the editor's primitives lack) and S10 (a
// cached symbol must be stored somewhere), so no file passes before those three are built.

import { readFileSync } from "node:fs"
import { join } from "node:path"
import { needsSch } from "./needs-sch.mjs"

const [, , dir] = process.argv
const files = JSON.parse(readFileSync(join(dir, "sidecars.json"), "utf8")).filter((r) => r.kind === "kicad_sch")
const real = files.filter((f) => ["pcbench", "github", "kicad-demos"].includes(f.group))

const plan = [
  ["3a reader, linking, symbol sources, wires and local labels", []],
  ["3b + S5 units and fields, S6 symbol graphics, S7 flags, S10 symbol storage, S4 annotations, S2 labels and net names", ["S5", "S6", "S7", "S10", "S4", "S2"]],
  ["3c + S1 hierarchical sheets", ["S1"]],
  ["3d + S3 buses, S8 directive labels and rule areas, S9 variants", ["S3", "S8", "S9"]],
]
const built = new Set()
console.log(`| slice (cumulative) | real .kicad_sch files (${real.length}) |\n|---|---|`)
for (const [label, add] of plan) {
  for (const x of add) built.add(x)
  const ok = real.filter((f) => [...needsSch(f.d)].every((x) => built.has(x))).length
  console.log(`| ${label} | ${ok} (${((100 * ok) / real.length).toFixed(1)}%) |`)
}
const tally = new Map()
for (const f of real) for (const x of needsSch(f.d)) tally.set(x, (tally.get(x) ?? 0) + 1)
console.log("\nfiles needing each:", [...tally.entries()].sort().map(([x, c]) => `${x} ${c}`).join(", "))
const sch = real.filter((f) => f.d.symbols > 0)
console.log(`files with symbols ${sch.length}; with a multi-unit or body-style-2 symbol ${sch.filter((f) => f.d.multiUnitSymbols).length}; mirrored ${sch.filter((f) => f.d.mirroredSymbols).length}; alternate pins ${sch.filter((f) => f.d.alternatePins).length}; library symbols with units ${sch.reduce((a, f) => a + f.d.libSymbolsWithUnits, 0)}`)
