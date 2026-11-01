import { normalizeAngle, round } from "../../../lib/geometry"
import { digest, drawingKey } from "../../customParts"
import type {
  CustomPartSpec,
  DrawingItem,
  DrawingPin,
  FieldPlace,
  PartCategory,
  PinAlternate,
  PinShape,
  PinType,
  StrokeDash,
  SymbolDrawing,
} from "../../types"
import { flagOf, kid, kids, numAt, strAt, type List } from "../board/sexpr"
import type { LibGraphic, LibPin, LibSymbol, PlacedSymbol, Pt, SchProperty } from "./types"

// Symbol sources (section 5 of docs/kicad-import-schematic.md): the symbols a schematic embeds in
// its `lib_symbols` cache, as the symbol drawings the editor holds (S10). A drawing is KiCad's own
// data in the editor's units (KiCad's 1.27 mm is the editor's 0.1): every shape with its width,
// dash, colour and fill, every pin with its type, shape, alternates and visibility, every unit and
// body style, and the place and look of each field. Nothing of a symbol is left out, and what the
// editor draws is worked out from this, never the other way round.

export { expandPinNumber, MAX_STACKED_PADS } from "../../pinNumbers"

/** Millimetres per editor unit: KiCad's 1.27 mm grid is the editor's 0.1. */
export const MM_PER_UNIT = 12.7

/** A length in millimetres as the editor holds it. */
export const u = (mm: number) => round(mm / MM_PER_UNIT, 6)

/** A symbol with the `extends` of its cache entry followed: the base's pins, drawing and fields stand where it has none. `source` is the cache entry that holds the drawing (the symbol itself, or the base it inherits it from). */
export type ResolvedLibSymbol = LibSymbol & { source: LibSymbol }

export function resolveLibSymbol(symbol: LibSymbol, lookup: (name: string) => LibSymbol | undefined): ResolvedLibSymbol {
  const seen = new Set<string>([symbol.name])
  let merged: ResolvedLibSymbol = { ...symbol, source: symbol }
  let current = symbol
  while (current.extendsName) {
    const base = lookup(current.extendsName)
    if (!base || seen.has(base.name)) throw new Error(`symbol ${symbol.name} extends ${current.extendsName}, which is ${base ? "a cycle" : "not in its library"}`)
    seen.add(base.name)
    const own = new Set(merged.props.map((p) => p.name))
    const inherits = !merged.pins.length
    merged = {
      ...merged,
      props: [...merged.props, ...base.props.filter((p) => !own.has(p.name))],
      pins: merged.pins.length ? merged.pins : base.pins,
      graphics: merged.graphics.length || merged.pins.length ? merged.graphics : base.graphics,
      units: merged.pins.length ? merged.units : base.units,
      bodyStyles: merged.pins.length ? merged.bodyStyles : base.bodyStyles,
      power: merged.power ?? base.power,
      source: inherits ? base : merged.source,
    }
    current = base
  }
  return merged
}

/** The pins a placed symbol has: those of its unit and body style, and those shared by every unit or style. */
export function pinsOfUnit(lib: LibSymbol, unit: number, bodyStyle: number): LibPin[] {
  return lib.pins.filter((p) => (p.unit === 0 || p.unit === unit) && (p.bodyStyle === 0 || p.bodyStyle === bodyStyle))
}

/**
 * A point of a symbol's own frame (y up) on the sheet (y down): the symbol's turn, counter-clockwise
 * on screen, then its mirror, then its place. This is the order KiCad's parser applies them in
 * (`SCH_SYMBOL::SetOrientation`, eeschema/sch_symbol.cpp): the turn from `(at x y angle)` first,
 * then `(mirror x)` (flip across the x axis, y becomes -y) or `(mirror y)` (x becomes -x), both
 * about the symbol's own origin.
 */
export function toSheet(p: Pt, sym: Pick<PlacedSymbol, "at" | "angle" | "mirror">): Pt {
  // The symbol's frame is y up, the sheet's y down.
  const x0 = p.x
  const y0 = -p.y
  const a = normalizeAngle(Math.round(sym.angle))
  let x = x0
  let y = y0
  // Counter-clockwise on a y-down screen: (x, y) becomes (x cos + y sin, -x sin + y cos), exact for quarter turns.
  if (a === 90) [x, y] = [y0, -x0]
  else if (a === 180) [x, y] = [-x0, -y0]
  else if (a === 270) [x, y] = [-y0, x0]
  else if (a !== 0) {
    const r = (a * Math.PI) / 180
    x = x0 * Math.cos(r) + y0 * Math.sin(r)
    y = -x0 * Math.sin(r) + y0 * Math.cos(r)
  }
  if (sym.mirror === "x") y = -y
  else if (sym.mirror === "y") x = -x
  return { x: round(sym.at.x + x, 6), y: round(sym.at.y + y, 6) }
}

/** The direction a wire leaves a pin: opposite to the way the pin points at its body, in the symbol's frame. */
export function portDir(angle: number): "left" | "right" | "up" | "down" {
  const a = ((Math.round(angle / 90) * 90) % 360 + 360) % 360
  return a === 0 ? "left" : a === 90 ? "down" : a === 180 ? "right" : "up"
}

// ---------- the drawing ----------

/** A colour of a file's `(color r g b a)`, or undefined for KiCad's "none of its own" (alpha 0). */
export function colorOf(node: List | undefined): string | undefined {
  if (!node) return undefined
  const [r, g, b] = [numAt(node, 1), numAt(node, 2), numAt(node, 3)]
  const a = numAt(node, 4, 1)
  if (a <= 0) return undefined
  const hex = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0")
  return a >= 1 ? `#${hex(r)}${hex(g)}${hex(b)}` : `rgba(${Math.round(r)},${Math.round(g)},${Math.round(b)},${round(a, 3)})`
}

const DASHES = new Set(["dash", "dot", "dash_dot", "dash_dot_dot"])

type Look = { width?: number; dash?: StrokeDash; color?: string; fill?: "outline" | "background" | "color"; fillColor?: string }

function lookOf(g: LibGraphic): Look {
  const out: Look = {}
  // A width that is not positive is KiCad's "default" and is drawn so; it is kept as the file has it.
  if (g.strokeWidth !== 0) out.width = u(g.strokeWidth)
  if (DASHES.has(g.strokeType)) out.dash = g.strokeType as StrokeDash
  const color = colorOf(kid(kid(g.node, "stroke"), "color"))
  if (color) out.color = color
  if (g.fill === "outline" || g.fill === "background") out.fill = g.fill
  else if (g.fill === "color") {
    out.fill = "color"
    const fc = colorOf(kid(kid(g.node, "fill"), "color"))
    if (fc) out.fillColor = fc
  }
  return out
}

interface TextEffects {
  size?: number
  thickness?: number
  bold?: true
  italic?: true
  h?: "left" | "right"
  v?: "top" | "bottom"
  hidden?: true
  color?: string
}

/** The size, style and justification of a text's `(effects ...)`; KiCad's default (50 mil, centred) is left out. */
function effectsOf(node: List | undefined, notes?: Set<string>): TextEffects {
  const effects = kid(node, "effects")
  const out: TextEffects = {}
  if (!effects) return out
  const font = kid(effects, "font")
  const thickness = numAt(kid(font, "thickness"), 1, 0)
  if (thickness > 0) out.thickness = u(thickness)
  if (kid(font, "face")) notes?.add("a font of its own")
  if (kid(font, "line_spacing")) notes?.add("a line spacing")
  if (kid(effects, "href")) notes?.add("a link")
  const size = numAt(kid(font, "size"), 1, 1.27)
  if (Math.abs(size - 1.27) > 1e-9) out.size = u(size)
  if (flagOf(font, "bold")) out.bold = true
  if (flagOf(font, "italic")) out.italic = true
  const color = colorOf(kid(font, "color"))
  if (color) out.color = color
  for (const w of kid(effects, "justify")?.slice(1) ?? []) {
    if (w === "left" || w === "right") out.h = w
    else if (w === "top" || w === "bottom") out.v = w
  }
  if (flagOf(effects, "hide")) out.hidden = true
  return out
}

const yes = (n: List | undefined) => !!n && (n[1] === "yes" || n[1] === "true" || n[1] === undefined)

const pt = (p: Pt) => ({ x: u(p.x), y: u(p.y) })
const unitBody = (g: { unit: number; bodyStyle: number }) => ({ ...(g.unit ? { unit: g.unit } : {}), ...(g.bodyStyle ? { body: g.bodyStyle } : {}) })

/** One graphic of a cached symbol as drawing items, or a note saying why it is not one. */
function itemOf(g: LibGraphic, notes: Set<string>): DrawingItem | DrawingItem[] | string {
  const base = { ...unitBody(g), ...lookOf(g), ...(flagOf(g.node, "private") ? { private: true as const } : {}) }
  switch (g.kind) {
    case "polyline":
      return { kind: "polyline", points: g.pts.map(pt), ...base }
    case "rectangle": {
      const radius = numAt(kid(g.node, "radius"), 1, 0)
      return { kind: "rectangle", a: pt(g.pts[0]), b: pt(g.pts[1]), ...(radius > 0 ? { radius: u(radius) } : {}), ...base }
    }
    case "circle":
      return { kind: "circle", c: pt(g.pts[0]), r: u(g.radius ?? 0), ...base }
    case "arc":
      if (!g.arc) return "an arc with no ends"
      return { kind: "arc", start: pt(g.arc.start), mid: pt(g.arc.mid), end: pt(g.arc.end), ...base }
    case "bezier":
      return { kind: "bezier", points: g.pts.map(pt), ...base }
    case "ellipse": {
      const isArc = g.node[0] === "ellipse_arc"
      return {
        kind: "ellipse",
        c: pt({ x: numAt(kid(g.node, "center"), 1), y: numAt(kid(g.node, "center"), 2) }),
        rx: u(numAt(kid(g.node, "major_radius"), 1, 1)),
        ry: u(numAt(kid(g.node, "minor_radius"), 1, 1)),
        rotation: numAt(kid(g.node, "rotation_angle"), 1, 0),
        ...(isArc ? { from: numAt(kid(g.node, "start_angle"), 1, 0), to: numAt(kid(g.node, "end_angle"), 1, 90) } : {}),
        ...base,
      }
    }
    case "text": {
      // A text of a cached symbol has its angle in tenths of a degree, as KiCad's parser reads it.
      const angle = numAt(kid(g.node, "at"), 3) / 10
      return { kind: "text", text: g.text ?? "", at: pt(g.pts[0]), angle: ((angle % 360) + 360) % 360, ...effectsOf(g.node, notes), ...base }
    }
    case "text_box":
      return textBoxItems(g, base, notes)
    default:
      return `a drawing of a kind the editor does not know (${String(g.node[0])})`
  }
}

/**
 * A text box of a cached symbol (KiCad 7 and later) as what it draws: its border and fill as a box, and its text inside
 * the margins, placed by its justification. `at` is a corner and `size` reaches the other, y up, as the file has them.
 * Without margins (files before KiCad 8) KiCad's own for a symbol's box is 0.8 of the text's height on every side.
 */
function textBoxItems(g: LibGraphic, base: Look & { unit?: number; body?: number; private?: true }, notes: Set<string>): DrawingItem[] | string {
  const at = kid(g.node, "at")
  const size = kid(g.node, "size")
  if (!at || !size) return "a text box with no corner or size"
  if (Math.round(numAt(at, 3, 0)) % 360 !== 0) return "a turned text box"
  const x0 = numAt(at, 1)
  const y0 = numAt(at, 2)
  const x1 = x0 + numAt(size, 1)
  const y1 = y0 + numAt(size, 2)
  const e = effectsOf(g.node, notes)
  const legacy = numAt(kid(kid(kid(g.node, "effects"), "font"), "size"), 1, 1.27) * 0.8
  const m = kid(g.node, "margins")
  const [ml, mt, mr, mb] = m ? [1, 2, 3, 4].map((i) => numAt(m, i, 0)) : [legacy, legacy, legacy, legacy]
  const left = Math.min(x0, x1)
  const right = Math.max(x0, x1)
  const top = Math.max(y0, y1)
  const bottom = Math.min(y0, y1)
  const x = e.h === "left" ? left + ml : e.h === "right" ? right - mr : (left + ml + right - mr) / 2
  const y = e.v === "top" ? top - mt : e.v === "bottom" ? bottom + mb : (top - mt + bottom + mb) / 2
  const { width: _w, dash: _d, color: _c, fill: _f, fillColor: _fc, ...where } = base
  const items: DrawingItem[] = []
  // A border of a negative width is KiCad's box without one, which leaves its text alone.
  if (g.strokeWidth >= 0) items.push({ kind: "rectangle", a: pt({ x: x0, y: y0 }), b: pt({ x: x1, y: y1 }), ...base })
  if (g.text) items.push({ kind: "text", text: g.text, at: pt({ x, y }), angle: 0, ...e, ...where })
  return items
}

const PIN_TYPES = new Set<string>(["input", "output", "bidirectional", "tri_state", "passive", "free", "unspecified", "power_in", "power_out", "open_collector", "open_emitter", "no_connect"])
const PIN_SHAPES = new Set<string>(["line", "inverted", "clock", "inverted_clock", "input_low", "clock_low", "output_low", "edge_clock_high", "non_logic"])

function pinOf(p: LibPin): DrawingPin | string {
  if (!PIN_TYPES.has(p.type)) return `a pin of the type "${p.type}"`
  if (!PIN_SHAPES.has(p.shape)) return `a pin of the shape "${p.shape}"`
  const angle = normalizeAngle(Math.round(p.angle))
  if (angle % 90 !== 0) return "a pin that does not point along an axis"
  const fontSize = (field: string) => {
    const size = numAt(kid(kid(kid(kid(p.node, field), "effects"), "font"), "size"), 1, 1.27)
    return Math.abs(size - 1.27) > 1e-9 ? u(size) : undefined
  }
  const nameS = fontSize("name")
  const numberS = fontSize("number")
  const alternates: PinAlternate[] = p.alternates.filter((a) => PIN_TYPES.has(a.type) && PIN_SHAPES.has(a.shape)).map((a) => ({ name: a.name, type: a.type as PinType, shape: a.shape as PinShape }))
  return {
    number: p.number,
    name: p.name,
    type: p.type as PinType,
    shape: p.shape as PinShape,
    x: u(p.at.x),
    y: u(p.at.y),
    angle,
    length: u(p.length),
    ...(p.hidden ? { hidden: true as const } : {}),
    ...(p.unit ? { unit: p.unit } : {}),
    ...(p.bodyStyle ? { body: p.bodyStyle } : {}),
    ...(alternates.length ? { alternates } : {}),
    ...(nameS !== undefined ? { nameSize: nameS } : {}),
    ...(numberS !== undefined ? { numberSize: numberS } : {}),
  }
}

/**
 * A field's place and look. `origin` is where the symbol sits in KiCad's sheet (y down) for a placed
 * symbol, whose fields are written in sheet coordinates; absent for a cached symbol's own fields,
 * which are in the symbol's frame (y up).
 */
export function placeOf(prop: SchProperty, origin?: Pt, notes?: Set<string>): FieldPlace {
  const at = prop.at ?? { x: 0, y: 0 }
  const angle = numAt(kid(prop.node, "at"), 3, 0)
  const e = effectsOf(prop.node, notes)
  const place: FieldPlace = {
    x: origin ? u(at.x - origin.x) : u(at.x),
    y: origin ? u(-(at.y - origin.y)) : u(at.y),
    // KiCad turns a field's text to lie across or up, never upside down.
    angle: Math.round(((angle % 180) + 180) % 180) === 90 ? 90 : 0,
    ...(e.size !== undefined ? { size: e.size } : {}),
    ...(prop.hide || e.hidden ? { hidden: true as const } : {}),
    ...(e.h ? { h: e.h } : {}),
    ...(e.v ? { v: e.v } : {}),
    ...(e.bold ? { bold: true as const } : {}),
    ...(e.italic ? { italic: true as const } : {}),
    ...(e.color ? { color: e.color } : {}),
    ...(e.thickness ? { thickness: e.thickness } : {}),
  }
  if (yes(kid(prop.node, "do_not_autoplace"))) place.noAutoplace = true
  const show = kid(prop.node, "show_name")
  if (show && (show[1] === undefined || show[1] === "yes" || show[1] === "true")) place.showName = true
  return place
}

export interface DrawingResult {
  drawing: SymbolDrawing
  /** What of the symbol the drawing cannot hold, in words. The importer refuses a symbol with any. */
  problems: string[]
  /** What the editor draws its own way and the drawing does not keep: the importer says so in its report. */
  notes: string[]
}

/** The drawing of a cached symbol, whole. */
export function drawingFromLib(lib: ResolvedLibSymbol): DrawingResult {
  const problems: string[] = []
  const notes = new Set<string>()
  const source = lib.source
  const items: DrawingItem[] = []
  for (const g of lib.graphics) {
    const item = itemOf(g, notes)
    if (typeof item === "string") problems.push(item)
    else if (Array.isArray(item)) items.push(...item)
    else items.push(item)
  }
  const pins: DrawingPin[] = []
  for (const p of lib.pins) {
    const pin = pinOf(p)
    if (typeof pin === "string") problems.push(pin)
    else pins.push(pin)
  }
  const names = kid(source.node, "pin_names")
  const offset = names ? kid(names, "offset") : undefined
  const unitNames: Record<number, string> = {}
  for (const sub of kids(source.node, "symbol")) {
    const m = /_(\d+)_(\d+)$/.exec(strAt(sub, 1) ?? "")
    const name = strAt(kid(sub, "unit_name"), 1)
    if (m && name) unitNames[Number(m[1])] = name
  }
  const styleNames = (kid(source.node, "body_styles")?.slice(1) ?? []).filter((w): w is string => typeof w === "string" && w !== "demorgan")
  const groups = (kid(source.node, "jumper_pin_groups")?.slice(1) ?? [])
    .filter(Array.isArray)
    .map((g) => (g as unknown[]).filter((w): w is string => typeof w === "string"))
    .filter((g) => g.length > 1)
  const duplicates = yes(kid(source.node, "duplicate_pin_numbers_are_jumpers")) && kid(source.node, "duplicate_pin_numbers_are_jumpers")?.[1] !== undefined
  const drawing: SymbolDrawing = {
    name: lib.name,
    ...(lib.units > 1 ? { units: lib.units } : {}),
    ...(Object.keys(unitNames).length ? { unitNames } : {}),
    ...(lib.bodyStyles > 1 ? { bodyStyles: lib.bodyStyles } : {}),
    ...(styleNames.length ? { bodyStyleNames: styleNames } : {}),
    items,
    pins,
    ...(offset || lib.pinNamesHidden ? { pinNames: { ...(offset ? { offset: u(numAt(offset, 1)) } : {}), ...(lib.pinNamesHidden ? { hidden: true as const } : {}) } } : {}),
    ...(lib.pinNumbersHidden ? { pinNumbersHidden: true as const } : {}),
    ...(lib.power ? { power: lib.power } : {}),
    ...(duplicates || groups.length ? { jumpers: { ...(duplicates ? { duplicates: true as const } : {}), ...(groups.length ? { groups } : {}) } } : {}),
    fields: lib.props.filter((p) => !/^ki_/.test(p.name)).map((p) => ({ name: p.name, value: p.value, place: placeOf(p, undefined, notes) })),
    ...(lib.props.some((p) => /^ki_/.test(p.name)) ? { ki: lib.props.filter((p) => /^ki_/.test(p.name)).map((p) => ({ name: p.name, value: p.value })) } : {}),
  }
  return { drawing, problems, notes: [...notes] }
}

// ---------- parts ----------

const PREFIX = /^[A-Za-z]{1,3}/

const CATEGORY_BY_PREFIX: [RegExp, PartCategory][] = [
  [/^(J|P|CN|CON|USB|X)$/, "Connectors"],
  [/^(Q|M|T)$/, "Transistors"],
  [/^(D|LED|TVS|Z)$/, "Diodes"],
  [/^(SW|S|K|BTN|RLY|BZ)$/, "Electromechanical"],
  [/^(R|C|L|F|FB|Y|XTAL|TP)$/, "Passives"],
]

const prop = (lib: LibSymbol, name: string) => lib.props.find((p) => p.name === name)?.value ?? ""

/**
 * The spec of the part a cached symbol is, naming its drawing by `key` in the project's symbols.
 * The part's id is a hash of its definition (the drawing's key, name and footprint), so one symbol
 * on one footprint is one part, however many times it is placed.
 */
export function specFromSymbol(lib: LibSymbol, drawing: SymbolDrawing, footprint: string): { spec: Omit<CustomPartSpec, "id">; key: string } {
  const key = drawingKey(drawing)
  const reference = prop(lib, "Reference")
  const power = !!lib.power
  // A reference that begins with # (`#PWR`, `#FLG`) is a symbol with no part behind it.
  const virtual = power || reference.startsWith("#")
  const letters = power ? "#PWR" : (virtual ? "#" : "") + (PREFIX.exec(reference.replace(/^#/, ""))?.[0] ?? "U").toUpperCase()
  const category: PartCategory = virtual ? "Symbols" : (CATEGORY_BY_PREFIX.find(([re]) => re.test(letters))?.[1] ?? "ICs")
  const description = prop(lib, "Description") || prop(lib, "ki_description")
  return {
    key,
    spec: {
      name: lib.name.includes(":") ? lib.name.slice(lib.name.indexOf(":") + 1) : lib.name,
      description: description || "From a KiCad schematic",
      category,
      refPrefix: letters,
      footprint,
      pins: [],
      drawing: key,
      props: {},
      valueProp: "value",
    },
  }
}

export { digest }
