import { pointSegmentDistance } from "../lib/geometry"
import { pcbPads } from "./instances"
import { pointPadDistance, segmentPadDistance } from "./pcb"
import type { ComponentInstance, Project } from "./types"

// Copper on a board that a part's place decides: shared by place_parts and by taking a part off the board.

/** Unlocked and locked traces and vias whose copper touches a pad of one of these parts, as they stand now. */
export function copperOn(project: Project, parts: ComponentInstance[]) {
  const pads = parts.flatMap((c) => (c.pcb.placed ? pcbPads(c) : []))
  const traces = project.traces.filter((t) =>
    t.points.slice(1).some((p, i) => pads.some((pad) => pad.layers.includes(t.layer) && segmentPadDistance(t.points[i], p, pad) <= t.width / 2 + 1e-6)),
  )
  const vias = project.vias.filter((v) => !v.net && pads.some((pad) => pointPadDistance(v, pad) <= v.diameter / 2 + 1e-6))
  return { traces, vias }
}

/**
 * Delete traces and vias. A routed via that a removed trace ended on, and that no trace left standing
 * and no pad touches, joins nothing any more and goes with it.
 */
export function removeCopper(project: Project, traceIds: Set<string>, viaIds: Set<string>): Project {
  const gone = project.traces.filter((t) => traceIds.has(t.id))
  const traces = project.traces.filter((t) => !traceIds.has(t.id))
  const pads = project.components.flatMap((c) => (c.pcb.placed ? pcbPads(c) : []))
  const touches = (t: Project["traces"][number], v: Project["vias"][number]) =>
    t.points.some((pt, i) => (i === 0 ? pointSegmentDistance(v, pt, pt) : pointSegmentDistance(v, t.points[i - 1], pt)) <= t.width / 2 + v.diameter / 2 + 1e-6)
  const orphan = (v: Project["vias"][number]) =>
    !v.net && !v.locked && gone.some((t) => touches(t, v)) && !traces.some((t) => touches(t, v)) && !pads.some((pad) => pointPadDistance(v, pad) <= v.diameter / 2 + 1e-6)
  const vias = project.vias.filter((v) => !viaIds.has(v.id) && !orphan(v))
  return { ...project, updatedAt: Date.now(), traces, vias }
}

/** What taking a part off the board removed, as a sentence ending in a space-free full stop; empty when nothing went. */
export function copperRemovedNote(before: Project, after: Project): string {
  const t = before.traces.length - after.traces.length
  const v = before.vias.length - after.vias.length
  if (t <= 0 && v <= 0) return ""
  const parts = [t > 0 ? `${t} trace${t === 1 ? "" : "s"}` : "", v > 0 ? `${v} via${v === 1 ? "" : "s"}` : ""].filter(Boolean)
  return `${parts.join(" and ")} that touched its pads ${t + v === 1 ? "was" : "were"} removed (locked copper stays)`
}

/** Copper that reaches the pads of parts that are leaving the board: the unlocked traces and vias go, as they do when a part moves away. */
export function withoutCopperOf(project: Project, parts: ComponentInstance[]): Project {
  const attached = copperOn(project, parts)
  const traces = new Set(attached.traces.filter((t) => !t.locked).map((t) => t.id))
  const vias = new Set(attached.vias.filter((v) => !v.locked).map((v) => v.id))
  return traces.size || vias.size ? removeCopper(project, traces, vias) : project
}
