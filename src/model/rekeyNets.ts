import { computeConnectivity } from "./connectivity"
import { isAutoNetName } from "./netNames"
import type { Project } from "./types"

/**
 * Board data is keyed by a net's name (`Zone.net`, `Via.net`, `rules.netWidths`). A name made up from a pin
 * (`Net-(R3-Pad2)`) changes when the part is renamed or removed, or when a connection adds a name to the net:
 * what was keyed by the old name is keyed by the new one. The net is found again by its pins the way KiCad's
 * board update finds it: the net of `after` that shares the most pins with the old one (a superset when nets were
 * joined, a subset when a part left), ties going to the net whose pins differ least. Nothing else is touched, and
 * a project with no such data, or whose names did not change, is returned as it is (the very same object).
 */
export function rekeyAutoNets(before: Project, after: Project): Project {
  const widths = after.rules.netWidths ?? {}
  const keyed = new Set<string>([...after.zones.map((z) => z.net), ...after.vias.flatMap((v) => (v.net ? [v.net] : [])), ...Object.keys(widths)])
  for (const name of [...keyed]) if (!isAutoNetName(name)) keyed.delete(name)
  if (!keyed.size) return after
  const pinKeyOf = (p: { componentId: string; pin: string }) => `${p.componentId}:${p.pin}`
  const old = computeConnectivity(before).nets.filter((n) => keyed.has(n.name))
  if (!old.length) return after
  const nets = computeConnectivity(after).nets.map((n) => ({ name: n.name, pins: new Set(n.pins.map(pinKeyOf)) }))
  const names = new Set(nets.map((n) => n.name))
  const map = new Map<string, string>()
  for (const o of old) {
    // The name is still a net of the new sheet: nothing to follow.
    if (names.has(o.name)) continue
    const mine = o.pins.map(pinKeyOf)
    let best: { name: string; shared: number; apart: number } | null = null
    for (const n of nets) {
      const shared = mine.filter((k) => n.pins.has(k)).length
      if (!shared) continue
      const apart = mine.length - shared + (n.pins.size - shared)
      if (!best || shared > best.shared || (shared === best.shared && apart < best.apart)) best = { name: n.name, shared, apart }
    }
    if (best && best.name !== o.name) map.set(o.name, best.name)
  }
  if (!map.size) return after
  const key = (name: string) => map.get(name) ?? name
  return {
    ...after,
    zones: after.zones.map((z) => (map.has(z.net) ? { ...z, net: key(z.net) } : z)),
    vias: after.vias.map((v) => (v.net && map.has(v.net) ? { ...v, net: key(v.net) } : v)),
    ...(Object.keys(widths).length ? { rules: { ...after.rules, netWidths: Object.fromEntries(Object.entries(widths).map(([k, v]) => [key(k), v])) } } : {}),
  }
}
