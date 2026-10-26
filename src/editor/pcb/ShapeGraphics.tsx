import { dashShape, shapeSvgPath, type DashPiece } from "../../model/shapes"
import { shapeLayerInfo } from "../../model/shapeLayers"
import type { BoardShape } from "../../model/types"
import { layerOfKicadName } from "../../model/stack"
import { copperColor, PCB } from "../theme"

/** The colour a drawing layer is drawn in, for the board and the layer menu. */
export function shapeLayerColor(name: string): string {
  const info = shapeLayerInfo(name)
  switch (info?.kind) {
    case "copper":
      // Copper is in the colour of its own layer, the inner ones too (`In3.Cu`).
      return copperColor(layerOfKicadName(name) ?? (info.side === "bottom" ? "bottom" : "top"))
    case "silk":
      return info.side === "bottom" ? PCB.silkBottom : PCB.silk
    case "mask":
      return PCB.shapeMask
    case "paste":
      return PCB.shapePaste
    case "fab":
      return PCB.shapeFab
    case "courtyard":
      return PCB.courtyard
    case "adhesive":
      return PCB.shapeAdhesive
    default:
      return PCB.shapeUser
  }
}

function pieceD(p: DashPiece): string {
  if (p.kind === "line") return `M${p.a.x} ${p.a.y}L${p.b.x} ${p.b.y}`
  if (p.kind === "arc") return shapeSvgPath({ type: "arc", start: p.start, mid: p.mid, end: p.end })
  return `M${p.pts.map((q) => `${q.x} ${q.y}`).join("L")}`
}

/**
 * One drawing: stroked by its width with round caps and joins, filled when it is, cut into
 * dashes the way the Gerber cuts it. Mask and paste are drawn thin, so they read as outlines.
 */
export function ShapeDraw({ shape, color, px, selected = false, opacity = 1 }: { shape: BoardShape; color: string; px: number; selected?: boolean; opacity?: number }) {
  const kind = shapeLayerInfo(shape.layer)?.kind
  const thin = kind === "mask" || kind === "paste"
  const width = Math.max(thin ? Math.min(shape.width, 0.08) : shape.width, px)
  const d = shapeSvgPath(shape)
  const soft = thin || kind === "fab" || kind === "courtyard" || kind === "adhesive" || kind === "user"
  const dashed = shape.dash ? dashShape(shape) : []
  return (
    <g opacity={opacity}>
      {selected && <path d={d} fill="none" stroke={PCB.select} strokeWidth={width + 3 * px} strokeLinecap="round" strokeLinejoin="round" opacity={0.95} />}
      {shape.fill ? (
        <path d={d} fill={color} fillOpacity={soft ? 0.4 : 1} fillRule="evenodd" stroke={dashed.length ? "none" : color} strokeWidth={width} strokeLinecap="round" strokeLinejoin="round" />
      ) : null}
      {dashed.length ? (
        <path d={dashed.map(pieceD).join("")} fill="none" stroke={color} strokeWidth={width} strokeLinecap="round" strokeLinejoin="round" />
      ) : !shape.fill ? (
        <path d={d} fill="none" stroke={color} strokeWidth={width} strokeLinecap="round" strokeLinejoin="round" />
      ) : null}
    </g>
  )
}
