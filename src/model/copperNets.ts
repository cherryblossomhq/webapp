import { pinKey } from "./connectivity"
import { getConnectivity, sameSchematic } from "./connectivityCache"
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
  // Only a schematic edit can rename a net: a move, turn, flip or flag on the PCB changes nothing the names depend on.
  if (sameSchematic(before, after)) return after
  // Connectivity is cached by schematic: the state before the edit is usually known already, and the one after is what the panels draw next.
  const was = getConnectivity(before)
  const now = getConnectivity(after)
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

/**
 * The traces and vias of the same connected copper as one item that carry the same stored net name as it does. A track
 * of a KiCad board is several editor traces, so forgetting the net on one would leave the rest naming it.
 * `island` is the PCB analysis's map of item ids to the copper they are joined to.
 */
export function sameStoredNet(project: Project, island: ReadonlyMap<string, number>, from: { trace: string } | { via: string }): { traces: string[]; vias: string[] } {
  const start = "trace" in from ? project.traces.find((t) => t.id === from.trace) : undefined
  const startVia = "via" in from ? project.vias.find((v) => v.id === from.via) : undefined
  const name = start?.net ?? startVia?.routedNet
  const root = "trace" in from ? island.get(`seg:${from.trace}:0`) : island.get(`via:${from.via}`)
  if (!name || root === undefined) return { traces: [], vias: [] }
  return {
    traces: project.traces.filter((t) => t.net === name && island.get(`seg:${t.id}:0`) === root).map((t) => t.id),
    vias: project.vias.filter((v) => v.routedNet === name && island.get(`via:${v.id}`) === root).map((v) => v.id),
  }
}

/** The traces and vias with their stored net forgotten: each is then on the net it touches. */
export function forgetStoredNets(project: Project, ids: { traces: string[]; vias: string[] }): Project {
  if (!ids.traces.length && !ids.vias.length) return project
  const t = new Set(ids.traces)
  const v = new Set(ids.vias)
  return {
    ...project,
    updatedAt: Date.now(),
    traces: project.traces.map((x) => {
      if (!t.has(x.id)) return x
      const { net: _n, ...rest } = x
      return rest
    }),
    vias: project.vias.map((x) => {
      if (!v.has(x.id)) return x
      const { routedNet: _n, ...rest } = x
      return rest
    }),
  }
}
