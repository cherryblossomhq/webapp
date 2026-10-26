import { round } from "../src/lib/geometry"
import { computeConnectivity } from "../src/model/connectivity"
import { buildCustomPart, customPartId, registerProjectParts } from "../src/model/customParts"
import { pcbPads } from "../src/model/instances"
import { addComponent, createProject, labelPin, resolvePinSpec, updateComponent } from "../src/model/ops"
import { analyzePcb } from "../src/model/pcb"
import type { CustomPartSpec, Project, Rotation } from "../src/model/types"

export interface ChipBoard {
  /** The chip's name. */
  name: string
  /** A footprinter string for the chip's land. */
  footprint: string
  /** Numbered leads, 1 to n. */
  leads: number
  /** An exposed pad, numbered n + 1, on GND. */
  exposedPad?: boolean
  /** Every lead from this one on, counting from 1, that is on GND instead of a signal; none when absent. */
  groundEvery?: number
  /** Leave the corner leads of a four-sided part unconnected: the footprinter draws neighbouring sides' corner pads on top of each other. */
  skipCorners?: boolean
  board: { width: number; height: number }
}

/**
 * A board with one fine-pitch chip whose every signal lead goes to a 0603 resistor of its own,
 * placed by the editor's automatic placement, with a GND pour on both layers. Built from a project
 * part, so it needs no supplier and no library part.
 */
export function chipBoard(c: ChipBoard): Project {
  const pins: CustomPartSpec["pins"] = Array.from({ length: c.leads }, (_, i) => ({ number: String(i + 1), name: `P${i + 1}` }))
  if (c.exposedPad) pins.push({ number: String(c.leads + 1), name: "EP", kind: "ground" })
  const base = { name: c.name, description: `${c.name} test chip`, category: "ICs" as const, refPrefix: "U", footprint: c.footprint, pins, props: {} }
  const spec: CustomPartSpec = { ...base, id: customPartId(base) }
  let p = createProject(c.name)
  p = { ...p, parts: [spec], board: { ...p.board, width: c.board.width, height: c.board.height } }
  registerProjectParts(p)
  buildCustomPart(spec)
  const u = addComponent(p, spec.id, { ref: "U1", sch: { x: 0, y: 0, rot: 0 } })
  p = u.project
  const gnd: string[] = c.exposedPad ? [`U1.${c.leads + 1}`] : []
  let at = 0
  for (let i = 1; i <= c.leads; i++) {
    const side = c.leads / 4
    if (c.skipCorners && ((i - 1) % side === 0 || i % side === 0)) continue
    if (c.groundEvery && i % c.groundEvery === 0) {
      gnd.push(`U1.${i}`)
      continue
    }
    const r = addComponent(p, "resistor", { ref: `R${i}`, sch: { x: 14 + (at % 6) * 4, y: -Math.floor(at / 6) * 4, rot: 0 }, props: { resistance: "10k" } })
    at++
    p = r.project
    p = labelPin(p, resolvePinSpec(p, `U1.${i}`)!, `S${i}`)
    p = labelPin(p, resolvePinSpec(p, `R${i}.1`)!, `S${i}`)
  }
  // A through-hole ground header in a corner: its plated holes join the top and bottom pours, as a
  // real board's connectors do. Without copper on both layers the bottom pour has nothing to hold it.
  p = addComponent(p, "header_1x2", { ref: "J1", sch: { x: 0, y: -30, rot: 0 } }).project
  gnd.push("J1.1", "J1.2")
  for (const spec of gnd) p = labelPin(p, resolvePinSpec(p, spec)!, "GND")
  p = placeAround(p, "U1")
  const header = p.components.find((q) => q.ref === "J1")!
  p = updateComponent(p, header.id, { pcb: { x: p.board.x + p.board.width / 2 - 5, y: p.board.y + p.board.height / 2 - 6, rot: 0, side: "top", placed: true } })
  const zones = (["top", "bottom"] as const).map((layer) => ({ id: `z-${layer}`, net: "GND", layer }))
  return { ...p, zones }
}

/**
 * The chip at the board's centre and each resistor outside the lead it serves, its pin 1 towards the
 * chip, in rows of staggered distance so that a side's resistors don't overlap: how a designer
 * fans a part out by hand. The routing, not the placement, is what the tests are about.
 */
function placeAround(project: Project, chipRef: string): Project {
  const place = (p: Project, ref: string, x: number, y: number, rot: Rotation) => {
    const c = p.components.find((q) => q.ref === ref)!
    return updateComponent(p, c.id, { pcb: { x, y, rot, side: "top", placed: true } })
  }
  let p = place(project, chipRef, project.board.x, project.board.y, 0)
  const chip = p.components.find((c) => c.ref === chipRef)!
  const pads = pcbPads(chip).filter((q) => q.pin && !q.holeDiameter)
  const sides = new Map<string, { pin: string; x: number; y: number }[]>()
  for (const q of pads) {
    const dx = q.x - chip.pcb.x
    const dy = q.y - chip.pcb.y
    const side = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? "right" : "left") : dy > 0 ? "bottom" : "top"
    sides.set(side, [...(sides.get(side) ?? []), { pin: q.pin!, x: q.x, y: q.y }])
  }
  const ROT: Record<string, Rotation> = { right: 0, left: 180, bottom: 90, top: 270 }
  for (const [side, list] of sides) {
    const horizontal = side === "left" || side === "right"
    list.sort((a, b) => (horizontal ? a.y - b.y : a.x - b.x))
    const resistors = list.filter((l) => p.components.some((c) => c.ref === `R${l.pin}`))
    const rows = 3
    const perRow = Math.ceil(resistors.length / rows)
    const sign = side === "right" || side === "bottom" ? 1 : -1
    resistors.forEach((l, i) => {
      const row = i % rows
      const col = Math.floor(i / rows)
      const lateral = (col - (perRow - 1) / 2) * 2.4 + (row % 2) * 1.2
      const dist = 6 + row * 3
      const cx = horizontal ? chip.pcb.x + sign * (Math.abs(l.x - chip.pcb.x) + dist) : chip.pcb.x + lateral
      const cy = horizontal ? chip.pcb.y + lateral : chip.pcb.y + sign * (Math.abs(l.y - chip.pcb.y) + dist)
      p = place(p, `R${l.pin}`, round(cx, 2), round(cy, 2), ROT[side])
    })
  }
  return p
}

export const analysis = (p: Project) => analyzePcb(p, computeConnectivity(p))
export const drcErrors = (p: Project) => analysis(p).violations.filter((v) => v.severity === "error")
export const unrouted = (p: Project) => analysis(p).violations.filter((v) => v.kind === "unrouted")
