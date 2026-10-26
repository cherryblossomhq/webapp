import { copperLayers, MAX_COPPER_LAYERS, viaBetween, withCopperCount } from "./stack"
import { emptyBox, expandBox, normalizeAngle, rotate90, round, snap, type Box } from "../lib/geometry"
import { uid } from "../lib/id"
import { createBlock } from "./blocks"
import { computeConnectivity, pinKey, UnionFind } from "./connectivity"
import { customPartId, customPartProblems, DEFAULT_REF_PREFIX, digest, registerProjectParts } from "./customParts"
import { getFootprint, isValidFootprint } from "./footprints"
import { pinStubPoint, schematicBounds, schematicPins } from "./instances"
import { labelBox } from "./labels"
import { outlineRadius } from "./board"
import { createProject, labelPin } from "./ops"
import { SCH_GRID } from "./symbols"
import type {
  BoardText,
  ComponentInstance,
  CustomPartSpec,
  FootprintDef,
  MountingHoles,
  PadDef,
  CopperLayer,
  PartCategory,
  PinSide,
  Project,
  Rotation,
  Trace,
  Vec2,
  Via,
  Zone,
} from "./types"

// Circuit JSON, tscircuit's netlist-and-geometry format, read into a project. Every board the
// tscircuit editor /app used to be was built into it, and this
// is how those boards came across. It carries a built board: parts, their pads, where they sit and
// what connects to what, which is everything a project needs except a schematic drawing. That is
// drawn anew from the netlist, a label on every connected pin, and parts keep tscircuit's
// arrangement, moved apart only where their labels would collide.
//
// The pads are the board's own, so a part lands exactly where it was: a part's land is the
// footprinter's when that draws the very same pads, and the project's own (Project.footprints)
// when it doesn't. Copper comes too, on every layer the board has (X1: `inner1` is the layer after
// the front one; a via between two layers is a blind or a buried via, X5).

interface Point {
  x: number
  y: number
}

interface SourceComponent {
  source_component_id: string
  ftype?: string
  name?: string
  manufacturer_part_number?: string
  supplier_part_numbers?: Record<string, string[] | undefined>
  resistance?: number
  display_resistance?: string
  capacitance?: number
  display_capacitance?: string
  max_voltage_rating?: number
  inductance?: number | string
  display_inductance?: string
  display_current_rating?: string
  color?: string
  transistor_type?: string
  channel_type?: string
  frequency?: number
  polarized?: boolean
  internally_connected_source_port_ids?: string[][]
  source_group_id?: string
}

interface SourceGroup {
  source_group_id: string
  name?: string
  parent_source_group_id?: string
  is_subcircuit?: boolean
  was_automatically_named?: boolean
}

interface SourcePort {
  source_port_id: string
  source_component_id: string
  name?: string
  pin_number?: number
  port_hints?: string[]
  do_not_connect?: boolean
}

interface SourceNet {
  source_net_id: string
  name?: string
}

interface SourceTrace {
  connected_source_port_ids?: string[]
  connected_source_net_ids?: string[]
}

interface SchematicComponent {
  source_component_id: string
  center: Point
  symbol_name?: string
}

interface SchematicPort {
  source_port_id: string
  center: Point
  side_of_component?: string
}

interface PcbComponent {
  pcb_component_id: string
  source_component_id: string
  center: Point
  rotation?: number
  layer?: string
}

interface PcbPort {
  pcb_port_id: string
  source_port_id: string
}

/** A pad, plated hole or bare hole, whichever fields its type has. */
interface PcbPadElement {
  type: string
  pcb_component_id?: string | null
  pcb_port_id?: string | null
  port_hints?: string[]
  shape?: string
  layer?: string
  x: number
  y: number
  width?: number
  height?: number
  radius?: number
  ccw_rotation?: number
  rect_ccw_rotation?: number
  points?: Point[]
  hole_diameter?: number
  hole_width?: number
  hole_height?: number
  outer_diameter?: number
  outer_width?: number
  outer_height?: number
  rect_pad_width?: number
  rect_pad_height?: number
  /** A polygon pad of a plated hole, relative to the hole's centre. */
  pad_outline?: Point[]
}

interface PcbBoard {
  center: Point
  width?: number
  height?: number
  thickness?: number
  num_layers?: number
  outline?: Point[]
}

interface RoutePoint extends Point {
  route_type?: string
  width?: number
  layer?: string
}

interface PcbTrace {
  route?: RoutePoint[]
}

interface PcbVia extends Point {
  outer_diameter?: number
  hole_diameter?: number
  from_layer?: string
  to_layer?: string
  layers?: string[]
}

interface PcbCopperPour {
  layer?: string
  source_net_id?: string
}

interface PcbSilkscreenText {
  pcb_component_id?: string | null
  text?: string
  anchor_position?: Point
  font_size?: number
  layer?: string
  ccw_rotation?: number
}

/** Silkscreen and courtyard drawing, whichever fields its type has. */
interface PcbDrawing {
  type: string
  pcb_component_id?: string | null
  route?: Point[]
  outline?: Point[]
  x1?: number
  y1?: number
  x2?: number
  y2?: number
  center?: Point
  width?: number
  height?: number
  radius?: number
  /** A rectangle's turn: its width and height are as it was drawn before it. */
  ccw_rotation?: number
}

export interface CircuitJsonImport {
  project: Project
  /** What didn't come across as it was, in words for whoever imported it. */
  notes: string[]
}

export interface CircuitJsonImportOptions {
  name: string
  description?: string
  /** Where the board came from, kept as the project's "Imported from" property. */
  source?: string
}

type Element = { type?: unknown }

/** The names the discrete transistor symbols want for their pins, by what tscircuit calls them. */
const ROLE_HINTS: Record<string, string> = {
  collector: "C",
  base: "B",
  emitter: "E",
  drain: "D",
  source: "S",
  gate: "G",
}

/** Nearest multiple of 90°, and what's left over. */
function quarterTurn(degrees = 0): { rot: Rotation; rest: number } {
  const d = ((degrees % 360) + 360) % 360
  const rot = ((Math.round(d / 90) * 90) % 360) as Rotation
  let rest = d - rot
  if (rest > 180) rest -= 360
  return { rot, rest: Math.abs(rest) < 1e-6 ? 0 : rest }
}

const ccw = (p: Point, degrees: number): Point => {
  const a = (degrees * Math.PI) / 180
  return { x: p.x * Math.cos(a) - p.y * Math.sin(a), y: p.x * Math.sin(a) + p.y * Math.cos(a) }
}

/** A world point into a part's own frame: the inverse of `transformPoint` for its pose. */
function toLocal(p: Point, origin: Point, rot: number, mirror: boolean): Vec2 {
  const r = rotate90({ x: p.x - origin.x, y: p.y - origin.y }, -rot)
  return { x: round(mirror ? -r.x : r.x), y: round(r.y) }
}

function rectCorners(c: Point, w: number, h: number, degrees: number): Point[] {
  return [
    { x: -w / 2, y: h / 2 },
    { x: w / 2, y: h / 2 },
    { x: w / 2, y: -h / 2 },
    { x: -w / 2, y: -h / 2 },
  ].map((p) => {
    const r = ccw(p, degrees)
    return { x: c.x + r.x, y: c.y + r.y }
  })
}

/** A pill's outline, its round ends in a few segments each. */
function pillOutline(c: Point, w: number, h: number, degrees: number): Point[] {
  const long = Math.max(w, h)
  const r = Math.min(w, h) / 2
  const half = long / 2 - r
  const points: Point[] = []
  for (const [cx, start] of [
    [half, -90],
    [-half, 90],
  ] as const) {
    for (let i = 0; i <= 6; i++) {
      const a = ((start + i * 30) * Math.PI) / 180
      points.push({ x: cx + r * Math.cos(a), y: r * Math.sin(a) })
    }
  }
  const along = w >= h ? 0 : 90
  return points.map((p) => {
    const q = ccw(p, degrees + along)
    return { x: c.x + q.x, y: c.y + q.y }
  })
}

const sizeOf = (w: number, h: number, rot: Rotation) => (rot === 90 || rot === 270 ? { width: h, height: w } : { width: w, height: h })

/**
 * A pad in a part's own frame, or null for an element that isn't one. A pad keeps its turn in
 * the world, so one the part's quarter turn doesn't square up becomes a polygon of its outline.
 */
function localPad(e: PcbPadElement, pin: string | null, origin: Point, rot: number, mirror: boolean): PadDef | null {
  const at = toLocal(e, origin, rot, mirror)
  const polygon = (outline: Point[], hole?: Partial<PadDef>): PadDef => {
    const points = outline.map((p) => toLocal(p, origin, rot, mirror))
    const b = emptyBox()
    for (const p of points) expandBox(b, p)
    return {
      pin,
      shape: "polygon",
      x: round((b.minX + b.maxX) / 2),
      y: round((b.minY + b.maxY) / 2),
      width: round(b.maxX - b.minX),
      height: round(b.maxY - b.minY),
      points,
      layer: "top",
      ...hole,
    }
  }

  if (e.type === "pcb_smtpad") {
    if (e.shape === "circle") {
      const d = round((e.radius ?? 0.5) * 2)
      return { pin, shape: "circle", ...at, width: d, height: d, layer: "top" }
    }
    if (e.shape === "polygon" && e.points?.length) return polygon(e.points)
    const w = e.width ?? 1
    const h = e.height ?? 1
    const pill = e.shape === "pill" || e.shape === "rotated_pill"
    const theta = e.shape === "rotated_rect" || e.shape === "rotated_pill" ? (e.ccw_rotation ?? 0) : 0
    const turn = quarterTurn(theta - rot)
    if (turn.rest) return polygon(pill ? pillOutline(e, w, h, theta) : rectCorners(e, w, h, theta))
    return { pin, shape: pill ? "pill" : "rect", ...at, ...sizeOf(w, h, turn.rot), layer: "top" }
  }

  if (e.type === "pcb_plated_hole") {
    const drill = e.hole_diameter ?? Math.min(e.hole_width ?? 0.8, e.hole_height ?? 0.8)
    if (e.shape === "circle") {
      const d = e.outer_diameter ?? drill + 0.6
      return { pin, shape: "circle", ...at, width: d, height: d, holeDiameter: drill, layer: "through" }
    }
    if (e.shape === "circular_hole_with_rect_pad") {
      const w = e.rect_pad_width ?? drill + 0.6
      const h = e.rect_pad_height ?? drill + 0.6
      const theta = e.rect_ccw_rotation ?? 0
      const turn = quarterTurn(theta - rot)
      if (turn.rest) return polygon(rectCorners(e, w, h, theta), { holeDiameter: drill, layer: "through" })
      return { pin, shape: "rect", ...at, ...sizeOf(w, h, turn.rot), holeDiameter: drill, layer: "through" }
    }
    if (e.shape === "pill_hole_with_rect_pad") {
      const holeW = e.hole_width ?? drill
      const holeH = e.hole_height ?? drill
      const turn = quarterTurn(-rot)
      return {
        pin,
        shape: "rect",
        ...at,
        ...sizeOf(e.rect_pad_width ?? drill + 0.6, e.rect_pad_height ?? drill + 0.6, turn.rot),
        holeDiameter: Math.min(holeW, holeH),
        ...(Math.abs(holeW - holeH) > 1e-6 ? { slotLength: Math.max(holeW, holeH) } : {}),
        layer: "through",
      }
    }
    if (e.shape === "hole_with_polygon_pad" && e.pad_outline?.length) {
      const hole = e.hole_diameter ?? Math.min(e.hole_width ?? 0.8, e.hole_height ?? 0.8)
      const slot = e.hole_width !== undefined && e.hole_height !== undefined && Math.abs(e.hole_width - e.hole_height) > 1e-6
      return polygon(
        e.pad_outline.map((q) => ({ x: e.x + q.x, y: e.y + q.y })),
        { holeDiameter: slot ? Math.min(e.hole_width!, e.hole_height!) : hole, ...(slot ? { slotLength: Math.max(e.hole_width!, e.hole_height!) } : {}), layer: "through" },
      )
    }
    if (e.shape === "pill" || e.shape === "oval") {
      const holeW = e.hole_width ?? drill
      const holeH = e.hole_height ?? drill
      const hole = {
        holeDiameter: Math.min(holeW, holeH),
        ...(Math.abs(holeW - holeH) > 1e-6 ? { slotLength: Math.max(holeW, holeH) } : {}),
        layer: "through" as const,
      }
      // Sized as drawn before its turn, like a rotated SMD pad: a part's turn is in `ccw_rotation`.
      const w = e.outer_width ?? 1.5
      const h = e.outer_height ?? 1.5
      const theta = e.ccw_rotation ?? 0
      const turn = quarterTurn(theta - rot)
      if (turn.rest) return polygon(pillOutline(e, w, h, theta), hole)
      return { pin, shape: "pill", ...at, ...sizeOf(w, h, turn.rot), ...hole }
    }
    return null
  }

  if (e.type === "pcb_hole") {
    const w = e.hole_width ?? e.hole_diameter ?? 1
    const h = e.hole_height ?? e.hole_diameter ?? 1
    if (Math.abs(w - h) > 1e-6) {
      return {
        pin: null,
        shape: "pill",
        ...at,
        ...sizeOf(w, h, quarterTurn(-rot).rot),
        holeDiameter: Math.min(w, h),
        slotLength: Math.max(w, h),
        layer: "through",
        plated: false,
      }
    }
    return { pin: null, shape: "circle", ...at, width: w, height: w, holeDiameter: w, layer: "through", plated: false }
  }
  return null
}

/** Silkscreen strokes in a part's own frame. */
function localSilk(e: PcbDrawing, origin: Point, rot: number, mirror: boolean): Vec2[][] {
  const local = (points: Point[]) => [points.map((p) => toLocal(p, origin, rot, mirror))]
  if (e.type === "pcb_silkscreen_path" && e.route && e.route.length > 1) return local(e.route)
  if (e.type === "pcb_silkscreen_line" && [e.x1, e.y1, e.x2, e.y2].every((n) => typeof n === "number")) {
    return local([
      { x: e.x1!, y: e.y1! },
      { x: e.x2!, y: e.y2! },
    ])
  }
  if (e.type === "pcb_silkscreen_rect" && e.center && e.width && e.height) {
    const corners = rectCorners(e.center, e.width, e.height, e.ccw_rotation ?? 0)
    return local([...corners, corners[0]])
  }
  if (e.type === "pcb_silkscreen_circle" && e.center && e.radius) {
    const c = e.center
    const r = e.radius
    return local(Array.from({ length: 25 }, (_, i) => ({ x: c.x + r * Math.cos((i / 24) * Math.PI * 2), y: c.y + r * Math.sin((i / 24) * Math.PI * 2) })))
  }
  return []
}

/** Courtyard bounds in a part's own frame, or null when the part draws none. */
function localCourtyard(drawings: PcbDrawing[], origin: Point, rot: number, mirror: boolean): Box | null {
  const b = emptyBox()
  for (const e of drawings) {
    const points: Point[] =
      e.type === "pcb_courtyard_rect" && e.center && e.width && e.height
        ? rectCorners(e.center, e.width, e.height, e.ccw_rotation ?? 0)
        : e.type === "pcb_courtyard_outline" && e.outline
          ? e.outline
          : e.type === "pcb_courtyard_circle" && e.center && e.radius
            ? rectCorners(e.center, e.radius * 2, e.radius * 2, 0)
            : []
    for (const p of points) expandBox(b, toLocal(p, origin, rot, mirror))
  }
  return Number.isFinite(b.minX) ? { minX: round(b.minX), minY: round(b.minY), maxX: round(b.maxX), maxY: round(b.maxY) } : null
}

function padBounds(pads: PadDef[], margin: number): Box {
  const b = emptyBox()
  for (const p of pads) {
    for (const q of p.points ?? [
      { x: p.x - p.width / 2, y: p.y - p.height / 2 },
      { x: p.x + p.width / 2, y: p.y + p.height / 2 },
    ]) {
      expandBox(b, q)
    }
  }
  return { minX: round(b.minX - margin), minY: round(b.minY - margin), maxX: round(b.maxX + margin), maxY: round(b.maxY + margin) }
}

/** Whether a footprinter string draws exactly these pads, numbered the same. */
function sameLand(name: string, pads: PadDef[]): boolean {
  if (!isValidFootprint(name)) return false
  const theirs = getFootprint(name).pads
  if (theirs.length !== pads.length) return false
  const near = (a: number, b: number) => Math.abs(a - b) < 0.011
  const left = [...theirs]
  for (const p of pads) {
    const i = left.findIndex(
      (q) =>
        q.pin === p.pin &&
        near(q.x, p.x) &&
        near(q.y, p.y) &&
        near(q.width, p.width) &&
        near(q.height, p.height) &&
        (q.holeDiameter === undefined) === (p.holeDiameter === undefined),
    )
    if (i < 0) return false
    left.splice(i, 1)
  }
  return true
}

/**
 * Footprinter strings tscircuit may have meant by its own, plainest first: it spells a resistor's
 * 0603 "res0603" and an LED's "1206_color(red)", where the library says "0603" and "1206".
 */
function footprinterCandidates(name: string | undefined): string[] {
  if (!name) return []
  const plain = name.replace(/_color\([^)]*\)/g, "")
  const bare = plain.replace(/^(res|cap|ind|led|diode)(?=\d)/, "")
  return [...new Set([bare, plain, name])]
}

const slug = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 24) || "land"

const SI = [
  [1e6, "M"],
  [1e3, "k"],
  [1, ""],
  [1e-3, "m"],
  [1e-6, "u"],
  [1e-9, "n"],
  [1e-12, "p"],
] as const

/**
 * A value as the library spells it: tscircuit's display text with "Ω" dropped and "µ" as "u"
 * ("10kΩ" is "10k", "33µH" is "33uH"), else its number with an SI prefix.
 */
function value(display: string | undefined, n: unknown, unit: string): string {
  const shown = display?.replace(/Ω/g, "").replace(/µ/g, "u").trim()
  if (shown) return shown
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) return typeof n === "string" ? n : ""
  const [scale, prefix] = SI.find(([s]) => n >= s * 0.9995) ?? SI[SI.length - 1]
  return `${round(n / scale, 3)}${prefix}${unit}`
}

const CATEGORY_BY_PREFIX: [RegExp, PartCategory][] = [
  [/^(J|P|CN|CON|USB|X)$/, "Connectors"],
  [/^(Q|M|T)$/, "Transistors"],
  [/^(D|LED|TVS|Z)$/, "Diodes"],
  [/^(SW|S|K|BTN|RLY|BZ)$/, "Electromechanical"],
  [/^(R|C|L|F|FB|Y|XTAL|TP)$/, "Passives"],
]

const FTYPE_CATEGORY: Record<string, PartCategory> = {
  simple_pin_header: "Connectors",
  simple_connector: "Connectors",
  simple_push_button: "Electromechanical",
  simple_switch: "Electromechanical",
  simple_transistor: "Transistors",
  simple_mosfet: "Transistors",
  simple_fuse: "Passives",
  simple_crystal: "Passives",
  simple_test_point: "Connectors",
}

const FTYPE_NAME: Record<string, string> = {
  simple_pin_header: "Pin header",
  simple_connector: "Connector",
  simple_push_button: "Push button",
  simple_switch: "Switch",
  simple_transistor: "Transistor",
  simple_mosfet: "MOSFET",
  simple_fuse: "Fuse",
  simple_crystal: "Crystal",
  simple_test_point: "Test point",
  simple_chip: "Part",
}

/** How a part's pins are drawn: a library part, or one of the project's own. */
interface PartChoice {
  partId?: string
  spec?: Omit<CustomPartSpec, "id" | "footprint">
  props: Record<string, string>
}

/** Part number and LCSC number, which the BOM lists, when tscircuit had them. */
function sourcing(c: SourceComponent): Record<string, string> {
  const props: Record<string, string> = {}
  if (c.manufacturer_part_number) props.mpn = c.manufacturer_part_number
  const lcsc = c.supplier_part_numbers?.jlcpcb?.[0] ?? c.supplier_part_numbers?.lcsc?.[0]
  if (lcsc) props.lcsc = lcsc
  return props
}

/** tscircuit kinds the library has, as the library part and its properties. */
const LIBRARY_PARTS: Record<string, (c: SourceComponent) => PartChoice> = {
  simple_resistor: (c) => ({ partId: "resistor", props: { resistance: value(c.display_resistance, c.resistance, ""), ...sourcing(c) } }),
  simple_capacitor: (c) => ({
    partId: c.polarized ? "capacitor_polarized" : "capacitor",
    props: {
      capacitance: value(c.display_capacitance, c.capacitance, "F"),
      ...(c.max_voltage_rating ? { voltage: `${c.max_voltage_rating}V` } : {}),
      ...sourcing(c),
    },
  }),
  simple_inductor: (c) => ({ partId: "inductor", props: { inductance: value(c.display_inductance, c.inductance, "H"), ...sourcing(c) } }),
  simple_diode: (c) => ({ partId: "diode", props: sourcing(c) }),
  simple_led: (c) => ({ partId: "led", props: { ...(c.color ? { color: c.color } : {}), ...sourcing(c) } }),
}

/** Turn of a tscircuit symbol from its name: resistor_up is the editor's resistor turned 90°. */
function symbolTurn(symbolName: string | undefined): Rotation {
  const m = symbolName?.match(/_(right|up|left|down|horz|vert)$/)
  return m ? ({ right: 0, horz: 0, up: 90, vert: 90, left: 180, down: 270 } as const)[m[1] as "right"] : 0
}

/** A project part for a tscircuit kind the library has nothing for, drawn as its pins say. */
function customPart(
  sc: SourceComponent,
  ref: string,
  ports: SourcePort[],
  pinOf: Map<string, string>,
  schematicPorts: Map<string, SchematicPort>,
  footprinter: string | undefined,
): PartChoice {
  const prefix = ref.match(/^[A-Z]{1,3}(?=\d|$)/)?.[0]
  const category: PartCategory =
    FTYPE_CATEGORY[sc.ftype ?? ""] ?? CATEGORY_BY_PREFIX.find(([re]) => prefix && re.test(prefix))?.[1] ?? "ICs"
  const props = sourcing(sc)
  if (sc.ftype === "simple_fuse" && sc.display_current_rating) props.current = sc.display_current_rating
  if (sc.ftype === "simple_crystal" && sc.frequency) props.frequency = `${round(sc.frequency / 1e6, 6)}MHz`

  // A discrete symbol where the part is one and its pins say which is which, else a box.
  const role = (p: SourcePort) => [p.name, ...(p.port_hints ?? [])].map((h) => ROLE_HINTS[h?.toLowerCase() ?? ""]).find(Boolean)
  const discrete =
    sc.ftype === "simple_transistor"
      ? sc.transistor_type === "pnp"
        ? "pnp"
        : "npn"
      : sc.ftype === "simple_mosfet"
        ? sc.channel_type === "p"
          ? "pmos"
          : "nmos"
        : undefined
  let symbol: string | undefined
  if (discrete && ports.length === 3 && ports.every(role)) symbol = discrete
  else if (ports.length === 2 && sc.ftype === "simple_fuse") symbol = "fuse"
  else if (ports.length === 2 && sc.ftype === "simple_crystal") symbol = "crystal"
  else if (ports.length === 2 && sc.ftype === "simple_switch") symbol = "switch"
  const nameOf = (p: SourcePort) =>
    symbol && discrete ? role(p)! : /^pin\d+$/.test(p.name ?? "") || !p.name ? pinOf.get(p.source_port_id)! : p.name

  const sideOf = (p: SourcePort): PinSide | undefined => {
    const side = schematicPorts.get(p.source_port_id)?.side_of_component
    return side === "left" || side === "right" || side === "top" || side === "bottom" ? side : undefined
  }
  // Each side top to bottom or left to right, as tscircuit drew it.
  const along = (p: SourcePort) => {
    const at = schematicPorts.get(p.source_port_id)?.center
    const side = sideOf(p)
    return !at ? 0 : side === "left" || side === "right" ? -at.y : at.x
  }
  const ordered = symbol ? ports : [...ports].sort((a, b) => along(a) - along(b))
  const kind = FTYPE_NAME[sc.ftype ?? ""] ?? "Part"
  return {
    props,
    spec: {
      // Without a part number, its package says the most about it.
      name: sc.manufacturer_part_number || (footprinter ? `${kind}, ${footprinter}` : `${kind} ${ref}`),
      description: `${kind} from a tscircuit board`,
      category,
      refPrefix: prefix ?? DEFAULT_REF_PREFIX[category],
      pins: ordered.map((p) => {
        const side = symbol ? undefined : sideOf(p)
        return { number: pinOf.get(p.source_port_id)!, name: nameOf(p), ...(side ? { side } : {}) }
      }),
      ...(symbol ? { symbol } : {}),
      props: { ...props },
      ...(props.mpn ? { valueProp: "mpn" } : {}),
    },
  }
}

interface ImportNet {
  name: string
  /** The netlist's own net: its root in the union of ports and nets. */
  root: string
  pins: { componentId: string; pin: string }[]
}

/** Read a built tscircuit board into a project. */
export function projectFromCircuitJson(elements: unknown[], options: CircuitJsonImportOptions): CircuitJsonImport {
  const notes: string[] = []
  const all = elements.filter((e): e is Element => !!e && typeof e === "object")
  const of = <T>(type: string) => all.filter((e) => e.type === type) as unknown as T[]

  const sourceComponents = of<SourceComponent>("source_component")
  const sourcePorts = of<SourcePort>("source_port")
  const sourceNets = new Map(of<SourceNet>("source_net").map((n) => [n.source_net_id, n]))
  const schematicBySource = new Map(of<SchematicComponent>("schematic_component").map((s) => [s.source_component_id, s]))
  const schematicPorts = new Map(of<SchematicPort>("schematic_port").map((p) => [p.source_port_id, p]))
  const pcbBySource = new Map(of<PcbComponent>("pcb_component").map((p) => [p.source_component_id, p]))
  const pcbPorts = new Map(of<PcbPort>("pcb_port").map((p) => [p.pcb_port_id, p.source_port_id]))
  const cadFootprints = new Map(
    of<{ pcb_component_id?: string; footprinter_string?: string }>("cad_component").map((c) => [c.pcb_component_id, c.footprinter_string]),
  )
  const padElements = all.filter((e) => e.type === "pcb_smtpad" || e.type === "pcb_plated_hole" || e.type === "pcb_hole") as unknown as PcbPadElement[]
  const drawings = all.filter(
    (e) => typeof e.type === "string" && (e.type.startsWith("pcb_silkscreen_") || e.type.startsWith("pcb_courtyard_")),
  ) as unknown as PcbDrawing[]

  // ---------- Nets ----------
  const uf = new UnionFind()
  for (const t of of<SourceTrace>("source_trace")) {
    const ids = [...(t.connected_source_port_ids ?? []).map((id) => `port:${id}`), ...(t.connected_source_net_ids ?? []).map((id) => `net:${id}`)]
    for (const id of ids.slice(1)) uf.union(ids[0], id)
  }
  // Pins joined inside the part, such as a connector's shell, are one net whether wired or not.
  for (const c of sourceComponents) {
    for (const group of c.internally_connected_source_port_ids ?? []) {
      for (const id of group.slice(1)) uf.union(`port:${group[0]}`, `port:${id}`)
    }
  }
  const netNames = new Map<string, string[]>()
  for (const n of sourceNets.values()) {
    if (!n.name?.trim()) continue
    const root = uf.find(`net:${n.source_net_id}`)
    netNames.set(root, [...(netNames.get(root) ?? []), n.name.trim()])
  }

  // ---------- Parts, their lands and where they sit ----------
  const portsByComponent = new Map<string, SourcePort[]>()
  for (const p of sourcePorts) portsByComponent.set(p.source_component_id, [...(portsByComponent.get(p.source_component_id) ?? []), p])

  const specs = new Map<string, CustomPartSpec>()
  const footprints = new Map<string, FootprintDef>()
  const components: ComponentInstance[] = []
  /** source_port_id -> the pin it became. */
  const placedPins = new Map<string, { componentId: string; pin: string }>()
  /** Component id -> the tscircuit group it was in. */
  const groupOf = new Map<string, string>()
  const refs = new Set<string>()
  const skipped: string[] = []
  const padless: string[] = []
  const unsupported: string[] = []

  for (const sc of sourceComponents) {
    const ref = sc.name?.trim() || sc.source_component_id
    const pcb = pcbBySource.get(sc.source_component_id)
    const ports = [...(portsByComponent.get(sc.source_component_id) ?? [])].sort((a, b) => (a.pin_number ?? 0) - (b.pin_number ?? 0))
    const pads = pcb ? padElements.filter((e) => e.pcb_component_id === pcb.pcb_component_id) : []
    if (!pcb || !pads.length || !ports.length) {
      skipped.push(ref)
      continue
    }

    // Pin numbers: tscircuit's own, else the order it listed the ports in.
    const pinOf = new Map<string, string>()
    for (const [i, p] of ports.entries()) {
      // A port with no number is numbered by its first hint, which is how Cherry Blossom writes
      // the pins that aren't numbers ("A6"), else by its place in the list.
      let n = String(p.pin_number ?? p.port_hints?.[0] ?? i + 1)
      while ([...pinOf.values()].includes(n)) n = `${n}_`
      pinOf.set(p.source_port_id, n)
    }
    const pinNumbers = new Set(pinOf.values())
    const padPin = (e: PcbPadElement) => {
      const port = e.pcb_port_id ? pcbPorts.get(e.pcb_port_id) : undefined
      if (port && pinOf.has(port)) return pinOf.get(port)!
      const hints = e.port_hints ?? []
      const numbered = hints.find((h) => pinNumbers.has(h))
      if (numbered) return numbered
      // A pad tscircuit didn't tie to a port ("pin17", "GND1"): the port its first hint names.
      for (const h of hints) {
        const named = ports.find((p) => p.name === h || p.port_hints?.includes(h))
        if (named) return pinOf.get(named.source_port_id)!
      }
      return null
    }

    // The part keeps the angle it has (X6), so its land is drawn in its own frame at any angle, and a pad the part's turn squares up stays a plain pad.
    const rot = normalizeAngle(pcb.rotation ?? 0)
    const mirror = pcb.layer === "bottom"
    const origin = pcb.center
    const localPads: PadDef[] = []
    const odd = new Set<string>()
    for (const e of pads) {
      const pad = localPad(e, padPin(e), origin, rot, mirror)
      if (pad) localPads.push(pad)
      else odd.add(e.shape ?? e.type)
    }
    if (odd.size) unsupported.push(`${ref} (${[...odd].join(", ")})`)

    // The part: a library one where tscircuit's kind is one of them with pins 1 and 2, else one
    // of the project's own, which only lists the pins that have a pad.
    // A capacitor whose pins are named for polarity is polarized, like tscircuit's own.
    const polarized = sc.polarized || ports.some((p) => p.port_hints?.some((h) => h === "pos" || h === "neg"))
    const library = sc.ftype && ports.length === 2 && pinNumbers.has("1") && pinNumbers.has("2") ? LIBRARY_PARTS[sc.ftype]?.({ ...sc, polarized }) : undefined
    const padPins = new Set(localPads.map((p) => p.pin))
    const withPads = ports.filter((p) => padPins.has(pinOf.get(p.source_port_id)!))
    const choice = library ?? customPart(sc, ref, withPads, pinOf, schematicPorts, cadFootprints.get(pcb.pcb_component_id))
    const keptPins = new Set(library ? pinNumbers : withPads.map((p) => pinOf.get(p.source_port_id)!))
    const lost = [...pinNumbers].filter((n) => !keptPins.has(n))
    if (lost.length) padless.push(`${ref} (${lost.join(", ")})`)
    for (const pad of localPads) if (pad.pin && !keptPins.has(pad.pin)) pad.pin = null

    // The land: the footprinter's when it draws these very pads, else the board's own.
    let footprint = footprinterCandidates(cadFootprints.get(pcb.pcb_component_id)).find((f) => sameLand(f, localPads))
    if (!footprint) {
      const mine = drawings.filter((d) => d.pcb_component_id === pcb.pcb_component_id)
      const land = {
        pads: localPads,
        silk: mine.flatMap((d) => localSilk(d, origin, rot, mirror)),
        courtyard: localCourtyard(mine, origin, rot, mirror) ?? padBounds(localPads, 0.25),
      }
      footprint = `${slug(sc.manufacturer_part_number || cadFootprints.get(pcb.pcb_component_id) || ref)}-${digest(JSON.stringify(land))}`
      if (!footprints.has(footprint)) footprints.set(footprint, { name: footprint, ...land })
    }

    let partId = choice.partId!
    if (choice.spec) {
      const spec = { ...choice.spec, footprint }
      partId = customPartId(spec)
      if (!specs.has(partId)) specs.set(partId, { id: partId, ...spec })
    }

    let unique = ref
    while (refs.has(unique)) unique = `${unique}_`
    refs.add(unique)
    const schematic = schematicBySource.get(sc.source_component_id)
    const component: ComponentInstance = {
      id: uid("c"),
      partId,
      ref: unique,
      props: choice.props,
      footprint,
      sch: { x: schematic?.center.x ?? 0, y: schematic?.center.y ?? 0, rot: choice.spec ? 0 : symbolTurn(schematic?.symbol_name) },
      pcb: { x: round(origin.x), y: round(origin.y), rot, side: mirror ? "bottom" : "top", placed: true },
    }
    components.push(component)
    if (sc.source_group_id) groupOf.set(component.id, sc.source_group_id)
    for (const p of ports) {
      const pin = pinOf.get(p.source_port_id)!
      if (keptPins.has(pin)) placedPins.set(p.source_port_id, { componentId: component.id, pin })
    }
  }

  let project: Project = {
    ...createProject(options.name, options.description ?? ""),
    components,
    parts: specs.size ? [...specs.values()] : undefined,
    footprints: footprints.size ? [...footprints.values()] : undefined,
  }
  registerProjectParts(project)
  for (const spec of specs.values()) {
    const problems = customPartProblems(spec)
    if (problems.length) notes.push(`${spec.name} can't be drawn: ${problems.join("; ")}.`)
  }

  // ---------- Net names, then a label on every connected pin ----------
  const members = new Map<string, { componentId: string; pin: string; portId: string }[]>()
  for (const [portId, placed] of placedPins) {
    const root = uf.find(`port:${portId}`)
    members.set(root, [...(members.get(root) ?? []), { ...placed, portId }])
  }
  const portName = new Map(sourcePorts.map((p) => [p.source_port_id, p.name ?? ""]))
  const doNotConnect = new Set(sourcePorts.filter((p) => p.do_not_connect).map((p) => p.source_port_id))
  const refOf = new Map(components.map((c) => [c.id, c.ref]))
  const pinCount = new Map<string, number>()
  for (const p of placedPins.values()) pinCount.set(p.componentId, (pinCount.get(p.componentId) ?? 0) + 1)
  const unnamedPin = (portId: string) => /^(pin)?\d+$/.test(portName.get(portId) ?? "")
  const taken = new Set([...netNames.values()].flat())
  const nets: ImportNet[] = []
  const merged: string[] = []
  for (const [root, pins] of members) {
    const names = [...new Set(netNames.get(root) ?? [])].sort()
    if (names.length > 1) merged.push(names.join(" = "))
    if (pins.length < 2 && !names.length) continue
    let name = names[0]
    if (!name) {
      // tscircuit left it unnamed (a trace from pin to pin), so it is named after its most
      // telling pin: a named one, on the part with the most pins.
      const best = [...pins].sort(
        (a, b) =>
          Number(unnamedPin(a.portId)) - Number(unnamedPin(b.portId)) ||
          (pinCount.get(b.componentId) ?? 0) - (pinCount.get(a.componentId) ?? 0) ||
          (refOf.get(a.componentId) ?? "").localeCompare(refOf.get(b.componentId) ?? "", undefined, { numeric: true }),
      )[0]
      const base = `${refOf.get(best.componentId)}_${unnamedPin(best.portId) ? best.pin : portName.get(best.portId)}`.replace(/[^A-Za-z0-9_+\-./]/g, "_")
      name = base
      for (let i = 2; taken.has(name); i++) name = `${base}_${i}`
    }
    taken.add(name)
    nets.push({ name, root, pins })
  }
  nets.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))

  // tscircuit packs its schematics tighter than a label on every pin leaves room for, so parts
  // that would collide with their labels move apart. Uniform spreading is the fallback, until
  // every net reads back exactly as it was, no two labels touching.
  const labels = new Map<string, Map<string, string>>()
  for (const net of nets) {
    for (const pin of net.pins) labels.set(pin.componentId, (labels.get(pin.componentId) ?? new Map()).set(pin.pin, net.name))
  }
  const label = (p: Project) => nets.reduce((q, net) => net.pins.reduce((r, pin) => labelPin(r, pin, net.name), q), p)
  let drawn = label(spreadApart(project, labels))
  if (!netsMatch(drawn, nets)) {
    let fits = false
    for (const spread of [1.5, 2, 2.5, 3, 4]) {
      drawn = label({
        ...project,
        components: project.components.map((c) => ({
          ...c,
          sch: { ...c.sch, x: round(snap(c.sch.x * spread, SCH_GRID)), y: round(snap(c.sch.y * spread, SCH_GRID)) },
        })),
      })
      if ((fits = netsMatch(drawn, nets))) break
    }
    if (!fits) notes.push("Some schematic labels touch each other; check the schematic's nets against the board.")
  }
  // Pins the part names as not connected, and that nothing connects, are marked so on purpose.
  const connected = new Set(nets.flatMap((n) => n.pins.map((p) => pinKey(p.componentId, p.pin))))
  const ncPins = new Map<string, string[]>()
  for (const [portId, placed] of placedPins) {
    if ((/^N\.?C\d*$/i.test(portName.get(portId) ?? "") || doNotConnect.has(portId)) && !connected.has(pinKey(placed.componentId, placed.pin))) {
      ncPins.set(placed.componentId, [...(ncPins.get(placed.componentId) ?? []), placed.pin])
    }
  }
  project = { ...drawn, components: drawn.components.map((c) => (ncPins.has(c.id) ? { ...c, nc: ncPins.get(c.id) } : c)) }

  // ---------- Blocks ----------
  // tscircuit's named groups become the schematic's blocks. The board is a group too, and so is
  // any group tscircuit named itself: a part in one belongs to the nearest named group above it.
  const groups = new Map(of<SourceGroup>("source_group").map((g) => [g.source_group_id, g]))
  const blockGroup = (id: string) => {
    const seen = new Set<string>()
    for (let g = groups.get(id); g && !seen.has(g.source_group_id); g = groups.get(g.parent_source_group_id ?? "")) {
      seen.add(g.source_group_id)
      const board = g.is_subcircuit && !g.parent_source_group_id
      if (g.name?.trim() && !g.was_automatically_named && !board) return g
    }
    return undefined
  }
  const blockMembers = new Map<SourceGroup, string[]>()
  for (const [componentId, groupId] of groupOf) {
    const g = blockGroup(groupId)
    if (g) blockMembers.set(g, [...(blockMembers.get(g) ?? []), componentId])
  }
  for (const [g, ids] of blockMembers) project = createBlock(project, g.name!, ids).project

  // ---------- Board ----------
  const board = of<PcbBoard>("pcb_board")[0]
  const layers = board?.num_layers ?? 2
  if (board) {
    let { width = 50, height = 40, center } = board
    let cornerRadius = 0
    if (board.outline?.length) {
      const b = emptyBox()
      for (const p of board.outline) expandBox(b, p)
      width = b.maxX - b.minX
      height = b.maxY - b.minY
      center = { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 }
      const radius = outlineRadius(board.outline)
      if (radius === null) notes.push("The board's outline was a shape the editor doesn't draw yet; it is the rectangle around it now.")
      else cornerRadius = radius
    }
    const outline = { ...project.board, width: round(width), height: round(height), x: round(center.x), y: round(center.y) }
    project.board = withCopperCount({
      ...outline,
      thickness: board.thickness ?? 1.6,
      cornerRadius,
      mountingHoles: cornerHoles([...of<PcbPadElement>("pcb_hole"), ...of<PcbPadElement>("pcb_plated_hole")].filter((h) => !h.pcb_component_id), outline, notes),
    }, Number.isFinite(layers) ? layers : 2)
  }
  // The board's copper layers (X1): `inner1` is the layer after the front one, and a name past the board's last inner layer is no layer of it.
  const stackIds = new Set<string>(copperLayers(project.board))
  const layerOf = (name: string | undefined): CopperLayer | undefined => {
    if (name === "top" || name === "bottom") return name
    const k = /^inner(\d+)$/.exec(name ?? "")
    return k && stackIds.has(`in${k[1]}`) ? (`in${k[1]}` as CopperLayer) : undefined
  }

  // Pours of whole nets on the outer layers.
  const zones: Zone[] = []
  const netByRoot = new Map(nets.map((n) => [n.root, n.name]))
  for (const pour of of<PcbCopperPour>("pcb_copper_pour")) {
    const pourLayer = layerOf(pour.layer)
    if (!pourLayer || !pour.source_net_id) continue
    const net = netByRoot.get(uf.find(`net:${pour.source_net_id}`)) ?? sourceNets.get(pour.source_net_id)?.name
    if (net && !zones.some((z) => z.net === net && z.layer === pourLayer)) zones.push({ id: uid("z"), net, layer: pourLayer })
  }

  // Copper, on the layers the board has.
  const traces: Trace[] = []
  const vias: Via[] = []
  const pcbTraces = of<PcbTrace>("pcb_trace")
  if (layers > copperLayers(project.board).length && pcbTraces.length) {
    notes.push(`The board has ${layers} copper layers and the editor has ${MAX_COPPER_LAYERS} at most, so its traces and vias were left behind: route it again in the PCB view.`)
  } else {
    for (const t of pcbTraces) {
      // A route is runs of wire, each on one layer at one width, between vias.
      let run: RoutePoint[] = []
      const flush = () => {
        const { layer: named, width } = run[run.length - 1] ?? {}
        const layer = layerOf(named)
        if (run.length > 1 && layer) {
          traces.push({ id: uid("t"), layer, width: width ?? project.rules.traceWidth, points: run.map((p) => ({ x: round(p.x), y: round(p.y) })) })
        }
      }
      for (const p of t.route ?? []) {
        const last = run[run.length - 1]
        if (p.route_type !== "wire") {
          flush()
          run = []
        } else if (last && (last.layer !== p.layer || last.width !== p.width)) {
          flush()
          run = [{ ...last, layer: p.layer, width: p.width }, p]
        } else run.push(p)
      }
      flush()
    }
    for (const v of of<PcbVia>("pcb_via")) {
      const ends = [layerOf(v.from_layer ?? v.layers?.[0]), layerOf(v.to_layer ?? v.layers?.[v.layers.length - 1])]
      // A via with two ends that are layers of the board and not the outer two is a blind or a buried one; any other is through the board.
      const span = ends[0] && ends[1] && ends[0] !== ends[1] ? viaBetween(project.board, ends[0], ends[1]) : {}
      vias.push({
        id: uid("v"),
        x: round(v.x),
        y: round(v.y),
        diameter: v.outer_diameter ?? project.rules.viaDiameter,
        drill: v.hole_diameter ?? project.rules.viaDrill,
        ...span,
      })
    }
  }

  // Free silkscreen text: whatever isn't a part's reference.
  const texts: BoardText[] = []
  for (const t of of<PcbSilkscreenText>("pcb_silkscreen_text")) {
    if (t.pcb_component_id || !t.text?.trim() || !t.anchor_position) continue
    texts.push({
      id: uid("tx"),
      text: t.text,
      x: round(t.anchor_position.x),
      y: round(t.anchor_position.y),
      size: t.font_size ?? 1,
      rot: quarterTurn(t.ccw_rotation).rot,
      side: t.layer === "bottom" ? "bottom" : "top",
    })
  }

  if (skipped.length) notes.push(`Left out ${skipped.length} part${skipped.length > 1 ? "s" : ""} with no pads on the board: ${skipped.join(", ")}.`)
  if (padless.length) notes.push(`Pins with no pad were left off: ${padless.join("; ")}.`)
  if (unsupported.length) notes.push(`Pads of a shape the editor doesn't draw yet were left off: ${unsupported.join("; ")}.`)
  if (merged.length) notes.push(`Nets tscircuit joined under more than one name keep the first: ${merged.join("; ")}.`)

  return {
    project: {
      ...project,
      zones,
      traces,
      vias,
      texts,
      ...(options.source ? { properties: [{ key: "Imported from", value: options.source }] } : {}),
    },
    notes,
  }
}

/**
 * Parts moved apart until none overlaps another, each counted with the labels it is about to
 * carry, keeping the arrangement they had: each overlapping pair is pushed apart along whichever
 * axis frees it sooner.
 */
function spreadApart(project: Project, labels: Map<string, Map<string, string>>): Project {
  const MARGIN = 0.2
  // Each part's extent around its own origin: the symbol, its reference and value, its labels.
  const extents = project.components.map((c) => {
    // The symbol's bounds leave out its reference and value, which sit beside or above it.
    const s = schematicBounds(c)
    const b = { minX: s.minX - 0.45, minY: s.minY - 0.25, maxX: s.maxX + 0.45, maxY: s.maxY + 0.25 }
    for (const pin of schematicPins(c)) {
      const name = labels.get(c.id)?.get(pin.pin)
      if (!name) continue
      const at = pinStubPoint(pin, SCH_GRID * 3)
      const rot: Rotation = pin.dir === "left" ? 180 : pin.dir === "up" ? 90 : pin.dir === "down" ? 270 : 0
      const l = labelBox({ id: "", name, x: at.x, y: at.y, rot })
      expandBox(b, { x: l.minX, y: l.minY })
      expandBox(b, { x: l.maxX, y: l.maxY })
    }
    return { minX: b.minX - c.sch.x - MARGIN, minY: b.minY - c.sch.y - MARGIN, maxX: b.maxX - c.sch.x + MARGIN, maxY: b.maxY - c.sch.y + MARGIN }
  })
  const at = project.components.map((c) => ({ x: c.sch.x, y: c.sch.y }))
  const n = at.length
  for (let pass = 0; pass < 400; pass++) {
    let moved = false
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const a = extents[i]
        const b = extents[j]
        const ox = Math.min(at[i].x + a.maxX, at[j].x + b.maxX) - Math.max(at[i].x + a.minX, at[j].x + b.minX)
        const oy = Math.min(at[i].y + a.maxY, at[j].y + b.maxY) - Math.max(at[i].y + a.minY, at[j].y + b.minY)
        if (ox <= 0 || oy <= 0) continue
        moved = true
        const horizontal = ox < oy
        const ca = horizontal ? at[i].x + (a.minX + a.maxX) / 2 : at[i].y + (a.minY + a.maxY) / 2
        const cb = horizontal ? at[j].x + (b.minX + b.maxX) / 2 : at[j].y + (b.minY + b.maxY) / 2
        const dir = Math.sign(ca - cb) || -1
        const step = (horizontal ? ox : oy) / 2 + SCH_GRID
        if (horizontal) {
          at[i].x += dir * step
          at[j].x -= dir * step
        } else {
          at[i].y += dir * step
          at[j].y -= dir * step
        }
      }
    }
    if (!moved) break
  }
  return {
    ...project,
    components: project.components.map((c, i) => ({
      ...c,
      sch: { ...c.sch, x: round(snap(at[i].x, SCH_GRID)), y: round(snap(at[i].y, SCH_GRID)) },
    })),
  }
}

/** Whether every net drawn on the schematic is exactly one of `nets`, pin for pin. */
function netsMatch(project: Project, nets: ImportNet[]): boolean {
  const { pinNet } = computeConnectivity(project)
  const seen = new Map<string, string>()
  for (const net of nets) {
    const ids = new Set(net.pins.map((p) => pinNet.get(pinKey(p.componentId, p.pin))))
    if (ids.size !== 1) return false
    const [id] = ids
    if (!id || (seen.has(id) && seen.get(id) !== net.name)) return false
    seen.set(id, net.name)
  }
  return true
}

/** Four like holes in the board's corners as its mounting holes; anything else can't be kept. */
function cornerHoles(holes: PcbPadElement[], board: Project["board"], notes: string[]): MountingHoles | null {
  if (!holes.length) return null
  const d = holes[0].hole_diameter
  const insetOf = (h: PcbPadElement) => ({ x: board.width / 2 - Math.abs(h.x - board.x), y: board.height / 2 - Math.abs(h.y - board.y) })
  const inset = insetOf(holes[0]).x
  const quadrants = new Set(holes.map((h) => `${Math.sign(h.x - board.x)},${Math.sign(h.y - board.y)}`))
  const corners =
    holes.length === 4 &&
    quadrants.size === 4 &&
    !!d &&
    inset > 0 &&
    holes.every((h) => h.hole_diameter === d && Math.abs(insetOf(h).x - inset) < 0.05 && Math.abs(insetOf(h).y - inset) < 0.05)
  if (corners) return { drill: d, diameter: holes[0].outer_diameter ?? round(d * 1.8), inset: round(inset) }
  notes.push(`${holes.length} hole${holes.length > 1 ? "s" : ""} drilled outside any part ${holes.length > 1 ? "were" : "was"} left out: the editor only drills mounting holes in the corners.`)
  return null
}
