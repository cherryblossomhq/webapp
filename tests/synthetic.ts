import { addComponent, createProject, labelPin, resolvePinSpec } from "../src/model/ops"
import type { Project } from "../src/model/types"

/**
 * A board with `copies` identical little circuits on a shared ground: an ATmega328P with two
 * decoupling capacitors, a pull-up, a current resistor and an LED, six parts each, all unplaced.
 * `synthetic(77)` is 462 parts, the size of a crowded real board.
 */
export function synthetic(copies: number): Project {
  let p = createProject("synthetic")
  p = { ...p, board: { ...p.board, width: 260, height: 260 } }
  const columns = 10
  for (let i = 0; i < copies; i++) {
    const ox = (i % columns) * 14
    const oy = Math.floor(i / columns) * 12
    const add = (partId: string, x: number, y: number, props?: Record<string, string>) => {
      const res = addComponent(p, partId, { sch: { x: ox + x, y: oy + y, rot: 0 }, props })
      p = res.project
      return res.component.ref
    }
    const u = add("atmega328p", 0, 0)
    const c1 = add("capacitor", 4, 3, { capacitance: "100nF" })
    const c2 = add("capacitor", 6, 3, { capacitance: "100nF" })
    const r1 = add("resistor", 8, 0)
    const r2 = add("resistor", 8, 2)
    const d = add("led", 10, 0)
    const net = (name: string, ...pins: string[]) => {
      for (const spec of pins) p = labelPin(p, resolvePinSpec(p, spec)!, name)
    }
    net(`5V${i}`, `${u}.4`, `${u}.6`, `${u}.18`, `${c1}.1`, `${c2}.1`, `${r1}.1`)
    net("GND", `${u}.3`, `${u}.5`, `${u}.21`, `${c1}.2`, `${c2}.2`, `${d}.K`)
    net(`LED${i}`, `${u}.PB5`, `${r2}.1`, `${d}.A`)
    net(`SIG${i}`, `${r1}.2`, `${r2}.2`)
  }
  return p
}
