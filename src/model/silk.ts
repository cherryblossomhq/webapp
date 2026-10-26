import { boxesOverlap, type Box } from "../lib/geometry"
import { strokeText, strokeTextWidth } from "../lib/strokeFont"
import { boardTextStrokes, mountingHoles } from "./board"
import { findPart } from "./library"
import { isPhysical, pcbCourtyard, pcbPads, pcbSilk } from "./instances"
import type { ComponentInstance, PcbSide, Project, Vec2 } from "./types"

/** Cap height of part designators on the silkscreen (mm). */
export const REF_SIZE = 1
/** Stroke width of footprint outlines and designators (mm). */
export const SILK_WIDTH = 0.15

/** Where a part's designator goes on the silkscreen. */
export interface Designator {
  componentId: string
  text: string
  x: number
  y: number
  /** 90 reads bottom to top, beside parts that stand upright on the board. */
  rot: 0 | 90
  side: PcbSide
  size: number
  /** Ink extent, stroke width included. */
  box: Box
}

/** Gap from the courtyard to the text. */
const GAP = 0.2
/** Silk stays this far from pad copper; the mask opening would clip it. */
const PAD_CLEAR = 0.15
/** Spacing kept between two designators or a designator and board text. */
const TEXT_CLEAR = 0.25
const EDGE_CLEAR = 0.3
const SLIDES = [0, 0.5, -0.5, 1, -1, 1.5, -1.5, 2, -2, 2.5, -2.5, 3, -3, 4, -4, 5, -5]

interface Candidate {
  x: number
  y: number
  rot: 0 | 90
  box: Box
  cost: number
}

const inflate = (b: Box, d: number): Box => ({ minX: b.minX - d, minY: b.minY - d, maxX: b.maxX + d, maxY: b.maxY + d })

function overlapArea(a: Box, b: Box) {
  const w = Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX)
  const h = Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY)
  return w > 0 && h > 0 ? w * h : 0
}

function strokesBox(paths: Vec2[][], grow: number): Box | null {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const path of paths) {
    for (const p of path) {
      minX = Math.min(minX, p.x)
      minY = Math.min(minY, p.y)
      maxX = Math.max(maxX, p.x)
      maxY = Math.max(maxY, p.y)
    }
  }
  return Number.isFinite(minX) ? { minX: minX - grow, minY: minY - grow, maxX: maxX + grow, maxY: maxY + grow } : null
}

/** Every position worth trying around a part, best first by its own preference. */
function candidates(c: ComponentInstance, cy: Box, w: number, h: number): Candidate[] {
  const hw = SILK_WIDTH / 2
  const cx = (cy.minX + cy.maxX) / 2
  const cyMid = (cy.minY + cy.maxY) / 2
  const horiz = (x: number, y: number) => ({ x, y, rot: 0 as const, box: { minX: x - w / 2 - hw, maxX: x + w / 2 + hw, minY: y - h / 2 - hw, maxY: y + h / 2 + hw } })
  const vert = (x: number, y: number) => ({ x, y, rot: 90 as const, box: { minX: x - h / 2 - hw, maxX: x + h / 2 + hw, minY: y - w / 2 - hw, maxY: y + w / 2 + hw } })
  const above = (s: number) => horiz(cx + s, cy.maxY + GAP + h / 2)
  const below = (s: number) => horiz(cx + s, cy.minY - GAP - h / 2)
  const leftUp = (s: number) => vert(cy.minX - GAP - h / 2, cyMid + s)
  const rightUp = (s: number) => vert(cy.maxX + GAP + h / 2, cyMid + s)
  const left = (s: number) => horiz(cy.minX - GAP - w / 2, cyMid + s)
  const right = (s: number) => horiz(cy.maxX + GAP + w / 2, cyMid + s)
  // A part turned on its side keeps its designator beside it, turned with it, the way the
  // reference above an unrotated footprint ends up after rotating it.
  const upright = c.pcb.rot === 90 || c.pcb.rot === 270
  const sides = upright
    ? c.pcb.rot === 90
      ? [leftUp, rightUp, above, below, left, right]
      : [rightUp, leftUp, above, below, right, left]
    : [above, below, left, right, leftUp, rightUp]
  const out: Candidate[] = []
  sides.forEach((at, i) => {
    for (const s of SLIDES) out.push({ ...at(s), cost: i * 2 + Math.abs(s) * 1.1 })
  })
  // Big parts such as modules can carry the designator inside their outline.
  if ((cy.maxX - cy.minX) * (cy.maxY - cy.minY) > w * h * 12) {
    const inside = [horiz(cx, cy.maxY - 1.2 - h / 2), horiz(cx, cy.minY + 1.2 + h / 2), vert(cy.minX + 1.2 + h / 2, cyMid)]
    inside.forEach((cand, i) => out.push({ ...cand, cost: 14 + i }))
  }
  return out
}

/**
 * Place every part's designator next to the part, clear of pads, board text, the board edge
 * and the other designators, and preferably off other parts' bodies and outlines. The editor,
 * the Gerber silkscreen and the 3D board all draw them from here.
 */
export function placeDesignators(project: Project): Map<string, Designator> {
  const placed = project.components.filter((c) => c.pcb.placed && !c.ref.startsWith("#") && isPhysical(findPart(c.partId)))
  const b = project.board
  const board = inflate({ minX: b.x - b.width / 2, maxX: b.x + b.width / 2, minY: b.y - b.height / 2, maxY: b.y + b.height / 2 }, -EDGE_CLEAR)

  const pads = placed.flatMap((c) =>
    pcbPads(c).map((p) => ({
      side: p.layers,
      box: inflate({ minX: p.x - p.width / 2, maxX: p.x + p.width / 2, minY: p.y - p.height / 2, maxY: p.y + p.height / 2 }, PAD_CLEAR),
    })),
  )
  const holes = mountingHoles(b).map((h) => inflate({ minX: h.x - h.diameter / 2, maxX: h.x + h.diameter / 2, minY: h.y - h.diameter / 2, maxY: h.y + h.diameter / 2 }, PAD_CLEAR))
  const texts = (project.texts ?? []).flatMap((t) => {
    const box = strokesBox(boardTextStrokes(t), TEXT_CLEAR)
    return box ? [{ side: t.side, box }] : []
  })
  const bodies = placed.flatMap((c) => {
    const cy = pcbCourtyard(c)
    return cy ? [{ id: c.id, side: c.pcb.side, box: cy }] : []
  })
  const outlines = placed.flatMap((c) =>
    pcbSilk(c).flatMap((path) => {
      const box = strokesBox([path], SILK_WIDTH / 2)
      return box ? [{ id: c.id, side: c.pcb.side, box }] : []
    }),
  )

  const out = new Map<string, Designator>()
  const taken: { side: PcbSide; box: Box }[] = []
  // Small parts have the fewest good spots, so they choose first.
  const area = (c: ComponentInstance) => {
    const cy = pcbCourtyard(c)
    return cy ? (cy.maxX - cy.minX) * (cy.maxY - cy.minY) : 0
  }
  const order = [...placed].sort((p, q) => area(p) - area(q) || p.ref.localeCompare(q.ref, undefined, { numeric: true }))

  for (const c of order) {
    const court = pcbCourtyard(c)
    if (!court) continue
    // Keep clear of the part's own outline too, where it pokes out of the courtyard.
    const own = strokesBox(pcbSilk(c), SILK_WIDTH / 2)
    const cy = own
      ? { minX: Math.min(court.minX, own.minX), minY: Math.min(court.minY, own.minY), maxX: Math.max(court.maxX, own.maxX), maxY: Math.max(court.maxY, own.maxY) }
      : court
    const side = c.pcb.side
    const size = REF_SIZE
    const w = strokeTextWidth(c.ref, size)
    let best: Candidate | null = null
    let fallback: Candidate | null = null
    for (const cand of candidates(c, cy, w, size)) {
      fallback ??= cand
      if (best && cand.cost >= best.cost) continue
      const box = cand.box
      if (box.minX < board.minX || box.maxX > board.maxX || box.minY < board.minY || box.maxY > board.maxY) continue
      if (pads.some((p) => p.side.includes(side) && boxesOverlap(p.box, box))) continue
      if (holes.some((h) => boxesOverlap(h, box))) continue
      if (texts.some((t) => t.side === side && boxesOverlap(t.box, box))) continue
      if (taken.some((t) => t.side === side && boxesOverlap(inflate(t.box, TEXT_CLEAR), box))) continue
      let cost = cand.cost
      const a = (box.maxX - box.minX) * (box.maxY - box.minY)
      // Under another part the text is hidden once it is assembled; across its outline it is hard to read.
      for (const o of bodies) if (o.id !== c.id && o.side === side) cost += (overlapArea(o.box, box) / a) * 12
      for (const o of outlines) if (o.id !== c.id && o.side === side && boxesOverlap(o.box, box)) cost += 1.5
      if (!best || cost < best.cost) best = { ...cand, cost }
    }
    const pick = best ?? fallback
    if (!pick) continue
    const d: Designator = { componentId: c.id, text: c.ref, x: pick.x, y: pick.y, rot: pick.rot, side, size, box: pick.box }
    out.set(c.id, d)
    taken.push({ side, box: pick.box })
  }
  return out
}

let cache: { components: unknown; texts: unknown; board: unknown; value: Map<string, Designator> } | null = null

/** placeDesignators, reused while parts, board text and the board are unchanged. */
export function getDesignators(project: Project): Map<string, Designator> {
  if (cache && cache.components === project.components && cache.texts === project.texts && cache.board === project.board) return cache.value
  const value = placeDesignators(project)
  cache = { components: project.components, texts: project.texts, board: project.board, value }
  return value
}

/** Silkscreen strokes of a designator, mirrored on the bottom so it reads from below. */
export function designatorStrokes(d: Designator): Vec2[][] {
  return strokeText(d.text, { x: d.x, y: d.y, size: d.size, rotation: d.rot, mirror: d.side === "bottom" })
}
