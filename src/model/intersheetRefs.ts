import type { Box } from "../lib/geometry"
import { labelBox } from "./labels"
import { textWidth } from "./labelShapes"
import { isHierarchical, sheetIdOf, sheetUses, type SheetUse } from "./sheets"
import { SCH_TEXT } from "./symbols"
import type { NetLabel, Project } from "./types"

// Intersheet references, as Altium and KiCad draw them beside a global label: the other sheets that have a global label of its name. Worked out from the
// whole project and never stored, so the file, the exports, hit tests of the label and Tidy know nothing of them. Only in a project of several sheets
// drawn here: a KiCad project's labels are drawn as KiCad has them.

const byProject = new WeakMap<Project, Map<string, SheetUse[]>>()

/** Each global label's name, with every use of a sheet that has a global label of it, in tree order. Empty for a KiCad project or one of one sheet. */
export function globalLabelUses(project: Project): Map<string, SheetUse[]> {
  const hit = byProject.get(project)
  if (hit) return hit
  const out = new Map<string, SheetUse[]>()
  if (!project.netNames && project.scope === undefined && isHierarchical(project)) {
    const namesOn = new Map<string, Set<string>>()
    for (const l of project.labels) {
      const name = l.name.trim()
      if (l.kind !== "global" || !name) continue
      const sheet = sheetIdOf(l)
      ;(namesOn.get(sheet) ?? namesOn.set(sheet, new Set()).get(sheet)!).add(name)
    }
    for (const use of sheetUses(project)) for (const name of namesOn.get(use.sheet) ?? []) (out.get(name) ?? out.set(name, []).get(name)!).push(use)
  }
  byProject.set(project, out)
  return out
}

/** The size of the references' text, smaller than the label's. */
export const REF_TEXT = SCH_TEXT * 0.8
const GAP = SCH_TEXT * 0.4

export interface IntersheetRefs {
  /** The whole text, `[Power, MCU]`, where it starts and which way it runs. */
  text: string
  at: { x: number; y: number }
  extent: { x: -1 | 1; y: 0 } | { x: 0; y: -1 | 1 }
  vertical: boolean
  /** Each use named, with the box of its name, for a click. */
  names: { use: SheetUse; box: Box }[]
}

/**
 * The references a global label on the use at `path` draws after its flag: the other uses whose sheet has a global label of its name (another use of the
 * same sheet counts). Null when there are none.
 */
export function intersheetRefs(project: Project, path: string, label: NetLabel): IntersheetRefs | null {
  if (label.kind !== "global") return null
  const uses = (globalLabelUses(project).get(label.name.trim()) ?? []).filter((u) => u.path !== path)
  if (!uses.length) return null
  const b = labelBox(label)
  const vertical = label.rot === 90 || label.rot === 270
  // After a flag pointing left or down the list ends at the flag, so its text starts its length before the point it is drawn from.
  const back = label.rot === 180 || label.rot === 270
  const at = label.rot === 0 ? { x: b.maxX + GAP, y: label.y } : label.rot === 180 ? { x: b.minX - GAP, y: label.y } : label.rot === 90 ? { x: label.x, y: b.maxY + GAP } : { x: label.x, y: b.minY - GAP }
  const text = `[${uses.map((u) => u.name).join(", ")}]`
  // Each name's place along the text, a monospaced character at a time from its start: "[" then the names with ", " between.
  const char = textWidth("x", REF_TEXT)
  const start = back ? -text.length * char : 0
  const names: IntersheetRefs["names"] = []
  let offset = 1
  for (const use of uses) {
    const lo = start + offset * char
    const hi = start + (offset + use.name.length) * char
    const half = REF_TEXT / 2
    names.push({ use, box: vertical ? { minX: at.x - half, maxX: at.x + half, minY: at.y + lo, maxY: at.y + hi } : { minX: at.x + lo, maxX: at.x + hi, minY: at.y - half, maxY: at.y + half } })
    offset += use.name.length + 2
  }
  return { text, at, extent: vertical ? { x: 0, y: back ? -1 : 1 } : { x: back ? -1 : 1, y: 0 }, vertical, names }
}
