import { round } from "../../../lib/geometry"
import { uid } from "../../../lib/id"
import { computeConnectivity } from "../../connectivity"
import { schematicPins } from "../../instances"
import { findPart, isRegistered, registerPart, unregisterPart } from "../../library"
import { createProject } from "../../ops"
import type { ComponentInstance, NetLabel, PartDef, Project, Rotation, SchematicBlock, Vec2, Wire } from "../../types"
import type { ImportReport } from "../board/report"
import { symbolRecords, type SymbolRecord } from "./link"
import type { Need } from "./needs"
import { MM_PER_UNIT, expandPinNumber, partFromSymbol, pinsOfUnit, portDir, resolveLibSymbol, toSheet } from "./symbols"
import type { SchematicTree } from "./tree"
import type { KicadSchematic, LibPin, LibSymbol, PlacedSymbol, Pt } from "./types"

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
//   - a pin of the type "no connect" is on no net whatever is drawn to it: its port is left out;
//   - a hidden power-input pin joins the global net of its name: the editor has no such pin (S5);
//   - the names KiCad gives nets (`/NAME`, `Net-(R1-Pad2)`, the power symbol over the label) are not
//     the editor's (S2).

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
  /** The extensions that are built. With S5 a hidden power-input pin is carried by a label of its name on the pin (for measurement: it is net-equal, and it draws what KiCad does not). */
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
const ERA_NAME: Record<KicadSchematic["era"], string> = { "pre6-nightly": "5.99 (a development build)", kicad6: "6", kicad7: "7", kicad8: "8", kicad9: "9", kicad10: "10", "kicad11-dev": "11 (a development build)", unknown: "(version not given)" }

const referenceOf = (s: PlacedSymbol) => s.props.find((p) => p.name === "Reference")?.value ?? ""
const valueOf = (s: PlacedSymbol) => s.props.find((p) => p.name === "Value")?.value ?? ""

/** Modern power symbols (stamp 20230221 on): the editable Value is the net (sch_file_versions.h). Before it a global power symbol is named by its hidden power pin (`FixLegacyPowerSymbolMismatches`, sch_screen.cpp). */
export const MODERN_POWER_SYMBOLS_FROM = 20230221

const DIRS = ["right", "up", "left", "down"] as const
type Dir = (typeof DIRS)[number]

/** The direction a wire leaves a pin once the symbol is turned and mirrored. */
function worldDir(dir: Dir, sym: Pick<PlacedSymbol, "angle" | "mirror">): Dir {
  const turns = ((Math.round(sym.angle / 90) % 4) + 4) % 4
  let d = DIRS[(DIRS.indexOf(dir) + turns) % 4]
  if (sym.mirror === "x") d = d === "up" ? "down" : d === "down" ? "up" : d
  else if (sym.mirror === "y") d = d === "left" ? "right" : d === "right" ? "left" : d
  return d
}

const rotate = (p: Vec2, rot: Rotation): Vec2 => (rot === 0 ? p : rot === 90 ? { x: -p.y, y: p.x } : rot === 180 ? { x: -p.x, y: -p.y } : { x: p.y, y: -p.x })

/** The editor's own power ports: their one pin, and the way a wire leaves it. */
const POWER_PARTS = { power: { id: "power", port: { x: 0, y: -0.2 }, dir: "down" as Dir }, ground: { id: "ground", port: { x: 0, y: 0.3 }, dir: "up" as Dir } }

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
  const built = options.built ?? new Set<string>()
  const lossy: Need[] = []
  const lose = (ext: string, why: string) => {
    if (!lossy.some((n) => n.ext === ext && n.why === why)) lossy.push({ ext, why, source: "importer" })
  }
  const root = tree.files.get(tree.root)!.schematic
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
  /** Labels the build adds for a hidden power-input pin: a power name, not a label of the user's. */
  const emulated = new Set<string>()
  const powerNames = new Set<string>()
  const localPowerNames = new Set<string>()
  const globalLabelNames = new Set<string>()
  let powerPorts = 0

  for (const sym of root.symbols) {
    const base = lookup(sym.cacheKey)
    if (!base) {
      missing.push(sym.cacheKey)
      continue
    }
    let lib: LibSymbol
    try {
      lib = resolveLibSymbol(base, lookup)
    } catch (e) {
      lose("S12", `a symbol whose cache entry cannot be read (${e instanceof Error ? e.message : String(e)})`)
      continue
    }
    const record = recordFor.get(sym)
    if (record) recordOf.set(sym, record)
    const ref = (record?.reference || referenceOf(sym) || "?").trim()
    // The unit is the instance's: a symbol whose own `(unit N)` says 1 may be used as unit 3 (connection_graph.cpp: `SetUnit( GetUnitSelection( &sheet ) )`).
    const unit = record?.unit ?? sym.unit
    const angle = ((Math.round(sym.angle) % 360) + 360) % 360
    if (angle % 90 !== 0) {
      lose("S5", "a symbol turned by other than a quarter turn")
      continue
    }
    const pinsHere = pinsOfUnit(lib, unit, sym.bodyStyle)

    // ---------- a power symbol: one of the editor's own power ports, turned so its pin is where KiCad's is ----------
    const pp = powerPin(lib)
    if (pp) {
      const pinAt = toSheet(pp.at, sym)
      const dir = worldDir(portDir(pp.angle), sym)
      const kind = pp.angle === 270 ? POWER_PARTS.ground : POWER_PARTS.power
      const rot = ((((DIRS.indexOf(dir) - DIRS.indexOf(kind.dir)) % 4) + 4) % 4) * 90 as Rotation
      const off = rotate(kind.port, rot)
      // Before stamp 20230221 a global power symbol with a hidden pin is named by that pin; from it the Value is the net, and an empty one stays empty.
      const legacy = root.version !== null && root.version < MODERN_POWER_SYMBOLS_FROM && lib.power === "global" && pp.hidden
      const net = (legacy ? pp.name : record?.value || valueOf(sym)).trim()
      if (net === "") lose("S2", "a power symbol with no name, which KiCad leaves a net with no name")
      ;(lib.power === "local" ? localPowerNames : powerNames).add(net)
      const c: ComponentInstance = {
        id: uid("c"),
        partId: kind.id,
        ref,
        props: { net },
        footprint: "",
        sch: { x: round(X(pinAt.x) - off.x, 4), y: round(Y(pinAt.y) - off.y, 4), rot },
        pcb: { x: 0, y: 0, rot: 0, side: "top", placed: false },
      }
      components.push(c)
      bySymbol.set(sym, c)
      powerPorts++
      pinPoints.push({ c, pin: "1", at: pinAt })
      continue
    }

    // ---------- any other symbol: a part made from its cached drawing ----------
    const numbers = pinsHere.flatMap((p) => expandPinNumber(p.number))
    if (new Set(numbers).size !== numbers.length) lose("S5", "pins that share a number: one pin to KiCad when they are jumpered, an error when not")
    if (pinsHere.some((p) => p.number.trim() === "")) lose("S5", "a pin with no number, which no pad can be paired with")
    const mirrored = sym.mirror !== ""
    const onBoard = options.footprintFor?.(sym)
    const part = partFromSymbol(lib, unit, sym.bodyStyle, mirrored ? { at: { x: 0, y: 0 }, angle: sym.angle, mirror: sym.mirror } : undefined, onBoard ? [onBoard.land] : [])
    // A pin of the type "no connect" is on no net, whatever is drawn to it: the editor gets no port for it.
    const nc = new Set(pinsHere.filter((p) => p.type === "no_connect").flatMap((p) => expandPinNumber(p.number)))
    const ported: PartDef = nc.size ? { ...part, id: `${part.id}n`, symbol: { ...part.symbol, ports: part.symbol.ports.filter((p) => !nc.has(p.pin)) } } : part
    if (!isRegistered(ported.id)) registered.push(ported.id)
    registerPart(ported)
    const c: ComponentInstance = {
      id: uid("c"),
      partId: ported.id,
      ref,
      props: {},
      footprint: onBoard?.land ?? "",
      sch: { x: X(sym.at.x), y: Y(sym.at.y), rot: (mirrored ? 0 : angle) as Rotation },
      pcb: onBoard?.pcb ?? { x: 0, y: 0, rot: 0, side: "top", placed: false },
    }
    // The instance's own value and footprint, where it has them, stand in place of the symbol's fields (KiCad 6 keeps the real ones there).
    for (const p of sym.props) {
      if (p.name === "Reference") continue
      const value = p.name === "Value" ? record?.value || p.value : p.name === "Footprint" ? record?.footprint || p.value : p.value
      if (p.name === "Value") c.props.value = value
      else if (value !== "") c.props[p.name] = value
    }
    components.push(c)
    bySymbol.set(sym, c)
    for (const p of pinsHere) {
      const at = toSheet(p.at, sym)
      for (const number of expandPinNumber(p.number)) pinPoints.push({ c, pin: number, at })
      // A hidden power-input pin is on the global net of its name. With S5 built the pin carries a label of that name.
      if (p.type === "power_in" && p.hidden) {
        if (built.has("S5") && p.name.trim() !== "") {
          const id = uid("l")
          emulated.add(id)
          powerNames.add(p.name.trim())
          labels.push({ id, name: p.name.trim(), x: PX(at.x), y: PY(at.y), rot: 0 })
        } else lose("S5", "a hidden power-input pin, which joins the global net of its name")
      }
    }
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
  const ncOf = new Map<string, Set<string>>()
  for (const pp of pinPoints) {
    if (!flags.has(keyOf(pp.at))) continue
    const set = ncOf.get(pp.c.id) ?? new Set()
    set.add(pp.pin)
    ncOf.set(pp.c.id, set)
  }
  for (const c of components) if (ncOf.has(c.id)) c.nc = [...ncOf.get(c.id)!]

  // ---------- wires, cut at the junctions on their bodies ----------
  const junctionPts = root.junctions.map((j) => j.at)
  const junctionKeys = new Set(junctionPts.map(keyOf))
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
      wires.push({ id: uid("w"), points: [editorPt(chain[i]), editorPt(chain[i + 1])] })
    }
    for (const p of chain) trackPoint(p)
  })

  // ---------- labels ----------
  const pinAt = new Set(pinPoints.map((p) => keyOf(p.at)))
  for (const l of root.labels) {
    // A global label joins the nets of its name on every sheet; on one sheet that is what the editor's label does, so with S2 built it is carried as a label.
    // A hierarchical label or a directive label has nothing the editor can hold: they are S1 and S8, never dropped silently.
    if (l.kind === "hierarchical") {
      lose("S1", "a hierarchical label, which joins the sheet to its parent")
      continue
    }
    if (l.kind === "directive") {
      lose("S8", "a directive label")
      continue
    }
    if (l.kind === "global" && !built.has("S2")) {
      lose("S2", "a global label, which joins the nets of its name on every sheet")
      continue
    }
    if (l.kind === "global") globalLabelNames.add(l.text.trim())
    labels.push({ id: uid("l"), name: l.text, x: PX(l.at.x), y: PY(l.at.y), rot: (((Math.round(l.angle) % 360) + 360) % 360) as Rotation })
    trackPoint(l.at)
    // A label on a pin is KiCad's alone with the pin, and skips a wire that only passes there (sch_label.cpp); the editor joins the wire.
    if (pinAt.has(keyOf(l.at)) && !junctionKeys.has(keyOf(l.at))) {
      for (const i of grid.near(l.at)) {
        const o = wiresIn[i]
        if (strictlyInside(q(l.at.x), q(l.at.y), q(o.a.x), q(o.a.y), q(o.b.x), q(o.b.y))) lose("S11", "a label on a pin that lies on a wire's side, which the editor joins to the wire and KiCad does not")
      }
    }
    if (nearMiss(l.at)) lose("S11", "a label a hair's breadth from a wire, which the editor joins and KiCad does not")
  }
  for (const pp of pinPoints) trackPoint(pp.at)

  // ---------- groups: a block of the symbols in each ----------
  const blocks: SchematicBlock[] = []
  const bySymbolUuid = new Map([...bySymbol].map(([s, c]) => [s.uuid, c]))
  for (const g of root.groups) {
    const members = g.members.map((m) => bySymbolUuid.get(m)).filter((c): c is ComponentInstance => !!c && !blocks.some((b) => b.components.includes(c.id)))
    const others = g.members.length - g.members.filter((m) => bySymbolUuid.has(m)).length
    if (members.length) blocks.push({ id: uid("b"), name: g.name || "Group", components: members.map((c) => c.id) })
    if (others > 0) {
      report.entries.push({ code: "group-member-not-in-block", severity: "not-brought", object: `${others} member${others > 1 ? "s" : ""} of the group ${g.name ? `"${g.name}"` : "(no name)"}`, why: "A block holds symbols; the wires and other items of a group stay where they are but are not in its block.", count: others })
    }
  }

  const version = `${root.generatorVersion ? `KiCad ${root.generatorVersion}, ` : ""}${root.version === null ? "no version stamp" : `file version ${root.version}`}`
  const properties = [
    { key: "Imported from", value: options.source ?? `KiCad ${root.generatorVersion ?? ERA_NAME[root.era]}` },
    { key: "KiCad file version", value: version },
    ...root.titleBlock.filter((t) => !(options.name === undefined && t.key === "Title" && title && title.trim())),
  ]
  project = { ...project, components, wires, labels, ...(blocks.length ? { blocks } : {}), properties }
  checkPinPlaces(project, pinPoints, lose)
  checkNetNames(project, components, { power: powerNames, localPower: localPowerNames, globalLabel: globalLabelNames, label: new Set(labels.filter((l) => !emulated.has(l.id)).map((l) => l.name.trim())) }, lose)
  return { project, lossy, bySymbol, recordOf, registered, stats: { components: components.length, wires: wires.length, labels: labels.length, powerPorts } }
}

/**
 * The names the editor gives the nets against the names KiCad does. A net that has a pin of a part
 * (a pad on a board) is checked: the editor names an unnamed net `Net-(R1-1)` where KiCad writes
 * `Net-(R1-Pad2)`, and a net named by a label by its text where KiCad adds the sheet's path
 * (`/NAME`); a power symbol's name is the same in both. Where one net has two names, KiCad takes
 * the one of the higher priority (a power symbol, then a local label: `CONNECTION_SUBGRAPH::PRIORITY`,
 * connection_graph.h) and, between names of one priority, the one that sorts first, as the editor does.
 * Every other name is S2, KiCad's own net names.
 */
function checkNetNames(project: Project, components: ComponentInstance[], kinds: { power: ReadonlySet<string>; localPower: ReadonlySet<string>; globalLabel: ReadonlySet<string>; label: ReadonlySet<string> }, lose: (ext: string, why: string) => void) {
  const { nets, pinNet, conflicts } = computeConnectivity(project)
  const power = new Set(components.filter((c) => findPart(c.partId)?.powerNet).map((c) => c.id))
  const pads = new Map<string, number>()
  for (const [key, id] of pinNet) {
    if (!power.has(key.slice(0, key.lastIndexOf(":")))) pads.set(id, (pads.get(id) ?? 0) + 1)
  }
  const conflictOf = new Map(conflicts.map((c) => [c.netId, c.names]))
  for (const net of nets) {
    if (!pads.get(net.id)) continue
    if (!net.named) {
      lose("S2", "a net with no name of its own, which KiCad names Net-(R1-Pad2) and the editor Net-(R1-2)")
      continue
    }
    const names = conflictOf.get(net.id) ?? [net.name]
    // KiCad's driver priority, lowest to highest: a local label, a local power symbol, a global power symbol, a global label.
    const rank = (n: string) => (kinds.globalLabel.has(n) ? 4 : kinds.power.has(n) ? 3 : kinds.localPower.has(n) ? 2 : 1)
    if (new Set(names.map(rank)).size > 1) {
      lose("S2", `a net with names of different priority (${names.slice(0, 3).join(" and ")}): KiCad takes the one of the higher priority (a global label, then a power symbol, then a local label), the editor the first by alphabet`)
    } else if (rank(names[0]) <= 2 && names.some((n) => kinds.label.has(n) || kinds.localPower.has(n))) {
      lose("S2", "a net named by a label or a local power symbol, which KiCad writes with its sheet's path (/NAME)")
    }
  }
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
