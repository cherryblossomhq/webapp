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
  // (A number of seven decimals or more is rounded to six, as the export's own tidying rounds it, so the text is the same after a round trip.)
  return Array.isArray(node) ? `(${node.map(nodeText).join(" ")})` : /^-?\d+(?:\.\d{7,}|(?:\.\d+)?e[+-]?\d+)$/.test(node) ? String(Number(Number(node).toFixed(6)) || 0) : word(node)
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

/** KiCad's fixed layers that the board's layer table does not list (an old board lists only the layers it uses): the export lists them all, so they are on. */
/** The line widths the board's outline is drawn with, and how many shapes have each. */
export function edgeWidths(board: KicadBoard): Map<number, number> {
  const widths = new Map<number, number>()
  for (const s of board.shapes) {
    if (s.layer !== "Edge.Cuts" && TRANSLATED_LAYER_NAMES[s.layer] !== "Edge.Cuts") continue
    if (s.width > 0 && !s.filled) widths.set(s.width, (widths.get(s.width) ?? 0) + 1)
  }
  return widths
}

export function unlistedStandardLayers(board: KicadBoard): string[] {
  if (!board.layers.length) return []
  const listed = new Set(board.layers.map((l) => TRANSLATED_LAYER_NAMES[l.name] ?? l.name))
  return Object.keys(STANDARD_USER_NAMES).filter((n) => !listed.has(n))
}

/** The words of a `pcbplotparams` that KiCad 9.0's parser has. It stops at a word it does not have, so a word of KiCad 10's (`pngdpi`...) is not carried. */
export const PLOT_WORDS_9: ReadonlySet<string> = new Set([
  "layerselection", "plot_on_all_layers_selection", "disableapertmacros", "usegerberextensions", "usegerberattributes", "usegerberadvancedattributes", "creategerberjobfile",
  "dashed_line_dash_ratio", "dashed_line_gap_ratio", "svgprecision", "excludeedgelayer", "plotframeref", "viasonmask", "mode", "useauxorigin", "hpglpennumber", "hpglpenspeed",
  "hpglpendiameter", "pdf_front_fp_property_popups", "pdf_back_fp_property_popups", "pdf_metadata", "pdf_single_document", "dxfpolygonmode", "dxfimperialunits", "dxfusepcbnewfont",
  "psnegative", "psa4output", "plotreference", "plotvalue", "plotinvisibletext", "sketchpadsonfab", "plotpadnumbers", "subtractmaskfromsilk", "outputformat", "mirror", "drillshape",
  "scaleselection", "outputdirectory", "hidednponfab", "sketchdnponfab", "crossoutdnponfab", "plot_black_and_white", "svguseinch",
])

/** The first file version that numbers the layers as the files the export writes (KiCad 9's). */
export const WRITTEN_LAYER_NUMBERING = 20241229

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
    carry.plot = nodeText(plot.filter((n) => !Array.isArray(n) || (PLOT_WORDS_9.has(String(n[0])) && (same || (n[0] !== "layerselection" && n[0] !== "plot_on_all_layers_selection")))))
  }
  // The nets whose names have a slash: what is a sheet's path and what is the label's own text cannot be told from the name the editor holds, so the file's own spelling is kept.
  const names: Record<string, string> = {}
  const seen = new Map<string, number>()
  for (const n of board.nets) seen.set(n.name, (seen.get(n.name) ?? 0) + 1)
  for (const n of board.nets) if (n.name.includes("/") && seen.get(n.name) === 1) names[n.name] = n.raw
  if (Object.keys(names).length) carry.netNames = names
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
  // (An old board's layers in Italian or Polish (`Kleju_Gorna`) are KiCad's own layers read under their name: KiCad keeps the name as the layer's own.)
  const canonical = (l: { name: string; userName?: string }) => ({ name: TRANSLATED_LAYER_NAMES[l.name] ?? l.name, userName: l.userName ?? (TRANSLATED_LAYER_NAMES[l.name] ? l.name : undefined) })
  const unusual = board.layers.map((l) => ({ ...l, ...canonical(l) })).some((l) => (!copperName(l.name) && l.userName !== undefined && STANDARD_USER_NAMES[l.name] !== l.userName) || !(l.name in STANDARD_USER_NAMES || copperName(l.name)))
  if (unusual) carry.layers = board.layers.map((l) => ({ ordinal: l.ordinal, type: l.type, ...canonical(l) })).map((l) => ({ n: l.ordinal, name: l.name, type: l.type, ...(l.userName !== undefined ? { user: l.userName } : {}) }))
  return Object.keys(carry).length ? carry : undefined
}
