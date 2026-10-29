import { buildCopperItems, copperNetOf } from "./pcb"
import { computeConnectivity } from "./connectivity"
import { withPartZones } from "./partZones"
import { hasKeptFills, keptContext, signKept } from "./zoneKeep"
import type { Project } from "./types"

/**
 * A project whose zones' kept fills (KiCad's own, from a board brought in) are signed as the project is now (`zoneKeep.ts`): from here the fill is valid until an edit near the zone changes
 * what the signature reads. Called once, as the import finishes, when the nets of the pads are the project's final ones. A project with no kept fill is returned as it is.
 */
export function signKeptFills(project: Project): Project {
  if (!hasKeptFills(project)) return project
  const whole = withPartZones(project)
  const sch = computeConnectivity(project)
  const copper = buildCopperItems(whole, sch)
  const netOf = copperNetOf(whole, sch, copper)
  const names = new Map(sch.nets.map((n) => [n.id, n.name]))
  return signKept(project, keptContext(whole, copper, netOf, (id) => (id ? (names.get(id) ?? null) : null)))
}
