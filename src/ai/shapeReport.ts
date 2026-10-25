import { round } from "../lib/geometry"
import { findPart } from "../model/library"
import { BOARD_SHAPE_OWNER, shapeKind, worldShapes } from "../model/shapeItems"
import { SHAPE_NAMES, shapeBox } from "../model/shapes"
import { shownOf, worldTexts } from "../model/texts"
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
  const shapes = worldShapes(project)
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
  const all = worldTexts(project).filter((t) => t.placed)
  if (!all.length) return null
  const by: Record<string, number> = {}
  for (const t of all) if (!t.hidden) bump(by, t.layer)
  const board = all.filter((t) => t.owner === "#board")
  const listed = board.slice(0, TEXT_LIST_CAP).map((t) => ({
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
