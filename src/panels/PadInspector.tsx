import { MousePointer2 } from "lucide-react"
import { componentFootprint } from "../model/instances"
import type { SelectedPad } from "../model/padSelection"
import { formatLength } from "../model/rules"
import { layerLabel } from "../model/stack"
import type { PadShape, Project } from "../model/types"
import { getConnectivity } from "../store/analysis"
import { uiApi } from "../store/uiStore"
import { Button } from "../ui/controls"
import { Row, Section, useLengthUnit } from "../ui/form"

const SHAPES: Record<PadShape, string> = { rect: "Rectangle", circle: "Circle", pill: "Oval", polygon: "Polygon" }

/**
 * One pad of a placed part, picked from the double-click list where it lies under the pointer with its part (`PickMenu`): what it is, where, on
 * which net. It reads only: a pad is its land pattern's, which every part placed from that land shares, so it changes in the part editor, or in
 * the part's Pads section for a land from KiCad.
 */
export function PadInspector({ selected: s, project }: { selected: SelectedPad; project: Project }) {
  const unit = useLengthUnit()
  const { c, pad } = s
  const len = (mm: number) => formatLength(mm, unit, true)
  const net = s.netId === "short" ? "Short circuit" : (getConnectivity(project).nets.find((n) => n.id === s.netId)?.name ?? "Not connected")
  const number = pad.padNumber ?? pad.pin ?? `${s.index + 1}`
  const land = componentFootprint(c)?.name
  return (
    <Section title={`Pad ${c.ref}.${number}`}>
      <Row label="Part" value={c.ref} mono />
      {s.pinName && <Row label="Pin" value={s.pinName} mono />}
      <Row label="Net" value={pad.plated === false ? "None (a hole)" : net} mono />
      <Row label="Shape" value={pad.plated === false ? "Non-plated hole" : SHAPES[pad.shape]} />
      <Row label="Size" value={`${formatLength(pad.width, unit)} x ${len(pad.height)}`} />
      {pad.holeDiameter !== undefined && <Row label={pad.slotLength ? "Slot" : "Drill"} value={pad.slotLength ? `${formatLength(pad.holeDiameter, unit)} x ${len(pad.slotLength)}` : len(pad.holeDiameter)} />}
      <Row label="Layers" value={pad.layers.map((l) => layerLabel(project.board, l)).join(", ")} />
      <Row label="Position" value={`${formatLength(pad.x, unit)}, ${len(pad.y)}`} mono />
      <p className="text-[12px] text-ink-2">
        A pad belongs to {land ? `the ${land} land pattern` : "its part's land pattern"}, shared by every part placed from it: change it in the part editor.
      </p>
      <div className="flex flex-wrap gap-1.5">
        <Button onClick={() => uiApi().select([`c:${c.id}`])} title={`Select ${c.ref}, the part this pad is on`}>
          <MousePointer2 size={14} /> Select {c.ref}
        </Button>
      </div>
    </Section>
  )
}
