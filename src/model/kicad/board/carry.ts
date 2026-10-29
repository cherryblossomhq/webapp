import type { KicadCarry } from "../../types"
import type { KicadBoard } from "./types"
import { TRANSLATED_LAYER_NAMES } from "./graphics"
import { kid, numAt, type List, type Node } from "./sexpr"

// What a board import keeps for the export and the editor does not edit (`KicadCarry`): the page, the two origins, the plot settings and the layer table's names,
// read from the file's own tree. The board writer (`export/kicadBoard.ts`) writes them back where KiCad keeps them.

/** A word of KiCad's file as it is written: bare when it is made of the characters KiCad's tokens are, else quoted. */
const word = (text: string): string => (/^[A-Za-z0-9_.+\-*:]+$/.test(text) ? text : `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`)

/** A node as KiCad's file text, on one line. */
export function nodeText(node: Node): string {
  return Array.isArray(node) ? `(${node.map(nodeText).join(" ")})` : word(node)
}

/** The words after a node's head, as text: `"A4"`, `"User" 297 210`. */
function wordsText(node: List | undefined): string | undefined {
  if (!node) return undefined
  const rest = node.slice(1)
  if (!rest.length) return undefined
  return rest.map((w, i) => (Array.isArray(w) ? nodeText(w) : i === 0 ? `"${w}"` : word(w))).join(" ")
}

/** KiCad's own names for its fixed layers, as the fourth word of a layer row says them: a name that is the same says nothing. */
const STANDARD_USER_NAMES: Record<string, string> = {
  "F.SilkS": "F.Silkscreen",
  "B.SilkS": "B.Silkscreen",
  "F.Adhes": "F.Adhesive",
  "B.Adhes": "B.Adhesive",
  "Dwgs.User": "User.Drawings",
  "Cmts.User": "User.Comments",
  "Eco1.User": "User.Eco1",
  "Eco2.User": "User.Eco2",
  "F.CrtYd": "F.Courtyard",
  "B.CrtYd": "B.Courtyard",
  "F.Mask": "F.Mask",
  "B.Mask": "B.Mask",
  "F.Paste": "F.Paste",
  "B.Paste": "B.Paste",
  "F.Fab": "F.Fab",
  "B.Fab": "B.Fab",
  "Edge.Cuts": "Edge.Cuts",
  Margin: "Margin",
}

/** The first file version that numbers the layers as the files the export writes (KiCad 9's). */
const WRITTEN_LAYER_NUMBERING = 20241229

const point = (node: List | undefined) => (node && node.length >= 3 ? { x: numAt(node, 1), y: numAt(node, 2) } : undefined)

export function boardCarry(board: KicadBoard): KicadCarry | undefined {
  const tree = board.tree
  const setup = kid(tree, "setup")
  const carry: KicadCarry = {}
  const paper = wordsText(kid(tree, "paper") ?? kid(tree, "page"))
  if (paper) carry.paper = paper
  const aux = point(kid(setup, "aux_axis_origin"))
  if (aux) carry.auxOrigin = aux
  const grid = point(kid(setup, "grid_origin"))
  if (grid) carry.gridOrigin = grid
  const plot = kid(setup, "pcbplotparams")
  if (plot && plot.length > 1) {
    // The two layer masks number the layers as the file's release does (KiCad 9 renumbered them), so they are kept only from a release that numbers them as the file the export writes does.
    const same = board.version !== null && board.version >= WRITTEN_LAYER_NUMBERING
    carry.plot = nodeText(same ? plot : plot.filter((n) => !(Array.isArray(n) && (n[0] === "layerselection" || n[0] === "plot_on_all_layers_selection"))))
  }
  // The width the outline was drawn with: the one most of the Edge.Cuts lines have.
  const widths = new Map<number, number>()
  for (const s of board.shapes) {
    if (s.layer !== "Edge.Cuts" && TRANSLATED_LAYER_NAMES[s.layer] !== "Edge.Cuts") continue
    if (s.width > 0 && !s.filled) widths.set(s.width, (widths.get(s.width) ?? 0) + 1)
  }
  const common = [...widths].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0]?.[0]
  if (common !== undefined && Math.abs(common - 0.05) > 1e-9) carry.edgeWidth = common
  // The layer table is kept when it says more than the writer's own: a name a person gave, or a layer the writer has no row for (`User.1`...).
  const copperName = (name: string) => /^(F|B|In\d+)\.Cu$/.test(name)
  const unusual = board.layers.some((l) => (!copperName(l.name) && l.userName !== undefined && STANDARD_USER_NAMES[l.name] !== l.userName) || !(l.name in STANDARD_USER_NAMES || copperName(l.name)))
  if (unusual) carry.layers = board.layers.map((l) => ({ n: l.ordinal, name: l.name, type: l.type, ...(l.userName !== undefined ? { user: l.userName } : {}) }))
  return Object.keys(carry).length ? carry : undefined
}
