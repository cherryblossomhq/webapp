// Which extensions each board needs to import exactly, and what share of the corpus each slice of
// the plan can therefore import without an approximation.
//
//   node tests/kicad-census/slices.mjs <census-out>
//
// A board "needs" an extension when it holds something the model cannot represent exactly today
// (section 5 of `docs/kicad-import.md`). The rules are stated in `needs` below, so a critic can
// argue with a rule rather than with a number. A slice passes a board when every extension the
// board needs has been built; until then the importer says "this board uses X, which is not
// supported yet" and imports nothing lossy.

import { readFileSync } from "node:fs"
import { join } from "node:path"
import { estimateBytes } from "./size.mjs"
import { needs } from "./needs.mjs"

const CAP = 900 * 1024

const [, , dir] = process.argv
const boards = JSON.parse(readFileSync(join(dir, "boards.json"), "utf8"))
const REAL = ["pcbench", "github", "kicad-demos"]
const real = boards.filter((b) => REAL.includes(b.group))

for (const b of boards) b.estJsonBytes = estimateBytes(b)

const plan = [
  ["1a reader, report, nets, generated schematic, X13 deferred", []],
  ["1b + X9 text, X8 graphics, X15 footprint flags, X13 nets on copper", ["X9", "X8", "X15", "X13"]],
  ["1c + X2 outline, X6 free angles, X7 pads", ["X2", "X6", "X7"]],
  ["1d + X3 zones, X10 net classes, X11 dimensions, X12 groups, X14 images", ["X3", "X10", "X11", "X12", "X14"]],
  ["1e + X16 writer and the round trip (adds no board)", []],
  ["2 + X1 layers, X5 via spans, X4 arc tracks", ["X1", "X5", "X4"]],
  ["3 + X19 to X23 (text outlines, rule areas, tuning, drill specs, variants)", ["X19", "X20", "X21", "X22", "X23"]],
]

const pct = (k, n) => `${k} (${((100 * k) / n).toFixed(1)}%)`
const sets = {
  "all real": real,
  "real, 2 copper layers": real.filter((b) => b.copperLayersDeclared === 2),
  "pcbench": real.filter((b) => b.group === "pcbench"),
  "github + demos": real.filter((b) => b.group !== "pcbench"),
}
console.log("| slice (cumulative) | " + Object.entries(sets).map(([k, v]) => `${k} (${v.length})`).join(" | ") + " |")
console.log("|---|" + Object.keys(sets).map(() => "---|").join(""))
const built = new Set()
for (const [label, add] of plan) {
  for (const x of add) built.add(x)
  const cells = Object.values(sets).map((s) => pct(s.filter((b) => [...needs(b).keys()].every((x) => built.has(x))).length, s.length))
  console.log(`| ${label} | ${cells.join(" | ")} |`)
}

console.log("\nBoards that need each extension (real):")
const tally = new Map()
for (const b of real) for (const x of needs(b).keys()) tally.set(x, (tally.get(x) ?? 0) + 1)
console.log([...tally.entries()].sort((a, b) => +a[0].slice(1) - +b[0].slice(1)).map(([x, c]) => `${x} ${c} (${((100 * c) / real.length).toFixed(1)}%)`).join(", "))
console.log(`\nboards that need nothing today: ${real.filter((b) => needs(b).size === 0).length}`)
const only = new Map()
for (const b of real) {
  const k = [...needs(b).keys()].sort().join("+")
  only.set(k, (only.get(k) ?? 0) + 1)
}
console.log("most common needs sets:", [...only.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `${k || "(none)"}: ${v}`).join("; "))
const over = real.filter((b) => b.estJsonBytes > CAP)
console.log(`\nestimated over the 900 KiB cap: ${over.length}; largest ${(Math.max(...real.map((b) => b.estJsonBytes)) / 1048576).toFixed(1)} MiB`)
const status = {}
for (const b of real) status[b.outline.status] = (status[b.outline.status] ?? 0) + 1
console.log("outline status of the real boards:", JSON.stringify(status))
const refused = real.filter((b) => needs(b).has("REFUSED"))
console.log(`refused for good (the 900 KiB size limit, by the census's estimate): ${refused.length} (${((100 * refused.length) / real.length).toFixed(1)}%); outlines that do not close or are missing, imported with X2: ${real.filter((b) => b.outline.status !== "closed").length}`)
const closedNotRep = real.filter((b) => b.outline.status === "closed" && !b.outline.representable).length
console.log(`closed outlines the model cannot hold yet (X2): ${closedNotRep}; representable today: ${real.filter((b) => b.outline.representable).length}`)
const exactEnd = real.filter((b) => !needs(b).has("REFUSED"))
console.log(`the most any phase can import exactly: ${exactEnd.length} (${((100 * exactEnd.length) / real.length).toFixed(1)}%)`)
