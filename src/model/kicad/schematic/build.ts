import { normalizeAngle, round } from "../../../lib/geometry"
import { uid } from "../../../lib/id"
import { computeConnectivity, pinKey } from "../../connectivity"
import { labelJustify } from "../../labelShapes"
import { customPartId, drawingKey, registerProjectParts } from "../../customParts"
import { schematicPins } from "../../instances"
import { findPart, isRegistered, unitTwinId, unregisterPart } from "../../library"
import { createProject } from "../../ops"
import { ROOT_SHEET, sheetIdOf, sheetView, symbolsOnSheet } from "../../sheets"
import { aliasLookup, analyzeSheet, mayHaveBuses } from "../../busConnectivity"
import { BusTooLarge, differsBetweenGenerations, parseBusName } from "../../busNames"
import type { BusAlias, ComponentInstance, CustomPartSpec, DirectiveShape, DrawingDirective, FieldPlace, VariantOverride, LabelShape, Mirror, NetLabel, PartFlags, Project, Rotation, SchematicBlock, SchematicDrawing, SchematicSheet, SheetPin, SheetSymbol, SymbolDrawing, Vec2, Wire } from "../../types"
import type { ImportReport } from "../board/report"
import type { KeptFile } from "../board/images"
import { decodeBase64, sha256Hex } from "../../../lib/imageFacts"
import { pngInfo } from "../../sheetItems"
import { kid, numAt, strAt, type List } from "../board/sexpr"
import { labelFields, readSheetItems, strokeOf, textLookOf } from "./annotations"
import { symbolRecords, type SymbolRecord } from "./link"
import { BUILT_EXTENSIONS, type Need } from "./needs"
import { MM_PER_UNIT, colorOf, u, drawingFromLib, expandPinNumber, pinsOfUnit, placeOf, resolveLibSymbol, specFromSymbol, toSheet, type ResolvedLibSymbol } from "./symbols"
import type { SchematicTree } from "./tree"
import { isMiss, type FoundLibSymbol, type LibraryMiss, type SymbolSource } from "./libraries"
import { aliasText, readProps, sheetFieldProps } from "./read"
import type { KicadSchematic, LibPin, LibSymbol, PlacedSymbol, Pt, SchLabel, SchSheet, SheetFile, VariantRead } from "./types"

// A KiCad schematic as an editor project. The editor is y up and KiCad's sheet y down, so every y
// is negated and a rotation keeps its visual sense (both are counter-clockwise). KiCad's 1.27 mm
// is the editor's 0.1. It builds a sheet's components with their place and turn, wires, junctions,
// no-connects, labels, power symbols, groups, sheet symbols, buses, text and drawings; what the model
// cannot hold is refused before this runs (`needs.ts`).
//
// The editor works out its own nets from where things touch, KiCad from its own rules, and the two
// differ in a few places. Each is handled so that the nets come out the same, or is an extension
// the schematic needs (`lossy`, each with the extension that will build it), never an approximation:
//
//   - a junction on a wire's body joins what is there. The editor joins wires at their ends, so the
//     wire is cut at the junction, as KiCad's own clean-up of a sheet cuts it;
//   - a wire end on another wire's body with no junction, a label on a pin that lies on a wire's
//     body, a wire end or label a hair's breadth from a wire (the editor's tolerance is 1.27 um) and
//     two KiCad points closer than the editor tells apart are joined or parted by the editor and
//     not by KiCad: the sheet gets KiCad's rules (`SchematicSheet.kicadRules`, S11) and KiCad's own
//     coordinates, and a point KiCad has on a pin is put where the editor has the pin;
//   - a pin of the type "no connect" is on no net whatever is drawn to it: connectivity leaves it out;
//   - a hidden power-input pin joins the global net of its name: so it does in the editor (S5);
//   - the names KiCad gives nets (`/NAME`, `Net-(R1-Pad2)`, the power symbol over the label) are the
//     project's own rule (`Project.netNames`, S2): connectivity names each net as KiCad does.

/** The place of a point on the editor's sheet: to the editor's own four digits for what must meet a pin, to six for a part's origin. */
const PX = (mm: number) => round(mm / MM_PER_UNIT, 4)
const PY = (mm: number) => round(-mm / MM_PER_UNIT, 4)
const X = (mm: number) => round(mm / MM_PER_UNIT, 6)
/** The flag shapes of a directive label (`netclass_flag`). */
const DIRECTIVE_SHAPES: ReadonlySet<string> = new Set(["dot", "round", "diamond", "rectangle"])
const Y = (mm: number) => round(-mm / MM_PER_UNIT, 6)

/** The editor's tolerance in millimetres: its `pointOnSegment` takes 1e-4 of a unit as on (`lib/geometry.ts`). */
const EDITOR_TOLERANCE_MM = 1e-4 * MM_PER_UNIT

export interface SchematicBuildOptions {
  name?: string
  /** Kept as the project's "Imported from" property. */
  source?: string
  /** The footprint a symbol is linked to on the board (the project import): the land's name, and where the part is on the board. */
  footprintFor?: (record: SymbolRecord) => { land: string; pcb: ComponentInstance["pcb"] } | undefined
  /** The extensions that are built; defaults to what the editor has. Measurement runs name more. */
  built?: ReadonlySet<string>
  /** S3: the bus aliases of a project file (KiCad 10 keeps them there), which come before those of the schematic files. */
  busAliases?: readonly { name: string; members: string[] }[]
  /** S9: the variants the project file lists (`schematic.variants` of the `.kicad_pro`), with their descriptions; the variants the schematic's own symbols name are added. */
  variants?: { name: string; description?: string }[]
}

export interface SchematicBuild {
  project: Project
  /** What the model cannot hold exactly, each with the extension that will: the importer refuses a schematic with any that is not built. */
  lossy: Need[]
  /** The component each placed symbol became (a power symbol too), for the first use of its sheet. */
  bySymbol: Map<PlacedSymbol, ComponentInstance>
  /** The component each use of each symbol became: a symbol on a sheet used twice is two components. */
  byRecord: Map<SymbolRecord, ComponentInstance>
  /** The record (reference, path) each symbol was built from, for the first use of its sheet. */
  recordOf: Map<PlacedSymbol, SymbolRecord>
  /** The ids of the parts this build registered in memory (not those a registered part of the same id already was). `releaseBuild` takes them out when the project is not imported. */
  registered: string[]
  /** The sheets' pictures, for the host's file store: the project names each by its file (`storePictures`). */
  pictures: KeptFile[]
  stats: { components: number; wires: number; labels: number; powerPorts: number }
}

/** Takes the parts a refused build registered out of memory again. */
export function releaseBuild(build: Pick<SchematicBuild, "registered">) {
  for (const id of build.registered) unregisterPart(id)
}

/** The release a stamp belongs to, for the "Imported from" property when the file does not name its version. */
const ERA_NAME: Record<KicadSchematic["era"], string> = { legacy: "5 or older (a legacy .sch file)", "pre6-nightly": "5.99 (a development build)", kicad6: "6", kicad7: "7", kicad8: "8", kicad9: "9", kicad10: "10", "kicad11-dev": "11 (a development build)", unknown: "(version not given)" }

const referenceOf = (s: PlacedSymbol) => s.props.find((p) => p.name === "Reference")?.value ?? ""
const valueOf = (s: PlacedSymbol) => s.props.find((p) => p.name === "Value")?.value ?? ""

/** Modern power symbols (stamp 20230221 on): the editable Value is the net (sch_file_versions.h). Before it a global power symbol is named by its hidden power pin (`FixLegacyPowerSymbolMismatches`, sch_screen.cpp). */
export const MODERN_POWER_SYMBOLS_FROM = 20230221

/** A power symbol: from a library symbol with the `(power)` flag and one power-input pin. */
function powerPin(lib: LibSymbol): LibPin | null {
  if (!lib.power) return null
  const pins = lib.pins.filter((p) => p.type === "power_in")
  return pins.length === 1 && lib.pins.length === 1 ? pins[0] : null
}

const keyOf = (p: Pt) => `${Math.round(p.x * 1e4)},${Math.round(p.y * 1e4)}`
const q = (v: number) => Math.round(v * 1e4)

/** Whether the point lies strictly inside the segment, in tenths of a micrometre. */
function strictlyInside(px: number, py: number, ax: number, ay: number, bx: number, by: number): boolean {
  const cross = (bx - ax) * (py - ay) - (by - ay) * (px - ax)
  if (cross !== 0) return false
  const dot = (px - ax) * (bx - ax) + (py - ay) * (by - ay)
  const len2 = (bx - ax) ** 2 + (by - ay) ** 2
  return dot > 0 && dot < len2
}

/** The distance of a point from a segment, in millimetres. */
function distanceToSegment(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len2 = dx * dx + dy * dy
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2))
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy))
}

/** Wire segments in a grid of 2 mm cells, so a point finds the wires near it without a pass over all of them. */
class SegGrid {
  private cells = new Map<string, number[]>()
  private big: number[] = []
  constructor(readonly segs: { a: Pt; b: Pt }[]) {
    segs.forEach((s, i) => {
      const x0 = Math.floor(Math.min(s.a.x, s.b.x) / 2)
      const x1 = Math.floor(Math.max(s.a.x, s.b.x) / 2)
      const y0 = Math.floor(Math.min(s.a.y, s.b.y) / 2)
      const y1 = Math.floor(Math.max(s.a.y, s.b.y) / 2)
      if ((x1 - x0 + 1) * (y1 - y0 + 1) > 600) this.big.push(i)
      else
        for (let x = x0; x <= x1; x++)
          for (let y = y0; y <= y1; y++) {
            const k = `${x},${y}`
            const l = this.cells.get(k)
            if (l) l.push(i)
            else this.cells.set(k, [i])
          }
    })
  }
  near(p: Pt): number[] {
    const cx = Math.floor(p.x / 2)
    const cy = Math.floor(p.y / 2)
    const out = new Set<number>(this.big)
    for (let x = cx - 1; x <= cx + 1; x++) for (let y = cy - 1; y <= cy + 1; y++) for (const i of this.cells.get(`${x},${y}`) ?? []) out.add(i)
    return [...out]
  }
}

/** `(name yes)`, a bare `name`, or `fallback` where the node has neither. */
function yesOf(node: List, name: string, fallback: boolean): boolean {
  const n = kid(node, name)
  if (n) return n[1] === undefined || n[1] === "yes" || n[1] === "true"
  return node.includes(name) ? true : fallback
}

/**
 * Schematic to project. Throws nothing for a schematic the model can hold; `lossy` names every extension it needs otherwise.
 *
 * S11: a sheet where KiCad and the editor would join different things (a wire end on another wire's side with no junction, a label on a pin on a wire's side,
 * points a hair apart) is built a second time with KiCad's rules on that sheet (`SchematicSheet.kicadRules`) and KiCad's own coordinates to six digits. A point
 * where KiCad has a pin is put where the editor has the pin (its four digits, which every edit of the sheet recomputes), so a pin the editor's rounding would
 * move off its wire stays joined. A sheet with none of these is built once, as before, so nothing changes for it.
 */
export function buildSchematicProject(tree: SchematicTree, report: ImportReport, options: SchematicBuildOptions = {}): SchematicBuild {
  const entries = report.entries.length
  const first = buildPass(tree, report, options, new Set(), new Map(), false)
  if (first.joinCases.size === 0 && !first.pinsMoved) return first.build
  // A measurement run that does not name S11 built sees each case as the need it was before S11: the build says so and is not made again.
  if (!(options.built ?? BUILT_EXTENSIONS).has("S11")) {
    for (const why of new Set([...first.joinCases.values()].flat())) first.build.lossy.push({ ext: "S11", why, source: "importer" })
    if (first.pinsMoved) first.build.lossy.push({ ext: "S11", why: "a pin that the editor's rounding would put off its wire", source: "importer" })
    return first.build
  }
  // The first build is thrown away: its parts leave memory, and what it said in the report is said again by the second.
  releaseBuild(first.build)
  report.entries.length = entries
  const second = buildPass(tree, report, options, new Set(first.joinCases.keys()), first.pinsAt, true)
  if (first.joinCases.size) {
    const note = [...first.joinCases.values()].flat()
    report.entries.push({
      code: "kicad-join-rules",
      severity: "note",
      object: `${first.joinCases.size} sheet${first.joinCases.size > 1 ? "s" : ""} joined by KiCad's rules`,
      why: `${[...new Set(note)].slice(0, 3).join("; ")}. The editor would join or part something here that KiCad does not, so these sheets keep KiCad's rules and KiCad's own coordinates (the sheet's flag in the project file), and their nets are KiCad's. Sheets drawn in the editor keep the editor's rules.`,
      count: first.joinCases.size,
    })
  }
  if (second.snapped.count) {
    report.entries.push({
      code: "kicad-pins-snapped",
      severity: "note",
      object: `${second.snapped.count} point${second.snapped.count > 1 ? "s" : ""} at a pin`,
      why: `The editor puts a pin to four digits of its unit, so a wire end, label or junction that KiCad has on a pin is put where the editor has the pin, at most ${second.snapped.maxUm.toFixed(2)} um from where the file has it, so that it stays joined to the pin in every edit.`,
      count: second.snapped.count,
    })
  }
  return second.build
}

/** One build of the schematic. `kicadFiles` are the sheet files built with KiCad's joining rules; `joinCases` the files that need them and why. */
function buildPass(
  tree: SchematicTree,
  report: ImportReport,
  options: SchematicBuildOptions,
  kicadFiles: ReadonlySet<string>,
  pinAt: ReadonlyMap<string, Vec2>,
  final: boolean,
): { build: SchematicBuild; joinCases: Map<string, string[]>; pinsAt: Map<string, Vec2>; pinsMoved: boolean; snapped: { count: number; maxUm: number } } {
  const lossy: Need[] = []
  const lose = (ext: string, why: string) => {
    if (!lossy.some((n) => n.ext === ext && n.why === why)) lossy.push({ ext, why, source: "importer" })
  }
  /** The sheet files that need KiCad's joining rules, and what in each does. */
  const joinCases = new Map<string, string[]>()
  /** Every point of every sheet, where KiCad has it and where the editor puts it, to say whether the editor joins and parts what KiCad does. */
  const points: { file: string; k: string; e: Vec2 }[] = []
  const snapped = { count: 0, maxUm: 0 }
  const snappedKeys = new Set<string>()
  const pxOf = (f: SheetFile) => (kicadFiles.has(f.path) ? X : PX)
  const pyOf = (f: SheetFile) => (kicadFiles.has(f.path) ? Y : PY)
  const root = tree.files.get(tree.root)!.schematic
  const fileName = tree.root.slice(tree.root.lastIndexOf("/") + 1)
  const title = root.titleBlock.find((t) => t.key === "Title")?.value
  let project = createProject(options.name ?? (title && title.trim() ? title : "Imported KiCad schematic"), "")
  const bySymbol = new Map<PlacedSymbol, ComponentInstance>()
  const byRecord = new Map<SymbolRecord, ComponentInstance>()
  const recordOf = new Map<PlacedSymbol, SymbolRecord>()
  const registered: string[] = []

  // ---------- the sheets: each file is a sheet, each use of it a path of sheet symbols (S1) ----------
  /** The files that are drawn: those with at least one use. A file no sheet symbol names is not part of the project. */
  const used = new Set(tree.instances.map((i) => i.file))
  const files = [...tree.files.values()].filter((f) => used.has(f.path))
  const sheetId = new Map<string, string>()
  files.forEach((f, i) => sheetId.set(f.path, f.path === tree.root ? ROOT_SHEET : `s${i}`))
  /** The id each sheet symbol gets, which the paths of its uses are made of. */
  const symbolId = new Map<SchSheet, string>()
  let symbolCount = 0
  for (const f of files) for (const s of f.schematic.sheets) if (tree.uses.some((u) => u.sheet === s && u.found)) symbolId.set(s, `h${++symbolCount}`)
  /** One use of a file: the path of sheet symbols (ours), the path KiCad writes (the board's form), and the symbols' uuids. */
  interface Use {
    file: SheetFile
    /** Ours: `` for the root, `/h1/h4`. */
    path: string
    /** The board's form of the path: `/` for the root, `/<uuid>/<uuid>`. */
    boardPath: string
    inst: SchematicTree["instances"][number]
    /** The first use of its file: its symbols are the ones the others are copies of. */
    first: boolean
  }
  const seenFiles = new Set<string>()
  const uses: Use[] = tree.instances.map((inst) => {
    const first = !seenFiles.has(inst.file)
    seenFiles.add(inst.file)
    return {
      file: tree.files.get(inst.file)!,
      path: inst.symbols.map((s) => `/${symbolId.get(s) ?? "?"}`).join(""),
      boardPath: inst.chain.length ? `/${inst.chain.join("/")}` : "/",
      inst,
      first,
    }
  })
  const usesOfFile = new Map<string, Use[]>()
  for (const u of uses) (usesOfFile.get(u.file.path) ?? usesOfFile.set(u.file.path, []).get(u.file.path)!).push(u)
  const sheetTag = (file: SheetFile) => (file.path === tree.root ? {} : { sheet: sheetId.get(file.path)! })
  const instTag = (use: Use) => (use.path === "" ? {} : { inst: use.path })

  // Each symbol's reference, unit, value and footprint from each use of its sheet.
  const records = symbolRecords(tree)
  const recordAt = new Map<PlacedSymbol, Map<string, SymbolRecord>>()
  for (const r of records) {
    const m = recordAt.get(r.symbol) ?? recordAt.set(r.symbol, new Map()).get(r.symbol)!
    if (!m.has(r.sheetPath)) m.set(r.sheetPath, r)
  }

  /** The cached symbols of each file (a sheet file has its own `lib_symbols`). */
  const caches = new Map(files.map((f) => [f.path, new Map(f.schematic.libSymbols.map((s) => [s.name, s]))]))
  const components: ComponentInstance[] = []
  /** Pins of every component, by world point, for the no-connects and the checks. */
  const pinPoints: { c: ComponentInstance; pin: string; at: Pt; file: SheetFile; first: boolean }[] = []
  const missing: string[] = []
  const labels: NetLabel[] = []
  let powerPorts = 0

  /** S9: the names of the variants the file's instances state, in the order they are met (a variant that changes nothing on a symbol is still the project's). */
  const variantSeen = new Set<string>()
  /** Variants with no name: nothing to choose them by, so they are not kept (said in the report). */
  let unnamedVariants = 0
  /**
   * S9: what each variant of one instance changes, against the flags the symbol or sheet has itself (KiCad starts a variant from them): only a flag that differs is
   * kept, a field is kept as stated. The last variant of a name in one instance is the one KiCad keeps (`m_Variants[name]`).
   */
  function overridesOf(vs: readonly VariantRead[], base: { dnp: boolean; excludeFromSim: boolean; excludeFromBom: boolean; notOnBoard: boolean; excludeFromPos: boolean }): Record<string, VariantOverride> | undefined {
    const out: Record<string, VariantOverride> = {}
    for (const v of vs) {
      if (!v.name.trim()) {
        unnamedVariants++
        continue
      }
      variantSeen.add(v.name)
      const o: VariantOverride = {}
      if (v.dnp !== null && v.dnp !== base.dnp) o.dnp = v.dnp
      if (v.excludeFromSim !== null && v.excludeFromSim !== base.excludeFromSim) o.excludeFromSim = v.excludeFromSim
      if (v.excludeFromBom !== null && v.excludeFromBom !== base.excludeFromBom) o.excludeFromBom = v.excludeFromBom
      if (v.notOnBoard !== null && v.notOnBoard !== base.notOnBoard) o.notOnBoard = v.notOnBoard
      if (v.excludeFromPos !== null && v.excludeFromPos !== base.excludeFromPos) o.excludeFromPos = v.excludeFromPos
      if (v.fields.length) o.fields = Object.fromEntries(v.fields.map((f) => [f.name, f.value]))
      if (Object.keys(o).length) out[v.name] = o
      else delete out[v.name]
    }
    return Object.keys(out).length ? out : undefined
  }
  const symbolVariants = (sym: PlacedSymbol, record: SymbolRecord | undefined) =>
    overridesOf(record?.variants ?? [], { dnp: sym.dnp, excludeFromSim: sym.excludeFromSim, excludeFromBom: !sym.inBom, notOnBoard: !sym.onBoard, excludeFromPos: !sym.inPosFiles })

  /** S7: the flags a placed symbol has that are not KiCad's defaults, as the one `PartFlags` set, and its `fields_autoplaced`. */
  function flagsProp(sym: PlacedSymbol): Pick<ComponentInstance, "flags" | "fieldsAutoplaced"> {
    const flags: PartFlags = {}
    if (sym.dnp) flags.dnp = true
    if (!sym.inBom) flags.excludeFromBom = true
    if (!sym.onBoard) flags.notOnBoard = true
    if (sym.excludeFromSim) flags.excludeFromSim = true
    if (!sym.inPosFiles) flags.excludeFromPos = true
    return { ...(Object.keys(flags).length ? { flags } : {}), ...(sym.fieldsAutoplaced ? { fieldsAutoplaced: true as const } : {}) }
  }

  // ---------- what each placed symbol is: its drawing, its part, its unit ----------
  const drawings = new Map<string, { lib: ResolvedLibSymbol; drawing: SymbolDrawing; key: string } | null>()
  /** What a text of a symbol asks for that the editor draws its own way: a font, a line spacing, a link. */
  const textNotes = new Set<string>()
  /** S12: where each symbol the schematic's cache lacks was found (a library of the project or the database), by `lib_id`, and why the ones that were found nowhere were not. */
  const libraryFound = new Map<string, SymbolSource>()
  const libraryMiss = new Map<string, LibraryMiss>()
  /** The cache entries (by file and key) that came from a library: the library may have drawn the symbol differently since the sheet was. */
  const fromLibraryKeys = new Set<string>()
  const drawingOf = (file: SheetFile, sym: Pick<PlacedSymbol, "cacheKey"> & Partial<Pick<PlacedSymbol, "libId" | "libName">>) => {
    const id = `${file.path}\u0000${sym.cacheKey}`
    const had = drawings.get(id)
    if (had !== undefined) return had
    const nick = sym.cacheKey.includes(":") ? sym.cacheKey.slice(0, sym.cacheKey.indexOf(":")) : ""
    const cached = (name: string) => caches.get(file.path)?.get(name)
    /** A symbol of the project's libraries, by the name an `extends` or a `lib_id` writes (`Base` is of the symbol's own library). */
    const inLibraries = (name: string): LibSymbol | undefined => {
      const hit = tree.libraries.find(name.includes(":") || !nick ? name : `${nick}:${name}`)
      return isMiss(hit) ? undefined : hit.symbol
    }
    let found: FoundLibSymbol | null = null
    let base = cached(sym.cacheKey)
    // A symbol with a `lib_name` is an edited copy of the library's: only the cache has it, and the library's own is another drawing.
    if (!base && sym.libId && !sym.libName) {
      const hit = tree.libraries.find(sym.libId)
      if (isMiss(hit)) libraryMiss.set(sym.cacheKey, hit)
      else {
        found = hit
        base = { ...hit.symbol, name: sym.cacheKey }
        libraryFound.set(sym.libId, hit.source)
        fromLibraryKeys.add(id)
      }
    }
    const lookup = (name: string) => cached(name) ?? (nick && !name.includes(":") ? cached(`${nick}:${name}`) : undefined) ?? (found ? (found.lookup(name) ?? inLibraries(name)) : inLibraries(name))
    let out: { lib: ResolvedLibSymbol; drawing: SymbolDrawing; key: string } | null = null
    if (!base) missing.push(sym.cacheKey)
    else {
      try {
        const lib = resolveLibSymbol(base, lookup)
        // A cache entry whose `extends` base had to come from a library is a library's drawing too.
        if (!found && base.extendsName && !cached(base.extendsName) && !cached(`${nick}:${base.extendsName}`)) fromLibraryKeys.add(id)
        const { drawing, problems, notes } = drawingFromLib(lib)
        for (const n of notes) textNotes.add(n)
        const power = lib.power ? powerPin(lib) : null
        // A power symbol names the net of its power-input pins by its Value. One that is one pin (`power:GND`) is a power port; one with other pins, power inputs among them, is not something the editor holds. A flag (`PWR_FLAG`: a power output) is an ordinary part.
        if (lib.power && !power && lib.pins.some((p) => p.type === "power_in")) problems.push("a power symbol with other pins than one power input")
        if (problems.length) {
          report.entries.push({ code: "symbol-not-held", severity: "refused", object: `the symbol ${sym.cacheKey}`, why: `The editor cannot hold ${[...new Set(problems)].join(", ")} of this symbol exactly, so the schematic is not imported.` })
        } else out = { lib, drawing, key: drawingKey(drawing) }
      } catch (e) {
        report.entries.push({
          code: "symbol-base-missing",
          severity: "refused",
          object: `the symbol ${sym.cacheKey}`,
          why: `${e instanceof Error ? e.message : String(e)}. The schematic's cache has no copy of the symbol it extends, and no library of the project or the parts database has it (S12): the symbol cannot be drawn, and nothing is guessed.`,
        })
      }
    }
    drawings.set(id, out)
    return out
  }
  interface Placed {
    sym: PlacedSymbol
    use: Use
    lib: ResolvedLibSymbol
    drawing: SymbolDrawing
    ref: string
    unit: number
    angle: number
    record: SymbolRecord | undefined
    onBoard: ReturnType<NonNullable<SchematicBuildOptions["footprintFor"]>>
    power: LibPin | null
  }
  /** The places of the pins of the type "no connect" (KiCad 5 joins what is drawn to such a pin), by file. */
  const ncPinKeys = new Map<string, Set<string>>()
  const placed: Placed[] = []
  for (const use of uses) {
    for (const sym of use.file.schematic.symbols) {
      const d = drawingOf(use.file, sym)
      if (!d) continue
      const record = recordAt.get(sym)?.get(use.boardPath)
      if (record) {
        if (use.first) recordOf.set(sym, record)
      }
      const angle = normalizeAngle(Math.round(sym.angle))
      if (angle % 90 !== 0) {
        lose("S5", "a symbol turned by other than a quarter turn")
        continue
      }
      placed.push({
        sym,
        use,
        lib: d.lib,
        drawing: d.drawing,
        record,
        ref: (record?.reference || referenceOf(sym) || "?").trim(),
        // The unit is the instance's: a symbol whose own `(unit N)` says 1 may be used as unit 3 (connection_graph.cpp: `SetUnit( GetUnitSelection( &sheet ) )`).
        unit: record?.unit ?? sym.unit,
        angle,
        onBoard: record ? options.footprintFor?.(record) : undefined,
        power: d.lib.power ? powerPin(d.lib) : null,
      })
    }
  }

  // A part with several units is several symbols of one reference. One is the part, with the footprint: the one the board's
  // footprint is linked to, else the first. The others are placements of its twin.
  // The units of a reference are one part (KiCad names a symbol's cached copy after its instance when the copies differ, so a part can have a copy for each unit: they are one part all the same).
  const byRef = new Map<string, Placed[]>()
  for (const p of placed) {
    // An unannotated symbol (`U?`) is not a unit of the next one, and a power symbol is never a unit.
    if (p.power || p.lib.units < 2 || p.ref === "" || /[?*]$/.test(p.ref)) continue
    ;(byRef.get(p.ref) ?? byRef.set(p.ref, []).get(p.ref)!).push(p)
  }
  const primaryOf = new Map<Placed, Placed>()
  for (const g of byRef.values()) {
    // Each unit once: a second symbol of the same unit and reference is another part that shares the name.
    const members: Placed[] = []
    for (const p of g) if (!members.some((m) => m.unit === p.unit)) members.push(p)
    const primary = members.find((p) => p.onBoard) ?? members[0]
    for (const p of members) primaryOf.set(p, primary)
  }

  // The parts (one per drawing and footprint) and the drawings, each kept once.
  const specs = new Map<string, CustomPartSpec>()
  const symbols: Record<string, SymbolDrawing> = {}
  const partFor = (p: Placed): string => {
    const isPrimary = (primaryOf.get(p) ?? p) === p
    const { spec, key } = specFromSymbol(p.lib, p.drawing, p.power || !isPrimary ? "" : (p.onBoard?.land ?? ""))
    // The part is the file's own: its symbol and pins are what the schematic has, so Checks has no supplier to hold it against.
    const full: CustomPartSpec = { ...spec, id: customPartId(spec), source: { pins: "import", land: "import", imported: { file: p.use.file.path.slice(p.use.file.path.lastIndexOf("/") + 1) || fileName, libId: p.sym.libId } } }
    symbols[key] = p.drawing
    if (!specs.has(full.id)) specs.set(full.id, full)
    return isPrimary ? full.id : unitTwinId(full.id)
  }

  /** The symbol of the first use of each placed symbol, which the later uses are copies of. */
  const firstOf = new Map<PlacedSymbol, ComponentInstance>()
  for (const p of placed) {
    const { sym, lib, ref, unit, angle, use } = p
    const partId = partFor(p)
    const mirror: Mirror | undefined = sym.mirror === "x" || sym.mirror === "y" ? sym.mirror : undefined
    const record = p.record
    const variantsHere = symbolVariants(sym, record)
    const isPrimary = (primaryOf.get(p) ?? p) === p
    const onBoard = isPrimary ? p.onBoard : undefined
    const pinsHere = pinsOfUnit(lib, unit, sym.bodyStyle)
    const copyOf = use.first ? {} : { tpl: firstOf.get(sym)?.id }
    const tag = { ...instTag(use), ...(copyOf.tpl ? { tpl: copyOf.tpl } : {}) }

    // ---------- a power symbol: its net is its Value ----------
    if (p.power) {
      const pp = p.power
      // Before stamp 20230221 a global power symbol with a hidden pin is named by that pin; from it the Value is the net, and an empty one stays empty.
      // In a KiCad 5 schematic the pin names the net whether it is shown or not (`LIB_PIN::IsPowerConnection`: a power input pin of a power symbol, or a hidden one).
      const file = use.file.schematic
      const legacy = file.legacy ? true : file.version !== null && file.version < MODERN_POWER_SYMBOLS_FROM && lib.power === "global" && pp.hidden
      const net = (legacy ? pp.name : record?.value || valueOf(sym)).trim()
      const c: ComponentInstance = {
        id: uid("c"),
        partId,
        ref,
        props: { net },
        ...flagsProp(sym),
        ...(variantsHere ? { variants: variantsHere } : {}),
        footprint: "",
        sch: { x: X(sym.at.x), y: Y(sym.at.y), rot: angle as Rotation, ...(mirror ? { mirror } : {}) },
        pcb: { x: 0, y: 0, rot: 0, side: "top", placed: false },
        ...tag,
      }
      const fields = fieldsOf(sym)
      if (fields) c.fields = fields
      components.push(c)
      if (use.first) {
        bySymbol.set(sym, c)
        firstOf.set(sym, c)
      }
      if (record) byRecord.set(record, c)
      powerPorts++
      pinPoints.push({ c, pin: pp.number, at: toSheet(pp.at, sym), file: use.file, first: use.first })
      continue
    }

    // ---------- any other symbol: a placement of its part ----------
    const c: ComponentInstance = {
      id: uid("c"),
      partId,
      ref,
      props: {},
      // The first use of a sheet has the symbol's own uuid (what a footprint's path ends with); a later use shares it, so it is not repeated.
      ...(use.first && sym.uuid ? { uuid: sym.uuid } : {}),
      ...flagsProp(sym),
      ...(variantsHere ? { variants: variantsHere } : {}),
      footprint: onBoard?.land ?? "",
      sch: { x: X(sym.at.x), y: Y(sym.at.y), rot: angle as Rotation, ...(mirror ? { mirror } : {}) },
      pcb: onBoard?.pcb ?? { x: 0, y: 0, rot: 0, side: "top", placed: false },
      ...tag,
    }
    if (lib.units > 1 && unit > 1) c.unit = unit
    if (lib.bodyStyles > 1 && sym.bodyStyle > 1) c.bodyStyle = sym.bodyStyle
    const alts = Object.fromEntries(sym.pins.filter((q) => q.alternate).map((q) => [q.number, q.alternate as string]))
    if (Object.keys(alts).length) c.pinAlt = alts
    // The instance's own value and footprint, where it has them, stand in place of the symbol's fields (KiCad 6 keeps the real ones there).
    for (const q of sym.props) {
      if (q.name === "Reference") continue
      const value = q.name === "Value" ? record?.value || q.value : q.name === "Footprint" ? record?.footprint || q.value : q.value
      if (q.name === "Value") c.props.value = value
      else if (value !== "") c.props[q.name] = value
    }
    const fields = fieldsOf(sym)
    if (fields) c.fields = fields
    components.push(c)
    if (use.first) {
      bySymbol.set(sym, c)
      firstOf.set(sym, c)
    }
    if (record) byRecord.set(record, c)
    for (const q of pinsHere) {
      const at = toSheet(q.at, sym)
      for (const number of expandPinNumber(q.number)) pinPoints.push({ c, pin: number, at, file: use.file, first: use.first })
      if (q.type === "no_connect") (ncPinKeys.get(use.file.path) ?? ncPinKeys.set(use.file.path, new Set()).get(use.file.path)!).add(keyOf(at))
    }
  }

  // The cache's other symbols (one that nothing places, a base another symbol extends) are kept as stored drawings, so the project keeps every drawing the file has. They are not listed as parts: a part nobody placed would crowd the library panel.
  const unplaced: string[] = []
  for (const f of files) {
    for (const lib of f.schematic.libSymbols) {
      if (drawings.has(`${f.path}\u0000${lib.name}`)) continue
      const d = drawingOf(f, { cacheKey: lib.name })
      if (!d) continue
      const { key } = specFromSymbol(d.lib, d.drawing, "")
      symbols[key] = d.drawing
      unplaced.push(lib.name)
    }
  }
  if (unplaced.length) {
    report.entries.push({
      code: "unplaced-symbols-kept",
      severity: "note",
      object: `${unplaced.length} symbol${unplaced.length > 1 ? "s" : ""} of the file's cache that no symbol is placed from (${unplaced.slice(0, 4).join(", ")}${unplaced.length > 4 ? ", ..." : ""})`,
      why: "Their drawings are kept in the project, but they are not listed as parts until one is placed.",
      count: unplaced.length,
    })
  }

  /** The place and look of every field a placed symbol lists, as KiCad wrote them (in sheet coordinates), relative to the symbol. */
  function fieldsOf(sym: PlacedSymbol): Record<string, FieldPlace> | undefined {
    const out: Record<string, FieldPlace> = {}
    for (const q of sym.props) out[q.name] = placeOf(q, sym.at, textNotes)
    return Object.keys(out).length ? out : undefined
  }

  // S12: the symbols the cache lacked and a library of the project (or the parts database) gave.
  if (libraryFound.size) {
    const byLibrary = new Map<string, string[]>()
    for (const [id, src] of libraryFound) (byLibrary.get(src.kind === "database" ? "the parts database" : `${src.library} (${src.file})`) ?? byLibrary.set(src.kind === "database" ? "the parts database" : `${src.library} (${src.file})`, []).get(src.kind === "database" ? "the parts database" : `${src.library} (${src.file})`)!).push(id)
    report.entries.push({
      code: "symbol-from-library",
      severity: "changed",
      object: `${libraryFound.size} symbol${libraryFound.size > 1 ? "s" : ""} (${[...libraryFound.keys()].slice(0, 4).join(", ")}${libraryFound.size > 4 ? ", ..." : ""}) from ${[...byLibrary.keys()].slice(0, 3).join(", ")}${byLibrary.size > 3 ? ", ..." : ""}`,
      why: "The schematic's own library cache has no drawing for these, so each was taken from a library of the project, the project's own libraries first and the parts database last. A library may have drawn a symbol differently since the sheet was saved; where a wire ends near one of them with no pin there, the import is refused rather than put the nets on other pins.",
      count: libraryFound.size,
    })
  }
  if (missing.length) {
    const names = [...new Set(missing)]
    const misses = [...libraryMiss.values()]
    const looked = [...new Set(misses.flatMap((m) => m.looked))]
    const listed = tree.libraries.listedButAbsent()
    const external = [...new Set(misses.flatMap((m) => m.external))]
    const unreadable = misses.flatMap((m) => m.unreadable)
    const parts: string[] = []
    if (looked.length) parts.push(`the libraries it looked in (${looked.slice(0, 5).join(", ")}) do not have them`)
    if (listed.length) parts.push(`the project's sym-lib-table lists ${listed.slice(0, 5).join(", ")}, whose file${listed.length > 1 ? "s are" : " is"} not among the files`)
    if (external.length) parts.push(`${external.slice(0, 5).join(", ")} ${external.length > 1 ? "are" : "is"} listed at a path of the machine that made the project (KiCad's own libraries, as a rule), and no file of that name came with it`)
    for (const u of [...new Map(unreadable.map((x) => [x.library, x])).values()].slice(0, 3)) parts.push(`${u.library} cannot be read (${u.why})`)
    if (!parts.length) parts.push(tree.libraries.tableError ? `the project's sym-lib-table cannot be read (${tree.libraries.tableError})` : "the files given have no symbol library (a sym-lib-table with the .kicad_sym files it lists) to take them from")
    report.entries.push({
      code: "symbol-not-in-cache",
      severity: "refused",
      object: `${missing.length} symbol${missing.length > 1 ? "s" : ""} (${names.slice(0, 4).join(", ")}${names.length > 4 ? ", ..." : ""})`,
      why: `The schematic's own library cache has no drawing for these, and nothing else has: ${parts.join("; ")}. Add the library files to the project (the .kicad_sym files and the sym-lib-table that lists them), or save the schematic again in KiCad, which keeps a copy of every symbol in the file (S12). The importer never draws a symbol the file or the project's libraries do not have.`,
      count: missing.length,
    })
  }

  // ---------- no-connects: the pins that lie on a flag ----------
  const flagsOf = new Map(files.map((f) => [f.path, new Set(f.schematic.noConnects.map((n) => keyOf(n.at)))]))
  const pinPlacesOf = new Map<string, Set<string>>()
  for (const pp of pinPoints) (pinPlacesOf.get(pp.file.path) ?? pinPlacesOf.set(pp.file.path, new Set()).get(pp.file.path)!).add(keyOf(pp.at))
  const ncOf = new Map<string, Set<string>>()
  for (const pp of pinPoints) {
    if (!flagsOf.get(pp.file.path)!.has(keyOf(pp.at))) continue
    const set = ncOf.get(pp.c.id) ?? new Set()
    set.add(pp.pin)
    ncOf.set(pp.c.id, set)
  }
  for (const c of components) if (ncOf.has(c.id)) c.nc = [...ncOf.get(c.id)!]

  // ---------- each sheet's own wires, labels and drawings (once, whatever the number of its uses) ----------
  const wires: Wire[] = []
  const sheetDrawings: SchematicDrawing[] = []
  const pointsOf = (f: SheetFile) => pinPoints.filter((p) => p.file === f && p.first)
  const stamp = (f: SheetFile) => f.schematic.version
  const SHAPES = new Set(["input", "output", "bidirectional", "tri_state", "passive"])

  for (const f of files) {
    const sch = f.schematic
    // S11: a sheet built with KiCad's joining rules also keeps KiCad's coordinates to six digits (100 nm is 8e-6 of the editor's unit; four digits would move points).
    const exact = kicadFiles.has(f.path)
    const PXf = exact ? X : PX
    const PYf = exact ? Y : PY
    /** The editor's place of a KiCad point: where the editor has the pin KiCad has there, else the point to the digits the sheet keeps. */
    const at = (p: Pt): Vec2 => {
      const own = { x: PXf(p.x), y: PYf(p.y) }
      const pin = pinAt.get(`${f.path}|${keyOf(p)}`)
      if (!pin) return own
      const d = Math.hypot(pin.x - own.x, pin.y - own.y)
      if (d > 1e-9) {
        snappedKeys.add(`${f.path}|${keyOf(p)}`)
        snapped.maxUm = Math.max(snapped.maxUm, d * MM_PER_UNIT * 1000)
      }
      return pin
    }
    const editorPt = at
    /** A case where the editor and KiCad would join differently: the sheet is built again with KiCad's rules (S11). */
    const joinCase = (why: string) => {
      if (exact) return
      const list = joinCases.get(f.path) ?? joinCases.set(f.path, []).get(f.path)!
      if (!list.includes(why)) list.push(why)
    }
    const here = sheetTag(f)
    const sheetPins = pointsOf(f)
    const ncKeys = ncPinKeys.get(f.path) ?? new Set<string>()
    const flags = flagsOf.get(f.path)!
    const pinAtHere = pinPlacesOf.get(f.path) ?? new Set<string>()

    // A pin of the type "no connect" is on no net in the editor (as in KiCad 6 and later). KiCad 5 joins it to whatever is drawn to it: a wire end, a label, a junction, another pin.
    if (sch.legacy && ncKeys.size) {
      const count = new Map<string, number>()
      for (const pp of sheetPins) count.set(keyOf(pp.at), (count.get(keyOf(pp.at)) ?? 0) + 1)
      const drawn = new Set<string>()
      for (const w of sch.wires) if (w.pts.length >= 2) for (const p of [w.pts[0], w.pts[w.pts.length - 1]]) drawn.add(keyOf(p))
      for (const l of sch.labels) drawn.add(keyOf(l.at))
      for (const j of sch.junctions) drawn.add(keyOf(j.at))
      for (const k of ncKeys) {
        if (drawn.has(k) || (count.get(k) ?? 0) > 1) {
          lose("S11L", "a pin of the type no connect with a wire, label, junction or other pin at it, which KiCad 5 joins to the net and KiCad 6 and later leave out")
          break
        }
      }
    }

    // A symbol taken from one of the project's libraries and not from the schematic's own cache is not the symbol the wires were drawn to: libraries change. If a wire
    // ends near such a symbol, where it has no pin and where nothing else is, the library has moved its pins since: the project is refused as inexact, naming the symbol.
    {
      // A KiCad 5 symbol taken from a project library, and (S12) a symbol of a modern sheet that the cache lacked and a library or the database gave.
      const fromLibrary = new Set<string>([...(sch.legacy?.symbolSources.filter((x) => x.from === "library").map((x) => x.libId) ?? []), ...sch.symbols.filter((sym) => fromLibraryKeys.has(`${f.path}\u0000${sym.cacheKey}`)).map((sym) => sym.libId)])
      if (fromLibrary.size) {
        const at = new Map<string, number>()
        const bump = (p: Pt) => at.set(keyOf(p), (at.get(keyOf(p)) ?? 0) + 1)
        for (const w of sch.wires) if (w.pts.length >= 2) for (const e of [w.pts[0], w.pts[w.pts.length - 1]]) bump(e)
        for (const pp of sheetPins) bump(pp.at)
        for (const l of sch.labels) bump(l.at)
        for (const j of sch.junctions) bump(j.at)
        for (const n of sch.noConnects) bump(n.at)
        const drifted: string[] = []
        for (const sym of sch.symbols) {
          const c = firstOf.get(sym)
          if (!c || !fromLibrary.has(sym.libId)) continue
          const mine = sheetPins.filter((p) => p.c === c)
          if (!mine.length) continue
          const reach = 2.54
          const x0 = Math.min(...mine.map((p) => p.at.x)) - reach
          const x1 = Math.max(...mine.map((p) => p.at.x)) + reach
          const y0 = Math.min(...mine.map((p) => p.at.y)) - reach
          const y1 = Math.max(...mine.map((p) => p.at.y)) + reach
          const own = new Set(mine.map((p) => keyOf(p.at)))
          const dangling = sch.wires.some((w) => w.pts.length >= 2 && [w.pts[0], w.pts[w.pts.length - 1]].some((e) => e.x >= x0 && e.x <= x1 && e.y >= y0 && e.y <= y1 && !own.has(keyOf(e)) && at.get(keyOf(e)) === 1))
          // The pins the file lists for the instance (and the alternates it chose) are the library's own pins of that unit: a library that has renumbered or
          // renamed its pins at the same places gives every wire a pin and the wrong net. The instance says no name but an alternate's, so that is what is checked.
          const lib = drawings.get(`${f.path} ${sym.cacheKey}`)?.lib
          let renumbered = false
          if (lib && sym.pins.length) {
            const own = pinsOfUnit(lib, sym.unit, sym.bodyStyle)
            const numbers = new Set(own.flatMap((p) => expandPinNumber(p.number)))
            const listed = new Set(sym.pins.map((p) => p.number))
            renumbered = [...listed].some((n) => !numbers.has(n)) || [...numbers].some((n) => !listed.has(n))
            if (!renumbered) renumbered = sym.pins.some((p) => p.alternate !== null && !own.some((o) => expandPinNumber(o.number).includes(p.number) && o.alternates.some((x) => x.name === p.alternate)))
          }
          if (dangling || renumbered) drifted.push(`${c.ref} (${sym.libId})`)
        }
        if (drifted.length) {
          report.entries.push({
            code: "symbol-may-have-changed",
            severity: "refused",
            object: `${drifted.length} symbol${drifted.length > 1 ? "s" : ""} (${drifted.slice(0, 4).join(", ")}${drifted.length > 4 ? ", ..." : ""})`,
            why: "These symbols come from a library of the project, not from the schematic's own cache, and either a wire ends near each where it has no pin, or the pins the schematic lists for it are not the library's (numbered or named differently): the library has drawn the symbol differently since the schematic was drawn, so its nets would not be the ones in the file. Nothing is guessed.",
            count: drifted.length,
          })
        }
      }
    }

    // ---------- wires, cut at the junctions on their bodies ----------
    const junctionPts = sch.junctions.map((j) => j.at)
    const junctionKeys = new Set(junctionPts.map(keyOf))
    const wireStrokes = sch.wires.filter((w) => w.pts.length >= 2).map((w) => strokeOf(w.node))
    const wiresIn = sch.wires.filter((w) => w.pts.length >= 2).map((w) => ({ a: w.pts[0], b: w.pts[w.pts.length - 1] }))
    const grid = new SegGrid(wiresIn)
    /** A point of the sheet, for the check at the end that the editor joins what KiCad joins and no more. */
    const trackPoint = (p: Pt, e: Vec2 = at(p)) => {
      points.push({ file: f.path, k: keyOf(p), e })
    }
    const cutsOf = new Map<number, Pt[]>()
    for (const j of junctionPts) {
      for (const i of grid.near(j)) {
        const w = wiresIn[i]
        if (strictlyInside(q(j.x), q(j.y), q(w.a.x), q(w.a.y), q(w.b.x), q(w.b.y))) (cutsOf.get(i) ?? cutsOf.set(i, []).get(i)!).push(j)
      }
    }
    /** The editor joins a point to a wire it is within 1.27 um of; KiCad only to one it is exactly on. */
    const nearMiss = (p: Pt, own?: { a: Pt; b: Pt }) => {
      for (const i of grid.near(p)) {
        const o = wiresIn[i]
        if (o === own) continue
        const exactEnd = keyOf(p) === keyOf(o.a) || keyOf(p) === keyOf(o.b)
        if (exactEnd || strictlyInside(q(p.x), q(p.y), q(o.a.x), q(o.a.y), q(o.b.x), q(o.b.y))) continue
        if (distanceToSegment(p, o.a, o.b) < EDITOR_TOLERANCE_MM * 1.0001) return true
      }
      return false
    }
    wiresIn.forEach((w, wi) => {
      const cuts = cutsOf.get(wi) ?? []
      for (const end of [w.a, w.b]) {
        // A wire end on another wire's body is joined by the editor and, with no junction, not by KiCad (connection_graph.cpp, sch_line.cpp).
        if (!junctionKeys.has(keyOf(end))) {
          for (const i of grid.near(end)) {
            const o = wiresIn[i]
            if (o !== w && strictlyInside(q(end.x), q(end.y), q(o.a.x), q(o.a.y), q(o.b.x), q(o.b.y))) joinCase("a wire end touches another wire's side with no junction")
          }
        }
        if (nearMiss(end, w)) joinCase("a wire end lies a hair's breadth from another wire")
      }
      const along = (p: Pt) => (p.x - w.a.x) * (w.b.x - w.a.x) + (p.y - w.a.y) * (w.b.y - w.a.y)
      cuts.sort((m, n) => along(m) - along(n))
      const chain = [w.a, ...cuts.filter((c, i) => i === 0 || keyOf(c) !== keyOf(cuts[i - 1])), w.b]
      for (let i = 0; i < chain.length - 1; i++) {
        if (keyOf(chain[i]) === keyOf(chain[i + 1])) continue
        wires.push({ id: uid("w"), ...here, points: [editorPt(chain[i]), editorPt(chain[i + 1])], ...(wireStrokes[wi] ? { look: wireStrokes[wi] } : {}) })
      }
      for (const p of chain) trackPoint(p)
    })

    // ---------- labels ----------
    /** A label with the kind, shape, size, style and fields its file gave it. */
    const labelOf = (l: SchLabel): NetLabel | null => {
      const turn = normalizeAngle(Math.round(l.angle))
      if (turn % 90 !== 0 || Math.abs(l.angle - Math.round(l.angle)) > 1e-9) {
        report.entries.push({ code: "label-not-held", severity: "refused", object: `the label ${l.text}`, why: "It is turned by other than a quarter turn, which the editor cannot draw." })
        return null
      }
      const kind = l.kind === "global" ? "global" : l.kind === "hierarchical" ? "hierarchical" : "local"
      if (kind !== "local" && (l.shape === null || !SHAPES.has(l.shape))) {
        report.entries.push({ code: "label-not-held", severity: "refused", object: `the ${kind === "global" ? "global" : "hierarchical"} label ${l.text}`, why: `Its shape ${l.shape === null ? "is missing" : `"${l.shape}" is not one KiCad has`}.` })
        return null
      }
      const rot = turn as Rotation
      const place = at(l.at)
      const out: NetLabel = { id: uid("l"), ...here, name: l.text, x: place.x, y: place.y, rot, kind }
      if (kind !== "local") out.shape = l.shape as LabelShape
      // Size, weight, colour and a justification other than the one its turn gives.
      const look = textLookOf(l.node, textNotes)
      if (look) {
        const j = labelJustify({ rot, kind, look: undefined })
        if (look.h === j.h) delete look.h
        if (look.v === j.v) delete look.v
        if (Object.keys(look).length) out.look = look
      }
      const props = readProps(l.node, stamp(f))
      if (props.length) out.fields = labelFields(l, props, textNotes)
      if (l.node.some((c) => Array.isArray(c) && c[0] === "fields_autoplaced" && (c[1] === undefined || c[1] === "yes")) || l.node.includes("fields_autoplaced")) out.fieldsAutoplaced = true
      return out
    }
    /** S8: a directive label (`netclass_flag`) as the drawing the editor holds: its pin, shape and turn, its look and every property it has. */
    const directiveOf = (l: SchLabel): DrawingDirective | null => {
      const turn = normalizeAngle(Math.round(l.angle))
      if (turn % 90 !== 0 || Math.abs(l.angle - Math.round(l.angle)) > 1e-9) {
        report.entries.push({ code: "label-not-held", severity: "refused", object: "a directive label", why: "It is turned by other than a quarter turn, which the editor cannot draw." })
        return null
      }
      if (l.shape === null || !DIRECTIVE_SHAPES.has(l.shape)) {
        report.entries.push({ code: "label-not-held", severity: "refused", object: "a directive label", why: `Its flag shape ${l.shape === null ? "is missing" : `"${l.shape}" is not one KiCad has for a directive label`}.` })
        return null
      }
      const length = kid(l.node, "length")
      if (length && (!Number.isFinite(Number(strAt(length, 1))) || Number(strAt(length, 1)) < 0)) {
        report.entries.push({ code: "label-not-held", severity: "refused", object: "a directive label", why: `Its pin length "${strAt(length, 1) ?? ""}" is not a length (a number of millimetres, nothing below zero), so the file looks damaged.` })
        return null
      }
      const look = textLookOf(l.node, textNotes)
      const props = readProps(l.node, stamp(f))
      return {
        id: uid("d"),
        type: "directive",
        text: l.raw,
        x: PX(l.at.x),
        y: PY(l.at.y),
        rot: turn as Rotation,
        shape: l.shape as DirectiveShape,
        // KiCad's own default pin is 100 mil, which a file that says no length does not have: the reader refuses a `(length)` that is not a number.
        length: length ? u(numAt(length, 1)) : u(2.54),
        ...(look ? { look } : {}),
        fields: labelFields(l, props, textNotes),
        ...(l.node.some((c) => Array.isArray(c) && c[0] === "fields_autoplaced" && (c[1] === undefined || c[1] === "yes")) || l.node.includes("fields_autoplaced") ? { fieldsAutoplaced: true as const } : {}),
      }
    }
    for (const l of sch.labels) {
      // S8: a directive label is a drawing of the sheet that sits on a wire, a pin or a rule area's edge; what it says (a net class) is worked out from it (`model/directives.ts`).
      if (l.kind === "directive") {
        const d = directiveOf(l)
        if (d) sheetDrawings.push({ ...d, ...here } as SchematicDrawing)
        continue
      }
      const label = labelOf(l)
      if (!label) continue
      labels.push(label)
      trackPoint(l.at)
      // A label on a pin is KiCad's alone with the pin, and skips a wire that only passes there (sch_label.cpp); the editor joins the wire.
      // KiCad 5 does not: a label joins the pin at its point and every wire it lies on (`NETLIST_OBJECT_LIST::segmentToPointConnect`), which is what the editor does.
      if (pinAtHere.has(keyOf(l.at)) && !junctionKeys.has(keyOf(l.at))) {
        for (const i of grid.near(l.at)) {
          const o = wiresIn[i]
          if (!strictlyInside(q(l.at.x), q(l.at.y), q(o.a.x), q(o.a.y), q(o.b.x), q(o.b.y))) continue
          // KiCad 5 joins such a label to both the pin and the wire, which is what the editor does; the flag would take the wire away, so a KiCad 5 sheet with this and a case that needs the flag is not built.
          if (sch.legacy) {
            if (exact) lose("S11L", "a label on a pin on a wire's side, which KiCad 5 joins to the wire, in a sheet that also needs KiCad 6's rules for what a wire joins")
          } else joinCase("a label on a pin that lies on a wire's side joins the pin alone")
        }
      }
      if (nearMiss(l.at)) joinCase("a label lies a hair's breadth from a wire")
    }

    // KiCad 5 joins two labels only through something that starts a join (`NETLIST_OBJECT_LIST::BuildNetListInfo`): a wire a label is on (`segmentToPointConnect`), or a pin, a
    // wire end, a pin label, a sheet pin or a no-connect flag at its point (`pointToPointConnect`, which starts from those and from nothing else). Two labels of different
    // names stacked on an empty point stay two nets in KiCad 5. KiCad 6 joins them (`SCH_LABEL::CanConnect`), and so does the editor, which puts what touches on one net.
    if (sch.legacy) {
      const textOf = (l: SchLabel) => l.raw
      const named = sch.labels.filter((l) => l.kind === "local" || l.kind === "global")
      const wireEnds = new Set<string>()
      for (const w of wiresIn) {
        wireEnds.add(keyOf(w.a))
        wireEnds.add(keyOf(w.b))
      }
      // A sheet pin is something that starts a join, as a pin of a part is.
      for (const s of sch.sheets) for (const p of s.pins) wireEnds.add(keyOf(p.at))
      const onWire = (p: Pt) => wireEnds.has(keyOf(p)) || grid.near(p).some((i) => strictlyInside(q(p.x), q(p.y), q(wiresIn[i].a.x), q(wiresIn[i].a.y), q(wiresIn[i].b.x), q(wiresIn[i].b.y)))
      const stacked = new Map<string, SchLabel[]>()
      for (const l of named) (stacked.get(keyOf(l.at)) ?? stacked.set(keyOf(l.at), []).get(keyOf(l.at))!).push(l)
      for (const [k, there] of stacked) {
        if (there.length < 2 || new Set(there.map(textOf)).size < 2) continue
        if (wireEnds.has(k) || pinAtHere.has(k) || flags.has(k) || onWire(there[0].at)) continue
        lose("S11L", `labels of different names stacked on a point with no wire, pin or no-connect flag (${[...new Set(there.map(textOf))].slice(0, 3).join(", ")}), which KiCad 5 keeps as separate nets and the editor joins`)
        break
      }
      // KiCad 5 compares label names as written: `~A~` and `~A` are two nets. The editor reads both as the name with an overbar on A.
      const written = new Map<string, Set<string>>()
      for (const l of named) (written.get(l.text) ?? written.set(l.text, new Set()).get(l.text)!).add(l.raw)
      for (const [text, raws] of written) {
        if (raws.size > 1) {
          lose("S11L", `labels written differently (${[...raws].slice(0, 3).join(", ")}) that the editor reads as one name (${text}), which KiCad 5 keeps as separate nets`)
          break
        }
      }
    }
    // The pins of parts are tracked once the parts are registered, with the place the editor gives them. A sheet pin is a point of the sheet too.
    for (const s of sch.sheets) for (const p of s.pins) trackPoint(p.at, { x: PXf(p.at.x), y: PYf(p.at.y) })

    // ---------- buses and bus entries (S3), as drawings of the sheet ----------
    // A bus is a line like a wire: the editor joins a bus end to another bus's side and KiCad only through a junction, so a bus is cut at the junctions
    // on its body (as a wire is) and an end on another bus's side with no junction is S11 (the sheet is built with KiCad's rules, `joinCase`).
    const busSegs = sch.buses.flatMap((b) => {
      if (b.pts.length !== 2) {
        report.entries.push({ code: "bus-not-held", severity: "refused", object: "a bus", why: `It has ${b.pts.length} points, and KiCad's buses are one straight segment each.` })
        return []
      }
      return [{ a: b.pts[0], b: b.pts[1], stroke: strokeOf(b.node) }]
    })
    const busGrid = new SegGrid(busSegs.map((s) => ({ a: s.a, b: s.b })))
    if (busSegs.length) {
      const busCuts = new Map<number, Pt[]>()
      for (const j of junctionPts) {
        for (const i of busGrid.near(j)) {
          const s = busSegs[i]
          if (strictlyInside(q(j.x), q(j.y), q(s.a.x), q(s.a.y), q(s.b.x), q(s.b.y))) (busCuts.get(i) ?? busCuts.set(i, []).get(i)!).push(j)
        }
      }
      busSegs.forEach((s, bi) => {
        for (const end of [s.a, s.b]) {
          if (junctionKeys.has(keyOf(end))) continue
          for (const i of busGrid.near(end)) {
            const o = busSegs[i]
            if (o !== s && strictlyInside(q(end.x), q(end.y), q(o.a.x), q(o.a.y), q(o.b.x), q(o.b.y))) joinCase("a bus end that touches another bus's side with no junction")
          }
        }
        const along = (p: Pt) => (p.x - s.a.x) * (s.b.x - s.a.x) + (p.y - s.a.y) * (s.b.y - s.a.y)
        const cuts = (busCuts.get(bi) ?? []).sort((m, n) => along(m) - along(n))
        const chain = [s.a, ...cuts.filter((c, i) => i === 0 || keyOf(c) !== keyOf(cuts[i - 1])), s.b]
        for (let i = 0; i < chain.length - 1; i++) {
          if (keyOf(chain[i]) === keyOf(chain[i + 1])) continue
          sheetDrawings.push({ id: uid("d"), type: "bus", ...here, points: [editorPt(chain[i]), editorPt(chain[i + 1])], ...(s.stroke ? { stroke: s.stroke } : {}) } as SchematicDrawing)
        }
        for (const p of chain) trackPoint(p)
      })
    }
    for (const e of sch.busEntries) {
      const far = { x: e.at.x + e.size.x, y: e.at.y + e.size.y }
      if (e.size.x === 0 && e.size.y === 0) {
        report.entries.push({ code: "bus-not-held", severity: "refused", object: "a bus entry", why: "It has no size." })
        continue
      }
      const stroke = strokeOf(e.node)
      const a = editorPt(e.at)
      const b = editorPt(far)
      sheetDrawings.push({ id: uid("d"), type: "busentry", ...here, x: a.x, y: a.y, dx: round(b.x - a.x, 6), dy: round(b.y - a.y, 6), ...(e.toBus ? { toBus: true as const } : {}), ...(stroke ? { stroke } : {}) } as SchematicDrawing)
      trackPoint(e.at)
      trackPoint(far)
      // A bus entry joins the wire at an end that is on no bus. The editor joins an end on a wire's side; KiCad does not (`updateItemConnectivity` gives the entry only its own points), so that is S11.
      if (e.toBus) continue
      for (const end of [e.at, far]) {
        const onBus = busGrid.near(end).some((i) => {
          const s = busSegs[i]
          return keyOf(end) === keyOf(s.a) || keyOf(end) === keyOf(s.b) || strictlyInside(q(end.x), q(end.y), q(s.a.x), q(s.a.y), q(s.b.x), q(s.b.y))
        })
        if (onBus || junctionKeys.has(keyOf(end))) continue
        for (const i of grid.near(end)) {
          const o = wiresIn[i]
          if (strictlyInside(q(end.x), q(end.y), q(o.a.x), q(o.a.y), q(o.b.x), q(o.b.y))) joinCase("a bus entry whose end touches a wire's side with no junction, which the editor joins to the wire and KiCad does not")
        }
      }
    }

    // The sheet's own text, lines, boxes, pictures and tables.
    const items = readSheetItems(sch)
    for (const n of items.notes) textNotes.add(n)
    for (const why of items.problems) {
      report.entries.push({ code: "item-not-held", severity: "refused", object: "something on the sheet", why: `${why[0].toUpperCase()}${why.slice(1)}, which the editor cannot draw.` })
    }
    for (const d of items.drawings) sheetDrawings.push({ ...d, ...here } as SchematicDrawing)
  }

  // ---------- bus aliases (S3): what each file names, kept with its sheet ----------
  const busAliases: BusAlias[] = (options.busAliases ?? []).map((a, i) => ({ id: `p${i + 1}`, name: a.name, members: [...a.members] }))
  for (const f of files) {
    for (const a of f.schematic.busAliases) {
      const name = aliasText(a.name, stamp(f))
      const members = a.members.map((m) => aliasText(m, stamp(f)))
      const had = busAliases.find((x) => x.name === name)
      // KiCad keeps one cache of aliases for the whole schematic, a later sheet's over an earlier one's: two of one name that differ would be read as one.
      if (had && (had.members.length !== members.length || had.members.some((m, i) => m !== members[i]))) lose("S3B", `two bus aliases of one name (${name}) with different members, which KiCad reads as the last one`)
      busAliases.push({ id: `a${busAliases.length + 1}`, ...sheetTag(f), name, members })
    }
  }

  // ---------- groups: a block of the symbols in each, for each use ----------
  const blocks: SchematicBlock[] = []
  for (const use of uses) {
    const bySymbolUuid = new Map<string, ComponentInstance>()
    for (const [r, c] of byRecord) if (r.file === use.file.path && r.sheetPath === use.boardPath) bySymbolUuid.set(r.symbol.uuid, c)
    for (const g of use.file.schematic.groups) {
      const members = g.members.map((m) => bySymbolUuid.get(m)).filter((c): c is ComponentInstance => !!c && !blocks.some((b) => b.components.includes(c.id)))
      const others = g.members.length - g.members.filter((m) => bySymbolUuid.has(m)).length
      if (members.length) blocks.push({ id: uid("b"), ...instTag(use), name: g.name || "Group", components: members.map((c) => c.id), ...(g.node.some((c) => Array.isArray(c) && c[0] === "locked" && (c[1] === undefined || c[1] === "yes")) || g.node.includes("locked") ? { locked: true as const } : {}) })
      // The same group on every use of the sheet is one report entry.
      if (others > 0 && use.first) {
        report.entries.push({ code: "group-member-not-in-block", severity: "not-brought", object: `${others} member${others > 1 ? "s" : ""} of the group ${g.name ? `"${g.name}"` : "(no name)"}`, why: "A block holds symbols; the wires and other items of a group stay where they are but are not in its block.", count: others })
      }
    }
  }

  // ---------- the sheet symbols, and the sheets they name ----------
  const sheets: SchematicSheet[] = []
  const sheetSymbols: SheetSymbol[] = []
  for (const f of files) {
    const sch = f.schematic
    const def = sheetId.get(f.path)!
    const entry: SchematicSheet = { id: def }
    // A single pasted schematic is read as `schematic.kicad_sch`, which is no name of the user's. The file's path from the root schematic's folder (as KiCad's Sheetfile has it); one outside that folder keeps its name alone.
    const rootDir = tree.root.includes("/") ? tree.root.slice(0, tree.root.lastIndexOf("/") + 1) : ""
    if (def === ROOT_SHEET) { if (f.path !== "schematic.kicad_sch") entry.file = f.path.slice(f.path.lastIndexOf("/") + 1) } else entry.file = f.path.startsWith(rootDir) ? f.path.slice(rootDir.length) : f.path.slice(f.path.lastIndexOf("/") + 1)
    if (kicadFiles.has(f.path)) entry.kicadRules = true
    // KiCad's own ids (uuids) and page numbers are not kept: the export makes ids from ours and numbers the pages in the order of the tree.
    if (def !== ROOT_SHEET && sch.titleBlock.length) entry.titleBlock = sch.titleBlock.map((t) => ({ ...t }))
    sheets.push(entry)
  }
  for (const f of files) {
    const sch = f.schematic
    for (const s of sch.sheets) {
      const id = symbolId.get(s)
      const resolved = tree.uses.find((u) => u.sheet === s && u.found)
      if (!id || !resolved) continue
      const sym = sheetSymbolOf(f, s, id, sheetId.get(f.path)!, sheetId.get(resolved.file)!)
      if (!sym) continue
      // S9: what each variant changes on each use of this sheet symbol, by the use of the parent sheet it is drawn on (the instance's path is that sheet's).
      const variants: Record<string, Record<string, VariantOverride>> = {}
      const base = { dnp: yesOf(s.node, "dnp", false), excludeFromSim: yesOf(s.node, "exclude_from_sim", false), excludeFromBom: !yesOf(s.node, "in_bom", true), notOnBoard: !yesOf(s.node, "on_board", true), excludeFromPos: false }
      for (const use of uses) {
        if (use.inst.sheet !== s) continue
        const cut = use.inst.path.lastIndexOf("/")
        const own = s.instances.find((i) => i.path === use.inst.path.slice(0, cut))
        const parentUse = use.path.slice(0, use.path.lastIndexOf("/"))
        const o = own ? overridesOf(own.variants, base) : undefined
        if (o) variants[parentUse] = o
      }
      if (Object.keys(variants).length) sym.variants = variants
      sheetSymbols.push(sym)
    }
  }

  /** A sheet symbol as the project holds it: the rectangle with its fields, border, fill, flags and pins, in the editor's frame. */
  function sheetSymbolOf(f: SheetFile, s: SchSheet, id: string, parent: string, child: string): SheetSymbol | null {
    const stampOf = stamp(f)
    const props = readProps(s.node, stampOf)
    const angled = s.pins.filter((p) => ![0, 90, 180, 270].includes(normalizeAngle(Math.round(p.angle))) || Math.abs(p.angle - Math.round(p.angle)) > 1e-9)
    if (angled.length) {
      report.entries.push({ code: "sheet-pin-not-held", severity: "refused", object: `the pin ${angled[0].name} of the sheet ${s.name ?? ""}`, why: "It is turned by other than a quarter turn, which the editor cannot draw." })
      return null
    }
    const origin = { x: s.at.x, y: s.at.y + s.size.y }
    const pins: SheetPin[] = s.pins.map((p, i) => {
      if (!SHAPES.has(p.type)) report.entries.push({ code: "sheet-pin-not-held", severity: "refused", object: `the pin ${p.name} of the sheet ${s.name ?? ""}`, why: `Its shape "${p.type}" is not one KiCad has.` })
      const look = textLookOf(p.node, textNotes)
      return { id: `p${i + 1}`, name: p.name, shape: (SHAPES.has(p.type) ? p.type : "bidirectional") as LabelShape, x: pxOf(f)(p.at.x), y: pyOf(f)(p.at.y), rot: (normalizeAngle(Math.round(p.angle)) as Rotation), ...(look ? { look } : {}) }
    })
    const out: SheetSymbol = {
      id,
      ...(s.uuid ? { uuid: s.uuid } : {}),
      sheet: parent,
      child,
      x: X(s.at.x),
      y: Y(s.at.y + s.size.y),
      w: X(s.size.x),
      h: X(s.size.y),
      name: s.name ?? "",
      pins,
    }
    // The name and file fields keep their place under KiCad 7's names; the file's is not kept, as the export names the file after the sheet.
    const own = sheetFieldProps(props, stampOf)
    const fields = props.map((p) => ({ name: p === own.name ? "Sheetname" : p === own.file ? "Sheetfile" : p.name, value: p === own.file ? "" : p.value, place: placeOf(p, origin, textNotes) }))
    if (fields.length) out.fields = fields
    const stroke = strokeOf(s.node)
    if (stroke) out.stroke = stroke
    const fillNode = kid(s.node, "fill")
    const fillColor = colorOf(kid(fillNode, "color"))
    const fillType = strAt(kid(fillNode, "type"), 1)
    if (fillType === "outline" || fillType === "background") out.fill = { kind: fillType }
    else if (fillColor) out.fill = { kind: "color", color: fillColor }
    const flags: NonNullable<SheetSymbol["flags"]> = {}
    if (yesOf(s.node, "dnp", false)) flags.dnp = true
    if (!yesOf(s.node, "in_bom", true)) flags.excludeFromBom = true
    if (!yesOf(s.node, "on_board", true)) flags.notOnBoard = true
    if (yesOf(s.node, "exclude_from_sim", false)) flags.excludeFromSim = true
    if (Object.keys(flags).length) out.flags = flags
    if (yesOf(s.node, "fields_autoplaced", false)) out.fieldsAutoplaced = true
    return out
  }

  const version = root.legacy ? `EESchema Schematic File Version ${root.legacy.version}` : `${root.generatorVersion ? `KiCad ${root.generatorVersion}, ` : ""}${root.version === null ? "no version stamp" : `file version ${root.version}`}`
  const properties = [
    { key: "Imported from", value: options.source ?? `KiCad ${root.generatorVersion ?? ERA_NAME[root.era]}` },
    { key: "KiCad file version", value: version },
    ...root.titleBlock.filter((t) => !(options.name === undefined && t.key === "Title" && title && title.trim())),
  ]
  if (textNotes.size) {
    report.entries.push({ code: "text-style-not-brought", severity: "not-brought", object: "the texts of symbols", why: `Some texts of the symbols ask for ${[...textNotes].join(", ")}. The editor draws every text in its own font: the size, weight, colour and justification are kept.` })
  }
  // S9: the project's variants: the project file's, in its order with its descriptions, then any the symbols name that it does not.
  const variantList: { name: string; description?: string }[] = []
  const listed = new Set<string>()
  for (const v of options.variants ?? []) if (v.name.trim() && !listed.has(v.name)) variantList.push({ name: (listed.add(v.name), v.name), ...(v.description ? { description: v.description } : {}) })
  for (const name of variantSeen) if (name.trim() && !listed.has(name)) variantList.push({ name: (listed.add(name), name) })
  if (unnamedVariants) {
    report.entries.push({ code: "variant-not-held", severity: "not-brought", object: `${unnamedVariants} variant${unnamedVariants > 1 ? "s" : ""} with no name`, why: "A variant is chosen by its name, so one with none is not kept.", count: unnamedVariants })
  }
  const hierarchical = sheetSymbols.length > 0
  // A one-sheet project lists its root only to say what is not the default: that it joins by KiCad's rules.
  const rootEntry = sheets.find((x) => x.id === ROOT_SHEET)
  const listRoot = !hierarchical && !!(rootEntry?.kicadRules || rootEntry?.file)
  project = {
    ...project,
    components,
    wires,
    labels,
    ...(hierarchical ? { sheets, sheetSymbols } : listRoot ? { sheets: [rootEntry!] } : {}),
    netNames: root.legacy ? ("kicad5" as const) : root.version !== null && root.version <= 20211123 ? ("kicad6" as const) : ("kicad" as const),
    ...(busAliases.length ? { busAliases } : {}),
    ...(blocks.length ? { blocks } : {}),
    ...(variantList.length ? { variants: { list: variantList } } : {}),
    properties,
    ...(specs.size ? { parts: [...specs.values()] } : {}),
    ...(Object.keys(symbols).length ? { symbols } : {}),
  }
  // The parts are in memory from here: the checks below read them as the editor does.
  for (const spec of specs.values()) if (!isRegistered(spec.id)) registered.push(spec.id)
  registerProjectParts(project)
  // Where the editor puts each pin, and whether it joins and parts what KiCad does (S11).
  const pinsAt = new Map<string, Vec2>()
  {
    const byId = new Map(project.components.map((c) => [c.id, c]))
    // A number that two pins share is already S5; which of them the editor draws is not a place to check.
    const seen = new Map<string, number>()
    for (const pp of pinPoints) seen.set(`${pp.c.id}:${pp.pin}`, (seen.get(`${pp.c.id}:${pp.pin}`) ?? 0) + 1)
    for (const pp of pinPoints) {
      if (!pp.first || (seen.get(`${pp.c.id}:${pp.pin}`) ?? 0) > 1) continue
      const c = byId.get(pp.c.id)!
      const world = schematicPins(c, findPart(c.partId)).find((p) => p.pin === pp.pin)
      if (!world) continue
      const key = `${pp.file.path}|${keyOf(pp.at)}`
      if (!pinsAt.has(key)) pinsAt.set(key, world.pos)
      points.push({ file: pp.file.path, k: keyOf(pp.at), e: world.pos })
    }
  }
  const editorKey = (file: string, e: Vec2) => (kicadFiles.has(file) ? `${Math.round(e.x * 127000)},${Math.round(e.y * 127000)}` : `${e.x.toFixed(3)},${e.y.toFixed(3)}`)
  const asEditor = new Map<string, Set<string>>()
  const asKicad = new Map<string, Set<string>>()
  for (const p of points) {
    const ek = `${p.file}|${editorKey(p.file, p.e)}`
    const kk = `${p.file}|${p.k}`
    ;(asEditor.get(kk) ?? asEditor.set(kk, new Set()).get(kk)!).add(ek)
    ;(asKicad.get(ek) ?? asKicad.set(ek, new Set()).get(ek)!).add(kk)
  }
  let pinsMoved = false
  // One KiCad point the editor puts in two places (a pin the editor's four digits move off the wire that ends on it): the wire's end is put on the pin.
  for (const set of asEditor.values()) {
    if (set.size < 2) continue
    if (final) lose("S11", "a pin that the editor's rounding would put off its wire")
    else pinsMoved = true
  }
  // Two KiCad points the editor puts in one (points closer than it tells apart): KiCad's rules and coordinates for the sheet.
  for (const [ek, set] of asKicad) {
    if (set.size < 2) continue
    const file = ek.slice(0, ek.indexOf("|"))
    if (final) lose("S11", "two points closer together than the editor can tell apart")
    else (joinCases.get(file) ?? joinCases.set(file, []).get(file)!).push("two points closer together than the editor can tell apart")
  }
  // Junction dots of their own size or colour, and ones where the editor would draw none, and no-connect flags that are not on a pin, are drawings of the sheet.
  const extra: SchematicDrawing[] = []
  for (const f of files) {
    const first = usesOfFile.get(f.path)![0]
    const view = sheetView(project, first.path)
    for (const d of junctionsAndFlags(view, f.schematic, pinPlacesOf.get(f.path) ?? new Set(), kicadFiles.has(f.path), (p) => pinAt.get(`${f.path}|${keyOf(p)}`) ?? (kicadFiles.has(f.path) ? { x: X(p.x), y: Y(p.y) } : { x: PX(p.x), y: PY(p.y) }))) extra.push({ ...d, ...sheetTag(f) } as SchematicDrawing)
  }
  const { drawings: all, pictures } = storePictures([...sheetDrawings, ...extra])
  if (all.length) project = { ...project, drawings: all }
  checkBusNames(project, [...new Set(sheetId.values())], lose)
  reportSplitPads(project, report)
  return { build: { project, lossy, bySymbol, byRecord, recordOf, registered, pictures, stats: { components: components.length, wires: wires.length, labels: labels.length, powerPorts } }, joinCases, pinsAt, pinsMoved, snapped: { count: snappedKeys.size, maxUm: snapped.maxUm } }
}


/**
 * The sheets' pictures go to the host's file store, as a board's do, and the project names each by the SHA-256 of its PNG with its size in pixels and
 * resolution (version 5): a picture does not compress, and kept as base64 in the project it was what took schematics over the stored project's limits.
 * One PNG drawn on several sheets is one file. A picture that is not a PNG stays as it was read.
 */
function storePictures(drawings: SchematicDrawing[]): { drawings: SchematicDrawing[]; pictures: KeptFile[] } {
  const pictures = new Map<string, KeptFile>()
  const out = drawings.map((d): SchematicDrawing => {
    if (d.type !== "image" || !d.data) return d
    const bytes = decodeBase64(d.data)
    if (!bytes || bytes[0] !== 0x89 || bytes[1] !== 0x50) return d
    const info = pngInfo(d.data)
    const id = sha256Hex(bytes)
    pictures.set(id, { id, name: "schematic-picture.png", bytes })
    const { data: _data, ...rest } = d
    return { ...rest, file: id, px: info.width, py: info.height, ...(info.ppi ? { ppi: info.ppi } : {}) }
  })
  return { drawings: out, pictures: [...pictures.values()] }
}

/**
 * S3: the bus names the model reads as KiCad does. A label or sheet pin whose name is a bus but that sits on a wire is a net's name in the
 * editor and a bus with pins on it in KiCad, which the model does not hold (S3B); a name KiCad 9 and KiCad 10 read differently cannot be
 * told which drew the board's nets (S3B); and a bus of more nets than the importer will hold is refused (S3B).
 */
function checkBusNames(project: Project, sheets: string[], lose: (ext: string, why: string) => void) {
  if (!mayHaveBuses(project)) return
  const aliases = aliasLookup(project.busAliases)
  const texts = new Set<string>()
  const maybe = (t: string) => t.includes("[") || t.includes("{")
  const parse = (t: string, what: string) => {
    try {
      return parseBusName(t, aliases)
    } catch (e) {
      if (!(e instanceof BusTooLarge)) throw e
      lose("S3B", `${what} that carries more nets than the importer holds (${e.message})`)
      return null
    }
  }
  for (const id of sheets) {
    const wires = project.wires.filter((w) => sheetIdOf(w) === id)
    const labels = project.labels.filter((l) => sheetIdOf(l) === id)
    const symbols = symbolsOnSheet(project, id)
    const sb = analyzeSheet(project, id, wires, labels, symbols, aliases)
    for (const l of labels) {
      const t = l.name.trim()
      if (!maybe(t)) continue
      texts.add(t)
      if (parse(t, "a bus name") && !sb.busLabels.has(l.id)) lose("S3B", `a bus name on a wire (${t}), which KiCad reads as a bus with pins on it`)
    }
    for (const sym of symbols) {
      for (const p of sym.pins) {
        const t = p.name.trim()
        if (!maybe(t)) continue
        texts.add(t)
        if (parse(t, "a bus name") && !sb.busPins.has(`${sym.id}:${p.id}`)) lose("S3B", `a bus name on a wire (${t}), which KiCad reads as a bus with pins on it`)
      }
    }
  }
  for (const a of project.busAliases ?? []) for (const t of [a.name, ...a.members]) if (maybe(t)) texts.add(t)
  for (const t of texts) if (differsBetweenGenerations(t, aliases)) lose("S3B", `the bus name ${t}, which KiCad 9 and KiCad 10 read differently`)
}

/**
 * A symbol that keeps the pins of one number apart can have them on different nets. A pad on a board is
 * on one net, so the board's pad of that number takes the net of the first of them: the report names the
 * pins, since the editor cannot hold more than that.
 */
function reportSplitPads(project: Project, report: ImportReport) {
  const { pinNet } = computeConnectivity(project)
  const split: string[] = []
  for (const c of project.components) {
    const part = findPart(c.partId)
    if (!part?.jumpers || part.jumpers.duplicates) continue
    for (const w of schematicPins(c, part)) {
      if (!w.slot) continue
      const first = pinNet.get(pinKey(c.id, w.pin))
      const here = pinNet.get(`${pinKey(c.id, w.pin)}#${w.slot}`)
      if (first && here && first !== here) split.push(`${c.ref} pin ${w.pin}`)
    }
  }
  if (!split.length) return
  report.entries.push({
    code: "split-pad",
    severity: "not-brought",
    object: `${split.length} pad${split.length > 1 ? "s" : ""} with pins of one number on different nets (${split.slice(0, 4).join(", ")}${split.length > 4 ? ", ..." : ""})`,
    why: "A pad on the board is on one net: it takes the net of the first of the pins of its number. The schematic keeps each pin on its own net.",
    count: split.length,
  })
}

/**
 * The junction dots and no-connect flags of a sheet that are items of their own: a junction whose dot is
 * not the editor's (a size or a colour of its own) or lies where the editor draws none, and a no-connect
 * flag that is not on a pin of a part (one on a pin is that pin's `nc` mark). The rest is drawn by the
 * editor from what meets there.
 */
function junctionsAndFlags(project: Project, root: KicadSchematic, flags: Set<string>, exact: boolean, at: (p: Pt) => Vec2): SchematicDrawing[] {
  const out: SchematicDrawing[] = []
  // On a sheet with KiCad's rules a dot is at an exact point: the editor's three digits would let a dot hide a junction a hundred nanometres away.
  const digits = exact ? 6 : 3
  const dots = new Set(computeConnectivity(project).junctions.map((j) => `${j.x.toFixed(digits)},${j.y.toFixed(digits)}`))
  for (const j of root.junctions) {
    const diameter = numAt(kid(j.node, "diameter"), 1, 0)
    const color = colorOf(kid(j.node, "color"))
    const { x, y } = at(j.at)
    const own = diameter > 0 || !!color
    if (!own && dots.has(`${x.toFixed(digits)},${y.toFixed(digits)}`)) continue
    out.push({ id: uid("d"), type: "junction", x, y, ...(diameter > 0 ? { diameter: round(diameter / MM_PER_UNIT, 6) } : {}), ...(color ? { dotColor: color } : {}) })
  }
  const pinKeys = flags
  for (const n of root.noConnects) {
    if (pinKeys.has(keyOf(n.at))) continue
    out.push({ id: uid("d"), type: "noconnect", x: at(n.at).x, y: at(n.at).y })
  }
  return out
}
