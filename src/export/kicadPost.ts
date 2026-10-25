import type { AnyCircuitElement } from "circuit-json"
import { round } from "../lib/geometry"
import { findPart } from "../model/library"
import { classValuesOfClass, hasNetClasses } from "../model/netClasses"
import { kicadAttributes } from "../model/partFlags"
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

// ---------- Board file: footprint attributes, net ties ----------

/**
 * The board file with each footprint's attributes (`(attr smd exclude_from_bom)`) and its net tie and
 * jumper groups set from the project's part flags, found by reference. The converter writes a
 * footprint's attributes from its pads alone, so a part with flags gets its own line instead, and the
 * groups follow it. Parts with no flags are left as the converter wrote them.
 */
export function applyFootprintFlags(pcb: string, project: Project): string {
  const flagged = new Map(project.components.filter((c) => c.flags).map((c) => [c.ref, c.flags!]))
  if (!flagged.size) return pcb
  return pcb.replace(/\n {2}\(footprint\b[\s\S]*?(?=\n {2}\(|\n\)\s*$)/g, (block) => {
    const ref = block.match(/\(property "Reference" "([^"]*)"/)?.[1]
    const flags = ref === undefined ? undefined : flagged.get(ref)
    if (!flags) return block
    // The converter's own words stay (it writes smd or through_hole from the pads, which a part drawn in the editor has no flag for); the flags add to them, and a mounting the flags name replaces the converter's.
    const had = block.match(/\n {4}\(attr([^\n]*)\)/)?.[1].trim().split(/\s+/).filter(Boolean) ?? []
    const words = [...new Set([...kicadAttributes(flags), ...had.filter((w) => !(flags.mount && (w === "smd" || w === "through_hole")))])]
    words.sort((a, b) => Number(!/^(smd|through_hole)$/.test(a)) - Number(!/^(smd|through_hole)$/.test(b)))
    const lines = [`\n    (attr${words.map((a) => ` ${a}`).join("")})`]
    if (flags.jumperDuplicates) lines.push("\n    (duplicate_pad_numbers_are_jumpers yes)")
    if (flags.netTies?.length) lines.push(`\n    (net_tie_pad_groups ${flags.netTies.map((g) => quote(g.join(","))).join(" ")})`)
    if (flags.jumperGroups?.length) lines.push(`\n    (jumper_pad_groups ${flags.jumperGroups.map((g) => `(${g.map(quote).join(" ")})`).join(" ")})`)
    const attr = /\n {4}\(attr[^\n]*\)/
    if (attr.test(block)) return block.replace(attr, () => lines.join(""))
    // No attribute line from the converter: after the position.
    return block.replace(/(\n {4}\(at [^\n]*\))/, (m) => `${m}${lines.join("")}`)
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
  // The mask web, the paste ratio and the mask bridges are board settings in KiCad 9's file (`parseSetup`: `solder_mask_min_width`, `pad_to_paste_clearance_ratio`, `allow_soldermask_bridges_in_footprints`).
  const more = [
    ...(rules.maskMinWidth !== undefined ? [`(solder_mask_min_width ${mm6(rules.maskMinWidth)})`] : []),
    ...(rules.pasteRatio !== undefined ? [`(pad_to_paste_clearance_ratio ${round(rules.pasteRatio, 6)})`] : []),
    ...(rules.maskBridgesInParts ? ["(allow_soldermask_bridges_in_footprints yes)"] : []),
  ]
  if (more.length) out = out.replace(/(\(pad_to_mask_clearance [^)]*\))/, `$1\n    ${more.join("\n    ")}`)
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
  /** What the project's rules hold that the file cannot, in words for whoever exported it. */
  notes: string[]
}

/** A net class pattern that matches exactly one net: KiCad reads it as a wildcard and as a regular expression, and a backslash before each character either reads specially makes the second match the name itself and the first match nothing a board would have. */
const exactPattern = (net: string) => net.replace(/[\\.+*?^$()[\]{}|]/g, "\\$&")

/** The .kicad_pro with the project's design rules, default sizes, per-net trace widths and properties. */
export function applyProjectSettings(pro: string, project: Project): KicadProject {
  const rules = project.rules
  const json = JSON.parse(pro) as Json
  const unmatched: string[] = []
  const notes: string[] = []
  const classed = hasNetClasses(rules)
  // The board's smallest clearance is the lowest any class asks for (KiCad raises every pair to it), or the one the project set; a board with no classes has the rules' own.
  const minClearance = rules.minClearance ?? (classed ? Math.min(rules.clearance, ...(rules.netClasses ?? []).map((c) => c.clearance ?? rules.clearance)) : rules.clearance)

  const design = object(object(json, "board"), "design_settings")
  Object.assign(object(design, "rules"), {
    min_clearance: minClearance,
    min_track_width: rules.minTraceWidth,
    // KiCad 9 has one smallest drill, for vias and through holes alike: the smaller of the two keeps it from flagging what the project allows
    min_through_hole_diameter: rules.minViaDrill !== undefined ? Math.min(rules.minDrill, rules.minViaDrill) : rules.minDrill,
    min_via_annular_width: rules.minAnnularRing,
    min_via_diameter: rules.minViaDiameter ?? round(rules.minDrill + 2 * rules.minAnnularRing, 6),
    min_hole_to_hole: rules.holeClearance,
    min_hole_clearance: rules.clearance,
    min_copper_edge_clearance: rules.edgeClearance,
    ...(rules.maxError !== undefined ? { max_error: rules.maxError } : {}),
  })
  if (rules.minViaDrill !== undefined && rules.minViaDrill !== rules.minDrill) {
    notes.push(`KiCad 9 has one smallest drill for vias and through holes, so the project file has the smaller, ${Math.min(rules.minDrill, rules.minViaDrill)} mm (the project checks vias at ${rules.minViaDrill} mm and through holes at ${rules.minDrill} mm).`)
  }
  Object.assign(object(design, "defaults"), {
    track_widths: [0, ...[...new Set([rules.traceWidth, ...rules.preferredWidths])].sort((a, b) => a - b)],
    via_dimensions: [
      { diameter: 0, drill: 0 },
      { diameter: rules.viaDiameter, drill: rules.viaDrill },
      ...(rules.viaSizes ?? []).filter((v) => !(v.diameter === rules.viaDiameter && v.drill === rules.viaDrill)).map((v) => ({ diameter: v.diameter, drill: v.drill })),
    ],
  })

  const base = { clearance: rules.clearance, via_diameter: rules.viaDiameter, via_drill: rules.viaDrill }
  const widths = rules.netWidths ?? {}
  const wideNets = Object.entries(widths).filter(([net, w]) => net && w > 0)
  const widthValues = [...new Set(wideNets.map(([, w]) => w))].sort((a, b) => a - b).slice(0, MAX_NET_CLASSES)
  const className = (w: number) => `Trace ${w} mm`
  const settings = object(json, "net_settings")
  if (!classed) {
    const d = rules.defaultClass
    settings.classes = [
      { name: "Default", track_width: rules.traceWidth, ...base, ...(d ? defaultFields(d) : {}) },
      ...widthValues.map((w, i) => ({ name: className(w), priority: i, track_width: w, ...base })),
    ]
    const patterns: { netclass: string; pattern: string }[] = []
    for (const [net, w] of wideNets) {
      if (!widthValues.includes(w)) continue
      if (/[*?]/.test(net)) unmatched.push(net)
      else patterns.push({ netclass: className(w), pattern: net })
    }
    settings.netclass_patterns = patterns
  } else {
    // KiCad 9 combines the classes a net is in by priority (lower is first), field by field. A width given to one net is a class of its own that
    // sets only the width and comes first, so it wins over the net's class for the width and leaves its clearance and vias alone; the project's classes
    // follow in their order with every size written, so the first of them a net is in decides all of its sizes.
    const classes = rules.netClasses ?? []
    settings.classes = [
      { name: "Default", track_width: rules.traceWidth, ...base, ...(rules.defaultClass ? defaultFields(rules.defaultClass) : {}) },
      ...widthValues.map((w, i) => ({ name: className(w), priority: i, track_width: w })),
      ...classes.map((c, j) => {
        const v = classValuesOfClass(rules, c.name)
        return {
          name: c.name,
          priority: widthValues.length + j,
          clearance: v.clearance,
          track_width: v.traceWidth,
          via_diameter: v.viaDiameter,
          via_drill: v.viaDrill,
          ...(v.microViaDiameter !== undefined ? { microvia_diameter: v.microViaDiameter } : {}),
          ...(v.microViaDrill !== undefined ? { microvia_drill: v.microViaDrill } : {}),
          ...(v.diffPairWidth !== undefined ? { diff_pair_width: v.diffPairWidth } : {}),
          ...(v.diffPairGap !== undefined ? { diff_pair_gap: v.diffPairGap } : {}),
        }
      }),
    ]
    const patterns: { netclass: string; pattern: string }[] = []
    for (const [net, w] of wideNets) if (widthValues.includes(w)) patterns.push({ netclass: className(w), pattern: exactPattern(net) })
    for (const c of classes) {
      for (const net of c.nets) patterns.push({ netclass: c.name, pattern: exactPattern(net) })
      for (const pattern of c.patterns ?? []) patterns.push({ netclass: c.name, pattern })
    }
    settings.netclass_patterns = patterns
    if (rules.defaultClass?.name || rules.defaultClass?.description) notes.push(`KiCad 9 names the Default net class "Default" and gives it no description, so the project's own ("${rules.defaultClass.name ?? ""}"${rules.defaultClass.description ? `, "${rules.defaultClass.description}"` : ""}) stays in the project.`)
  }
  if (!classed && rules.defaultClass?.description) notes.push(`KiCad 9 gives the Default net class no description, so "${rules.defaultClass.description}" stays in the project.`)

  // Project properties as text variables, `${REVISION}` in KiCad's text fields.
  const variables = object(json, "text_variables")
  if (project.description) variables.DESCRIPTION = project.description
  for (const { key, value } of project.properties ?? []) {
    const name = key.trim().replace(/[^A-Za-z0-9_]+/g, "_").toUpperCase()
    if (name && value) variables[name] = value
  }
  return { text: `${JSON.stringify(json, null, 2)}\n`, unmatched, notes }
}

/** The fields only the Default class has, in KiCad's names. */
function defaultFields(d: NonNullable<Project["rules"]["defaultClass"]>) {
  return {
    ...(d.microViaDiameter !== undefined ? { microvia_diameter: d.microViaDiameter } : {}),
    ...(d.microViaDrill !== undefined ? { microvia_drill: d.microViaDrill } : {}),
    ...(d.diffPairWidth !== undefined ? { diff_pair_width: d.diffPairWidth } : {}),
    ...(d.diffPairGap !== undefined ? { diff_pair_gap: d.diffPairGap } : {}),
  }
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
