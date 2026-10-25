import type { Box } from "../lib/geometry"
import { SCH_TEXT } from "./symbols"
import { textOnSheet } from "./symbolDrawing"
import type { NetLabel, TextLook, Vec2 } from "./types"

// S2: how a label from KiCad is laid out on the sheet. A local label is its text beside its point; a
// global label is a flag (`SCH_GLOBALLABEL::CreateGraphicShape`, sch_label.cpp) whose shape says what
// the signal does. Both take the size, justification and style the file gave them. The editor's own
// labels (no `kind`) are drawn by the editor as before (`model/labels.ts`).

/**
 * The width of a character as a part of the text's height. An estimate: KiCad's newstroke capitals are about 0.95 em wide
 * and its lower case narrower, so 0.6 is a mixed-text average; a flag's width is therefore not exactly KiCad's.
 */
const CHAR_WIDTH = 0.6
/** The gap KiCad leaves around the text of a label, as a part of its height (`labelSizeRatio`). */
const MARGIN = 0.375

export const textSizeOf = (look?: TextLook) => look?.size ?? SCH_TEXT

/** The width a text takes, to the editor's measure: what a flag is built around and a click is tested against. */
export const textWidth = (text: string, size: number) => Math.max(1, text.length) * size * CHAR_WIDTH

/** Whether a label is drawn by KiCad's rules rather than the editor's own flag. */
export const isKicadLabel = (l: Pick<NetLabel, "kind">) => l.kind !== undefined

/** The justification a label has when its file names none: by the way it points, as KiCad writes it. */
export function labelJustify(l: Pick<NetLabel, "rot" | "kind" | "look">): { h: "left" | "right"; v: "top" | "bottom" | undefined } {
  const away = l.rot === 180 || l.rot === 270
  return { h: l.look?.h ?? (away ? "right" : "left"), v: l.look?.v ?? (l.kind === "global" ? undefined : "bottom") }
}

/** The box a text covers: from its anchor, on the sides its extent names, `width` along the text and `height` across it. */
export function textBox(at: Vec2, extent: { x: number; y: number }, vertical: boolean, width: number, height: number): Box {
  const dx = vertical ? height : width
  const dy = vertical ? width : height
  const span = (from: number, e: number, d: number): [number, number] => (e > 0 ? [from, from + d] : e < 0 ? [from - d, from] : [from - d / 2, from + d / 2])
  const [minX, maxX] = span(at.x, extent.x, dx)
  const [minY, maxY] = span(at.y, extent.y, dy)
  return { minX, minY, maxX, maxY }
}

export interface LabelGeometry {
  /** The flag's outline, closed, for a global label; none for a local one. */
  outline: Vec2[]
  /** Where the text is anchored, which way it extends from there, and whether it reads up the sheet. */
  text: { x: number; y: number; extent: { x: -1 | 0 | 1; y: -1 | 0 | 1 }; vertical: boolean; size: number }
  /** The box the label covers, for picking it and for keeping other things clear of it. */
  box: Box
}

const unionBox = (a: Box, b: Box): Box => ({ minX: Math.min(a.minX, b.minX), minY: Math.min(a.minY, b.minY), maxX: Math.max(a.maxX, b.maxX), maxY: Math.max(a.maxY, b.maxY) })

/** A label from KiCad, laid out. */
export function labelGeometry(l: NetLabel): LabelGeometry {
  const size = textSizeOf(l.look)
  const len = textWidth(l.name, size)
  const vertical = l.rot === 90 || l.rot === 270
  const angle = vertical ? 90 : 0
  if (l.kind !== "global") {
    // The text's angle is the label's mod 180, and its justification names the side of the point it extends to.
    const j = labelJustify(l)
    const { extent, vertical: v } = textOnSheet(angle, j.h, j.v, { rot: 0 })
    return { outline: [], text: { x: l.x, y: l.y, extent, vertical: v, size }, box: textBox(l, extent, v, len, size) }
  }
  // A global label: a flag whose body runs from the point along its direction, as long as the text and its margins, as high as the text and its margins.
  const margin = size * MARGIN
  const half = size / 2 + margin
  const body = len + 2 * margin
  const shape = l.shape ?? "passive"
  const nearTip = shape === "input" || shape === "bidirectional" || shape === "tri_state"
  const farTip = shape === "output" || shape === "bidirectional" || shape === "tri_state"
  const d = { x: l.rot === 0 ? 1 : l.rot === 180 ? -1 : 0, y: l.rot === 90 ? 1 : l.rot === 270 ? -1 : 0 }
  const n = { x: -d.y, y: d.x }
  const at = (s: number, t: number): Vec2 => ({ x: l.x + d.x * s + n.x * t, y: l.y + d.y * s + n.y * t })
  const start = nearTip ? half : 0
  const outline: Vec2[] = nearTip ? [at(0, 0), at(start, half), at(start + body, half)] : [at(start, half), at(start + body, half)]
  if (farTip) outline.push(at(start + body + half, 0))
  outline.push(at(start + body, -half), at(start, -half))
  const xs = outline.map((p) => p.x)
  const ys = outline.map((p) => p.y)
  const box = { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) }
  // The text is centred on the flag's axis, starting a margin in from the near end. A flag that runs against the reading direction has the text end there instead.
  const anchor = at(start + margin, 0)
  const { extent, vertical: v } = textOnSheet(angle, d.x < 0 || d.y < 0 ? "right" : "left", undefined, { rot: 0 })
  return { outline, text: { x: anchor.x, y: anchor.y, extent, vertical: v, size }, box: unionBox(box, textBox(anchor, extent, v, len, size)) }
}
