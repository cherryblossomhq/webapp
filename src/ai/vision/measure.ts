import { boardAreaMm2, describeOutline } from "../../model/outline"
import { resolvedComponents } from "../../model/ruleAreas"
import { partOutsideBoard } from "../../model/pcb"
import { boxesOverlap, type Box } from "../../lib/geometry"
import { isSchematicPart, pcbCourtyard, schematicBounds } from "../../model/instances"
import { drawingBounds } from "../../model/drawings"
import { labelBox } from "../../model/labels"
import { findPart } from "../../model/library"
import type { Project, Vec2 } from "../../model/types"
import { getConnectivity, getPcbAnalysis } from "../../store/analysis"
import { pcbContent, schematicContent } from "./framing"
import { onBoard } from "../../model/partFlags"

// What the model gets beside a picture: counts and positions it can act on. The old editor's
// research found models fix what a number names far more reliably than what a picture hints at,
// so every problem the picture can show is also here, with the refs involved, and the renderers
// outline the same boxes.

const SHOWN = 6
const round = (v: number, d = 2) => Math.round(v * 10 ** d) / 10 ** d
const at = (p: Vec2) => `(${round(p.x)}, ${round(p.y)})`

const shrink = (b: Box, d: number): Box => ({ minX: b.minX + d, minY: b.minY + d, maxX: b.maxX - d, maxY: b.maxY - d })
const mid = (a: Box, b: Box): Box => ({
  minX: Math.max(a.minX, b.minX),
  minY: Math.max(a.minY, b.minY),
  maxX: Math.min(a.maxX, b.maxX),
  maxY: Math.min(a.maxY, b.maxY),
})

/** Does the segment cross the box's inside? (Liang-Barsky; touching an edge does not count.) */
export function segmentCrossesBox(a: Vec2, b: Vec2, box: Box): boolean {
  if (box.maxX <= box.minX || box.maxY <= box.minY) return false
  let t0 = 0
  let t1 = 1
  const dx = b.x - a.x
  const dy = b.y - a.y
  const clip = (p: number, q: number) => {
    if (p === 0) return q > 0
    const r = q / p
    if (p < 0) {
      if (r > t1) return false
      if (r > t0) t0 = r
    } else {
      if (r < t0) return false
      if (r < t1) t1 = r
    }
    return true
  }
  return clip(-dx, a.x - box.minX) && clip(dx, box.maxX - a.x) && clip(-dy, a.y - box.minY) && clip(dy, box.maxY - a.y) && t1 > t0
}

export interface Clash {
  a: string
  b: string
  /** Where they overlap, for outlining it. */
  box: Box
}

export interface SchematicMeasure {
  parts: number
  nets: number
  wires: number
  labels: number
  bounds: Box | null
  /** Symbols drawn over each other. */
  symbolOverlaps: Clash[]
  /** Net labels drawn over a symbol they are not on. */
  labelsOnSymbols: Clash[]
  /** Net labels drawn over each other. */
  labelOverlaps: Clash[]
  /** Wires that run through the body of a symbol. */
  wiresThroughSymbols: Clash[]
  /** Texts drawn on the sheet over a symbol or a net label. */
  textsOnSymbols: Clash[]
  /** Texts, lines and shapes drawn on the sheet. */
  drawings: number
  /** Pins of real parts with nothing on them and no no-connect flag. */
  unconnectedPins: number
  /** Real parts none of whose pins are connected to anything. */
  isolatedParts: string[]
}

/** Overlap at which two things count as drawn over each other, in schematic units. */
const SCH_EPS = 0.04

export function measureSchematic(project: Project): SchematicMeasure {
  const conn = getConnectivity(project)
  const comps = project.components.map((c) => ({ c, box: schematicBounds(c) }))

  const symbolOverlaps: Clash[] = []
  for (let i = 0; i < comps.length; i++) {
    for (let j = i + 1; j < comps.length; j++) {
      const a = shrink(comps[i].box, SCH_EPS)
      const b = shrink(comps[j].box, SCH_EPS)
      if (boxesOverlap(a, b)) symbolOverlaps.push({ a: comps[i].c.ref, b: comps[j].c.ref, box: mid(a, b) })
    }
  }

  const labels = project.labels.map((l) => ({ l, box: labelBox(l) }))
  const labelsOnSymbols: Clash[] = []
  for (const { l, box } of labels) {
    for (const { c, box: cb } of comps) {
      const s = shrink(cb, SCH_EPS)
      if (boxesOverlap(shrink(box, 0.01), s)) labelsOnSymbols.push({ a: l.name, b: c.ref, box: mid(box, s) })
    }
  }
  const labelOverlaps: Clash[] = []
  for (let i = 0; i < labels.length; i++) {
    for (let j = i + 1; j < labels.length; j++) {
      if (boxesOverlap(shrink(labels[i].box, 0.01), shrink(labels[j].box, 0.01))) {
        labelOverlaps.push({ a: labels[i].l.name, b: labels[j].l.name, box: mid(labels[i].box, labels[j].box) })
      }
    }
  }

  const wiresThroughSymbols: Clash[] = []
  for (const w of project.wires) {
    for (const { c, box } of comps) {
      const inner = shrink(box, 0.06)
      let hit = false
      for (let i = 0; i < w.points.length - 1 && !hit; i++) hit = segmentCrossesBox(w.points[i], w.points[i + 1], inner)
      if (hit) wiresThroughSymbols.push({ a: `the wire from ${at(w.points[0])} to ${at(w.points[w.points.length - 1])}`, b: c.ref, box: inner })
    }
  }

  // A text over a symbol or a label hides one of them; a line or a box may well cross one on purpose.
  const textsOnSymbols: Clash[] = []
  for (const d of project.drawings ?? []) {
    if (d.type !== "text") continue
    const box = shrink(drawingBounds(d), 0.01)
    const name = `the text "${d.text.split("\n")[0].slice(0, 24)}"`
    for (const { c, box: cb } of comps) {
      const s = shrink(cb, SCH_EPS)
      if (boxesOverlap(box, s)) textsOnSymbols.push({ a: name, b: c.ref, box: mid(box, s) })
    }
    for (const { l, box: lb } of labels) if (boxesOverlap(box, lb)) textsOnSymbols.push({ a: name, b: `label ${l.name}`, box: mid(box, lb) })
  }

  const connected = new Set<string>()
  for (const net of conn.nets) {
    if (net.named || net.pins.length > 1) for (const p of net.pins) connected.add(p.componentId)
  }
  const isolatedParts = project.components.filter((c) => isSchematicPart(findPart(c.partId)) && !connected.has(c.id)).map((c) => c.ref)

  return {
    parts: project.components.length,
    nets: conn.nets.filter((n) => n.named || n.pins.length > 1).length,
    wires: project.wires.length,
    labels: project.labels.length,
    bounds: schematicContent(project),
    symbolOverlaps,
    labelsOnSymbols,
    labelOverlaps,
    wiresThroughSymbols,
    textsOnSymbols,
    drawings: project.drawings?.length ?? 0,
    unconnectedPins: conn.unconnectedPins.length,
    isolatedParts,
  }
}

export interface PcbMeasure {
  board: { width: number; height: number; x: number; y: number; /** What an outline of its own is, in words, with its area; absent for a rectangle. */ outline?: string }
  /** Placed and unplaced real parts. */
  placed: number
  total: number
  unplaced: string[]
  /** Parts whose courtyard is not inside the board outline. */
  offBoard: string[]
  /** Courtyards drawn over each other on one side. */
  overlaps: Clash[]
  /** Open connections of the ratsnest, and the nets they belong to. */
  unrouted: number
  unroutedNets: string[]
  traces: number
  vias: number
  pours: number
  errors: number
  warnings: number
  /** Everything drawn, the board and the parts off it. */
  bounds: Box
}

export function measurePcb(project: Project): PcbMeasure {
  const pcb = getPcbAnalysis(project)
  const conn = getConnectivity(project)
  const physical = resolvedComponents(project).filter((c) => onBoard(c))
  const placed = physical.filter((c) => c.pcb.placed)
  const bd = project.board

  const offBoard: string[] = []
  const boxes: { ref: string; side: string; box: Box }[] = []
  for (const c of placed) {
    const cy = pcbCourtyard(c)
    if (!cy) continue
    boxes.push({ ref: c.ref, side: c.pcb.side, box: cy })
    if (partOutsideBoard(project, c, cy)) offBoard.push(c.ref)
  }
  // The same test as the overlap check in the PCB analysis, so the two always agree.
  const overlaps: Clash[] = []
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      if (boxes[i].side !== boxes[j].side) continue
      const a = shrink(boxes[i].box, 0.05)
      const b = shrink(boxes[j].box, 0.05)
      if (boxesOverlap(a, b)) overlaps.push({ a: boxes[i].ref, b: boxes[j].ref, box: mid(a, b) })
    }
  }

  const netNames = new Map(conn.nets.map((n) => [n.id, n.name]))
  const unroutedNets = [...new Set(pcb.ratsnest.map((r) => netNames.get(r.netId) ?? r.netId))]

  return {
    board: { width: bd.width, height: bd.height, x: bd.x, y: bd.y, ...(bd.outline ? { outline: `${describeOutline(bd)}, ${round(boardAreaMm2(bd) / 100)} cm2` } : {}) },
    placed: placed.length,
    total: physical.length,
    unplaced: physical.filter((c) => !c.pcb.placed).map((c) => c.ref),
    offBoard,
    overlaps,
    unrouted: pcb.ratsnest.length,
    unroutedNets,
    traces: project.traces.length,
    vias: project.vias.length,
    pours: project.zones.length,
    // What run_checks calls an error, less what has a line of its own above.
    errors: pcb.violations.filter((v) => v.severity === "error" && v.kind !== "unrouted" && v.kind !== "outside-board").length,
    warnings: pcb.violations.filter((v) => v.severity === "warning" && v.kind !== "overlap").length,
    bounds: pcbContent(project),
  }
}

const more = (items: string[], shown = SHOWN) => (items.length > shown ? `${items.slice(0, shown).join(", ")} and ${items.length - shown} more` : items.join(", "))
const pairs = (c: Clash[]) => more(c.map((x) => `${x.a}/${x.b}`))
const range = (b: Box, unit: string) => `x ${round(b.minX)} to ${round(b.maxX)}, y ${round(b.minY)} to ${round(b.maxY)}${unit}`

/** How many separate problems the schematic numbers name. */
export const schematicProblems = (m: SchematicMeasure) =>
  m.symbolOverlaps.length + m.labelsOnSymbols.length + m.labelOverlaps.length + m.wiresThroughSymbols.length + m.textsOnSymbols.length + m.unconnectedPins + m.isolatedParts.length

/** How many separate problems the PCB numbers name; open connections count by net. */
export const pcbProblems = (m: PcbMeasure) => m.unplaced.length + m.offBoard.length + m.overlaps.length + m.unroutedNets.length + m.errors

/** The schematic numbers as lines for the tool result. */
export function describeSchematic(m: SchematicMeasure): string[] {
  const lines = [`${m.parts} parts, ${m.nets} nets, ${m.wires} wires, ${m.labels} net labels${m.drawings ? `, ${m.drawings} drawing(s)` : ""}${m.bounds ? `; drawn over ${range(m.bounds, "")} (units)` : ""}`]
  const problems: string[] = []
  if (m.symbolOverlaps.length) problems.push(`${m.symbolOverlaps.length} symbol overlap(s): ${pairs(m.symbolOverlaps)}`)
  if (m.labelsOnSymbols.length) problems.push(`${m.labelsOnSymbols.length} net label(s) over a symbol: ${more(m.labelsOnSymbols.map((x) => `${x.a} on ${x.b}`))}`)
  if (m.labelOverlaps.length) problems.push(`${m.labelOverlaps.length} net label(s) over each other: ${pairs(m.labelOverlaps)}`)
  if (m.wiresThroughSymbols.length) problems.push(`${m.wiresThroughSymbols.length} wire(s) through a symbol body: ${more(m.wiresThroughSymbols.map((x) => `${x.a} through ${x.b}`), 4)}`)
  if (m.textsOnSymbols.length) problems.push(`${m.textsOnSymbols.length} drawn text(s) over a symbol or label: ${more(m.textsOnSymbols.map((x) => `${x.a} on ${x.b}`), 4)}`)
  if (m.unconnectedPins) problems.push(`${m.unconnectedPins} unconnected pin(s)`)
  if (m.isolatedParts.length) problems.push(`${m.isolatedParts.length} part(s) with nothing connected: ${more(m.isolatedParts)}`)
  lines.push(problems.length ? `Problems: ${problems.join("; ")}` : "Problems: none found (no overlaps, no wires through symbols, no unconnected pins)")
  return lines
}

/** The PCB numbers as lines for the tool result. */
export function describePcb(m: PcbMeasure): string[] {
  const lines = [
    `Board ${m.board.width} x ${m.board.height} mm${m.board.outline ? ` bounding box, an outline of its own (${m.board.outline})` : ""} (${range({ minX: m.board.x - m.board.width / 2, maxX: m.board.x + m.board.width / 2, minY: m.board.y - m.board.height / 2, maxY: m.board.y + m.board.height / 2 }, " mm")}); ${m.placed} of ${m.total} parts placed; ${m.traces} traces, ${m.vias} vias, ${m.pours} pours`,
  ]
  const b = m.bounds
  if (b.minX < m.board.x - m.board.width / 2 - 1e-6 || b.maxX > m.board.x + m.board.width / 2 + 1e-6 || b.minY < m.board.y - m.board.height / 2 - 1e-6 || b.maxY > m.board.y + m.board.height / 2 + 1e-6) {
    lines.push(`Parts reach ${range(b, " mm")}, beyond the board`)
  }
  const problems: string[] = []
  if (m.unplaced.length) problems.push(`${m.unplaced.length} part(s) not placed: ${more(m.unplaced)}`)
  if (m.offBoard.length) problems.push(`${m.offBoard.length} part(s) off the board: ${more(m.offBoard)}`)
  if (m.overlaps.length) problems.push(`${m.overlaps.length} courtyard overlap(s): ${pairs(m.overlaps)}`)
  if (m.unrouted) problems.push(`${m.unrouted} unrouted connection(s) on ${m.unroutedNets.length} net(s): ${more(m.unroutedNets)}`)
  if (m.errors) problems.push(`${m.errors} check error(s)`)
  lines.push(problems.length ? `Problems: ${problems.join("; ")}` : "Problems: none found (all placed, on the board, no overlaps, nothing unrouted)")
  return lines
}
