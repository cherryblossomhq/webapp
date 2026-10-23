import { nextRef } from "./ops"
import type { Project } from "./types"

/** A part renumbered because someone else's took its designator at the same moment. */
export interface Renumbered {
  componentId: string
  from: string
  to: string
}

/**
 * Designators two people took at once. Each tab numbers a new part from the project as it sees it,
 * so two people adding a resistor at the same moment both make R3. When one tab hears of the
 * other's R3, exactly one of the two parts is renumbered, by the tab that added it: the part with
 * the later id (ids start with the time they were made), so both tabs reach the same answer
 * without asking each other.
 *
 * Only clashes with parts that have just `arrived` (added by someone else's batch) count: a part
 * someone named by hand to match another is left for Checks, not renamed behind their back.
 */
export function resolveDesignatorClashes(project: Project, arrived: ReadonlySet<string>, mine: (componentId: string) => boolean): { project: Project; renumbered: Renumbered[] } {
  const renumbered: Renumbered[] = []
  let current = project
  for (const theirs of project.components) {
    if (!arrived.has(theirs.id) || !theirs.ref || theirs.ref.startsWith("#")) continue
    for (const own of current.components) {
      if (own.id === theirs.id || own.ref !== theirs.ref || !mine(own.id) || own.id < theirs.id) continue
      const prefix = own.ref.replace(/\d+$/, "")
      if (!prefix || prefix === own.ref) continue
      const to = nextRef(current, prefix)
      renumbered.push({ componentId: own.id, from: own.ref, to })
      current = { ...current, components: current.components.map((c) => (c.id === own.id ? { ...c, ref: to } : c)) }
    }
  }
  return { project: current, renumbered }
}
