import { computeConnectivity, pinKey } from "./connectivity"
import type { Project } from "./types"

/** The names the traces and vias of a board brought in from KiCad say they are on. */
const storedNames = (p: Project) => new Set([...p.traces.flatMap((t) => (t.net ? [t.net] : [])), ...p.vias.flatMap((v) => (v.routedNet ? [v.routedNet] : []))])

/** Trace and via net names changed by `renamed` (old name to new), all at once, so a swap is a swap. */
export function renameStoredNets(project: Project, renamed: Record<string, string>): Project {
  if (!project.traces.some((t) => t.net && renamed[t.net]) && !project.vias.some((v) => v.routedNet && renamed[v.routedNet])) return project
  return {
    ...project,
    traces: project.traces.map((t) => (t.net && renamed[t.net] ? { ...t, net: renamed[t.net] } : t)),
    vias: project.vias.map((v) => (v.routedNet && renamed[v.routedNet] ? { ...v, routedNet: renamed[v.routedNet] } : v)),
  }
}

/**
 * Stored copper nets follow a net that the schematic renamed or merged, whichever way the name
 * changed (a label edited, a power port renamed, Tidy's renames, a tool): a net is found again by the
 * pins it had, and when they all sit on one named net now, the copper that named the old net names that one.
 */
export function followNetRenames(before: Project, after: Project): Project {
  const names = storedNames(after)
  if (!names.size) return after
  if (before.components === after.components && before.wires === after.wires && before.labels === after.labels) return after
  const was = computeConnectivity(before)
  const now = computeConnectivity(after)
  const nowNet = new Map(now.nets.map((n) => [n.id, n]))
  const renamed: Record<string, string> = {}
  for (const net of was.nets) {
    if (!names.has(net.name)) continue
    const targets = new Set<string>()
    for (const pin of net.pins) {
      const id = now.pinNet.get(pinKey(pin.componentId, pin.pin))
      const n = id ? nowNet.get(id) : undefined
      if (n?.named) targets.add(n.name)
    }
    if (targets.size === 1) {
      const [to] = targets
      if (to !== net.name) renamed[net.name] = to
    }
  }
  if (!Object.keys(renamed).length) return after
  // Copper whose name the edit itself already changed (Tidy's renames) is left as the edit made it.
  const wasTrace = new Map(before.traces.map((t) => [t.id, t.net]))
  const wasVia = new Map(before.vias.map((v) => [v.id, v.routedNet]))
  const traces = after.traces.map((t) => (t.net && renamed[t.net] && wasTrace.get(t.id) === t.net ? { ...t, net: renamed[t.net] } : t))
  const vias = after.vias.map((v) => (v.routedNet && renamed[v.routedNet] && wasVia.get(v.id) === v.routedNet ? { ...v, routedNet: renamed[v.routedNet] } : v))
  return { ...after, traces, vias }
}
