import { isSchematicPart, valueText } from "../model/instances"
import { findPart } from "../model/library"
import { inBom } from "../model/partFlags"
import { withRuleAreaFlags } from "../model/ruleAreas"
import type { Project } from "../model/types"

/** Quote a CSV field when it contains separators, quotes, newlines or edge whitespace. */
export function csvField(value: string | number): string {
  const s = String(value)
  return /[",\r\n]|^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export const csvRow = (fields: (string | number)[]) => fields.map(csvField).join(",")

const naturalCompare = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true })

export function bomCsv(source: Project): string {
  // A flag on a sheet symbol is the flag of every part on the sheet, and one on a rule area of every part it touches.
  const project = withRuleAreaFlags(source)
  const groups = new Map<
    string,
    { refs: string[]; value: string; footprint: string; properties: string; mpn: string; description: string }
  >()
  for (const c of project.components) {
    const part = findPart(c.partId)
    // The other units of a part are symbols of it, not parts: a part is one line however many units it has.
    if (!part || !isSchematicPart(part) || part.unitOf) continue
    // A part brought in from KiCad can be marked virtual, not in the BOM, board only or do not populate.
    if (!inBom(c)) continue
    const value = valueText(c, part)
    const mpn = c.props.mpn ?? part.mpn ?? ""
    // An imported symbol has no land until it is linked to a board; the footprint its file names is carried as text.
    const footprint = c.footprint || c.props.Footprint || ""
    // Every property can pick a different physical part (a 16 V and a 50 V 10uF cap), so all of
    // them are in the key, and the ones the other columns don't show are listed.
    const properties = Object.entries(c.props)
      .filter(([k, v]) => k !== part.valueProp && k !== "mpn" && !(k === "Footprint" && v === footprint) && v !== "")
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join("; ")
    const key = JSON.stringify([c.partId, value, footprint, mpn, properties])
    const g = groups.get(key)
    if (g) {
      g.refs.push(c.ref)
      continue
    }
    groups.set(key, {
      refs: [c.ref],
      value,
      footprint,
      properties,
      mpn,
      description: part.description,
    })
  }
  const rows = [...groups.values()]
    .map((g) => ({ ...g, refs: g.refs.sort(naturalCompare) }))
    .sort((a, b) => naturalCompare(a.refs[0], b.refs[0]))
  const lines = [csvRow(["Designators", "Quantity", "Value", "Footprint", "Properties", "MPN", "Description"])]
  for (const g of rows) {
    lines.push(csvRow([g.refs.join(", "), g.refs.length, g.value, g.footprint, g.properties, g.mpn, g.description]))
  }
  return lines.join("\n") + "\n"
}
