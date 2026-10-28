import { valueText } from "../model/instances"
import { inPositionFile } from "../model/partFlags"
import { normalizeAngle } from "../lib/geometry"
import type { ComponentInstance, Project } from "../model/types"
import { csvRow } from "./bom"
import { withRuleAreaFlags } from "../model/ruleAreas"

/**
 * The angle the position file gives a part. A part drawn in the editor gives its rotation as it is.
 * A part from a KiCad board gives the angle KiCad's own position file has, the footprint's stored
 * orientation in [0, 360) (`place_file_exporter.cpp`: `GetOrientation().AsDegrees()`): the editor
 * holds a bottom part half a turn from it (mirror, then turn), so that half turn is taken off. Any
 * angle is written to six decimals with no trailing zeros, so 45 and 22.5 stay what they are.
 */
export function positionAngle(c: ComponentInstance): number {
  if (c.fpid === undefined) return Number.isInteger(c.pcb.rot) ? c.pcb.rot : Number(normalizeAngle(c.pcb.rot).toFixed(6))
  return Number(normalizeAngle(c.pcb.side === "bottom" ? c.pcb.rot - 180 : c.pcb.rot).toFixed(6))
}

export function pnpCsv(source: Project): string {
  // A flag on a sheet symbol is the flag of every part on the sheet, and one on a rule area of every part it touches.
  const project = withRuleAreaFlags(source)
  const lines = [csvRow(["Designator", "Value", "Footprint", "Mid X", "Mid Y", "Rotation", "Layer"])]
  const parts = project.components
    .filter((c) => inPositionFile(c))
    .sort((a, b) => a.ref.localeCompare(b.ref, undefined, { numeric: true }))
  for (const c of parts) {
    lines.push(
      csvRow([c.ref, valueText(c), c.footprint, c.pcb.x.toFixed(4), c.pcb.y.toFixed(4), positionAngle(c), c.pcb.side]),
    )
  }
  return lines.join("\n") + "\n"
}
