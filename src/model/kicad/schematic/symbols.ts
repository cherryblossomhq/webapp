import { digest } from "../../customParts"
import { round } from "../../../lib/geometry"
import type { PartCategory, PartDef, PinDef, SymbolDef, SymbolPort, SymbolPrimitive, Vec2 } from "../../types"
import { symbolDef } from "../../symbols"
import { pinKindOf } from "../board/build"
import { cleanPinName } from "../symbol"
import type { LibGraphic, LibPin, LibSymbol, PlacedSymbol, Pt } from "./types"

// Symbol sources (section 5 of docs/kicad-import-schematic.md): the symbols a schematic embeds in
// its `lib_symbols` cache, as the editor's `SymbolDef` and `PinDef`. The pins are exact: their
// places, numbers, names and directions are KiCad's, scaled to the editor's grid (KiCad's 1.27 mm
// is the editor's 0.1). The drawing is not: the editor draws paths, circles and text, so arcs,
// curves, fills and strokes are what extensions S6 and S10 add, and `needs` says which of them a
// symbol uses. A project never holds such a symbol until those are built; the builder registers it
// in memory for measurement and tests only.

/** Millimetres per editor unit: KiCad's 1.27 mm grid is the editor's 0.1. */
export const MM_PER_UNIT = 12.7

const mm = (v: number) => round(v / MM_PER_UNIT, 6)

/** A symbol with the `extends` of its cache entry followed: the base's pins, drawing and fields stand where it has none. */
export function resolveLibSymbol(symbol: LibSymbol, lookup: (name: string) => LibSymbol | undefined): LibSymbol {
  const seen = new Set<string>([symbol.name])
  let merged = symbol
  let current = symbol
  while (current.extendsName) {
    const base = lookup(current.extendsName)
    if (!base || seen.has(base.name)) throw new Error(`symbol ${symbol.name} extends ${current.extendsName}, which is ${base ? "a cycle" : "not in its library"}`)
    seen.add(base.name)
    const own = new Set(merged.props.map((p) => p.name))
    merged = {
      ...merged,
      props: [...merged.props, ...base.props.filter((p) => !own.has(p.name))],
      pins: merged.pins.length ? merged.pins : base.pins,
      graphics: merged.graphics.length || merged.pins.length ? merged.graphics : base.graphics,
      units: merged.pins.length ? merged.units : base.units,
      bodyStyles: merged.pins.length ? merged.bodyStyles : base.bodyStyles,
      power: merged.power ?? base.power,
    }
    current = base
  }
  return merged
}

/** The most pads one drawn pin may stand for: KiCad has no limit, a file that asks for more is not a schematic. */
export const MAX_STACKED_PADS = 10000

const isSpecial = (c: string) => c === "[" || c === "]" || c === "," || c === "-" || c === "\\"
/** A backslash is an escape only before one of the notation's own characters (`ExpandStackedPinNotation`, common/string_utils.cpp). */
const isEscapeAt = (t: string, i: number) => t[i] === "\\" && i + 1 < t.length && isSpecial(t[i + 1])

function splitUnescaped(inner: string): string[] {
  const parts: string[] = []
  let current = ""
  for (let i = 0; i < inner.length; i++) {
    if (isEscapeAt(inner, i)) {
      current += inner[i] + inner[i + 1]
      i++
    } else if (inner[i] === ",") {
      parts.push(current)
      current = ""
    } else current += inner[i]
  }
  parts.push(current)
  return parts
}

function unescapeItem(item: string): string {
  let out = ""
  for (let i = 0; i < item.length; i++) {
    if (isEscapeAt(item, i)) out += item[++i]
    else out += item[i]
  }
  return out
}

function findUnescaped(text: string, ch: string): number {
  for (let i = 0; i < text.length; i++) {
    if (isEscapeAt(text, i)) i++
    else if (text[i] === ch) return i
  }
  return -1
}

/** A pin number as a prefix and its trailing digits, or -1 when it has none: `A12` is `A` and 12. */
function alphaNumeric(pin: string): [string, number] {
  let numStart = pin.length
  for (let i = pin.length - 1; i >= 0; i--) {
    if (!/[0-9]/.test(pin[i])) {
      numStart = i + 1
      break
    }
    if (i === 0) numStart = 0
  }
  if (numStart < pin.length) return [pin.slice(0, numStart), Number(pin.slice(numStart))]
  return [pin.slice(0, 0), -1]
}

/**
 * The pad numbers one drawn pin stands for: KiCad's `ExpandStackedPinNotation`. KiCad 9 lets a pin
 * be `[1,2,3]`, `[1-5]` or `[6,7,9-11]`, and `[A1-A4]` for a run with a common prefix; a dash, comma or
 * bracket inside one number is written with a backslash. A notation KiCad cannot read (a bracket with
 * no partner, a range whose ends have other prefixes or run backwards, an empty list) is the one pin
 * that has the text as its number, and so is anything not in brackets.
 */
export function expandPinNumber(raw: string): string[] {
  const open = raw.includes("[")
  const close = raw.includes("]")
  const bracketed = raw.startsWith("[") && raw.endsWith("]")
  if ((open || close) && !bracketed) return [raw]
  if (!bracketed) return [raw]
  const out: string[] = []
  for (let part of splitUnescaped(raw.slice(1, -1))) {
    part = part.trim()
    if (part === "") continue
    const dash = findUnescaped(part, "-")
    if (dash < 0) {
      out.push(unescapeItem(part))
      continue
    }
    const start = unescapeItem(part.slice(0, dash)).trim()
    const end = unescapeItem(part.slice(dash + 1)).trim()
    const [sp, sv] = alphaNumeric(start)
    const [ep, ev] = alphaNumeric(end)
    if (sp !== ep || sv === -1 || ev === -1 || sv > ev || out.length + (ev - sv + 1) > MAX_STACKED_PADS) return [raw]
    for (let n = sv; n <= ev; n++) out.push(`${sp}${n}`)
  }
  return out.length ? out : [raw]
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
  const a = ((Math.round(sym.angle) % 360) + 360) % 360
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
export function portDir(angle: number): SymbolPort["dir"] {
  const a = ((Math.round(angle / 90) * 90) % 360 + 360) % 360
  return a === 0 ? "left" : a === 90 ? "down" : a === 180 ? "right" : "up"
}

// ---------- the drawing ----------

const hasText = (s: string) => s.trim() !== "" && s.trim() !== "~"

/** What of a symbol's drawing the editor cannot draw: each reason once. Empty when it can all be drawn. */
export function drawingNeeds(lib: LibSymbol): string[] {
  const out = new Set<string>()
  for (const g of lib.graphics) {
    if (g.kind === "arc") out.add("an arc")
    else if (g.kind === "bezier") out.add("a curve")
    else if (g.kind === "ellipse") out.add("an ellipse")
    else if (g.kind === "text_box") out.add("a text box")
    else if (g.kind === "other") out.add("a drawing the editor does not know")
    if (g.fill && g.fill !== "none") out.add(`a ${g.fill} fill`)
    if (g.strokeWidth > 0) out.add("a stroke width of its own")
    if (g.strokeType !== "default" && g.strokeType !== "solid") out.add(`a ${g.strokeType} line`)
  }
  for (const p of lib.pins) {
    if (p.shape !== "line") out.add(`a ${p.shape} pin`)
    if (p.alternates.length) out.add("alternate pin functions")
  }
  return [...out]
}

const path = (points: Vec2[], fill = false): SymbolPrimitive => ({ type: "path", points, fill })

function graphicPrimitives(g: LibGraphic): SymbolPrimitive[] {
  const fill = g.fill !== null && g.fill !== "none"
  const v = (p: Pt): Vec2 => ({ x: mm(p.x), y: mm(p.y) })
  switch (g.kind) {
    case "polyline":
      return g.pts.length >= 2 ? [path(g.pts.map(v), fill && g.pts.length > 2)] : []
    case "rectangle": {
      const [a, b] = g.pts
      return a && b ? [path([v(a), v({ x: b.x, y: a.y }), v(b), v({ x: a.x, y: b.y }), v(a)], fill)] : []
    }
    case "circle":
      return g.pts[0] && g.radius ? [{ type: "circle", x: mm(g.pts[0].x), y: mm(g.pts[0].y), radius: mm(g.radius), fill }] : []
    case "arc": {
      if (!g.arc || g.arc.radius <= 0) return g.arc ? [path([v(g.arc.start), v(g.arc.end)])] : []
      // Sampled as a path: an approximation, which `drawingNeeds` names.
      const { center, radius, start, mid, end } = g.arc
      const ang = (p: Pt) => Math.atan2(p.y - center.y, p.x - center.x)
      const aS = ang(start)
      const aM = ang(mid)
      const aE = ang(end)
      const norm = (a: number) => ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)
      const ccw = norm(aM - aS) < norm(aE - aS)
      const sweep = ccw ? norm(aE - aS) : -norm(aS - aE)
      const steps = Math.max(4, Math.ceil(Math.abs(sweep) / (Math.PI / 12)))
      const pts: Vec2[] = []
      for (let i = 0; i <= steps; i++) {
        const a = aS + (sweep * i) / steps
        pts.push(v({ x: center.x + radius * Math.cos(a), y: center.y + radius * Math.sin(a) }))
      }
      return [path(pts)]
    }
    case "bezier":
      return g.pts.length >= 2 ? [path(g.pts.map(v))] : []
    case "text":
      return g.text && hasText(g.text) && g.pts[0] ? [{ type: "text", text: g.text, x: mm(g.pts[0].x), y: mm(g.pts[0].y), anchor: "center", size: 0.1 }] : []
    default:
      return []
  }
}

const ANCHOR_BY_DIR = { left: "middle_left", right: "middle_right", up: "middle_bottom", down: "middle_top" } as const

function pinPrimitives(p: LibPin, hideNames: boolean, hideNumbers: boolean): SymbolPrimitive[] {
  const out: SymbolPrimitive[] = []
  const dir = portDir(p.angle)
  // The wire leaves opposite to `dir`'s inverse: the body is toward `p.angle`.
  const toward = { x: Math.round(Math.cos((p.angle * Math.PI) / 180)), y: Math.round(Math.sin((p.angle * Math.PI) / 180)) }
  const a = { x: mm(p.at.x), y: mm(p.at.y) }
  const b = { x: mm(p.at.x + toward.x * p.length), y: mm(p.at.y + toward.y * p.length) }
  if (p.length > 0) out.push(path([a, b]))
  if (!hideNames && hasText(p.name) && !p.hidden) {
    // The name sits inside the body, past the end of the pin.
    const inside = { x: mm(p.at.x + toward.x * (p.length + 0.762)), y: mm(p.at.y + toward.y * (p.length + 0.762)) }
    out.push({ type: "text", text: cleanPinName(p.name, p.number), x: inside.x, y: inside.y, anchor: ANCHOR_BY_DIR[dir], size: 0.1, role: "pin" })
  }
  if (!hideNumbers && hasText(p.number) && !p.hidden) {
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 + (toward.x !== 0 ? 0.03 : 0) }
    out.push({ type: "text", text: p.number, x: mid.x, y: mid.y, anchor: "middle_bottom", size: 0.08, role: "pinNumber" })
  }
  return out
}

/** The editor's symbol for a placed symbol's unit and body style: KiCad's pins at KiCad's places, and the drawing the editor can draw. */
export function convertCachedSymbol(lib: LibSymbol, unit: number, bodyStyle: number, bake?: Pick<PlacedSymbol, "at" | "angle" | "mirror">): { symbol: SymbolDef; pins: PinDef[] } {
  const pins = pinsOfUnit(lib, unit, bodyStyle)
  // A mirrored symbol cannot be turned by the editor (S5); for measurement it is baked into the ports, with the turn.
  const place = (p: Pt): Pt => {
    if (!bake) return p
    const w = toSheet(p, { ...bake, at: { x: 0, y: 0 } })
    return { x: w.x, y: -w.y }
  }
  const ports: SymbolPort[] = []
  const primitives: SymbolPrimitive[] = []
  const seen = new Set<string>()
  for (const g of lib.graphics) {
    if ((g.unit !== 0 && g.unit !== unit) || (g.bodyStyle !== 0 && g.bodyStyle !== bodyStyle)) continue
    primitives.push(...graphicPrimitives(g))
  }
  for (const p of pins) {
    primitives.push(...pinPrimitives(p, lib.pinNamesHidden, lib.pinNumbersHidden))
    for (const number of expandPinNumber(p.number)) {
      if (seen.has(number)) continue
      seen.add(number)
      const at = place(p.at)
      const dir = bake ? rotateDirBy(portDir(p.angle), bake) : portDir(p.angle)
      ports.push({ pin: number, x: mm(at.x), y: mm(at.y), dir })
    }
  }
  const def = bake
    ? symbolDef(primitives.map((q) => bakePrimitive(q, bake)), ports)
    : symbolDef(primitives, ports)
  const pinDefs: PinDef[] = []
  const done = new Set<string>()
  for (const p of pins) {
    const kind = pinKindOf(p.type, p.name)
    for (const number of expandPinNumber(p.number)) {
      if (done.has(number)) continue
      done.add(number)
      // The name as the library import writes it: an overbar is a trailing `#`, a subscript is dropped, an empty name is the number.
      pinDefs.push({ number, name: cleanPinName(p.name, number), ...(kind && kind !== "unknown" ? { kind } : {}) })
    }
  }
  return { symbol: def, pins: pinDefs }
}

const DIRS: SymbolPort["dir"][] = ["right", "up", "left", "down"]

function rotateDirBy(dir: SymbolPort["dir"], s: Pick<PlacedSymbol, "angle" | "mirror">): SymbolPort["dir"] {
  const turns = ((Math.round(s.angle / 90) % 4) + 4) % 4
  let d = DIRS[(DIRS.indexOf(dir) + turns) % 4]
  // In the editor's y-up frame `mirror x` flips up and down, `mirror y` flips left and right.
  if (s.mirror === "x") d = d === "up" ? "down" : d === "down" ? "up" : d
  else if (s.mirror === "y") d = d === "left" ? "right" : d === "right" ? "left" : d
  return d
}

function bakePrimitive(q: SymbolPrimitive, bake: Pick<PlacedSymbol, "angle" | "mirror">): SymbolPrimitive {
  const t = (p: Vec2): Vec2 => {
    const w = toSheet({ x: p.x * MM_PER_UNIT, y: p.y * MM_PER_UNIT }, { ...bake, at: { x: 0, y: 0 } })
    return { x: mm(w.x), y: mm(-w.y) }
  }
  if (q.type === "path") return { ...q, points: q.points.map(t) }
  if (q.type === "circle") return { ...q, ...t({ x: q.x, y: q.y }) }
  return { ...q, ...t({ x: q.x, y: q.y }) }
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
 * The part a symbol is in the editor: its pins and drawing, no footprint until the project import
 * gives it one. `variant` names the unit, body style and bake the part was made for, so one cached
 * symbol used in several ways is several parts.
 */
export function partFromSymbol(lib: LibSymbol, unit: number, bodyStyle: number, bake?: Pick<PlacedSymbol, "at" | "angle" | "mirror">, footprints: string[] = []): PartDef {
  const { symbol, pins } = convertCachedSymbol(lib, unit, bodyStyle, bake)
  const reference = prop(lib, "Reference")
  const letters = (PREFIX.exec(reference.replace(/^#/, ""))?.[0] ?? "U").toUpperCase()
  const category = CATEGORY_BY_PREFIX.find(([re]) => re.test(letters))?.[1] ?? "ICs"
  const bakeKey = bake ? `${bake.angle}${bake.mirror}` : ""
  const key = JSON.stringify([lib.name, unit, bodyStyle, bakeKey, footprints])
  const description = prop(lib, "Description") || prop(lib, "ki_description")
  return {
    id: `kicad-${digest(key)}`,
    name: lib.name.includes(":") ? lib.name.slice(lib.name.indexOf(":") + 1) : lib.name,
    category,
    description: description || "From a KiCad schematic",
    refPrefix: letters,
    pins,
    symbol,
    footprints,
    defaultProps: {},
    valueProp: "value",
    custom: true,
  }
}

