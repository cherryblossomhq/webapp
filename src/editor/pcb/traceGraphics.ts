import { arcOf, isArcTrace } from "../../model/arcTracks"
import type { Trace, Vec2 } from "../../model/types"
import { PCB } from "../theme"
import type { PathPiece } from "./boardPaths"

// X4: how a trace is drawn. A polyline is its points; an arc track is the arc through its three, in SVG's own arc command so the curve is the circle, not chords.

/** The SVG path of a trace: `M x y L ...` for a polyline, `M x y A r r 0 large sweep x y` for an arc. */
export function traceD(t: Pick<Trace, "arc" | "points">): string {
  if (isArcTrace(t)) {
    const a = arcOf(t.points)
    const c = a.circle
    if (c) {
      const large = Math.abs(c.sweep) > Math.PI ? 1 : 0
      // The editor's y is up and the SVG is drawn with y flipped by the viewport, so the sweep flag is the arc's own direction (counter-clockwise is `1` here).
      const sweep = c.sweep > 0 ? 1 : 0
      // A full circle is two half arcs: SVG draws no arc whose ends are one point.
      if (Math.abs(Math.abs(c.sweep) - Math.PI * 2) < 1e-9 || (t.points[0].x === t.points[2].x && t.points[0].y === t.points[2].y)) {
        return `M ${a.start.x} ${a.start.y} A ${c.r} ${c.r} 0 1 ${sweep} ${a.mid.x} ${a.mid.y} A ${c.r} ${c.r} 0 1 ${sweep} ${a.end.x} ${a.end.y}`
      }
      return `M ${a.start.x} ${a.start.y} A ${c.r} ${c.r} 0 ${large} ${sweep} ${a.end.x} ${a.end.y}`
    }
    return `M ${t.points[0].x} ${t.points[0].y} L ${t.points[2].x} ${t.points[2].y}`
  }
  return `M ${t.points.map((p: Vec2) => `${p.x} ${p.y}`).join(" L ")}`
}

// How a lit or selected track is drawn: at exactly its own width, never wider. A track's width is what the board is made with, and the glow round
// a lit or selected one that this replaced read as a wider track.

const ROUND = { fill: "none", strokeLinecap: "round", strokeLinejoin: "round" } as const

/** How much white a lit track (its net under the pointer or picked in Checks) has over its copper. */
const LIT = 0.42
/** A track of a layer behind the front one is lit alone, none of its copper drawn over the front layer's, so a little more. */
const LIT_BEHIND = 0.55

/** A lit track: white over its copper, at its own width. */
export function litTrack(d: string, width: number, behind: boolean): PathPiece {
  const opacity = behind ? LIT_BEHIND : LIT
  return { style: `lit|${width}|${opacity}`, props: { ...ROUND, stroke: PCB.select, strokeWidth: width, strokeOpacity: opacity }, d }
}

/**
 * A selected track, at its own width: a white edge just inside its sides and its copper lit within it, as KiCad and Altium draw one. `copper` is its
 * layer's colour, or null for a track of a layer behind the front one, which is lit alone so that it hides none of the front layer's copper.
 */
export function selectedTrack(d: string, width: number, px: number, copper: string | null): PathPiece[] {
  if (!copper) return [{ style: `selected|${width}`, props: { ...ROUND, stroke: PCB.select, strokeWidth: width, strokeOpacity: 0.75 }, d }]
  // The edge is a pixel and a bit, and never more than a fifth of the width on each side, so a thin track seen from afar still shows its copper.
  const inner = width - 2 * Math.min(1.25 * px, width * 0.2)
  return [
    { style: `edge|${width}`, props: { ...ROUND, stroke: PCB.select, strokeWidth: width }, d },
    { style: `inner|${inner}`, props: { ...ROUND, stroke: copper, strokeWidth: inner }, d },
    { style: `innerLit|${inner}`, props: { ...ROUND, stroke: PCB.select, strokeWidth: inner, strokeOpacity: LIT }, d },
  ]
}
