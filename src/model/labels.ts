import type { Box } from "../lib/geometry"
import type { NetLabel } from "./types"

/** Height of a net label's flag, across the wire it names. */
export const LABEL_H = 0.17
export const labelWidth = (name: string) => name.length * 0.08 + 0.16

/** The flag of a net label: it starts at the label's point and runs away from it in the label's direction. */
export function labelBox(l: NetLabel): Box {
  const w = labelWidth(l.name)
  switch (l.rot) {
    case 180:
      return { minX: l.x - w, maxX: l.x, minY: l.y - LABEL_H / 2, maxY: l.y + LABEL_H / 2 }
    // On vertical wires the label runs along the wire, so labels on neighbouring pins sit side by side.
    case 90:
      return { minX: l.x - LABEL_H / 2, maxX: l.x + LABEL_H / 2, minY: l.y, maxY: l.y + w }
    case 270:
      return { minX: l.x - LABEL_H / 2, maxX: l.x + LABEL_H / 2, minY: l.y - w, maxY: l.y }
    default:
      return { minX: l.x, maxX: l.x + w, minY: l.y - LABEL_H / 2, maxY: l.y + LABEL_H / 2 }
  }
}
