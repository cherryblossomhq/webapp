import { bodyBox, flagMarkBox } from "../../model/instances"
import { labelGeometry } from "../../model/labelShapes"
import type { ComponentInstance, NetLabel } from "../../model/types"
import { useSch } from "../theme"
import { WorldText } from "../viewport"

// S2 and S7 on the canvas: a label as KiCad draws it (its text, or its flag), and the marks a part's
// flags give it. What else a KiCad sheet carries is drawn as drawings (`DrawingView`, `drawingPaint.ts`).
// Everything is drawn at the numbers the file gave, in the editor's units; the text is the editor's own
// font at KiCad's size and justification.

/** KiCad's default line width, 6 mil. */
const LINE = 0.012

/** A label from KiCad: its text beside its point, or a flag whose shape says what the signal does. */
export function KicadLabelView({ label, selected, px }: { label: NetLabel; selected: boolean; px: number }) {
  const sch = useSch()
  if (label.look?.hidden) return null
  const g = labelGeometry(label)
  const ink = label.look?.color ?? sch.labelInk
  const edge = selected ? sch.select : sch.wire
  return (
    <g>
      {g.outline.length > 0 && <polygon points={g.outline.map((p) => `${p.x},${p.y}`).join(" ")} fill={sch.label} stroke={edge} strokeWidth={Math.max(LINE, (selected ? 1.6 : 1) * px)} strokeLinejoin="round" />}
      {g.outline.length === 0 && selected && <rect x={g.box.minX} y={g.box.minY} width={g.box.maxX - g.box.minX} height={g.box.maxY - g.box.minY} fill={sch.selectSoft} stroke={sch.select} strokeWidth={px} />}
      <WorldText x={g.text.x} y={g.text.y} text={label.name} size={g.text.size} extent={g.text.extent} vertical={g.text.vertical} fill={selected && g.outline.length === 0 ? sch.select : ink} weight={label.look?.bold ? 700 : 500} italic={label.look?.italic} markup />
    </g>
  )
}

/**
 * What KiCad draws over a symbol its flags mark (`SCH_PAINTER::draw` of a symbol): a cross over a part that
 * is not to be populated, and a frame round the body of one left out of simulation.
 */
export function FlagMarks({ c }: { c: ComponentInstance }) {
  const sch = useSch()
  if (!c.flags?.dnp && !c.flags?.excludeFromSim) return null
  const dnp = c.flags.dnp ? flagMarkBox(c) : null
  const sim = c.flags.excludeFromSim ? bodyBox(c) : null
  return (
    <g pointerEvents="none">
      {dnp && (
        <g stroke={sch.danger} strokeWidth={0.036} strokeLinecap="butt" opacity={0.85}>
          <line x1={dnp.minX} y1={dnp.minY} x2={dnp.maxX} y2={dnp.maxY} />
          <line x1={dnp.minX} y1={dnp.maxY} x2={dnp.maxX} y2={dnp.minY} />
        </g>
      )}
      {sim && <rect x={sim.minX - 0.006} y={sim.minY - 0.006} width={sim.maxX - sim.minX + 0.012} height={sim.maxY - sim.minY + 0.012} fill="none" stroke={sch.ink3} strokeWidth={0.012} strokeDasharray="0.04 0.03" />}
    </g>
  )
}
