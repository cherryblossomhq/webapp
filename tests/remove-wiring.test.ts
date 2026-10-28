import { describe, expect, it } from "vitest"
import { runTool } from "../src/ai/tools"
import { pinKey } from "../src/model/connectivity"
import { EXAMPLES } from "../src/model/examples"
import { addLabel, addWire, createProject } from "../src/model/ops"
import type { Project } from "../src/model/types"
import { getConnectivity } from "../src/store/analysis"

// `remove_wiring`: taking pins off their nets, and deleting the drawing that reaches no part (what
// Tidy keeps below the blocks). It only ever deletes, so it may cut pins off a net but never join two.

function must(p: Project, name: string, input: Record<string, unknown>) {
  const out = runTool(p, name, input)
  expect(out.isError, out.result).toBe(false)
  return out
}

/** The pins that share a net with another pin, as "R1.2 R2.1" per net, sorted. */
function nets(p: Project): string[] {
  const d = JSON.parse(runTool(p, "get_design", {}).result) as { nets: { pins: string[] }[] }
  return d.nets.filter((n) => n.pins.length > 1).map((n) => [...n.pins].sort().join(" ")).sort()
}

/** The net get_design gives a pin, or null. */
function netOf(p: Project, ref: string, pin: string): string | null {
  const d = JSON.parse(runTool(p, "get_design", {}).result) as { components: { ref: string; pins?: { pin: string; net: string | null }[] }[] }
  return d.components.find((c) => c.ref === ref)?.pins?.find((x) => x.pin === pin)?.net ?? null
}

function circuit() {
  let p = createProject("t")
  p = must(p, "add_component", { part_id: "resistor", ref: "R1", x: 0, y: 0 }).project
  p = must(p, "add_component", { part_id: "resistor", ref: "R2", x: 4, y: 0 }).project
  p = must(p, "add_component", { part_id: "capacitor", ref: "C1", x: 0, y: 4 }).project
  return p
}

/** Pins that are together after an edit and weren't before: what remove_wiring must never make. */
function joined(before: Project, after: Project): string[] {
  const a = getConnectivity(before).pinNet
  const b = getConnectivity(after).pinNet
  const out: string[] = []
  const byNet = new Map<string, string[]>()
  for (const [key, net] of b) byNet.set(net, [...(byNet.get(net) ?? []), key])
  for (const keys of byNet.values()) for (const k of keys.slice(1)) if (a.get(k) !== a.get(keys[0])) out.push(`${keys[0]} ~ ${k}`)
  return out
}

describe("remove_wiring with pins", () => {
  it("takes a pin off a wire to another pin, and says that pin is cut off too", () => {
    const p = must(circuit(), "connect", { pins: ["R1.2", "R2.1"] }).project
    expect(nets(p)).toContain("R1.2 R2.1")
    const out = must(p, "remove_wiring", { pins: ["R1.2"] })
    expect(nets(out.project)).toEqual([])
    expect(out.project.wires.length + out.project.labels.length).toBe(0)
    expect(out.result).toMatch(/^Deleted .* at R1\.2\. R1\.2 is off \S+\. Also cut off: R2\.1 no longer on /)
    expect(out.summary).toBe("Removed wiring at R1.2")
  })

  it("takes a labelled pin off its net and leaves the other pins of the name on it", () => {
    let p = must(circuit(), "connect", { pins: ["R1.1", "C1.1"], net_name: "VIN" }).project
    expect(nets(p)).toEqual(["C1.1 R1.1"])
    const labels = p.labels.length
    p = must(p, "remove_wiring", { pins: ["R1.1"] }).project
    expect(nets(p)).toEqual([])
    expect(p.labels).toHaveLength(labels - 1)
    expect(netOf(p, "C1", "1")).toBe("VIN")
  })

  it("deletes a port the pin's wire leaves standing on nothing", () => {
    let p = must(circuit(), "add_component", { part_id: "ground", x: 4, y: -3 }).project
    p = must(p, "connect", { pins: ["R2.2", "#GND1"] }).project
    expect(netOf(p, "R2", "2")).toBe("GND")
    const out = must(p, "remove_wiring", { pins: ["R2.2"] })
    expect(out.project.components.map((c) => c.ref)).toEqual(["R1", "R2", "C1"])
    expect(out.result).toMatch(/port/)
    expect(out.project.wires).toHaveLength(0)
  })

  it("says so when nothing is drawn at a pin, and changes nothing", () => {
    const p = circuit()
    const out = must(p, "remove_wiring", { pins: ["R1.1"] })
    expect(out.project).toBe(p)
    expect(out.result).toBe("Nothing is drawn at R1.1. R1.1 was on no net.")
  })

  it("refuses an unknown pin, and a call that says nothing to delete", () => {
    const p = circuit()
    expect(runTool(p, "remove_wiring", { pins: ["R9.1"] }).isError).toBe(true)
    expect(runTool(p, "remove_wiring", {}).result).toMatch(/Say what to delete/)
  })
})

describe("remove_wiring with loose", () => {
  it("deletes the wires, labels and ports that reach no part, and nothing else", () => {
    let p = must(circuit(), "connect", { pins: ["R1.2", "R2.1"] }).project
    const kept = { wires: p.wires.length, labels: p.labels.length }
    p = addWire(p, [{ x: 10, y: 10 }, { x: 12, y: 10 }]).project
    p = addLabel(p, "SDA", { x: 12, y: 10 }).project
    p = must(p, "add_component", { part_id: "ground", x: 20, y: 20 }).project
    const before = nets(p)
    expect(JSON.parse(runTool(p, "get_design", {}).result).loose_wiring).toBe("1 wire, 1 label and 1 port reach no part (remove_wiring loose deletes them)")
    const out = must(p, "remove_wiring", { loose: true })
    expect(JSON.parse(runTool(out.project, "get_design", {}).result).loose_wiring).toBeUndefined()
    expect(out.result).toBe("Deleted 1 wire, 1 label and 1 port that reached no part.")
    expect(out.project.wires).toHaveLength(kept.wires)
    expect(out.project.labels).toHaveLength(kept.labels)
    expect(out.project.components.map((c) => c.ref)).toEqual(["R1", "R2", "C1"])
    expect(nets(out.project)).toEqual(before)
    expect(must(out.project, "remove_wiring", { loose: true }).result).toBe("No wiring on the sheet reaches no part.")
  })

  it("keeps a wire that joins two nets by name, since deleting it would split them", () => {
    let p = must(circuit(), "connect", { pins: ["R1.1"], net_name: "A" }).project
    p = must(p, "connect", { pins: ["R2.2"], net_name: "B" }).project
    p = addWire(p, [{ x: 10, y: 10 }, { x: 12, y: 10 }]).project
    p = addLabel(p, "A", { x: 10, y: 10 }).project
    p = addLabel(p, "B", { x: 12, y: 10 }).project
    p = addLabel(p, "LONE", { x: 30, y: 30 }).project
    expect(nets(p)).toEqual(["R1.1 R2.2"])
    const out = must(p, "remove_wiring", { loose: true })
    expect(nets(out.project)).toEqual(["R1.1 R2.2"])
    expect(out.result).toBe("Deleted 1 label that reached no part. Kept 1 piece that joins two nets by name: deleting it would split those nets.")
  })

  it("takes what a whole-sheet tidy kept below the blocks, as its result suggests", () => {
    let p = must(circuit(), "connect", { pins: ["R1.2", "R2.1"] }).project
    p = must(p, "add_component", { part_id: "ground", x: 20, y: 20 }).project
    p = must(p, "group_parts", { block: "DIVIDER", refs: ["R1", "R2", "C1"] }).project
    const tidied = must(p, "tidy_schematic", { whole_sheet: true })
    expect(tidied.result).toMatch(/Kept 1 port that reaches no part, below the blocks\..*remove_wiring loose/)
    const out = must(tidied.project, "remove_wiring", { loose: true })
    expect(out.result).toBe("Deleted 1 port that reached no part.")
    expect(must(out.project, "tidy_schematic", { whole_sheet: true }).result).not.toMatch(/reach(es)? no part/)
  })
})

describe("remove_wiring on the examples", () => {
  for (const { id, project } of EXAMPLES) {
    it(`${id}: never joins two nets, and loose changes no net`, () => {
      const loose = must(project, "remove_wiring", { loose: true })
      expect(nets(loose.project)).toEqual(nets(project))
      const parts = project.components.filter((c) => !c.ref.startsWith("#")).slice(0, 12)
      for (const c of parts) {
        const pin = getConnectivity(project).pinNet.has(pinKey(c.id, "1")) ? "1" : undefined
        if (!pin) continue
        const out = runTool(project, "remove_wiring", { pins: [`${c.ref}.${pin}`] })
        expect(out.isError, out.result).toBe(false)
        expect(joined(project, out.project), `${c.ref}.${pin}`).toEqual([])
      }
    })
  }
})
