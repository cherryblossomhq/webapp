import { round } from "../lib/geometry"
import type { ZoneFill } from "../model/pour"
import { flattenPath, type PathSeg, type ShapePath } from "../model/shapes"
import { zoneLayers } from "../model/zones"
import type { CopperLayer, Project, Vec2, Zone } from "../model/types"
import { fractureRings } from "./fracture"

// The KiCad export's zones (X3), written as KiCad 9 writes them (`PCB_IO_KICAD_SEXPR::format( const ZONE* )`, pcbnew/pcb_io/kicad_sexpr/
// pcb_io_kicad_sexpr.cpp): the polygon with its holes and arcs, the layers, net, priority, clearance, minimum width, pad connection, thermal
// gap and spoke width, smoothing, island rule, keepout flags and teardrop attribute, and the copper the editor filled, as `filled_polygon`
// on each layer. A project with a polygon zone has every zone written here (the converter's own pours are taken out of the file first), so
// the file has one writer for its zones; a project of whole-board pours alone still goes through the converter, as it always did.

const mm6 = (n: number) => String(round(n, 6) || 0)
/** Where the converter puts the editor's origin on KiCad's page (`CircuitJsonToKicadPcbConverter`); the native writer's frame has none. */
const PAGE_ORIGIN = 100
export type ToFile = (p: Vec2) => Vec2
const toPage: ToFile = (p) => ({ x: PAGE_ORIGIN + p.x, y: PAGE_ORIGIN - p.y })
const xyOf = (to: ToFile) => (p: Vec2) => {
  const q = to(p)
  return `(xy ${mm6(q.x)} ${mm6(q.y)})`
}
const quote = (text: string) => `"${text.replace(/\r?\n/g, " ").replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
const LAYER: Record<CopperLayer, string> = { top: "F.Cu", bottom: "B.Cu" }

/** A uuid made from the zone's id, so the same project exports the same file. */
function uuidOf(text: string): string {
  let a = 0x811c9dc5
  let b = 0x01000193
  const out: string[] = []
  for (let k = 0; k < 4; k++) {
    for (let i = 0; i < text.length; i++) {
      a = Math.imul(a ^ text.charCodeAt(i), 0x01000193) >>> 0
      b = (Math.imul(b + a, 0x85ebca6b) ^ (a >>> 13)) >>> 0
    }
    out.push((a >>> 0).toString(16).padStart(8, "0"), (b >>> 0).toString(16).padStart(8, "0"))
    text += "~"
  }
  const h = out.join("")
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`
}

function pts(path: ShapePath, to: ToFile): string {
  const xy = xyOf(to)
  const at = (p: Vec2) => {
    const q = to(p)
    return `${mm6(q.x)} ${mm6(q.y)}`
  }
  const out: string[] = []
  const lineTo = (p: Vec2) => out.push(xy(p))
  let first = true
  for (const s of path.segs as PathSeg[]) {
    if (s.kind === "line") {
      if (first) lineTo(s.a)
      lineTo(s.b)
    } else if (s.kind === "arc") {
      if (first) lineTo(s.start)
      out.push(`(arc (start ${at(s.start)}) (mid ${at(s.mid)}) (end ${at(s.end)}))`)
    } else {
      // KiCad has no curve in a zone: it is written as the straight pieces it is flattened to.
      const flat = flattenPath({ closed: false, segs: [s] })
      for (let i = first ? 0 : 1; i < flat.length; i++) lineTo(flat[i])
    }
    first = false
  }
  // The ring closes by itself; a closing point equal to the first is dropped.
  if (out.length > 1 && out[0] === out[out.length - 1]) out.pop()
  return `(pts ${out.join(" ")})`
}

/** The zone as one `(zone ...)` list of KiCad 9. */
export function zoneText(project: Project, z: Zone, fills: ZoneFill[], netNumber: (name: string) => number, boardRings: ShapePath[] | null, fallbackUuid?: () => string, to: ToFile = toPage): string {
  const xy = xyOf(to)
  const rule = z.keepout !== undefined
  const layers = zoneLayers(z)
  const set = {
    clearance: z.clearance ?? project.rules.pourClearance,
    minWidth: z.minWidth ?? project.rules.pourMinWidth,
    connect: z.connect ?? (project.rules.thermalRelief === "direct" ? "solid" : project.rules.thermalRelief === "relief" ? "thermal" : "tht"),
    gap: z.thermalGap ?? z.clearance ?? project.rules.pourClearance,
    spoke: z.spokeWidth ?? project.rules.thermalSpokeWidth,
  }
  const o: string[] = []
  o.push(`  (zone`)
  o.push(`    (net ${rule || !z.net ? 0 : netNumber(z.net)})`)
  o.push(`    (net_name ${quote(rule ? "" : z.net)})`)
  if (z.locked) o.push(`    (locked yes)`)
  o.push(layers.length > 1 ? `    (layers ${layers.map((l) => quote(LAYER[l])).join(" ")})` : `    (layer ${quote(LAYER[layers[0]])})`)
  o.push(`    (uuid ${z.uuid ? `${z.uuid.slice(0, 8)}-${z.uuid.slice(8, 12)}-${z.uuid.slice(12, 16)}-${z.uuid.slice(16, 20)}-${z.uuid.slice(20)}` : fallbackUuid ? fallbackUuid() : uuidOf(z.id)})`)
  if (z.name) o.push(`    (name ${quote(z.name)})`)
  o.push(`    (hatch edge 0.5)`)
  if ((z.priority ?? 0) > 0) o.push(`    (priority ${z.priority})`)
  if (z.teardrop) o.push(`    (attr (teardrop (type ${z.teardrop})))`)
  const join = set.connect === "solid" ? " yes" : set.connect === "none" ? " no" : set.connect === "tht" ? " thru_hole_only" : ""
  o.push(`    (connect_pads${join} (clearance ${mm6(set.clearance)}))`)
  o.push(`    (min_thickness ${mm6(set.minWidth)})`)
  o.push(`    (filled_areas_thickness no)`)
  if (rule) {
    const k = z.keepout!
    const f = (b: boolean | undefined) => (b ? "not_allowed" : "allowed")
    o.push(`    (keepout (tracks ${f(k.tracks)}) (vias ${f(k.vias)}) (pads ${f(k.pads)}) (copperpour ${f(k.pour)}) (footprints ${f(k.footprints)}))`)
    o.push(`    (placement (enabled no) (sheetname ""))`)
  }
  const filled = !rule && fills.some((f) => f.zoneId === z.id)
  const fill = [filled ? " yes" : ""]
  fill.push(` (thermal_gap ${mm6(set.gap)}) (thermal_bridge_width ${mm6(set.spoke)})`)
  if (z.smoothing) fill.push(` (smoothing ${z.smoothing.kind}) (radius ${mm6(z.smoothing.radius)})`)
  if (z.islands !== undefined) fill.push(` (island_removal_mode ${z.islands === "never" ? 1 : 2}) (island_area_min ${mm6(z.islands === "never" ? 10 : z.islands)})`)
  o.push(`    (fill${fill.join("")})`)
  for (const ring of z.outline ?? boardRings ?? []) o.push(`    (polygon ${pts(ring, to)})`)
  if (!rule) {
    for (const layer of layers) {
      const f = fills.find((x) => x.zoneId === z.id && x.layer === layer)
      for (const polygon of f?.polygons ?? []) {
        const ring = polygon.length > 1 ? fractureRings(polygon[0], polygon.slice(1)) : polygon[0]
        o.push(`    (filled_polygon (layer ${quote(LAYER[layer])}) (pts ${ring.map(xy).join(" ")}))`)
      }
    }
  }
  o.push(`  )`)
  return o.join("\n")
}

export interface KicadZones {
  text: string
  notes: string[]
}

/** The board file with every zone of the project written by the editor, in place of the converter's pours. */
export function applyZones(pcb: string, project: Project, fills: ZoneFill[]): KicadZones {
  if (!project.zones.length) return { text: pcb, notes: [] }
  const nets = new Map<string, number>()
  for (const m of pcb.matchAll(/\n {2}\(net (\d+) "((?:[^"\\]|\\.)*)"\)/g)) nets.set(m[2].replace(/\\(.)/g, "$1"), Number(m[1]))
  let next = Math.max(0, ...nets.values()) + 1
  const extra: string[] = []
  const netNumber = (name: string) => {
    const hit = nets.get(name)
    if (hit !== undefined) return hit
    nets.set(name, next)
    extra.push(`  (net ${next} ${quote(name)})`)
    return next++
  }
  const boardRings = (() => {
    const b = project.board
    const hw = b.width / 2
    const hh = b.height / 2
    const p = [
      { x: b.x - hw, y: b.y - hh },
      { x: b.x + hw, y: b.y - hh },
      { x: b.x + hw, y: b.y + hh },
      { x: b.x - hw, y: b.y + hh },
    ]
    return [{ closed: true, segs: p.map((a, i) => ({ kind: "line" as const, a, b: p[(i + 1) % 4] })) }] as ShapePath[]
  })()
  const blocks = project.zones.map((z) => zoneText(project, z, fills, netNumber, boardRings))
  // The converter's own pours come out of the file, and ours go in before its end.
  let text = pcb.replace(/\n {2}\(zone\n[\s\S]*?\n {2}\)(?=\n)/g, "")
  if (extra.length) text = text.replace(/(\n {2}\(net \d+ "[^\n]*\)\n)(?!\s*\(net )/, (m) => `${m}${extra.join("\n")}\n`)
  const end = text.lastIndexOf("\n)")
  text = `${text.slice(0, end)}\n${blocks.join("\n")}${text.slice(end)}`
  const notes: string[] = []
  const whole = project.zones.filter((z) => !z.outline && !z.keepout).length
  if (whole) notes.push(`${whole === 1 ? "A pour that covers the whole board is" : `${whole} pours that cover the whole board are`} written as a polygon of the board's box, which is what it is; the board's edge and the edge clearance cut it back when KiCad fills it.`)
  notes.push("Zones are written with their outlines, layers, nets, priorities and settings, filled as the editor filled them; press B in KiCad to refill them by its own rules. KiCad's thermal reliefs have four spokes; the pour's own spoke count and angle rules do not exist there.")
  return { text, notes }
}
