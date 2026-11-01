import { emptyBox, expandBox, normalizeAngle, round, snap, type Box } from "../../../lib/geometry"
import { uid } from "../../../lib/id"
import { computeConnectivity, pinKey, type SchematicConnectivity } from "../../connectivity"
import { customPartId, customPartProblems, digest, registerProjectParts } from "../../customParts"
import { runErc } from "../../erc"
import { labelBox } from "../../labels"
import { cleanFlags } from "../../partFlags"
import { derivedCopperNets } from "../../pcb"
import { pinStubPoint, schematicBounds, schematicPins } from "../../instances"
import { createProject } from "../../ops"
import { SCH_GRID } from "../../symbols"
import { pathsBox } from "../../shapes"
import type { BoardDimension, BoardGraphic, CopperLayer, BoardOutline, BoardText, ComponentInstance, CustomPartSpec, FootprintDef, ModelAssignment, NetLabel, PadDef, PartCategory, PartFlags, PcbGroup, PinDef, Project, ReferenceImage, Rotation, Trace, Vec2, Via, Wire, Zone } from "../../types"
import { kicadModel } from "../../models3d"
import { pinRole } from "../../supplier/roles"
import { cleanPinName } from "../symbol"
import { padRings } from "../../padGeom"
import { landPad, type PadIds } from "./pads"
import { defaultGraphicId } from "../../shapeCodec"
import { convertShape, convertTarget, courtyardBox, drawingBox, landShapes, type GraphicsContext } from "./graphics"
import { convertBoardText, convertPartTexts, landTextBox, type PartPlacement, type TextConversion } from "./texts"
import { convertDimension } from "./dimensions"
import { groupParents, newGroupStats, resolveGroups, type RawGroup } from "./groups"
import { convertGenerator, convertNetChains, viaDrilling } from "./build22"
import { convertImage, type KeptFile } from "./images"
import { defaultDimensionId, defaultGroupId, defaultImageId, defaultPartGroupId } from "../../dimCodec"
import { defaultTextId } from "../../textCodec"
import { textShown } from "../../texts"
import { flipShapeLayer } from "../../shapeLayers"
import { modelKey, planModels } from "./models"
import type { OutlineResult } from "./outline"
import type { ImportReport } from "./report"
import { decodeNetName, eraOf } from "./read"
import { importRulesX10 } from "./netClassImport"
import { convertPartZones, convertZones, reportPartZones, reportZones } from "./zones"
import { buildStack, layerMapOf, layersOfNames } from "./layers"
import { copperLayers, viaBetween } from "../../stack"
import type { KicadBoard, KicadFootprint, KicadVia } from "./types"
import type { List } from "./sexpr"
import { kid, kids, strAt } from "./sexpr"

export { KICAD_LIBRARY_RELEASE, stockModelId } from "./models"

// A KiCad board as an editor project. The editor is y up and KiCad y down, so every y is negated
// and a rotation keeps its visual sense. A footprint becomes a part with a land of its own
// (`Project.footprints`): the library's land, the same whichever side the footprint is on, and the
// difference between the sides is in the placement (see `landPad`). The nets, which the editor
// derives from a schematic, are drawn on a generated one: a label with the net's name on every
// connected pin, parts in a grid. The result is checked pad by pad against the file's nets before
// it is returned.

export interface BuildOptions {
  name?: string
  /** Kept as the project's "Imported from" property. */
  source?: string
  /**
   * Build a board that needs extensions that are not built, approximating what the model cannot
   * hold. For measurement and tests only: the importer never imports such a board.
   */
  allowLossy?: boolean
}

export interface BuildResult {
  project: Project
  /** The files the project names that the host keeps (reference images): the bytes, by the SHA-256 the project holds them by. */
  files: KeptFile[]
  /** What had to be approximated; always empty unless `allowLossy`. */
  lossy: string[]
  stats: { parts: number; lands: number; pins: number; nets: number; padsWithNet: number; copperNetMismatches: number }
  /**
   * The component each footprint of the board became, by the footprint's index in `board.footprints`: every footprint is a
   * part (a padless one too, a logo or a mounting hole), so there is one for each. A project import links a symbol to its
   * footprint by this, not by guessing from the reference and the place.
   */
  footprintComponents: Map<number, string>
}

const CATEGORY_BY_PREFIX: [RegExp, PartCategory][] = [
  [/^(J|P|CN|CON|USB|X)$/, "Connectors"],
  [/^(Q|M|T)$/, "Transistors"],
  [/^(D|LED|TVS|Z)$/, "Diodes"],
  [/^(SW|S|K|BTN|RLY|BZ)$/, "Electromechanical"],
  [/^(R|C|L|F|FB|Y|XTAL|TP)$/, "Passives"],
]

/** The letters a footprint with no reference is numbered under, read from its footprint as KiCad's libraries name them: `H` for a mounting hole, not the `U` of a chip. */
function unnamedPrefix(footprint: string, pads: number): string {
  const name = footprint.toLowerCase()
  if (/mounting.?hole|^hole/.test(name)) return "H"
  if (name.includes("fiducial")) return "FID"
  if (/test.?point/.test(name)) return "TP"
  // A logo or a drawing: KiCad's own graphics are `G***`.
  if (!pads) return "G"
  return "U"
}

const slug = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 24) || "land"

const frameTop = (p: { x: number; y: number }): Vec2 => ({ x: p.x, y: -p.y })

export { landPad } from "./pads"

/** The bounds of a land's copper, grown by `margin`. */
function padBounds(pads: PadDef[], margin: number): Box {
  const b = emptyBox()
  for (const p of pads) {
    // A pad turned by a turn of its own, or a custom one, reaches where its outline does; any other, as it always has.
    const ring = p.rot || p.custom || p.chamfer ? padRings(p).flat() : null
    for (const q of ring ?? p.points ?? [
      { x: p.x - p.width / 2, y: p.y - p.height / 2 },
      { x: p.x + p.width / 2, y: p.y + p.height / 2 },
    ]) {
      expandBox(b, q)
    }
  }
  return { minX: round(b.minX - margin), minY: round(b.minY - margin), maxX: round(b.maxX + margin), maxY: round(b.maxY + margin) }
}

/**
 * X1: the board's stack, and the finish and outer copper weight where the stackup's say one of the editor's own: KiCad's `ENIG`, `HAL SnPb`, `HAL lead-free` and
 * `OSP`, and an outer copper of 35 or 70 micrometres. What does not fit stays in the stack as the file wrote it (`BoardStack.finish`, the rows).
 */
function stackFields(board: KicadBoard): Pick<Project["board"], "stack" | "finish" | "copperWeight"> {
  const stack = buildStack(board)
  if (!stack) return {}
  const out: Pick<Project["board"], "stack" | "finish" | "copperWeight"> = { stack }
  const finish = stack.finish === undefined ? undefined : FINISHES[stack.finish.trim().toLowerCase()]
  if (finish) out.finish = finish
  const outer = stack.rows?.find((r) => r.name === "F.Cu")?.thickness
  if (outer !== undefined) {
    if (Math.abs(outer - 0.035) < 0.0011) out.copperWeight = 1
    else if (Math.abs(outer - 0.07) < 0.0011) out.copperWeight = 2
  }
  return out
}

/** KiCad's names for the finishes the editor has (the board setup's list), as lower case. */
const FINISHES: Record<string, NonNullable<Project["board"]["finish"]>> = { enig: "enig", "hal snpb": "hasl", "hal lead-free": "lf-hasl", osp: "osp" }

/** Natural order for references: R2 before R10. */
const natural = new Intl.Collator("en", { numeric: true, sensitivity: "base" })

/** A pin type of KiCad's schematic symbols as the editor's coarse role (the mapping the library import uses: `kindOf` in `kicad/convert.ts`), or undefined for one that says nothing. */
export function pinKindOf(pintype: string, name: string): PinDef["kind"] | "unknown" {
  const types = pintype.split("+")
  if (types.includes("no_connect")) return "nc"
  switch (types[0]) {
    case "input":
      return "input"
    case "output":
    case "tri_state":
    case "open_collector":
    case "open_emitter":
      return "output"
    case "bidirectional":
      return "io"
    case "passive":
      return "passive"
    case "power_in":
    case "power_out":
      return pinRole(name) === "ground" ? "ground" : "power"
    case "free":
    case "unspecified":
      return undefined
    default:
      return "unknown"
  }
}

/**
 * What the editor's role does to a KiCad pin type that it does not keep: null when the role says the
 * same, else a few words (`tri_state as output`). The roles are seven (input, output, io, passive,
 * power, ground, nc), so these are folded: tri-state and open collector or emitter pins are outputs,
 * a power output is a power pin, and a pin that says nothing (free, unspecified) has no role.
 */
export function pinFold(pintype: string): string | null {
  const types = pintype.split("+")
  if (types.includes("no_connect")) return types.length > 1 ? `${pintype} as nc` : null
  switch (types[0]) {
    case "tri_state":
    case "open_collector":
    case "open_emitter":
      return `${pintype} as output`
    case "power_out":
      return `${pintype} as power`
    case "free":
    case "unspecified":
      return `${pintype} as no role`
    default:
      return types.length > 1 ? `${pintype} as ${types[0]}` : null
  }
}

/** The flags a footprint's attributes set, and its net tie and jumper groups. */
export function flagsOf(fp: KicadFootprint): PartFlags | undefined {
  const has = (a: string) => fp.attr.includes(a)
  return cleanFlags({
    mount: has("smd") ? "smd" : fp.throughHole ? "through_hole" : undefined,
    virtual: has("virtual"),
    excludeFromBom: has("exclude_from_bom"),
    excludeFromPos: has("exclude_from_pos_files"),
    boardOnly: has("board_only"),
    dnp: has("dnp"),
    allowMissingCourtyard: has("allow_missing_courtyard"),
    allowMaskBridges: has("allow_soldermask_bridges"),
    jumperDuplicates: fp.jumperDuplicates,
    netTies: fp.netTies,
    jumperGroups: fp.jumperGroups,
  })
}

/** The part's pins, and the notes about them. */
interface PinFacts {
  name: string
  kind: PinDef["kind"]
}

/** The pin each pad of a footprint is on, and the part's pins. */
interface PinPlan {
  /** Per pad, by its place in the footprint: the pin it is on (null for none) and the number the land keeps when it is not the pin's. */
  ids: PadIds[]
  pins: { pin: string; name: string; kind: PinDef["kind"]; fold: string | null }[]
}

/**
 * The pins of a part made from a footprint. Pads of one number that agree on net, name and type are one pin. Pads of one number that
 * differ in any of them each get a pin of their own, named with the number and `.2`, `.3` (the first keeps the number), so the net each
 * pad is on is kept; the land keeps the file's number on each (`PadDef.number`) for the KiCad writer. A pad with no number that carries a net
 * has a pin of its own (`_1`, `_2`) and an empty number; so does a non-plated hole that carries one, whose number KiCad clears (`CanHaveNumber`,
 * parser `:6403`). A pad with no number and no net, and a hole with no net, has no pin.
 */
export function planPins(fp: KicadFootprint, lose: (what: string) => void): PinPlan {
  const taken = new Set(fp.pads.map((p) => p.number).filter(Boolean))
  const made = new Set<string>()
  const byKey = new Map<string, string>()
  const firstOfNumber = new Set<string>()
  const ids: PadIds[] = []
  const pins: PinPlan["pins"] = []
  let synthetic = 0
  const fresh = (base: string) => {
    let k = 2
    while (taken.has(`${base}.${k}`) || made.has(`${base}.${k}`)) k++
    made.add(`${base}.${k}`)
    return `${base}.${k}`
  }
  for (const p of fp.pads) {
    const numbered = p.number !== "" && p.type !== "np_thru_hole"
    if (!numbered && !p.netRaw) {
      ids.push({ pin: null })
      continue
    }
    const key = `${numbered ? p.number : ""}\n${p.netRaw ?? ""}\n${p.pinFunction ?? ""}\n${p.pinType ?? ""}`
    const had = byKey.get(key)
    if (had !== undefined) {
      ids.push({ pin: had, ...(numbered && p.number !== had ? { number: p.number } : numbered ? {} : { number: "" }) })
      continue
    }
    let pin: string
    if (numbered) {
      if (!firstOfNumber.has(p.number)) {
        firstOfNumber.add(p.number)
        pin = p.number
      } else pin = fresh(p.number)
    } else {
      do pin = `_${++synthetic}`
      while (taken.has(pin) || made.has(pin))
      made.add(pin)
    }
    byKey.set(key, pin)
    ids.push({ pin, ...(numbered ? (p.number !== pin ? { number: p.number } : {}) : { number: "" }) })
    const name = cleanPinName(p.pinFunction ?? "", pin)
    const found = p.pinType === undefined ? undefined : pinKindOf(p.pinType, name)
    if (found === "unknown") lose(`a pin type that is not one of KiCad's (${p.pinType})`)
    const fold = p.pinType === undefined || found === "unknown" ? null : pinFold(p.pinType)
    pins.push({ pin, name, kind: found === "unknown" ? undefined : found, fold })
  }
  return { ids, pins }
}

/**
 * Where a footprint sits on the board: the editor's rotation for it, in degrees (a bottom part is turned half a
 * turn, see `landPad`). The angle is the file's own, any angle (X6), taken to the millionth of a degree, which
 * moves no point of a part under 100 m across by a thousandth of a millimetre: `90.0000001` is the quarter turn.
 */
export function placementRotation(angle: number, bottom: boolean): number {
  return normalizeAngle(angle + (bottom ? 180 : 0))
}

/** Board to project. Throws nothing for a board the model can hold; `lossy` names every approximation otherwise. */
export function buildKicadProject(board: KicadBoard, outline: OutlineResult, report: ImportReport, options: BuildOptions = {}): BuildResult {
  const lossy: string[] = []
  const lose = (what: string) => {
    if (!lossy.includes(what)) lossy.push(what)
  }
  /** What X21 and X22 kept in the project that KiCad itself ignores or could not be brought, for the report. */
  const x22Notes = new Set<string>()
  const title = board.properties.find((p) => p.key === "Title")?.value
  let project: Project = createProject(options.name ?? title ?? "Imported KiCad board", "")

  // ---------- design rules ----------
  // Only the class named Default is the rules: a board with other classes and no Default has KiCad's own Default class, which `setup` says by its values (a user class's values are never the rules).
  const def = board.netClasses.find((c) => c.name === "Default")
  const pick = (...values: (number | undefined)[]) => values.find((v) => v !== undefined && Number.isFinite(v))
  const rules = { ...project.rules }
  type NumericRule = "traceWidth" | "minTraceWidth" | "clearance" | "viaDiameter" | "viaDrill" | "minDrill" | "pourClearance" | "edgeClearance" | "holeClearance" | "minAnnularRing"
  const set = (key: NumericRule, value: number | undefined, allowZero = false) => {
    if (value !== undefined && Number.isFinite(value) && (allowZero ? value >= 0 : value > 0)) rules[key] = value
  }
  // The rules are the Default net class's (KiCad 4 and 5 keep it in the board). `setup` writes its clearance, via size and via drill a second
  // time, and a board with no class block has them as the Default class, as KiCad's parser reads them; `last_trace_width` is the toolbar's last choice.
  set("traceWidth", def?.traceWidth)
  set("minTraceWidth", board.setup.trace_min)
  set("clearance", pick(def?.clearance, board.setup.trace_clearance), true)
  set("viaDiameter", pick(def?.viaDiameter, board.setup.via_size))
  set("viaDrill", pick(def?.viaDrill, board.setup.via_drill))
  set("minDrill", pick(board.setup.through_hole_min, board.setup.via_min_drill))
  set("holeClearance", board.setup.hole_to_hole_min, true)
  set("minAnnularRing", board.setup.via_min_annulus, true)
  // KiCad's `via_min_size`: the smallest via diameter the checks allow (`DesignRules.minViaDiameter`; absent is no minimum).
  if (board.setup.via_min_size !== undefined && Number.isFinite(board.setup.via_min_size) && board.setup.via_min_size > 0) rules.minViaDiameter = board.setup.via_min_size
  // KiCad 4 and 5 boards never state a minimum annular ring, and KiCad 5 has no such check: the editor's own default (0.13 mm) would flag
  // rings KiCad never showed, so such a board starts with none (0) and one note says so. A KiCad 6 or later board without the setting is
  // checked against the default, as its project file would say (`import.ts` names the project file it did not read).
  if (board.setup.via_min_annulus === undefined && ["kicad3", "kicad4", "kicad5"].includes(eraOf(board.version))) {
    rules.minAnnularRing = 0
    report.entries.push({
      code: "annular-ring-none",
      severity: "note",
      object: "the minimum annular ring",
      why: "KiCad 4 and 5 boards state no minimum annular ring and KiCad 5 has no such check, so the project has none (0 mm) and Checks do not flag a ring that KiCad never flagged. Set one in the design rules if your fab needs it.",
    })
  }
  set("pourClearance", board.setup.zone_clearance, true)
  set("edgeClearance", board.setup.edge_clearance, true)
  if (board.setup.pad_to_mask_clearance !== undefined) rules.maskExpansion = board.setup.pad_to_mask_clearance
  if (board.setup.pad_to_paste_clearance !== undefined) rules.pasteExpansion = board.setup.pad_to_paste_clearance
  if (board.userTraceWidths.length) rules.preferredWidths = [...new Set([rules.traceWidth, ...board.userTraceWidths])].sort((a, b) => a - b)
  project.rules = rules

  // ---------- parts, lands and where they sit ----------
  const lands = new Map<string, FootprintDef>()
  const specs = new Map<string, CustomPartSpec>()
  const components: ComponentInstance[] = []
  const models: ModelAssignment[] = []
  const refs = new Set<string>()
  const renamed: string[] = []
  const pinCounts = new Map<string, number>()
  /** Pins whose KiCad type the editor's roles fold, as `R1.2 tri_state as output`. */
  const folded: string[] = []
  /** Parts whose attributes say `exclude_from_sim`, which the editor has no use for. */
  const simExcluded: string[] = []
  /** Pins with no net in the file, marked no connect (`ComponentInstance.nc`) so Checks does not call each one a mistake. */
  let looseCount = 0
  /** Per component: pad number -> the file's raw net name, one per pin, for the labels. */
  const padNets = new Map<string, Map<string, string>>()
  /** Per component: every numbered pad with the file's raw net name (null for none), for the check at the end, which compares pads, not pins. */
  const padFacts = new Map<string, { number: string; net: string | null }[]>()
  const modelDropped = new Map<string, { path: string; why: string; refs: string[] }>()
  /** What KiCad does to a pad that the project shows differently (a hole of a nanometre), by words, with the parts it is on. */
  const padNotes = new Map<string, string[]>()
  const counters = new Map<string, number>()
  let withNet = 0

  // The project's name for every net of the file, decided before the lands are made because a drawing on copper can carry one:
  // the nets of the pads (every pad that carries one has a pin), of the tracks, vias and drawings.
  const allNets = new Set<string>()
  for (const f of board.footprints) for (const p of f.pads) if (p.netRaw) allNets.add(p.netRaw)
  for (const o of [...board.segments, ...board.arcTracks, ...board.vias, ...board.shapes, ...board.footprints.flatMap((f) => f.shapes), ...board.zones]) if (o.netRaw) allNets.add(o.netRaw)
  const labelText = netLabelNames(new Map(), report, allNets)
  // X10: net classes and the rules that go with them, by the labels the nets have in the project
  const { unknownMembers: _unknownMembers, ...x10 } = importRulesX10(board, labelText, report, lose)
  project = { ...project, rules: { ...project.rules, ...x10 } }
  const degenerate: string[] = []
  const badNets: string[] = []
  /** The zones inside parts, for the report. */
  const partZones: { parts: number; zones: Zone[]; degenerate: number } = { parts: 0, zones: [], degenerate: 0 }
  let privateShapes = 0
  /** Text objects brought in, for the report; and the conversion context a text is built with. */
  let textCount = 0
  const textCx = (where: string): TextConversion => ({ board, lose, where })
  /** The id a node of the file has (`uuid`, or `tstamp` before KiCad 7). */
  const uuidOf = (c: List): string | null => strAt(kid(c, "uuid"), 1) ?? strAt(kid(c, "tstamp"), 1) ?? null
  /** What each id of the file is in the project, for the groups to resolve their members by. */
  const boardRefs = new Map<string, string[]>()
  const addRef = (uuid: string | null, ...ids: string[]) => {
    if (uuid !== null && !boardRefs.has(uuid)) boardRefs.set(uuid, ids)
  }
  /** The group each id belongs to, for the tracks: a track is joined with its neighbours only inside one group. */
  // X21: a generated item is a group of the tracks and vias it made (KiCad's `PCB_GENERATOR` is a `PCB_GROUP`), resolved after the plain groups (`resolveGroups`, parser `:1706-1710`).
  const generatorGroups: RawGroup[] = board.generators.map((g) => ({ name: g.name, uuid: g.uuid, locked: g.locked, libId: null, members: g.members, node: g.node }))
  const boardParents = groupParents([...board.groups, ...generatorGroups])
  const groupStats = newGroupStats()
  const compOf = new Map<KicadFootprint, ComponentInstance>()
  const landOrigins = new Map<KicadFootprint, { shapes: number[]; texts: number[] }>()
  const partGroups = new Map<string, PcbGroup[]>()

  // References the file gives itself are kept; the names made up for empty ones avoid them.
  const fileRefs = new Set(board.footprints.map((f) => f.ref.trim().replace(/\*/g, "")).filter(Boolean))
  const ordered = board.footprints.map((fp, index) => ({ fp, index })).sort((a, b) => natural.compare(a.fp.ref, b.fp.ref))
  const footprintComponents = new Map<number, string>()
  for (const { fp, index } of ordered) {
    const bottom = fp.side === "bottom"
    const rot = placementRotation(fp.angle, bottom)

    // The part's pins: one per distinct number, net, name and type of the pads (see `planPins`), and a pin of its own for a pad with no number that carries a net.
    const plan = planPins(fp, lose)
    const pads: PadDef[] = []
    fp.pads.forEach((p, i) => {
      const lp = landPad(fp, p, bottom, plan.ids[i], board)
      if (lp.lossy) lose(lp.lossy)
      for (const n of lp.notes) padNotes.set(n, [...(padNotes.get(n) ?? []), fp.ref || fp.name || "a footprint"])
      pads.push(lp.def)
    })
    // The net of each pin (the raw name: two names that read alike are two nets), and every pad that is on a pin with its pin, for the check at the end, which compares pads.
    const numberNet = new Map<string, string>()
    const facts: { number: string; net: string | null }[] = []
    fp.pads.forEach((p, i) => {
      const pin = plan.ids[i].pin
      if (pin === null) return
      facts.push({ number: pin, net: p.netRaw })
      if (p.netRaw) {
        withNet++
        if (!numberNet.has(pin)) numberNet.set(pin, p.netRaw)
      }
    })

    // The model the part holds, and the land it is held with: footprints with the same pads and model share a land.
    const modelPlan = planModels(fp)
    // The drawings of the footprint on its land, in the land's frame; the courtyard is the one the file draws, else the pads' box and a quarter millimetre, else (a logo) the box of what is drawn, which the checks leave out.
    const drawn = landShapes(fp, board, bottom, (raw) => labelText.get(raw), lose, degenerate, badNets)
    privateShapes += drawn.privateCount
    // X30: the zones drawn inside the footprint are the land's, in the land's frame, so they move, turn and flip with every part that has it.
    const inside = fp.zones.length ? convertPartZones(fp, bottom, { board, rules: project.rules, netName: (raw) => labelText.get(raw) }) : null
    if (inside) {
      for (const what of inside.lossy) lose(what)
      partZones.parts += inside.zones.length ? 1 : 0
      partZones.zones.push(...inside.zones)
      partZones.degenerate += inside.degenerate
    }
    const partTextOrigins: number[] = []
    const drawnCourtyard = courtyardBox(drawn.shapes)
    // A footprint of text only (a logo's name) has no pad and no drawing: its box, for selecting it, is where its texts are.
    const placeOf = (): PartPlacement => ({ x: round(frameTop(fp.at).x), y: round(frameTop(fp.at).y), rot, bottom, at: fp.at, angle: fp.angle })
    const textBox = !pads.length && !drawn.shapes.length ? landTextBox(convertPartTexts(fp.texts, fp.ref, placeOf(), { board, lose: () => {}, where: "" }, { ref: fp.ref })) : null
    const courtyard = drawnCourtyard ?? (pads.length ? padBounds(pads, 0.25) : (drawingBox(drawn.shapes) ?? textBox ?? { minX: -0.5, minY: -0.5, maxX: 0.5, maxY: 0.5 }))
    const land = { pads, silk: [] as Vec2[][], courtyard, ...(drawn.shapes.length ? { shapes: drawn.shapes } : {}), ...(inside?.zones.length ? { zones: inside.zones } : {}), ...(!drawnCourtyard && !pads.length ? { noCourtyard: true as const } : {}) }
    const nameBase = fp.name.includes(":") ? fp.name.slice(fp.name.indexOf(":") + 1) : fp.name
    const landName = `${slug(nameBase || fp.ref)}-${digest(JSON.stringify(land) + modelKey(modelPlan))}`
    if (!lands.has(landName)) lands.set(landName, { name: landName, ...land })

    // The part: one per land and pin list. A pin is named by its pad's function (an overbar `~{RESET}` is `RESET#`, as the editor names an active-low pin) and typed by its pad's pin type.
    const pinNames = new Map<string, PinFacts>(plan.pins.map((q) => [q.pin, { name: q.name, kind: q.kind }]))
    const foldsHere: string[] = plan.pins.filter((q) => q.fold).map((q) => `pin ${q.pin} ${q.fold}`)
    const letters = (fp.ref.match(/^[A-Za-z]+/)?.[0] ?? "").toUpperCase().slice(0, 3)
    const prefix = letters || unnamedPrefix(nameBase, pads.length)
    const category = CATEGORY_BY_PREFIX.find(([re]) => re.test(prefix))?.[1] ?? "ICs"
    const keywords = [...new Set(fp.tags.split(/[\s,]+/).filter(Boolean))]
    const spec: Omit<CustomPartSpec, "id"> = {
      name: nameBase || fp.ref || "Part",
      description: fp.descr.trim() || "From a KiCad board",
      category,
      refPrefix: prefix,
      footprint: landName,
      pins: [...pinNames].map(([number, { name, kind }]) => ({ number, name, ...(kind ? { kind } : {}) })),
      props: {},
      valueProp: "value",
      ...(keywords.length ? { keywords } : {}),
      // The user's own footprint, from their board: nothing to check against a supplier (a part the schematic also has is replaced by the schematic's).
      source: { pins: "import", land: "import", imported: { file: `${options.name ?? "board"}.kicad_pcb`, libId: fp.name } },
    }
    const partId = customPartId(spec)
    if (!specs.has(partId)) specs.set(partId, { id: partId, ...spec })

    // The reference: unique, never empty, never `REF**`.
    let ref = fp.ref.trim()
    const stripped = ref.replace(/\*/g, "")
    if (!stripped) {
      let n = counters.get(prefix) ?? 0
      do ref = `${prefix}${++n}`
      while (refs.has(ref) || fileRefs.has(ref))
      counters.set(prefix, n)
      renamed.push(`${fp.ref || "(empty)"} as ${ref}`)
    } else if (ref !== stripped) {
      renamed.push(`${ref} as ${stripped}`)
      ref = stripped
    }
    if (refs.has(ref)) {
      let n = 2
      while (refs.has(`${ref}_${n}`) || fileRefs.has(`${ref}_${n}`)) n++
      renamed.push(`${ref} as ${ref}_${n}`)
      ref = `${ref}_${n}`
    }
    refs.add(ref)
    for (const f of foldsHere) folded.push(`${ref} ${f}`)
    if (fp.attr.includes("exclude_from_sim")) simExcluded.push(ref)

    const at = frameTop(fp.at)
    const flags = flagsOf(fp)
    const component: ComponentInstance = {
      id: uid("c"),
      partId,
      ref,
      props: fp.value ? { value: fp.value } : {},
      footprint: landName,
      ...(fp.name ? { fpid: fp.name } : {}),
      // X20: the part's component classes, and the sheet its footprint says it is from.
      ...(fp.classes.length ? { classes: fp.classes } : {}),
      ...(fp.sheetname ? { sheetPath: fp.sheetname } : {}),
      sch: { x: 0, y: 0, rot: 0 },
      pcb: { x: round(at.x), y: round(at.y), rot, side: bottom ? "bottom" : "top", placed: true, ...(fp.locked ? { locked: true } : {}) },
      ...(flags ? { flags } : {}),
      // The part's own text, as the file has it (none is a part with no designator); with it the editor places none.
      texts: convertPartTexts(fp.texts, ref, placeOf(), textCx(`${ref}`), { ref }, partTextOrigins),
    }
    compOf.set(fp, component)
    landOrigins.set(fp, { shapes: drawn.origins, texts: partTextOrigins })
    addRef(uuidOf(fp.node), component.id)
    textCount += component.texts!.length
    // A pad with no net is what a pin left unconnected looks like in KiCad: Checks would say "isn't connected" of each, so it is marked no connect.
    const loose = [...pinNames.keys()].filter((n) => !numberNet.has(n)).sort(natural.compare)
    if (loose.length) {
      component.nc = loose
      looseCount += loose.length
    }
    components.push(component)
    footprintComponents.set(index, component.id)
    pinCounts.set(component.id, pinNames.size)
    padNets.set(component.id, numberNet)
    padFacts.set(component.id, facts)

    // 3D model: the one the plan keeps becomes the part's assignment, converted as the parts index converts a KiCad model
    // (the same offset and rotation on the bottom: the half turn of the placement is what KiCad's flip adds, see `landPad`).
    // Every other model is named in the report with its reason.
    if (modelPlan.kept && !models.some((a) => a.part === partId && a.footprint === landName)) {
      const { model, id } = modelPlan.kept
      const held = kicadModel({ source: "kicad", id, name: id.slice(id.lastIndexOf("/") + 1).replace(/\.[^.]+$/, ""), offset: model.offset, rotate: model.rotate, scale: model.scale })
      if (held) models.push({ part: partId, footprint: landName, model: held })
    }
    for (const d of modelPlan.dropped) {
      const key = `${d.model.path}\n${d.why}`
      const had = modelDropped.get(key)
      if (had) had.refs.push(ref)
      else modelDropped.set(key, { path: d.model.path, why: d.why, refs: [ref] })
    }
  }
  for (const d of modelDropped.values()) {
    report.entries.push({
      code: "model-not-brought",
      severity: "not-brought",
      object: `3D model ${d.path || "(no file name)"} of ${d.refs.length === 1 ? d.refs[0] : `${d.refs.length} parts (${d.refs.slice(0, 3).join(", ")}${d.refs.length > 3 ? ", ..." : ""})`}`,
      why: d.why,
      count: d.refs.length,
    })
  }
  for (const [what, parts] of padNotes) {
    report.entries.push({
      code: "pad-as-kicad-reads-it",
      severity: "changed",
      object: `${parts.length} pad${parts.length > 1 ? "s" : ""} (${[...new Set(parts)].slice(0, 5).join(", ")}${new Set(parts).size > 5 ? ", ..." : ""})`,
      why: `The file has ${what}.`,
      count: parts.length,
    })
  }
  const noPins = components.filter((c) => !pinCounts.get(c.id)).map((c) => c.ref)
  if (noPins.length) {
    report.entries.push({
      code: "parts-without-pins",
      severity: "note",
      object: `${noPins.length} part${noPins.length > 1 ? "s" : ""} with no numbered pad (${noPins.slice(0, 5).join(", ")}${noPins.length > 5 ? ", ..." : ""})`,
      why: "A logo, a mounting hole or a drawing has no pin to connect. It came in as a part with no pins, drawn on the board with its land's drawings.",
      count: noPins.length,
      items: noPins,
    })
  }
  if (folded.length) {
    report.entries.push({
      code: "pin-type-folded",
      severity: "changed",
      object: `${folded.length} pin${folded.length > 1 ? "s" : ""} (${folded.slice(0, 5).join("; ")}${folded.length > 5 ? "; ..." : ""})`,
      why: "The editor gives a pin one of seven roles (input, output, io, passive, power, ground, no connect), so these pins' KiCad types were folded into the nearest: tri-state and open collector or emitter pins became outputs, a power output became a power pin, and a pin that says nothing has no role. The file's own type is in the board that was read.",
      count: folded.length,
      items: folded,
    })
  }
  if (looseCount) {
    report.entries.push({
      code: "unconnected-pins-marked",
      severity: "note",
      object: `${looseCount} pad${looseCount > 1 ? "s" : ""} with no net`,
      why: "KiCad puts no net on these pads, which is how a pin left unconnected looks. They are marked no connect, so Checks does not call each one a mistake and the schematic crosses them; clear the flag on a pin in the Inspector to have it checked, or press 'Check imported no-connect pins' (on a part, or with nothing selected for the whole board) to hand every one back to Checks at once.",
      count: looseCount,
    })
  }
  const dnpRefs = components.filter((c) => c.flags?.dnp).map((c) => c.ref)
  if (dnpRefs.length) {
    report.entries.push({
      code: "dnp-parts",
      severity: "note",
      object: `${dnpRefs.length} part${dnpRefs.length > 1 ? "s" : ""} marked do not populate (${dnpRefs.slice(0, 5).join(", ")}${dnpRefs.length > 5 ? ", ..." : ""})`,
      why: "The editor leaves a do not populate part out of its BOM and its position file, which is what a fab expects; KiCad keeps such a part in both by default. Its solder paste is still plotted, as KiCad plots it. Clear the flag in the Inspector to list it again.",
      count: dnpRefs.length,
      items: dnpRefs,
    })
  }
  if (simExcluded.length) {
    report.entries.push({ code: "attr-not-brought", severity: "not-brought", object: `exclude from simulation on ${simExcluded.length} part${simExcluded.length > 1 ? "s" : ""} (${simExcluded.slice(0, 5).join(", ")}${simExcluded.length > 5 ? ", ..." : ""})`, why: "The editor does no circuit simulation on the board, so it has nowhere to keep this flag.", count: simExcluded.length, items: simExcluded })
  }
  if (renamed.length) {
    report.entries.push({ code: "renamed-ref", severity: "changed", object: `${renamed.length} reference${renamed.length > 1 ? "s" : ""} (${renamed.slice(0, 5).join("; ")}${renamed.length > 5 ? "; ..." : ""})`, why: "References must be unique and cannot be empty or contain `*`, so these were renamed.", count: renamed.length })
  }

  project = { ...project, components, parts: specs.size ? [...specs.values()] : undefined, footprints: lands.size ? [...lands.values()] : undefined, ...(models.length ? { models } : {}) }
  registerProjectParts(project)
  for (const spec of specs.values()) {
    const problems = customPartProblems(spec)
    if (problems.length) report.entries.push({ code: "part-cannot-be-drawn", severity: "refused", object: `part ${spec.name}`, why: problems.join("; ") })
  }

  // ---------- the schematic: a label with the net's name on every connected pin ----------
  // Nets that only copper is on (no pad) have no label but are named the same way, so a trace can say which net it is on.
  const placed = layoutSchematic(project, padNets, labelText)
  project = placed.project

  // ---------- copper ----------
  const layers = layerMapOf(board)
  const layerOf = (name: string) => layers.of(name)
  const joined = joinSegments(board, layerOf, lose, labelText, (s) => boardParents.get(uuidOf(s.node) ?? "") ?? -1)
  const traces = joined.traces
  for (const s of board.segments) {
    const t = joined.of.get(s)
    if (t) addRef(uuidOf(s.node), t)
  }
  // X4: an arc track is a trace of its own, `arc` with the three points the file gives (start, a point on the arc, end).
  for (const a of board.arcTracks) {
    const layer = layerOf(a.layer)
    if (!layer) {
      lose(`an arc track on ${a.layer}`)
      continue
    }
    const net = a.netRaw ? labelText.get(a.netRaw) : undefined
    // An arc is held to the nanometre (the file's own unit), not the tenth of a micrometre of a polyline: its circle follows from the three points.
    const pts = [a.start, a.mid, a.end].map((p) => ({ x: round(p.x, 6), y: round(-p.y, 6) }))
    // Three points on a line are KiCad's own straight track (a degenerate arc); it is held as the arc it is, exactly.
    const t: Trace = { id: uid("t"), layer, width: a.width, points: pts, arc: true, ...(a.locked ? { locked: true } : {}), ...(net ? { net } : {}) }
    traces.push(t)
    addRef(uuidOf(a.node), t.id)
  }
  const convertVia = (v: KicadVia): Via => {
    const net = v.netRaw ? labelText.get(v.netRaw) : undefined
    const via: Via = { id: uid("v"), x: round(v.at.x), y: round(-v.at.y), diameter: v.size || rules.viaDiameter, drill: v.drill || rules.viaDrill, ...(v.locked ? { locked: true } : {}), ...(net ? { routedNet: net } : {}) }
    // X5: a via that is not a through via says which layers it joins. KiCad sorts the pair front to back and calls a `blind` between two inner layers buried.
    if (v.kind !== "through") {
      const a = v.layers[0] ? layerOf(v.layers[0]) : null
      const b = v.layers[1] ? layerOf(v.layers[1]) : null
      if (!a || !b || a === b) lose(`a ${v.kind} via on layers the board does not have (${v.layers.join(", ")})`)
      else {
        const span = viaBetween({ stack: { copper: layers.ids.map(() => ({})) } }, a, b, v.kind === "micro")
        via.kind = v.kind === "buried" ? "buried" : v.kind === "micro" ? "micro" : span.kind === "buried" ? "buried" : "blind"
        via.from = span.from ?? (layers.ids.indexOf(a) <= layers.ids.indexOf(b) ? a : b)
        via.to = span.to ?? (layers.ids.indexOf(a) <= layers.ids.indexOf(b) ? b : a)
      }
    }
    if (v.free) via.free = true
    if (v.unused) via.unused = v.unused
    if (v.zoneLayers) via.zoneLayers = layersOfNames(layers, v.zoneLayers)
    if (v.tenting && (v.tenting.front !== undefined || v.tenting.back !== undefined)) via.tent = { ...(v.tenting.front !== undefined ? { front: v.tenting.front } : {}), ...(v.tenting.back !== undefined ? { back: v.tenting.back } : {}) }
    if (v.stack) {
      const sized = (name: string) => v.stack!.sizes.find((s) => s.name === name)?.size
      if (v.stack.mode === "front_inner_back") {
        via.stack = { inner: sized("Inner") ?? via.diameter, back: sized("B.Cu") ?? via.diameter }
      } else {
        const custom: Partial<Record<(typeof layers.ids)[number], number>> = {}
        for (const s of v.stack.sizes) {
          const l = layerOf(s.name)
          if (!l) lose(`a via stack that names ${s.name}, which is not a copper layer of the board`)
          else if (l === "top") via.diameter = s.size
          else custom[l] = s.size
        }
        // A layer that is left out has the via's own diameter, so one that says it is that says nothing; the mode stays (`layers` is then empty).
        for (const [l, d] of Object.entries(custom)) if (d === via.diameter) delete custom[l as keyof typeof custom]
        via.stack = { layers: custom }
      }
    }
    Object.assign(via, viaDrilling(v, layers, (what) => x22Notes.add(what)))
    return via
  }
  const vias: Via[] = board.vias.map(convertVia)
  board.vias.forEach((v, i) => addRef(uuidOf(v.node), vias[i].id))
  // Things a group cannot hold (zones: the project holds them since X3, but a group's members are parts, tracks, vias, drawings, texts, dimensions and images; tables, barcodes and the rest) are known to the file: a group that lists one says so, not that it names nothing.
  for (const z of board.zones) addRef(uuidOf(z.node))
  for (const list of Object.values(board.others)) for (const n of list) addRef(uuidOf(n))
  // A track or via on a net number the net table does not list is on no net, as KiCad loads it (`parseNet`, parser lines 305-315).
  const copperBadNets = [
    ...board.segments.filter((s) => s.badNet !== undefined).map((s) => `a track at (${s.start.x}, ${s.start.y}): net ${s.badNet}`),
    ...board.arcTracks.filter((s) => s.badNet !== undefined).map((s) => `an arc track at (${s.start.x}, ${s.start.y}): net ${s.badNet}`),
    ...board.vias.filter((v) => v.badNet !== undefined).map((v) => `a via at (${v.at.x}, ${v.at.y}): net ${v.badNet}`),
  ]
  if (copperBadNets.length) {
    report.entries.push({
      code: "copper-net-unknown",
      severity: "changed",
      object: `${copperBadNets.length} track${copperBadNets.length > 1 ? "s and vias" : " or via"} on a net number the board does not list (${copperBadNets.slice(0, 3).join("; ")}${copperBadNets.length > 3 ? "; ..." : ""})`,
      why: "KiCad logs an invalid net number on a track or via and loads it with no net, so these are on no net here either.",
      count: copperBadNets.length,
      items: copperBadNets,
    })
  }
  const zoneResult = convertZones({ board, rules, netName: (raw) => labelText.get(raw) })
  for (const what of zoneResult.lossy) lose(what)

  // ---------- drawings on the board ----------
  const edgeTargets: string[] = []
  const graphicsCx: GraphicsContext = { board, map: (p) => ({ x: p.x, y: -p.y }), layerOf: (l) => l, netName: (raw) => labelText.get(raw), lose, degenerate, badNets, edgeTargets, where: "the board" }
  const graphics: BoardGraphic[] = []
  const drawn = (node: List, made: ReturnType<typeof convertShape>) => {
    const ids = made.map((g) => {
      const id = defaultGraphicId(graphics.length)
      graphics.push({ id, ...g })
      return id
    })
    addRef(uuidOf(node), ...ids)
  }
  for (const s of board.shapes) drawn(s.node, convertShape(s, graphicsCx))
  for (const t of board.targets) drawn(t.node, convertTarget(t, graphicsCx))
  if (edgeTargets.length) {
    report.entries.push({
      code: "target-off-edge",
      severity: "note",
      object: `${edgeTargets.length} alignment mark${edgeTargets.length > 1 ? "s" : ""} on Edge.Cuts (at ${edgeTargets.slice(0, 5).join(", ")}${edgeTargets.length > 5 ? ", ..." : ""})`,
      why: "KiCad leaves a target mark out of the board's outline and plots it on the edge layer. The editor reads every drawing on Edge.Cuts as the outline, so the marks are kept on Dwgs.User, where they are drawn but not cut: the Edge.Cuts Gerber does not have them.",
      count: edgeTargets.length,
    })
  }

  if (degenerate.length) {
    report.entries.push({ code: "polygon-too-small", severity: "not-brought", object: `${degenerate.length} polygon${degenerate.length > 1 ? "s" : ""} with fewer than three corners (${[...new Set(degenerate)].slice(0, 5).join(", ")}${new Set(degenerate).size > 5 ? ", ..." : ""})`, why: "KiCad draws and plots nothing for a polygon with fewer than three corners, so none was brought in.", count: degenerate.length })
  }
  if (badNets.length) {
    report.entries.push({
      code: "drawing-net-unknown",
      severity: "changed",
      object: `${badNets.length} copper drawing${badNets.length > 1 ? "s" : ""} on a net number the board does not list (${badNets.slice(0, 3).join("; ")}${badNets.length > 3 ? "; ..." : ""})`,
      why: "KiCad logs an invalid net number on a drawing and loads it with no net, so these drawings are on no net here either.",
      count: badNets.length,
      items: badNets,
    })
  }
  if (privateShapes) {
    report.entries.push({ code: "private-layer-drawings", severity: "not-brought", object: `${privateShapes} drawing${privateShapes > 1 ? "s" : ""} on a footprint's private layers`, why: "KiCad shows and plots nothing on a footprint's private layers, so these drawings were not brought in.", count: privateShapes })
  }

  // ---------- text on the board ----------
  const boardTexts: BoardText[] = []
  for (const t of board.texts) {
    const converted = convertBoardText(t, textCx("the board"), defaultTextId(boardTexts.length))
    if (converted) boardTexts.push(converted)
    addRef(uuidOf(t.node), ...(converted ? [converted.id] : []))
  }
  textCount += boardTexts.length

  // ---------- dimensions, reference images and groups ----------
  const dimensions: BoardDimension[] = []
  for (const k of board.dimensions) {
    const made = convertDimension(k, { board, lose }, defaultDimensionId(dimensions.length))
    if (made) dimensions.push(made)
    addRef(k.uuid, ...(made ? [made.id] : []))
  }
  const keptFiles = new Map<string, KeptFile>()
  const images: ReferenceImage[] = []
  for (const k of board.images) {
    const made = convertImage(k, { board, lose }, defaultImageId(images.length))
    if (made) {
      images.push(made.image)
      keptFiles.set(made.file.id, made.file)
    }
    addRef(k.uuid, ...(made ? [made.image.id] : []))
  }
  const footprintImages = board.images.filter((k) => k.footprint !== undefined)
  if (footprintImages.length) {
    const refs = [...new Set(footprintImages.map((k) => k.footprint || "a footprint with no reference"))]
    report.entries.push({
      code: "footprint-image-on-board",
      severity: "note",
      object: `${footprintImages.length} reference image${footprintImages.length > 1 ? "s" : ""} inside footprints (${refs.join(", ")})`,
      why: "KiCad keeps them in a footprint, at their place on the board. The project keeps them on the board in that place, so they no longer move with the part.",
      count: footprintImages.length,
    })
  }
  // X21: the generated items (tuning patterns, via stacks, via stitching) are groups with what made them. KiCad does not keep a tuning pattern or a via stack with no members (`parseGENERATOR`, parser `:8777`).
  const generated: RawGroup[] = []
  const droppedGenerators: string[] = []
  board.generators.forEach((g, i) => {
    if (!g.members.length && (g.kind === "tuning_pattern" || g.kind === "via_stack")) {
      groupStats.empty++
      addRef(g.uuid)
      return
    }
    const made = convertGenerator(g, layers, convertVia)
    if ("why" in made) {
      droppedGenerators.push(made.why)
      addRef(g.uuid)
      return
    }
    generatorGroups[i].gen = made.gen
    generated.push(generatorGroups[i])
  })
  const boardGroups = resolveGroups([...board.groups, ...generated], boardRefs, defaultGroupId, groupStats)
  // A part's groups: what they list are the part's own pads, drawings and texts, by their place in its land and in its list of texts.
  for (const fp of board.footprints) {
    const comp = compOf.get(fp)
    const origins = landOrigins.get(fp)
    if (!comp || !origins || !fp.groups.length) continue
    const refs = new Map<string, string[]>()
    const bump = (uuid: string | null, ref: string) => {
      if (uuid === null) return
      const list = refs.get(uuid)
      if (list) list.push(ref)
      else refs.set(uuid, [ref])
    }
    fp.pads.forEach((p, i) => bump(uuidOf(p.node), `p${i}`))
    origins.shapes.forEach((from, k) => bump(uuidOf(fp.shapes[from].node), `s${k}`))
    fp.shapes.forEach((s) => refs.has(uuidOf(s.node) ?? "") || (uuidOf(s.node) !== null && refs.set(uuidOf(s.node)!, [])))
    origins.texts.forEach((from, j) => bump(uuidOf(fp.texts[from].node), `t${j}`))
    fp.texts.forEach((t) => refs.has(uuidOf(t.node) ?? "") || (uuidOf(t.node) !== null && refs.set(uuidOf(t.node)!, [])))
    for (const z of fp.zones) refs.set(uuidOf(z.node) ?? "", [])
    for (const d of kids(fp.node, "dimension")) refs.set(uuidOf(d) ?? "", [])
    const groups = resolveGroups(fp.groups, refs, defaultPartGroupId, groupStats)
    if (groups.length) partGroups.set(comp.id, groups)
  }

  // X21: net chains, by the project's names for the nets and the pads' places in their parts.
  const padPlaces = new Map<string, { component: string; pad: number }>()
  for (const fp of board.footprints) {
    const comp = compOf.get(fp)
    if (comp) fp.pads.forEach((p, i) => (uuidOf(p.node) !== null ? padPlaces.set(uuidOf(p.node)!, { component: comp.id, pad: i }) : undefined))
  }
  const netChains = convertNetChains(board, (raw) => labelText.get(raw) ?? decodeNetName(raw).trim(), (u) => padPlaces.get(u))

  // ---------- the board ----------
  // A rectangle or a rounded rectangle is the board's own shape, as ever. Any other outline (X2) is held as the paths it is: loops with their cutouts, and what does not close, kept as drawn.
  let box = outline.box
  let outlineDef: BoardOutline | undefined
  if (!box || !outline.representable) {
    outlineDef = { paths: outline.paths }
    if (outline.paths.length) {
      const exact = pathsBox(outline.paths)
      box = { minX: exact.minX, maxX: exact.maxX, minY: -exact.maxY, maxY: -exact.minY }
    } else {
      // No outline at all: the board is held with none, and the box is the parts' with a margin, so there is something to show and route in.
      const b = emptyBox()
      for (const c of components) expandBox(b, c.pcb, 5)
      box = b.minX <= b.maxX ? { minX: b.minX, minY: -b.maxY, maxX: b.maxX, maxY: -b.minY } : { minX: -25, minY: -20, maxX: 25, maxY: 20 }
    }
  }
  const width = box.maxX - box.minX
  const height = box.maxY - box.minY
  const centre = frameTop({ x: (box.minX + box.maxX) / 2, y: (box.minY + box.maxY) / 2 })
  // The title is the project's name unless the caller named it, and then it is kept as a property; the release and file version are always kept.
  const titleIsName = options.name === undefined && title !== undefined
  const version = `${board.generatorVersion ? `KiCad ${board.generatorVersion}, ` : ""}${board.version === null ? "no version stamp" : `file version ${board.version}`}`
  const properties = [
    { key: "Imported from", value: options.source ?? `KiCad ${board.generatorVersion ?? board.era}` },
    { key: "KiCad file version", value: version },
    ...board.properties.filter((p) => !(titleIsName && p.key === "Title")),
  ]
  project = {
    ...project,
    board: {
      ...project.board,
      width: round(width),
      height: round(height),
      x: round(centre.x),
      y: round(centre.y),
      thickness: board.thickness ?? 1.6,
      cornerRadius: round(outline.representable ? outline.cornerRadius : 0),
      mountingHoles: null,
      ...(outlineDef ? { outline: outlineDef } : {}),
      ...stackFields(board),
    },
    traces,
    vias,
    zones: zoneResult.zones,
    ...(graphics.length ? { graphics } : {}),
    ...(boardTexts.length ? { texts: boardTexts } : {}),
    ...(partGroups.size ? { components: project.components.map((c) => (partGroups.has(c.id) ? { ...c, groups: partGroups.get(c.id)! } : c)) } : {}),
    ...(dimensions.length ? { dimensions } : {}),
    ...(boardGroups.length ? { groups: boardGroups } : {}),
    ...(netChains.length ? { netChains } : {}),
    ...(images.length ? { images } : {}),
    properties,
  }
  reportTexts(project, textCount, report)
  reportDimensionsGroupsImages(board, dimensions, groupStats, report)
  reportX21X22(boardGroups, droppedGenerators, x22Notes, report)

  // ---------- every pad on the net the file gives it ----------
  const checked = verifyNets(project, padFacts, labelText, report)
  zoneResult.loose = [...new Set(zoneResult.zones.filter((z) => z.net && !checked.conn.nets.some((n) => n.name === z.net)).map((z) => z.net))]
  reportZones(zoneResult, report, board.zones.length)
  reportPartZones(partZones, report)
  const copperNetMismatches = compareCopperNets(project, checked.conn, board, report)
  project = acceptLoneLabels(project, checked.conn, report)
  // The pins marked no connect are the importer's, recorded so they can be handed back to Checks in one action.
  const noConnect = Object.fromEntries(components.flatMap((c) => (c.nc ? [[c.id, c.nc]] : [])))
  if (Object.keys(noConnect).length) project = { ...project, importMarks: { ...project.importMarks, noConnect } }
  const pins = components.reduce((n, c) => n + (padNets.get(c.id)?.size ?? 0), 0)
  return { project, files: [...keptFiles.values()], lossy, stats: { parts: components.length, lands: lands.size, pins, nets: checked.nets, padsWithNet: withNet, copperNetMismatches }, footprintComponents }
}

// ---------- X21 and X22 ----------

/** What the report says of generated items, via protection, drills and post-machining, pad lengths and net chains that came in, and what KiCad itself ignores. */
function reportX21X22(groups: PcbGroup[], dropped: string[], notes: ReadonlySet<string>, report: ImportReport) {
  const word = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
  if (dropped.length) {
    report.entries.push({ code: "generator-not-brought", severity: "not-brought", object: word(dropped.length, "generated item"), why: `${[...new Set(dropped)].slice(0, 3).join("; ")}. Its tracks and vias came in as plain ones, with nothing to tune again.`, count: dropped.length, items: dropped })
  }
  const kept = groups.filter((g) => g.gen)
  const other = kept.filter((g) => g.gen!.kind !== "tuning_pattern")
  if (other.length) {
    report.entries.push({
      code: "generator-via-kept",
      severity: "note",
      object: word(other.length, "generated via stack or via stitching group", "generated via stack or via stitching groups"),
      why: "A via stack or via stitching is kept as a group with its settings, and its vias are ordinary vias. The editor does not lay out stitching or stacks again; take the group apart to edit its vias one by one. KiCad 9 has no such item, so a file written for it carries the vias only.",
      count: other.length,
    })
  }
  for (const n of notes) report.entries.push({ code: "drill-ignored", severity: "note", object: n, why: "KiCad's own reader keeps it but it drills nothing, so the project does not hold it." })
}

// ---------- dimensions, groups and images ----------

/** What the report says of the dimensions, groups and reference images that came in, and of what KiCad's own resolution did with the groups' members. */
function reportDimensionsGroupsImages(board: KicadBoard, dimensions: BoardDimension[], stats: ReturnType<typeof newGroupStats>, report: ImportReport) {
  const word = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
  // A dimension in automatic units shows its value in millimetres, as KiCad does for a file it has no display settings for.
  const automatic = dimensions.filter((d) => d.units === 3 && d.kind !== "center" && d.kind !== "leader" && d.override === undefined && d.format !== 0)
  if (automatic.length) {
    report.entries.push({
      code: "dimension-units-automatic",
      severity: "note",
      object: word(automatic.length, "dimension") + " in automatic units",
      why: "KiCad shows a dimension in automatic units in whatever units its own screen is set to, which a board file does not say. They are drawn in millimetres, KiCad's default, and so are plotted.",
      count: automatic.length,
    })
  }
  const legacy = board.dimensions.filter((d) => d.legacy).length
  if (legacy) {
    report.entries.push({
      code: "dimensions-redrawn",
      severity: "note",
      object: word(legacy, "KiCad 5 dimension"),
      why: "KiCad 6 and later do not read a KiCad 5 dimension's arrows, feature lines or text position: they keep its two points, how far its crossbar is and its text's size, and draw the rest themselves, with the units its text names and four digits. So do these, which is what KiCad now shows for the file.",
      count: legacy,
    })
  }
  const moved = stats.moved + stats.refused
  if (stats.unresolved) {
    report.entries.push({ code: "group-member-unresolved", severity: "note", object: word(stats.unresolved, "group member"), why: "These members name nothing in the file (or, in a part, nothing of that part). KiCad skips them as well.", count: stats.unresolved })
  }
  if (stats.notBrought) {
    report.entries.push({ code: "group-member-not-brought", severity: "not-brought", object: word(stats.notBrought, "group member"), why: "These members are zones (a group cannot hold a zone yet: the zone is in the board, but moving, turning and locking a group leaves it where it is), arc tracks or tables, so they are not in their group.", count: stats.notBrought })
  }
  if (moved) {
    report.entries.push({ code: "group-member-moved", severity: "note", object: word(moved, "group member"), why: "An item is in one group, so a group that lists an item another group holds takes it, and a group is never put into itself or into a group it holds, as KiCad does when it loads the file.", count: moved })
  }
  if (stats.empty) {
    report.entries.push({ code: "group-empty", severity: "note", object: word(stats.empty, "group"), why: "These groups have nothing left in them, so KiCad would not write them back and the project does not keep them.", count: stats.empty })
  }
}

// ---------- text ----------

/** The report entry for the variables the texts use that the board file cannot resolve. */
function reportTexts(project: Project, count: number, report: ImportReport) {
  if (!count) return
  const unresolved = new Map<string, number>()
  const note = (owner: ComponentInstance | null, content: string, layer: string | undefined) => {
    const left: string[] = []
    textShown(project, owner, content, 0, left, layer)
    for (const name of left) unresolved.set(name, (unresolved.get(name) ?? 0) + 1)
  }
  for (const t of project.texts) note(null, t.text, t.layer)
  for (const c of project.components) for (const t of c.texts ?? []) if (t.kind === "user" || t.text !== undefined) note(c, t.text ?? "", c.pcb.side === "bottom" ? flipShapeLayer(t.layer, copperLayers(project.board).length) : t.layer)
  if (unresolved.size) {
    const names = [...unresolved.keys()].sort()
    report.entries.push({
      code: "text-variable-unresolved",
      severity: "changed",
      object: `text variables with no value in a board file (${names.slice(0, 5).map((n) => `\${${n}}`).join(", ")}${names.length > 5 ? ", ..." : ""})`,
      why: "KiCad takes these from the project file (`.kicad_pro` text variables) or from the clock when it draws the text, and a board file alone does not have them, so the text shows the name as written, which is what KiCad draws when it has no project.",
      count: [...unresolved.values()].reduce((a, b) => a + b, 0),
      items: names,
    })
  }
}

// ---------- nets ----------

/**
 * The text of the label for each net of the file, by the net's raw name (the file's spelling, which
 * is its identity: `/A/B` and `/A{slash}B` are two nets even though they read alike). The label reads
 * as the user reads the net, `{slash}` as `/` and trimmed, since that is how the editor compares
 * labels; two nets that would read the same keep distinct labels: the one the file spells exactly as
 * it reads (nothing to decode, nothing to trim) keeps the text, then one with only decoding or
 * trimming to do, and the others keep their raw spelling (and a number if even that is taken).
 * `extra` names nets that only carry copper, so their labels are chosen the same way.
 */
export function netLabelNames(padNets: Map<string, Map<string, string>>, report: ImportReport, extra: Iterable<string> = []): Map<string, string> {
  const used = new Set<string>()
  const out = new Map<string, string>()
  const altered: string[] = []
  const names = new Set<string>(extra)
  for (const m of padNets.values()) for (const n of m.values()) names.add(n)
  // The name exactly as written goes first, so a collision never changes the name of a net that needs no decoding or trimming
  // (the file's `GND` is `GND` even when the file also has ` GND`); a name that only needs decoding goes before one that needs more.
  const rank = (raw: string) => (decodeNetName(raw).trim() === raw ? 0 : decodeNetName(raw) === raw ? 1 : 2)
  const ordered = [...names].sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0))
  for (const raw of ordered) {
    let text = decodeNetName(raw).trim()
    if (!text || used.has(text)) {
      const fallback = raw.trim()
      if (fallback && !used.has(fallback)) text = fallback
      else {
        let n = used.size + 1
        while (used.has(`${fallback || "NET"} (${n})`)) n++
        text = `${fallback || "NET"} (${n})`
      }
      altered.push(`${raw && raw === raw.trim() ? raw : JSON.stringify(raw)} as ${text}`)
    }
    used.add(text)
    out.set(raw, text)
  }
  if (altered.length) report.entries.push({ code: "renamed-net", severity: "changed", object: `${altered.length} net${altered.length > 1 ? "s" : ""} (${altered.slice(0, 5).join("; ")})`, why: "Two nets read the same once their names are trimmed and decoded, or a name was empty. The net spelled exactly as the name keeps it; the other keeps its raw spelling, with a number when even that is taken.", count: altered.length })
  return out
}

interface Extent {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

/** Parts in a grid, packed in rows, each given room for its symbol, its text and the labels of its pins; then a label on every connected pin. */
function layoutSchematic(project: Project, padNets: Map<string, Map<string, string>>, labelText: Map<string, string>): { project: Project } {
  const margin = 0.4
  const extents = project.components.map((c) => {
    const s = schematicBounds(c)
    const b: Extent = { minX: s.minX - 0.45, minY: s.minY - 0.25, maxX: s.maxX + 0.45, maxY: s.maxY + 0.25 }
    for (const pin of schematicPins(c)) {
      const net = padNets.get(c.id)?.get(pin.pin)
      if (!net) continue
      const at = pinStubPoint(pin, SCH_GRID * 3)
      const rot: Rotation = pin.dir === "left" ? 180 : pin.dir === "up" ? 90 : pin.dir === "down" ? 270 : 0
      const l = labelBox({ id: "", name: labelText.get(net) ?? net, x: at.x, y: at.y, rot })
      b.minX = Math.min(b.minX, l.minX)
      b.minY = Math.min(b.minY, l.minY)
      b.maxX = Math.max(b.maxX, l.maxX)
      b.maxY = Math.max(b.maxY, l.maxY)
    }
    return b
  })
  const total = extents.reduce((a, e) => a + (e.maxX - e.minX + margin) * (e.maxY - e.minY + margin), 0)
  const rowWidth = Math.max(40, Math.sqrt(total) * 1.6)
  let x = 0
  let y = 0
  let rowHeight = 0
  const positions: Vec2[] = []
  extents.forEach((e) => {
    const w = e.maxX - e.minX + margin
    const h = e.maxY - e.minY + margin
    if (x > 0 && x + w > rowWidth) {
      x = 0
      y -= rowHeight
      rowHeight = 0
    }
    // The part's origin sits so that its extent starts at the cursor; rows run downwards (y up).
    positions.push({ x: snap(x - e.minX, SCH_GRID), y: snap(y - e.maxY, SCH_GRID) })
    x += w
    rowHeight = Math.max(rowHeight, h)
  })
  const components = project.components.map((c, i) => ({ ...c, sch: { x: round(positions[i].x), y: round(positions[i].y), rot: 0 as Rotation } }))
  const wires: Wire[] = []
  const labels: NetLabel[] = []
  for (const c of components) {
    const pins = new Map(schematicPins(c).map((p) => [p.pin, p]))
    for (const [pinNumber, net] of padNets.get(c.id) ?? []) {
      const pin = pins.get(pinNumber)
      if (!pin) continue
      const stub = pinStubPoint(pin, SCH_GRID * 3)
      const rot: Rotation = pin.dir === "left" ? 180 : pin.dir === "up" ? 90 : pin.dir === "down" ? 270 : 0
      wires.push({ id: uid("w"), points: [pin.pos, stub] })
      labels.push({ id: uid("l"), name: labelText.get(net) ?? net, x: round(stub.x), y: round(stub.y), rot })
    }
  }
  return { project: { ...project, components, wires, labels } }
}

/**
 * Checks the generated schematic against the file, pad by pad: every pad's pin is on the net the
 * file gives that pad (and on none when the pad has none). Pads that share a number are one pin, so
 * they can only agree; a board with pads that disagree is not imported (X7). Returns the number of nets
 * and the connectivity it computed.
 */
function verifyNets(project: Project, padFacts: Map<string, { number: string; net: string | null }[]>, labelText: Map<string, string>, report: ImportReport): { nets: number; conn: SchematicConnectivity } {
  const conn = computeConnectivity(project)
  const { pinNet } = conn
  const bad: string[] = []
  const netOfName = new Map<string, string>()
  for (const c of project.components) {
    for (const pad of padFacts.get(c.id) ?? []) {
      const got = pinNet.get(pinKey(c.id, pad.number))
      if (pad.net === null) {
        if (got !== undefined) bad.push(`${c.ref} pad ${pad.number} is on ${got.slice(4)} but has no net in the file`)
        continue
      }
      const expected = `net:${(labelText.get(pad.net) ?? pad.net).trim()}`
      if (got !== expected) bad.push(`${c.ref} pad ${pad.number} is on ${got?.slice(4) ?? "no net"}, the file has ${pad.net}`)
      else netOfName.set(pad.net, expected)
    }
  }
  if (bad.length) {
    report.entries.push({ code: "net-mismatch", severity: "refused", object: `${bad.length} pad${bad.length > 1 ? "s" : ""}: ${bad.slice(0, 3).join("; ")}`, why: "The generated schematic does not carry the file's nets exactly, so nothing was imported.", count: bad.length })
  }
  return { nets: netOfName.size, conn }
}

/**
 * The net each trace and via is on in the file against the net the editor derives from what the
 * copper touches (`derivedCopperNets`, which ignores the nets the items name): every difference is
 * reported by item. The file's net stays on the item either way (`Trace.net`, `Via.routedNet`), so
 * the editor's own checks see the difference too (a short, an unrouted connection). Returns how many differ.
 */
function compareCopperNets(project: Project, conn: SchematicConnectivity, board: KicadBoard, report: ImportReport): number {
  if (!project.traces.length && !project.vias.length) return 0
  const derived = derivedCopperNets(project, conn, { keptFills: true })
  const nameOf = new Map(conn.nets.map((n) => [n.id, n.name]))
  const says = (id: string | null | undefined) => (id === undefined || id === null ? "no net" : id === "short" ? "pads of more than one net" : `net ${nameOf.get(id) ?? id}`)
  const front = board.copper.front
  const at = (p: { x: number; y: number }) => `(${round(p.x, 3)}, ${round(-p.y, 3)})`
  const items: string[] = []
  const check = (what: string, file: string | undefined, id: string | null | undefined) => {
    const got = id === undefined || id === null || id === "short" ? id : nameOf.get(id)
    if ((file === undefined && (got === undefined || got === null)) || file === got) return
    items.push(`${what}: the file puts it on ${file === undefined ? "no net" : `net ${file}`}, the editor derives ${file !== undefined && (got === null || got === undefined) ? "no net, since no pad of that net touches it" : says(id)}`)
  }
  for (const t of project.traces) {
    const first = t.points[0]
    const last = t.points[t.points.length - 1]
    check(`trace on ${t.layer === "top" ? front : board.copper.back} from ${at(first)} to ${at(last)} (${t.points.length - 1} segment${t.points.length > 2 ? "s" : ""})`, t.net, derived.traceNet.get(t.id))
  }
  for (const v of project.vias) check(`via at ${at(v)}`, v.routedNet, derived.viaNet.get(v.id))
  if (items.length) {
    report.entries.push({
      code: "copper-net-differs",
      severity: "changed",
      object: `${items.length} trace${items.length > 1 ? "s and vias" : " or via"} whose net the editor derives differently (${items.slice(0, 3).join("; ")}${items.length > 3 ? "; ..." : ""})`,
      why: "The editor works out a trace's net from the pads it touches and the copper pours it lies in. For these the file says another net, or none. The file's net is kept on the item, so Checks shows the difference as a short or an unrouted connection.",
      count: items.length,
      items,
    })
  }
  return items.length
}

/**
 * A net with one pad on it shows in Checks as "goes only to a label no other pin has", which is true of
 * the file and no mistake in it: KiCad names a lone pad's net `Net-(R1-Pad1)` or `unconnected-(R1-Pad1)`,
 * and a net a person named by hand can have one pad too. Every one keeps its label, so no name is lost
 * and traces can still say which net they are on, and each warning is set to ignored (`ignoredChecks`),
 * where Checks lists it and can restore it. One note says how many.
 */
function acceptLoneLabels(project: Project, conn: SchematicConnectivity, report: ImportReport): Project {
  const lone = runErc(project, conn).filter((f) => f.kind === "lone-label")
  if (!lone.length) return project
  const labelName = new Map(project.labels.map((l) => [l.id, l.name]))
  const auto = lone.filter((f) => f.labelIds.some((id) => /^(?:Net-\(|unconnected-\()/.test(labelName.get(id) ?? ""))).length
  report.entries.push({
    code: "lone-labels-accepted",
    severity: "note",
    object: `${lone.length} net${lone.length > 1 ? "s" : ""} with a single pad`,
    why: `Checks would warn that the pad goes only to a label no other pin has. In KiCad that is how a net with one pad looks (${auto} of these are KiCad's own Net-(...) or unconnected-(...) names, ${lone.length - auto} were named by hand), so the warnings are set to ignored. Every net keeps its name. They are listed under Ignored in Checks, where each can be restored.`,
    count: lone.length,
    items: lone.map((f) => f.message),
  })
  const keys = lone.map((f) => f.key)
  return { ...project, ignoredChecks: [...new Set([...(project.ignoredChecks ?? []), ...keys])], importMarks: { ...project.importMarks, checks: keys } }
}

// ---------- tracks ----------

/** Segments of one net, layer, width, lock and group that meet end to end, as polylines; `of` says which polyline each segment is in. */
function joinSegments(board: KicadBoard, layerOf: (name: string) => CopperLayer | null, lose: (what: string) => void, labelText: Map<string, string>, groupOf: (s: KicadBoard["segments"][number]) => number): { traces: Trace[]; of: Map<KicadBoard["segments"][number], string> } {
  const traces: Trace[] = []
  const of = new Map<KicadBoard["segments"][number], string>()
  const groups = new Map<string, { layer: CopperLayer; width: number; locked: boolean; netRaw: string | null; segs: typeof board.segments }>()
  for (const s of board.segments) {
    const layer = layerOf(s.layer)
    if (!layer) {
      lose(`a track on ${s.layer}`)
      continue
    }
    // Segments are joined only within one net, layer, width, lock and group; the raw name is the net's identity (`/A/B` and `/A{slash}B` are two nets).
    const group = groupOf(s)
    const key = JSON.stringify(group < 0 ? [layer, s.width, s.locked, s.netRaw] : [layer, s.width, s.locked, s.netRaw, group])
    const g = groups.get(key)
    if (g) g.segs.push(s)
    else groups.set(key, { layer, width: s.width, locked: s.locked, netRaw: s.netRaw, segs: [s] })
  }
  const k = (p: { x: number; y: number }) => `${Math.round(p.x * 1e4)},${Math.round(p.y * 1e4)}`
  for (const { layer, width, locked, netRaw, segs } of groups.values()) {
    const net = netRaw ? labelText.get(netRaw) : undefined
    const trace = (pts: { x: number; y: number }[]): Trace => ({ id: uid("t"), layer, width, points: pts.map((p) => ({ x: round(p.x), y: round(-p.y) })), ...(locked ? { locked: true } : {}), ...(net ? { net } : {}) })
    const at = new Map<string, number[]>()
    segs.forEach((s, i) => {
      for (const p of [s.start, s.end]) {
        const list = at.get(k(p))
        if (list) list.push(i)
        else at.set(k(p), [i])
      }
    })
    const used = new Array<boolean>(segs.length).fill(false)
    const walk = (first: number, from: "start" | "end") => {
      const pts: { x: number; y: number }[] = []
      const made: number[] = []
      let i = first
      let head = from
      for (;;) {
        used[i] = true
        made.push(i)
        const s = segs[i]
        const a = head === "start" ? s.start : s.end
        const b = head === "start" ? s.end : s.start
        if (!pts.length) pts.push(a)
        pts.push(b)
        const next = (at.get(k(b)) ?? []).filter((j) => !used[j])
        // Continue only through a point exactly two segments share.
        if ((at.get(k(b)) ?? []).length !== 2 || next.length !== 1) break
        i = next[0]
        head = k(segs[i].start) === k(b) ? "start" : "end"
      }
      return { pts, made }
    }
    const push = (chain: { pts: { x: number; y: number }[]; made: number[] }) => {
      const t = trace(chain.pts)
      traces.push(t)
      for (const i of chain.made) of.set(segs[i], t.id)
    }
    // Chains start at an end that is not shared by exactly two segments; what is left is a loop.
    const starts: [number, "start" | "end"][] = []
    segs.forEach((s, i) => {
      if ((at.get(k(s.start)) ?? []).length !== 2) starts.push([i, "start"])
      if ((at.get(k(s.end)) ?? []).length !== 2) starts.push([i, "end"])
    })
    for (const [i, head] of starts) if (!used[i]) push(walk(i, head))
    segs.forEach((_, i) => {
      if (!used[i]) push(walk(i, "start"))
    })
  }
  return { traces, of }
}
