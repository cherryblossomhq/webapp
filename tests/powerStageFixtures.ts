import { runTool } from "../src/ai/tools"
import { createProject } from "../src/model/ops"
import type { Project } from "../src/model/types"

/** Run a tool and return the project it made; a failed call is a failed test setup. */
export function step(p: Project, tool: string, input: object): Project {
  const out = runTool(p, tool, input)
  if (out.isError) throw new Error(`${tool} failed: ${out.result}`)
  return out.project
}

function makePart(p: Project, spec: object): { project: Project; id: string } {
  const out = runTool(p, "create_part", spec)
  if (out.isError) throw new Error(out.result)
  return { project: out.project, id: out.result.match(/part_id "([^"]+)"/)![1] }
}

/** A TPS563200-style 3 A synchronous buck in SOT-23-6: GND, SW, VIN, VFB, EN, VBST. */
const BUCK = {
  name: "TPS563200",
  description: "3 A synchronous step-down converter, SOT-23-6",
  category: "Power",
  footprint: "sot23_6",
  pins: [
    { number: "1", name: "GND", kind: "ground" },
    { number: "2", name: "SW", kind: "output" },
    { number: "3", name: "VIN", kind: "power" },
    { number: "4", name: "VFB", kind: "input" },
    { number: "5", name: "EN", kind: "input" },
    { number: "6", name: "VBST", kind: "passive" },
  ],
}

/** A TPS61023-style boost converter: SW, GND, EN, FB, VOUT, VIN. */
const BOOST = {
  name: "TPS61023",
  description: "3.7 A boost converter, 6-pin",
  category: "Power",
  footprint: "sot23_6",
  pins: [
    { number: "1", name: "SW", kind: "output" },
    { number: "2", name: "GND", kind: "ground" },
    { number: "3", name: "EN", kind: "input" },
    { number: "4", name: "FB", kind: "input" },
    { number: "5", name: "VOUT", kind: "output" },
    { number: "6", name: "VIN", kind: "power" },
  ],
}

const cap = (p: Project, value: string, footprint: string) => step(p, "add_component", { part_id: "capacitor", props: { capacitance: value }, footprint })

/**
 * A buck converter schematic, not yet on the PCB: U1 with input capacitors C1 (10 uF) and C2
 * (100 nF) on VIN, the inductor L1 on SW, a bootstrap capacitor C3 on VBST and SW, output
 * capacitors C4 (22 uF) and C5 (22 uF) on VOUT, and the feedback divider R1 (top) and R2.
 */
export function buckDesign(): Project {
  const made = makePart({ ...createProject("buck"), board: { ...createProject("b").board, width: 40, height: 30 } }, BUCK)
  let p = step(made.project, "add_component", { part_id: made.id, x: 0, y: 0 })
  p = cap(p, "10uF", "0805")
  p = cap(p, "100nF", "0402")
  p = step(p, "add_component", { part_id: "inductor", props: { inductance: "2.2uH" }, footprint: "1206" })
  p = cap(p, "100nF", "0402")
  p = cap(p, "22uF", "0805")
  p = cap(p, "22uF", "0805")
  p = step(p, "add_component", { part_id: "resistor", props: { resistance: "100k" }, footprint: "0603" })
  p = step(p, "add_component", { part_id: "resistor", props: { resistance: "22k" }, footprint: "0603" })
  const nets: [string, string[]][] = [
    ["VIN", ["U1.VIN", "U1.EN", "C1.1", "C2.1"]],
    ["GND", ["U1.GND", "C1.2", "C2.2", "C4.2", "C5.2", "R2.2"]],
    ["SW", ["U1.SW", "L1.1", "C3.2"]],
    ["BST", ["U1.VBST", "C3.1"]],
    ["VOUT", ["L1.2", "C4.1", "C5.1", "R1.1"]],
    ["FB", ["U1.VFB", "R1.2", "R2.1"]],
  ]
  for (const [net_name, pins] of nets) p = step(p, "connect", { pins, net_name })
  return p
}

/** A boost converter: L1 from VIN to SW, input capacitor C1, output capacitors C2 and C3 on VOUT, divider R1 and R2. */
export function boostDesign(): Project {
  const made = makePart({ ...createProject("boost"), board: { ...createProject("b").board, width: 40, height: 30 } }, BOOST)
  let p = step(made.project, "add_component", { part_id: made.id, x: 0, y: 0 })
  p = cap(p, "10uF", "0805")
  p = cap(p, "22uF", "0805")
  p = cap(p, "100nF", "0402")
  p = step(p, "add_component", { part_id: "inductor", props: { inductance: "1uH" }, footprint: "1206" })
  p = step(p, "add_component", { part_id: "resistor", props: { resistance: "560k" }, footprint: "0603" })
  p = step(p, "add_component", { part_id: "resistor", props: { resistance: "100k" }, footprint: "0603" })
  const nets: [string, string[]][] = [
    ["VIN", ["U1.VIN", "U1.EN", "C1.1", "L1.1"]],
    ["GND", ["U1.GND", "C1.2", "C2.2", "C3.2", "R2.2"]],
    ["SW", ["U1.SW", "L1.2"]],
    ["VOUT", ["U1.VOUT", "C2.1", "C3.1", "R1.1"]],
    ["FB", ["U1.FB", "R1.2", "R2.1"]],
  ]
  for (const [net_name, pins] of nets) p = step(p, "connect", { pins, net_name })
  return p
}

/** An LDO with a bulk input capacitor and a bulk output capacitor beside the usual 100 nF ones. */
export function ldoDesign(): Project {
  let p = { ...createProject("ldo"), board: { ...createProject("b").board, width: 40, height: 30 } }
  p = step(p, "add_component", { part_id: "ams1117_3v3", x: 0, y: 0 })
  p = cap(p, "10uF", "0805")
  p = cap(p, "100nF", "0402")
  p = cap(p, "22uF", "0805")
  p = cap(p, "100nF", "0402")
  const nets: [string, string[]][] = [
    ["VIN", ["U1.VIN", "C1.1", "C2.1"]],
    ["GND", ["U1.GND", "C1.2", "C2.2", "C3.2", "C4.2"]],
    ["3V3", ["U1.VOUT", "C3.1", "C4.1"]],
  ]
  for (const [net_name, pins] of nets) p = step(p, "connect", { pins, net_name })
  return p
}

/**
 * An AMS1117 (U1) whose 3V3 output feeds an ESP32-WROOM (U2), built without coordinates as Sakura builds
 * designs, so parts stand in a row in creation order: C1 (10 uF) on VIN, C2 (22 uF) and C3 (10 uF) on 3V3.
 * `capsFirst` adds the capacitors before the ESP32 instead of after it.
 */
export function ldoFeedsMcuDesign(capsFirst: boolean): Project {
  let p = { ...createProject("ldo-mcu"), board: { ...createProject("b").board, width: 50, height: 40 } }
  p = step(p, "add_component", { part_id: "ams1117_3v3" })
  const mcu = (q: Project) => step(q, "add_component", { part_id: "esp32_wroom_32e" })
  const caps = (q: Project) => cap(cap(cap(q, "10uF", "0805"), "22uF", "0805"), "10uF", "0805")
  p = capsFirst ? mcu(caps(p)) : caps(mcu(p))
  const nets: [string, string[]][] = [
    ["VIN", ["U1.VIN", "C1.1"]],
    ["GND", ["U1.GND", "U2.GND", "C1.2", "C2.2", "C3.2"]],
    ["3V3", ["U1.VOUT", "U2.3V3", "C2.1", "C3.1"]],
  ]
  for (const [net_name, pins] of nets) p = step(p, "connect", { pins, net_name })
  return p
}
