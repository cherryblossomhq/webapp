import { boxesOverlap, pointInBox, type Box } from "../../lib/geometry"
import { pcbCourtyard } from "../../model/instances"
import { shapeLayerInfo } from "../../model/shapeLayers"
import { layerText, parseTextId, textLayerKind, worldTexts, type WorldText } from "../../model/texts"
import type { Project, Vec2 } from "../../model/types"
import type { ShapeVisibility } from "./shapeEditing"

// The pure parts of drawing, picking and moving texts in the PCB view, kept out of the component so they can be tested
// without a browser. A text is shown on screen when it is placed on the board and not hidden, its layer is not switched off in the
// Layers menu, and the copper or silkscreen switch of its side is on: the same rule as a drawing's.

/** The shortcut of the text tool. */
export const TEXT_TOOL_KEY = "T"

/** The pen and size a new text starts with on a layer: silkscreen and the other thin layers 1 mm and 0.15 mm, copper 1.5 mm and 0.3 mm. */
export function defaultTextStyle(layer: string): { size: number; thickness: number } {
  return textLayerKind(layer) === "copper" ? { size: 1.5, thickness: 0.3 } : { size: 1, thickness: 0.15 }
}

/** Whether a text is on screen. */
export function textShownOnScreen(t: WorldText, vis: ShapeVisibility): boolean {
  if (!t.placed || t.hidden) return false
  if (vis.hidden[t.layer]) return false
  const info = shapeLayerInfo(t.layer)
  if (info?.kind === "copper") return info.side === "bottom" ? vis.layers.bottom : vis.layers.top
  if (info?.kind === "silk") return vis.layers.silk
  return true
}

export const visibleTexts = (project: Project, vis: ShapeVisibility): WorldText[] => worldTexts(project).filter((t) => textShownOnScreen(t, vis))

const inflate = (b: Box, d: number): Box => ({ minX: b.minX - d, minY: b.minY - d, maxX: b.maxX + d, maxY: b.maxY + d })

/** The box a text takes on screen, the pen and a knockout's margin included; null for a text with nothing to draw. */
export function textBox(project: Project, t: WorldText): Box | null {
  return layerText(project, t)?.box ?? null
}

const near = (p: Vec2, b: Box, tol: number) => p.x >= b.minX - tol && p.x <= b.maxX + tol && p.y >= b.minY - tol && p.y <= b.maxY + tol

/** A part's text on a layer that is not copper or silkscreen (its fab, courtyard, mask, paste, adhesive or user layers): what a part carries as documentation. */
const isDocumentationText = (t: WorldText) => t.owner !== "#board" && textLayerKind(t.layer) !== "silk" && textLayerKind(t.layer) !== "copper"

/** Whether a placed part's body (its courtyard) is under a point. */
const bodyUnder = (project: Project, at: Vec2) =>
  project.components.some((c) => {
    if (!c.pcb.placed) return false
    const cy = pcbCourtyard(c)
    return !!cy && pointInBox(at, cy)
  })

/**
 * The topmost visible text under a point: the point is within `tol` of its box. Later texts are on top; a part's come after the board's, so
 * they win a tie. A part's documentation text (the fab layer's `${REFERENCE}` that every KiCad footprint has, a user layer's note) does not
 * win over the body of a part under the point, as in KiCad: a click on a part's middle picks the part, and a drag moves it, not the text.
 */
export function hitText(project: Project, at: Vec2, tol: number, vis: ShapeVisibility): WorldText | null {
  const all = visibleTexts(project, vis)
  const body = all.some(isDocumentationText) && bodyUnder(project, at)
  for (let i = all.length - 1; i >= 0; i--) {
    if (body && isDocumentationText(all[i])) continue
    const b = textBox(project, all[i])
    if (b && near(at, b, tol)) return all[i]
  }
  return null
}

/** The texts a marquee touches, as selection ids: board texts and the texts of parts. */
export function marqueeTexts(project: Project, box: Box, vis: ShapeVisibility): string[] {
  const out: string[] = []
  for (const t of visibleTexts(project, vis)) {
    const b = textBox(project, t)
    if (b && boxesOverlap(box, inflate(b, 0))) out.push(t.id)
  }
  return out
}

/** The selection ids of texts in a selection. */
export const textIds = (selection: string[]): string[] => selection.filter((s) => parseTextId(s) !== null)

/** The texts of a selection that are free to move (not locked), as board text ids and part text places. */
export function movableTexts(project: Project, selection: string[]): { board: string[]; parts: { component: string; index: number }[]; locked: number } {
  const board: string[] = []
  const parts: { component: string; index: number }[] = []
  let locked = 0
  const byId = new Map(worldTexts(project).map((t) => [t.id, t]))
  for (const id of textIds(selection)) {
    const t = byId.get(id)
    const parsed = parseTextId(id)
    if (!t || !parsed) continue
    if (t.locked) {
      locked++
      continue
    }
    if (parsed.kind === "board") board.push(parsed.text)
    else parts.push({ component: parsed.component, index: parsed.index })
  }
  return { board, parts, locked }
}
