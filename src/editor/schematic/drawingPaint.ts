import { LINE_HEIGHT, strokeWidth, textFrame, textLines } from "../../model/drawings"
import type { DrawingLine, SchematicDrawing, Vec2 } from "../../model/types"
import type { SchPalette } from "../theme"

// How a drawing is painted, as a list of SVG elements, in world space (y up). The schematic editor
// renders the list as React elements and the copilot's pictures as SVG text (`ai/vision`), so what
// Sakura sees is what the user sees.

export interface PaintNode {
  tag: "path" | "rect" | "polyline" | "polygon" | "text"
  /** Attributes by their React names (camelCase); `ai/vision` writes them out in SVG's. */
  attrs: Record<string, string | number | undefined>
  /** A text element's content and face. */
  text?: string
  mono?: boolean
}

/** Dashes and dots scale with the line, so a thick dashed line still reads as dashed. */
function dashArray(d: SchematicDrawing, width: number): string | undefined {
  const w = Math.max(width, 0.016)
  if (d.dash === "dashed") return `${w * 5} ${w * 3.5}`
  if (d.dash === "dotted") return `0.0001 ${w * 2.6}`
  return undefined
}

/** An arrowhead whose tip is at `tip`, pointing away from `from`, and where the line should stop under it. */
function arrowHead(tip: Vec2, from: Vec2, width: number): { points: Vec2[]; base: Vec2 } {
  const len = 0.06 + width * 3
  const dx = tip.x - from.x
  const dy = tip.y - from.y
  const l = Math.hypot(dx, dy) || 1
  const ux = dx / l
  const uy = dy / l
  const back = { x: tip.x - ux * len, y: tip.y - uy * len }
  const half = len * 0.42
  return {
    points: [tip, { x: back.x - uy * half, y: back.y + ux * half }, { x: back.x + uy * half, y: back.y - ux * half }],
    base: { x: tip.x - ux * len * 0.7, y: tip.y - uy * len * 0.7 },
  }
}

const pointList = (pts: Vec2[]) => pts.map((p) => `${round4(p.x)},${round4(p.y)}`).join(" ")
const round4 = (n: number) => Math.round(n * 10000) / 10000

/** The line's points with its ends drawn back under its arrowheads, and the heads themselves. */
function arrowedLine(d: DrawingLine, width: number): { points: Vec2[]; heads: Vec2[][] } {
  const points = d.points.slice()
  const heads: Vec2[][] = []
  if (d.closed || !d.arrows || points.length < 2) return { points, heads }
  // The neighbour of an end that isn't on top of it, so a doubled point doesn't lose the direction.
  const away = (from: number, step: number) => {
    for (let i = from + step; i >= 0 && i < points.length; i += step) if (points[i].x !== points[from].x || points[i].y !== points[from].y) return points[i]
    return null
  }
  const last = points.length - 1
  if (d.arrows === "end" || d.arrows === "both") {
    const from = away(last, -1)
    if (from) {
      const h = arrowHead(points[last], from, width)
      heads.push(h.points)
      points[last] = h.base
    }
  }
  if (d.arrows === "start" || d.arrows === "both") {
    const from = away(0, 1)
    if (from) {
      const h = arrowHead(d.points[0], from, width)
      heads.push(h.points)
      points[0] = h.base
    }
  }
  return { points, heads }
}

/** The elements that draw `d` on `sch`'s sheet, at `px` world units per screen pixel. */
export function paintDrawing(d: SchematicDrawing, sch: SchPalette, px: number): PaintNode[] {
  const color = sch.drawing[d.color ?? "ink"]
  const fill = d.fill ? sch.drawing[d.fill] : undefined
  const width = Math.max(strokeWidth(d), px * 0.9)
  const stroke = {
    stroke: color,
    strokeWidth: width,
    strokeDasharray: dashArray(d, width),
    strokeLinecap: d.dash === "dotted" ? "round" : d.type === "line" ? "round" : "butt",
    strokeLinejoin: "round",
  }
  const tint = { fill: fill ?? "none", fillOpacity: fill ? sch.tint : undefined }

  if (d.type === "line") {
    if (d.closed && d.points.length > 2) return [{ tag: "polygon", attrs: { points: pointList(d.points), ...tint, ...stroke } }]
    const { points, heads } = arrowedLine(d, width)
    return [
      { tag: "polyline", attrs: { points: pointList(points), fill: "none", ...stroke } },
      ...heads.map((h): PaintNode => ({ tag: "polygon", attrs: { points: pointList(h), fill: color, stroke: color, strokeWidth: width * 0.5, strokeLinejoin: "round" } })),
    ]
  }
  if (d.type !== "text") {
    const r = Math.min(d.radius ?? 0, d.width / 2, d.height / 2)
    return [{ tag: "rect", attrs: { x: d.x, y: d.y, width: d.width, height: d.height, rx: r || undefined, ry: r || undefined, ...tint, ...stroke } }]
  }

  const nodes: PaintNode[] = []
  if (d.fill || d.border) {
    const f = textFrame(d)
    const r = d.size * 0.25
    nodes.push({
      tag: "rect",
      attrs: { x: f.minX, y: f.minY, width: f.maxX - f.minX, height: f.maxY - f.minY, rx: r, ry: r, ...tint, ...(d.border ? stroke : { stroke: "none" }) },
    })
  }
  // The text's own frame: upright on screen, turned a quarter when it reads upwards, its lines
  // stacked down from the anchor.
  const turn = d.rot === 90 ? " rotate(-90)" : ""
  const anchor = d.align === "center" ? "middle" : d.align === "right" ? "end" : "start"
  textLines(d).forEach((line, i) => {
    if (!line) return
    nodes.push({
      tag: "text",
      attrs: {
        transform: `translate(${round4(d.x)},${round4(d.y)}) scale(1,-1)${turn}`,
        y: round4(i * d.size * LINE_HEIGHT),
        fontSize: d.size,
        textAnchor: anchor,
        dominantBaseline: "text-before-edge",
        fill: color,
        fontWeight: d.bold ? 700 : 500,
        fontStyle: d.italic ? "italic" : undefined,
      },
      text: line,
      mono: d.mono,
    })
  })
  return nodes
}
