import { describe, expect, it } from "vitest"
import { runTool, type ToolOutcome } from "../src/ai/tools"
import { computeConnectivity } from "../src/model/connectivity"
import { schematicBounds } from "../src/model/instances"
import { addComponent, addLabel, addWire, createProject, labelPin, resolvePinSpec } from "../src/model/ops"
import { boxesOverlap } from "../src/lib/geometry"
import type { Project } from "../src/model/types"

const add = (p: Project, part_id: string, extra: Record<string, unknown> = {}) => {
  const out = runTool(p, "add_component", { part_id, ...extra })
  expect(out.isError, out.result).toBe(false)
  return out.project
}
const connect = (p: Project, pins: string[], net_name?: string): ToolOutcome =>
  runTool(p, "connect", net_name ? { pins, net_name } : { pins })

/** Net name -> pins, as the model reads it. */
function nets(p: Project) {
  const out = runTool(p, "get_design", {})
  const d = JSON.parse(out.result) as { nets: { name: string; pins: string[] }[] }
  return d.nets
}
const refPin = (p: Project, spec: string) => {
  const pin = resolvePinSpec(p, spec)!
  return `${pin.componentId}:${pin.pin}`
}
const sameNet = (p: Project, a: string, b: string) => {
  const conn = computeConnectivity(p)
  const na = conn.pinNet.get(refPin(p, a))
  return !!na && na === conn.pinNet.get(refPin(p, b))
}
const noOverlap = (p: Project) => {
  for (let i = 0; i < p.components.length; i++)
    for (let j = i + 1; j < p.components.length; j++)
      expect(boxesOverlap(schematicBounds(p.components[i]), schematicBounds(p.components[j])), `${p.components[i].ref} overlaps ${p.components[j].ref}`).toBe(false)
}

/** Parts that used to land on each other: two regulators, an ESP32 module and caps, with no x/y on any of them. */
const ORDERS = {
  "regulators, module, caps": ["ams1117_3v3", "ams1117_3v3", "esp32_wroom_32e", "capacitor", "capacitor", "capacitor"],
  "module first": ["esp32_wroom_32e", "ams1117_3v3", "capacitor", "ams1117_3v3", "capacitor", "capacitor"],
  "caps first": ["capacitor", "capacitor", "capacitor", "esp32_wroom_32e", "ams1117_3v3", "ams1117_3v3"],
}
const refsOf = (p: Project, part: string) => p.components.filter((c) => c.partId === part).map((c) => c.ref)

describe("parts added without x/y", () => {
  for (const [label, order] of Object.entries(ORDERS)) {
    it(`do not overlap, and keep VIN and 3V3 apart (${label})`, () => {
      let p = createProject("t")
      for (const part of order) p = add(p, part)
      noOverlap(p)

      const [r1, r2] = refsOf(p, "ams1117_3v3")
      const [esp] = refsOf(p, "esp32_wroom_32e")
      const [c1, c2, c3] = refsOf(p, "capacitor")
      const steps: [string[], string][] = [
        [[`${r1}.VIN`, `${r2}.VIN`, `${c1}.1`], "VIN"],
        [[`${r1}.VOUT`, `${esp}.3V3`, `${c2}.1`], "3V3"],
        [[`${r1}.GND`, `${r2}.GND`, `${esp}.GND`, `${c1}.2`, `${c2}.2`, `${c3}.2`], "GND"],
      ]
      for (const [pins, name] of steps) {
        const out = connect(p, pins, name)
        expect(out.isError, out.result).toBe(false)
        expect(out.result).not.toMatch(/merged/)
        p = out.project
      }
      expect(computeConnectivity(p).conflicts).toEqual([])
      const byName = Object.fromEntries(nets(p).map((n) => [n.name, n.pins]))
      expect(byName.VIN.sort()).toEqual([`${c1}.1`, `${r1}.3`, `${r2}.3`].sort())
      expect(byName["3V3"].sort()).toEqual([`${c2}.1`, `${esp}.2`, `${r1}.2`].sort())
      expect(runTool(p, "run_checks", {}).result).not.toMatch(/net-conflict|Net names merged/)
    })

    it(`keep auto-named nets apart too (${label})`, () => {
      let p = createProject("t")
      for (const part of order) p = add(p, part)
      const [r1, r2] = refsOf(p, "ams1117_3v3")
      const [esp] = refsOf(p, "esp32_wroom_32e")
      const [c1, c2] = refsOf(p, "capacitor")
      for (const pins of [[`${r1}.VIN`, `${r2}.VIN`, `${c1}.1`], [`${r1}.VOUT`, `${esp}.3V3`, `${c2}.1`], [`${r2}.VOUT`, `${c2}.2`]]) {
        const out = connect(p, pins)
        expect(out.isError, out.result).toBe(false)
        p = out.project
      }
      expect(sameNet(p, `${r1}.VIN`, `${c1}.1`)).toBe(true)
      expect(sameNet(p, `${r1}.VOUT`, `${esp}.3V3`)).toBe(true)
      expect(sameNet(p, `${r2}.VOUT`, `${c2}.2`)).toBe(true)
      expect(sameNet(p, `${r1}.VIN`, `${r1}.VOUT`)).toBe(false)
      expect(sameNet(p, `${r1}.VIN`, `${r2}.VOUT`)).toBe(false)
      expect(sameNet(p, `${r1}.VOUT`, `${r2}.VOUT`)).toBe(false)
    })
  }

  it("leave a wide part's left edge clear of the part before it, not just its origin", () => {
    let p = createProject("t")
    p = add(p, "ams1117_3v3")
    p = add(p, "esp32_wroom_32e")
    const [a, b] = p.components.map((c) => schematicBounds(c))
    expect(b.minX - a.maxX).toBeGreaterThanOrEqual(1)
  })

  it("leave room past the label flags that are already drawn", () => {
    let p = createProject("t")
    p = add(p, "ams1117_3v3")
    p = connect(p, ["U1.VOUT"], "A_VERY_LONG_NET_NAME_FOR_A_RAIL").project
    p = add(p, "ams1117_3v3")
    const flagEnd = Math.max(...p.labels.map((l) => l.x + l.name.length * 0.08 + 0.16))
    expect(schematicBounds(p.components[1]).minX).toBeGreaterThan(flagEnd)
  })
})

describe("connect never joins nets it was not asked to", () => {
  it("labels a hop instead of drawing a wire across the parts between", () => {
    // Four resistors in a row, 1.5 apart: a straight wire from R1 to R3 runs along R2's pins, and
    // the next wire from R2 to R4 then starts on it, which merged both nets without a word.
    let p = createProject("t")
    for (let i = 0; i < 4; i++) p = add(p, "resistor", { x: i * 1.5, y: 0 })
    let out = connect(p, ["R1.2", "R3.1"])
    expect(out.isError, out.result).toBe(false)
    expect(out.result).toMatch(/drawn wire was not used/)
    p = out.project
    out = connect(p, ["R2.2", "R4.1"])
    expect(out.isError, out.result).toBe(false)
    p = out.project
    expect(sameNet(p, "R1.2", "R3.1")).toBe(true)
    expect(sameNet(p, "R2.2", "R4.1")).toBe(true)
    expect(sameNet(p, "R1.2", "R2.2")).toBe(false)
    expect(sameNet(p, "R2.1", "R2.2")).toBe(false)
    expect(sameNet(p, "R3.2", "R3.1")).toBe(false)
  })

  it("refuses a part that lands on another part's pins", () => {
    let p = createProject("t")
    p = add(p, "resistor", { x: 0, y: 0 })
    const out = runTool(p, "add_component", { part_id: "resistor", x: 0.6, y: 0 })
    expect(out.isError).toBe(true)
    expect(out.result).toContain("R1.2")
    expect(out.result).toContain("R2.1")
    expect(out.project).toBe(p)
  })

  it("adds a part on the same spot as another without touching its pins, with a note", () => {
    let p = createProject("t")
    p = add(p, "ams1117_3v3", { x: 0, y: 0 })
    const out = runTool(p, "add_component", { part_id: "capacitor", x: 0, y: -0.2 })
    expect(out.isError, out.result).toBe(false)
    expect(out.result).toMatch(/overlaps U1/)
  })

  it("puts power ports on their rail without calling it a merge", () => {
    let p = createProject("t")
    p = add(p, "ams1117_3v3")
    p = connect(p, ["U1.VOUT"], "3V3").project
    const out = runTool(p, "add_component", { part_id: "power", props: { net: "3V3" }, x: 20, y: 0 })
    expect(out.isError, out.result).toBe(false)
  })

  it("keeps VIN and 3V3 apart when the parts were placed 1.6 apart by hand", () => {
    let p = createProject("t")
    p = add(p, "ams1117_3v3", { x: 0, y: 0 })
    p = add(p, "ams1117_3v3", { x: 1.6, y: 0 })
    p = add(p, "esp32_wroom_32e", { x: 3.2, y: 0 })
    for (const [pins, name] of [
      [["U1.VIN", "U2.VIN"], "VIN"],
      [["U1.VOUT", "U3.3V3"], "3V3"],
    ] as const) {
      const out = connect(p, [...pins], name)
      if (!out.isError) p = out.project
      else expect(out.project).toBe(p)
    }
    expect(computeConnectivity(p).conflicts).toEqual([])
    expect(sameNet(p, "U1.VIN", "U1.VOUT")).toBe(false)
    expect(sameNet(p, "U2.VIN", "U1.VOUT")).toBe(false)
  })

  it("refuses to short two named nets and says which pins", () => {
    let p = createProject("t")
    p = add(p, "ams1117_3v3")
    p = add(p, "ams1117_3v3")
    p = connect(p, ["U1.VIN", "U2.VIN"], "VIN").project
    p = connect(p, ["U1.VOUT", "U2.VOUT"], "3V3").project
    const out = connect(p, ["U1.VIN", "U1.VOUT"])
    expect(out.isError).toBe(true)
    expect(out.project).toBe(p)
    expect(out.result).toContain("3V3 and VIN")
    expect(out.result).toContain("U2.VIN")

    const named = connect(p, ["U1.VIN", "U1.GND"], "3V3")
    expect(named.isError).toBe(true)
    expect(named.project).toBe(p)
    expect(named.result).toContain("U1.VIN")
  })

  it("still names a net after the pins' own net and joins nets the caller listed", () => {
    let p = createProject("t")
    p = add(p, "resistor")
    p = add(p, "resistor")
    p = add(p, "resistor")
    p = connect(p, ["R1.2", "R2.1"]).project
    const out = connect(p, ["R2.1", "R3.1"], "MID")
    expect(out.isError, out.result).toBe(false)
    expect(sameNet(out.project, "R1.2", "R3.1")).toBe(true)
  })
})

describe("how the schematic reads wires", () => {
  it("does not connect a wire that only passes over a pin; a wire end or label on a wire does connect", () => {
    let p = createProject("t")
    p = add(p, "resistor", { x: 0, y: 0 })
    // R1.2 sits at (0.3, 0), and this wire runs straight through it.
    p = addWire(p, [{ x: 0.3, y: -1 }, { x: 0.3, y: 1 }]).project
    expect(computeConnectivity(p).pinNet.get(refPin(p, "R1.2"))).toBeUndefined()
    // A label on that wire joins it, and a wire that ends on its middle does too.
    p = addLabel(p, "A", { x: 0.3, y: 0.5 }).project
    p = addWire(p, [{ x: 0.3, y: -0.5 }, { x: 0.9, y: -0.5 }]).project
    const conn = computeConnectivity(p)
    expect(new Set(conn.wireNet.values()).size).toBe(1)
    expect(conn.labelNet.size).toBe(1)
  })

  it("flags two names that end up on one net in the checks", () => {
    // The geometry Sakura used to build: two parts 1.6 apart whose label stubs share a line.
    let p = createProject("t")
    p = addComponent(p, "ams1117_3v3", { sch: { x: 0, y: 0, rot: 0 } }).project
    p = addComponent(p, "ams1117_3v3", { sch: { x: 1.6, y: 0, rot: 0 } }).project
    p = labelPin(p, { componentId: p.components[0].id, pin: "2" }, "3V3")
    p = labelPin(p, { componentId: p.components[1].id, pin: "3" }, "VIN")
    const conn = computeConnectivity(p)
    expect(conn.conflicts.map((c) => c.names)).toEqual([["3V3", "VIN"]])
    const out = runTool(p, "run_checks", {})
    expect(out.result).toContain("Net names merged: 3V3, VIN")
  })
})
