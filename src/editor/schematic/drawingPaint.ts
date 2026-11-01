import { LINE_HEIGHT, strokeWidth, textFrame, textLines } from "../../model/drawings"
import { primitivePathData } from "../../model/primitiveGeometry"
import { BUS_WIDTH, boxCorners, boxTextAt, directiveShape, imageSize, lookOfText, textLines as kicadLines, textLines2 } from "../../model/sheetItems"
import type { DrawingLine, DrawingStyle, DrawingTable, Rotation, SchematicDrawing, SheetFill, ShapeLook, TextLook, Vec2 } from "../../model/types"
import type { SchPalette } from "../theme"
import { imageDataUri } from "../../store/imageFiles"

// How a drawing is painted, as a list of SVG elements, in world space (y up). The schematic editor
// renders the list as React elements and the copilot's pictures as SVG text (`ai/vision`), so what
// Sakura sees is what the user sees.

export interface PaintNode {
  tag: "path" | "rect" | "polyline" | "polygon" | "text" | "circle" | "line" | "image" | "ktext"
  /** Attributes by their React names (camelCase); `ai/vision` writes them out in SVG's. */
  attrs: Record<string, string | number | undefined>
  /** A text element's content and face. */
  text?: string
  mono?: boolean
  /**
   * A `ktext`: a line of text placed KiCad's way, from its anchor and the way it extends (`WorldText` in the
   * editor, `text()` in a picture), where a `text` is the editor's own, set from the top of its first line.
   */
  kicad?: { x: number; y: number; size: number; extent: { x: number; y: number }; vertical: boolean; fill: string; weight: number; italic?: boolean; markup?: boolean }
}

/** KiCad's line styles in line widths: a dash is 6, a dot 1, the gap 3. */
function kicadDash(dash: ShapeLook["dash"], w: number): string | undefined {
  switch (dash) {
    case "dash":
      return `${w * 6} ${w * 3}`
    case "dot":
      return `${w} ${w * 3}`
    case "dash_dot":
      return `${w * 6} ${w * 3} ${w} ${w * 3}`
    case "dash_dot_dot":
      return `${w * 6} ${w * 3} ${w} ${w * 3} ${w} ${w * 3}`
    default:
      return undefined
  }
}

/** Dashes and dots scale with the line, so a thick dashed line still reads as dashed. */
function dashArray(d: DrawingStyle, width: number): string | undefined {
  if (d.stroke) return d.stroke.dash ? kicadDash(d.stroke.dash, width) : d.dash ? namedDash(d, width) : undefined
  return namedDash(d, width)
}

function namedDash(d: DrawingStyle, width: number): string | undefined {
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

/** What a KiCad fill paints: the outline's colour, the sheet's body colour, or a colour of its own. */
const paintOf = (paint: SheetFill | undefined, stroke: string, sch: SchPalette) => (!paint ? "none" : paint.kind === "outline" ? stroke : paint.kind === "background" ? sch.body : (paint.color ?? sch.body))

/** The elements that draw `d` on `sch`'s sheet, at `px` world units per screen pixel. */
export function paintDrawing(d: SchematicDrawing, sch: SchPalette, px: number): PaintNode[] {
  if (d.type === "text" && d.hidden) return []
  // A line with a look of KiCad's own has its colour, or KiCad's wire blue where it names none; otherwise it is the named colour.
  const color = d.stroke?.color ?? (d.stroke && !d.color ? sch.wire : sch.drawing[d.color ?? "ink"])
  const fill = d.fill ? sch.drawing[d.fill] : undefined
  const width = Math.max(strokeWidth(d), px * 0.9)
  const stroke = {
    stroke: color,
    strokeWidth: width,
    strokeDasharray: dashArray(d, width),
    strokeLinecap: d.dash === "dotted" || d.stroke ? "round" : d.type === "line" ? "round" : "butt",
    strokeLinejoin: "round",
  }
  const tint = d.paint ? { fill: paintOf(d.paint, color, sch) } : { fill: fill ?? "none", fillOpacity: fill ? sch.tint : undefined }

  if (d.type === "line") {
    // A KiCad polyline filled is a polygon whether or not its last point repeats its first.
    if ((d.closed && d.points.length > 2) || (d.paint && d.points.length > 2)) return [{ tag: "polygon", attrs: { points: pointList(d.points), ...tint, ...stroke } }]
    const { points, heads } = arrowedLine(d, width)
    return [
      { tag: "polyline", attrs: { points: pointList(points), fill: "none", ...stroke } },
      ...heads.map((h): PaintNode => ({ tag: "polygon", attrs: { points: pointList(h), fill: color, stroke: color, strokeWidth: width * 0.5, strokeLinejoin: "round" } })),
    ]
  }
  if (d.type === "rect") {
    const r = Math.min(d.radius ?? 0, d.width / 2, d.height / 2)
    return [{ tag: "rect", attrs: { x: d.x, y: d.y, width: d.width, height: d.height, rx: r || undefined, ry: r || undefined, ...tint, ...stroke } }]
  }
  if (d.type !== "text") return kicadOnlyNodes(d, sch, px, { stroke, tint, color })

  const nodes: PaintNode[] = []
  if (d.valign) return kicadTextNodes(d, sch)
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

const polygon = (pts: Vec2[]) => pointList(pts)

/** A text placed KiCad's way, line by line from where it is anchored. */
function ktextNodes(text: string, at: Vec2, rot: Rotation, look: TextLook | undefined, fill: string): PaintNode[] {
  if (look?.hidden) return []
  return textLines2(at, rot, look, kicadLines(text)).flatMap((l): PaintNode[] =>
    l.text ? [{ tag: "ktext", attrs: {}, text: l.text, kicad: { x: l.x, y: l.y, size: l.size, extent: l.extent, vertical: l.vertical, fill: look?.color ?? fill, weight: look?.bold ? 700 : 500, italic: look?.italic, markup: true } }] : [],
  )
}

/** A text from a KiCad file: its look is the drawing's, its colour the pen's or the sheet's own text colour. */
function kicadTextNodes(d: Extract<SchematicDrawing, { type: "text" }>, sch: SchPalette): PaintNode[] {
  const look = lookOfText(d)
  return ktextNodes(d.text, d, d.rot ?? 0, look, d.color ? sch.drawing[d.color] : sch.ink2)
}

type Pen = { stroke: Record<string, string | number | undefined>; tint: Record<string, string | number | undefined>; color: string }

/** The drawings only a KiCad sheet has: arcs, curves, circles, text boxes, pictures, tables, dots and flags. */
function kicadOnlyNodes(d: Exclude<SchematicDrawing, { type: "line" | "rect" | "text" }>, sch: SchPalette, px: number, pen: Pen): PaintNode[] {
  // They are drawn at the width KiCad draws a line of no width (and in KiCad's wire blue) when the file said none.
  const stroke = { ...pen.stroke, strokeWidth: Math.max(d.stroke?.width ?? 0.012, px * 0.8), strokeDasharray: kicadDash(d.stroke?.dash, Math.max(d.stroke?.width ?? 0.012, px * 0.8)) }
  const color = d.stroke?.color ?? sch.wire
  const draw = { ...stroke, stroke: color }
  const fill = d.paint ? paintOf(d.paint, color, sch) : "none"
  switch (d.type) {
    case "textbox": {
      const at = boxTextAt(d, d.margins, d.look)
      return [{ tag: "polygon", attrs: { points: polygon(boxCorners(d, d.w, d.h, d.rot)), fill, ...draw } }, ...ktextNodes(d.text, at, d.rot, d.look, sch.ink2)]
    }
    case "circle":
      return [{ tag: "circle", attrs: { cx: d.x, cy: d.y, r: d.radius, fill, ...draw } }]
    case "arc":
      return [{ tag: "path", attrs: { d: primitivePathData({ type: "arc", start: d.start, mid: d.mid, end: d.end, fill: false }) ?? "", fill: "none", ...draw } }]
    case "bezier":
      return [{ tag: "path", attrs: { d: primitivePathData({ type: "bezier", points: d.points, fill: false }) ?? "", fill, ...draw } }]
    case "image": {
      const s = imageSize(d)
      // A picture in the file store draws once its bytes are on the page (`useImages` loads them); until then, or when the file is not here, a frame of its size.
      const href = d.data ? `data:image/png;base64,${d.data}` : d.file ? imageDataUri({ file: d.file, format: "png" }) : null
      if (!href) return [{ tag: "rect", attrs: { x: d.x - s.w / 2, y: d.y - s.h / 2, width: s.w, height: s.h, fill: "none", stroke: sch.ink2, strokeWidth: px, strokeDasharray: `${4 * px} ${3 * px}` } }]
      return [{ tag: "image", attrs: { href, transform: `translate(${d.x},${d.y}) scale(1,-1)`, x: -s.w / 2, y: -s.h / 2, width: s.w, height: s.h, preserveAspectRatio: "none" } }]
    }
    case "table":
      return tableNodes(d, sch, px)
    case "bus": {
      // A bus is drawn twice as wide as a wire, in KiCad's colour for it, or the colour its file gave.
      const width = Math.max(d.stroke?.width ?? BUS_WIDTH, px * 1.6)
      return [{ tag: "polyline", attrs: { points: pointList(d.points), fill: "none", stroke: color, strokeWidth: width, strokeDasharray: kicadDash(d.stroke?.dash, width), strokeLinecap: "round", strokeLinejoin: "round" } }]
    }
    case "busentry": {
      const width = Math.max(d.stroke?.width ?? BUS_WIDTH / 2, px * 1.2)
      return [{ tag: "line", attrs: { x1: d.x, y1: d.y, x2: d.x + d.dx, y2: d.y + d.dy, stroke: color, strokeWidth: width, strokeLinecap: "round" } }]
    }
    case "junction":
      return [{ tag: "circle", attrs: { cx: d.x, cy: d.y, r: (d.diameter ?? 0.08) / 2, fill: d.dotColor ?? sch.junction } }]
    case "noconnect": {
      const r = 0.06
      return [
        { tag: "path", attrs: { d: `M${d.x - r},${d.y - r} L${d.x + r},${d.y + r} M${d.x - r},${d.y + r} L${d.x + r},${d.y - r}`, fill: "none", stroke: sch.noConnect, strokeWidth: Math.max(sch.stroke, 1.4 * px), strokeLinecap: "round" } },
      ]
    }
    case "directive": {
      // S8: the pin and its flag as KiCad's painter draws them, then each field that has something to say.
      const g = directiveShape(d)
      const ink = d.stroke?.color ?? sch.drawing.purple
      const w = Math.max(0.012, px * 0.8)
      const pen = { stroke: ink, strokeWidth: w, strokeLinecap: "round", strokeLinejoin: "round" }
      const nodes: PaintNode[] = [{ tag: "line", attrs: { x1: g.pin[0].x, y1: g.pin[0].y, x2: g.pin[1].x, y2: g.pin[1].y, ...pen } }]
      if (g.circle) nodes.push({ tag: "circle", attrs: { cx: g.circle.at.x, cy: g.circle.at.y, r: g.circle.r, fill: g.circle.filled ? ink : "none", ...pen } })
      if (g.outline) nodes.push({ tag: "polyline", attrs: { points: polygon(g.outline), fill: "none", ...pen } })
      for (const f of d.fields) {
        if (f.place.hidden || !f.value.trim()) continue
        const look: TextLook = { ...(f.place.size ? { size: f.place.size } : {}), ...(f.place.h ? { h: f.place.h } : {}), ...(f.place.v ? { v: f.place.v } : {}), ...(f.place.bold ? { bold: true as const } : {}), ...(f.place.italic ? { italic: true as const } : {}), ...(f.place.color ? { color: f.place.color } : {}) }
        nodes.push(...ktextNodes(f.place.showName ? `${f.name}: ${f.value}` : f.value, { x: d.x + f.place.x, y: d.y + f.place.y }, f.place.angle, look, ink))
      }
      return nodes
    }
  }
}

/** A table: each cell's fill and text, then the lines (its outer border, the line under its header row, the lines between its rows and columns where they are on). */
function tableNodes(item: DrawingTable, sch: SchPalette, px: number): PaintNode[] {
  const line = (s: { width?: number; dash?: ShapeLook["dash"]; color?: string } | undefined) => {
    const w = Math.max(s?.width ?? 0.012, 0.8 * px)
    return { stroke: s?.color ?? sch.wire, strokeWidth: w, strokeLinecap: "round", strokeLinejoin: "round", strokeDasharray: kicadDash(s?.dash, w) }
  }
  const border = line(item.border.stroke)
  const sep = line(item.separators.stroke)
  const nodes: PaintNode[] = []
  for (const c of item.cells) {
    if (c.fill) nodes.push({ tag: "polygon", attrs: { points: polygon(boxCorners(c, c.w, c.h, c.rot)), fill: paintOf(c.fill, sch.ink2, sch), stroke: "none" } })
    if (c.text) nodes.push(...ktextNodes(c.text, boxTextAt(c, c.margins, c.look), c.rot, c.look, sch.ink2))
  }
  // Each cell's own edges: the ones on the table's edge are the border, the others separators.
  const xs = item.cells.flatMap((c) => boxCorners(c, c.w, c.h, c.rot).map((p) => p.x))
  const ys = item.cells.flatMap((c) => boxCorners(c, c.w, c.h, c.rot).map((p) => p.y))
  const edge = { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) }
  const eq = (a: number, b: number) => Math.abs(a - b) < 1e-6
  const headerBottom = item.cells.length ? Math.min(...item.cells.filter((c) => eq(c.y, edge.maxY)).map((c) => c.y - c.h)) : 0
  for (const c of item.cells) {
    const [p0, p1, p2, p3] = boxCorners(c, c.w, c.h, c.rot)
    const sides: [Vec2, Vec2][] = [
      [p0, p1],
      [p1, p2],
      [p2, p3],
      [p3, p0],
    ]
    for (const [a, b] of sides) {
      const horizontal = eq(a.y, b.y)
      const onEdge = horizontal ? eq(a.y, edge.minY) || eq(a.y, edge.maxY) : eq(a.x, edge.minX) || eq(a.x, edge.maxX)
      let pen: typeof border | null = null
      if (onEdge) {
        if (item.border.external) pen = border
      } else if (horizontal ? item.separators.rows : item.separators.cols) pen = sep
      else if (horizontal && item.border.header && eq(a.y, headerBottom)) pen = border
      if (pen) nodes.push({ tag: "line", attrs: { x1: a.x, y1: a.y, x2: b.x, y2: b.y, ...pen } })
    }
  }
  return nodes
}
