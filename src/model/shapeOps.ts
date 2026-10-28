import { uid } from "../lib/id"
import { remapPartGroups } from "./boardObjects"
import { registerProjectFootprints } from "./footprints"
import { isShapeLayer } from "./shapeLayers"
import { isClosedShape, mapShape } from "./shapes"
import type { BoardGraphic, BoardShape, FootprintDef, Project, ShapeDash, Vec2 } from "./types"

// Editing drawings: those on the board (`Project.graphics`) and those inside a part's land
// (`FootprintDef.shapes` of a land the project owns). Every function returns a new project, or the
// same one when nothing changed, and keeps shapes valid: a layer is one of KiCad's drawing layers,
// a width is not negative, only a closed shape is filled.

const touch = (p: Project): Project => ({ ...p, updatedAt: Date.now() })
const r6 = (n: number) => Math.round(n * 1e6) / 1e6 || 0

/** What can be changed on a drawing without changing what it is. `null` for dash, net or lock clears it. */
export interface ShapePatch {
  layer?: string
  width?: number
  dash?: ShapeDash | null
  fill?: boolean
  net?: string | null
  locked?: boolean
}

export function patchShape<T extends BoardShape>(shape: T, patch: ShapePatch): T {
  const next: BoardShape = { ...shape }
  if (patch.layer !== undefined && isShapeLayer(patch.layer)) next.layer = patch.layer
  if (patch.width !== undefined && Number.isFinite(patch.width)) next.width = r6(Math.max(0, patch.width))
  if (patch.dash !== undefined) {
    if (patch.dash) next.dash = patch.dash
    else delete next.dash
  }
  if (patch.fill !== undefined) {
    if (patch.fill && isClosedShape(next)) next.fill = true
    else delete next.fill
  }
  if (patch.net !== undefined) {
    if (patch.net && patch.net.trim()) next.net = patch.net.trim()
    else delete next.net
  }
  if (patch.locked !== undefined) {
    if (patch.locked) next.locked = true
    else delete next.locked
  }
  return next as T
}

/** A drawing moved by (dx, dy), every point of it, with coordinates held to a millionth of a millimetre. */
export function moveShape<T extends BoardShape>(shape: T, dx: number, dy: number): T {
  return mapShape(shape, (p: Vec2) => ({ x: r6(p.x + dx), y: r6(p.y + dy) }))
}

// ---------- on the board ----------

/** A new drawing on the board. The geometry must be a valid one for its type (the editor's drawing tools make them). */
export function addGraphic(project: Project, shape: BoardShape): { project: Project; graphic: BoardGraphic } {
  const graphic = { ...patchShape(shape, {}), id: uid("g") } as BoardGraphic
  return { project: touch({ ...project, graphics: [...(project.graphics ?? []), graphic] }), graphic }
}

export function updateGraphics(project: Project, ids: string[], patch: ShapePatch): Project {
  const set = new Set(ids)
  if (!project.graphics?.some((g) => set.has(g.id))) return project
  return touch({ ...project, graphics: project.graphics.map((g) => (set.has(g.id) ? patchShape(g, patch) : g)) })
}

/** Moves the drawings that are not locked; a locked one stays where it is. */
export function moveGraphics(project: Project, ids: string[], dx: number, dy: number): Project {
  const set = new Set(ids)
  if (!project.graphics?.some((g) => set.has(g.id) && !g.locked) || (dx === 0 && dy === 0)) return project
  return touch({ ...project, graphics: project.graphics.map((g) => (set.has(g.id) && !g.locked ? moveShape(g, dx, dy) : g)) })
}

export function removeGraphics(project: Project, ids: string[]): Project {
  const set = new Set(ids)
  if (!project.graphics?.some((g) => set.has(g.id))) return project
  const graphics = project.graphics.filter((g) => !set.has(g.id))
  const { graphics: _old, ...rest } = project
  return touch({ ...rest, ...(graphics.length ? { graphics } : {}) })
}

// ---------- in a part's land ----------

/** The land a component is drawn with, when the project owns it (a land from the library or the footprinter is not edited). */
export function ownLand(project: Project, componentId: string): FootprintDef | null {
  const c = project.components.find((x) => x.id === componentId)
  return (c && project.footprints?.find((f) => f.name === c.footprint)) || null
}

function withLand(project: Project, name: string, edit: (shapes: BoardShape[]) => BoardShape[]): Project {
  const land = project.footprints?.find((f) => f.name === name)
  if (!land?.shapes) return project
  const shapes = edit(land.shapes)
  if (shapes === land.shapes) return project
  const { shapes: _old, ...rest } = land
  const next: FootprintDef = { ...rest, ...(shapes.length ? { shapes } : {}) }
  registerProjectFootprints({ footprints: [next] })
  return touch({ ...project, footprints: project.footprints!.map((f) => (f.name === name ? next : f)) })
}

/** Every part drawn with this land changes with it: the land is the part's, not the instance's. */
export function updateLandShapes(project: Project, land: string, indices: number[], patch: ShapePatch): Project {
  const set = new Set(indices)
  return withLand(project, land, (shapes) => (shapes.some((_, i) => set.has(i)) ? shapes.map((s, i) => (set.has(i) ? patchShape(s, patch) : s)) : shapes))
}

/** Moves the land's drawings by (dx, dy) in the land's own frame (the part's, before it is turned or flipped). */
export function moveLandShapes(project: Project, land: string, indices: number[], dx: number, dy: number): Project {
  const set = new Set(indices)
  if (dx === 0 && dy === 0) return project
  return withLand(project, land, (shapes) => (shapes.some((s, i) => set.has(i) && !s.locked) ? shapes.map((s, i) => (set.has(i) && !s.locked ? moveShape(s, dx, dy) : s)) : shapes))
}

export function removeLandShapes(project: Project, land: string, indices: number[]): Project {
  const set = new Set(indices)
  const next = withLand(project, land, (shapes) => (shapes.some((_, i) => set.has(i)) ? shapes.filter((_, i) => !set.has(i)) : shapes))
  if (next === project || !next.components.some((c) => c.groups && c.footprint === land)) return next
  // The parts drawn with this land hold groups of its drawings by place: the later places shift down.
  return { ...next, components: next.components.map((c) => (c.footprint === land ? remapPartGroups(c, "s", set) : c)) }
}
