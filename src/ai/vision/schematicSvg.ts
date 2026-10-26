import { transformPoint, type Box } from "../../lib/geometry"
import { paintDrawing, type PaintNode } from "../../editor/schematic/drawingPaint"
import { SCH_LIGHT } from "../../editor/theme"
import { BLOCK_TITLE, blockFrames, type BlockFrame } from "../../model/blocks"
import { labelBox } from "../../model/labels"
import { findPart } from "../../model/library"
import { powerNetName, schematicBounds, valueText } from "../../model/instances"
import { anchorToExtent, rotateExtent, SCH_TEXT } from "../../model/symbols"
import type { ComponentInstance, NetLabel, PartDef, Project } from "../../model/types"
import { getConnectivity } from "../../store/analysis"
import type { PixelSize } from "./limits"
import type { Clash, SchematicMeasure } from "./measure"
import { attrs, esc, MONO, n, pts, SANS, svgDocument, text } from "./svg"

// The schematic as the editor draws it, on the light sheet whatever the user's theme (cream paper,
// blue wires, red symbols: the one palette every model has seen), as an SVG string. The symbol and
// label drawing follows `SymbolView.tsx` and the schematic editor, and the problems the numbers
// name are outlined in red.

const sch = SCH_LIGHT

type Primitive = PartDef["symbol"]["primitives"][number]

function symbol(c: ComponentInstance, part: PartDef): string {
  const power = powerNetName(c, part)
  const color = power ? sch.power : sch.outline
  const isBox = part.category === "ICs" || part.refPrefix === "U" || part.category === "Connectors"
  const refText = power ?? c.ref
  const val = power ? "" : valueText(c, part)
  const rot = c.sch.rot
  const vertical = rot === 90 || rot === 270
  let shapes = ""
  part.symbol.primitives.forEach((p: Primitive, i) => {
    if (p.type === "path") {
      const d = p.points.map((pt, j) => `${j ? "L" : "M"}${n(pt.x)},${n(pt.y)}`).join("")
      const closed = p.points.length > 2 && p.points[0].x === p.points[p.points.length - 1].x && p.points[0].y === p.points[p.points.length - 1].y
      const fill = p.fill ? color : isBox && closed && i === 0 ? sch.body : "none"
      shapes += `<path d="${d}" fill="${fill}" stroke="${color}" stroke-width="${sch.stroke}" stroke-linecap="round" stroke-linejoin="round"/>`
    } else if (p.type === "circle") {
      shapes += `<circle cx="${n(p.x)}" cy="${n(p.y)}" r="${n(p.radius)}" fill="${p.fill ? color : "none"}" stroke="${color}" stroke-width="${sch.stroke}"/>`
    }
  })
  let out = `<g transform="translate(${n(c.sch.x)},${n(c.sch.y)}) rotate(${rot})">${shapes}</g>`
  for (const p of part.symbol.primitives) {
    if (p.type !== "text") continue
    let value = p.text
    if (p.role === "ref") value = refText
    else if (p.role === "value") value = val
    if (!value) continue
    const at = transformPoint(p, { x: c.sch.x, y: c.sch.y }, rot)
    const pinText = p.role === "pin" || p.role === "pinNumber"
    const fill = p.role === "value" || p.role === "pin" ? sch.ink2 : p.role === "pinNumber" ? sch.pinNumber : power ? sch.power : sch.ink
    out += text(at.x, at.y, value, {
      fill,
      size: p.size ?? SCH_TEXT,
      extent: rotateExtent(anchorToExtent(p.anchor), rot),
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

const kebab = (name: string) => name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)

/** One of a drawing's elements as SVG text: the editor's attributes in SVG's spelling. */
function node(p: PaintNode): string {
  const a = attrs(Object.fromEntries(Object.entries(p.attrs).map(([k, v]) => [kebab(k), v])))
  if (p.tag !== "text") return `<${p.tag}${a}/>`
  return `<text${a} font-family="${p.mono ? MONO : SANS}">${esc(p.text ?? "")}</text>`
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
  for (const d of project.drawings ?? []) body += paintDrawing(d, sch, px).map(node).join("")
  for (const w of project.wires) {
    body += `<polyline points="${pts(w.points)}" fill="none" stroke="${sch.wire}" stroke-width="${n(Math.max(sch.wireWidth, 1.4 * px))}" stroke-linecap="round" stroke-linejoin="round"/>`
  }
  for (const j of conn.junctions) body += `<circle cx="${n(j.x)}" cy="${n(j.y)}" r="0.04" fill="${sch.junction}"/>`
  for (const l of project.labels) body += label(l, px)
  for (const c of project.components) {
    const part = findPart(c.partId)
    if (part) body += symbol(c, part)
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
  for (const c of [...m.symbolOverlaps, ...m.labelsOnSymbols, ...m.labelOverlaps, ...m.wiresThroughSymbols, ...m.textsOnSymbols]) body += outline(c, px)
  return svgDocument(box, size, sch.paper, body)
}
