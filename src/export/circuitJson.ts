import { fp } from "@tscircuit/footprinter"
import type {
  AnyCircuitElement,
  BRepShape,
  CadComponent,
  PcbComponent,
  PcbCopperPour,
  PcbHole,
  PcbPlatedHole,
  PcbPort,
  PcbSilkscreenPath,
  PcbSilkscreenText,
  PcbSmtPad,
  PcbTrace,
  PcbVia,
  SchematicComponent,
  SchematicNetLabel,
  SchematicPort,
  SchematicText,
  SchematicTrace,
  SourceNet,
  SourcePort,
  SourceTrace,
} from "circuit-json"
import { parseValue } from "../lib/values"
import { emptyBox, expandBox, pointOnSegment, rotate90, round, transformPoint } from "../lib/geometry"
import { computeConnectivity, pinKey } from "../model/connectivity"
import { registerProjectParts } from "../model/customParts"
import { libraryFootprint } from "../model/footprintLibrary"
import { componentFootprint, isNpth, isPhysical, pcbCourtyard, pcbPads, pcbSilk, powerNetName, schematicBounds, schematicPins, slotEnds, valueText, type WorldPad } from "../model/instances"
import { findPart } from "../model/library"
import { boardColors, boardTextStrokeWidth, mountingHoles, ownTexts, roundedOutline } from "../model/board"
import { analyzePcb } from "../model/pcb"
import { worldShapes } from "../model/shapeItems"
import { drawingElements } from "./circuitJsonShapes"
import { textElements } from "./circuitJsonTexts"
import { worldTexts } from "../model/texts"
import { getDesignators, SILK_WIDTH } from "../model/silk"
import type { ComponentInstance, PartDef, PinDef, Project, Rotation, TextAnchor, Vec2 } from "../model/types"

// Circuit JSON, tscircuit's netlist-and-geometry format, written from a project: the inverse of
// `model/circuitJsonImport.ts`. Every part is a source component with its ports, every net a
// source net and trace, and the board, schematic and copper are drawn from the same data the
// editor shows. Pads are in board coordinates (a part's `center` and `rotation` are its origin
// and turn, which is how the importer takes them back into the part's own frame). The schematic is
// in the editor's own units, where one unit is 10 grid squares of KiCad's 50 mil; symbols are
// drawn as schematic paths and circles rather than named after tscircuit's library, since ours
// are drawn by us.

export interface CircuitJsonExport {
  elements: AnyCircuitElement[]
  /** What didn't come across, in words for whoever exported it. */
  notes: string[]
}

const mm = (n: number) => round(n, 4)
const pt = (p: Vec2): Vec2 => ({ x: mm(p.x), y: mm(p.y) })

const numeric = (s: string) => /^\d+$/.test(s)

/** tscircuit's names for what a transistor's pin does, which its own tools and our importer look for. */
const ROLE_NAMES: Record<string, string> = { C: "collector", B: "base", E: "emitter", D: "drain", S: "source", G: "gate" }
const POLARITY: Record<string, string[]> = { "+": ["pos", "anode"], "-": ["neg", "cathode"], A: ["anode", "pos"], K: ["cathode", "neg"] }

const GROUND = /^(GND|AGND|DGND|PGND|VSS|0V|GROUND)$/i

/** tscircuit kinds for the library's parts, by part id; anything else is a chip. */
const FTYPE_BY_PART: Record<string, string> = {
  resistor: "simple_resistor",
  capacitor: "simple_capacitor",
  capacitor_polarized: "simple_capacitor",
  capacitor_tantalum: "simple_capacitor",
  inductor: "simple_inductor",
  diode: "simple_diode",
  schottky: "simple_diode",
  zener: "simple_diode",
  led: "simple_led",
  crystal: "simple_crystal",
  npn: "simple_transistor",
  pnp: "simple_transistor",
  nmos: "simple_mosfet",
  pmos: "simple_mosfet",
  pushbutton: "simple_push_button",
  pushbutton_smd: "simple_push_button",
  slide_switch: "simple_switch",
}

function ftypeOf(part: PartDef): string {
  const known = FTYPE_BY_PART[part.id]
  if (known) return known
  return /^header_/.test(part.id) ? "simple_pin_header" : "simple_chip"
}

/** The number in a value with its unit: "16V" is 16, "100nF" is 1e-7. */
function amount(text: string | undefined): number | undefined {
  const n = parseValue(text)
  return n === null || n === undefined || !Number.isFinite(n) ? undefined : n
}

/** A value as tscircuit prints it: with its unit, "u" as "µ". */
function display(text: string | undefined, unit: string): string | undefined {
  const t = text?.trim()
  if (!t) return undefined
  const bare = t.replace(/(ohms?|Ω)$/i, "").replace(new RegExp(`${unit}$`, "i"), "")
  return `${bare}${unit}`.replace(/u(?=[FH]$)/, "µ")
}

const ANCHORS: Record<TextAnchor, [number, number]> = {
  middle: [0, 0],
  center: [0, 0],
  middle_left: [-1, 0],
  middle_right: [1, 0],
  middle_top: [0, 1],
  middle_bottom: [0, -1],
  top_left: [-1, 1],
  top_right: [1, 1],
  bottom_left: [-1, -1],
  bottom_right: [1, -1],
}

type SchAnchor = NonNullable<SchematicText["anchor"]>

function schAnchor(anchor: TextAnchor, rot: Rotation): SchAnchor {
  const [x, y] = ANCHORS[anchor]
  const r = rotate90({ x, y }, rot)
  const name = (ax: number, ay: number): SchAnchor => {
    if (ax === 0 && ay === 0) return "center"
    if (ay === 0) return ax < 0 ? "left" : "right"
    if (ax === 0) return ay > 0 ? "top" : "bottom"
    return `${ay > 0 ? "top" : "bottom"}_${ax < 0 ? "left" : "right"}` as SchAnchor
  }
  return name(Math.sign(Math.round(r.x)), Math.sign(Math.round(r.y)))
}

const DIR_SIDE = { left: "left", right: "right", up: "top", down: "bottom" } as const
const OPPOSITE = { left: "right", right: "left", up: "down", down: "up" } as const

/** Whether a footprint name is one the footprinter draws, which tscircuit can then draw too. */
function isFootprinterString(name: string): boolean {
  if (libraryFootprint(name)) return false
  try {
    return fp.string(name).circuitJson().some((e) => e.type === "pcb_smtpad" || e.type === "pcb_plated_hole")
  } catch {
    return false
  }
}

function sourceComponent(c: ComponentInstance, part: PartDef, id: string, projectFootprints: Set<string>): AnyCircuitElement {
  const props = c.props
  const mpn = props.mpn ?? part.mpn
  const lcsc = props.lcsc
  const base = {
    type: "source_component" as const,
    source_component_id: id,
    name: c.ref,
    ...(mpn ? { manufacturer_part_number: mpn } : {}),
    ...(lcsc ? { supplier_part_numbers: { jlcpcb: [lcsc] } } : {}),
    ...(valueText(c, part) ? { display_value: valueText(c, part) } : {}),
  }
  const ftype = ftypeOf(part)
  void projectFootprints
  switch (ftype) {
    case "simple_resistor": {
      const text = props.resistance
      return { ...base, ftype, resistance: amount(text) ?? 0, ...(display(text, "Ω") ? { display_resistance: display(text, "Ω") } : {}) }
    }
    case "simple_capacitor": {
      const text = props.capacitance
      const volts = amount(props.voltage)
      return {
        ...base,
        ftype,
        capacitance: amount(text) ?? 0,
        ...(volts ? { max_voltage_rating: volts } : {}),
        ...(display(text, "F") ? { display_capacitance: display(text, "F") } : {}),
      }
    }
    case "simple_inductor": {
      const text = props.inductance
      return { ...base, ftype, inductance: amount(text) ?? 0, ...(display(text, "H") ? { display_inductance: display(text, "H") } : {}) }
    }
    case "simple_led":
      return { ...base, ftype, ...(props.color ? { color: props.color } : {}) }
    case "simple_crystal":
      return { ...base, ftype, frequency: amount(props.frequency?.replace(/mhz$/i, "M")) ?? 0 }
    case "simple_transistor":
      return { ...base, ftype, transistor_type: part.id === "pnp" ? "pnp" : "npn" }
    case "simple_mosfet":
      return { ...base, ftype, channel_type: part.id === "pmos" ? "p" : "n", mosfet_mode: "enhancement" }
    case "simple_pin_header":
      return { ...base, ftype, pin_count: part.pins.length, gender: /female/.test(part.id) ? "female" : "male" }
    default:
      return { ...base, ftype } as AnyCircuitElement
  }
}

/** Hints tscircuit's tools use to tell pins apart: the number, the name, and the role it plays. */
function portHints(part: PartDef, pin: PinDef): string[] {
  const hints = [pin.number]
  if (pin.name && pin.name !== pin.number) hints.push(pin.name)
  if (FTYPE_BY_PART[part.id] === "simple_transistor" || FTYPE_BY_PART[part.id] === "simple_mosfet") {
    const role = ROLE_NAMES[pin.name]
    if (role) hints.push(role)
  }
  if (part.id.startsWith("capacitor_") || FTYPE_BY_PART[part.id] === "simple_diode" || FTYPE_BY_PART[part.id] === "simple_led") {
    hints.push(...(POLARITY[pin.name] ?? []))
  }
  return [...new Set(hints)]
}

/** Pads of a part's footprint, one element each, tied to the port of the pin they carry. */
function padElements(c: ComponentInstance, pcbComponentId: string, portIds: Map<string, string>, ids: { next: (prefix: string) => string }): (PcbSmtPad | PcbPlatedHole | PcbHole)[] {
  const out: (PcbSmtPad | PcbPlatedHole | PcbHole)[] = []
  for (const pad of pcbPads(c)) {
    if (isNpth(pad)) {
      out.push(npthElement(pad, pcbComponentId, ids.next("pcb_hole")))
      continue
    }
    const link = {
      pcb_component_id: pcbComponentId,
      port_hints: [...new Set([pad.padNumber, pad.pin].filter((h): h is string => !!h))],
      ...(pad.pin && portIds.has(pad.pin) ? { pcb_port_id: portIds.get(pad.pin) } : {}),
    }
    out.push(pad.holeDiameter ? platedHole(pad, link, ids.next("pcb_plated_hole")) : smtPad(pad, link, pad.layers[0], ids.next("pcb_smtpad")))
  }
  return out
}

interface PadLink {
  pcb_component_id: string
  port_hints: string[]
  pcb_port_id?: string
}

function smtPad(pad: WorldPad, link: PadLink, layer: "top" | "bottom", id: string): PcbSmtPad {
  const at = { x: mm(pad.x), y: mm(pad.y) }
  const common = { pcb_smtpad_id: id, layer, ...link, is_covered_with_solder_mask: false }
  if (pad.shape === "polygon" && pad.points?.length) return { type: "pcb_smtpad", shape: "polygon", points: pad.points.map(pt), ...common }
  if (pad.shape === "circle") return { type: "pcb_smtpad", shape: "circle", ...at, radius: mm(pad.width / 2), ...common }
  if (pad.shape === "pill") {
    return { type: "pcb_smtpad", shape: "pill", ...at, width: mm(pad.width), height: mm(pad.height), radius: mm(Math.min(pad.width, pad.height) / 2), ...common }
  }
  return { type: "pcb_smtpad", shape: "rect", ...at, width: mm(pad.width), height: mm(pad.height), ...common }
}

function platedHole(pad: WorldPad, link: PadLink, id: string): PcbPlatedHole {
  const at = { x: mm(pad.x), y: mm(pad.y) }
  const drill = pad.holeDiameter!
  const common = { pcb_plated_hole_id: id, layers: ["top", "bottom"] as ("top" | "bottom")[], ...link, is_covered_with_solder_mask: false }
  const slot = slotEnds(pad)
  const along = pad.width >= pad.height
  const hole = slot ? { hole_width: mm(along ? pad.slotLength! : drill), hole_height: mm(along ? drill : pad.slotLength!) } : { hole_width: mm(drill), hole_height: mm(drill) }
  if (pad.shape === "polygon" && pad.points?.length) {
    return {
      type: "pcb_plated_hole",
      shape: "hole_with_polygon_pad",
      hole_shape: slot ? "pill" : "circle",
      ...(slot ? hole : { hole_diameter: mm(drill) }),
      pad_outline: pad.points.map((p) => ({ x: mm(p.x - pad.x), y: mm(p.y - pad.y) })),
      ...at,
      ...common,
    } as PcbPlatedHole
  }
  if (pad.shape === "rect") {
    if (slot) {
      return { type: "pcb_plated_hole", shape: "pill_hole_with_rect_pad", hole_shape: "pill", pad_shape: "rect", ...hole, hole_offset_x: 0, hole_offset_y: 0, rect_pad_width: mm(pad.width), rect_pad_height: mm(pad.height), ...at, ...common }
    }
    return { type: "pcb_plated_hole", shape: "circular_hole_with_rect_pad", hole_shape: "circle", pad_shape: "rect", hole_diameter: mm(drill), hole_offset_x: 0, hole_offset_y: 0, rect_pad_width: mm(pad.width), rect_pad_height: mm(pad.height), ...at, ...common }
  }
  if (pad.shape === "circle" && !slot) {
    return { type: "pcb_plated_hole", shape: "circle", outer_diameter: mm(pad.width), hole_diameter: mm(drill), ...at, ...common }
  }
  return {
    type: "pcb_plated_hole",
    shape: "pill",
    outer_width: mm(pad.width),
    outer_height: mm(pad.height),
    ...hole,
    ccw_rotation: 0,
    ...at,
    ...common,
  }
}

function npthElement(pad: WorldPad, pcbComponentId: string | undefined, id: string): PcbHole {
  const at = { x: mm(pad.x), y: mm(pad.y) }
  const owner = pcbComponentId ? { pcb_component_id: pcbComponentId } : {}
  if (pad.slotLength && pad.slotLength > pad.holeDiameter! + 1e-6) {
    const along = pad.width >= pad.height
    return { type: "pcb_hole", pcb_hole_id: id, hole_shape: "pill", hole_width: mm(along ? pad.slotLength : pad.holeDiameter!), hole_height: mm(along ? pad.holeDiameter! : pad.slotLength), ...at, ...owner }
  }
  return { type: "pcb_hole", pcb_hole_id: id, hole_shape: "circle", hole_diameter: mm(pad.holeDiameter!), ...at, ...owner }
}

/** Project to Circuit JSON, with notes on what it could not carry. */
export function projectToCircuitJson(project: Project, options: { nameAllNets?: boolean; forKicad?: boolean } = {}): CircuitJsonExport {
  registerProjectParts(project)
  const notes: string[] = []
  const elements: AnyCircuitElement[] = []
  const counters = new Map<string, number>()
  const ids = {
    next(prefix: string) {
      const n = counters.get(prefix) ?? 0
      counters.set(prefix, n + 1)
      return `${prefix}_${n}`
    },
  }
  const projectFootprints = new Set((project.footprints ?? []).map((f) => f.name))

  const sch = computeConnectivity(project)
  const pcb = analyzePcb(project, sch)
  const designators = getDesignators(project)

  elements.push({ type: "source_project_metadata", name: project.name, software_used_string: "Cherry Blossom", created_at: new Date(project.createdAt).toISOString() })

  // ---------- Nets ----------
  const netIds = new Map<string, string>()
  for (const net of sch.nets) {
    // KiCad has no net without a name, so its export names the ones tscircuit leaves as a trace.
    if (!net.named && !(options.nameAllNets && net.pins.length >= 2)) continue
    const id = ids.next("source_net")
    netIds.set(net.id, id)
    const ground = GROUND.test(net.name) || project.components.some((c) => findPart(c.partId)?.powerNet && powerNetName(c) === net.name && findPart(c.partId)?.pins[0]?.kind === "ground")
    const power = !ground && (project.components.some((c) => findPart(c.partId)?.powerNet && powerNetName(c) === net.name))
    const element: SourceNet = {
      type: "source_net",
      source_net_id: id,
      name: net.name,
      member_source_group_ids: [],
      ...(ground ? { is_ground: true } : {}),
      ...(power ? { is_power: true } : {}),
    }
    elements.push(element)
  }

  // ---------- Parts: source, schematic and board ----------
  const portIds = new Map<string, string>()
  const parts: { c: ComponentInstance; part: PartDef; sourceId: string; pcbId: string; schId: string }[] = []
  const unknown: string[] = []
  const droppedProps = new Set<string>()
  const ncPins = new Set(project.components.flatMap((c) => (c.nc ?? []).map((pin) => pinKey(c.id, pin))))

  for (const c of project.components) {
    const part = findPart(c.partId)
    if (!part) {
      unknown.push(c.ref)
      continue
    }
    if (!isPhysical(part)) continue
    const sourceId = ids.next("source_component")
    const pcbId = ids.next("pcb_component")
    const schId = ids.next("schematic_component")
    parts.push({ c, part, sourceId, pcbId, schId })
    elements.push(sourceComponent(c, part, sourceId, projectFootprints))
    const kept = new Set(["mpn", "lcsc", part.valueProp ?? "", ...(FTYPE_BY_PART[part.id] === "simple_resistor" ? ["resistance"] : []), ...(FTYPE_BY_PART[part.id] === "simple_capacitor" ? ["capacitance", "voltage"] : []), ...(FTYPE_BY_PART[part.id] === "simple_inductor" ? ["inductance"] : []), ...(FTYPE_BY_PART[part.id] === "simple_led" ? ["color"] : []), ...(FTYPE_BY_PART[part.id] === "simple_crystal" ? ["frequency"] : [])])
    for (const [k, v] of Object.entries(c.props)) if (v && !kept.has(k)) droppedProps.add(k)

    for (const pin of part.pins) {
      const id = ids.next("source_port")
      portIds.set(pinKey(c.id, pin.number), id)
      const port: SourcePort = {
        type: "source_port",
        source_port_id: id,
        source_component_id: sourceId,
        name: pin.name || pin.number,
        ...(numeric(pin.number) ? { pin_number: Number(pin.number) } : {}),
        port_hints: portHints(part, pin),
        ...(ncPins.has(pinKey(c.id, pin.number)) ? { do_not_connect: true } : {}),
      }
      elements.push(port)
    }
  }

  // ---------- Connectivity ----------
  const traceIds = new Map<string, string>()
  for (const net of sch.nets) {
    const ports = net.pins.map((p) => portIds.get(pinKey(p.componentId, p.pin))).filter((p): p is string => !!p)
    const netId = netIds.get(net.id)
    if (!ports.length || (ports.length < 2 && !netId)) continue
    const id = ids.next("source_trace")
    traceIds.set(net.id, id)
    const trace: SourceTrace = { type: "source_trace", source_trace_id: id, connected_source_port_ids: ports, connected_source_net_ids: netId ? [netId] : [] }
    elements.push(trace)
  }

  // ---------- Board ----------
  const b = project.board
  const colors = boardColors(b)
  const rules = project.rules
  const roundedBoard = b.cornerRadius > 1e-6
  const r = Math.max(0, Math.min(b.cornerRadius, b.width / 2, b.height / 2))
  elements.push({
    type: "pcb_board",
    pcb_board_id: "pcb_board_0",
    center: pt(b),
    width: mm(b.width),
    height: mm(b.height),
    thickness: b.thickness,
    num_layers: 2,
    material: "fr4",
    ...(roundedBoard ? { outline: roundedOutline(b.x - b.width / 2, b.y - b.height / 2, b.x + b.width / 2, b.y + b.height / 2, r) } : {}),
    solder_mask_color: colors.mask,
    silkscreen_color: colors.silk,
    is_via_in_pad_allowed: rules.viaInPad,
    default_via_tented_on_top: rules.tentVias,
    default_via_tented_on_bottom: rules.tentVias,
    min_trace_width: rules.minTraceWidth,
    min_board_edge_clearance: rules.edgeClearance,
    min_via_hole_diameter: rules.minDrill,
    min_via_hole_edge_to_via_hole_edge_clearance: rules.holeClearance,
    min_plated_hole_drill_edge_to_drill_edge_clearance: rules.holeClearance,
    min_different_net_trace_edge_to_trace_edge_clearance: rules.clearance,
    min_trace_to_pad_edge_clearance: rules.clearance,
    min_pad_edge_to_pad_edge_clearance: rules.clearance,
  })
  for (const hole of mountingHoles(b)) {
    elements.push({
      type: "pcb_plated_hole",
      pcb_plated_hole_id: ids.next("pcb_plated_hole"),
      shape: "circle",
      x: mm(hole.x),
      y: mm(hole.y),
      outer_diameter: hole.diameter,
      hole_diameter: hole.drill,
      layers: ["top", "bottom"],
      pcb_component_id: undefined,
      is_covered_with_solder_mask: false,
    } as PcbPlatedHole)
  }

  // ---------- Each part on the board ----------
  const cad: CadComponent[] = []
  for (const { c, part, sourceId, pcbId, schId } of parts) {
    const fpDef = componentFootprint(c)
    const box = emptyBox()
    const court = pcbCourtyard(c)
    if (court) {
      expandBox(box, { x: court.minX, y: court.minY })
      expandBox(box, { x: court.maxX, y: court.maxY })
    }
    const pads = pcbPads(c)
    for (const p of pads) {
      expandBox(box, { x: p.x - p.width / 2, y: p.y - p.height / 2 })
      expandBox(box, { x: p.x + p.width / 2, y: p.y + p.height / 2 })
    }
    const component: PcbComponent = {
      type: "pcb_component",
      pcb_component_id: pcbId,
      source_component_id: sourceId,
      center: pt(c.pcb),
      layer: c.pcb.side,
      rotation: c.pcb.rot,
      width: Number.isFinite(box.minX) ? mm(box.maxX - box.minX) : 0,
      height: Number.isFinite(box.minY) ? mm(box.maxY - box.minY) : 0,
      obstructs_within_bounds: false,
    }
    elements.push(component)

    const portOf = new Map(part.pins.map((p) => [p.number, p.number]))
    const pcbPortIds = new Map<string, string>()
    for (const pin of portOf.keys()) {
      const source = portIds.get(pinKey(c.id, pin))
      if (!source) continue
      const owned = pads.filter((p) => p.pin === pin && !isNpth(p))
      if (!owned.length) continue
      const id = ids.next("pcb_port")
      pcbPortIds.set(pin, id)
      const port: PcbPort = {
        type: "pcb_port",
        pcb_port_id: id,
        source_port_id: source,
        pcb_component_id: pcbId,
        x: mm(owned[0].x),
        y: mm(owned[0].y),
        layers: [...new Set(owned.flatMap((p) => p.layers))],
      }
      elements.push(port)
    }
    elements.push(...padElements(c, pcbId, pcbPortIds, ids))

    if (fpDef) {
      for (const path of pcbSilk(c)) {
        if (path.length < 2) continue
        const silk: PcbSilkscreenPath = { type: "pcb_silkscreen_path", pcb_silkscreen_path_id: ids.next("pcb_silkscreen_path"), pcb_component_id: pcbId, layer: c.pcb.side, route: path.map(pt), stroke_width: SILK_WIDTH }
        elements.push(silk)
      }
      if (court) {
        elements.push({
          type: "pcb_courtyard_rect",
          pcb_courtyard_rect_id: ids.next("pcb_courtyard_rect"),
          pcb_component_id: pcbId,
          center: { x: mm((court.minX + court.maxX) / 2), y: mm((court.minY + court.maxY) / 2) },
          width: mm(court.maxX - court.minX),
          height: mm(court.maxY - court.minY),
          layer: c.pcb.side,
        })
      }
    }
    const d = designators.get(c.id)
    if (d) {
      const text: PcbSilkscreenText = {
        type: "pcb_silkscreen_text",
        pcb_silkscreen_text_id: ids.next("pcb_silkscreen_text"),
        font: "tscircuit2024",
        pcb_component_id: pcbId,
        text: d.text,
        font_size: d.size,
        anchor_position: pt(d),
        anchor_alignment: "center",
        ccw_rotation: d.rot,
        layer: d.side,
        ...(d.side === "bottom" ? { is_mirrored: true } : {}),
      }
      elements.push(text)
    }
    if (isFootprinterString(c.footprint)) {
      cad.push({
        type: "cad_component",
        cad_component_id: ids.next("cad_component"),
        pcb_component_id: pcbId,
        source_component_id: sourceId,
        position: { x: mm(c.pcb.x), y: mm(c.pcb.y), z: c.pcb.side === "top" ? b.thickness / 2 : -b.thickness / 2 },
        rotation: { x: c.pcb.side === "top" ? 0 : 180, y: 0, z: c.pcb.rot },
        layer: c.pcb.side,
        footprinter_string: c.footprint,
        model_object_fit: "contain_within_bounds",
        anchor_alignment: "center",
      })
    }
    void schId
  }
  elements.push(...cad)

  // Free silkscreen text.
  for (const t of ownTexts(project)) {
    elements.push({
      type: "pcb_silkscreen_text",
      pcb_silkscreen_text_id: ids.next("pcb_silkscreen_text"),
      font: "tscircuit2024",
      pcb_component_id: "",
      text: t.text,
      font_size: t.size,
      anchor_position: pt(t),
      anchor_alignment: "center",
      ccw_rotation: t.rot,
      layer: t.side,
      ...(t.side === "bottom" ? { is_mirrored: true } : {}),
    })
    void boardTextStrokeWidth
  }

  // ---------- Copper ----------
  const netNameOf = new Map(sch.nets.map((n) => [n.id, n.name]))
  for (const t of project.traces) {
    const netId = pcb.traceNet.get(t.id)
    const trace: PcbTrace = {
      type: "pcb_trace",
      pcb_trace_id: ids.next("pcb_trace"),
      ...(netId && traceIds.has(netId) ? { source_trace_id: traceIds.get(netId) } : {}),
      route: t.points.map((p) => ({ route_type: "wire" as const, x: mm(p.x), y: mm(p.y), width: t.width, layer: t.layer })),
    }
    elements.push(trace)
  }
  for (const v of project.vias) {
    const netId = pcb.viaNet.get(v.id)
    const via: PcbVia = {
      type: "pcb_via",
      pcb_via_id: ids.next("pcb_via"),
      x: mm(v.x),
      y: mm(v.y),
      outer_diameter: v.diameter,
      hole_diameter: v.drill,
      layers: ["top", "bottom"],
      from_layer: "top",
      to_layer: "bottom",
      ...(netId && netIds.has(netId) ? { source_net_id: netIds.get(netId) } : {}),
    }
    elements.push(via)
  }
  const emptyZones: string[] = []
  for (const fill of pcb.zoneFills) {
    const netId = fill.netId ?? sch.nets.find((n) => n.name === fill.netName)?.id
    const sourceNetId = netId ? netIds.get(netId) : undefined
    if (!fill.polygons.length) {
      emptyZones.push(`${fill.netName} (${fill.layer})`)
      continue
    }
    for (const polygon of fill.polygons) {
      const ring = (points: Vec2[]) => ({ vertices: points.map(pt) })
      const brep: BRepShape = { outer_ring: ring(polygon[0]), inner_rings: polygon.slice(1).map(ring) }
      const pour: PcbCopperPour = {
        type: "pcb_copper_pour",
        pcb_copper_pour_id: ids.next("pcb_copper_pour"),
        layer: fill.layer,
        shape: "brep",
        brep_shape: brep,
        covered_with_solder_mask: true,
        ...(sourceNetId ? { source_net_id: sourceNetId } : {}),
      }
      elements.push(pour)
    }
  }
  void netNameOf

  // ---------- Drawings ----------
  // The KiCad export writes them itself, exactly, so they are left out of the circuit it converts.
  const drawingNotes: string[] = []
  if (!options.forKicad && worldShapes(project).some((s) => s.placed)) {
    const drawn = drawingElements(project, {
      pcbIds: new Map(parts.map((p) => [p.c.id, p.pcbId])),
      next: (prefix) => ids.next(prefix),
      netOf: (name) => {
        const netId = sch.nets.find((n) => n.name === name)?.id
        return netId ? { net: netIds.get(netId), trace: traceIds.get(netId) } : {}
      },
    })
    elements.push(...drawn.elements)
    drawingNotes.push("Drawings: silkscreen and fabrication drawings, closed courtyard shapes, and copper drawings (strokes as traces, fills as pours) are in the file, with curves, ellipses, arcs in polygons and dashed lines flattened to points.")
    if (drawn.left.size) drawingNotes.push(`Left out, since Circuit JSON has no element for them: ${[...drawn.left].map(([what, n]) => `${n} ${what}`).join(", ")}. Solder mask, paste and adhesive drawings are always left out.`)
    else drawingNotes.push("Solder mask, paste, adhesive and user layer drawings have no element in Circuit JSON and are left out.")
  }

  // ---------- Text of a board brought in from KiCad ----------
  // The KiCad export writes it itself, with its pen, justification and every attribute, so it is left out of the circuit it converts.
  if (!options.forKicad && worldTexts(project).some((t) => t.placed && !t.hidden)) {
    const written = textElements(project, { pcbIds: new Map(parts.map((p) => [p.c.id, p.pcbId])), next: (prefix) => ids.next(prefix) })
    elements.push(...written.elements)
    drawingNotes.push("Text: silkscreen, copper and fabrication text is in the file with its size, place, turn, mirror and knockout, its variables resolved; Circuit JSON has no pen width, bold or italic, which are left out.")
    if (written.left.size) drawingNotes.push(`Text left out, since Circuit JSON has no element for it: ${[...written.left].map(([what, n]) => `${n} on ${what}`).join(", ")}.`)
    if (written.boxes) drawingNotes.push(`${written.boxes} text box${written.boxes > 1 ? "es are" : " is"} written as its text alone, with no box or border.`)
  }

  // ---------- Schematic ----------
  for (const { c, part, sourceId, schId } of parts) {
    const bounds = schematicBounds(c, part)
    const component: SchematicComponent = {
      type: "schematic_component",
      schematic_component_id: schId,
      source_component_id: sourceId,
      center: pt({ x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 }),
      size: { width: mm(bounds.maxX - bounds.minX), height: mm(bounds.maxY - bounds.minY) },
      // Drawn as the paths and text below, not as tscircuit's box with pins.
      is_box_with_pins: false,
    }
    elements.push(component)
    for (const pin of schematicPins(c, part)) {
      const source = portIds.get(pinKey(c.id, pin.pin))
      if (!source) continue
      const port: SchematicPort = {
        type: "schematic_port",
        schematic_port_id: ids.next("schematic_port"),
        schematic_component_id: schId,
        source_port_id: source,
        center: pt(pin.pos),
        facing_direction: pin.dir,
        side_of_component: DIR_SIDE[pin.dir],
        ...(numeric(pin.pin) ? { pin_number: Number(pin.pin) } : {}),
      }
      elements.push(port)
    }
    for (const p of part.symbol.primitives) {
      if (p.type === "path") {
        const points = p.points.map((q) => pt(transformPoint(q, c.sch, c.sch.rot)))
        elements.push({
          type: "schematic_path",
          schematic_path_id: ids.next("schematic_path"),
          schematic_component_id: schId,
          points,
          is_filled: p.fill,
          is_dashed: false,
          stroke_width: p.width ?? 0.01,
        })
      } else if (p.type === "circle") {
        elements.push({
          type: "schematic_circle",
          schematic_circle_id: ids.next("schematic_circle"),
          schematic_component_id: schId,
          center: pt(transformPoint(p, c.sch, c.sch.rot)),
          radius: p.radius,
          color: "#000000",
          is_filled: p.fill,
          is_dashed: false,
          stroke_width: 0.01,
        })
      } else {
        const text = p.role === "ref" ? c.ref : p.role === "value" ? valueText(c, part) : p.text
        if (!text) continue
        const vertical = c.sch.rot === 90 || c.sch.rot === 270
        const pinText = p.role === "pin" || p.role === "pinNumber"
        const turned = pinText && (p.alongPin ? !vertical : vertical)
        const el: SchematicText = {
          type: "schematic_text",
          schematic_text_id: ids.next("schematic_text"),
          schematic_component_id: schId,
          text,
          font_size: p.size ?? 0.1,
          position: pt(transformPoint(p, c.sch, c.sch.rot)),
          rotation: turned ? 90 : 0,
          anchor: schAnchor(p.anchor, c.sch.rot),
          color: "#000000",
        }
        elements.push(el)
      }
    }
  }

  // Power ports are net labels with their symbol.
  for (const c of project.components) {
    const part = findPart(c.partId)
    const net = powerNetName(c, part)
    if (!part || !net) continue
    const pin = schematicPins(c, part)[0]
    const netId = sch.nets.find((n) => n.name === net)?.id
    const sourceNetId = netId ? netIds.get(netId) : undefined
    if (!pin || !sourceNetId) continue
    const ground = part.pins[0]?.kind === "ground"
    const label: SchematicNetLabel = {
      type: "schematic_net_label",
      schematic_net_label_id: ids.next("schematic_net_label"),
      source_net_id: sourceNetId,
      text: net,
      anchor_position: pt(pin.pos),
      center: pt(pin.pos),
      anchor_side: pin.dir === "up" ? "top" : pin.dir === "down" ? "bottom" : pin.dir,
      symbol_name: `${ground ? "ground" : "vcc"}_${OPPOSITE[pin.dir]}`,
    }
    elements.push(label)
  }

  const labelAnchor = { 0: "left", 90: "bottom", 180: "right", 270: "top" } as const
  for (const l of project.labels) {
    const netId = sch.labelNet.get(l.id)
    const sourceNetId = netId ? netIds.get(netId) : undefined
    if (!sourceNetId) continue
    elements.push({
      type: "schematic_net_label",
      schematic_net_label_id: ids.next("schematic_net_label"),
      source_net_id: sourceNetId,
      text: l.name,
      anchor_position: pt(l),
      center: pt(l),
      anchor_side: labelAnchor[l.rot],
      ...(traceIds.has(netId!) ? { source_trace_id: traceIds.get(netId!) } : {}),
    })
  }

  for (const w of project.wires) {
    if (w.points.length < 2) continue
    const netId = sch.wireNet.get(w.id)
    const edges = w.points.slice(1).map((to, i) => ({ from: pt(w.points[i]), to: pt(to) }))
    const junctions = sch.junctions.filter((j) => w.points.some((p, i) => i > 0 && pointOnSegment(j, w.points[i - 1], p))).map(pt)
    const trace: SchematicTrace = {
      type: "schematic_trace",
      schematic_trace_id: ids.next("schematic_trace"),
      ...(netId && traceIds.has(netId) ? { source_trace_id: traceIds.get(netId) } : {}),
      edges,
      junctions,
    }
    elements.push(trace)
  }

  // ---------- Notes ----------
  // The KiCad export says what it carries in its own words, since it carries more than Circuit JSON has a field for.
  const kicad = options.forKicad === true
  if (unknown.length) notes.push(`Left out ${unknown.length === 1 ? "a part" : `${unknown.length} parts`} the library no longer has: ${unknown.join(", ")}.`)
  if (droppedProps.size && !kicad) notes.push(`Part properties with no field in Circuit JSON were left out: ${[...droppedProps].sort().join(", ")}. Values, part numbers and LCSC numbers are kept.`)
  if (project.zones.length && !kicad) notes.push("Copper pours are exported as the copper they fill, not as pours that refill: change a pour's settings in Cherry Blossom, not after the export.")
  if (emptyZones.length) notes.push(`Pours that fill nothing were left out: ${emptyZones.join(", ")}.`)
  if (project.drawings?.length) notes.push("The schematic's drawings (texts, lines and shapes) are left out.")
  if (project.footprints?.length || project.parts?.length) notes.push("Parts and land patterns made for the project are exported as the parts and pads they are; they have no link to a library in the other tool.")
  if (!kicad) {
    if (project.description || project.properties?.length) notes.push("The project's description and properties (revision, author and the like) are left out: Circuit JSON has no field for them.")
    notes.push("The 3D view, the net trace widths and the pour and mask settings stay in Cherry Blossom; the design rules the board states (trace width, clearances, drills) are in the board.")
  }
  void projectFootprints
  notes.push(...drawingNotes)
  return { elements, notes }
}

/** The text of the .json file and the notes to show with it. */
export function circuitJsonFile(project: Project): { text: string; notes: string[] } {
  const { elements, notes } = projectToCircuitJson(project)
  // One element a line, as tscircuit's own tools write it: readable and diffable without the size of indenting every field.
  return { text: `[\n${elements.map((e) => JSON.stringify(e)).join(",\n")}\n]\n`, notes }
}
