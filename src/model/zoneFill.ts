import { Clipper, Clipper64, ClipType, FillRule, JoinType, PointInPolygonResult, PolyTree64, type Path64, type Paths64, type PolyPath64 } from "@countertype/clipper2-ts"
import type { SchematicConnectivity } from "./connectivity"
import { classIndex, type ClassIndex } from "./netClasses"
import { scoped } from "./scope"
import { isNpth, npthFlashes, type WorldPad } from "./instances"
import { trackPoints } from "./arcTracks"
import type { CopperItem } from "./pcb"
import type { FillPolygon, PourInput, ZoneFill } from "./pour"
import { regionTester } from "./regionTester"
import {
  ARC_MM,
  areaMm2,
  boardArea,
  boardLoops,
  circlePath,
  difference,
  holeShape,
  inflate,
  intersect,
  padObstacle,
  padShape,
  pt,
  ring,
  shapeObstacle,
  stroke,
  toVec,
  U,
  union,
  upright,
} from "./zoneGeom"
import { withPartZones } from "./partZones"
import { hatchPaths, type HatchNet } from "./zoneHatch"
import { hasPolygon, higherPriority, isRuleArea, zoneLayers, zoneRings, zoneSettings, type ZoneSettings } from "./zones"
import type { CopperLayer, Project, Vec2, Zone } from "./types"

// The fill of a polygon zone (X3), as KiCad's `ZONE_FILLER` makes it (pcbnew/zone_filler.cpp and zone.cpp, KiCad 9 and 10; the
// KiCad 5 filler differs in how it draws its result, not in what copper it keeps, and its stored fills are read back as the copper
// they were drawn as, `docs/kicad-import.md` section 10). The steps, per zone and layer, zones in priority order:
//
//   1. the zone's polygon, with the polygons of same-net zones that overlap it, kept inside the board, its corners smoothed
//   2. minus a ring of clearance round each pad of its net that has a thermal relief, and minus the clearance round pads it does not join
//   3. the clearances: other nets' tracks, vias, pads, copper drawings and text, rule areas that keep pours out, other zones of higher priority
//   4. thermal spokes, kept where they reach copper
//   5. minimum width: the copper is shrunk by half of it less a thousandth of a millimetre and grown back, and what the shrinking
//      removed stays gone
//   6. the result is kept inside the zone's own polygon and out of every clearance, and out of the polygons of higher priority zones of the same net
//   7. a hatched pour has the grid's holes cut out of it (`zoneHatch.ts`)
//   8. copper that touches no copper of its net is an island and goes, by the zone's island rule
//
// Clipper does the sums, in tenths of a micron (`zoneGeom.ts`).

/** The extra margin KiCad adds to every clearance so a rounded edge never leaves less than asked (`m_ExtraClearance`, 0.0005 mm). */
const EXTRA = 0.0005
/**
 * How far inside the curve it stands for a round cut can come: the chords of a stroke's or an offset's round ends (`ARC_MM`), and of a rounded or oval pad's own
 * corners under that (`ARC_MM` more). KiCad draws every clearance with its error outside (`ERROR_OUTSIDE`), so a cut here is grown by this as well and never leaves
 * less than the clearance (a board's pours, filled again after an edit, were 0.5068 mm from its tracks under a 0.508 mm zone clearance: 200 errors in KiCad's DRC).
 */
const ROUND = 2 * ARC_MM
/** What a minimum width is trimmed by when shrinking and growing, so a feature exactly that wide survives. */
const EPSILON_MM = 0.001
/** How far from the pad KiCad tests whether a spoke reaches copper (its maximum error). */
const SPOKE_REACH = 0.005

const SQUARE = JoinType.Square
/** An outline under this area (the square of KiCad's maximum error, 0.005 mm) is dropped. */
const ARC_NOISE_MM2 = 0.005 * 0.005

interface ItemRec {
  index: number
  item: CopperItem
  net: string | null
}

export interface Group {
  /** The outline then its holes. */
  paths: Path64[]
}

/** A polytree flattened into outline-and-holes groups, islands inside holes included. */
function collect(node: PolyPath64, out: Group[]) {
  for (let i = 0; i < node.count; i++) {
    const outer = node.child(i)
    if (!outer.poly) continue
    const g: Path64[] = [outer.poly]
    for (let j = 0; j < outer.count; j++) {
      const hole = outer.child(j)
      if (hole.poly) g.push(hole.poly)
      collect(hole, out)
    }
    out.push({ paths: g })
  }
}

export function groupsOf(paths: Paths64): Group[] {
  if (!paths.length) return []
  const tree = new PolyTree64()
  const c = new Clipper64()
  c.addSubject(paths)
  c.execute(ClipType.Union, FillRule.NonZero, tree)
  const out: Group[] = []
  collect(tree, out)
  return out
}

const pathsOfGroups = (groups: Group[]): Paths64 => groups.flatMap((g) => g.paths)

interface Bounds {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

function boundsOf(paths: Path64[]): Bounds {
  const b = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }
  for (const p of paths) {
    for (const q of p) {
      if (q.x < b.minX) b.minX = q.x
      if (q.x > b.maxX) b.maxX = q.x
      if (q.y < b.minY) b.minY = q.y
      if (q.y > b.maxY) b.maxY = q.y
    }
  }
  return b
}

const overlaps = (a: Bounds, b: Bounds, pad = 0) => a.minX <= b.maxX + pad && b.minX <= a.maxX + pad && a.minY <= b.maxY + pad && b.minY <= a.maxY + pad

const groupTesters = new WeakMap<Group, (q: { x: number; y: number }) => boolean>()

/** Whether a point is in a group's copper (on its outline counts): its outline and holes asked through their boxes (`regionTester`), made once per group. */
function insideGroup(p: { x: number; y: number }, g: Group): boolean {
  let t = groupTesters.get(g)
  if (!t) groupTesters.set(g, (t = regionTester(g.paths)))
  return t(p)
}

/** The part of some paths inside a box: cheap for a large polygon, which a test against a small shape then meets in a few pieces. */
const crop = (paths: Paths64, b: Bounds): Paths64 => Clipper.rectClip({ left: b.minX, top: b.minY, right: b.maxX, bottom: b.maxY }, paths)

/** Whether a shape touches copper of a group: one of its corners in it, else what is left of the group in the shape's box meets it. */
function groupTouches(g: Group, shape: Paths64, box: Bounds): boolean {
  for (const p of shape) for (const q of p) if (insideGroup(q, g)) return true
  return intersect(shape, crop(g.paths, box)).length > 0
}

/** A tester over many groups, with their boxes so most points are turned away at once. */
class Region {
  readonly groups: Group[]
  private readonly boxes: Bounds[]
  constructor(paths: Paths64) {
    this.groups = groupsOf(paths)
    this.boxes = this.groups.map((g) => boundsOf([g.paths[0]]))
  }
  /** Whether a shape touches the copper of the region. */
  touches(shape: Paths64): boolean {
    const box = boundsOf(shape)
    for (let i = 0; i < this.groups.length; i++) if (overlaps(this.boxes[i], box) && groupTouches(this.groups[i], shape, box)) return true
    return false
  }
  contains(p: { x: number; y: number }): boolean {
    for (let i = 0; i < this.groups.length; i++) {
      const b = this.boxes[i]
      if (p.x < b.minX || p.x > b.maxX || p.y < b.minY || p.y > b.maxY) continue
      if (insideGroup(p, this.groups[i])) return true
    }
    return false
  }
}

interface Spoke {
  poly: Path64
  /** The middle of the spoke's outer end, which has to be in the copper for the spoke to stay. */
  test: { x: number; y: number }
}

/** The axes and size of a pad as its footprint has it before the part is turned, with the angle of that turn (degrees). */
function padFrame(pad: WorldPad, project: Project): { w: number; h: number; angle: number; round: boolean } {
  if (pad.shape === "circle" && !pad.axisSpokes) {
    const c = project.components.find((x) => x.id === pad.componentId)
    // A round pad's spokes are at 45 degrees to the part's axes (KiCad's default for a circle), so they follow the part's angle.
    return { w: pad.width, h: pad.width, angle: c ? ((c.pcb.rot % 90) + 90) % 90 : 0, round: true }
  }
  if (pad.oriented) return { w: pad.oriented.width, h: pad.oriented.height, angle: pad.oriented.rot, round: false }
  if (pad.shape === "polygon" && pad.points?.length) {
    let minX = Infinity
    let maxX = -Infinity
    let minY = Infinity
    let maxY = -Infinity
    for (const p of pad.points) {
      minX = Math.min(minX, p.x)
      maxX = Math.max(maxX, p.x)
      minY = Math.min(minY, p.y)
      maxY = Math.max(maxY, p.y)
    }
    return { w: maxX - minX, h: maxY - minY, angle: 0, round: false }
  }
  return { w: pad.width, h: pad.height, angle: 0, round: false }
}

/**
 * The four spokes of a pad's thermal relief, as KiCad builds them (`buildThermalSpokes`): square-ended bars from the middle of the pad
 * out to the box of the pad grown by the gap, a round pad's at 45 degrees and every other pad's along its own axes, turned with the pad. `reach` is half the width
 * KiCad grows them by on top of that (`zone_half_width`): the minimum width's, and a hatched pour's line width's in KiCad 10.
 */
function spokesOf(pad: WorldPad, project: Project, gap: number, spokeWidth: number, minWidth: number, reach: number): Spoke[] {
  const f = padFrame(pad, project)
  const limit = Math.min(f.w, f.h)
  const sw = Math.min(spokeWidth, limit)
  // A spoke thinner than the zone's minimum width would be trimmed away, so KiCad makes none.
  if (sw < minWidth - 1e-9) return []
  const hx = f.w / 2 + gap + SPOKE_REACH + reach
  const hy = f.h / 2 + gap + SPOKE_REACH + reach
  // A pad's own `thermal_bridge_angle` (X7) replaces KiCad's default, which is 45 degrees for a round pad and none for any other; the spokes are four, a quarter turn apart, so it counts modulo 90.
  const own = pad.thermalAngle !== undefined ? pad.thermalAngle % 90 : undefined
  const base = ((own ?? (f.round ? 45 : 0)) + f.angle) * (Math.PI / 180)
  const out: Spoke[] = []
  for (let k = 0; k < 4; k++) {
    const a = base + (k * Math.PI) / 2
    const dx = Math.cos(a)
    const dy = Math.sin(a)
    // Where the ray meets the box (an axis ray stops at the half size). The box is axis-aligned in the pad's frame, so unturn the ray.
    const ca = Math.cos(-f.angle * (Math.PI / 180))
    const sa = Math.sin(-f.angle * (Math.PI / 180))
    const ux = dx * ca - dy * sa
    const uy = dx * sa + dy * ca
    let t: number
    if (Math.abs(ux) < 1e-9) t = hy
    else if (Math.abs(uy) < 1e-9) t = hx
    else t = Math.min(hx / Math.abs(ux), hy / Math.abs(uy))
    const px = -dy
    const py = dx
    const h = sw / 2
    const ex = pad.x + dx * t
    const ey = pad.y + dy * t
    out.push({
      poly: upright([
        pt(pad.x + px * h, pad.y + py * h),
        pt(pad.x - px * h, pad.y - py * h),
        pt(ex - px * h, ey - py * h),
        pt(ex + px * h, ey + py * h),
      ]),
      test: pt(ex, ey),
    })
  }
  return out
}

/** The vias and pads of the pour's net on a layer, which KiCad 9 and earlier keep from being isolated in a hole of a hatch (`zoneHatch.ts`). */
function hatchNetOf(project: Project, items: ItemRec[], netId: string | null, layer: CopperLayer): HatchNet {
  const net: HatchNet = { vias: [], pads: [] }
  if (netId === null) return net
  for (const { item: it, net: itemNet } of items) {
    if (itemNet !== netId || !it.layers.includes(layer)) continue
    if (it.kind === "via") {
      const via = project.vias.find((v) => v.id === it.viaId)
      if (via) net.vias.push({ at: it.at, drill: via.drill })
    } else if (it.kind === "pad") {
      const f = padFrame(it.pad, project)
      net.pads.push({ shape: padShape(it.pad), width: Math.min(f.w, f.h), slot: it.pad.holeDiameter ?? 0 })
    }
  }
  return net
}

/**
 * The ring KiCad 10 puts round a thermal relief of a hatched pour (`buildHatchZoneThermalRings`): the band of the spokes' width just outside the relief's gap, kept inside `limit` (the pour's polygon).
 * The webbing joins the ring and the spokes cross it, so that the pad does not depend on a hole of the grid being cut right. No ring for a spoke too thin for the pour's minimum width.
 */
function thermalRing(pad: WorldPad, project: Project, gap: number, spokeWidth: number, minWidth: number, limit: Paths64): Paths64 {
  const f = padFrame(pad, project)
  const sw = Math.min(spokeWidth, f.w, f.h)
  if (sw < minWidth - 1e-9) return []
  const circular = pad.shape === "circle" || (pad.shape === "pill" && pad.width === pad.height)
  const ring = circular
    ? difference([circlePath(pad.x, pad.y, Math.max(f.w, f.h) / 2 + gap + sw)], [circlePath(pad.x, pad.y, Math.max(f.w, f.h) / 2 + gap)])
    : difference(inflate(padShape(pad), gap + sw), inflate(padShape(pad), gap))
  return intersect(ring, limit)
}

/** A via of the pour's net, as the pad KiCad 10 treats it as in a hatched pour (a round one, its spokes along the axes). */
const viaPad = (it: Extract<CopperItem, { kind: "via" }>): WorldPad => ({ componentId: "", pin: null, padNumber: null, shape: "circle", x: it.at.x, y: it.at.y, width: it.diameter, height: it.diameter, layers: it.layers, axisSpokes: true })

/** A box grown by `d` on every side. */
const pad0 = (b: Bounds, d: number): Bounds => ({ minX: b.minX - d, minY: b.minY - d, maxX: b.maxX + d, maxY: b.maxY + d })
/** A box as a path in Clipper's units, wound as an outline. */
const boxPath = (b: Bounds): Path64 => [
  { x: Math.floor(b.minX), y: Math.floor(b.minY) },
  { x: Math.ceil(b.maxX), y: Math.floor(b.minY) },
  { x: Math.ceil(b.maxX), y: Math.ceil(b.maxY) },
  { x: Math.floor(b.minX), y: Math.ceil(b.maxY) },
]

/** The zone's outline with its holes, flattened, as paths that fill with the even-odd rule. */
export function outlinePaths(project: Project, z: Zone): Paths64 {
  if (!hasPolygon(z)) return boardLoops(project.board)
  const rings = zoneRings(z)
  if (!rings.length) return []
  // One even-odd union: the first ring is the outline, the rest are holes in it, and a ring that crosses itself is made simple.
  return Clipper.union(rings.map(ring), [], FillRule.EvenOdd)
}

/** KiCad's corner smoothing (`SHAPE_POLY_SET::Chamfer` and `Fillet`): each convex corner cut off or rounded by the radius. Concave corners stay (a fillet there lies outside the zone and is trimmed). */
export function smoothPaths(paths: Paths64, kind: "chamfer" | "fillet", radius: number): Paths64 {
  const out: Paths64 = []
  for (const path of paths) {
    const pts = toVec(path)
    const n = pts.length
    if (n < 3) continue
    const positive = Clipper.isPositive(path)
    const res: Vec2[] = []
    for (let i = 0; i < n; i++) {
      const p = pts[(i + n - 1) % n]
      const c = pts[i]
      const q = pts[(i + 1) % n]
      const ax = p.x - c.x
      const ay = p.y - c.y
      const bx = q.x - c.x
      const by = q.y - c.y
      const la = Math.hypot(ax, ay)
      const lb = Math.hypot(bx, by)
      if (la < 1e-9 || lb < 1e-9) {
        res.push(c)
        continue
      }
      const cross = ax * by - ay * bx
      // A convex corner turns the way the ring is wound; a reflex corner is left alone.
      const convex = positive ? cross < 0 : cross > 0
      if (!convex) {
        res.push(c)
        continue
      }
      const cosT = (ax * bx + ay * by) / (la * lb)
      const theta = Math.acos(Math.max(-1, Math.min(1, cosT)))
      if (theta < 1e-3 || theta > Math.PI - 1e-3) {
        res.push(c)
        continue
      }
      if (kind === "chamfer") {
        const d = Math.min(radius, la / 2, lb / 2)
        res.push({ x: c.x + (ax / la) * d, y: c.y + (ay / la) * d }, { x: c.x + (bx / lb) * d, y: c.y + (by / lb) * d })
        continue
      }
      // The tangent length of an arc of the radius in a corner of angle theta, no more than half of the shorter side.
      let r = radius
      let t = r / Math.tan(theta / 2)
      const cap = Math.min(la, lb) / 2
      if (t > cap) {
        t = cap
        r = t * Math.tan(theta / 2)
      }
      const p1 = { x: c.x + (ax / la) * t, y: c.y + (ay / la) * t }
      const p2 = { x: c.x + (bx / lb) * t, y: c.y + (by / lb) * t }
      // The arc's centre is along the bisector at r / sin(theta / 2) from the corner.
      const mx = ax / la + bx / lb
      const my = ay / la + by / lb
      const ml = Math.hypot(mx, my)
      const dist = r / Math.sin(theta / 2)
      const cx = c.x + (mx / ml) * dist
      const cy = c.y + (my / ml) * dist
      const a1 = Math.atan2(p1.y - cy, p1.x - cx)
      let a2 = Math.atan2(p2.y - cy, p2.x - cx)
      let d = a2 - a1
      while (d > Math.PI) d -= Math.PI * 2
      while (d < -Math.PI) d += Math.PI * 2
      a2 = a1 + d
      const steps = Math.max(2, Math.ceil(Math.abs(d) / (2 * Math.acos(Math.max(0, 1 - 0.0025 / Math.max(r, 0.0026))))))
      for (let s = 0; s <= steps; s++) {
        const a = a1 + (d * s) / steps
        res.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r })
      }
    }
    out.push(upright(res.map((p) => pt(p.x, p.y))))
  }
  return out
}

interface Prepared {
  project: Project
  sch: SchematicConnectivity
  input: PourInput
  recs: ItemRec[]
  /** The widest clearance any pair of nets is held to (the board's, the classes' and the board minimum): how far to look, never a gap itself. */
  gapRule: number
  /** The net classes' clearances (`netClasses.ts`): the gap two nets keep is the larger of their classes', raised to a zone's own clearance. */
  classes: ClassIndex
  /** What of the classes goes into the key a fill is kept under: a class's clearance or members changing must fill again. */
  classKey: string
  /** The most any pad asks of a pour on its own (its clearance, thermal gap), which the search for neighbours has to reach (X7). */
  padReach: number
  /** The name of a net by its id: classes are by name. */
  netName: (id: string | null) => string | null
  netIdOf: Map<string, string | null>
  loops: Paths64
}

/** The widest gap a pad of the board asks for on its own: a clearance of its own or a thermal gap of its own. */
function padReachOf(recs: ItemRec[]): number {
  let m = 0
  for (const { item } of recs) if (item.kind === "pad") m = Math.max(m, item.pad.clearance ?? 0, item.pad.thermalGap ?? 0)
  return m
}

/** The part of the design rules that sets a gap between nets, as text: what a fill kept under a key depends on besides the copper and the zones. */
function classSignature(rules: Project["rules"]): string {
  return JSON.stringify([rules.clearance, rules.minClearance ?? 0, (rules.netClasses ?? []).map((c) => [c.nets, c.patterns ?? [], c.clearance ?? null])])
}

// ---------- Reusing fills (X3) ----------
//
// A refill of every zone on every edit froze the editor (6 s on a board of 102 parts), so a fill is kept and reused while what it was made
// from is the same. The zones are split into groups that can touch each other (their boxes, grown by everything that reaches across a
// gap, overlap on a shared layer); a group is filled together, as before, and its fill is kept under a key made of the zones themselves,
// their resolved settings, the board's outline and the copper that can reach them (every pad, track, via and drawing whose box is inside a
// zone's box grown by the widest gap), with the net of each. A part moved away from a zone leaves its group's key as it was, so the fill
// is not made again; one moved under it changes the key and the group is filled anew. The sums are the same ones, so a kept fill is the
// fill a fresh run would make.

/** What a group's kept fill is held under: at most this many groups, the least recently used going first. */
let cacheLimit = 96
/**
 * The kept fills, and the groups filled (not read from the cache) since the last `takeFilled`: what
 * a worker sends back to the thread that asked. The scope's (`model/scope.ts`): on a server the
 * fills of one call's board are neither read by another's nor left behind, where nothing takes them.
 */
const fillStore = scoped(() => ({ cache: new Map<string, ZoneFill[]>(), sinceTaken: [] as { key: string; fills: ZoneFill[] }[] }))

function remember(key: string, made: ZoneFill[]) {
  const { cache } = fillStore()
  cache.delete(key)
  cache.set(key, made)
  while (cache.size > cacheLimit) cache.delete(cache.keys().next().value as string)
}

/** Put in the fills another thread made, under the keys it made them under. */
export function seedZoneFills(entries: { key: string; fills: ZoneFill[] }[]): void {
  for (const e of entries) remember(e.key, e.fills)
}

/** The groups filled since this was last called (and forget them): the worker's reply. */
export function takeFilled(): { key: string; fills: ZoneFill[] }[] {
  const kept = fillStore()
  const out = kept.sinceTaken
  kept.sinceTaken = []
  return out
}

/** How many groups' fills are kept (0 keeps none: every fill is made again, as before fills were kept). */
export function setZoneFillCacheLimit(n: number): void {
  cacheLimit = Math.max(0, Math.floor(n))
  const { cache } = fillStore()
  while (cache.size > cacheLimit) cache.delete(cache.keys().next().value as string)
}

/** Forget every kept fill (tests, and a measure of a cold fill). */
export function clearZoneFillCache(): void {
  const kept = fillStore()
  kept.cache.clear()
  kept.sinceTaken = []
}

/** A 64-bit hash of a string as 16 hex digits (two 32-bit hashes of different kinds), which is what keys are made of. */
export function hashText(text: string): string {
  let a = 0x811c9dc5
  let b = 0x9e3779b9
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    a = Math.imul(a ^ c, 0x01000193) >>> 0
    b = Math.imul(b ^ (c + i), 0x85ebca6b) >>> 0
    b ^= b >>> 15
  }
  return a.toString(16).padStart(8, "0") + (b >>> 0).toString(16).padStart(8, "0")
}

const boardText = new WeakMap<Project["board"], string>()
const boardKey = (b: Project["board"]): string => {
  let t = boardText.get(b)
  if (t === undefined) {
    t = hashText(JSON.stringify(b))
    boardText.set(b, t)
  }
  return t
}

/** A group of zones whose fill is not current: the key its fill is kept under once made, and the zones in it. */
export interface PendingGroup {
  key: string
  zones: string[]
}

interface ZoneGroup {
  zones: Zone[]
  key: string
}

/**
 * The groups of zones that can touch one another and the key of each. Two zones are in one group when, on a layer they share, their
 * boxes grown by what a zone reaches (the widest clearance, thermal gap or hole gap it has, and the minimum width it grows and shrinks
 * by) overlap. A rule area is a zone here: it joins the groups it overlaps.
 */
function groupZones(prep: Prepared, settings: Map<string, ZoneSettings>, keepIslands: boolean): ZoneGroup[] {
  const { project, recs } = prep
  const zones = project.zones
  const grown = zones.map((z) => {
    const set = settings.get(z.id)!
    const own = hasPolygon(z) ? boundsOf(zoneRings(z).map(ring)) : boundsOf(prep.loops)
    const pad = Math.max(set.clearance, set.thermalGap, z.holeGap ?? 0, prep.gapRule, prep.padReach, project.rules.clearance, set.edgeGap) + 2 * Math.max(0.01, set.minWidth) + 1
    return pad0(own, pad * U)
  })
  const parent = zones.map((_, i) => i)
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])))
  for (let i = 0; i < zones.length; i++) {
    const li = zoneLayers(zones[i])
    for (let j = i + 1; j < zones.length; j++) {
      if (!overlaps(grown[i], grown[j])) continue
      if (!zoneLayers(zones[j]).some((l) => li.includes(l))) continue
      parent[find(i)] = find(j)
    }
  }
  const byRoot = new Map<number, number[]>()
  zones.forEach((_, i) => {
    const r = find(i)
    byRoot.set(r, [...(byRoot.get(r) ?? []), i])
  })

  // What each piece of copper is, as text, once: its shape, its layers, its net and (for a pad) the turn of its part, which sets its spokes.
  const turn = new Map(project.components.map((c) => [c.id, c.pcb.rot]))
  const sigs = new Map<number, string>()
  const sigOf = (r: ItemRec): string => {
    let t = sigs.get(r.index)
    if (t === undefined) {
      t = hashText(JSON.stringify(r.item) + "|" + (r.net ?? "") + (r.item.kind === "pad" ? "|" + (turn.get(r.item.pad.componentId) ?? "") : ""))
      sigs.set(r.index, t)
    }
    return t
  }
  const base = `${keepIslands ? "k" : "-"}|${boardKey(project.board)}|${prep.gapRule}|${prep.classKey}`
  return [...byRoot.values()].map((members) => {
    const group = members.map((i) => zones[i])
    const parts: string[] = [base]
    for (const i of members) {
      const z = zones[i]
      parts.push(JSON.stringify(z), JSON.stringify(settings.get(z.id)), prep.netIdOf.get(z.net) ?? "")
    }
    const boxes = members.map((i) => grown[i])
    const near = recs.filter((r) => {
      const b = r.item.box
      return boxes.some((g) => b.maxX * U >= g.minX && b.minX * U <= g.maxX && b.maxY * U >= g.minY && b.minY * U <= g.maxY)
    })
    // Sorted: the order the copper is listed in decides nothing, so a part added elsewhere in the list does not change the key.
    parts.push(...near.map(sigOf).sort())
    return { zones: group, key: hashText(parts.join("\n")) + group.length }
  })
}

/**
 * Fill every zone of a project that has a polygon, a rule area or any setting of its own, together with the editor's whole-board pours
 * (a whole-board pour is the board's outline as its polygon here). `fillZones` calls this when the project has any such zone, and fills
 * the project the way it always did when it has none.
 *
 * With `reuseOnly`, a group whose fill is not kept is not filled: the fills in `reuseOnly.stale` stand in for it, and it is listed in `missing`.
 */
export function fillPolygonZonesEx(project: Project, sch: SchematicConnectivity, input: PourInput, reuseOnly?: { stale: ZoneFill[] }): { fills: ZoneFill[]; missing: PendingGroup[] } {
  project = withPartZones(project)
  const netIdOf = new Map<string, string | null>()
  for (const z of project.zones) netIdOf.set(z.net, z.net ? (sch.nets.find((n) => n.name === z.net)?.id ?? null) : null)
  const recs: ItemRec[] = input.items.flatMap((item, index) => (item.kind === "zone" ? [] : [{ index, item, net: input.netOf(index) }]))
  const classes = classIndex(project.rules)
  const names = new Map(sch.nets.map((n) => [n.id, n.name]))
  const prep: Prepared = { project, sch, input, recs, gapRule: classes.worst, classes, padReach: padReachOf(recs), classKey: classSignature(project.rules), netName: (id) => (id ? (names.get(id) ?? null) : null), netIdOf, loops: boardLoops(project.board) }
  const settings = new Map(project.zones.map((z) => [z.id, zoneSettings(project, z)]))

  const byKey = new Map<string, ZoneFill>()
  const missing: PendingGroup[] = []
  for (const group of groupZones(prep, settings, input.keepIslands === true)) {
    const kept = fillStore().cache.get(group.key)
    if (kept) {
      remember(group.key, kept)
      for (const f of kept) byKey.set(`${f.zoneId}|${f.layer}`, f)
      continue
    }
    if (reuseOnly) {
      missing.push({ key: group.key, zones: group.zones.filter((z) => !isRuleArea(z)).map((z) => z.id) })
      for (const f of reuseOnly.stale) {
        const z = group.zones.find((x) => x.id === f.zoneId)
        if (z && zoneLayers(z).includes(f.layer)) byKey.set(`${f.zoneId}|${f.layer}`, f)
      }
      continue
    }
    const fills = fillGroup(prep, group.zones, settings)
    remember(group.key, fills)
    fillStore().sinceTaken.push({ key: group.key, fills })
    for (const f of fills) byKey.set(`${f.zoneId}|${f.layer}`, f)
  }
  // The result keeps the order the zones are stored in, as every consumer expects.
  const result: ZoneFill[] = []
  for (const zone of project.zones) {
    if (isRuleArea(zone)) continue
    for (const layer of zoneLayers(zone)) {
      const f = byKey.get(`${zone.id}|${layer}`)
      if (f) result.push(f)
    }
  }
  return { fills: result, missing }
}

export const fillPolygonZones = (project: Project, sch: SchematicConnectivity, input: PourInput): ZoneFill[] => fillPolygonZonesEx(project, sch, input).fills

/**
 * Earlier fills with the copper added since cut out of them: a track or via of another net (or of none) takes its clearance out of every
 * fill it reaches, as a refill would, and nothing else changes. For work that needs the pours to be about right many times over while
 * it adds copper (the router's steps); what it is judged by is filled in full. `fresh` is the copper added since the fills were made,
 * with the net of each.
 */
export function carveFills(project: Project, fills: ZoneFill[], fresh: { item: CopperItem; net: string | null }[], netName: (id: string | null) => string | null = () => null): ZoneFill[] {
  if (!fresh.length) return fills
  project = withPartZones(project)
  const classes = classIndex(project.rules)
  return fills.map((f) => {
    const zone = project.zones.find((z) => z.id === f.zoneId)
    if (!zone || !f.polygons.length) return f
    const own = zoneSettings(project, zone).clearance
    const gapOf = (net: string | null) => Math.max(own, classes.pair(f.netName || null, netName(net))) + EXTRA
    const paths: Paths64 = f.polygons.flatMap((poly) => poly.map(ring))
    const box = boundsOf(paths)
    const holes: Paths64 = []
    for (const { item: it, net } of fresh) {
      if (!it.layers.includes(f.layer) || (net !== null && net === f.netId)) continue
      const b = it.box
      const gap = gapOf(net)
      if (!overlaps({ minX: b.minX * U, maxX: b.maxX * U, minY: b.minY * U, maxY: b.maxY * U }, box, gap * U)) continue
      if (it.kind === "segment") holes.push(...stroke(trackPoints(it), it.width / 2 + gap + ROUND))
      else if (it.kind === "via") holes.push(circlePath(it.at.x, it.at.y, it.diameter / 2 + gap))
      else if (it.kind === "pad") holes.push(...padObstacle(it.pad, (it.pad.clearance ? Math.max(gap, it.pad.clearance + EXTRA) : gap) + ROUND))
      else if (it.kind === "shape") holes.push(...shapeObstacle(it, gap + ROUND))
    }
    if (!holes.length) return f
    return { ...f, polygons: groupsOf(difference(paths, union(holes))).map((g) => g.paths.map(toVec)) }
  })
}

/** The fills of one group of zones that touch one another, filled together. */
function fillGroup(prep: Prepared, group: Zone[], settings: Map<string, ZoneSettings>): ZoneFill[] {
  const { project, input, netIdOf } = prep
  const pours = group.filter((z) => !isRuleArea(z))
  const order = [...pours].sort((a, b) => (higherPriority(project, a, b) ? -1 : higherPriority(project, b, a) ? 1 : 0))
  const filled = new Map<string, Paths64>()
  const fills = new Map<string, ZoneFill>()
  const keyOf = (z: Zone, l: CopperLayer) => `${z.id}|${l}`
  const islandCandidates = new Map<string, Group[]>()

  for (const zone of order) {
    for (const layer of zoneLayers(zone)) {
      const net = netIdOf.get(zone.net) ?? null
      const copper = fillOne(prep, zone, layer, net, settings.get(zone.id)!, (other, l) => filled.get(keyOf(other, l)) ?? null)
      filled.set(keyOf(zone, layer), pathsOfGroups(copper))
      fills.set(keyOf(zone, layer), { zoneId: zone.id, netId: net, netName: zone.net, layer, polygons: [] })
      islandCandidates.set(keyOf(zone, layer), copper)
    }
  }
  const out = removeIslands(prep, pours, settings, fills, islandCandidates, input.keepIslands === true)
  const result: ZoneFill[] = []
  for (const zone of pours) for (const layer of zoneLayers(zone)) result.push(out.get(keyOf(zone, layer))!)
  return result
}

/** The gap of a pad's thermal relief: its own (`thermal_gap`, X7) when it has one, else the zone's. */
const thermalGapOf = (pad: WorldPad, set: ZoneSettings): number => (pad.thermalGap && pad.thermalGap > 0 ? pad.thermalGap : set.thermalGap)
/** The width of a pad's thermal spokes: its own (`thermal_width`, X7) when it has one, else the zone's. */
const spokeWidthOf = (pad: WorldPad, set: ZoneSettings): number => (pad.thermalWidth && pad.thermalWidth > 0 ? pad.thermalWidth : set.spokeWidth)

/** The copper of one zone on one layer, before islands go. */
function fillOne(prep: Prepared, zone: Zone, layer: CopperLayer, netId: string | null, set: ZoneSettings, fillOf: (z: Zone, l: CopperLayer) => Paths64 | null): Group[] {
  const { project, recs } = prep
  const teardrop = zone.teardrop !== undefined
  const minWidth = Math.max(0.01, set.minWidth)
  const hmw = minWidth / 2
  const shrink = hmw - EPSILON_MM
  const prune = shrink > EPSILON_MM
  // The gap to copper of another net: the largest of the zone's own clearance, the larger of the two nets' class clearances and the board minimum.
  // KiCad max's a zone's local clearance with the class value and does not substitute it (drc_engine.cpp 9.0 :1451-1540, 10.0 :1982-2063), and the
  // class value is the larger of the two items' classes (9.0 :1383-1400). A board with no classes is the zone's clearance or the rules', as before.
  const zoneNet = zone.net || null
  const gapTo = (net: string | null) => Math.max(set.clearance, prep.classes.pair(zoneNet, prep.netName(net)))
  const gap = gapTo(null)
  const holeGap = zone.holeGap ?? gap

  // ---- 1. the polygon, with same-net zones that overlap it, inside the board, and smoothed ----
  const flat = outlinePaths(project, zone)
  if (!flat.length) return []
  const area = boardArea(project.board, set.edgeGap)
  let joined = flat
  if (!teardrop) {
    const mine = boundsOf(flat)
    for (const other of project.zones) {
      if (other === zone || isRuleArea(other) || other.teardrop !== undefined || other.net !== zone.net || !zoneLayers(other).includes(layer)) continue
      const o = outlinePaths(project, other)
      if (!o.length || !overlaps(boundsOf(o), mine)) continue
      if (!intersect(flat, o).length) continue
      // A zone of higher priority and another net that swallows the other zone whole cuts it off from this one.
      const covers = union(project.zones.filter((d) => d !== other && !isRuleArea(d) && d.net !== zone.net && zoneLayers(d).includes(layer) && higherPriority(project, d, other)).flatMap((d) => outlinePaths(project, d)))
      if (covers.length && !difference(o, covers).length) continue
      joined = union(joined, o)
    }
  }
  const sameNet = intersect(joined, prep.loops)
  const smoothedAll = !teardrop && set.smoothing ? smoothPaths(sameNet, set.smoothing.kind, set.smoothing.radius) : sameNet
  // What the copper may never leave: the zone's own polygon, smoothed (smoothing only ever takes copper away).
  const maxExtents = intersect(smoothedAll, flat)
  // The envelope that lets the shrinking and growing of the minimum width run past the border with a same-net zone without leaving a notch.
  let fill = intersect(intersect(smoothedAll, intersect(inflate(flat, minWidth), sameNet)), area)
  if (!fill.length) return []

  const box = boundsOf(fill)
  const reach = pad0(box, (Math.max(gap, set.clearance, prep.gapRule, prep.padReach, set.thermalGap, holeGap) + minWidth) * U)

  // ---- 2 and 3. what the fill keeps out of ----
  let reached: Region | null = null
  const thermalPads: WorldPad[] = []
  const thermalHoles: Paths64 = []
  /** KiCad 10, a hatched pour: the pads the pour does not join (their clearance holes, which no hole of the grid may hold whole) and the vias it joins solid (which no hole may isolate). */
  const noneHoles: Paths64 = []
  const solidVias: Extract<CopperItem, { kind: "via" }>[] = []
  // KiCad 10 hatches by other rules than KiCad 9 and earlier: thermal rings, via reliefs, an anchored grid (`zoneHatch.ts`)
  const hatch10 = zone.hatch !== undefined && !zone.hatch.fromFill
  const holes: Paths64 = []
  /** Zones of higher priority and another net, kept apart so the thinnest copper is judged again after they cut in (KiCad 10, `postKnockoutMinWidthPrune`). */
  const zoneHoles: Paths64 = []
  const startFill = fill
  const nearby = recs.filter((r) => {
    const b = r.item.box
    return b.maxX * U >= reach.minX && b.minX * U <= reach.maxX && b.maxY * U >= reach.minY && b.minY * U <= reach.maxY
  })
  for (const { item: it, net } of nearby) {
    const on = it.layers.includes(layer)
    const same = netId !== null && net === netId
    if (it.kind === "pad") {
      const pad = it.pad
      if (!on) {
        // A pad that has no copper here but a hole through the board still keeps the pour back from its hole.
        const h = holeShape(pad)
        if (h && !isNpth(pad)) holes.push(...inflate(h, holeGap + EXTRA + ROUND))
        continue
      }
      // X22: where a backdrill or post-machining cuts the pad's copper, the pour does not join it and keeps out of the hole that is cut (`zone_filler.cpp` 10.0 `:2190` and `:2507`).
      const cut = it.cut?.[layer] ?? 0
      if (cut > 0) holes.push(circlePath(pad.hole?.x ?? pad.x, pad.hole?.y ?? pad.y, cut / 2 + Math.max(holeGap, 0) + EXTRA))
      if (same && !isNpth(pad) && !cut) {
        // A teardrop zone joins its pads solidly; otherwise a pad's own connection (`zone_connect`, X7) replaces the zone's (KiCad: the pad's local setting
        // comes before the footprint's and the zone's, `EvalZoneConnection`), and through-hole-only is a relief on a pad with a hole and solid on any other.
        const wanted = teardrop ? "solid" : (pad.zoneConnect ?? set.connect)
        const connection = wanted === "tht" ? (pad.holeDiameter !== undefined ? "thermal" : "solid") : wanted
        if (connection === "thermal") {
          // Only a pad the copper reaches gets a relief, of the pad's own gap when it has one.
          const shape = padShape(pad)
          if (overlaps(boundsOf(shape), box) && (reached ??= new Region(fill)).touches(shape)) {
            thermalPads.push(pad)
            thermalHoles.push(...inflate(shape, thermalGapOf(pad, set)))
          }
        } else if (connection === "none") {
          // The pad is cut out with the zone's own clearance, and its hole with the hole's.
          thermalHoles.push(...inflate(padShape(pad), set.clearance))
          noneHoles.push(...inflate(padShape(pad), set.clearance))
        }
        continue
      }
      if (isNpth(pad)) {
        // One with copper of its own keeps the pour the clearance from that copper, as any pad of another net; its hole keeps only the hole's (`knockoutPadClearance`,
        // zone_filler.cpp 9.0: "NPTH do not need copper clearance gaps to their holes").
        if (npthFlashes(pad)) holes.push(...padObstacle(pad, (pad.clearance ? Math.max(gapTo(null), pad.clearance) : gapTo(null)) + EXTRA + ROUND))
        const h = holeShape(pad) ?? padShape(pad)
        holes.push(...inflate(h, holeGap + EXTRA + ROUND))
        continue
      }
      // A pad with a clearance of its own (X7) is kept that far from at least, as KiCad max's a local clearance with the class's (and the zone's, which `gapTo` has).
      const padGap = pad.clearance ? Math.max(gapTo(net), pad.clearance) : gapTo(net)
      holes.push(...padObstacle(pad, padGap + EXTRA + ROUND))
      const h = holeShape(pad)
      if (h) holes.push(...inflate(h, Math.max(padGap, holeGap) + EXTRA + ROUND))
    } else if (it.kind === "segment") {
      if (!on || same) continue
      holes.push(...stroke(trackPoints(it), it.width / 2 + gapTo(net) + EXTRA + ROUND))
    } else if (it.kind === "via") {
      // X22: a backdrill or post-machining that cuts the via here keeps the pour from joining it and out of the hole it cuts (`zone_filler.cpp` 10.0 `:2345` and `:2609`).
      const cut = it.cut?.[layer] ?? 0
      if (!on) continue
      if (same && !cut) {
        // KiCad 10 treats a via of the pour's net in a hatched pour as a pad: thermal relief, or solid with no hole of the grid to isolate it (a pour that joins no via leaves it alone).
        if (hatch10) {
          const connection = set.connect === "tht" ? "solid" : set.connect
          if (connection === "solid") solidVias.push(it)
          else if (connection === "thermal" && set.thermalGap > 0) {
            const via = viaPad(it)
            thermalPads.push(via)
            thermalHoles.push(...inflate(padShape(via), set.thermalGap))
          }
        }
        continue
      }
      holes.push(circlePath(it.at.x, it.at.y, it.diameter / 2 + gapTo(net) + EXTRA))
      if (cut > 0) holes.push(circlePath(it.at.x, it.at.y, cut / 2 + Math.max(holeGap, 0) + EXTRA))
    } else if (it.kind === "shape") {
      if (!on) continue
      if (same && !it.what) continue
      holes.push(...shapeObstacle(it, gapTo(net) + EXTRA + ROUND))
    }
  }

  // Rule areas that keep pours out (by their outline, with no clearance) and zones of higher priority and another net (by their fill, with the gap).
  if (!teardrop) {
    for (const other of project.zones) {
      if (other === zone || !zoneLayers(other).includes(layer)) continue
      if (isRuleArea(other)) {
        if (other.keepout?.pour) holes.push(...outlinePaths(project, other))
      } else if (other.net !== zone.net && higherPriority(project, other, zone)) {
        const theirs = fillOf(other, layer)
        if (!theirs?.length) continue
        const g = Math.max(set.clearance, zoneSettings(project, other).clearance, prep.classes.pair(zoneNet, other.net || null)) + EXTRA
        // Only the part of their fill within the gap of this one's matters: it is cut to a box two gaps round this fill before it is grown, so a board-wide
        // pour is not grown whole for each small zone it outranks (a keyboard's 150 row zones under one ground pour took most of a minute). The cut's own
        // edges grow by one gap, which stays outside this fill. The cut is a boolean, not `crop`: Clipper's rectangle clip gets some unions' paths wrong.
        const near = intersect(theirs, [boxPath(pad0(box, 2 * g * U))])
        if (near.length) zoneHoles.push(...inflate(near, g + ROUND))
      }
    }
  }

  // Everything a thermal relief cuts out of the zone before the spokes go back in.
  if (thermalHoles.length) fill = difference(fill, union(thermalHoles))
  // KiCad 10: a hatched pour gets a ring round each relief, which the grid's webbing joins instead of the pad.
  let rings: Paths64 = []
  if (hatch10) {
    for (const pad of thermalPads) rings.push(...thermalRing(pad, project, thermalGapOf(pad, set), spokeWidthOf(pad, set), minWidth, startFill))
    if (rings.length) fill = union(fill, rings)
  }
  const clearance = holes.length ? union(holes) : []
  const zoneCut = zoneHoles.length ? union(zoneHoles) : []

  // ---- 4. thermal spokes ----
  const spokes: Spoke[] = []
  const spokeReach = hatch10 ? zone.hatch!.thickness / 2 : hmw
  for (const pad of thermalPads) spokes.push(...spokesOf(pad, project, thermalGapOf(pad, set), spokeWidthOf(pad, set), minWidth, spokeReach))
  let withSpokes = fill
  if (spokes.length) {
    let test = difference(difference(fill, clearance), zoneCut)
    if (prune) test = inflate(inflate(test, -shrink, SQUARE), shrink, SQUARE)
    const region = new Region(test)
    const kept: Spoke[] = []
    const pending: Spoke[] = []
    for (const s of spokes) (region.contains(s.test) ? kept : pending).push(s)
    // A spoke whose end is not in the copper stays when it meets another spoke (two pads' spokes can bridge a gap).
    for (const s of pending) {
      const sb = boundsOf([s.poly])
      for (const o of spokes) {
        if (o === s || !overlaps(sb, boundsOf([o.poly]))) continue
        if (Clipper.pointInPolygon(s.test, o.poly) !== PointInPolygonResult.IsOutside && Clipper.pointInPolygon(o.test, s.poly) !== PointInPolygonResult.IsOutside) {
          kept.push(s)
          break
        }
      }
    }
    if (kept.length) withSpokes = union(fill, kept.map((s) => s.poly))
  }
  fill = difference(withSpokes, clearance)

  // ---- 5. the minimum width ----
  if (prune) {
    fill = inflate(fill, -shrink, SQUARE)
    // The rings are shrunk to match, for the hatch's holes to be cut right round them.
    if (rings.length) rings = inflate(rings, -shrink, SQUARE)
    // A piece no wider than the minimum is gone, as KiCad deletes it between shrinking and growing.
    // The outlines come out of the offset wound one way and the holes the other, so a small outline is told by its winding, and what lies in it goes too.
    const small: Bounds[] = []
    const tiny = fill.filter((p) => {
      if (!Clipper.isPositive(p)) return false
      const b = boundsOf([p])
      const yes = Math.max(b.maxX - b.minX, b.maxY - b.minY) < minWidth * U
      if (yes) small.push(b)
      return yes
    })
    if (tiny.length) {
      const within = (b: Bounds) => small.some((s) => b.minX >= s.minX && b.maxX <= s.maxX && b.minY >= s.minY && b.maxY <= s.maxY)
      fill = fill.filter((p) => !tiny.includes(p) && (Clipper.isPositive(p) || !within(boundsOf([p]))))
    }
  }
  // X24: a hatched pour has the grid's holes cut out of it while it is shrunk, as KiCad does.
  if (zone.hatch && fill.length) {
    const discs = solidVias.flatMap((v) => intersect([circlePath(v.at.x, v.at.y, v.diameter / 2)], startFill))
    fill = hatchPaths(fill, zone.hatch, minWidth, flat, hatch10 ? { at: zone.hatchAt?.[layer], protect: union([...rings, ...noneHoles, ...clearance, ...discs]) } : { net: hatchNetOf(project, nearby, netId, layer) })
  }
  if (prune && fill.length) fill = inflate(fill, shrink)
  // KiCad 10 adds the rings back after the growing, which can leave notches in the outline.
  if (rings.length) fill = union(fill, rings)

  // ---- 6. kept inside the polygon and out of the clearances ----
  const padHoles: Paths64 = []
  for (const pad of thermalPads) {
    const h = holeShape(pad)
    if (h) padHoles.push(...h)
  }
  fill = intersect(fill, maxExtents)
  fill = intersect(fill, area)
  const cut = padHoles.length ? union([...clearance, ...padHoles]) : clearance
  fill = difference(fill, cut)
  // Different-net zones of higher priority cut in last, and the thinnest copper is judged again where they did: the band the trim to the
  // polygon took off where a zone of the same net abuts stands in for that zone, so the shrinking leaves no notch along the border.
  // Copper thinner than the minimum that a cut leaves is within two shrinks of it, and whether a point there stays reads the copper within
  // two more: so the shrinking and growing run on the copper within six shrinks of the cuts (the pieces the crop makes there are wider than
  // the minimum, so none is taken for a sliver), and the fill loses the cuts and what the growing did not give back within two shrinks of
  // them; the rest is kept as it was. The whole pour is cut twice (the crop and the last difference): a board-wide hatched pour under a
  // keyboard's 150 row zones was shrunk, grown and cut whole here, 32 of its 62 seconds.
  if (zoneCut.length && fill.length) {
    if (!prune) fill = difference(fill, zoneCut)
    else {
      const apron = difference(difference(startFill, maxExtents), cut)
      const band = union(inflate(zoneCut, 2 * shrink + EPSILON_MM))
      const reach = union(inflate(zoneCut, 6 * shrink + EPSILON_MM))
      const local = difference(intersect(fill, reach), zoneCut)
      let work = apron.length ? union(local, intersect(inflate(difference(apron, zoneCut), EPSILON_MM), reach)) : local
      work = inflate(work, -shrink, SQUARE)
      const kept = groupsOf(work).filter((g) => {
        const b = boundsOf([g.paths[0]])
        return Math.max(b.maxX - b.minX, b.maxY - b.minY) >= minWidth * U
      })
      work = kept.length ? inflate(pathsOfGroups(kept), shrink) : []
      fill = difference(fill, union(zoneCut, difference(band, work)))
    }
  }
  // The zones of the same net that outrank this one are in charge of their own polygon.
  const outranking = project.zones.filter((o) => o !== zone && !isRuleArea(o) && o.net === zone.net && o.teardrop === undefined && zoneLayers(o).includes(layer) && (o.priority ?? 0) > (zone.priority ?? 0))
  if (outranking.length && fill.length) fill = difference(fill, union(outranking.flatMap((o) => outlinePaths(project, o))))
  // Outlines smaller than the resolution of the fill are noise (KiCad 10, `dropSubResolutionOutlines`).
  return groupsOf(fill).filter((g) => areaMm2([g.paths[0]]) >= ARC_NOISE_MM2)
}

/**
 * Copper that no copper of its net touches is an island (KiCad's connectivity: a polygon alone in its cluster). By the zone's rule it is
 * removed, kept, or removed under an area; a zone whose every polygon is an island keeps them all.
 */
function removeIslands(
  prep: Prepared,
  pours: Zone[],
  settings: Map<string, ZoneSettings>,
  fills: Map<string, ZoneFill>,
  candidates: Map<string, Group[]>,
  keepIslands: boolean,
): Map<string, ZoneFill> {
  const { recs } = prep
  // The same-net copper on each layer that can join a polygon: pads, tracks, vias and drawings of the net, as shapes.
  const anchorCache = new Map<string, { bounds: Bounds; paths: Paths64; at: { x: number; y: number } }[]>()
  const anchorsFor = (netId: string, layer: CopperLayer) => {
    const key = `${netId}|${layer}`
    const hit = anchorCache.get(key)
    if (hit) return hit
    const list: { bounds: Bounds; paths: Paths64; at: { x: number; y: number } }[] = []
    for (const { item: it, net } of recs) {
      if (net !== netId || !it.layers.includes(layer)) continue
      // X22: copper cut round its hole on this layer is not joined to the pour.
      if ((it.kind === "pad" || it.kind === "via") && (it.cut?.[layer] ?? 0) > 0) continue
      let paths: Paths64
      let at: { x: number; y: number }
      if (it.kind === "pad") {
        if (isNpth(it.pad)) continue
        paths = padShape(it.pad)
        at = pt(it.pad.x, it.pad.y)
      } else if (it.kind === "segment") {
        paths = stroke(trackPoints(it), it.width / 2)
        at = pt(it.a.x, it.a.y)
      } else if (it.kind === "via") {
        paths = [circlePath(it.at.x, it.at.y, it.diameter / 2)]
        at = pt(it.at.x, it.at.y)
      } else if (it.kind === "shape" && it.conducts) {
        paths = shapeObstacle(it, 0)
        at = pt(it.box.minX, it.box.minY)
      } else continue
      if (paths.length) list.push({ bounds: boundsOf(paths), paths, at })
    }
    anchorCache.set(key, list)
    return list
  }

  // Which polygons are islands, per zone and layer.
  const isIsland = new Map<string, boolean[]>()
  const netZones = pours.filter((z) => prep.netIdOf.get(z.net) ?? null)
  for (const zone of pours) {
    const netId = prep.netIdOf.get(zone.net) ?? null
    for (const layer of zoneLayers(zone)) {
      const key = `${zone.id}|${layer}`
      const groups = candidates.get(key) ?? []
      if (!netId) {
        // A zone on no net: every polygon is alone in its cluster.
        isIsland.set(key, groups.map(() => true))
        continue
      }
      const anchors = anchorsFor(netId, layer)
      // The polygons of the other zones of the net on this layer join the ones they touch.
      const others = netZones.filter((o) => o !== zone && prep.netIdOf.get(o.net) === netId && zoneLayers(o).includes(layer)).flatMap((o) => candidates.get(`${o.id}|${layer}`) ?? [])
      const flags = groups.map((g) => {
        const b = boundsOf([g.paths[0]])
        for (const a of anchors) {
          if (!overlaps(b, a.bounds)) continue
          if (insideGroup(a.at, g) || groupTouches(g, a.paths, a.bounds)) return false
        }
        for (const o of others) {
          if (!overlaps(b, boundsOf([o.paths[0]]))) continue
          if (groupTouches(g, o.paths, boundsOf([o.paths[0]]))) return false
        }
        return true
      })
      isIsland.set(key, flags)
    }
  }

  const result = new Map<string, ZoneFill>()
  for (const zone of pours) {
    const set = settings.get(zone.id)!
    const netId = prep.netIdOf.get(zone.net) ?? null
    const layers = zoneLayers(zone)
    // If every polygon on every layer is an island, none is removed.
    const allIslands = layers.every((l) => {
      const f = isIsland.get(`${zone.id}|${l}`) ?? []
      return f.length === (candidates.get(`${zone.id}|${l}`) ?? []).length && f.every(Boolean)
    })
    for (const layer of layers) {
      const key = `${zone.id}|${layer}`
      const base = fills.get(key)!
      const groups = candidates.get(key) ?? []
      const flags = isIsland.get(key) ?? []
      const polygons: FillPolygon[] = []
      groups.forEach((g, i) => {
        if (!keepIslands && !allIslands && flags[i] && netId) {
          if (set.islands === "never") {
            // kept
          } else if (typeof set.islands === "number") {
            if (areaMm2([g.paths[0]]) < set.islands) return
          } else return
        } else if (!keepIslands && !allIslands && flags[i] && !netId) {
          // a zone with no net keeps every polygon
        }
        polygons.push(g.paths.map(toVec))
      })
      result.set(key, { ...base, polygons })
    }
  }
  return result
}

