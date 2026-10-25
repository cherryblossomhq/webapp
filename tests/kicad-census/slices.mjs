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

const [, , dir] = process.argv
const boards = JSON.parse(readFileSync(join(dir, "boards.json"), "utf8"))
const REAL = ["pcbench", "github", "kicad-demos"]
const real = boards.filter((b) => REAL.includes(b.group))

const has = (b, re) => Object.keys(b.nodes).some((k) => re.test(k.replace(/^module/, "footprint")))
const flag = (b, name) => (b.pads.flags[name] ?? 0) > 0
const CAP = 900 * 1024

/** The extensions a board needs, with the reason for each. */
export function needs(b) {
  const n = new Map()
  const need = (x, why) => n.has(x) || n.set(x, why)
  if (b.copperLayersDeclared > 2 || b.undeclaredCopperLayers.length) need("X1", "more than two copper layers, or copper on a layer the table lacks")
  // Refused for good, with a message, and never an approximation: an outline that still does not
  // close after the repair (merge overlapping and collinear pieces, drop pieces shorter than 0.1 mm,
  // join ends within 0.1 mm), a board with no Edge.Cuts at all, and a project that measures over
  // the 900 KiB limit with `serializeProject` (`estJsonBytes` stands in for that measurement here).
  if (b.outline.status !== "closed") need("REFUSED", `outline: ${b.outline.status}`)
  else if (!b.outline.representable) need("X2", `outline is ${b.outline.shape}${b.outline.cutouts ? " with cutouts" : ""}`)
  if (b.estJsonBytes > CAP) need("REFUSED", "over the 900 KiB project limit")
  if (b.zones.total > 0) need("X3", "has zones (a board-sized pour with the board's own settings would map today, but whether the settings equal the defaults is not checked)")
  if (b.zones.teardrop || has(b, /^general>legacy_teardrops/)) need("X3", "teardrops")
  if (b.tracks.arcs > 0) need("X4", "arc tracks")
  if (Object.keys(b.tracks.viaKinds).some((k) => ["blind", "micro", "buried", "through-but-partial-span", "padstack-node"].includes(k)) || has(b, /^via>(free|tenting|remove_unused_layers|keep_end_layers|padstack)/)) need("X5", "via spans or via stacks")
  if (b.fps.angle.other > 0 || b.fps.transformed) need("X6", "a footprint off a quarter turn")
  const anyShape = (suffix) => Object.keys(b.pads.byShape).some((k) => k.endsWith(suffix))
  if (flag(b, "non-quarter-angle") || anyShape(":roundrect") || anyShape(":custom") || flag(b, "chamfer") || b.pads.drill["round+offset"] || b.pads.drill["oval+offset"] || flag(b, "smd-on-the-other-side-of-its-footprint") || flag(b, "no-copper-layer") || ["solder_mask_margin", "solder_paste_margin", "solder_paste_margin_ratio", "clearance", "zone_connect", "thermal_gap", "thermal_width", "thermal_bridge_width", "padstack", "remove_unused_layers"].some((f) => flag(b, f)) || has(b, /^footprint>(clearance|solder_mask_margin|solder_paste_margin|solder_paste_margin_ratio|zone_connect)$/) || has(b, /^footprint>pad>property/)) need("X7", "rotated, rounded or custom pads, offset holes, pads on the other side, per-pad margins")
  const shapeGfx = Object.keys(b.gfx).some((k) => /^(board|fp):(line|arc|circle|rect|poly|curve)@/.test(k) && !k.endsWith("@edge"))
  if (shapeGfx || b.fps.padless > 0 || has(b, /^target/)) need("X8", "graphics beyond the editor's silk polylines, or footprints with no pads")
  if (b.fps.total > 0 || has(b, /^gr_text/)) need("X9", "reference and value text of every footprint, board text")
  if (b.nets.classes > 1) need("X10", "net classes beyond Default")
  if (has(b, /^(footprint>)?dimension$/)) need("X11", "dimensions")
  if (has(b, /^(footprint>)?group$/)) need("X12", "groups")
  if (b.tracks.segments + b.tracks.vias > 0) need("X13", "tracks and vias carry a net in the file")
  if (has(b, /^image$/)) need("X14", "reference image")
  if (Object.keys(b.fps.attr).some((a) => !["smd", "through_hole", "(none)"].includes(a)) || has(b, /^footprint>(net_tie_pad_groups|jumper_pad_groups|duplicate_pad_numbers_are_jumpers)/)) need("X15", "footprint flags or net ties")
  if (has(b, /render_cache$/) || has(b, /^(footprint>)?embedded_fonts$/)) need("X19", "TrueType text outlines or embedded fonts")
  if (has(b, /^(footprint>)?zone>placement$/) || has(b, /^footprint>component_classes$/)) need("X20", "placement rule areas or component classes")
  if (has(b, /^generated$/) || has(b, /^footprint>pad>(die_length|die_delay)$/)) need("X21", "tuning patterns or pad lengths")
  if (has(b, /^via>(capping|covering|plugging|filling|backdrill|tertiary_drill)/) || has(b, /^footprint>pad>(backdrill|tertiary_drill|front_post_machining|back_post_machining)/)) need("X22", "via protection or backdrill")
  if (has(b, /^(variants|footprint>variant|footprint>units|footprint>point)/)) need("X23", "variants, units or points")
  return n
}

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
console.log(`refused for good: ${refused.length} (${((100 * refused.length) / real.length).toFixed(1)}%): outline ${real.filter((b) => b.outline.status !== "closed").length}, size ${over.length}`)
const closedNotRep = real.filter((b) => b.outline.status === "closed" && !b.outline.representable).length
console.log(`closed outlines the model cannot hold yet (X2): ${closedNotRep}; representable today: ${real.filter((b) => b.outline.representable).length}`)
const exactEnd = real.filter((b) => !needs(b).has("REFUSED"))
console.log(`the most any phase can import exactly: ${exactEnd.length} (${((100 * exactEnd.length) / real.length).toFixed(1)}%)`)
