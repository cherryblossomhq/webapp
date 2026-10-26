// The layers oracle (X1, X4, X5): what a KiCad board file says of its copper layers, its stackup, its arc tracks, its vias and its padstacks, read straight from the text with the
// census's own s-expression reader. It shares no code with `src`: the importer's answers are compared with these in `tests/kicad-layers-check.ts`.
//
// Layers are told by position, as KiCad's own reader does: the front layer first, the back layer last, the inner layers between them by their number (In1.Cu, In2.Cu, ...).

import { parseSexpr } from "./sexpr.mjs"

const kids = (n, name) => n.filter((c) => Array.isArray(c) && c[0] === name)
const kid = (n, name) => n.find((c) => Array.isArray(c) && c[0] === name)
const num = (v) => Number(v)

/** The copper layers of a board file, in stack order, each with the name the file gives it and the label of its fourth column. */
export function copperTable(root) {
  const table = kid(root, "layers")
  const rows = []
  if (!table) return rows
  // KiCad reads the copper rows of the table in the order written: the first is the front layer, the last the back, the others the inner layers between them (a legacy file names
  // them Front, GND.Cu, Back). A copper row is one typed signal, power, mixed or jumper.
  for (const r of table.slice(1)) {
    if (!Array.isArray(r)) continue
    const [id, name, type, label] = r
    if (typeof name === "string" && ["signal", "power", "mixed", "jumper"].includes(type)) rows.push({ id: num(id), name, type, label: typeof label === "string" ? label : undefined })
  }
  return rows
}

/** The ids the project gives the layers: top, in1.., bottom. */
const idsOf = (count) => Array.from({ length: count }, (_, i) => (i === 0 ? "top" : i === count - 1 ? "bottom" : `in${i}`))

const circle = (a, m, b) => {
  const d = 2 * (a[0] * (m[1] - b[1]) + m[0] * (b[1] - a[1]) + b[0] * (a[1] - m[1]))
  if (Math.abs(d) < 1e-12) return null
  const ux = ((a[0] ** 2 + a[1] ** 2) * (m[1] - b[1]) + (m[0] ** 2 + m[1] ** 2) * (b[1] - a[1]) + (b[0] ** 2 + b[1] ** 2) * (a[1] - m[1])) / d
  const uy = ((a[0] ** 2 + a[1] ** 2) * (b[0] - m[0]) + (m[0] ** 2 + m[1] ** 2) * (a[0] - b[0]) + (b[0] ** 2 + b[1] ** 2) * (m[0] - a[0])) / d
  return [ux, uy, Math.hypot(a[0] - ux, a[1] - uy)]
}

/** The length of the arc through three points: the radius times the sweep that passes through the middle one. */
export function arcLength(a, m, b) {
  const c = circle(a, m, b)
  if (!c) return Math.hypot(b[0] - a[0], b[1] - a[1])
  const TAU = Math.PI * 2
  const ang = (p) => Math.atan2(p[1] - c[1], p[0] - c[0])
  const norm = (x) => ((x % TAU) + TAU) % TAU
  const toM = norm(ang(m) - ang(a))
  const toB = norm(ang(b) - ang(a))
  const sweep = toM <= toB ? toB : TAU - toB
  return c[2] * (sweep === 0 ? TAU : sweep)
}

const pt = (n, name) => {
  const k = kid(n, name)
  return k ? [num(k[1]), num(k[2])] : null
}

/** Everything a board file says about layers. */
export function layersOracle(text) {
  const root = parseSexpr(text)[0]
  if (!Array.isArray(root) || root[0] !== "kicad_pcb") return null
  const copper = copperTable(root)
  const ids = idsOf(copper.length)
  const idOf = new Map(copper.map((r, i) => [r.name, ids[i]]))
  const setup = kid(root, "setup")
  const stackup = setup ? kid(setup, "stackup") : undefined
  // KiCad's parser (parseBoardStackup) takes the rows in order: a surface layer (a copper, silkscreen, mask or paste layer) listed a second time is a stackup appended to itself (KiCad's own
  // test `Issue23625_CorruptedStackup` has one of 605 rows that grew by being saved again), and it and every row after it are not part of the stackup; at most 128 rows are kept.
  const stackRows = []
  if (stackup) {
    const seen = new Set()
    for (const r of kids(stackup, "layer")) {
      const name = typeof r[1] === "string" ? r[1] : ""
      if (seen.has(name) && /\.(Cu|SilkS|Mask|Paste)$/.test(name)) break
      seen.add(name)
      if (stackRows.length < 128) stackRows.push(r)
    }
  }
  // the thickness of a row is every `thickness` it has: a dielectric of several sublayers writes the word `addsublayer` and then the next sublayer's fields in the same row
  let thickness = 0
  for (const r of stackRows) for (const t of kids(r, "thickness")) thickness += num(t[1])
  const arcs = kids(root, "arc")
  const segments = kids(root, "segment")
  let arcLen = 0
  const arcKeys = []
  for (const a of arcs) {
    const s = pt(a, "start")
    const m = pt(a, "mid")
    const e = pt(a, "end")
    if (!s || !m || !e) continue
    arcLen += arcLength(s, m, e)
    const layer = kid(a, "layer")
    arcKeys.push(`${idOf.get(layer?.[1]) ?? "?"}|${s.map((v) => v.toFixed(3))}|${e.map((v) => v.toFixed(3))}`)
  }
  let segLen = 0
  for (const s of segments) {
    const a = pt(s, "start")
    const b = pt(s, "end")
    if (a && b) segLen += Math.hypot(b[0] - a[0], b[1] - a[1])
  }
  const innerOnly = (n) => n !== "top" && n !== "bottom"
  const vias = []
  for (const v of kids(root, "via")) {
    const at = pt(v, "at")
    const l = kid(v, "layers")
    const words = v.filter((c) => typeof c === "string")
    const names = l ? l.slice(1).filter((x) => typeof x === "string") : []
    const a = idOf.get(names[0])
    const b = idOf.get(names[1])
    let kind = "through"
    if (words.includes("micro")) kind = "micro"
    else if (words.includes("buried")) kind = "buried"
    else if (words.includes("blind")) kind = "blind"
    // KiCad 9 writes `blind` for a via between two inner layers: that is a buried via
    if (kind === "blind" && a && b && innerOnly(a) && innerOnly(b)) kind = "buried"
    const ends = a && b ? [a, b].sort((x, y) => ids.indexOf(x) - ids.indexOf(y)) : []
    vias.push({ key: `${kind}|${at ? at.map((n) => n.toFixed(3)) : ""}|${kind === "through" ? "" : ends.join(">")}`, kind })
  }
  // pads that say their copper layer by layer
  let padstacks = 0
  for (const fp of kids(root, "footprint")) {
    for (const pad of kids(fp, "pad")) {
      const ps = kid(pad, "padstack")
      const mode = ps ? kid(ps, "mode") : undefined
      if (mode && (mode[1] === "front_inner_back" || mode[1] === "custom")) padstacks++
    }
  }
  return { copper, ids, stackRows: stackRows.length, thickness, arcs: arcs.length, arcLen, arcKeys, segments: segments.length, segLen, vias, padstacks }
}
