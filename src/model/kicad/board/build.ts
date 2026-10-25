import { emptyBox, expandBox, round, snap, type Box } from "../../../lib/geometry"
import { uid } from "../../../lib/id"
import { computeConnectivity, pinKey } from "../../connectivity"
import { customPartId, customPartProblems, digest, registerProjectParts } from "../../customParts"
import { labelBox } from "../../labels"
import { pinStubPoint, schematicBounds, schematicPins } from "../../instances"
import { createProject } from "../../ops"
import { SCH_GRID } from "../../symbols"
import type { ComponentInstance, CustomPartSpec, FootprintDef, ModelAssignment, NetLabel, PadDef, PartCategory, PinDef, Project, Rotation, Trace, Vec2, Via, Wire } from "../../types"
import { kicadModel } from "../../models3d"
import { pinRole } from "../../supplier/roles"
import { cleanPinName } from "../symbol"
import { quarterTurns, reach, rotK } from "./geometry"
import { modelKey, planModels } from "./models"
import { edgePieces, type OutlineResult } from "./outline"
import type { ImportReport } from "./report"
import { decodeNetName } from "./read"
import type { KicadBoard, KicadFootprint, KicadPad } from "./types"

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
  /** What had to be approximated; always empty unless `allowLossy`. */
  lossy: string[]
  stats: { parts: number; lands: number; pins: number; nets: number; padsWithNet: number }
}

const CATEGORY_BY_PREFIX: [RegExp, PartCategory][] = [
  [/^(J|P|CN|CON|USB|X)$/, "Connectors"],
  [/^(Q|M|T)$/, "Transistors"],
  [/^(D|LED|TVS|Z)$/, "Diodes"],
  [/^(SW|S|K|BTN|RLY|BZ)$/, "Electromechanical"],
  [/^(R|C|L|F|FB|Y|XTAL|TP)$/, "Passives"],
]

const slug = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 24) || "land"

const frameTop = (p: { x: number; y: number }): Vec2 => ({ x: p.x, y: -p.y })

/** A pad's outline in the pad's own frame (y down, before its turn): the trapezoid KiCad draws for a size and a delta. */
function trapezoidCorners(w: number, h: number, dx: number, dy: number): { x: number; y: number }[] {
  const hx = w / 2
  const hy = h / 2
  const ddx = dx / 2
  const ddy = dy / 2
  return [
    { x: -hx - ddy, y: hy + ddx },
    { x: -hx + ddy, y: -hy - ddx },
    { x: hx - ddy, y: -hy + ddx },
    { x: hx + ddy, y: hy - ddx },
  ]
}

interface LandPad {
  def: PadDef
  lossy?: string
}

/**
 * A pad as a pad of the land of its footprint, in the editor's frame, and what the model cannot
 * hold of it. The land is the library's, the footprint with no turn and on the top side, so one
 * footprint has one land on whichever side a board puts it; the instance's turn and mirror
 * (`bottom`) put it where the file has it.
 *
 * KiCad flips a footprint about its own x axis: `FOOTPRINT::Flip` (footprint.cpp, line 3504)
 * negates the y of each pad's place in the footprint's frame, and `PAD::Flip` (pad.cpp, line
 * 1813) also negates the pad's turn within the footprint and the y of a trapezoid's delta; the
 * footprint's own turn is negated; and the footprint is on the other layer. The file stores that
 * flipped state. So a bottom pad stored at (px, py) is the library's at (px, -py), which the editor
 * (y up) has at (px, py), and the editor's bottom placement (`transformPoint`: mirror x, then
 * turn by `rot`) puts it where KiCad has it when `rot` is the footprint's angle plus 180 degrees,
 * since mirroring x is flipping about x and turning by half a turn. `placement` below does that.
 */
export function landPad(fp: KicadFootprint, pad: KicadPad, bottom: boolean): LandPad {
  const px = pad.at.x
  const py = pad.at.y
  // Top: the pad's place in the editor frame. Bottom: the library's land, which is the stored place with y as the editor has it (see above).
  const at: Vec2 = bottom ? { x: round(px), y: round(py) } : { x: round(px), y: round(-py) }
  // The pad's own turn within the footprint, as the library has it: the stored (absolute) angle minus the footprint's, and the other way round on the bottom, where `PAD::Flip` negated it.
  const r = bottom ? fp.angle - pad.angle : pad.angle - fp.angle
  const q = quarterTurns(r, Math.hypot(pad.w, pad.h) / 2)
  const swap = q === 1 || q === 3
  let lossy: string | undefined
  const note = (what: string) => (lossy ??= what)
  const w = swap ? pad.h : pad.w
  const h = swap ? pad.w : pad.h
  if (q === null) note("a pad turned by other than a quarter turn")
  const hole = pad.drill
  const base = { pin: pad.number ? pad.number : null, ...at }
  let def: PadDef
  const slotDims = hole ? (swap ? { a: hole.h, b: hole.w } : { a: hole.w, b: hole.h }) : null
  if (pad.type === "np_thru_hole") {
    const d = hole ?? { oval: false, w: Math.min(pad.w, pad.h), h: Math.min(pad.w, pad.h), offset: null }
    const dims = swap ? { a: d.h, b: d.w } : { a: d.w, b: d.h }
    if (hole?.offset) note("a hole drilled off the pad's centre")
    if (Math.abs(dims.a - dims.b) < 1e-6) def = { pin: null, shape: "circle", ...at, width: round(dims.a), height: round(dims.a), holeDiameter: round(dims.a), layer: "through", plated: false }
    else def = { pin: null, shape: "pill", ...at, width: round(dims.a), height: round(dims.b), holeDiameter: round(Math.min(dims.a, dims.b)), slotLength: round(Math.max(dims.a, dims.b)), layer: "through", plated: false }
    return { def, lossy }
  }
  const through = pad.type === "thru_hole"
  const layer: PadDef["layer"] = through ? "through" : "top"
  let holeFields: Partial<PadDef> = {}
  if (through) {
    if (!hole || slotDims === null) {
      note("a through-hole pad with no drill")
      holeFields = { holeDiameter: 0.8 }
    } else {
      if (hole.offset) note("a hole drilled off the pad's centre")
      const oval = hole.oval && Math.abs(hole.w - hole.h) > 1e-6
      holeFields = oval ? { holeDiameter: round(Math.min(slotDims.a, slotDims.b)), slotLength: round(Math.max(slotDims.a, slotDims.b)) } : { holeDiameter: round(Math.min(slotDims.a, slotDims.b)) }
      // The editor draws a slot along the pad's longer side; one across it is not representable.
      if (oval && slotDims.a >= slotDims.b !== w >= h) note("a slot across the pad's long side")
    }
  }
  if (pad.shape === "circle") {
    // A circle's diameter is the pad's size x whatever its turn (pad.cpp:1482), and a legacy board may give a circle two different sizes (pad.cpp:3126).
    def = { ...base, shape: "circle", width: round(pad.w), height: round(pad.w), layer, ...holeFields }
  } else if (pad.shape === "oval") {
    def = Math.abs(w - h) < 1e-6 ? { ...base, shape: "circle", width: round(w), height: round(w), layer, ...holeFields } : { ...base, shape: "pill", width: round(w), height: round(h), layer, ...holeFields }
  } else if (pad.shape === "trapezoid") {
    // The outline in the pad's own frame, turned by its absolute angle, placed on the board, then into the footprint's frame.
    const d = pad.rectDelta ?? { x: 0, y: 0 }
    const corners = trapezoidCorners(pad.w, pad.h, d.x, d.y)
    const centre = { x: pad.at.x, y: pad.at.y }
    const points = corners.map((c) => {
      const t = rotK(c.x, c.y, pad.angle - fp.angle)
      // t is the offset in the footprint's own (unturned) frame, y down, in the stored (flipped, on the bottom) state: the editor's y is its negative on top, and the stored y as it is on the bottom (the land is the library's, see above).
      const ey = bottom ? centre.y + t.y : -(centre.y + t.y)
      return { x: round(centre.x + t.x), y: round(ey) }
    })
    const b = emptyBox()
    for (const p of points) expandBox(b, p)
    def = { pin: base.pin, shape: "polygon", x: round((b.minX + b.maxX) / 2), y: round((b.minY + b.maxY) / 2), width: round(b.maxX - b.minX), height: round(b.maxY - b.minY), points, layer, ...holeFields }
  } else {
    // rect, roundrect (square corners here), custom (its anchor): exact for rect only
    if (pad.shape === "roundrect") note("a rounded rectangle pad")
    if (pad.shape === "custom") note("a custom shaped pad")
    if (pad.shape !== "rect" && pad.shape !== "roundrect" && pad.shape !== "custom") note(`a pad of the shape ${pad.shape}`)
    const anchorCircle = pad.shape === "custom" && pad.node.some((c) => Array.isArray(c) && c[0] === "options") && JSON.stringify(pad.node).includes('"anchor","circle"')
    def = { ...base, shape: anchorCircle ? "circle" : "rect", width: round(w), height: round(anchorCircle ? w : h), layer, ...holeFields }
  }
  return { def, lossy }
}

/** The bounds of a land's copper, grown by `margin`. */
function padBounds(pads: PadDef[], margin: number): Box {
  const b = emptyBox()
  for (const p of pads) {
    for (const q of p.points ?? [
      { x: p.x - p.width / 2, y: p.y - p.height / 2 },
      { x: p.x + p.width / 2, y: p.y + p.height / 2 },
    ]) {
      expandBox(b, q)
    }
  }
  return { minX: round(b.minX - margin), minY: round(b.minY - margin), maxX: round(b.maxX + margin), maxY: round(b.maxY + margin) }
}

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

/** The part's pins, and the notes about them. */
interface PinFacts {
  name: string
  kind: PinDef["kind"]
}

/** Where a footprint sits on the board: the editor's rotation for it (a bottom part is turned half a turn, see `landPad`). */
export function placementRotation(angle: number, bottom: boolean): Rotation {
  return ((((Math.round(angle / 90) + (bottom ? 2 : 0)) % 4) + 4) % 4) * 90 as Rotation
}

/** Board to project. Throws nothing for a board the model can hold; `lossy` names every approximation otherwise. */
export function buildKicadProject(board: KicadBoard, outline: OutlineResult, report: ImportReport, options: BuildOptions = {}): BuildResult {
  const lossy: string[] = []
  const lose = (what: string) => {
    if (!lossy.includes(what)) lossy.push(what)
  }
  const title = board.properties.find((p) => p.key === "Title")?.value
  let project: Project = createProject(options.name ?? title ?? "Imported KiCad board", "")

  // ---------- design rules ----------
  const def = board.netClasses.find((c) => c.name === "Default") ?? board.netClasses[0]
  const pick = (...values: (number | undefined)[]) => values.find((v) => v !== undefined && Number.isFinite(v))
  const rules = { ...project.rules }
  type NumericRule = "traceWidth" | "minTraceWidth" | "clearance" | "viaDiameter" | "viaDrill" | "minDrill" | "pourClearance" | "edgeClearance" | "holeClearance" | "minAnnularRing"
  const set = (key: NumericRule, value: number | undefined, allowZero = false) => {
    if (value !== undefined && Number.isFinite(value) && (allowZero ? value >= 0 : value > 0)) rules[key] = value
  }
  // The rules are the Default net class's (KiCad 4 and 5 keep it in the board); `setup` repeats the toolbar's last selections, which are not rules.
  set("traceWidth", def?.traceWidth)
  set("minTraceWidth", board.setup.trace_min)
  set("clearance", def?.clearance, true)
  set("viaDiameter", def?.viaDiameter)
  set("viaDrill", def?.viaDrill)
  set("minDrill", pick(board.setup.through_hole_min, board.setup.via_min_drill))
  set("holeClearance", board.setup.hole_to_hole_min, true)
  set("minAnnularRing", board.setup.via_min_annulus, true)
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
  const padless: string[] = []
  /** Per component: pad number -> the file's raw net name, one per pin, for the labels. */
  const padNets = new Map<string, Map<string, string>>()
  /** Per component: every numbered pad with the file's raw net name (null for none), for the check at the end, which compares pads, not pins. */
  const padFacts = new Map<string, { number: string; net: string | null }[]>()
  const modelDropped = new Map<string, { path: string; why: string; refs: string[] }>()
  const counters = new Map<string, number>()
  let withNet = 0

  // References the file gives itself are kept; the names made up for empty ones avoid them.
  const fileRefs = new Set(board.footprints.map((f) => f.ref.trim().replace(/\*/g, "")).filter(Boolean))
  const ordered = [...board.footprints].sort((a, b) => natural.compare(a.ref, b.ref))
  for (const fp of ordered) {
    if (!fp.pads.length) {
      lose("a part with no pads")
      padless.push(fp.ref || fp.name || "a footprint")
      continue
    }
    const turns = quarterTurns(fp.angle, reach(fp))
    if (turns === null) lose("a part turned by other than a quarter turn")
    const bottom = fp.side === "bottom"
    const rot = placementRotation(fp.angle, bottom)

    const pads: PadDef[] = []
    for (const p of fp.pads) {
      const lp = landPad(fp, p, bottom)
      if (lp.lossy) lose(lp.lossy)
      pads.push(lp.def)
    }
    // Pad numbers with a net, one net per number (the raw name: two names that read alike are two nets).
    const numberNet = new Map<string, string>()
    const facts: { number: string; net: string | null }[] = []
    const nets = new Map<string, Set<string | null>>()
    for (const p of fp.pads) {
      // A non-plated hole has no copper and so no pin, whatever number the file gives it.
      if (!p.number || p.type === "np_thru_hole") {
        if (p.net) lose("an unnumbered pad that carries a net")
        continue
      }
      facts.push({ number: p.number, net: p.netRaw })
      const seen = nets.get(p.number)
      if (seen) seen.add(p.netRaw)
      else nets.set(p.number, new Set([p.netRaw]))
      if (p.netRaw) {
        withNet++
        if (!numberNet.has(p.number)) numberNet.set(p.number, p.netRaw)
      }
    }
    // Pads of one number are one pin of the part, so they must agree: a net and no net is a disagreement too (X7 will give each pad its own net).
    if ([...nets.values()].some((s) => s.size > 1)) lose("pads that share a number but carry different nets, or a net and no net")

    // The model the part holds, and the land it is held with: footprints with the same pads and model share a land.
    const modelPlan = planModels(fp)
    const courtyard = padBounds(pads, 0.25)
    const land = { pads, silk: [] as Vec2[][], courtyard }
    const nameBase = fp.name.includes(":") ? fp.name.slice(fp.name.indexOf(":") + 1) : fp.name
    const landName = `${slug(nameBase || fp.ref)}-${digest(JSON.stringify(land) + modelKey(modelPlan))}`
    if (!lands.has(landName)) lands.set(landName, { name: landName, ...land })

    // The part: one per land and pin list. A pin is named by its pad's function (an overbar `~{RESET}` is `RESET#`, as the editor names an active-low pin) and typed by its pad's pin type.
    const pinNames = new Map<string, PinFacts>()
    for (const p of fp.pads) {
      if (!p.number || p.type === "np_thru_hole") continue
      const name = cleanPinName(p.pinFunction ?? "", p.number)
      const found = p.pinType === undefined ? undefined : pinKindOf(p.pinType, name)
      if (found === "unknown") lose(`a pin type that is not one of KiCad's (${p.pinType})`)
      const kind = found === "unknown" ? undefined : found
      const had = pinNames.get(p.number)
      if (!had) pinNames.set(p.number, { name, kind })
      else if (had.name !== name || had.kind !== kind) lose("pads that share a number but have different pin names or pin types")
    }
    const letters = (fp.ref.match(/^[A-Za-z]+/)?.[0] ?? "").toUpperCase().slice(0, 3)
    const prefix = letters || "U"
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
    }
    if (!spec.pins.length) {
      lose("a part with no numbered pads")
      padless.push(fp.ref || fp.name || "a footprint")
      continue
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

    const at = frameTop(fp.at)
    const component: ComponentInstance = {
      id: uid("c"),
      partId,
      ref,
      props: fp.value ? { value: fp.value } : {},
      footprint: landName,
      sch: { x: 0, y: 0, rot: 0 },
      pcb: { x: round(at.x), y: round(at.y), rot, side: bottom ? "bottom" : "top", placed: true, ...(fp.locked ? { locked: true } : {}) },
    }
    components.push(component)
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
  if (padless.length) {
    report.entries.push({ code: "padless-part", severity: "not-brought", object: `${padless.length} part${padless.length > 1 ? "s" : ""} with no pads (${padless.slice(0, 5).join(", ")}${padless.length > 5 ? "..." : ""})`, why: "A part with no numbered pads has no pins to draw. Its drawings need the graphics extension.", count: padless.length })
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
  const labelText = netLabelNames(padNets, report)
  const placed = layoutSchematic(project, padNets, labelText)
  project = placed.project

  // ---------- copper ----------
  const layerOf = (name: string) => (name === board.copper.front ? "top" : name === board.copper.back ? "bottom" : null)
  const traces = joinSegments(board, layerOf, lose)
  const vias: Via[] = board.vias.map((v) => {
    if (v.kind !== "through" || v.layers.length !== 2) lose("a blind, buried or micro via")
    return { id: uid("v"), x: round(v.at.x), y: round(-v.at.y), diameter: v.size || rules.viaDiameter, drill: v.drill || rules.viaDrill, ...(v.locked ? { locked: true } : {}) }
  })
  if (board.arcTracks.length) lose("arc tracks")
  if (board.zones.length || board.footprints.some((f) => f.zones.length)) lose("copper zones")

  // ---------- the board ----------
  let box = outline.box
  if (!box || !outline.representable) {
    lose(outline.status === "closed" ? `an outline that is ${outline.shape}` : "an outline that does not close")
    if (!box) {
      const b = emptyBox()
      for (const c of components) expandBox(b, c.pcb, 5)
      for (const piece of edgePieces(board)) for (const [x, y] of piece.pts) expandBox(b, { x, y: -y })
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
    },
    traces,
    vias,
    properties,
  }

  // ---------- every pad on the net the file gives it ----------
  const nets = verifyNets(project, padFacts, labelText, report)
  const pins = components.reduce((n, c) => n + (padNets.get(c.id)?.size ?? 0), 0)
  return { project, lossy, stats: { parts: components.length, lands: lands.size, pins, nets, padsWithNet: withNet } }
}

// ---------- nets ----------

/**
 * The text of the label for each net of the file, by the net's raw name (the file's spelling, which
 * is its identity: `/A/B` and `/A{slash}B` are two nets even though they read alike). The label reads
 * as the user reads the net, `{slash}` as `/` and trimmed, since that is how the editor compares
 * labels; two nets that would read the same keep distinct labels: the one the file spells as it reads
 * keeps the text, the other keeps its raw spelling (and a number if even that is taken).
 */
export function netLabelNames(padNets: Map<string, Map<string, string>>, report: ImportReport): Map<string, string> {
  const used = new Set<string>()
  const out = new Map<string, string>()
  const altered: string[] = []
  const names = new Set<string>()
  for (const m of padNets.values()) for (const n of m.values()) names.add(n)
  // A name the file spells as it reads goes first, so a collision never changes the name of a net that needs no decoding.
  const plain = (raw: string) => decodeNetName(raw) === raw
  const ordered = [...names].sort((a, b) => Number(plain(b)) - Number(plain(a)) || (a < b ? -1 : a > b ? 1 : 0))
  for (const raw of ordered) {
    let text = decodeNetName(raw).trim()
    if (!text || used.has(text)) {
      const fallback = raw.trim()
      text = fallback && !used.has(fallback) ? fallback : `${fallback || "NET"} (${used.size + 1})`
      altered.push(`${raw || "(empty)"} as ${text}`)
    }
    used.add(text)
    out.set(raw, text)
  }
  if (altered.length) report.entries.push({ code: "renamed-net", severity: "changed", object: `${altered.length} net${altered.length > 1 ? "s" : ""} (${altered.slice(0, 5).join("; ")})`, why: "Two nets read the same once their names are trimmed and decoded, or a name was empty, so the second keeps its raw spelling.", count: altered.length })
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
 * they can only agree; a board with pads that disagree is not imported (X7). Returns the number of nets.
 */
function verifyNets(project: Project, padFacts: Map<string, { number: string; net: string | null }[]>, labelText: Map<string, string>, report: ImportReport): number {
  const { pinNet } = computeConnectivity(project)
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
  return netOfName.size
}

// ---------- tracks ----------

/** Segments of one net, layer and width that meet end to end, as polylines. */
function joinSegments(board: KicadBoard, layerOf: (name: string) => "top" | "bottom" | null, lose: (what: string) => void): Trace[] {
  const traces: Trace[] = []
  const groups = new Map<string, typeof board.segments>()
  for (const s of board.segments) {
    const layer = layerOf(s.layer)
    if (!layer) {
      lose(`a track on ${s.layer}`)
      continue
    }
    const key = `${layer}|${s.width}|${s.net ?? ""}|${s.locked ? 1 : 0}`
    const g = groups.get(key)
    if (g) g.push(s)
    else groups.set(key, [s])
  }
  const k = (p: { x: number; y: number }) => `${Math.round(p.x * 1e4)},${Math.round(p.y * 1e4)}`
  for (const [key, segs] of groups) {
    const [layer, width, , locked] = key.split("|")
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
      let i = first
      let head = from
      for (;;) {
        used[i] = true
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
      return pts
    }
    // Chains start at an end that is not shared by exactly two segments; what is left is a loop.
    const starts: [number, "start" | "end"][] = []
    segs.forEach((s, i) => {
      if ((at.get(k(s.start)) ?? []).length !== 2) starts.push([i, "start"])
      if ((at.get(k(s.end)) ?? []).length !== 2) starts.push([i, "end"])
    })
    for (const [i, head] of starts) if (!used[i]) traces.push({ id: uid("t"), layer: layer as "top" | "bottom", width: Number(width), points: walk(i, head).map((p) => ({ x: round(p.x), y: round(-p.y) })), ...(locked === "1" ? { locked: true } : {}) })
    segs.forEach((_, i) => {
      if (!used[i]) traces.push({ id: uid("t"), layer: layer as "top" | "bottom", width: Number(width), points: walk(i, "start").map((p) => ({ x: round(p.x), y: round(-p.y) })), ...(locked === "1" ? { locked: true } : {}) })
    })
  }
  return traces
}

