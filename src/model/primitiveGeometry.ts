import type { SymbolPrimitive, Vec2 } from "./types"

// The curved shapes a symbol can have (S6), as the editor draws and measures them. A symbol's arcs
// are kept as KiCad keeps them, three points on the circle; a Bezier by its four points. Both the
// editor's canvas and the SVG the copilot looks at write the same path data from here, so a shape
// is the same wherever it is drawn.

/** The circle through three points, or null when they lie on a line. */
export function circleThrough(s: Vec2, m: Vec2, e: Vec2): { center: Vec2; radius: number } | null {
  const d = 2 * (s.x * (m.y - e.y) + m.x * (e.y - s.y) + e.x * (s.y - m.y))
  if (Math.abs(d) < 1e-12) return null
  const s2 = s.x * s.x + s.y * s.y
  const m2 = m.x * m.x + m.y * m.y
  const e2 = e.x * e.x + e.y * e.y
  const x = (s2 * (m.y - e.y) + m2 * (e.y - s.y) + e2 * (s.y - m.y)) / d
  const y = (s2 * (e.x - m.x) + m2 * (s.x - e.x) + e2 * (m.x - s.x)) / d
  return { center: { x, y }, radius: Math.hypot(s.x - x, s.y - y) }
}

const TAU = Math.PI * 2
const norm = (a: number) => ((a % TAU) + TAU) % TAU

/** An arc from `start` through `mid` to `end`: its circle, the angles of its ends and which way round it goes. */
export function arcOf(start: Vec2, mid: Vec2, end: Vec2): { center: Vec2; radius: number; from: number; sweep: number } | null {
  const c = circleThrough(start, mid, end)
  if (!c) return null
  const angle = (p: Vec2) => Math.atan2(p.y - c.center.y, p.x - c.center.x)
  const aS = angle(start)
  const aM = angle(mid)
  const aE = angle(end)
  // Counter-clockwise (the angle grows) when the middle is passed before the end going that way.
  const ccw = norm(aM - aS) < norm(aE - aS)
  const sweep = ccw ? norm(aE - aS) : -norm(aS - aE)
  return { center: c.center, radius: c.radius, from: aS, sweep }
}

const n = (v: number) => Number(v.toFixed(5)).toString()

/** SVG path data of an arc, ready for a user space in which y is as the symbol has it. */
export function arcPathData(start: Vec2, mid: Vec2, end: Vec2): string {
  const a = arcOf(start, mid, end)
  if (!a) return `M${n(start.x)},${n(start.y)}L${n(end.x)},${n(end.y)}`
  const large = Math.abs(a.sweep) > Math.PI ? 1 : 0
  // Positive sweep is the direction in which the angle grows, in the user space of the path.
  const sweepFlag = a.sweep > 0 ? 1 : 0
  return `M${n(start.x)},${n(start.y)}A${n(a.radius)},${n(a.radius)} 0 ${large} ${sweepFlag} ${n(end.x)},${n(end.y)}`
}

export function bezierPathData(p: readonly Vec2[]): string {
  if (p.length < 4) return `M${p.map((q) => `${n(q.x)},${n(q.y)}`).join("L")}`
  return `M${n(p[0].x)},${n(p[0].y)}C${n(p[1].x)},${n(p[1].y)} ${n(p[2].x)},${n(p[2].y)} ${n(p[3].x)},${n(p[3].y)}`
}

/** The point of an ellipse (or an arc of it) at the parametric angle `t`, in radians. */
function ellipsePoint(c: Vec2, rx: number, ry: number, rotation: number, t: number): Vec2 {
  const r = (rotation * Math.PI) / 180
  const x = rx * Math.cos(t)
  const y = ry * Math.sin(t)
  return { x: c.x + x * Math.cos(r) - y * Math.sin(r), y: c.y + x * Math.sin(r) + y * Math.cos(r) }
}

export function ellipsePathData(c: Vec2, rx: number, ry: number, rotation: number, from?: number, to?: number): string {
  if (from === undefined || to === undefined) {
    const a = ellipsePoint(c, rx, ry, rotation, 0)
    const b = ellipsePoint(c, rx, ry, rotation, Math.PI)
    return `M${n(a.x)},${n(a.y)}A${n(rx)},${n(ry)} ${n(rotation)} 1 1 ${n(b.x)},${n(b.y)}A${n(rx)},${n(ry)} ${n(rotation)} 1 1 ${n(a.x)},${n(a.y)}Z`
  }
  const a0 = (from * Math.PI) / 180
  let a1 = (to * Math.PI) / 180
  if (a1 <= a0) a1 += TAU
  const s = ellipsePoint(c, rx, ry, rotation, a0)
  const e = ellipsePoint(c, rx, ry, rotation, a1)
  return `M${n(s.x)},${n(s.y)}A${n(rx)},${n(ry)} ${n(rotation)} ${a1 - a0 > Math.PI ? 1 : 0} 1 ${n(e.x)},${n(e.y)}`
}

/** Path data of a shape drawn as a path, or null for a circle or text, which have elements of their own. */
export function primitivePathData(p: SymbolPrimitive): string | null {
  switch (p.type) {
    case "path":
      return p.points.map((q, i) => `${i ? "L" : "M"}${n(q.x)},${n(q.y)}`).join("")
    case "arc":
      return arcPathData(p.start, p.mid, p.end)
    case "bezier":
      return bezierPathData(p.points)
    case "ellipse":
      return ellipsePathData({ x: p.x, y: p.y }, p.rx, p.ry, p.rotation, p.from, p.to)
    default:
      return null
  }
}

/** Points along a curved shape, enough to measure its box and to turn it into a polyline. */
export function samplePrimitive(p: SymbolPrimitive, steps = 24): Vec2[] {
  switch (p.type) {
    case "path":
      return p.points
    case "circle":
      return [
        { x: p.x - p.radius, y: p.y - p.radius },
        { x: p.x + p.radius, y: p.y + p.radius },
      ]
    case "arc": {
      const a = arcOf(p.start, p.mid, p.end)
      if (!a) return [p.start, p.end]
      const out: Vec2[] = []
      const count = Math.max(steps, Math.ceil(Math.abs(a.sweep) / (Math.PI / 12)))
      for (let i = 0; i <= count; i++) {
        const t = a.from + (a.sweep * i) / count
        out.push({ x: a.center.x + a.radius * Math.cos(t), y: a.center.y + a.radius * Math.sin(t) })
      }
      // Land exactly on the ends.
      out[0] = p.start
      out[out.length - 1] = p.end
      return out
    }
    case "bezier": {
      const [p0, p1, p2, p3] = p.points
      const out: Vec2[] = []
      for (let i = 0; i <= steps; i++) {
        const t = i / steps
        const u = 1 - t
        out.push({
          x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
          y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
        })
      }
      return out
    }
    case "ellipse": {
      const out: Vec2[] = []
      const a0 = p.from === undefined || p.to === undefined ? 0 : (p.from * Math.PI) / 180
      let a1 = p.from === undefined || p.to === undefined ? TAU : (p.to * Math.PI) / 180
      if (a1 <= a0) a1 += TAU
      for (let i = 0; i <= steps * 2; i++) out.push(ellipsePoint({ x: p.x, y: p.y }, p.rx, p.ry, p.rotation, a0 + ((a1 - a0) * i) / (steps * 2)))
      return out
    }
    default:
      return []
  }
}
