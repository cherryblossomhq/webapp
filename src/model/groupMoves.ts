import { rotate90, round } from "../lib/geometry"
import { dimensionBox, imageBox, lockedByGroup, memberOfSelection, moveDimension, moveImages, pivotOf, rotateDimension } from "./boardObjects"
import { carryGenerators } from "./generators"
import { findPart } from "./library"
import { isPhysical, pcbCourtyard } from "./instances"
import { moveShape } from "./shapeOps"
import { mapShape, shapeBox } from "./shapes"
import { layerText, worldTexts } from "./texts"
import type { BoardGraphic, BoardText, Project, Rotation, Vec2 } from "./types"

// Moving and turning a selection that holds a group: everything in it goes as one, whatever it is (a part, a trace, a via, a drawing, a text, a dimension, an
// image). A selection with no group is moved and turned by the PCB view's own rules, part by part, as before. What is locked stays where it is: a part,
// a drawing, a text, a dimension or an image with its lock on, and everything under a locked group (`BOARD_ITEM::IsLocked` asks the parent group).

const touch = (p: Project): Project => ({ ...p, updatedAt: Date.now() })
const r6 = (n: number) => Math.round(n * 1e6) / 1e6 || 0

/** The ids of a selection by kind. */
function split(selection: string[]) {
  const by = { c: [] as string[], t: [] as string[], v: [] as string[], g: [] as string[], x: [] as string[], m: [] as string[], i: [] as string[] }
  for (const s of selection) {
    const id = memberOfSelection(s)
    if (id !== null) by[s[0] as keyof typeof by].push(id)
  }
  return by
}

/** What of a selection is held in place by a lock, as selection ids. */
export function lockedInSelection(project: Project, selection: string[]): string[] {
  const group = lockedByGroup(project)
  const by = split(selection)
  const out: string[] = []
  for (const id of by.c) if (group.has(id) || project.components.find((c) => c.id === id)?.pcb.locked) out.push(`c:${id}`)
  for (const id of by.t) if (group.has(id)) out.push(`t:${id}`)
  for (const id of by.v) if (group.has(id)) out.push(`v:${id}`)
  for (const id of by.g) if (group.has(id) || project.graphics?.find((g) => g.id === id)?.locked) out.push(`g:${id}`)
  for (const id of by.x) if (group.has(id) || project.texts.find((t) => t.id === id)?.locked) out.push(`x:${id}`)
  for (const id of by.m) if (group.has(id) || project.dimensions?.find((d) => d.id === id)?.locked) out.push(`m:${id}`)
  for (const id of by.i) if (group.has(id) || project.images?.find((m) => m.id === id)?.locked) out.push(`i:${id}`)
  return out
}

/** Moves everything in a selection that is not locked by (dx, dy). The same project when nothing moves. */
export function moveObjects(project: Project, selection: string[], dx: number, dy: number): Project {
  if (dx === 0 && dy === 0) return project
  const held = new Set(lockedInSelection(project, selection))
  const by = split(selection.filter((s) => !held.has(s)))
  const c = new Set(by.c)
  const t = new Set(by.t)
  const v = new Set(by.v)
  const g = new Set(by.g)
  const x = new Set(by.x)
  const m = new Set(by.m)
  const i = new Set(by.i)
  const moved = (p: Vec2): Vec2 => ({ x: round(p.x + dx, 3), y: round(p.y + dy, 3) })
  let next: Project = project
  if (c.size) next = { ...next, components: next.components.map((q) => (c.has(q.id) ? { ...q, pcb: { ...q.pcb, x: round(q.pcb.x + dx), y: round(q.pcb.y + dy), placed: true } } : q)) }
  if (t.size) next = { ...next, traces: next.traces.map((q) => (t.has(q.id) ? { ...q, points: q.points.map(moved) } : q)) }
  if (v.size) next = { ...next, vias: next.vias.map((q) => (v.has(q.id) ? { ...q, ...moved(q) } : q)) }
  if (g.size && next.graphics) next = { ...next, graphics: next.graphics.map((q) => (g.has(q.id) ? moveShape(q, dx, dy) : q)) }
  if (x.size) next = { ...next, texts: next.texts.map((q) => (x.has(q.id) && q.layer !== undefined ? { ...q, x: r6(q.x + dx), y: r6(q.y + dy) } : q)) }
  if (m.size && next.dimensions) next = { ...next, dimensions: next.dimensions.map((q) => (m.has(q.id) ? moveDimension(q, dx, dy) : q)) }
  if (i.size) next = moveImages(next, [...i], dx, dy)
  // X21: a tuning pattern or other generated item that went whole takes its layout points with it.
  next = carryGenerators(next, new Set([...c, ...t, ...v, ...g, ...x, ...m, ...i]), (p) => ({ x: p.x + dx, y: p.y + dy }))
  return next === project ? project : touch(next)
}

/** The box a selection takes on the board, or null when it has nothing with a place. */
export function selectionBounds(project: Project, selection: string[]): { minX: number; minY: number; maxX: number; maxY: number } | null {
  const by = split(selection)
  const box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }
  const add = (b: { minX: number; minY: number; maxX: number; maxY: number } | null | undefined) => {
    if (!b) return
    box.minX = Math.min(box.minX, b.minX)
    box.minY = Math.min(box.minY, b.minY)
    box.maxX = Math.max(box.maxX, b.maxX)
    box.maxY = Math.max(box.maxY, b.maxY)
  }
  const point = (p: Vec2) => add({ minX: p.x, minY: p.y, maxX: p.x, maxY: p.y })
  for (const id of by.c) {
    const q = project.components.find((c) => c.id === id)
    if (q && q.pcb.placed && isPhysical(findPart(q.partId))) add(pcbCourtyard(q) ?? { minX: q.pcb.x, minY: q.pcb.y, maxX: q.pcb.x, maxY: q.pcb.y })
  }
  for (const id of by.t) project.traces.find((q) => q.id === id)?.points.forEach(point)
  for (const id of by.v) {
    const q = project.vias.find((w) => w.id === id)
    if (q) point(q)
  }
  for (const id of by.g) {
    const q = project.graphics?.find((w) => w.id === id)
    if (q) add(shapeBox(q))
  }
  const world = by.x.length ? worldTexts(project) : []
  for (const id of by.x) {
    const w = world.find((t) => t.id === `x:${id}`)
    if (w) add(layerText(project, w)?.box)
  }
  for (const id of by.m) {
    const q = project.dimensions?.find((w) => w.id === id)
    if (q) add(dimensionBox(q))
  }
  for (const id of by.i) {
    const q = project.images?.find((w) => w.id === id)
    if (q) add(imageBox(q))
  }
  return box.minX <= box.maxX ? box : null
}

const turnGraphic = (g: BoardGraphic, turn: (p: Vec2) => Vec2): BoardGraphic => mapShape(g, turn)

export interface TurnResult {
  project: Project
  /** What was left as it was: locked things, and a picture, which cannot be turned. */
  notes: string[]
}

/**
 * Turns everything in a selection a quarter turn counter-clockwise about the middle of its box, as one body. A locked part, drawing, text, dimension or
 * image stays where it is, and an image is moved round the pivot but not turned: the editor holds no angle for a picture.
 */
export function rotateObjects(project: Project, selection: string[]): TurnResult | null {
  const box = selectionBounds(project, selection)
  if (!box) return null
  const pivot = pivotOf(box)
  const held = new Set(lockedInSelection(project, selection))
  const by = split(selection.filter((s) => !held.has(s)))
  const turn = (p: Vec2): Vec2 => {
    const r = rotate90({ x: p.x - pivot.x, y: p.y - pivot.y }, 90)
    return { x: r6(pivot.x + r.x), y: r6(pivot.y + r.y) }
  }
  const c = new Set(by.c)
  const t = new Set(by.t)
  const v = new Set(by.v)
  const g = new Set(by.g)
  const x = new Set(by.x)
  const m = new Set(by.m)
  const i = new Set(by.i)
  const notes: string[] = []
  if (held.size) notes.push(`${held.size} locked ${held.size === 1 ? "object stays" : "objects stay"} where ${held.size === 1 ? "it is" : "they are"}`)
  if (i.size) notes.push(`${i.size === 1 ? "A reference image is" : `${i.size} reference images are`} moved round the pivot, not turned`)
  const next: Project = {
    ...project,
    components: project.components.map((q) => {
      if (!c.has(q.id)) return q
      const p = turn({ x: q.pcb.x, y: q.pcb.y })
      return { ...q, pcb: { ...q.pcb, x: round(p.x), y: round(p.y), rot: (((q.pcb.rot + 90) % 360) as Rotation) } }
    }),
    traces: project.traces.map((q) => (t.has(q.id) ? { ...q, points: q.points.map(turn) } : q)),
    vias: project.vias.map((q) => (v.has(q.id) ? { ...q, ...turn(q) } : q)),
    ...(project.graphics ? { graphics: project.graphics.map((q) => (g.has(q.id) ? turnGraphic(q, turn) : q)) } : {}),
    texts: project.texts.map((q): BoardText => {
      if (!x.has(q.id) || q.layer === undefined) return q
      const p = turn({ x: q.x, y: q.y })
      return { ...q, x: p.x, y: p.y, rot: r6((q.rot + 90) % 360) }
    }),
    ...(project.dimensions ? { dimensions: project.dimensions.map((q) => (m.has(q.id) ? rotateDimension(q, pivot) : q)) } : {}),
    ...(project.images ? { images: project.images.map((q) => (i.has(q.id) ? { ...q, ...turn({ x: q.x, y: q.y }) } : q)) } : {}),
  }
  const turned = carryGenerators(next, new Set([...c, ...t, ...v, ...g, ...x, ...m, ...i]), turn)
  return { project: touch(turned), notes }
}
