import { computeConnectivity } from "../src/model/connectivity"
import { pcbPads } from "../src/model/instances"
import { addComponent, addTrace, createProject, labelPin } from "../src/model/ops"
import { analyzePcb } from "../src/model/pcb"
import { fillTester, type ZoneFill } from "../src/model/pour"
import { makeZone } from "../src/model/zoneOps"
import type { Project, Vec2, Zone } from "../src/model/types"

/** Two resistors on a 40 by 30 board: pin 1 of each is SIG (joined by a trace on top), pin 2 is GND. */
export function twoResistors(extra: Partial<Project["board"]> = {}): Project {
  let p = createProject("Zones")
  p = { ...p, board: { ...p.board, width: 40, height: 30, ...extra } }
  const a = addComponent(p, "resistor", { sch: { x: 0, y: 0 }, pcb: { x: -6, y: 0, placed: true } })
  p = a.project
  const b = addComponent(p, "resistor", { sch: { x: 3, y: 0 }, pcb: { x: 6, y: 0, placed: true } })
  p = b.project
  for (const c of [a.component, b.component]) {
    p = labelPin(p, { componentId: c.id, pin: "1" }, "SIG")
    p = labelPin(p, { componentId: c.id, pin: "2" }, "GND")
  }
  const pad = (id: string, pin: string) => pcbPads(p.components.find((c) => c.id === id)!).find((x) => x.pin === pin)!
  const s1 = pad(a.component.id, "1")
  const s2 = pad(b.component.id, "1")
  p = addTrace(p, { layer: "top", width: 0.25, points: [s1, { x: s1.x, y: 6 }, { x: s2.x, y: 6 }, s2] }).project
  return p
}

export const rectangle = (x0: number, y0: number, x1: number, y1: number): Vec2[] => [
  { x: x0, y: y0 },
  { x: x1, y: y0 },
  { x: x1, y: y1 },
  { x: x0, y: y1 },
]

/** A project with the zone added (the zone's id is kept as given). */
export function withZone(p: Project, points: Vec2[], opts: Parameters<typeof makeZone>[1] & Partial<Zone> = {}, id = "z1"): Project {
  const { net, layers, priority, clearance, name, keepout, ...rest } = opts
  const z = makeZone(points, { net, layers, priority, clearance, name, keepout })!
  return { ...p, zones: [...p.zones, { ...z, ...rest, id }] }
}

export const analyze = (p: Project, keepIslands = false) => analyzePcb(p, computeConnectivity(p), { keepIslands })

export function fillOf(p: Project, id = "z1", layer: "top" | "bottom" = "top"): ZoneFill {
  return analyze(p).zoneFills.find((f) => f.zoneId === id && f.layer === layer)!
}

/** Whether a point of the board is copper of the fill. */
export const filled = (f: ZoneFill, at: Vec2) => f.polygons.some((poly) => fillTester(poly)(at))

/** The area of a fill (mm²), holes taken out. */
export function fillArea(f: ZoneFill): number {
  const ring = (r: Vec2[]) => Math.abs(r.reduce((a, q, i) => a + (r[(i + r.length - 1) % r.length].x * q.y - q.x * r[(i + r.length - 1) % r.length].y), 0) / 2)
  return f.polygons.reduce((s, poly) => s + poly.reduce((a, r, i) => a + (i === 0 ? 1 : -1) * ring(r), 0), 0)
}
