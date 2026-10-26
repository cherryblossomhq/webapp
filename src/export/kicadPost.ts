import type { AnyCircuitElement } from "circuit-json"
import { round } from "../lib/geometry"
import { findPart } from "../model/library"
import { zoneClearance } from "../model/rules"
import type { ComponentInstance, Project } from "../model/types"

// What `circuit-json-to-kicad` leaves out, put into the files it wrote: no-connect flags, the bill
// of materials fields on each symbol, the board's design rules and the pours' settings. The
// converter's files are KiCad's own S-expressions, so each piece here finds the one block it
// changes by the layout the converter prints (two spaces a level) and leaves the rest alone.

const mm6 = (n: number) => String(round(n, 6) || 0)

/** A string as KiCad reads it: quoted, with the backslash and the quote escaped. */
const quote = (text: string) => `"${text.replace(/\r?\n/g, " ").replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`

// ---------- No-connect flags ----------

export interface SchematicPoint {
  x: number
  y: number
}

/**
 * Where each pin flagged "do not connect" ends, in the circuit's schematic units: the port of a
 * source port with `do_not_connect`.
 */
export function noConnectPins(circuit: AnyCircuitElement[]): SchematicPoint[] {
  const flagged = new Set(circuit.flatMap((e) => (e.type === "source_port" && e.do_not_connect ? [e.source_port_id] : [])))
  return circuit.flatMap((e) => (e.type === "schematic_port" && e.source_port_id && flagged.has(e.source_port_id) ? [{ x: e.center.x, y: e.center.y }] : []))
}

/** The schematic with a no-connect flag at each of the points (in the page's millimetres). */
export function addNoConnects(sch: string, points: SchematicPoint[]): string {
  if (!points.length) return sch
  const flags = points.map((p, i) => `  (no_connect\n    (at ${mm6(p.x)} ${mm6(p.y)})\n    (uuid ${flagUuid(i)})\n  )\n`).join("")
  // After the last top-level item, before the file's closing bracket.
  const end = sch.lastIndexOf("\n)")
  return end < 0 ? sch : `${sch.slice(0, end + 1)}${flags}${sch.slice(end + 1)}`
}

/** A uuid for the nth flag; stable, so two exports of one project differ only in the converter's own random ids. */
function flagUuid(n: number): string {
  const hex = (n + 1).toString(16).padStart(12, "0")
  return `00000000-0000-4000-8000-${hex}`
}

// ---------- Symbol fields ----------

export interface SymbolFields {
  /** Library id of the footprint the board uses. */
  footprint?: string
  datasheet?: string
  description?: string
  /** Further fields in the order they are shown, such as MPN, LCSC and Voltage. */
  extra: [string, string][]
}

const RESERVED = new Set(["reference", "value", "footprint", "datasheet", "description"])
const HANDLED_PROPS = new Set(["mpn", "lcsc", "manufacturer", "datasheet", "description", "footprint"])

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

/** The fields a part's symbol carries: part numbers, and every property the symbol doesn't already show. */
export function symbolFields(c: ComponentInstance, footprintIds: Map<string, string>): SymbolFields {
  const part = findPart(c.partId)
  const props = c.props
  const extra: [string, string][] = []
  const mpn = props.mpn ?? part?.mpn
  if (mpn) extra.push(["MPN", mpn])
  if (props.manufacturer) extra.push(["Manufacturer", props.manufacturer])
  if (props.lcsc) extra.push(["LCSC", props.lcsc])
  for (const [key, value] of Object.entries(props)) {
    if (!value || HANDLED_PROPS.has(key) || key === part?.valueProp || RESERVED.has(key.toLowerCase())) continue
    extra.push([capitalise(key), value])
  }
  return { footprint: footprintIds.get(c.ref), datasheet: props.datasheet, description: part?.description, extra }
}

/** Reference to footprint library id (as written in the board file), read from the board. */
export function boardFootprintIds(pcb: string): Map<string, string> {
  const ids = new Map<string, string>()
  for (const block of pcb.split(/\r?\n {2}\(footprint\b/).slice(1)) {
    const id = block.match(/^\s*"([^"]+)"/)?.[1]
    const ref = block.match(/\(property "Reference" "([^"]*)"/)?.[1]
    if (id && ref) ids.set(ref, id)
  }
  return ids
}

const SYMBOL_BLOCK = /\n {2}\(symbol\n {4}\(lib_id [^\n]*\n[\s\S]*?\n {2}\)(?=\n)/g

function hiddenProperty(key: string, value: string, id: number, x: string, y: string): string {
  return [
    `    (property ${quote(key)} ${quote(value)}`,
    `      (id ${id})`,
    `      (at ${x} ${y} 0)`,
    "      (effects",
    "        (font",
    "          (size 1.27 1.27)",
    "        )",
    "        (hide yes)",
    "      )",
    "    )",
  ].join("\n")
}

/** Fill in the fields of each placed symbol, found by its reference, and add the ones the converter has no place for. */
export function addSymbolFields(sch: string, fields: Map<string, SymbolFields>): string {
  return sch.replace(SYMBOL_BLOCK, (block) => {
    const ref = block.match(/\(property "Reference" "([^"]*)"/)?.[1]
    const f = ref === undefined ? undefined : fields.get(ref)
    if (!f) return block
    let out = block
    const set = (key: string, value: string | undefined) => {
      if (value) out = out.replace(new RegExp(`\\(property "${key}" "[^"]*"`), () => `(property "${key}" ${quote(value)}`)
    }
    set("Footprint", f.footprint)
    set("Datasheet", f.datasheet)
    set("Description", f.description)
    const at = out.match(/\(property "Datasheet"[\s\S]*?\(at (\S+) (\S+) /)
    const ids = [...out.matchAll(/^ {6}\(id (\d+)\)/gm)].map((m) => Number(m[1]))
    let next = ids.length ? Math.max(...ids) + 1 : 5
    const added = f.extra.map(([key, value]) => hiddenProperty(key, value, next++, at?.[1] ?? "0", at?.[2] ?? "0")).join("\n")
    if (!added) return out
    const firstPin = out.search(/\n {4}\(pin "/)
    const at2 = firstPin < 0 ? out.lastIndexOf("\n  )") : firstPin
    return `${out.slice(0, at2)}\n${added}${out.slice(at2)}`
  })
}

// ---------- Board file: pours and mask ----------

const KICAD_LAYER = { top: "F.Cu", bottom: "B.Cu" } as const

/** The board file with each pour's clearance, thinnest neck and thermal relief set from the project, and the mask and paste openings. */
export function applyBoardSettings(pcb: string, project: Project): string {
  const rules = project.rules
  const gaps = new Map<string, number>()
  for (const zone of project.zones) {
    const key = `${zone.net}|${KICAD_LAYER[zone.layer]}`
    gaps.set(key, Math.max(gaps.get(key) ?? 0, zoneClearance(project, zone.clearance)))
  }
  // KiCad writes thermal reliefs as no keyword, solid joins as "yes", and reliefs on through-hole pads only as "thru_hole_only".
  const join = rules.thermalRelief === "direct" ? " yes" : rules.thermalRelief === "relief-tht" ? " thru_hole_only" : ""
  let out = pcb.replace(/\n {2}\(zone\n[\s\S]*?\n {2}\)(?=\n)/g, (zone) => {
    const net = zone.match(/\(net_name (?:"([^"]*)"|(\S+?))\)/)
    const layer = zone.match(/\(layer (\S+?)\)/)?.[1]
    const gap = gaps.get(`${net?.[1] ?? net?.[2]}|${layer}`) ?? zoneClearance(project)
    return zone
      .replace(/\(connect_pads(?: yes| no| thru_hole_only)?(\s*)\(clearance [^)]*\)/, (_, space: string) => `(connect_pads${join}${space}(clearance ${mm6(gap)})`)
      .replace(/\(min_thickness [^)]*\)/, `(min_thickness ${mm6(rules.pourMinWidth)})`)
      .replace(/\(thermal_gap [^)]*\)/, `(thermal_gap ${mm6(gap)})`)
      .replace(/\(thermal_bridge_width [^)]*\)/, `(thermal_bridge_width ${mm6(rules.thermalSpokeWidth)})`)
  })
  out = out.replace(/\(pad_to_mask_clearance [^)]*\)/, `(pad_to_mask_clearance ${mm6(rules.maskExpansion)})`)
  if (rules.pasteExpansion) out = out.replace(/(\(pad_to_mask_clearance [^)]*\))/, `$1\n    (pad_to_paste_clearance ${mm6(rules.pasteExpansion)})`)
  return out
}

// ---------- Project file: design rules, net classes, text variables ----------

type Json = Record<string, unknown>
const object = (parent: Json, key: string): Json => {
  const existing = parent[key]
  if (existing && typeof existing === "object" && !Array.isArray(existing)) return existing as Json
  const made: Json = {}
  parent[key] = made
  return made
}

const MAX_NET_CLASSES = 40

export interface KicadProject {
  text: string
  /** Nets whose widths could not be written, since KiCad reads `*` and `?` in a net class pattern as wildcards. */
  unmatched: string[]
}

/** The .kicad_pro with the project's design rules, default sizes, per-net trace widths and properties. */
export function applyProjectSettings(pro: string, project: Project): KicadProject {
  const rules = project.rules
  const json = JSON.parse(pro) as Json
  const unmatched: string[] = []

  const design = object(object(json, "board"), "design_settings")
  Object.assign(object(design, "rules"), {
    min_clearance: rules.clearance,
    min_track_width: rules.minTraceWidth,
    min_through_hole_diameter: rules.minDrill,
    min_via_annular_width: rules.minAnnularRing,
    min_via_diameter: round(rules.minDrill + 2 * rules.minAnnularRing, 6),
    min_hole_to_hole: rules.holeClearance,
    min_hole_clearance: rules.clearance,
    min_copper_edge_clearance: rules.edgeClearance,
  })
  Object.assign(object(design, "defaults"), {
    track_widths: [0, ...[...new Set([rules.traceWidth, ...rules.preferredWidths])].sort((a, b) => a - b)],
    via_dimensions: [
      { diameter: 0, drill: 0 },
      { diameter: rules.viaDiameter, drill: rules.viaDrill },
    ],
  })

  const base = { clearance: rules.clearance, via_diameter: rules.viaDiameter, via_drill: rules.viaDrill }
  const widths = rules.netWidths ?? {}
  const wideNets = Object.entries(widths).filter(([net, w]) => net && w > 0)
  const widthValues = [...new Set(wideNets.map(([, w]) => w))].sort((a, b) => a - b).slice(0, MAX_NET_CLASSES)
  const className = (w: number) => `Trace ${w} mm`
  const settings = object(json, "net_settings")
  settings.classes = [
    { name: "Default", track_width: rules.traceWidth, ...base },
    ...widthValues.map((w, i) => ({ name: className(w), priority: i, track_width: w, ...base })),
  ]
  const patterns: { netclass: string; pattern: string }[] = []
  for (const [net, w] of wideNets) {
    if (!widthValues.includes(w)) continue
    if (/[*?]/.test(net)) unmatched.push(net)
    else patterns.push({ netclass: className(w), pattern: net })
  }
  settings.netclass_patterns = patterns

  // Project properties as text variables, `${REVISION}` in KiCad's text fields.
  const variables = object(json, "text_variables")
  if (project.description) variables.DESCRIPTION = project.description
  for (const { key, value } of project.properties ?? []) {
    const name = key.trim().replace(/[^A-Za-z0-9_]+/g, "_").toUpperCase()
    if (name && value) variables[name] = value
  }
  return { text: `${JSON.stringify(json, null, 2)}\n`, unmatched }
}

// ---------- Title block ----------

export interface TitleBlock {
  title: string
  date?: string
  revision?: string
  company?: string
  comments: { index: number; text: string }[]
}

/** The schematic's title block: the name, the revision and company if the project's properties have them, and the description and the rest as comments. */
export function titleBlock(project: Project): TitleBlock {
  const props = project.properties ?? []
  const take = (pattern: RegExp) => props.find((p) => p.value && pattern.test(p.key.trim()))
  const revision = take(/^rev(ision)?$/i)
  const company = take(/^(company|organi[sz]ation)$/i)
  const rest = props.filter((p) => p.value && p !== revision && p !== company).map((p) => `${p.key}: ${p.value}`)
  const lines = [...(project.description ? [project.description] : []), ...rest].slice(0, 9)
  const saved = Number.isFinite(project.updatedAt) && project.updatedAt > 0 ? new Date(project.updatedAt) : null
  return {
    title: project.name,
    ...(saved && Number.isFinite(saved.getTime()) ? { date: saved.toISOString().slice(0, 10) } : {}),
    ...(revision ? { revision: revision.value } : {}),
    ...(company ? { company: company.value } : {}),
    comments: lines.map((text, i) => ({ index: i + 1, text })),
  }
}
