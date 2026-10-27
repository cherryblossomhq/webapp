import { labelGeometry } from "../../model/labelShapes"
import type { SheetSymbol } from "../../model/types"
import { useSch } from "../theme"
import { WorldText } from "../viewport"

// S1 on the canvas: a sheet symbol (KiCad's rectangle with the sheet's name above it and its file below) and its pins, each a flag
// whose shape says which way the signal goes, drawn as a hierarchical label is. Everything at the numbers the file gave.

const LINE = 0.012
const TEXT = 0.1

/** A sheet symbol with its name and file, and its pins. */
export function SheetSymbolView({ sym, selected, hovered, px, openable }: { sym: SheetSymbol; selected: boolean; hovered: boolean; px: number; openable: boolean }) {
  const sch = useSch()
  const border = sym.stroke?.color ?? sch.block
  const stroke = selected ? sch.select : border
  // With no fill of its own a sheet is a soft tint of its border, as Altium fills its sheet symbols: one thing to click and open, never mistaken for a block's frame.
  const fill = sym.fill?.kind === "color" ? (sym.fill.color ?? "none") : sym.fill ? sch.body : border
  const fillOpacity = sym.fill?.kind === "color" ? 1 : sym.fill ? 0.5 : hovered && openable ? 0.1 : 0.06
  const dash = sym.stroke?.dash === "dash" ? "0.08 0.04" : sym.stroke?.dash === "dot" ? "0.02 0.04" : undefined
  return (
    <g>
      <rect
        x={sym.x}
        y={sym.y}
        width={sym.w}
        height={sym.h}
        fill={fill}
        fillOpacity={fillOpacity}
        stroke={stroke}
        strokeWidth={Math.max(sym.stroke?.width ?? 0.014, (selected || hovered ? 1.8 : 1.2) * px)}
        strokeDasharray={dash}
      />
      {selected && <rect x={sym.x} y={sym.y} width={sym.w} height={sym.h} fill={sch.selectSoft} stroke="none" pointerEvents="none" />}
      <WorldText x={sym.x} y={sym.y + sym.h + 0.03} text={sym.name} size={TEXT} extent={{ x: 1, y: -1 }} fill={selected ? sch.select : sch.ink2} weight={600} />
      <WorldText x={sym.x} y={sym.y - 0.03} text={sym.file} size={TEXT} extent={{ x: 1, y: 1 }} fill={sch.ink3} weight={500} />
      {openable && hovered && <WorldText x={sym.x + sym.w / 2} y={sym.y + sym.h / 2} text="Double-click to open" size={TEXT} extent={{ x: 0, y: 0 }} fill={sch.ink3} weight={500} />}
      {sym.flags?.dnp && (
        <g stroke={sch.danger} strokeWidth={0.036} opacity={0.85} pointerEvents="none">
          <line x1={sym.x} y1={sym.y} x2={sym.x + sym.w} y2={sym.y + sym.h} />
          <line x1={sym.x} y1={sym.y + sym.h} x2={sym.x + sym.w} y2={sym.y} />
        </g>
      )}
      {sym.pins.map((p) => {
        // A pin is the flag of a hierarchical label that points into the sheet: it starts at the edge and runs inward.
        const inward = ((p.rot + 180) % 360) as 0 | 90 | 180 | 270
        const g = labelGeometry({ id: p.id, name: p.name, x: p.x, y: p.y, rot: inward, kind: "hierarchical", shape: p.shape, ...(p.look ? { look: p.look } : {}) })
        return (
          <g key={p.id}>
            {g.outline.length > 0 && <polygon points={g.outline.map((q) => `${q.x},${q.y}`).join(" ")} fill={sch.label} stroke={selected ? sch.select : sch.wire} strokeWidth={Math.max(LINE, px)} strokeLinejoin="round" />}
            <WorldText x={g.text.x} y={g.text.y} text={p.name} size={g.text.size} extent={g.text.extent} vertical={g.text.vertical} fill={p.look?.color ?? sch.labelInk} weight={p.look?.bold ? 700 : 500} italic={p.look?.italic} markup />
          </g>
        )
      })}
    </g>
  )
}
