import { qrCode } from "../../../lib/qrCode"
import { atomsOf, kid, kids, numAt, strAt, type List } from "./sexpr"
import type { KicadShape, Pt } from "./types"

// KiCad 9's tables (`table`, and the `drill_chart` KiCad generates from the drill data, which is a table with more nodes) as the lines KiCad draws for their borders and
// separators (`TABLE_BASE::DrawBorders`, pcbnew/pcb_table.cpp) and the cells, each of which is a text box. The editor has no table: an imported one is these plain drawings (X25),
// in the table's own frame (the board's, or the footprint's for a table inside one), as the file gives it (y down).

export interface TableLine {
  a: Pt
  b: Pt
  width: number
  dash: string | null
}

export interface TableParts {
  layer: string
  lines: TableLine[]
  /** The `table_cell` nodes, in the file's order. */
  cells: List[]
}

const strokeOf = (node: List | undefined): { width: number; dash: string | null } => {
  const s = kid(node, "stroke")
  const dash = strAt(kid(s, "type"), 1)
  return { width: s && kid(s, "width") ? numAt(kid(s, "width"), 1, 0) : 0, dash: dash && dash !== "default" && dash !== "solid" ? dash : null }
}

const yes = (node: List | undefined, name: string) => {
  const n = kid(node, name)
  return !!n && (n[1] === undefined || n[1] === "yes" || n[1] === "true")
}

/** A cell's rectangle: its `start` and `end`, or the box of the four corners of its `pts` (a table in a part that was turned writes them so, a thousandth of a micrometre off the rectangle). */
function rectOf(cell: List): { x0: number; y0: number; x1: number; y1: number } {
  const corners = kids(kid(cell, "pts"), "xy").map((p) => ({ x: numAt(p, 1, 0), y: numAt(p, 2, 0) }))
  if (corners.length) return { x0: Math.min(...corners.map((p) => p.x)), y0: Math.min(...corners.map((p) => p.y)), x1: Math.max(...corners.map((p) => p.x)), y1: Math.max(...corners.map((p) => p.y)) }
  return { x0: numAt(kid(cell, "start"), 1, 0), y0: numAt(kid(cell, "start"), 2, 0), x1: numAt(kid(cell, "end"), 1, 0), y1: numAt(kid(cell, "end"), 2, 0) }
}

/** The grid of a table: the lines of its border, header and separators, and its cells. */
export function tableParts(table: List): TableParts {
  const cells = kids(kid(table, "cells"), "table_cell")
  const columns = Math.max(1, Math.trunc(numAt(kid(table, "column_count"), 1, 1)))
  const widths = atomsOf(kid(table, "column_widths")).map(Number).filter(Number.isFinite)
  const heights = atomsOf(kid(table, "row_heights")).map(Number).filter(Number.isFinite)
  const layer = strAt(kid(table, "layer"), 1) ?? ""
  const rects = cells.map(rectOf)
  const origin = rects.length ? { x: Math.min(...rects.map((r) => r.x0)), y: Math.min(...rects.map((r) => r.y0)) } : { x: 0, y: 0 }
  // The grid's lines, from the first cell's corner by the widths and heights the file gives (a cell's own corners are what the table was last laid out with).
  const xs = [origin.x]
  for (let i = 0; i < Math.min(columns, widths.length); i++) xs.push(xs[i] + widths[i])
  const ys = [origin.y]
  for (const h of heights) ys.push(ys[ys.length - 1] + h)
  const cols = xs.length - 1
  const rows = ys.length - 1
  if (cols < 1 || rows < 1) return { layer, lines: [], cells }

  // Which cells a merged cell covers: `(span columns rows)` from the cell's own place, row by row, `columns` to a row.
  const owner = new Map<string, number>()
  cells.forEach((cell, i) => {
    const [c, r] = [Math.max(1, Math.trunc(numAt(kid(cell, "span"), 1, 1))), Math.max(1, Math.trunc(numAt(kid(cell, "span"), 2, 1)))]
    const col = xs.findIndex((x) => Math.abs(x - rects[i].x0) < 1e-3)
    const row = ys.findIndex((y) => Math.abs(y - rects[i].y0) < 1e-3)
    if (col < 0 || row < 0) return
    for (let dr = 0; dr < r; dr++) for (let dc = 0; dc < c; dc++) owner.set(`${row + dr},${col + dc}`, i)
  })
  const same = (r1: number, c1: number, r2: number, c2: number) => {
    const a = owner.get(`${r1},${c1}`)
    return a !== undefined && a === owner.get(`${r2},${c2}`)
  }

  const border = kid(table, "border")
  const separators = kid(table, "separators")
  const borderStroke = strokeOf(border)
  const separatorStroke = strokeOf(separators)
  const lines: TableLine[] = []
  /** A run of the lines of one boundary, the pieces that meet joined. */
  const run = (pieces: [Pt, Pt][], stroke: { width: number; dash: string | null }) => {
    const out: [Pt, Pt][] = []
    for (const [a, b] of pieces) {
      const last = out[out.length - 1]
      if (last && Math.abs(last[1].x - a.x) < 1e-9 && Math.abs(last[1].y - a.y) < 1e-9) last[1] = b
      else out.push([a, b])
    }
    for (const [a, b] of out) lines.push({ a, b, ...stroke })
  }
  if (yes(border, "external")) {
    run([[{ x: xs[0], y: ys[0] }, { x: xs[cols], y: ys[0] }]], borderStroke)
    run([[{ x: xs[cols], y: ys[0] }, { x: xs[cols], y: ys[rows] }]], borderStroke)
    run([[{ x: xs[cols], y: ys[rows] }, { x: xs[0], y: ys[rows] }]], borderStroke)
    run([[{ x: xs[0], y: ys[rows] }, { x: xs[0], y: ys[0] }]], borderStroke)
  }
  // The line under the header row is the border's own stroke, unless every row has a separator.
  const rowLines = yes(separators, "rows")
  const colLines = yes(separators, "cols")
  const boundary = (r: number, stroke: typeof borderStroke) => {
    const pieces: [Pt, Pt][] = []
    for (let c = 0; c < cols; c++) if (!same(r - 1, c, r, c)) pieces.push([{ x: xs[c], y: ys[r] }, { x: xs[c + 1], y: ys[r] }])
    run(pieces, stroke)
  }
  if (yes(border, "header") && !rowLines && rows > 1) boundary(1, borderStroke)
  if (rowLines) for (let r = 1; r < rows; r++) boundary(r, separatorStroke)
  if (colLines) {
    for (let c = 1; c < cols; c++) {
      const pieces: [Pt, Pt][] = []
      for (let r = 0; r < rows; r++) if (!same(r, c - 1, r, c)) pieces.push([{ x: xs[c], y: ys[r] }, { x: xs[c], y: ys[r + 1] }])
      run(pieces, separatorStroke)
    }
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

/** The word of a barcode's `type` that this importer can draw. */
const DRAWN_BARCODES = new Set(["qr"])

export interface BarcodeParts {
  /** The filled pieces of the symbol, in the file's frame (y down). */
  shapes: KicadShape[]
  /** Why a symbol is not drawn: it is hidden, or its kind or length is beyond this importer. */
  skipped: "hidden" | { unsupported: string } | null
}

/**
 * A barcode (`barcode`, KiCad 10) as the filled squares its symbol is made of. The symbol is centred on the barcode's point and turned about it by its angle, a square as large as the
 * barcode's smaller side less its margins; the dark modules are filled, merged along each row, or the light ones and the box round them when the barcode is a knockout (the symbol
 * is then cut out of a filled box). The symbol is the standard's QR code for the text at the error correction level: KiCad draws its own encoder's, which differs in the mask it picks and
 * not in what a reader decodes.
 */
export function barcodeParts(node: List, layer: string): BarcodeParts {
  const kind = strAt(kid(node, "type"), 1) ?? ""
  if (yes(node, "hide")) return { shapes: [], skipped: "hidden" }
  if (!DRAWN_BARCODES.has(kind)) return { shapes: [], skipped: { unsupported: `a ${kind || "barcode"} barcode` } }
  const level = strAt(kid(node, "ecc_level"), 1)
  const modules = qrCode(strAt(kid(node, "text"), 1) ?? "", level === "L" || level === "Q" || level === "H" ? level : "M")
  if (!modules) return { shapes: [], skipped: { unsupported: "a QR code with more text than version 40 holds" } }
  const at = kid(node, "at")
  const centre = { x: numAt(at, 1, 0), y: numAt(at, 2, 0) }
  const angle = (numAt(at, 3, 0) * Math.PI) / 180
  const marginX = numAt(kid(node, "margins"), 1, 0)
  const marginY = numAt(kid(node, "margins"), 2, 0)
  const width = numAt(kid(node, "size"), 1, 0)
  const height = numAt(kid(node, "size"), 2, 0)
  const side = Math.min(width - 2 * marginX, height - 2 * marginY)
  const n = modules.length
  const cell = side / n
  const knockout = yes(node, "knockout")
  // A point of the symbol's own frame (x right, y down, from the centre) in the file's.
  const place = (x: number, y: number): Pt => ({ x: centre.x + x * Math.cos(angle) - y * Math.sin(angle), y: centre.y + x * Math.sin(angle) + y * Math.cos(angle) })
  const shapes: KicadShape[] = []
  const box = (x0: number, y0: number, x1: number, y1: number) => shapes.push(fillShape(layer, [place(x0, y0), place(x1, y0), place(x1, y1), place(x0, y1)], node))
  const half = side / 2
  if (knockout) {
    // The box is the barcode's whole size; its light modules are filled, the symbol's dark ones cut out.
    const [bx, by] = [width / 2, height / 2]
    box(-bx, -by, bx, -half)
    box(-bx, half, bx, by)
    box(-bx, -half, -half, half)
    box(half, -half, bx, half)
  }
  for (let row = 0; row < n; row++) {
    for (let col = 0; col < n; col++) {
      if (modules[row][col] === knockout) continue
      let end = col
      while (end + 1 < n && modules[row][end + 1] !== knockout) end++
      box(-half + col * cell, -half + row * cell, -half + (end + 1) * cell, -half + (row + 1) * cell)
      col = end
    }
  }
  return { shapes, skipped: null }
}
