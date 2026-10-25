import { getConnectivity, getErc } from "../model/connectivityCache"
import type { SchematicConnectivity } from "../model/connectivity"
import type { ErcFinding } from "../model/erc"
import { analyzePcb, type PcbAnalysis } from "../model/pcb"
import type { ZoneFill } from "../model/pour"
import type { Project } from "../model/types"
import { useProjectStore } from "./projectStore"

export { getConnectivity, getErc }

const pcbCache = new WeakMap<Project, PcbAnalysis>()

export function useErc(): ErcFinding[] | null {
  const p = useProjectStore((s) => s.project)
  return p ? getErc(p) : null
}

const dragCache = new WeakMap<Project, PcbAnalysis>()
let lastFills: { zones: Project["zones"]; board: Project["board"]; fills: ZoneFill[] } | null = null

export function getPcbAnalysis(p: Project): PcbAnalysis {
  const hit = pcbCache.get(p)
  if (hit) return hit
  // While something is being dragged, keep the last pour fill; it refills on drop. That holds for the corner of a zone that is being dragged
  // too (its outline moves with the pointer and its copper follows on drop, as KiCad's does on a refill): the fill of a big board takes seconds.
  const dragging = useProjectStore.getState().transientBase !== null
  if (dragging && p.zones.length && lastFills && lastFills.zones.length === p.zones.length && lastFills.board === p.board) {
    const stale = dragCache.get(p)
    if (stale) return stale
    const value = analyzePcb(p, getConnectivity(p), { fills: lastFills.fills })
    dragCache.set(p, value)
    return value
  }
  const value = analyzePcb(p, getConnectivity(p))
  pcbCache.set(p, value)
  lastFills = { zones: p.zones, board: p.board, fills: value.zoneFills }
  return value
}

/** Filled copper pours, computed as part of the PCB analysis. */
export function getZoneFills(p: Project): ZoneFill[] {
  return getPcbAnalysis(p).zoneFills
}

export function useConnectivity(): SchematicConnectivity | null {
  const p = useProjectStore((s) => s.project)
  return p ? getConnectivity(p) : null
}

export function usePcbAnalysis(): PcbAnalysis | null {
  const p = useProjectStore((s) => s.project)
  return p ? getPcbAnalysis(p) : null
}
