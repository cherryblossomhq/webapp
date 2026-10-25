import { emptyBox, expandBox, round, transformBox, transformPoint, type Box } from "../lib/geometry"
import { mountingHoles } from "./board"
import { computeConnectivity, pinKey } from "./connectivity"
import { decouplingPairs, padGap, type DecouplingPair } from "./decoupling"
import { getFootprint } from "./footprints"
import { isOnBoard, pcbCourtyard, pcbPads, type WorldPad } from "./instances"
import { pointPadDistance, segmentPadDistance } from "./pcb"
import { placeStage, powerStages, STAGE_GAP, type PowerStage } from "./powerStage"
import { stitchVias } from "./stitch"
import type { ComponentInstance, PcbSide, Project, Rotation, Vec2 } from "./types"

// Automatic placement: decoupling capacitors next to the supply pins they serve, then every
// part (a chip with its capacitors as one) shelf-packed on the board.

/** Courtyard to board edge (mm). */
const EDGE_MARGIN = 1.5
/** The tightest spacing between packed parts (mm); boards with room get more. */
const MIN_GAP = 1.2
/**
 * Spacings tried, widest first: the widest that fits every part leaves room to route between
 * them. Wider than 2.5 mm spreads a board out so far that connections get long and cross; on
 * the shipped examples that left the Node-328 with 3 unrouted where 2.5 mm routes it fully.
 */
const GAPS = [2.5, 2.2, 1.9, 1.6, MIN_GAP]
/** A decoupling capacitor's courtyard to any other part's (mm). */
export const CAP_GAP = 0.5
/** How far from its supply pad a capacitor's supply pad is looked for (mm). */
const CAP_REACH = 4
const CAP_STEP = 0.1
/** SMD pads closer than this to a neighbour have their way out kept clear of capacitors. */
const FINE_PITCH = 1
/** Length of that way out, from the pad's outer end (mm). */
const EXIT_LENGTH = 1.2
/** Mounting hole copper to a part's courtyard (mm). */
const HOLE_GAP = 0.5
/** A unit moving to the best spot within this many half-millimetres of where its nets point. */
const SEARCH = 24
/** Up to this many units every pair is tried for a swap; beyond it, each unit tries its nearest NEIGHBOURS. */
const ALL_PAIRS = 48
const NEIGHBOURS = 24
/**
 * Nets with more pins than this (a supply rail across a big board) are left out of the wirelength,
 * as poured nets are: they route as a tree whichever way the parts sit, and moving one part
 * hardly changes their length, but they cost the most to measure.
 */
const HIGH_FANOUT = 24

const ROTATIONS: Rotation[] = [0, 90, 180, 270]

const CAP_STEPS = Math.round(CAP_REACH / CAP_STEP)
/** Every offset in whole steps out to CAP_STEPS, ring by ring outward and in raster order within a ring. */
const RINGS = (() => {
  const i: number[] = []
  const j: number[] = []
  const start: number[] = []
  for (let r = 0; r <= CAP_STEPS; r++) {
    start.push(i.length)
    for (let a = -r; a <= r; a++) {
      for (let b = -r; b <= r; b += Math.abs(a) === r || r === 0 ? 1 : 2 * r) {
        i.push(a)
        j.push(b)
      }
    }
  }
  start.push(i.length)
  return { i, j, start, dist: i.map((a, k) => Math.hypot(a, j[k]) * CAP_STEP) }
})()

const inflate = (b: Box, d: number): Box => ({ minX: b.minX - d, minY: b.minY - d, maxX: b.maxX + d, maxY: b.maxY + d })
const shift = (b: Box, x: number, y: number): Box => ({ minX: b.minX + x, minY: b.minY + y, maxX: b.maxX + x, maxY: b.maxY + y })
/** Overlap with some area in common; boxes that only touch don't overlap. */
const overlaps = (a: Box, b: Box) => a.minX < b.maxX - 1e-9 && a.maxX > b.minX + 1e-9 && a.minY < b.maxY - 1e-9 && a.maxY > b.minY + 1e-9
const inside = (a: Box, outer: Box) => a.minX >= outer.minX - 1e-9 && a.maxX <= outer.maxX + 1e-9 && a.minY >= outer.minY - 1e-9 && a.maxY <= outer.maxY + 1e-9
const boxDistance = (b: Box, x: number, y: number) => {
  const dx = b.minX - x > x - b.maxX ? b.minX - x : x - b.maxX
  const dy = b.minY - y > y - b.maxY ? b.minY - y : y - b.maxY
  const ex = dx > 0 ? dx : 0
  const ey = dy > 0 ? dy : 0
  return Math.sqrt(ex * ex + ey * ey)
}
const boxPointDistance = (b: Box, p: Vec2) => boxDistance(b, p.x, p.y)
/** `a` moved by (x, y) overlaps `b`, as `overlaps(shift(a, x, y), b)` but without making the box. */
const overlapsAt = (a: Box, x: number, y: number, b: Box) =>
  a.minX + x < b.maxX - 1e-9 && a.maxX + x > b.minX + 1e-9 && a.minY + y < b.maxY - 1e-9 && a.maxY + y > b.minY + 1e-9

/** `round(n, 3)` without the power and the negative zero check: it runs in the capacitor search's inner loop. */
const round3 = (n: number) => Math.round(n * 1000) / 1000 + 0

const at = (c: ComponentInstance, x: number, y: number, rot: Rotation = c.pcb.rot, side: PcbSide = c.pcb.side): ComponentInstance => ({
  ...c,
  pcb: { ...c.pcb, x, y, rot, side },
})

/** A part's courtyard around its own origin, turned and flipped as it would be placed. */
function localCourtyard(c: ComponentInstance, rot: Rotation = c.pcb.rot, side: PcbSide = c.pcb.side): Box {
  return transformBox(getFootprint(c.footprint).courtyard, { x: 0, y: 0 }, rot, side === "bottom")
}

/** Parts whose pads touch locked copper, which stays where it is and holds them there. */
function heldByLockedCopper(project: Project, parts: ComponentInstance[]): Set<string> {
  const held = new Set<string>()
  const traces = project.traces.filter((t) => t.locked)
  const vias = project.vias.filter((v) => v.locked)
  if (!traces.length && !vias.length) return held
  // Each locked segment and via with the box its copper fills, so a pad only meets the few near it.
  const segments = traces.flatMap((t) =>
    t.points.slice(1).map((p, i) => {
      const a = t.points[i]
      const half = t.width / 2 + 1e-6
      return { layer: t.layer, a, b: p, half, box: inflate({ minX: Math.min(a.x, p.x), minY: Math.min(a.y, p.y), maxX: Math.max(a.x, p.x), maxY: Math.max(a.y, p.y) }, half) }
    }),
  )
  const viaBoxes = vias.map((v) => ({ v, box: inflate({ minX: v.x, minY: v.y, maxX: v.x, maxY: v.y }, v.diameter / 2 + 1e-6) }))
  for (const c of parts) {
    if (!c.pcb.placed) continue
    const touches = (pad: WorldPad) => {
      const reach = Math.hypot(pad.width, pad.height) / 2 + 1e-6
      const padBox = { minX: pad.x - reach, minY: pad.y - reach, maxX: pad.x + reach, maxY: pad.y + reach }
      return (
        segments.some((s) => pad.layers.includes(s.layer) && overlaps(padBox, s.box) && segmentPadDistance(s.a, s.b, pad) <= s.half) ||
        viaBoxes.some(({ v, box }) => overlaps(padBox, box) && pointPadDistance(v, pad) <= v.diameter / 2 + 1e-6)
      )
    }
    if (pcbPads(c).some(touches)) held.add(c.id)
  }
  return held
}

/** Copper and holes parts may not be placed on: mounting holes and the copper that stays. */
export function boardObstacles(project: Project): Box[] {
  const out: Box[] = []
  for (const h of mountingHoles(project.board)) {
    const r = h.diameter / 2 + HOLE_GAP
    out.push({ minX: h.x - r, minY: h.y - r, maxX: h.x + r, maxY: h.y + r })
  }
  const clearance = project.rules.clearance
  for (const t of project.traces) {
    for (let i = 1; i < t.points.length; i++) {
      const a = t.points[i - 1]
      const b = t.points[i]
      out.push(inflate({ minX: Math.min(a.x, b.x), minY: Math.min(a.y, b.y), maxX: Math.max(a.x, b.x), maxY: Math.max(a.y, b.y) }, t.width / 2 + clearance))
    }
  }
  for (const v of project.vias) out.push(inflate({ minX: v.x, minY: v.y, maxX: v.x, maxY: v.y }, v.diameter / 2 + clearance))
  return out
}

/**
 * The way out of each fine-pitch SMD pad of a chip, straight out from the part along the pad,
 * for pads on nets other than `exempt`. A capacitor parked there would leave the pin with no
 * room to escape, which is what sealed pins in when capacitors were simply put closest.
 */
export function exitCorridors(chip: ComponentInstance, netOf: (pin: string) => string | undefined, exempt: Set<string>): Box[] {
  const pads = pcbPads(chip).filter((p) => p.layers.length === 1)
  if (pads.length < 3) return []
  const cx = pads.reduce((s, p) => s + p.x, 0) / pads.length
  const cy = pads.reduce((s, p) => s + p.y, 0) / pads.length
  const out: Box[] = []
  for (const pad of pads) {
    const net = pad.pin ? netOf(pad.pin) : undefined
    if (!net || exempt.has(net) || Math.abs(pad.width - pad.height) < 0.2) continue
    if (!pads.some((o) => o !== pad && Math.hypot(o.x - pad.x, o.y - pad.y) < FINE_PITCH)) continue
    const alongX = pad.width > pad.height
    const sign = alongX ? Math.sign(pad.x - cx) : Math.sign(pad.y - cy)
    if (!sign) continue
    const half = (alongX ? pad.width : pad.height) / 2
    const across = (alongX ? pad.height : pad.width) / 2
    const a0 = (alongX ? pad.x : pad.y) + sign * half
    const a1 = a0 + sign * EXIT_LENGTH
    out.push(
      alongX
        ? { minX: Math.min(a0, a1), maxX: Math.max(a0, a1), minY: pad.y - across, maxY: pad.y + across }
        : { minX: pad.x - across, maxX: pad.x + across, minY: Math.min(a0, a1), maxY: Math.max(a0, a1) },
    )
  }
  return out
}

export interface CapSpot {
  x: number
  y: number
  rot: Rotation
  side: PcbSide
  /** Courtyard where it lands. */
  box: Box
  /** Supply pad to the nearest supply pad of the chip, edge to edge (mm). */
  gap: number
  score: number
}

/**
 * The best place for a decoupling capacitor beside its chip, as the chip is placed: on the
 * chip's side of the board, turned whichever way puts its supply pad nearest a supply pad of
 * the chip with its ground pad facing away, CAP_GAP clear of the chip and of `blocked`, out
 * of the chip's fine-pitch pin exits and inside `keepIn`. Null when nothing within CAP_REACH fits.
 */
export function bestCapSpot(
  cap: ComponentInstance,
  pair: DecouplingPair,
  chip: ComponentInstance,
  opts: { blocked: Box[]; corridors: Box[]; keepIn?: Box | null; crowding?: (pad: WorldPad) => number },
): CapSpot | null {
  const fp = getFootprint(cap.footprint)
  const railDef = fp.pads.find((p) => p.pin === pair.capSupplyPin)
  const gndDef = fp.pads.find((p) => p.pin === pair.capGroundPin)
  const chipBox = pcbCourtyard(chip)
  if (!railDef || !gndDef || !chipBox) return null
  const supply = new Set(pair.supplyPins)
  const sites = pcbPads(chip).filter((p) => p.pin !== null && supply.has(p.pin))
  if (!sites.length) return null
  const side = chip.pcb.side
  const mirror = side === "bottom"
  // Only what the search can reach: the supply pads, CAP_REACH and the capacitor's size around them.
  const reach = CAP_REACH + Math.hypot(fp.courtyard.maxX - fp.courtyard.minX, fp.courtyard.maxY - fp.courtyard.minY)
  const window = emptyBox()
  for (const s of sites) expandBox(window, s, reach)
  const blocked = [inflate(chipBox, CAP_GAP), ...opts.corridors, ...opts.blocked].filter((b) => overlaps(b, window))
  let best: CapSpot | null = null
  for (const rot of ROTATIONS) {
    const rail = transformPoint(railDef, { x: 0, y: 0 }, rot, mirror)
    const gnd = transformPoint(gndDef, { x: 0, y: 0 }, rot, mirror)
    const swap = rot === 90 || rot === 270
    const railPad = { shape: railDef.shape, x: 0, y: 0, width: swap ? railDef.height : railDef.width, height: swap ? railDef.width : railDef.height }
    const courtyard = transformBox(fp.courtyard, { x: 0, y: 0 }, rot, mirror)
    const chipClear = inflate(chipBox, CAP_GAP)
    for (const site of sites) {
      const crowd = opts.crowding?.(site) ?? 0
      // How far two pads' centres can be while their edges touch; the gap is at least the
      // distance beyond that, which bounds what a ring of candidates farther out can score.
      const reachOfPads = (Math.max(railPad.width, railPad.height) + Math.max(site.width, site.height)) / 2 + 0.002
      // padGap spelled out for the usual pairs, a box facing a box or a round pad, which this loop runs most.
      const boxRail = railPad.shape !== "circle"
      const roundSite = site.shape === "circle"
      const halfW = roundSite ? railPad.width / 2 : (railPad.width + site.width) / 2
      const halfH = roundSite ? railPad.height / 2 : (railPad.height + site.height) / 2
      const siteRadius = roundSite ? site.width / 2 : 0
      // The offsets, in steps from the site, at which the capacitor is certainly inside the chip's own
      // clearance: most of the window on a big chip, skipped without any arithmetic.
      const inChip = {
        i0: (chipClear.minX - courtyard.maxX + rail.x - site.x) / CAP_STEP + 0.05,
        i1: (chipClear.maxX - courtyard.minX + rail.x - site.x) / CAP_STEP - 0.05,
        j0: (chipClear.minY - courtyard.maxY + rail.y - site.y) / CAP_STEP + 0.05,
        j1: (chipClear.maxY - courtyard.minY + rail.y - site.y) / CAP_STEP - 0.05,
      }
      // Rings of candidates outward from the site, so a good spot found near it ends the search.
      for (let r = 0; r <= CAP_STEPS; r++) {
        const away = r * CAP_STEP
        if (best && Math.max(0, away - reachOfPads) + 0.1 * away + crowd >= best.score - 1e-9) break
        for (let k = RINGS.start[r]; k < RINGS.start[r + 1]; k++) {
          const ci = RINGS.i[k]
          const cj = RINGS.j[k]
          if (ci > inChip.i0 && ci < inChip.i1 && cj > inChip.j0 && cj < inChip.j1) continue
          const dx = ci * CAP_STEP
          const dy = cj * CAP_STEP
          const rx = site.x + dx
          const ry = site.y + dy
          railPad.x = rx
          railPad.y = ry
          const gx = Math.abs(dx) - halfW
          const gy = Math.abs(dy) - halfH
          const gap = boxRail ? Math.max(0, Math.sqrt((gx > 0 ? gx * gx : 0) + (gy > 0 ? gy * gy : 0)) - siteRadius) : padGap(railPad, site)
          const near = gap + crowd + 0.1 * RINGS.dist[k]
          if (best && near >= best.score - 1e-9) continue
          const x = round3(rx - rail.x)
          const y = round3(ry - rail.y)
          let clear = true
          for (let b = 0; clear && b < blocked.length; b++) clear = !overlapsAt(courtyard, x, y, blocked[b])
          if (!clear) continue
          // Ground pad farther from the chip than the supply pad: its own way to ground is outwards.
          const out = boxDistance(chipBox, x + gnd.x, y + gnd.y) - boxDistance(chipBox, rx, ry)
          const score = near + (out > 0.2 ? 0 : 3)
          if (best && score >= best.score - 1e-9) continue
          const box = shift(courtyard, x, y)
          if (opts.keepIn && !inside(box, opts.keepIn)) continue
          best = { x, y, rot, side, box, gap: 0, score }
        }
      }
    }
  }
  if (!best) return null
  // Reported against the nearest of the supply pads, whichever one the search started from.
  const swapped = best.rot === 90 || best.rot === 270
  const placedPad = {
    shape: railDef.shape,
    ...transformPoint(railDef, best, best.rot, mirror),
    width: swapped ? railDef.height : railDef.width,
    height: swapped ? railDef.width : railDef.height,
  }
  best.gap = Math.min(...sites.map((s) => padGap(placedPad, s)))
  return best
}

/** Parts placed together, relative to the unit's origin. */
interface Unit {
  members: { c: ComponentInstance; x: number; y: number; rot: Rotation; side: PcbSide }[]
  /** Union of the members' courtyards around the origin. */
  box: Box
}

function unitBox(members: Unit["members"]): Box {
  const box = emptyBox()
  for (const m of members) {
    const b = shift(localCourtyard(m.c, m.rot, m.side), m.x, m.y)
    expandBox(box, { x: b.minX, y: b.minY })
    expandBox(box, { x: b.maxX, y: b.maxY })
  }
  return box
}

/**
 * Rows from the top left, `gap` from other parts; a part that no row has room for left takes the
 * first free spot scanning down from the top. `keepouts` already carry their own clearance.
 * Returns each unit's origin, and the units that didn't fit.
 */
function shelfPack(
  units: Unit[],
  area: Box,
  parts: Box[],
  keepouts: Box[],
  gap: number,
): { origins: Map<Unit, Vec2>; overflow: Unit[] } {
  const taken = [...parts.map((b) => inflate(b, gap)), ...keepouts]
  const origins = new Map<Unit, Vec2>()
  const overflow: Unit[] = []
  const blocker = (box: Box) => taken.find((o) => overlaps(box, o))
  const put = (u: Unit, x: number, y: number) => {
    origins.set(u, { x: x - u.box.minX, y: y - u.box.maxY })
    taken.push(inflate({ minX: x, maxX: x + u.box.maxX - u.box.minX, minY: y - (u.box.maxY - u.box.minY), maxY: y }, gap))
  }
  let x = area.minX
  let y = area.maxY
  let rowH = 0
  const left: Unit[] = []
  for (const u of units) {
    const w = u.box.maxX - u.box.minX
    const h = u.box.maxY - u.box.minY
    let placed = false
    while (!placed) {
      if (x + w > area.maxX + 1e-9) {
        x = area.minX
        y -= rowH > 0 ? rowH + gap : 0.5
        rowH = 0
      }
      if (y - h < area.minY - 1e-9) break
      const hit = blocker({ minX: x, maxX: x + w, minY: y - h, maxY: y })
      if (hit) {
        x = Math.max(x + 0.1, hit.maxX)
        continue
      }
      put(u, x, y)
      x += w + gap
      rowH = Math.max(rowH, h)
      placed = true
    }
    if (!placed) left.push(u)
  }
  // Rows leave room beside tall parts and fixed ones; scan for it.
  for (const u of left) {
    const w = u.box.maxX - u.box.minX
    const h = u.box.maxY - u.box.minY
    let placed = false
    for (let top = area.maxY; !placed && top - h >= area.minY - 1e-9; top -= 0.5) {
      for (let lx = area.minX; lx + w <= area.maxX + 1e-9; ) {
        const hit = blocker({ minX: lx, maxX: lx + w, minY: top - h, maxY: top })
        if (!hit) {
          put(u, lx, top)
          placed = true
          break
        }
        lx = Math.max(lx + 0.1, hit.maxX)
      }
    }
    if (!placed) overflow.push(u)
  }
  return { origins, overflow }
}

interface NetPins {
  /** Pads of parts that stay where they are. */
  fixed: Vec2[]
  /** Pads of units being placed, relative to the unit's origin. */
  moving: { unit: number; x: number; y: number }[]
}

/** Boxes by grid cell, so "what is near here" doesn't mean looking at every box on the board. */
class BoxGrid {
  private cells = new Map<number, number[]>()
  constructor(private size = 8) {}
  private key(cx: number, cy: number) {
    return (cx + 32768) * 65536 + cy + 32768
  }
  add(id: number, b: Box) {
    const s = this.size
    for (let cx = Math.floor(b.minX / s); cx <= Math.floor(b.maxX / s); cx++) {
      for (let cy = Math.floor(b.minY / s); cy <= Math.floor(b.maxY / s); cy++) {
        const list = this.cells.get(this.key(cx, cy))
        if (list) list.push(id)
        else this.cells.set(this.key(cx, cy), [id])
      }
    }
  }
  remove(id: number, b: Box) {
    const s = this.size
    for (let cx = Math.floor(b.minX / s); cx <= Math.floor(b.maxX / s); cx++) {
      for (let cy = Math.floor(b.minY / s); cy <= Math.floor(b.maxY / s); cy++) {
        const list = this.cells.get(this.key(cx, cy))
        const at = list ? list.indexOf(id) : -1
        if (list && at >= 0) list.splice(at, 1)
      }
    }
  }
  /** Calls `visit` with the ids in the cells `b` touches, until it returns true; an id can come up more than once. */
  some(b: Box, visit: (id: number) => boolean | void): boolean {
    const s = this.size
    for (let cx = Math.floor(b.minX / s); cx <= Math.floor(b.maxX / s); cx++) {
      for (let cy = Math.floor(b.minY / s); cy <= Math.floor(b.maxY / s); cy++) {
        const list = this.cells.get(this.key(cx, cy))
        if (list) for (let i = 0; i < list.length; i++) if (visit(list[i])) return true
      }
    }
    return false
  }
}

/**
 * Shorten the wiring by moving whole units: each to the free spot that best suits what it
 * connects to, then pairs of units swapped, keeping `gap` from other parts. A move is kept only
 * when the nets' total half-perimeter length goes down, which is what makes a board quicker
 * and surer to route: fewer long connections crossing each other.
 */
function improvePlacement(
  units: Unit[],
  origins: Map<Unit, Vec2>,
  nets: NetPins[],
  bounds: { area: Box; parts: Box[]; keepouts: Box[]; gap: number },
) {
  const placed = units.filter((u) => origins.has(u))
  const index = new Map(placed.map((u, i) => [u, i]))
  const pos = placed.map((u) => ({ ...origins.get(u)! }))
  const netsOf = placed.map(() => [] as number[])
  const live = nets
    .map((n) => ({ fixed: n.fixed, moving: n.moving.filter((m) => index.has(units[m.unit])).map((m) => ({ ...m, unit: index.get(units[m.unit])! })) }))
    .filter((n) => new Set(n.moving.map((m) => m.unit)).size + (n.fixed.length ? 1 : 0) >= 2 && n.fixed.length + n.moving.length <= HIGH_FANOUT)
  live.forEach((n, k) => {
    for (const u of new Set(n.moving.map((m) => m.unit))) netsOf[u].push(k)
  })
  const length = (k: number) => {
    const n = live[k]
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    const take = (x: number, y: number) => {
      minX = Math.min(minX, x)
      maxX = Math.max(maxX, x)
      minY = Math.min(minY, y)
      maxY = Math.max(maxY, y)
    }
    for (const f of n.fixed) take(f.x, f.y)
    for (const m of n.moving) take(pos[m.unit].x + m.x, pos[m.unit].y + m.y)
    return maxX - minX + (maxY - minY)
  }
  const cost = (ks: Iterable<number>) => {
    let sum = 0
    for (const k of ks) sum += length(k)
    return sum
  }
  // Parts that stay and keepouts never move; units do, so the grid follows them.
  const statics = [...bounds.parts.map((b) => inflate(b, bounds.gap)), ...bounds.keepouts]
  const staticGrid = new BoxGrid()
  statics.forEach((b, i) => staticGrid.add(i, b))
  const unitGrid = new BoxGrid()
  const boxAt = (u: number, o: Vec2) => shift(placed[u].box, o.x, o.y)
  const indexed = placed.map((_, u) => boxAt(u, pos[u]))
  indexed.forEach((b, u) => unitGrid.add(u, b))
  /** Record that unit `u` now stands at `pos[u]`. */
  const moved = (u: number) => {
    unitGrid.remove(u, indexed[u])
    indexed[u] = boxAt(u, pos[u])
    unitGrid.add(u, indexed[u])
  }
  const legal = (u: number, o: Vec2, skip: number) => {
    const box = boxAt(u, o)
    if (!inside(box, bounds.area)) return false
    if (staticGrid.some(box, (i) => overlaps(box, statics[i]))) return false
    const grown = inflate(box, bounds.gap)
    return !unitGrid.some(grown, (v) => v !== u && v !== skip && overlaps(grown, indexed[v]))
  }
  const snap = (n: number) => round(Math.round(n / 0.05) * 0.05, 2)

  /** Units this one might trade places with: all of them on a small board, else the nearest few. */
  const partners = (u: number): number[] => {
    if (placed.length <= ALL_PAIRS) return placed.map((_, v) => v).filter((v) => v > u)
    const bu = indexed[u]
    const near: { v: number; d: number }[] = []
    for (let v = 0; v < placed.length; v++) {
      if (v === u) continue
      const bv = indexed[v]
      const dx = (bv.minX + bv.maxX - bu.minX - bu.maxX) / 2
      const dy = (bv.minY + bv.maxY - bu.minY - bu.maxY) / 2
      const d = dx * dx + dy * dy
      if (near.length === NEIGHBOURS && d >= near[NEIGHBOURS - 1].d) continue
      let at = near.length
      while (at > 0 && near[at - 1].d > d) at--
      near.splice(at, 0, { v, d })
      if (near.length > NEIGHBOURS) near.pop()
    }
    return near.map((e) => e.v)
  }

  for (let pass = 0; pass < 6; pass++) {
    let gained = 0
    // Each unit towards what it connects to.
    for (let u = 0; u < placed.length; u++) {
      const ks = netsOf[u]
      if (!ks.length) continue
      // Per net, the box of every pin but this unit's, and this unit's own pins. A net's length is
      // its box's width plus its height, so the cost of an offset is a sum over x and one over y.
      const nets = ks.map((k) => {
        const rest = emptyBox()
        const own = emptyBox()
        for (const f of live[k].fixed) expandBox(rest, f)
        for (const m of live[k].moving) {
          if (m.unit === u) expandBox(own, m)
          else expandBox(rest, { x: pos[m.unit].x + m.x, y: pos[m.unit].y + m.y })
        }
        return { rest, own }
      })
      const lengthX = (ox: number) => nets.reduce((sum, n) => sum + Math.max(n.rest.maxX, n.own.maxX + ox) - Math.min(n.rest.minX, n.own.minX + ox), 0)
      const lengthY = (oy: number) => nets.reduce((sum, n) => sum + Math.max(n.rest.maxY, n.own.maxY + oy) - Math.min(n.rest.minY, n.own.minY + oy), 0)
      // Where its pins would sit best: the middle of each net's other pins, averaged.
      let tx = 0
      let ty = 0
      let count = 0
      for (const n of nets) {
        if (!Number.isFinite(n.rest.minX)) continue
        tx += (n.rest.minX + n.rest.maxX) / 2
        ty += (n.rest.minY + n.rest.maxY) / 2
        count++
      }
      if (!count) continue
      let ownX = 0
      let ownY = 0
      let ownCount = 0
      for (const k of ks) {
        for (const m of live[k].moving) {
          if (m.unit !== u) continue
          ownX += m.x
          ownY += m.y
          ownCount++
        }
      }
      const cx = tx / count - ownX / ownCount
      const cy = ty / count - ownY / ownCount
      const start = pos[u]
      const before = lengthX(start.x) + lengthY(start.y)
      const xs: number[] = []
      const ys: number[] = []
      const costX: number[] = []
      const costY: number[] = []
      for (let i = -SEARCH; i <= SEARCH; i++) {
        xs.push(snap(cx + i * 0.5))
        ys.push(snap(cy + i * 0.5))
        costX.push(lengthX(xs[xs.length - 1]))
        costY.push(lengthY(ys[ys.length - 1]))
      }
      // Which offsets the unit has room at: every box near it blocks a rectangle of them.
      const side = 2 * SEARCH + 1
      const taken = new Uint8Array(side * side)
      const box = placed[u].box
      // The first index of the increasing `arr` whose value is above `t` (or at least `t`). The values
      // are a half-millimetre apart, give or take the snap, so a guess is nearly right.
      const first = (arr: number[], t: number, orEqual: boolean) => {
        let g = Math.min(Math.max(Math.floor((t - arr[0]) / 0.5), 0), arr.length)
        const past = (v: number) => (orEqual ? v >= t : v > t)
        while (g > 0 && past(arr[g - 1])) g--
        while (g < arr.length && !past(arr[g])) g++
        return g
      }
      const block = (o: Box, grow: number) => {
        const i0 = first(xs, o.minX + 1e-9 - box.maxX - grow, false)
        const i1 = first(xs, o.maxX - 1e-9 - box.minX + grow, true)
        const j0 = first(ys, o.minY + 1e-9 - box.maxY - grow, false)
        const j1 = first(ys, o.maxY - 1e-9 - box.minY + grow, true)
        for (let i = i0; i < i1; i++) taken.fill(1, i * side + j0, i * side + Math.max(j0, j1))
      }
      const window: Box = { minX: xs[0] + box.minX - bounds.gap, maxX: xs[side - 1] + box.maxX + bounds.gap, minY: ys[0] + box.minY - bounds.gap, maxY: ys[side - 1] + box.maxY + bounds.gap }
      const seenStatic = new Set<number>()
      staticGrid.some(window, (i) => {
        if (!seenStatic.has(i)) block(statics[i], 0)
        seenStatic.add(i)
      })
      const seenUnit = new Set<number>([u])
      unitGrid.some(window, (v) => {
        if (!seenUnit.has(v)) block(indexed[v], bounds.gap)
        seenUnit.add(v)
      })
      // And the board: its edge blocks everything the unit would stick out at.
      const area = bounds.area
      const ia0 = first(xs, area.minX - 1e-9 - box.minX, true)
      const ia1 = first(xs, area.maxX + 1e-9 - box.maxX, false)
      const ja0 = first(ys, area.minY - 1e-9 - box.minY, true)
      const ja1 = first(ys, area.maxY + 1e-9 - box.maxY, false)
      for (let i = 0; i < side; i++) {
        if (i < ia0 || i >= ia1) taken.fill(1, i * side, (i + 1) * side)
        else {
          taken.fill(1, i * side, i * side + ja0)
          taken.fill(1, i * side + Math.max(ja0, ja1), (i + 1) * side)
        }
      }
      // Spots in rings outward from the target; the cheapest with room, the nearest the target among equals.
      let best = { o: start, c: before - 0.05 }
      for (let r = 0; r <= SEARCH; r++) {
        for (let i = -r; i <= r; i++) {
          for (let j = -r; j <= r; j += Math.abs(i) === r || r === 0 ? 1 : 2 * r) {
            const c = costX[i + SEARCH] + costY[j + SEARCH]
            if (c < best.c - 1e-6 && !taken[(i + SEARCH) * side + j + SEARCH]) best = { o: { x: xs[i + SEARCH], y: ys[j + SEARCH] }, c }
          }
        }
      }
      // The same test the swaps use, in case a spot sat right on a box's edge.
      if (best.o !== start && !legal(u, best.o, -1)) best = { o: start, c: before }
      if (best.o !== start) {
        pos[u] = best.o
        moved(u)
        gained += before - best.c
      }
    }
    // Pairs of units trading places.
    for (let u = 0; u < placed.length; u++) {
      for (const v of partners(u)) {
        const ks = [...new Set([...netsOf[u], ...netsOf[v]])]
        if (!ks.length) continue
        const bu = boxAt(u, pos[u])
        const bv = boxAt(v, pos[v])
        const ou = { x: snap(pos[u].x + (bv.minX + bv.maxX - bu.minX - bu.maxX) / 2), y: snap(pos[u].y + (bv.minY + bv.maxY - bu.minY - bu.maxY) / 2) }
        const ov = { x: snap(pos[v].x + (bu.minX + bu.maxX - bv.minX - bv.maxX) / 2), y: snap(pos[v].y + (bu.minY + bu.maxY - bv.minY - bv.maxY) / 2) }
        const before = cost(ks)
        const [su, sv] = [pos[u], pos[v]]
        pos[u] = ou
        pos[v] = ov
        const after = cost(ks)
        const ok = after < before - 0.05 && legal(u, ou, v) && legal(v, ov, u) && !overlaps(inflate(boxAt(u, ou), bounds.gap), boxAt(v, ov))
        if (ok) {
          gained += before - after
          moved(u)
          moved(v)
        } else {
          pos[u] = su
          pos[v] = sv
        }
      }
    }
    if (gained < 0.5) break
  }
  placed.forEach((u, i) => origins.set(u, pos[i]))
}

/**
 * Place every physical part that is not on the board yet; with `all`, re-pack the whole board
 * instead. Re-packing starts the layout over: copper that isn't locked is cleared, since it would
 * no longer reach the pads it was routed to, and that includes pour stitching vias, which
 * `repackPcb` puts back. Parts that are locked, or that locked copper is routed to, stay where
 * they are, and parts already placed are never moved otherwise.
 *
 * Each chip's decoupling capacitors go beside the supply pins they serve first; a chip being
 * placed then moves with its capacitors as one block. A switching regulator or an LDO takes its
 * whole power stage along the same way (`model/powerStage.ts`); `powerStage: false` leaves that
 * out, which is how the measurements compare against placement without it.
 */
export function autoPlacePcb(project: Project, all = false, options: { powerStage?: boolean } = {}): Project {
  const physical = project.components.filter((c) => isOnBoard(c) && !!c.footprint)
  const held = all ? heldByLockedCopper(project, physical) : new Set<string>()
  // A part that isn't on the board yet is placed even if it is locked: a lock keeps a part where it
  // is, and a pasted copy of a locked part is nowhere. (Pasting clears the lock too.)
  const movable = physical.filter((c) => (all || !c.pcb.placed) && (!c.pcb.locked || !c.pcb.placed) && !held.has(c.id))
  if (!movable.length) return project
  const base: Project = all ? { ...project, traces: project.traces.filter((t) => t.locked), vias: project.vias.filter((v) => v.locked) } : project
  const moving = new Set(movable.map((c) => c.id))
  const fixed = physical.filter((c) => !moving.has(c.id) && c.pcb.placed)

  const b = base.board
  const area: Box = {
    minX: b.x - b.width / 2 + EDGE_MARGIN,
    maxX: b.x + b.width / 2 - EDGE_MARGIN,
    minY: b.y - b.height / 2 + EDGE_MARGIN,
    maxY: b.y + b.height / 2 - EDGE_MARGIN,
  }
  // Parts that stay, and the holes and copper that do; capacitors keep CAP_GAP from all of them.
  const occupied: { box: Box; owner: string | null }[] = fixed.map((c) => ({ box: pcbCourtyard(c)!, owner: c.id }))
  const keepouts = boardObstacles(base)

  const sch = computeConnectivity(base)
  const byId = new Map(base.components.map((c) => [c.id, c]))
  const capsOf = new Map<string, DecouplingPair[]>()
  // A power stage places its own capacitors, whatever their value, so decoupling leaves them out.
  const stageOf = new Map<string, PowerStage>()
  const inStage = new Set<string>()
  const pairs = decouplingPairs(base, sch)
  if (options.powerStage !== false) {
    for (const stage of powerStages(base, sch, pairs, new Set(fixed.map((c) => c.id)))) {
      stageOf.set(stage.chipId, stage)
      for (const s of stage.sats) inStage.add(s.id)
    }
  }
  for (const pair of pairs) {
    const chip = byId.get(pair.chipId)
    if (inStage.has(pair.capId)) continue
    if (!moving.has(pair.capId) || !chip || !isOnBoard(chip)) continue
    if (!moving.has(chip.id) && !chip.pcb.placed) continue
    capsOf.set(chip.id, [...(capsOf.get(chip.id) ?? []), pair])
  }
  const byRef = (a: DecouplingPair, c: DecouplingPair) => byId.get(a.capId)!.ref.localeCompare(byId.get(c.capId)!.ref, undefined, { numeric: true })

  const positions = new Map<string, { x: number; y: number; rot: Rotation; side: PcbSide }>()
  const grouped = new Set<string>()

  /** Capacitors around a chip as it stands; returns where each went. */
  const surround = (chip: ComponentInstance, pairs: DecouplingPair[], blocked: { box: Box; owner: string | null }[], keepIn: Box | null) => {
    const placed: { pair: DecouplingPair; spot: CapSpot }[] = []
    for (const pair of [...pairs].sort(byRef)) {
      const cap = byId.get(pair.capId)!
      const corridors = exitCorridors(chip, (pin) => sch.pinNet.get(pinKey(chip.id, pin)), new Set([pair.netId]))
      const others = [
        ...blocked.filter((o) => o.owner !== chip.id).map((o) => inflate(o.box, CAP_GAP)),
        ...placed.map((p) => inflate(p.spot.box, CAP_GAP)),
      ]
      // Spread a chip's capacitors over its supply pins before doubling up on one.
      const crowding = (pad: WorldPad) =>
        0.6 * placed.filter((p) => p.pair.netId === pair.netId && boxPointDistance(p.spot.box, pad) < 2.5).length
      const spot = bestCapSpot(cap, pair, chip, { blocked: others, corridors, keepIn, crowding })
      if (spot) placed.push({ pair, spot })
    }
    return placed
  }

  /** A chip's power stage around it as it stands, if it has one; returns where each part went. */
  const surroundStage = (chip: ComponentInstance, blocked: { box: Box; owner: string | null }[], keepIn: Box | null) => {
    const stage = stageOf.get(chip.id)
    if (!stage) return []
    return placeStage(
      stage,
      {
        chip,
        byId,
        blocked: blocked.filter((o) => o.owner !== chip.id).map((o) => inflate(o.box, STAGE_GAP)),
        corridors: (exempt) => exitCorridors(chip, (pin) => sch.pinNet.get(pinKey(chip.id, pin)), exempt),
        netOf: (id, pin) => sch.pinNet.get(pinKey(id, pin)),
        keepIn,
      },
      (id) => moving.has(id),
    )
  }

  // The power stages and capacitors of chips that stay put go beside them where the board has room.
  for (const chip of fixed) {
    const pairs = capsOf.get(chip.id)
    for (const { id, spot } of surroundStage(chip, [...occupied, ...keepouts.map((box) => ({ box, owner: null }))], area)) {
      positions.set(id, { x: spot.x, y: spot.y, rot: spot.rot, side: spot.side })
      occupied.push({ box: spot.box, owner: id })
      grouped.add(id)
    }
    if (!pairs) continue
    for (const { pair, spot } of surround(chip, pairs, [...occupied, ...keepouts.map((box) => ({ box, owner: null }))], area)) {
      positions.set(pair.capId, { x: spot.x, y: spot.y, rot: spot.rot, side: spot.side })
      occupied.push({ box: spot.box, owner: pair.capId })
      grouped.add(pair.capId)
    }
  }

  // Chips being placed take their power stage and capacitors along as one unit.
  const units: Unit[] = []
  const solo = (c: ComponentInstance): Unit["members"][number] => ({ c, x: 0, y: 0, rot: c.pcb.rot, side: c.pcb.side })
  for (const c of movable) {
    const pairs = capsOf.get(c.id)
    if (!pairs && !stageOf.has(c.id)) continue
    const members = [solo(c)]
    const stage = surroundStage(at(c, 0, 0), [], null)
    for (const { id, spot } of stage) {
      members.push({ c: byId.get(id)!, x: spot.x, y: spot.y, rot: spot.rot, side: spot.side })
      grouped.add(id)
    }
    const around = stage.map((p) => ({ box: p.spot.box, owner: p.id }))
    for (const { pair, spot } of surround(at(c, 0, 0), pairs ?? [], around, null)) {
      members.push({ c: byId.get(pair.capId)!, x: spot.x, y: spot.y, rot: spot.rot, side: spot.side })
      grouped.add(pair.capId)
    }
    grouped.add(c.id)
    units.push({ members, box: unitBox(members) })
  }
  for (const c of movable) if (!grouped.has(c.id)) units.push({ members: [solo(c)], box: unitBox([solo(c)]) })
  const size = (u: Unit) => (u.box.maxX - u.box.minX) * (u.box.maxY - u.box.minY)
  const loose = units.sort((p, q) => size(q) - size(p))

  const taken = occupied.map((o) => o.box)
  let packed!: ReturnType<typeof shelfPack>
  let gap = MIN_GAP
  for (gap of GAPS) {
    packed = shelfPack(loose, area, taken, keepouts, gap)
    if (!packed.overflow.length) break
  }

  // A fresh layout is centred on the board rather than hugging its top-left corner.
  const fresh = !fixed.length && packed.overflow.length === 0
  if (fresh && loose.length) {
    const block = emptyBox()
    for (const [u, o] of packed.origins) {
      expandBox(block, { x: o.x + u.box.minX, y: o.y + u.box.minY })
      expandBox(block, { x: o.x + u.box.maxX, y: o.y + u.box.maxY })
    }
    const dx = round(Math.round((b.x - (block.minX + block.maxX) / 2) / 0.25) * 0.25, 2)
    const dy = round(Math.round((b.y - (block.minY + block.maxY) / 2) / 0.25) * 0.25, 2)
    const moved = [...packed.origins].map(([u, o]) => shift(u.box, o.x + dx, o.y + dy))
    if (moved.every((box) => !taken.some((t) => overlaps(box, inflate(t, MIN_GAP))) && !keepouts.some((k) => overlaps(box, k)))) {
      for (const [u, o] of packed.origins) packed.origins.set(u, { x: o.x + dx, y: o.y + dy })
    }
  }

  // Then shorten the wiring. Poured nets reach their pads through the pour and don't count.
  const poured = new Set(base.zones.map((z) => sch.nets.find((n) => n.name === z.net)?.id).filter((id): id is string => !!id))
  const netPins = new Map<string, NetPins>()
  const pinsOf = (c: ComponentInstance, add: (net: string, p: Vec2) => void) => {
    for (const pad of pcbPads(c)) {
      const net = pad.pin ? sch.pinNet.get(pinKey(c.id, pad.pin)) : undefined
      if (net && !poured.has(net)) add(net, pad)
    }
  }
  const netEntry = (net: string) => {
    let e = netPins.get(net)
    if (!e) netPins.set(net, (e = { fixed: [], moving: [] }))
    return e
  }
  const still = [...fixed, ...[...positions].map(([id, p]) => at(byId.get(id)!, p.x, p.y, p.rot, p.side))]
  for (const c of still) pinsOf(c, (net, p) => netEntry(net).fixed.push({ x: p.x, y: p.y }))
  loose.forEach((u, i) => {
    for (const m of u.members) pinsOf(at(m.c, m.x, m.y, m.rot, m.side), (net, p) => netEntry(net).moving.push({ unit: i, x: p.x, y: p.y }))
  })
  improvePlacement(loose, packed.origins, [...netPins.values()], { area, parts: taken, keepouts, gap })

  for (const [u, o] of packed.origins) {
    for (const m of u.members) positions.set(m.c.id, { x: o.x + m.x, y: o.y + m.y, rot: m.rot, side: m.side })
  }
  // What didn't fit waits in a column right of the board.
  let overflowY = area.maxY
  const overflowX = b.x + b.width / 2 + 5
  for (const u of packed.overflow) {
    const h = u.box.maxY - u.box.minY
    const o = { x: overflowX - u.box.minX, y: overflowY - u.box.maxY }
    for (const m of u.members) positions.set(m.c.id, { x: o.x + m.x, y: o.y + m.y, rot: m.rot, side: m.side })
    overflowY -= h + MIN_GAP
  }

  return {
    ...base,
    updatedAt: Date.now(),
    components: base.components.map((c) => {
      const p = positions.get(c.id)
      return p ? { ...c, pcb: { ...c.pcb, x: round(p.x, 2), y: round(p.y, 2), rot: p.rot, side: p.side, placed: true } } : c
    }),
  }
}


/**
 * Re-pack the whole board, as the Re-pack button and `layout_pcb` with `relayout_all` do:
 * `autoPlacePcb(project, true)`, then the pour stitching vias it cleared are put back on the
 * new layout, for each poured net that had them.
 */
export function repackPcb(project: Project): Project {
  const placed = autoPlacePcb(project, true)
  if (placed === project) return project
  // Stitched nets whose vias are all unlocked, so none is left standing among the new ones.
  const locked = new Set(project.vias.filter((v) => v.locked && v.net).map((v) => v.net))
  const nets = new Set(project.vias.filter((v) => v.net && !locked.has(v.net)).map((v) => v.net!))
  let next = placed
  for (const net of nets) if (next.zones.some((z) => z.net === net)) next = stitchVias(next, net).project
  return next
}

/** What a re-pack did to the copper: what it cleared, and the stitching vias before and after. */
export function repackCopper(before: Project, after: Project) {
  const stitching = (p: Project) => p.vias.filter((v) => v.net).length
  return {
    traces: Math.max(0, before.traces.length - after.traces.length),
    vias: Math.max(0, before.vias.filter((v) => !v.net).length - after.vias.filter((v) => !v.net).length),
    stitchedBefore: stitching(before),
    stitchedAfter: stitching(after),
  }
}
