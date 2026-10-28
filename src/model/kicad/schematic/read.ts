import type { SharedFlag } from "../../partFlags"
import { newReport, type ImportReport } from "../board/report"
import { convertOverbar, decodeNetName } from "../board/read"
import { decodeBytes, flagOf, kid, kids, KicadReadError, nameOf, numAt, parseSexpr, strAt, type List } from "../board/sexpr"
import type {
  BusEntry,
  LegacyInfo,
  EmbeddedFileRef,
  KicadSchematic,
  LabelKind,
  LibGraphic,
  LibGraphicKind,
  LibPin,
  LibSymbol,
  PlacedSymbol,
  Pt,
  SchEra,
  SchGroup,
  SchLabel,
  SchProperty,
  SchSheet,
  SchWire,
  SheetInstance,
  SheetPin,
  SymbolInstance,
  VariantRead,
} from "./types"

// The reader: a KiCad schematic file of any release from KiCad 6 on (stamps 20200310 to 11) into
// `KicadSchematic`. It goes by the token wherever KiCad's own parser does, and by the version stamp
// only where the file format really changed with it. The switches are the rows of section 6 of
// docs/kicad-import-schematic.md, each with its test in tests/kicad-schematic-read.test.ts.

/** The newest stamp in the KiCad source this reader was written against (the corpus's newest file is 20260306). */
export const NEWEST_KNOWN_STAMP = 20261018

/** Switch 4: `~NAME~` before this stamp is an overbar, `~{NAME}` from it (the parser converts pin names, label texts and a power symbol's value at the same stamp). */
export const OVERBAR_NOTATION_FROM = 20210606
export const NET_NAME_OVERBAR_FROM = 20210606
/** Switch 9: a single `~` as a property value, pin name or pin number is empty before this stamp. */
export const TILDE_IS_EMPTY_UNTIL = 20250317
/** Switch 8: in files up to this stamp a sheet's first property is its name and the second its file. */
export const SHEET_FIELDS_BY_POSITION_UNTIL = 20200310
/** Switch 10: in files up to this stamp a symbol arc of more than a half turn is replaced by its complement. */
export const ARC_COMPLEMENT_UNTIL = 20230121

/** A file that cannot be read as a KiCad schematic at all, with the reason in plain words. */
export class KicadSchematicReadError extends Error {
  constructor(
    readonly code: "empty" | "missing-root" | "not-sexpr" | "unbalanced" | "truncated" | "not-a-schematic" | "legacy-schematic" | "legacy-damaged" | "unknown-record" | "too-deep" | "encoding" | "bad-number" | "bad-value",
    message: string,
    /** For `unknown-record`: the record the legacy file has that this importer does not know, as the accounting names it. */
    readonly path: string | null = null,
  ) {
    super(message)
  }
}

/** KiCad's release for a stamp (docs/kicad-import-schematic.md, section 2). */
export function schEraOf(stamp: number | null): SchEra {
  if (stamp === null) return "unknown"
  if (stamp < 20211123) return "pre6-nightly"
  if (stamp <= 20211123) return "kicad6"
  if (stamp <= 20230121) return "kicad7"
  if (stamp <= 20231120) return "kicad8"
  if (stamp <= 20250114) return "kicad9"
  if (stamp <= 20260206) return "kicad10"
  return "kicad11-dev"
}

/**
 * The flags of a part that both a symbol and its footprint have, which the symbol is the authority for. KiCad's
 * "Update PCB from Schematic" copies a symbol's flag to the footprint only from some release on (read from
 * `pcbnew/netlist_reader/board_netlist_updater.cpp` of each branch: 6.0 and 7.0 copy `exclude_from_bom` only, 8.0 and
 * 9.0 add `dnp`, 10.0 adds `exclude_from_pos_files`; the simulation flag only on master, after 10.0). A symbol that has
 * no word for a flag (KiCad 9's has no `in_pos_files`) says nothing about it. So a footprint's own flag stands
 * unless the file's release copies the flag and the symbol states it.
 */
export function flagVoice(sym: Pick<PlacedSymbol, "stamp" | "stated">): { authority: Set<SharedFlag>; stated: Set<SharedFlag> } {
  const era = schEraOf(sym.stamp)
  const known = era !== "unknown"
  const copies: Record<SharedFlag, boolean> = {
    excludeFromBom: known,
    dnp: era === "kicad8" || era === "kicad9" || era === "kicad10" || era === "kicad11-dev",
    excludeFromPos: era === "kicad10" || era === "kicad11-dev",
  }
  const has: Record<SharedFlag, boolean> = { excludeFromBom: sym.stated.inBom, dnp: sym.stated.dnp, excludeFromPos: sym.stated.inPosFiles }
  const keys = Object.keys(copies) as SharedFlag[]
  return { authority: new Set(keys.filter((k) => copies[k] && has[k])), stated: new Set(keys.filter((k) => has[k])) }
}

export interface SchematicReadResult {
  schematic: KicadSchematic
  /** The text that was read, for the node accounting. */
  text: string
  report: ImportReport
}

function kindOfText(text: string): string | null {
  const head = text.slice(0, 400).replace(/^﻿/, "").trimStart()
  if (/^\(kicad_sch\b/.test(head)) return "schematic"
  if (/^EESchema Schematic File Version\s+(\d+)/i.test(head)) return `legacy:${/(\d+)/.exec(head.split(/\r?\n/)[0])?.[1] ?? "?"}`
  if (/^\(kicad_pcb\b/.test(head)) return "board"
  if (/^\(kicad_symbol_lib\b/.test(head)) return "symbol-library"
  if (/^\((footprint|module)\b/.test(head)) return "footprint"
  return null
}

/**
 * Reads a `.kicad_sch`, as text or bytes. Throws `KicadSchematicReadError` for a file that is not a schematic it can read at all.
 * `legacy` is given by the legacy reader (`legacy/read.ts`), which hands this the text of the KiCad 5 schematic written as a
 * `.kicad_sch` (`legacy/sexpr.ts`) so that one reader, one accounting and one build serve both.
 */
export function readKicadSchematic(input: string | Uint8Array, legacy?: LegacyInfo): SchematicReadResult {
  const report = newReport()
  let text: string
  if (typeof input === "string") text = input
  else {
    const decoded = decodeBytes(input)
    text = decoded.text
    for (const why of decoded.notes) report.entries.push({ code: "encoding", severity: "note", object: "the file", why })
  }
  if (!text.trim()) throw new KicadSchematicReadError("empty", "The file is empty.")
  const kind = kindOfText(text)
  if (kind?.startsWith("legacy:")) {
    throw new KicadSchematicReadError("legacy-schematic", `This is a KiCad 5 or older schematic (EESchema Schematic File Version ${kind.slice(7)}); it is read with the files of its project (its symbol libraries), by the legacy reader.`)
  }
  if (kind && kind !== "schematic") {
    const what = { board: "a KiCad board", "symbol-library": "a KiCad symbol library", footprint: "a single KiCad footprint" }[kind] ?? "another KiCad file"
    throw new KicadSchematicReadError("not-a-schematic", `This is ${what}, not a schematic (.kicad_sch).`)
  }
  let root: List
  try {
    root = parseSexpr(text)
  } catch (e) {
    if (e instanceof KicadReadError) throw new KicadSchematicReadError(e.code === "not-a-board" || e.code === "legacy-board" ? "not-sexpr" : e.code, e.message)
    throw e
  }
  const tree = root.find((n): n is List => nameOf(n) === "kicad_sch")
  if (!tree) throw new KicadSchematicReadError("not-a-schematic", "This file has no (kicad_sch ...) list, so it is not a KiCad schematic.")
  return { schematic: readSchematic(tree, report, legacy), text, report }
}

// ---------- small readers ----------

/**
 * A number of the file. A missing one is the fallback; one that is there and is not a number, or not
 * one a drawing can have (`abc`, `1e400`, beyond 10 km), is an unreadable file, as it is for KiCad's
 * parser: it is never read as 0, which would move a wire or make it vanish.
 */
function snum(node: List | undefined, index: number, fallback = 0): number {
  const v = strAt(node, index)
  if (v === undefined) return fallback
  const x = Number(v)
  if (!Number.isFinite(x) || Math.abs(x) > 1e7 || v.trim() === "") {
    throw new KicadSchematicReadError("bad-number", `The file has "${v}" where a number belongs, in (${String(node?.[0])} ...). It looks damaged.`)
  }
  return x
}

const pt = (node: List | undefined, at = 1): Pt => ({ x: snum(node, at), y: snum(node, at + 1) })
const xyOf = (node: List | undefined): Pt | null => (node ? pt(node) : null)

const yes = (node: List | undefined, name: string, fallback: boolean): boolean => {
  const c = kid(node, name)
  if (!c) return fallback
  return c[1] === undefined || c[1] === "yes" || c[1] === "true"
}

/** Switch 9: a lone `~` is empty before stamp 20250318. */
const tilde = (value: string, stamp: number | null) => (value === "~" && stamp !== null && stamp <= TILDE_IS_EMPTY_UNTIL ? "" : value)

function readProperty(node: List, stamp: number | null): SchProperty | null {
  const name = strAt(node, 1)
  if (name === undefined) return null
  const at = kid(node, "at")
  return { name, value: tilde(strAt(node, 2) ?? "", stamp), hide: flagOf(kid(node, "effects"), "hide") || flagOf(node, "hide"), at: at ? pt(at) : null, node }
}

export const readProps = (node: List, stamp: number | null): SchProperty[] => kids(node, "property").map((p) => readProperty(p, stamp)).filter((p): p is SchProperty => p !== null)

/** A net name or label text as the user reads it (switch 4, and `{slash}` is `/`). */
export function labelText(raw: string, stamp: number | null): string {
  const converted = stamp !== null && stamp < NET_NAME_OVERBAR_FROM ? convertOverbar(raw) : raw
  return decodeNetName(converted)
}

/** A bus alias's name or member as the user reads it: KiCad converts the old overbar notation of an alias before stamp 20210621 (`parseBusAlias`), a little later than a label's. */
export function aliasText(raw: string, stamp: number | null): string {
  return decodeNetName(stamp !== null && stamp < 20210621 ? convertOverbar(raw) : raw)
}

/** A pin or sheet-pin name: the old overbar notation is converted before stamp 20210606. */
const pinText = (raw: string, stamp: number | null) => (stamp !== null && stamp < OVERBAR_NOTATION_FROM ? convertOverbar(raw) : raw)

function readPoints(node: List | undefined): Pt[] {
  const pts = kid(node, "pts")
  return pts ? kids(pts, "xy").map((p) => pt(p)) : []
}

// ---------- symbol arcs (switch 10) ----------

const DEG = 180 / Math.PI
const norm360 = (a: number) => ((a % 360) + 360) % 360

/** An arc through three points: its circle and sweep, or null when they are in a line. */
function circleThrough(s: Pt, m: Pt, e: Pt): { center: Pt; radius: number } | null {
  const d = 2 * (s.x * (m.y - e.y) + m.x * (e.y - s.y) + e.x * (s.y - m.y))
  if (Math.abs(d) < 1e-12) return null
  const s2 = s.x * s.x + s.y * s.y
  const m2 = m.x * m.x + m.y * m.y
  const e2 = e.x * e.x + e.y * e.y
  const x = (s2 * (m.y - e.y) + m2 * (e.y - s.y) + e2 * (s.y - m.y)) / d
  const y = (s2 * (e.x - m.x) + m2 * (s.x - e.x) + e2 * (m.x - s.x)) / d
  return { center: { x, y }, radius: Math.hypot(s.x - x, s.y - y) }
}

/**
 * A symbol arc from its file form: `(start) (mid) (end)` (KiCad 6.0 and later), or the older
 * `(start) (end) (radius (at c) (length r) (angles a b))`. In files up to stamp 20230121 an arc of
 * more than a half turn is replaced by the arc between the same ends the other way round (the
 * parser does this to work around bad data in converted libraries: sch_io_kicad_sexpr_parser.cpp,
 * line 1730), and an arc of exactly a half turn is treated the same way.
 */
export function readArc(node: List, stamp: number | null): NonNullable<LibGraphic["arc"]> | null {
  const start = xyOf(kid(node, "start"))
  const end = xyOf(kid(node, "end"))
  if (!start || !end) return null
  let mid = xyOf(kid(node, "mid"))
  let center: Pt
  let radius: number
  if (mid) {
    const c = circleThrough(start, mid, end)
    if (!c) return { start, mid, end, center: mid, radius: 0, complemented: false }
    center = c.center
    radius = c.radius
  } else {
    const r = kid(node, "radius")
    const c = xyOf(kid(r, "at"))
    if (!c) return null
    center = c
    radius = snum(kid(r, "length"), 1)
    const angles = kid(r, "angles")
    const a1 = snum(angles, 1)
    const a2 = snum(angles, 2)
    const sweep0 = norm360(a2 - a1)
    const midAngle = ((a1 + sweep0 / 2) * Math.PI) / 180
    mid = { x: center.x + radius * Math.cos(midAngle), y: center.y + radius * Math.sin(midAngle) }
  }
  const angleOf = (p: Pt) => Math.atan2(p.y - center.y, p.x - center.x) * DEG
  const aS = angleOf(start)
  const aM = angleOf(mid)
  const aE = angleOf(end)
  // Counter-clockwise when the middle point is reached before the end going that way.
  const ccw = norm360(aM - aS) < norm360(aE - aS)
  const sweep = ccw ? norm360(aE - aS) : norm360(aS - aE)
  if (stamp !== null && stamp <= ARC_COMPLEMENT_UNTIL && sweep >= 180 - 1e-9 && radius > 0) {
    // The bisector of the arc as it was, and the other side of the circle from it.
    const bisector = ccw ? aS + sweep / 2 : aS - sweep / 2
    const a = ((bisector + 180) * Math.PI) / 180
    return { start, mid: { x: center.x + radius * Math.cos(a), y: center.y + radius * Math.sin(a) }, end, center, radius, complemented: true }
  }
  return { start, mid, end, center, radius, complemented: false }
}

// ---------- library symbols ----------

const UNIT_NAME = /_(\d+)_(\d+)$/

const GRAPHIC_KINDS: Record<string, LibGraphicKind> = { polyline: "polyline", rectangle: "rectangle", circle: "circle", arc: "arc", bezier: "bezier", ellipse: "ellipse", ellipse_arc: "ellipse", text: "text", text_box: "text_box" }

function readPin(node: List, unit: number, bodyStyle: number, stamp: number | null): LibPin {
  const at = kid(node, "at")
  const type = strAt(node, 1) ?? "unspecified"
  const nameNode = kid(node, "name")
  const numberNode = kid(node, "number")
  return {
    // KiCad's `SCH_PIN::SetNumber`: a pin number has no spaces.
    number: tilde(strAt(numberNode, 1) ?? "", stamp).replace(/ /g, "_"),
    name: pinText(tilde(strAt(nameNode, 1) ?? "", stamp), stamp),
    // Switch 2: the old name of the no-connect type.
    type: type === "unconnected" ? "no_connect" : type,
    shape: strAt(node, 2) ?? "line",
    at: pt(at),
    angle: snum(at, 3),
    length: snum(kid(node, "length"), 1),
    hidden: flagOf(node, "hide"),
    unit,
    bodyStyle,
    alternates: kids(node, "alternate").map((a) => ({ name: pinText(strAt(a, 1) ?? "", stamp), type: strAt(a, 2) === "unconnected" ? "no_connect" : (strAt(a, 2) ?? "unspecified"), shape: strAt(a, 3) ?? "line" })),
    node,
  }
}

function readGraphic(node: List, unit: number, bodyStyle: number, stamp: number | null): LibGraphic {
  const name = node[0] as string
  const kind = GRAPHIC_KINDS[name] ?? "other"
  const stroke = kid(node, "stroke")
  const width = snum(kid(stroke, "width"), 1, snum(kid(node, "width"), 1))
  const g: LibGraphic = {
    kind,
    unit,
    bodyStyle,
    pts: [],
    fill: null,
    strokeWidth: width,
    strokeType: strAt(kid(stroke, "type"), 1) ?? "default",
    node,
  }
  // `(fill (type none))` and the old `(fill none)`
  const fill = kid(node, "fill")
  g.fill = fill ? (strAt(kid(fill, "type"), 1) ?? (typeof fill[1] === "string" ? fill[1] : null)) : null
  if (kind === "polyline" || kind === "bezier") g.pts = readPoints(node)
  else if (kind === "rectangle") g.pts = [pt(kid(node, "start")), pt(kid(node, "end"))]
  else if (kind === "circle") {
    g.pts = [pt(kid(node, "center"))]
    g.radius = snum(kid(node, "radius"), 1)
  } else if (kind === "arc") {
    const arc = readArc(node, stamp)
    if (arc) {
      g.arc = arc
      g.pts = [arc.start, arc.mid, arc.end]
    }
  } else if (kind === "text" || kind === "text_box") {
    g.text = strAt(node, 1) ?? ""
    g.pts = [pt(kid(node, "at"))]
  }
  return g
}

export function readLibSymbol(node: List, stamp: number | null): LibSymbol {
  const name = strAt(node, 1) ?? ""
  const pins: LibPin[] = []
  const graphics: LibGraphic[] = []
  let units = 1
  let bodyStyles = 1
  for (const sub of kids(node, "symbol")) {
    const m = UNIT_NAME.exec(strAt(sub, 1) ?? "")
    const unit = m ? Number(m[1]) : 0
    const style = m ? Number(m[2]) : 0
    if (unit > units) units = unit
    if (style > bodyStyles) bodyStyles = style
    for (let i = 2; i < sub.length; i++) {
      const c = sub[i]
      if (!Array.isArray(c) || typeof c[0] !== "string") continue
      if (c[0] === "pin") pins.push(readPin(c, unit, style, stamp))
      else if (c[0] in GRAPHIC_KINDS) graphics.push(readGraphic(c, unit, style, stamp))
    }
  }
  const power = kid(node, "power")
  // Body styles are also declared by `(body_styles ...)` (KiCad 10) and by a `convert` of the unit; the nested names are the source of truth for De Morgan.
  const declared = kid(node, "body_styles")
  if (declared) {
    // `(body_styles demorgan)` is two styles; `(body_styles "A" "B")` names each of them.
    const words = declared.slice(1).filter((w): w is string => typeof w === "string")
    bodyStyles = Math.max(bodyStyles, words.includes("demorgan") ? 2 : 0, words.filter((w) => w !== "demorgan").length, 1)
  }
  const names = kid(node, "pin_names")
  const numbers = kid(node, "pin_numbers")
  return {
    name,
    extendsName: strAt(kid(node, "extends"), 1),
    props: readProps(node, stamp),
    power: power ? (power[1] === "local" ? "local" : "global") : null,
    pinNamesHidden: flagOf(names, "hide"),
    pinNumbersHidden: flagOf(numbers, "hide"),
    inBom: yes(node, "in_bom", true),
    onBoard: yes(node, "on_board", true),
    units,
    bodyStyles,
    pins,
    graphics,
    node,
  }
}

// ---------- placed symbols ----------

/** A text of an instance's `path`, or null when it has none. */
const instanceText = (path: List, name: string, stamp: number | null): string | null => {
  const v = strAt(kid(path, name), 1)
  return v === undefined ? null : tilde(v, stamp)
}

/** The stamp from which `in_bom` in a variant is the positive logic KiCad writes (`sch_io_kicad_sexpr_parser.cpp`, 10.0: `m_requiredVersion >= 20260306`). */
export const VARIANT_IN_BOM_FROM = 20260306

/**
 * S9: the variants of an instance. `in_bom` is read as KiCad 10's parser reads it: from stamp 20260306 `(in_bom yes)` is in the BOM; before it the parser stores
 * the word's value as "excluded from the BOM" without inverting it (its own comment calls that "the incorrect logic from prior file versions"), so
 * `(in_bom yes)` of an older file leaves the symbol out of the BOM. `on_board` and `in_pos_files` are positive in every file.
 */
function readVariants(node: List | undefined, stamp: number | null): VariantRead[] {
  const out: VariantRead[] = []
  for (const v of kids(node, "variant")) {
    const word = (name: string): boolean | null => {
      const c = kid(v, name)
      return c ? c[1] === undefined || c[1] === "yes" || c[1] === "true" : null
    }
    const inBom = word("in_bom")
    const onBoard = word("on_board")
    const inPos = word("in_pos_files")
    out.push({
      name: strAt(kid(v, "name"), 1) ?? "",
      dnp: word("dnp"),
      excludeFromSim: word("exclude_from_sim"),
      excludeFromBom: inBom === null ? null : stamp !== null && stamp >= VARIANT_IN_BOM_FROM ? !inBom : inBom,
      notOnBoard: onBoard === null ? null : !onBoard,
      excludeFromPos: inPos === null ? null : !inPos,
      fields: kids(v, "field").map((f) => ({ name: strAt(kid(f, "name"), 1) ?? "", value: strAt(kid(f, "value"), 1) ?? "" })),
    })
  }
  return out
}

function readInstances(node: List | undefined, stamp: number | null): SymbolInstance[] {
  const out: SymbolInstance[] = []
  for (const project of kids(node, "project")) {
    for (const path of kids(project, "path")) {
      out.push({
        project: strAt(project, 1) ?? "",
        path: strAt(path, 1) ?? "",
        reference: strAt(kid(path, "reference"), 1) ?? "",
        unit: snum(kid(path, "unit"), 1, 1),
        value: instanceText(path, "value", stamp),
        footprint: instanceText(path, "footprint", stamp),
        from: "symbol",
        variants: readVariants(path, stamp),
      })
    }
  }
  return out
}

function readPlacedSymbol(node: List, stamp: number | null): PlacedSymbol {
  const at = kid(node, "at")
  const libId = strAt(kid(node, "lib_id"), 1) ?? ""
  const libName = strAt(kid(node, "lib_name"), 1) ?? null
  const mirror = kid(node, "mirror")
  const mirrorWords = mirror ? mirror.slice(1).filter((c): c is string => typeof c === "string") : []
  // KiCad's parser takes one token after `mirror`.
  if (mirrorWords.length > 1 || (mirrorWords.length === 1 && mirrorWords[0] !== "x" && mirrorWords[0] !== "y")) {
    throw new KicadSchematicReadError("bad-value", `A symbol has (mirror ${mirrorWords.join(" ")}), which KiCad does not read: a mirror is x or y.`)
  }
  // KiCad's parser takes 0, 90, 180 or 270 for a symbol's turn and nothing else (`Expecting( "0, 90, 180, or 270" )`).
  const turn = snum(at, 3)
  if (Math.round(turn) % 90 !== 0 || Math.round(turn) !== turn) {
    throw new KicadSchematicReadError("bad-value", `A symbol is turned by ${turn} degrees, which KiCad does not read: a symbol turns 0, 90, 180 or 270 degrees.`)
  }
  return {
    libId,
    libName,
    cacheKey: libName ?? libId,
    at: pt(at),
    angle: snum(at, 3),
    mirror: mirrorWords.includes("x") ? "x" : mirrorWords.includes("y") ? "y" : "",
    unit: snum(kid(node, "unit"), 1, 1),
    bodyStyle: snum(kid(node, "body_style") ?? kid(node, "convert"), 1, 1),
    uuid: strAt(kid(node, "uuid"), 1) ?? "",
    props: readProps(node, stamp),
    inBom: yes(node, "in_bom", true),
    onBoard: yes(node, "on_board", true),
    dnp: yes(node, "dnp", false),
    excludeFromSim: yes(node, "exclude_from_sim", false),
    inPosFiles: yes(node, "in_pos_files", true),
    stated: { inBom: !!kid(node, "in_bom"), dnp: !!kid(node, "dnp"), inPosFiles: !!kid(node, "in_pos_files") },
    stamp,
    fieldsAutoplaced: yes(node, "fields_autoplaced", false),
    pins: kids(node, "pin").map((p) => ({ number: strAt(p, 1) ?? "", uuid: strAt(kid(p, "uuid"), 1) ?? "", alternate: strAt(kid(p, "alternate"), 1) ?? null })),
    instances: readInstances(kid(node, "instances"), stamp),
    node,
  }
}

// ---------- sheets ----------

/**
 * Switch 8: where a sheet's file and name are. The properties are `Sheetfile` and `Sheetname` (KiCad
 * 7 and later), `"Sheet file"` and `"Sheet name"` (KiCad 6), `File` and `Name` (older); in files up to
 * stamp 20200310 the ids and names are wrong, so the first property is the name and the second the file.
 */
export function sheetFields(props: SchProperty[], stamp: number | null): { name: string | null; file: string | null } {
  const p = sheetFieldProps(props, stamp)
  return { name: p.name?.value ?? null, file: p.file?.value ?? null }
}

/** The properties that hold a sheet's name and file, by `sheetFields`'s rules. */
export function sheetFieldProps(props: SchProperty[], stamp: number | null): { name?: SchProperty; file?: SchProperty } {
  const by = (...names: string[]) => props.find((p) => names.includes(p.name))
  if (stamp !== null && stamp <= SHEET_FIELDS_BY_POSITION_UNTIL) return { name: props[0], file: props[1] }
  return { name: by("Sheetname", "Sheet name", "Name"), file: by("Sheetfile", "Sheet file", "File") ?? props[1] }
}

function readSheet(node: List, stamp: number | null): SchSheet {
  const props = readProps(node, stamp)
  const { name, file } = sheetFields(props, stamp)
  const pins: SheetPin[] = kids(node, "pin").map((p) => {
    const at = kid(p, "at")
    // A sheet pin names a net as a label does, so its text is read as a label's is (`{slash}` is `/`).
    return { name: labelText(strAt(p, 1) ?? "", stamp), type: strAt(p, 2) ?? "input", at: pt(at), angle: snum(at, 3), node: p }
  })
  const instances: SheetInstance[] = []
  for (const project of kids(kid(node, "instances"), "project")) {
    for (const path of kids(project, "path")) instances.push({ project: strAt(project, 1) ?? "", path: strAt(path, 1) ?? "", page: strAt(kid(path, "page"), 1) ?? "", variants: readVariants(path, stamp) })
  }
  return { at: pt(kid(node, "at")), size: pt(kid(node, "size")), uuid: strAt(kid(node, "uuid"), 1) ?? "", name, file, pins, instances, node }
}

// ---------- the file ----------

const LABEL_TOKENS: Record<string, LabelKind> = { label: "local", global_label: "global", hierarchical_label: "hierarchical", netclass_flag: "directive", directive_label: "directive" }

/** Root lists the typed fields cover; every other one goes to `others` by its token. */
const TYPED_ROOT = new Set([
  "version",
  "generator",
  "generator_version",
  "uuid",
  "paper",
  "title_block",
  "lib_symbols",
  "symbol",
  "wire",
  "bus",
  "bus_entry",
  "bus_alias",
  "junction",
  "no_connect",
  "label",
  "global_label",
  "hierarchical_label",
  "netclass_flag",
  "directive_label",
  "sheet",
  "group",
  "symbol_instances",
  "sheet_instances",
  "embedded_files",
])

function readSchematic(tree: List, report: ImportReport, legacy?: LegacyInfo): KicadSchematic {
  const versionNode = kid(tree, "version")
  const stampNumber = versionNode ? numAt(versionNode, 1, NaN) : NaN
  const stamp = Number.isFinite(stampNumber) ? stampNumber : null
  if (stamp === null) report.entries.push({ code: "no-version", severity: "note", object: "the file", why: "The file has no (version N) stamp, so it is read by its tokens alone." })
  else if (stamp > NEWEST_KNOWN_STAMP && !legacy) {
    report.entries.push({ code: "newer-format", severity: "note", object: "the file", why: `The file's version stamp ${stamp} is newer than the newest this importer was written against (${NEWEST_KNOWN_STAMP}). It is read by its tokens, and anything new is named in this report.` })
  }
  const titleBlock: { key: string; value: string }[] = []
  const tb = kid(tree, "title_block")
  for (const c of tb?.slice(1) ?? []) {
    if (!Array.isArray(c) || typeof c[0] !== "string") continue
    if (c[0] === "comment") titleBlock.push({ key: `Comment${strAt(c, 1) ?? ""}`, value: strAt(c, 2) ?? "" })
    else if (typeof c[1] === "string") titleBlock.push({ key: c[0].charAt(0).toUpperCase() + c[0].slice(1), value: c[1] })
  }

  const libSymbols = kids(kid(tree, "lib_symbols"), "symbol").map((s) => readLibSymbol(s, stamp))
  const symbols = kids(tree, "symbol").map((s) => readPlacedSymbol(s, stamp))
  // Before 20210606 a power symbol's value is in the old overbar notation too (the parser converts it with the pin names).
  if (stamp !== null && stamp < OVERBAR_NOTATION_FROM) {
    const power = new Set(libSymbols.filter((l) => l.power).map((l) => l.name))
    for (const sym of symbols) {
      if (!power.has(sym.cacheKey)) continue
      for (const p of sym.props) if (p.name === "Value") p.value = convertOverbar(p.value)
    }
  }
  const wires: SchWire[] = kids(tree, "wire").map((w) => ({ pts: readPoints(w), node: w }))
  const buses: SchWire[] = kids(tree, "bus").map((w) => ({ pts: readPoints(w), node: w }))
  const busEntries: BusEntry[] = kids(tree, "bus_entry").map((b) => ({ at: pt(kid(b, "at")), size: pt(kid(b, "size")), toBus: flagOf(b, "bus_to_bus"), node: b }))
  const busAliases = kids(tree, "bus_alias").map((a) => ({ name: strAt(a, 1) ?? "", members: (kid(a, "members")?.slice(1) ?? []).filter((m): m is string => typeof m === "string") }))
  const junctions = kids(tree, "junction").map((j) => ({ at: pt(kid(j, "at")), node: j }))
  const noConnects = kids(tree, "no_connect").map((j) => ({ at: pt(kid(j, "at")), node: j }))

  const labels: SchLabel[] = []
  for (const c of tree.slice(1)) {
    const token = nameOf(c)
    const kind = token ? LABEL_TOKENS[token] : undefined
    if (!kind || !Array.isArray(c)) continue
    const raw = strAt(c, 1) ?? ""
    const at = kid(c, "at")
    labels.push({ kind, text: labelText(raw, stamp), raw, at: pt(at), angle: snum(at, 3), shape: strAt(kid(c, "shape"), 1) ?? null, node: c })
  }

  const sheets = kids(tree, "sheet").map((s) => readSheet(s, stamp))
  const groups: SchGroup[] = kids(tree, "group").map((g) => ({
    name: typeof g[1] === "string" ? g[1] : "",
    members: (kid(g, "members")?.slice(1) ?? []).filter((m): m is string => typeof m === "string"),
    uuid: strAt(kid(g, "uuid"), 1) ?? strAt(kid(g, "id"), 1) ?? "",
    node: g,
  }))

  const rootInstances: SymbolInstance[] = kids(kid(tree, "symbol_instances"), "path").map((p) => ({
    project: "",
    path: strAt(p, 1) ?? "",
    reference: strAt(kid(p, "reference"), 1) ?? "",
    unit: snum(kid(p, "unit"), 1, 1),
    value: instanceText(p, "value", stamp),
    footprint: instanceText(p, "footprint", stamp),
    from: "root-list" as const,
    variants: [],
  }))
  const sheetInstances: SheetInstance[] = kids(kid(tree, "sheet_instances"), "path").map((p) => ({ project: "", path: strAt(p, 1) ?? "", page: strAt(kid(p, "page"), 1) ?? "", variants: [] }))
  const embeddedFiles: EmbeddedFileRef[] = kids(kid(tree, "embedded_files"), "file").map((f) => ({ name: strAt(kid(f, "name"), 1) ?? "(no name)", type: strAt(kid(f, "type"), 1) ?? "" }))

  const others: Record<string, List[]> = {}
  for (const c of tree.slice(1)) {
    const token = nameOf(c)
    if (!token || TYPED_ROOT.has(token)) continue
    ;(others[token] ??= []).push(c as List)
  }

  const gen = kid(tree, "generator")
  return {
    version: stamp,
    era: legacy ? "legacy" : schEraOf(stamp),
    ...(legacy ? { legacy } : {}),
    generator: strAt(gen, 1) ?? null,
    generatorVersion: strAt(kid(tree, "generator_version"), 1) ?? null,
    uuid: strAt(kid(tree, "uuid"), 1) ?? "",
    paper: strAt(kid(tree, "paper"), 1) ?? null,
    titleBlock,
    libSymbols,
    symbols,
    wires,
    buses,
    busEntries,
    busAliases,
    junctions,
    noConnects,
    labels,
    sheets,
    groups,
    rootInstances,
    sheetInstances,
    embeddedFiles,
    others,
    tree,
  }
}
