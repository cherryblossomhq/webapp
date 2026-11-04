import type { ReactNode, SVGProps } from "react"
import { slotEnds, type WorldPad } from "../../model/instances"
import { holeCentre } from "../../model/padDistance"
import type { Via } from "../../model/types"
import { PCB } from "../theme"

// The board's copper drawn as few paths: one for all the pieces that look alike (the tracks of one width, the pads of one colour, the drills),
// where it was an element or three for each. A board of 5,798 tracks, 5,215 vias and 10,000 pads was 110,000 elements, and the page went
// through all of them on every move of the pointer (to find what is under it) and every frame anything changed (to sort them into layers).
// Pieces of one path are drawn alike: opaque, they look as the separate elements did.

/** A piece of a path, the props of the path it goes in (which pieces with the same `style` share), and its path data. */
export interface PathPiece {
  style: string
  props: SVGProps<SVGPathElement>
  d: string
}

/** One path for each style, in the order the styles first come, each with the data of all its pieces. */
export function mergedPaths(pieces: PathPiece[]): ReactNode[] {
  const byStyle = new Map<string, { props: SVGProps<SVGPathElement>; d: string[] }>()
  for (const p of pieces) {
    const at = byStyle.get(p.style)
    if (at) at.d.push(p.d)
    else byStyle.set(p.style, { props: p.props, d: [p.d] })
  }
  return [...byStyle].map(([style, { props, d }]) => <path key={style} {...props} d={d.join("")} />)
}

/** The pieces in one group for each opacity, the fainter under the rest, each group's pieces merged (`mergedPaths`). */
export function fadedPaths(pieces: [opacity: number, piece: PathPiece][]): ReactNode[] {
  const groups = new Map<number, PathPiece[]>()
  for (const [o, p] of pieces) {
    const list = groups.get(o)
    if (list) list.push(p)
    else groups.set(o, [p])
  }
  return [...groups]
    .sort((a, b) => a[0] - b[0])
    .map(([o, list]) => (
      <g key={o} opacity={o === 1 ? undefined : o}>
        {mergedPaths(list)}
      </g>
    ))
}

const n = (v: number) => +v.toFixed(5)

/** A circle as path data. */
export const circleD = (x: number, y: number, r: number) => `M${n(x - r)},${n(y)}a${n(r)},${n(r)} 0 1 0 ${n(2 * r)},0a${n(r)},${n(r)} 0 1 0 ${n(-2 * r)},0Z`

/** A rectangle with rounded corners (`rx` as an SVG rect has it, no more than half a side) as path data. */
export function roundRectD(x0: number, y0: number, w: number, h: number, rx: number): string {
  const x1 = x0 + w
  const y1 = y0 + h
  const r = Math.max(0, Math.min(rx, w / 2, h / 2))
  if (r <= 0) return `M${n(x0)},${n(y0)}H${n(x1)}V${n(y1)}H${n(x0)}Z`
  const a = `A${n(r)},${n(r)} 0 0 1 `
  return `M${n(x0 + r)},${n(y0)}H${n(x1 - r)}${a}${n(x1)},${n(y0 + r)}V${n(y1 - r)}${a}${n(x1 - r)},${n(y1)}H${n(x0 + r)}${a}${n(x0)},${n(y1 - r)}V${n(y0 + r)}${a}${n(x0 + r)},${n(y0)}Z`
}

const ringD = (ring: { x: number; y: number }[]) => `M${ring.map((p) => `${p.x},${p.y}`).join("L")}Z`

/**
 * A pad as path pieces, drawn as `PadShape` draws it: its copper (`copper`), then its drill and plating (`holes`). A custom pad with a hole in it
 * or in pieces (more than one ring, filled even-odd) is a path of its own (its style names it), so no other pad's copper cuts into it.
 */
export function padPieces(pad: WorldPad, id: string, color: string, highlight: boolean, px: number): { copper: PathPiece; holes: PathPiece[] } {
  const stroke = highlight ? "#ffffff" : "none"
  const sw = highlight ? 1.6 * px : 0
  const look = { fill: color, stroke, strokeWidth: sw }
  let copper: PathPiece
  if (pad.shape === "circle") copper = { style: `pad|${color}|${highlight}`, props: look, d: circleD(pad.x, pad.y, pad.width / 2) }
  else if (pad.rings && pad.rings.length > 1) copper = { style: `rings|${id}`, props: { ...look, fillRule: "evenodd" }, d: pad.rings.map(ringD).join("") }
  else if (pad.shape === "polygon" && pad.points) copper = { style: `pad|${color}|${highlight}`, props: look, d: ringD(pad.points) }
  else {
    // A pad that has its own shape is drawn as it is; the plain one keeps the slight rounding it has always been drawn with.
    const rr = pad.shape === "pill" ? Math.min(pad.width, pad.height) / 2 : pad.x7 ? (pad.corner ?? 0) : Math.min(pad.width, pad.height) * 0.12
    copper = { style: `pad|${color}|${highlight}`, props: look, d: roundRectD(pad.x - pad.width / 2, pad.y - pad.height / 2, pad.width, pad.height, rr) }
  }
  const holes: PathPiece[] = []
  const d = pad.holeDiameter
  if (d) {
    const ring = Math.min(d * 0.12, Math.max(0.05, 1.2 * px))
    const ends = slotEnds(pad)
    if (!ends) {
      const at = holeCentre(pad)
      holes.push({ style: `hole|${ring}`, props: { fill: PCB.hole, stroke: PCB.plating, strokeWidth: ring }, d: circleD(at.x, at.y, d / 2) })
    } else {
      // Two round-capped strokes: the plating ring, then the drill inside it, as the circle draws them.
      const [a, b] = ends
      const line = `M${a.x},${a.y}L${b.x},${b.y}`
      holes.push({ style: `slot|${d + ring}`, props: { fill: "none", stroke: PCB.plating, strokeWidth: d + ring, strokeLinecap: "round" }, d: line })
      holes.push({ style: `slotDrill|${d - ring}`, props: { fill: "none", stroke: PCB.hole, strokeWidth: d - ring, strokeLinecap: "round" }, d: line })
    }
  }
  return { copper, holes }
}

/** Pads as few paths, in groups by opacity: all their copper, then all their drills. */
export function padPaths(pads: { opacity: number; pad: WorldPad; id: string; color: string; highlight: boolean }[], px: number): ReactNode[] {
  const copper: [number, PathPiece][] = []
  const holes: [number, PathPiece][] = []
  for (const p of pads) {
    const made = padPieces(p.pad, p.id, p.color, p.highlight, px)
    copper.push([p.opacity, made.copper])
    for (const h of made.holes) holes.push([p.opacity, h])
  }
  return fadedPaths([...copper, ...holes])
}

/**
 * Vias as few paths, as the board drew each: its ring (a via that does not run the whole stack in the colour `ringColor` gives it, with a dashed
 * edge), its drill, and a micro via's inner ring.
 */
export function viaPaths(vias: { opacity: number; via: Via; ringColor: string; partial: boolean; lit: boolean }[], px: number): ReactNode[] {
  const pieces: [number, PathPiece][] = []
  for (const { opacity, via: v, ringColor, partial, lit } of vias) {
    const stroke = lit ? "#fff" : partial ? PCB.hole : "none"
    pieces.push([
      opacity,
      {
        style: `via|${ringColor}|${stroke}|${partial}`,
        props: { fill: ringColor, stroke, strokeWidth: 1.4 * px, strokeDasharray: partial ? `${3 * px} ${2 * px}` : undefined },
        d: circleD(v.x, v.y, v.diameter / 2),
      },
    ])
  }
  for (const { opacity, via: v } of vias) pieces.push([opacity, { style: "viaDrill", props: { fill: PCB.hole }, d: circleD(v.x, v.y, v.drill / 2) }])
  for (const { opacity, via: v } of vias) {
    if (v.kind === "micro") pieces.push([opacity, { style: "viaMicro", props: { fill: "none", stroke: PCB.hole, strokeWidth: 1 * px }, d: circleD(v.x, v.y, v.diameter / 2 - 1.2 * px) }])
  }
  return fadedPaths(pieces)
}
