import { orientPoint, round } from "../../lib/geometry"
import { blockFrames } from "../../model/blocks"
import type { SchematicConnectivity } from "../../model/connectivity"
import { drawingBounds, LINE_HEIGHT, textFrame, textLines } from "../../model/drawings"
import { dirVector, isSchematicPart, powerNetName, schematicBounds, schematicPins, valueText, type WorldPin } from "../../model/instances"
import { findPart } from "../../model/library"
import { pinTypeOfKind } from "../../model/pinKinds"
import { samplePrimitive } from "../../model/primitiveGeometry"
import { copyKey, isHierarchical, sheetsOf, sheetView, usesOfSheet, ROOT_SHEET } from "../../model/sheets"
import { arcCircle } from "../../model/shapes"
import { lookOfText, textLines as kicadLines, textLines2 } from "../../model/sheetItems"
import { componentFields, FIELD_SIZE, symbolOf, symbolTextOnSheet, unitCount } from "../../model/symbolDrawing"
import type { ComponentInstance, DrawingText, LabelShape, PartDef, PinType, Project, SymbolPort, SymbolPrimitive, Vec2 } from "../../model/types"
import { writeCfb } from "./cfb"
import { Bytes, overbar, props, propRecord, uniqueId, type PropValue } from "./records"

// A `.SchDoc`: Altium's schematic sheet, a compound file whose `FileHeader` stream is a header and then one property list (`|RECORD=1|...`) per object, in
// order: the sheet (index 0), then each object, the ones a part owns right after it and naming it by its index (`OWNERINDEX`). Everything is in
// Altium's schematic unit, ten mils, with y up as in the editor; a part's drawing is written where it is on the sheet, already turned and mirrored,
// which is how Altium stores a placed part. The editor's unit is 500 mils (a pin pitch of 0.1 is 50 mils), so a unit is 50 of Altium's.

const K = 50
/** The editor's colours as Altium's (a Delphi TColor: red in the low byte): wires navy, part outlines blue, bodies pale yellow, labels dark red. */
const NAVY = 0x800000
const BLUE = 0xff0000
const PALE = 0xb0ffff
const DARK_RED = 0x000080
const SHEET_PAPER = 0xf8fcff
/**
 * Altium sizes a schematic font by its cell, from the top of its ascent to the bottom of its descent: `SIZE` n is n × 10 mils, which in Arial is
 * an em 1.117 times smaller (its Windows ascent and descent, 1854 and 434 of 2048). Measured on a title block Altium saved (AltiumSharp's
 * `SPI Isolator.SchDoc`): only at this scale does its disclaimer fit its box and its revision table's headers sit centred in their columns. Fonts
 * were sized at 6 mils a point before, which drew every text 1.49 times the editor's from where it is anchored: a title ran into the line under it
 * and a note past the page.
 */
const ARIAL_CELL = (1854 + 434) / 2048

export interface SchContext {
  project: Project
  sch: SchematicConnectivity
  netNames: Map<string, string>
  /** The file of each sheet, by sheet id. */
  sheetFiles: Map<string, string>
  /** The unique id of each part (by `copyKey`) and each sheet symbol, which the board's parts name. */
  componentIds: Map<string, string>
  symbolIds: Map<string, string>
  ids: Set<string>
}

/** Altium's standard sheets, landscape, by the size of their drawing area in its unit. */
const SHEETS: { style: number; w: number; h: number }[] = [
  { style: 0, w: 1150, h: 760 },
  { style: 1, w: 1550, h: 1110 },
  { style: 2, w: 2230, h: 1570 },
  { style: 3, w: 3150, h: 2230 },
  { style: 4, w: 4460, h: 3150 },
]

/** A Delphi colour of a CSS one (`#rrggbb` or `rgba(r,g,b,a)`), or undefined. */
function colorOf(css: string | undefined): number | undefined {
  if (!css) return undefined
  const hex = /^#([0-9a-f]{6})$/i.exec(css)
  if (hex) {
    const n = parseInt(hex[1], 16)
    return ((n & 0xff) << 16) | (n & 0xff00) | ((n >> 16) & 0xff)
  }
  const rgb = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(css)
  if (rgb) return (Number(rgb[3]) << 16) | (Number(rgb[2]) << 8) | Number(rgb[1])
  return undefined
}

/** Altium's line width of an editor width (in units): smallest, small (10 mils), medium (20) or large (40). */
function lineWidth(units: number | undefined): number {
  const mils = (units ?? 0.01) * 500
  return mils < 3 ? 0 : mils < 15 ? 1 : mils < 30 ? 2 : 3
}

/** An Altium electrical type of a pin. */
function electrical(type: PinType | undefined): number {
  switch (type) {
    case "input":
      return 0
    case "bidirectional":
      return 1
    case "output":
      return 2
    case "open_collector":
      return 3
    case "tri_state":
      return 5
    case "open_emitter":
      return 6
    case "power_in":
    case "power_out":
      return 7
    default:
      return 4
  }
}

const ORIENT = { right: 0, up: 1, left: 2, down: 3 } as const
const OPPOSITE = { right: "left", left: "right", up: "down", down: "up" } as const

type Pairs = [string, PropValue][]

/** The writer of one sheet: its records in order and the fonts they use. */
class Sheet {
  records: Pairs[] = []
  fonts = new Map<string, { size: number; bold: boolean; italic: boolean }>()
  private top = 0
  constructor(
    readonly ox: number,
    readonly oy: number,
  ) {
    this.records.push([])
    this.font(FIELD_SIZE)
  }
  /** A point in Altium's unit. */
  at(p: Vec2): Vec2 {
    return { x: (p.x - this.ox) * K, y: (p.y - this.oy) * K }
  }
  /** A record; its index, by which the objects it owns name it. */
  add(pairs: Pairs, owner?: number): number {
    if (owner === undefined) pairs.splice(1, 0, ["INDEXINSHEET", this.top++])
    this.records.push(pairs)
    return this.records.length - 1
  }
  /** The font id of a text of `size` units: the editor's size is the em, and Altium's is the cell (see `ARIAL_CELL`). */
  font(size: number, bold = false, italic = false): number {
    const pts = Math.max(1, Math.round((size * 500 * ARIAL_CELL) / 10))
    const key = `${pts}|${bold}|${italic}`
    if (!this.fonts.has(key)) this.fonts.set(key, { size: pts, bold, italic })
    return [...this.fonts.keys()].indexOf(key) + 1
  }
}

/** A coordinate as Altium writes one: the whole part, and the rest in hundred-thousandths when there is any. */
function coord(key: string, v: number, frac = `${key}_FRAC`): Pairs {
  const r = round(v, 5)
  let whole = Math.floor(r)
  let f = Math.round((r - whole) * 100000)
  if (f >= 100000) {
    whole++
    f -= 100000
  }
  return f ? [[key, whole], [frac, f]] : [[key, whole]]
}
const loc = (p: Vec2, key = "LOCATION"): Pairs => [...coord(`${key}.X`, p.x), ...coord(`${key}.Y`, p.y)]
const pointList = (pts: Vec2[], prefix = ""): Pairs => [["LOCATIONCOUNT", pts.length], ...pts.flatMap((p, i) => [...coord(`${prefix}X${i + 1}`, p.x), ...coord(`${prefix}Y${i + 1}`, p.y)])]

/** Altium's justification (0 bottom-left to 8 top-right) and orientation of a text that extends from its anchor the way `extent` says. */
function placement(extent: { x: number; y: number }, vertical: boolean): { ORIENTATION: number; JUSTIFICATION: number } {
  const along = vertical ? extent.y : extent.x
  const across = vertical ? -extent.x : extent.y
  const col = along > 0 ? 0 : along < 0 ? 2 : 1
  const row = across > 0 ? 0 : across < 0 ? 2 : 1
  return { ORIENTATION: vertical ? 1 : 0, JUSTIFICATION: row * 3 + col }
}

/**
 * A text of the drawing tools as Altium's text strings, one a line, each anchored where the editor draws that line. A text string holds one line;
 * a text frame would lay the lines out itself, by its own line pitch and wrapping, and Altium reads its alignment by a number nothing confirms past
 * left. The editor's own text hangs its lines down from its top at its pitch (sideways when it reads upwards), and a KiCad text is laid out as
 * the canvas lays it out (`textLines2`), its `~{overbar}` drawn as Altium's.
 */
function drawingTextLines(d: DrawingText): { text: string; at: Vec2; place: ReturnType<typeof placement>; size: number }[] {
  if (d.valign) return textLines2(d, d.rot ?? 0, lookOfText(d), kicadLines(d.text)).flatMap((l) => (l.text ? [{ text: overbar(l.text), at: { x: l.x, y: l.y }, place: placement(l.extent, l.vertical), size: l.size }] : []))
  const upwards = d.rot === 90
  const col = d.align === "right" ? 2 : d.align === "center" ? 1 : 0
  const pitch = d.size * LINE_HEIGHT
  return textLines(d).flatMap((text, i) => (text ? [{ text, at: upwards ? { x: d.x + i * pitch, y: d.y } : { x: d.x, y: d.y - i * pitch }, place: { ORIENTATION: upwards ? 1 : 0, JUSTIFICATION: 6 + col }, size: d.size }] : []))
}

/** The pin line of a port: a straight two-point path of the symbol that starts at the port and runs into the body. Its index and length, or null. */
function pinLine(symbol: { primitives: SymbolPrimitive[] }, port: SymbolPort): { index: number; length: number } | null {
  const d = dirVector(port.dir)
  for (const [index, p] of symbol.primitives.entries()) {
    if (p.type !== "path" || p.points.length !== 2 || p.fill) continue
    for (const [a, b] of [
      [p.points[0], p.points[1]],
      [p.points[1], p.points[0]],
    ]) {
      if (Math.abs(a.x - port.x) > 1e-6 || Math.abs(a.y - port.y) > 1e-6) continue
      const v = { x: b.x - a.x, y: b.y - a.y }
      const length = Math.hypot(v.x, v.y)
      if (length < 1e-6) continue
      // It runs from the port back into the body: against the way a wire leaves.
      if (Math.abs(v.x / length + d.x) < 1e-6 && Math.abs(v.y / length + d.y) < 1e-6) return { index, length }
    }
  }
  return null
}

interface SheetOut {
  bytes: Uint8Array
}

/** Every sheet of the project as a `.SchDoc`, by file name. */
export function writeSchDocs(ctx: SchContext): { files: Map<string, Uint8Array>; notes: string[] } {
  const { project } = ctx
  const notes = new Set<string>()
  const files = new Map<string, Uint8Array>()
  const hierarchical = isHierarchical(project)
  for (const sheet of sheetsOf(project)) {
    const file = ctx.sheetFiles.get(sheet.id)!
    const uses = hierarchical ? usesOfSheet(project, sheet.id) : []
    if (hierarchical && !uses.length) {
      notes.add("A sheet no sheet symbol uses is written empty.")
    }
    const path = uses[0]?.path ?? ""
    const view = hierarchical ? (uses.length ? sheetView(project, path) : { ...project, components: [], wires: [], labels: [], drawings: [], blocks: [], scope: "" }) : project
    const junctions = hierarchical ? (ctx.sch.byUse?.junctions.get(path) ?? []) : ctx.sch.junctions
    const out = writeSheet(ctx, view, sheet.id, junctions, notes)
    files.set(file, out.bytes)
    if (hierarchical && uses.length > 1) notes.add(`A sheet used by more than one sheet symbol is one file, drawn with the parts of its first use; the board has the parts of every use, each naming its own sheet symbol.`)
  }
  return { files, notes: [...notes] }
}

function writeSheet(ctx: SchContext, view: Project, sheetId: string, junctions: Vec2[], notes: Set<string>): SheetOut {
  const { project } = ctx
  const onSheet = <T extends { sheet?: string }>(items: readonly T[]) => items.filter((i) => (i.sheet ?? ROOT_SHEET) === sheetId)
  const wires = onSheet(view.wires)
  const labels = onSheet(view.labels)
  const drawings = onSheet(view.drawings ?? [])
  const symbols = (project.sheetSymbols ?? []).filter((s) => s.sheet === sheetId)
  const components = view.components

  // The sheet: the smallest standard size the drawing fits on with an inch round it, the drawing in its middle on a 100-mil grid.
  const box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }
  const grow = (p: Vec2) => {
    box.minX = Math.min(box.minX, p.x)
    box.minY = Math.min(box.minY, p.y)
    box.maxX = Math.max(box.maxX, p.x)
    box.maxY = Math.max(box.maxY, p.y)
  }
  for (const c of components) {
    const b = schematicBounds(c)
    grow({ x: b.minX, y: b.minY })
    grow({ x: b.maxX, y: b.maxY })
  }
  for (const w of wires) w.points.forEach(grow)
  for (const l of labels) grow(l)
  for (const s of symbols) {
    grow({ x: s.x, y: s.y })
    grow({ x: s.x + s.w, y: s.y + s.h })
  }
  for (const d of drawings) {
    const b = drawingBounds(d)
    if (b.minX > b.maxX) continue
    grow({ x: b.minX, y: b.minY })
    grow({ x: b.maxX, y: b.maxY })
  }
  if (!Number.isFinite(box.minX)) Object.assign(box, { minX: 0, minY: 0, maxX: 1, maxY: 1 })
  const contentW = (box.maxX - box.minX) * K
  const contentH = (box.maxY - box.minY) * K
  const fit = SHEETS.find((s) => s.w >= contentW + 200 && s.h >= contentH + 200)
  const sheetW = fit?.w ?? Math.ceil((contentW + 200) / 100) * 100
  const sheetH = fit?.h ?? Math.ceil((contentH + 200) / 100) * 100
  const grid = 0.2
  const ox = Math.round((box.minX - (sheetW / K - (box.maxX - box.minX)) / 2) / grid) * grid
  const oy = Math.round((box.minY - (sheetH / K - (box.maxY - box.minY)) / 2) / grid) * grid
  const s = new Sheet(ox, oy)

  // The sheet's own parameters, which special strings and a title block show.
  for (const [name, text] of [
    ["Title", project.name],
    ["DocumentName", ctx.sheetFiles.get(sheetId) ?? ""],
    ...(project.properties ?? []).map((p) => [p.key, p.value]),
  ] as [string, string][]) {
    s.add([["RECORD", 41], ["OWNERPARTID", -1], ["COLOR", DARK_RED], ["FONTID", 1], ["ISHIDDEN", true], ["TEXT", text || "*"], ["NAME", name], ["READONLYSTATE", 1], ["UNIQUEID", uniqueId(`sheetparam:${sheetId}:${name}`, ctx.ids)]])
  }

  // ---------- parts ----------
  let unplacedPins = 0
  for (const c of components) {
    const part = findPart(c.partId)
    if (!part) continue
    const net = powerNetName(c, part)
    if (part.powerNet || (!isSchematicPart(part) && net)) {
      powerPort(s, c, part, net ?? part.powerNet ?? "", ctx)
      continue
    }
    unplacedPins += writePart(s, ctx, c, part)
  }
  if (unplacedPins) notes.add("Pins with no pin line in their symbol are written as pins of no length at their tip, with the symbol drawn as it is.")

  // ---------- sheet symbols ----------
  for (const sym of symbols) {
    const tl = s.at({ x: sym.x, y: sym.y + sym.h })
    const index = s.add([
      ["RECORD", 15],
      ["OWNERPARTID", -1],
      ...loc(tl),
      ...coord("XSIZE", sym.w * K),
      ...coord("YSIZE", sym.h * K),
      ["COLOR", DARK_RED],
      ["AREACOLOR", 0x80ff80],
      ["ISSOLID", true],
      ["UNIQUEID", ctx.symbolIds.get(sym.id)],
      ["SYMBOLTYPE", "Normal"],
    ])
    for (const pin of sym.pins) {
      const side = Math.abs(pin.x - sym.x) < 1e-6 ? 0 : Math.abs(pin.x - (sym.x + sym.w)) < 1e-6 ? 1 : Math.abs(pin.y - (sym.y + sym.h)) < 1e-6 ? 2 : 3
      const fromTop = side <= 1 ? (sym.y + sym.h - pin.y) * K : (pin.x - sym.x) * K
      const tens = Math.floor(fromTop / 10 + 1e-9)
      const frac = Math.round((fromTop - tens * 10) * 100000)
      s.add(
        [
          ["RECORD", 16],
          ["OWNERINDEX", index],
          ["OWNERPARTID", -1],
          ["SIDE", side],
          ["DISTANCEFROMTOP", tens],
          ...(frac ? ([["DISTANCEFROMTOP_FRAC1", frac]] as Pairs) : []),
          ["COLOR", DARK_RED],
          ["AREACOLOR", 0x80ffff],
          ["TEXTCOLOR", DARK_RED],
          ["TEXTFONTID", 1],
          ["TEXTSTYLE", "Full"],
          ["NAME", overbar(pin.name)],
          ["IOTYPE", ioType(pin.shape)],
          ["STYLE", side <= 1 ? 3 : 7],
          ["ARROWKIND", "Block & Triangle"],
          ["UNIQUEID", uniqueId(`entry:${sym.id}:${pin.id}`, ctx.ids)],
        ],
        index,
      )
    }
    const child = ctx.sheetFiles.get(sym.child) ?? ""
    s.add([["RECORD", 32], ["OWNERINDEX", index], ["OWNERPARTID", -1], ...loc({ x: tl.x, y: tl.y + 2 }), ["COLOR", DARK_RED], ["FONTID", 1], ["TEXT", sym.name || "Sheet"], ["UNIQUEID", uniqueId(`symname:${sym.id}`, ctx.ids)]], index)
    s.add([["RECORD", 33], ["OWNERINDEX", index], ["OWNERPARTID", -1], ...loc({ x: tl.x, y: tl.y - sym.h * K - 10 }), ["COLOR", DARK_RED], ["FONTID", 1], ["TEXT", child], ["UNIQUEID", uniqueId(`symfile:${sym.id}`, ctx.ids)]], index)
  }

  // ---------- wires, labels, junctions ----------
  for (const w of wires) {
    if (w.points.length < 2) continue
    s.add([["RECORD", 27], ["OWNERPARTID", -1], ["LINEWIDTH", 1], ["COLOR", colorOf(w.look?.color) ?? NAVY], ...pointList(w.points.map((p) => s.at(p))), ["UNIQUEID", uniqueId(`wire:${w.id}`, ctx.ids)]])
  }
  for (const l of labels) {
    const kind = l.kind ?? "local"
    const p = s.at(l)
    const orientation = ((l.rot ?? 0) / 90) % 4
    if (kind === "local") {
      // The label's point is where it joins; its text runs from there the way the label points, kept readable: a label pointing left or down is
      // Altium's label at 0 or 90 degrees justified at its right end.
      s.add([["RECORD", 25], ["OWNERPARTID", -1], ...loc(p), ["ORIENTATION", orientation % 2], ["JUSTIFICATION", orientation >= 2 ? 2 : 0], ["COLOR", DARK_RED], ["FONTID", s.font(l.look?.size ?? FIELD_SIZE)], ["TEXT", overbar(l.name)], ["UNIQUEID", uniqueId(`label:${l.id}`, ctx.ids)]])
    } else if (kind === "global") {
      // A global label joins every sheet, as Altium's power port does whatever the project's net scope.
      s.add([["RECORD", 17], ["OWNERPARTID", -1], ["STYLE", 1], ["SHOWNETNAME", true], ...loc(p), ["ORIENTATION", orientation], ["COLOR", DARK_RED], ["FONTID", 1], ["TEXT", overbar(l.name)], ["UNIQUEID", uniqueId(`label:${l.id}`, ctx.ids)]])
    } else {
      // A hierarchical label is a port: it joins the sheet entry of its name on the sheet symbol above. It runs from the label's point the way its text does.
      const width = Math.max(30, Math.ceil((l.name.length * 7 + 20) / 10) * 10)
      const horizontal = orientation % 2 === 0
      const start = orientation === 2 ? { x: p.x - width, y: p.y } : orientation === 3 ? { x: p.x, y: p.y - width } : p
      s.add([
        ["RECORD", 18],
        ["OWNERPARTID", -1],
        ["STYLE", horizontal ? 3 : 7],
        ["IOTYPE", ioType(l.shape)],
        ["ALIGNMENT", orientation === 2 || orientation === 3 ? 2 : 1],
        ["WIDTH", width],
        ...loc(start),
        ["COLOR", DARK_RED],
        ["FONTID", 1],
        ["AREACOLOR", 0x80ffff],
        ["TEXTCOLOR", DARK_RED],
        ["NAME", overbar(l.name)],
        ["UNIQUEID", uniqueId(`label:${l.id}`, ctx.ids)],
        ["HEIGHT", 10],
      ])
    }
  }
  for (const j of junctions) s.add([["RECORD", 29], ["INDEXINSHEET", -1], ["OWNERPARTID", -1], ...loc(s.at(j)), ["COLOR", NAVY]], 0)

  // ---------- drawings and blocks ----------
  let skipped = 0
  for (const d of drawings) {
    const color = colorOf(d.stroke?.color) ?? DARK_RED
    const width = lineWidth(d.stroke?.width)
    switch (d.type) {
      case "line":
        s.add([["RECORD", d.closed ? 7 : 6], ["OWNERPARTID", -1], ["LINEWIDTH", width], ["COLOR", color], ...pointList((d.closed ? d.points : d.points).map((p) => s.at(p))), ...(d.arrows === "start" || d.arrows === "both" ? ([["STARTLINESHAPE", 2]] as Pairs) : []), ...(d.arrows === "end" || d.arrows === "both" ? ([["ENDLINESHAPE", 2]] as Pairs) : [])])
        break
      case "rect": {
        const a = s.at({ x: d.x, y: d.y })
        const b = s.at({ x: d.x + d.width, y: d.y + d.height })
        const lo = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y) }
        const hi = { x: Math.max(a.x, b.x), y: Math.max(a.y, b.y) }
        const filled = !!d.fill || !!d.paint
        s.add([["RECORD", d.radius ? 10 : 14], ["OWNERPARTID", -1], ...loc(lo), ...loc(hi, "CORNER"), ...(d.radius ? [...coord("CORNERXRADIUS", d.radius * K), ...coord("CORNERYRADIUS", d.radius * K)] : []), ["LINEWIDTH", width], ["COLOR", color], ["AREACOLOR", colorOf(d.paint?.color) ?? PALE], ["ISSOLID", filled], ["TRANSPARENT", !filled]])
        break
      }
      case "circle":
        s.add([["RECORD", 8], ["OWNERPARTID", -1], ...loc(s.at(d)), ...coord("RADIUS", d.radius * K), ...coord("SECONDARYRADIUS", d.radius * K), ["LINEWIDTH", width], ["COLOR", color], ["AREACOLOR", colorOf(d.paint?.color) ?? PALE], ["ISSOLID", !!d.fill || !!d.paint]])
        break
      case "arc":
        arcRecord(s, [d.start, d.mid, d.end].map((p) => s.at(p)) as [Vec2, Vec2, Vec2], width, color, -1)
        break
      case "bezier":
        s.add([["RECORD", 5], ["OWNERPARTID", -1], ["LINEWIDTH", width], ["COLOR", color], ...pointList(d.points.map((p) => s.at(p)))])
        break
      case "text": {
        if (d.hidden) break
        const ink = colorOf(d.stroke?.color) ?? NAVY
        // The border and tint the editor draws round its own text (none round a KiCad text), a rectangle with the editor's rounded corners under the text.
        if (!d.valign && (d.border || d.fill)) {
          const f = textFrame(d)
          const area = colorOf(d.paint?.color) ?? PALE
          const radius = d.size * 0.25 * K
          s.add([["RECORD", 10], ["OWNERPARTID", -1], ...loc(s.at({ x: f.minX, y: f.minY })), ...loc(s.at({ x: f.maxX, y: f.maxY }), "CORNER"), ...coord("CORNERXRADIUS", radius), ...coord("CORNERYRADIUS", radius), ["LINEWIDTH", width], ["COLOR", d.border ? ink : area], ["AREACOLOR", area], ["ISSOLID", !!d.fill], ["TRANSPARENT", !d.fill]])
        }
        for (const line of drawingTextLines(d)) s.add([["RECORD", 4], ["OWNERPARTID", -1], ...loc(s.at(line.at)), ...Object.entries(line.place), ["COLOR", ink], ["FONTID", s.font(line.size, !!d.bold, !!d.italic)], ["TEXT", line.text]])
        break
      }
      case "textbox": {
        // A KiCad text box is Altium's text frame: a box its text wraps in, hanging down from its corner (`boxCorners`).
        const lo = s.at({ x: d.x, y: d.y - d.h })
        s.add([["RECORD", 28], ["OWNERPARTID", -1], ...loc(lo), ...loc({ x: lo.x + d.w * K, y: lo.y + d.h * K }, "CORNER"), ["AREACOLOR", 0xffffff], ["FONTID", s.font(d.look?.size ?? FIELD_SIZE, !!d.look?.bold, !!d.look?.italic)], ["ALIGNMENT", 1], ["WORDWRAP", true], ["COLOR", NAVY], ["ISSOLID", false], ["SHOWBORDER", true], ["TEXT", d.text.split(/\r?\n/).join("~1")]])
        break
      }
      case "junction":
        s.add([["RECORD", 29], ["OWNERPARTID", -1], ...loc(s.at(d)), ["COLOR", NAVY]])
        break
      case "noconnect":
        s.add([["RECORD", 22], ["OWNERPARTID", -1], ...loc(s.at(d)), ["COLOR", 0xff], ["ISACTIVE", true], ["SYMBOL", "Thin Cross"]])
        break
      case "bus":
        s.add([["RECORD", 26], ["OWNERPARTID", -1], ["LINEWIDTH", 2], ["COLOR", NAVY], ...pointList(d.points.map((p) => s.at(p)))])
        break
      case "busentry": {
        const a = s.at(d)
        s.add([["RECORD", 37], ["OWNERPARTID", -1], ...loc(a), ...loc({ x: a.x + d.dx * K, y: a.y + d.dy * K }, "CORNER"), ["LINEWIDTH", 1], ["COLOR", NAVY]])
        break
      }
      default:
        skipped++
    }
  }
  if (skipped) notes.add("Pictures, tables and net class directives of a sheet are left out: Altium's schematic has no object for them as KiCad draws them.")
  for (const f of blockFrames(view)) {
    if (!components.some((c) => f.contents.components.includes(c.id))) continue
    const lo = s.at({ x: f.box.minX, y: f.box.minY })
    const hi = s.at({ x: f.box.maxX, y: f.box.maxY })
    s.add([["RECORD", 14], ["OWNERPARTID", -1], ...loc(lo), ...loc(hi, "CORNER"), ["LINEWIDTH", 1], ["COLOR", 0x808080], ["AREACOLOR", 0xffffff], ["ISSOLID", false], ["TRANSPARENT", true]])
    s.add([["RECORD", 4], ["OWNERPARTID", -1], ...loc(s.at(f.title)), ["JUSTIFICATION", 6], ["COLOR", 0x404040], ["FONTID", s.font(FIELD_SIZE * 1.4, true)], ["TEXT", f.name]])
  }

  // ---------- the sheet record and the file ----------
  const fonts = [...s.fonts.values()]
  s.records[0] = [
    ["RECORD", 31],
    ["FONTIDCOUNT", fonts.length],
    ...fonts.flatMap((f, i): Pairs => [[`SIZE${i + 1}`, f.size], [`FONTNAME${i + 1}`, "Arial"], ...(f.bold ? ([[`BOLD${i + 1}`, true]] as Pairs) : []), ...(f.italic ? ([[`ITALIC${i + 1}`, true]] as Pairs) : [])]),
    ["USEMBCS", true],
    ["ISBOC", true],
    ["HOTSPOTGRIDON", true],
    ["HOTSPOTGRIDSIZE", 4],
    ["SHEETSTYLE", fit?.style ?? 0],
    ["SYSTEMFONT", 1],
    ["BORDERON", true],
    ["TITLEBLOCKON", false],
    ["SHEETNUMBERSPACESIZE", 4],
    ["AREACOLOR", SHEET_PAPER],
    ["SNAPGRIDON", true],
    ["SNAPGRIDSIZE", 5],
    ["VISIBLEGRIDON", true],
    ["VISIBLEGRIDSIZE", 10],
    ["CUSTOMX", sheetW],
    ["CUSTOMY", sheetH],
    ["USECUSTOMSHEET", !fit],
    ["CUSTOMXZONES", 6],
    ["CUSTOMYZONES", 4],
    ["CUSTOMMARGINWIDTH", 20],
    ["DISPLAY_UNIT", 4],
  ]
  const data = new Bytes()
  propRecord(data, props([["HEADER", "Protel for Windows - Schematic Capture Binary File Version 5.0"], ["WEIGHT", s.records.length], ["MINORVERSION", 2], ["UNIQUEID", uniqueId(`doc:${sheetId}`, ctx.ids)]]))
  for (const r of s.records) propRecord(data, props(r))
  const storage = new Bytes()
  propRecord(storage, props([["HEADER", "Icon storage"]]))
  return { bytes: writeCfb({ FileHeader: data.done(), Storage: storage.done() }) }
}

const ioType = (shape: LabelShape | undefined) => (shape === "output" ? 1 : shape === "input" ? 2 : shape === "bidirectional" || shape === "tri_state" ? 3 : 0)

/** An arc through three points as Altium's arc: its centre, radius and angles, counter-clockwise from the start to the end. */
function arcRecord(s: Sheet, [a, m, b]: [Vec2, Vec2, Vec2], width: number, color: number, owner: number, ownerPart?: number) {
  const c = arcCircle(a, m, b)
  const pairs: Pairs = [["RECORD", 12]]
  if (owner >= 0) pairs.push(["OWNERINDEX", owner], ["ISNOTACCESIBLE", true])
  pairs.push(["OWNERPARTID", ownerPart ?? -1])
  if (!c) {
    s.add([["RECORD", 13], ...(owner >= 0 ? ([["OWNERINDEX", owner], ["ISNOTACCESIBLE", true]] as Pairs) : []), ["OWNERPARTID", ownerPart ?? -1], ...loc(a), ...loc(b, "CORNER"), ["LINEWIDTH", width], ["COLOR", color]], owner >= 0 ? owner : undefined)
    return
  }
  const deg = (r: number) => round(((((r * 180) / Math.PI) % 360) + 360) % 360, 3)
  let sa = deg(c.a0)
  let ea = deg(c.a0 + c.sweep)
  if (c.sweep < 0) [sa, ea] = [ea, sa]
  if (Math.abs(Math.abs(c.sweep) - 2 * Math.PI) < 1e-9) [sa, ea] = [0, 360]
  pairs.push(...loc(c.c), ...coord("RADIUS", c.r), ["LINEWIDTH", width], ["STARTANGLE", sa.toFixed(3)], ["ENDANGLE", ea.toFixed(3)], ["COLOR", color])
  s.add(pairs, owner >= 0 ? owner : undefined)
}

/** A power symbol of the editor (a supply or ground) as a power port: the net it names at its pin, its mark pointing away from the wire. */
function powerPort(s: Sheet, c: ComponentInstance, part: PartDef, net: string, ctx: SchContext) {
  const pin = schematicPins(c, part)[0]
  if (!pin) return
  const ground = part.pins[0]?.kind === "ground" || /gnd|ground|vss/i.test(net)
  s.add([
    ["RECORD", 17],
    ["OWNERPARTID", -1],
    ["STYLE", ground ? 4 : 1],
    ["SHOWNETNAME", true],
    ...loc(s.at(pin.pos)),
    ["ORIENTATION", ORIENT[OPPOSITE[pin.dir]]],
    ["COLOR", DARK_RED],
    ["FONTID", 1],
    ["TEXT", net],
    ["UNIQUEID", uniqueId(`power:${c.id}`, ctx.ids)],
  ])
}

/** A part: the component record, its pins and drawing, its designator, comment and parameters, and its footprint. Returns how many pins had no pin line. */
function writePart(s: Sheet, ctx: SchContext, c: ComponentInstance, part: PartDef): number {
  const symbol = symbolOf(part, c)
  const units = unitCount(part)
  const unit = Math.max(1, c.unit ?? 1)
  const pins = schematicPins(c, part)
  const here = (q: Vec2) => {
    const o = orientPoint(q, c.sch.rot, c.sch.mirror)
    return s.at({ x: c.sch.x + o.x, y: c.sch.y + o.y })
  }
  // Mirror x (a flip top to bottom) is a turn of half a turn and a flip left to right, which is the one mirror Altium has.
  const orientation = ((c.sch.rot / 90 + (c.sch.mirror === "x" ? 2 : 0)) % 4) as 0 | 1 | 2 | 3
  const index = s.add([
    ["RECORD", 1],
    ["LIBREFERENCE", part.name],
    ["COMPONENTDESCRIPTION", part.description || undefined],
    ["PARTCOUNT", units + 1],
    ["DISPLAYMODECOUNT", 1],
    ["OWNERPARTID", -1],
    ...loc(s.at(c.sch)),
    ["ORIENTATION", orientation],
    ["ISMIRRORED", c.sch.mirror ? true : undefined],
    ["CURRENTPARTID", unit],
    ["LIBRARYPATH", "*"],
    ["SOURCELIBRARYNAME", "Cherry Blossom"],
    ["SHEETPARTFILENAME", "*"],
    ["TARGETFILENAME", "*"],
    ["UNIQUEID", ctx.componentIds.get(copyKey(c))],
    ["AREACOLOR", PALE],
    ["COLOR", DARK_RED],
    ["PARTIDLOCKED", false],
    ["DESIGNITEMID", part.name],
    ["ALLPINCOUNT", part.pins.length],
  ])
  const kicad = !!symbol.pinLabels
  const labelOf = new Map((symbol.pinLabels ?? []).map((l) => [l.number, l]))
  const kinds = new Map(part.pins.map((p) => [p.number, p]))
  const dropped = new Set<number>()
  let unplaced = 0
  pins.forEach((pin: WorldPin, i) => {
    const port = symbol.ports[i]
    const line = port ? pinLine(symbol, port) : null
    const label = labelOf.get(pin.pin)
    // A KiCad symbol's pin draws its own line from its label; the editor's own draws it as a path of the symbol.
    const length = line?.length ?? (kicad && label ? label.length : 0)
    if (line) dropped.add(line.index)
    if (!line && !(kicad && label) && !pin.hidden) unplaced++
    const d = dirVector(pin.dir)
    const hot = s.at(pin.pos)
    const base = { x: hot.x - d.x * length * K, y: hot.y - d.y * length * K }
    const def = kinds.get(pin.pin)
    const type = pin.type ?? def?.type ?? pinTypeOfKind(def?.kind)
    const showName = kicad ? !!label?.showName : false
    const showNumber = kicad ? !!label?.showNumber : false
    const name = def?.unnamed ? "" : pin.name
    s.add(
      [
        ["RECORD", 2],
        ["OWNERINDEX", index],
        ["OWNERPARTID", unit],
        ["FORMALTYPE", 1],
        ["ELECTRICAL", electrical(type)],
        ["PINCONGLOMERATE", ORIENT[pin.dir] | (pin.hidden ? 0x04 : 0) | (showName ? 0x08 : 0) | (showNumber ? 0x10 : 0) | 0x20],
        ...coord("PINLENGTH", length * K),
        ...loc(base),
        ["NAME", overbar(name) || undefined],
        ["DESIGNATOR", pin.pin],
        ["UNIQUEID", uniqueId(`pin:${c.id}:${pin.pin}:${pin.slot ?? 0}`, ctx.ids)],
        ...(pin.hidden && type === "power_in" && name ? ([["HIDDENNETNAME", name]] as Pairs) : []),
      ],
      index,
    )
  })

  // The drawing, every shape where it is on the sheet; the texts of the editor's own symbols (their pins' names and numbers) as labels of the part.
  let refAt: { at: Vec2; place: ReturnType<typeof placement>; size: number } | null = null
  let valueAt: { at: Vec2; place: ReturnType<typeof placement>; size: number } | null = null
  symbol.primitives.forEach((p, i) => {
    if (dropped.has(i)) return
    if (p.type === "text") {
      const on = symbolTextOnSheet(p, c.sch)
      const at = s.at({ x: c.sch.x + on.at.x, y: c.sch.y + on.at.y })
      const place = placement(on.extent, on.vertical)
      if (p.role === "ref") {
        refAt ??= { at, place, size: p.size ?? FIELD_SIZE }
        return
      }
      if (p.role === "value") {
        valueAt ??= { at, place, size: p.size ?? FIELD_SIZE }
        return
      }
      if (!p.text) return
      s.add([["RECORD", 4], ["OWNERINDEX", index], ["ISNOTACCESIBLE", true], ["OWNERPARTID", unit], ...loc(at), ["COLOR", colorOf(p.color) ?? NAVY], ["FONTID", s.font(p.size ?? FIELD_SIZE, !!p.bold, !!p.italic)], ["TEXT", overbar(p.text)], ...Object.entries(place)], index)
      return
    }
    shape(s, p, here, index, unit)
  })

  // The designator, the comment (the value) and the other fields: where a KiCad symbol places them, else where the editor's symbol draws them.
  const fields = kicad ? componentFields(c, part) : []
  const fieldAt = (name: string) => {
    const f = fields.find((x) => x.name === name)
    if (!f) return null
    return { at: s.at({ x: c.sch.x + f.place.x, y: c.sch.y + f.place.y }), place: placement(f.extent, f.vertical), size: f.place.size ?? FIELD_SIZE }
  }
  const ref = fieldAt("Reference") ?? refAt
  const val = fieldAt("Value") ?? valueAt
  const fallback = s.at({ x: c.sch.x, y: c.sch.y })
  const value = valueText(c, part)
  s.add([["RECORD", 34], ["OWNERINDEX", index], ["OWNERPARTID", -1], ...loc(ref?.at ?? fallback), ["COLOR", DARK_RED], ["FONTID", s.font(ref?.size ?? FIELD_SIZE)], ["TEXT", c.ref], ["NAME", "Designator"], ["READONLYSTATE", 1], ...Object.entries(ref?.place ?? {}), ["ISHIDDEN", ref ? undefined : true], ["UNIQUEID", uniqueId(`des:${c.id}`, ctx.ids)]], index)
  s.add([["RECORD", 41], ["OWNERINDEX", index], ["OWNERPARTID", -1], ...loc(val?.at ?? fallback), ["COLOR", DARK_RED], ["FONTID", s.font(val?.size ?? FIELD_SIZE)], ["TEXT", value || part.name], ["NAME", "Comment"], ...Object.entries(val?.place ?? {}), ["ISHIDDEN", val && value ? undefined : true], ["UNIQUEID", uniqueId(`comment:${c.id}`, ctx.ids)]], index)
  const params = new Map<string, string>()
  if (value) params.set("Value", value)
  if (part.mpn) params.set("Manufacturer Part Number", part.mpn)
  for (const [k, v] of Object.entries(c.props)) if (v && k !== part.valueProp && k !== "net") params.set(paramName(k), v)
  for (const [name, v] of params) {
    const shown = fields.find((f) => f.name !== "Reference" && f.name !== "Value" && paramName(f.name) === name)
    const at = shown ? { at: s.at({ x: c.sch.x + shown.place.x, y: c.sch.y + shown.place.y }), place: placement(shown.extent, shown.vertical) } : null
    s.add([["RECORD", 41], ["OWNERINDEX", index], ["OWNERPARTID", -1], ...loc(at?.at ?? fallback), ["COLOR", DARK_RED], ["FONTID", 1], ["ISHIDDEN", at ? undefined : true], ["TEXT", v], ["NAME", name], ...Object.entries(at?.place ?? {}), ["UNIQUEID", uniqueId(`param:${c.id}:${name}`, ctx.ids)]], index)
  }
  // The footprint, by the name the board's part has (its PATTERN), so Altium matches the two.
  if (c.footprint) {
    const list = s.add([["RECORD", 44], ["OWNERINDEX", index]], index)
    const model = s.add(
      [
        ["RECORD", 45],
        ["OWNERINDEX", list],
        ["INDEXINSHEET", -1],
        ["DESCRIPTION", c.footprint],
        ["MODELNAME", c.footprint],
        ["MODELTYPE", "PCBLIB"],
        ["DATAFILECOUNT", 1],
        ["MODELDATAFILEENTITY0", c.footprint],
        ["MODELDATAFILEKIND0", "PCBLib"],
        ["ISCURRENT", true],
        ["UNIQUEID", uniqueId(`model:${c.id}`, ctx.ids)],
      ],
      list,
    )
    s.add([["RECORD", 46], ["OWNERINDEX", model]], model)
    s.add([["RECORD", 48], ["OWNERINDEX", model]], model)
  }
  return unplaced
}

/** The names Altium's own libraries give the fields the editor knows. */
function paramName(key: string): string {
  const known: Record<string, string> = { mpn: "Manufacturer Part Number", MPN: "Manufacturer Part Number", manufacturer: "Manufacturer", Manufacturer: "Manufacturer", lcsc: "LCSC", LCSC: "LCSC", datasheet: "Datasheet", Datasheet: "Datasheet", description: "Description" }
  return known[key] ?? key
}

/** One shape of a part's drawing, owned by the part and drawn on its unit. */
function shape(s: Sheet, p: Exclude<SymbolPrimitive, { type: "text" }>, here: (q: Vec2) => Vec2, owner: number, unit: number) {
  const look = p.look
  const color = colorOf(look?.color) ?? BLUE
  const width = lineWidth(look?.width ?? (p.type === "path" ? p.width : undefined))
  const filled = p.fill || !!look?.fillKind
  const area = look?.fillKind === "color" ? (colorOf(look.fillColor) ?? PALE) : look?.fillKind === "background" ? PALE : p.fill ? (colorOf(look?.color) ?? BLUE) : PALE
  const own: Pairs = [["OWNERINDEX", owner], ["ISNOTACCESIBLE", true], ["OWNERPARTID", unit]]
  switch (p.type) {
    case "path": {
      const pts = p.points.map(here)
      if (pts.length < 2) return
      if (filled && pts.length >= 3) s.add([["RECORD", 7], ...own, ["LINEWIDTH", width], ["COLOR", color], ["AREACOLOR", area], ["ISSOLID", true], ...pointList(pts)], owner)
      else if (pts.length === 2) s.add([["RECORD", 13], ...own, ...loc(pts[0]), ...loc(pts[1], "CORNER"), ["LINEWIDTH", width], ["COLOR", color]], owner)
      else s.add([["RECORD", 6], ...own, ["LINEWIDTH", width], ["COLOR", color], ...pointList(pts)], owner)
      return
    }
    case "circle": {
      const c = here(p)
      s.add([["RECORD", 8], ...own, ...loc(c), ...coord("RADIUS", p.radius * K), ...coord("SECONDARYRADIUS", p.radius * K), ["LINEWIDTH", width], ["COLOR", color], ["AREACOLOR", area], ["ISSOLID", filled]], owner)
      return
    }
    case "arc":
      arcRecord(s, [here(p.start), here(p.mid), here(p.end)], width, color, owner, unit)
      return
    case "bezier":
      s.add([["RECORD", 5], ...own, ["LINEWIDTH", width], ["COLOR", color], ...pointList(p.points.map(here))], owner)
      return
    case "ellipse": {
      const pts = samplePrimitive(p).map(here)
      const closed = p.from === undefined || p.to === undefined
      if (closed && filled) s.add([["RECORD", 7], ...own, ["LINEWIDTH", width], ["COLOR", color], ["AREACOLOR", area], ["ISSOLID", true], ...pointList(pts)], owner)
      else s.add([["RECORD", 6], ...own, ["LINEWIDTH", width], ["COLOR", color], ...pointList(closed && pts.length ? [...pts, pts[0]] : pts)], owner)
      return
    }
  }
}
