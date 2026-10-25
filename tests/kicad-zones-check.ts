import { Clipper, EndType, FillRule, JoinType, type Path64, type Paths64 } from "@countertype/clipper2-ts"
import { computeConnectivity } from "../src/model/connectivity"
import { analyzePcb } from "../src/model/pcb"
import { isNpth } from "../src/model/instances"
import { boardLoops, padShape } from "../src/model/zoneGeom"
import { zoneLayers } from "../src/model/zones"
import { flattenPath } from "../src/model/shapes"
import type { Project, Zone } from "../src/model/types"
import { nearestIndex, sample } from "./kicad-census/edge.mjs"
import { importedZone, zoneOracle } from "./kicad-census/zones.mjs"

// The zones of an imported board against the raw file (`kicad-census/zones.mjs`, which shares no code with `src`): each zone's outline,
// layers, net and settings, and the editor's own fill of it against the copper KiCad stored, by area and by Hausdorff distance.

const U = 10_000
const ARC = 25

type Oracle = ReturnType<typeof zoneOracle>["zones"][number]

const toPath = (ring: number[][]): Path64 => ring.map(([x, y]) => ({ x: Math.round(x * U), y: Math.round(-y * U) }))
const areaMm2 = (paths: Paths64) => Math.abs(Clipper.areaPaths(paths)) / (U * U)

/** The copper KiCad stored for a zone on a layer, in the editor's frame (y up), as a region. */
export function storedCopper(z: Oracle, layer: string): Paths64 {
  const rings = z.fills.get(layer) ?? []
  if (!rings.length) return []
  let paths = Clipper.union(rings.map(toPath), [], FillRule.EvenOdd)
  // Fills drawn with a pen (no `filled_areas_thickness`): the copper is the stored polygon grown by half the minimum width.
  if (z.strokedFill && z.minThickness && z.minThickness > 0 && paths.length) paths = Clipper.inflatePaths(paths, (z.minThickness / 2) * U, JoinType.Round, EndType.Polygon, 2, ARC)
  return paths
}

export interface ZoneMismatch {
  zone: number
  what: string
}

/** The project's zones against the file's: the same zones in the same order, and every setting. Returns what differs. */
export function checkZoneSettings(text: string, project: Project): { compared: number; mismatches: ZoneMismatch[]; oracle: Oracle[] } {
  const raw = zoneOracle(text).zones
  const expected = raw.filter(importedZone)
  const out: ZoneMismatch[] = []
  if (expected.length !== project.zones.length) out.push({ zone: -1, what: `the file has ${expected.length} zones to import and the project ${project.zones.length}` })
  const n = Math.min(expected.length, project.zones.length)
  for (let i = 0; i < n; i++) {
    const f = expected[i]
    const z = project.zones[i]
    const bad = (what: string) => out.push({ zone: i, what })
    const layers = zoneLayers(z).slice().sort()
    if (layers.join() !== f.surface.slice().sort().join()) bad(`layers ${layers.join("+")} against ${f.surface.join("+")}`)
    // The tie-break between zones of equal priority (KiCad 6 and later compare the uuid's sixteen bytes; a tstamp is the last four): kept from file version 20211014 (KiCad 6) on.
    const stamp = Number(/\(version\s+(\d+)\)/.exec(text)?.[1] ?? 0)
    const digits = f.uuid === null ? "" : f.uuid.replace(/-/g, "").toLowerCase()
    const wantUuid = stamp >= 20211014 && /^([0-9a-f]{8}|[0-9a-f]{32})$/.test(digits) ? digits.padStart(32, "0") : undefined
    if (z.uuid !== wantUuid) bad(`uuid ${z.uuid} against ${wantUuid}`)
    // KiCad 5 and earlier have no order between zones of equal priority (their filler cuts only out of strictly higher priority).
    if ((z.unordered === true) !== (stamp < 20211014)) bad(`unordered ${z.unordered} against a file of version ${stamp}`)
    const rule = f.kind === "keepout" || f.kind === "rule-area"
    if (rule !== !!z.keepout) bad("rule area")
    if (rule) {
      for (const [k, key] of [["tracks", "tracks"], ["vias", "vias"], ["pads", "pads"], ["copperpour", "pour"], ["footprints", "footprints"]] as const) {
        if (!!f.keepout?.[k] !== !!(z.keepout as Record<string, unknown>)[key]) bad(`keepout ${k}`)
      }
    } else {
      if (project.zones[i].net !== f.netName && !(f.netName === "" && z.net === "")) {
        // The importer names nets by its own rule (a name that is not safe is encoded); the net must at least be the same net.
        if (!z.net || !f.netName) bad(`net ${z.net} against ${f.netName}`)
      }
      if ((z.priority ?? 0) !== f.priority) bad("priority")
      if (Math.abs((z.clearance ?? NaN) - (f.clearance ?? NaN)) > 1e-9 && f.clearance !== null) bad("clearance")
      if (f.minThickness !== null && Math.abs((z.minWidth ?? NaN) - f.minThickness) > 1e-9) bad("minimum width")
      const connect = f.connect === "yes" ? "solid" : f.connect === "no" ? "none" : f.connect === "thru_hole_only" ? "tht" : "thermal"
      if (z.connect !== connect) bad(`pad connection ${z.connect} against ${connect}`)
      if (f.thermalGap !== null && Math.abs((z.thermalGap ?? NaN) - f.thermalGap) > 1e-9) bad("thermal gap")
      if (f.thermalBridge !== null && Math.abs((z.spokeWidth ?? NaN) - f.thermalBridge) > 1e-9) bad("spoke width")
      const smooth = f.smoothing !== "none" && f.radius > 0 ? `${f.smoothing}:${f.radius}` : "none"
      const mine = z.smoothing ? `${z.smoothing.kind}:${z.smoothing.radius}` : "none"
      if (smooth !== mine) bad(`smoothing ${mine} against ${smooth}`)
      const islands = f.islandMode === 1 ? "never" : f.islandMode === 2 ? (f.islandArea ?? 10) : "always"
      if ((z.islands ?? "always") !== islands) bad("island rule")
      if ((z.teardrop ?? null) !== f.teardrop) bad("teardrop")
    }
    if ((z.name ?? "") !== f.name) bad("name")
    if (!!z.locked !== f.locked) bad("lock")
    // The outline: every corner of the file's polygons is on the project's, as areas.
    const mineRings = (z.outline ?? []).map((p) => flattenPath({ ...p, closed: true }, 2e-5).map((q) => [q.x, -q.y]))
    const a = Clipper.union(mineRings.map(toPath), [], FillRule.EvenOdd)
    const b = Clipper.union(f.rings.map(toPath), [], FillRule.EvenOdd)
    const diff = areaMm2(Clipper.xor(a, b, FillRule.NonZero))
    if (diff > 1e-4 + areaMm2(b) * 1e-6) bad(`outline differs by ${diff.toFixed(6)} mm2`)
  }
  return { compared: n, mismatches: out, oracle: expected }
}

export interface FillRow {
  zone: number
  layer: string
  net: string
  /** Square millimetres of the editor's copper and KiCad's stored copper, and of what is in only one of them. */
  ours: number
  theirs: number
  xor: number
  /** The farthest a point of one's boundary is from the other's (mm). */
  hausdorff: number
  /** The 99th percentile of the same distances, over every boundary point sampled. */
  p99: number
  /** The zone had a stored fill to compare with. */
  stored: boolean
  version: "stroked" | "area"
}

const ringsOf = (paths: Paths64): number[][][] => paths.map((p) => [...p.map((q) => [q.x / U, q.y / U]), [p[0].x / U, p[0].y / U]])

/** The editor's copper of every zone and layer against KiCad's stored fill. */
export function compareFills(text: string, project: Project, reach = 3): FillRow[] {
  const expected = zoneOracle(text).zones.filter(importedZone)
  const analysis = analyzePcb(project, computeConnectivity(project))
  const rows: FillRow[] = []
  project.zones.forEach((z: Zone, i) => {
    const f = expected[i]
    if (!f || z.keepout) return
    for (const layer of zoneLayers(z)) {
      const name = layer === "top" ? zoneOracle(text).front : zoneOracle(text).back
      // KiCad 5's thermal relief leaves the zone's copper under the pad, and the editor's does not: the pad's own copper is on top of it either
      // way, so the two are compared with the pads of the layer added to both.
      const padCopper: Paths64 = analysis.items.flatMap((it) => (it.kind === "pad" && it.layers.includes(layer) && !isNpth(it.pad) ? padShape(it.pad) : []))
      const withPads = (paths: Paths64): Paths64 => (padCopper.length && paths.length ? Clipper.union(paths, padCopper, FillRule.NonZero) : paths)
      // KiCad does not cut a fill to the board (a pour drawn past the edge leaves copper outside it, which no fabrication file has), so the stored
      // copper is cut to the board before it is compared: the editor's is inside it by construction.
      const onBoard = boardLoops(project.board)
      const theirs = withPads(Clipper.intersect(storedCopper(f, name), onBoard, FillRule.NonZero))
      const fill = analysis.zoneFills.find((x) => x.zoneId === z.id && x.layer === layer)
      const ours: Paths64 = withPads(
        Clipper.union(
          (fill?.polygons ?? []).flatMap((poly) => poly.map((r) => r.map((p) => ({ x: Math.round(p.x * U), y: Math.round(p.y * U) })))),
          [],
          FillRule.NonZero,
        ),
      )
      const row: FillRow = { zone: i, layer, net: z.net, ours: areaMm2(ours), theirs: areaMm2(theirs), xor: 0, hausdorff: 0, p99: 0, stored: theirs.length > 0, version: f.strokedFill ? "stroked" : "area" }
      if (theirs.length || ours.length) {
        row.xor = areaMm2(Clipper.xor(ours, theirs, FillRule.NonZero))
        const a = ringsOf(ours)
        const b = ringsOf(theirs)
        const toTheirs = b.length ? nearestIndex(b, reach) : () => Infinity
        const toOurs = a.length ? nearestIndex(a, reach) : () => Infinity
        const dists: number[] = []
        for (const line of a) for (const p of sample(line, 0.05)) dists.push(Math.min(toTheirs(p), reach))
        for (const line of b) for (const p of sample(line, 0.05)) dists.push(Math.min(toOurs(p), reach))
        dists.sort((x, y) => x - y)
        row.hausdorff = dists.length ? dists[dists.length - 1] : 0
        row.p99 = dists.length ? dists[Math.floor(dists.length * 0.99)] : 0
      }
      rows.push(row)
    }
  })
  return rows
}
