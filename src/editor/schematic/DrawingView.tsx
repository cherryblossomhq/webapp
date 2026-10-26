import { createElement } from "react"
import { drawingBounds, drawingHandles } from "../../model/drawings"
import type { SchematicDrawing } from "../../model/types"
import { useSch } from "../theme"
import { paintDrawing } from "./drawingPaint"

/** A drawing on the sheet: a line, a shape or a text. Never a pointer target; the editor hit-tests them itself. */
export function DrawingView({ drawing, px, hidden = false, opacity }: { drawing: SchematicDrawing; px: number; hidden?: boolean; opacity?: number }) {
  const sch = useSch()
  return (
    <g opacity={hidden ? 0 : opacity} style={{ pointerEvents: "none" }}>
      {paintDrawing(drawing, sch, px).map((node, i) =>
        createElement(node.tag, { key: i, ...node.attrs, ...(node.tag === "text" && node.mono && { style: { fontFamily: "var(--font-mono)" } }) }, node.text),
      )}
    </g>
  )
}

/** What a selected or hovered drawing shows: a dashed box around it, and its grab handles when it is the only one selected. */
export function DrawingSelection({ drawing, px, handles, hovered = false }: { drawing: SchematicDrawing; px: number; handles: boolean; hovered?: boolean }) {
  const sch = useSch()
  const b = drawingBounds(drawing)
  const grow = 3 * px
  const size = 7 * px
  const showBox = drawing.type !== "line" || !handles
  return (
    <g style={{ pointerEvents: "none" }}>
      {showBox && (
        <rect
          x={b.minX - grow}
          y={b.minY - grow}
          width={b.maxX - b.minX + grow * 2}
          height={b.maxY - b.minY + grow * 2}
          fill={hovered ? "none" : sch.selectSoft}
          stroke={sch.select}
          strokeOpacity={hovered ? 0.45 : 1}
          strokeWidth={1.2 * px}
          strokeDasharray={`${4 * px} ${3 * px}`}
        />
      )}
      {handles &&
        drawingHandles(drawing).map((h, i) => (
          <rect key={i} x={h.x - size / 2} y={h.y - size / 2} width={size} height={size} rx={1.5 * px} fill={sch.paper} stroke={sch.select} strokeWidth={1.4 * px} />
        ))}
    </g>
  )
}
