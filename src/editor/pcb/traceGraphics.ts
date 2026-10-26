import { arcOf, isArcTrace } from "../../model/arcTracks"
import type { Trace, Vec2 } from "../../model/types"

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
