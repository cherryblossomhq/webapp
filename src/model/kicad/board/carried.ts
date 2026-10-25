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
}

const SHAPES = "(?:gr_|footprint>fp_)(?:line|arc|circle|rect|poly|curve)"

const row = (source: string, how: Settled["how"], reason?: string) => ({ re: new RegExp(`^(?:${source})$`), how, ...(reason ? { reason } : {}) })

const ROWS = [
  row("footprint>at", "built"),
  row("footprint>pad|footprint>pad>(?:at|size|drill|rect_delta)", "built"),
  row("via>layers", "built"),
  // Drawings on Edge.Cuts are the outline (`outline.ts`); a drawing on any other layer needs X8 and is never settled here.
  row(`${SHAPES}|${SHAPES}>(?:start|end|mid|center|layer|pts|pts>xy|pts>arc|pts>arc>(?:start|mid|end)|angle|radius)`, "built"),
  row(`${SHAPES}>(?:stroke|stroke>(?:type|width)|width|fill|locked)`, "derived", "the width and style of an outline line: the board is cut along the line's centre"),
  row("net_class>(?:clearance|trace_width|via_dia|via_drill)", "built"),
  row("net_class", "derived", "the Default net class's name and description are KiCad's own; its clearance, track width and via size are the design rules, which are imported"),
  row("net_class>add_net", "derived", "every net that no other class names is in the Default class, so listing them says nothing"),
  row("net_class>(?:uvia_dia|uvia_drill)", "derived", "the micro via size of the Default class, which applies to nothing on a board with no micro via"),
  row("layers|layers><layer number>", "derived", "the editor's layers are fixed: two copper layers, mask, silkscreen and the board edge. The copper rows say which layer is front and which is back (by position, whatever they are called)"),
  // X15 and X13 are built: the flags, the net tie and jumper groups, and the net of each track and via are written into the project.
  row("footprint>attr|footprint>net_tie_pad_groups|footprint>duplicate_pad_numbers_are_jumpers|footprint>jumper_pad_groups(?:><layer number>|>[^>]+)?", "built"),
  row("(?:segment|arc|via)>net", "built"),
  row("footprint>pad>layers", "derived", "the layers a pad is on are what the editor draws for its type and side (copper, mask, and paste on surface-mount pads); a pad whose layers differ needs X7"),
  row("footprint>pad>(?:solder_mask_margin|solder_paste_margin|solder_paste_margin_ratio|clearance)|footprint>(?:solder_mask_margin|solder_paste_margin|solder_paste_margin_ratio|clearance)", "derived", "a zero margin or clearance in a file up to stamp 20240201 means no setting (KiCad reads it as inherit)"),
]

/** What the builder does with an `extend` node whose extension the board does not need, from its path alone. */
export function settledFor(path: string): Settled | null {
  const p = path.replace(/^module(?=$|>)/, "footprint")
  for (const r of ROWS) if (r.re.test(p)) return r.how === "derived" ? { how: r.how, reason: r.reason } : { how: r.how }
  return null
}

const DEFAULT_CLASS_NOTE = "This is the default net class."

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
      return word === "no" || noMicro ? "a permission for vias the board does not have" : null
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
      // Both sides tented is `DesignRules.tentVias`, which is the editor's default; KiCad 7 writes `(tenting front back)`, KiCad 8 `(tenting (front yes) (back yes))`.
      const sides = c.slice(1)
      const front = sides.includes("front") || strAt(kid(c, "front"), 1) === "yes"
      const back = sides.includes("back") || strAt(kid(c, "back"), 1) === "yes"
      return front && back && board.vias.every((v) => v.kind === "through") ? "both sides tented, which is the editor's default" : null
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
  return c.name === "Default" && (c.description === "" || c.description === DEFAULT_CLASS_NOTE)
}

/** The path-and-board settle function the accounting uses. */
export function settleFor(board: KicadBoard): (path: string) => Settled | null {
  const setup = settledSetup(board)
  return (path) => {
    const reason = setup.get(path.replace(/^(setup>[^>]+).*$/, "$1"))
    if (path.startsWith("setup>") && reason) return { how: "derived", reason }
    return settledFor(path)
  }
}
