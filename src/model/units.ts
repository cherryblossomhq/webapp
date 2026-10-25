import { findPart, unitTwinId } from "./library"
import type { ComponentInstance } from "./types"

// A part with several units is placed as several symbols that share a reference (S5). One of them
// is the part, with its footprint and place on the board; the others are placements of the part's
// twin (`unitTwinId`), which has no footprint (`unitOwners` in `instances.ts` pairs them up). These
// are the repairs that keep that pairing whole when a component is removed, copied or read from a file.

/**
 * A twin with no part of its reference to belong to becomes the part: it takes the footprint the
 * part has by default. A file edited by hand, a paste of one unit alone and a delete of the part
 * itself all leave one. `removed` are the components just deleted: a unit that takes over from
 * the part that was deleted keeps its footprint and its place on the board.
 */
export function repairUnits(components: ComponentInstance[], removed?: ComponentInstance[]): ComponentInstance[] {
  let out: ComponentInstance[] | null = null
  const has = new Set<string>()
  for (const c of components) if (!findPart(c.partId)?.unitOf) has.add(c.ref)
  for (let i = 0; i < components.length; i++) {
    const c = components[i]
    const base = findPart(c.partId)?.unitOf
    if (!base) continue
    if (has.has(c.ref)) continue
    has.add(c.ref)
    const part = findPart(base)
    const gone = removed?.find((r) => r.ref === c.ref)
    ;(out ??= components.slice())[i] = { ...c, partId: base, footprint: gone?.footprint ?? part?.footprints[0] ?? "", ...(gone ? { pcb: gone.pcb } : {}) }
  }
  return out ?? components
}

/** The component a part's other units are listed under: itself, or the part it is a unit of. */
export const basePartId = (partId: string): string => findPart(partId)?.unitOf ?? partId

export { unitTwinId }
