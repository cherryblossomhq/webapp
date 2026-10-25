import { boxesOverlap, type Box } from "../../lib/geometry"
import { arcCircle, pointShapeDistance, shapeCopper, shapeInkBox, type ShapeCopper } from "../../model/shapes"
import { SHAPE_LAYERS, shapeLayerInfo, type ShapeLayerInfo } from "../../model/shapeLayers"
import type { WorldShape } from "../../model/shapeItems"
import type { BoardShape, ShapePoint, Vec2 } from "../../model/types"

// The pure parts of drawing, selecting and hiding board drawings in the PCB view, kept out of the
// component so they can be tested without a browser.

/** The tools that make a new drawing. */
export type DrawTool = "line" | "arc" | "circle" | "rect" | "polygon"

export const DRAW_TOOLS: DrawTool[] = ["line", "arc", "circle", "rect", "polygon"]

export const isDrawTool = (tool: string): tool is DrawTool => (DRAW_TOOLS as string[]).includes(tool)

/** The shortcut of each drawing tool. */
export const DRAW_TOOL_KEYS: Record<DrawTool, string> = { line: "D", arc: "A", circle: "C", rect: "B", polygon: "P" }

export const DRAW_TOOL_NAMES: Record<DrawTool, string> = { line: "Draw line", arc: "Draw arc", circle: "Draw circle", rect: "Draw rectangle", polygon: "Draw polygon" }

/** Stroke width a drawing starts with on a layer (mm): silkscreen 0.15, copper 0.25, every other layer 0.1. */
export function defaultDrawWidth(layer: string): number {
  const kind = shapeLayerInfo(layer)?.kind
  if (kind === "silk") return 0.15
  if (kind === "copper") return 0.25
  return 0.1
}

/** The layer a drawing tool starts on. */
export const DEFAULT_DRAW_LAYER = "F.SilkS"

/** The board's edge: what a drawing tool draws on this layer is the board outline or a cutout, not a drawing. */
export const EDGE_CUTS_LAYER = "Edge.Cuts"

/** Every layer the picker offers: all of KiCad's drawing layers, and the board's edge. */
export const drawLayerChoices = (): ShapeLayerInfo[] => [...SHAPE_LAYERS, { name: EDGE_CUTS_LAYER, kind: "user", side: null, label: "Board outline (Edge.Cuts)" }]

// ---------- which drawings are shown ----------

export interface ShapeVisibility {
  hidden: Record<string, boolean>
  /** The editor's layer switches (`top`, `bottom`, `silk`). */
  layers: { top: boolean; bottom: boolean; silk: boolean }
}

/** Whether a drawing is on screen: its layer is not hidden, and the copper or silkscreen switch of its side is on. A part not placed has none. */
export function shapeShown(ws: WorldShape, vis: ShapeVisibility): boolean {
  if (!ws.placed) return false
  const name = ws.shape.layer
  if (vis.hidden[name]) return false
  const info = shapeLayerInfo(name)
  if (info?.kind === "copper") return info.side === "bottom" ? vis.layers.bottom : vis.layers.top
  if (info?.kind === "silk") return vis.layers.silk
  return true
}

export const visibleShapes = (shapes: WorldShape[], vis: ShapeVisibility): WorldShape[] => shapes.filter((s) => shapeShown(s, vis))

/** The drawing layers a project uses, in the order of the layer list, for the layer menu. */
export function usedShapeLayers(shapes: WorldShape[], textLayers: string[] = []): ShapeLayerInfo[] {
  const used = new Set([...shapes.map((s) => s.shape.layer), ...textLayers])
  const known = SHAPE_LAYERS.filter((l) => used.has(l.name))
  const unknown = [...used].filter((n) => !shapeLayerInfo(n)).sort().map((name): ShapeLayerInfo => ({ name, kind: "user", side: null, label: name }))
  return [...known, ...unknown]
}

// ---------- hit testing ----------

const coppers = new WeakMap<BoardShape, ShapeCopper>()

function copperOf(shape: BoardShape): ShapeCopper {
  let c = coppers.get(shape)
  if (!c) {
    // A coarse flattening is plenty for picking.
    c = shapeCopper(shape, 0.01)
    coppers.set(shape, c)
  }
  return c
}

/** Distance from a point to a drawing's ink: 0 on its stroke (half the width counted) or inside its fill. */
export function pointShapeInkDistance(at: Vec2, shape: BoardShape): number {
  return pointShapeDistance(at, copperOf(shape))
}

/**
 * The topmost visible drawing under a point, within `tol` of its stroke or inside its fill. Later
 * drawings are on top; board drawings come before a part's in the list, so a part's win a tie.
 */
export function hitShape(shapes: WorldShape[], at: Vec2, tol: number, vis: ShapeVisibility): WorldShape | null {
  for (let i = shapes.length - 1; i >= 0; i--) {
    const s = shapes[i]
    if (!shapeShown(s, vis)) continue
    const b = shapeInkBox(s.shape)
    if (at.x < b.minX - tol || at.x > b.maxX + tol || at.y < b.minY - tol || at.y > b.maxY + tol) continue
    if (pointShapeInkDistance(at, s.shape) <= tol) return s
  }
  return null
}

/** What clicking a drawing selects: a board drawing is itself, a dimension's line is the dimension, a part's drawing is the part. */
export function shapeSelectionId(ws: WorldShape): string {
  return ws.select ?? (ws.owner === "#board" ? ws.id : `c:${ws.owner}`)
}

/** The board drawings (`g:` ids) a marquee touches. */
export function marqueeShapes(shapes: WorldShape[], box: Box, vis: ShapeVisibility): string[] {
  const out: string[] = []
  for (const s of shapes) {
    if (!s.id.startsWith("g:") || !shapeShown(s, vis)) continue
    if (boxesOverlap(box, shapeInkBox(s.shape))) out.push(s.id)
  }
  return out
}

/** The ids of board drawings in a selection, without the prefix. */
export const graphicIds = (selection: string[]): string[] => selection.filter((s) => s.startsWith("g:")).map((s) => s.slice(2))

// ---------- the drawing tools ----------

/** Clicks a tool needs before it makes its shape; a polygon takes as many as it is given. */
export const DRAW_CLICKS: Record<DrawTool, number> = { line: 2, arc: 3, circle: 2, rect: 2, polygon: Infinity }

const near = (a: Vec2, b: Vec2) => Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6

/**
 * One more click. A click on the spot of the last one is ignored (a double click would
 * otherwise add a corner twice); `complete` says the tool has what it needs.
 */
export function addDrawPoint(tool: DrawTool, points: Vec2[], at: Vec2): { points: Vec2[]; complete: boolean } {
  const last = points[points.length - 1]
  if (last && near(last, at)) return { points, complete: false }
  const next = [...points, at]
  return { points: next, complete: next.length >= DRAW_CLICKS[tool] }
}

/** The style of a new drawing. */
export interface DrawStyle {
  layer: string
  width: number
}

function polygonArea(pts: Vec2[]): number {
  let a = 0
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]
    const q = pts[(i + 1) % pts.length]
    a += p.x * q.y - q.x * p.y
  }
  return a / 2
}

/** A polygon's corners without a corner repeated in a row (and the closing one). */
function distinctCorners(points: Vec2[]): ShapePoint[] {
  const out: ShapePoint[] = []
  for (const p of points) if (!out.length || !near(out[out.length - 1], p)) out.push({ x: p.x, y: p.y })
  while (out.length > 1 && near(out[0], out[out.length - 1])) out.pop()
  return out
}

/**
 * The drawing a tool makes from its clicks, or null when the clicks do not make a valid one: a line
 * or circle of no length, an arc whose three points lie on a line, a rectangle with a zero side, a
 * polygon of fewer than 3 corners or none of area.
 */
export function buildShape(tool: DrawTool, points: Vec2[], style: DrawStyle): BoardShape | null {
  const base = { layer: style.layer, width: style.width }
  const pt = (p: Vec2): Vec2 => ({ x: p.x, y: p.y })
  switch (tool) {
    case "line": {
      if (points.length < 2 || near(points[0], points[1])) return null
      return { ...base, type: "line", a: pt(points[0]), b: pt(points[1]) }
    }
    case "arc": {
      if (points.length < 3) return null
      const [start, mid, end] = points
      if (near(start, mid) || near(mid, end) || near(start, end)) return null
      if (!arcCircle(start, mid, end)) return null
      return { ...base, type: "arc", start: pt(start), mid: pt(mid), end: pt(end) }
    }
    case "circle": {
      if (points.length < 2) return null
      const r = Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y)
      if (r < 1e-6) return null
      return { ...base, type: "circle", c: pt(points[0]), r }
    }
    case "rect": {
      if (points.length < 2) return null
      const [a, b] = points
      if (Math.abs(a.x - b.x) < 1e-6 || Math.abs(a.y - b.y) < 1e-6) return null
      return { ...base, type: "rect", a: pt(a), b: pt(b) }
    }
    case "polygon": {
      const pts = distinctCorners(points)
      if (pts.length < 3 || Math.abs(polygonArea(pts)) < 1e-9) return null
      return { ...base, type: "polygon", pts }
    }
  }
}

/**
 * What to draw while the user is part way through: the clicks so far with the cursor as the next one.
 * Fewer clicks than a shape needs show as a line from the last click to the cursor.
 */
export function previewShape(tool: DrawTool, points: Vec2[], cursor: Vec2, style: DrawStyle): BoardShape | null {
  if (!points.length) return null
  const all = [...points, cursor]
  const asLine = (): BoardShape | null => buildShape("line", [points[points.length - 1], cursor], style)
  if (tool === "line" || tool === "circle" || tool === "rect") return buildShape(tool, all, style)
  if (tool === "arc") return points.length >= 2 ? (buildShape("arc", all, style) ?? asLine()) : asLine()
  // Polygon: the outline so far, closed back to the first corner once it has three.
  return distinctCorners(all).length >= 3 ? (buildShape("polygon", all, style) ?? asLine()) : asLine()
}

/** What the polygon tool finishes with, from its clicks so far. */
export const finishPolygon = (points: Vec2[], style: DrawStyle): BoardShape | null => buildShape("polygon", points, style)
