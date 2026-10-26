import { emptyBox, expandBox, pointInBox, pointSegmentDistance, rotate90, round, snap, snapPoint, type Box } from "../lib/geometry"
import { uid } from "../lib/id"
import { SCH_GRID } from "./symbols"
import type { DrawingBox, DrawingColor, DrawingLine, DrawingStyle, DrawingText, LineDash, LineWeight, Project, SchematicDrawing, Vec2 } from "./types"

// Drawings: lines, rectangles and text on the schematic, for titles, notes, callouts and
// the boxes and arrows that explain a sheet, as Altium's drawing tools make. They are graphics only:
// connectivity, checks and exports never read them. The editor and the copilot both edit them
// through these functions, so the two can draw the same things.

export const DRAWING_COLORS: DrawingColor[] = ["ink", "gray", "red", "orange", "yellow", "green", "blue", "purple"]
export const LINE_WEIGHTS: LineWeight[] = ["thin", "medium", "thick"]
export const LINE_DASHES: LineDash[] = ["solid", "dashed", "dotted"]

/** Stroke width of each weight, in schematic units: a symbol's outline is 0.02. */
export const WEIGHT_WIDTH: Record<LineWeight, number> = { thin: 0.012, medium: 0.022, thick: 0.045 }

/** Text sizes by name, the ones the Inspector and the copilot offer. A designator is 0.1. */
export const TEXT_SIZES = [
  { id: "small", label: "Small", size: 0.1 },
  { id: "normal", label: "Normal", size: 0.14 },
  { id: "large", label: "Large", size: 0.2 },
  { id: "heading", label: "Heading", size: 0.3 },
  { id: "title", label: "Title", size: 0.5 },
] as const
export type TextSizeName = (typeof TEXT_SIZES)[number]["id"]
export const DEFAULT_TEXT_SIZE = 0.14

/** Corner radii of a rectangle by name. */
export const CORNER_RADII = [
  { id: "none", label: "Square", radius: 0 },
  { id: "small", label: "Rounded", radius: 0.06 },
  { id: "large", label: "Round", radius: 0.2 },
] as const
export type CornerName = (typeof CORNER_RADII)[number]["id"]

/** Between the lines of a text, as a share of its size. */
export const LINE_HEIGHT = 1.3
/** Rough advance of a character, as a share of the text size (Geist, and the monospace face). */
const ADVANCE = { sans: 0.58, mono: 0.6, bold: 0.62 }
/** Room between a text and its border or tint, as a share of its size. */
export const TEXT_PAD = 0.45

export const isDrawingColor = (v: unknown): v is DrawingColor => typeof v === "string" && (DRAWING_COLORS as string[]).includes(v)
export const isLineWeight = (v: unknown): v is LineWeight => typeof v === "string" && (LINE_WEIGHTS as string[]).includes(v)
export const isLineDash = (v: unknown): v is LineDash => typeof v === "string" && (LINE_DASHES as string[]).includes(v)

export const strokeWidth = (d: DrawingStyle) => WEIGHT_WIDTH[d.weight ?? "medium"]

/** What a drawing is called in a sentence or a heading. */
export function drawingKind(d: SchematicDrawing): string {
  if (d.type === "line") return d.closed ? "Polygon" : d.arrows ? "Arrow" : "Line"
  return d.type === "rect" ? "Rectangle" : "Text"
}

// ---------- Text ----------

export const textLines = (t: Pick<DrawingText, "text">) => t.text.split("\n")

/** Width and height of a text's lines, unturned. */
export function textSize(t: Pick<DrawingText, "text" | "size" | "bold" | "mono">): { width: number; height: number } {
  const lines = textLines(t)
  const advance = t.mono ? ADVANCE.mono : t.bold ? ADVANCE.bold : ADVANCE.sans
  const longest = Math.max(1, ...lines.map((l) => l.length))
  return { width: longest * t.size * advance, height: (lines.length - 1) * t.size * LINE_HEIGHT + t.size * 1.15 }
}

/** A box in the text's own frame (x along its lines, y up) to the world. */
function textFrameToWorld(t: DrawingText, local: Box): Box {
  if (t.rot !== 90) return { minX: t.x + local.minX, maxX: t.x + local.maxX, minY: t.y + local.minY, maxY: t.y + local.maxY }
  // Turned a quarter anticlockwise: along the lines is world up, and down the lines is world right.
  return { minX: t.x - local.maxY, maxX: t.x - local.minY, minY: t.y + local.minX, maxY: t.y + local.maxX }
}

/** Where a text's lines are drawn, without its border. */
export function textBox(t: DrawingText): Box {
  const { width, height } = textSize(t)
  const x0 = t.align === "center" ? -width / 2 : t.align === "right" ? -width : 0
  return textFrameToWorld(t, { minX: x0, maxX: x0 + width, minY: -height, maxY: 0 })
}

/** A text's box with the room its border or tint takes. */
export function textFrame(t: DrawingText): Box {
  const b = textBox(t)
  if (!t.border && !t.fill) return b
  const pad = t.size * TEXT_PAD
  return { minX: b.minX - pad, minY: b.minY - pad, maxX: b.maxX + pad, maxY: b.maxY + pad }
}

// ---------- Geometry ----------

/**
 * Whether a drawing is inside a frame, to move with it: its middle is, and it is no bigger than the
 * frame, so a note that pokes out of a block goes with it and a box drawn around several doesn't.
 */
export function drawnInside(d: SchematicDrawing, frame: Box): boolean {
  const b = drawingBounds(d)
  const fits = b.maxX - b.minX <= frame.maxX - frame.minX && b.maxY - b.minY <= frame.maxY - frame.minY
  return fits && pointInBox({ x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 }, frame)
}

/** Everything a drawing covers. */
export function drawingBounds(d: SchematicDrawing): Box {
  if (d.type === "text") return textFrame(d)
  if (d.type === "line") {
    const b = emptyBox()
    for (const p of d.points) expandBox(b, p)
    return b
  }
  return { minX: d.x, minY: d.y, maxX: d.x + d.width, maxY: d.y + d.height }
}

/** The segments a line is drawn with, the closing one included for a polygon. */
export function lineSegments(d: DrawingLine): [Vec2, Vec2][] {
  const segs: [Vec2, Vec2][] = []
  for (let i = 0; i < d.points.length - 1; i++) segs.push([d.points[i], d.points[i + 1]])
  if (d.closed && d.points.length > 2) segs.push([d.points[d.points.length - 1], d.points[0]])
  return segs
}

function insidePolygon(p: Vec2, pts: Vec2[]): boolean {
  let inside = false
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i]
    const b = pts[j]
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside
  }
  return inside
}

/**
 * Is `at` on the drawing? Lines and outlines are picked up within `tol` of their stroke, filled
 * shapes and texts anywhere inside: an empty frame is clicked through, as a block's is.
 */
export function hitDrawing(d: SchematicDrawing, at: Vec2, tol: number): boolean {
  if (d.type === "text") return pointInBox(at, textFrame(d), tol * 0.5)
  if (d.type === "line") {
    if (lineSegments(d).some(([a, b]) => pointSegmentDistance(at, a, b) <= tol)) return true
    return !!d.closed && !!d.fill && insidePolygon(at, d.points)
  }
  const b = drawingBounds(d)
  const inside = pointInBox(at, b, tol)
  const inner = pointInBox(at, { minX: b.minX + tol, minY: b.minY + tol, maxX: b.maxX - tol, maxY: b.maxY - tol })
  return inside && (!inner || !!d.fill)
}

const shiftPoint = (p: Vec2, by: Vec2): Vec2 => ({ x: round(p.x + by.x), y: round(p.y + by.y) })

export function moveDrawing(d: SchematicDrawing, by: Vec2): SchematicDrawing {
  if (d.type === "line") return { ...d, points: d.points.map((p) => shiftPoint(p, by)) }
  return { ...d, ...shiftPoint(d, by) }
}

/** A quarter turn anticlockwise about the drawing's own middle, kept on the grid. */
export function rotateDrawing(d: SchematicDrawing): SchematicDrawing {
  if (d.type === "text") return clean({ ...d, rot: d.rot === 90 ? 0 : 90 })
  const b = drawingBounds(d)
  const c = snapPoint({ x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 }, SCH_GRID)
  if (d.type === "line") {
    return { ...d, points: d.points.map((p) => shiftPoint(rotate90({ x: p.x - c.x, y: p.y - c.y }, 90), c)) }
  }
  // The corner on the grid, which puts the middle half a square off when a side is an odd number of squares.
  return { ...d, x: round(snap(c.x - d.height / 2, SCH_GRID)), y: round(snap(c.y - d.width / 2, SCH_GRID)), width: d.height, height: d.width }
}

/**
 * Grab points of a drawing: a box's corners and the middles of its sides, bottom-left first and
 * anticlockwise, or a line's points. A text has none; its size is a property.
 */
export function drawingHandles(d: SchematicDrawing): Vec2[] {
  if (d.type === "text") return []
  if (d.type === "line") return d.points
  const { minX, minY, maxX, maxY } = drawingBounds(d)
  const mx = round((minX + maxX) / 2)
  const my = round((minY + maxY) / 2)
  return [
    { x: minX, y: minY },
    { x: mx, y: minY },
    { x: maxX, y: minY },
    { x: maxX, y: my },
    { x: maxX, y: maxY },
    { x: mx, y: maxY },
    { x: minX, y: maxY },
    { x: minX, y: my },
  ]
}

/** Which way each box handle moves its sides: -1 the low side, 1 the high one, 0 neither. */
export const BOX_HANDLE_SIDES: [number, number][] = [
  [-1, -1],
  [0, -1],
  [1, -1],
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
]

/** The drawing with one handle dragged to `to`. A box can't be dragged thinner than half a grid square. */
export function dragHandle(d: SchematicDrawing, handle: number, to: Vec2): SchematicDrawing {
  if (d.type === "text") return d
  if (d.type === "line") return { ...d, points: d.points.map((p, i) => (i === handle ? { x: round(to.x), y: round(to.y) } : p)) }
  const [sx, sy] = BOX_HANDLE_SIDES[handle] ?? [0, 0]
  const least = SCH_GRID / 2
  let { minX, minY, maxX, maxY } = drawingBounds(d)
  if (sx < 0) minX = Math.min(to.x, maxX - least)
  if (sx > 0) maxX = Math.max(to.x, minX + least)
  if (sy < 0) minY = Math.min(to.y, maxY - least)
  if (sy > 0) maxY = Math.max(to.y, minY + least)
  return { ...d, x: round(minX), y: round(minY), width: round(maxX - minX), height: round(maxY - minY) }
}

/** `to` turned onto the nearest multiple of 45° from `from`, for lines drawn with Shift held. */
export function constrain45(from: Vec2, to: Vec2): Vec2 {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4)
  const diagonal = Math.abs(Math.cos(angle)) > 0.1 && Math.abs(Math.sin(angle)) > 0.1
  // On a diagonal both legs are the same length, the pointer's reach along it, so the end stays on the grid.
  const leg = diagonal ? Math.round((Math.abs(dx) + Math.abs(dy)) / 2 / SCH_GRID + 1e-9) * SCH_GRID : 0
  if (diagonal) return { x: round(from.x + Math.sign(Math.cos(angle)) * leg), y: round(from.y + Math.sign(Math.sin(angle)) * leg) }
  return Math.abs(Math.cos(angle)) > 0.5 ? { x: round(to.x), y: from.y } : { x: from.x, y: round(to.y) }
}

/**
 * The drawing as it is stored: defaults left out, so a file only says what differs from them, and
 * coordinates without floating point noise.
 */
export function clean<T extends SchematicDrawing>(d: T): T {
  const out = { ...d } as T & Record<string, unknown>
  if (!out.color || out.color === "ink") delete out.color
  if (!out.weight || out.weight === "medium") delete out.weight
  if (!out.dash || out.dash === "solid") delete out.dash
  if (!out.fill) delete out.fill
  if (out.type === "text") {
    const t = out as DrawingText & Record<string, unknown>
    if (!t.align || t.align === "left") delete t.align
    if (!t.rot) delete t.rot
    for (const k of ["bold", "italic", "mono", "border"] as const) if (!t[k]) delete t[k]
    t.x = round(t.x)
    t.y = round(t.y)
    t.size = round(t.size)
  } else if (out.type === "line") {
    const l = out as DrawingLine & Record<string, unknown>
    if (!l.closed) delete l.closed
    if (l.closed || !l.arrows) delete l.arrows
    l.points = l.points.map((p) => ({ x: round(p.x), y: round(p.y) }))
  } else {
    const b = out as DrawingBox & Record<string, unknown>
    if (!b.radius) delete b.radius
    b.x = round(b.x)
    b.y = round(b.y)
    b.width = round(b.width)
    b.height = round(b.height)
  }
  return out
}

// ---------- Editing the project ----------

/** A drawing without its id, as one is asked for. */
export type NewDrawing = SchematicDrawing extends infer D ? (D extends SchematicDrawing ? Omit<D, "id"> : never) : never

const touch = (p: Project, drawings: SchematicDrawing[]): Project => ({ ...p, updatedAt: Date.now(), drawings: drawings.length ? drawings : undefined })

/** Add drawings on top of the others. */
export function addDrawings(project: Project, items: NewDrawing[]): { project: Project; added: SchematicDrawing[] } {
  const added = items.map((d) => clean({ ...d, id: uid("d") } as SchematicDrawing))
  return { project: touch(project, [...(project.drawings ?? []), ...added]), added }
}

/** Change drawings in place; one the change returns as it was is left as it was. */
export function updateDrawings(project: Project, ids: Iterable<string>, change: (d: SchematicDrawing) => SchematicDrawing): Project {
  const set = new Set(ids)
  let changed = false
  const drawings = (project.drawings ?? []).map((d) => {
    if (!set.has(d.id)) return d
    const next = change(d)
    if (next === d) return d
    changed = true
    return clean(next)
  })
  return changed ? touch(project, drawings) : project
}

export function removeDrawings(project: Project, ids: Iterable<string>): Project {
  const set = new Set(ids)
  if (!project.drawings?.some((d) => set.has(d.id))) return project
  return touch(project, project.drawings.filter((d) => !set.has(d.id)))
}

/** Bring drawings to the front (drawn last) or send them to the back, keeping their own order. */
export function reorderDrawings(project: Project, ids: Iterable<string>, to: "front" | "back"): Project {
  const set = new Set(ids)
  const all = project.drawings ?? []
  const moving = all.filter((d) => set.has(d.id))
  if (!moving.length) return project
  const rest = all.filter((d) => !set.has(d.id))
  const next = to === "front" ? [...rest, ...moving] : [...moving, ...rest]
  if (next.every((d, i) => d === all[i])) return project
  return touch(project, next)
}

/** Copies of drawings moved by `offset`, with ids of their own. */
export function copyDrawings(drawings: SchematicDrawing[], offset: Vec2): SchematicDrawing[] {
  return drawings.map((d) => ({ ...moveDrawing(d, offset), id: uid("d") }))
}

/** Style fields a drawing of this type uses. */
export function styleOf(d: SchematicDrawing): DrawingStyle {
  return { color: d.color, fill: d.fill, weight: d.weight, dash: d.dash }
}
