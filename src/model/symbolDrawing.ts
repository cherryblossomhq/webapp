import { orientPoint, round, transformPoint } from "../lib/geometry"
import { pinKindOfType } from "./pinKinds"
import { expandPinNumber } from "./pinNumbers"
import { samplePrimitive } from "./primitiveGeometry"
import { SCH_TEXT, anchorToExtent, computeBounds, rotateExtent } from "./symbols"
import type {
  ComponentInstance,
  DrawingItem,
  DrawingPin,
  FieldPlace,
  PartDef,
  PartUnits,
  PinDef,
  PinLabel,
  PinType,
  Rotation,
  ShapeLook,
  SymbolDef,
  SymbolDrawing,
  SymbolPort,
  SymbolPrimitive,
  TextAnchor,
  Vec2,
} from "./types"

// Symbol drawings (S10): what the editor holds of a symbol KiCad drew, and how it becomes the
// symbols and pins the schematic works with. A drawing is KiCad's own data in the editor's units
// (KiCad's 1.27 mm is 0.1), kept whole in the project; everything the editor needs of a part
// (`symbolOf` for the unit and body style on the sheet, the pins, the places of its fields) is
// worked out from it here, so the drawing is the one source and what is drawn can never drift
// from it.

/** One mil in schematic units: KiCad's 50 mil grid is the editor's 0.1. */
const MIL = 0.002
/** KiCad's offsets for pin texts (`PIN_TEXT_MARGIN`, the text offset ratio, the thickness of a default line). */
const PIN_TEXT_OFFSET = 4 * MIL
const PIN_TEXT_MARGIN = 4 * MIL
const PIN_TEXT_THICKNESS = 6 * MIL
/** `TARGET_PIN_RADIUS`: the cross KiCad draws on a pin of the type "no connect". */
const TARGET_PIN_RADIUS = 15 * MIL

const r6 = (v: number) => round(v, 6)

// ---------- units and body styles ----------

export const drawingUnits = (d: SymbolDrawing) => Math.max(1, d.units ?? 1)
export const drawingBodyStyles = (d: SymbolDrawing) => Math.max(1, d.bodyStyles ?? 1)

const inUnit = (item: { unit?: number; body?: number }, unit: number, body: number) => (!item.unit || item.unit === unit) && (!item.body || item.body === body)

/** The pins a placed symbol of this unit and body style has: its own and those shared by every unit or style. */
export function drawingPinsOf(d: SymbolDrawing, unit: number, body: number): DrawingPin[] {
  return d.pins.filter((p) => inUnit(p, unit, body))
}

// ---------- shapes ----------

const lookOf = (item: { width?: number; dash?: ShapeLook["dash"]; color?: string; fill?: string; fillColor?: string }): ShapeLook | undefined => {
  const look: ShapeLook = {}
  if (item.width && item.width > 0) look.width = item.width
  if (item.dash) look.dash = item.dash
  if (item.color) look.color = item.color
  if (item.fill === "background" || item.fill === "color") look.fillKind = item.fill
  if (item.fill === "color" && item.fillColor) look.fillColor = item.fillColor
  return Object.keys(look).length ? look : undefined
}

const withLook = <T extends SymbolPrimitive>(p: T, look: ShapeLook | undefined): T => (look ? { ...p, look } : p)

/** The anchor KiCad's justification names, as the editor's text anchor. */
function anchorOf(h: "left" | "right" | undefined, v: "top" | "bottom" | undefined): TextAnchor {
  if (!h && !v) return "center"
  if (!h) return v === "top" ? "middle_top" : "middle_bottom"
  if (!v) return h === "left" ? "middle_left" : "middle_right"
  return `${v}_${h}` as TextAnchor
}

/** A rectangle with rounded corners as a closed polyline (the drawing keeps the radius; this is how it is shown). */
function roundedRect(a: Vec2, b: Vec2, radius: number): Vec2[] {
  const x0 = Math.min(a.x, b.x)
  const x1 = Math.max(a.x, b.x)
  const y0 = Math.min(a.y, b.y)
  const y1 = Math.max(a.y, b.y)
  const r = Math.min(radius, (x1 - x0) / 2, (y1 - y0) / 2)
  if (r <= 0) return [a, { x: b.x, y: a.y }, b, { x: a.x, y: b.y }, a]
  const out: Vec2[] = []
  const corner = (cx: number, cy: number, from: number) => {
    for (let i = 0; i <= 8; i++) {
      const t = ((from + (i * 90) / 8) * Math.PI) / 180
      out.push({ x: r6(cx + r * Math.cos(t)), y: r6(cy + r * Math.sin(t)) })
    }
  }
  corner(x1 - r, y1 - r, 0)
  corner(x0 + r, y1 - r, 90)
  corner(x0 + r, y0 + r, 180)
  corner(x1 - r, y0 + r, 270)
  out.push(out[0])
  return out
}

function itemPrimitives(item: DrawingItem): SymbolPrimitive[] {
  // A private item is part of the symbol and is not drawn on a sheet (KiCad shows it in the symbol editor only).
  if (item.private) return []
  const look = lookOf(item)
  const fill = item.fill === "outline"
  switch (item.kind) {
    case "polyline":
      return item.points.length >= 2 ? [withLook({ type: "path", points: item.points, fill: fill && item.points.length > 2 }, look)] : []
    case "rectangle": {
      const { a, b } = item
      return [withLook({ type: "path", points: item.radius ? roundedRect(a, b, item.radius) : [a, { x: b.x, y: a.y }, b, { x: a.x, y: b.y }, a], fill }, look)]
    }
    case "circle":
      return item.r > 0 ? [withLook({ type: "circle", x: item.c.x, y: item.c.y, radius: item.r, fill }, look)] : []
    case "arc":
      return [withLook({ type: "arc", start: item.start, mid: item.mid, end: item.end, fill }, look)]
    case "bezier":
      return item.points.length >= 4 ? [withLook({ type: "bezier", points: [item.points[0], item.points[1], item.points[2], item.points[3]], fill }, look)] : []
    case "ellipse":
      return [withLook({ type: "ellipse", x: item.c.x, y: item.c.y, rx: item.rx, ry: item.ry, rotation: item.rotation, ...(item.from !== undefined && item.to !== undefined ? { from: item.from, to: item.to } : {}), fill }, look)]
    case "text":
      // Hidden text is kept in the drawing and not drawn, as KiCad does.
      if (item.hidden || !item.text.trim()) return []
      return [
        {
          type: "text",
          text: item.text,
          x: item.at.x,
          y: item.at.y,
          anchor: anchorOf(item.h, item.v),
          size: item.size ?? SCH_TEXT,
          ...(item.angle ? { angle: item.angle } : {}),
          ...(item.bold ? { bold: true } : {}),
          ...(item.italic ? { italic: true } : {}),
          ...(item.color ? { color: item.color } : {}),
        },
      ]
  }
}

// ---------- pins ----------

/** The way a wire leaves a pin: opposite to the way the pin points at its body. */
export function portDirOf(angle: number): SymbolPort["dir"] {
  const a = ((Math.round(angle / 90) * 90) % 360 + 360) % 360
  return a === 0 ? "left" : a === 90 ? "down" : a === 180 ? "right" : "up"
}

const sign = (v: number) => (v > 0 ? 1 : v < 0 ? -1 : 0)

/**
 * The line of a pin and the marks KiCad puts on its end (a bubble, a clock triangle, the slopes of
 * the active-low shapes, a cross for "not logic") or on a pin of the type "no connect". KiCad's own
 * construction, `SCH_PAINTER::draw( const SCH_PIN* )`, step for step: it works in y down, so the
 * points are turned over on the way in and out.
 */
export function pinGraphics(p: DrawingPin): SymbolPrimitive[] {
  if (p.hidden) return []
  const out: SymbolPrimitive[] = []
  const a = (p.angle * Math.PI) / 180
  // y down, as KiCad draws: `pos` is where a wire meets the pin, `p0` its end at the body, `dir` from p0 to pos.
  const pos = { x: p.x, y: -p.y }
  const p0 = { x: p.x + Math.cos(a) * p.length, y: -(p.y + Math.sin(a) * p.length) }
  const dir = { x: sign(pos.x - p0.x), y: sign(pos.y - p0.y) }
  const numberSize = p.numberSize ?? SCH_TEXT
  const nameSize = p.nameSize ?? SCH_TEXT
  const radius = numberSize / 2
  const diam = radius * 2
  const clock = nameSize !== 0 ? nameSize / 2 : numberSize / 2
  const back = (q: Vec2): Vec2 => ({ x: r6(q.x), y: r6(-q.y) })
  const add = (q: Vec2, x: number, y: number): Vec2 => ({ x: q.x + x, y: q.y + y })
  const line = (...pts: Vec2[]) => out.push({ type: "path", points: pts.map(back), fill: false })
  const circle = (c: Vec2, r: number) => out.push({ type: "circle", x: r6(c.x), y: r6(-c.y), radius: r6(r), fill: false })
  // Where the pin line starts and ends is not always p0 and pos: the line may be zero long.
  line(p0, pos)
  const last = out.pop()!
  if (p.type === "no_connect") {
    out.push(last)
    out.push({ type: "path", points: [back(add(pos, -TARGET_PIN_RADIUS, -TARGET_PIN_RADIUS)), back(add(pos, TARGET_PIN_RADIUS, TARGET_PIN_RADIUS))], fill: false })
    out.push({ type: "path", points: [back(add(pos, TARGET_PIN_RADIUS, -TARGET_PIN_RADIUS)), back(add(pos, -TARGET_PIN_RADIUS, TARGET_PIN_RADIUS))], fill: false })
    return out
  }
  const lowTri = () => {
    if (!dir.y) line(add(p0, dir.x * diam, 0), add(p0, dir.x * diam, -diam), p0)
    else line(add(p0, 0, dir.y * diam), add(p0, -diam, dir.y * diam), p0)
  }
  const clockTri = (inverted: boolean) => {
    if (inverted) line(add(p0, dir.y * clock, -dir.x * clock), add(p0, -dir.x * clock, -dir.y * clock), add(p0, -dir.y * clock, dir.x * clock))
    else if (!dir.y) line(add(p0, 0, clock), add(p0, -dir.x * clock, 0), add(p0, 0, -clock))
    else line(add(p0, clock, 0), add(p0, 0, -dir.y * clock), add(p0, -clock, 0))
  }
  switch (p.shape) {
    default:
    case "line":
      out.push(last)
      break
    case "inverted":
      circle(add(p0, dir.x * radius, dir.y * radius), radius)
      line(add(p0, dir.x * diam, dir.y * diam), pos)
      break
    case "inverted_clock":
      clockTri(true)
      circle(add(p0, dir.x * radius, dir.y * radius), radius)
      line(add(p0, dir.x * diam, dir.y * diam), pos)
      break
    case "clock_low":
    case "edge_clock_high":
      clockTri(true)
      lowTri()
      out.push(last)
      break
    case "clock":
      out.push(last)
      clockTri(false)
      break
    case "input_low":
      out.push(last)
      lowTri()
      break
    case "output_low":
      out.push(last)
      if (!dir.y) line(add(p0, 0, -diam), add(p0, dir.x * diam, 0))
      else line(add(p0, -diam, 0), add(p0, 0, dir.y * diam))
      break
    case "non_logic":
      out.push(last)
      line(add(p0, -(dir.x + dir.y) * radius, -(dir.y - dir.x) * radius), add(p0, (dir.x + dir.y) * radius, (dir.y - dir.x) * radius))
      line(add(p0, -(dir.x - dir.y) * radius, -(dir.x + dir.y) * radius), add(p0, (dir.x - dir.y) * radius, (dir.x + dir.y) * radius))
      break
  }
  return out
}

/** A pin's name and number as the layout of `pinTexts` needs them. */
function labelOf(p: DrawingPin, d: SymbolDrawing, maxNameSize: number): PinLabel {
  const a = (p.angle * Math.PI) / 180
  const name = p.name.trim()
  return {
    number: p.number,
    name: p.name,
    x: p.x,
    y: p.y,
    dx: Math.round(Math.cos(a)),
    dy: Math.round(Math.sin(a)),
    length: p.length,
    nameSize: p.nameSize ?? SCH_TEXT,
    numberSize: p.numberSize ?? SCH_TEXT,
    maxNameSize,
    showName: !d.pinNames?.hidden && name !== "" && name !== "~",
    showNumber: !d.pinNumbersHidden && p.number.trim() !== "",
  }
}

export interface PinText {
  text: string
  /** From the symbol's origin, on the sheet. */
  x: number
  y: number
  angle: 0 | 90
  h: "left" | "center" | "right"
  size: number
  /** The pin text is the pin's number. */
  number: boolean
}

/**
 * Where the name and number of a pin are written once the symbol is turned and mirrored, as KiCad
 * lays them out (`pin_layout_cache.cpp`): names inside the body when the symbol's name offset is
 * more than zero, else above the pin; numbers above the pin (below it when the name is there too),
 * centred along it; on a vertical pin both read upward, the name to the left. The layout follows
 * the pin as it lies on the sheet, so a symbol turned half a turn keeps its texts above its pins.
 */
export function pinTexts(l: PinLabel, sch: { rot: Rotation; mirror?: ComponentInstance["sch"]["mirror"] }, nameOffset: number, name = l.name): PinText[] {
  const out: PinText[] = []
  const at = orientPoint({ x: l.x, y: l.y }, sch.rot, sch.mirror)
  const d = orientPoint({ x: l.dx, y: l.dy }, sch.rot, sch.mirror)
  const horizontal = Math.abs(d.x) > 0.5
  const mid = { x: at.x + (d.x * l.length) / 2, y: at.y + (d.y * l.length) / 2 }
  const showName = l.showName && name.trim() !== "" && name.trim() !== "~"
  if (l.showNumber) {
    // Name and number both outside: the name is above the pin and the number below it.
    const both = showName && nameOffset === 0
    const block = l.numberSize / 2 + PIN_TEXT_OFFSET + PIN_TEXT_MARGIN + PIN_TEXT_THICKNESS
    if (horizontal) out.push({ text: l.number, x: mid.x, y: both ? at.y - block : at.y + block, angle: 0, h: "center", size: l.numberSize, number: true })
    else out.push({ text: l.number, x: both ? at.x + block : at.x - block, y: mid.y, angle: 90, h: "center", size: l.numberSize, number: true })
  }
  if (showName) {
    if (nameOffset > 0) {
      const reach = l.length + nameOffset
      const p = { x: at.x + d.x * reach, y: at.y + d.y * reach }
      if (horizontal) out.push({ text: name, x: p.x, y: p.y, angle: 0, h: d.x > 0 ? "left" : "right", size: l.nameSize, number: false })
      else out.push({ text: name, x: p.x, y: p.y, angle: 90, h: d.y > 0 ? "left" : "right", size: l.nameSize, number: false })
    } else {
      const clearance = PIN_TEXT_OFFSET + PIN_TEXT_MARGIN
      if (horizontal) out.push({ text: name, x: mid.x, y: at.y + l.maxNameSize / 2 + clearance + PIN_TEXT_THICKNESS, angle: 0, h: "center", size: l.nameSize, number: false })
      else out.push({ text: name, x: at.x - (clearance + l.nameSize / 2 + PIN_TEXT_THICKNESS), y: mid.y, angle: 90, h: "center", size: l.nameSize, number: false })
    }
  }
  return out.map((t) => ({ ...t, x: r6(t.x), y: r6(t.y) }))
}

// ---------- building a part from a drawing ----------

function portsOf(pins: DrawingPin[]): SymbolPort[] {
  const ports: SymbolPort[] = []
  for (const p of pins) {
    const dir = portDirOf(p.angle)
    for (const number of expandPinNumber(p.number)) {
      ports.push({ pin: number, x: p.x, y: p.y, dir, type: p.type, ...(p.hidden ? { hidden: true as const } : {}) })
    }
  }
  return ports
}

/** The editor's symbol for one unit of a drawing in one body style. */
export function drawingSymbol(d: SymbolDrawing, unit: number, body: number): SymbolDef {
  const pins = drawingPinsOf(d, unit, body)
  const primitives: SymbolPrimitive[] = []
  for (const item of d.items) if (inUnit(item, unit, body)) primitives.push(...itemPrimitives(item))
  const bodyCount = primitives.length
  for (const p of pins) primitives.push(...pinGraphics(p))
  const ports = portsOf(pins)
  const shown = pins.filter((p) => !p.hidden)
  const maxNameSize = shown.reduce((m, p) => (p.name.trim() && p.name.trim() !== "~" ? Math.max(m, p.nameSize ?? SCH_TEXT) : m), 0)
  const pinLabels = shown.map((p) => labelOf(p, d, maxNameSize))
  const bodyOnly = primitives.slice(0, bodyCount)
  return { primitives, ports, bounds: computeBounds(primitives, ports), ...(bodyOnly.length ? { bodyBounds: computeBounds(bodyOnly, []) } : {}), pinLabels, pinNameOffset: d.pinNames?.offset ?? 0.04 }
}

/** The part's pins: one per number across every unit and body style, in the drawing's order. */
export function drawingPartPins(d: SymbolDrawing): PinDef[] {
  const out: PinDef[] = []
  const seen = new Set<string>()
  for (const p of d.pins) {
    for (const number of expandPinNumber(p.number)) {
      if (seen.has(number)) continue
      seen.add(number)
      const kind = pinKindOfType(p.type, p.name)
      out.push({
        number,
        name: pinDisplayName(p.name, number),
        ...(pinDisplayName(p.name, "") === "" ? { unnamed: true as const } : {}),
        ...(kind && kind !== "unknown" ? { kind } : {}),
        type: p.type,
        ...(p.alternates?.length ? { alternates: p.alternates.map((a) => ({ ...a, name: pinDisplayName(a.name, "") })) } : {}),
      })
    }
  }
  return out
}

/** A pin name as the editor writes it: `~{RESET}` (KiCad's overbar) is `RESET#`, subscripts lose their braces, and no name is the number. */
export function pinDisplayName(raw: string, number: string): string {
  const name = raw
    .replace(/[_^]\{([^{}]*)\}/g, "$1")
    .replace(/~\{([^}]*)\}/g, (_, inner: string) => `${inner}#`)
    .trim()
  return !name || name === "~" ? number : name
}

export interface DrawnPart {
  pins: PinDef[]
  symbol: SymbolDef
  units: PartUnits
  jumpers: NonNullable<PartDef["jumpers"]>
  fieldPlaces: Record<string, FieldPlace>
  /** The text of the symbol's fields, by name. */
  fieldValues: Record<string, string>
}

/** Everything a part takes from its drawing. */
export function drawnPart(d: SymbolDrawing): DrawnPart {
  const count = drawingUnits(d)
  const styles = drawingBodyStyles(d)
  const symbols: Record<string, SymbolDef> = {}
  for (let u = 1; u <= count; u++) for (let b = 1; b <= styles; b++) symbols[`${u}:${b}`] = drawingSymbol(d, u, b)
  const places: Record<string, FieldPlace> = {}
  const values: Record<string, string> = {}
  for (const f of d.fields) {
    places[f.name] = f.place
    values[f.name] = f.value
  }
  return {
    pins: drawingPartPins(d),
    symbol: symbols["1:1"],
    units: { count, bodyStyles: styles, ...(d.unitNames ? { unitNames: d.unitNames } : {}), ...(d.bodyStyleNames ? { bodyStyleNames: d.bodyStyleNames } : {}), symbols },
    // Always present on a KiCad symbol: its pins of one number are separate pins unless it says they are jumpered.
    jumpers: { duplicates: !!d.jumpers?.duplicates, groups: d.jumpers?.groups ?? [] },
    fieldPlaces: places,
    fieldValues: values,
  }
}

// ---------- the symbol a placed component is ----------

const EMPTY_SYMBOL: SymbolDef = { primitives: [], ports: [], bounds: { minX: -0.2, minY: -0.2, maxX: 0.2, maxY: 0.2 } }

/**
 * The drawing of a placed symbol: its unit's and body style's for a part that has them, the part's
 * one drawing otherwise. A unit or style the part does not have is drawn empty, as KiCad draws it.
 */
export function symbolOf(part: PartDef, c?: Pick<ComponentInstance, "unit" | "bodyStyle">): SymbolDef {
  const u = part.units
  if (!u) return part.symbol
  return u.symbols[`${c?.unit ?? 1}:${c?.bodyStyle ?? 1}`] ?? EMPTY_SYMBOL
}

/** How many units a part has, and how many body styles. */
export const unitCount = (part: PartDef) => part.units?.count ?? 1
export const bodyStyleCount = (part: PartDef) => part.units?.bodyStyles ?? 1

// ---------- fields ----------

/** The size a field is drawn at when it names none: KiCad's 50 mil. */
export const FIELD_SIZE = SCH_TEXT

/** A unit as KiCad's references write it: 1 is A, 2 is B, 27 is AA. */
export function unitLetters(unit: number): string {
  let n = Math.max(1, Math.floor(unit))
  let out = ""
  while (n > 0) {
    n--
    out = String.fromCharCode(65 + (n % 26)) + out
    n = Math.floor(n / 26)
  }
  return out
}

/** One field of a placed symbol, as it is written on the sheet. */
export interface FieldText {
  name: string
  /** What is written, name included when the field shows it. */
  text: string
  /** Its place: `x` and `y` are where its anchor is drawn, from the symbol's origin; the angle and justification are the symbol's own, as the file has them. */
  place: FieldPlace
  /** Which way the text extends from its anchor on the sheet (for `WorldText`), once the symbol's turn and mirror are put through its box. */
  extent: { x: -1 | 0 | 1; y: -1 | 0 | 1 }
  /** Whether it reads up the sheet: a field's angle is swapped when the symbol is turned a quarter. */
  vertical: boolean
}

/**
 * How a text of a symbol (a field, a text of its drawing) lies on the sheet, by KiCad's rules
 * (`SCH_FIELD::GetDrawRotation` and `GetBoundingBox`, `sch_field.cpp`): its angle and its
 * justification are the symbol's own, as the file has them. The text box is built in the symbol's
 * frame, along the text's angle and on the side its justification names, and put through the symbol's
 * turn and mirror; the text is then drawn centred in that box, its angle swapped between across
 * and up when the symbol is turned a quarter. So the box stays on the same side of the anchor as the
 * symbol turns, and a text never reads upside down or mirrored.
 */
export function textOnSheet(angle: number, h: "left" | "right" | undefined, v: "top" | "bottom" | undefined, sch: { rot: Rotation; mirror?: ComponentInstance["sch"]["mirror"] }): { extent: { x: -1 | 0 | 1; y: -1 | 0 | 1 }; vertical: boolean } {
  const a = (angle * Math.PI) / 180
  const d = { x: Math.cos(a), y: Math.sin(a) }
  const u = { x: -Math.sin(a), y: Math.cos(a) }
  const hx = h === "left" ? 1 : h === "right" ? -1 : 0
  const vy = v === "top" ? -1 : v === "bottom" ? 1 : 0
  // The box extends along the text for left, against it for right, towards its top for bottom, away from it for top.
  const es = { x: d.x * hx + u.x * vy, y: d.y * hx + u.y * vy }
  const ew = orientPoint(es, sch.rot, sch.mirror)
  const dir = orientPoint(d, sch.rot, sch.mirror)
  const sgn = (n: number) => (Math.abs(n) < 1e-9 ? 0 : n > 0 ? 1 : -1) as -1 | 0 | 1
  return { extent: { x: sgn(ew.x), y: sgn(ew.y) }, vertical: Math.abs(dir.y) > Math.abs(dir.x) + 1e-9 }
}

/**
 * Where a text of the editor's own symbol (its designator, its value, a pin's name) lies on the sheet once the symbol is turned and mirrored, as `SymbolBody` draws it:
 * the anchor's offset from the symbol's origin, which way the text extends from it, and whether it reads up the page.
 */
export function symbolTextOnSheet(
  p: Extract<SymbolPrimitive, { type: "text" }>,
  sch: { rot: Rotation; mirror?: ComponentInstance["sch"]["mirror"] },
): { at: Vec2; extent: { x: -1 | 0 | 1; y: -1 | 0 | 1 }; vertical: boolean } {
  const sgn = (v: number) => (Math.abs(v) < 1e-9 ? 0 : v > 0 ? 1 : -1) as -1 | 0 | 1
  const pinText = p.role === "pin" || p.role === "pinNumber"
  const vertical = sch.rot === 90 || sch.rot === 270
  if (p.angle !== undefined || sch.mirror) {
    const angle = p.angle ?? 0
    const up = Math.abs(angle % 180) === 90
    const e = anchorToExtent(p.anchor)
    const base = up ? { x: -e.y, y: e.x } : { x: e.x, y: e.y }
    const dir = orientPoint({ x: Math.cos((angle * Math.PI) / 180), y: Math.sin((angle * Math.PI) / 180) }, sch.rot, sch.mirror)
    const w = orientPoint(base, sch.rot, sch.mirror)
    return { at: orientPoint(p, sch.rot, sch.mirror), extent: { x: sgn(w.x), y: sgn(w.y) }, vertical: Math.abs(dir.y) > Math.abs(dir.x) + 1e-9 }
  }
  const ext = rotateExtent(anchorToExtent(p.anchor), sch.rot)
  return { at: transformPoint(p, { x: 0, y: 0 }, sch.rot), extent: { x: ext.x, y: ext.y }, vertical: pinText && (p.alongPin ? !vertical : vertical) }
}

/** The text of one field: the reference (with its unit letter when the part has several units), the value (a power port's net), or a property. */
export function fieldValue(c: ComponentInstance, part: PartDef, name: string): string {
  if (name === "Reference") return unitCount(part) > 1 ? `${c.ref}${unitLetters(c.unit ?? 1)}` : c.ref
  if (name === "Value") return part.powerNet ? (c.props.net?.trim() || (part.jumpers && c.props.net !== undefined ? "" : part.powerNet)) : part.valueProp ? (c.props[part.valueProp] ?? "") : ""
  return c.props[name] ?? ""
}

/**
 * The place of a field on a placed symbol: its own, else the part's. A place the part gives is in the
 * symbol's frame, so on a symbol that is turned or mirrored its anchor is turned and mirrored with it
 * (`SCH_FIELD::GetPosition`); a symbol's own place is already where it is drawn.
 */
export function fieldPlaceOf(c: ComponentInstance, part: PartDef, name: string): FieldPlace | undefined {
  const own = c.fields?.[name]
  if (own) return own
  const base = part.fieldPlaces?.[name]
  if (!base) return undefined
  const at = orientPoint({ x: base.x, y: base.y }, c.sch.rot, c.sch.mirror)
  return { ...base, x: r6(at.x), y: r6(at.y) }
}

/**
 * A symbol's own field places taken to its frame (undoing its turn and mirror) and brought out on another
 * orientation: how a field of one symbol is given to another of the same drawing, turned differently.
 */
export function fieldsInFrame(fields: NonNullable<ComponentInstance["fields"]>, sch: { rot: Rotation; mirror?: ComponentInstance["sch"]["mirror"] }): NonNullable<ComponentInstance["fields"]> {
  const back = ((360 - sch.rot) % 360) as Rotation
  return Object.fromEntries(
    Object.entries(fields).map(([name, f]) => {
      const m = sch.mirror === "x" ? { x: f.x, y: -f.y } : sch.mirror === "y" ? { x: -f.x, y: f.y } : { x: f.x, y: f.y }
      const p = orientPoint(m, back)
      return [name, { ...f, x: r6(p.x), y: r6(p.y) }]
    }),
  )
}

/** Field places in a symbol's frame, as they lie on a symbol turned and mirrored as `sch`. */
export function fieldsOnSheet(fields: NonNullable<ComponentInstance["fields"]>, sch: { rot: Rotation; mirror?: ComponentInstance["sch"]["mirror"] }): NonNullable<ComponentInstance["fields"]> {
  return Object.fromEntries(
    Object.entries(fields).map(([name, f]) => {
      const p = orientPoint({ x: f.x, y: f.y }, sch.rot, sch.mirror)
      return [name, { ...f, x: r6(p.x), y: r6(p.y) }]
    }),
  )
}

/** Every field place of a placed symbol, as `fieldPlaceOf` gives it. */
export function fieldPlacesOf(c: ComponentInstance, part: PartDef): Record<string, FieldPlace> {
  const out: Record<string, FieldPlace> = {}
  for (const name of new Set([...Object.keys(part.fieldPlaces ?? {}), ...Object.keys(c.fields ?? {})])) {
    const p = fieldPlaceOf(c, part, name)
    if (p) out[name] = p
  }
  return out
}

/**
 * The fields a placed symbol of an imported part writes on the sheet: every field with a place that is
 * not hidden and has something to say, the reference and value first. The editor's own parts have
 * no field places (their reference and value are texts of the drawing) and give none.
 */
export function componentFields(c: ComponentInstance, part: PartDef): FieldText[] {
  const names = [...new Set([...Object.keys(part.fieldPlaces ?? {}), ...Object.keys(c.fields ?? {})])]
  const order = (n: string) => (n === "Reference" ? 0 : n === "Value" ? 1 : 2)
  names.sort((a, b) => order(a) - order(b))
  const out: FieldText[] = []
  for (const name of names) {
    const place = fieldPlaceOf(c, part, name)
    if (!place || place.hidden) continue
    const value = fieldValue(c, part, name)
    if (!value.trim()) continue
    out.push({ name, text: place.showName ? `${name}: ${value}` : value, place, ...textOnSheet(place.angle, place.h, place.v, c.sch) })
  }
  return out
}

/** Whether a part draws its own reference and value as fields (an imported part) rather than as texts of its symbol. */
export const hasFieldPlaces = (part: PartDef) => !!part.fieldPlaces && Object.keys(part.fieldPlaces).length > 0

// ---------- checking a drawing from a file ----------

const finite = (...values: unknown[]) => values.every((v) => typeof v === "number" && Number.isFinite(v))
const isVec = (p: unknown): p is Vec2 => !!p && typeof p === "object" && finite((p as Vec2).x, (p as Vec2).y)
const PIN_TYPE_SET = new Set<string>(["input", "output", "bidirectional", "tri_state", "passive", "free", "unspecified", "power_in", "power_out", "open_collector", "open_emitter", "no_connect"])
const PIN_SHAPES = new Set(["line", "inverted", "clock", "inverted_clock", "input_low", "clock_low", "output_low", "edge_clock_high", "non_logic"])

function isItem(raw: unknown): raw is DrawingItem {
  if (!raw || typeof raw !== "object") return false
  const i = raw as Record<string, unknown>
  switch (i.kind) {
    case "polyline":
    case "bezier":
      return Array.isArray(i.points) && i.points.every(isVec)
    case "rectangle":
      return isVec(i.a) && isVec(i.b)
    case "circle":
      return isVec(i.c) && finite(i.r)
    case "arc":
      return isVec(i.start) && isVec(i.mid) && isVec(i.end)
    case "ellipse":
      return isVec(i.c) && finite(i.rx, i.ry, i.rotation)
    case "text":
      return typeof i.text === "string" && isVec(i.at) && finite(i.angle)
    default:
      return false
  }
}

function isPin(raw: unknown): raw is DrawingPin {
  if (!raw || typeof raw !== "object") return false
  const p = raw as Record<string, unknown>
  return typeof p.number === "string" && typeof p.name === "string" && typeof p.type === "string" && PIN_TYPE_SET.has(p.type) && typeof p.shape === "string" && PIN_SHAPES.has(p.shape) && finite(p.x, p.y, p.angle, p.length)
}

function isPlace(raw: unknown): raw is FieldPlace {
  if (!raw || typeof raw !== "object") return false
  const f = raw as Record<string, unknown>
  return finite(f.x, f.y) && (f.angle === 0 || f.angle === 90) && (f.size === undefined || (finite(f.size) && (f.size as number) > 0))
}

/** A drawing read from a file, or null when it is not one the editor can draw: one bad item costs the drawing, not a hole in it. */
export function readDrawing(raw: unknown): SymbolDrawing | null {
  if (!raw || typeof raw !== "object") return null
  const d = raw as Record<string, unknown>
  if (typeof d.name !== "string" || !Array.isArray(d.items) || !d.items.every(isItem) || !Array.isArray(d.pins) || !d.pins.every(isPin)) return null
  if (!Array.isArray(d.fields) || !d.fields.every((f) => !!f && typeof f === "object" && typeof (f as { name: unknown }).name === "string" && typeof (f as { value: unknown }).value === "string" && isPlace((f as { place: unknown }).place))) return null
  for (const key of ["units", "bodyStyles"] as const) {
    const v = d[key]
    if (v !== undefined && !(typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 256)) return null
  }
  if (d.power !== undefined && d.power !== "global" && d.power !== "local") return null
  if (d.ki !== undefined && !(Array.isArray(d.ki) && d.ki.every((k) => !!k && typeof k === "object" && typeof (k as { name: unknown }).name === "string" && typeof (k as { value: unknown }).value === "string"))) delete d.ki
  return d as unknown as SymbolDrawing
}

/** The samples of a drawing's curved items, for tests that measure them against the file. */
export const sampleItem = (item: DrawingItem) => itemPrimitives(item).flatMap((p) => samplePrimitive(p))

export type { PinType }

/**
 * The box a field's text covers on the sheet, for hit tests and block frames. Its width is estimated by the
 * length of its text (`advance` is the width of a character in text heights); the box lies on the side of
 * the anchor `f.extent` says, and is tall when the text reads up the sheet.
 */
export function fieldBox(c: Pick<ComponentInstance, "sch">, f: FieldText, advance = 0.6): { minX: number; minY: number; maxX: number; maxY: number } {
  const size = f.place.size ?? SCH_TEXT
  const width = f.text.length * size * advance
  const e = f.extent
  const span = (dir: number, length: number): [number, number] => (dir > 0 ? [0, length] : dir < 0 ? [-length, 0] : [-length / 2, length / 2])
  const x0 = c.sch.x + f.place.x
  const y0 = c.sch.y + f.place.y
  if (f.vertical) {
    // Up the sheet the text runs along y; its top side is world left, so it stands left of the anchor when the extent points left.
    const [ya, yb] = span(e.y, width)
    const [xa, xb] = e.x < 0 ? [-size, 0] : e.x > 0 ? [0, size] : [-size / 2, size / 2]
    return { minX: x0 + xa, maxX: x0 + xb, minY: y0 + ya, maxY: y0 + yb }
  }
  const [xa, xb] = span(e.x, width)
  const [ya, yb] = span(e.y, size)
  return { minX: x0 + xa, maxX: x0 + xb, minY: y0 + ya, maxY: y0 + yb }
}
