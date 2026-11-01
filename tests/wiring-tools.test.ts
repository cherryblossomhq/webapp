import { readdirSync, readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { runTool, type ToolOutcome } from "../src/ai/tools"
import { WIRING_BUDGET } from "../src/ai/wiringTools"
import { computeConnectivity } from "../src/model/connectivity"
import { EXAMPLES } from "../src/model/examples"
import { powerNetName } from "../src/model/instances"
import { findPart } from "../src/model/library"
import { createProject, resolvePinSpec } from "../src/model/ops"
import { parseProjectFile } from "../src/model/projectFile"
import type { Project } from "../src/model/types"

// get_wiring, draw_wiring and edit_net: the schematic by its coordinates, and nets by their names.

const example = (id: string) => EXAMPLES.find((e) => e.id === id)!.project

/** Every net as its pins by designator, names left out: what a rename or a restyle may never change. */
function groups(p: Project): string[] {
  const conn = computeConnectivity(p)
  const refOf = new Map(p.components.map((c) => [c.id, c.ref]))
  const physical = (id: string) => !findPart(p.components.find((c) => c.id === id)!.partId)?.powerNet
  return conn.nets
    .map((n) => n.pins.filter((x) => physical(x.componentId)).map((x) => `${refOf.get(x.componentId)}.${x.pin}`).sort().join(" "))
    .filter((g) => g.includes(" "))
    .sort()
}

const netOf = (p: Project, spec: string) => {
  const pin = resolvePinSpec(p, spec)!
  const conn = computeConnectivity(p)
  return conn.nets.find((n) => n.id === conn.pinNet.get(`${pin.componentId}:${pin.pin}`))
}
const sameNet = (p: Project, a: string, b: string) => netOf(p, a)?.id === netOf(p, b)?.id
const ok = (out: ToolOutcome) => {
  expect(out.isError, out.result).toBe(false)
  return out.project
}

/** R1 and R2 side by side (pins at x -0.3, 0.3 and 1.7, 2.3 on y 0), R3 upright above the gap between them (pin 1 at (1, 0.7) facing down). */
function three(): Project {
  let p = createProject("t")
  for (const [x, y, rotation] of [[0, 0, 0], [2, 0, 0], [1, 1, 90]] as const) p = ok(runTool(p, "add_component", { part_id: "resistor", x, y, rotation }))
  return p
}

describe("get_wiring", () => {
  it("gives each pin's end, the way it faces and its net, and the wires of a block", () => {
    const p = example("esp32-robot")
    const out = runTool(p, "get_wiring", { block: "POWER" })
    expect(out.isError, out.result).toBe(false)
    const read = JSON.parse(out.result) as { area: object; pins: { pin: string; x: number; y: number; faces: string; net: string | null }[]; wires: { net: string | null; points: number[][] }[]; frames: { block: string }[] }
    expect(read.area).toBeDefined()
    const u3 = read.pins.find((x) => x.pin === "U3.IN")!
    expect(u3).toMatchObject({ faces: "left", net: "VBAT" })
    // The point given is where a wire meets the pin: a wire of its net ends there.
    expect(read.wires.some((w) => w.net === "VBAT" && w.points.some(([x, y]) => x === u3.x && y === u3.y))).toBe(true)
    expect(read.frames.map((f) => f.block)).toContain("POWER")
  })

  it("refuses a block that isn't there", () => {
    expect(runTool(example("blinker"), "get_wiring", { block: "NOPE" }).result).toMatch(/No block NOPE/)
  })

  // Claude Code warns about a tool's output past 10k tokens and cuts it at 25k: a whole sheet grows
  // with the board, so past the budget it answers with the frames, and every block fits.
  const BLOG = readdirSync(new URL("./fixtures/blog-boards/", import.meta.url)).filter((f) => f.endsWith(".json"))
  const boards: [string, Project][] = [
    ...EXAMPLES.map((e): [string, Project] => [e.id, e.project]),
    ...BLOG.map((f): [string, Project] => [f, parseProjectFile(readFileSync(new URL(`./fixtures/blog-boards/${f}`, import.meta.url), "utf8"), { id: f })]),
  ]
  it.each(boards)("keeps every answer for %s within what an assistant is shown", (_, p) => {
    const whole = runTool(p, "get_wiring", {})
    expect(whole.result.length).toBeLessThanOrEqual(WIRING_BUDGET)
    if (whole.empty) {
      const read = JSON.parse(whole.result) as { too_big: string; frames: { block: string }[] }
      expect(read.too_big).toMatch(/Ask again with block/)
      expect(read.frames.length).toBe(p.blocks!.length)
    }
    for (const b of p.blocks ?? []) {
      const one = runTool(p, "get_wiring", { block: b.name })
      expect(one.isError || one.empty, `${b.name}: ${one.result.slice(0, 80)}`).toBeFalsy()
      expect(one.result.length).toBeLessThanOrEqual(WIRING_BUDGET)
    }
  })

  it("answers a whole sheet past the budget with its frames", () => {
    const p = boards.find(([n]) => n === "rp2040-dense-4layer.json")![1]
    const out = runTool(p, "get_wiring", {})
    expect(out.isError).toBe(false)
    expect(out.empty).toBe(true)
    expect(out.result).toMatch(/too many for one answer/)
  })
})

describe("draw_wiring", () => {
  it("joins the pins its ends are on, and a wire ending on a wire's side", () => {
    let p = ok(runTool(three(), "draw_wiring", { wires: [[{ x: 0.3, y: 0 }, { x: 1.7, y: 0 }]] }))
    expect(sameNet(p, "R1.2", "R2.1")).toBe(true)
    const out = runTool(p, "draw_wiring", { wires: [[{ x: 1, y: 0.7 }, { x: 1, y: 0 }]] })
    expect(out.result).toMatch(/R3\.1/)
    p = ok(out)
    expect(sameNet(p, "R3.1", "R1.2")).toBe(true)
  })

  it("puts a label where it is told, which names the net", () => {
    let p = ok(runTool(three(), "draw_wiring", { wires: [[{ x: 0.3, y: 0 }, { x: 1.7, y: 0 }]] }))
    p = ok(runTool(p, "draw_wiring", { wires: [[{ x: 1, y: 0.7 }, { x: 1, y: 0.4 }]], labels: [{ name: "MID", x: 1, y: 0.4, side: "down" }] }))
    expect(netOf(p, "R3.1")!.name).toBe("MID")
    expect(sameNet(p, "R3.1", "R1.2")).toBe(false)
    const label = p.labels.find((l) => l.name === "MID")!
    expect(label.rot).toBe(270)
  })

  it("refuses what it can't draw cleanly, and changes nothing", () => {
    const p = ok(runTool(three(), "draw_wiring", { wires: [[{ x: 0.3, y: 0 }, { x: 1.7, y: 0 }]] }))
    const refused = (input: Record<string, unknown>, why: RegExp) => {
      const out = runTool(p, "draw_wiring", input)
      expect(out.isError, out.result).toBe(true)
      expect(out.result).toMatch(why)
      expect(out.project).toBe(p)
    }
    refused({ wires: [[{ x: 0.3, y: 0 }, { x: 1, y: 0.7 }]] }, /slant/)
    refused({ wires: [[{ x: 0.5, y: 0 }, { x: 1.2, y: 0 }]] }, /run along/)
    refused({ labels: [{ name: "X", x: 5, y: 5 }] }, /on no pin end or wire/)
    // A corner on R3.1 that the call never asked to join, and a wire over R3.1's end.
    refused({ wires: [[{ x: -0.3, y: 0 }, { x: -0.3, y: 0.7 }, { x: 1, y: 0.7 }, { x: 1, y: 1.5 }]] }, /join/)
    refused({ wires: [[{ x: 2.3, y: 0.7 }, { x: 0.5, y: 0.7 }]] }, /under the wire/)
  })

  it("says what each end reached, a wire or label drawn in the same call included", () => {
    const tee = runTool(three(), "draw_wiring", { wires: [[{ x: 0.3, y: 0 }, { x: 1.7, y: 0 }], [{ x: 1, y: 0.7 }, { x: 1, y: 0 }]] })
    expect(tee.isError, tee.result).toBe(false)
    expect(tee.result).toMatch(/Wire 2 from \(1, 0\.7\) at R3\.1 to \(1, 0\) at a wire/)
    expect(tee.result).not.toMatch(/touch(es)? nothing/)
    const labelled = runTool(three(), "draw_wiring", { wires: [[{ x: 0.3, y: 0 }, { x: 0.3, y: -0.5 }]], labels: [{ name: "X", x: 0.3, y: -0.5 }] })
    expect(labelled.isError, labelled.result).toBe(false)
    expect(labelled.result).toMatch(/at the label X/)
    expect(labelled.result).not.toMatch(/touch(es)? nothing/)
  })

  it("never joins two nets that each have a name", () => {
    let p = ok(runTool(three(), "connect", { pins: ["R1.1"], net_name: "VBUS" }))
    p = ok(runTool(p, "connect", { pins: ["R2.2"], net_name: "GND" }))
    const r1 = p.labels.find((l) => l.name === "VBUS")!
    const r2 = p.labels.find((l) => l.name === "GND")!
    const out = runTool(p, "draw_wiring", { wires: [[{ x: r1.x, y: r1.y }, { x: r1.x, y: -1 }, { x: r2.x, y: -1 }, { x: r2.x, y: r2.y }]] })
    expect(out.isError, out.result).toBe(true)
    expect(out.result).toMatch(/VBUS and GND|GND and VBUS/)
  })
})

describe("edit_net", () => {
  it("renames every label and port of a net, and what the board keeps by its name follows", () => {
    let p = example("esp32-robot")
    p = { ...p, rules: { ...p.rules, netWidths: { "5V": 0.8 } } }
    const out = runTool(p, "edit_net", { net: "5V", rename_to: "5V0" })
    const q = ok(out)
    expect(out.result).toMatch(/10 power ports/)
    expect(groups(q)).toEqual(groups(p))
    const ports = q.components.filter((c) => findPart(c.partId)?.powerNet)
    expect(ports.filter((c) => powerNetName(c) === "5V")).toEqual([])
    expect(ports.filter((c) => powerNetName(c) === "5V0")).toHaveLength(10)
    expect(q.rules.netWidths).toEqual({ "5V0": 0.8 })
    expect(computeConnectivity(q).nets.some((n) => n.name === "5V")).toBe(false)
  })

  it("refuses a name another net has, which would join the two", () => {
    const p = example("esp32-robot")
    const out = runTool(p, "edit_net", { net: "5V", rename_to: "3V3" })
    expect(out.isError).toBe(true)
    expect(out.result).toMatch(/already a net/)
    expect(out.project).toBe(p)
  })

  it("names a net nobody named with a label on one of its pins", () => {
    const p = ok(runTool(three(), "connect", { pins: ["R1.2", "R2.1"] }))
    expect(netOf(p, "R1.2")!.named).toBe(false)
    const q = ok(runTool(p, "edit_net", { net: netOf(p, "R1.2")!.name, rename_to: "MID" }))
    expect(netOf(q, "R2.1")!.name).toBe("MID")
    expect(groups(q)).toEqual(groups(p))
  })

  it("refuses to name a net nobody named after another net, or with a made-up name, and changes nothing", () => {
    let p = ok(runTool(three(), "connect", { pins: ["R1.2", "R2.1"] }))
    p = ok(runTool(p, "connect", { pins: ["R3.1"], net_name: "VBUS" }))
    const unnamed = netOf(p, "R1.2")!.name
    for (const [rename_to, why] of [["VBUS", /already a net/], ["NET7", /makes up/], ["A B", /space/]] as const) {
      const out = runTool(p, "edit_net", { net: unnamed, rename_to })
      expect(out.isError, out.result).toBe(true)
      expect(out.result).toMatch(why)
      expect(out.project).toBe(p)
    }
    expect(sameNet(p, "R1.2", "R3.1")).toBe(false)
  })

  it("refuses ports for a net a local label names, which Tidy keeps as labels", () => {
    let p: Project = { ...three(), netNames: "kicad" }
    p = ok(runTool(p, "connect", { pins: ["R1.2", "R2.1"], net_name: "MID" }))
    const out = runTool(p, "edit_net", { net: "MID", draw_as: "port" })
    expect(out.isError, out.result).toBe(true)
    expect(out.result).toMatch(/local label/)
    expect(ok(runTool(p, "edit_net", { net: "MID", draw_as: "label" })).netStyles).toEqual({ MID: "label" })
  })

  it("draws a supply with labels when told, keeps the netlist, and Tidy keeps to it", () => {
    const p = example("esp32-robot")
    const vbatPorts = (x: Project) => x.components.filter((c) => findPart(c.partId)?.powerNet && powerNetName(c) === "VBAT").length
    expect(vbatPorts(p)).toBeGreaterThan(0)
    const styled = runTool(p, "edit_net", { net: "VBAT", draw_as: "label" })
    expect(styled.result).toMatch(/Tidy the blocks it is in to redraw it: .*POWER/)
    let q = ok(styled)
    expect(q.netStyles).toEqual({ VBAT: "label" })
    q = ok(runTool(q, "tidy_schematic", { whole_sheet: true }))
    expect(vbatPorts(q)).toBe(0)
    expect(q.labels.some((l) => l.name === "VBAT")).toBe(true)
    expect(groups(q)).toEqual(groups(p))
    expect(netOf(q, "U3.IN")!.name).toBe("VBAT")
    // Tidying again changes nothing; leaving it to Tidy draws ports again.
    expect(runTool(q, "tidy_schematic", { whole_sheet: true }).result).toMatch(/Already tidy/)
    q = ok(runTool(q, "edit_net", { net: "VBAT", draw_as: "auto" }))
    expect(q.netStyles).toBeUndefined()
    q = ok(runTool(q, "tidy_schematic", { whole_sheet: true }))
    expect(vbatPorts(q)).toBeGreaterThan(0)
  })

  it("carries the style along a rename", () => {
    let p = ok(runTool(example("esp32-robot"), "edit_net", { net: "VBAT", draw_as: "label" }))
    p = ok(runTool(p, "edit_net", { net: "VBAT", rename_to: "VBATT" }))
    expect(p.netStyles).toEqual({ VBATT: "label" })
  })
})
