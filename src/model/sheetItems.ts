import type { Box } from "../lib/geometry"
import { pointSegmentDistance, round } from "../lib/geometry"
import { textBox, textSizeOf, textWidth } from "./labelShapes"
import { textOnSheet } from "./symbolDrawing"
import { SCH_TEXT } from "./symbols"
import type { DirectiveShape, DrawingDirective, RuleAreaMark, DrawingStyle, DrawingTable, DrawingText, LabelField, NetLabel, Rotation, SchematicDrawing, SheetFill, SheetStroke, TableCell, TextLook, Vec2 } from "./types"

// S4: what a KiCad sheet draws besides parts, wires and labels, held as drawings (`Project.drawings`, with
// the ones the drawing tools make): the geometry of the kinds only KiCad has (arcs, curves, circles, text
// boxes, pictures, tables, dots and flags) and of a text placed KiCad's way, their boxes, their moves, what is
// under a click, and the reading of one from a file that may be damaged.

/** The drawings only a KiCad sheet has: everything but a line, a rectangle and a text. */
export type KicadOnlyDrawing = Exclude<SchematicDrawing, { type: "line" | "rect" | "text" }>

/** Whether a drawing is one only a KiCad sheet has. */
export const isKicadOnly = (d: SchematicDrawing): d is KicadOnlyDrawing => d.type !== "line" && d.type !== "rect" && d.type !== "text"

/**
 * Whether a drawing says something exactly that the drawing tools cannot: a KiCad stroke or fill, or a text placed
 * KiCad's way. The Inspector gives these the exact controls (millimetres, a line style by name, a colour of any value).
 */
export const isExact = (d: SchematicDrawing): boolean => isKicadOnly(d) || !!d.stroke || !!d.paint || (d.type === "text" && d.valign !== undefined)

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v)
const finite = (...v: unknown[]) => v.every((x) => typeof x === "number" && Number.isFinite(x))
const ROTATIONS = [0, 90, 180, 270]
const isPoint = (p: unknown): p is Vec2 => isObject(p) && finite(p.x, p.y)

/** The most points one bus polyline may have: a file with more is not a bus this editor holds. */
export const MAX_BUS_POINTS = 4096

const COLOR = /^(?:#[0-9a-fA-F]{6}|rgba\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*[\d.]+\s*\))$/

/** A text's look as the editor can draw it: what is malformed is dropped. */
export function normalizeLook(raw: unknown): TextLook | undefined {
  if (!isObject(raw)) return undefined
  const out: TextLook = {}
  if (finite(raw.size) && (raw.size as number) > 0) out.size = raw.size as number
  if (finite(raw.thickness) && (raw.thickness as number) > 0) out.thickness = raw.thickness as number
  if (raw.bold === true) out.bold = true
  if (raw.italic === true) out.italic = true
  if (typeof raw.color === "string" && COLOR.test(raw.color)) out.color = raw.color
  if (typeof raw.face === "string" && raw.face) out.face = raw.face
  if (raw.h === "left" || raw.h === "right") out.h = raw.h
  if (raw.v === "top" || raw.v === "bottom") out.v = raw.v
  if (raw.mirror === true) out.mirror = true
  if (typeof raw.href === "string" && raw.href) out.href = raw.href
  if (raw.hidden === true) out.hidden = true
  if (finite(raw.lineSpacing) && (raw.lineSpacing as number) > 0) out.lineSpacing = raw.lineSpacing as number
  return Object.keys(out).length ? out : undefined
}

const DASHES = new Set(["dash", "dot", "dash_dot", "dash_dot_dot"])

export function normalizeStroke(raw: unknown): SheetStroke | undefined {
  if (!isObject(raw)) return undefined
  const out: SheetStroke = {}
  if (finite(raw.width) && (raw.width as number) > 0) out.width = raw.width as number
  if (typeof raw.dash === "string" && DASHES.has(raw.dash)) out.dash = raw.dash as SheetStroke["dash"]
  if (typeof raw.color === "string" && COLOR.test(raw.color)) out.color = raw.color
  return Object.keys(out).length ? out : undefined
}

function normalizeFill(raw: unknown): SheetFill | undefined {
  if (!isObject(raw) || (raw.kind !== "outline" && raw.kind !== "background" && raw.kind !== "color")) return undefined
  return { kind: raw.kind, ...(typeof raw.color === "string" && COLOR.test(raw.color) ? { color: raw.color } : {}) }
}

const margins4 = (raw: unknown): [number, number, number, number] | undefined => (Array.isArray(raw) && raw.length === 4 && raw.every((n) => finite(n)) ? (raw as [number, number, number, number]) : undefined)

/** A label's own fields: those with a name, a value and a place. */
export function normalizeLabelFields(raw: unknown): LabelField[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const out: LabelField[] = []
  for (const f of raw) {
    if (!isObject(f) || typeof f.name !== "string" || typeof f.value !== "string" || !isObject(f.place) || !finite(f.place.x, f.place.y)) continue
    const p = f.place
    out.push({
      name: f.name,
      value: f.value,
      place: {
        x: p.x as number,
        y: p.y as number,
        angle: p.angle === 90 ? 90 : 0,
        ...(finite(p.size) && (p.size as number) > 0 ? { size: p.size as number } : {}),
        ...(p.hidden === true ? { hidden: true as const } : {}),
        ...(p.h === "left" || p.h === "right" ? { h: p.h } : {}),
        ...(p.v === "top" || p.v === "bottom" ? { v: p.v } : {}),
        ...(p.bold === true ? { bold: true as const } : {}),
        ...(p.italic === true ? { italic: true as const } : {}),
        ...(p.showName === true ? { showName: true as const } : {}),
        ...(typeof p.color === "string" && COLOR.test(p.color) ? { color: p.color } : {}),
        ...(finite(p.thickness) && (p.thickness as number) > 0 ? { thickness: p.thickness as number } : {}),
        ...(p.noAutoplace === true ? { noAutoplace: true as const } : {}),
      },
    })
  }
  return out.length ? out : undefined
}

const SHAPES = new Set(["input", "output", "bidirectional", "tri_state", "passive"])

/** A label with its S2 fields as the editor can draw them: what is malformed is dropped, what was there before is kept as it is. */
export function normalizeLabel(raw: unknown): NetLabel | null {
  if (!isObject(raw) || typeof raw.id !== "string" || typeof raw.name !== "string" || !finite(raw.x, raw.y)) return null
  const { kind, shape, look, fields, fieldsAutoplaced, ...rest } = raw
  const out = { ...rest, rot: ROTATIONS.includes(raw.rot as number) ? raw.rot : 0 } as unknown as NetLabel
  if (kind === "local" || kind === "global" || kind === "hierarchical") out.kind = kind
  if (typeof shape === "string" && SHAPES.has(shape) && (out.kind === "global" || out.kind === "hierarchical")) out.shape = shape as NetLabel["shape"]
  const l = normalizeLook(look)
  if (l) out.look = l
  const f = normalizeLabelFields(fields)
  if (f) out.fields = f
  if (fieldsAutoplaced === true) out.fieldsAutoplaced = true
  return out
}

/** A text's look as a drawing says it: its pen and letter colour are the drawing's stroke. */
export function lookOfText(d: DrawingText): TextLook {
  const h = d.align === "center" ? undefined : (d.align ?? "left")
  const v = d.valign === "middle" ? undefined : (d.valign ?? "top")
  return {
    size: d.size,
    ...(d.stroke?.width ? { thickness: d.stroke.width } : {}),
    ...(d.bold ? { bold: true as const } : {}),
    ...(d.italic ? { italic: true as const } : {}),
    ...(d.stroke?.color ? { color: d.stroke.color } : {}),
    ...(d.face ? { face: d.face } : {}),
    ...(h ? { h } : {}),
    ...(v ? { v } : {}),
    ...(d.mirror ? { mirror: true as const } : {}),
    ...(d.href ? { href: d.href } : {}),
    ...(d.hidden ? { hidden: true as const } : {}),
    ...(d.lineSpacing ? { lineSpacing: d.lineSpacing } : {}),
  }
}

/** A text from a KiCad file as a drawing: its look is what the drawing says, and the justification KiCad's default (the middle) is named. */
export function kicadText(id: string, text: string, at: Vec2, rot: Rotation, look: TextLook | undefined, sim?: boolean): DrawingText {
  const stroke: SheetStroke = { ...(look?.thickness ? { width: look.thickness } : {}), ...(look?.color ? { color: look.color } : {}) }
  return {
    id,
    type: "text",
    text,
    x: at.x,
    y: at.y,
    size: look?.size ?? SCH_TEXT,
    align: look?.h ?? "center",
    valign: look?.v ?? "middle",
    ...(rot ? { rot } : {}),
    ...(look?.bold ? { bold: true } : {}),
    ...(look?.italic ? { italic: true } : {}),
    ...(look?.face ? { face: look.face } : {}),
    ...(look?.mirror ? { mirror: true as const } : {}),
    ...(look?.href ? { href: look.href } : {}),
    ...(look?.hidden ? { hidden: true as const } : {}),
    ...(look?.lineSpacing ? { lineSpacing: look.lineSpacing } : {}),
    ...(Object.keys(stroke).length ? { stroke } : {}),
    ...(sim ? { excludeFromSim: true as const } : {}),
  }
}

/** The exact stroke, fill and simulation flag a raw drawing carries, as the editor can draw them; what is malformed is dropped. */
export function normalizeExact(r: Record<string, unknown>): Pick<DrawingStyle, "stroke" | "paint" | "excludeFromSim"> {
  const stroke = normalizeStroke(r.stroke)
  const paint = normalizeFill(r.paint)
  return { ...(stroke ? { stroke } : {}), ...(paint ? { paint } : {}), ...(r.excludeFromSim === true ? { excludeFromSim: true as const } : {}) }
}

/**
 * A drawing of a kind only KiCad has, as the editor can draw it; null when it is malformed (it is dropped, never drawn
 * half) or is not one of those kinds. `r.id` is already known to be a string.
 */
export function normalizeKicadOnly(r: Record<string, unknown> & { id: string }): KicadOnlyDrawing | null {
  const base = { id: r.id, ...normalizeExact(r) }
  const rot = ROTATIONS.includes(r.rot as number) ? (r.rot as Rotation) : 0
  const look = normalizeLook(r.look)
  switch (r.type) {
    case "textbox":
      if (typeof r.text === "string" && finite(r.x, r.y, r.w, r.h)) {
        const m = margins4(r.margins)
        return { ...base, type: "textbox", text: r.text, x: r.x as number, y: r.y as number, w: r.w as number, h: r.h as number, rot, ...(m ? { margins: m } : {}), ...(look ? { look } : {}) }
      }
      return null
    case "circle":
      return finite(r.x, r.y, r.radius) && (r.radius as number) >= 0 ? { ...base, type: "circle", x: r.x as number, y: r.y as number, radius: r.radius as number } : null
    case "arc":
      return isPoint(r.start) && isPoint(r.mid) && isPoint(r.end) ? { ...base, type: "arc", start: { x: r.start.x, y: r.start.y }, mid: { x: r.mid.x, y: r.mid.y }, end: { x: r.end.x, y: r.end.y } } : null
    case "bezier": {
      if (!Array.isArray(r.points) || r.points.length !== 4 || !r.points.every(isPoint)) return null
      const p = r.points as Vec2[]
      return { ...base, type: "bezier", points: [p[0], p[1], p[2], p[3]].map((q) => ({ x: q.x, y: q.y })) as [Vec2, Vec2, Vec2, Vec2] }
    }
    case "image":
      return typeof r.data === "string" && r.data && finite(r.x, r.y, r.scale) && (r.scale as number) > 0 ? { ...base, type: "image", x: r.x as number, y: r.y as number, scale: r.scale as number, data: r.data } : null
    case "junction":
      return finite(r.x, r.y)
        ? { ...base, type: "junction", x: r.x as number, y: r.y as number, ...(finite(r.diameter) && (r.diameter as number) > 0 ? { diameter: r.diameter as number } : {}), ...(typeof r.dotColor === "string" && COLOR.test(r.dotColor) ? { dotColor: r.dotColor } : {}) }
        : null
    case "noconnect":
      return finite(r.x, r.y) ? { ...base, type: "noconnect", x: r.x as number, y: r.y as number } : null
    case "bus":
      return Array.isArray(r.points) && r.points.length >= 2 && r.points.length <= MAX_BUS_POINTS && r.points.every(isPoint) ? { ...base, type: "bus", points: (r.points as Vec2[]).map((q) => ({ x: q.x, y: q.y })) } : null
    case "busentry":
      return finite(r.x, r.y, r.dx, r.dy) && (r.dx !== 0 || r.dy !== 0) ? { ...base, type: "busentry", x: r.x as number, y: r.y as number, dx: r.dx as number, dy: r.dy as number, ...(r.toBus === true ? { toBus: true as const } : {}) } : null
    case "table":
      return normalizeTable(r, base)
    case "directive": {
      if (!finite(r.x, r.y) || !DIRECTIVE_SHAPES.has(r.shape as string) || !finite(r.length) || (r.length as number) < 0) return null
      const fields = normalizeLabelFields(r.fields)
      return {
        ...base,
        type: "directive",
        text: typeof r.text === "string" ? r.text : "",
        x: r.x as number,
        y: r.y as number,
        rot,
        shape: r.shape as DirectiveShape,
        length: r.length as number,
        ...(look ? { look } : {}),
        fields: fields ?? [],
        ...(r.fieldsAutoplaced === true ? { fieldsAutoplaced: true as const } : {}),
      }
    }
  }
  return null
}

const DIRECTIVE_SHAPES = new Set(["dot", "round", "diamond", "rectangle"])

/** A rule area's marks from a stored line: only the flags that are set (a `uuid` a file saved earlier has is read past: the export makes one). */
export function normalizeRuleArea(raw: unknown): RuleAreaMark | undefined {
  if (!isObject(raw)) return undefined
  const out: RuleAreaMark = {}
  if (raw.dnp === true) out.dnp = true
  if (raw.excludeFromBom === true) out.excludeFromBom = true
  if (raw.notOnBoard === true) out.notOnBoard = true
  if (raw.excludeFromSim === true) out.excludeFromSim = true
  return out
}

function normalizeTable(r: Record<string, unknown>, base: { id: string } & Pick<DrawingStyle, "stroke" | "paint" | "excludeFromSim">): DrawingTable | null {
  if (!Array.isArray(r.cells) || !Array.isArray(r.columnWidths) || !Array.isArray(r.rowHeights)) return null
  if (!r.columnWidths.every((n) => finite(n)) || !r.rowHeights.every((n) => finite(n))) return null
  const cells: TableCell[] = []
  for (const c of r.cells) {
    if (!isObject(c) || typeof c.text !== "string" || !finite(c.x, c.y, c.w, c.h, c.colSpan, c.rowSpan)) return null
    const look = normalizeLook(c.look)
    const fill = normalizeFill(c.fill)
    const m = margins4(c.margins)
    cells.push({ text: c.text, x: c.x as number, y: c.y as number, w: c.w as number, h: c.h as number, rot: ROTATIONS.includes(c.rot as number) ? (c.rot as Rotation) : 0, colSpan: Math.max(1, c.colSpan as number), rowSpan: Math.max(1, c.rowSpan as number), ...(m ? { margins: m } : {}), ...(look ? { look } : {}), ...(fill ? { fill } : {}), ...(c.excludeFromSim === true ? { excludeFromSim: true as const } : {}) })
  }
  const border = isObject(r.border) ? r.border : {}
  const sep = isObject(r.separators) ? r.separators : {}
  const bs = normalizeStroke(border.stroke)
  const ss = normalizeStroke(sep.stroke)
  return {
    ...base,
    type: "table",
    columns: finite(r.columns) ? (r.columns as number) : (r.columnWidths as number[]).length,
    columnWidths: r.columnWidths as number[],
    rowHeights: r.rowHeights as number[],
    cells,
    border: { external: border.external === true, header: border.header === true, ...(bs ? { stroke: bs } : {}) },
    separators: { rows: sep.rows === true, cols: sep.cols === true, ...(ss ? { stroke: ss } : {}) },
  }
}

// ---------- geometry ----------

/** A bus is drawn twice as wide as a wire (KiCad's default bus is 12 mil, its wire 6), in schematic units. */
export const BUS_WIDTH = 0.045

const turn = (p: Vec2, rot: Rotation): Vec2 => (rot === 0 ? p : rot === 90 ? { x: -p.y, y: p.x } : rot === 180 ? { x: -p.x, y: -p.y } : { x: p.y, y: -p.x })

/**
 * The corners of a text box or table cell: always the axis-aligned rectangle from `at` to `at + size`, in order.
 * KiCad's angle on a box turns only its text (`SCH_TEXTBOX::Rotate90` toggles the text angle), never the box,
 * so the turn is accepted for the callers' sake and ignored.
 */
export function boxCorners(at: Vec2, w: number, h: number, _rot?: Rotation): Vec2[] {
  return [
    { x: 0, y: 0 },
    { x: w, y: 0 },
    { x: w, y: -h },
    { x: 0, y: -h },
  ].map((p) => ({ x: at.x + p.x, y: at.y + p.y }))
}

/** The text of a text or a cell: the size it is set in, and where it is anchored and how it extends from there. */
export function textPlacement(at: Vec2, rot: Rotation, look: TextLook | undefined, lines: number, longest: number) {
  const size = textSizeOf(look)
  const angle = rot === 90 || rot === 270 ? 90 : 0
  const { extent, vertical } = textOnSheet(angle, look?.h, look?.v, { rot: 0 })
  const height = size * (1 + (lines - 1) * (look?.lineSpacing ?? 1) * 1.5)
  return { size, extent, vertical, box: textBox(at, extent, vertical, textWidth("x".repeat(longest), size), height) }
}

export const textLines = (text: string) => text.split(/\r?\n/)

/** The size a picture is drawn at, in schematic units: its pixels at the resolution it names (300 per inch when it names none), times its scale. */
export function imageSize(item: Pick<Extract<SchematicDrawing, { type: "image" }>, "data" | "scale">): { w: number; h: number } {
  const info = pngInfo(item.data)
  const ppi = info.ppi ?? 300
  const unit = (25.4 / ppi) * item.scale
  return { w: round((info.width * unit) / 12.7, 6), h: round((info.height * unit) / 12.7, 6) }
}

/** A PNG's pixel size and, where it says so, its resolution in pixels per inch, read from the first bytes of its base64. */
export function pngInfo(data: string): { width: number; height: number; ppi: number | null } {
  let bytes: Uint8Array
  try {
    const head = data.slice(0, 4096)
    const text = typeof atob === "function" ? atob(head.slice(0, head.length - (head.length % 4))) : Buffer.from(head, "base64").toString("binary")
    bytes = Uint8Array.from(text, (c) => c.charCodeAt(0))
  } catch {
    return { width: 100, height: 100, ppi: null }
  }
  const isPng = bytes[0] === 0x89 && bytes[1] === 0x50
  if (!isPng || bytes.length < 24) return { width: 100, height: 100, ppi: null }
  const u32 = (i: number) => ((bytes[i] << 24) | (bytes[i + 1] << 16) | (bytes[i + 2] << 8) | bytes[i + 3]) >>> 0
  const out: { width: number; height: number; ppi: number | null } = { width: u32(16), height: u32(20), ppi: null }
  // Chunks follow the header: a `pHYs` one gives pixels per metre.
  let at = 33
  while (at + 12 <= bytes.length) {
    const len = u32(at)
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7])
    if (type === "pHYs" && at + 8 + 9 <= bytes.length) {
      if (bytes[at + 8 + 8] === 1) out.ppi = u32(at + 8) * 0.0254
      break
    }
    if (type === "IDAT" || type === "IEND") break
    at += 12 + len
  }
  return out
}

/** The box a text placed KiCad's way covers (a text with `valign`, a text box's own text goes through `textPlacement` too). */
export function kicadTextBox(d: DrawingText): Box {
  const lines = textLines(d.text)
  return textPlacement(d, d.rot ?? 0, lookOfText(d), lines.length, Math.max(1, ...lines.map((l) => l.length))).box
}

/** The box a drawing of a kind only KiCad has covers. */
export function kicadOnlyBox(item: KicadOnlyDrawing): Box {
  switch (item.type) {
    case "textbox":
      return boxOfPoints(boxCorners(item, item.w, item.h, item.rot))
    case "table": {
      const pts = item.cells.flatMap((c) => boxCorners(c, c.w, c.h, c.rot))
      return boxOfPoints(pts.length ? pts : [{ x: 0, y: 0 }])
    }
    case "image": {
      const s = imageSize(item)
      return { minX: item.x - s.w / 2, minY: item.y - s.h / 2, maxX: item.x + s.w / 2, maxY: item.y + s.h / 2 }
    }
    case "junction": {
      const r = (item.diameter ?? 0.08) / 2
      return { minX: item.x - r, minY: item.y - r, maxX: item.x + r, maxY: item.y + r }
    }
    case "noconnect":
      return { minX: item.x - 0.06, minY: item.y - 0.06, maxX: item.x + 0.06, maxY: item.y + 0.06 }
    case "directive":
      return boxOfPoints(directiveShape(item).bulk)
    case "bus": {
      const w = (item.stroke?.width ?? BUS_WIDTH) / 2
      const b = boxOfPoints(item.points)
      return { minX: b.minX - w, minY: b.minY - w, maxX: b.maxX + w, maxY: b.maxY + w }
    }
    case "busentry": {
      const w = (item.stroke?.width ?? 0.012) / 2
      const b = boxOfPoints([item, { x: item.x + item.dx, y: item.y + item.dy }])
      return { minX: b.minX - w, minY: b.minY - w, maxX: b.maxX + w, maxY: b.maxY + w }
    }
    default: {
      const pts: Vec2[] =
        item.type === "bezier"
          ? item.points
          : item.type === "arc"
            ? [item.start, item.mid, item.end]
            : [
                { x: item.x - item.radius, y: item.y - item.radius },
                { x: item.x + item.radius, y: item.y + item.radius },
              ]
      const w = (item.stroke?.width ?? 0.012) / 2
      const b = boxOfPoints(pts)
      return { minX: b.minX - w, minY: b.minY - w, maxX: b.maxX + w, maxY: b.maxY + w }
    }
  }
}

/** A directive label's symbol is 20 mil (0.508 mm) across, whatever its pin's length (`SCH_DIRECTIVE_LABEL`'s `m_symbolSize`). */
export const DIRECTIVE_SYMBOL_MM = 0.508
/** The pin length KiCad gives a new directive label: 100 mil (2.54 mm). */
export const DIRECTIVE_LENGTH = 0.2

/**
 * What a directive label draws, in the sheet's units with y up, as `SCH_DIRECTIVE_LABEL::CreateGraphicShape` and the painter lay it out
 * (sch_label.cpp, sch_painter.cpp of 9.0 and 10.0): its pin, then a filled or empty circle for a dot and a round flag, or a closed outline for
 * a diamond and a rectangle. `bulk` is the points KiCad boxes it by. The shape is drawn for a pin that runs down the page, and turned by the
 * label's angle: 0 sends the pin up, 90 left, 180 down and 270 right.
 */
export function directiveShape(d: Pick<DrawingDirective, "x" | "y" | "rot" | "shape" | "length">): { pin: [Vec2, Vec2]; circle?: { at: Vec2; r: number; filled: boolean }; outline?: Vec2[]; bulk: Vec2[] } {
  const L = d.length * 12.7
  const S0 = DIRECTIVE_SYMBOL_MM
  // Page frame (mm, y down), the pin along +y, then turned to the label's angle: 180 as it is, 90 by (-y, x), 0 by (-x, -y), 270 by (y, -x).
  const turnTo = (p: Vec2): Vec2 => (d.rot === 180 ? p : d.rot === 90 ? { x: -p.y, y: p.x } : d.rot === 0 ? { x: -p.x, y: -p.y } : { x: p.y, y: -p.x })
  const world = (p: Vec2): Vec2 => {
    const q = turnTo(p)
    return { x: round(d.x + q.x / 12.7, 6), y: round(d.y - q.y / 12.7, 6) }
  }
  const mm = (r: number) => round(r / 12.7, 6)
  const origin = world({ x: 0, y: 0 })
  if (d.shape === "dot" || d.shape === "round") {
    const S = d.shape === "dot" ? S0 * 0.7 : S0
    return {
      pin: [origin, world({ x: 0, y: L - S })],
      circle: { at: world({ x: 0, y: L }), r: mm(S), filled: d.shape === "dot" },
      // The three points KiCad draws from, and the ones it widens the box with (the full symbol size beside the pin's end, and past it).
      bulk: [origin, world({ x: 0, y: L - S }), world({ x: 0, y: L }), world({ x: -S0, y: L }), world({ x: S0, y: L + S })],
    }
  }
  if (d.shape === "diamond") {
    const pts = [{ x: 0, y: 0 }, { x: 0, y: L - S0 }, { x: -2 * S0, y: L }, { x: 0, y: L + S0 }, { x: 2 * S0, y: L }, { x: 0, y: L - S0 }, { x: 0, y: 0 }].map(world)
    return { pin: [pts[0], pts[1]], outline: pts, bulk: pts }
  }
  const S = S0 * 0.8
  const pts = [{ x: 0, y: 0 }, { x: 0, y: L - S }, { x: -2 * S, y: L - S }, { x: -2 * S, y: L + S }, { x: 2 * S, y: L + S }, { x: 2 * S, y: L - S }, { x: 0, y: L - S }, { x: 0, y: 0 }].map(world)
  return { pin: [pts[0], pts[1]], outline: pts, bulk: pts }
}

function boxOfPoints(pts: Vec2[]): Box {
  return { minX: Math.min(...pts.map((p) => p.x)), minY: Math.min(...pts.map((p) => p.y)), maxX: Math.max(...pts.map((p) => p.x)), maxY: Math.max(...pts.map((p) => p.y)) }
}

/** The drawing moved by `d`, to a millionth of a unit (KiCad's own resolution). */
export function moveKicadOnly<T extends KicadOnlyDrawing>(item: T, d: Vec2): T {
  const m = (p: Vec2): Vec2 => ({ x: round(p.x + d.x, 6), y: round(p.y + d.y, 6) })
  const it = item as KicadOnlyDrawing
  switch (it.type) {
    case "bezier":
      return { ...it, points: it.points.map(m) as [Vec2, Vec2, Vec2, Vec2] } as T
    case "arc":
      return { ...it, start: m(it.start), mid: m(it.mid), end: m(it.end) } as T
    case "table":
      return { ...it, cells: it.cells.map((c) => ({ ...c, ...m(c) })) } as T
    case "bus":
      return { ...it, points: it.points.map(m) } as T
    default:
      return { ...it, ...m(it) } as T
  }
}

/** Whether a click at `at` (within `tol`) is on a drawing of a kind only KiCad has: on a stroke, inside a box, a picture, a dot or a flag. */
export function hitKicadOnly(item: KicadOnlyDrawing, at: Vec2, tol: number): boolean {
  const filled = !!item.paint || !!item.fill
  switch (item.type) {
    case "circle": {
      const dist = Math.hypot(at.x - item.x, at.y - item.y)
      return filled ? dist <= item.radius + tol : Math.abs(dist - item.radius) <= tol
    }
    case "arc":
      return pointSegmentDistance(at, item.start, item.mid) <= tol || pointSegmentDistance(at, item.mid, item.end) <= tol
    case "bezier":
      return item.points.some((p, i) => i > 0 && pointSegmentDistance(at, item.points[i - 1], p) <= tol)
    case "bus":
      return item.points.some((p, i) => i > 0 && pointSegmentDistance(at, item.points[i - 1], p) <= tol)
    case "busentry":
      return pointSegmentDistance(at, item, { x: item.x + item.dx, y: item.y + item.dy }) <= tol
    default: {
      const b = kicadOnlyBox(item)
      return at.x >= b.minX - tol * 0.5 && at.x <= b.maxX + tol * 0.5 && at.y >= b.minY - tol * 0.5 && at.y <= b.maxY + tol * 0.5
    }
  }
}

/** Whether `p` is inside the polygon through `pts`. */
export function insidePolygon(pts: Vec2[], p: Vec2): boolean {
  return polygonHas(pts, p)
}

function polygonHas(pts: Vec2[], p: Vec2): boolean {
  let inside = false
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    if (pts[i].y > p.y !== pts[j].y > p.y && p.x < ((pts[j].x - pts[i].x) * (p.y - pts[i].y)) / (pts[j].y - pts[i].y) + pts[i].x) inside = !inside
  }
  return inside
}

// ---------- text placement ----------

const up = (rot: Rotation): Vec2 => turn({ x: 0, y: 1 }, rot)

/** The line pitch of a text of this size and spacing: KiCad sets lines 1.5 text heights apart at the default spacing. */
export const linePitch = (size: number, look?: TextLook) => size * 1.5 * (look?.lineSpacing ?? 1)

/**
 * Where each line of a text is anchored, and how it extends from there. The text's anchor and justification
 * name the box the whole text covers; its lines are set from the top of that box down, so a text anchored at
 * its bottom grows upward.
 */
export function textLines2(at: Vec2, rot: Rotation, look: TextLook | undefined, lines: string[]): { text: string; x: number; y: number; extent: { x: -1 | 0 | 1; y: -1 | 0 | 1 }; vertical: boolean; size: number }[] {
  const size = textSizeOf(look)
  const pitch = linePitch(size, look)
  const height = size + (lines.length - 1) * pitch
  const { extent, vertical } = textOnSheet(rot, look?.h, look?.v, { rot: 0 })
  const u = up(rot)
  // How far above the anchor the first line is anchored, so that the box sits where the justification puts it.
  const top = look?.v === "bottom" ? height - size : look?.v === "top" ? 0 : (height - size) / 2
  return lines.map((text, i) => {
    const k = top - i * pitch
    return { text, x: at.x + u.x * k, y: at.y + u.y * k, extent, vertical, size }
  })
}

/**
 * The anchor of the text inside a box (a text box or a table cell), as `SCH_TEXTBOX::GetDrawPos` has it. The box is
 * never turned, so this is along the sheet's own axes. Text across the box (0 or 180): the horizontal justification
 * sets x (left is the left edge plus the left margin, right the right edge minus the right margin) and the vertical
 * one sets y (top is the top edge plus the top margin, bottom the bottom edge minus the bottom margin). Vertical text
 * (90 or 270) swaps them: the horizontal justification sets y (left is the bottom edge minus the bottom margin, right
 * the top edge plus the top margin, centre the middle) and the vertical one sets x (top is the left edge plus the left
 * margin, bottom the right edge minus the right margin, centre the middle).
 */
export function boxTextAt(box: { x: number; y: number; w: number; h: number; rot: Rotation }, margins: [number, number, number, number] | undefined, look: TextLook | undefined): Vec2 {
  const [ml, mt, mr, mb] = margins ?? [0, 0, 0, 0]
  const h = look?.h
  const v = look?.v
  if (box.rot === 90 || box.rot === 270) {
    const x = v === "top" ? ml : v === "bottom" ? box.w - mr : box.w / 2
    const down = h === "left" ? box.h - mb : h === "right" ? mt : box.h / 2
    return { x: round(box.x + x, 6), y: round(box.y - down, 6) }
  }
  const across = h === "left" ? ml : h === "right" ? box.w - mr : (ml + box.w - mr) / 2
  const down = v === "top" ? mt : v === "bottom" ? box.h - mb : (mt + box.h - mb) / 2
  return { x: round(box.x + across, 6), y: round(box.y - down, 6) }
}
