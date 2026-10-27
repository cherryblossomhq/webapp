import { ruleFor } from "./account"
import { landPad } from "./build"
import { netClassIsPlain, settledFor, settledSetup } from "./carried"
import { quarterTurns } from "./geometry"
import { zoneOnlyCopper } from "./zones"
import { NEGLIGIBLE_WIDTH } from "./graphics"
import { KICAD_FONT_NAME } from "./texts"
import { hasExpression, textVariables, UNSUPPORTED_VARIABLES } from "../../texts"
import { numAt, type List } from "./sexpr"
import { ZERO_MEANS_INHERIT_UNTIL } from "./read"
import type { OutlineResult } from "./outline"
import type { KicadBoard, KicadFootprint, KicadPad } from "./types"

// What a board needs from the editor's model that the model does not have, extension by
// extension (X1 to X23 of docs/kicad-import.md). A board that needs an extension that is not built
// is refused with "this board uses X, which is not supported yet", never imported lossy.
// The rules are the ones of `tests/kicad-census/slices.mjs`, which the census judged the plan by,
// with the differences named in `Need.source`.

/** The extensions the editor has built. Each slice adds its own: 1a built none, 1b-i built X13 (nets on tracks and vias) and X15 (part flags and net ties), 1b-ii X8 (board and footprint drawings), 1b-iii X9 (text objects), the board objects slice X11 (dimensions), X12 (groups) and X14 (reference images), the zones slice X3, slice X7 the pad model, X29 (zones on layers that are not copper), X30 (zones inside parts) and X31 (the layers a pour joins a pad on). */
export const BUILT_EXTENSIONS: ReadonlySet<string> = new Set(["X1", "X2", "X3", "X4", "X5", "X6", "X7", "X8", "X9", "X10", "X11", "X12", "X13", "X14", "X15", "X29", "X30", "X31"])

/** What each extension is, for the sentence "This board uses ..., which is not supported yet." */
export const EXTENSION_NAMES: Record<string, string> = {
  X1: "more than two copper layers, a stackup, pad stacks (a pad with a shape on each copper layer), or pads that drop their copper on layers nothing connects to",
  X2: "an outline that is not a plain or rounded rectangle, a cutout, or an outline that is not closed",
  X3: "copper zones, keepouts or teardrops",
  X29: "filled zones on layers that are not copper (solder mask, paste, silkscreen or user layers)",
  X30: "zones that belong to a part (a keepout or a pour drawn inside a footprint)",
  X31: "a pad that joins a pour on some copper layers and not others",
  X4: "arc tracks",
  X5: "blind, buried or micro vias, via stacks, or a pad that tents or opens its own solder mask",
  X6: "parts turned by other than a quarter turn",
  X7: "pads that are turned, rounded, custom, drilled off centre, on layers the editor does not draw, or have their own margins or their own nets",
  X8: "drawings beyond the editor's silkscreen lines, or parts with no pads",
  X9: "text objects",
  X10: "net classes and design rules beyond the defaults",
  X11: "dimensions",
  X12: "groups",
  X13: "nets on tracks and vias",
  X14: "reference images",
  X15: "part flags and net ties",
  X19: "text in a font other than KiCad's own, text outlines or embedded fonts",
  X20: "placement rule areas or component classes",
  X21: "tuning patterns or pad lengths",
  X22: "via protection, backdrill or post-machining",
  X23: "variants, units or points",
  X25: "tables, barcodes, drill charts, text boxes inside footprints, text with expressions or variables the editor cannot resolve",
  X26: "a creepage rule (KiCad 10's minimum creepage distance), which Checks cannot test yet",
  X27: "dimensions inside footprints",
  X28: "reference images in a format other than PNG or JPEG",
  X24: "hatched fills, line end shapes, colours on drawings, filled drawings with a negative width, or tracks exposed through the solder mask",
}

export interface Need {
  ext: string
  /** What in the board needs it, in words. */
  why: string
  /** `slices` when the census's rule found it; `importer` when the importer found it on top of those rules. */
  source: "slices" | "importer"
}

const COPPER_LAYER_NAME = /\.Cu$/

/** Which of KiCad's layer classes a layer is on, for telling copper graphics from silkscreen. */
export function layerClass(name: string, copperNames: ReadonlySet<string>): string {
  if (!name) return "none"
  if (name === "Edge.Cuts") return "edge"
  if (copperNames.has(name)) return "copper"
  if (/Silk/.test(name)) return "silk"
  if (/\.Fab$/.test(name)) return "fab"
  if (/CrtYd|Courtyard/.test(name)) return "court"
  if (/\.Mask$/.test(name)) return "mask"
  if (/\.Paste$/.test(name)) return "paste"
  if (/\.Cu$/.test(name)) return "copper"
  if (/Adhes/.test(name)) return "adhes"
  if (/User|Eco|Margin/.test(name)) return "user"
  return "other"
}

/** What side of its footprint a pad has copper on: front, back, both, or none (the footprint's side is `fp.side`). */
export function padCopperSide(pad: KicadPad, board: KicadBoard): "F" | "B" | "both" | "none" {
  const hasF = pad.layers.some((n) => n === board.copper.front || n === "*.Cu" || n === "F&B.Cu")
  const hasB = pad.layers.some((n) => n === board.copper.back || n === "*.Cu" || n === "F&B.Cu")
  return hasF && hasB ? "both" : hasF ? "F" : hasB ? "B" : "none"
}

export type Face = "F" | "B"

/** The layers of a pad's `(layers ...)`, by kind. Copper layers are named in the board's layer table (`Front`, `Top`), mask and paste are KiCad's own. */
export interface PadLayers {
  copper: Set<Face>
  mask: Set<Face>
  paste: Set<Face>
  silk: boolean
  /** An inner copper layer (X1 finds it as well). */
  inner: boolean
  /** Any other layer: fabrication, courtyard, drawing, adhesive. */
  other: string[]
}

export function padLayers(pad: KicadPad, board: KicadBoard): PadLayers {
  const out: PadLayers = { copper: new Set(), mask: new Set(), paste: new Set(), silk: false, inner: false, other: [] }
  const both = (set: Set<Face>) => {
    set.add("F")
    set.add("B")
  }
  for (const n of pad.layers) {
    if (n === board.copper.front || n === "F.Cu") out.copper.add("F")
    else if (n === board.copper.back || n === "B.Cu") out.copper.add("B")
    else if (n === "*.Cu" || n === "F&B.Cu") both(out.copper)
    else if (n === "F.Mask") out.mask.add("F")
    else if (n === "B.Mask") out.mask.add("B")
    else if (n === "*.Mask") both(out.mask)
    else if (n === "F.Paste") out.paste.add("F")
    else if (n === "B.Paste") out.paste.add("B")
    else if (n === "*.Paste") both(out.paste)
    else if (n === "F.SilkS" || n === "B.SilkS" || n === "*.SilkS") out.silk = true
    else if (COPPER_LAYER_NAME.test(n) || board.copper.names.includes(n)) out.inner = true
    else out.other.push(n)
  }
  return out
}

/**
 * The layers the editor gives a pad of this type on this side (`gerber.ts`, `padsOn`): a surface-mount
 * or connector pad has copper, mask and paste on its part's side; a through-hole pad has copper and
 * mask on both and no paste; a non-plated hole has mask on both and no copper.
 */
export function editorPadLayers(pad: KicadPad, fp: KicadFootprint): { copper: Set<Face>; mask: Set<Face>; paste: Set<Face> } {
  const side: Face = fp.side === "bottom" ? "B" : "F"
  const both = new Set<Face>(["F", "B"])
  const smdLike = pad.type === "smd" || pad.type === "connect"
  if (smdLike) return { copper: new Set([side]), mask: new Set([side]), paste: new Set([side]) }
  if (pad.type === "np_thru_hole") return { copper: new Set(), mask: both, paste: new Set() }
  return { copper: both, mask: new Set(both), paste: new Set() }
}

const sameSet = (a: Set<Face>, b: Set<Face>) => a.size === b.size && [...a].every((x) => b.has(x))

const PAD_OVERRIDES = ["solder_mask_margin", "solder_paste_margin", "solder_paste_margin_ratio", "clearance", "zone_connect", "thermal_gap", "thermal_width", "thermal_bridge_width", "padstack", "remove_unused_layers"]
/** The margins and clearances for which a zero means "inherit" in files up to stamp 20240201 (switch 8). */
const ZERO_INHERITS = new Set(["solder_mask_margin", "solder_paste_margin", "solder_paste_margin_ratio", "clearance"])

export interface NeedsOptions {
  /** Count a zero margin as an override in every version, as the census's rules do; for comparing with them. */
  zeroMarginsAreOverrides?: boolean
}

/** Whether a pad or footprint sets `name`, a zero in an old file being no setting at all. */
function sets(node: List, name: string, stamp: number | null, opts: NeedsOptions): boolean {
  const c = node.find((x): x is List => Array.isArray(x) && x[0] === name)
  if (!c) return false
  const inherits = !opts.zeroMarginsAreOverrides && ZERO_INHERITS.has(name) && stamp !== null && stamp <= ZERO_MEANS_INHERIT_UNTIL
  return !(inherits && numAt(c, 1, NaN) === 0)
}

/** The reasons only the importer finds (the census's rules do not list them). */
const MASK_REASON = "a pad whose solder mask opening is not the editor's (the editor opens the mask over every pad, on both sides of a hole and on a surface-mount pad's own side)"
const PASTE_REASON = "a pad whose solder paste is not the editor's (the editor puts paste on every surface-mount pad's own side and nowhere else)"
const OTHER_LAYER_REASON = "a pad on a layer other than copper, mask, paste or silkscreen"
const SILK_REASON = "a pad plotted on the silkscreen"
const NPTH_REASON = "a non-plated hole whose pad is larger than its drill (copper or a mask opening around the hole)"
const SHARED_NET_REASON = "pads that share a number but carry different nets, or a net and no net"
const SHARED_NAME_REASON = "pads that share a number but have different pin names or pin types"
const IMPORTER_ONLY = [
  "a through-hole pad with copper on one side only",
  "an SMD pad with copper on both sides",
  NPTH_REASON,
  "a slot across the pad's long side",
  "a through-hole pad with no drill",
  MASK_REASON,
  PASTE_REASON,
  OTHER_LAYER_REASON,
  SILK_REASON,
  SHARED_NET_REASON,
  SHARED_NAME_REASON,
]

function padNeeds(fp: KicadFootprint, p: KicadPad, board: KicadBoard, why: Map<string, string>, opts: NeedsOptions) {
  const where = `${fp.ref || fp.name || "a footprint"}, pad ${p.number || "(no number)"}`
  const need = (reason: string) => why.has(reason) || why.set(reason, where)
  // A pad's stored angle is the board's, so its turn within the part is the difference (the other way round on the bottom, where the flip negated it, `landPad`): a pad that is the part's own turn is no turn of its own, whatever the part's angle.
  if (quarterTurns(fp.side === "bottom" ? fp.angle - p.angle : p.angle - fp.angle, Math.hypot(p.w, p.h) / 2) === null) need("a pad turned by other than a quarter turn")
  if (p.shape === "roundrect") need("a rounded rectangle pad")
  if (p.shape === "custom") need("a custom shaped pad")
  if (p.node.some((c) => Array.isArray(c) && c[0] === "chamfer")) need("a chamfered pad")
  if (p.drill?.offset) need("a hole drilled off the pad's centre")
  const layers = padLayers(p, board)
  const side = padCopperSide(p, board)
  const smdLike = p.type === "smd" || p.type === "connect"
  if (smdLike && side !== "none" && side !== (fp.side === "bottom" ? "B" : "F")) need("an SMD pad on the other side of its part")
  if (p.type !== "np_thru_hole" && side === "none") need("a pad with no copper layer")
  for (const f of PAD_OVERRIDES) if (sets(p.node, f, board.version, opts)) need("a pad with its own margin, clearance or zone connection")
  if (p.node.some((c) => Array.isArray(c) && c[0] === "property")) need("a pad with fabrication properties")
  // The importer's own additions: what the model cannot hold that the census rules did not list.
  if (p.type === "thru_hole" && side !== "both") need("a through-hole pad with copper on one side only")
  if (smdLike && side === "both") need("an SMD pad with copper on both sides")
  if (p.type === "np_thru_hole" && p.drill && (p.w > p.drill.w + 1e-6 || p.h > p.drill.h + 1e-6)) need(NPTH_REASON)
  // The layers of the pad against what the editor draws for its type and side: copper is checked above, mask and paste here.
  const want = editorPadLayers(p, fp)
  if (!sameSet(layers.mask, want.mask)) need(MASK_REASON)
  if (!sameSet(layers.paste, want.paste)) need(PASTE_REASON)
  if (layers.other.length) need(OTHER_LAYER_REASON)
  if (layers.silk && board.padsOnSilk) need(SILK_REASON)
  // Whatever else the land conversion cannot hold exactly: a slot across the pad, a hole with no drill, a shape it does not know.
  const lossy = landPad(fp, p, fp.side === "bottom").lossy
  if (lossy) need(lossy)
}

/** Pads of one number are one pin of the generated part: they must agree on net, name and type. */
function sharedNumberNeeds(fp: KicadFootprint, why: Map<string, string>) {
  const by = new Map<string, KicadPad[]>()
  for (const p of fp.pads) {
    if (!p.number || p.type === "np_thru_hole") continue
    const list = by.get(p.number)
    if (list) list.push(p)
    else by.set(p.number, [p])
  }
  for (const [number, pads] of by) {
    if (pads.length < 2) continue
    const where = `${fp.ref || fp.name || "a footprint"}, pad ${number}`
    if (new Set(pads.map((p) => p.netRaw)).size > 1) why.has(SHARED_NET_REASON) || why.set(SHARED_NET_REASON, where)
    if (new Set(pads.map((p) => p.pinFunction ?? "")).size > 1 || new Set(pads.map((p) => p.pinType ?? "")).size > 1) why.has(SHARED_NAME_REASON) || why.set(SHARED_NAME_REASON, where)
  }
}

/** The first text of the board that is an expression, or uses a variable KiCad resolves from somewhere a board file is not (the clock, the footprint's library entry, the nets), as words; null when none does. */
function textNeedsX25(board: KicadBoard): string | null {
  const fieldNames = (fp: KicadFootprint) => new Set(fp.props.map((p) => p.key))
  const check = (text: string, fp: KicadFootprint | null): string | null => {
    if (hasExpression(text)) return `text with an expression @{...} (${JSON.stringify(text.slice(0, 40))})`
    for (const token of textVariables(text)) {
      if (UNSUPPORTED_VARIABLES.test(token)) return `text that uses the variable \${${token}}, which KiCad resolves from the footprint's library entry, the nets or the clock`
      // A footprint's own field (Datasheet, a user field) that is not the reference or the value
      if (fp && token !== "REFERENCE" && token !== "VALUE" && fieldNames(fp).has(token)) return `text that uses the part's field \${${token}}`
    }
    return null
  }
  for (const t of board.texts) {
    const why = check(t.text, null)
    if (why) return why
  }
  for (const fp of board.footprints) {
    for (const t of fp.texts) {
      const why = check(t.text, fp)
      if (why) return `${why} (${fp.ref || fp.name})`
    }
  }
  return null
}

/** Every extension this board needs that the model does not have, with the reason. Order is by extension number. */
export function needsOf(board: KicadBoard, account: { paths: ReadonlyMap<string, number> }, outline: OutlineResult, opts: NeedsOptions = {}): Need[] {
  const out = new Map<string, Need>()
  const need = (ext: string, why: string, source: Need["source"] = "slices") => {
    if (!out.has(ext)) out.set(ext, { ext, why, source })
  }
  const has = (re: RegExp) => {
    for (const path of account.paths.keys()) if (re.test(path.replace(/^module(?=$|>)/, "footprint"))) return true
    return false
  }
  const copperSet = new Set(board.copper.names)

  // copper layers
  const undeclared = new Set<string>()
  const mark = (names: string[]) => {
    for (const n of names) {
      if (n === "*.Cu" || n === "F&B.Cu" || copperSet.has(n)) continue
      if (COPPER_LAYER_NAME.test(n) || /^Inner\d+\.Cu$/.test(n)) undeclared.add(n)
    }
  }
  for (const s of board.segments) mark([s.layer])
  for (const s of board.arcTracks) mark([s.layer])
  for (const v of board.vias) mark(v.layers)
  for (const z of board.zones) mark(z.layers)
  for (const s of board.shapes) mark(s.layers)
  for (const t of board.targets) mark([t.layer])
  for (const t of board.texts) mark([t.layer])
  for (const fp of board.footprints) {
    for (const z of fp.zones) mark(z.layers)
    for (const p of fp.pads) mark(p.layers)
    for (const s of fp.shapes) mark(s.layers)
    for (const t of fp.texts) mark([t.layer])
  }
  if (board.copperLayerCount > 2 || undeclared.size) need("X1", `${board.copperLayerCount} copper layers${undeclared.size ? `, and copper on ${[...undeclared].join(", ")}, which the layer table lacks` : ""}`)

  // outline (the founder's decision: an open or missing outline is imported, so it needs X2, it is not refused)
  if (outline.status !== "closed") need("X2", outline.status === "no outline" ? "no outline on Edge.Cuts" : "an outline that does not close")
  else if (!outline.representable) need("X2", `an outline that is ${outline.shape}${outline.cutouts ? " with cutouts" : ""}`)

  // X3 (zones) is built: a copper zone, a keepout, a rule area or a teardrop zone of the board is imported (and named here, as every extension a board uses is, built or not). What is left of it is named.
  const zoneCount = board.zones.length + board.footprints.reduce((n, f) => n + f.zones.length, 0)
  if (zoneCount > 0) need("X3", "copper zones, keepouts or rule areas")
  if (board.zones.some((z) => z.kind === "teardrop")) need("X3", "teardrops")
  if (board.zones.some((z) => z.kind !== "placement" && z.fillMode !== "polygon")) need("X24", "a zone filled with a hatch or a thieving pattern", "importer")
  if (board.zones.some((z) => z.kind !== "placement" && !zoneOnlyCopper(z, board))) need("X29", "a zone on a layer that is not copper (mask, paste, silkscreen or a user layer)", "importer")
  if (board.footprints.some((f) => f.zones.length)) need("X30", "a zone that belongs to a part (a keepout or pour drawn inside a footprint)", "importer")
  if (board.arcTracks.length > 0) need("X4", "arc tracks")
  const frontBack = (layers: string[]) => layers.includes(board.copper.front) && layers.includes(board.copper.back)
  if (board.vias.some((v) => v.kind !== "through" || (v.layers.length === 2 && !frontBack(v.layers))) || has(/^via>(free|tenting|remove_unused_layers|keep_end_layers|padstack)/)) need("X5", "blind, buried or micro vias, or via stacks")

  // What a KiCad 9 pad can say that the pad model has no place for yet: a shape for each copper layer (X1), copper dropped on a layer nothing connects to (X1: on a
  // two layer board only a pad with `remove_unused_layers` and no `keep_end_layers` loses any, an outer layer's), a pour's connection per layer (X3), and its own tenting of the mask (X5).
  const pads = board.footprints.flatMap((f) => f.pads)
  if (pads.some((p) => p.padstack)) need("X1", "a pad with a shape on each copper layer (a KiCad 9 pad stack)", "importer")
  if (pads.some((p) => p.type === "thru_hole" && p.removeUnused === true && p.keepEnds !== true)) need("X1", "a through-hole pad that drops its copper on layers nothing connects to", "importer")
  if (pads.some((p) => p.zoneLayers)) need("X31", "a pad that joins a pour on some copper layers and not others", "importer")
  if (pads.some((p) => p.tented)) need("X5", "a pad that tents or opens its own solder mask", "importer")

  const why = new Map<string, string>()
  for (const fp of board.footprints) {
    for (const p of fp.pads) padNeeds(fp, p, board, why, opts)
    sharedNumberNeeds(fp, why)
  }
  if (board.footprints.some((f) => ["clearance", "solder_mask_margin", "solder_paste_margin", "solder_paste_margin_ratio", "zone_connect"].some((n) => sets(f.node, n, board.version, opts)))) why.set("a part with its own margin, clearance or zone connection", "footprint")
  if (has(/^footprint>pad>property/)) why.set("a pad with fabrication properties", "footprint")
  // pads the census rules listed are `slices`; the importer's three additions are named as such
  const sliceReasons = [...why.keys()].filter((r) => !IMPORTER_ONLY.includes(r) && !r.startsWith("a pad of the shape"))
  if (sliceReasons.length) need("X7", `${sliceReasons[0]}${sliceReasons.length > 1 ? ` and ${sliceReasons.length - 1} more kind${sliceReasons.length > 2 ? "s" : ""}` : ""}`)
  else if (why.size) need("X7", [...why.keys()][0], "importer")

  const shapeGfx = (shapes: { kind: string; layer: string }[]) => shapes.some((s) => ["line", "arc", "circle", "rect", "poly", "curve"].includes(s.kind) && layerClass(s.layer, copperSet) !== "edge")
  if (shapeGfx(board.shapes) || board.footprints.some((f) => shapeGfx(f.shapes)) || board.footprints.some((f) => f.pads.length === 0) || has(/^target/)) need("X8", "drawings beyond the editor's silkscreen lines, or parts with no pads")
  // A part is its pins: one whose pads are all unnumbered (a mounting hole) has none to draw, which X8's graphics-only parts will.
  else if (board.footprints.some((f) => !f.pads.some((p) => p.number !== "" && p.type !== "np_thru_hole"))) need("X8", "a part with no numbered pads, such as a mounting hole", "importer")
  // X24: what KiCad 9 and 10 add to a drawing that the editor's shapes do not hold (the nodes of line ends, colours and track mask openings are found by the table below).
  const allShapes = [...board.shapes, ...board.footprints.flatMap((f) => f.shapes)]
  if (allShapes.some((s) => s.hatched && layerClass(s.layer, copperSet) !== "edge")) need("X24", "a drawing filled with a hatch", "importer")
  // A filled drawing whose stroke width is negative shrinks its fill when KiCad plots it (`PlotShape`: the polygon is inflated by half the negative width, a circle's diameter is cut by it; plot_brditems_plotter.cpp, lines 948-951, 1040-1046 and 1170-1173), which the model's widths (never negative) cannot say. A nanometre of it (-0.000001 in one corpus file) is no width at all, as before.
  if (allShapes.some((s) => s.filled && s.width <= -NEGLIGIBLE_WIDTH && ["rect", "bbox", "circle", "poly", "ellipse"].includes(s.kind) && layerClass(s.layer, copperSet) !== "edge")) need("X24", "a filled drawing with a negative width, which shrinks its fill", "importer")
  if (board.footprints.length > 0 || has(/^gr_text/)) need("X9", "the reference and value text of every part, and board text")
  if (!netClassIsPlain(board)) need("X10", "net classes beyond the default, or a default class with a name or description of its own")
  // A through hole's and a via's smallest drill are two rules; the design rules hold one.
  const { through_hole_min: holeMin, via_min_drill: viaMin } = board.setup
  if (holeMin !== undefined && viaMin !== undefined && Math.abs(holeMin - viaMin) > 1e-9) need("X10", "two different smallest drill sizes (a through hole's and a via's)", "importer")
  if (has(/^(footprint>)?dimension$/)) need("X11", "dimensions")
  // A footprint's own dimension moves, turns and flips with its part by KiCad's rules for the part (the text's side of the crossbar does not follow a mirror), which the model does not hold yet.
  if (has(/^footprint>dimension$/)) need("X27", "a dimension inside a footprint", "importer")
  if (has(/^(footprint>)?group$/)) need("X12", "groups")
  if (board.images.some((m) => m.format === null)) need("X28", "a reference image that is neither a PNG nor a JPEG", "importer")
  if (board.segments.length + board.vias.length > 0) need("X13", "tracks and vias that carry a net in the file")
  if (has(/^image$/)) need("X14", "a reference image")
  if (board.footprints.some((f) => f.attr.some((a) => !["smd", "through_hole"].includes(a))) || has(/^footprint>(net_tie_pad_groups|jumper_pad_groups|duplicate_pad_numbers_are_jumpers)/) || board.footprints.some((f) => f.netTies.length)) need("X15", "part flags (virtual, board only, not in the BOM or position files, do not populate) or net ties")
  if (has(/render_cache$/) || has(/^(footprint>)?embedded_fonts$/)) need("X19", "text outlines or embedded fonts")
  // Text in a font of the user's computer (`face`) is drawn by that font, which the editor does not have: X19, named.
  const outlineFonts = [...new Set([...board.texts, ...board.footprints.flatMap((f) => f.texts)].filter((t) => t.face !== null && !t.face.startsWith(KICAD_FONT_NAME)).map((t) => t.face!))]
  if (outlineFonts.length) need("X19", `text in the font${outlineFonts.length > 1 ? "s" : ""} ${outlineFonts.slice(0, 3).join(", ")}${outlineFonts.length > 3 ? " and more" : ""}, not KiCad's stroke font`, "importer")
  // X25: what X9 does not build, named. Tables, barcodes and drill charts, a text box inside a footprint, a box that is an outline of points, text that is an expression, and variables KiCad resolves from places a board file does not have.
  if (has(/^(footprint>)?(table|barcode|drill_chart|drill_map)(>|$)/)) need("X25", "tables, barcodes or drill charts")
  else if (has(/^footprint>fp_text_box(>|$)/)) need("X25", "a text box inside a footprint", "importer")
  else if (has(/^gr_text_box>pts(>|$)/)) need("X25", "a text box that is an outline of points", "importer")
  else {
    const hard = textNeedsX25(board)
    if (hard) need("X25", hard, "importer")
  }
  // A rule area whose placement is switched off (what KiCad 9 writes on every keepout) places nothing; one that is on is X20.
  if (board.zones.some((z) => z.kind === "placement") || board.footprints.some((f) => f.zones.some((z) => z.kind === "placement")) || has(/^footprint>component_classes$/)) need("X20", "placement rule areas or component classes")
  if (has(/^generated$/) || has(/^footprint>pad>(die_length|die_delay)$/)) need("X21", "tuning patterns or pad lengths")
  if (has(/^via>(capping|covering|plugging|filling|backdrill|tertiary_drill)/) || has(/^footprint>pad>(backdrill|tertiary_drill|front_post_machining|back_post_machining)/)) need("X22", "via protection or backdrill")
  if (has(/^(variants|footprint>variant|footprint>units|footprint>point)/)) need("X23", "variants, units or points")

  // The importer's own addition: a pad that carries a net but has no number has no pin to carry it on.
  if (board.footprints.some((f) => f.pads.some((p) => (p.number === "" || p.type === "np_thru_hole") && p.net !== null))) need("X7", "an unnumbered pad that carries a net", "importer")

  // Every other `extend` node of the table stands for something the model must grow to hold; a board with one is not imported until it has.
  // Settings in `setup` that equal KiCad's own default, or that the rules have a field for, hold nothing to lose.
  const setupOk = settledSetup(board)
  for (const path of account.paths.keys()) {
    const rule = ruleFor(path)
    if (rule?.decision !== "extend" || !rule.ext || out.has(rule.ext)) continue
    const p = path.replace(/^module(?=$|>)/, "footprint")
    if (settledFor(p) || p === "layers" || p === "layers><layer number>") continue
    const top = /^setup>[^>]+/.exec(p)?.[0]
    if (top && setupOk.has(top)) continue
    need(rule.ext, `the node "${path}"`, "importer")
  }
  return [...out.values()].sort((a, b) => Number(a.ext.slice(1)) - Number(b.ext.slice(1)))
}

/** The extensions a board needs that are not built. */
export const unbuilt = (needs: Need[], built: ReadonlySet<string> = BUILT_EXTENSIONS) => needs.filter((n) => !built.has(n.ext))

/** "This board uses A, B and C, which are not supported yet." */
export function refusalMessage(needs: Need[]): string {
  const names = needs.map((n) => EXTENSION_NAMES[n.ext] ?? n.ext)
  const list = names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`
  return `This board uses ${list}, which ${names.length === 1 ? "is" : "are"} not supported yet.`
}
