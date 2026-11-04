// Ported from KiCad (https://gitlab.com/kicad/code/kicad): `ExpandTextVars` and `ResolveTextVars` (common/common.cpp), `EDA_TEXT::GetLinePositions`, `GetEffectiveTextPenWidth` and the text box rules (common/eda_text.cpp, pcbnew/pcb_textbox.cpp), `PCB_TEXT::GetDrawRotation` (pcbnew/pcb_text.cpp) and the knockout of `BRDITEMS_PLOTTER::PlotText` (pcbnew/plot_brditems_plotter.cpp).
// Copyright The KiCad Developers, see AUTHORS.txt for contributors. This program source code file is part of KiCad, a free EDA
// CAD application. This program is free software; you can redistribute it and/or modify it under the terms of the GNU General
// Public License as published by the Free Software Foundation; either version 2 of the License, or (at your option) any later
// version. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied
// warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU General Public License for more details. You
// should have received a copy of the GNU General Public License along with this program; if not, see
// <https://www.gnu.org/licenses/>.

import { copperCount } from "./stack"
import { Clipper, Clipper64, ClipType, EndType, FillRule, JoinType, PolyTree64, type Path64, type Paths64 } from "@countertype/clipper2-ts"
import { transformPoint } from "../lib/geometry"
import { effectivePenWidth, inkBox, iuToMm, kiRound, knockoutMargin, layoutText, linebreakText, mmToIu, strokeFont, type IuBox, type StrokeFontData, type TextAttrsIu, type TextStrokes } from "../lib/kicadText"
import { collect, outlineRings, ringsToPolygons, textOutlineSignature, type Pose } from "./textOutlines"
import { dimensionDrawing } from "./dimensions"
import { findPart } from "./library"
import { isPhysical, valueText } from "./instances"
import { flipShapeLayer, shapeLayerInfo, type ShapeLayerKind } from "./shapeLayers"
import type { BoardDimension, BoardText, ComponentInstance, PartText, Project, TextAttrs, TextOutline, Vec2 } from "./types"

// Text objects on the board (X9): board text, and the reference, value and own text of each part, with
// where each is and how it is drawn as KiCad draws it. A text is laid out by `lib/kicadText.ts` in KiCad's
// own frame and unit; this file turns the model's texts into what every output draws: the strokes in the
// board's frame (y up, millimetres), the knockout of a knockout text, and a text box's border.
//
// Frames. A board text's place is the board's. A part's text is in the part's land frame (the part with no turn
// and on the top side) and goes where the part goes: for a part on the top, its position is turned and
// moved with the part and its angle turns with it; on the bottom, the land is mirrored (`transformPoint`) first, so
// its position is mirrored, its angle is the part's turn minus its own, and its mirror flag is the other way
// round (a mirror and a turn compose: R(rot) Mx R(a) Mx^m = R(rot - a) Mx^(1 - m)), and its layer is on the other side.

/** A text is a KiCad text when it has a layer; one with none is the editor's own silkscreen text and is not handled here. */
export const isKicadText = (t: BoardText): t is BoardText & { layer: string } => t.layer !== undefined

/** The layers a text can be on: the drawing layers and the board's edge. */
export function textLayerKind(layer: string): ShapeLayerKind | "edge" | null {
  if (layer === "Edge.Cuts") return "edge"
  return shapeLayerInfo(layer)?.kind ?? null
}

/** Which side of the board a text layer is on, or null for one that has none (user layers, the edge). */
export function textLayerSide(layer: string): "top" | "bottom" | null {
  return shapeLayerInfo(layer)?.side ?? null
}

export const isTextLayer = (layer: string) => layer === "Edge.Cuts" || shapeLayerInfo(layer) !== null

// ---------- variables ----------

/**
 * The names a text's `${...}` can refer to that this editor has no value for, so a board whose text uses one is not imported (X25): KiCad
 * resolves them from the board file's place on disk or its project, the nets, the variants or its clock. `LAYER`, `FOOTPRINT_NAME`,
 * `FOOTPRINT_LIBRARY` and `FILENAME` are not among them: the board has what they show (`footprintVariable`, `textShown`).
 */
export const UNSUPPORTED_VARIABLES = /^(FILEPATH|PROJECTNAME|VARIANT|VARIANT_DESC|DRILL_OPERATIONS|DRILL_SITES|DRILL_GROUPS|CURRENT_DATE|DNP|EXCLUDE_FROM_[A-Z_]+|PROPERTY\..*|(SHORT_NET_NAME|NET_NAME|NET_CLASS|PIN_NAME)\(.*\))$/

/** The title block's variable names and the property of the project each reads (the importer keeps the title block as properties). */
export const TITLE_BLOCK: Record<string, string> = { TITLE: "Title", ISSUE_DATE: "Date", REVISION: "Rev", COMPANY: "Company" }

/** Every `${...}` token of a text, outermost first, nested ones inside their parent, without the braces. */
export function textVariables(text: string): string[] {
  const out: string[] = []
  const scan = (s: string) => {
    for (let i = 0; i < s.length; i++) {
      if (s[i] === "\\" && (s[i + 1] === "$" || s[i + 1] === "@") && s[i + 2] === "{") {
        let depth = 1
        let j = i + 3
        while (j < s.length && depth > 0) depth += s[j] === "{" ? 1 : s[j] === "}" ? -1 : 0, j++
        i = j - 1
        continue
      }
      if (s[i] === "$" && s[i + 1] === "{") {
        let depth = 1
        let j = i + 2
        while (j < s.length) {
          if (s[j] === "{") depth++
          else if (s[j] === "}" && --depth === 0) break
          j++
        }
        const token = s.slice(i + 2, j)
        if (token) {
          out.push(token)
          scan(token)
        }
        i = j
      }
    }
  }
  scan(text)
  return out
}

/** Whether a text holds an expression `@{...}` (KiCad evaluates it; this editor does not). */
export const hasExpression = (text: string) => /(^|[^\\])@\{/.test(text) || text.startsWith("@{")

/**
 * `ExpandTextVars` and `ResolveTextVars` (common.cpp:103-345): each `${NAME}` is replaced by what `resolve` says
 * and left as it is when it says nothing; a name with another `${...}` inside is expanded inside out; `\${X}` is
 * the text `${X}`; `${}` is nothing. Up to ten passes, as KiCad's depth limit.
 */
export function expandTextVars(text: string, resolve: (token: string) => string | null, depth = 0): string {
  if (!text.includes("${")) return text.replace(/\\\$\{/g, "${")
  let out = ""
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\\" && text[i + 1] === "$" && text[i + 2] === "{") {
      let braces = 1
      let j = i + 3
      while (j < text.length && braces > 0) braces += text[j] === "{" ? 1 : text[j] === "}" ? -1 : 0, j++
      out += `\${${text.slice(i + 3, j)}`
      i = j - 1
    } else if (text[i] === "$" && text[i + 1] === "{") {
      let braces = 1
      let j = i + 2
      let token = ""
      for (; j < text.length; j++) {
        if (text[j] === "{") braces++
        else if (text[j] === "}" && --braces === 0) break
        token += text[j]
      }
      i = j
      if (!token) continue
      if (token.includes("${") && depth < 10) token = expandTextVars(token, resolve, depth + 1)
      const value = resolve(token)
      out += value === null ? `\${${token}}` : value
    } else out += text[i]
  }
  return out
}

/** The layer a part's text is on in the board (its land layer, the other side on the bottom). */
const partLayer = (c: ComponentInstance, layer: string | undefined, count: number) => (layer === undefined ? undefined : c.pcb.side === "bottom" ? flipShapeLayer(layer, count) : layer)

/** The text a part's reference text shows. */
export function referenceShown(project: Project, c: ComponentInstance, depth = 0): string {
  const t = c.texts?.find((x) => x.kind === "reference")
  return t?.text !== undefined ? textShown(project, c, t.text, depth + 1, undefined, partLayer(c, t.layer, copperCount(project.board))) : c.ref
}

/** The text a part's value text shows. */
export function valueShown(project: Project, c: ComponentInstance, depth = 0): string {
  const t = c.texts?.find((x) => x.kind === "value")
  return t?.text !== undefined ? textShown(project, c, t.text, depth + 1, undefined, partLayer(c, t.layer, copperCount(project.board))) : valueText(c)
}

/** The part's footprint name and library as KiCad's `m_fpid` has them: `Library:Name` (the first colon splits them); a part drawn here has no library and its footprint is its name. */
export function footprintId(c: ComponentInstance): { library: string; name: string } {
  const id = c.fpid ?? c.footprint
  const colon = c.fpid === undefined ? -1 : id.indexOf(":")
  return colon < 0 ? { library: "", name: id } : { library: id.slice(0, colon), name: id.slice(colon + 1) }
}

/** `FOOTPRINT::ResolveTextVar` (footprint.cpp, 10.0.0 lines 1170-1200): the variables a part answers whichever text asks. `LAYER` is the footprint's own layer here (a text of its own asks for its own layer first). */
function footprintVariable(project: Project, c: ComponentInstance, token: string, depth: number): string | null {
  if (token === "REFERENCE") return referenceShown(project, c, depth)
  if (token === "VALUE") return valueShown(project, c, depth)
  if (token === "LAYER") return c.pcb.side === "bottom" ? "B.Cu" : "F.Cu"
  if (token === "FOOTPRINT_LIBRARY") return footprintId(c).library
  if (token === "FOOTPRINT_NAME") return footprintId(c).name
  return null
}

/**
 * What a text's content shows: its variables resolved against the part it is on and the board. `layer` is the layer of the text
 * (`${LAYER}` of a text object is its own layer's name: pcb_text.cpp and pcb_field.cpp resolve it before asking the footprint).
 */
export function textShown(project: Project, owner: ComponentInstance | null, content: string, depth = 0, unresolved?: string[], layer?: string): string {
  if (depth > 10 || !content.includes("${")) return content.replace(/\\\$\{/g, "${")
  const prop = (key: string) => project.properties?.find((p) => p.key === key)?.value
  return expandTextVars(content, (token) => {
    if (token === "LAYER" && layer !== undefined) return layer
    if (owner) {
      const own = footprintVariable(project, owner, token, depth)
      if (own !== null) return own
    }
    // the board's own file name, as KiCad's `${FILENAME}` shows it (board.cpp ResolveTextVar): the project is named after it when a board is imported
    if (token === "FILENAME") return `${project.name}.kicad_pcb`
    // ${REF:NAME}: a variable of another part, found by its reference designator
    const colon = token.indexOf(":")
    if (colon > 0) {
      const other = project.components.find((c) => c.ref.toLowerCase() === token.slice(0, colon).toLowerCase())
      const rest = token.slice(colon + 1)
      if (other) {
        const found = footprintVariable(project, other, rest, depth)
        if (found !== null) return found
      }
      return `<Unresolved: ${other?.ref ?? token.slice(0, colon)}:${rest}>`
    }
    const block = TITLE_BLOCK[token]
    let found: string | null
    if (block) found = prop(block) ?? (token === "TITLE" ? project.name : null)
    else {
      const comment = /^COMMENT([1-9])$/.exec(token)
      found = comment ? (prop(`Comment ${comment[1]}`) ?? null) : (prop(token) ?? null)
    }
    if (found === null) unresolved?.push(token)
    return found
  })
}

// ---------- a text on the board ----------

/** A text with everything resolved to where and how it is on the board. */
export interface WorldText {
  /** The id the editor selects it by: `x:<id>` for board text, `p:<component id>:<index>` for a part's. */
  id: string
  /** `#board`, or the component's id. */
  owner: string
  /** Index in `Project.texts` or in the component's `texts`. */
  index: number
  kind: "board" | "reference" | "value" | "user"
  /** False for a part not placed on the PCB yet: its text is left out of every output, as its pads are of the checks. */
  placed: boolean
  hidden: boolean
  locked: boolean
  /** The layer it is on, in the board. */
  layer: string
  /** Its anchor, in the board's frame (mm, y up). */
  x: number
  y: number
  /** Its angle as stored (degrees counter-clockwise), and the angle it is drawn at once keep upright has been applied. */
  rot: number
  drawRot: number
  mirror: boolean
  size: number
  w: number
  thickness: number
  bold: boolean
  italic: boolean
  knockout: boolean
  hj: -1 | 0 | 1
  vj: -1 | 0 | 1
  spacing: number
  /** A text that belongs to a part and keeps upright. */
  upright: boolean
  /** The content, as stored. */
  content: string
  /** Where to find the text's own record. */
  source: BoardText | PartText
  box?: NonNullable<TextAttrs["box"]>
  component?: ComponentInstance
  /** X19: the TrueType font the text names, and the outlines KiCad drew it with (see `textOutline`). */
  face?: string
  outline?: TextOutline
}

export const boardTextId = (id: string) => `x:${id}`
export const partTextId = (componentId: string, index: number) => `p:${componentId}:${index}`

/** What a selection id is: a board text or the text of a part. */
export function parseTextId(id: string): { kind: "board"; text: string } | { kind: "part"; component: string; index: number } | null {
  if (id.startsWith("x:")) return { kind: "board", text: id.slice(2) }
  if (id.startsWith("p:")) {
    const at = id.lastIndexOf(":")
    const index = Number(id.slice(at + 1))
    return at > 2 && Number.isInteger(index) ? { kind: "part", component: id.slice(2, at), index } : null
  }
  return null
}

const norm360 = (a: number) => ((a % 360) + 360) % 360

/** `PCB_TEXT::GetDrawRotation` (10.0.0 pcb_text.cpp:184): a part's text that keeps upright is turned by half turns into ]-90, 90]; any other text is in [0, 360). */
export function drawRotation(angle: number, keepUpright: boolean): number {
  let r = norm360(angle)
  if (keepUpright) {
    while (r > 90) r -= 180
    while (r <= -90) r += 180
    return r
  }
  return r
}

const J = { left: -1, right: 1, top: -1, bottom: 1 } as const

function fromAttrs(base: Pick<WorldText, "id" | "owner" | "index" | "kind" | "placed" | "source" | "content" | "component">, t: BoardText | PartText, at: { x: number; y: number; rot: number; mirror: boolean; layer: string }, part: boolean): WorldText {
  const upright = part && t.upright !== false && !t.box
  return {
    ...base,
    hidden: t.hide === true,
    locked: t.locked === true,
    layer: at.layer,
    x: at.x,
    y: at.y,
    rot: at.rot,
    drawRot: drawRotation(at.rot, upright),
    mirror: at.mirror,
    size: t.size,
    w: t.w ?? t.size,
    thickness: t.thickness ?? 0,
    bold: t.bold === true,
    italic: t.italic === true,
    knockout: t.knockout === true,
    hj: t.hj ? J[t.hj] : 0,
    vj: t.vj ? J[t.vj] : 0,
    spacing: t.spacing ?? 1,
    upright,
    ...(t.box ? { box: t.box } : {}),
    ...(t.face !== undefined ? { face: t.face } : {}),
    ...(t.outline ? { outline: t.outline } : {}),
  }
}

/** A board text as a world text (the editor's own silkscreen text is not one). */
export const boardTextWorld = (t: BoardText & { layer: string }, index = 0): WorldText =>
  fromAttrs({ id: boardTextId(t.id), owner: "#board", index, kind: "board", placed: true, source: t, content: t.text }, t, { x: t.x, y: t.y, rot: t.rot, mirror: t.mirror === true, layer: t.layer }, false)

/** A text's pose: where it is, the angle it is drawn at and whether it is mirrored; what a cached outline is mapped by. */
export const textPose = (wt: WorldText): Pose => ({ x: wt.x, y: wt.y, rot: wt.drawRot, mirror: wt.mirror })

/** What a text's cached outlines are drawn for as it is now (`TextOutline.sig`). */
export const outlineSignatureOf = (wt: WorldText): string => textOutlineSignature(outlineLook(wt))

/** A part's text where the part has put it. */
export function partTextWorld(c: ComponentInstance, t: PartText, index: number, copperCount: number): WorldText {
  const bottom = c.pcb.side === "bottom"
  const p = transformPoint(t, c.pcb, c.pcb.rot, bottom)
  return fromAttrs(
    { id: partTextId(c.id, index), owner: c.id, index, kind: t.kind, placed: c.pcb.placed, source: t, content: t.text ?? "", component: c },
    t,
    { x: p.x, y: p.y, rot: norm360(bottom ? c.pcb.rot - t.rot : c.pcb.rot + t.rot), mirror: bottom ? !t.mirror : t.mirror === true, layer: bottom ? flipShapeLayer(t.layer, copperCount) : t.layer },
    true,
  )
}

const cache = new WeakMap<ComponentInstance, { count: number; value: WorldText[] }>()

/** The world texts of one part; cached per component object (a component is replaced, never edited): treat the result as read-only. */
export function componentTexts(c: ComponentInstance, copperCount: number): WorldText[] {
  if (!c.texts?.length) return []
  let hit = cache.get(c)
  if (!hit || hit.count !== copperCount) {
    hit = { count: copperCount, value: c.texts.map((t, i) => partTextWorld(c, t, i, copperCount)) }
    cache.set(c, hit)
  }
  return hit.value
}

/** The text of a dimension as a world text (X11): what KiCad shows for it, anchored where KiCad puts it, on the dimension's layer. Selecting it selects the dimension (`m:<id>`). */
export function dimensionWorldText(d: BoardDimension, keepEmpty = false): WorldText | null {
  const t = dimensionDrawing(d).text
  if (!t || (t.content === "" && !keepEmpty)) return null
  const hj = d.hj === "left" ? -1 : d.hj === "right" ? 1 : 0
  const vj = d.vj === "top" ? -1 : d.vj === "bottom" ? 1 : 0
  const source: BoardText = { id: `m:${d.id}`, layer: d.layer, text: t.content, x: t.x, y: t.y, size: d.size, rot: t.rot, side: d.layer.startsWith("B.") ? "bottom" : "top" }
  return {
    id: `m:${d.id}`,
    owner: DIMENSION_TEXT_OWNER,
    index: 0,
    kind: "board",
    placed: true,
    hidden: false,
    locked: d.locked === true,
    layer: d.layer,
    x: t.x,
    y: t.y,
    rot: t.rot,
    drawRot: t.rot,
    mirror: d.mirror === true,
    size: d.size,
    w: d.w ?? d.size,
    thickness: d.tw ?? 0,
    bold: d.bold === true,
    italic: d.italic === true,
    knockout: false,
    hj,
    vj,
    spacing: d.spacing ?? 1,
    upright: false,
    content: t.content,
    source,
  }
}

/** The owner of a dimension's text among the world texts. */
export const DIMENSION_TEXT_OWNER = "#dim"

/** Whether a world text is a dimension's: the texts the project holds as texts are not (the KiCad export writes a dimension with its text, not a text). */
export const isDimensionText = (t: WorldText) => t.owner === DIMENSION_TEXT_OWNER

/**
 * The texts of the last two boards asked for: the board on screen, and the copper of only what an edit moved (`followEdit`), which would otherwise
 * drop it and have every text of the board made again on the next frame.
 */
let all: { board: Project["board"]; components: Project["components"]; texts: Project["texts"]; dimensions: Project["dimensions"]; value: WorldText[] }[] = []

/** Every KiCad text of the board and of its parts, board text first. Reused while the parts and the board's text are unchanged. */
export function worldTexts(project: Project): WorldText[] {
  const hit = all.find((a) => a.board === project.board && a.components === project.components && a.texts === project.texts && a.dimensions === project.dimensions)
  if (hit) return hit.value
  const out: WorldText[] = []
  project.texts?.forEach((t, index) => {
    if (!isKicadText(t)) return
    out.push(fromAttrs({ id: boardTextId(t.id), owner: "#board", index, kind: "board", placed: true, source: t, content: t.text }, t, { x: t.x, y: t.y, rot: t.rot, mirror: t.mirror === true, layer: t.layer }, false))
  })
  for (const d of project.dimensions ?? []) {
    const wt = dimensionWorldText(d)
    if (wt) out.push(wt)
  }
  for (const c of project.components) {
    if (!isPhysical(findPart(c.partId))) continue
    out.push(...componentTexts(c, copperCount(project.board)))
  }
  all = [{ board: project.board, components: project.components, texts: project.texts, dimensions: project.dimensions, value: out }, ...all.slice(0, 1)]
  return out
}

// ---------- ink ----------

/** The text of a world text as shown. */
export function shownOf(project: Project, wt: WorldText): string {
  const raw = wt.source as { text?: string }
  const content = wt.kind === "reference" && raw.text === undefined ? (wt.component?.ref ?? "") : wt.kind === "value" && raw.text === undefined ? (wt.component ? valueText(wt.component) : "") : wt.content
  return textShown(project, wt.component ?? null, content, 0, undefined, wt.layer)
}

const toIuAttrs = (wt: WorldText): TextAttrsIu => ({
  w: mmToIu(wt.w),
  h: mmToIu(wt.size),
  thickness: mmToIu(wt.thickness),
  bold: wt.bold,
  italic: wt.italic,
  mirror: wt.mirror,
  hAlign: wt.hj,
  vAlign: wt.vj,
  lineSpacing: wt.spacing,
})

export interface TextInk {
  /** The strokes in the board's frame (mm, y up), and the pen they are drawn with (mm). */
  strokes: Vec2[][]
  pen: number
  /** A text drawn from KiCad's cached outlines of a TrueType font (X19): its letters as polygons, each its outer ring then its holes. It has no strokes. */
  outlines?: Vec2[][][]
  /** A knockout text's box, which is filled round the strokes: its corners (counter-clockwise), and the box of a text box's border. */
  hull?: Vec2[]
  /** A text box's border as a closed outline, and the width it is stroked with. */
  border?: { points: Vec2[]; width: number }
  /** The ink's box, the pen included (the knockout's margin and a text box's rectangle not included). */
  box: { minX: number; minY: number; maxX: number; maxY: number } | null
}

const toBoard = (pt: { x: number; y: number }): Vec2 => ({ x: iuToMm(pt.x), y: -iuToMm(pt.y) })

/** The corners of a text box in KiCad's frame, turned about its centre (`PCB_TEXTBOX::GetCornersInSequence`): top left, top right, bottom right, bottom left. */
function boxCorners(wt: WorldText, angle: number): { x: number; y: number }[] {
  const b = wt.box!
  const cx = mmToIu(wt.x)
  const cy = -mmToIu(wt.y)
  const hw = Math.round(mmToIu(b.w) / 2)
  const hh = Math.round(mmToIu(b.h) / 2)
  const pts = [
    { x: cx - hw, y: cy - hh },
    { x: cx + hw, y: cy - hh },
    { x: cx + hw, y: cy + hh },
    { x: cx - hw, y: cy + hh },
  ]
  const a = norm360(angle)
  if (a === 0) return pts
  const s = Math.sin((a * Math.PI) / 180)
  const co = Math.cos((a * Math.PI) / 180)
  return pts.map((p) => {
    const ox = p.x - cx
    const oy = p.y - cy
    if (a === 90) return { x: cx + oy, y: cy - ox }
    if (a === 180) return { x: cx - ox, y: cy - oy }
    if (a === 270) return { x: cx - oy, y: cy + ox }
    return { x: cx + kiRound(oy * s + ox * co), y: cy + kiRound(oy * co - ox * s) }
  })
}

/** A text box's corners as it is drawn: top left, top right, bottom right, bottom left of the text's own frame, in the board's frame (mm, y up). */
export const textBoxCorners = (wt: WorldText): Vec2[] => boxCorners(wt, wt.drawRot).map(toBoard)

/** Where a text box's text starts (`PCB_TEXTBOX::GetDrawPos`, pcb_textbox.cpp:313-405 of 10.0.0): the corner or midpoint its justification names, a margin in. */
function boxAnchor(wt: WorldText): { x: number; y: number } {
  const b = wt.box!
  const c = boxCorners(wt, wt.drawRot)
  const mid = (p: { x: number; y: number }, q: { x: number; y: number }) => ({ x: Math.trunc((p.x + q.x) / 2), y: Math.trunc((p.y + q.y) / 2) })
  const h = wt.mirror ? (wt.hj === -1 ? 1 : wt.hj === 1 ? -1 : 0) : wt.hj
  const v = wt.vj
  const top = mid(c[0], c[1])
  const bottom = mid(c[3], c[2])
  const left = mid(c[0], c[3])
  const right = mid(c[1], c[2])
  const centre = { x: Math.trunc((c[0].x + c[1].x + c[2].x + c[3].x) / 4), y: Math.trunc((c[0].y + c[1].y + c[2].y + c[3].y) / 4) }
  const table: Record<string, { x: number; y: number }> = {
    "-1,-1": c[0],
    "0,-1": top,
    "1,-1": c[1],
    "-1,0": left,
    "0,0": centre,
    "1,0": right,
    "-1,1": c[3],
    "0,1": bottom,
    "1,1": c[2],
  }
  const anchor = table[`${h},${v}`]
  const [ml, mt, mr, mb] = b.margins.map(mmToIu)
  let ox = 0
  let oy = 0
  if (h === -1) ox = ml
  else if (h === 1) ox = -mr
  if (v === -1) oy = mt
  else if (v === 1) oy = -mb
  const a = norm360(wt.drawRot)
  const s = Math.sin((a * Math.PI) / 180)
  const co = Math.cos((a * Math.PI) / 180)
  let rx = ox
  let ry = oy
  if (a === 90) [rx, ry] = [oy, -ox]
  else if (a === 180) [rx, ry] = [-ox, -oy]
  else if (a === 270) [rx, ry] = [-oy, ox]
  else if (a !== 0) [rx, ry] = [kiRound(oy * s + ox * co), kiRound(oy * co - ox * s)]
  return { x: anchor.x + rx, y: anchor.y + ry }
}

const inkCache = new WeakMap<WorldText, { project: Project["properties"]; name: string; components: Project["components"]; font: StrokeFontData; ink: TextInk }>()

/** The ink of a text: its strokes, and for a knockout text the box round them, for a text box its border. Cached per world text. */
export function textInk(project: Project, wt: WorldText): TextInk {
  const hit = inkCache.get(wt)
  const font = strokeFont()
  if (hit && hit.project === project.properties && hit.name === project.name && hit.components === project.components && hit.font === font) return hit.ink
  const ink = computeInk(project, wt)
  inkCache.set(wt, { project: project.properties, name: project.name, components: project.components, font, ink })
  return ink
}

/** What a text's cached outlines were drawn for, which is what they depend on besides the text it shows and its pose. */
const outlineLook = (wt: WorldText) => ({ face: wt.face ?? "", size: wt.size, w: wt.w, bold: wt.bold, italic: wt.italic, hj: wt.hj, vj: wt.vj, spacing: wt.spacing, ...(wt.box ? { box: wt.box } : {}) })

/** A text box wraps its text at the box's width, and KiCad caches the wrapped text: the words are what is compared. */
const words = (s: string) => s.replace(/\s+/g, " ").trim()

/**
 * The outlines KiCad drew a text with, when they still are the text's shape: the text still shows what they were drawn for and its size, width, weight, slant,
 * justification, line spacing and face are as they were. KiCad's own cache is thrown away on these edits (and compared with the shown text on every draw); the
 * editor has no TrueType rasteriser, so a text that has lost them is drawn in the stroke font and says so (`textFontState`).
 */
export function currentOutline(project: Project, wt: WorldText): TextOutline | null {
  const o = wt.outline
  if (!o || wt.face === undefined || o.sig !== textOutlineSignature(outlineLook(wt))) return null
  const shown = shownOf(project, wt)
  return (wt.box ? words(o.text) === words(shown) : o.text === shown) ? o : null
}

/**
 * How a text is drawn with respect to its font (X19): `null` for a text in KiCad's own stroke font, `outline` when it is KiCad's cached outlines of the font, `edited`
 * when it had outlines and an edit took them away, `uncached` when the board names a font and has no outlines for it. The last two are drawn in the stroke font.
 */
export function textFontState(project: Project, wt: WorldText): "outline" | "edited" | "uncached" | null {
  if (wt.face === undefined) return null
  if (currentOutline(project, wt)) return "outline"
  return wt.outline ? "edited" : "uncached"
}

/** The ink of a text drawn from its cached outlines (X19): the letters as polygons in place, and for a knockout the box round them, for a text box its border. */
function outlineInk(wt: WorldText, o: TextOutline, a: TextAttrsIu): TextInk {
  const rings = outlineRings(o, { x: wt.x, y: wt.y, rot: wt.drawRot, mirror: wt.mirror }).flat()
  const outlines = ringsToPolygons(rings)
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const r of rings) {
    for (let i = 0; i < r.length; i += 2) {
      minX = Math.min(minX, r[i])
      maxX = Math.max(maxX, r[i])
      minY = Math.min(minY, r[i + 1])
      maxY = Math.max(maxY, r[i + 1])
    }
  }
  const ink: TextInk = { strokes: [], pen: 0, outlines, box: Number.isFinite(minX) ? { minX: minX / NM, maxX: maxX / NM, minY: minY / NM, maxY: maxY / NM } : null }
  if (wt.knockout) {
    if (wt.box) ink.hull = boxCorners(wt, wt.drawRot).map(toBoard)
    else if (ink.box) {
      const place = { x: mmToIu(wt.x), y: -mmToIu(wt.y), angle: wt.drawRot }
      const margin = knockoutMargin(a.h, effectivePenWidth(a.thickness, a.bold, a.w, a.h))
      // The outlines' box in the text's own turn, grown by the margin, then turned back, as for strokes (`PCB_TEXT::buildBoundingHull`).
      let x0 = Infinity
      let y0 = Infinity
      let x1 = -Infinity
      let y1 = -Infinity
      for (const r of rings) {
        for (let i = 0; i < r.length; i += 2) {
          const p = turnPoint({ x: r[i], y: -r[i + 1] }, place, -place.angle)
          x0 = Math.min(x0, p.x)
          x1 = Math.max(x1, p.x)
          y0 = Math.min(y0, p.y)
          y1 = Math.max(y1, p.y)
        }
      }
      const corners = [
        { x: x0 - margin, y: y0 - margin },
        { x: x1 + margin, y: y0 - margin },
        { x: x1 + margin, y: y1 + margin },
        { x: x0 - margin, y: y1 + margin },
      ].map((p) => turnPoint(p, place, place.angle))
      ink.hull = corners.map(toBoard)
    }
  }
  if (wt.box?.border !== undefined && wt.box.border > 0) ink.border = { points: boxCorners(wt, wt.drawRot).map(toBoard), width: wt.box.border }
  return ink
}

function computeInk(project: Project, wt: WorldText): TextInk {
  const a = toIuAttrs(wt)
  const outline = currentOutline(project, wt)
  if (outline) return outlineInk(wt, outline, a)
  let shown = shownOf(project, wt)
  let place = { x: mmToIu(wt.x), y: -mmToIu(wt.y), angle: wt.drawRot }
  const multiline = wt.kind === "board" || !!wt.box
  if (wt.box) {
    const b = wt.box
    const [ml, mt, mr, mb] = b.margins.map(mmToIu)
    const horizontal = norm360(wt.rot) % 180 === 0
    const column = mmToIu(b.w) - (horizontal ? ml + mr : mt + mb)
    // `PCB_TEXTBOX::GetShownText` of KiCad 10.0 wraps with `GetTextThickness()`, the stored width (0 for the automatic pen), not the
    // effective pen (pcb_textbox.cpp:439-475 in 10.0.0; master uses the effective one). The stored width of a bold text is the base times 1.6.
    const stored = a.thickness > 0 && a.bold ? kiRound(a.thickness * 1.6) : a.thickness
    shown = linebreakText(shown, column, a, stored)
    const anchor = boxAnchor(wt)
    place = { x: anchor.x, y: anchor.y, angle: wt.drawRot }
  }
  const laid: TextStrokes = layoutText(shown, place, a, multiline)
  const strokes = laid.polylines.map((line) => line.map(toBoard))
  const ink: TextInk = { strokes, pen: iuToMm(laid.pen), box: null }
  const box = inkBox(laid)
  if (box) ink.box = { minX: iuToMm(box.minX), maxX: iuToMm(box.maxX), minY: -iuToMm(box.maxY), maxY: -iuToMm(box.minY) }
  if (wt.knockout) {
    const margin = knockoutMargin(a.h, laid.pen)
    if (wt.box) {
      const corners = boxCorners(wt, wt.drawRot).map(toBoard)
      ink.hull = corners
    } else if (box) {
      // The text's ink box, found in the text's own turn and grown by the margin, then turned back (`PCB_TEXT::buildBoundingHull`).
      const inv = turnBox(laid, place, -place.angle)
      const grown = { minX: inv.minX - margin, minY: inv.minY - margin, maxX: inv.maxX + margin, maxY: inv.maxY + margin }
      const corners = [
        { x: grown.minX, y: grown.minY },
        { x: grown.maxX, y: grown.minY },
        { x: grown.maxX, y: grown.maxY },
        { x: grown.minX, y: grown.maxY },
      ].map((p) => turnPoint(p, place, place.angle))
      ink.hull = corners.map(toBoard)
    }
  }
  if (wt.box?.border !== undefined && wt.box.border > 0) ink.border = { points: boxCorners(wt, wt.drawRot).map(toBoard), width: wt.box.border }
  return ink
}

function turnPoint(p: { x: number; y: number }, c: { x: number; y: number }, deg: number): { x: number; y: number } {
  const a = norm360(deg)
  if (a === 0) return { x: p.x, y: p.y }
  const ox = p.x - c.x
  const oy = p.y - c.y
  const s = Math.sin((a * Math.PI) / 180)
  const co = Math.cos((a * Math.PI) / 180)
  return { x: c.x + oy * s + ox * co, y: c.y + oy * co - ox * s }
}

/** The box of a text's ink with the text turned back by `deg` about its anchor, the pen included. */
function turnBox(laid: TextStrokes, c: { x: number; y: number }, deg: number): IuBox {
  const turned: TextStrokes = { pen: laid.pen, polylines: laid.polylines.map((l) => l.map((p) => turnPoint(p, c, deg))) }
  return inkBox(turned) ?? { minX: c.x, minY: c.y, maxX: c.x, maxY: c.y }
}

// ---------- knockout ----------

/** Clipper's unit for text: a nanometre, KiCad's own. */
const NM = 1e6

const p64 = (p: Vec2) => ({ x: Math.round(p.x * NM), y: Math.round(p.y * NM) })
const back = (p: { x: number; y: number }): Vec2 => ({ x: p.x / NM, y: p.y / NM })

/** The ink of a text as polygons (each stroke grown by half the pen, round ends): what KiCad's `TransformTextToPolySet` makes of it. A text drawn from outlines is its outlines. */
export function inkPaths(ink: TextInk, grow = 0): Paths64 {
  const half = (ink.pen / 2 + grow) * NM
  const out: Paths64 = []
  if (ink.outlines) for (const polygon of ink.outlines) for (const ring of polygon) out.push(ring.map(p64))
  for (const line of ink.strokes) {
    if (line.length < 1) continue
    const path: Path64 = line.length === 1 ? [p64(line[0]), p64({ x: line[0].x + 1e-6, y: line[0].y })] : line.map(p64)
    out.push(...Clipper.inflatePaths([path], half, JoinType.Round, EndType.Round, 2, 0.005 * NM))
  }
  return out.length ? Clipper.union(out, [], FillRule.NonZero) : []
}

/** A knockout text's filled shape: its box (grown by the margin) with the strokes taken out. Each polygon is its outer ring and then its holes. */
export function knockoutPolygons(ink: TextInk): Vec2[][][] {
  if (!ink.hull) return []
  const tree = new PolyTree64()
  const c = new Clipper64()
  c.addSubject([ink.hull.map(p64)])
  c.addClip(inkPaths(ink))
  c.execute(ClipType.Difference, FillRule.NonZero, tree)
  const groups: Path64[][] = []
  collect(tree, groups)
  return groups.map((g) => g.map((ring) => ring.map(back)))
}

// ---------- what each layer draws ----------

/** What a text puts on its layer: strokes to draw with a round pen, the filled shape of a knockout (its box with the strokes taken out), and a text box's border. */
export interface LayerText {
  id: string
  owner: string
  strokes: Vec2[][]
  pen: number
  /** Polygons to fill: each its outer ring then its holes. */
  fills: Vec2[][][]
  border?: { points: Vec2[]; width: number }
  /** The ink's box with the pen (the box of a knockout is its hull). */
  box: { minX: number; minY: number; maxX: number; maxY: number }
}

/** The ink of a text as a layer draws it, or null when there is nothing to draw. */
export function layerText(project: Project, wt: WorldText): LayerText | null {
  const ink = textInk(project, wt)
  const fills = wt.knockout ? knockoutPolygons(ink) : (ink.outlines ?? [])
  if (!ink.strokes.length && !fills.length && !ink.border) return null
  let box = ink.box
  if (ink.hull) {
    const xs = ink.hull.map((p) => p.x)
    const ys = ink.hull.map((p) => p.y)
    const hullBox = { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) }
    box = box ? { minX: Math.min(box.minX, hullBox.minX), maxX: Math.max(box.maxX, hullBox.maxX), minY: Math.min(box.minY, hullBox.minY), maxY: Math.max(box.maxY, hullBox.maxY) } : hullBox
  }
  if (ink.border) for (const p of ink.border.points) box = box ? { minX: Math.min(box.minX, p.x), maxX: Math.max(box.maxX, p.x), minY: Math.min(box.minY, p.y), maxY: Math.max(box.maxY, p.y) } : { minX: p.x, maxX: p.x, minY: p.y, maxY: p.y }
  if (!box) return null
  return { id: wt.id, owner: wt.owner, strokes: wt.knockout ? [] : ink.strokes, pen: ink.pen, fills, ...(ink.border ? { border: ink.border } : {}), box }
}

/** Every text that is plotted on a layer: placed, not hidden, and with something to draw. */
export function textsOnLayer(project: Project, layer: string): LayerText[] {
  const out: LayerText[] = []
  for (const wt of worldTexts(project)) {
    if (!wt.placed || wt.hidden || wt.layer !== layer) continue
    const t = layerText(project, wt)
    if (t) out.push(t)
  }
  return out
}
