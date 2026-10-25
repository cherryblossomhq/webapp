import type { Box } from "../lib/geometry"
import { pointSegmentDistance, round } from "../lib/geometry"
import { textBox, textSizeOf, textWidth } from "./labelShapes"
import { textOnSheet } from "./symbolDrawing"
import type { LabelField, NetLabel, Rotation, SheetFill, SheetItem, SheetStroke, SheetTable, SheetTextBox, TableCell, TextLook, Vec2 } from "./types"

// S4: the items a sheet carries besides parts, wires and labels (`Project.items`): their boxes, their
// moves, what is under a click, and the reading of one from a file that may be damaged.

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v)
const finite = (...v: unknown[]) => v.every((x) => typeof x === "number" && Number.isFinite(x))
const ROTATIONS = [0, 90, 180, 270]
const isPoint = (p: unknown): p is Vec2 => isObject(p) && finite(p.x, p.y)

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
  if (kind === "local" || kind === "global") out.kind = kind
  if (typeof shape === "string" && SHAPES.has(shape) && out.kind === "global") out.shape = shape as NetLabel["shape"]
  const l = normalizeLook(look)
  if (l) out.look = l
  const f = normalizeLabelFields(fields)
  if (f) out.fields = f
  if (fieldsAutoplaced === true) out.fieldsAutoplaced = true
  return out
}

/** The items of a project that the editor can draw; one that is malformed is dropped, never drawn half. */
export function normalizeItems(raw: unknown): SheetItem[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const out: SheetItem[] = []
  const ids = new Set<string>()
  for (const r of raw) {
    if (!isObject(r) || typeof r.id !== "string" || ids.has(r.id) || typeof r.kind !== "string") continue
    const base = { id: r.id, ...(r.excludeFromSim === true ? { excludeFromSim: true as const } : {}) }
    const stroke = normalizeStroke(r.stroke)
    const fill = normalizeFill(r.fill)
    const look = normalizeLook(r.look)
    const rot = ROTATIONS.includes(r.rot as number) ? (r.rot as Rotation) : 0
    let item: SheetItem | null = null
    switch (r.kind) {
      case "text":
        if (typeof r.text === "string" && finite(r.x, r.y)) item = { ...base, kind: "text", text: r.text, x: r.x as number, y: r.y as number, rot, ...(look ? { look } : {}) }
        break
      case "textbox":
        if (typeof r.text === "string" && finite(r.x, r.y, r.w, r.h)) {
          const m = margins4(r.margins)
          item = { ...base, kind: "textbox", text: r.text, x: r.x as number, y: r.y as number, w: r.w as number, h: r.h as number, rot, ...(m ? { margins: m } : {}), ...(look ? { look } : {}), ...(stroke ? { stroke } : {}), ...(fill ? { fill } : {}) }
        }
        break
      case "polyline":
        if (Array.isArray(r.points) && r.points.length >= 2 && r.points.every(isPoint)) item = { ...base, kind: "polyline", points: (r.points as Vec2[]).map((p) => ({ x: p.x, y: p.y })), ...(stroke ? { stroke } : {}), ...(fill ? { fill } : {}) }
        break
      case "rectangle":
        if (isPoint(r.a) && isPoint(r.b)) item = { ...base, kind: "rectangle", a: { x: r.a.x, y: r.a.y }, b: { x: r.b.x, y: r.b.y }, ...(finite(r.radius) && (r.radius as number) > 0 ? { radius: r.radius as number } : {}), ...(stroke ? { stroke } : {}), ...(fill ? { fill } : {}) }
        break
      case "circle":
        if (isPoint(r.c) && finite(r.r) && (r.r as number) >= 0) item = { ...base, kind: "circle", c: { x: r.c.x, y: r.c.y }, r: r.r as number, ...(stroke ? { stroke } : {}), ...(fill ? { fill } : {}) }
        break
      case "arc":
        if (isPoint(r.start) && isPoint(r.mid) && isPoint(r.end)) item = { ...base, kind: "arc", start: { x: r.start.x, y: r.start.y }, mid: { x: r.mid.x, y: r.mid.y }, end: { x: r.end.x, y: r.end.y }, ...(stroke ? { stroke } : {}), ...(fill ? { fill } : {}) }
        break
      case "bezier":
        if (Array.isArray(r.points) && r.points.length === 4 && r.points.every(isPoint)) {
          const p = r.points as Vec2[]
          item = { ...base, kind: "bezier", points: [p[0], p[1], p[2], p[3]].map((q) => ({ x: q.x, y: q.y })) as [Vec2, Vec2, Vec2, Vec2], ...(stroke ? { stroke } : {}), ...(fill ? { fill } : {}) }
        }
        break
      case "image":
        if (typeof r.data === "string" && r.data && finite(r.x, r.y, r.scale) && (r.scale as number) > 0) item = { ...base, kind: "image", x: r.x as number, y: r.y as number, scale: r.scale as number, data: r.data }
        break
      case "junction":
        if (finite(r.x, r.y)) item = { ...base, kind: "junction", x: r.x as number, y: r.y as number, ...(finite(r.diameter) && (r.diameter as number) > 0 ? { diameter: r.diameter as number } : {}), ...(typeof r.color === "string" && COLOR.test(r.color) ? { color: r.color } : {}) }
        break
      case "noconnect":
        if (finite(r.x, r.y)) item = { ...base, kind: "noconnect", x: r.x as number, y: r.y as number }
        break
      case "table":
        item = normalizeTable(r, base)
        break
    }
    if (item) {
      ids.add(r.id)
      out.push(item)
    }
  }
  return out.length ? out : undefined
}

function normalizeTable(r: Record<string, unknown>, base: { id: string; excludeFromSim?: true }): SheetTable | null {
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
    kind: "table",
    columns: finite(r.columns) ? (r.columns as number) : (r.columnWidths as number[]).length,
    columnWidths: r.columnWidths as number[],
    rowHeights: r.rowHeights as number[],
    cells,
    border: { external: border.external === true, header: border.header === true, ...(bs ? { stroke: bs } : {}) },
    separators: { rows: sep.rows === true, cols: sep.cols === true, ...(ss ? { stroke: ss } : {}) },
  }
}

// ---------- geometry ----------

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

/** The points a shape is drawn through, enough to bound it. */
function shapePoints(item: Extract<SheetItem, { kind: "polyline" | "rectangle" | "circle" | "arc" | "bezier" }>): Vec2[] {
  switch (item.kind) {
    case "polyline":
    case "bezier":
      return item.points
    case "rectangle":
      return [item.a, item.b]
    case "circle":
      return [
        { x: item.c.x - item.r, y: item.c.y - item.r },
        { x: item.c.x + item.r, y: item.c.y + item.r },
      ]
    case "arc":
      return [item.start, item.mid, item.end]
  }
}

/** The size a picture is drawn at, in schematic units: its pixels at the resolution it names (300 per inch when it names none), times its scale. */
export function imageSize(item: Extract<SheetItem, { kind: "image" }>): { w: number; h: number } {
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

/** The box an item covers. */
export function itemBox(item: SheetItem): Box {
  switch (item.kind) {
    case "text": {
      const lines = textLines(item.text)
      return textPlacement(item, item.rot, item.look, lines.length, Math.max(1, ...lines.map((l) => l.length))).box
    }
    case "textbox": {
      const c = boxCorners(item, item.w, item.h, item.rot)
      return boxOfPoints(c)
    }
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
    default: {
      const pts = shapePoints(item)
      const w = (item.stroke?.width ?? 0.012) / 2
      const b = boxOfPoints(pts)
      return { minX: b.minX - w, minY: b.minY - w, maxX: b.maxX + w, maxY: b.maxY + w }
    }
  }
}

function boxOfPoints(pts: Vec2[]): Box {
  return { minX: Math.min(...pts.map((p) => p.x)), minY: Math.min(...pts.map((p) => p.y)), maxX: Math.max(...pts.map((p) => p.x)), maxY: Math.max(...pts.map((p) => p.y)) }
}

/** The item moved by `d`. */
export function moveItem<T extends SheetItem>(item: T, d: Vec2): T {
  const m = (p: Vec2): Vec2 => ({ x: round(p.x + d.x, 6), y: round(p.y + d.y, 6) })
  const it = item as SheetItem
  switch (it.kind) {
    case "polyline":
    case "bezier":
      return { ...it, points: it.points.map(m) } as T
    case "rectangle":
      return { ...it, a: m(it.a), b: m(it.b) } as T
    case "circle":
      return { ...it, c: m(it.c) } as T
    case "arc":
      return { ...it, start: m(it.start), mid: m(it.mid), end: m(it.end) } as T
    case "table":
      return { ...it, cells: it.cells.map((c) => ({ ...c, ...m(c) })) } as T
    default:
      return { ...it, ...m(it) } as T
  }
}

/** Whether a click at `at` (within `tol`) is on the item: on a line or a shape's outline, inside a box, a text, a picture, a dot or a flag. */
export function itemHit(item: SheetItem, at: Vec2, tol: number): boolean {
  const near = (box: Box, t = tol) => at.x >= box.minX - t && at.x <= box.maxX + t && at.y >= box.minY - t && at.y <= box.maxY + t
  switch (item.kind) {
    case "polyline": {
      if (item.fill && polygonHas(item.points, at)) return true
      return item.points.some((p, i) => i > 0 && pointSegmentDistance(at, item.points[i - 1], p) <= tol)
    }
    case "rectangle": {
      const b = boxOfPoints([item.a, item.b])
      if (item.fill) return near(b)
      return near(b) && !(at.x > b.minX + tol && at.x < b.maxX - tol && at.y > b.minY + tol && at.y < b.maxY - tol)
    }
    case "circle": {
      const d = Math.hypot(at.x - item.c.x, at.y - item.c.y)
      return item.fill ? d <= item.r + tol : Math.abs(d - item.r) <= tol
    }
    case "arc":
      return pointSegmentDistance(at, item.start, item.mid) <= tol || pointSegmentDistance(at, item.mid, item.end) <= tol
    case "bezier":
      return item.points.some((p, i) => i > 0 && pointSegmentDistance(at, item.points[i - 1], p) <= tol)
    default:
      return near(itemBox(item), item.kind === "text" ? tol * 0.3 : tol * 0.5)
  }
}

function polygonHas(pts: Vec2[], p: Vec2): boolean {
  let inside = false
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    if (pts[i].y > p.y !== pts[j].y > p.y && p.x < ((pts[j].x - pts[i].x) * (p.y - pts[i].y)) / (pts[j].y - pts[i].y) + pts[i].x) inside = !inside
  }
  return inside
}

/** Whether a text box's corner box covers a point, for a text box's own text. */
export const textBoxBox = (item: SheetTextBox): Box => boxOfPoints(boxCorners(item, item.w, item.h, item.rot))

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
