import { layerText, textFontState, textLayerKind, textLayerSide, type LayerText, type WorldText } from "../../model/texts"
import type { Project } from "../../model/types"
import { PCB } from "../theme"
import { shapeLayerColor } from "./ShapeGraphics"

/** The colour a text's layer is drawn in: the colour of the layer's drawings. */
export function textLayerColor(layer: string): string {
  return textLayerKind(layer) === "edge" ? PCB.edge : shapeLayerColor(layer)
}

const ring = (r: { x: number; y: number }[]) => `M${r.map((p) => `${p.x},${p.y}`).join("L")}Z`

/**
 * One KiCad text as the board shows it: its strokes with its pen, a knockout filled with the letters left out, a text box's border.
 * Mask and paste text is drawn thin and every layer that is not copper or silkscreen soft, as a drawing on them is.
 */
export function TextDraw({ t, project, px, selected = false, opacity = 1 }: { t: WorldText; project: Project; px: number; selected?: boolean; opacity?: number }) {
  const lt: LayerText | null = layerText(project, t)
  if (!lt) return null
  const kind = textLayerKind(t.layer)
  const color = textLayerColor(t.layer)
  const thin = kind === "mask" || kind === "paste"
  const soft = thin || kind === "fab" || kind === "courtyard" || kind === "adhesive" || kind === "user"
  const width = Math.max(thin ? Math.min(lt.pen, 0.08) : lt.pen, px)
  const strokes = lt.strokes.map((s) => (s.length === 1 ? [s[0], s[0]] : s))
  const d = strokes.map((s) => `M${s.map((p) => `${p.x},${p.y}`).join("L")}`).join("")
  const fillD = lt.fills.flatMap((poly) => poly.map(ring)).join("")
  // A text whose font the editor cannot draw (X19) and has no outlines for is drawn in the stroke font: a dashed amber box says it is not the shape KiCad draws.
  const font = textFontState(project, t)
  const border = lt.border ? `M${lt.border.points.map((p) => `${p.x},${p.y}`).join("L")}Z` : ""
  return (
    <g opacity={opacity}>
      {selected && (
        <rect
          x={lt.box.minX - 2 * px}
          y={lt.box.minY - 2 * px}
          width={lt.box.maxX - lt.box.minX + 4 * px}
          height={lt.box.maxY - lt.box.minY + 4 * px}
          fill={PCB.selectSoft}
          stroke={PCB.select}
          strokeWidth={1.2 * px}
          rx={2 * px}
        />
      )}
      {(font === "edited" || font === "uncached") && (
        <rect
          x={lt.box.minX - 1.5 * px}
          y={lt.box.minY - 1.5 * px}
          width={lt.box.maxX - lt.box.minX + 3 * px}
          height={lt.box.maxY - lt.box.minY + 3 * px}
          fill="none"
          stroke={PCB.warn}
          strokeWidth={1 * px}
          strokeDasharray={`${3 * px} ${2 * px}`}
          pointerEvents="none"
        >
          <title>{`Drawn in KiCad's stroke font: the editor cannot draw ${t.face}`}</title>
        </rect>
      )}
      {fillD && <path d={fillD} fill={color} fillOpacity={soft ? 0.4 : 1} fillRule="evenodd" />}
      {d && <path d={d} fill="none" stroke={color} strokeWidth={width} strokeLinecap="round" strokeLinejoin="round" />}
      {border && <path d={border} fill="none" stroke={color} strokeWidth={Math.max(lt.border!.width, px)} strokeLinejoin="round" />}
    </g>
  )
}

/** Which side of the board a text's layer is on, for fading the far side's. */
export const textSide = (layer: string) => textLayerSide(layer)
