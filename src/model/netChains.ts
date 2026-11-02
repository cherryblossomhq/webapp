import type { NetChain, Project } from "./types"
import { isObject } from "../lib/guards"

// X21: KiCad's net chains (a run of nets through series parts: a termination resistor, a connector pair), kept by net name and by the pad each end is on. Nothing in the editor routes or checks by a chain yet; the
// project holds it, and it follows what it names: a net renamed in the schematic is renamed in its chains, a part that is gone takes its terminal pads with it.

/** The project with the chains' nets renamed by `renamed` (old name to new). The same project when none names one. */
export function renameChainNets(project: Project, renamed: Record<string, string>): Project {
  const chains = project.netChains
  if (!chains?.some((c) => c.nets.some((n) => renamed[n] !== undefined))) return project
  return { ...project, netChains: chains.map((c): NetChain => (c.nets.some((n) => renamed[n] !== undefined) ? { ...c, nets: [...new Set(c.nets.map((n) => renamed[n] ?? n))] } : c)) }
}

/** The chains with the terminals on parts that are gone left out, and a chain left with nothing at all dropped. The same project when nothing changed. */
export function pruneNetChains(project: Project): Project {
  const chains = project.netChains
  if (!chains?.length) return project
  const ids = new Set(project.components.map((c) => c.id))
  let changed = false
  const next = chains.flatMap((c): NetChain[] => {
    if (!c.terminals?.some((t) => !ids.has(t.component))) return [c]
    changed = true
    const terminals = c.terminals.filter((t) => ids.has(t.component))
    const { terminals: _t, ...rest } = c
    const kept: NetChain = terminals.length ? { ...rest, terminals } : rest
    return kept.nets.length || kept.name ? [kept] : []
  })
  if (!changed) return project
  const { netChains: _n, ...rest } = project
  return next.length ? { ...rest, netChains: next } : (rest as Project)
}


/** The chains of a stored project, each valid or gone; absent when there are none. */
export function normalizeNetChains(raw: unknown): NetChain[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const out: NetChain[] = []
  for (const c of raw) {
    if (!isObject(c) || typeof c.name !== "string" || !Array.isArray(c.nets) || !c.nets.every((n) => typeof n === "string")) continue
    const terminals = Array.isArray(c.terminals) ? c.terminals.filter((t): t is { component: string; pad: number } => isObject(t) && typeof t.component === "string" && Number.isInteger(t.pad) && (t.pad as number) >= 0) : []
    out.push({ name: c.name, nets: [...new Set(c.nets as string[])], ...(terminals.length ? { terminals } : {}) })
  }
  return out.length ? out : undefined
}
