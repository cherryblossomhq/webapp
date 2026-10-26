import { describe, expect, it } from "vitest"
import { boxesOverlap, type Box } from "../src/lib/geometry"
import { computeConnectivity } from "../src/model/connectivity"
import { schematicBounds } from "../src/model/instances"
import { labelBox } from "../src/model/labels"
import { analyzePcb } from "../src/model/pcb"
import { EXAMPLES } from "../src/model/examples"
import { TEMPLATES } from "../src/model/templates"
import type { Project } from "../src/model/types"
import { built } from "./built"

/** JSON with one line per part, wire, trace and via, so a regenerated example diffs readably. */
function exampleFile(p: Project): string {
  const fields = Object.entries(p).map(([key, value]) =>
    Array.isArray(value) && value.length
      ? `  ${JSON.stringify(key)}: [\n${value.map((v) => `    ${JSON.stringify(v)}`).join(",\n")}\n  ]`
      : `  ${JSON.stringify(key)}: ${JSON.stringify(value)}`,
  )
  return `{\n${fields.join(",\n")}\n}\n`
}

/** Edges that only touch don't count as overlapping. */
const inset = (b: Box): Box => ({ minX: b.minX + 0.01, minY: b.minY + 0.01, maxX: b.maxX - 0.01, maxY: b.maxY - 0.01 })

describe("templates", () => {
  it.each(TEMPLATES.map((t) => t.id))("%s builds a placed, fully routed design", (id) => {
    const p = built(id)
    const conn = computeConnectivity(p)
    expect(conn.unconnectedPins.filter((pin) => !pin.name.startsWith("PD") && !pin.name.startsWith("PC") && !pin.name.startsWith("PB") && !pin.name.startsWith("ADC") && pin.name !== "AREF")).toEqual([])
    expect(conn.conflicts).toEqual([])
    const pcb = analyzePcb(p, conn)
    expect(pcb.violations.filter((v) => v.kind === "overlap" || v.kind === "outside-board")).toEqual([])
    expect(pcb.violations.filter((v) => v.severity === "error")).toEqual([])
    expect(pcb.ratsnest).toEqual([])
    expect(p.traces.length).toBeGreaterThan(0)
    expect(pcb.zoneFills.every((f) => f.polygons.length > 0)).toBe(true)
    // Every net label is readable: none lies on another label or on a part.
    const boxes = p.labels.map((l) => inset(labelBox(l)))
    boxes.forEach((box, i) => {
      for (let j = i + 1; j < boxes.length; j++) expect(boxesOverlap(box, boxes[j]), `${p.labels[i].name} on ${p.labels[j].name}`).toBe(false)
      for (const c of p.components) expect(boxesOverlap(box, inset(schematicBounds(c))), `${p.labels[i].name} on ${c.ref}`).toBe(false)
    })
  })

  it("wires the 555 blinker timing network", () => {
    const p = built("blinker")
    const conn = computeConnectivity(p)
    const names = conn.nets.map((n) => n.name)
    for (const n of ["VCC", "GND", "DIS", "THR", "CV"]) expect(names).toContain(n)
    const thr = conn.nets.find((n) => n.name === "THR")!
    expect(thr.pins).toHaveLength(4)
  })

  it("routes the ESP32 robot's battery, motor and 5 V nets at their own widths", () => {
    const p = built("esp32-robot")
    const conn = computeConnectivity(p)
    const pcb = analyzePcb(p, conn)
    const widths = (name: string) => {
      const id = conn.nets.find((n) => n.name === name)!.id
      return p.traces.filter((t) => pcb.traceNet.get(t.id) === id).map((t) => t.width)
    }
    for (const n of ["VBAT_IN", "VSW", "VBAT", "MOTA1", "MOTA2", "MOTB1", "MOTB2"]) expect(widths(n)).toContain(1)
    expect(widths("5V")).toContain(0.75)
  })

  it("wires the ESP32 robot controller netlist", () => {
    const p = built("esp32-robot")
    const conn = computeConnectivity(p)
    const size = (name: string) => conn.nets.find((n) => n.name === name)?.pins.length
    // Pin counts per net (power ports excluded).
    expect(size("GND")).toBe(35)
    expect(size("3V3")).toBe(11)
    expect(size("5V")).toBe(11)
    expect(size("VBAT")).toBe(8)
    for (const n of ["QTR1", "QTR2", "S1", "S2", "S3", "S4", "S5", "Button1", "Button2", "Button3", "IBUS_RX"]) expect(size(n)).toBe(3)
    for (const n of ["MOTA1", "MOTA2", "MOTB1", "MOTB2"]) expect(size(n)).toBe(3)
    for (const n of ["MotorA_IN1", "MotorB_IN2", "I2C_SDA", "I2C_SCL", "IBUS_TX", "Encoder1_ChA", "Encoder2_ChB"]) expect(size(n)).toBe(2)
  })

  // The dashboard opens these files rather than routing the templates, which takes seconds.
  it.each(TEMPLATES.map((t) => t.id))("%s ships as built", async (id) => {
    // A new template's file is written here, but the dashboard only has it once examples.ts imports it.
    expect(EXAMPLES.find((e) => e.id === id)?.project, `import examples/${id}.json in examples.ts`).toBeDefined()
    await expect(exampleFile(built(id))).toMatchFileSnapshot(
      `../src/model/examples/${id}.json`,
      "the shipped example is out of date: npm run examples -w @cherryblossom/editor",
    )
  })
})
