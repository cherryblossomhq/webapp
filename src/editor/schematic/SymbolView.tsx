import { memo } from "react"
import { transformPoint } from "../../lib/geometry"
import { findPart } from "../../model/library"
import { powerNetName, valueText } from "../../model/instances"
import { anchorToExtent, rotateExtent, SCH_TEXT } from "../../model/symbols"
import type { ComponentInstance, PartDef, Rotation, SymbolDef } from "../../model/types"
import { useSch, type SchPalette } from "../theme"
import { WorldText } from "../viewport"

interface SymbolBodyProps {
  symbol: SymbolDef
  x: number
  y: number
  rot: Rotation
  color?: string
  fill?: string
  refText?: string
  valueText?: string
  opacity?: number
  isBox?: boolean
}

/** Renders a symbol's artwork in world space; text stays upright regardless of rotation. */
export const SymbolBody = memo(function SymbolBody({
  symbol,
  x,
  y,
  rot,
  color: given,
  fill: givenFill,
  refText,
  valueText: val,
  opacity,
  isBox,
}: SymbolBodyProps) {
  const sch = useSch()
  const color = given ?? sch.outline
  const fill = givenFill ?? sch.body
  const vertical = rot === 90 || rot === 270
  return (
    <g opacity={opacity}>
      <g transform={`translate(${x},${y}) rotate(${rot})`}>
        {symbol.primitives.map((p, i) => {
          if (p.type === "path") {
            const d = p.points.map((pt, j) => `${j ? "L" : "M"}${pt.x},${pt.y}`).join("")
            const closed = p.points.length > 2 && p.points[0].x === p.points[p.points.length - 1].x && p.points[0].y === p.points[p.points.length - 1].y
            return (
              <path
                key={i}
                d={d}
                fill={p.fill ? color : isBox && closed && i === 0 ? fill : "none"}
                stroke={color}
                strokeWidth={sch.stroke}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            )
          }
          if (p.type === "circle") {
            return <circle key={i} cx={p.x} cy={p.y} r={p.radius} fill={p.fill ? color : "none"} stroke={color} strokeWidth={sch.stroke} />
          }
          return null
        })}
      </g>
      {symbol.primitives.map((p, i) => {
        if (p.type !== "text") return null
        let text = p.text
        if (p.role === "ref") text = refText ?? ""
        else if (p.role === "value") text = val ?? ""
        if (!text) return null
        const at = transformPoint(p, { x, y }, rot)
        const pinText = p.role === "pin" || p.role === "pinNumber"
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

export function ComponentSymbol({
  c,
  part,
  opacity,
  color,
}: {
  c: ComponentInstance
  part?: PartDef
  opacity?: number
  color?: string
}) {
  const sch = useSch()
  const def = part ?? findPart(c.partId)
  if (!def) return null
  const power = powerNetName(c, def)
  return (
    <SymbolBody
      symbol={def.symbol}
      x={c.sch.x}
      y={c.sch.y}
      rot={c.sch.rot}
      color={color ?? (power ? sch.power : undefined)}
      refText={power ?? c.ref}
      valueText={power ? "" : valueText(c, def)}
      opacity={opacity}
      isBox={def.category === "ICs" || def.refPrefix === "U" || def.category === "Connectors"}
    />
  )
}

/** Small standalone preview for the parts library. */
export function SymbolPreview({ part, size = 44 }: { part: PartDef; size?: number }) {
  const sch = useSch()
  const b = part.symbol.bounds
  const pad = 0.12
  const w = b.maxX - b.minX + pad * 2
  const h = b.maxY - b.minY + pad * 2
  const isBox = part.category === "ICs" || part.refPrefix === "U" || part.category === "Connectors"
  const stroke = part.powerNet ? sch.power : sch.outline
  return (
    <svg width={size} height={size} viewBox={`${b.minX - pad} ${-b.maxY - pad} ${w} ${h}`} aria-hidden>
      <g transform="scale(1,-1)">
        {part.symbol.primitives.map((p, i) => {
          if (p.type === "path") {
            const d = p.points.map((pt, j) => `${j ? "L" : "M"}${pt.x},${pt.y}`).join("")
            return (
              <path
                key={i}
                d={d}
                fill={p.fill ? stroke : isBox && i === 0 ? sch.body : "none"}
                stroke={stroke}
                strokeWidth={Math.max(w, h) / 34}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            )
          }
          if (p.type === "circle") {
            return <circle key={i} cx={p.x} cy={p.y} r={p.radius} fill={p.fill ? stroke : "none"} stroke={stroke} strokeWidth={Math.max(w, h) / 34} />
          }
          return null
        })}
      </g>
    </svg>
  )
}
