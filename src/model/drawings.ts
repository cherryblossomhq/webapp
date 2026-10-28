import { emptyBox, expandBox, pointInBox, pointSegmentDistance, rotate90, round, snap, snapPoint, type Box } from "../lib/geometry"
import { uid } from "../lib/id"
import { hitKicadOnly, insidePolygon, isExact, isKicadOnly, kicadOnlyBox, kicadTextBox, moveKicadOnly } from "./sheetItems"
import { SCH_GRID } from "./symbols"
import type { DrawingBox, DrawingBus, DrawingBusEntry, DrawingColor, DrawingLine, DrawingStyle, DrawingText, LineDash, LineWeight, Project, SchematicDrawing, SheetFill, SheetStroke, Vec2 } from "./types"

// Drawings: lines, rectangles and text on the schematic, for titles, notes, callouts and
// the boxes and arrows that explain a sheet, as Altium's drawing tools make, and what a KiCad sheet
// draws (arcs, curves, circles, text boxes, pictures, tables, dots and flags: `sheetItems.ts` has the
// geometry of those). They are graphics only: connectivity and checks never read them. The editor
// and the copilot both edit them through these functions, so the two can draw the same things.

export const DRAWING_COLORS: DrawingColor[] = ["ink", "gray", "red", "orange", "yellow", "green", "blue", "purple"]
/** The named colours as the light sheet draws them, which is how a named colour becomes an exact one. */
export const DRAWING_HEX: Record<DrawingColor, string> = {
  ink: "#24211c",
  gray: "#7d7a72",
  red: "#c02a2a",
  orange: "#c8600e",
  yellow: "#b08600",
  green: "#1f7f43",
  blue: "#3a51c2",
  purple: "#7a3fc4",
}
/** Opacity of a drawing's fill on the light sheet. */
export const DRAWING_TINT = 0.13
/** `#rrggbb` as the `rgba(r,g,b,a)` a KiCad file writes for a colour with an alpha. */
export const withAlpha = (hex: string, alpha: number) => `rgba(${parseInt(hex.slice(1, 3), 16)},${parseInt(hex.slice(3, 5), 16)},${parseInt(hex.slice(5, 7), 16)},${alpha})`
/** The shapes only KiCad has that are stroked, and so take a colour, a weight and a dash. */
const STROKED_KICAD_ONLY: ReadonlySet<string> = new Set(["circle", "arc", "bezier", "textbox", "bus", "busentry"])
export const LINE_WEIGHTS: LineWeight[] = ["thin", "medium", "thick"]
export const LINE_DASHES: LineDash[] = ["solid", "dashed", "dotted"]

/** Stroke width of each weight, in schematic units: a symbol's outline is 0.02. */
export const WEIGHT_WIDTH: Record<LineWeight, number> = { thin: 0.012, medium: 0.022, thick: 0.045 }

/** A schematic unit in millimetres: ten of KiCad's 50 mil, so a text's size can be shown and typed in mm or mil. */
export const SCH_UNIT_MM = 12.7
/** The smallest and largest text the Inspector takes, in schematic units (10 mil and 5 inches). */
export const TEXT_SIZE_RANGE = { min: 0.02, max: 10 }

/** Text sizes by name: the copilot's, and the Inspector's presets beside its size field. A designator is 0.1. */
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

/** KiCad's default line width, 6 mil: a line with a KiCad look of its own and no width of its own. */
export const KICAD_LINE = 0.012

/** The width a drawing is stroked with: a KiCad file's own, else KiCad's default for a line of its look, else the weight's. */
export const strokeWidth = (d: DrawingStyle) => d.stroke?.width ?? (d.stroke && !d.weight ? KICAD_LINE : WEIGHT_WIDTH[d.weight ?? "medium"])

/** What a drawing is called in a sentence or a heading. */
export function drawingKind(d: SchematicDrawing): string {
  switch (d.type) {
    case "line":
      return d.ruleArea ? "Rule area" : d.closed ? "Polygon" : d.arrows ? "Arrow" : "Line"
    case "rect":
      return "Rectangle"
    case "text":
      return "Text"
    case "textbox":
      return "Text box"
    case "circle":
      return "Circle"
    case "arc":
      return "Arc"
    case "bezier":
      return "Curve"
    case "image":
      return "Picture"
    case "table":
      return "Table"
    case "junction":
      return "Junction dot"
    case "noconnect":
      return "No-connect flag"
    case "directive":
      return "Directive label"
    case "bus":
      return "Bus"
    case "busentry":
      return d.toBus ? "Bus-to-bus entry" : "Bus entry"
  }
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
  if (isKicadOnly(d)) return kicadOnlyBox(d)
  if (d.type === "text") return d.valign ? kicadTextBox(d) : textFrame(d)
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

/**
 * Is `at` on the drawing? Lines and outlines are picked up within `tol` of their stroke, filled
 * shapes and texts anywhere inside: an empty frame is clicked through, as a block's is.
 */
export function hitDrawing(d: SchematicDrawing, at: Vec2, tol: number): boolean {
  if (isKicadOnly(d)) return hitKicadOnly(d, at, tol)
  if (d.type === "text") return pointInBox(at, d.valign ? kicadTextBox(d) : textFrame(d), tol * 0.5)
  if (d.type === "line") {
    if (lineSegments(d).some(([a, b]) => pointSegmentDistance(at, a, b) <= tol)) return true
    return ((!!d.closed && !!d.fill) || !!d.paint) && insidePolygon(d.points, at)
  }
  const b = drawingBounds(d)
  const inside = pointInBox(at, b, tol)
  const inner = pointInBox(at, { minX: b.minX + tol, minY: b.minY + tol, maxX: b.maxX - tol, maxY: b.maxY - tol })
  return inside && (!inner || !!d.fill || !!d.paint)
}

const shiftPoint = (p: Vec2, by: Vec2, digits = 4): Vec2 => ({ x: round(p.x + by.x, digits), y: round(p.y + by.y, digits) })

/** Moved to four digits, or six (a millionth of a unit, KiCad's own resolution) for a drawing a KiCad file gave, which keeps every digit it came with. */
export function moveDrawing(d: SchematicDrawing, by: Vec2): SchematicDrawing {
  if (isKicadOnly(d)) return moveKicadOnly(d, by)
  const digits = isExact(d) ? 6 : 4
  if (d.type === "line") return { ...d, points: d.points.map((p) => shiftPoint(p, by, digits)) }
  return { ...d, ...shiftPoint(d, by, digits) }
}

/** A quarter turn anticlockwise about the drawing's own middle, kept on the grid. */
export function rotateDrawing(d: SchematicDrawing): SchematicDrawing {
  if (d.type === "text") return clean({ ...d, rot: d.rot === 90 ? 0 : 90 })
  // What KiCad draws turns where it is for the shapes that have points; a text box turns its text, and a picture, a circle, a dot and a table stay.
  if (d.type === "textbox") return { ...d, rot: d.rot === 90 || d.rot === 270 ? 0 : 90 }
  if (d.type === "arc" || d.type === "bezier") {
    const b = drawingBounds(d)
    const c = snapPoint({ x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 }, SCH_GRID)
    const turn = (p: Vec2) => shiftPoint(rotate90({ x: p.x - c.x, y: p.y - c.y }, 90), c, 6)
    return d.type === "arc" ? { ...d, start: turn(d.start), mid: turn(d.mid), end: turn(d.end) } : { ...d, points: d.points.map(turn) as typeof d.points }
  }
  // A directive label turns about its own point, as KiCad turns one: the pin goes up, then left, down and right.
  if (d.type === "directive") return { ...d, rot: ((d.rot + 90) % 360) as typeof d.rot }
  if (d.type === "bus") {
    const b = drawingBounds(d)
    const c = snapPoint({ x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 }, SCH_GRID)
    return { ...d, points: d.points.map((p) => shiftPoint(rotate90({ x: p.x - c.x, y: p.y - c.y }, 90), c, 6)) }
  }
  // An entry turns about its own corner: the quarter turn takes its far end to the next corner of its square.
  if (d.type === "busentry") return { ...d, dx: round(-d.dy, 6), dy: round(d.dx, 6) }
  if (isKicadOnly(d)) return d
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
  if (d.type === "bus") return d.points
  if (d.type === "busentry") return [d, { x: round(d.x + d.dx, 6), y: round(d.y + d.dy, 6) }]
  if (d.type === "text" || isKicadOnly(d)) return []
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
  if (d.type === "bus") return { ...d, points: d.points.map((p, i) => (i === handle ? { x: round(to.x, 6), y: round(to.y, 6) } : p)) }
  if (d.type === "busentry") {
    // Either end moves the entry's own end; the other stays, so the entry may change its slant.
    const far = { x: d.x + d.dx, y: d.y + d.dy }
    const [a, b] = handle === 0 ? [{ x: round(to.x, 6), y: round(to.y, 6) }, far] : [{ x: d.x, y: d.y }, { x: round(to.x, 6), y: round(to.y, 6) }]
    return a.x === b.x && a.y === b.y ? d : { ...d, x: a.x, y: a.y, dx: round(b.x - a.x, 6), dy: round(b.y - a.y, 6) }
  }
  if (d.type === "text" || isKicadOnly(d)) return d
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
  // Four digits for what the drawing tools make, six (KiCad's own resolution) for what a KiCad file said.
  const digits = isExact(d) ? 6 : 4
  if (!out.color || out.color === "ink") delete out.color
  if (!out.weight || out.weight === "medium") delete out.weight
  if (!out.dash || out.dash === "solid") delete out.dash
  if (!out.fill) delete out.fill
  if (!out.paint) delete out.paint
  // A KiCad look with nothing to say is kept when it is a line's or a box's (it says "KiCad's own line"), and dropped from the rest.
  if (!out.stroke || (Object.keys(out.stroke).length === 0 && out.type !== "line" && out.type !== "rect")) delete out.stroke
  if (!out.excludeFromSim) delete out.excludeFromSim
  if (out.type === "text") {
    const t = out as DrawingText & Record<string, unknown>
    // Left is the editor's own alignment; a text KiCad justified says every one, since its own is the middle.
    if (!t.align || (t.align === "left" && t.valign === undefined)) delete t.align
    if (!t.rot) delete t.rot
    for (const k of ["bold", "italic", "mono", "border", "mirror", "hidden"] as const) if (!t[k]) delete t[k]
    for (const k of ["href", "face", "lineSpacing", "valign"] as const) if (!t[k]) delete t[k]
    t.x = round(t.x, digits)
    t.y = round(t.y, digits)
    // Six digits whoever drew it: a size typed in millimetres or mil keeps its value to the micron.
    t.size = round(t.size, 6)
  } else if (out.type === "line") {
    const l = out as DrawingLine & Record<string, unknown>
    if (!l.closed) delete l.closed
    if (!l.ruleArea) delete l.ruleArea
    if (l.closed || !l.arrows) delete l.arrows
    l.points = l.points.map((p) => ({ x: round(p.x, digits), y: round(p.y, digits) }))
  } else if (out.type === "bus") {
    const l = out as DrawingBus & Record<string, unknown>
    l.points = l.points.map((p) => ({ x: round(p.x, digits), y: round(p.y, digits) }))
  } else if (out.type === "busentry") {
    const e = out as DrawingBusEntry & Record<string, unknown>
    if (!e.toBus) delete e.toBus
    e.x = round(e.x, digits)
    e.y = round(e.y, digits)
    e.dx = round(e.dx, digits)
    e.dy = round(e.dy, digits)
  } else if (out.type === "rect") {
    const b = out as DrawingBox & Record<string, unknown>
    if (!b.radius) delete b.radius
    b.x = round(b.x, digits)
    b.y = round(b.y, digits)
    b.width = round(b.width, digits)
    b.height = round(b.height, digits)
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
  return drawings.map((d) => ({ ...moveDrawing(d, offset), id: uid("d") }) as SchematicDrawing)
}

/**
 * A drawing with the editor's style fields set (`undefined` clears one). A drawing the tools made takes them as its
 * named style. A drawing that says its look exactly (a KiCad file's `stroke` and `paint`, and the shapes only KiCad has
 * that have a stroke: circles, arcs, curves and text boxes) changes only the part the patch names, as the exact
 * Inspector does: a colour sets the stroke's colour (the light sheet's value for the name), a weight its width, a dash its
 * dash, a fill its paint (the name's tint); the rest of the stroke stays, so a dashed KiCad line given a colour is still
 * dashed and still an exact drawing that the KiCad export writes as it is. A text's stroke is its letters' pen, so only the colour
 * of a text is set. The shapes with no stroke (junction dots, no-connect flags, pictures, tables) take none.
 */
export function applyStyle<T extends SchematicDrawing>(d: T, patch: DrawingStyle): T {
  if (isKicadOnly(d) && !STROKED_KICAD_ONLY.has(d.type)) return d
  if (!isExact(d)) return { ...d, ...patch } as T
  const out = { ...d } as T & Record<string, unknown>
  const stroke: SheetStroke = { ...(d as { stroke?: SheetStroke }).stroke }
  const text = d.type === "text"
  if ("color" in patch) {
    if (patch.color) stroke.color = DRAWING_HEX[patch.color]
    else delete stroke.color
  }
  if ("weight" in patch && !text) {
    if (patch.weight) stroke.width = WEIGHT_WIDTH[patch.weight]
    else delete stroke.width
  }
  if ("dash" in patch && !text) {
    if (patch.dash === "dashed") stroke.dash = "dash"
    else if (patch.dash === "dotted") stroke.dash = "dot"
    else delete stroke.dash
  }
  if ((d as { stroke?: SheetStroke }).stroke || Object.keys(stroke).length) out.stroke = stroke
  if ("fill" in patch && !text) {
    // An open line takes no fill, so a fill asked of it only clears the file's.
    if (patch.fill && (d.type !== "line" || d.closed)) out.paint = { kind: "color", color: withAlpha(DRAWING_HEX[patch.fill], DRAWING_TINT) } satisfies SheetFill
    else delete out.paint
  }
  return out
}

/** Style fields a drawing of this type uses. */
export function styleOf(d: SchematicDrawing): DrawingStyle {
  return { color: d.color, fill: d.fill, weight: d.weight, dash: d.dash }
}
