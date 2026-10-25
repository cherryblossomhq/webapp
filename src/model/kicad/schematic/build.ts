import { round } from "../../../lib/geometry"
import { uid } from "../../../lib/id"
import { computeConnectivity, pinKey } from "../../connectivity"
import { labelJustify } from "../../labelShapes"
import { customPartId, drawingKey, registerProjectParts } from "../../customParts"
import { schematicPins } from "../../instances"
import { findPart, isRegistered, unitTwinId, unregisterPart } from "../../library"
import { createProject } from "../../ops"
import type { ComponentInstance, CustomPartSpec, FieldPlace, LabelShape, Mirror, NetLabel, Project, Rotation, SchematicBlock, SheetItem, SymbolDrawing, SymbolFlags, Vec2, Wire } from "../../types"
import type { ImportReport } from "../board/report"
import { kid, numAt } from "../board/sexpr"
import { labelFields, readSheetItems, strokeOf, textLookOf } from "./annotations"
import { symbolRecords, type SymbolRecord } from "./link"
import type { Need } from "./needs"
import { MM_PER_UNIT, colorOf, drawingFromLib, expandPinNumber, pinsOfUnit, placeOf, resolveLibSymbol, specFromSymbol, toSheet, type ResolvedLibSymbol } from "./symbols"
import type { SchematicTree } from "./tree"
import { readProps } from "./read"
import type { KicadSchematic, LibPin, LibSymbol, PlacedSymbol, Pt, SchLabel } from "./types"

// A KiCad schematic as an editor project. The editor is y up and KiCad's sheet y down, so every y
// is negated and a rotation keeps its visual sense (both are counter-clockwise). KiCad's 1.27 mm
// is the editor's 0.1. Slice 3a builds one flat sheet: components with their place and turn,
// wires, junctions, no-connects, local labels, power symbols and groups; the rest (sheets, buses,
// global labels, text...) is an extension and is refused before this runs.
//
// The editor works out its own nets from where things touch, KiCad from its own rules, and the two
// differ in a few places. Each is handled so that the nets come out the same, or is an extension
// the schematic needs (`lossy`, each with the extension that will build it), never an approximation:
//
//   - a junction on a wire's body joins what is there. The editor joins wires at their ends, so the
//     wire is cut at the junction, as KiCad's own clean-up of a sheet cuts it;
//   - a wire end on another wire's body with no junction, a label on a pin that lies on a wire's
//     body, and a wire end or label a hair's breadth from a wire (the editor's tolerance is 1.27 um)
//     are joined by the editor and not by KiCad: the connectivity extension (S11);
//   - two KiCad points closer than the editor tells apart collapse to one (S11);
//   - a pin of the type "no connect" is on no net whatever is drawn to it: connectivity leaves it out;
//   - a hidden power-input pin joins the global net of its name: so it does in the editor (S5);
//   - the names KiCad gives nets (`/NAME`, `Net-(R1-Pad2)`, the power symbol over the label) are the
//     project's own rule (`Project.netNames`, S2): connectivity names each net as KiCad does.

/** The place of a point on the editor's sheet: to the editor's own four digits for what must meet a pin, to six for a part's origin. */
const PX = (mm: number) => round(mm / MM_PER_UNIT, 4)
const PY = (mm: number) => round(-mm / MM_PER_UNIT, 4)
const X = (mm: number) => round(mm / MM_PER_UNIT, 6)
const Y = (mm: number) => round(-mm / MM_PER_UNIT, 6)

/** The editor's tolerance in millimetres: its `pointOnSegment` takes 1e-4 of a unit as on (`lib/geometry.ts`). */
const EDITOR_TOLERANCE_MM = 1e-4 * MM_PER_UNIT

export interface SchematicBuildOptions {
  name?: string
  /** Kept as the project's "Imported from" property. */
  source?: string
  /** The footprint a symbol is linked to on the board (the project import): the land's name, and where the part is on the board. */
  footprintFor?: (symbol: PlacedSymbol) => { land: string; pcb: ComponentInstance["pcb"] } | undefined
  /** The extensions that are built; defaults to what the editor has. Measurement runs name more. */
  built?: ReadonlySet<string>
}

export interface SchematicBuild {
  project: Project
  /** What the model cannot hold exactly, each with the extension that will: the importer refuses a schematic with any that is not built. */
  lossy: Need[]
  /** The component each placed symbol became (a power symbol too). */
  bySymbol: Map<PlacedSymbol, ComponentInstance>
  /** The record (reference, path) each symbol was built from. */
  recordOf: Map<PlacedSymbol, SymbolRecord>
  /** The ids of the parts this build registered in memory (not those a registered part of the same id already was). `releaseBuild` takes them out when the project is not imported. */
  registered: string[]
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

/** Schematic to project. Throws nothing for a schematic the model can hold; `lossy` names every extension it needs otherwise. */
export function buildSchematicProject(tree: SchematicTree, report: ImportReport, options: SchematicBuildOptions = {}): SchematicBuild {
  const lossy: Need[] = []
  const lose = (ext: string, why: string) => {
    if (!lossy.some((n) => n.ext === ext && n.why === why)) lossy.push({ ext, why, source: "importer" })
  }
  const root = tree.files.get(tree.root)!.schematic
  const fileName = tree.root.slice(tree.root.lastIndexOf("/") + 1)
  const title = root.titleBlock.find((t) => t.key === "Title")?.value
  let project = createProject(options.name ?? (title && title.trim() ? title : "Imported KiCad schematic"), "")
  const bySymbol = new Map<PlacedSymbol, ComponentInstance>()
  const recordOf = new Map<PlacedSymbol, SymbolRecord>()
  const registered: string[] = []

  // Each symbol's reference, unit, value and footprint from the instance of the root sheet.
  const records = symbolRecords(tree).filter((r) => r.file === tree.root)
  const recordFor = new Map<PlacedSymbol, SymbolRecord>()
  for (const r of records) if (!recordFor.has(r.symbol) || r.sheetPath === "/") recordFor.set(r.symbol, r)

  const cache = new Map(root.libSymbols.map((s) => [s.name, s]))
  const lookup = (name: string) => cache.get(name)
  const components: ComponentInstance[] = []
  /** Pins of every component, by world point, for the no-connects and the checks. */
  const pinPoints: { c: ComponentInstance; pin: string; at: Pt }[] = []
  const missing: string[] = []
  const labels: NetLabel[] = []
  let powerPorts = 0

  /** S7: the flags a placed symbol has that are not KiCad's defaults. */
  function flagsProp(sym: PlacedSymbol): { flags?: SymbolFlags } {
    const flags: SymbolFlags = {}
    if (sym.dnp) flags.dnp = true
    if (!sym.inBom) flags.inBom = false
    if (!sym.onBoard) flags.onBoard = false
    if (sym.excludeFromSim) flags.excludeFromSim = true
    if (!sym.inPosFiles) flags.inPosFiles = false
    if (sym.fieldsAutoplaced) flags.fieldsAutoplaced = true
    return Object.keys(flags).length ? { flags } : {}
  }

  // ---------- what each placed symbol is: its drawing, its part, its unit ----------
  const drawings = new Map<string, { lib: ResolvedLibSymbol; drawing: SymbolDrawing; key: string } | null>()
  /** What a text of a symbol asks for that the editor draws its own way: a font, a line spacing, a link. */
  const textNotes = new Set<string>()
  const drawingOf = (sym: Pick<PlacedSymbol, "cacheKey">) => {
    const had = drawings.get(sym.cacheKey)
    if (had !== undefined) return had
    const base = lookup(sym.cacheKey)
    let out: { lib: ResolvedLibSymbol; drawing: SymbolDrawing; key: string } | null = null
    if (!base) missing.push(sym.cacheKey)
    else {
      try {
        const lib = resolveLibSymbol(base, lookup)
        const { drawing, problems, notes } = drawingFromLib(lib)
        for (const n of notes) textNotes.add(n)
        const power = lib.power ? powerPin(lib) : null
        // A power symbol names the net of its power-input pins by its Value. One that is one pin (`power:GND`) is a power port; one with other pins, power inputs among them, is not something the editor holds. A flag (`PWR_FLAG`: a power output) is an ordinary part.
        if (lib.power && !power && lib.pins.some((p) => p.type === "power_in")) problems.push("a power symbol with other pins than one power input")
        if (problems.length) {
          report.entries.push({ code: "symbol-not-held", severity: "refused", object: `the symbol ${sym.cacheKey}`, why: `The editor cannot hold ${[...new Set(problems)].join(", ")} of this symbol exactly, so the schematic is not imported.` })
        } else out = { lib, drawing, key: drawingKey(drawing) }
      } catch (e) {
        lose("S12", `a symbol whose cache entry cannot be read (${e instanceof Error ? e.message : String(e)})`)
      }
    }
    drawings.set(sym.cacheKey, out)
    return out
  }
  interface Placed {
    sym: PlacedSymbol
    lib: ResolvedLibSymbol
    drawing: SymbolDrawing
    ref: string
    unit: number
    angle: number
    onBoard: ReturnType<NonNullable<SchematicBuildOptions["footprintFor"]>>
    power: LibPin | null
  }
  /** The places of the pins of the type "no connect" (KiCad 5 joins what is drawn to such a pin). */
  const ncPinKeys = new Set<string>()
  const placed: Placed[] = []
  for (const sym of root.symbols) {
    const d = drawingOf(sym)
    if (!d) continue
    const record = recordFor.get(sym)
    if (record) recordOf.set(sym, record)
    const angle = ((Math.round(sym.angle) % 360) + 360) % 360
    if (angle % 90 !== 0) {
      lose("S5", "a symbol turned by other than a quarter turn")
      continue
    }
    placed.push({
      sym,
      lib: d.lib,
      drawing: d.drawing,
      ref: (record?.reference || referenceOf(sym) || "?").trim(),
      // The unit is the instance's: a symbol whose own `(unit N)` says 1 may be used as unit 3 (connection_graph.cpp: `SetUnit( GetUnitSelection( &sheet ) )`).
      unit: record?.unit ?? sym.unit,
      angle,
      onBoard: options.footprintFor?.(sym),
      power: d.lib.power ? powerPin(d.lib) : null,
    })
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
    const full: CustomPartSpec = { ...spec, id: customPartId(spec), source: { pins: "import", land: "import", imported: { file: fileName, libId: p.sym.libId } } }
    symbols[key] = p.drawing
    if (!specs.has(full.id)) specs.set(full.id, full)
    return isPrimary ? full.id : unitTwinId(full.id)
  }

  for (const p of placed) {
    const { sym, lib, ref, unit, angle } = p
    const partId = partFor(p)
    const mirror: Mirror | undefined = sym.mirror === "x" || sym.mirror === "y" ? sym.mirror : undefined
    const record = recordOf.get(sym)
    const isPrimary = (primaryOf.get(p) ?? p) === p
    const onBoard = isPrimary ? p.onBoard : undefined
    const pinsHere = pinsOfUnit(lib, unit, sym.bodyStyle)

    // ---------- a power symbol: its net is its Value ----------
    if (p.power) {
      const pp = p.power
      // Before stamp 20230221 a global power symbol with a hidden pin is named by that pin; from it the Value is the net, and an empty one stays empty.
      // In a KiCad 5 schematic the pin names the net whether it is shown or not (`LIB_PIN::IsPowerConnection`: a power input pin of a power symbol, or a hidden one).
      const legacy = root.legacy ? true : root.version !== null && root.version < MODERN_POWER_SYMBOLS_FROM && lib.power === "global" && pp.hidden
      const net = (legacy ? pp.name : record?.value || valueOf(sym)).trim()
      const c: ComponentInstance = {
        id: uid("c"),
        partId,
        ref,
        props: { net },
        ...flagsProp(sym),
        footprint: "",
        sch: { x: X(sym.at.x), y: Y(sym.at.y), rot: angle as Rotation, ...(mirror ? { mirror } : {}) },
        pcb: { x: 0, y: 0, rot: 0, side: "top", placed: false },
      }
      const fields = fieldsOf(sym)
      if (fields) c.fields = fields
      components.push(c)
      bySymbol.set(sym, c)
      powerPorts++
      pinPoints.push({ c, pin: pp.number, at: toSheet(pp.at, sym) })
      continue
    }

    // ---------- any other symbol: a placement of its part ----------
    const c: ComponentInstance = {
      id: uid("c"),
      partId,
      ref,
      props: {},
      ...flagsProp(sym),
      footprint: onBoard?.land ?? "",
      sch: { x: X(sym.at.x), y: Y(sym.at.y), rot: angle as Rotation, ...(mirror ? { mirror } : {}) },
      pcb: onBoard?.pcb ?? { x: 0, y: 0, rot: 0, side: "top", placed: false },
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
    bySymbol.set(sym, c)
    for (const q of pinsHere) {
      const at = toSheet(q.at, sym)
      for (const number of expandPinNumber(q.number)) pinPoints.push({ c, pin: number, at })
      if (q.type === "no_connect") ncPinKeys.add(keyOf(at))
    }
  }

  // The cache's other symbols (one that nothing places, a base another symbol extends) are kept as stored drawings, so the project keeps every drawing the file has. They are not listed as parts: a part nobody placed would crowd the library panel.
  const unplaced: string[] = []
  for (const lib of root.libSymbols) {
    if (drawings.has(lib.name)) continue
    const d = drawingOf({ cacheKey: lib.name })
    if (!d) continue
    const { key } = specFromSymbol(d.lib, d.drawing, "")
    symbols[key] = d.drawing
    unplaced.push(lib.name)
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

  if (missing.length) {
    const names = [...new Set(missing)]
    report.entries.push({
      code: "symbol-not-in-cache",
      severity: "refused",
      object: `${missing.length} symbol${missing.length > 1 ? "s" : ""} (${names.slice(0, 4).join(", ")}${names.length > 4 ? ", ..." : ""})`,
      why: "The schematic's own library cache has no drawing for these. A symbol library of the project or the parts database would have, but those are not read yet (S12).",
      count: missing.length,
    })
    lose("S12", "a symbol with no drawing in the schematic's cache")
  }

  // ---------- no-connects: the pins that lie on a flag ----------
  const flags = new Set(root.noConnects.map((n) => keyOf(n.at)))
  const pinPlaces = new Set(pinPoints.map((p) => keyOf(p.at)))
  const ncOf = new Map<string, Set<string>>()
  for (const pp of pinPoints) {
    if (!flags.has(keyOf(pp.at))) continue
    const set = ncOf.get(pp.c.id) ?? new Set()
    set.add(pp.pin)
    ncOf.set(pp.c.id, set)
  }
  for (const c of components) if (ncOf.has(c.id)) c.nc = [...ncOf.get(c.id)!]

  // A pin of the type "no connect" is on no net in the editor (as in KiCad 6 and later). KiCad 5 joins it to whatever is drawn to it: a wire end, a label, a junction, another pin.
  if (root.legacy && ncPinKeys.size) {
    const here = new Map<string, number>()
    for (const pp of pinPoints) here.set(keyOf(pp.at), (here.get(keyOf(pp.at)) ?? 0) + 1)
    const drawn = new Set<string>()
    for (const w of root.wires) if (w.pts.length >= 2) for (const p of [w.pts[0], w.pts[w.pts.length - 1]]) drawn.add(keyOf(p))
    for (const l of root.labels) drawn.add(keyOf(l.at))
    for (const j of root.junctions) drawn.add(keyOf(j.at))
    for (const k of ncPinKeys) {
      if (drawn.has(k) || (here.get(k) ?? 0) > 1) {
        lose("S11", "a pin of the type no connect with a wire, label, junction or other pin at it, which KiCad 5 joins to the net and KiCad 6 and later leave out")
        break
      }
    }
  }

  // A symbol taken from one of the project's libraries and not from the schematic's own cache is not the symbol the wires were drawn to: libraries change. If a wire
  // ends near such a symbol, where it has no pin and where nothing else is, the library has moved its pins since: the project is refused as inexact, naming the symbol.
  if (root.legacy) {
    const fromLibrary = new Set(root.legacy.symbolSources.filter((x) => x.from === "library").map((x) => x.libId))
    if (fromLibrary.size) {
      const at = new Map<string, number>()
      const bump = (p: Pt) => at.set(keyOf(p), (at.get(keyOf(p)) ?? 0) + 1)
      for (const w of root.wires) if (w.pts.length >= 2) for (const e of [w.pts[0], w.pts[w.pts.length - 1]]) bump(e)
      for (const pp of pinPoints) bump(pp.at)
      for (const l of root.labels) bump(l.at)
      for (const j of root.junctions) bump(j.at)
      for (const n of root.noConnects) bump(n.at)
      const drifted: string[] = []
      for (const [sym, c] of bySymbol) {
        if (!fromLibrary.has(sym.libId)) continue
        const mine = pinPoints.filter((p) => p.c === c)
        if (!mine.length) continue
        const reach = 2.54
        const x0 = Math.min(...mine.map((p) => p.at.x)) - reach
        const x1 = Math.max(...mine.map((p) => p.at.x)) + reach
        const y0 = Math.min(...mine.map((p) => p.at.y)) - reach
        const y1 = Math.max(...mine.map((p) => p.at.y)) + reach
        const own = new Set(mine.map((p) => keyOf(p.at)))
        const dangling = root.wires.some((w) => w.pts.length >= 2 && [w.pts[0], w.pts[w.pts.length - 1]].some((e) => e.x >= x0 && e.x <= x1 && e.y >= y0 && e.y <= y1 && !own.has(keyOf(e)) && at.get(keyOf(e)) === 1))
        if (dangling) drifted.push(`${c.ref} (${sym.libId})`)
      }
      if (drifted.length) {
        report.entries.push({
          code: "symbol-may-have-changed",
          severity: "refused",
          object: `${drifted.length} symbol${drifted.length > 1 ? "s" : ""} (${drifted.slice(0, 4).join(", ")}${drifted.length > 4 ? ", ..." : ""})`,
          why: "These symbols come from a library of the project, not from the schematic's own cache, and a wire ends near each where it has no pin: the library has drawn the symbol differently since the schematic was drawn, so its nets would not be the ones in the file. Nothing is guessed.",
          count: drifted.length,
        })
      }
    }
  }

  // ---------- wires, cut at the junctions on their bodies ----------
  const junctionPts = root.junctions.map((j) => j.at)
  const junctionKeys = new Set(junctionPts.map(keyOf))
  const wireStrokes = root.wires.filter((w) => w.pts.length >= 2).map((w) => strokeOf(w.node))
  const wiresIn = root.wires.filter((w) => w.pts.length >= 2).map((w) => ({ a: w.pts[0], b: w.pts[w.pts.length - 1] }))
  const grid = new SegGrid(wiresIn)
  const wires: Wire[] = []
  const editorPt = (p: Pt): Vec2 => ({ x: PX(p.x), y: PY(p.y) })
  const seenPoints = new Map<string, string>()
  const trackPoint = (p: Pt) => {
    // Two KiCad points that the editor cannot tell apart would join what KiCad keeps apart.
    const e = `${PX(p.x).toFixed(3)},${PY(p.y).toFixed(3)}`
    const k = keyOf(p)
    const had = seenPoints.get(e)
    if (had !== undefined && had !== k) lose("S11", "two points closer together than the editor can tell apart")
    seenPoints.set(e, k)
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
          if (o !== w && strictlyInside(q(end.x), q(end.y), q(o.a.x), q(o.a.y), q(o.b.x), q(o.b.y))) lose("S11", "a wire end that touches another wire's side with no junction")
        }
      }
      if (nearMiss(end, w)) lose("S11", "a wire end a hair's breadth from another wire, which the editor joins and KiCad does not")
    }
    const along = (p: Pt) => (p.x - w.a.x) * (w.b.x - w.a.x) + (p.y - w.a.y) * (w.b.y - w.a.y)
    cuts.sort((m, n) => along(m) - along(n))
    const chain = [w.a, ...cuts.filter((c, i) => i === 0 || keyOf(c) !== keyOf(cuts[i - 1])), w.b]
    for (let i = 0; i < chain.length - 1; i++) {
      if (keyOf(chain[i]) === keyOf(chain[i + 1])) continue
      wires.push({ id: uid("w"), points: [editorPt(chain[i]), editorPt(chain[i + 1])], ...(wireStrokes[wi] ? { look: wireStrokes[wi] } : {}) })
    }
    for (const p of chain) trackPoint(p)
  })

  // ---------- labels ----------
  const pinAt = new Set(pinPoints.map((p) => keyOf(p.at)))
  const stamp = root.version
  const SHAPES = new Set(["input", "output", "bidirectional", "tri_state", "passive"])
  for (const l of root.labels) {
    // A hierarchical label or a directive label has nothing the editor can hold: they are S1 and S8, never dropped silently.
    if (l.kind === "hierarchical") {
      lose("S1", "a hierarchical label, which joins the sheet to its parent")
      continue
    }
    if (l.kind === "directive") {
      lose("S8", "a directive label")
      continue
    }
    const label = labelOf(l)
    if (!label) continue
    labels.push(label)
    trackPoint(l.at)
    // A label on a pin is KiCad's alone with the pin, and skips a wire that only passes there (sch_label.cpp); the editor joins the wire.
    // KiCad 5 does not: a label joins the pin at its point and every wire it lies on (`NETLIST_OBJECT_LIST::segmentToPointConnect`), which is what the editor does.
    if (!root.legacy && pinAt.has(keyOf(l.at)) && !junctionKeys.has(keyOf(l.at))) {
      for (const i of grid.near(l.at)) {
        const o = wiresIn[i]
        if (strictlyInside(q(l.at.x), q(l.at.y), q(o.a.x), q(o.a.y), q(o.b.x), q(o.b.y))) lose("S11", "a label on a pin that lies on a wire's side, which the editor joins to the wire and KiCad does not")
      }
    }
    if (nearMiss(l.at)) lose("S11", "a label a hair's breadth from a wire, which the editor joins and KiCad does not")
  }

  /** A label with the kind, shape, size, style and fields its file gave it. */
  function labelOf(l: SchLabel): NetLabel | null {
    const turn = ((Math.round(l.angle) % 360) + 360) % 360
    if (turn % 90 !== 0 || Math.abs(l.angle - Math.round(l.angle)) > 1e-9) {
      report.entries.push({ code: "label-not-held", severity: "refused", object: `the label ${l.text}`, why: "It is turned by other than a quarter turn, which the editor cannot draw." })
      return null
    }
    const kind = l.kind === "global" ? "global" : "local"
    if (kind === "global" && (l.shape === null || !SHAPES.has(l.shape))) {
      report.entries.push({ code: "label-not-held", severity: "refused", object: `the global label ${l.text}`, why: `Its shape ${l.shape === null ? "is missing" : `"${l.shape}" is not one KiCad has`}.` })
      return null
    }
    const rot = turn as Rotation
    const out: NetLabel = { id: uid("l"), name: l.text, x: PX(l.at.x), y: PY(l.at.y), rot, kind }
    if (kind === "global") out.shape = l.shape as LabelShape
    // Size, weight, colour and a justification other than the one its turn gives.
    const look = textLookOf(l.node, textNotes)
    if (look) {
      const j = labelJustify({ rot, kind, look: undefined })
      if (look.h === j.h) delete look.h
      if (look.v === j.v) delete look.v
      if (Object.keys(look).length) out.look = look
    }
    const props = readProps(l.node, stamp)
    if (props.length) out.fields = labelFields(l, props, textNotes)
    if (l.node.some((c) => Array.isArray(c) && c[0] === "fields_autoplaced" && (c[1] === undefined || c[1] === "yes")) || l.node.includes("fields_autoplaced")) out.fieldsAutoplaced = true
    return out
  }
  for (const pp of pinPoints) trackPoint(pp.at)

  // ---------- groups: a block of the symbols in each ----------
  const blocks: SchematicBlock[] = []
  const bySymbolUuid = new Map([...bySymbol].map(([s, c]) => [s.uuid, c]))
  for (const g of root.groups) {
    const members = g.members.map((m) => bySymbolUuid.get(m)).filter((c): c is ComponentInstance => !!c && !blocks.some((b) => b.components.includes(c.id)))
    const others = g.members.length - g.members.filter((m) => bySymbolUuid.has(m)).length
    if (members.length) blocks.push({ id: uid("b"), name: g.name || "Group", components: members.map((c) => c.id), ...(g.node.some((c) => Array.isArray(c) && c[0] === "locked" && (c[1] === undefined || c[1] === "yes")) || g.node.includes("locked") ? { locked: true as const } : {}) })
    if (others > 0) {
      report.entries.push({ code: "group-member-not-in-block", severity: "not-brought", object: `${others} member${others > 1 ? "s" : ""} of the group ${g.name ? `"${g.name}"` : "(no name)"}`, why: "A block holds symbols; the wires and other items of a group stay where they are but are not in its block.", count: others })
    }
  }

  const version = root.legacy ? `EESchema Schematic File Version ${root.legacy.version}` : `${root.generatorVersion ? `KiCad ${root.generatorVersion}, ` : ""}${root.version === null ? "no version stamp" : `file version ${root.version}`}`
  const properties = [
    { key: "Imported from", value: options.source ?? `KiCad ${root.generatorVersion ?? ERA_NAME[root.era]}` },
    { key: "KiCad file version", value: version },
    ...root.titleBlock.filter((t) => !(options.name === undefined && t.key === "Title" && title && title.trim())),
  ]
  const sheet = readSheetItems(root)
  for (const n of sheet.notes) textNotes.add(n)
  for (const why of sheet.problems) {
    report.entries.push({ code: "item-not-held", severity: "refused", object: "something on the sheet", why: `${why[0].toUpperCase()}${why.slice(1)}, which the editor cannot draw.` })
  }
  if (textNotes.size) {
    report.entries.push({ code: "text-style-not-brought", severity: "not-brought", object: "the texts of symbols", why: `Some texts of the symbols ask for ${[...textNotes].join(", ")}. The editor draws every text in its own font: the size, weight, colour and justification are kept.` })
  }
  project = {
    ...project,
    components,
    wires,
    labels,
    netNames: root.version !== null && root.version <= 20211123 ? ("kicad6" as const) : ("kicad" as const),
    ...(blocks.length ? { blocks } : {}),
    properties,
    ...(specs.size ? { parts: [...specs.values()] } : {}),
    ...(Object.keys(symbols).length ? { symbols } : {}),
  }
  // The parts are in memory from here: the checks below read them as the editor does.
  for (const spec of specs.values()) if (!isRegistered(spec.id)) registered.push(spec.id)
  registerProjectParts(project)
  checkPinPlaces(project, pinPoints, lose)
  // Junction dots of their own size or colour, and ones where the editor would draw none, and no-connect flags that are not on a pin, are items of the sheet.
  const extra = junctionsAndFlags(project, root, pinPlaces, lose)
  const all: SheetItem[] = [...sheet.items, ...extra]
  if (all.length) project = { ...project, items: all }
  reportSplitPads(project, report)
  return { project, lossy, bySymbol, recordOf, registered, stats: { components: components.length, wires: wires.length, labels: labels.length, powerPorts } }
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
function junctionsAndFlags(project: Project, root: KicadSchematic, flags: Set<string>, lose: (ext: string, why: string) => void): SheetItem[] {
  void lose
  const out: SheetItem[] = []
  const dots = new Set(computeConnectivity(project).junctions.map((j) => `${j.x.toFixed(3)},${j.y.toFixed(3)}`))
  for (const j of root.junctions) {
    const diameter = numAt(kid(j.node, "diameter"), 1, 0)
    const color = colorOf(kid(j.node, "color"))
    const x = PX(j.at.x)
    const y = PY(j.at.y)
    const own = diameter > 0 || !!color
    if (!own && dots.has(`${x.toFixed(3)},${y.toFixed(3)}`)) continue
    out.push({ id: uid("n"), kind: "junction", x, y, ...(diameter > 0 ? { diameter: round(diameter / MM_PER_UNIT, 6) } : {}), ...(color ? { color } : {}) })
  }
  const pinKeys = flags
  for (const n of root.noConnects) {
    if (pinKeys.has(keyOf(n.at))) continue
    out.push({ id: uid("n"), kind: "noconnect", x: PX(n.at.x), y: PY(n.at.y) })
  }
  return out
}

/** Every pin the editor draws is where KiCad has it, to the editor's own rounding: a pin that is off is a net that could come out wrong. */
function checkPinPlaces(project: Project, pinPoints: { c: ComponentInstance; pin: string; at: Pt }[], lose: (ext: string, why: string) => void) {
  const byId = new Map(project.components.map((c) => [c.id, c]))
  // A number that two pins share is already S5; which of them the editor draws is not a place to check.
  const seen = new Map<string, number>()
  for (const pp of pinPoints) seen.set(`${pp.c.id}:${pp.pin}`, (seen.get(`${pp.c.id}:${pp.pin}`) ?? 0) + 1)
  for (const pp of pinPoints) {
    if ((seen.get(`${pp.c.id}:${pp.pin}`) ?? 0) > 1) continue
    const c = byId.get(pp.c.id)!
    const part = findPart(c.partId)
    const world = schematicPins(c, part).find((p) => p.pin === pp.pin)
    if (!world) continue
    if (Math.abs(world.pos.x - PX(pp.at.x)) > 1e-9 || Math.abs(world.pos.y - PY(pp.at.y)) > 1e-9) {
      lose("S11", "a pin that the editor's rounding would put off its wire")
      return
    }
  }
}
