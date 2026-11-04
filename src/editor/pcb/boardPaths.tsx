import type { ReactNode, SVGProps } from "react"
import { slotEnds, type WorldPad } from "../../model/instances"
import { holeCentre } from "../../model/padDistance"
import type { Vec2, Via } from "../../model/types"
import { PCB } from "../theme"

// The board's copper drawn as few paths: one for all the pieces that look alike (the tracks of one width, the pads of one colour, the drills),
// where it was an element or three for each. A board of 5,798 tracks, 5,215 vias and 10,000 pads was 110,000 elements, and the page went
// through all of them on every move of the pointer (to find what is under it) and every frame anything changed (to sort them into layers).
// Pieces of one path are drawn alike: opaque, and each filled shape wound the same way round, so where two overlap the path fills both.

/** A piece of a path, the props of the path it goes in (which pieces with the same `style` share), and its path data. */
export interface PathPiece {
  style: string
  props: SVGProps<SVGPathElement>
  d: string
}

/** Things in one list for each opacity, the faintest first. */
function byOpacityOf<T>(items: [opacity: number, item: T][]): [number, T[]][] {
  const groups = new Map<number, T[]>()
  for (const [o, item] of items) {
    const list = groups.get(o)
    if (list) list.push(item)
    else groups.set(o, [item])
  }
  return [...groups].sort((a, b) => a[0] - b[0])
}

const fadeGroup = (o: number, children: ReactNode) => (
  <g key={o} opacity={o === 1 ? undefined : o}>
    {children}
  </g>
)

/**
 * Elements in one group for each opacity, the fainter under the rest. An opacity of its own on each element makes it a piece of its own that the page
 * sorts into layers again on every frame anything changes: the 18,586 faint drawings and back-side parts of CERN's Macbeth took a quarter of a second
 * a frame to move the pointer over, where the same elements in a few groups take nothing.
 */
export const byOpacity = (items: [opacity: number, el: ReactNode][]): ReactNode[] => byOpacityOf(items).map(([o, els]) => fadeGroup(o, els))

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

/** Path pieces in one group for each opacity (`byOpacity`), each group's pieces merged (`mergedPaths`). */
export const fadedPaths = (pieces: [opacity: number, piece: PathPiece][]): ReactNode[] => byOpacityOf(pieces).map(([o, list]) => fadeGroup(o, mergedPaths(list)))

const n = (v: number) => +v.toFixed(5)

// Every filled shape below is wound the same way (the shoelace sum of its points positive, as `roundRectD` goes), so that in one path, filled by
// the non-zero rule, two that overlap fill their overlap rather than cancel there.

/** A circle as path data. */
export const circleD = (x: number, y: number, r: number) => `M${n(x - r)},${n(y)}a${n(r)},${n(r)} 0 1 1 ${n(2 * r)},0a${n(r)},${n(r)} 0 1 1 ${n(-2 * r)},0Z`

/** A rectangle with rounded corners (`rx` as an SVG rect has it, no more than half a side) as path data. */
export function roundRectD(x0: number, y0: number, w: number, h: number, rx: number): string {
  const x1 = x0 + w
  const y1 = y0 + h
  const r = Math.max(0, Math.min(rx, w / 2, h / 2))
  if (r <= 0) return `M${n(x0)},${n(y0)}H${n(x1)}V${n(y1)}H${n(x0)}Z`
  const a = `A${n(r)},${n(r)} 0 0 1 `
  return `M${n(x0 + r)},${n(y0)}H${n(x1 - r)}${a}${n(x1)},${n(y0 + r)}V${n(y1 - r)}${a}${n(x1 - r)},${n(y1)}H${n(x0 + r)}${a}${n(x0)},${n(y1 - r)}V${n(y0 + r)}${a}${n(x0 + r)},${n(y0)}Z`
}

const ringD = (ring: Vec2[]) => `M${ring.map((p) => `${p.x},${p.y}`).join("L")}Z`

/** A polygon as path data, wound as the other shapes are. */
function polygonD(ring: Vec2[]): string {
  let twice = 0
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i]
    const q = ring[(i + 1) % ring.length]
    twice += p.x * q.y - q.x * p.y
  }
  return ringD(twice < 0 ? [...ring].reverse() : ring)
}

/**
 * A pad as path pieces, drawn as the board always drew it: its copper, then its drill and plating (`holes`). A custom pad with a hole in it or in
 * pieces (more than one ring, filled even-odd) is a path of its own (its style names it), so no other pad's copper cuts into it.
 */
function padPieces(pad: WorldPad, id: string, color: string, highlight: boolean, px: number): { copper: PathPiece; holes: PathPiece[] } {
  const look = { fill: color, stroke: highlight ? "#ffffff" : "none", strokeWidth: highlight ? 1.6 * px : 0 }
  const style = `pad|${color}|${highlight}`
  let copper: PathPiece
  if (pad.shape === "circle") copper = { style, props: look, d: circleD(pad.x, pad.y, pad.width / 2) }
  else if (pad.rings && pad.rings.length > 1) copper = { style: `rings|${id}`, props: { ...look, fillRule: "evenodd" }, d: pad.rings.map(ringD).join("") }
  else if (pad.shape === "polygon" && pad.points) copper = { style, props: look, d: polygonD(pad.points) }
  else {
    // A pad that has its own shape is drawn as it is; the plain one keeps the slight rounding it has always been drawn with.
    const rr = pad.shape === "pill" ? Math.min(pad.width, pad.height) / 2 : pad.x7 ? (pad.corner ?? 0) : Math.min(pad.width, pad.height) * 0.12
    copper = { style, props: look, d: roundRectD(pad.x - pad.width / 2, pad.y - pad.height / 2, pad.width, pad.height, rr) }
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

/** Pads as few paths, in groups by opacity: all their copper, then all their drills. `outline` draws the copper as its lit outline alone. */
export function padPaths(pads: { opacity: number; pad: WorldPad; id: string; color: string; highlight: boolean; outline?: boolean }[], px: number): ReactNode[] {
  const copper: [number, PathPiece][] = []
  const holes: [number, PathPiece][] = []
  for (const p of pads) {
    const made = padPieces(p.pad, p.id, p.color, p.highlight, px)
    copper.push([p.opacity, p.outline ? { ...made.copper, style: `outline|${made.copper.style}`, props: { ...made.copper.props, fill: "none" } } : made.copper])
    if (!p.outline) for (const h of made.holes) holes.push([p.opacity, h])
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
