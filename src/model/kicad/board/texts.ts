// Ported from KiCad (https://gitlab.com/kicad/code/kicad): `PCB_IO_KICAD_SEXPR_PARSER::parsePCB_TEXT`, `parsePCB_TEXTBOX`, `parseEDA_TEXT` and the footprint text rules (pcbnew/pcb_io/kicad_sexpr/pcb_io_kicad_sexpr_parser.cpp), `FOOTPRINT::GetFieldText` rules (pcbnew/footprint.cpp).
// Copyright The KiCad Developers, see AUTHORS.txt for contributors. This program source code file is part of KiCad, a free EDA
// CAD application. This program is free software; you can redistribute it and/or modify it under the terms of the GNU General
// Public License as published by the Free Software Foundation; either version 2 of the License, or (at your option) any later
// version. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied
// warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU General Public License for more details. You
// should have received a copy of the GNU General Public License along with this program; if not, see
// <https://www.gnu.org/licenses/>.

import { rotate90 } from "../../../lib/geometry"
import { kiRound, mmToIu } from "../../../lib/kicadText"
import { flipShapeLayer } from "../../shapeLayers"
import { boardTextWorld, isTextLayer, outlineSignatureOf, partTextWorld, textInk, textPose, type WorldText } from "../../texts"
import { packRings } from "../../textOutlines"
import type { BoardText, ComponentInstance, PartText, PcbSide, Project, TextAttrs, TextOutline } from "../../types"
import { resolveLayer } from "./graphics"
import type { KicadBoard, KicadText } from "./types"

// KiCad's text objects (`gr_text`, `gr_text_box`, a footprint's `fp_text` and `property`) as the editor's texts
// (X9). A text keeps what KiCad keeps: where it is, its size, thickness, justification, mirror, bold, italic,
// knockout, line spacing and whether it keeps upright; a part's texts are in the part's land frame (the part with no
// turn, on the top), so they follow the part, and a text of a part on the bottom is the library's, as its pads are
// (`landPad`, build.ts): see `partTextWorld` (model/texts.ts) for the map back.

const r6 = (n: number) => {
  const v = Math.round(n * 1e6) / 1e6
  return Object.is(v, -0) ? 0 : v
}

const norm360 = (a: number) => ((a % 360) + 360) % 360

/** KiCad's name for its own stroke font; any other face is a TrueType font (X19). */
export const KICAD_FONT_NAME = "KiCad Font"

/** The font a text names that is not KiCad's own, or null for a text in KiCad's stroke font. A cache with no face is a font the file does not name. */
export function faceOf(t: KicadText): string | null {
  if (t.face !== null && !t.face.startsWith(KICAD_FONT_NAME)) return t.face
  return t.renderCache && t.face === null ? UNNAMED_FONT : null
}

/** What a text is said to be in when the file caches its outlines and names no font. */
export const UNNAMED_FONT = "a font the file does not name"

/** The outlines of a text, kept with the pose and the look they were drawn at: the world text is the text as the model has it. */
function outlineOf(t: KicadText, wt: WorldText): TextOutline | undefined {
  const c = t.renderCache
  if (!c) return undefined
  const { x, y, rot, mirror } = textPose(wt)
  return { text: c.text, angle: c.angle, sig: outlineSignatureOf(wt), at: { x, y, rot, ...(mirror ? { mirror: true as const } : {}) }, rings: packRings(c.polygons) }
}

/** The first stamp whose files store a bold text's thickness without the bold multiplier (master parser line 898: `MigrateLegacyBoldStrokeWidth` runs for older ones; KiCad 10.0 has no migration). */
export const BOLD_BASE_THICKNESS_FROM = 20260826

/** What KiCad does to an older file's bold stroke text (master eda_text.cpp:332): the stored width is divided by the 1.6 bold multiplier, so drawing it again multiplies it back. */
export function baseThickness(t: Pick<KicadText, "thickness" | "bold">, stamp: number | null): number {
  const iu = mmToIu(t.thickness)
  if (!t.bold || iu <= 1 || (stamp !== null && stamp >= BOLD_BASE_THICKNESS_FROM)) return iu
  return Math.max(2, kiRound(iu / 1.6))
}

export interface TextConversion {
  board: KicadBoard
  /** What cannot be held, by reason. */
  lose: (what: string) => void
  /** A label for messages: where the text is. */
  where: string
}

/** The attributes a text carries besides its place, or null when its layer is not one the editor has (said through `lose`). */
function attrsOf(t: KicadText, cx: TextConversion, layer: string): (TextAttrs & { size: number }) | null {
  const face = faceOf(t)
  const thickness = baseThickness(t, cx.board.version)
  const attrs: TextAttrs & { size: number } = {
    layer,
    size: r6(t.h),
    ...(r6(t.w) !== r6(t.h) ? { w: r6(t.w) } : {}),
    ...(thickness > 1 ? { thickness: r6(thickness / 1e6) } : {}),
    ...(t.bold ? { bold: true as const } : {}),
    ...(t.italic ? { italic: true as const } : {}),
    ...(t.mirror ? { mirror: true as const } : {}),
    ...(t.knockout ? { knockout: true as const } : {}),
    ...(t.justify.includes("left") ? { hj: "left" as const } : t.justify.includes("right") ? { hj: "right" as const } : {}),
    ...(t.justify.includes("top") ? { vj: "top" as const } : t.justify.includes("bottom") ? { vj: "bottom" as const } : {}),
    ...(t.lineSpacing !== 1 ? { spacing: t.lineSpacing } : {}),
    ...(t.href ? { href: t.href } : {}),
    ...(t.locked ? { locked: true as const } : {}),
    ...(face !== null ? { face } : {}),
  }
  return attrs
}

/** The layer of a text in the editor, or null for one it does not have. Inner copper is X1's and is not drawn here. */
function layerOf(t: KicadText, cx: TextConversion): string | null {
  const r = resolveLayer(cx.board, t.layer)
  if (r.kind === "unknown") {
    cx.lose(`text on the layer "${t.layer}", which is not one of KiCad's (${cx.where})`)
    return null
  }
  if (r.kind === "inner") {
    cx.lose(`text on ${t.layer}, a copper layer the board's layer table does not list (${cx.where})`)
    return null
  }
  return isTextLayer(r.name) ? r.name : null
}

const sideOf = (layer: string): PcbSide => (layer.startsWith("B.") ? "bottom" : "top")

/**
 * The first stamp whose files store a text box as the rectangle of its own frame, which the angle then turns about the
 * centre: `FIRST_FP_AFFINE_TRANSFORM` (20260616, "Footprint affine transform: lib-frame storage"), from which the writer
 * saves `GetLibraryStart`/`GetLibraryEnd` and the angle (`PCB_TEXTBOX::GetCornersInSequence` of master, which rotates the
 * rectangle by the angle for every angle). A file of an older stamp (KiCad 7 to 10.0) stores the rectangle as it is drawn
 * and only re-sequences its corners by the angle (`EDA_SHAPE::GetCornersInSequence` of 10.0.0, pcb_textbox.cpp
 * `GetAnchorAndOppositeCorner` of 9.0.0): at 90 and 270 degrees the text runs along the stored box's height.
 */
export const BOX_LIB_FRAME_FROM = 20260616

/** The box of a text box in the editor's frame: its centre, size and margins; null when it cannot be one (said through `lose`). */
function boxOf(t: KicadText, size: number, stamp: number | null, lose: (what: string) => void, where: string): { cx: number; cy: number; box: NonNullable<TextAttrs["box"]> } | null {
  const b = t.box
  if (!b) return null
  const dx = Math.abs(b.end.x - b.start.x)
  const dy = Math.abs(b.end.y - b.start.y)
  const angle = norm360(t.angle)
  const quarter = angle % 90 === 0
  const libFrame = stamp !== null && stamp >= BOX_LIB_FRAME_FROM
  if (!libFrame && !quarter) {
    // KiCad 9 and 10 write such a box as a polygon (`pts`, refused above); a rectangle turned by another angle is what they cannot draw.
    lose(`a rectangular text box turned by ${angle} degrees in a file of stamp ${stamp ?? "unknown"}, which KiCad does not draw (${where})`)
    return null
  }
  // The text's own width is the stored box's width, unless the file stores the rectangle as drawn and the angle is 90 or 270.
  const turned = !libFrame && (angle === 90 || angle === 270)
  const w = turned ? dy : dx
  const h = turned ? dx : dy
  // KiCad's default margin for a box that names none: half the stroke width (a nanometre when there is no stroke) plus three quarters of the text height (`GetLegacyTextMargin`, pcb_textbox.cpp:192).
  const legacy = kiRound((b.strokeWidth === null ? -1 : mmToIu(b.strokeWidth)) / 2) + kiRound(mmToIu(size) * 0.75)
  const margins: [number, number, number, number] = b.margins ? b.margins.map(r6) as [number, number, number, number] : [r6(legacy / 1e6), r6(legacy / 1e6), r6(legacy / 1e6), r6(legacy / 1e6)]
  const border = b.border && b.strokeWidth !== null && b.strokeWidth > 0 ? r6(b.strokeWidth) : undefined
  return { cx: (b.start.x + b.end.x) / 2, cy: -(b.start.y + b.end.y) / 2, box: { w: r6(w), h: r6(h), ...(border !== undefined ? { border } : {}), margins } }
}

/** A `gr_text` or `gr_text_box` as a board text, or null when it cannot be one (said through `lose`). */
export function convertBoardText(t: KicadText, cx: TextConversion, id: string): BoardText | null {
  if (t.box?.hasOutline) {
    cx.lose(`a text box that is an outline of points (${cx.where})`)
    return null
  }
  const layer = layerOf(t, cx)
  if (!layer) return null
  const attrs = attrsOf(t, cx, layer)
  if (!attrs) return null
  const box = boxOf(t, t.h, cx.board.version, cx.lose, cx.where)
  if (t.box && !box) return null
  const { size, ...rest } = attrs
  // Board text cannot be hidden in KiCad (`parsePCB_TEXT`, 10.0.0 parser lines 3846-3854: a hide node of a board text is refused, master 4586), and has no keep upright.
  const at = box ? { x: box.cx, y: box.cy } : { x: t.at.x, y: -t.at.y }
  const made: BoardText & { layer: string } = { ...rest, ...(box ? { box: box.box } : {}), id, text: t.text, x: r6(at.x), y: r6(at.y), size, rot: r6(norm360(t.angle)), side: sideOf(layer), layer }
  const outline = made.face !== undefined ? outlineOf(t, boardTextWorld(made)) : undefined
  return outline ? { ...made, outline } : made
}

/** Where the part sits, for turning a text's place on the board into a place in its land. */
export interface PartPlacement {
  /** The footprint's position on the board in the editor's frame (y up), its quarter-turn placement and its side. */
  x: number
  y: number
  rot: number
  bottom: boolean
  /** The footprint's own position and angle in KiCad's frame, with which a text's stored position is turned onto the board. */
  at: { x: number; y: number }
  angle: number
}

/**
 * A part's texts, in the order of the file, in the land's frame. A text's place on the board is the footprint's position
 * plus its stored place turned by the footprint's angle (the same map as a pad's, `padWorld`); the land's place is that
 * through the placement taken back, `rot` and then a mirror on the bottom (`transformPoint`); its angle is the part's turn
 * plus the text's on the top and the part's turn minus the text's on the bottom (a mirror turns the other way), its
 * mirror flag the other way on the bottom, and its layer the other side.
 */
export function convertPartTexts(texts: KicadText[], ref: string, place: PartPlacement, cx: TextConversion, shown: { ref: string }, origins?: number[]): PartText[] {
  const out: PartText[] = []
  const c = Math.cos((place.angle * Math.PI) / 180)
  const s = Math.sin((place.angle * Math.PI) / 180)
  for (const [source, t] of texts.entries()) {
    if (t.box) {
      cx.lose(`a text box inside a footprint (${ref})`)
      continue
    }
    const where = `${ref}, ${t.kind === "user" ? (t.field ?? "text") : t.kind}`
    const here = { ...cx, where }
    const resolved = layerOf(t, here)
    if (!resolved) continue
    const attrs = attrsOf(t, here, resolved)
    if (!attrs) continue
    // The board's place of the text, then the editor's frame (y up), then the land's.
    const wx = place.at.x + (t.at.x * c + t.at.y * s)
    const wy = place.at.y + (-t.at.x * s + t.at.y * c)
    const ex = wx
    const ey = -wy
    const dx = ex - place.x
    const dy = ey - place.y
    // Taken back through the placement: turn by -rot, then mirror x on the bottom.
    const back = rotate90({ x: dx, y: dy }, -place.rot)
    const rx = back.x
    const ry = back.y
    const lx = place.bottom ? -rx : rx
    const ly = ry
    const world = norm360(t.angle)
    const landAngle = place.bottom ? place.rot - world : world - place.rot
    const mirror = place.bottom ? !t.mirror : t.mirror
    const layer = place.bottom ? flipShapeLayer(resolved, cx.board.copper.names.length || 2) : resolved
    const { size, mirror: _mirror, ...rest } = attrs
    const kind = t.kind === "reference" || t.kind === "value" ? t.kind : "user"
    origins?.push(source)
    // A reference or value says what it shows only when that is not the part's own (a part KiCad names `REF**` is renamed).
    const text = kind === "user" ? t.text : kind === "reference" && t.text !== shown.ref ? t.text : undefined
    const made: PartText = {
      ...rest,
      layer,
      ...(mirror ? { mirror: true as const } : {}),
      ...(t.keepUpright ? {} : { upright: false as const }),
      ...(t.hide ? { hide: true as const } : {}),
      kind,
      ...(text !== undefined ? { text } : {}),
      x: r6(lx),
      y: r6(ly),
      size,
      rot: r6(norm360(landAngle)),
    }
    // The outlines are kept with the pose the part gives the text, worked out by the very function the editor draws it by (the part is as the component will have it).
    if (made.face !== undefined && t.renderCache) {
      const stub = { id: "", partId: "", ref, props: {}, footprint: "", sch: { x: 0, y: 0, rot: 0 }, pcb: { x: place.x, y: place.y, rot: place.rot, side: place.bottom ? "bottom" : "top", placed: true } } as unknown as ComponentInstance
      const outline = outlineOf(t, partTextWorld(stub, made, out.length, cx.board.copper.names.length || 2))
      if (outline) made.outline = outline
    }
    out.push(made)
  }
  return out
}

/** The box of the ink of a land's texts that are drawn (the land's own frame, mm), for selecting a part that is nothing but text; null when there is none. */
export function landTextBox(texts: PartText[]): { minX: number; minY: number; maxX: number; maxY: number } | null {
  const stub = { id: "", partId: "", ref: "", props: {}, footprint: "", sch: { x: 0, y: 0, rot: 0 }, pcb: { x: 0, y: 0, rot: 0, side: "top", placed: true }, texts } as unknown as ComponentInstance
  const project = { properties: undefined, name: "", components: [stub], texts: [] } as unknown as Project
  let box: { minX: number; minY: number; maxX: number; maxY: number } | null = null
  texts.forEach((t, i) => {
    if (t.hide) return
    const wt = partTextWorld(stub, t, i, 2)
    const ink = textInk(project, wt)
    if (!ink.box) return
    box = box ? { minX: Math.min(box.minX, ink.box.minX), minY: Math.min(box.minY, ink.box.minY), maxX: Math.max(box.maxX, ink.box.maxX), maxY: Math.max(box.maxY, ink.box.maxY) } : { ...ink.box }
  })
  const b = box as { minX: number; minY: number; maxX: number; maxY: number } | null
  return b ? { minX: r6(b.minX), minY: r6(b.minY), maxX: r6(b.maxX), maxY: r6(b.maxY) } : null
}
