import { Clipper, Clipper64, ClipType, FillRule, JoinType, PointInPolygonResult, PolyTree64, type Path64, type Paths64, type PolyPath64 } from "@countertype/clipper2-ts"
import type { SchematicConnectivity } from "./connectivity"
import { isNpth, type WorldPad } from "./instances"
import type { CopperItem } from "./pcb"
import type { FillPolygon, PourInput, ZoneFill } from "./pour"
import {
  areaMm2,
  boardArea,
  boardLoops,
  circlePath,
  difference,
  holeShape,
  inflate,
  intersect,
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
//   7. copper that touches no copper of its net is an island and goes, by the zone's island rule
//
// Clipper does the sums, in tenths of a micron (`zoneGeom.ts`).

/** The extra margin KiCad adds to every clearance so a rounded edge never leaves less than asked (`m_ExtraClearance`, 0.0005 mm). */
const EXTRA = 0.0005
/** What a minimum width is trimmed by when shrinking and growing, so a feature exactly that wide survives. */
const EPSILON_MM = 0.001
/** How far from the pad KiCad tests whether a spoke reaches copper (its maximum error). */
const SPOKE_REACH = 0.005

const SQUARE = JoinType.Square

interface ItemRec {
  index: number
  item: CopperItem
  net: string | null
}

interface Group {
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

function groupsOf(paths: Paths64): Group[] {
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

/** Whether a point is inside a group (its outline, and not inside one of its holes); a point on the edge counts as inside. */
function insideGroup(p: { x: number; y: number }, g: Group): boolean {
  const o = Clipper.pointInPolygon(p, g.paths[0])
  if (o === PointInPolygonResult.IsOutside) return false
  if (o === PointInPolygonResult.IsOn) return true
  for (let i = 1; i < g.paths.length; i++) if (Clipper.pointInPolygon(p, g.paths[i]) === PointInPolygonResult.IsInside) return false
  return true
}

/** A tester over many groups, with their boxes so most points are turned away at once. */
class Region {
  readonly groups: Group[]
  private readonly boxes: Bounds[]
  constructor(paths: Paths64) {
    this.groups = groupsOf(paths)
    this.boxes = this.groups.map((g) => boundsOf([g.paths[0]]))
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
 * out to the box of the pad grown by the gap, a round pad's at 45 degrees and every other pad's along its own axes, turned with the pad.
 */
function spokesOf(pad: WorldPad, project: Project, gap: number, spokeWidth: number, minWidth: number): Spoke[] {
  const f = padFrame(pad, project)
  const limit = Math.min(f.w, f.h)
  const sw = Math.min(spokeWidth, limit)
  // A spoke thinner than the zone's minimum width would be trimmed away, so KiCad makes none.
  if (sw < minWidth - 1e-9) return []
  const hx = f.w / 2 + gap + SPOKE_REACH + minWidth / 2
  const hy = f.h / 2 + gap + SPOKE_REACH + minWidth / 2
  const base = ((f.round ? 45 : 0) + f.angle) * (Math.PI / 180)
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

/** A box grown by `d` on every side. */
const pad0 = (b: Bounds, d: number): Bounds => ({ minX: b.minX - d, minY: b.minY - d, maxX: b.maxX + d, maxY: b.maxY + d })

/** The zone's outline with its holes, flattened, as paths that fill with the even-odd rule. */
function outlinePaths(project: Project, z: Zone): Paths64 {
  if (!hasPolygon(z)) return boardLoops(project.board)
  const rings = zoneRings(z)
  if (!rings.length) return []
  // One even-odd union: the first ring is the outline, the rest are holes in it, and a ring that crosses itself is made simple.
  return Clipper.union(rings.map(ring), [], FillRule.EvenOdd)
}

/** KiCad's corner smoothing (`SHAPE_POLY_SET::Chamfer` and `Fillet`): each convex corner cut off or rounded by the radius. Concave corners stay (a fillet there lies outside the zone and is trimmed). */
function smoothPaths(paths: Paths64, kind: "chamfer" | "fillet", radius: number): Paths64 {
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
  gapRule: number
  netIdOf: Map<string, string | null>
  loops: Paths64
}

/**
 * Fill every zone of a project that has a polygon, a rule area or any setting of its own, together with the editor's whole-board pours
 * (a whole-board pour is the board's outline as its polygon here). `fillZones` calls this when the project has any such zone, and fills
 * the project the way it always did when it has none.
 */
export function fillPolygonZones(project: Project, sch: SchematicConnectivity, input: PourInput): ZoneFill[] {
  const netIdOf = new Map<string, string | null>()
  const idOfNet = (name: string) => {
    if (!netIdOf.has(name)) netIdOf.set(name, name ? (sch.nets.find((n) => n.name === name)?.id ?? null) : null)
    return netIdOf.get(name) ?? null
  }
  const recs: ItemRec[] = input.items.flatMap((item, index) => (item.kind === "zone" ? [] : [{ index, item, net: input.netOf(index) }]))
  const prep: Prepared = { project, sch, input, recs, gapRule: project.rules.clearance, netIdOf, loops: boardLoops(project.board) }
  const settings = new Map(project.zones.map((z) => [z.id, zoneSettings(project, z)]))

  const pours = project.zones.filter((z) => !isRuleArea(z))
  const order = [...pours].sort((a, b) => (higherPriority(project, a, b) ? -1 : higherPriority(project, b, a) ? 1 : 0))
  const filled = new Map<string, Paths64>()
  const fills = new Map<string, ZoneFill>()
  const keyOf = (z: Zone, l: CopperLayer) => `${z.id}|${l}`
  const islandCandidates = new Map<string, Group[]>()

  for (const zone of order) {
    for (const layer of zoneLayers(zone)) {
      const net = idOfNet(zone.net)
      const copper = fillOne(prep, zone, layer, net, settings.get(zone.id)!, (other, l) => filled.get(keyOf(other, l)) ?? null)
      filled.set(keyOf(zone, layer), pathsOfGroups(copper))
      fills.set(keyOf(zone, layer), { zoneId: zone.id, netId: net, netName: zone.net, layer, polygons: [] })
      islandCandidates.set(keyOf(zone, layer), copper)
    }
  }
  const out = removeIslands(prep, pours, settings, fills, islandCandidates, input.keepIslands === true)
  // The result keeps the order the zones are stored in, as every consumer expects.
  const result: ZoneFill[] = []
  for (const zone of project.zones) {
    if (isRuleArea(zone)) continue
    for (const layer of zoneLayers(zone)) {
      const f = out.get(keyOf(zone, layer))
      if (f) result.push(f)
    }
  }
  return result
}

/** The copper of one zone on one layer, before islands go. */
function fillOne(prep: Prepared, zone: Zone, layer: CopperLayer, netId: string | null, set: ZoneSettings, fillOf: (z: Zone, l: CopperLayer) => Paths64 | null): Group[] {
  const { project, recs } = prep
  const teardrop = zone.teardrop !== undefined
  const minWidth = Math.max(0.01, set.minWidth)
  const hmw = minWidth / 2
  const shrink = hmw - EPSILON_MM
  const prune = shrink > EPSILON_MM
  // The gap to copper of another net: the zone's clearance, or the board's if that is more.
  const gap = Math.max(set.clearance, prep.gapRule)
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
  const reach = pad0(box, (Math.max(gap, set.thermalGap, holeGap, project.rules.clearance) + minWidth) * U)

  // ---- 2 and 3. what the fill keeps out of ----
  const thermalPads: WorldPad[] = []
  const thermalHoles: Paths64 = []
  const holes: Paths64 = []
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
        if (h && !isNpth(pad)) holes.push(...inflate(h, holeGap + EXTRA))
        continue
      }
      if (same && !isNpth(pad)) {
        const connection = teardrop ? "solid" : set.connect === "tht" ? (pad.holeDiameter !== undefined ? "thermal" : "solid") : set.connect
        if (connection === "thermal") {
          // Only a pad the copper reaches gets a relief.
          const shape = padShape(pad)
          if (overlaps(boundsOf(shape), box) && intersect(fill, shape).length) {
            thermalPads.push(pad)
            thermalHoles.push(...inflate(shape, set.thermalGap))
          }
        } else if (connection === "none") {
          // The pad is cut out with the zone's own clearance, and its hole with the hole's.
          thermalHoles.push(...inflate(padShape(pad), set.clearance))
        }
        continue
      }
      if (isNpth(pad)) {
        const h = holeShape(pad) ?? padShape(pad)
        holes.push(...inflate(h, holeGap + EXTRA))
        continue
      }
      holes.push(...inflate(padShape(pad), gap + EXTRA))
      const h = holeShape(pad)
      if (h) holes.push(...inflate(h, Math.max(gap, holeGap) + EXTRA))
    } else if (it.kind === "segment") {
      if (!on || same) continue
      holes.push(...stroke([it.a, it.b], it.width / 2 + gap + EXTRA))
    } else if (it.kind === "via") {
      if (!on || same) continue
      holes.push(circlePath(it.at.x, it.at.y, it.diameter / 2 + gap + EXTRA))
    } else if (it.kind === "shape") {
      if (!on) continue
      if (same && !it.what) continue
      holes.push(...shapeObstacle(it, gap + EXTRA))
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
        if (theirs?.length) holes.push(...inflate(theirs, Math.max(gap, zoneSettings(project, other).clearance, prep.gapRule) + EXTRA))
      }
    }
  }

  // Everything a thermal relief cuts out of the zone before the spokes go back in.
  if (thermalHoles.length) fill = difference(fill, union(thermalHoles))
  const clearance = holes.length ? union(holes) : []

  // ---- 4. thermal spokes ----
  const spokes: Spoke[] = []
  for (const pad of thermalPads) spokes.push(...spokesOf(pad, project, set.thermalGap, set.spokeWidth, minWidth))
  let withSpokes = fill
  if (spokes.length) {
    let test = difference(fill, clearance)
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
  if (prune) fill = inflate(fill, -shrink, SQUARE)
  if (prune) {
    // A piece no wider than the minimum is gone, as KiCad deletes it between shrinking and growing.
    fill = groupsOf(fill)
      .filter((g) => {
        const b = boundsOf([g.paths[0]])
        return Math.max(b.maxX - b.minX, b.maxY - b.minY) >= minWidth * U
      })
      .flatMap((g) => g.paths)
    if (fill.length) fill = inflate(fill, shrink)
  }

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
  // The zones of the same net that outrank this one are in charge of their own polygon.
  const outranking = project.zones.filter((o) => o !== zone && !isRuleArea(o) && o.net === zone.net && o.teardrop === undefined && zoneLayers(o).includes(layer) && (o.priority ?? 0) > (zone.priority ?? 0))
  if (outranking.length && fill.length) fill = difference(fill, union(outranking.flatMap((o) => outlinePaths(project, o))))
  return groupsOf(fill)
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
      let paths: Paths64
      let at: { x: number; y: number }
      if (it.kind === "pad") {
        if (isNpth(it.pad)) continue
        paths = padShape(it.pad)
        at = pt(it.pad.x, it.pad.y)
      } else if (it.kind === "segment") {
        paths = stroke([it.a, it.b], it.width / 2)
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
          if (insideGroup(a.at, g) || intersect(a.paths, g.paths).length) return false
        }
        for (const o of others) {
          if (!overlaps(b, boundsOf([o.paths[0]]))) continue
          if (intersect(g.paths, o.paths).length) return false
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

