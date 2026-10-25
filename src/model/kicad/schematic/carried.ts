import { flagOf, kid, kids, numAt, strAt, type List } from "../board/sexpr"
import { pinsOfUnit, resolveLibSymbol, toSheet } from "./symbols"
import type { KicadSchematic, PlacedSymbol, Pt, SheetFile } from "./types"

// What the builder (`build.ts`) does with the nodes the decision table gives an extension but that
// need none once the schematic is plain. For such a node the accounting says one of two things, and
// only these two count it as handled:
//
//   built    the builder writes it into the project (a symbol's reference)
//   derived  it says only what the editor works out for itself, and the reason says what; every
//            file is checked for the one thing that would make it more (`Plainness`): a label of
//            another size, a wire of another width, a symbol flag that is not a default
//
// A node of neither kind is imported only once its extension is built, so a file with one needs it.

export interface Settled {
  how: "built" | "derived"
  reason?: string
}

/** The facts of a project that decide whether the nodes of a row say anything more than the editor already does. */
export interface Plainness {
  /** Every wire and bus has the default stroke: width 0, a solid style, no colour. */
  wires: boolean
  /** Every local label is drawn as the editor draws one: KiCad's default size, no style, the justification its angle gives. */
  labels: boolean
  /** Every symbol is used once, on the root sheet, with an instance that agrees with its own fields. */
  instances: boolean
  /** Every `sheet_instances` path is the root's. */
  sheetInstances: boolean
  /** No symbol has a flag other than the defaults (in the BOM, on the board, in position files, simulated, populated). */
  flags: boolean
  /** No fonts are embedded. */
  embeddedFonts: boolean
  /** Every junction has KiCad's default dot: diameter 0 (the size of the sheet's setting) and no colour. */
  junctions: boolean
  /** Every no-connect flag is on a pin of a symbol: the pin's `nc` mark. */
  noConnects: boolean
  /** No cached symbol says its pins of one number are jumpered (KiCad's default is no). */
  jumpers: boolean
}

type Fact = keyof Plainness

interface Row {
  re: RegExp
  how: Settled["how"]
  reason?: string
  /** The plainness fact that must hold for the row to apply; absent when it always does. */
  when?: Fact
}

const row = (source: string, how: Settled["how"], reason?: string, when?: Fact): Row => ({ re: new RegExp(`^(?:${source})$`), how, ...(reason ? { reason } : {}), ...(when ? { when } : {}) })

const STROKE = "(?:stroke|stroke>(?:color|type|width)|fill|fill>(?:color|type))"
const TEXT = "(?:effects|effects>(?:justify|href|hide)|effects>font|effects>font>(?:size|thickness|bold|italic|face|color))"

const ROWS: Row[] = [
  row("embedded_fonts", "derived", "no fonts are embedded", "embeddedFonts"),
  row("junction>(?:diameter|color)", "derived", "a junction dot is drawn at the editor's size, and KiCad's default has no colour of its own", "junctions"),
  row("no_connect|no_connect>at", "built", undefined, "noConnects"),
  row("lib_symbols>symbol>duplicate_pin_numbers_are_jumpers", "derived", "no: pins of one number are not jumpered, which is KiCad's default", "jumpers"),
  row("sheet_instances|sheet_instances>path|sheet_instances>path>page", "derived", "the page number of the one sheet", "sheetInstances"),
  row("symbol>instances|symbol>instances>project|symbol>instances>project>path|symbol>instances>project>path>(?:reference|unit)", "built", undefined, "instances"),
  row("symbol>instances>project>path>(?:value|footprint)", "built", undefined, "instances"),
  row("symbol_instances|symbol_instances>path|symbol_instances>path>(?:reference|unit)", "built", undefined, "instances"),
  row("symbol_instances>path>(?:value|footprint)", "built", undefined, "instances"),
  row(`wire>${STROKE}`, "derived", "every wire is drawn at the editor's one width and colour", "wires"),
  row(`(?:label|hierarchical_label)>${TEXT}`, "derived", "a label is drawn at the editor's text size and turned with its angle", "labels"),
  row("symbol>(?:in_bom|on_board|dnp|exclude_from_sim|in_pos_files)", "derived", "every symbol has KiCad's default flags: in the BOM, on the board, populated, simulated", "flags"),
  row("lib_symbols>symbol>(?:in_bom|on_board|exclude_from_sim|in_pos_files)", "derived", "a cached symbol's flags are read from each symbol placed from it"),
]

/** What the builder does with an `extend` node whose extension the project does not need, from its path and the project's plainness. */
export function settledFor(path: string, plain: Plainness): Settled | null {
  for (const r of ROWS) {
    if (!r.re.test(path)) continue
    if (r.when && !plain[r.when]) return null
    return r.how === "derived" ? { how: r.how, reason: r.reason } : { how: r.how }
  }
  return null
}

export const settleFor = (plain: Plainness) => (path: string) => settledFor(path, plain)

// ---------- plainness ----------

const strokeIsPlain = (node: List | undefined): boolean => {
  const stroke = kid(node, "stroke")
  if (!stroke) return true
  if (numAt(kid(stroke, "width"), 1) !== 0) return false
  const type = strAt(kid(stroke, "type"), 1)
  if (type !== undefined && type !== "default" && type !== "solid") return false
  const color = kid(stroke, "color")
  // KiCad's `0 0 0 0` is "no colour of its own": the alpha is the fourth number.
  if (color && numAt(color, 4) !== 0) return false
  return true
}

/** The default justification of a label by its angle: KiCad writes it out in every file. */
export function defaultJustify(angle: number): string {
  const a = ((Math.round(angle) % 360) + 360) % 360
  return a === 180 || a === 270 ? "right bottom" : "left bottom"
}

/** The default text size of a schematic: 50 mil. */
export const DEFAULT_TEXT_SIZE = 1.27

export function labelIsPlain(label: { node: List; angle: number }): boolean {
  const effects = kid(label.node, "effects")
  if (!effects) return true
  const font = kid(effects, "font")
  const size = kid(font, "size")
  if (size && (Math.abs(numAt(size, 1) - DEFAULT_TEXT_SIZE) > 1e-6 || Math.abs(numAt(size, 2) - DEFAULT_TEXT_SIZE) > 1e-6)) return false
  if (font && (flagOf(font, "bold") || flagOf(font, "italic") || kid(font, "thickness") || kid(font, "face") || kid(font, "color"))) return false
  if (flagOf(effects, "hide") || kid(effects, "href")) return false
  const justify = kid(effects, "justify")
  if (justify) {
    const words = justify.slice(1).filter((w): w is string => typeof w === "string")
    if (words.join(" ") !== defaultJustify(label.angle)) return false
  }
  return true
}

/** KiCad's flags of a symbol against the defaults. `in_pos_files` is the one the census's rule leaves out. */
export const symbolFlagged = (s: PlacedSymbol) => s.dnp || !s.inBom || !s.onBoard || s.excludeFromSim || !s.inPosFiles

/** The census's rule for S7: the four flags it knows. */
export const symbolFlaggedByCensus = (s: PlacedSymbol) => s.dnp || !s.inBom || !s.onBoard || s.excludeFromSim

/** A symbol's instance paths that belong to this project (they start with its root sheet's uuid), in the form `/<root>/<sheets...>`. */
export function ownInstances(s: PlacedSymbol, rootUuid: string) {
  return s.instances.filter((i) => i.path === `/${rootUuid}` || i.path.startsWith(`/${rootUuid}/`))
}

export function plainnessOf(files: SheetFile[], rootUuid: string, rootPath: string): Plainness {
  const p: Plainness = { wires: true, labels: true, instances: true, sheetInstances: true, flags: true, embeddedFonts: true, junctions: true, noConnects: true, jumpers: true }
  for (const f of files) {
    const s = f.schematic
    const isRoot = f.path === rootPath
    for (const w of [...s.wires, ...s.buses]) if (!strokeIsPlain(w.node)) p.wires = false
    for (const l of s.labels) if ((l.kind === "local" || l.kind === "hierarchical") && !labelIsPlain(l)) p.labels = false
    for (const sym of s.symbols) {
      if (symbolFlagged(sym)) p.flags = false
      if (!instanceIsPlain(sym, s, isRoot, rootUuid)) p.instances = false
    }
    // KiCad 7 writes the root's own path as `/`, later releases as `/<uuid>`.
    // and the page number of the one sheet is KiCad's default, 1
    if (s.sheetInstances.some((i) => (i.path !== "/" && i.path !== `/${s.uuid}` && i.path !== `/${rootUuid}`) || (i.page !== "" && i.page !== "1"))) p.sheetInstances = false
    for (const j of s.junctions) if (!junctionIsPlain(j.node)) p.junctions = false
    if (!noConnectsOnPins(s, rootUuid)) p.noConnects = false
    for (const l of s.libSymbols) if (kids(l.node, "duplicate_pin_numbers_are_jumpers").some((n) => n[1] === "yes" || n[1] === "true")) p.jumpers = false
    if (kids(s.tree, "embedded_fonts").some((n) => n[1] === "yes" || n[1] === "true")) p.embeddedFonts = false
  }
  return p
}

const junctionIsPlain = (node: List): boolean => numAt(kid(node, "diameter"), 1) === 0 && (!kid(node, "color") || numAt(kid(node, "color"), 4) === 0)

const key = (p: Pt) => `${Math.round(p.x * 1e4)},${Math.round(p.y * 1e4)}`

/** Whether every no-connect flag of a file is on a pin of a symbol placed on it, in the unit the symbol is used as. */
function noConnectsOnPins(s: KicadSchematic, rootUuid: string): boolean {
  if (!s.noConnects.length) return true
  const cache = new Map(s.libSymbols.map((l) => [l.name, l]))
  const at = new Set<string>()
  for (const sym of s.symbols) {
    const base = cache.get(sym.cacheKey)
    if (!base) continue
    let lib
    try {
      lib = resolveLibSymbol(base, (n) => cache.get(n))
    } catch {
      continue
    }
    const units = new Set<number>()
    for (const i of ownInstances(sym, rootUuid)) units.add(i.unit)
    for (const i of s.rootInstances) if (i.path === `/${sym.uuid}` || i.path.endsWith(`/${sym.uuid}`)) units.add(i.unit)
    if (!units.size) units.add(sym.unit)
    for (const u of units) for (const pin of pinsOfUnit(lib, u, sym.bodyStyle)) at.add(key(toSheet(pin.at, sym)))
  }
  return s.noConnects.every((n) => at.has(key(n.at)))
}

function instanceIsPlain(sym: PlacedSymbol, file: KicadSchematic, isRoot: boolean, rootUuid: string): boolean {
  // KiCad 7 and later: the symbol lists where it is used. Only the root sheet's own path is plain.
  const own = ownInstances(sym, rootUuid)
  if (own.length > 1) return false
  if (own.length === 1 && (!isRoot || own[0].path !== `/${rootUuid}`)) return false
  // KiCad 6: the root sheet lists every symbol under its own uuid, with no sheet in front of it.
  if (isRoot) {
    const listed = file.rootInstances.filter((i) => i.path === `/${sym.uuid}`)
    const deeper = file.rootInstances.filter((i) => i.path.endsWith(`/${sym.uuid}`) && i.path !== `/${sym.uuid}`)
    if (listed.length > 1 || deeper.length > 0) return false
  } else if (!own.length) {
    return false
  }
  return true
}
