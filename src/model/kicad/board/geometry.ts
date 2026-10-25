import type { KicadFootprint, KicadPad, KicadShape, Pt } from "./types"

// KiCad's frame: millimetres, y down, a positive angle turns counter-clockwise on screen.

const D2R = Math.PI / 180

/** A point turned by `deg` about the origin the way KiCad turns things. */
export function rotK(x: number, y: number, deg: number): Pt {
  const c = Math.cos(deg * D2R)
  const s = Math.sin(deg * D2R)
  return { x: x * c + y * s, y: -x * s + y * c }
}

/** An angle into [0, 360). */
export const mod360 = (deg: number) => ((deg % 360) + 360) % 360

/** How far a point of a part may move, in millimetres, when its angle is taken for the quarter turn beside it. */
export const QUARTER_TURN_TOLERANCE = 0.0005

/**
 * Quarter turns (0 to 3) when the angle is a multiple of 90 closely enough that no point of the
 * part, `radius` mm from the turn's centre at most, moves more than `QUARTER_TURN_TOLERANCE` when
 * the angle is taken for the quarter turn; null otherwise, and then the part needs X6. With no
 * radius (nothing to move) a hundredth of a degree is close enough.
 */
export function quarterTurns(deg: number, radius = 0): number | null {
  const q = deg / 90
  const off = Math.abs(q - Math.round(q)) * 90 * D2R
  const limit = radius > 0 ? QUARTER_TURN_TOLERANCE / radius : 0.01 * D2R
  return off <= limit ? ((Math.round(q) % 4) + 4) % 4 : null
}

/** How far from the origin a drawing of a footprint reaches (an upper bound: its points, and a circle's or an ellipse's radius beyond its centre). */
function shapeReach(s: KicadShape): number {
  const far = (p: Pt | undefined, extra = 0) => (p ? Math.hypot(p.x, p.y) + extra : 0)
  let r = Math.max(far(s.start), far(s.mid), far(s.end), far(s.center))
  if (s.kind === "circle" && s.center && s.end) r = Math.max(r, far(s.center, Math.hypot(s.end.x - s.center.x, s.end.y - s.center.y)))
  if (s.ellipse) r = Math.max(r, far(s.ellipse.center, Math.max(s.ellipse.major, s.ellipse.minor)))
  for (const p of s.pts ?? []) r = Math.max(r, far(p))
  for (const item of s.polyItems ?? []) {
    if ("xy" in item) r = Math.max(r, far(item.xy))
    else r = Math.max(r, far(item.arc.start), far(item.arc.mid), far(item.arc.end))
  }
  return r
}

/** The distance from a footprint's origin to the farthest corner of its farthest pad or drawing: what an angle error moves most. */
export function reach(fp: Pick<KicadFootprint, "pads"> & { shapes?: KicadShape[] }): number {
  let r = 0
  for (const p of fp.pads) r = Math.max(r, Math.hypot(p.at.x, p.at.y) + Math.hypot(p.w, p.h) / 2)
  for (const s of fp.shapes ?? []) r = Math.max(r, shapeReach(s))
  return r
}

/** Where a pad's centre is on the board: the footprint's position plus the pad's, turned by the footprint's angle. */
export function padWorld(fp: Pick<KicadFootprint, "at" | "angle">, pad: Pick<KicadPad, "at">): Pt {
  const r = rotK(pad.at.x, pad.at.y, fp.angle)
  return { x: fp.at.x + r.x, y: fp.at.y + r.y }
}

/** The corners of a pad's bounding rectangle on the board, turned by the pad's own (absolute) angle. */
export function padCorners(fp: Pick<KicadFootprint, "at" | "angle">, pad: Pick<KicadPad, "at" | "angle" | "w" | "h">): Pt[] {
  const c = padWorld(fp, pad)
  return [
    [-pad.w / 2, -pad.h / 2],
    [pad.w / 2, -pad.h / 2],
    [pad.w / 2, pad.h / 2],
    [-pad.w / 2, pad.h / 2],
  ].map(([x, y]) => {
    const r = rotK(x, y, pad.angle)
    return { x: c.x + r.x, y: c.y + r.y }
  })
}

/** The circle through three points: its centre, its radius and the sweep from `s` through `m` to `e` in degrees. */
export function arcThrough(s: Pt, m: Pt, e: Pt): { centre: Pt; radius: number; sweep: number } | null {
  const d = 2 * (s.x * (m.y - e.y) + m.x * (e.y - s.y) + e.x * (s.y - m.y))
  if (Math.abs(d) < 1e-12) return null
  const s2 = s.x * s.x + s.y * s.y
  const m2 = m.x * m.x + m.y * m.y
  const e2 = e.x * e.x + e.y * e.y
  const ux = (s2 * (m.y - e.y) + m2 * (e.y - s.y) + e2 * (s.y - m.y)) / d
  const uy = (s2 * (e.x - m.x) + m2 * (s.x - e.x) + e2 * (m.x - s.x)) / d
  const ang = (p: Pt) => Math.atan2(p.y - uy, p.x - ux)
  const norm = (x: number) => ((x % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)
  const a1 = ang(s)
  const d12 = norm(ang(m) - a1)
  const d13 = norm(ang(e) - a1)
  const sweep = d12 < d13 ? d13 : 2 * Math.PI - d13
  return { centre: { x: ux, y: uy }, radius: Math.hypot(s.x - ux, s.y - uy), sweep: sweep / D2R }
}

/**
 * A legacy arc (stamp 20210925 and older: `start` is the centre, `end` the first end, `angle` the
 * sweep, clockwise on screen when positive) as the start, middle and end points a modern one has.
 */
export function legacyArc(centre: Pt, first: Pt, sweep: number): { start: Pt; mid: Pt; end: Pt } {
  const dx = first.x - centre.x
  const dy = first.y - centre.y
  const end = rotK(dx, dy, -sweep)
  const mid = rotK(dx, dy, -sweep / 2)
  return { start: { ...first }, mid: { x: centre.x + mid.x, y: centre.y + mid.y }, end: { x: centre.x + end.x, y: centre.y + end.y } }
}
