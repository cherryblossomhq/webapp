import { uid } from "../../../lib/id"
import type { PathSeg, ShapePath } from "../../shapes"
import type { CopperLayer, DesignRules, Vec2, Zone } from "../../types"
import { kicadUuid } from "../../zones"
import { layerClass } from "./needs"
import { layerMapOf, layersOfNames } from "./layers"
import { eraOf } from "./read"
import type { ImportReport } from "./report"
import type { KicadBoard, KicadZone, KicadZoneSeg, Pt } from "./types"

// A KiCad zone as the editor's `Zone` (X3). The file's frame is y down and the editor's is y up, so every point is flipped. A zone keeps
// what the file says (its outline with holes and arcs, layers, net, priority, clearance, minimum width, how its pads join, the thermal
// gap and spoke width, corner smoothing, island rule, keepout flags, teardrop), and the copper is the editor's own fill of it: KiCad's
// stored `filled_polygon` is not kept (docs/kicad-import.md section 10).

const flip = (p: Pt): Vec2 => ({ x: p.x + 0, y: p.y === 0 ? 0 : -p.y })

/** Where a zone's layers are in the editor (X1): the board's copper layers it is on, in stack order; `*.Cu` is all of them, `F&B.Cu` the two outer ones. */
export function zoneCopperLayers(z: KicadZone, board: KicadBoard): CopperLayer[] {
  return layersOfNames(layerMapOf(board), z.layers)
}

/** Whether every layer of a zone is a copper layer (a zone on mask, paste, silkscreen or a user layer is a different thing, X26). */
export function zoneOnlyCopper(z: KicadZone, board: KicadBoard): boolean {
  const names = new Set(board.copper.names)
  return z.layers.length > 0 && z.layers.every((n) => n === "*.Cu" || n === "F&B.Cu" || layerClass(n, names) === "copper")
}

/** One ring of a zone as a closed path of the editor's: corners as lines, arcs through their three points. */
function ringPath(segs: KicadZoneSeg[]): ShapePath | null {
  const out: PathSeg[] = []
  const at: { cur: Vec2 | null; first: Vec2 | null } = { cur: null, first: null }
  const lineTo = (p: Vec2) => {
    if (at.cur && (at.cur.x !== p.x || at.cur.y !== p.y)) out.push({ kind: "line", a: at.cur, b: p })
    at.cur = p
    if (!at.first) at.first = p
  }
  for (const s of segs) {
    if (s.kind === "xy") lineTo(flip(s.at))
    else {
      const start = flip(s.start)
      const end = flip(s.end)
      lineTo(start)
      out.push({ kind: "arc", start, mid: flip(s.mid), end })
      at.cur = end
    }
  }
  if (at.first && at.cur && (at.cur.x !== at.first.x || at.cur.y !== at.first.y)) out.push({ kind: "line", a: at.cur, b: at.first })
  return out.length >= 2 ? { closed: true, segs: out } : null
}

export interface ZoneContext {
  board: KicadBoard
  rules: DesignRules
  /** The project's name for a net, by the file's raw net name. */
  netName: (raw: string) => string | undefined
}

export interface ZoneResult {
  zones: Zone[]
  /** Zones with no fill in the file, which the editor fills (KiCad refills before it plots). */
  unfilled: number
  /** Zones with fewer than three corners, which KiCad ignores. */
  degenerate: number
  /** Zones on a net that no pin carries, which cannot be on a net here. */
  loose: string[]
}

/** The widest line the file draws on Edge.Cuts: KiCad 5's pours kept half of it from the edge, on top of the zone's clearance. */
function edgeWidth(board: KicadBoard): number {
  let w = 0
  for (const s of [...board.shapes, ...board.footprints.flatMap((f) => f.shapes)]) if (s.layer === "Edge.Cuts" && s.width > w) w = s.width
  return w
}

export function convertZones(cx: ZoneContext): ZoneResult {
  const { board, rules } = cx
  const out: Zone[] = []
  let unfilled = 0
  let degenerate = 0
  const loose: string[] = []
  const widest = edgeWidth(board)
  for (const z of board.zones) {
    // A zone with a layer that is not copper among its layers is X26 (the board is refused for it before it gets here).
    if (z.kind === "placement" || !zoneOnlyCopper(z, board)) continue
    const layers = zoneCopperLayers(z, board)
    const paths = z.rings.map(ringPath).filter((p): p is ShapePath => p !== null)
    if (!layers.length || paths.length === 0 || z.rings[0].length < 3) {
      degenerate++
      continue
    }
    const zone: Zone = { id: uid("z"), net: "", layer: layers[0], outline: paths }
    if (layers.length > 1) zone.layers = layers
    if (z.name) zone.name = z.name
    if (z.priority > 0) zone.priority = z.priority
    // KiCad 6 and later order zones of equal priority by uuid (zone.cpp, `HigherPriority`, 6.0 to 10.0); KiCad 5 and earlier cut a zone only out of
    // zones of strictly higher priority (zone_filler.cpp of 5.1), so two zones of equal priority overlap.
    if (["kicad3", "kicad4", "kicad5", "pre6-nightly"].includes(eraOf(board.version))) zone.unordered = true
    else {
      const uuid = z.uuid ? kicadUuid(z.uuid) : undefined
      if (uuid) zone.uuid = uuid
    }
    if (z.locked) zone.locked = true
    if (z.kind === "keepout" || z.kind === "rule-area") {
      zone.keepout = {
        ...(z.keepout?.tracks ? { tracks: true as const } : {}),
        ...(z.keepout?.vias ? { vias: true as const } : {}),
        ...(z.keepout?.pads ? { pads: true as const } : {}),
        ...(z.keepout?.copperpour ? { pour: true as const } : {}),
        ...(z.keepout?.footprints ? { footprints: true as const } : {}),
      }
      out.push(zone)
      continue
    }
    if (z.netRaw) {
      const name = cx.netName(z.netRaw)
      if (name) zone.net = name
    }
    if (z.teardrop) zone.teardrop = z.teardrop
    zone.clearance = z.clearance ?? rules.pourClearance
    zone.minWidth = z.minThickness ?? rules.pourMinWidth
    zone.connect = z.connect === "yes" ? "solid" : z.connect === "no" ? "none" : z.connect === "thru_hole_only" ? "tht" : "thermal"
    zone.thermalGap = z.thermalGap ?? 0.5
    zone.spokeWidth = z.thermalBridge ?? 0.5
    if (z.smoothing !== "none" && z.radius > 0) zone.smoothing = { kind: z.smoothing, radius: z.radius }
    if (z.islandMode === 1) zone.islands = "never"
    else if (z.islandMode === 2) zone.islands = z.islandArea ?? 10
    // KiCad 5 and earlier kept a pour its own clearance and half the edge line's width from the edge, and from a hole with no copper by the
    // pour's clearance (zone_filler.cpp of 5.1, buildZoneFeatureHoleList). KiCad 6 and later keep it from the edge by the board's copper to edge
    // clearance and from such a hole by the board's hole clearance, which are design rules of the project file (`.kicad_pro`), not of the board:
    // the files that have a stored fill show 0.5 mm as the commonest distance from a fill to the edge in every release from 6 to 10, which is
    // KiCad's default, and 0.25 mm is its default hole clearance.
    if (z.strokedFill) zone.edgeGap = Math.round((zone.clearance + widest / 2) * 1e6) / 1e6
    else {
      zone.edgeGap = 0.5
      zone.holeGap = 0.25
    }
    if (!z.filled) unfilled++
    out.push(zone)
  }
  return { zones: out, unfilled, degenerate, loose }
}

export function reportZones(r: ZoneResult, report: ImportReport, all: number) {
  if (!r.zones.length && !r.degenerate) return
  const pours = r.zones.filter((z) => !z.keepout)
  const areas = r.zones.length - pours.length
  if (pours.length) {
    report.entries.push({
      code: "zones-refilled",
      severity: "changed",
      object: `${pours.length} copper zone${pours.length === 1 ? "" : "s"}`,
      why: "The zones are brought in with their outlines, layers, nets, priorities and settings, and the editor fills them itself by KiCad's rules (clearances, thermal reliefs, minimum width, islands, priority). KiCad's own filled copper is not kept: it recomputes it on every refill, and so does the editor on every edit, so the copper can differ from the file's by a few hundredths of a millimetre at corners and thermal reliefs.",
      count: pours.length,
    })
  }
  if (areas) {
    report.entries.push({ code: "rule-areas", severity: "note", object: `${areas} keepout${areas === 1 ? "" : "s"} and rule area${areas === 1 ? "" : "s"}`, why: "Kept as the file has them: what each keeps out (tracks, vias, pads, pours, parts). Pours keep out of the ones that forbid pours, the router and Checks keep to the rest.", count: areas })
  }
  if (r.unfilled) {
    report.entries.push({ code: "zones-unfilled", severity: "changed", object: `${r.unfilled} zone${r.unfilled === 1 ? "" : "s"} with no fill in the file`, why: "KiCad had not filled these zones (it fills them before it plots). The editor fills every zone, so they have copper here.", count: r.unfilled })
  }
  if (r.loose.length) {
    report.entries.push({
      code: "zones-net-without-pins",
      severity: "changed",
      object: `zones on ${r.loose.length === 1 ? "a net" : "nets"} no pin is on (${r.loose.slice(0, 3).join(", ")}${r.loose.length > 3 ? ", ..." : ""})`,
      why: "A net that only copper is on has no place among the editor's nets, which are made of pins. A zone on one keeps clear of the copper of that net instead of joining it, as a pour on no net does.",
      count: r.loose.length,
      items: r.loose,
    })
  }
  if (r.degenerate) {
    report.entries.push({ code: "zones-degenerate", severity: "not-brought", object: `${r.degenerate} zone${r.degenerate === 1 ? "" : "s"} with fewer than three corners, or on no copper layer of the board`, why: "KiCad draws and fills nothing for such a zone, so none was brought in.", count: r.degenerate })
  }
  void all
}
