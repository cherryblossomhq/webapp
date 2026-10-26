import { readFileSync } from "node:fs"
import { schematicPins } from "../src/model/instances"
import { addComponent } from "../src/model/ops"
import type { Project, Rotation } from "../src/model/types"
import { Session, U1_PART, U2_PART } from "./sakura-session"

// The owner's exported schematic (untitled-project.circuit.json) taken back into an editor project
// exactly as drawn: each part at the spot and turn that puts its pins where the export has them,
// every wire as drawn, every net label and power port as a label at its point (a port joins by
// name, as a label does).

type El = Record<string, any>

const PART_OF: Record<string, [string, Record<string, string>?]> = {
  U1: [U1_PART], U2: [U2_PART], U3: ["ap2112k_3v3"], J1: ["usb_c"], SW1: ["pushbutton_smd"], SW2: ["pushbutton_smd"], D1: ["led", { color: "green" }],
  R1: ["resistor", { resistance: "5.1k" }], R2: ["resistor", { resistance: "5.1k" }], R3: ["resistor", { resistance: "10k" }], R4: ["resistor", { resistance: "10k" }],
  R5: ["resistor", { resistance: "4.7k" }], R6: ["resistor", { resistance: "4.7k" }], R7: ["resistor", { resistance: "1k" }],
  C1: ["capacitor", { capacitance: "10uF" }], C2: ["capacitor", { capacitance: "10uF" }], C3: ["capacitor", { capacitance: "100nF" }], C4: ["capacitor", { capacitance: "100nF" }], C5: ["capacitor", { capacitance: "1uF" }],
}

const ROT: Record<string, Rotation> = { left: 0, bottom: 90, right: 180, top: 270 }

export function projectFromExport(path: string): Project {
  const els = JSON.parse(readFileSync(path, "utf8")) as El[]
  const s = new Session()
  let p = s.project
  const comps = els.filter((e) => e.type === "source_component")
  const ports = els.filter((e) => e.type === "source_port")
  const schPort = new Map(els.filter((e) => e.type === "schematic_port").map((e) => [e.source_port_id, e]))
  for (const sc of comps) {
    const [partId, props] = PART_OF[sc.name]
    // Where each pin is in the export, by pin number (pin hints carry the number first).
    const want = new Map<string, { x: number; y: number }>()
    for (const sp of ports.filter((x) => x.source_component_id === sc.source_component_id)) {
      const number = String(sp.pin_number ?? sp.port_hints?.[0])
      const at = schPort.get(sp.source_port_id)?.center
      if (at) want.set(number, at)
    }
    let placed = false
    for (const rot of [0, 90, 180, 270] as Rotation[]) {
      const probe = addComponent(p, partId, { ref: sc.name, props, sch: { x: 0, y: 0, rot } }).component
      const pins = schematicPins(probe)
      const first = pins.find((q) => want.has(q.pin))!
      const at = want.get(first.pin)!
      const dx = Math.round((at.x - first.pos.x) * 10) / 10
      const dy = Math.round((at.y - first.pos.y) * 10) / 10
      const ok = pins.every((q) => !want.has(q.pin) || (Math.abs(q.pos.x + dx - want.get(q.pin)!.x) < 1e-6 && Math.abs(q.pos.y + dy - want.get(q.pin)!.y) < 1e-6))
      if (!ok) continue
      p = addComponent(p, partId, { ref: sc.name, props, sch: { x: dx, y: dy, rot } }).project
      placed = true
      break
    }
    if (!placed) throw new Error(`no turn of ${sc.name} puts its pins where the export has them`)
  }
  let w = 0
  let l = 0
  const wires = els.filter((e) => e.type === "schematic_trace").map((e) => ({ id: `xw${w++}`, points: [e.edges[0].from, ...e.edges.map((x: El) => x.to)].map((q: El) => ({ x: q.x, y: q.y })) }))
  const labels = els.filter((e) => e.type === "schematic_net_label").map((e) => ({ id: `xl${l++}`, name: e.text, x: e.anchor_position.x, y: e.anchor_position.y, rot: ROT[e.anchor_side] ?? 0, port: !!e.symbol_name }))
  return { ...p, wires, labels: labels.map(({ port: _port, ...x }) => x) }
}

/** The labels that were power ports in the export, by id. */
export function exportedPorts(path: string): Set<string> {
  const els = JSON.parse(readFileSync(path, "utf8")) as El[]
  const ids = new Set<string>()
  els.filter((e) => e.type === "schematic_net_label").forEach((e, i) => e.symbol_name && ids.add(`xl${i}`))
  return ids
}
