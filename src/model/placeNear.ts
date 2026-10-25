import { emptyBox, expandBox, transformBox, transformPoint, type Box } from "../lib/geometry"
import { padGap } from "./decoupling"
import { getFootprint } from "./footprints"
import { findPart } from "./library"
import type { ComponentInstance, PcbSide, Rotation, Vec2 } from "./types"

// Where to put one part so that chosen pins of it sit beside chosen pads: the search behind the
// copilot's place_parts and the auto-placer's power stages. It is the decoupling capacitor search
// of autoplace.ts made general: any part, several pins to keep close, and a penalty hook.

/** One pin of the part being placed, with the pads it should sit beside. */
export interface NearAnchor {
  /** The part's own pin, by number. */
  pin: string
  /** Pads in board coordinates; the gap is measured to the nearest of them. */
  targets: PadLike[]
  /** How much each millimetre of this gap costs; the first anchor decides where the search looks. */
  weight: number
}

export interface PadLike {
  shape: "rect" | "circle" | "pill" | "polygon"
  x: number
  y: number
  width: number
  height: number
}

export interface NearSpot {
  x: number
  y: number
  rot: number
  side: PcbSide
  /** Courtyard where it lands. */
  box: Box
  /** Edge-to-edge gap of each anchor, in the order given (mm). */
  gaps: number[]
  score: number
}

export interface NearOptions {
  side: PcbSide
  /** Rotations to try; all four when absent. */
  rotations?: number[]
  /** Courtyards the part's own may not overlap; callers grow them by the spacing they want. */
  blocked: Box[]
  /** The part's courtyard stays inside this. */
  keepIn?: Box | null
  /** How far from a target pad the first anchor's pad is looked for (mm). */
  reach?: number
  /** Extra cost for the first anchor's pad centre standing at a point (mm of gap). */
  penalty?: (at: Vec2) => number
  /** Penalty when the pin's pad is not farther from the box than the first anchor's (a far end that should point away). */
  away?: { pin: string; from: Box; cost?: number }
}

const STEP = 0.1
const DEFAULT_REACH = 6

const inflate = (b: Box, d: number): Box => ({ minX: b.minX - d, minY: b.minY - d, maxX: b.maxX + d, maxY: b.maxY + d })
const overlapsAt = (a: Box, x: number, y: number, b: Box) =>
  a.minX + x < b.maxX - 1e-9 && a.maxX + x > b.minX + 1e-9 && a.minY + y < b.maxY - 1e-9 && a.maxY + y > b.minY + 1e-9
const boxDistance = (b: Box, x: number, y: number) => {
  const dx = Math.max(b.minX - x, x - b.maxX, 0)
  const dy = Math.max(b.minY - y, y - b.maxY, 0)
  return Math.hypot(dx, dy)
}
const round3 = (n: number) => Math.round(n * 1000) / 1000 + 0

/** Every offset in whole steps out to `steps`, ring by ring outward. */
function rings(steps: number) {
  const i: number[] = []
  const j: number[] = []
  const start: number[] = []
  for (let r = 0; r <= steps; r++) {
    start.push(i.length)
    for (let a = -r; a <= r; a++) {
      for (let b = -r; b <= r; b += Math.abs(a) === r || r === 0 ? 1 : 2 * r) {
        i.push(a)
        j.push(b)
      }
    }
  }
  start.push(i.length)
  return { i, j, start }
}
const ringCache = new Map<number, ReturnType<typeof rings>>()
const ringsFor = (steps: number) => {
  let r = ringCache.get(steps)
  if (!r) ringCache.set(steps, (r = rings(steps)))
  return r
}

interface LocalPad {
  shape: PadLike["shape"]
  dx: number
  dy: number
  width: number
  height: number
}

/**
 * The best spot for `part` (its position and rotation are ignored) with every anchor's pin close to
 * its pads, clear of `blocked`, inside `keepIn`. Cost is the weighted sum of the anchors' gaps plus
 * a little for distance from the first target and the callers' penalty. Null when nothing within
 * reach is free.
 */
export function findNearSpot(part: ComponentInstance, anchors: NearAnchor[], opts: NearOptions): NearSpot | null {
  const def = findPart(part.partId)
  if (!def || !anchors.length || !anchors[0].targets.length) return null
  const fp = getFootprint(part.footprint)
  const padsOf = (pin: string) => fp.pads.filter((p) => p.pin !== null && (def.padAlias?.[p.pin] ?? p.pin) === pin)
  const mirror = opts.side === "bottom"
  const reach = opts.reach ?? DEFAULT_REACH
  const steps = Math.round(reach / STEP)
  const ring = ringsFor(steps)
  const farPads = opts.away ? padsOf(opts.away.pin) : []
  let best: NearSpot | null = null

  for (const rot of opts.rotations ?? ([0, 90, 180, 270] as Rotation[])) {
    const swap = rot === 90 || rot === 270
    const local = (pin: string): LocalPad[] =>
      padsOf(pin).map((p) => {
        const o = transformPoint(p, { x: 0, y: 0 }, rot, mirror)
        return { shape: p.shape, dx: o.x, dy: o.y, width: swap ? p.height : p.width, height: swap ? p.width : p.height }
      })
    const mine = anchors.map((a) => local(a.pin))
    if (mine.some((l) => !l.length)) continue
    const courtyard = transformBox(fp.courtyard, { x: 0, y: 0 }, rot, mirror)
    const far = farPads.map((p) => transformPoint(p, { x: 0, y: 0 }, rot, mirror))
    const window = emptyBox()
    const [primary] = anchors
    for (const t of primary.targets) expandBox(window, t, reach + Math.hypot(courtyard.maxX - courtyard.minX, courtyard.maxY - courtyard.minY))
    const blocked = opts.blocked.filter((b) => b.minX < window.maxX && b.maxX > window.minX && b.minY < window.maxY && b.maxY > window.minY)

    const gapsAt = (x: number, y: number): number[] =>
      anchors.map((a, k) => {
        let g = Infinity
        for (const lp of mine[k]) {
          const pad = { shape: lp.shape, x: x + lp.dx, y: y + lp.dy, width: lp.width, height: lp.height }
          for (const t of a.targets) g = Math.min(g, padGap(pad, t))
        }
        return g
      })

    for (const lead of mine[0]) {
      const reachOfPads = Math.max(lead.width, lead.height) / 2 + 0.002
      for (const site of primary.targets) {
        const reachPads = reachOfPads + Math.max(site.width, site.height) / 2
        for (let r = 0; r <= steps; r++) {
          const away = r * STEP
          if (best && primary.weight * Math.max(0, away - reachPads) + 0.05 * away >= best.score - 1e-9) break
          for (let k = ring.start[r]; k < ring.start[r + 1]; k++) {
            const cx = site.x + ring.i[k] * STEP
            const cy = site.y + ring.j[k] * STEP
            const x = round3(cx - lead.dx)
            const y = round3(cy - lead.dy)
            const gaps = gapsAt(x, y)
            let score = 0.05 * Math.hypot(ring.i[k], ring.j[k]) * STEP + (opts.penalty?.({ x: cx, y: cy }) ?? 0)
            for (let n = 0; n < gaps.length; n++) score += anchors[n].weight * gaps[n]
            if (best && score >= best.score - 1e-9) continue
            if (far.length && opts.away) {
              const near = Math.min(...mine[0].map((l) => boxDistance(opts.away!.from, x + l.dx, y + l.dy)))
              const out = Math.min(...far.map((f) => boxDistance(opts.away!.from, x + f.x, y + f.y))) - near
              if (out <= 0.2) score += opts.away.cost ?? 3
              if (best && score >= best.score - 1e-9) continue
            }
            let clear = true
            for (let b = 0; clear && b < blocked.length; b++) clear = !overlapsAt(courtyard, x, y, blocked[b])
            if (!clear) continue
            const box = { minX: courtyard.minX + x, maxX: courtyard.maxX + x, minY: courtyard.minY + y, maxY: courtyard.maxY + y }
            if (opts.keepIn && (box.minX < opts.keepIn.minX - 1e-9 || box.maxX > opts.keepIn.maxX + 1e-9 || box.minY < opts.keepIn.minY - 1e-9 || box.maxY > opts.keepIn.maxY + 1e-9)) continue
            best = { x, y, rot, side: opts.side, box, gaps, score }
          }
        }
      }
    }
  }
  return best
}

export { inflate as inflateBox }
