import { round } from "../lib/geometry"
import type { FootprintDef, PadDef, Vec2 } from "./types"

// Building blocks for data-defined footprints. Millimetres, y up, origin at the footprint centre,
// as footprinter output.

export type Box = FootprintDef["courtyard"]

export const rect = (minX: number, minY: number, maxX: number, maxY: number): Vec2[] => [
  { x: minX, y: maxY },
  { x: maxX, y: maxY },
  { x: maxX, y: minY },
  { x: minX, y: minY },
  { x: minX, y: maxY },
]

export const box = (minX: number, minY: number, maxX: number, maxY: number): Box => ({ minX, minY, maxX, maxY })

export function circle(cx: number, cy: number, r: number, segments = 24): Vec2[] {
  return Array.from({ length: segments + 1 }, (_, i) => {
    const a = (i / segments) * Math.PI * 2
    return { x: round(cx + Math.cos(a) * r), y: round(cy + Math.sin(a) * r) }
  })
}

export const tht = (pin: string, x: number, y: number, size: number, drill: number, square = false): PadDef => ({
  pin,
  shape: square ? "rect" : "circle",
  x: round(x),
  y: round(y),
  width: size,
  height: size,
  holeDiameter: drill,
  layer: "through",
})

/** Oblong through-hole pad with a slot along its longer side, for connector shell tabs and jack lugs. */
export const slot = (pin: string, x: number, y: number, width: number, height: number, drill: number, length: number): PadDef => ({
  pin,
  shape: "pill",
  x: round(x),
  y: round(y),
  width,
  height,
  holeDiameter: drill,
  slotLength: length,
  layer: "through",
})

export const smd = (pin: string, x: number, y: number, width: number, height: number): PadDef => ({
  pin,
  shape: "rect",
  x: round(x),
  y: round(y),
  width,
  height,
  layer: "top",
})

/** Non-plated hole: a bare drill with no copper and no pin. */
export const npth = (x: number, y: number, drill: number): PadDef => ({
  pin: null,
  shape: "circle",
  x: round(x),
  y: round(y),
  width: drill,
  height: drill,
  holeDiameter: drill,
  layer: "through",
  plated: false,
})

export const line = (x0: number, y0: number, x1: number, y1: number): Vec2[] => [
  { x: round(x0), y: round(y0) },
  { x: round(x1), y: round(y1) },
]

export const range = (from: number, to: number, step: number) =>
  Array.from({ length: Math.round((to - from) / step) + 1 }, (_, i) => round(from + i * step))

/** Silk centreline to copper edge: half the 0.15 mm Gerber stroke plus about 0.12 mm. */
export const SILK_GAP = 0.2

/** Parameter range [t0, t1] of segment a-b inside a pad grown by `gap`, or null. */
function padSpan(a: Vec2, b: Vec2, pad: PadDef, gap: number): [number, number] | null {
  const dx = b.x - a.x
  const dy = b.y - a.y
  if (pad.shape === "circle") {
    const r = pad.width / 2 + gap
    const fx = a.x - pad.x
    const fy = a.y - pad.y
    const qa = dx * dx + dy * dy
    const qb = 2 * (fx * dx + fy * dy)
    const qc = fx * fx + fy * fy - r * r
    const disc = qb * qb - 4 * qa * qc
    if (qa < 1e-12 || disc <= 0) return null
    const sq = Math.sqrt(disc)
    return [(-qb - sq) / (2 * qa), (-qb + sq) / (2 * qa)]
  }
  // Rectangles and pills: clip against the grown bounding box (Liang-Barsky).
  let t0 = -Infinity
  let t1 = Infinity
  const slabs: [number, number, number, number][] = [
    [dx, a.x, pad.x - pad.width / 2 - gap, pad.x + pad.width / 2 + gap],
    [dy, a.y, pad.y - pad.height / 2 - gap, pad.y + pad.height / 2 + gap],
  ]
  for (const [d, p0, lo, hi] of slabs) {
    if (Math.abs(d) < 1e-12) {
      if (p0 <= lo || p0 >= hi) return null
      continue
    }
    const u = (lo - p0) / d
    const v = (hi - p0) / d
    t0 = Math.max(t0, Math.min(u, v))
    t1 = Math.min(t1, Math.max(u, v))
  }
  return t0 < t1 ? [t0, t1] : null
}

/** Cut silk polylines where they would print on copper or over a hole, as a fab's silk clip does. */
export function clearOfPads(paths: Vec2[][], pads: PadDef[], gap = SILK_GAP): Vec2[][] {
  const out: Vec2[][] = []
  for (const path of paths) {
    let current: Vec2[] | null = null
    for (let i = 0; i < path.length - 1; i++) {
      const a = path[i]
      const b = path[i + 1]
      const at = (t: number): Vec2 => ({ x: round(a.x + (b.x - a.x) * t), y: round(a.y + (b.y - a.y) * t) })
      const blocked = pads
        .map((pad) => padSpan(a, b, pad, gap))
        .filter((span): span is [number, number] => !!span)
        .sort((p, q) => p[0] - q[0])
      const visible: [number, number][] = []
      let t = 0
      for (const [s0, s1] of blocked) {
        if (s0 > t) visible.push([t, Math.min(s0, 1)])
        t = Math.max(t, s1)
        if (t >= 1) break
      }
      if (t < 1) visible.push([t, 1])
      if (!visible.length) current = null
      for (const [u0, u1] of visible) {
        if (u1 - u0 < 1e-6) continue
        if (u0 > 1e-6 || !current) {
          current = [at(u0)]
          out.push(current)
        }
        current.push(at(u1))
        if (u1 < 1 - 1e-6) current = null
      }
    }
  }
  return out
}

/** A footprint whose silk is clipped clear of its pads and whose courtyard defaults to the body plus 0.25 mm. */
export function footprint(name: string, pads: PadDef[], silk: Vec2[][], courtyard: Box): FootprintDef {
  return { name, pads, silk: clearOfPads(silk, pads), courtyard }
}

/** Two rows of through-hole pins numbered like a DIP: down the left from the top, then up the right. */
export function dualRow(opts: { n: number; rowX: number; pitch: number; size: number; drill: number; topY?: number }): PadDef[] {
  const { n, rowX, pitch, size, drill } = opts
  const top = opts.topY ?? ((n - 1) / 2) * pitch
  const pads: PadDef[] = []
  for (let i = 0; i < n; i++) pads.push(tht(String(i + 1), -rowX, top - i * pitch, size, drill, i === 0))
  for (let i = 0; i < n; i++) pads.push(tht(String(2 * n - i), rowX, top - i * pitch, size, drill))
  return pads
}
