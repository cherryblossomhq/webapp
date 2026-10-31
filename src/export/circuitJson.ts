import { flattenHierarchy } from "./flatten"
import { variantExportNotes } from "../model/variants"
import { fp } from "@tscircuit/footprinter"
import { copperCount, copperLayers, viaLayers } from "../model/stack"
import { arcPolyline, isArcTrace } from "../model/arcTracks"
import { viaTentedOn } from "../model/viaRules"
import type { CopperLayer } from "../model/types"
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
import { emptyBox, expandBox, orientPoint, pointOnSegment, rotate90, round } from "../lib/geometry"
import { anchorFromAxes, justifyAnchor, justifyOf, orientText } from "../ai/vision/svg"
import { computeConnectivity, pinKey } from "../model/connectivity"
import { registerProjectParts } from "../model/customParts"
import { libraryFootprint } from "../model/footprintLibrary"
import { componentFootprint, isNpth, isSchematicPart, pcbCourtyard, pcbPads, pcbSilk, powerNetName, schematicBounds, schematicPins, slotEnds, unitOwners, valueText, type WorldPad } from "../model/instances"
import { findPart } from "../model/library"
import { holeCentre, padOutline } from "../model/padDistance"
import { boardColors, boardTextStrokeWidth, mountingHoles, ownTexts, roundedOutline } from "../model/board"
import { outlineRegionsAt, outlineState, signedArea } from "../model/outline"
import { analyzePcbOnce } from "../model/pcb"
import { flattenPath } from "../model/shapes"
import { withPartZones } from "../model/partZones"
import { isOtherZone, kicadWritesZones, zoneLayers } from "../model/zones"
import { worldShapes } from "../model/shapeItems"
import { drawingElements } from "./circuitJsonShapes"
import { textElements } from "./circuitJsonTexts"
import { mm } from "./circuitJsonUnits"
import { worldTexts } from "../model/texts"
import { arcOf, samplePrimitive } from "../model/primitiveGeometry"
import { componentFields, FIELD_SIZE, pinDisplayName, pinTexts, symbolOf, symbolTextOnSheet, unitCount, unitLetters } from "../model/symbolDrawing"
import { pinTypeOfKind } from "../model/pinKinds"
import { getDesignators, SILK_WIDTH } from "../model/silk"
import { withRuleAreaFlags, withRuleAreaFlagsOnly } from "../model/ruleAreas"
import { BUS_WIDTH, boxCorners, boxTextAt, directiveShape, isExact, lookOfText } from "../model/sheetItems"
import type { ComponentInstance, Mirror, PartDef, PinDef, PinType, Project, Rotation, SchematicDrawing, SheetFill, SheetStroke, ShapeLook, SymbolPrimitive, TextAnchor, TextLook, Vec2 } from "../model/types"
import { onBoard } from "../model/partFlags"

// Circuit JSON, tscircuit's netlist-and-geometry format, written from a project: the inverse of
// `model/circuitJsonImport.ts`. Every part is a source component with its ports, every net a
// source net and trace, and the board, schematic and copper are drawn from the same data the
// editor shows. Pads are in board coordinates (a part's `center` and `rotation` are its origin
// and turn, which is how the importer takes them back into the part's own frame). The schematic is
// in the editor's own units, where one unit is 10 grid squares of KiCad's 50 mil; symbols are
// drawn as schematic paths and circles rather than named after tscircuit's library, since ours
// are drawn by us.

/** A text of a symbol that has a place of its own: where it is anchored, in the schematic's units, and how it is set. */
export interface PlacedText {
  text: string
  x: number
  y: number
  angle: 0 | 90
  size: number
  h?: "left" | "right"
  v?: "top" | "bottom"
}

/**
 * A symbol drawn from a KiCad symbol, for the KiCad writer, which has places for what Circuit JSON
 * has none: `owner` is the schematic component of the part's own symbol, and `unit` which unit of
 * it this one draws (symbols of one part are units of one KiCad symbol); the reference and value are
 * written where the symbol had them.
 */
export interface KicadSymbolLink {
  id: string
  owner: string
  unit: number
  /** A unit drawn only for the library symbol to have it (another use of the sheet takes it): its placed symbol is not written. */
  virtual?: true
  /** The part this is a unit of (its reference), for the units of one part on different sheets. */
  part?: string
  reference?: PlacedText
  value?: PlacedText
  /** The editor's own symbols: the texts they draw besides the designator and value (their pins' names and numbers), where the editor draws them. */
  texts?: PlacedText[]
  /** The designator prefix of the editor's own part (`J`, `RV`), which the file's library symbol names as its reference, so a part made from it is numbered so. */
  refPrefix?: string
  /**
   * The pins this symbol draws, with the name and electrical type they have on the sheet (an alternate applied), which the converter has no place for.
   * `wrote` is the number the converter wrote for a pin whose number it cannot say (`writtenPinNumbers`), which the writer puts back as `number`.
   */
  pins: { number: string; wrote?: string; name: string; type?: PinType }[]
}

/** A unit of a part that one use of a sheet takes and the sheet's first use does not (a symbol drawn once is a different unit in each use): `unit` is the symbol as that use has it, `base` the component of the first use it is a unit alongside. */
export interface ExtraUnit {
  unit: ComponentInstance
  base: string
}

export interface CircuitJsonExport {
  elements: AnyCircuitElement[]
  /** What didn't come across, in words for whoever exported it. */
  notes: string[]
  /** The symbols the KiCad writer has more to say of than the converter does: those that came from KiCad, and, for the editor's own parts, what they show on the sheet (designator, value, pins' names and numbers) and the pins' names and numbers. Only for the KiCad export. */
  symbols: KicadSymbolLink[]
  /** The name of each power port's net where the editor draws it, by the id of the net label the port is written as: the file's power symbol shows it as its value. */
  powerTexts: { id: string; text: PlacedText }[]
}

const pt = (p: Vec2): Vec2 => ({ x: mm(p.x), y: mm(p.y) })

const numeric = (s: string) => /^\d+$/.test(s)

/** A pin number the converter reads back as the same text: Circuit JSON's `pin_number` is a number, so `EP`, `A1` and `0` (which the converter takes for "no number") are not. */
const plainPinNumber = (s: string) => /^[1-9]\d{0,8}$/.test(s)
/** The names the converter takes for a connector pin's own number when the port has no `pin_number` (`A1`, `B12`): it writes the name as the pin's number. */
const CONNECTOR_PIN_NAME = /^[A-Z]+[1-9]\d*$/

/**
 * What the converter writes for the pins of a KiCad export. A pin whose number is not a plain number has no `pin_number`, and the converter would number it by its place
 * among the pins (`EP` as `3`, a diode's `A` and `C` as `1` and `2`), a number the board's pad does not have. Each such pin is given a number of its own above the part's
 * plain ones (on the schematic port only: the pads keep their numbers), and the writer puts the real number back in the file (`kicadPost.ts`, `patchPins`).
 * Returns, for each pin number of the part, the number given to the schematic port and the number the converter then writes in the file: the same, except for a
 * source port that has no `pin_number` and a name like a connector pin's (`A1`), whose name it writes.
 */
export function writtenPinNumbers(part: Pick<PartDef, "pins">): Map<string, { port: number | null; wrote: string }> {
  const out = new Map<string, { port: number | null; wrote: string }>()
  let next = Math.max(0, ...part.pins.filter((p) => plainPinNumber(p.number)).map((p) => Number(p.number)))
  for (const pin of part.pins) {
    if (out.has(pin.number)) continue
    if (plainPinNumber(pin.number)) {
      out.set(pin.number, { port: Number(pin.number), wrote: pin.number })
      continue
    }
    const port = ++next
    const name = pin.name || pin.number
    out.set(pin.number, { port, wrote: !numeric(pin.number) && CONNECTOR_PIN_NAME.test(name) ? name : String(port) })
  }
  return out
}

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

function schAnchor(anchor: TextAnchor, rot: Rotation, mirror?: Mirror): SchAnchor {
  const [x, y] = ANCHORS[anchor]
  const r = mirror ? orientPoint({ x, y }, rot, mirror) : rotate90({ x, y }, rot)
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

/** Circuit JSON's layer for a copper layer: `inner1` to `inner8` (its enum stops there), or null for one beyond them. */
const CJ_INNER = 8
type CjLayer = "top" | "bottom" | "inner1" | "inner2" | "inner3" | "inner4" | "inner5" | "inner6" | "inner7" | "inner8"
function cjLayer(l: CopperLayer): CjLayer | null {
  if (l === "top" || l === "bottom") return l
  const k = Number(l.slice(2))
  return k >= 1 && k <= CJ_INNER ? (`inner${k}` as CjLayer) : null
}
const cjLayers = (ls: readonly CopperLayer[]): CjLayer[] => ls.map(cjLayer).filter((l): l is CjLayer => l !== null)

/** Pads of a part's footprint, one element each, tied to the port of the pin they carry. */
function padElements(c: ComponentInstance, pcbComponentId: string, portIds: Map<string, string>, ids: { next: (prefix: string) => string }, count: number): (PcbSmtPad | PcbPlatedHole | PcbHole)[] {
  const out: (PcbSmtPad | PcbPlatedHole | PcbHole)[] = []
  for (const pad of pcbPads(c, count)) {
    if (isNpth(pad)) {
      out.push(npthElement(pad, pcbComponentId, ids.next("pcb_hole")))
      continue
    }
    const link = {
      pcb_component_id: pcbComponentId,
      port_hints: [...new Set([pad.padNumber, pad.pin].filter((h): h is string => !!h))],
      ...(pad.pin && portIds.has(pad.pin) ? { pcb_port_id: portIds.get(pad.pin) } : {}),
    }
    if (pad.holeDiameter) {
      // A hole whose pad has no copper at all is a bare hole in Circuit JSON.
      if (pad.layers.length === 0) out.push(npthElement(pad, pcbComponentId, ids.next("pcb_hole")))
      else out.push(platedHole(pad, link, ids.next("pcb_plated_hole")))
    } else for (const layer of cjLayers(pad.layers)) out.push(smtPad(pad.variants?.[layer as CopperLayer] ?? pad, link, layer, ids.next("pcb_smtpad")))
  }
  return out
}

interface PadLink {
  pcb_component_id: string
  port_hints: string[]
  pcb_port_id?: string
}

/** A pad's own mask and paste margins, where Circuit JSON has a field for them (a pad of the board's margins says none). */
const padMargins = (pad: WorldPad) => ({ ...(pad.maskMargin !== undefined ? { soldermask_margin: mm(pad.maskMargin) } : {}), ...(pad.pasteMargin !== undefined ? { solderpaste_margin: mm(pad.pasteMargin) } : {}) })

function smtPad(pad: WorldPad, link: PadLink, layer: CjLayer, id: string): PcbSmtPad {
  const at = { x: mm(pad.x), y: mm(pad.y) }
  const common = { pcb_smtpad_id: id, layer, ...link, is_covered_with_solder_mask: false, ...padMargins(pad) }
  if (pad.oriented) {
    const o = pad.oriented
    // A part at an angle that is not a quarter turn: the pad keeps its own size and turns, as KiCad's pad angle and Circuit JSON's rotated shapes have it.
    if (pad.points?.length && pad.shape === "polygon" && pad.slotAxis === undefined) {
      const radius = o.corner ? { rect_border_radius: mm(o.corner) } : {}
      return pad.points.length === 4 || o.corner
        ? ({ type: "pcb_smtpad", shape: "rotated_rect", ...at, width: mm(o.width), height: mm(o.height), ...radius, ccw_rotation: o.rot, ...common } as PcbSmtPad)
        : ({ type: "pcb_smtpad", shape: "rotated_pill", ...at, width: mm(o.width), height: mm(o.height), radius: mm(Math.min(o.width, o.height) / 2), ccw_rotation: o.rot, ...common } as PcbSmtPad)
    }
  }
  if (pad.shape === "polygon" && pad.points?.length) return { type: "pcb_smtpad", shape: "polygon", points: pad.points.map(pt), ...common }
  if (pad.shape === "circle") return { type: "pcb_smtpad", shape: "circle", ...at, radius: mm(pad.width / 2), ...common }
  if (pad.shape === "pill") {
    return { type: "pcb_smtpad", shape: "pill", ...at, width: mm(pad.width), height: mm(pad.height), radius: mm(Math.min(pad.width, pad.height) / 2), ...common }
  }
  return { type: "pcb_smtpad", shape: "rect", ...at, width: mm(pad.width), height: mm(pad.height), ...(pad.corner ? { rect_border_radius: mm(pad.corner) } : {}), ...common }
}

function platedHole(pad: WorldPad, link: PadLink, id: string): PcbPlatedHole {
  const at = { x: mm(pad.x), y: mm(pad.y) }
  const drill = pad.holeDiameter!
  const common = { pcb_plated_hole_id: id, layers: cjLayers(pad.x7 || pad.layers.length > 2 ? pad.layers : ["top", "bottom"]), ...link, is_covered_with_solder_mask: false, ...(pad.maskMargin !== undefined ? { soldermask_margin: mm(pad.maskMargin) } : {}) }
  const slot = slotEnds(pad)
  // A pad whose hole is not at its centre, with rounded corners, or of a shape of its own: its outline round the hole, exactly.
  if (pad.x7 && (pad.hole || pad.corner || pad.rings || (pad.shape === "polygon" && !pad.oriented))) {
    const hole = pad.hole ?? pad
    const ring = padOutline(pad)[0]
    return {
      type: "pcb_plated_hole",
      shape: "hole_with_polygon_pad",
      hole_shape: slot ? "rotated_pill" : "circle",
      ...(slot ? { hole_width: mm(pad.slotLength!), hole_height: mm(drill), ccw_rotation: pad.slotAxis ?? 0 } : { hole_diameter: mm(drill) }),
      pad_outline: ring.map((p) => ({ x: mm(p.x - pad.x), y: mm(p.y - pad.y) })),
      hole_offset_x: mm(hole.x - pad.x),
      hole_offset_y: mm(hole.y - pad.y),
      ...at,
      ...common,
    } as PcbPlatedHole
  }
  const o = pad.oriented
  const along = o ? o.width >= o.height : pad.width >= pad.height
  const hole = slot ? { hole_width: mm(along ? pad.slotLength! : drill), hole_height: mm(along ? drill : pad.slotLength!) } : { hole_width: mm(drill), hole_height: mm(drill) }
  if (o && pad.points?.length === 4) {
    // A rectangular pad of a part at an angle that is not a quarter turn: it keeps its size and turns.
    const rect = { rect_pad_width: mm(o.width), rect_pad_height: mm(o.height), ...at, ...common }
    if (slot) return { type: "pcb_plated_hole", shape: "rotated_pill_hole_with_rect_pad", hole_shape: "rotated_pill", pad_shape: "rect", ...hole, hole_ccw_rotation: o.rot, rect_ccw_rotation: o.rot, hole_offset_x: 0, hole_offset_y: 0, ...rect } as PcbPlatedHole
    return { type: "pcb_plated_hole", shape: "circular_hole_with_rect_pad", hole_shape: "circle", pad_shape: "rect", hole_diameter: mm(drill), hole_offset_x: 0, hole_offset_y: 0, rect_ccw_rotation: o.rot, ...rect } as PcbPlatedHole
  }
  if (o && pad.shape === "polygon" && pad.points && pad.points.length > 4) {
    return { type: "pcb_plated_hole", shape: "pill", outer_width: mm(o.width), outer_height: mm(o.height), ...hole, ccw_rotation: o.rot, ...at, ...common } as PcbPlatedHole
  }
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
  const at = { x: mm(holeCentre(pad).x), y: mm(holeCentre(pad).y) }
  const owner = pcbComponentId ? { pcb_component_id: pcbComponentId } : {}
  if (pad.slotAxis !== undefined && pad.slotLength && pad.slotLength > pad.holeDiameter! + 1e-6) {
    return { type: "pcb_hole", pcb_hole_id: id, hole_shape: "rotated_pill", hole_width: mm(pad.slotLength), hole_height: mm(pad.holeDiameter!), ccw_rotation: pad.slotAxis, ...at, ...owner } as PcbHole
  }
  if (pad.slotLength && pad.slotLength > pad.holeDiameter! + 1e-6) {
    const along = pad.width >= pad.height
    return { type: "pcb_hole", pcb_hole_id: id, hole_shape: "pill", hole_width: mm(along ? pad.slotLength : pad.holeDiameter!), hole_height: mm(along ? pad.holeDiameter! : pad.slotLength), ...at, ...owner }
  }
  return { type: "pcb_hole", pcb_hole_id: id, hole_shape: "circle", hole_diameter: mm(pad.holeDiameter!), ...at, ...owner }
}

/** What a project's schematic uses that Circuit JSON cannot say exactly: the notes name only these. */
interface SchematicUse {
  curves: boolean
  mixedDash: boolean
  styledText: boolean
  overbar: boolean
  alternates: boolean
  sharedNumbers: boolean
  kicadPins: boolean
}

/** KiCad's fill for a shape filled with the background: the pale yellow of its body on the light sheet. */
const BODY_FILL = "#ffffc2"
const INK = "#000000"

type Ids = { next: (prefix: string) => string }

/** KiCad's dash lengths, in line widths: a dash is 12, a dot 2, the gap between them 4. */
function dashFields(look: ShapeLook | undefined, width: number, drawn: SchematicUse) {
  if (!look?.dash) return {}
  if (look.dash === "dash_dot" || look.dash === "dash_dot_dot") drawn.mixedDash = true
  const w = width > 0 ? width : 0.012
  return { dash_length: round(w * (look.dash === "dot" ? 2 : 12), 4), dash_gap: round(w * 4, 4) }
}

/** The colour inside a shape: its own, the body's, or the line's when it is filled with it; none when it is not filled. */
function fillColorOf(look: ShapeLook | undefined, fill: boolean): string | undefined {
  if (look?.fillKind === "color") return look.fillColor ?? look.color ?? INK
  if (look?.fillKind === "background") return BODY_FILL
  return fill && look?.color ? look.color : undefined
}

/** One drawn shape of a symbol (not text) as Circuit JSON elements, turned and mirrored onto the sheet by `here`. */
function shapeElements(p: SymbolPrimitive, here: (q: Vec2) => Vec2, schId: string | undefined, ids: Ids, drawn: SchematicUse): AnyCircuitElement[] {
  if (p.type === "text") return []
  const look = p.look
  const filled = p.fill || !!look?.fillKind
  const width = look?.width ?? (p.type === "path" ? p.width : undefined) ?? 0.01
  const fillColor = fillColorOf(look, p.fill)
  const path = (points: Vec2[], closed: boolean): AnyCircuitElement => ({
    type: "schematic_path",
    schematic_path_id: ids.next("schematic_path"),
    schematic_component_id: schId,
    points,
    is_filled: closed && filled,
    is_dashed: !!look?.dash,
    stroke_width: width,
    ...(look?.color ? { stroke_color: look.color } : {}),
    ...(closed && filled && fillColor ? { fill_color: fillColor } : {}),
    ...dashFields(look, width, drawn),
  })
  switch (p.type) {
    case "path":
      return [path(p.points.map(here), p.fill || !!look?.fillKind)]
    case "circle":
      return [
        {
          type: "schematic_circle",
          schematic_circle_id: ids.next("schematic_circle"),
          schematic_component_id: schId,
          center: here(p),
          radius: p.radius,
          color: look?.color ?? INK,
          is_filled: filled,
          is_dashed: !!look?.dash,
          stroke_width: look?.width ?? 0.01,
          ...(filled && fillColor ? { fill_color: fillColor } : {}),
        },
      ]
    case "arc": {
      const [start, mid, end] = [p.start, p.mid, p.end].map(here)
      const a = arcOf(start, mid, end)
      if (!a) return [path([start, end], false)]
      const out: AnyCircuitElement[] = []
      if (filled) {
        // A filled arc is a pie, the centre then the arc: Circuit JSON's arc has no fill, so the fill is a polygon under it.
        drawn.curves = true
        const rim = samplePrimitive({ type: "arc", start, mid, end, fill: false })
        out.push({ ...path([pt(a.center), ...rim.map(pt), pt(a.center)], true), stroke_width: 0, is_dashed: false } as AnyCircuitElement)
      }
      const deg = (r: number) => round((r * 180) / Math.PI, 4)
      out.push({
        type: "schematic_arc",
        schematic_arc_id: ids.next("schematic_arc"),
        schematic_component_id: schId,
        center: pt(a.center),
        radius: mm(a.radius),
        start_angle_degrees: deg(a.from),
        end_angle_degrees: deg(a.from + a.sweep),
        direction: a.sweep > 0 ? "counterclockwise" : "clockwise",
        stroke_width: width,
        color: look?.color ?? INK,
        is_dashed: !!look?.dash,
      })
      return out
    }
    case "bezier":
    case "ellipse": {
      // Circuit JSON has no curve but the arc: these are short straight lines.
      drawn.curves = true
      const points = samplePrimitive(p).map(here)
      const closed = p.type === "ellipse" ? p.from === undefined || p.to === undefined || filled : filled
      return [path(closed && points.length ? [...points, points[0]] : points, closed)]
    }
    default:
      return []
  }
}

/** The justification of a text that extends from its anchor the way `extent` says: which end of the text the anchor is (KiCad's `left` anchors the left end), whether the text reads up the page. */
function placedAt(text: string, at: Vec2, size: number, extent: { x: number; y: number }, vertical: boolean): PlacedText {
  const along = vertical ? extent.y : extent.x
  const across = vertical ? -extent.x : extent.y
  return { text, x: at.x, y: at.y, angle: vertical ? 90 : 0, size, ...(along > 0 ? { h: "left" as const } : along < 0 ? { h: "right" as const } : {}), ...(across > 0 ? { v: "bottom" as const } : across < 0 ? { v: "top" as const } : {}) }
}

/**
 * What a part of the editor's own library writes on the sheet, for the file to carry as KiCad has it: its designator and its value where the editor draws them (visible fields; the
 * converter hides both), and the other texts of its symbol (the names and numbers of its pins), which the file's library symbol draws as texts of its own.
 */
function ownSymbolTexts(c: ComponentInstance, part: PartDef, symbol: ReturnType<typeof symbolOf>, here: (q: Vec2) => Vec2): Pick<KicadSymbolLink, "reference" | "value" | "texts"> {
  const out: Pick<KicadSymbolLink, "reference" | "value" | "texts"> = {}
  if (part.powerNet) return out
  const texts: PlacedText[] = []
  for (const p of symbol.primitives) {
    if (p.type !== "text") continue
    const place = symbolTextOnSheet(p, c.sch)
    const text = p.role === "ref" ? (unitCount(part) > 1 ? c.ref + unitLetters(c.unit ?? 1) : c.ref) : p.role === "value" ? valueText(c, part) : p.text
    if (!text) continue
    const placed = placedAt(text, here(p), p.size ?? FIELD_SIZE, place.extent, place.vertical)
    if (p.role === "ref") out.reference ??= placed
    else if (p.role === "value") out.value ??= placed
    else texts.push(placed)
  }
  if (texts.length) out.texts = texts
  return out
}

/** A symbol's own text: the editor's own parts keep the placement they have always had. */
function textPrimitive(c: ComponentInstance, part: PartDef, p: Extract<SymbolPrimitive, { type: "text" }>, here: (q: Vec2) => Vec2, schId: string, ids: Ids, kicad: boolean, drawn: SchematicUse): SchematicText | null {
  const text = p.role === "ref" ? c.ref : p.role === "value" ? valueText(c, part) : p.text
  if (!text) return null
  if (p.bold || p.italic) drawn.styledText = true
  const base = { type: "schematic_text" as const, schematic_text_id: ids.next("schematic_text"), schematic_component_id: schId, text, font_size: p.size ?? 0.1, position: here(p) }
  if (kicad) {
    // Text of a KiCad symbol turns with it and stays readable.
    const o = orientText(p.angle ?? 0, p.anchor, c.sch)
    return { ...base, rotation: o.angle, anchor: schAnchor(o.anchor, 0), color: p.color ?? INK }
  }
  const vertical = c.sch.rot === 90 || c.sch.rot === 270
  const pinText = p.role === "pin" || p.role === "pinNumber"
  const turned = pinText && (p.alongPin ? !vertical : vertical)
  return { ...base, rotation: turned ? 90 : 0, anchor: schAnchor(p.anchor, c.sch.rot, c.sch.mirror), color: INK }
}

/** Text the sheet writes at a place of its own (a field, a pin's name), already turned: `angle` is 0 or 90. */
function sheetText(ids: Ids, schId: string, text: string, at: Vec2, size: number, angle: 0 | 90, anchor: TextAnchor, color?: string): SchematicText {
  return {
    type: "schematic_text",
    schematic_text_id: ids.next("schematic_text"),
    schematic_component_id: schId,
    text,
    font_size: Number.isFinite(size) && size > 0 ? size : FIELD_SIZE,
    position: pt(at),
    rotation: angle,
    anchor: schAnchor(anchor, 0),
    color: color ?? INK,
  }
}

const ANCHOR_BY_JUSTIFY = (h?: "left" | "right", v?: "top" | "bottom"): TextAnchor => (!h && !v ? "center" : !h ? (v === "top" ? "middle_top" : "middle_bottom") : !v ? (h === "left" ? "middle_left" : "middle_right") : (`${v}_${h}` as TextAnchor))

/** One drawing a KiCad sheet gave (a text, a shape, a picture, a table, a dot or a flag) as Circuit JSON elements, free of any component. */
function drawingElements2(item: SchematicDrawing, ids: Ids, drawn: SchematicUse, notes: Set<string>): AnyCircuitElement[] {
  const look = (stroke?: SheetStroke, fill?: SheetFill): ShapeLook => ({
    ...(stroke?.width ? { width: stroke.width } : {}),
    ...(stroke?.dash ? { dash: stroke.dash } : {}),
    ...(stroke?.color ? { color: stroke.color } : {}),
    ...(fill?.kind === "background" ? { fillKind: "background" as const } : fill?.kind === "color" ? { fillKind: "color" as const, ...(fill.color ? { fillColor: fill.color } : {}) } : {}),
  })
  const shape = (p: SymbolPrimitive) => shapeElements(p, pt, undefined as unknown as string, ids, drawn)
  const text = (t: string, at: Vec2, rot: number, tl: TextLook | undefined): AnyCircuitElement => {
    if (tl?.bold || tl?.italic) drawn.styledText = true
    return { type: "schematic_text", schematic_text_id: ids.next("schematic_text"), text: t, font_size: tl?.size ?? 0.1, position: pt(at), rotation: rot, anchor: schAnchor(ANCHOR_BY_JUSTIFY(tl?.h, tl?.v), 0), color: tl?.color ?? INK } as SchematicText
  }
  const box = (corners: Vec2[], stroke?: SheetStroke, fill?: SheetFill) => shape({ type: "path", points: [...corners, corners[0]], fill: fill?.kind === "outline", look: look(stroke, fill) })
  switch (item.type) {
    case "text":
      notes.add("Text, text boxes, drawings and tables are written as Circuit JSON text, paths, circles and arcs; a text's font, link and simulation flag are not.")
      return [text(item.text, item, item.rot ?? 0, lookOfText(item))]
    case "textbox": {
      const c = boxCorners(item, item.w, item.h, item.rot)
      return [...box(c, item.stroke, item.paint), text(item.text, boxTextAt(item, item.margins, item.look), item.rot, item.look)]
    }
    case "line":
      return shape({ type: "path", points: item.points, fill: item.paint?.kind === "outline" && item.points.length > 2, look: look(item.stroke, item.paint) })
    case "rect":
      return box([{ x: item.x, y: item.y }, { x: item.x + item.width, y: item.y }, { x: item.x + item.width, y: item.y + item.height }, { x: item.x, y: item.y + item.height }], item.stroke, item.paint)
    case "circle":
      return shape({ type: "circle", x: item.x, y: item.y, radius: item.radius, fill: item.paint?.kind === "outline", look: look(item.stroke, item.paint) })
    case "arc":
      return shape({ type: "arc", start: item.start, mid: item.mid, end: item.end, fill: item.paint?.kind === "outline", look: look(item.stroke, item.paint) })
    case "bezier":
      return shape({ type: "bezier", points: item.points, fill: item.paint?.kind === "outline", look: look(item.stroke, item.paint) })
    case "image":
      notes.add("Pictures are left out of Circuit JSON, which has no picture on a schematic.")
      return []
    case "table":
      return item.cells.flatMap((c) => [...box(boxCorners(c, c.w, c.h, c.rot), item.separators.rows || item.separators.cols ? item.separators.stroke : undefined, c.fill), ...(c.text ? [text(c.text, boxTextAt(c, c.margins, c.look), c.rot, c.look)] : [])])
    case "bus":
      notes.add("Buses and bus entries are drawn as lines: Circuit JSON has no bus, and the nets of a bus's members are nets like any other.")
      return shape({ type: "path", points: item.points, fill: false, look: { ...look(item.stroke), width: item.stroke?.width ?? BUS_WIDTH } })
    case "busentry":
      notes.add("Buses and bus entries are drawn as lines: Circuit JSON has no bus, and the nets of a bus's members are nets like any other.")
      return shape({ type: "path", points: [{ x: item.x, y: item.y }, { x: item.x + item.dx, y: item.y + item.dy }], fill: false, look: look(item.stroke) })
    case "junction":
      return [{ type: "schematic_circle", schematic_circle_id: ids.next("schematic_circle"), center: pt(item), radius: (item.diameter ?? 0.08) / 2, color: item.dotColor ?? INK, is_filled: true, fill_color: item.dotColor ?? INK, is_dashed: false, stroke_width: 0 } as AnyCircuitElement]
    case "noconnect": {
      const d = 0.06
      return [
        { type: "schematic_line", schematic_line_id: ids.next("schematic_line"), x1: item.x - d, y1: item.y - d, x2: item.x + d, y2: item.y + d, color: INK, is_dashed: false, stroke_width: 0.01 },
        { type: "schematic_line", schematic_line_id: ids.next("schematic_line"), x1: item.x - d, y1: item.y + d, x2: item.x + d, y2: item.y - d, color: INK, is_dashed: false, stroke_width: 0.01 },
      ] as AnyCircuitElement[]
    }
    case "directive": {
      // S8: the pin and the flag as lines and a circle, and the text of each field that is shown; what the label does (a net class) is not a schematic drawing.
      notes.add("A directive label is written as its pin, its flag and its shown fields; Circuit JSON has no net class on a label.")
      const g = directiveShape(item)
      return [
        ...shape({ type: "path", points: [...g.pin], fill: false, look: {} }),
        ...(g.circle ? shape({ type: "circle", x: g.circle.at.x, y: g.circle.at.y, radius: g.circle.r, fill: g.circle.filled, look: {} }) : []),
        ...(g.outline ? shape({ type: "path", points: g.outline, fill: false, look: {} }) : []),
        ...item.fields.filter((f) => !f.place.hidden && f.value.trim()).map((f) => text(f.place.showName ? `${f.name}: ${f.value}` : f.value, { x: item.x + f.place.x, y: item.y + f.place.y }, f.place.angle, { ...(f.place.size ? { size: f.place.size } : {}), ...(f.place.h ? { h: f.place.h } : {}), ...(f.place.v ? { v: f.place.v } : {}) })),
      ]
    }
  }
}

/**
 * Project to Circuit JSON, with notes on what it could not carry. A project with sheets is flattened first (`flatten.ts`): Circuit
 * JSON has no sheets, and says so in the notes. A view of one sheet is exported as the sheet it is.
 */
export function projectToCircuitJson(source: Project, options: { nameAllNets?: boolean; forKicad?: boolean; keepVariants?: boolean; extraUnits?: ExtraUnit[] } = {}): CircuitJsonExport {
  // S8, S9: a rule area's flags are the flags of the parts it touches, and Circuit JSON has no variants: the symbols are written as the active variant, the sheet symbols
  // and the areas make them. (`keepVariants`: the KiCad export that writes the variants itself, so only the areas' flags are put on the symbols.)
  const project = options.keepVariants ? withRuleAreaFlagsOnly(source) : withRuleAreaFlags(source)
  const flat = flattenHierarchy(project)
  const variantNotes = options.keepVariants || options.forKicad ? [] : variantExportNotes(source, "Circuit JSON")
  if (flat.project === project) {
    const out = projectToCircuitJsonFlat(project, options)
    return variantNotes.length ? { ...out, notes: [...out.notes, ...variantNotes] } : out
  }
  const out = projectToCircuitJsonFlat(flat.project, options)
  return { ...out, notes: [...flat.notes, ...out.notes, ...variantNotes] }
}

function projectToCircuitJsonFlat(project: Project, options: { nameAllNets?: boolean; forKicad?: boolean; extraUnits?: ExtraUnit[] } = {}): CircuitJsonExport {
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
  const pcb = analyzePcbOnce(project, sch)
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
  const isVirtualSymbol = (part: PartDef, c: ComponentInstance) => !part.powerNet && part.category === "Symbols" && part.pins.length > 0 && c.ref.startsWith("#")
  const portIds = new Map<string, string>()
  const parts: { c: ComponentInstance; part: PartDef; sourceId: string; pcbId: string; schId: string; onBoard: boolean }[] = []
  const unknown: string[] = []
  const droppedProps = new Set<string>()
  const ncPins = new Set(project.components.flatMap((c) => (c.nc ?? []).map((pin) => pinKey(c.id, pin))))
  // A unit of a part whose other units are on another sheet is a symbol of its own in this sheet's file (a power unit on a sheet of its own is the usual one): it has no part on the sheet to be a unit of.
  const unitParts = unitOwners(project.components)

  for (const c of project.components) {
    const part = findPart(c.partId)
    if (!part) {
      unknown.push(c.ref)
      continue
    }
    // A part with a footprint is on the board; a KiCad symbol with none is a part of the schematic alone. The other units of a part are symbols of the part.
    // A virtual symbol of KiCad's (`PWR_FLAG`) is a symbol of the sheet with no part behind it: it is written, so the checks that count on it (a power input driven by a flag) still hold.
    if (!(isSchematicPart(part) || isVirtualSymbol(part, c)) || (part.unitOf && unitParts.has(c.id))) continue
    const sourceId = ids.next("source_component")
    const pcbId = ids.next("pcb_component")
    const schId = ids.next("schematic_component")
    parts.push({ c, part, sourceId, pcbId, schId, onBoard: onBoard(c) })
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
  // A board with an outline of its own: its biggest piece is the board's outline, and every cutout (and every other piece, as a cutout of the rest it is not) is a `pcb_cutout`. Circuit JSON has no arcs, so they are written as straight pieces within 0.005 mm.
  const customRegions = (outlineState(b) === "closed" ? outlineRegionsAt(b, 0.005) : []).sort((p, q) => Math.abs(signedArea(q.outer)) - Math.abs(signedArea(p.outer)))
  const r = Math.max(0, Math.min(b.cornerRadius, b.width / 2, b.height / 2))
  elements.push({
    type: "pcb_board",
    pcb_board_id: "pcb_board_0",
    center: pt(b),
    width: mm(b.width),
    height: mm(b.height),
    thickness: b.thickness,
    num_layers: copperCount(b),
    material: "fr4",
    ...(roundedBoard ? { outline: roundedOutline(b.x - b.width / 2, b.y - b.height / 2, b.x + b.width / 2, b.y + b.height / 2, r) } : {}),
    ...(customRegions.length ? { outline: customRegions[0].outer.map((q) => ({ x: round(q.x), y: round(q.y) })) } : {}),
    solder_mask_color: colors.mask,
    silkscreen_color: colors.silk,
    is_via_in_pad_allowed: rules.viaInPad,
    default_via_tented_on_top: rules.tentSides ? rules.tentSides.front : rules.tentVias,
    default_via_tented_on_bottom: rules.tentSides ? rules.tentSides.back : rules.tentVias,
    min_trace_width: rules.minTraceWidth,
    min_board_edge_clearance: rules.edgeClearance,
    min_via_hole_diameter: rules.minDrill,
    min_via_hole_edge_to_via_hole_edge_clearance: rules.holeClearance,
    min_plated_hole_drill_edge_to_drill_edge_clearance: rules.holeClearance,
    min_different_net_trace_edge_to_trace_edge_clearance: rules.clearance,
    min_trace_to_pad_edge_clearance: rules.clearance,
    min_pad_edge_to_pad_edge_clearance: rules.clearance,
  })
  for (const rg of customRegions) {
    for (const hole of rg.holes) {
      elements.push({ type: "pcb_cutout", pcb_cutout_id: ids.next("pcb_cutout"), shape: "polygon", points: hole.map((q) => ({ x: mm(q.x), y: mm(q.y) })) } as AnyCircuitElement)
    }
  }
  if (customRegions.length > 1) notes.push(`The board is ${customRegions.length} separate pieces, and Circuit JSON has one outline: the biggest is the board's outline and the others are left out.`)
  if (customRegions.length && b.outline?.paths.some((p) => p.segs.some((s) => s.kind !== "line"))) notes.push("The board outline has arcs or curves, which Circuit JSON has no way to hold: they are written as straight pieces within 0.005 mm.")
  if (b.outline && outlineState(b) !== "closed") notes.push("The board outline is not closed, so Circuit JSON has the board's box and none of the outline.")
  for (const hole of mountingHoles(b)) {
    elements.push({
      type: "pcb_plated_hole",
      pcb_plated_hole_id: ids.next("pcb_plated_hole"),
      shape: "circle",
      x: mm(hole.x),
      y: mm(hole.y),
      outer_diameter: hole.diameter,
      hole_diameter: hole.drill,
      layers: cjLayers(copperLayers(b)),
      pcb_component_id: undefined,
      is_covered_with_solder_mask: false,
    } as PcbPlatedHole)
  }

  // ---------- Each part on the board ----------
  const cad: CadComponent[] = []
  for (const { c, part, sourceId, pcbId, schId, onBoard } of parts) {
    if (!onBoard) continue
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
      ...(c.flags?.dnp ? { do_not_place: true } : {}),
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
        layers: cjLayers([...new Set(owned.flatMap((p) => p.layers))]),
      }
      elements.push(port)
    }
    elements.push(...padElements(c, pcbId, pcbPortIds, ids, copperCount(project.board)))

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
  const layerNotes: string[] = []
  let flattenedArcs = 0
  let beyond = 0
  for (const t of project.traces) {
    const layer = cjLayer(t.layer)
    if (!layer) {
      beyond++
      continue
    }
    const netId = pcb.traceNet.get(t.id)
    // X4: Circuit JSON has no arc in a route, so an arc track is the points of its curve, within 0.0002 mm.
    const points = isArcTrace(t) ? arcPolyline(t.points) : t.points
    if (isArcTrace(t)) flattenedArcs++
    const trace: PcbTrace = {
      type: "pcb_trace",
      pcb_trace_id: ids.next("pcb_trace"),
      ...(netId && traceIds.has(netId) ? { source_trace_id: traceIds.get(netId) } : {}),
      route: points.map((p) => ({ route_type: "wire" as const, x: mm(p.x), y: mm(p.y), width: t.width, layer })),
    }
    elements.push(trace)
  }
  for (const v of project.vias) {
    const netId = pcb.viaNet.get(v.id)
    const span = viaLayers(project.board, v)
    const via: PcbVia = {
      type: "pcb_via",
      pcb_via_id: ids.next("pcb_via"),
      x: mm(v.x),
      y: mm(v.y),
      outer_diameter: v.diameter,
      hole_diameter: v.drill,
      layers: cjLayers(span),
      from_layer: cjLayer(span[0]) ?? "top",
      to_layer: cjLayer(span[span.length - 1]) ?? "bottom",
      ...(v.tent ? { is_tented: viaTentedOn(rules, v, "top") && viaTentedOn(rules, v, "bottom") } : {}),
      ...(netId && netIds.has(netId) ? { source_net_id: netIds.get(netId) } : {}),
    } as PcbVia
    elements.push(via)
  }
  if (flattenedArcs) layerNotes.push(`${flattenedArcs} arc track${flattenedArcs === 1 ? "" : "s"} ${flattenedArcs === 1 ? "is" : "are"} written as ${flattenedArcs === 1 ? "its" : "their"} points (within 0.0002 mm of the curve): a Circuit JSON route has no arc.`)
  const layerNotesAfter = () => {
    if (beyond) layerNotes.push(`${beyond} trace${beyond === 1 ? "" : "s"} and pour${beyond === 1 ? "" : "s"} on inner layers beyond inner${CJ_INNER} ${beyond === 1 ? "is" : "are"} left out: Circuit JSON has no layer past inner${CJ_INNER}.`)
  }
  const emptyZones: string[] = []
  // The KiCad export writes the zones of a project that has polygon zones itself, so they are not in the circuit it converts.
  const zonesWrittenByKicadExport = options.forKicad === true && kicadWritesZones(project)
  for (const fill of zonesWrittenByKicadExport ? [] : pcb.zoneFills) {
    const netId = fill.netId ?? sch.nets.find((n) => n.name === fill.netName)?.id
    const sourceNetId = netId ? netIds.get(netId) : undefined
    if (!fill.polygons.length) {
      emptyZones.push(`${fill.netName} (${fill.layer})`)
      continue
    }
    if (!cjLayer(fill.layer)) {
      beyond++
      continue
    }
    for (const polygon of fill.polygons) {
      const ring = (points: Vec2[]) => ({ vertices: points.map(pt) })
      const brep: BRepShape = { outer_ring: ring(polygon[0]), inner_rings: polygon.slice(1).map(ring) }
      const pour: PcbCopperPour = {
        type: "pcb_copper_pour",
        pcb_copper_pour_id: ids.next("pcb_copper_pour"),
        layer: cjLayer(fill.layer)!,
        shape: "brep",
        brep_shape: brep,
        covered_with_solder_mask: true,
        ...(sourceNetId ? { source_net_id: sourceNetId } : {}),
      }
      elements.push(pour)
    }
  }
  void netNameOf
  // Rule areas (keepouts) are `pcb_keepout` outlines: the outline of the polygon, on the layers it is on.
  const keepoutNotes: string[] = []
  if (!options.forKicad) {
    // The keepouts inside parts are the board's here (X30), where they stand now.
    for (const z of withPartZones(project).zones) {
      if (!z.keepout || !z.outline?.length) continue
      const k = z.keepout
      // X29: a rule area on layers that are not copper alone has no copper layer to keep anything out of.
      if (!zoneLayers(z).length) {
        keepoutNotes.push("A rule area that is on layers that are not copper only has no element in Circuit JSON and was left out.")
        continue
      }
      if (!(k.tracks || k.vias || k.pads || k.pour || k.footprints)) {
        keepoutNotes.push("A rule area that keeps nothing out (it is there for rules) has no element in Circuit JSON and was left out.")
        continue
      }
      const outer = flattenPath({ ...z.outline[0], closed: true })
      if (z.outline.length > 1) keepoutNotes.push("The holes of a keepout are left out: Circuit JSON keeps out the whole outline.")
      elements.push({
        type: "pcb_keepout",
        shape: "outline",
        pcb_keepout_id: ids.next("pcb_keepout"),
        layers: cjLayers(zoneLayers(z)),
        outline: outer.map(pt),
        stroke_width: 0,
        ...(z.name ? { description: z.name } : {}),
        ...(k.tracks || k.vias ? {} : { allow_traces: true }),
        ...(k.pads || k.footprints ? {} : { allow_placements: true }),
      } as unknown as AnyCircuitElement)
      if ((k.tracks && !k.vias) || (k.vias && !k.tracks)) keepoutNotes.push("A keepout that keeps out only tracks or only vias keeps out both in Circuit JSON, which has one flag for them.")
      if ((k.pads && !k.footprints) || (k.footprints && !k.pads)) keepoutNotes.push("A keepout that keeps out only pads or only parts keeps out both in Circuit JSON, which has one flag for them.")
    }
  }

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
  // A part with several units is several symbols that share a reference: the part's own and its
  // twins' (`unitOwners`). Each is a schematic component of the part's one source component, and its
  // ports are the part's source ports, so a pin drawn on another unit is still that pin.
  const drawn: SchematicUse = { curves: false, mixedDash: false, styledText: false, overbar: false, alternates: false, sharedNumbers: false, kicadPins: false }
  const owners = unitOwners(project.components)
  const partOf = new Map(parts.map((p) => [p.c.id, p]))
  const orphanUnits: string[] = []
  const symbols: KicadSymbolLink[] = []
  // The units another use of this sheet takes of a symbol drawn here (`extraUnits`) are drawn as units of the symbol the use has: the library symbol of the file must have them.
  const extraBase = new Map((options.extraUnits ?? []).map((e) => [e.unit.id, e.base]))
  for (const c of [...project.components, ...(options.extraUnits ?? []).map((e) => e.unit)]) {
    const part = findPart(c.partId)
    if (!part) continue
    // A part that is on the board alone (KiCad's `board_only`: a logo, a mark) has no symbol in the schematic.
    // (A reference text with a star, `G***`, is KiCad's for a logo or a mark that no symbol stands for.)
    if (c.flags?.boardOnly || c.texts?.some((t) => t.kind === "reference" && t.text?.includes("*"))) continue
    let own = extraBase.has(c.id) ? (partOf.get(extraBase.get(c.id)!) ?? partOf.get(owners.get(extraBase.get(c.id)!) ?? "")) : partOf.get(c.id)
    let schId = extraBase.has(c.id) ? own && ids.next("schematic_component") : own?.schId
    if (!own && part.unitOf) {
      const ownerId = owners.get(c.id)
      if (!ownerId) orphanUnits.push(c.ref)
      own = partOf.get(ownerId ?? "")
      schId = own && ids.next("schematic_component")
    }
    if (!own || !schId) continue
    const { sourceId } = own
    const ownerId = own.c.id
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
    const worldPins = schematicPins(c, part)
    // A KiCad file carries each pin's own number: a number the converter cannot say is written as one of ours and put back by the writer (`writtenPinNumbers`).
    const written = options.forKicad ? writtenPinNumbers(own.part) : null
    for (const pin of worldPins) {
      const source = portIds.get(pinKey(ownerId, pin.pin))
      if (!source) continue
      const port: SchematicPort = {
        type: "schematic_port",
        schematic_port_id: ids.next("schematic_port"),
        schematic_component_id: schId,
        source_port_id: source,
        center: pt(pin.pos),
        facing_direction: pin.dir,
        side_of_component: DIR_SIDE[pin.dir],
        ...(written ? (written.get(pin.pin)?.port != null ? { pin_number: written.get(pin.pin)!.port! } : {}) : numeric(pin.pin) ? { pin_number: Number(pin.pin) } : {}),
      }
      elements.push(port)
      if (pin.slot && part.jumpers && !part.jumpers.duplicates) drawn.sharedNumbers = true
    }
    const symbol = symbolOf(part, c)
    const here = (q: Vec2) => {
      const o = orientPoint(q, c.sch.rot, c.sch.mirror)
      return pt({ x: c.sch.x + o.x, y: c.sch.y + o.y })
    }
    const kicad = !!part.jumpers
    for (const p of symbol.primitives) {
      if (p.type === "text") {
        const el = textPrimitive(c, part, p, here, schId, ids, kicad, drawn)
        if (el) elements.push(el)
      } else elements.push(...shapeElements(p, here, schId, ids, drawn))
    }
    // The number the converter wrote for a pin, where it is not the pin's own.
    const wroteOf = (n: string) => (written?.get(n)?.wrote !== n ? written?.get(n)?.wrote : undefined)
    if (!kicad) {
      // A part drawn here keeps the converter's drawing, but its pins' numbers are put back (its own pins' names are the numbers, as the converter writes them).
      // The pins the file's symbol names as the part does (the converter names each by its number), the numbers it cannot say put back, and what the part shows on the sheet
      // beyond its drawing, which the converter hides: the designator, the value, the pins' names and numbers.
      const named = new Map(part.pins.map((q) => [q.number, q.name]))
      const typed = new Map(part.pins.flatMap((q) => (q.type ?? pinTypeOfKind(q.kind) ? [[q.number, (q.type ?? pinTypeOfKind(q.kind))!] as const] : [])))
      const pins = worldPins.filter((w) => !w.slot).map((w) => ({ number: w.pin, ...(wroteOf(w.pin) !== undefined ? { wrote: wroteOf(w.pin)! } : {}), name: named.get(w.pin)?.trim() || w.pin, ...(typed.has(w.pin) ? { type: typed.get(w.pin)! } : {}) }))
      const own = options.forKicad ? { ...ownSymbolTexts(c, part, symbol, here), ...(part.powerNet || !part.refPrefix ? {} : { refPrefix: part.refPrefix }) } : {}
      const renamed = pins.some((q) => q.name !== q.number || q.wrote !== undefined || (q.type !== undefined && q.type !== "passive"))
      if (options.forKicad && (renamed || extraBase.has(c.id) || own.reference || own.value || own.texts || own.refPrefix)) symbols.push({ id: schId, owner: partOf.get(ownerId)!.schId, unit: c.unit ?? 1, ...(extraBase.has(c.id) ? { virtual: true as const } : {}), part: c.ref, pins, ...own })
      continue
    }
    // An imported part writes its fields and its pins' names and numbers on the sheet itself.
    drawn.kicadPins = true
    const link: KicadSymbolLink = { id: schId, owner: partOf.get(ownerId)!.schId, unit: c.unit ?? 1, ...(extraBase.has(c.id) ? { virtual: true as const } : {}), part: c.ref, pins: worldPins.filter((w) => !w.slot).map((w) => ({ number: w.pin, ...(wroteOf(w.pin) !== undefined ? { wrote: wroteOf(w.pin)! } : {}), name: part.pins.find((q) => q.number === w.pin)?.unnamed && !c.pinAlt?.[w.pin] ? "~" : w.name, ...(w.type ? { type: w.type } : {}) })) }
    symbols.push(link)
    for (const f of componentFields(c, part)) {
      if (f.place.bold || f.place.italic) drawn.styledText = true
      // The field's angle and justification are the symbol's own: on the sheet they follow its turn and mirror.
      const drawnAs = orientText(f.place.angle, justifyAnchor(f.place.h, f.place.v), c.sch)
      if (f.name === "Reference" || f.name === "Value") {
        const placed: PlacedText = { text: f.text, x: c.sch.x + f.place.x, y: c.sch.y + f.place.y, angle: drawnAs.angle, size: f.place.size ?? FIELD_SIZE, ...justifyOf(drawnAs.anchor) }
        if (f.name === "Reference") link.reference = placed
        else link.value = placed
      }
      elements.push(sheetText(ids, schId, f.text, { x: c.sch.x + f.place.x, y: c.sch.y + f.place.y }, f.place.size ?? FIELD_SIZE, drawnAs.angle, drawnAs.anchor, f.place.color))
    }
    for (const label of symbol.pinLabels ?? []) {
      const alt = c.pinAlt?.[label.number] ? worldPins.find((w) => w.pin === label.number)?.name : undefined
      for (const t of pinTexts(label, c.sch, symbol.pinNameOffset ?? 0.04, alt)) {
        const shown = t.number ? t.text : pinDisplayName(t.text, "")
        if (!shown) continue
        if (!t.number && /~\{/.test(t.text)) drawn.overbar = true
        elements.push(sheetText(ids, schId, shown, { x: c.sch.x + t.x, y: c.sch.y + t.y }, t.size, t.angle, anchorFromAxes(t.h === "left" ? -1 : t.h === "right" ? 1 : 0, 0)))
      }
    }
    if (part.pins.some((pin) => pin.alternates?.length)) drawn.alternates = true
  }

  // Power ports are net labels with their symbol.
  const powerTexts: CircuitJsonExport["powerTexts"] = []
  for (const c of project.components) {
    const part = findPart(c.partId)
    // A symbol that is not a power symbol but has a hidden power-input pin (KiCad's `VPP` with no `(power)`) is on the net of that pin's name: it is written as the power port it acts as.
    const hiddenPower = part && !part.powerNet && !isSchematicPart(part) ? schematicPins(c, part).find((p) => p.hidden && p.type === "power_in" && p.name.trim()) : undefined
    const net = powerNetName(c, part) ?? hiddenPower?.name.trim()
    if (!part || !net) continue
    const pin = hiddenPower ?? schematicPins(c, part)[0]
    const netId = (project.netNames || project.scope !== undefined) && pin ? sch.pinNet.get(pinKey(c.id, pin.pin)) : sch.nets.find((n) => n.name === net)?.id
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
    // The net's name where the editor draws it, for the file's power symbol to carry as its value.
    const name = symbolOf(part, c).primitives.find((p): p is Extract<SymbolPrimitive, { type: "text" }> => p.type === "text" && p.role === "ref")
    if (name && options.forKicad) {
      const place = symbolTextOnSheet(name, c.sch)
      const o = orientPoint(name, c.sch.rot, c.sch.mirror)
      powerTexts.push({ id: label.schematic_net_label_id, text: placedAt(net, pt({ x: c.sch.x + o.x, y: c.sch.y + o.y }), name.size ?? FIELD_SIZE, place.extent, place.vertical) })
    }
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

  // S4: the sheet's own items. The KiCad export writes them itself, in KiCad's own nodes.
  const itemNotes = new Set<string>()
  // What a KiCad sheet drew goes in; the drawings the editor's tools made stay out, as they always did (the note below).
  const kicadDrawn = (project.drawings ?? []).filter(isExact)
  if (!options.forKicad) for (const d of kicadDrawn) elements.push(...drawingElements2(d, ids, drawn, itemNotes))
  if (kicadDrawn.length && !options.forKicad) notes.push(...itemNotes)
  if (project.wires.some((w) => w.look) && !options.forKicad) notes.push("The widths, dashes and colours of wires are not in Circuit JSON.")
  if (project.labels.some((l) => l.kind || l.look) && !options.forKicad) notes.push("A label is written as a net label of its text: whether it is local or global, its shape, size and style are not in Circuit JSON.")
  if (project.components.some((c) => c.flags && (c.flags.excludeFromBom || c.flags.notOnBoard || c.flags.excludeFromSim || c.flags.excludeFromPos || c.flags.dnp)) && !options.forKicad) notes.push("A part marked do not populate is written as one not to be placed; the other flags (out of the BOM, off the board, out of simulation, out of the position file) have no field in Circuit JSON, and a part off the board has no board component.")

  // ---------- Notes ----------
  // The KiCad export says what it carries in its own words, since it carries more than Circuit JSON has a field for.
  const kicad = options.forKicad === true
  if (unknown.length) notes.push(`Left out ${unknown.length === 1 ? "a part" : `${unknown.length} parts`} the library no longer has: ${unknown.join(", ")}.`)
  if (droppedProps.size && !kicad) notes.push(`Part properties with no field in Circuit JSON were left out: ${[...droppedProps].sort().join(", ")}. Values, part numbers and LCSC numbers are kept.`)
  layerNotesAfter()
  notes.push(...layerNotes)
  if (project.zones.some(isOtherZone) && !kicad) notes.push("Zones on layers that are not copper (solder mask, paste, silkscreen and user layers) are left out: Circuit JSON has no filled area on those layers. The Gerber files carry them.")
  if (project.zones.some((z) => !z.keepout && !isOtherZone(z)) && !kicad) notes.push("Copper pours are exported as the copper they fill, not as pours that refill: change a pour's settings in Cherry Blossom, not after the export.")
  if (orphanUnits.length) notes.push(`Left out ${orphanUnits.length === 1 ? "a unit symbol" : `${orphanUnits.length} unit symbols`} whose part is not on the sheet: ${orphanUnits.join(", ")}.`)
  if (drawn.curves) notes.push("Bezier curves and ellipses, and the fill of filled arcs, are written as paths of short straight lines, since Circuit JSON has no curve for them.")
  if (drawn.mixedDash) notes.push("Dash-dot and dash-dot-dot lines are written as plain dashes: Circuit JSON has one dash length and gap for a line.")
  if (drawn.styledText) notes.push("Bold and italic text is written in plain type.")
  if (drawn.overbar) notes.push("A pin name with an overbar is written with a trailing #.")
  if (drawn.alternates) notes.push("Each pin carries the function chosen in the schematic; the other functions a pin can take are not in Circuit JSON.")
  if (drawn.sharedNumbers) notes.push("Pins that share a number are one port in Circuit JSON, which names a port by its number; KiCad keeps them apart.")
  if (drawn.kicadPins && !kicad) notes.push("KiCad's pin types (input, output, power and the others) are not in Circuit JSON: every pin is written as passive.")
  if (emptyZones.length) notes.push(`Pours that fill nothing were left out: ${emptyZones.join(", ")}.`)
  if (project.drawings?.some((d) => !isExact(d)) && !options.forKicad) notes.push("The schematic's drawings (texts, lines and shapes) are left out.")
  if (project.footprints?.length || project.parts?.length) notes.push("Parts and land patterns made for the project are exported as the parts and pads they are; they have no link to a library in the other tool.")
  if (!kicad && project.components.some((c) => onBoard(c) && pcbPads(c).some((p) => p.rings || p.shape === "polygon" && p.x7))) notes.push("A custom pad is written as the outline of its copper, and one with a hole in it or in pieces as its first outline: Circuit JSON has no pad with a cut-out. The KiCad export keeps it whole.")
  if (!kicad) {
    if (project.description || project.properties?.length) notes.push("The project's description and properties (revision, author and the like) are left out: Circuit JSON has no field for them.")
    notes.push("The 3D view, the net trace widths and the pour and mask settings stay in Cherry Blossom; the design rules the board states (trace width, clearances, drills) are in the board.")
  }
  void projectFootprints
  notes.push(...drawingNotes, ...new Set(keepoutNotes))
  return { elements, notes, symbols, powerTexts }
}

/** The text of the .json file and the notes to show with it. */
export function circuitJsonFile(project: Project): { text: string; notes: string[] } {
  const { elements, notes } = projectToCircuitJson(project)
  // One element a line, as tscircuit's own tools write it: readable and diffable without the size of indenting every field.
  return { text: `[\n${elements.map((e) => JSON.stringify(e)).join(",\n")}\n]\n`, notes }
}
