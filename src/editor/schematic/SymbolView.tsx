import { memo } from "react"
import { orientPoint, transformPoint } from "../../lib/geometry"
import { findPart } from "../../model/library"
import { powerNetName, valueText } from "../../model/instances"
import { arcOf, primitivePathData } from "../../model/primitiveGeometry"
import { anchorToExtent, rotateExtent, SCH_TEXT, type TextExtent } from "../../model/symbols"
import { componentFields, hasFieldPlaces, pinTexts, symbolOf, type FieldText } from "../../model/symbolDrawing"
import type { ComponentInstance, Mirror, PartDef, Rotation, ShapeLook, SymbolDef, SymbolPrimitive } from "../../model/types"
import { useSch, type SchPalette } from "../theme"
import { WorldText } from "../viewport"

interface SymbolBodyProps {
  symbol: SymbolDef
  x: number
  y: number
  rot: Rotation
  mirror?: Mirror
  color?: string
  fill?: string
  refText?: string
  valueText?: string
  opacity?: number
  isBox?: boolean
  /** Fields an imported part writes, in place of the reference and value texts of its symbol. */
  fields?: FieldText[]
  /** The names pins have on this symbol where they are not the drawing's (a chosen alternate), by pin number. */
  pinNames?: Record<string, string>
}

/** Dashes in KiCad's styles, scaled to the line width. */
export function dashArray(dash: ShapeLook["dash"], w: number): string | undefined {
  switch (dash) {
    case "dash":
      return `${w * 6} ${w * 3}`
    case "dot":
      return `${w} ${w * 3}`
    case "dash_dot":
      return `${w * 6} ${w * 3} ${w} ${w * 3}`
    case "dash_dot_dot":
      return `${w * 6} ${w * 3} ${w} ${w * 3} ${w} ${w * 3}`
    default:
      return undefined
  }
}

type ShapePrimitive = Exclude<SymbolPrimitive, { type: "text" }>
const isShape = (p: SymbolPrimitive): p is ShapePrimitive => p.type !== "text"

/** One shape of a symbol's drawing, in the symbol's own frame. */
function Shape({ p, color, fill, isBox, first, sch }: { p: ShapePrimitive; color: string; fill: string; isBox?: boolean; first: boolean; sch: SchPalette }) {
  const look = p.look
  const width = look?.width ?? (p.type === "path" ? p.width : undefined) ?? sch.stroke
  const stroke = look?.color ?? color
  let fillColor = "none"
  if (p.fill) fillColor = stroke
  else if (look?.fillKind === "background") fillColor = fill
  else if (look?.fillKind === "color") fillColor = look.fillColor ?? fill
  const common = { stroke, strokeWidth: width, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, strokeDasharray: dashArray(look?.dash, width) }
  if (p.type === "circle") return <circle cx={p.x} cy={p.y} r={p.radius} fill={fillColor} {...common} />
  if (p.type === "path") {
    const closed = p.points.length > 2 && p.points[0].x === p.points[p.points.length - 1].x && p.points[0].y === p.points[p.points.length - 1].y
    const f = fillColor !== "none" ? fillColor : isBox && closed && first ? fill : "none"
    return <path d={primitivePathData(p) ?? ""} fill={f} {...common} />
  }
  if (p.type === "arc" && fillColor !== "none") {
    // KiCad fills an arc as the pie between it and its centre.
    const a = arcOf(p.start, p.mid, p.end)
    const d = primitivePathData(p) ?? ""
    const pie = a ? `M${a.center.x},${a.center.y}L${p.start.x},${p.start.y}${d.slice(d.indexOf("A"))}Z` : d
    return (
      <g>
        <path d={pie} fill={fillColor} stroke="none" />
        <path d={d} fill="none" {...common} />
      </g>
    )
  }
  return <path d={primitivePathData(p) ?? ""} fill={fillColor} {...common} />
}

/** A text's extent on the sheet once the symbol is turned and mirrored, and whether it then reads up the page. */
function textLayout(p: Extract<SymbolPrimitive, { type: "text" }>, rot: Rotation, mirror: Mirror | undefined) {
  const angle = p.angle ?? 0
  const up = Math.abs(angle % 180) === 90
  const e = anchorToExtent(p.anchor)
  // The text's own justification in the symbol's frame: along its reading direction and across it.
  const base = up ? { x: -e.y, y: e.x } : { x: e.x, y: e.y }
  const dir = orientPoint({ x: Math.cos((angle * Math.PI) / 180), y: Math.sin((angle * Math.PI) / 180) }, rot, mirror)
  const w = orientPoint(base, rot, mirror)
  const sgn = (v: number) => (Math.abs(v) < 1e-9 ? 0 : v > 0 ? 1 : -1)
  return { extent: { x: sgn(w.x), y: sgn(w.y) } as TextExtent, vertical: Math.abs(dir.y) > Math.abs(dir.x) + 1e-9 }
}

/** Renders a symbol's artwork in world space; text stays upright regardless of rotation. */
export const SymbolBody = memo(function SymbolBody({ symbol, x, y, rot, mirror, color: given, fill: givenFill, refText, valueText: val, opacity, isBox, fields, pinNames }: SymbolBodyProps) {
  const sch = useSch()
  const color = given ?? sch.outline
  const fill = givenFill ?? sch.body
  const vertical = rot === 90 || rot === 270
  const sx = mirror === "y" ? -1 : 1
  const sy = mirror === "x" ? -1 : 1
  const imported = !!symbol.pinLabels
  return (
    <g opacity={opacity}>
      <g transform={`translate(${x},${y}) scale(${sx},${sy}) rotate(${rot})`}>
        {symbol.primitives.map((p, i) => (isShape(p) ? <Shape key={i} p={p} color={color} fill={fill} isBox={isBox} first={i === 0} sch={sch} /> : null))}
      </g>
      {symbol.primitives.map((p, i) => {
        if (p.type !== "text") return null
        let text = p.text
        if (p.role === "ref") text = refText ?? ""
        else if (p.role === "value") text = val ?? ""
        if (!text) return null
        const pinText = p.role === "pin" || p.role === "pinNumber"
        if (imported || p.angle !== undefined || mirror) {
          const at = orientPoint(p, rot, mirror)
          const l = textLayout(p, rot, mirror)
          return <WorldText key={`t${i}`} x={x + at.x} y={y + at.y} text={text} size={p.size ?? SCH_TEXT} extent={l.extent} vertical={l.vertical} fill={p.color ?? textColor(p.role, given, sch)} weight={p.bold ? 700 : 500} italic={p.italic} markup />
        }
        const at = transformPoint(p, { x, y }, rot)
        const extent = rotateExtent(anchorToExtent(p.anchor), rot)
        return (
          <WorldText
            key={`t${i}`}
            x={at.x}
            y={at.y}
            text={text}
            size={p.size ?? SCH_TEXT}
            extent={extent}
            vertical={pinText && (p.alongPin ? !vertical : vertical)}
            fill={textColor(p.role, given, sch)}
            weight={p.role === "ref" ? 600 : 500}
            mono={p.role === "ref" || pinText}
          />
        )
      })}
      {symbol.pinLabels?.flatMap((l) =>
        pinTexts(l, { rot, mirror }, symbol.pinNameOffset ?? 0, pinNames?.[l.number]).map((t, i) => {
          const h = t.h === "left" ? 1 : t.h === "right" ? -1 : 0
          const extent: TextExtent = t.angle === 90 ? { x: 0, y: h } : { x: h, y: 0 }
          return <WorldText key={`p${l.number}-${i}`} x={x + t.x} y={y + t.y} text={t.text} size={t.size} extent={extent} vertical={t.angle === 90} fill={t.number ? sch.pinNumber : sch.ink2} markup={!t.number} />
        }),
      )}
      {fields?.map((f) => {
        const ink = f.place.color ?? (f.name === "Reference" ? (given ?? sch.ink) : sch.ink2)
        return <WorldText key={`f${f.name}`} x={x + f.place.x} y={y + f.place.y} text={f.text} size={f.place.size ?? SCH_TEXT} extent={f.extent} vertical={f.vertical} fill={ink} weight={f.place.bold ? 700 : f.name === "Reference" ? 600 : 500} italic={f.place.italic} markup />
      })}
    </g>
  )
})

type TextRole = "ref" | "value" | "pin" | "pinNumber" | "label" | undefined

/** An override colour (power, placement ghost) also paints the designator. */
function textColor(role: TextRole, given: string | undefined, sch: SchPalette): string {
  if (role === "value" || role === "pin") return sch.ink2
  if (role === "pinNumber") return sch.pinNumber
  return given ?? sch.ink
}

/** The names a placed symbol's pins have where a chosen alternate gives one. */
function alternateNames(c: ComponentInstance, def: PartDef): Record<string, string> | undefined {
  if (!c.pinAlt) return undefined
  const out: Record<string, string> = {}
  for (const [pin, name] of Object.entries(c.pinAlt)) if (def.pins.find((p) => p.number === pin)?.alternates?.some((a) => a.name === name)) out[pin] = name
  return Object.keys(out).length ? out : undefined
}

export function ComponentSymbol({ c, part, opacity, color }: { c: ComponentInstance; part?: PartDef; opacity?: number; color?: string }) {
  const sch = useSch()
  const def = part ?? findPart(c.partId)
  if (!def) return null
  const power = powerNetName(c, def)
  const imported = hasFieldPlaces(def)
  return (
    <SymbolBody
      symbol={symbolOf(def, c)}
      x={c.sch.x}
      y={c.sch.y}
      rot={c.sch.rot}
      mirror={c.sch.mirror}
      color={color ?? (power ? sch.power : undefined)}
      refText={power ?? c.ref}
      valueText={power ? "" : valueText(c, def)}
      opacity={opacity}
      isBox={!imported && (def.category === "ICs" || def.refPrefix === "U" || def.category === "Connectors")}
      fields={imported ? componentFields(c, def) : undefined}
      pinNames={alternateNames(c, def)}
    />
  )
}

/** Small standalone preview for the parts library. */
export function SymbolPreview({ part, size = 44 }: { part: PartDef; size?: number }) {
  const sch = useSch()
  const symbol = symbolOf(part)
  const b = symbol.bounds
  const pad = 0.12
  const w = b.maxX - b.minX + pad * 2
  const h = b.maxY - b.minY + pad * 2
  const imported = hasFieldPlaces(part)
  const isBox = !imported && (part.category === "ICs" || part.refPrefix === "U" || part.category === "Connectors")
  const stroke = part.powerNet ? sch.power : sch.outline
  // A preview draws every line at a width that follows its size, whatever width the drawing gives it.
  const line = Math.max(w, h) / 34
  const flat = (p: ShapePrimitive): ShapePrimitive => {
    const look = p.look ? { ...p.look, width: undefined } : undefined
    return { ...p, look, ...(p.type === "path" ? { width: undefined } : {}) } as ShapePrimitive
  }
  return (
    <svg width={size} height={size} viewBox={`${b.minX - pad} ${-b.maxY - pad} ${w} ${h}`} aria-hidden>
      <g transform="scale(1,-1)">
        {symbol.primitives.map((p, i) => (isShape(p) ? <Shape key={i} p={flat(p)} color={stroke} fill={sch.body} isBox={isBox} first={i === 0} sch={{ ...sch, stroke: line }} /> : null))}
      </g>
    </svg>
  )
}
