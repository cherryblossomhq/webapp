import { orientPoint, type Box } from "../../lib/geometry"
import { paintDrawing, type PaintNode } from "../../editor/schematic/drawingPaint"
import { SCH_LIGHT } from "../../editor/theme"
import { BLOCK_TITLE, blockFrames, type BlockFrame } from "../../model/blocks"
import { labelBox } from "../../model/labels"
import { isKicadLabel, labelGeometry } from "../../model/labelShapes"
import { flagMarkBox } from "../../model/instances"
import { findPart } from "../../model/library"
import { powerNetName, schematicBounds, schematicPins, valueText } from "../../model/instances"
import { arcOf, primitivePathData } from "../../model/primitiveGeometry"
import { componentFields, FIELD_SIZE, pinDisplayName, pinTexts, symbolOf } from "../../model/symbolDrawing"
import { anchorToExtent, rotateExtent, SCH_TEXT } from "../../model/symbols"
import type { ComponentInstance, NetLabel, PartDef, Project, SchematicDrawing, ShapeLook, SymbolPrimitive, TextAnchor } from "../../model/types"
import { getConnectivity } from "../../store/analysis"
import type { PixelSize } from "./limits"
import type { Clash, SchematicMeasure } from "./measure"
import { anchorFromAxes, attrs, esc, justifyAnchor, MONO, n, orientText, pts, SANS, svgDocument, text } from "./svg"
import { resolvedComponents } from "../../model/ruleAreas"

// The schematic as the editor draws it, on the light sheet whatever the user's theme (cream paper,
// blue wires, red symbols: the one palette every model has seen), as an SVG string. The symbol and
// label drawing follows `SymbolView.tsx` and the schematic editor, and the problems the numbers
// name are outlined in red.

const sch = SCH_LIGHT

/** A junction dot or a no-connect flag: drawn over the wires, where the other drawings go under them. */
const isDot = (d: SchematicDrawing) => d.type === "junction" || d.type === "noconnect" || d.type === "directive"

/** KiCad's dash lengths in line widths: a dash is 12, a dot 2, the gap between them 4. */
function dashArray(dash: ShapeLook["dash"], width: number): string | undefined {
  if (!dash) return undefined
  const w = width > 0 ? width : 0.012
  const d = n(w * 12)
  const o = n(w * 2)
  const g = n(w * 4)
  return dash === "dash" ? `${d} ${g}` : dash === "dot" ? `${o} ${g}` : dash === "dash_dot" ? `${d} ${g} ${o} ${g}` : `${d} ${g} ${o} ${g} ${o} ${g}`
}

/** One drawn shape of a symbol (not text) with the width, dash, colour and fill its file gave it. */
function shape(p: Exclude<SymbolPrimitive, { type: "text" }>, color: string): string {
  const look = p.look
  const width = look?.width ?? sch.stroke
  const stroke = look?.color ?? color
  const fill = p.fill ? stroke : look?.fillKind === "background" ? sch.body : look?.fillKind === "color" ? (look.fillColor ?? stroke) : "none"
  const dash = dashArray(look?.dash, width)
  const style = ` fill="${fill}" stroke="${stroke}" stroke-width="${n(width)}"${dash ? ` stroke-dasharray="${dash}"` : ""} stroke-linecap="round" stroke-linejoin="round"`
  if (p.type === "circle") return `<circle cx="${n(p.x)}" cy="${n(p.y)}" r="${n(p.radius)}"${style}/>`
  let d = primitivePathData(p) ?? ""
  // A filled arc is a pie: from the centre to the start, along the arc, and back.
  if (p.type === "arc" && fill !== "none") {
    const a = arcOf(p.start, p.mid, p.end)
    if (a) d = `M${n(a.center.x)},${n(a.center.y)}L${d.slice(1)}Z`
  }
  return `<path d="${d}"${style}/>`
}

type Primitive = PartDef["symbol"]["primitives"][number]

/** A symbol KiCad drew, on the sheet as the editor draws it: the shapes, the fields and the pins' names and numbers. */
function kicadSymbol(c: ComponentInstance, part: PartDef, color: string, transform: string): string {
  const symbol = symbolOf(part, c)
  let shapes = ""
  for (const p of symbol.primitives) if (p.type !== "text") shapes += shape(p, color)
  let out = `<g transform="${transform}">${shapes}</g>`
  const power = !!powerNetName(c, part)
  for (const p of symbol.primitives) {
    if (p.type !== "text" || !p.text) continue
    // The text turns with the symbol and stays readable.
    const o = orientText(p.angle ?? 0, p.anchor, c.sch)
    const at = orientPoint(p, c.sch.rot, c.sch.mirror)
    out += text(c.sch.x + at.x, c.sch.y + at.y, p.text, {
      fill: p.color ?? (power ? sch.power : sch.ink),
      size: p.size ?? SCH_TEXT,
      extent: rotateExtent(anchorToExtent(o.anchor), o.angle),
      vertical: o.angle === 90,
      weight: p.bold ? 700 : 500,
      italic: p.italic,
    })
  }
  // Fields have places of their own; their angle and justification are the symbol's, and put through its turn and mirror as KiCad does.
  for (const f of componentFields(c, part)) {
    const o = orientText(f.place.angle, justifyAnchor(f.place.h, f.place.v), c.sch)
    out += text(c.sch.x + f.place.x, c.sch.y + f.place.y, f.text, {
      fill: f.place.color ?? (power ? sch.power : f.name === "Reference" ? sch.ink : sch.ink2),
      size: f.place.size ?? FIELD_SIZE,
      extent: rotateExtent(anchorToExtent(o.anchor), o.angle),
      vertical: o.angle === 90,
      weight: f.place.bold || f.name === "Reference" ? 700 : 500,
      italic: f.place.italic,
      mono: f.name === "Reference",
    })
  }
  const pins = schematicPins(c, part)
  for (const label of symbol.pinLabels ?? []) {
    // A pin switched to another function shows that function's name.
    const alt = c.pinAlt?.[label.number] ? pins.find((w) => w.pin === label.number)?.name : undefined
    for (const t of pinTexts(label, c.sch, symbol.pinNameOffset ?? 0.04, alt)) {
      const shown = t.number ? t.text : pinDisplayName(t.text, "")
      if (!shown) continue
      const anchor: TextAnchor = anchorFromAxes(t.h === "left" ? -1 : t.h === "right" ? 1 : 0, 0)
      out += text(c.sch.x + t.x, c.sch.y + t.y, shown, {
        fill: t.number ? sch.pinNumber : sch.ink2,
        size: t.size,
        extent: rotateExtent(anchorToExtent(anchor), t.angle),
        vertical: t.angle === 90,
        mono: true,
      })
    }
  }
  return out
}

function symbol(c: ComponentInstance, part: PartDef): string {
  const power = powerNetName(c, part)
  const color = power ? sch.power : sch.outline
  // The symbol is turned, then mirrored: `x` flips top to bottom, `y` left to right.
  const mirror = c.sch.mirror === "x" ? " scale(1,-1)" : c.sch.mirror === "y" ? " scale(-1,1)" : ""
  const transform = `translate(${n(c.sch.x)},${n(c.sch.y)})${mirror} rotate(${c.sch.rot})`
  if (part.jumpers) return kicadSymbol(c, part, color, transform)
  const isBox = part.category === "ICs" || part.refPrefix === "U" || part.category === "Connectors"
  const refText = power ?? c.ref
  const val = power ? "" : valueText(c, part)
  const rot = c.sch.rot
  const vertical = rot === 90 || rot === 270
  const primitives = symbolOf(part, c).primitives
  let shapes = ""
  primitives.forEach((p: Primitive, i) => {
    if (p.type === "path") {
      const d = p.points.map((pt, j) => `${j ? "L" : "M"}${n(pt.x)},${n(pt.y)}`).join("")
      const closed = p.points.length > 2 && p.points[0].x === p.points[p.points.length - 1].x && p.points[0].y === p.points[p.points.length - 1].y
      const fill = p.fill ? color : isBox && closed && i === 0 ? sch.body : "none"
      shapes += `<path d="${d}" fill="${fill}" stroke="${color}" stroke-width="${sch.stroke}" stroke-linecap="round" stroke-linejoin="round"/>`
    } else if (p.type === "circle") {
      shapes += `<circle cx="${n(p.x)}" cy="${n(p.y)}" r="${n(p.radius)}" fill="${p.fill ? color : "none"}" stroke="${color}" stroke-width="${sch.stroke}"/>`
    } else if (p.type !== "text") shapes += shape(p, color)
  })
  let out = `<g transform="${transform}">${shapes}</g>`
  for (const p of primitives) {
    if (p.type !== "text") continue
    let value = p.text
    if (p.role === "ref") value = refText
    else if (p.role === "value") value = val
    if (!value) continue
    const o = orientPoint(p, rot, c.sch.mirror)
    const at = { x: c.sch.x + o.x, y: c.sch.y + o.y }
    const pinText = p.role === "pin" || p.role === "pinNumber"
    const fill = p.role === "value" || p.role === "pin" ? sch.ink2 : p.role === "pinNumber" ? sch.pinNumber : power ? sch.power : sch.ink
    const extent = rotateExtent(anchorToExtent(p.anchor), rot)
    out += text(at.x, at.y, value, {
      fill,
      size: p.size ?? SCH_TEXT,
      extent: c.sch.mirror === "x" ? { x: extent.x, y: -extent.y } : c.sch.mirror === "y" ? { x: -extent.x, y: extent.y } : extent,
      vertical: pinText && (p.alongPin ? !vertical : vertical),
      weight: p.role === "ref" ? 600 : 500,
      mono: p.role === "ref" || pinText,
    })
  }
  return out
}

/** A flag whose point touches the wire end it names. */
function label(l: NetLabel, px: number): string {
  const b = labelBox(l)
  const tip = 0.06
  const { x, y } = l
  let d: string
  let at: { x: number; y: number }
  if (l.rot === 0) {
    d = `M${n(x)},${n(y)} L${n(b.minX + tip)},${n(b.maxY)} L${n(b.maxX)},${n(b.maxY)} L${n(b.maxX)},${n(b.minY)} L${n(b.minX + tip)},${n(b.minY)} Z`
    at = { x: (b.minX + tip + b.maxX) / 2, y }
  } else if (l.rot === 180) {
    d = `M${n(x)},${n(y)} L${n(b.maxX - tip)},${n(b.maxY)} L${n(b.minX)},${n(b.maxY)} L${n(b.minX)},${n(b.minY)} L${n(b.maxX - tip)},${n(b.minY)} Z`
    at = { x: (b.minX + b.maxX - tip) / 2, y }
  } else if (l.rot === 90) {
    d = `M${n(x)},${n(y)} L${n(b.maxX)},${n(b.minY + tip)} L${n(b.maxX)},${n(b.maxY)} L${n(b.minX)},${n(b.maxY)} L${n(b.minX)},${n(b.minY + tip)} Z`
    at = { x, y: (b.minY + tip + b.maxY) / 2 }
  } else {
    d = `M${n(x)},${n(y)} L${n(b.maxX)},${n(b.maxY - tip)} L${n(b.maxX)},${n(b.minY)} L${n(b.minX)},${n(b.minY)} L${n(b.minX)},${n(b.maxY - tip)} Z`
    at = { x, y: (b.minY + b.maxY - tip) / 2 }
  }
  return (
    `<path d="${d}" fill="${sch.label}" stroke="${sch.wire}" stroke-width="${n(Math.max(0.012, px))}" stroke-linejoin="round"/>` +
    text(at.x, at.y, l.name, { fill: sch.labelInk, size: SCH_TEXT, vertical: l.rot === 90 || l.rot === 270, weight: 600, mono: true }) +
    `<circle cx="${n(x)}" cy="${n(y)}" r="0.022" fill="${sch.wire}"/>`
  )
}

/** A block's thin frame with its title, as the editor draws it. */
function block(f: BlockFrame, px: number): string {
  const b = f.box
  return (
    `<rect x="${n(b.minX)}" y="${n(b.minY)}" width="${n(b.maxX - b.minX)}" height="${n(b.maxY - b.minY)}" fill="none" stroke="${sch.block}" stroke-width="${n(Math.max(0.012, px))}"/>` +
    text(f.title.x, f.title.y, f.name, { fill: sch.block, size: BLOCK_TITLE, extent: { x: 1, y: -1 }, weight: 600 })
  )
}

/** SVG's own spelling of an attribute React spells in camel case; `preserveAspectRatio` is camel case in SVG too. */
const kebab = (name: string) => (name === "preserveAspectRatio" ? name : name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`))

/** One of a drawing's elements as SVG text: the editor's attributes in SVG's spelling. */
function node(p: PaintNode): string {
  if (p.tag === "ktext") return p.kicad ? text(p.kicad.x, p.kicad.y, p.text ?? "", p.kicad) : ""
  const a = attrs(Object.fromEntries(Object.entries(p.attrs).map(([k, v]) => [kebab(k), v])))
  if (p.tag !== "text") return `<${p.tag}${a}/>`
  return `<text${a} font-family="${p.mono ? MONO : SANS}">${esc(p.text ?? "")}</text>`
}

/** A label from KiCad: its text beside its point, or a flag of its shape. */
function kicadLabel(l: NetLabel, px: number): string {
  if (l.look?.hidden) return ""
  const g = labelGeometry(l)
  const flag = g.outline.length ? `<polygon points="${pts(g.outline)}" fill="${sch.label}" stroke="${sch.wire}" stroke-width="${n(Math.max(0.012, px))}" stroke-linejoin="round"/>` : ""
  return flag + text(g.text.x, g.text.y, l.name, { fill: l.look?.color ?? sch.labelInk, size: g.text.size, extent: g.text.extent, vertical: g.text.vertical, weight: l.look?.bold ? 700 : 500, italic: l.look?.italic })
}

const dash = (d: string | undefined, w: number) => (d ? ` stroke-dasharray="${n(w * (d === "dot" ? 1 : 6))} ${n(w * 3)}"` : "")

/** The cross over a part that is not to be populated. */
function dnpMark(c: Parameters<typeof flagMarkBox>[0]): string {
  const b = c.flags?.dnp ? flagMarkBox(c) : null
  return b ? `<path d="M${n(b.minX)},${n(b.minY)} L${n(b.maxX)},${n(b.maxY)} M${n(b.minX)},${n(b.maxY)} L${n(b.maxX)},${n(b.minY)}" stroke="${sch.danger}" stroke-width="0.036" opacity="0.85"/>` : ""
}

function outline(c: Clash, px: number, grow = 0.06): string {
  const b = c.box
  return `<rect x="${n(b.minX - grow)}" y="${n(b.minY - grow)}" width="${n(b.maxX - b.minX + grow * 2)}" height="${n(b.maxY - b.minY + grow * 2)}" fill="rgba(207,58,61,0.12)" stroke="${sch.danger}" stroke-width="${n(Math.max(0.02, 1.6 * px))}" stroke-dasharray="${n(5 * px)} ${n(3 * px)}"/>`
}

/** The schematic over `box` at `size` pixels, with the measured problems outlined. */
export function schematicSvg(project: Project, box: Box, size: PixelSize, m: SchematicMeasure): string {
  const px = (box.maxX - box.minX) / size.width
  const conn = getConnectivity(project)
  let body = ""
  for (const f of blockFrames(project)) body += block(f, px)
  for (const d of project.drawings ?? []) if (!isDot(d)) body += paintDrawing(d, sch, px).map(node).join("")
  for (const w of project.wires) {
    const width = Math.max(w.look?.width ?? sch.wireWidth, 1.4 * px)
    body += `<polyline points="${pts(w.points)}" fill="none" stroke="${w.look?.color ?? sch.wire}" stroke-width="${n(width)}"${w.look ? dash(w.look.dash, width) : ""} stroke-linecap="round" stroke-linejoin="round"/>`
  }
  const own = (project.drawings ?? []).filter((d) => d.type === "junction")
  for (const j of conn.junctions) if (!own.some((d) => d.type === "junction" && Math.abs(d.x - j.x) < 1e-3 && Math.abs(d.y - j.y) < 1e-3)) body += `<circle cx="${n(j.x)}" cy="${n(j.y)}" r="0.04" fill="${sch.junction}"/>`
  for (const d of project.drawings ?? []) if (isDot(d)) body += paintDrawing(d, sch, px).map(node).join("")
  for (const l of project.labels) body += isKicadLabel(l) ? kicadLabel(l, px) : label(l, px)
  for (const c of resolvedComponents(project)) {
    const part = findPart(c.partId)
    if (part) body += symbol(c, part) + dnpMark(c)
    else {
      const b = schematicBounds(c)
      body += `<rect x="${n(b.minX)}" y="${n(b.minY)}" width="${n(b.maxX - b.minX)}" height="${n(b.maxY - b.minY)}" fill="none" stroke="${sch.danger}" stroke-width="0.02"/>`
      body += text(c.sch.x, c.sch.y, `${c.ref}?`, { fill: sch.danger, size: SCH_TEXT })
    }
  }
  for (const p of conn.unconnectedPins) {
    body += `<circle cx="${n(p.pos.x)}" cy="${n(p.pos.y)}" r="${n(Math.max(0.03, 3 * px))}" fill="${sch.paper}" stroke="${sch.danger}" stroke-width="${n(1.2 * px)}"/>`
  }
  for (const p of conn.ncPins) {
    const d = 0.06
    body +=
      `<g stroke="${sch.noConnect}" stroke-width="${n(Math.max(sch.stroke, 1.4 * px))}" stroke-linecap="round">` +
      `<line x1="${n(p.pos.x - d)}" y1="${n(p.pos.y - d)}" x2="${n(p.pos.x + d)}" y2="${n(p.pos.y + d)}"/>` +
      `<line x1="${n(p.pos.x - d)}" y1="${n(p.pos.y + d)}" x2="${n(p.pos.x + d)}" y2="${n(p.pos.y - d)}"/></g>`
  }
  for (const c of [...m.symbolOverlaps, ...m.labelsOnSymbols, ...m.labelOverlaps, ...m.wiresThroughSymbols, ...m.textsOnSymbols, ...m.frameOverlaps, ...m.textsOnFrames]) body += outline(c, px)
  return svgDocument(box, size, sch.paper, body)
}
