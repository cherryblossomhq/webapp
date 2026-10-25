import { findPart } from "./library"
import { isPhysical, pcbShapes } from "./instances"
import { shapeLayerInfo, type ShapeLayerKind } from "./shapeLayers"
import type { BoardShape, Project } from "./types"

// Every drawing on the board in the board's frame, whether it is the board's own or a part's, with
// the id the editor selects it by. Board drawings are `g:<id>`; a part's are `s:<component id>:<index in its land>`.

export interface WorldShape {
  /** Selection id. */
  id: string
  /** `#board`, or the component id. */
  owner: string
  /** Index in the land's `shapes` (0 for a board drawing). */
  index: number
  shape: BoardShape
  /** False for a part not placed on the PCB yet (its drawings are left out of every output, as its pads are of the checks). */
  placed: boolean
}

export const BOARD_SHAPE_OWNER = "#board"

export const boardShapeId = (graphicId: string) => `g:${graphicId}`
export const landShapeId = (componentId: string, index: number) => `s:${componentId}:${index}`

/** What a selection id is: a board drawing, or the drawing of a part's land. */
export function parseShapeId(id: string): { kind: "board"; graphic: string } | { kind: "land"; component: string; index: number } | null {
  if (id.startsWith("g:")) return { kind: "board", graphic: id.slice(2) }
  if (id.startsWith("s:")) {
    const at = id.lastIndexOf(":")
    const index = Number(id.slice(at + 1))
    return at > 2 && Number.isInteger(index) ? { kind: "land", component: id.slice(2, at), index } : null
  }
  return null
}

/** The kind of layer a drawing is on (a name that is none of KiCad's counts as a user layer). */
export const shapeKind = (s: BoardShape): ShapeLayerKind => shapeLayerInfo(s.layer)?.kind ?? "user"

let cache: { components: Project["components"]; graphics: Project["graphics"]; footprints: Project["footprints"]; value: WorldShape[] } | null = null

/** Every drawing of the board and of its parts, in the board's frame, board drawings first. Reused while parts, drawings and lands are unchanged. */
export function worldShapes(project: Project): WorldShape[] {
  if (cache && cache.components === project.components && cache.graphics === project.graphics && cache.footprints === project.footprints) return cache.value
  const out: WorldShape[] = []
  for (const g of project.graphics ?? []) out.push({ id: boardShapeId(g.id), owner: BOARD_SHAPE_OWNER, index: 0, shape: g, placed: true })
  for (const c of project.components) {
    if (!isPhysical(findPart(c.partId))) continue
    pcbShapes(c).forEach((shape, index) => out.push({ id: landShapeId(c.id, index), owner: c.id, index, shape, placed: c.pcb.placed }))
  }
  cache = { components: project.components, graphics: project.graphics, footprints: project.footprints, value: out }
  return out
}
