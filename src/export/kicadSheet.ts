import { round } from "../lib/geometry"
import { labelJustify } from "../model/labelShapes"
import { SCH_LIGHT } from "../editor/theme"
import { textFrame, WEIGHT_WIDTH, withAlpha } from "../model/drawings"
import { isExact, lookOfText } from "../model/sheetItems"
import type { ComponentInstance, DrawingColor, LabelField, NetLabel, SchematicDrawing, SheetFill, SheetStroke, TextLook, Vec2 } from "../model/types"
import { escapeNetName, quote } from "../lib/kicadQuote"

// S2 and S4 in the KiCad schematic: labels with their kind, shape and style, the drawings of the sheet (texts, text
// boxes, lines, shapes, pictures, tables, junction dots and flags), and the flags of a symbol. The converter
// (`circuit-json-to-kicad`) knows none of these, so they are written here, as KiCad's own S-expressions (file
// version 20250114, which is the converter's). `toPage` puts a point of the sheet (the editor's units, y up) on
// KiCad's page in millimetres (y down).

const MM = 12.7
const mm6 = (n: number) => String(round(n, 6) || 0)
/** A length in editor units as millimetres, to a tenth of a micrometre. */
const L = (units: number) => String(round(units * MM, 4) || 0)

/** KiCad's `(color r g b a)` of `#rrggbb` or `rgba(r,g,b,a)`. */
export function colorNode(color: string): string {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color)
  if (m) return `(color ${parseInt(m[1], 16)} ${parseInt(m[2], 16)} ${parseInt(m[3], 16)} 1)`
  const r = /^rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([\d.]+)\s*\)$/.exec(color)
  return r ? `(color ${r[1]} ${r[2]} ${r[3]} ${r[4]})` : "(color 0 0 0 0)"
}

type ToPage = (p: Vec2) => Vec2

/**
 * The uuids this writer makes up, which no two items of a sheet may share. Each kind has a group of its own (the fourth group of the uuid), so a kind can never
 * collide with another however many items a sheet has: an item's own (`uuidOf`, by its place on the sheet), the nodes inside one item (`subUuidOf`: the segments of a bus,
 * the cells of a table), the labels of a bus (`busLabelUuidOf`) and the fallback of a rewritten label (`labelUuidOf`).
 */
const uuidIn = (group: number, n: number) => `00000000-0000-4000-${(0x8000 + group).toString(16)}-${(n + 0x100000).toString(16).padStart(12, "0")}`
const uuidOf = (n: number) => uuidIn(0, n)
/** The `k`th node inside item `n`: a span of 2^20 per item, far above what one item holds (a bus of a million segments is refused long before). */
const subUuidOf = (n: number, k: number) => uuidIn(1, n * 0x100000 + k)
const busLabelUuidOf = (i: number) => uuidIn(2, i)
const labelUuidOf = (i: number) => uuidIn(3, i)

/** `(effects (font (size ...) ...) (justify ...) (href ...) (hide yes))` of a text's look; the page's text size is 1.27 mm. */
function effects(look: TextLook | undefined, justify?: { h?: string; v?: string }): string {
  const size = round((look?.size ?? 0.1) * MM, 4)
  const font = [`(size ${mm6(size)} ${mm6(size)})`]
  if (look?.thickness) font.push(`(thickness ${L(look.thickness)})`)
  if (look?.bold) font.push("bold")
  if (look?.italic) font.push("italic")
  if (look?.color) font.push(colorNode(look.color))
  const parts = [`(font ${font.join(" ")})`]
  const words = [justify?.h ?? look?.h, justify?.v ?? look?.v, look?.mirror ? "mirror" : undefined].filter(Boolean)
  if (words.length) parts.push(`(justify ${words.join(" ")})`)
  if (look?.href) parts.push(`(href ${quote(look.href)})`)
  if (look?.hidden) parts.push("(hide yes)")
  return `(effects ${parts.join(" ")})`
}

function strokeNode(stroke: SheetStroke | undefined): string {
  const parts = [`(width ${L(stroke?.width ?? 0)})`, `(type ${stroke?.dash ?? "default"})`]
  if (stroke?.color) parts.push(colorNode(stroke.color))
  return `(stroke ${parts.join(" ")})`
}

function fillNode(fill: SheetFill | undefined): string {
  if (!fill) return "(fill (type none))"
  return fill.kind === "color" ? `(fill (type color) ${colorNode(fill.color ?? "#000000")})` : `(fill (type ${fill.kind}))`
}

const sim = (on: boolean | undefined) => `(exclude_from_sim ${on ? "yes" : "no"})`

/**
 * A label as KiCad writes it: a local one `(label ...)`, a global one `(global_label ...)` with its shape, both
 * with the size and style of their text, the justification a turn gives (and one that is not), and the fields.
 * `uuid` is the converter's, kept.
 */
export function labelNode(l: NetLabel, toPage: ToPage, uuid: string): string {
  const p = toPage(l)
  const global = l.kind === "global"
  const hierarchical = l.kind === "hierarchical"
  const j = labelJustify(l)
  const out: string[] = [`  (${global ? "global_label" : hierarchical ? "hierarchical_label" : "label"} ${quote(hierarchical ? l.name.replace(/\//g, "{slash}") : l.name)}`]
  if (global || hierarchical) out.push(`    (shape ${l.shape ?? "bidirectional"})`)
  out.push(`    (at ${mm6(p.x)} ${mm6(p.y)} ${l.rot})`)
  if (l.fieldsAutoplaced) out.push("    (fields_autoplaced yes)")
  out.push(`    ${effects(l.look, { h: j.h, v: j.v })}`)
  out.push(`    (uuid ${uuid})`)
  for (const f of l.fields ?? []) out.push(fieldNode(f, l, toPage))
  out.push("  )")
  return out.join("\n")
}

/** One field of a label: its place is relative to the label's point. */
function fieldNode(f: LabelField, l: Vec2, toPage: ToPage): string {
  const at = toPage({ x: l.x + f.place.x, y: l.y + f.place.y })
  const look: TextLook = { ...(f.place.size ? { size: f.place.size } : {}), ...(f.place.bold ? { bold: true as const } : {}), ...(f.place.italic ? { italic: true as const } : {}), ...(f.place.color ? { color: f.place.color } : {}), ...(f.place.thickness ? { thickness: f.place.thickness } : {}), ...(f.place.hidden ? { hidden: true as const } : {}) }
  const flags = [f.place.showName ? "    (show_name yes)" : "", f.place.noAutoplace ? "    (do_not_autoplace yes)" : ""].filter(Boolean)
  return [`    (property ${quote(f.name)} ${quote(f.value)}`, `      (at ${mm6(at.x)} ${mm6(at.y)} ${f.place.angle})`, ...flags.map((x) => `  ${x}`), `      ${effects(look, { h: f.place.h, v: f.place.v })}`, "    )"].join("\n")
}

/** The editor's named colours as the light sheet draws them, which is how they leave the editor. */
const named = (c: DrawingColor | undefined) => SCH_LIGHT.drawing[c ?? "ink"]

/**
 * A drawing the drawing tools made, said the way a KiCad file says it: exact strokes, fills and text, which is
 * what `itemNode` writes. A drawing that already is exact is itself. An arrowhead is a small filled triangle of
 * its own, since KiCad's lines have none; a text with a border or a background is a text box.
 */
export function exactForm(d: SchematicDrawing, n: () => string): SchematicDrawing[] {
  if (isExact(d)) return [d]
  // Ink is KiCad's own default colour (none written), so it turns light in KiCad's dark theme; only a named colour is written.
  const color = d.color && d.color !== "ink" ? named(d.color) : undefined
  const stroke: SheetStroke = { width: WEIGHT_WIDTH[d.weight ?? "medium"], ...(d.dash && d.dash !== "solid" ? { dash: d.dash === "dashed" ? ("dash" as const) : ("dot" as const) } : {}), color }
  const paint: SheetFill | undefined = d.fill ? { kind: "color", color: withAlpha(named(d.fill), SCH_LIGHT.tint) } : undefined
  if (d.type === "line") {
    const points = d.closed && d.points.length > 2 ? [...d.points, d.points[0]] : d.points
    const out: SchematicDrawing[] = [{ id: d.id, type: "line", points, stroke, ...(d.closed && paint ? { paint } : {}), ...(d.ruleArea ? { ruleArea: d.ruleArea, closed: true } : {}) }]
    if (!d.closed && d.arrows) {
      const heads = [...(d.arrows === "end" || d.arrows === "both" ? [{ tip: d.points[d.points.length - 1], from: d.points[d.points.length - 2] }] : []), ...(d.arrows === "start" || d.arrows === "both" ? [{ tip: d.points[0], from: d.points[1] }] : [])]
      for (const h of heads) {
        const len = 0.06 + stroke.width! * 3
        const dx = h.tip.x - h.from.x
        const dy = h.tip.y - h.from.y
        const l = Math.hypot(dx, dy) || 1
        const [ux, uy] = [dx / l, dy / l]
        const back = { x: h.tip.x - ux * len, y: h.tip.y - uy * len }
        const half = len * 0.42
        out.push({ id: n(), type: "line", points: [h.tip, { x: back.x - uy * half, y: back.y + ux * half }, { x: back.x + uy * half, y: back.y - ux * half }, h.tip], stroke: { width: stroke.width, color }, paint: color ? { kind: "color", color } : { kind: "outline" } })
      }
    }
    return out
  }
  if (d.type === "rect") return [{ id: d.id, type: "rect", x: d.x, y: d.y, width: d.width, height: d.height, ...(d.radius ? { radius: d.radius } : {}), stroke, ...(paint ? { paint } : {}) }]
  if (d.type === "text") {
    const look = { ...lookOfText(d), color }
    if (d.border || d.fill) {
      const f = textFrame(d)
      const pad = d.size * 0.45
      return [{ id: d.id, type: "textbox", text: d.text, x: f.minX, y: f.maxY, w: f.maxX - f.minX, h: f.maxY - f.minY, rot: d.rot === 90 ? 90 : 0, margins: [pad, pad, pad, pad], look: { ...look, h: "left", v: "top" }, stroke: d.border ? stroke : { width: 0, color }, ...(paint ? { paint } : {}) }]
    }
    return [{ ...d, size: d.size, valign: "top", align: d.align ?? "left", stroke: { color } }]
  }
  return [d]
}

/** Segments per corner of the polygon that carries the fill of a rounded rectangle. */
const CORNER_STEPS = 16

/**
 * A rounded rectangle for a KiCad 9 file, which has no radius on a rectangle: four lines and four arcs for the
 * outline, exact, each with the rectangle's stroke, and when it has a fill, a polygon behind them that follows
 * the corners in short straight steps (an arc cannot be filled to a corner of its own), within 0.004 mm at
 * 2.54 mm. The polygon carries the stroke too, so no outline shows where the fill ends; a dashed rectangle has its
 * gaps drawn solid by it, which the export's notes say.
 */
function roundedRectangle(g: { x0: number; y0: number; x1: number; y1: number; r: number }, item: Extract<SchematicDrawing, { type: "rect" }>, at: (p: Vec2) => string, xy: (p: Vec2) => string, n: number): string {
  const { x0, y0, x1, y1, r } = g
  const tail = (k: number) => `\n    ${strokeNode(item.stroke)}\n    (fill (type none))\n    (uuid ${subUuidOf(n, k)})\n  )`
  const out: string[] = []
  if (item.paint) {
    const pts: Vec2[] = []
    for (const [cx, cy, from] of [[x1 - r, y0 + r, -90], [x1 - r, y1 - r, 0], [x0 + r, y1 - r, 90], [x0 + r, y0 + r, 180]] as const) {
      for (let i = 0; i <= CORNER_STEPS; i++) {
        const a = ((from + (90 * i) / CORNER_STEPS) * Math.PI) / 180
        pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) })
      }
    }
    out.push(`  (polyline\n    (pts ${[...pts, pts[0]].map(xy).join(" ")})\n    ${strokeNode(item.stroke && { ...item.stroke, dash: undefined })}\n    ${fillNode(item.paint)}\n    (uuid ${subUuidOf(n, 99)})\n  )`)
  }
  const sides: [Vec2, Vec2][] = [
    [{ x: x0 + r, y: y0 }, { x: x1 - r, y: y0 }],
    [{ x: x1, y: y0 + r }, { x: x1, y: y1 - r }],
    [{ x: x1 - r, y: y1 }, { x: x0 + r, y: y1 }],
    [{ x: x0, y: y1 - r }, { x: x0, y: y0 + r }],
  ]
  sides.forEach(([a, b], k) => out.push(`  (polyline\n    (pts ${xy(a)} ${xy(b)})${tail(10 + k)}`))
  const c = Math.SQRT1_2 * r
  const corners: [Vec2, Vec2, Vec2][] = [
    [{ x: x1 - r, y: y0 }, { x: x1 - r + c, y: y0 + r - c }, { x: x1, y: y0 + r }],
    [{ x: x1, y: y1 - r }, { x: x1 - r + c, y: y1 - r + c }, { x: x1 - r, y: y1 }],
    [{ x: x0 + r, y: y1 }, { x: x0 + r - c, y: y1 - r + c }, { x: x0, y: y1 - r }],
    [{ x: x0, y: y0 + r }, { x: x0 + r - c, y: y0 + r - c }, { x: x0 + r, y: y0 }],
  ]
  corners.forEach(([a, m, b], k) => out.push(`  (arc\n    (start ${at(a)})\n    (mid ${at(m)})\n    (end ${at(b)})${tail(20 + k)}`))
  return out.join("\n")
}

/** Whether a drawing is a rounded rectangle (which KiCad 9 draws as lines and arcs) and whether it has a fill. */
export const roundedFill = (d: SchematicDrawing) => d.type === "rect" && !!d.radius && d.radius > 0 && !!(d.paint ?? (d as { fill?: unknown }).fill)

/** A drawing as KiCad writes it for the sheet: a text, a text box, a line or shape, a picture, a table, a junction dot or a no-connect flag. */
export function itemNode(item: SchematicDrawing, toPage: ToPage, n: number): string {
  const xy = (p: Vec2) => {
    const q = toPage(p)
    return `(xy ${mm6(q.x)} ${mm6(q.y)})`
  }
  const at = (p: Vec2) => {
    const q = toPage(p)
    return `${mm6(q.x)} ${mm6(q.y)}`
  }
  const uuid = `(uuid ${uuidOf(n)})`
  const fillOf = (d: { paint?: SheetFill }) => fillNode(d.paint)
  switch (item.type) {
    case "text":
      return `  (text ${quote(item.text)}\n    ${sim(item.excludeFromSim)}\n    (at ${at(item)} ${item.rot ?? 0})\n    ${effects(lookOfText(item))}\n    ${uuid}\n  )`
    case "textbox": {
      const m = item.margins ? `\n    (margins ${item.margins.map((v) => L(v)).join(" ")})` : ""
      return `  (text_box ${quote(item.text)}\n    ${sim(item.excludeFromSim)}\n    (at ${at(item)} ${item.rot})\n    (size ${L(item.w)} ${L(item.h)})${m}\n    ${strokeNode(item.stroke)}\n    ${fillOf(item)}\n    ${effects(item.look)}\n    ${uuid}\n  )`
    }
    case "line":
      // S8: a rule area is KiCad 9's `(rule_area (polyline ...))`: its polygon is closed by the reader, so the first point is not written again. Its flags are not in the KiCad 9 file (`model/ruleAreas.ts` puts them on the symbols inside).
      if (item.ruleArea) {
        const first = item.points[0]
        const last = item.points[item.points.length - 1]
        const pts = item.points.length > 3 && first.x === last.x && first.y === last.y ? item.points.slice(0, -1) : item.points
        return `  (rule_area\n    (polyline\n      (pts ${pts.map(xy).join(" ")})\n      ${strokeNode(item.stroke)}\n      ${fillOf(item)}\n      (uuid ${uuidOf(n)})\n    )\n  )`
      }
      return `  (polyline\n    (pts ${item.points.map(xy).join(" ")})\n    ${strokeNode(item.stroke)}\n    ${fillOf(item)}\n    ${uuid}\n  )`
    case "rect": {
      const x0 = Math.min(item.x, item.x + item.width)
      const x1 = Math.max(item.x, item.x + item.width)
      const y0 = Math.min(item.y, item.y + item.height)
      const y1 = Math.max(item.y, item.y + item.height)
      // KiCad 9 reads only start, end, stroke, fill and uuid in a rectangle, so a rounded one is lines and arcs.
      const r = Math.min(item.radius ?? 0, (x1 - x0) / 2, (y1 - y0) / 2)
      if (!(r > 0)) return `  (rectangle
    (start ${at({ x: item.x, y: item.y })})
    (end ${at({ x: item.x + item.width, y: item.y + item.height })})
    ${strokeNode(item.stroke)}
    ${fillOf(item)}
    ${uuid}
  )`
      return roundedRectangle({ x0, y0, x1, y1, r }, item, at, xy, n)
    }
    case "circle":
      return `  (circle\n    (center ${at(item)})\n    (radius ${L(item.radius)})\n    ${strokeNode(item.stroke)}\n    ${fillOf(item)}\n    ${uuid}\n  )`
    case "arc":
      return `  (arc\n    (start ${at(item.start)})\n    (mid ${at(item.mid)})\n    (end ${at(item.end)})\n    ${strokeNode(item.stroke)}\n    ${fillOf(item)}\n    ${uuid}\n  )`
    case "bezier":
      return `  (bezier\n    (pts ${item.points.map(xy).join(" ")})\n    ${strokeNode(item.stroke)}\n    ${fillOf(item)}\n    ${uuid}\n  )`
    case "image": {
      const data = item.data.match(/.{1,76}/g) ?? [item.data]
      return `  (image\n    (at ${at(item)})${item.scale !== 1 ? `\n    (scale ${mm6(item.scale)})` : ""}\n    ${uuid}\n    (data ${data.map((d) => `"${d}"`).join("\n      ")})\n  )`
    }
    case "junction": {
      const d = item.diameter ? `\n    (diameter ${L(item.diameter)})` : "\n    (diameter 0)"
      return `  (junction\n    (at ${at(item)})${d}\n    ${item.dotColor ? colorNode(item.dotColor) : "(color 0 0 0 0)"}\n    ${uuid}\n  )`
    }
    case "noconnect":
      return `  (no_connect\n    (at ${at(item)})\n    ${uuid}\n  )`
    case "directive": {
      // S8: `(netclass_flag "" (length L) (shape round) (at x y angle) (fields_autoplaced yes) (effects ...) (uuid ...) (property ...))`, as KiCad 9 and 10 write it.
      const fields = item.fields.map((f) => fieldNode(f, item, toPage))
      return [
        `  (netclass_flag ${quote(item.text)}`,
        `    (length ${L(item.length)})`,
        `    (shape ${item.shape})`,
        `    (at ${at(item)} ${item.rot})`,
        ...(item.fieldsAutoplaced && item.fields.length ? ["    (fields_autoplaced yes)"] : []),
        `    ${effects(item.look)}`,
        `    (uuid ${uuidOf(n)})`,
        ...fields,
        "  )",
      ].join("\n")
    }
    case "bus": {
      // KiCad's bus is one segment each: a polyline of several is written as several.
      const segs: string[] = []
      for (let k = 0; k + 1 < item.points.length; k++) segs.push(`  (bus\n    (pts ${xy(item.points[k])} ${xy(item.points[k + 1])})\n    ${strokeNode(item.stroke)}\n    (uuid ${subUuidOf(n, k + 700)})\n  )`)
      return segs.join("\n")
    }
    case "busentry": {
      // KiCad 6 and later have one kind of bus entry in the file, from a wire to a bus; a bus-to-bus entry (KiCad 5's) joins two buses, which a short bus segment does too.
      if (item.toBus) return `  (bus\n    (pts ${xy(item)} ${xy({ x: item.x + item.dx, y: item.y + item.dy })})\n    ${strokeNode(item.stroke)}\n    ${uuid}\n  )`
      // `(size x y)` is the run to the far end on the page, y down: the editor's dy is up.
      return `  (bus_entry\n    (at ${at(item)})\n    (size ${mm6(item.dx * MM)} ${mm6(-item.dy * MM)})\n    ${strokeNode(item.stroke)}\n    ${uuid}\n  )`
    }
    case "table": {
      const cells = item.cells
        .map((c, i) => {
          const p = toPage(c)
          const m = c.margins ? `\n          (margins ${c.margins.map((v) => L(v)).join(" ")})` : ""
          return `        (table_cell ${quote(c.text)}\n          ${sim(c.excludeFromSim)}\n          (at ${mm6(p.x)} ${mm6(p.y)} ${c.rot})\n          (size ${L(c.w)} ${L(c.h)})${m}\n          (span ${c.colSpan} ${c.rowSpan})\n          ${fillNode(c.fill)}\n          ${effects(c.look)}\n          (uuid ${subUuidOf(n, i + 500)})\n        )`
        })
        .join("\n")
      const yes = (b: boolean) => (b ? "yes" : "no")
      return `  (table\n    (column_count ${item.columns})\n    (border\n      (external ${yes(item.border.external)})\n      (header ${yes(item.border.header)})\n      ${strokeNode(item.border.stroke)}\n    )\n    (separators\n      (rows ${yes(item.separators.rows)})\n      (cols ${yes(item.separators.cols)})\n      ${strokeNode(item.separators.stroke)}\n    )\n    (column_widths ${item.columnWidths.map((w) => L(w)).join(" ")})\n    (row_heights ${item.rowHeights.map((h) => L(h)).join(" ")})\n    (cells\n${cells}\n    )\n  )`
    }
  }
}

/** The schematic with the drawings before its closing bracket. */
export function addSheetItems(sch: string, drawings: SchematicDrawing[], toPage: ToPage): string {
  if (!drawings.length) return sch
  let spare = 0
  const exact = drawings.flatMap((d) => exactForm(d, () => `arrowhead-${spare++}`))
  const text = exact.map((it, i) => itemNode(it, toPage, i + 1)).join("\n") + "\n"
  const end = sch.lastIndexOf("\n)")
  return end < 0 ? sch : `${sch.slice(0, end + 1)}${text}${sch.slice(end + 1)}`
}

/**
 * S3: the labels that name a bus, which the converter does not write (it writes a label for each net a label names, and a bus is no net), and
 * the bus aliases of the sheet (`(bus_alias "NAME" (members "A" "B"))`, what KiCad 9's `saveBusAlias` writes), before the closing bracket.
 */
export function addBusItems(sch: string, labels: NetLabel[], aliases: { name: string; members: string[] }[], toPage: ToPage): string {
  if (!labels.length && !aliases.length) return sch
  const lines = [...aliases.map((a) => `  (bus_alias ${quote(escapeNetName(a.name))} (members ${a.members.map((m) => quote(escapeNetName(m))).join(" ")}))`), ...labels.map((l, i) => labelNode(l, toPage, busLabelUuidOf(i)))]
  const end = sch.lastIndexOf("\n)")
  return end < 0 ? sch : `${sch.slice(0, end + 1)}${lines.join("\n")}\n${sch.slice(end + 1)}`
}

const GLOBAL_LABEL = /\n {2}\(global_label [^\n]*\n[\s\S]*?\n {2}\)(?=\n)/g

/**
 * The labels the converter wrote (every one a global label, in the order of the project's labels), written as the
 * project has them. Returns the schematic unchanged when the converter wrote another number of them than the
 * project has, since they cannot then be told apart.
 */
export function rewriteLabels(sch: string, labels: NetLabel[], toPage: ToPage): { text: string; ok: boolean } {
  const blocks = [...sch.matchAll(GLOBAL_LABEL)]
  if (blocks.length !== labels.length) return { text: sch, ok: labels.length === 0 }
  let i = 0
  return { text: sch.replace(GLOBAL_LABEL, (block) => `\n${labelNode(labels[i++], toPage, block.match(/\(uuid ([0-9a-f-]+)\)/)?.[1] ?? labelUuidOf(i))}`), ok: true }
}

/** The wires the converter wrote (one for each edge of each wire, in order), with the strokes the project's wires have. */
export function rewriteWireStrokes(sch: string, strokes: (SheetStroke | undefined)[]): { text: string; ok: boolean } {
  if (!strokes.some(Boolean)) return { text: sch, ok: true }
  const WIRE = /\n {2}\(wire\n[\s\S]*?\n {2}\)(?=\n)/g
  const blocks = [...sch.matchAll(WIRE)]
  if (blocks.length !== strokes.length) return { text: sch, ok: false }
  let i = 0
  return { text: sch.replace(WIRE, (block) => block.replace(/\n {4}\(stroke[\s\S]*?\n {4}\)/, () => `\n    ${strokeNode(strokes[i++])}`)), ok: true }
}

/** What flags a placed symbol has in KiCad's file: the converter writes the defaults. */
export function flagLines(c: Pick<ComponentInstance, "flags" | "fieldsAutoplaced"> | undefined): { dnp: string; bom: string; board: string; sim: string; autoplaced: string } {
  const yes = (b: boolean) => (b ? "yes" : "no")
  const flags = c?.flags
  return { dnp: `(dnp ${yes(!!flags?.dnp)})`, bom: `(in_bom ${yes(!flags?.excludeFromBom)})`, board: `(on_board ${yes(!flags?.notOnBoard)})`, sim: `(exclude_from_sim ${yes(!!flags?.excludeFromSim)})`, autoplaced: `(fields_autoplaced ${yes(!!c?.fieldsAutoplaced)})` }
}

/** The placed symbols of the schematic with their flags, found by reference. */
export function applySymbolFlags(sch: string, byRef: Map<string, Pick<ComponentInstance, "flags" | "fieldsAutoplaced">>): string {
  if (!byRef.size) return sch
  return sch.replace(/\n {2}\(symbol\n {4}\(lib_id [^\n]*\n[\s\S]*?\n {2}\)(?=\n)/g, (block) => {
    const ref = block.match(/\(property "Reference" "([^"]*)"/)?.[1]
    const c = ref === undefined ? undefined : byRef.get(ref)
    if (!c) return block
    const l = flagLines(c)
    return block
      .replace(/\(exclude_from_sim (?:yes|no)\)/, l.sim)
      .replace(/\(in_bom (?:yes|no)\)/, l.bom)
      .replace(/\(on_board (?:yes|no)\)/, l.board)
      .replace(/\(dnp (?:yes|no)\)/, l.dnp)
      .replace(/\(fields_autoplaced (?:yes|no)\)/, l.autoplaced)
  })
}

const POWER_LIB = /\n {4}\(symbol "(Custom:[^"]+)"\n[\s\S]*?\n {4}\)(?=\n)/g

/**
 * The power symbols of the given names written as KiCad 9's local power symbols: the converter writes one global library symbol
 * for each shape, so the placed symbols with a local name get a library symbol of their own (`<name>_local`) with `(power local)`,
 * which is what makes their net belong to the sheet they are on, as the editor has it.
 */
export function localizePower(sch: string, texts: Set<string>): string {
  if (!texts.size) return sch
  const used = new Set<string>()
  let out = sch.replace(/\n {2}\(symbol\n {4}\(lib_id "(Custom:[^"]+)"\)[\s\S]*?\n {2}\)(?=\n)/g, (block, lib: string) => {
    const ref = block.match(/\(property "Reference" "([^"]*)"/)?.[1] ?? ""
    const value = block.match(/\(property "Value" "([^"]*)"/)?.[1]
    if (!ref.startsWith("#PWR") || value === undefined || !texts.has(value)) return block
    used.add(lib)
    return block.replace(`(lib_id "${lib}")`, `(lib_id "${lib}_local")`)
  })
  if (!used.size) return sch
  // A copy of each library symbol beside the original, renamed, with the power flag local.
  const placed = out
  out = out.replace(POWER_LIB, (block, lib: string) => {
    if (!used.has(lib)) return block
    const bare = lib.slice(lib.indexOf(":") + 1)
    const copy = block
      .replace(`(symbol "${lib}"`, `(symbol "${lib}_local"`)
      .replaceAll(`(symbol "${bare}_`, `(symbol "${bare}_local_`)
      .replace(/\(power global\)/, "(power local)")
    // The original goes when no placed symbol is left that uses it.
    return placed.includes(`(lib_id "${lib}")`) ? `${block}${copy}` : copy
  })
  return out
}
