import type { AnyCircuitElement } from "circuit-json"
import { round } from "../lib/geometry"
import { shownOf, textLayerKind, textLayerSide, worldTexts, type WorldText } from "../model/texts"
import type { Project } from "../model/types"

// KiCad texts as Circuit JSON, where the format has an element for them:
//   silkscreen    pcb_silkscreen_text
//   copper        pcb_copper_text
//   fabrication   pcb_fabrication_note_text
// Mask, paste, courtyard, adhesive, user and edge text have no element and are left out, and a text box is its text
// alone at its anchor. Circuit JSON text has a size, an anchor, an alignment, a turn and a mirror and a knockout; it has no
// pen width, bold or italic, which are left out. Text is written as it is shown, its variables resolved.

const mm = (n: number) => round(n, 4)

type Anchor = "top_left" | "top_center" | "top_right" | "center_left" | "center" | "center_right" | "bottom_left" | "bottom_center" | "bottom_right"

/** The alignment a justification is. A mirrored text's left is its right on screen, but the anchor stays where the text was put: only the name of the side changes with the mirror. */
export function anchorOf(t: Pick<WorldText, "hj" | "vj">): Anchor {
  const v = t.vj === -1 ? "top" : t.vj === 1 ? "bottom" : "center"
  const h = t.hj === -1 ? "left" : t.hj === 1 ? "right" : "center"
  if (v === "center") return h === "center" ? "center" : (`center_${h}` as Anchor)
  return `${v}_${h}` as Anchor
}

export interface TextElements {
  elements: AnyCircuitElement[]
  /** Texts left out, by what their layer is. */
  left: Map<string, number>
  /** Text boxes, written as their text alone. */
  boxes: number
}

export function textElements(project: Project, ctx: { pcbIds: Map<string, string>; next: (prefix: string) => string }): TextElements {
  const elements: AnyCircuitElement[] = []
  const left = new Map<string, number>()
  let boxes = 0
  for (const t of worldTexts(project)) {
    if (!t.placed || t.hidden) continue
    const text = shownOf(project, t)
    if (!text.trim()) continue
    const kind = textLayerKind(t.layer)
    const side = textLayerSide(t.layer) ?? "top"
    const part = t.owner === "#board" ? "" : (ctx.pcbIds.get(t.owner) ?? "")
    const common = { font: "tscircuit2024" as const, font_size: mm(t.size), pcb_component_id: part, text, anchor_position: { x: mm(t.x), y: mm(t.y) }, anchor_alignment: anchorOf(t), ccw_rotation: mm(t.drawRot) }
    if (t.box) boxes++
    if (kind === "silk") {
      elements.push({ type: "pcb_silkscreen_text", pcb_silkscreen_text_id: ctx.next("pcb_silkscreen_text"), ...common, layer: side, ...(t.mirror ? { is_mirrored: true } : {}), ...(t.knockout ? { is_knockout: true } : {}) })
    } else if (kind === "copper") {
      elements.push({ type: "pcb_copper_text", pcb_copper_text_id: ctx.next("pcb_copper_text"), ...common, layer: side, ...(t.mirror ? { is_mirrored: true } : {}), ...(t.knockout ? { is_knockout: true } : {}) })
    } else if (kind === "fab") {
      const { anchor_alignment, ...rest } = common
      const alignment = anchor_alignment === "center" || anchor_alignment.startsWith("top_") || anchor_alignment.startsWith("bottom_") ? anchor_alignment : "center"
      elements.push({ type: "pcb_fabrication_note_text", pcb_fabrication_note_text_id: ctx.next("pcb_fabrication_note_text"), ...rest, anchor_alignment: alignment.endsWith("_center") ? "center" : (alignment as "center" | "top_left" | "top_right" | "bottom_left" | "bottom_right"), layer: side })
    } else {
      const what = kind === "mask" ? "mask" : kind === "paste" ? "paste" : kind === "courtyard" ? "courtyard" : kind === "adhesive" ? "adhesive" : kind === "edge" ? "board edge" : "user layer"
      left.set(what, (left.get(what) ?? 0) + 1)
    }
  }
  return { elements, left, boxes }
}
