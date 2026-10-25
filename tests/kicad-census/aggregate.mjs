// Turns the census's per-board records into the tables of the gap list.
//
//   node tests/kicad-census/aggregate.mjs <out-dir> [set]
//
// `set` is `real` (default: every board but KiCad's own regression files), `all`, or a group:
// `pcbench`, `github`, `kicad-demos`, `kicad-qa`. The regression files are kept out of the headline
// numbers because KiCad wrote them to exercise odd features, so they would inflate every rate.

import { readFileSync } from "node:fs"
import { join } from "node:path"

const [, , dir, setName = "real"] = process.argv
const boards = JSON.parse(readFileSync(join(dir, "boards.json"), "utf8"))
const pick = {
  real: (b) => !["kicad-qa", "github-targeted"].includes(b.group),
  all: () => true,
}
const set = boards.filter(pick[setName] ?? ((b) => b.group === setName))
const N = set.length
const pct = (n) => `${((100 * n) / N).toFixed(1)}%`
const row = (label, n) => console.log(`| ${label} | ${n} | ${pct(n)} |`)
const tally = (f) => {
  const m = new Map()
  for (const b of set) {
    const keys = f(b)
    for (const k of Array.isArray(keys) ? keys : [keys]) m.set(k, (m.get(k) ?? 0) + 1)
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1])
}
const table = (title, entries) => {
  console.log(`\n### ${title} (set: ${setName}, ${N} boards)\n\n| value | boards | % |\n|---|---|---|`)
  for (const [k, n] of entries) row(k, n)
}
const sum = (f) => set.reduce((s, b) => s + f(b), 0)

console.log(`# Census aggregate: set ${setName}, ${N} boards, ${(sum((b) => b.bytes) / 1e6).toFixed(0)} MB of board files`)
table("By group", tally((b) => b.group))
table("By KiCad release (from the version stamp)", tally((b) => b.era))
table("By exact version stamp", tally((b) => String(b.version)))
table("Generator", tally((b) => `${b.generator}${b.generatorVersion ? " " + b.generatorVersion : ""}`).slice(0, 12))
table("Footprint token", tally((b) => (b.hasLegacyModuleToken ? "(module ...)" : b.hasModernFootprintToken ? "(footprint ...)" : "no footprints")))
table("Copper layers declared", tally((b) => String(b.copperLayersDeclared)))
table("Copper layers actually carrying copper", tally((b) => String(b.copperLayersUsed)))
table("Copper layers declared but unused inner", tally((b) => (b.copperLayersDeclared > 2 && b.innerUsed.length === 0 ? "declared >2, no inner copper" : "other")))
table("Outline shape (the largest closed loop of Edge.Cuts)", tally((b) => b.outline.shape))
table("Outline: has cutouts inside", tally((b) => (b.outline.cutouts > 0 ? "cutouts" : "none")))
table("Outline: more than one separate outer loop", tally((b) => (b.outline.outerLoops > 1 ? "several outer loops" : "one or none")))
table("Outline: open or broken chain", tally((b) => (b.outline.openChains > 0 ? "open chain" : "closed")))
table("Outline graphic kinds present", tally((b) => b.outline.kinds))
table("Boards with Edge.Cuts graphics inside footprints", tally((b) => (Object.keys(b.gfx).some((k) => k.startsWith("fp:") && k.endsWith("@edge")) ? "yes" : "no")))
table("Zones: boards with any zone", tally((b) => (b.zones.total ? "has zones" : "no zones")))
table("Zone kinds (boards having each)", tally((b) => Object.keys(b.zones.kinds).filter((k) => !k.startsWith("connect:") && !k.startsWith("smoothing:") && !k.startsWith("outline-hatch:") && !["island-flag", "locked", "named"].includes(k))))
table("Zone extras", tally((b) => [b.zones.filled ? "filled copper zone" : null, b.zones.unfilled ? "unfilled copper zone" : null, b.zones.priorities ? "priority > 0" : null, b.zones.multiLayer ? "multi-layer zone" : null, b.zones.hatched ? "hatched fill" : null, b.zones.polyArcs ? "arcs in zone outline" : null, b.zones.teardrop ? "teardrop zone" : null, b.zones.noNet ? "copper zone with no net" : null].filter(Boolean)))
table("Zone connect and smoothing", tally((b) => Object.keys(b.zones.kinds).filter((k) => k.startsWith("connect:") || k.startsWith("smoothing:") || k.startsWith("outline-hatch:") || ["island-flag", "locked", "named"].includes(k))))
table("Tracks: arcs and vias", tally((b) => [b.tracks.arcs ? "arc tracks" : null, b.tracks.segments ? "straight tracks" : null, ...Object.keys(b.tracks.viaKinds).map((k) => `via:${k}`)].filter(Boolean)))
table("Pads by type and shape (boards having each)", tally((b) => Object.keys(b.pads.byShape)))
table("Pad drills", tally((b) => Object.keys(b.pads.drill)))
table("Pad features (boards having each)", tally((b) => Object.keys(b.pads.flags)))
table("Footprints: angle", tally((b) => [b.fps.angle.other ? "a footprint at a non-quarter angle" : null, b.fps.bottom ? "a footprint on the bottom" : null, b.fps.zones ? "zone inside a footprint" : null, b.fps.groups ? "group inside a footprint" : null, b.fps.withModels ? "3D model reference" : null].filter(Boolean)))
table("Footprint attributes", tally((b) => Object.keys(b.fps.attr)))
table("Graphics (board: and fp: by layer class), boards having each", tally((b) => Object.keys(b.gfx)))
table("Stackup", tally((b) => (b.stackup ? "has stackup block" : "no stackup block")))
table("Net names", tally((b) => [b.nets.unnamed ? "Net-(...) names" : null, b.nets.hierarchical ? "hierarchical /names" : null, b.nets.classes ? "net_class in the board file" : null, b.nets.autoUnconnected ? "unconnected-(...) nets" : null].filter(Boolean)))
table("Companion files in the same folder", tally((b) => b.companions.map((c) => c.replace(/^.*\./, ".").replace(/^.*-cache\.lib$/, "-cache.lib")).filter((v, i, a) => a.indexOf(v) === i)))

// sizes
const sizeBuckets = [
  ["pads < 100", (b) => b.pads.total < 100],
  ["pads 100 to 499", (b) => b.pads.total >= 100 && b.pads.total < 500],
  ["pads 500 to 1999", (b) => b.pads.total >= 500 && b.pads.total < 2000],
  ["pads >= 2000", (b) => b.pads.total >= 2000],
]
table("Pad count", sizeBuckets.map(([l, f]) => [l, set.filter(f).length]))
const sorted = (f) => set.map(f).sort((a, b) => a - b)
const q = (a, p) => a[Math.min(a.length - 1, Math.floor((p * a.length) / 100))]
for (const [label, f] of [["pads", (b) => b.pads.total], ["footprints", (b) => b.fps.total], ["segments", (b) => b.tracks.segments], ["vias", (b) => b.tracks.vias], ["file bytes", (b) => b.bytes]]) {
  const a = sorted(f)
  console.log(`\n${label}: median ${q(a, 50)}, p90 ${q(a, 90)}, p99 ${q(a, 99)}, max ${a[a.length - 1]}`)
}

// evidence
console.log("\n### Pad frame evidence (track ends that land on a pad centre of the same net)\n")
const ev = {}
for (const b of set) {
  for (const [k, v] of Object.entries(b.evidence)) {
    const key = `${b.era}|${k}`
    ev[key] = ev[key] ?? {}
    for (const [n, c] of Object.entries(v)) ev[key][n] = (ev[key][n] ?? 0) + c
  }
}
for (const k of Object.keys(ev).sort()) console.log(k, JSON.stringify(ev[k]))
console.log("\n### Pad angle versus footprint angle (footprint turned only)\n")
const pa = {}
for (const b of set) for (const [k, v] of Object.entries(b.pads.angle)) pa[k] = (pa[k] ?? 0) + v
for (const k of Object.keys(pa).sort()) console.log(k, pa[k])

// PCBench metadata against the census
if (setName === "pcbench" || setName === "real" || setName === "all") {
  const pb = set.filter((b) => b.pcbenchMeta)
  console.log(`\n### PCBench metadata vs census (${pb.length} boards)\n`)
  const m = new Map()
  for (const b of pb) {
    const k = `meta layers ${b.pcbenchMeta.layers} -> census declared ${b.copperLayersDeclared}, used ${b.copperLayersUsed}`
    m.set(k, (m.get(k) ?? 0) + 1)
  }
  for (const [k, n] of [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14)) console.log(n, k)
  const cad = new Map()
  for (const b of pb) {
    const k = `meta '${b.pcbenchMeta.cad}' -> stamp ${b.version}`
    cad.set(k, (cad.get(k) ?? 0) + 1)
  }
  for (const [k, n] of [...cad.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14)) console.log(n, k)
}
