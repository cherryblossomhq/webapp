import { describe, expect, it } from "vitest"
import { tidySchematic } from "../src/model/tidy"
import { BlockLayout } from "../src/model/tidy/block"
import { wiredSupplyPins } from "../src/model/tidy/clusters"
import { netInfo } from "../src/model/tidy/nets"
import { runTool } from "../src/ai/tools"
import type { Project } from "../src/model/types"
import { firstRequest, netlist, netlistDiff } from "./sakura-session"
import { frameProblems, offGrid, overlaps, pinsOnWires, wireProblems } from "./tidy-metrics"

// Problem 1 of the owner's Sakura session (ESP32-C3 + BME280 board): "Tidy couldn't find room for
// everything; nothing was changed. Tidy: no room for U2: no room for a label of SCL".
//
// Needs sakura-session.ts and sakura-session-parts.json beside it.
//
// Cause: the SENSOR block's 3V3 is served by one small part of its own (C4), so `wiredSupplyPins`
// (tidy/clusters.ts) wires 3V3 like a signal. On the BME280, 3V3 is also on CSB, a pin on the right
// side under SDI and SCK. The wire from CSB to VDD/VDDIO goes round the right side and walls in SDI
// and SCK, whose labels can only run straight out (block.ts placeSlot), so the main part had no
// spot in any style, and the whole sheet was refused. Not the label's length, not the grid, not a
// search limit.
//
// Fixed: a cluster that can't be drawn with a supply wired is drawn with a port at each of its
// pins instead (`supplyDrops`, tidy/clusters.ts), and a block that still can't be drawn no longer
// refuses the sheet: the rest is tidied around it (tidy-keeps-block.test.ts).

const sensorOf = (p: Project) => p.blocks!.find((b) => b.name === "SENSOR")!

describe("Tidy on the session's sheet", () => {
  it("is replayed with every net apart, as the owner's sheet had them", () => {
    const nl = netlist(firstRequest().project)
    expect([nl.get("U1.23"), nl.get("SW2.1"), nl.get("U1.1"), nl.get("SW2.2")]).toEqual(["BOOT", "BOOT", "GND", "GND"])
    expect([nl.get("U1.8"), nl.get("SW1.1"), nl.get("U1.27"), nl.get("J1.A6")]).toEqual(["EN", "EN", "USB_DP", "USB_DP"])
    expect(new Set(nl.values()).size).toBe(14)
  })

  it("tidies the sheet Sakura built and grouped (refused before: no room for a label of SCL)", () => {
    const s = firstRequest()
    const before = netlist(s.project)
    const out = s.run("tidy_schematic", {})
    expect(out.result).not.toContain("no room for a label of SCL")
    expect(out.isError).toBe(false)
    expect(out.result).toBe("Tidied 19 parts into 5 blocks.")
    expect(netlistDiff(before, netlist(s.project))).toEqual([])
    // U2 with the rest, every block in a frame, and nothing drawn over anything.
    expect(s.project.blocks!.find((b) => b.name === "SENSOR")!.components).toContain(s.ref("U2").id)
    const w = wireProblems(s.project)
    expect({ overlaps: overlaps(s.project), crossings: w.crossings, through: w.through, pins: pinsOnWires(s.project), grid: offGrid(s.project), frames: frameProblems(s.project) }).toEqual({
      overlaps: [],
      crossings: [],
      through: [],
      pins: [],
      grid: [],
      frames: [],
    })
    expect(tidySchematic(s.project).changed).toBe(false)
  })

  it("tidies the SENSOR block on its own", () => {
    const p = firstRequest().project
    const r = tidySchematic(p, { blockId: sensorOf(p).id })
    expect(r.problems).toEqual([])
    expect(r.ok).toBe(true)
  })

  it("a block that can't be drawn doesn't stop the other four (today one block refuses all)", () => {
    const s = firstRequest()
    const out = s.run("tidy_schematic", { whole_sheet: true })
    // Every other block tidies alone; the whole sheet should tidy them and report SENSOR, not refuse.
    for (const name of ["USB-C INPUT", "3.3V POWER", "MCU", "STATUS LED"]) {
      const p = firstRequest().project
      expect(tidySchematic(p, { blockId: p.blocks!.find((b) => b.name === name)!.id }).ok).toBe(true)
    }
    expect(out.isError).toBe(false)
  })
})

describe("why (these pin the cause)", () => {
  it("the same block without C4 tidies, and so does it with SCL renamed: the label's name made no difference", () => {
    const p = firstRequest().project
    const without = runTool(p, "edit_block", { block: "SENSOR", remove_refs: ["C4"] }).project
    expect(tidySchematic(without, { blockId: sensorOf(without).id }).ok).toBe(true)
    const renamed = { ...p, labels: p.labels.map((l) => (l.name === "SCL" ? { ...l, name: "X" } : l)) }
    const r = tidySchematic(renamed, { blockId: sensorOf(renamed).id })
    expect(r.problems).toEqual([])
    expect(r.ok).toBe(true)
  })

  it("3V3 is wired, CSB included, and U2 drawn with a port at each supply pin has room", () => {
    const p = firstRequest().project
    const parts = sensorOf(p).components.map((id) => p.components.find((c) => c.id === id)!)
    const nets = netInfo(p)
    const wired = wiredSupplyPins(parts, nets)
    const u2 = p.components.find((c) => c.ref === "U2")!
    expect([...wired].filter((k) => k.startsWith(`${u2.id}:`)).sort()).toEqual([`${u2.id}:2`, `${u2.id}:6`, `${u2.id}:8`])
    const ctx = { nets, external: () => true, labelName: (net: string) => nets.nets.get(net)!.name }
    expect(() => new BlockLayout(parts, { ...ctx, wired: (k) => wired.has(k) }, "full").layout()).toThrow("no room for a label of SCL")
    expect(() => new BlockLayout(parts, { ...ctx, wired: () => false }, "full").layout()).not.toThrow()
  })
})
