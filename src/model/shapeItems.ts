import { dimensionShapes } from "./dimensions"
import { findPart } from "./library"
import { isPhysical, pcbShapes } from "./instances"
import { shapeLayerInfo, type ShapeLayerKind } from "./shapeLayers"
import { copperCount } from "./stack"
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
  /** For a line or circle of a dimension (X11): the id of the dimension it belongs to. It is drawn and plotted as any drawing of its layer is, and is not a drawing of the project: the editor selects the dimension (`select`), and the KiCad export writes the dimension. */
  dim?: string
  /** What clicking it selects, when that is not `id`. */
  select?: string
}

export const BOARD_SHAPE_OWNER = "#board"

export const boardShapeId = (graphicId: string) => `g:${graphicId}`
export const landShapeId = (componentId: string, index: number) => `s:${componentId}:${index}`
/** The selection id of a dimension. */
export const dimensionId = (dimension: string) => `m:${dimension}`

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

/** The drawings of the last two boards asked for, as `worldTexts` keeps their texts: the board on screen, and the copper of only what an edit moved. */
let cache: { board: Project["board"]; components: Project["components"]; graphics: Project["graphics"]; footprints: Project["footprints"]; dimensions: Project["dimensions"]; value: WorldShape[] }[] = []

/** Every drawing of the board and of its parts, in the board's frame, board drawings first. Reused while parts, drawings and lands are unchanged. */
export function worldShapes(project: Project): WorldShape[] {
  const hit = cache.find((c) => c.board === project.board && c.components === project.components && c.graphics === project.graphics && c.footprints === project.footprints && c.dimensions === project.dimensions)
  if (hit) return hit.value
  const out: WorldShape[] = []
  const count = copperCount(project.board)
  for (const g of project.graphics ?? []) out.push({ id: boardShapeId(g.id), owner: BOARD_SHAPE_OWNER, index: 0, shape: g, placed: true })
  // A dimension draws its extension lines, crossbar and arrows as lines of its layer, after the board's own drawings.
  for (const d of project.dimensions ?? []) dimensionShapes(d).forEach((shape, i) => out.push({ id: `${dimensionId(d.id)}:${i}`, owner: BOARD_SHAPE_OWNER, index: 0, shape, placed: true, dim: d.id, select: dimensionId(d.id) }))
  for (const c of project.components) {
    if (!isPhysical(findPart(c.partId))) continue
    pcbShapes(c, count).forEach((shape, index) => out.push({ id: landShapeId(c.id, index), owner: c.id, index, shape, placed: c.pcb.placed }))
  }
  cache = [{ board: project.board, components: project.components, graphics: project.graphics, footprints: project.footprints, dimensions: project.dimensions, value: out }, ...cache.slice(0, 1)]
  return out
}
