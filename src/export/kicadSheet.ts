import { round } from "../lib/geometry"
import { labelJustify } from "../model/labelShapes"
import type { LabelField, NetLabel, SheetFill, SheetItem, SheetStroke, SymbolFlags, TextLook, Vec2 } from "../model/types"

// S2 and S4 in the KiCad schematic: labels with their kind, shape and style, the texts, text boxes, drawings,
// pictures, tables, junction dots and flags a sheet carries, and the flags of a symbol. The converter
// (`circuit-json-to-kicad`) knows none of these, so they are written here, as KiCad's own S-expressions (file
// version 20250114, which is the converter's). `toPage` puts a point of the sheet (the editor's units, y up) on
// KiCad's page in millimetres (y down).

const MM = 12.7
const mm6 = (n: number) => String(round(n, 6) || 0)
/** A length in editor units as millimetres, to a tenth of a micrometre. */
const L = (units: number) => String(round(units * MM, 4) || 0)

/** A string as KiCad reads it: quoted, with the backslash and the quote escaped. A new line stays one (KiCad writes `\n`). */
const quote = (text: string) => `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r?\n/g, "\\n")}"`

/** KiCad's `(color r g b a)` of `#rrggbb` or `rgba(r,g,b,a)`. */
export function colorNode(color: string): string {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color)
  if (m) return `(color ${parseInt(m[1], 16)} ${parseInt(m[2], 16)} ${parseInt(m[3], 16)} 1)`
  const r = /^rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([\d.]+)\s*\)$/.exec(color)
  return r ? `(color ${r[1]} ${r[2]} ${r[3]} ${r[4]})` : "(color 0 0 0 0)"
}

type ToPage = (p: Vec2) => Vec2

const uuidOf = (n: number) => `00000000-0000-4000-8000-${(n + 0x100000).toString(16).padStart(12, "0")}`

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
  const j = labelJustify(l)
  const out: string[] = [`  (${global ? "global_label" : "label"} ${quote(l.name)}`]
  if (global) out.push(`    (shape ${l.shape ?? "bidirectional"})`)
  out.push(`    (at ${mm6(p.x)} ${mm6(p.y)} ${l.rot})`)
  if (l.fieldsAutoplaced) out.push("    (fields_autoplaced yes)")
  out.push(`    ${effects(l.look, { h: j.h, v: j.v })}`)
  out.push(`    (uuid ${uuid})`)
  for (const f of l.fields ?? []) out.push(fieldNode(f, l, toPage))
  out.push("  )")
  return out.join("\n")
}

/** One field of a label: its place is relative to the label's point. */
function fieldNode(f: LabelField, l: NetLabel, toPage: ToPage): string {
  const at = toPage({ x: l.x + f.place.x, y: l.y + f.place.y })
  const look: TextLook = { ...(f.place.size ? { size: f.place.size } : {}), ...(f.place.bold ? { bold: true as const } : {}), ...(f.place.italic ? { italic: true as const } : {}), ...(f.place.color ? { color: f.place.color } : {}), ...(f.place.thickness ? { thickness: f.place.thickness } : {}), ...(f.place.hidden ? { hidden: true as const } : {}) }
  const flags = [f.place.showName ? "    (show_name yes)" : "", f.place.noAutoplace ? "    (do_not_autoplace yes)" : ""].filter(Boolean)
  return [`    (property ${quote(f.name)} ${quote(f.value)}`, `      (at ${mm6(at.x)} ${mm6(at.y)} ${f.place.angle})`, ...flags.map((x) => `  ${x}`), `      ${effects(look, { h: f.place.h, v: f.place.v })}`, "    )"].join("\n")
}

/** A junction dot or no-connect flag, a text, a drawing, a picture or a table as KiCad writes it, for the sheet. */
export function itemNode(item: SheetItem, toPage: ToPage, n: number): string {
  const xy = (p: Vec2) => {
    const q = toPage(p)
    return `(xy ${mm6(q.x)} ${mm6(q.y)})`
  }
  const at = (p: Vec2) => {
    const q = toPage(p)
    return `${mm6(q.x)} ${mm6(q.y)}`
  }
  const uuid = `(uuid ${uuidOf(n)})`
  switch (item.kind) {
    case "text":
      return `  (text ${quote(item.text)}\n    ${sim(item.excludeFromSim)}\n    (at ${at(item)} ${item.rot})\n    ${effects(item.look)}\n    ${uuid}\n  )`
    case "textbox": {
      const m = item.margins ? `\n    (margins ${item.margins.map((v) => L(v)).join(" ")})` : ""
      return `  (text_box ${quote(item.text)}\n    ${sim(item.excludeFromSim)}\n    (at ${at(item)} ${item.rot})\n    (size ${L(item.w)} ${L(item.h)})${m}\n    ${strokeNode(item.stroke)}\n    ${fillNode(item.fill)}\n    ${effects(item.look)}\n    ${uuid}\n  )`
    }
    case "polyline":
      return `  (polyline\n    (pts ${item.points.map(xy).join(" ")})\n    ${strokeNode(item.stroke)}\n    ${fillNode(item.fill)}\n    ${uuid}\n  )`
    case "rectangle": {
      const r = item.radius ? `\n    (radius ${L(item.radius)})` : ""
      return `  (rectangle\n    (start ${at(item.a)})\n    (end ${at(item.b)})${r}\n    ${strokeNode(item.stroke)}\n    ${fillNode(item.fill)}\n    ${uuid}\n  )`
    }
    case "circle":
      return `  (circle\n    (center ${at(item.c)})\n    (radius ${L(item.r)})\n    ${strokeNode(item.stroke)}\n    ${fillNode(item.fill)}\n    ${uuid}\n  )`
    case "arc":
      return `  (arc\n    (start ${at(item.start)})\n    (mid ${at(item.mid)})\n    (end ${at(item.end)})\n    ${strokeNode(item.stroke)}\n    ${fillNode(item.fill)}\n    ${uuid}\n  )`
    case "bezier":
      return `  (bezier\n    (pts ${item.points.map(xy).join(" ")})\n    ${strokeNode(item.stroke)}\n    ${fillNode(item.fill)}\n    ${uuid}\n  )`
    case "image": {
      const data = item.data.match(/.{1,76}/g) ?? [item.data]
      return `  (image\n    (at ${at(item)})${item.scale !== 1 ? `\n    (scale ${mm6(item.scale)})` : ""}\n    ${uuid}\n    (data ${data.map((d) => `"${d}"`).join("\n      ")})\n  )`
    }
    case "junction": {
      const d = item.diameter ? `\n    (diameter ${L(item.diameter)})` : "\n    (diameter 0)"
      return `  (junction\n    (at ${at(item)})${d}\n    ${item.color ? colorNode(item.color) : "(color 0 0 0 0)"}\n    ${uuid}\n  )`
    }
    case "noconnect":
      return `  (no_connect\n    (at ${at(item)})\n    ${uuid}\n  )`
    case "table": {
      const cells = item.cells
        .map((c, i) => {
          const p = toPage(c)
          const m = c.margins ? `\n          (margins ${c.margins.map((v) => L(v)).join(" ")})` : ""
          return `        (table_cell ${quote(c.text)}\n          ${sim(c.excludeFromSim)}\n          (at ${mm6(p.x)} ${mm6(p.y)} ${c.rot})\n          (size ${L(c.w)} ${L(c.h)})${m}\n          (span ${c.colSpan} ${c.rowSpan})\n          ${fillNode(c.fill)}\n          ${effects(c.look)}\n          (uuid ${uuidOf(n * 1000 + i + 500)})\n        )`
        })
        .join("\n")
      const yes = (b: boolean) => (b ? "yes" : "no")
      return `  (table\n    (column_count ${item.columns})\n    (border\n      (external ${yes(item.border.external)})\n      (header ${yes(item.border.header)})\n      ${strokeNode(item.border.stroke)}\n    )\n    (separators\n      (rows ${yes(item.separators.rows)})\n      (cols ${yes(item.separators.cols)})\n      ${strokeNode(item.separators.stroke)}\n    )\n    (column_widths ${item.columnWidths.map((w) => L(w)).join(" ")})\n    (row_heights ${item.rowHeights.map((h) => L(h)).join(" ")})\n    (cells\n${cells}\n    )\n  )`
    }
  }
}

/** The schematic with the items before its closing bracket. */
export function addSheetItems(sch: string, items: SheetItem[], toPage: ToPage): string {
  if (!items.length) return sch
  const text = items.map((it, i) => itemNode(it, toPage, i + 1)).join("\n") + "\n"
  const end = sch.lastIndexOf("\n)")
  return end < 0 ? sch : `${sch.slice(0, end + 1)}${text}${sch.slice(end + 1)}`
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
  return { text: sch.replace(GLOBAL_LABEL, (block) => `\n${labelNode(labels[i++], toPage, block.match(/\(uuid ([0-9a-f-]+)\)/)?.[1] ?? uuidOf(i))}`), ok: true }
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
export function flagLines(flags: SymbolFlags | undefined): { dnp: string; bom: string; board: string; sim: string; autoplaced: string } {
  const yes = (b: boolean) => (b ? "yes" : "no")
  return { dnp: `(dnp ${yes(!!flags?.dnp)})`, bom: `(in_bom ${yes(flags?.inBom !== false)})`, board: `(on_board ${yes(flags?.onBoard !== false)})`, sim: `(exclude_from_sim ${yes(!!flags?.excludeFromSim)})`, autoplaced: `(fields_autoplaced ${yes(!!flags?.fieldsAutoplaced)})` }
}

/** The placed symbols of the schematic with their flags, found by reference. */
export function applySymbolFlags(sch: string, flagsByRef: Map<string, SymbolFlags>): string {
  if (!flagsByRef.size) return sch
  return sch.replace(/\n {2}\(symbol\n {4}\(lib_id [^\n]*\n[\s\S]*?\n {2}\)(?=\n)/g, (block) => {
    const ref = block.match(/\(property "Reference" "([^"]*)"/)?.[1]
    const flags = ref === undefined ? undefined : flagsByRef.get(ref)
    if (!flags) return block
    const l = flagLines(flags)
    return block
      .replace(/\(exclude_from_sim (?:yes|no)\)/, l.sim)
      .replace(/\(in_bom (?:yes|no)\)/, l.bom)
      .replace(/\(on_board (?:yes|no)\)/, l.board)
      .replace(/\(dnp (?:yes|no)\)/, l.dnp)
      .replace(/\(fields_autoplaced (?:yes|no)\)/, l.autoplaced)
  })
}

/** The footprints of the board with the attributes the flags give them: do not populate, out of the BOM, out of the position file. */
export function applyFootprintFlags(pcb: string, flagsByRef: Map<string, SymbolFlags>): string {
  if (!flagsByRef.size) return pcb
  return pcb.replace(/\n {2}\(footprint\b[\s\S]*?\n {2}\)(?=\n)/g, (block) => {
    const ref = block.match(/\(property "Reference" "([^"]*)"/)?.[1]
    const flags = ref === undefined ? undefined : flagsByRef.get(ref)
    if (!flags) return block
    const words = [flags.dnp ? "dnp" : "", flags.inBom === false ? "exclude_from_bom" : "", flags.inPosFiles === false ? "exclude_from_pos_files" : ""].filter(Boolean)
    if (!words.length) return block
    return block.replace(/\(attr ([^)]*)\)/, (_, a: string) => `(attr ${[...a.split(/\s+/).filter(Boolean), ...words.filter((w) => !a.includes(w))].join(" ")})`)
  })
}
