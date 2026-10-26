import { computeConnectivity, type SchematicConnectivity } from "../model/connectivity"
import { runErc, type ErcFinding } from "../model/erc"
import { analyzePcb, type PcbAnalysis } from "../model/pcb"
import type { ZoneFill } from "../model/pour"
import type { Project } from "../model/types"
import { useProjectStore } from "./projectStore"

const schCache = new WeakMap<Project, SchematicConnectivity>()
const pcbCache = new WeakMap<Project, PcbAnalysis>()

/** Connectivity depends only on schematic content, so reuse it across PCB-only edits. */
let lastSchKey: { components: unknown; wires: unknown; labels: unknown; value: SchematicConnectivity } | null = null

export function getConnectivity(p: Project): SchematicConnectivity {
  const hit = schCache.get(p)
  if (hit) return hit
  let value: SchematicConnectivity
  if (lastSchKey && lastSchKey.components === p.components && lastSchKey.wires === p.wires && lastSchKey.labels === p.labels) {
    value = lastSchKey.value
  } else {
    value = computeConnectivity(p)
    lastSchKey = { components: p.components, wires: p.wires, labels: p.labels, value }
  }
  schCache.set(p, value)
  return value
}

/** Keyed by the connectivity, which is reused while the schematic is unchanged, so PCB edits don't rerun it. */
const ercCache = new WeakMap<SchematicConnectivity, ErcFinding[]>()

/** Electrical check findings, ignored ones included (`splitIgnored` separates them). */
export function getErc(p: Project): ErcFinding[] {
  const conn = getConnectivity(p)
  let value = ercCache.get(conn)
  if (!value) {
    value = runErc(p, conn)
    ercCache.set(conn, value)
  }
  return value
}

export function useErc(): ErcFinding[] | null {
  const p = useProjectStore((s) => s.project)
  return p ? getErc(p) : null
}

const dragCache = new WeakMap<Project, PcbAnalysis>()
let lastFills: { zones: Project["zones"]; board: Project["board"]; fills: ZoneFill[] } | null = null

export function getPcbAnalysis(p: Project): PcbAnalysis {
  const hit = pcbCache.get(p)
  if (hit) return hit
  // While something is being dragged, keep the last pour fill; it refills on drop.
  const dragging = useProjectStore.getState().transientBase !== null
  if (dragging && p.zones.length && lastFills && lastFills.zones === p.zones && lastFills.board === p.board) {
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
