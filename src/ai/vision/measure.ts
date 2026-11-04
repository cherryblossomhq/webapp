import { boardAreaMm2, describeOutline } from "../../model/outline"
import { resolvedComponents } from "../../model/ruleAreas"
import { partOutsideBoard } from "../../model/pcb"
import { boxesOverlap, type Box } from "../../lib/geometry"
import { isSchematicPart, pcbCourtyard, schematicBounds } from "../../model/instances"
import { drawingBounds } from "../../model/drawings"
import { blockFrames } from "../../model/blocks"
import { BLOCK_GAP } from "../../model/tidy"
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
  /** Block frames drawn over each other. */
  frameOverlaps: Clash[]
  /** Texts drawn on the sheet over a block's title, or across its frame. */
  textsOnFrames: Clash[]
  /** Frames nearer each other than Tidy leaves them, without overlapping: information, not a problem. */
  crowdedFrames: { a: string; b: string; gap: number }[]
  /** How much of the drawn area is used, and the biggest empty part of it; null for an empty sheet. */
  fill: SheetFill | null
  /** Texts, lines and shapes drawn on the sheet. */
  drawings: number
  /** Pins of real parts with nothing on them and no no-connect flag. */
  unconnectedPins: number
  /** Real parts none of whose pins are connected to anything. */
  isolatedParts: string[]
}

/** Overlap at which two things count as drawn over each other, in schematic units. */
const SCH_EPS = 0.04

/**
 * How much of the drawn area holds something, on squares of `FILL_CELL` units: a block's frame
 * counts whole (what is inside it is Tidy's to pack), and outside frames every symbol, label,
 * wire and drawing counts the squares it touches. The picture shows a sheet sparse or not; a
 * model only acts on it when a number says so.
 */
export interface SheetFill {
  /** Share of the drawn area's squares that hold something, 0 to 1. */
  share: number
  /** Whether the frames are what is counted (the sheet has blocks) or the drawing itself. */
  framed: boolean
  /** The largest empty rectangle of squares, when it is big enough for a block to sit in. */
  empty: Box | null
  /** Its share of the drawn area, 0 to 1. */
  emptyShare: number
  /** Clearly too spread out: see the thresholds below. */
  sparse: boolean
}

const FILL_CELL = 0.5
/** Cells at most, so a huge imported sheet is measured on coarser squares rather than slowly. */
const FILL_MAX_CELLS = 40_000
/**
 * Below these a sheet reads as sparse. Measured on the shipped examples and the blog boards tidied
 * (frames: 58% to 79%; drawn by hand before Tidy, with no blocks: 20% to 34%) against the same
 * sheets with their blocks pushed apart (1.4 times: 42% to 51%, 1.7 times: 32% to 40%) or every
 * part spread out (1.5 times: 12% to 21%, twice: 8% to 15%).
 */
const SPARSE_FRAMED = 0.45
const SPARSE_DRAWN = 0.12
/** An empty area worth naming: room for a small block. */
const EMPTY_MIN_SIDE = 2

/** Is `inner` wholly within `outer`? */
const within = (inner: Box, outer: Box) => inner.minX >= outer.minX && inner.maxX <= outer.maxX && inner.minY >= outer.minY && inner.maxY <= outer.maxY

/** The clear distance between two boxes that don't overlap: the larger of the gaps across and along. */
const gapBetween = (a: Box, b: Box) => Math.max(Math.max(a.minX, b.minX) - Math.min(a.maxX, b.maxX), Math.max(a.minY, b.minY) - Math.min(a.maxY, b.maxY))

function sheetFill(project: Project, bounds: Box | null, frames: Box[], parts: number): SheetFill | null {
  if (!bounds) return null
  const w = bounds.maxX - bounds.minX
  const h = bounds.maxY - bounds.minY
  if (w <= 0 || h <= 0) return null
  const cell = Math.max(FILL_CELL, Math.sqrt((w * h) / FILL_MAX_CELLS))
  const cols = Math.max(1, Math.ceil(w / cell - 1e-9))
  const rows = Math.max(1, Math.ceil(h / cell - 1e-9))
  const used = new Uint8Array(cols * rows)
  const mark = (b: Box) => {
    const c0 = Math.max(0, Math.floor((b.minX - bounds.minX) / cell))
    const c1 = Math.min(cols - 1, Math.max(c0, Math.ceil((b.maxX - bounds.minX) / cell) - 1))
    const r0 = Math.max(0, Math.floor((b.minY - bounds.minY) / cell))
    const r1 = Math.min(rows - 1, Math.max(r0, Math.ceil((b.maxY - bounds.minY) / cell) - 1))
    for (let r = r0; r <= r1; r++) used.fill(1, r * cols + c0, r * cols + c1 + 1)
  }
  for (const f of frames) mark(f)
  for (const c of project.components) mark(schematicBounds(c))
  for (const l of project.labels) mark(labelBox(l))
  for (const d of project.drawings ?? []) mark(drawingBounds(d))
  for (const wire of project.wires) {
    for (let i = 0; i + 1 < wire.points.length; i++) {
      const a = wire.points[i]
      const b = wire.points[i + 1]
      mark({ minX: Math.min(a.x, b.x), minY: Math.min(a.y, b.y), maxX: Math.max(a.x, b.x), maxY: Math.max(a.y, b.y) })
    }
  }
  let count = 0
  for (const v of used) count += v
  const share = count / (cols * rows)

  // The largest empty rectangle of squares: row by row, the height of empty squares above each
  // column, and the widest rectangle under that skyline.
  const heights = new Array<number>(cols).fill(0)
  let best = { area: 0, c0: 0, c1: 0, r0: 0, r1: 0 }
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) heights[c] = used[r * cols + c] ? 0 : heights[c] + 1
    const stack: number[] = []
    for (let c = 0; c <= cols; c++) {
      const height = c === cols ? 0 : heights[c]
      while (stack.length && heights[stack[stack.length - 1]] >= height) {
        const top = stack.pop()!
        const left = stack.length ? stack[stack.length - 1] + 1 : 0
        const area = heights[top] * (c - left)
        if (area > best.area) best = { area, c0: left, c1: c - 1, r0: r - heights[top] + 1, r1: r }
      }
      stack.push(c)
    }
  }
  const empty: Box = {
    minX: bounds.minX + best.c0 * cell,
    maxX: Math.min(bounds.maxX, bounds.minX + (best.c1 + 1) * cell),
    minY: bounds.minY + best.r0 * cell,
    maxY: Math.min(bounds.maxY, bounds.minY + (best.r1 + 1) * cell),
  }
  const roomy = best.area > 0 && empty.maxX - empty.minX >= EMPTY_MIN_SIDE && empty.maxY - empty.minY >= EMPTY_MIN_SIDE
  const framed = frames.length > 0
  // One block, or one part, fills its own bounds by definition: there is nothing to be sparse about.
  const several = framed ? frames.length > 1 : parts > 1
  return {
    share,
    framed,
    empty: roomy ? empty : null,
    emptyShare: roomy ? best.area / (cols * rows) : 0,
    sparse: several && share < (framed ? SPARSE_FRAMED : SPARSE_DRAWN),
  }
}

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

  // Frames are on the grid, so two that only touch share an edge: shrunk a little, only a real overlap counts.
  const frames = blockFrames(project)
  const frameOverlaps: Clash[] = []
  const crowdedFrames: SchematicMeasure["crowdedFrames"] = []
  for (let i = 0; i < frames.length; i++) {
    for (let j = i + 1; j < frames.length; j++) {
      const a = shrink(frames[i].box, 0.01)
      const b = shrink(frames[j].box, 0.01)
      if (boxesOverlap(a, b)) frameOverlaps.push({ a: frames[i].name, b: frames[j].name, box: mid(a, b) })
      else {
        const gap = gapBetween(frames[i].box, frames[j].box)
        if (gap < BLOCK_GAP - 1e-6) crowdedFrames.push({ a: frames[i].name, b: frames[j].name, gap: round(Math.max(0, gap)) })
      }
    }
  }

  // A text over a block's title hides the title (a sheet title dropped on the top block, say), and
  // one across a frame's edge reads as belonging to neither side. A note wholly inside a frame is
  // how a block is explained, and one wholly outside is the sheet's own.
  const textsOnFrames: Clash[] = []
  for (const d of project.drawings ?? []) {
    if (d.type !== "text") continue
    const box = shrink(drawingBounds(d), 0.01)
    const name = `the text "${d.text.split("\n")[0].slice(0, 24)}"`
    for (const f of frames) {
      if (boxesOverlap(box, f.titleBox)) textsOnFrames.push({ a: name, b: `the title of ${f.name}`, box: mid(box, f.titleBox) })
      else if (boxesOverlap(box, f.box) && !within(box, f.box)) textsOnFrames.push({ a: name, b: `the frame of ${f.name}`, box: mid(box, f.box) })
    }
  }

  const connected = new Set<string>()
  for (const net of conn.nets) {
    if (net.named || net.pins.length > 1) for (const p of net.pins) connected.add(p.componentId)
  }
  const isolatedParts = project.components.filter((c) => isSchematicPart(findPart(c.partId)) && !connected.has(c.id)).map((c) => c.ref)
  const bounds = schematicContent(project)
  const parts = project.components.filter((c) => isSchematicPart(findPart(c.partId))).length

  return {
    parts: project.components.length,
    nets: conn.nets.filter((n) => n.named || n.pins.length > 1).length,
    wires: project.wires.length,
    labels: project.labels.length,
    bounds,
    symbolOverlaps,
    labelsOnSymbols,
    labelOverlaps,
    wiresThroughSymbols,
    textsOnSymbols,
    frameOverlaps,
    textsOnFrames,
    crowdedFrames,
    fill: sheetFill(project, bounds, frames.map((f) => f.box), parts),
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
  for (const c of placed) {
    const cy = pcbCourtyard(c)
    if (cy && partOutsideBoard(project, c, cy)) offBoard.push(c.ref)
  }
  // The overlaps run_checks reports, so the two always agree: a part turned to 72 degrees is tested by its turned courtyard, not
  // the box around it, which overlaps a neighbour's long before the part does (an assistant was told of overlaps Checks never had).
  const byId = new Map(placed.map((c) => [c.id, c]))
  const overlaps: Clash[] = []
  for (const v of pcb.violations) {
    if (v.kind !== "overlap") continue
    const [a, b] = (v.items ?? []).map((k) => byId.get(k.slice(2)))
    const ca = a && pcbCourtyard(a)
    const cb = b && pcbCourtyard(b)
    if (a && b) overlaps.push({ a: a.ref, b: b.ref, box: ca && cb ? mid(shrink(ca, 0.05), shrink(cb, 0.05)) : { minX: v.at.x, minY: v.at.y, maxX: v.at.x, maxY: v.at.y } })
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
    errors: pcb.violations.filter((v) => v.severity === "error" && v.kind !== "unrouted" && v.kind !== "outside-board" && v.kind !== "overlap").length,
    warnings: pcb.violations.filter((v) => v.severity === "warning" && v.kind !== "overlap").length,
    bounds: pcbContent(project),
  }
}

const more = (items: string[], shown = SHOWN) => (items.length > shown ? `${items.slice(0, shown).join(", ")} and ${items.length - shown} more` : items.join(", "))
const pairs = (c: Clash[]) => more(c.map((x) => `${x.a}/${x.b}`))
const range = (b: Box, unit: string) => `x ${round(b.minX)} to ${round(b.maxX)}, y ${round(b.minY)} to ${round(b.maxY)}${unit}`

/** How many separate problems the schematic numbers name. */
export const schematicProblems = (m: SchematicMeasure) =>
  m.symbolOverlaps.length + m.labelsOnSymbols.length + m.labelOverlaps.length + m.wiresThroughSymbols.length + m.textsOnSymbols.length + m.frameOverlaps.length + m.textsOnFrames.length + m.unconnectedPins + m.isolatedParts.length

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
  if (m.frameOverlaps.length) problems.push(`${m.frameOverlaps.length} block frame(s) over each other: ${pairs(m.frameOverlaps)}`)
  if (m.textsOnFrames.length) problems.push(`${m.textsOnFrames.length} drawn text(s) over a block's title or across its frame: ${more(m.textsOnFrames.map((x) => `${x.a} on ${x.b}`), 4)}`)
  if (m.unconnectedPins) problems.push(`${m.unconnectedPins} unconnected pin(s)`)
  if (m.isolatedParts.length) problems.push(`${m.isolatedParts.length} part(s) with nothing connected: ${more(m.isolatedParts)}`)
  lines.push(problems.length ? `Problems: ${problems.join("; ")}` : "Problems: none found (no overlaps, no wires through symbols, no unconnected pins)")
  const fill = fillLine(m)
  if (fill) lines.push(fill)
  return lines
}

/** How full the sheet is, where its biggest gap is, and frames nearer each other than Tidy leaves them. */
function fillLine(m: SchematicMeasure): string {
  const f = m.fill
  if (!f) return ""
  const pct = (v: number) => `${Math.round(v * 100)}%`
  const used = f.framed ? `${pct(f.share)} of the drawn area is used (block frames count whole)` : `${pct(f.share)} of the drawn area holds symbols, wires, labels or drawings`
  const sparse = f.framed ? "sparse (a tidied sheet uses over 55%): move blocks closer with arrange_blocks or edit_block move_by" : "sparse (a sheet drawn by hand uses over 20%): move parts closer"
  const parts = [f.sparse ? `${used}, ${sparse}` : used]
  if (f.empty) parts.push(`the largest empty area is ${range(f.empty, "")} (${pct(f.emptyShare)})`)
  if (m.crowdedFrames.length) parts.push(`frames nearer than ${BLOCK_GAP} (Tidy's gap): ${more(m.crowdedFrames.map((x) => `${x.a}/${x.b} ${x.gap}`))}`)
  return `Sheet use: ${parts.join("; ")}`
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
