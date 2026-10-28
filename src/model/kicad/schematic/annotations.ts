import { round } from "../../../lib/geometry"
import { uid } from "../../../lib/id"
import { kicadText } from "../../sheetItems"
import type { DrawingTable, FillKind, LabelField, RuleAreaMark, SchematicDrawing, SheetFill, SheetStroke, StrokeDash, TableCell, TextLook, Vec2 } from "../../types"
import { flagOf, kid, kids, numAt, strAt, type List } from "../board/sexpr"
import { colorOf, placeOf, u } from "./symbols"
import type { KicadSchematic, Pt, SchLabel, SchProperty } from "./types"

// S4 and S2's text: what the sheet carries besides parts, wires and labels (free text, text boxes,
// lines, rectangles, circles, arcs, curves, pictures, tables), read as drawings (`Project.drawings`, the
// ones the drawing tools make), a label's size and style, a wire's stroke, a junction's size and colour.
// Every number is KiCad's own in the editor's units (KiCad's 1.27 mm is 0.1, and y is negated), exact to
// 0.000001 of a unit (about 13 nm).

/** A point as the editor holds it: y up. */
export const sheetPt = (p: Pt | undefined): Vec2 => ({ x: u(p?.x ?? 0), y: -u(p?.y ?? 0) === 0 ? 0 : -u(p?.y ?? 0) })

const pointOf = (n: List | undefined): Pt => ({ x: numAt(n, 1), y: numAt(n, 2) })

const DASHES = new Set(["dash", "dot", "dash_dot", "dash_dot_dot"])

/** `(stroke (width w) (type t) (color r g b a))`: the line's own look; a plain default line is none. */
export function strokeOf(node: List | undefined): SheetStroke | undefined {
  const stroke = kid(node, "stroke")
  if (!stroke) return undefined
  const out: SheetStroke = {}
  const width = numAt(kid(stroke, "width"), 1, 0)
  // A width of nothing is KiCad's "default", which the editor draws as its own.
  if (width > 0) out.width = u(width)
  const type = strAt(kid(stroke, "type"), 1)
  if (type && DASHES.has(type)) out.dash = type as StrokeDash
  const color = colorOf(kid(stroke, "color"))
  if (color) out.color = color
  return Object.keys(out).length ? out : undefined
}

/** `(fill (type none|outline|background|color) (color ...))`. */
export function fillOf(node: List | undefined): SheetFill | undefined {
  const fill = kid(node, "fill")
  if (!fill) return undefined
  const type = strAt(kid(fill, "type"), 1)
  if (type === "outline" || type === "background") return { kind: type as FillKind }
  if (type === "color") {
    const color = colorOf(kid(fill, "color"))
    return { kind: "color", ...(color ? { color } : {}) }
  }
  return undefined
}

/** The look of a text from its `(effects ...)`; every default is left out (KiCad's 1.27 mm, centred, plain). `node` is the list that holds the effects. */
export function textLookOf(node: List | undefined, notes?: Set<string>): TextLook | undefined {
  const effects = kid(node, "effects")
  if (!effects) return undefined
  const out: TextLook = {}
  const font = kid(effects, "font")
  const size = numAt(kid(font, "size"), 1, 1.27)
  if (Math.abs(size - 1.27) > 1e-9) out.size = u(size)
  const thickness = numAt(kid(font, "thickness"), 1, 0)
  if (thickness > 0) out.thickness = u(thickness)
  if (flagOf(font, "bold")) out.bold = true
  if (flagOf(font, "italic")) out.italic = true
  const color = colorOf(kid(font, "color"))
  if (color) out.color = color
  const face = strAt(kid(font, "face"), 1)
  if (face) {
    out.face = face
    notes?.add("a font of its own")
  }
  const spacing = numAt(kid(font, "line_spacing"), 1, 1)
  if (kid(font, "line_spacing") && Math.abs(spacing - 1) > 1e-9) out.lineSpacing = spacing
  for (const w of kid(effects, "justify")?.slice(1) ?? []) {
    if (w === "left" || w === "right") out.h = w
    else if (w === "top" || w === "bottom") out.v = w
    else if (w === "mirror") out.mirror = true
  }
  const href = strAt(kid(effects, "href"), 1)
  if (href) out.href = href
  if (flagOf(effects, "hide")) out.hidden = true
  return Object.keys(out).length ? out : undefined
}

/** A turn of a sheet item: KiCad's angle, a quarter turn only. */
function turnOf(angle: number): 0 | 90 | 180 | 270 | null {
  const a = ((Math.round(angle) % 360) + 360) % 360
  return Math.abs(angle - Math.round(angle)) < 1e-9 && a % 90 === 0 ? (a as 0 | 90 | 180 | 270) : null
}

const simFlag = (node: List) => (kid(node, "exclude_from_sim") && flagOf(node, "exclude_from_sim") ? ({ excludeFromSim: true } as const) : {})

/** The `at` of a node with its angle: the editor's point and a quarter turn, or null when the angle is not one. */
function placeAt(node: List): { p: Vec2; rot: 0 | 90 | 180 | 270 } | null {
  const at = kid(node, "at")
  const rot = turnOf(numAt(at, 3, 0))
  return rot === null ? null : { p: sheetPt(pointOf(at)), rot }
}

/** The margins of a box: left, top, right, bottom. */
function marginsOf(node: List): [number, number, number, number] | undefined {
  const m = kid(node, "margins")
  if (!m) return undefined
  return [u(numAt(m, 1)), u(numAt(m, 2)), u(numAt(m, 3)), u(numAt(m, 4))]
}

export interface SheetDrawings {
  drawings: SchematicDrawing[]
  /** What the editor cannot hold of what was read, in words: an item with an angle that is not a quarter turn, a shape with too few points. */
  problems: string[]
  /** What a text asks for that the editor draws its own way (a font of its own). */
  notes: Set<string>
}

/** The data of an image: the base64 text of its `(data "..." "...")` strings, joined. */
function imageData(node: List): string {
  const data = kid(node, "data")
  return (data?.slice(1) ?? []).filter((c): c is string => typeof c === "string").join("").replace(/\s+/g, "")
}

/** Every text, text box, drawing, picture and table of a sheet, from the lists the reader left in `others`, as drawings. */
export function readSheetItems(s: KicadSchematic): SheetDrawings {
  const drawings: SchematicDrawing[] = []
  const problems: string[] = []
  const notes = new Set<string>()
  const add = (d: SchematicDrawing) => drawings.push(d)

  for (const n of s.others.text ?? []) {
    const place = placeAt(n)
    if (!place) {
      problems.push("a text turned by other than a quarter turn")
      continue
    }
    add(kicadText(uid("d"), strAt(n, 1) ?? "", place.p, place.rot, textLookOf(n, notes), !!simFlag(n).excludeFromSim))
  }
  for (const n of s.others.text_box ?? []) {
    const place = placeAt(n)
    if (!place) {
      problems.push("a text box turned by other than a quarter turn")
      continue
    }
    const size = kid(n, "size")
    const look = textLookOf(n, notes)
    const stroke = strokeOf(n)
    const paint = fillOf(n)
    const margins = marginsOf(n)
    add({ id: uid("d"), type: "textbox", text: strAt(n, 1) ?? "", x: place.p.x, y: place.p.y, w: u(numAt(size, 1)), h: u(numAt(size, 2)), rot: place.rot, ...(margins ? { margins } : {}), ...(look ? { look } : {}), ...(stroke ? { stroke } : {}), ...(paint ? { paint } : {}), ...simFlag(n) })
  }

  /** The look every shape of the file has: its stroke (an empty one says "KiCad's own line" for a line and a box) and fill. */
  const look = (n: List, own: boolean) => {
    const stroke = strokeOf(n) ?? (own ? {} : undefined)
    const paint = fillOf(n)
    return { ...(stroke ? { stroke } : {}), ...(paint ? { paint } : {}) }
  }
  const pts = (n: List) => kids(kid(n, "pts"), "xy").map((p) => sheetPt(pointOf(p)))
  for (const n of s.others.polyline ?? []) {
    const points = pts(n)
    if (points.length < 2) problems.push("a line with fewer than two points")
    else add({ id: uid("d"), type: "line", points, ...look(n, true) })
  }
  // S8: a rule area is a closed polygon (`(rule_area (polyline ...))`, with the flags of KiCad 10's files beside the polyline): a line that is closed and says what it does.
  for (const n of s.others.rule_area ?? []) {
    const poly = kid(n, "polyline")
    // A corner that is not a number is a damaged file, not a corner at 0.
    const corners = kids(kid(poly, "pts"), "xy")
    if (corners.some((c) => !Number.isFinite(Number(c[1])) || !Number.isFinite(Number(c[2])))) {
      problems.push("a rule area with a corner that is not a number")
      continue
    }
    const points = poly ? pts(poly) : []
    // KiCad closes the polygon itself; a first point written again at the end is the same corner twice.
    const first = points[0]
    const last = points[points.length - 1]
    if (points.length > 3 && first.x === last.x && first.y === last.y) points.pop()
    if (!poly || points.length < 3) {
      problems.push("a rule area with fewer than three corners")
      continue
    }
    const mark: RuleAreaMark = {}
    if (kid(n, "dnp") && flagOf(n, "dnp")) mark.dnp = true
    if (kid(n, "in_bom") && !flagOf(n, "in_bom")) mark.excludeFromBom = true
    if (kid(n, "on_board") && !flagOf(n, "on_board")) mark.notOnBoard = true
    if (kid(n, "exclude_from_sim") && flagOf(n, "exclude_from_sim")) mark.excludeFromSim = true
    add({ id: uid("d"), type: "line", points, closed: true, ...look(poly, true), ruleArea: mark })
  }
  for (const n of s.others.rectangle ?? []) {
    const a = sheetPt(pointOf(kid(n, "start")))
    const b = sheetPt(pointOf(kid(n, "end")))
    const radius = numAt(kid(n, "radius"), 1, 0)
    add({ id: uid("d"), type: "rect", x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: round(Math.abs(b.x - a.x), 6), height: round(Math.abs(b.y - a.y), 6), ...(radius > 0 ? { radius: u(radius) } : {}), ...look(n, true) })
  }
  for (const n of s.others.circle ?? []) {
    const c = sheetPt(pointOf(kid(n, "center")))
    add({ id: uid("d"), type: "circle", x: c.x, y: c.y, radius: u(numAt(kid(n, "radius"), 1)), ...look(n, false) })
  }
  for (const n of s.others.arc ?? []) add({ id: uid("d"), type: "arc", start: sheetPt(pointOf(kid(n, "start"))), mid: sheetPt(pointOf(kid(n, "mid"))), end: sheetPt(pointOf(kid(n, "end"))), ...look(n, false) })
  for (const n of s.others.bezier ?? []) {
    const points = pts(n)
    if (points.length !== 4) problems.push("a curve without four points")
    else add({ id: uid("d"), type: "bezier", points: [points[0], points[1], points[2], points[3]], ...look(n, false) })
  }

  for (const n of s.others.image ?? []) {
    const at = sheetPt(pointOf(kid(n, "at")))
    const scale = kid(n, "scale") ? numAt(kid(n, "scale"), 1, 1) : 1
    const data = imageData(n)
    if (!data) problems.push("a picture with no data")
    else add({ id: uid("d"), type: "image", x: at.x, y: at.y, scale, data })
  }

  for (const n of s.others.table ?? []) {
    const table = readTable(n, notes, problems)
    if (table) add(table)
  }
  return { drawings, problems, notes }
}

function readTable(n: List, notes: Set<string>, problems: string[]): DrawingTable | null {
  const cells: TableCell[] = []
  for (const c of kids(kid(n, "cells"), "table_cell")) {
    const place = placeAt(c)
    if (!place) {
      problems.push("a table cell turned by other than a quarter turn")
      return null
    }
    const size = kid(c, "size")
    const span = kid(c, "span")
    const look = textLookOf(c, notes)
    const fill = fillOf(c)
    const margins = marginsOf(c)
    cells.push({
      text: strAt(c, 1) ?? "",
      x: place.p.x,
      y: place.p.y,
      w: u(numAt(size, 1)),
      h: u(numAt(size, 2)),
      rot: place.rot,
      colSpan: Math.max(1, numAt(span, 1, 1)),
      rowSpan: Math.max(1, numAt(span, 2, 1)),
      ...(margins ? { margins } : {}),
      ...(look ? { look } : {}),
      ...(fill ? { fill } : {}),
      ...(kid(c, "exclude_from_sim") && flagOf(c, "exclude_from_sim") ? { excludeFromSim: true as const } : {}),
    })
  }
  const border = kid(n, "border")
  const separators = kid(n, "separators")
  const bs = strokeOf(border)
  const ss = strokeOf(separators)
  const yes = (node: List | undefined, name: string) => flagOf(node, name)
  return {
    id: uid("d"),
    type: "table",
    columns: numAt(kid(n, "column_count"), 1, 0),
    columnWidths: (kid(n, "column_widths")?.slice(1) ?? []).map((v) => u(Number(v))),
    rowHeights: (kid(n, "row_heights")?.slice(1) ?? []).map((v) => u(Number(v))),
    cells,
    border: { external: yes(border, "external"), header: yes(border, "header"), ...(bs ? { stroke: bs } : {}) },
    separators: { rows: yes(separators, "rows"), cols: yes(separators, "cols"), ...(ss ? { stroke: ss } : {}) },
  }
}

/** A label's own fields (a global label's `Intersheet References`), each with its place relative to the label's point and its look. */
export function labelFields(l: SchLabel, props: SchProperty[], notes: Set<string>): LabelField[] {
  return props.map((p) => ({ name: p.name, value: p.value, place: placeOf(p, l.at, notes) }))
}
