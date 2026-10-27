import { Clipper, Clipper64, ClipType, EndType, FillRule, JoinType, PolyTree64, type Path64, type Paths64 } from "@countertype/clipper2-ts"
import { fractureRings } from "../../../export/fracture"
import { inkBox, layoutText, type TextAttrsIu } from "../../../lib/kicadText"
import { qrCode, type QrLevel } from "../../../lib/qrCode"
import { collect } from "../../textOutlines"
import { expandTextVars } from "../../texts"
import { kid, kids, numAt, strAt, type List } from "./sexpr"
import type { KicadShape, Pt } from "./types"

// KiCad 9's tables (`table`, and the `drill_chart` of KiCad 11 development, which KiCad fills from the drill data and is a table with more nodes) as the lines KiCad draws for their
// borders and separators (`PCB_TABLE::DrawBorders`, pcbnew/pcb_table.cpp) and the cells, each of which is a text box. The editor has no table: an imported one is these plain drawings
// (X25), in the table's own frame (the board's, or the footprint's for a table inside one), as the file gives it (y down).

export interface TableLine {
  a: Pt
  b: Pt
  width: number
  dash: string | null
}

export interface TableParts {
  layer: string
  lines: TableLine[]
  /** The `table_cell` nodes KiCad draws, in the file's order: the cells a merged cell covers (`span 0 0`) are not drawn. */
  cells: List[]
}

interface Stroke {
  /** KiCad's -1 is a width the file did not give. */
  width: number
  dash: string | null
}

/** A table's stroke: the width the file gives (a table starts with -1, `PCB_TABLE(aParent, -1)` as the parser makes it) and its style word. */
function strokeOf(node: List | undefined): Stroke {
  const s = kid(node, "stroke")
  const dash = strAt(kid(s, "type"), 1)
  return { width: s && kid(s, "width") ? numAt(kid(s, "width"), 1, -1) : -1, dash: dash && dash !== "default" && dash !== "solid" ? dash : null }
}

/** A yes/no flag of a node: `parseBool`, and the default the item starts with when the file has none. */
const flag = (node: List | undefined, name: string, fallback: boolean) => {
  const n = kid(node, name)
  return n ? n[1] !== "no" && n[1] !== "false" : fallback
}

/** A cell's corners: those of its `pts` when it is an outline of points (a table inside a part that was turned writes them so, a thousandth of a micrometre off the rectangle), or of its `start` and `end`. */
function cornersOf(cell: List): Pt[] {
  const pts = kids(kid(cell, "pts"), "xy").map((p) => ({ x: numAt(p, 1, 0), y: numAt(p, 2, 0) }))
  if (pts.length) return pts
  const [x0, y0, x1, y1] = [numAt(kid(cell, "start"), 1, 0), numAt(kid(cell, "start"), 2, 0), numAt(kid(cell, "end"), 1, 0), numAt(kid(cell, "end"), 2, 0)]
  return [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }]
}

/**
 * A cell's corners in the order of the text's own frame, top left, top right, bottom right, bottom left (`EDA_SHAPE::GetCornersInSequence`, common/eda_shape.cpp): the box's corners
 * from the one the angle starts at for a quarter turn, and for any other angle the outline's extreme points, in the order of the quadrant the angle is in.
 */
function cornersInSequence(corners: Pt[], angle: number): Pt[] {
  const [minX, maxX] = [Math.min(...corners.map((p) => p.x)), Math.max(...corners.map((p) => p.x))]
  const [minY, maxY] = [Math.min(...corners.map((p) => p.y)), Math.max(...corners.map((p) => p.y))]
  const a = ((angle % 360) + 360) % 360
  if (a % 90 === 0) {
    const [tl, tr, br, bl] = [{ x: minX, y: minY }, { x: maxX, y: minY }, { x: maxX, y: maxY }, { x: minX, y: maxY }]
    return a === 0 ? [tl, tr, br, bl] : a === 90 ? [bl, tl, tr, br] : a === 180 ? [br, bl, tl, tr] : [tr, br, bl, tl]
  }
  const pts = [...corners]
  while (pts.length < 4) pts.push({ x: pts[pts.length - 1].x + 1e-5, y: pts[pts.length - 1].y + 1e-5 })
  // the first point to reach each extreme, as KiCad's `<` and `>` choose it
  const extreme = (better: (p: Pt, m: Pt) => boolean) => pts.reduce((m, p) => (better(p, m) ? p : m))
  const left = extreme((p, m) => p.x < m.x)
  const right = extreme((p, m) => p.x > m.x)
  const top = extreme((p, m) => p.y < m.y)
  const bottom = extreme((p, m) => p.y > m.y)
  return a < 90 ? [left, top, right, bottom] : a < 180 ? [bottom, left, top, right] : a < 270 ? [right, bottom, left, top] : [top, right, bottom, left]
}

/**
 * The grid of a table as KiCad draws it (`PCB_TABLE::DrawBorders`): each cell is at its row and column of the file's order, and the line on its right and the one under it are the cell's own
 * corners, a cell at a time, so a table that is turned or flipped is drawn where its cells are. The header row's separators are the border's stroke whatever the others are; the border is
 * drawn when it is on and has a width.
 */
export function tableParts(table: List): TableParts {
  const all = kids(kid(table, "cells"), "table_cell")
  const layer = strAt(kid(table, "layer"), 1) ?? ""
  const columns = Math.trunc(numAt(kid(table, "column_count"), 1, 0))
  const rows = columns > 0 ? Math.floor(all.length / columns) : 0
  const cells = all.filter((c) => numAt(kid(c, "span"), 1, 1) > 0 || numAt(kid(c, "span"), 2, 1) > 0)
  if (rows < 1) return { layer, lines: [], cells }

  const border = kid(table, "border")
  const separators = kid(table, "separators")
  const borderStroke = strokeOf(border)
  const separatorStroke = strokeOf(separators)
  const header = flag(border, "header", true)
  const drawAngle = numAt(kid(all[0], "angle"), 1, 0)
  const at = (row: number, col: number) => all[row * columns + col]
  const corners = (cell: List) => cornersInSequence(cornersOf(cell), drawAngle)
  const spanOf = (cell: List) => ({ cols: Math.trunc(numAt(kid(cell, "span"), 1, 1)), rows: Math.trunc(numAt(kid(cell, "span"), 2, 1)) })
  const lines: TableLine[] = []
  const draw = (a: Pt, b: Pt, stroke: Stroke) => lines.push({ a, b, width: Math.max(0, stroke.width), dash: stroke.dash })

  // between the columns: the right edge of each cell that is not on the table's right
  for (let col = 0; col < columns - 1; col++) {
    for (let row = 0; row < rows; row++) {
      const stroke = row === 0 && header ? borderStroke : flag(separators, "cols", true) ? separatorStroke : null
      const cell = at(row, col)
      if (!stroke || spanOf(cell).cols === 0 || col + spanOf(cell).cols === columns) continue
      const c = corners(cell)
      draw(c[1], c[2], stroke)
    }
  }
  // between the rows: the bottom edge of each cell that is not on the table's bottom
  for (let row = 0; row < rows - 1; row++) {
    const stroke = row === 0 && header ? borderStroke : flag(separators, "rows", true) ? separatorStroke : null
    if (!stroke) continue
    for (let col = 0; col < columns; col++) {
      const cell = at(row, col)
      if (spanOf(cell).rows === 0 || row + spanOf(cell).rows === rows) continue
      const c = corners(cell)
      draw(c[2], c[3], stroke)
    }
  }
  if (flag(border, "external", true) && borderStroke.width >= 0) {
    const [topLeft, topRight, bottomRight, bottomLeft] = [corners(at(0, 0)), corners(at(0, columns - 1)), corners(at(rows - 1, columns - 1)), corners(at(rows - 1, 0))]
    draw(topLeft[0], topRight[1], borderStroke)
    draw(topRight[1], bottomRight[2], borderStroke)
    draw(bottomRight[2], bottomLeft[3], borderStroke)
    draw(bottomLeft[3], topLeft[0], borderStroke)
  }
  return { layer, lines, cells }
}

/** A straight line as the shape KiCad would have written for it (`gr_line`), so the importer reads it as any other drawing. */
export function lineShape(layer: string, a: Pt, b: Pt, stroke: { width: number; dash: string | null }, node: List): KicadShape {
  return { kind: "line", layer, layers: [layer], start: a, end: b, width: stroke.width, filled: false, hatched: false, dash: stroke.dash, locked: false, net: null, netRaw: null, radius: 0, node }
}

/** A filled polygon (`gr_poly`) with no outline of its own. */
function fillShape(layer: string, pts: Pt[], node: List): KicadShape {
  return { kind: "poly", layer, layers: [layer], pts, width: 0, filled: true, hatched: false, dash: null, locked: false, net: null, netRaw: null, radius: 0, node }
}

export interface BarcodeParts {
  /** The symbol as one filled polygon, in the file's frame (y down). */
  shapes: KicadShape[]
  /** Why a symbol is not drawn: its text is empty (KiCad draws nothing for it), or its kind, length or text is beyond this importer. */
  skipped: "empty" | { unsupported: string } | null
}

/** Millimetres to the nanometres KiCad counts in, which the symbol is worked out in. */
const NM = 1e6

/** The outlines of a clipping, each with its holes. */
function groupsOf(op: ClipType, subject: Paths64, clip: Paths64 = []): Path64[][] {
  const tree = new PolyTree64()
  const c = new Clipper64()
  c.addSubject(subject)
  if (clip.length) c.addClip(clip)
  c.execute(op, FillRule.NonZero, tree)
  const out: Path64[][] = []
  collect(tree, out)
  return out
}

/** Several rings as one, each joined to the one before it by a bridge out and back along the same line, which covers no area (what KiCad's `Fracture` does with holes). */
function chain(rings: Pt[][]): Pt[] {
  const sorted = [...rings].sort((a, b) => a[0].y - b[0].y || a[0].x - b[0].x)
  const anchors = sorted.map((r) => r[0])
  return [anchors[0], ...sorted.slice(1).flatMap((r) => [...r, r[0]]), ...anchors.slice(0, -1).reverse(), ...sorted[0].slice(1)]
}

/** A barcode's layer is one of the back side's, so that KiCad draws its symbol mirrored (`BOARD_ITEM::IsSideSpecific` and `BOARD::IsBackLayer`). */
const BACK_LAYER = /^B\.(Cu|SilkS|Mask|Paste|Adhes|CrtYd|Fab)$/

/** The size a text starts with in KiCad: 60 mils. */
const DEFAULT_TEXT_HEIGHT = 1.524

/**
 * A barcode (`barcode`, KiCad 10) as the one filled polygon its symbol is (`PCB_BARCODE::AssembleBarcode`, pcbnew/pcb_barcode.cpp). The symbol is stretched to the barcode's whole `size`,
 * centred on its point, one module being the width over the number of modules across and the height over the number down; under it, a gap of 1 mm below, is its text unless the barcode
 * says `hide` (which hides the text and not the symbol). A knockout barcode is the box round both, grown by its margins and at least a tenth of its smaller side to the next 0.1 mm, with the
 * symbol and the text cut out of it. On a back layer the symbol is mirrored about its point, and then turned about it by its angle. The symbol is the QR code zint makes of the text
 * (`lib/qrCode.ts`); `variable` is what a `${...}` of the text shows, and null for a name the editor has no value for.
 */
export function barcodeParts(node: List, layer: string, variable: (token: string) => string | null): BarcodeParts {
  const kind = strAt(kid(node, "type"), 1) ?? ""
  const unsupported = (what: string): BarcodeParts => ({ shapes: [], skipped: { unsupported: what } })
  if (kind !== "qr" && kind !== "qrcode") return unsupported(`a ${kind || "barcode"} barcode`)
  const left: string[] = []
  const shown = expandTextVars(strAt(kid(node, "text"), 1) ?? "", (token) => {
    const value = variable(token)
    if (value === null) left.push(token)
    return value
  })
  if (left.length) return unsupported(`a barcode whose text uses \${${left[0]}}`)
  if (!shown) return { shapes: [], skipped: "empty" }
  const level = (strAt(kid(node, "ecc_level"), 1) ?? "L").toUpperCase()
  const modules = qrCode(shown, level === "M" || level === "Q" || level === "H" ? (level as QrLevel) : "L")
  if (!modules) return unsupported("a QR code with more text than version 40 holds")
  const n = modules.length
  const width = Math.round(numAt(kid(node, "size"), 1, 40) * NM)
  const height = Math.round(numAt(kid(node, "size"), 2, 40) * NM)

  // The symbol in its own frame (nm, y down) with its centre at the origin: the dark modules, a row at a time.
  const edge = (total: number, i: number) => Math.round(-total / 2 + (i * total) / n)
  const symbol: Paths64 = []
  modules.forEach((row, y) => {
    for (let x = 0; x < n; x++) {
      if (!row[x]) continue
      let end = x
      while (end + 1 < n && row[end + 1]) end++
      const [x0, x1, y0, y1] = [edge(width, x), edge(width, end + 1), edge(height, y), edge(height, y + 1)]
      symbol.push([{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }])
      x = end
    }
  })

  // The text: centred under the symbol, its ink's top 1 mm below the symbol's bottom.
  const ink: Paths64 = []
  if (!yes(node, "hide")) {
    const size = Math.max(1, Math.round(numAt(kid(node, "text_height"), 1, DEFAULT_TEXT_HEIGHT) * NM))
    const attrs: TextAttrsIu = { w: size, h: size, thickness: Math.max(1, Math.round(size / 8)), bold: false, italic: false, mirror: false, hAlign: 0, vAlign: 0, lineSpacing: 1 }
    const strokes = layoutText(shown, { x: 0, y: 0, angle: 0 }, attrs, true)
    const box = inkBox(strokes)
    if (box) {
      const dx = -Math.round((box.minX + box.maxX) / 2)
      const dy = Math.round(height / 2 - box.minY + NM)
      for (const line of strokes.polylines) {
        const path: Path64 = line.map((p) => ({ x: Math.round(p.x) + dx, y: Math.round(p.y) + dy }))
        if (path.length === 1) path.push({ x: path[0].x + 1, y: path[0].y })
        ink.push(...Clipper.inflatePaths([path], strokes.pen / 2, JoinType.Round, EndType.Round, 2, 0.005 * NM))
      }
    }
  }
  const solid = Clipper.union([...symbol, ...ink], [], FillRule.NonZero)

  let groups: Path64[][]
  if (yes(node, "knockout")) {
    const all = solid.flat()
    const [minX, maxX] = [Math.min(...all.map((p) => p.x)), Math.max(...all.map((p) => p.x))]
    const [minY, maxY] = [Math.min(...all.map((p) => p.y)), Math.max(...all.map((p) => p.y))]
    // at least a tenth of the smaller side, rounded up to 0.1 mm
    const tenth = Math.ceil(Math.ceil(Math.min(width, height) / 10) / (NM / 10)) * (NM / 10)
    const growX = Math.max(Math.round(numAt(kid(node, "margins"), 1, 0) * NM), tenth)
    const growY = Math.max(Math.round(numAt(kid(node, "margins"), 2, 0) * NM), tenth)
    const box: Path64 = [{ x: minX - growX, y: minY - growY }, { x: maxX + growX, y: minY - growY }, { x: maxX + growX, y: maxY + growY }, { x: minX - growX, y: maxY + growY }]
    groups = groupsOf(ClipType.Difference, [box], solid)
  } else groups = groupsOf(ClipType.Union, solid)
  if (!groups.length) return { shapes: [], skipped: "empty" }

  // mirrored on the back, then turned about the point (`RotatePoint` in the file's frame, y down), the quarter turns exact
  const at = kid(node, "at")
  const centre = { x: Math.round(numAt(at, 1, 0) * NM), y: Math.round(numAt(at, 2, 0) * NM) }
  const angle = ((numAt(at, 3, 0) % 360) + 360) % 360
  const [sin, cos] = angle % 90 === 0 ? [[0, 1, 0, -1][angle / 90], [1, 0, -1, 0][angle / 90]] : [Math.sin((angle * Math.PI) / 180), Math.cos((angle * Math.PI) / 180)]
  const mirrored = BACK_LAYER.test(layer)
  const place = (p: Pt): Pt => {
    const x = mirrored ? -p.x : p.x
    return { x: (centre.x + Math.round(x * cos + p.y * sin)) / NM, y: (centre.y + Math.round(-x * sin + p.y * cos)) / NM }
  }
  const rings = groups.map((g) => fractureRings(g[0], g.slice(1)))
  return { shapes: [fillShape(layer, chain(rings).map(place), node)], skipped: null }
}

/** A flag of a barcode that is on: `(hide yes)`, `(knockout yes)`. */
const yes = (node: List, name: string) => flag(node, name, false)
