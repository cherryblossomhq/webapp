import { describe, expect, it } from "vitest"
import { runTool } from "../src/ai/tools"
import { computeConnectivity, pinKey } from "../src/model/connectivity"
import { EXAMPLES } from "../src/model/examples"
import { importKicadSchematic } from "../src/model/kicad/schematic"
import { removeItems } from "../src/model/ops"
import { rekeyAutoNets } from "../src/model/rekeyNets"
import type { Project, Zone } from "../src/model/types"
import { LIB_R, schematic } from "./kicad-schematic-fixtures"

// Fix round 2 of slice 3b-ii: a made-up net name is kept, never a trap; board data keyed by it follows every rename.

const uuid = (n: number) => `aaaaaaaa-0000-4000-8000-00000000000${n}`
const example = (id: string) => EXAMPLES.find((e) => e.id === id)!.project
const refId = (p: Project, ref: string) => p.components.find((c) => c.ref === ref)!.id
const netOf = (p: Project, ref: string, pin: string) => {
  const conn = computeConnectivity(p)
  return conn.nets.find((n) => n.id === conn.pinNet.get(pinKey(refId(p, ref), pin)))
}
const noDuplicateIds = (p: Project) => {
  const ids = computeConnectivity(p).nets.map((n) => n.id)
  expect(new Set(ids).size).toBe(ids.length)
}

const chain = (): Project => {
  const r = importKicadSchematic(
    schematic({
      version: 20250114,
      libs: [LIB_R],
      symbols: [
        { lib: "Device:R", at: "50.8 50.8", ref: "R1", value: "1k", uuid: uuid(1) },
        { lib: "Device:R", at: "76.2 50.8", ref: "R2", value: "1k", uuid: uuid(2) },
        { lib: "Device:R", at: "101.6 50.8", ref: "R3", value: "1k", uuid: uuid(3) },
        { lib: "Device:R", at: "127 50.8", ref: "R4", value: "1k", uuid: uuid(4) },
      ],
      wires: ["76.2 54.61 101.6 54.61"],
    }),
  )
  if (r.status !== "imported") throw new Error("refused")
  return r.project
}

describe("connect by a made-up name: the second call finds the net", () => {
  it("esp32-robot: two calls with Net-(J6-2) land on one net, which keeps the name", () => {
    const p = example("esp32-robot")
    const first = runTool(p, "connect", { pins: ["J7.2"], net_name: "Net-(J6-2)" })
    expect(first.isError, first.result).toBeFalsy()
    expect(first.result).toContain("labelled Net-(J6-2)")
    expect(netOf(first.project, "J6", "2")!.name).toBe("Net-(J6-2)")
    expect(netOf(first.project, "J7", "2")!.id).toBe(netOf(first.project, "J6", "2")!.id)
    const second = runTool(first.project, "connect", { pins: ["J8.2"], net_name: "Net-(J6-2)" })
    expect(second.isError, second.result).toBeFalsy()
    expect(netOf(second.project, "J8", "2")!.id).toBe(netOf(second.project, "J6", "2")!.id)
    expect(netOf(second.project, "J6", "2")!.pins.length).toBeGreaterThanOrEqual(6)
    noDuplicateIds(second.project)
  })

  it("an imported design: the label is a global one of that exact text, and the second call joins the same net", () => {
    const p = chain()
    const name = netOf(p, "R2", "2")!.name
    expect(name).toMatch(/^Net-\(/)
    const first = runTool(p, "connect", { pins: ["R1.1"], net_name: name })
    expect(first.isError, first.result).toBeFalsy()
    expect(first.result).toContain("(a global label)")
    expect(first.project.labels.some((l) => l.name === name && l.kind === "global")).toBe(true)
    expect(netOf(first.project, "R2", "2")!.name).toBe(name)
    expect(netOf(first.project, "R1", "1")!.id).toBe(netOf(first.project, "R2", "2")!.id)
    const second = runTool(first.project, "connect", { pins: ["R4.1"], net_name: name })
    expect(second.isError, second.result).toBeFalsy()
    expect(netOf(second.project, "R4", "1")!.id).toBe(netOf(second.project, "R2", "2")!.id)
    noDuplicateIds(second.project)
  })

  it("a made-up name no net has is refused, and nothing changes", () => {
    for (const [p, name] of [
      [example("esp32-robot"), "Net-(R9-Pad9)"],
      [example("esp32-robot"), "unconnected-(R3-Pad1)"],
      [chain(), "Net-(R9-Pad9)"],
      [chain(), "unconnected-(R3-Pad1)"],
    ] as const) {
      const out = runTool(p, "connect", { pins: [p.components.find((c) => !c.ref.startsWith("#"))!.ref + ".1"], net_name: name })
      expect(out.isError, name).toBe(true)
      expect(out.result).toContain(`No net is called ${name} now`)
      expect(out.project).toBe(p)
    }
  })

  it("a name a label gives is still an ordinary name, and says nothing about made-up names", () => {
    const p = example("blinker")
    const out = runTool(p, "connect", { pins: ["R1.1"], net_name: "GND" })
    expect(out.result).not.toContain("made up")
  })

  it("the note is not given when the pin of that net could not be labelled, or the pins were already on it", () => {
    const p = chain()
    const name = netOf(p, "R2", "2")!.name
    const there = runTool(p, "connect", { pins: ["R2.2", "R3.2"], net_name: name })
    expect(there.result).toContain("already on")
    expect(there.result).not.toContain("labelled")
  })
})

describe("board data keyed by a made-up name follows every rename (M3)", () => {
  const keyed = (p: Project, name: string): Project => ({
    ...p,
    zones: [...p.zones, { id: "z-test", net: name, layer: "top" } as Zone],
    rules: { ...p.rules, netWidths: { ...p.rules.netWidths, [name]: 0.5 } },
  })

  it("a Sakura rename of D1 keeps a 0.5 mm width on Net-(D1-1), on every example that has it", () => {
    let seen = 0
    for (const ex of EXAMPLES) {
      const p = ex.project
      const d1 = p.components.find((c) => c.ref === "D1")
      const net = d1 && computeConnectivity(p).nets.find((n) => n.name === "Net-(D1-1)")
      if (!net) continue
      seen++
      const out = runTool(keyed(p, "Net-(D1-1)"), "update_component", { ref: "D1", new_ref: "D9" })
      expect(out.isError, ex.id).toBeFalsy()
      const now = computeConnectivity(out.project).nets.find((n) => n.pins.some((q) => net.pins.some((t) => t.componentId === q.componentId && t.pin === q.pin)))!
      expect(now.name, ex.id).toBe("Net-(D9-1)")
      expect(out.project.rules.netWidths!["Net-(D9-1)"], ex.id).toBe(0.5)
      expect(out.project.rules.netWidths!["Net-(D1-1)"], ex.id).toBeUndefined()
      expect(out.project.zones.find((z) => z.id === "z-test")!.net, ex.id).toBe("Net-(D9-1)")
    }
    expect(seen).toBeGreaterThan(0)
  })

  it("a rename of a part with no board data returns the very same data (no copy of the rules)", () => {
    const p = example("blinker")
    const out = runTool(p, "update_component", { ref: "D1", new_ref: "D9" })
    expect(out.project.rules).toBe(p.rules)
    expect(out.project.zones).toBe(p.zones)
  })

  it("removing a part keeps a width on a net that loses a pin", () => {
    const p = example("blinker")
    const net = computeConnectivity(p).nets.find((n) => n.name === "Net-(D1-1)")!
    const other = net.pins.find((q) => q.componentId !== refId(p, "D1"))!
    // the net names itself by the first pin; take the part away that gives the name and the width follows the remaining pins
    const gone = removeItems(keyed(p, "Net-(D1-1)"), { components: [refId(p, "D1")] })
    const left = computeConnectivity(gone).nets.find((n) => n.pins.some((q) => q.componentId === other.componentId && q.pin === other.pin))
    expect(left).toBeTruthy()
    expect(left!.name).not.toBe("Net-(D1-1)")
    expect(gone.rules.netWidths![left!.name]).toBe(0.5)
    expect(gone.rules.netWidths!["Net-(D1-1)"]).toBeUndefined()
  })

  it("a connect that joins two made-up nets moves the data of the one that lost its name onto the joined net", () => {
    const p = example("esp32-robot")
    const b = netOf(p, "J7", "2")!.name
    const joinedTo = (out: Project) => netOf(out, "J7", "2")!.name
    const withB = keyed(p, b)
    const out = runTool(withB, "connect", { pins: ["J6.2", "J7.2"] })
    expect(out.isError, out.result).toBeFalsy()
    const joined = joinedTo(out.project)
    expect(netOf(out.project, "J6", "2")!.id).toBe(netOf(out.project, "J7", "2")!.id)
    expect(out.project.zones.find((z) => z.id === "z-test")!.net).toBe(joined)
    expect(out.project.rules.netWidths![joined]).toBe(0.5)
  })

  it("connect that renames an auto net by a label name moves the width with it (superset or same pins)", () => {
    const p = example("blinker")
    const out = runTool(keyed(p, "Net-(D1-1)"), "connect", { pins: ["D1.1"], net_name: "LEDA" })
    expect(out.isError, out.result).toBeFalsy()
    expect(netOf(out.project, "D1", "1")!.name).toBe("LEDA")
    expect(out.project.rules.netWidths!.LEDA).toBe(0.5)
    expect(out.project.rules.netWidths!["Net-(D1-1)"]).toBeUndefined()
  })

  it("a design with no name-keyed board data comes back as the very same object", () => {
    const p = example("esp32-robot")
    expect(rekeyAutoNets(p, p)).toBe(p)
    const q = { ...p, rules: { ...p.rules, netWidths: { GND: 0.6 } } }
    expect(rekeyAutoNets(p, q)).toBe(q)
  })
})
