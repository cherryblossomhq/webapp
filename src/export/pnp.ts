import { isPhysical, valueText } from "../model/instances"
import { findPart } from "../model/library"
import { inPositionFile } from "../model/partFlags"
import type { Project } from "../model/types"
import { csvRow } from "./bom"

export function pnpCsv(project: Project): string {
  const lines = [csvRow(["Designator", "Value", "Footprint", "Mid X", "Mid Y", "Rotation", "Layer"])]
  const parts = project.components
    .filter((c) => isPhysical(findPart(c.partId)) && inPositionFile(c))
    .sort((a, b) => a.ref.localeCompare(b.ref, undefined, { numeric: true }))
  for (const c of parts) {
    lines.push(
      csvRow([c.ref, valueText(c), c.footprint, c.pcb.x.toFixed(4), c.pcb.y.toFixed(4), c.pcb.rot, c.pcb.side]),
    )
  }
  return lines.join("\n") + "\n"
}
