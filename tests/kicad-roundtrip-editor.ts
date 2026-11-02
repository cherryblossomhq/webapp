import { kicadFiles } from "../src/export/kicad"
import { computeConnectivity } from "../src/model/connectivity"
import { importKicadProject, type ProjectFile } from "../src/model/kicad/project"
import { findPart } from "../src/model/library"
import { componentModel } from "../src/model/models3d"
import { componentFields, hasFieldPlaces, pinTexts, symbolOf, symbolTextOnSheet, unitCount, unitLetters } from "../src/model/symbolDrawing"
import { pcbPads, powerNetName, schematicBounds, schematicPins, valueText } from "../src/model/instances"
import type { ComponentInstance, DrawingText, Project } from "../src/model/types"
import { registerProjectParts } from "../src/model/customParts"
import { matchLcsc, type LcscLookup, type LcscStats } from "../src/model/lcscMatch"

// A project made in the editor, written by the KiCad export and read again by the KiCad import, compared field by field. The schematic is judged by what is
// drawn on the sheet (every text, symbol and label, in sheet coordinates), the board by what a footprint is (its pads, its 3D model, the part's data).
// A "loss" is one thing the first project has that the second does not (or has changed); `kind` is the table row, `detail` names the item.

export interface Loss {
  kind: string
  detail: string
}

export interface Trip {
  before: Project
  after: Project
  notes: string[]
  report: unknown
}

export async function exportAndImport(project: Project, lcsc?: LcscLookup): Promise<Trip & { lcscStats: LcscStats | null }> {
  const out = await kicadFiles(project)
  const files: ProjectFile[] = Object.entries(out.files).map(([path, data]) => ({ path, data }))
  const r = importKicadProject(files)
  if (r.status !== "imported") throw new Error(`the export did not import (${r.reason}): ${r.message}`)
  registerProjectParts(r.project)
  // The step the page runs after an import (it needs the network, so the importer does not): the LCSC numbers looked up, through the lookup it is given.
  const matched = lcsc ? await matchLcsc(r.project, lcsc) : null
  if (matched) registerProjectParts(matched.project)
  return { before: project, after: matched?.project ?? r.project, notes: out.notes, report: r.report, lcscStats: matched?.stats ?? null }
}

// ---------- the texts on a sheet ----------

export interface SheetText {
  /** What it is: `reference U1`, `value R1`, `pin U1`, `pinNumber U1`, `label`, `text`. */
  key: string
  text: string
  x: number
  y: number
  /** Which way it extends from its anchor, as the renderer takes it. */
  ex: number
  ey: number
  vertical: boolean
  size: number
  hidden: boolean
}

const SCH_DEFAULT = 0.1

/** Every text a component writes on the sheet, in sheet coordinates: its fields and pin names and numbers, or the texts of its symbol when it has no fields of its own. */
function componentTexts(c: ComponentInstance): SheetText[] {
  const part = findPart(c.partId)
  if (!part) return []
  const out: SheetText[] = []
  const imported = hasFieldPlaces(part) || !!(c.fields && Object.keys(c.fields).length)
  const symbol = symbolOf(part, c)
  if (imported) {
    for (const f of componentFields(c, part)) out.push({ key: `${f.name.toLowerCase()} ${c.ref}`, text: f.text, x: c.sch.x + f.place.x, y: c.sch.y + f.place.y, ex: f.extent.x, ey: f.extent.y, vertical: f.vertical, size: f.place.size ?? SCH_DEFAULT, hidden: false })
    const pn = powerNetName(c, part)
    void pn
    for (const l of symbol.pinLabels ?? []) {
      for (const t of pinTexts(l, c.sch, symbol.pinNameOffset ?? 0)) {
        const h = t.h === "left" ? 1 : t.h === "right" ? -1 : 0
        out.push({ key: `symbol text ${c.ref}`, text: t.text, x: c.sch.x + t.x, y: c.sch.y + t.y, ex: t.angle === 90 ? 0 : h, ey: t.angle === 90 ? h : 0, vertical: t.angle === 90, size: t.size, hidden: false })
      }
    }
    for (const p of symbol.primitives) {
      if (p.type !== "text" || !p.text) continue
      const place = symbolTextOnSheet(p, c.sch)
      out.push({ key: `symbol text ${c.ref}`, text: p.text, x: c.sch.x + place.at.x, y: c.sch.y + place.at.y, ex: place.extent.x, ey: place.extent.y, vertical: place.vertical, size: p.size ?? SCH_DEFAULT, hidden: false })
    }
    return out
  }
  const power = powerNetName(c, part)
  for (const p of symbol.primitives) {
    if (p.type !== "text") continue
    const text = p.role === "ref" ? (power ?? (unitCount(part) > 1 ? c.ref + unitLetters(c.unit ?? 1) : c.ref)) : p.role === "value" ? (power ? "" : valueText(c, part)) : p.text
    if (!text) continue
    const place = symbolTextOnSheet(p, c.sch)
    out.push({ key: `${p.role === "ref" ? "reference" : p.role === "value" ? "value" : "symbol text"} ${c.ref}`, text, x: c.sch.x + place.at.x, y: c.sch.y + place.at.y, ex: place.extent.x, ey: place.extent.y, vertical: place.vertical, size: p.size ?? SCH_DEFAULT, hidden: false })
  }
  return out
}

export function sheetTexts(p: Project): SheetText[] {
  const out: SheetText[] = []
  for (const c of p.components) out.push(...componentTexts(c))
  for (const l of p.labels) out.push({ key: "label", text: l.name, x: l.x, y: l.y, ex: 0, ey: 0, vertical: l.rot === 90 || l.rot === 270, size: l.look?.size ?? SCH_DEFAULT, hidden: false })
  for (const d of p.drawings ?? []) if (d.type === "text") out.push(drawingText(d))
  return out
}

function drawingText(d: DrawingText): SheetText {
  return { key: "text", text: d.text, x: d.x, y: d.y, ex: d.align === "center" ? 0 : d.align === "right" ? -1 : 1, ey: 0, vertical: d.rot === 90 || d.rot === 270, size: d.size, hidden: !!d.hidden }
}

// ---------- the comparison ----------

/** The kind of a text from its key: everything before the designator. */
const kindOf = (key: string) => (/ #/.test(key) ? "power net" : key.includes(" ") ? key.slice(0, key.lastIndexOf(" ")) : key)

const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol

/** The part a component stands for: what is the same project over a trip (the library may have renamed it). */
const refKey = (c: ComponentInstance) => `${c.ref}${c.unit && c.unit > 1 ? `/${c.unit}` : ""}`

/** The sheet moves as a whole in the file (it is centred on a page): the shift is what most parts agree on. */
function shiftOf(before: Project, after: Project): { dx: number; dy: number } {
  const b = new Map(before.components.map((c) => [refKey(c), c]))
  const votes = new Map<string, { n: number; dx: number; dy: number }>()
  for (const a of after.components) {
    const o = b.get(refKey(a))
    if (!o) continue
    const dx = Math.round((a.sch.x - o.sch.x) * 100) / 100
    const dy = Math.round((a.sch.y - o.sch.y) * 100) / 100
    const k = `${dx}/${dy}`
    const v = votes.get(k) ?? { n: 0, dx, dy }
    v.n++
    votes.set(k, v)
  }
  return [...votes.values()].sort((x, y) => y.n - x.n)[0] ?? { dx: 0, dy: 0 }
}

/** The board is moved to the middle of the page in the file: the shift most parts agree on. */
function boardShiftOf(before: Project, after: Project): { dx: number; dy: number } {
  const b = new Map(before.components.map((c) => [refKey(c), c]))
  const votes = new Map<string, { n: number; dx: number; dy: number }>()
  for (const a of after.components) {
    const o = b.get(refKey(a))
    if (!o || !o.pcb.placed || !a.pcb.placed) continue
    const dx = Math.round((a.pcb.x - o.pcb.x) * 100) / 100
    const dy = Math.round((a.pcb.y - o.pcb.y) * 100) / 100
    const k = `${dx}/${dy}`
    const v = votes.get(k) ?? { n: 0, dx, dy }
    v.n++
    votes.set(k, v)
  }
  return [...votes.values()].sort((x, y) => y.n - x.n)[0] ?? { dx: 0, dy: 0 }
}

export interface Compare {
  losses: Loss[]
  /** How many of each thing were compared, for the table's denominators. */
  counts: Record<string, number>
}

export function compareTrip(t: Trip, tol = 0.02): Compare {
  const { before, after } = t
  const losses: Loss[] = []
  const counts: Record<string, number> = {}
  const add = (kind: string, detail: string) => losses.push({ kind, detail })
  const count = (kind: string, n = 1) => (counts[kind] = (counts[kind] ?? 0) + n)
  const { dx, dy } = shiftOf(before, after)
  const board = boardShiftOf(before, after)

  // components. A power port is matched by its net and place (its reference is a number KiCad makes up); every other part by its reference.
  const isPower = (c: ComponentInstance) => c.ref.startsWith("#")
  const aBy = new Map(after.components.filter((c) => !isPower(c)).map((c) => [refKey(c), c]))
  const powerAfter = after.components.filter(isPower)
  const usedPower = new Set<string>()
  for (const c of before.components) {
    if (isPower(c)) {
      count("power port")
      const hit = powerAfter.find((a) => !usedPower.has(a.id) && powerNetName(a) === powerNetName(c) && Math.abs(a.sch.x - c.sch.x - dx) < 0.6 && Math.abs(a.sch.y - c.sch.y - dy) < 0.6)
      if (hit) usedPower.add(hit.id)
      else add("power port missing", `${powerNetName(c)} at ${c.sch.x},${c.sch.y}`)
      continue
    }
    count("component")
    const a = aBy.get(refKey(c))
    if (!a) {
      add("component missing", refKey(c))
      continue
    }
    const part = findPart(c.partId)
    const partA = findPart(a.partId)
    // the symbol as it lies on the sheet: where each pin is, and the box of the body
    if (part && partA) {
      const pb = new Map(schematicPins(c, part).map((w) => [w.pin, w.pos]))
      for (const w of schematicPins(a, partA)) {
        const o = pb.get(w.pin)
        if (o && (!near(w.pos.x - o.x, dx, tol) || !near(w.pos.y - o.y, dy, tol))) add("symbol pin moved", `${refKey(c)}.${w.pin}`)
      }
      if (pb.size !== schematicPins(a, partA).length) add("symbol pins differ", `${refKey(c)} ${pb.size} -> ${schematicPins(a, partA).length}`)
      // each pin's electrical role (what the checks and the box symbols read)
      const kindA = new Map(partA.pins.map((q) => [q.number, q.kind]))
      for (const q of part.pins) {
        if (!q.kind) continue
        count("pin role")
        if (kindA.get(q.number) !== q.kind) add("pin electrical type", `${refKey(c)}.${q.number} ${q.kind} -> ${kindA.get(q.number) ?? "none"}`)
      }
      const bb = schematicBounds(c, part)
      const ba = schematicBounds(a, partA)
      if (!near(ba.maxX - ba.minX, bb.maxX - bb.minX, 0.3) || !near(ba.maxY - ba.minY, bb.maxY - bb.minY, 0.3)) add("symbol body resized", `${refKey(c)} ${(bb.maxX - bb.minX).toFixed(2)}x${(bb.maxY - bb.minY).toFixed(2)} -> ${(ba.maxX - ba.minX).toFixed(2)}x${(ba.maxY - ba.minY).toFixed(2)}`)
      else if (!near((ba.maxX + ba.minX) / 2 - (bb.maxX + bb.minX) / 2, dx, 0.3) || !near((ba.maxY + ba.minY) / 2 - (bb.maxY + bb.minY) / 2, dy, 0.3)) add("symbol body moved", refKey(c))
    }
    if (part && partA && part.refPrefix && partA.refPrefix && part.refPrefix !== partA.refPrefix) add("reference prefix", `${refKey(c)} ${part.refPrefix} -> ${partA.refPrefix}`)
    // part data. The value property goes to the Value field, which is where an imported part keeps it.
    for (const [k, v] of Object.entries(c.props)) {
      if (!v || k === "net") continue
      count("prop")
      const valueProp = part?.valueProp === k
      const got = a.props[k] ?? Object.entries(a.props).find(([kk]) => kk.toLowerCase() === k.toLowerCase())?.[1] ?? (valueProp ? a.props.value : undefined)
      if (got === undefined) add(`part data lost: ${k}`, `${refKey(c)} ${v}`)
      else if (got.replace(/µ/g, "u") !== v && !(valueProp && got.replace(/µ/g, "u").startsWith(v))) add(`part data changed: ${k}`, `${refKey(c)} ${v} -> ${got}`)
    }
    if (part?.mpn && !a.props.mpn && !a.props.MPN && !partA?.mpn) {
      count("prop")
      add("part data lost: mpn", `${refKey(c)} ${part.mpn}`)
    }
    // the board
    if (c.pcb.placed) {
      count("footprint")
      if (!a.pcb.placed) add("footprint unplaced", refKey(c))
      if (a.pcb.side !== c.pcb.side) add("footprint side", refKey(c))
      if (!c.footprint !== !a.footprint) add("footprint missing", refKey(c))
      const mb = componentModel(before, c)
      const ma = componentModel(after, a)
      if (mb && !ma) add("3D model lost", refKey(c))
      // the pads: where each is on the board, in the board's frame
      const padsA = pcbPads(a)
      const padsB = pcbPads(c)
      const used = new Set<number>()
      for (const o of padsB) {
        const i = padsA.findIndex((p, k) => !used.has(k) && near(p.x - o.x, board.dx, 0.01) && near(p.y - o.y, board.dy, 0.01))
        if (i < 0) add("pad moved", `${refKey(c)}.${o.padNumber}`)
        else used.add(i)
      }
      count("pad", padsB.length)
      if (padsB.length !== padsA.length) add("pads differ", `${refKey(c)} ${padsB.length} -> ${padsA.length}`)
    }
  }
  for (const a of after.components) if (!isPower(a) && !before.components.some((c) => refKey(c) === refKey(a))) add("component added", `${refKey(a)} ${a.partId} ${JSON.stringify(a.props)} ${a.pcb.placed ? "placed" : "not on board"} ${a.sch.x},${a.sch.y}`)

  // texts
  const ta = sheetTexts(after).map((x) => ({ ...x, x: x.x - dx, y: x.y - dy }))
  const used = new Set<number>()
  for (const x of sheetTexts(before)) {
    count("text")
    let best = -1
    let bestD = Infinity
    ta.forEach((y, i) => {
      if (used.has(i) || y.text !== x.text || kindOf(y.key) !== kindOf(x.key)) return
      const d = Math.hypot(y.x - x.x, y.y - x.y)
      if (d < bestD) {
        bestD = d
        best = i
      }
    })
    if (best < 0) {
      // the text may exist under another key (a moved field renamed): say it is gone only when nothing has it
      const anywhere = ta.findIndex((y, i) => !used.has(i) && y.text === x.text)
      if (anywhere < 0) add(`text lost: ${kindOf(x.key)}`, `"${x.text}" at ${x.x},${x.y} (${x.key})`)
      else {
        used.add(anywhere)
        add(`text moved: ${kindOf(x.key)}`, `"${x.text}" ${x.key}: ${x.x},${x.y} -> ${ta[anywhere].x.toFixed(2)},${ta[anywhere].y.toFixed(2)}`)
      }
      continue
    }
    used.add(best)
    const y = ta[best]
    if (bestD > tol) add(`text moved: ${kindOf(x.key)}`, `"${x.text}" ${x.key}: ${x.x},${x.y} -> ${y.x.toFixed(2)},${y.y.toFixed(2)}`)
    if (x.ex !== y.ex || x.ey !== y.ey) add(`text justification: ${kindOf(x.key)}`, `"${x.text}" ${x.key}: ${x.ex},${x.ey} -> ${y.ex},${y.ey}`)
    if (x.vertical !== y.vertical) add(`text rotation: ${kindOf(x.key)}`, `"${x.text}" ${x.key}`)
    if (!near(x.size, y.size, 0.01)) add(`text size: ${kindOf(x.key)}`, `"${x.text}" ${x.key}: ${x.size} -> ${y.size}`)
    if (x.hidden !== y.hidden) add(`text visibility: ${kindOf(x.key)}`, `"${x.text}" ${x.key}`)
  }

  // the board itself: its size, its corners, its mounting holes
  count("board")
  const bb = before.board
  const ba = after.board
  if (!near(bb.width, ba.width, 0.01) || !near(bb.height, ba.height, 0.01)) add("board size", `${bb.width}x${bb.height} -> ${ba.width}x${ba.height}`)
  if (!near(bb.cornerRadius ?? 0, ba.cornerRadius ?? 0, 0.01) || (ba.outline?.paths.length ?? 0) > 0) add("board outline", `corner ${bb.cornerRadius ?? 0} -> ${ba.cornerRadius ?? 0}${ba.outline?.paths.length ? ", polygon" : ""}`)
  if (JSON.stringify(bb.mountingHoles ?? null) !== JSON.stringify(ba.mountingHoles ?? null)) add("mounting holes", `${JSON.stringify(bb.mountingHoles)} -> ${JSON.stringify(ba.mountingHoles)}`)

  // copper: the length of trace on each layer and net, the vias, the pours
  const traceLen = (p: Project) => {
    const m = new Map<string, number>()
    for (const t of p.traces) {
      let len = 0
      for (let i = 1; i < t.points.length; i++) len += Math.hypot(t.points[i].x - t.points[i - 1].x, t.points[i].y - t.points[i - 1].y)
      m.set(t.layer, (m.get(t.layer) ?? 0) + len)
    }
    return m
  }
  count("trace", before.traces.length)
  const copperB = traceLen(before)
  const copperA = traceLen(after)
  for (const [layer, len] of copperB) if (!near(copperA.get(layer) ?? 0, len, 0.05)) add("trace length", `${layer}: ${len.toFixed(2)} -> ${(copperA.get(layer) ?? 0).toFixed(2)}`)
  const widthB = new Map<string, number>()
  const widthA = new Map<string, number>()
  for (const [list, into] of [[before.traces, widthB], [after.traces, widthA]] as const) for (const t of list) into.set(t.width.toFixed(3), (into.get(t.width.toFixed(3)) ?? 0) + Math.max(0, t.points.length - 1))
  const widthKeys = new Set([...widthB.keys(), ...widthA.keys()])
  for (const k of widthKeys) if (widthB.get(k) !== undefined && !widthA.has(k)) add("trace width", `${k} mm lost`)
  for (const [k, v] of Object.entries(before.rules)) {
    if (typeof v !== "number") continue
    const got = (after.rules as unknown as Record<string, unknown>)[k]
    count("rule")
    if (typeof got !== "number" || !near(got, v, 0.001)) add("design rule", `${k}: ${v} -> ${String(got)}`)
  }
  count("via", before.vias.length)
  if (before.vias.length !== after.vias.length) add("vias differ", `${before.vias.length} -> ${after.vias.length}`)
  else
    for (const v of before.vias) if (!after.vias.some((w) => near(w.x - v.x, board.dx, 0.02) && near(w.y - v.y, board.dy, 0.02) && near(w.drill, v.drill, 0.01) && near(w.diameter, v.diameter, 0.01))) add("via moved or resized", `${v.x},${v.y}`)
  count("zone", before.zones.length)
  if (before.zones.length !== after.zones.length) add("zones differ", `${before.zones.length} -> ${after.zones.length}`)
  else
    before.zones.forEach((z, i) => {
      const w = after.zones.find((x) => x.net === z.net && x.layer === z.layer) ?? after.zones[i]
      if (!w) return
      if (w.net !== z.net || w.layer !== z.layer) add("zone net or layer", `${z.net}/${z.layer} -> ${w.net}/${w.layer}`)
    })
  count("board text", before.texts.length)
  for (const t of before.texts) if (!after.texts.some((u) => u.text === t.text)) add("board text lost", t.text)

  // titled blocks: the name and the parts in it
  const refsOf = (p: Project, b: { components: string[] }) => b.components.map((id) => p.components.find((c) => c.id === id)?.ref ?? "").filter((r) => r && !r.startsWith("#")).sort().join(",")
  const blocksAfter = new Map((after.blocks ?? []).map((b) => [b.name, refsOf(after, b)]))
  for (const b of before.blocks ?? []) {
    count("block")
    const got = blocksAfter.get(b.name)
    if (got === undefined) add("block lost", b.name)
    else if (got !== refsOf(before, b)) add("block members changed", `${b.name}: ${refsOf(before, b)} -> ${got}`)
  }

  // wires and nets
  count("wire", before.wires.length)
  const len = (p: Project) => p.wires.reduce((s, w) => s + Math.hypot((w.points?.[1]?.x ?? 0) - (w.points?.[0]?.x ?? 0), 0), 0)
  void len
  const nb = connectivityPins(before)
  const na = connectivityPins(after)
  for (const [pin, net] of nb) {
    count("pin")
    const got = na.get(pin)
    if (got === undefined) add("pin lost", pin)
    else if (got !== net) add("pin joined to another net", `${pin}: ${net} -> ${got}`)
  }
  const gb = new Set(before.components.filter((c) => c.pcb.placed).map(refKey))
  void gb

  // names of nets labels
  const lb = new Map(before.labels.map((l) => [l.name, 0]))
  for (const l of after.labels) if (lb.has(l.name)) lb.set(l.name, 1)
  for (const [n, seen] of lb) if (!seen) add("label lost", n)
  return { losses, counts }
}

/** Which pins are on one net together: each `ref.pin` mapped to the smallest pin of its net (a net's name changes in a file; what it joins does not). Power ports have no pins that matter. */
function connectivityPins(p: Project): Map<string, string> {
  const refOf = new Map(p.components.map((c) => [c.id, c.ref]))
  const out = new Map<string, string>()
  for (const n of computeConnectivity(p).nets) {
    const pins = n.pins.filter((x) => !(refOf.get(x.componentId) ?? "#").startsWith("#")).map((x) => `${refOf.get(x.componentId)}.${x.pin}`).sort()
    for (const pin of pins) out.set(pin, pins[0] ?? "")
  }
  return out
}

export function table(all: Loss[][]): string {
  const rows = new Map<string, number>()
  for (const l of all.flat()) rows.set(l.kind, (rows.get(l.kind) ?? 0) + 1)
  return [...rows.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${String(n).padStart(5)}  ${k}`).join("\n")
}
