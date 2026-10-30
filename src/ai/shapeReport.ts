import { round } from "../lib/geometry"
import { findPart } from "../model/library"
import { BOARD_SHAPE_OWNER, shapeKind, worldShapes } from "../model/shapeItems"
import { SHAPE_NAMES, shapeBox } from "../model/shapes"
import { dimensionDrawing } from "../model/dimensions"
import { isDimensionText, shownOf, worldTexts } from "../model/texts"
import type { Project } from "../model/types"

// What get_design says about drawings: counts per layer, the copper ones in full, and how many parts
// have no pins. A project with no drawings says nothing, so its output is what it always was.

/** How many copper drawings are listed before the rest are only counted. */
export const COPPER_LIST_CAP = 20

const bump = (m: Record<string, number>, key: string) => {
  m[key] = (m[key] ?? 0) + 1
}

export interface DrawingsReport {
  board_by_layer: Record<string, number>
  part_by_layer: Record<string, number>
  copper: { type: string; layer: string; width: number; net?: string; owner: string; box_mm: number[] }[]
  copper_more?: string
  parts_without_pins: number
}

/** The report of a project's drawings, or null when it has none. */
export function drawingsReport(project: Project): DrawingsReport | null {
  // The lines of a dimension are reported with the dimension (`dimensionsReport`), not as drawings.
  const shapes = worldShapes(project).filter((w) => !w.dim)
  if (!shapes.length) return null
  const refOf = new Map(project.components.map((c) => [c.id, c.ref]))
  const board: Record<string, number> = {}
  const part: Record<string, number> = {}
  const copper: DrawingsReport["copper"] = []
  for (const w of shapes) {
    const onBoard = w.owner === BOARD_SHAPE_OWNER
    bump(onBoard ? board : part, w.shape.layer)
    if (shapeKind(w.shape) !== "copper") continue
    const b = shapeBox(w.shape)
    copper.push({
      type: SHAPE_NAMES[w.shape.type].toLowerCase(),
      layer: w.shape.layer,
      width: round(w.shape.width, 3),
      ...(w.shape.net && { net: w.shape.net }),
      owner: onBoard ? "board" : (refOf.get(w.owner) ?? w.owner),
      box_mm: [round(b.minX, 2), round(b.minY, 2), round(b.maxX, 2), round(b.maxY, 2)],
    })
  }
  const noPins = project.components.filter((c) => {
    const p = findPart(c.partId)
    return !!p && !p.powerNet && p.pins.length === 0
  }).length
  return {
    board_by_layer: board,
    part_by_layer: part,
    copper: copper.slice(0, COPPER_LIST_CAP),
    ...(copper.length > COPPER_LIST_CAP && { copper_more: `and ${copper.length - COPPER_LIST_CAP} more copper drawings` }),
    parts_without_pins: noPins,
  }
}

/** How many board texts are listed before the rest are only counted. */
export const TEXT_LIST_CAP = 20

export interface TextsReport {
  count: number
  by_layer: Record<string, number>
  hidden: number
  /** Text on the board itself, as shown. */
  board: { layer: string; text: string; x: number; y: number; size: number; angle?: number; knockout?: true }[]
  board_more?: string
  /** Parts whose designator is the file's own text, and how many of them show it. */
  parts_with_text: number
  designators_hidden: number
}

/** What get_design says about KiCad texts, or null when the project has none, so a board drawn here says nothing new. */
export function textsReport(project: Project): TextsReport | null {
  const all = worldTexts(project).filter((t) => t.placed && !isDimensionText(t))
  if (!all.length) return null
  const by: Record<string, number> = {}
  for (const t of all) if (!t.hidden) bump(by, t.layer)
  const board = all.filter((t) => t.owner === "#board")
  const listed = board.slice(0, TEXT_LIST_CAP).map((t) => ({
    // what pcb_text changes it by
    id: project.texts[t.index].id,
    layer: t.layer,
    text: shownOf(project, t),
    x: round(t.x, 3),
    y: round(t.y, 3),
    size: round(t.size, 3),
    ...(t.drawRot ? { angle: round(t.drawRot, 2) } : {}),
    ...(t.knockout ? { knockout: true as const } : {}),
  }))
  const parts = project.components.filter((c) => c.texts)
  return {
    count: all.length,
    by_layer: by,
    hidden: all.filter((t) => t.hidden).length,
    board: listed,
    ...(board.length > TEXT_LIST_CAP && { board_more: `and ${board.length - TEXT_LIST_CAP} more board texts` }),
    parts_with_text: parts.length,
    designators_hidden: parts.filter((c) => !c.texts!.some((t) => t.kind === "reference" && !t.hide)).length,
  }
}

/** How many dimensions are listed before the rest are only counted. */
export const DIMENSION_LIST_CAP = 20

export interface DimensionsReport {
  count: number
  by_layer: Record<string, number>
  by_kind: Record<string, number>
  /** The first dimensions: kind, layer, the text KiCad shows and the value it measures (mm). */
  list: { id: string; kind: string; layer: string; text: string; measured_mm: number }[]
  more?: string
}

/** What get_design says about dimensions, or null when the board has none, so a board drawn here says nothing new. */
export function dimensionsReport(project: Project): DimensionsReport | null {
  const dims = project.dimensions
  if (!dims?.length) return null
  const byLayer: Record<string, number> = {}
  const byKind: Record<string, number> = {}
  for (const d of dims) {
    bump(byLayer, d.layer)
    bump(byKind, d.kind)
  }
  return {
    count: dims.length,
    by_layer: byLayer,
    by_kind: byKind,
    list: dims.slice(0, DIMENSION_LIST_CAP).map((d) => {
      const draw = dimensionDrawing(d)
      return { id: d.id, kind: d.kind, layer: d.layer, text: draw.text?.content ?? "", measured_mm: round(draw.measured / 1e6, 3) }
    }),
    ...(dims.length > DIMENSION_LIST_CAP && { more: `and ${dims.length - DIMENSION_LIST_CAP} more dimensions` }),
  }
}

/** How many groups are listed before the rest are only counted. */
export const GROUP_LIST_CAP = 20

export interface GroupsReport {
  count: number
  locked: number
  /** The first groups: name (or id when it has none), how many things are in it, and whether it is locked. */
  list: { name: string; members: number; locked?: true }[]
  more?: string
}

/** What get_design says about the board's groups, or null when it has none. A part's own groups (inside its footprint) are not listed. */
export function groupsReport(project: Project): GroupsReport | null {
  const groups = project.groups
  if (!groups?.length) return null
  return {
    count: groups.length,
    locked: groups.filter((g) => g.locked).length,
    list: groups.slice(0, GROUP_LIST_CAP).map((g) => ({ name: g.name || g.id, members: g.members.length, ...(g.locked ? { locked: true as const } : {}) })),
    ...(groups.length > GROUP_LIST_CAP && { more: `and ${groups.length - GROUP_LIST_CAP} more groups` }),
  }
}

export interface ImagesReport {
  count: number
  /** Each image: its layer, where its centre is (mm), and its size on the board (mm). */
  list: { layer: string; x: number; y: number; width_mm: number; height_mm: number; locked?: true }[]
}

/** What get_design says about reference images, or null when the board has none. */
export function imagesReport(project: Project): ImagesReport | null {
  const images = project.images
  if (!images?.length) return null
  return {
    count: images.length,
    list: images.map((m) => ({ layer: m.layer, x: round(m.x, 3), y: round(m.y, 3), width_mm: round(((m.px / m.ppi) * 25.4) * m.scale, 2), height_mm: round(((m.py / m.ppi) * 25.4) * m.scale, 2), ...(m.locked ? { locked: true as const } : {}) })),
  }
}
