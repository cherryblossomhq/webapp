import { jsonEqual } from "@cherryblossom/project-changes"
import { dropDeadLayers } from "./layerOps"
import { dropUnusedSheets } from "./sheetOps"
import { fillCopies, sheetsOf } from "./sheets"
import type { Project, SheetSymbol } from "./types"

// Live editing: what two copies of a project each run after an edit (their own, an undo, or someone else's batch) so that the sheet tree and what hangs
// on it stay whole whatever order the edits met in. A copy that settles a state sends what that changed, and every copy settling the same state must reach
// the same project, or they would trade edits for ever (`fillCopies` is built for that).

/** Whether two projects have the same sheet tree and the same things on it (a plain root listed or not is no difference). */
function sameStructure(a: Project, b: Project): boolean {
  return (
    jsonEqual(a.components, b.components) &&
    jsonEqual(a.wires, b.wires) &&
    jsonEqual(a.labels, b.labels) &&
    jsonEqual(a.drawings ?? [], b.drawings ?? []) &&
    jsonEqual(a.busAliases ?? [], b.busAliases ?? []) &&
    jsonEqual(a.sheetSymbols ?? [], b.sheetSymbols ?? []) &&
    jsonEqual(sheetsOf(a), sheetsOf(b))
  )
}

/** What is drawn on sheets and uses the tree no longer has goes (and the per-use keys of the symbols that went), then each use of a reused sheet gets the parts another use has. */
export function settleStructure(project: Project): Project {
  const dropped = dropUnusedSheets(project)
  const clean = sameStructure(project, dropped) ? project : dropped
  return dropDeadLayers(fillCopies(clean))
}

/** How many things (parts, wires, labels, drawings, bus aliases) the tree leaves on sheets and uses it does not have. */
function orphans(project: Project): number {
  const d = dropUnusedSheets(project)
  return (
    project.components.length - d.components.length +
    project.wires.length - d.wires.length +
    project.labels.length - d.labels.length +
    (project.drawings?.length ?? 0) - (d.drawings?.length ?? 0) +
    (project.busAliases?.length ?? 0) - (d.busAliases?.length ?? 0)
  )
}

/**
 * `after` is `before` with an undo or a redo applied. A sheet symbol that step removed stays when someone else has parts or wires on what it stands for
 * (the step only ever took back this user's own sheet; what was added to it since is another's, and removing it would delete their work without their
 * knowing). A symbol whose sheet is empty goes as the step said. Returns `after` unchanged when nothing would be orphaned.
 */
export function keepSheetsWithWork(before: Project, after: Project): Project {
  const there = new Set((after.sheetSymbols ?? []).map((s) => s.id))
  const removed = (before.sheetSymbols ?? []).filter((s) => !there.has(s.id))
  if (!removed.length) return after
  const restore = (p: Project, symbols: SheetSymbol[]): Project => {
    const sheets = [...sheetsOf(p)]
    for (const s of symbols) {
      if (!sheets.some((x) => x.id === s.child)) {
        const own = sheetsOf(before).find((x) => x.id === s.child)
        if (own) sheets.push(own)
      }
    }
    return { ...p, sheetSymbols: [...(p.sheetSymbols ?? []), ...symbols], sheets }
  }
  const full = restore(after, removed)
  const base = orphans(full)
  if (orphans(after) <= base) return after
  let cur = full
  for (const s of removed) {
    const trial: Project = { ...cur, sheetSymbols: (cur.sheetSymbols ?? []).filter((x) => x.id !== s.id) }
    if (orphans(trial) <= base) cur = dropUnusedSheets(trial)
  }
  return cur
}
