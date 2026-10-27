import { TRANSLATED_LAYER_NAMES } from "./graphics"
import { defaultClassOf, derivedClassNodes } from "./netClassImport"
import { buildStack } from "./layers"
import type { KicadBoard } from "./types"
import { kid, numAt, strAt, type List } from "./sexpr"

// What the project builder (`build.ts`) does with the nodes the decision table gives an extension
// but that need none once the board is plain. For such a node the accounting says one of two
// things, and only these two count it as handled:
//
//   built    the builder writes it into the project (a pad's place and size, the outline's geometry,
//            the design rules a net class holds)
//   derived  it says only what the editor works out for itself, and the reason says what; every
//            board is checked for the one thing that would make it more (`needs.ts`): a pad whose
//            layers differ from what the editor draws, a setting that is not KiCad's default
//
// A `native` node of the table is `built` by definition (the table is pinned to this file by
// `tests/kicad-board-import.test.ts`, which builds a board and looks for every node counted as
// imported). A node of neither kind is imported only once its extension is built.

export interface Settled {
  how: "built" | "derived"
  /** For `derived`: what the editor does instead. */
  reason?: string
  /** For `derived`: how many of the nodes at this path it holds for (the others are built); absent for all of them. */
  derived?: number
}

const COPPER_ROW = new Set(["signal", "power", "mixed", "jumper"])

const SHAPES = "(?:gr_|footprint>fp_)(?:line|arc|circle|rect|poly|curve|ellipse|ellipse_arc)"

const row = (source: string, how: Settled["how"], reason?: string, scope?: "edge" | "net" | "classes") => ({ re: new RegExp(`^(?:${source})$`), how, ...(reason ? { reason } : {}), ...(scope ? { scope } : {}) })

const ROWS = [
  row("footprint>at", "built"),
  row("footprint>pad|footprint>pad>(?:at|size|drill|rect_delta)", "built"),
  row("via>layers", "built"),
  // Drawings on Edge.Cuts are the outline (`outline.ts`), which is cut along a line's centre whatever its width, style or fill; a drawing on any other
  // layer is X8: its geometry, width, dash, fill, lock and net are written into the project (`graphics.ts`), a `target` mark as its circle and two lines.
  row(`${SHAPES}|${SHAPES}>(?:start|end|mid|center|layer|layers|pts|pts>xy|pts>arc|pts>arc>(?:start|mid|end)|angle|radius|major_radius|minor_radius|rotation_angle|start_angle|end_angle|solder_mask_margin)`, "built"),
  // Only copper has a net: the net of a drawing on any other layer means nothing (KiCad loads it, even with a number its table lacks) and is not brought; on copper it is written (a number the table lacks is no net, and says so).
  row(`${SHAPES}>net`, "derived", "the net a drawing names when it is not on a copper layer: only copper has a net, and KiCad draws and plots it the same without", "net"),
  row(`${SHAPES}>(?:stroke|stroke>(?:type|width)|width|fill|locked)`, "derived", "the width and style of an outline line: the board is cut along the line's centre", "edge"),
  row("target|target>(?:at|layer|size|width)", "built"),
  // Dimensions (X11), groups (X12) and reference images (X14) are built. KiCad does not read a KiCad 5 dimension's arrows (`parseDIMENSION`: "no longer saved; no-op"): it draws its own from the points, the height and the arrow length.
  row("dimension>arrow[12][ab]|dimension>arrow[12][ab]>pts|dimension>arrow[12][ab]>pts>xy", "derived", "a KiCad 5 dimension's arrows: KiCad does not read them and draws its own"),
  row("dimension>gr_text>effects>hide", "derived", "KiCad draws a board text whatever the file says: hidden board text is no longer supported (`parsePCB_TEXT` makes it visible, parser line 4503), and a dimension's text is a board text"),
  // Net classes (X10) are written into `DesignRules` (`netClassImport.ts`): the Default class's four sizes are the rules, every other class is a `NetClass`
  // with its nets and sizes, and a differential pair rule or a description of the Default class's own is `defaultClass`. What is derived is what says nothing:
  // a Default class with nothing of its own, the nets listed in the Default class (every net no other class lists is in it), and a micro via size that is
  // KiCad's own default or the Default class's (`derivedClassNodes` counts them from the board).
  row("net_class>(?:clearance|trace_width|via_dia|via_drill|diff_pair_width|diff_pair_gap)", "built"),
  row("net_class", "derived", "the Default net class with nothing of its own: its name and description are KiCad's own, and its clearance, track width and via size are the design rules, which are imported", "classes"),
  row("net_class>add_net", "derived", "the nets of the Default net class: every net that no other class lists is in it, so listing them says nothing", "classes"),
  row("net_class>(?:uvia_dia|uvia_drill)", "derived", "a micro via size that is KiCad's own default for the Default class, or the Default class's for another: the class that does not mention it has the same", "classes"),
  // X15 and X13 are built: the flags, the net tie and jumper groups, and the net of each track and via are written into the project.
  row("footprint>attr|footprint>net_tie_pad_groups|footprint>duplicate_pad_numbers_are_jumpers|footprint>jumper_pad_groups(?:><layer number>|>[^>]+)?", "built"),
  row("(?:segment|arc|via)>net", "built"),
  // Text (X9) is built: its place, layer, size, pen, justification, mirror, flags and content are written into the project. A board text cannot be hidden in KiCad.
  row("(?:gr_text|gr_text_box)>effects>hide", "derived", "KiCad draws a board text whatever the file says: hidden board text is no longer supported (`parsePCB_TEXT` makes it visible, parser line 4503)"),
  // X20 is built: a rule area's placement (its target, and whether it is on) is `Zone.placement`, and a part's component classes are `ComponentInstance.classes`. A rule area that is switched off and names no sheet (what KiCad 9
  // writes on every keepout) is a rule area with no placement, which is what the project holds for it. A rule area inside a part keeps no placement (`convertPartZones` leaves it out and reports it).
  row("zone>placement(?:>(?:enabled|sheetname|component_class|group))?", "built"),
  row("footprint>component_classes(?:>class)?", "built"),
  row("footprint>zone>placement(?:>(?:enabled|sheetname|component_class|group))?", "derived", "a rule area's placement settings inside a part: not kept (a part's land is shared, a placement area is the board's); one that is switched on or names a sheet, class or group is reported"),
  // X1 and X5 are built: what becomes of a pad's copper on layers nothing connects to (`PadDef.unused`) and its own tenting of the mask (`PadDef.tent`) are written into the project.
  row("footprint>pad>(?:remove_unused_layers|keep_end_layers)", "built"),
  row("footprint>pad>tenting(?:>(?:front|back))?", "built"),
  row("footprint>pad>layers", "derived", "the layers a pad is on are what the editor draws for its type and side (copper, mask, and paste on surface-mount pads); a pad whose layers differ needs X7"),
  row("footprint>pad>(?:solder_mask_margin|solder_paste_margin|solder_paste_margin_ratio|clearance)|footprint>(?:solder_mask_margin|solder_paste_margin|solder_paste_margin_ratio|clearance)", "derived", "a zero margin or clearance in a file up to stamp 20240201 means no setting (KiCad reads it as inherit)"),
]

/** What the builder does with an `extend` node whose extension the board does not need, from its path alone. */
export function settledFor(path: string, counts?: { edge?: ReadonlyMap<string, number>; net?: ReadonlyMap<string, number>; classes?: ReadonlyMap<string, number> }): Settled | null {
  const p = path.replace(/^module(?=$|>)/, "footprint")
  for (const r of ROWS) {
    if (!r.re.test(p)) continue
    if (r.how !== "derived") return { how: r.how }
    // Derived for the drawings on the board's edge only: with no count to say how many, it is for none of them.
    if ("scope" in r) return { how: "derived", reason: r.reason, derived: (r.scope === "edge" ? counts?.edge : r.scope === "net" ? counts?.net : counts?.classes)?.get(path) ?? 0 }
    return { how: r.how, reason: r.reason }
  }
  return null
}

/** How many nodes of each path belong to a drawing on Edge.Cuts: the drawing's own list and everything inside it. */
export const edgeNodeCounts = (board: KicadBoard) => shapeNodeCounts(board, (layer) => layer === "Edge.Cuts" || (layer !== undefined && TRANSLATED_LAYER_NAMES[layer] === "Edge.Cuts"))

/** How many `net` nodes of each path are on a drawing that is not on a copper layer, which means nothing there. */
export const ignoredNetCounts = (board: KicadBoard) => shapeNodeCounts(board, (_, copper) => !copper, "net")

/** Counts of nodes by path inside the drawings (board and footprint) that `pick` takes, by the drawing's layer and whether it is a copper one; with `only`, just the nodes of that name. */
function shapeNodeCounts(board: KicadBoard, pick: (layer: string | undefined, copper: boolean) => boolean, only?: string): Map<string, number> {
  const copperNames = new Set(board.copper.names)
  const out = new Map<string, number>()
  const count = (node: List, path: string) => {
    if (!only || path.endsWith(`>${only}`)) out.set(path, (out.get(path) ?? 0) + 1)
    for (let i = 1; i < node.length; i++) {
      const c = node[i]
      if (Array.isArray(c) && typeof c[0] === "string") count(c, `${path}>${c[0]}`)
    }
  }
  const visit = (node: List, path: string) => {
    for (let i = 1; i < node.length; i++) {
      const c = node[i]
      if (!Array.isArray(c) || typeof c[0] !== "string") continue
      const here = path ? `${path}>${c[0]}` : c[0]
      const isShape = path === "" ? /^gr_(?:line|arc|circle|rect|poly|curve|ellipse|ellipse_arc)$/.test(c[0]) : /^(?:module|footprint)$/.test(path) && /^fp_(?:line|arc|circle|rect|poly|curve|ellipse|ellipse_arc)$/.test(c[0])
      if (isShape) {
        const layer = strAt(kid(c, "layer"), 1) ?? strAt(kid(c, "layers"), 1)
        const layers = kid(c, "layers") ? (kid(c, "layers") as List).slice(1).filter((x): x is string => typeof x === "string") : [layer ?? ""]
        if (pick(layer, layers.some((n) => copperNames.has(n) || /\.Cu$/.test(n)))) count(c, here)
      } else if (path === "" && (c[0] === "footprint" || c[0] === "module")) visit(c, c[0])
    }
  }
  visit(board.tree, "")
  return out
}

/** KiCad's default for a `setup` setting a board states. */
function settleSetup(c: List, board: KicadBoard): string | null {
  const name = c[0] as string
  const word = strAt(c, 1)
  const num = numAt(c, 1, NaN)
  const noMicro = !board.vias.some((v) => v.kind !== "through")
  switch (name) {
    case "allow_soldermask_bridges_in_footprints":
      return word === "no" ? "KiCad's default (no)" : null
    case "uvias_allowed":
    case "blind_buried_vias_allowed":
      return noMicro ? "a permission for vias the board does not have" : null
    case "solder_mask_min_width":
    case "pad_to_paste_clearance_ratio":
    case "clearance_min":
    case "creepage":
      return num === 0 ? "zero, which is KiCad's default" : null
    case "max_error":
      return num === 0.005 ? "KiCad's default (0.005 mm)" : null
    // microvia sizes on a board with no blind or micro via, where they would apply to nothing
    case "uvia_size":
    case "uvia_drill":
    case "uvia_min_size":
    case "uvia_min_drill":
      return Number.isFinite(num) && noMicro ? "a micro via size on a board with no micro via" : null
    // via protection (KiCad 10) switched off
    case "covering":
    case "plugging":
    case "capping":
    case "filling":
      return c.slice(1).every((x) => (Array.isArray(x) ? x.slice(1).every((y) => y === "no" || y === "none") : x === "no" || x === "none")) ? "via protection switched off" : null
    case "tenting": {
      // Both sides tented is `DesignRules.tentVias`, which is the editor's default; any other is written (`tentSides`). KiCad 7 writes `(tenting front back)`, KiCad 8 `(tenting (front yes) (back yes))`.
      return board.tenting?.front && board.tenting.back ? "both sides tented, which is the editor's default" : null
    }
    default:
      return null
  }
}

/** The `setup` settings of a board that hold nothing to lose, by path, with why. */
export function settledSetup(board: KicadBoard): Map<string, string> {
  const out = new Map<string, string>()
  for (const c of kid(board.tree, "setup")?.slice(1) ?? []) {
    if (!Array.isArray(c) || typeof c[0] !== "string") continue
    const why = settleSetup(c, board)
    if (why) out.set(`setup>${c[0]}`, why)
  }
  return out
}

/** Whether the Default net class says anything the design rules cannot hold: another name, or a description of its own. */
export function netClassIsPlain(board: KicadBoard): boolean {
  if (board.netClasses.length === 0) return true
  if (board.netClasses.length > 1) return false
  const c = board.netClasses[0]
  return c.name === "Default" && !defaultClassOf(c)
}

/** The path-and-board settle function the accounting uses. */
export function settleFor(board: KicadBoard): (path: string) => Settled | null {
  const setup = settledSetup(board)
  const counts = { edge: edgeNodeCounts(board), net: ignoredNetCounts(board), classes: derivedClassNodes(board) }
  const rows = board.layers.filter((l) => COPPER_ROW.has(l.type))
  const plainStack = buildStack(board) === undefined
  return (path) => {
    // X1: the layer table is the board's copper layers (their order, names and types) and the fixed layers of the editor. The copper rows are written into the project's stack when it has one.
    if (path === "layers") return plainStack ? { how: "derived", reason: "the editor's layers are fixed: two copper layers, mask, silkscreen and the board edge. The copper rows say which layer is front and which is back (by position, whatever they are called)" } : { how: "built" }
    if (path === "layers><layer number>") {
      const derived = board.layers.length - (plainStack ? 0 : rows.length)
      return derived <= 0 ? { how: "built" } : { how: "derived", reason: plainStack ? "the editor's layers are fixed: two copper layers, mask, silkscreen and the board edge. The copper rows say which layer is front and which is back (by position, whatever they are called)" : "a layer that is not copper: the editor's layers for mask, paste, silkscreen, fabrication and drawings are fixed", derived }
    }
    const reason = setup.get(path.replace(/^(setup>[^>]+).*$/, "$1"))
    if (path.startsWith("setup>") && reason) return { how: "derived", reason }
    return settledFor(path, counts)
  }
}
