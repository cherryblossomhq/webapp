import type { AnyCircuitElement } from "circuit-json"
import { round, mm6 } from "../lib/geometry"
import { mountingHoles } from "../model/board"
import { FOOTPRINT_LIBRARY } from "../model/footprints"
import { MOUNTING_HOLE_MARK } from "../model/kicad/mountingHoles"
import { findPart } from "../model/library"
import { componentModel } from "../model/models3d"
import { classValuesOfClass, hasNetClasses } from "../model/netClasses"
import { kicadAttributes, onBoard } from "../model/partFlags"
import { partSheet } from "../model/placementAreas"
import { isHierarchical } from "../model/sheets"
import { zoneClearance } from "../model/rules"
import type { ComponentInstance, PinType, Project } from "../model/types"
import { quoteFlat as quote } from "../lib/kicadQuote"
import { stableUuid } from "./kicadUuid"
import { isObject } from "../lib/guards"
import { kicadModelLines } from "./kicadBoard"
import { FOOTPRINT_BLOCK, referenceOf } from "./kicadBlocks"

// What `circuit-json-to-kicad` leaves out, put into the files it wrote: no-connect flags, the bill
// of materials fields on each symbol, the board's design rules and the pours' settings. The
// converter's files are KiCad's own S-expressions, so each piece here finds the one block it
// changes by the layout the converter prints (two spaces a level) and leaves the rest alone.


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
const flagUuid = (n: number): string => stableUuid("8000", n + 1)

// ---------- Symbol fields ----------

export interface SymbolFields {
  /** Library id of the footprint the board uses. */
  footprint?: string
  /** The value, which the converter leaves empty for a symbol that does not show it. */
  value?: string
  /** A symbol that came from KiCad: each of its fields is written as it had it, an empty one too (the converter's own text for a field the symbol did not have is not). */
  exact?: true
  datasheet?: string
  description?: string
  /** Further fields in the order they are shown, such as MPN, LCSC and Voltage. */
  extra: [string, string][]
}

const RESERVED = new Set(["reference", "value", "footprint", "datasheet", "description"])
const HANDLED_PROPS = new Set(["mpn", "lcsc", "manufacturer", "datasheet", "description", "footprint"])

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

/** The fields a part's symbol carries: part numbers, and every property the symbol doesn't already show. */
export function symbolFields(c: ComponentInstance, footprintIds: Map<string, string>, fromKicad = false): SymbolFields {
  const part = findPart(c.partId)
  const props = c.props
  // A field a KiCad symbol had is named as it was (`Datasheet`, `Description`); the editor's own parts name theirs in lower case.
  const keyOf = (name: string) => Object.keys(props).find((k) => k.toLowerCase() === name)
  const named = (name: string) => {
    const key = keyOf(name)
    return key === undefined ? undefined : props[key]
  }
  const extra: [string, string][] = []
  const mpn = named("mpn") ?? part?.mpn
  // (A field a KiCad symbol had keeps its own spelling: `MANUFACTURER`, `Mpn`.)
  if (mpn) extra.push([fromKicad ? (keyOf("mpn") ?? "MPN") : "MPN", mpn])
  if (named("manufacturer")) extra.push([fromKicad ? keyOf("manufacturer")! : "Manufacturer", named("manufacturer")!])
  if (named("lcsc")) extra.push([fromKicad ? keyOf("lcsc")! : "LCSC", named("lcsc")!])
  for (const [key, value] of Object.entries(props)) {
    // (A field a KiCad symbol had empty stays: the file said it was there.)
    if ((!value && !fromKicad) || HANDLED_PROPS.has(key.toLowerCase()) || key === part?.valueProp || RESERVED.has(key.toLowerCase())) continue
    // A field of a KiCad symbol keeps the name it had; the editor's own properties are capitalised.
    extra.push([fromKicad ? key : capitalise(key), value])
  }
  // A field the symbol had with nothing in it is not among the properties (the editor keeps none that is empty), but its place is: it is written, empty, as it was.
  if (fromKicad) for (const name of Object.keys(c.fields ?? {})) if (!RESERVED.has(name.toLowerCase()) && !HANDLED_PROPS.has(name.toLowerCase()) && name !== part?.valueProp && !extra.some(([k]) => k === name)) extra.push([name, ""])
  // A project that came from KiCad says what the symbol's own footprint field said, not the board's footprint (an empty field stays empty).
  const footprint = fromKicad ? named("footprint") : footprintIds.get(c.ref)
  if (fromKicad) return { footprint: footprint ?? "", value: named("value") ?? "", datasheet: named("datasheet") ?? "", description: named("description"), extra, exact: true }
  return { footprint, datasheet: named("datasheet"), description: named("description") ?? part?.description, extra }
}

/** Reference to footprint library id (as written in the board file), read from the board. */
export function boardFootprintIds(pcb: string): Map<string, string> {
  const ids = new Map<string, string>()
  for (const block of pcb.split(/\r?\n {2}\(footprint\b/).slice(1)) {
    const id = block.match(/^\s*"([^"]+)"/)?.[1]
    const ref = referenceOf(block)
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
    const ref = referenceOf(block)
    const f = ref === undefined ? undefined : fields.get(ref)
    if (!f) return block
    let out = block
    const set = (key: string, value: string | undefined) => {
      if (value || (f.exact && value !== undefined)) out = out.replace(new RegExp(`\\(property "${key}" "[^"]*"`), () => `(property "${key}" ${quote(value)}`)
    }
    set("Footprint", f.footprint)
    set("Value", f.value)
    set("Datasheet", f.datasheet)
    set("Description", f.description)
    // A symbol that had no Description field has none: KiCad then takes the library symbol's (a field written empty would make the footprint's description empty too).
    if (f.exact && f.description === undefined) out = out.replace(/\n {4}\(property "Description" [\s\S]*?\n {4}\)(?=\n)/, "")
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

// ---------- Board file: footprint names, attributes, net ties ----------

/**
 * The converter names a footprint after its own library and the part (`tscircuit:resistor_0603`, `tscircuit:NE555`). The board's are named as the project names them, under one library of
 * their own (`CherryBlossom:0603`, `CherryBlossom:soic8`), which is how a board read back finds the land patterns the editor knows. Found by reference; a footprint with no part (a
 * mounting hole) keeps the converter's name.
 */
export function applyFootprintNames(pcb: string, project: Project): string {
  const names = new Map(project.components.filter((c) => c.footprint).map((c) => [c.ref, c.footprint]))
  return pcb.replace(FOOTPRINT_BLOCK, (block) => {
    const ref = referenceOf(block)
    const name = ref === undefined ? undefined : names.get(ref)
    return name ? block.replace(/^(\n {2}\(footprint\s+)"[^"]*"/, (_m, head: string) => `${head}${quote(`${FOOTPRINT_LIBRARY}:${name}`)}`) : block
  })
}

/**
 * The corner mounting holes of the board, which the converter writes as footprints with no reference (`tscircuit:platedhole_circle_...`), are written as KiCad writes a mounting hole:
 * a footprint named for its drill (`CherryBlossom:MountingHole_3.2mm`), referenced H1 to H4, kept out of the BOM and the position files and on the board only. Each carries a property of
 * its own (`MOUNTING_HOLE_MARK`), by which the import knows them for the board's setting again.
 */
export function applyMountingHoleMarks(pcb: string, project: Project): string {
  if (!mountingHoles(project.board).length) return pcb
  let n = 0
  return pcb.replace(/\n {2}\(footprint\s+"tscircuit:platedhole[^"]*"[\s\S]*?(?=\n {2}\(|\n\)\s*$)/g, (block) => {
    if (block.includes('(property "Reference"')) return block
    n++
    const drill = block.match(/\(drill ([0-9.]+)\)/)?.[1] ?? "0"
    const uuid = (k: number) => stableUuid("8001", 0x1000 + n * 8 + k)
    const field = (key: string, value: string, k: number) =>
      [`    (property ${quote(key)} ${quote(value)}`, "      (at 0 0 0)", "      (layer F.Fab)", "      (hide yes)", `      (uuid ${uuid(k)})`, "      (effects", "        (font", "          (size 1.27 1.27)", "          (thickness 0.15)", "        )", "      )", "    )"].join("\n")
    const attr = "\n    (attr through_hole exclude_from_pos_files exclude_from_bom board_only)\n" + [field("Reference", `H${n}`, 1), field("Value", `MountingHole_${drill}mm`, 2), field(MOUNTING_HOLE_MARK, "yes", 3)].join("\n")
    return block.replace(/^(\n {2}\(footprint\s+)"[^"]*"/, (_m, head: string) => `${head}${quote(`${FOOTPRINT_LIBRARY}:MountingHole_${drill}mm`)}`).replace(/\n {4}\(attr[^\n]*\)/, () => attr)
  })
}

/**
 * The board file with each footprint's attributes (`(attr smd exclude_from_bom)`) and its net tie and
 * jumper groups set from the project's part flags, found by reference. The converter writes a
 * footprint's attributes from its pads alone, so a part with flags gets its own line instead, and the
 * groups follow it. Parts with no flags are left as the converter wrote them.
 */
export function applyFootprintFlags(pcb: string, project: Project): string {
  const flagged = new Map(project.components.filter((c) => c.flags).map((c) => [c.ref, c.flags!]))
  if (!flagged.size) return pcb
  return pcb.replace(FOOTPRINT_BLOCK, (block) => {
    const ref = referenceOf(block)
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

/**
 * Each footprint's 3D model where its part has one of KiCad's 3D library (a built-in part's own, `libraryModels.ts`, or one the project gave it), found by reference and written
 * last, as KiCad writes it. The converter writes none, so KiCad drew the board without bodies and a board read back drew only pads. A model of another kind (a supplier's, a
 * file the user added) has no path KiCad can name, and the export notes it.
 */
export function applyFootprintModels(pcb: string, project: Project): { text: string; notes: string[] } {
  const models = new Map(project.components.flatMap((c) => (c.footprint && c.pcb.placed && onBoard(c) ? [[c.ref, componentModel(project, c)] as const] : [])))
  let other = 0
  const text = pcb.replace(FOOTPRINT_BLOCK, (block) => {
    const ref = referenceOf(block)
    const model = ref === undefined ? undefined : models.get(ref)
    if (!model) return block
    if (model.source !== "kicad") {
      other++
      return block
    }
    const end = block.lastIndexOf("\n  )")
    return `${block.slice(0, end)}${kicadModelLines(model).map((l) => `\n    ${l}`).join("")}${block.slice(end)}`
  })
  return { text, notes: other ? ["A 3D model that is not one of KiCad's stock library has no file the board can name, so it is not written."] : [] }
}

/**
 * X20: the converter's footprints get the component classes of their parts and, in a hierarchical project, the sheet each is from, found by reference: KiCad's
 * `(component_classes (class ...))` and `(sheetname ...)`, which come before the footprint's attributes. Parts with neither are left as the converter wrote them.
 */
export function applyComponentClasses(pcb: string, project: Project): string {
  const hierarchical = isHierarchical(project)
  const wanted = new Map(project.components.filter((c) => c.classes?.length || hierarchical || c.sheetPath !== undefined).map((c) => [c.ref, c]))
  if (!wanted.size) return pcb
  return pcb.replace(FOOTPRINT_BLOCK, (block) => {
    const ref = referenceOf(block)
    const c = ref === undefined ? undefined : wanted.get(ref)
    if (!c) return block
    const lines: string[] = []
    if (c.classes?.length) lines.push(`\n    (component_classes${c.classes.map((n) => ` (class ${quote(n)})`).join("")})`)
    if (hierarchical || c.sheetPath !== undefined) lines.push(`\n    (sheetname ${quote(partSheet(project, c))})`)
    const attr = /\n {4}\(attr[^\n]*\)/
    if (attr.test(block)) return block.replace(attr, (m) => `${lines.join("")}${m}`)
    return block.replace(/(\n {4}\(at [^\n]*\))/, (m) => `${m}${lines.join("")}`)
  })
}

// ---------- Symbols that came from KiCad: units and their texts ----------

/** A symbol's reference or value where its file had it, in the page's millimetres (y down, as KiCad has it). */
export interface PlacedField {
  text: string
  x: number
  y: number
  angle: 0 | 90
  /** Text height in millimetres. */
  size: number
  h?: "left" | "right"
  v?: "top" | "bottom"
}

export interface SymbolLink {
  /** The schematic component the converter wrote this symbol for. */
  id: string
  /** The schematic component of the part's own symbol: symbols with one owner are units of one KiCad symbol. */
  owner: string
  unit: number
  /** A unit drawn only so the library symbol has it: its placed symbol is left out of the file. */
  virtual?: true
  /** The part this is a unit of, by its reference: the units of one part on different sheets are given one library symbol (`shareUnitSymbols`). */
  part?: string
  reference?: PlacedField
  value?: PlacedField
  /** The editor's own symbols: the texts the symbol draws besides its designator and value (its pins' names and numbers), where the editor draws them, on the page. They are written inside the library symbol, as KiCad's own symbol texts. */
  texts?: PlacedField[]
  /** The designator prefix the library symbol names as its reference. */
  refPrefix?: string
  /** The name and electrical type of each pin this symbol draws, by number. */
  pins?: { number: string; wrote?: string; name: string; type?: PinType }[]
}

const PIN_BLOCK = /\n {8}\(pin (\S+) (\S+)\n[\s\S]*?\n {8}\)(?=\n|$)/g
const QUOTED = String.raw`"((?:[^"\\]|\\.)*)"`

/**
 * The pins of a library symbol with the names and electrical types the symbol had. The converter
 * writes every pin as passive and names it by its number; the sheet draws the names itself, so the
 * library's pin names stay hidden and these only say what the pin is, to KiCad's ERC and netlist.
 * A pin the symbol leaves unnamed is written `~`, which is how KiCad writes an empty name (and reads it,
 * before stamp 20250318, which the converter's 20250114 is).
 */
function patchPins(body: string, pins: NonNullable<SymbolLink["pins"]>): string {
  // `wrote` is the number the converter wrote for a pin whose own it cannot say (`writtenPinNumbers`): the pin is found by that and written with its real number.
  const by = new Map(pins.map((p) => [p.wrote ?? p.number, p]))
  return body.replace(PIN_BLOCK, (block, type: string) => {
    const number = block.match(new RegExp(String.raw`\(number ${QUOTED}`))?.[1]
    const pin = number === undefined ? undefined : by.get(number.replace(/\\(.)/g, "$1"))
    if (!pin) return block
    const named = block.replace(`(pin ${type} `, `(pin ${pin.type ?? type} `).replace(new RegExp(String.raw`\(name ${QUOTED}`), () => `(name ${quote(pin.name)}`)
    return pin.wrote === undefined ? named : named.replace(new RegExp(String.raw`\(number ${QUOTED}`), () => `(number ${quote(pin.number)}`)
  })
}

/** The value of each power symbol placed for a net label (the converter names its reference after the label's id) shown where the editor draws the net's name. */
export function applyPowerTexts(sch: string, texts: { id: string; field: PlacedField }[]): string {
  if (!texts.length) return sch
  const by = new Map(texts.map((t) => [`#PWR${t.id}`, t.field]))
  return sch.replace(SYMBOL_BLOCK, (block) => {
    const ref = referenceOf(block)
    const f = ref === undefined ? undefined : by.get(ref)
    return f ? block.replace(/\n {4}\(property "Value"[\s\S]*?\n {4}\)(?=\n)/, () => `\n${propertyBlock("Value", f.text, f)}`) : block
  })
}

/** A text of a library symbol, written from the symbol's origin, its angle in tenths of a degree as KiCad reads a symbol's text (which is where the symbol is placed on the page; the library's y is up, the page's down). */
function symbolTextNode(t: PlacedField, origin: { x: number; y: number } | undefined): string {
  const at = origin ?? { x: 0, y: 0 }
  return [
    `        (text ${quote(t.text)}`,
    `          (at ${mm6(t.x - at.x)} ${mm6(-(t.y - at.y))} ${t.angle * 10})`,
    "          (effects",
    "            (font",
    `              (size ${mm6(t.size)} ${mm6(t.size)})`,
    "            )",
    ...(t.h || t.v ? [`            (justify ${[t.h, t.v].filter(Boolean).join(" ")})`] : []),
    "          )",
    "        )",
  ].join("\n")
}

const LIB_SYMBOL = /\n {4}\(symbol "([^"]+)"\n[\s\S]*?\n {4}\)(?=\n)/g
const SUB_SYMBOL = /\n {6}\(symbol "([^"]+)_(\d+)_(\d+)"\n([\s\S]*?)\n {6}\)(?=\n)/g
const idOf = (libId: string) => libId.match(/_(schematic_component_\d+)$/)?.[1]

const propertyBlock = (key: string, text: string, f: PlacedField) =>
  [
    `    (property ${quote(key)} ${quote(text)}`,
    "      (id " + (key === "Reference" ? 0 : 1) + ")",
    `      (at ${mm6(f.x)} ${mm6(f.y)} ${f.angle})`,
    "      (effects",
    "        (font",
    `          (size ${mm6(f.size)} ${mm6(f.size)})`,
    "        )",
    ...(f.h || f.v ? [`        (justify ${[f.h, f.v].filter(Boolean).join(" ")})`] : []),
    "      )",
    "    )",
  ].join("\n")

/**
 * The symbols that came from KiCad, as KiCad has them. The converter writes one library symbol for
 * each schematic component, so the units of one part would be separate symbols that share a
 * reference, which KiCad reports as duplicates; here the units of a part become the units of one
 * library symbol (`NAME_<unit>_1`) and each placed symbol says which it is. A reference or value
 * the symbol had on show is written where it was (the converter hides both).
 */
export function writeSymbolLinks(sch: string, links: SymbolLink[], libOf?: Map<string, string>): string {
  if (!links.length) return sch
  const byId = new Map(links.map((l) => [l.id, l]))
  let text = sch

  // Units of a part: all the symbols with one owner, when there are several.
  const groups = new Map<string, SymbolLink[]>()
  for (const l of links) groups.set(l.owner, [...(groups.get(l.owner) ?? []), l])
  const libs = new Map<string, { name: string; block: string }>()
  for (const m of text.matchAll(LIB_SYMBOL)) {
    const id = idOf(m[1])
    if (id) libs.set(id, { name: m[1], block: m[0] })
  }
  const baseName = new Map<string, string>()
  for (const [owner, members] of groups) {
    const units = new Set(members.map((m) => m.unit))
    const base = libs.get(owner)
    // A unit alone in its file (its other units are on another sheet) still becomes its own unit of the symbol.
    if ((members.length < 2 && members[0].unit === 1) || units.size < members.length || !base || members.some((m) => !libs.has(m.id))) continue
    const subs = new Map<string, string[]>()
    const taken = (id: string) => [...libs.get(id)!.block.matchAll(SUB_SYMBOL)]
    for (const m of members) subs.set(m.id, taken(m.id).sort((a, b) => Number(a[2]) - Number(b[2]) || Number(a[3]) - Number(b[3])).map((x) => x[4]))
    const found = [...base.block.matchAll(SUB_SYMBOL)]
    const head = base.block.slice(0, found.length ? found[0].index : base.block.lastIndexOf("\n      (embedded_fonts"))
    const last = found[found.length - 1]
    const tail = last ? base.block.slice(last.index + last[0].length) : base.block.slice(head.length)
    const merged = [...members]
      .sort((a, b) => a.unit - b.unit)
      .map((m) => `\n      (symbol "${base.name.slice(base.name.indexOf(":") + 1)}_${m.unit}_1"\n${subs.get(m.id)!.join("\n")}\n      )`)
      .join("")
    text = text.replace(base.block, () => head + merged + tail)
    for (const m of members) if (m.id !== owner) text = text.replace(libs.get(m.id)!.block, "")
    for (const m of members) baseName.set(m.id, base.name)
  }

  // Where each symbol is placed on the page, for texts the library symbol draws (they are written from the symbol's own origin).
  const origins = new Map<string, { x: number; y: number }>()
  for (const m of text.matchAll(SYMBOL_BLOCK)) {
    const libId = m[0].match(/\(lib_id "([^"]+)"/)?.[1]
    const at = m[0].match(/\n {4}\(at (-?[0-9.e-]+) (-?[0-9.e-]+)/)
    const id = libId ? idOf(libId) : undefined
    if (id && at) origins.set(id, { x: Number(at[1]), y: Number(at[2]) })
  }

  // The pins of each library symbol: the names and types of the unit each sub-symbol draws.
  text = text.replace(LIB_SYMBOL, (block, name: string) => {
    const id = idOf(name)
    const mine = links.filter((l) => l.pins && (l.id === id || (baseName.get(l.id) === name && l.owner === id)))
    if (!id || !mine.length) return block
    // The texts the editor's symbol draws (its pins' names and numbers) are texts of the library symbol, in the common drawing (unit 0), where the editor draws them.
    const drawn = mine.flatMap((l) => (l.texts ?? []).map((t) => symbolTextNode(t, origins.get(l.id))))
    const hasCommon = [...block.matchAll(SUB_SYMBOL)].some((m) => m[2] === "0")
    let wrote = false
    // The designator the symbol is numbered with (`J` for a connector, where the converter writes `U`).
    const prefix = mine.find((l) => l.refPrefix)?.refPrefix
    const named = prefix ? block.replace(/(\n {6}\(property "Reference" )"[^"\n]*"/, (_m, head: string) => `${head}${quote(prefix)}`) : block
    return named.replace(SUB_SYMBOL, (sub, _n: string, unit: string, _style: string, body: string) => {
      const link = mine.length === 1 ? mine[0] : mine.find((l) => l.unit === Number(unit))
      let out = link?.pins ? sub.replace(body, () => patchPins("\n" + body, link.pins!).slice(1)) : sub
      if (drawn.length && !wrote && (unit === "0" || !hasCommon)) {
        wrote = true
        out = out.replace(/\n {6}\)$/, () => `\n${drawn.join("\n")}\n      )`)
      }
      return out
    })
  })

  // Each placed symbol: its library symbol and unit, and the texts it shows.
  return text.replace(SYMBOL_BLOCK, (block) => {
    const libId = block.match(/\(lib_id "([^"]+)"/)?.[1]
    const link = libId ? byId.get(idOf(libId) ?? "") : undefined
    if (!link) return block
    if (link.virtual) return ""
    let out = block
    const lib = baseName.get(link.id)
    if (link.part && libOf && libId) libOf.set(lib ?? libId, link.part)
    if (lib) out = out.replace(/\(lib_id "[^"]+"\)/, () => `(lib_id ${quote(lib)})`)
    if (lib || link.unit !== 1) {
      out = out.replace(/\n {4}\(unit \d+\)/, `\n    (unit ${link.unit})`).replace(/\n {10}\(unit \d+\)/, `\n          (unit ${link.unit})`)
    }
    // The pins whose numbers the converter could not say are listed under the number it wrote: they are put back as the pins' own.
    const renumbered = new Map((link.pins ?? []).filter((p) => p.wrote !== undefined).map((p) => [p.wrote!, p.number]))
    if (renumbered.size) out = out.replace(/\n {4}\(pin "((?:[^"\\]|\\.)*)"/g, (m, n: string) => (renumbered.has(n) ? `\n    (pin ${quote(renumbered.get(n)!)}` : m))
    const ref = out.match(/\(property "Reference" "([^"]*)"/)?.[1]
    if (link.reference && ref !== undefined) out = out.replace(/\n {4}\(property "Reference"[\s\S]*?\n {4}\)(?=\n)/, () => `\n${propertyBlock("Reference", ref, link.reference!)}`)
    if (link.value) out = out.replace(/\n {4}\(property "Value"[\s\S]*?\n {4}\)(?=\n)/, () => `\n${propertyBlock("Value", link.value!.text, link.value!)}`)
    return out
  })
}

/**
 * The units of one part that are drawn on different sheets, as one library symbol with every unit in each file that has any of them. The converter writes a library
 * symbol for each symbol it draws, so the unit of a part on one sheet and the units of it on another are different symbols with the same reference; KiCad's file has
 * the part's one library symbol, with all its units, in the cache of every sheet that uses it, and reads the symbols that share a reference and a library symbol as the
 * units of one part. `libOfs` has, for each sheet's text, the library symbols that hold a part's units, by the part.
 */
export function shareUnitSymbols(texts: string[], libOfs: Map<string, string>[]): string[] {
  const unitsOf = new Map<string, Map<number, string>>()
  const own = new Map<string, Set<number>>()
  const where = new Map<string, { sheet: number; lib: string }[]>()
  const blocks = (text: string) => new Map([...text.matchAll(LIB_SYMBOL)].map((m) => [m[1], m[0]] as const))
  texts.forEach((text, i) => {
    const here = blocks(text)
    for (const [lib, part] of libOfs[i]) {
      const block = here.get(lib)
      if (!block) continue
      const subs = [...block.matchAll(SUB_SYMBOL)]
      const common = subs.find((m) => Number(m[2]) === 0)?.[4]
      const mine = new Set<number>()
      const all = unitsOf.get(part) ?? unitsOf.set(part, new Map()).get(part)!
      for (const m of subs) {
        const unit = Number(m[2])
        if (unit === 0) continue
        mine.add(unit)
        // A unit of a symbol that was not merged keeps its shared drawing (unit 0) beside it.
        if (!all.has(unit)) all.set(unit, common ? [common, m[4]].join("\n") : m[4])
      }
      own.set(`${i}|${lib}`, mine)
      ;(where.get(part) ?? where.set(part, []).get(part)!).push({ sheet: i, lib })
    }
  })
  const out = [...texts]
  let shared = 0
  for (const [part, list] of where) {
    const all = unitsOf.get(part)!
    if (list.length < 2 || list.every((w) => own.get(`${w.sheet}|${w.lib}`)!.size === all.size)) continue
    const canonical = `${list[0].lib.replace(/_schematic_component_\d+$/, "")}_part${++shared}`
    const short = canonical.slice(canonical.indexOf(":") + 1)
    for (const sheet of new Set(list.map((w) => w.sheet))) {
      const mine = list.filter((w) => w.sheet === sheet).map((w) => w.lib)
      let text = out[sheet]
      const first = blocks(text).get(mine[0])!
      const subs = [...first.matchAll(SUB_SYMBOL)]
      const head = first.slice(0, subs[0].index).replace(`(symbol "${mine[0]}"`, `(symbol "${canonical}"`)
      const last = subs[subs.length - 1]
      const tail = first.slice(last.index + last[0].length)
      const middle = [...all].sort((a, b) => a[0] - b[0]).map(([unit, body]) => ["", `      (symbol "${short}_${unit}_1"`, body, "      )"].join("\n")).join("")
      text = text.replace(first, () => head + middle + tail)
      for (const lib of mine.slice(1)) text = text.replace(blocks(text).get(lib)!, "")
      for (const lib of mine) text = text.split(`(lib_id "${lib}")`).join(`(lib_id "${canonical}")`)
      out[sheet] = text
    }
  }
  return out
}

// ---------- Board file: pours and mask ----------

const KICAD_LAYER = { top: "F.Cu", bottom: "B.Cu" } as Record<string, string>

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
      .replace(/\(thermal_gap [^)]*\)/, `(thermal_gap ${mm6(rules.thermalGap ?? gap)})`)
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

/** Whether a JSON value is an object that is not a list. */

/** What the project file says of where its files are and of its sheets, which are the export's own (new files, new ids), not the original's. */
const NOT_CARRIED = ["meta", "sheets", "boards", "libraries", "cvpcb"]

/** The converter's project file with the settings of the file the project was imported from laid over it (`KicadCarry.pro`): the keys the original has win, key by key. */
function mergeCarried(into: Json, carried: Json): void {
  for (const [k, v] of Object.entries(carried)) {
    if (isObject(v) && isObject(into[k])) mergeCarried(into[k] as Json, v)
    else into[k] = v
  }
}

/** The .kicad_pro with the project's design rules, default sizes, per-net trace widths and properties. */
export function applyProjectSettings(pro: string, project: Project): KicadProject {
  const rules = project.rules
  const json = JSON.parse(pro) as Json
  // What the original project file had that the editor does not edit comes first; what the project models is written over it below.
  let carriedClasses: Json[] = []
  if (project.kicad?.pro) {
    try {
      const original = JSON.parse(project.kicad.pro) as Json
      for (const k of NOT_CARRIED) delete original[k]
      if (isObject(original.schematic)) {
        delete original.schematic.top_level_sheets
        delete original.schematic.legacy_lib_dir
        delete original.schematic.legacy_lib_list
        delete original.schematic.last_opened_files
      }
      if (isObject(original.pcbnew)) delete original.pcbnew.last_paths
      if (isObject(original.net_settings) && Array.isArray(original.net_settings.classes)) carriedClasses = original.net_settings.classes.filter(isObject)
      mergeCarried(json, original)
    } catch {
      // a project file that does not read is not carried
    }
  }
  const unmatched: string[] = []
  const notes: string[] = []
  const classed = hasNetClasses(rules)
  // The board's smallest clearance is the lowest any class asks for (KiCad raises every pair to it), or the one the project set; a board with no classes has the rules' own.
  const minClearance = rules.minClearance ?? (classed ? Math.min(rules.clearance, ...(rules.netClasses ?? []).map((c) => c.clearance ?? rules.clearance)) : rules.clearance)

  const design = object(object(json, "board"), "design_settings")
  // A rule the editor took from the original project file and that has not been edited since is written as the file had it.
  let original: Json = {}
  try {
    const o = project.kicad?.pro ? (JSON.parse(project.kicad.pro) as Json) : {}
    const d = isObject(o.board) && isObject(o.board.design_settings) ? o.board.design_settings : {}
    original = isObject(d.rules) ? d.rules : {}
  } catch {
    original = {}
  }
  const snapshot = project.kicad?.proRules
  const field = (name: string, current: number | undefined) => snapshot !== undefined && name in snapshot && (snapshot[name] ?? undefined) === current
  const own = (key: string, name: string, current: number | undefined, value: number): number => (typeof original[key] === "number" && field(name, current) ? (original[key] as number) : value)
  Object.assign(object(design, "rules"), {
    min_clearance: own("min_clearance", "minClearance", rules.minClearance, minClearance),
    min_track_width: own("min_track_width", "minTraceWidth", rules.minTraceWidth, rules.minTraceWidth),
    // KiCad 9 has one smallest drill, for vias and through holes alike: the smaller of the two keeps it from flagging what the project allows
    min_through_hole_diameter: own("min_through_hole_diameter", "minDrill", rules.minDrill, rules.minViaDrill !== undefined ? Math.min(rules.minDrill, rules.minViaDrill) : rules.minDrill),
    min_via_annular_width: own("min_via_annular_width", "minAnnularRing", rules.minAnnularRing, rules.minAnnularRing),
    min_via_diameter: own("min_via_diameter", "minViaDiameter", rules.minViaDiameter, rules.minViaDiameter ?? round(rules.minDrill + 2 * rules.minAnnularRing, 6)),
    min_hole_to_hole: own("min_hole_to_hole", "holeClearance", rules.holeClearance, rules.holeClearance),
    // The editor has no hole clearance of its own: the file's is written back, and a board that never had one has the clearance.
    min_hole_clearance: typeof original.min_hole_clearance === "number" ? original.min_hole_clearance : rules.clearance,
    min_copper_edge_clearance: own("min_copper_edge_clearance", "edgeClearance", rules.edgeClearance, rules.edgeClearance),
    ...(rules.maxError !== undefined ? { max_error: rules.maxError } : {}),
    ...(rules.minMicroVia ? { min_microvia_diameter: rules.minMicroVia.diameter, min_microvia_drill: rules.minMicroVia.drill } : {}),
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
  // What the original's net classes said that the project does not model (wire width, colours, line style, bus width, tuning profile) is written back on the class of the same name.
  const rebuilt = settings.classes as Json[]
  for (const c of rebuilt) {
    const was = carriedClasses.find((o) => o.name === c.name)
    if (!was) continue
    // (The other classes' priorities are the order the export writes them in; the Default class is last in KiCad's own files, at the largest int.)
    for (const [k, v] of Object.entries(was)) if (!(k in c) && (k !== "priority" || c.name === "Default")) c[k] = v
  }

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

/** The first file version that has `(power local)`: KiCad 10's. */
export const LOCAL_POWER_VERSION = 20250227

/**
 * The schematic files of a project with their power symbols written as the file's version reads
 * them. The converter writes `(power global)` and stamps KiCad 9's version (20250114), whose parser
 * reads `power` and then expects the closing bracket, so anything after it fails to open: bare
 * `(power)` means global in every version, and is what is written. `(power local)` exists only from
 * version 20250227 (KiCad 10), so when any file has a local power symbol every file is stamped with
 * that version (KiCad 10 reads bare `(power)` too); `kicad10` says so.
 */
export function finishPower(texts: string[]): { texts: string[]; kicad10: boolean } {
  const kicad10 = texts.some((t) => /\(power local\)/.test(t))
  const out = texts.map((t) => {
    const bare = t.replace(/\(power global\)/g, "(power)")
    return kicad10 ? bare.replace(/^(\(kicad_sch\s+\(version )\d+\)/, `$1${LOCAL_POWER_VERSION})`) : bare
  })
  return { texts: out, kicad10 }
}
