import { areaTouches, hasPolygon, zoneArea, zoneLayers } from "./zones"
import { hasCourtyard, pcbCourtyard, pcbCourtyardRing } from "./instances"
import { trackPoints } from "./arcTracks"
import type { CopperItem, DrcViolation } from "./pcb"
import type { Project, Vec2 } from "./types"

// What a rule area (keepout) forbids, checked: a track, via, pad or part inside an area that keeps it out is an error where it stands.

const boxRing = (b: { minX: number; minY: number; maxX: number; maxY: number }): Vec2[] => [
  { x: b.minX, y: b.minY },
  { x: b.maxX, y: b.minY },
  { x: b.maxX, y: b.maxY },
  { x: b.minX, y: b.maxY },
]

export function keepoutViolations(project: Project, items: CopperItem[]): Omit<DrcViolation, "id">[] {
  const areas = project.zones.filter((z) => z.keepout && hasPolygon(z) && (z.keepout.tracks || z.keepout.vias || z.keepout.pads || z.keepout.footprints))
  if (!areas.length) return []
  const out: Omit<DrcViolation, "id">[] = []
  const refOf = new Map(project.components.map((c) => [c.id, c.ref]))
  const seen = new Set<string>()
  const say = (zoneId: string, key: string, message: string, at: Vec2, items: string[] = []) => {
    const k = `${zoneId}:${key}`
    if (seen.has(k)) return
    seen.add(k)
    out.push({ severity: "error", kind: "keepout", message, at, items: [...items, `z:${zoneId}`] })
  }
  for (const z of areas) {
    const area = zoneArea(z)!
    const layers = zoneLayers(z)
    const name = z.name ? `the keepout ${z.name}` : "a keepout"
    for (const it of items) {
      if (it.kind === "segment" && z.keepout!.tracks && it.layers.some((l) => layers.includes(l)) && areaTouches(area, trackPoints(it), it.width / 2)) {
        say(z.id, `t:${it.traceId}`, `A trace is inside ${name} that keeps tracks out`, { x: (it.a.x + it.b.x) / 2, y: (it.a.y + it.b.y) / 2 })
      } else if (it.kind === "via" && z.keepout!.vias && areaTouches(area, [it.at], it.diameter / 2)) {
        say(z.id, `v:${it.viaId}`, `A via is inside ${name} that keeps vias out`, it.at)
      } else if (it.kind === "pad" && z.keepout!.pads && it.layers.some((l) => layers.includes(l)) && it.pad.componentId !== "#board" && it.pad.componentId !== z.part) {
        // A part's own keepout keeps out other parts' pads, never its own (the same `intersectsArea` rule as for parts, below).
        const pts = it.pad.points?.length ? it.pad.points : boxRing(it.box)
        if (areaTouches(area, pts, 0, true)) say(z.id, `p:${it.id}`, `${refOf.get(it.pad.componentId) ?? "A part"}.${it.pad.padNumber ?? it.pad.pin ?? "pad"} is inside ${name} that keeps pads out`, { x: it.pad.x, y: it.pad.y }, [it.id.split("@")[0]])
      }
    }
    if (z.keepout!.footprints) {
      for (const c of project.components) {
        // The part a keepout belongs to is not kept out of its own keepout (KiCad's `intersectsArea` skips the area's parent, pcbexpr_functions.cpp).
        if (!c.pcb.placed || !hasCourtyard(c) || !layers.includes(c.pcb.side) || z.part === c.id) continue
        const ring = pcbCourtyardRing(c) ?? (pcbCourtyard(c) ? boxRing(pcbCourtyard(c)!) : null)
        if (ring && areaTouches(area, ring, 0, true)) say(z.id, `f:${c.id}`, `${c.ref} is inside ${name} that keeps parts out`, { x: c.pcb.x, y: c.pcb.y }, [`c:${c.id}`])
      }
    }
  }
  return out
}
