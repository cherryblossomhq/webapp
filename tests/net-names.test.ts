import { beforeEach, describe, expect, it } from "vitest"
import { runTool } from "../src/ai/tools"
import { computeConnectivity } from "../src/model/connectivity"
import { getErc } from "../src/model/connectivityCache"
import { ignoreCheck, splitIgnored } from "../src/model/erc"
import { addComponent, createProject, findPin, labelPin, resolvePinSpec } from "../src/model/ops"
import type { Project } from "../src/model/types"
import { commitOnUse } from "../src/model/sheets"
import { useProjectStore } from "../src/store/projectStore"

const tool = (p: Project, name: string, input: Record<string, unknown>) => {
  const out = runTool(p, name, input)
  expect(out.isError, out.result).toBe(false)
  return out.project
}
const pinAt = (p: Project, spec: string) => findPin(p, resolvePinSpec(p, spec)!)!.pos

/** A ground port with its pin on a pin of the sheet. */
function groundOn(p: Project, spec: string): Project {
  const probe = addComponent(createProject("probe"), "ground", { sch: { x: 0, y: 0, rot: 0 } })
  const offset = findPin(probe.project, { componentId: probe.component.id, pin: "1" })!.pos
  const at = pinAt(p, spec)
  return addComponent(p, "ground", { sch: { x: at.x - offset.x, y: at.y - offset.y, rot: 0 } }).project
}

/** R1.2 and C1.2 on a net `connect` named NET1, R1.1 and C2.2 on NET2. */
function madeUpNets(): Project {
  let p = createProject("t")
  p = tool(p, "add_component", { part_id: "resistor", x: 0, y: 0 })
  p = tool(p, "add_component", { part_id: "capacitor", x: 3, y: 0 })
  p = tool(p, "add_component", { part_id: "capacitor", x: 6, y: 0 })
  p = tool(p, "connect", { pins: ["R1.2", "C1.2"] })
  p = tool(p, "connect", { pins: ["R1.1", "C2.2"] })
  expect(p.labels.map((l) => l.name).sort()).toEqual(["NET1", "NET1", "NET2", "NET2"])
  return p
}

const names = (p: Project) => p.labels.map((l) => l.name).sort()
const conflicts = (p: Project) => computeConnectivity(p).conflicts.map((c) => c.names.join(","))
const nameFinding = (p: Project) => getErc(p).find((f) => f.kind === "net-names")

describe("made-up net names", () => {
  const api = () => useProjectStore.getState()
  beforeEach(() => api().close())

  it("take the name of the net an edit joins them to", () => {
    api().open(madeUpNets())
    api().commit((p) => groundOn(p, "R1.2"))
    const p = api().project!
    expect(names(p)).toEqual(["GND", "GND", "NET2", "NET2"])
    expect(conflicts(p)).toEqual([])
    expect(nameFinding(p)).toBeUndefined()
    // One undo step: the port and the rename go together.
    api().undo()
    expect(names(api().project!)).toEqual(["NET1", "NET1", "NET2", "NET2"])
    expect(api().project!.components.some((c) => c.partId === "ground")).toBe(false)
  })

  it("leave a net that already had them, and settle the rest once one is renamed by hand", () => {
    // A project from before: GND, NET1 and NET2 on one net (two ground ports join by their name).
    const legacy = groundOn(groundOn(madeUpNets(), "R1.2"), "C2.2")
    expect(conflicts(legacy)).toEqual(["GND,NET1,NET2"])
    api().open(legacy)
    // An edit that joins nothing new and names no label on the net leaves the names alone.
    api().commit((p) => tool(p, "add_component", { part_id: "resistor", x: 20, y: 20 }))
    expect(conflicts(api().project!)).toEqual(["GND,NET1,NET2"])
    // Renaming one stale label by hand works on that net: the other made-up labels follow it.
    const one = api().project!.labels.find((l) => l.name === "NET1")!
    api().commit((p) => ({ ...p, labels: p.labels.map((l) => (l.id === one.id ? { ...l, name: "GND" } : l)) }))
    expect(conflicts(api().project!)).toEqual([])
    expect(names(api().project!)).toEqual(["GND", "GND", "GND", "GND"])
  })

  it("keep a made-up name the edit typed itself", () => {
    api().open(madeUpNets())
    api().commit((p) => groundOn(p, "R1.2"))
    const gnd = api().project!.labels.find((l) => l.name === "GND")!
    api().commit((p) => ({ ...p, labels: p.labels.map((l) => (l.id === gnd.id ? { ...l, name: "NET7" } : l)) }))
    expect(api().project!.labels.find((l) => l.id === gnd.id)!.name).toBe("NET7")
    expect(conflicts(api().project!)).toEqual(["GND,NET7"])
  })

  it("leave two chosen names joined for Checks to show", () => {
    // Two regulators 1.6 apart, whose label stubs share a line: 3V3 and VIN on one net.
    let p = createProject("t")
    p = addComponent(p, "ams1117_3v3", { sch: { x: 0, y: 0, rot: 0 } }).project
    p = addComponent(p, "ams1117_3v3", { sch: { x: 1.6, y: 0, rot: 0 } }).project
    p = labelPin(p, { componentId: p.components[0].id, pin: "2" }, "3V3")
    p = labelPin(p, { componentId: p.components[1].id, pin: "3" }, "VIN")
    expect(conflicts(p)).toEqual(["3V3,VIN"])
    api().open(p)
    api().commit((q) => labelPin(q, { componentId: q.components[0].id, pin: "2" }, "NET5", 0.1))
    expect(conflicts(api().project!)).toEqual(["3V3,NET5,VIN"])
  })
})

describe("the check for a net with several names", () => {
  it("points at the labels of the names the net is not known by, and can be ignored", () => {
    const p = groundOn(groundOn(madeUpNets(), "R1.2"), "C2.2")
    const joined = tool(p, "connect", { pins: ["C1.2", "C2.2"] })
    const f = nameFinding(joined)!
    expect(f.message).toBe("Net names merged: GND, NET1, NET2")
    const stale = joined.labels.filter((l) => l.name !== "GND")
    expect(new Set(f.labelIds)).toEqual(new Set(stale.map((l) => l.id)))
    expect(f.componentIds).toEqual([])
    expect(stale.some((l) => l.x === f.at.x && l.y === f.at.y)).toBe(true)
    // Sakura reads it with the electrical checks, and an ignored one as ignored.
    expect(runTool(joined, "run_checks", {}).result).toContain("- Net names merged: GND, NET1, NET2")
    const ignored = ignoreCheck(joined, f.key)
    expect(splitIgnored(getErc(ignored), ignored.ignoredChecks).active.some((x) => x.kind === "net-names")).toBe(false)
    expect(runTool(ignored, "run_checks", {}).result).not.toContain("- Net names merged")
  })

  it("leaves names that meet only through a sheet pin, and flags two names on one sheet below", () => {
    let p = createProject("t")
    p = tool(p, "add_component", { part_id: "resistor", x: 0, y: 0 })
    p = tool(p, "add_sheet", { name: "SUB", x: 6, y: 0 })
    p = tool(p, "add_component", { part_id: "resistor", sheet: "SUB", x: 0, y: 0 })
    p = tool(p, "add_hier_label", { sheet: "SUB", name: "SDA", pins: ["R2.1"] })
    p = tool(p, "wire_sheet_pin", { sheet: "SUB", pin: "SDA", to: ["R1.2"], net_name: "I2C_SDA" })
    // I2C_SDA outside and SDA inside are one net by design, as in KiCad.
    expect(conflicts(p)).toEqual(["I2C_SDA,SDA"])
    expect(nameFinding(p)).toBeUndefined()
    const r2 = p.components.find((c) => c.ref === "R2")!
    const clash = commitOnUse(p, r2.inst!, (v) => labelPin(v, { componentId: r2.id, pin: "1" }, "DATA", 0.1))
    const f = nameFinding(clash)!
    // The names that meet on the sheet below, as KiCad's ERC says them: I2C_SDA is the sheet above's name for the net.
    expect(f.message).toBe("Net names merged: DATA, SDA")
    expect(f.sheet).toBe(r2.inst)
  })

  it("points at the power ports when they are the odd ones out", () => {
    let p = createProject("t")
    p = addComponent(p, "resistor", { sch: { x: 0, y: 0, rot: 0 } }).project
    p = labelPin(p, { componentId: p.components[0].id, pin: "1" }, "VSS")
    p = labelPin(p, { componentId: p.components[0].id, pin: "2" }, "VSS")
    p = groundOn(p, "R1.2")
    const f = nameFinding(p)!
    expect(f.message).toBe("Net names merged: GND, VSS")
    expect(f.labelIds).toEqual([])
    expect(f.componentIds).toEqual([p.components.find((c) => c.partId === "ground")!.id])
  })
})
