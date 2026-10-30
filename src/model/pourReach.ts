import type { PcbAnalysis } from "./pcb"
import { zoneClearance } from "./rules"
import type { Project } from "./types"
import { zoneLayers, zoneSettings } from "./zones"

// Pads a pour leaves out. A pour's fill keeps its pads' own scraps (a pad and the stubs of its spokes) even when nothing joins them
// to the rest, so "the fill touches the pad" says nothing: a pad is reached when its fill joins it to another pad of the net. An
// assistant poured a 10 A board at a 2.5 mm pour clearance, which was then also its thermal gap: round a 2.6 mm pad that is a
// 7.6 mm ring, wider than the 7 mm strip of copper it sat in, so the spokes reached nothing, the pads were dropped without a word,
// and route_pcb joined them with thin traces.

/** The pads of `net` (as `REF.PAD`) on a layer its pours cover that no fill of them joins to another of its pads, in board order. */
export function padsPourMisses(project: Project, analysis: PcbAnalysis, net: string): string[] {
  const zones = project.zones.filter((z) => z.net === net && !z.keepout && zoneSettings(project, z).connect !== "none")
  const netId = analysis.zoneFills.find((f) => f.netName === net && f.netId)?.netId
  if (!zones.length || !netId) return []
  const ids = new Set(zones.map((z) => z.id))
  const layers = new Set(zones.flatMap(zoneLayers))
  const pads = analysis.items.filter((it) => it.kind === "pad" && it.netId === netId && it.pad.zoneConnect !== "none")
  if (pads.length < 2) return []
  const padsIn = new Map<number, number>()
  for (const it of pads) padsIn.set(analysis.island.get(it.id)!, (padsIn.get(analysis.island.get(it.id)!) ?? 0) + 1)
  const reached = new Set<number>()
  for (const it of analysis.items) {
    if (it.kind !== "zone" || !ids.has(it.zoneId)) continue
    const island = analysis.island.get(it.id)!
    if ((padsIn.get(island) ?? 0) >= 2) reached.add(island)
  }
  const refOf = new Map(project.components.map((c) => [c.id, c.ref]))
  const out: string[] = []
  for (const it of pads) {
    if (it.kind !== "pad" || !it.layers.some((l) => layers.has(l)) || reached.has(analysis.island.get(it.id)!)) continue
    out.push(`${refOf.get(it.pad.componentId) ?? "?"}.${it.pad.padNumber ?? it.pad.pin ?? "?"}`)
  }
  return [...new Set(out)]
}

/** What a tool says of the pads a net's pours leave out, with the gaps that usually cause it; empty when they reach every pad. */
export function pourMissNote(project: Project, analysis: PcbAnalysis, net: string): string {
  const missed = padsPourMisses(project, analysis, net)
  if (!missed.length) return ""
  const zone = project.zones.find((z) => z.net === net && !z.keepout)!
  const set = zoneSettings(project, zone)
  const gap = `a ${set.thermalGap} mm thermal gap${zone.thermalGap === undefined && project.rules.thermalGap === undefined ? " (the pour clearance)" : ""}`
  const shown = missed.length > 8 ? `${missed.slice(0, 8).join(", ")} and ${missed.length - 8} more` : missed.join(", ")
  return ` The ${net} pour does not join ${shown}: no copper of it round them joins them to the rest, at ${gap} and a ${zoneClearance(project, zone.clearance)} mm pour clearance. Narrow thermal_gap with set_design_rules, or clear room round them; route_pcb otherwise joins them with traces.`
}
