import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import { blockFrames, drawnIslands } from "../src/model/blocks"
import { parseProjectFile } from "../src/model/projectFile"
import { tidySchematic } from "../src/model/tidy"
import type { Project } from "../src/model/types"
import { firstRequest, netlist, netlistDiff, Session } from "./sakura-session"
import { Designer, randomDesign, rng } from "./tidy-designs"
import { frameProblems, offGrid, overlaps, pinsOnWires, wireProblems } from "./tidy-metrics"

// A whole-sheet tidy keeps a block it can't lay out exactly as it was drawn and tidies the rest
// around it, rather than refusing the sheet; the message and Sakura's reply name the block and why.
// No real symbol is known to need it any more, so the layout of a block holding one of `refs` is
// made to fail here, as the BME280's did before its supply could be drawn with ports.

const failing = vi.hoisted(() => ({ refs: new Set<string>() }))

vi.mock("../src/model/tidy/clusters", async (load) => {
  const real = await load<typeof import("../src/model/tidy/clusters")>()
  return {
    ...real,
    layoutBlock: (...args: Parameters<typeof real.layoutBlock>) => {
      const hit = args[0].find((c) => failing.refs.has(c.ref))
      if (hit) throw new Error(`Tidy: no room for ${hit.ref}: no room for a label of SCL`)
      return real.layoutBlock(...args)
    },
  }
})

const failOn = (...refs: string[]) => {
  failing.refs = new Set(refs)
}

/** The parts of a block, and every wire, label and port drawn for them alone, as they are drawn. */
function drawingOf(p: Project, ids: Set<string>) {
  const isl = drawnIslands(p)
  const wires = new Set<string>()
  const labels = new Set<string>()
  const comps = new Set<string>(ids)
  const byId = new Map(p.components.map((c) => [c.id, c]))
  for (const [root, members] of isl.components) {
    const arranged = [...members].filter((id) => !byId.get(id)!.ref.startsWith("#"))
    if (!arranged.length || !arranged.every((id) => ids.has(id))) continue
    for (const id of isl.wires.get(root) ?? []) wires.add(id)
    for (const id of isl.labels.get(root) ?? []) labels.add(id)
    for (const id of members) comps.add(id)
  }
  const byIdOrder = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  return JSON.stringify({
    comps: p.components.filter((c) => comps.has(c.id)).sort(byIdOrder),
    wires: p.wires.filter((w) => wires.has(w.id)).sort(byIdOrder),
    labels: p.labels.filter((l) => labels.has(l.id)).sort(byIdOrder),
  })
}

function looksClean(p: Project) {
  const w = wireProblems(p)
  expect({ overlaps: overlaps(p), crossings: w.crossings, through: w.through, pins: pinsOnWires(p), grid: offGrid(p), frames: frameProblems(p) }).toEqual({
    overlaps: [],
    crossings: [],
    through: [],
    pins: [],
    grid: [],
    frames: [],
  })
}

const touch = (a: { minX: number; minY: number; maxX: number; maxY: number }, b: typeof a) => a.minX < b.maxX && a.maxX > b.minX && a.minY < b.maxY && a.maxY > b.minY

describe("a whole-sheet tidy with a block it can't lay out", () => {
  it("keeps SENSOR exactly as drawn, tidies the other four around it and says so", () => {
    failOn("U2")
    const p = firstRequest().project
    const sensor = p.blocks!.find((b) => b.name === "SENSOR")!
    const ids = new Set(sensor.components)
    const r = tidySchematic(p)
    expect(r.ok).toBe(true)
    expect(r.changed).toBe(true)
    expect(r.kept).toEqual([{ block: "SENSOR", why: "no room for U2: no room for a label of SCL" }])
    // SENSOR stays where Sakura drew it, 60 units down: further than the largest page of its family reaches, which the message says.
    expect(r.message).toBe("Tidied 15 parts into 4 blocks. Kept SENSOR as it was drawn: no room for U2: no room for a label of SCL. The sheet grew from A4 to A0, the largest of its sizes, and still doesn't fit on it.")
    expect(netlistDiff(netlist(p), netlist(r.project))).toEqual([])
    // Byte for byte: its parts, its block, and all that is drawn for them alone.
    expect(drawingOf(r.project, ids)).toBe(drawingOf(p, ids))
    expect(r.project.blocks!.find((b) => b.id === sensor.id)).toEqual(sensor)
    // Every other part moved, and no tidied frame is on the kept block or its parts.
    const was = new Map(p.components.map((c) => [c.id, c]))
    const frames = blockFrames(r.project)
    const keptBox = frames.find((f) => f.id === sensor.id)!.box
    for (const f of frames) if (f.id !== sensor.id) expect(touch(f.box, keptBox)).toBe(false)
    expect(r.project.components.filter((c) => !c.ref.startsWith("#") && !ids.has(c.id) && JSON.stringify(c.sch) === JSON.stringify(was.get(c.id)?.sch))).toEqual([])
    // A second tidy keeps it again and finds the rest tidy.
    const again = tidySchematic(r.project)
    expect(again.ok).toBe(true)
    expect(again.changed).toBe(false)
    expect(again.message).toBe("Already tidy. Kept SENSOR as it was drawn: no room for U2: no room for a label of SCL. The sheet doesn't fit on A0, the largest of its sizes.")
    // The same with the parts in another order.
    const rev = tidySchematic({ ...p, components: [...p.components].reverse() })
    expect(netlistDiff(netlist(p), netlist(rev.project))).toEqual([])
    expect(drawingOf(rev.project, ids)).toBe(drawingOf(p, ids))
  })

  it("leaves the rest of the sheet clean once SENSOR is tidy", () => {
    failOn("U2")
    const p = firstRequest().project
    const kept = tidySchematic(p).project
    failOn()
    const r = tidySchematic(kept)
    expect(r.kept).toEqual([])
    expect(netlistDiff(netlist(p), netlist(r.project))).toEqual([])
    looksClean(r.project)
  })

  it("Sakura's tidy_schematic says which block it kept and why", () => {
    failOn("U2")
    const s = firstRequest()
    const out = s.run("tidy_schematic", {})
    expect(out.isError).toBe(false)
    expect(out.result).toContain("Kept SENSOR as it was drawn: no room for U2: no room for a label of SCL.")
    expect(out.summary).toBe("Tidied 15 parts into 4 blocks. Kept SENSOR as it was drawn.")
  })

  it("Sakura tidying named blocks tidies those it can and keeps the one it can't", () => {
    failOn("U2")
    const s = firstRequest()
    const before = s.project
    const sensor = before.blocks!.find((b) => b.name === "SENSOR")!
    const out = s.run("tidy_schematic", { blocks: ["SENSOR", "MCU"] })
    expect(out.isError).toBe(false)
    expect(out.result).toContain("Tidied MCU.")
    expect(out.result).toContain("Kept SENSOR as it was drawn: no room for U2: no room for a label of SCL.")
    expect(out.summary).toBe("Tidied MCU. Kept SENSOR as it was drawn.")
    expect(netlistDiff(netlist(before), netlist(s.project))).toEqual([])
    for (const id of sensor.components) expect(s.project.components.find((c) => c.id === id)!.sch).toEqual(before.components.find((c) => c.id === id)!.sch)
    // Just the one block, as before: refused, nothing changed.
    const one = s.run("tidy_schematic", { blocks: ["SENSOR"] })
    expect(one.isError).toBe(true)
  })

  it("cuts drawing the kept block shares with a tidied one where it leaves the tidied part", () => {
    failOn()
    const s = firstRequest()
    s.must("tidy_schematic", {})
    // R5 into a block of its own: its wire to U2's SDI is now drawing SENSOR shares with it.
    s.must("edit_block", { block: "SENSOR", remove_refs: ["R5"] })
    s.must("group_parts", { block: "PULL-UP", refs: ["R5"] })
    const p = s.project
    const sensor = p.blocks!.find((b) => b.name === "SENSOR")!
    const [u2, r5] = [s.ref("U2").id, s.ref("R5").id]
    expect([...drawnIslands(p).components.values()].some((m) => m.has(u2) && m.has(r5))).toBe(true)
    failOn("U2")
    const r = tidySchematic(p)
    expect(r.ok).toBe(true)
    expect((r.kept ?? []).map((k) => k.block)).toEqual(["SENSOR"])
    expect(netlistDiff(netlist(p), netlist(r.project))).toEqual([])
    for (const id of sensor.components) expect(r.project.components.find((c) => c.id === id)).toEqual(p.components.find((c) => c.id === id))
    const frames = blockFrames(r.project)
    const keptBox = frames.find((f) => f.id === sensor.id)!.box
    for (const f of frames) if (f.id !== sensor.id) expect(touch(f.box, keptBox)).toBe(false)
    const again = tidySchematic(r.project)
    expect(again.changed).toBe(false)
  })

  it("keeps parts in no block where they are, without making a block of them", () => {
    failOn("U2")
    const s = firstRequest()
    s.must("edit_block", { block: "SENSOR", ungroup: true })
    const p = s.project
    const r = tidySchematic(p)
    expect(r.ok).toBe(true)
    expect((r.kept ?? []).map((k) => k.block)).toEqual(["OTHER"])
    expect(r.project.blocks!.map((b) => b.name)).toEqual(["USB-C INPUT", "3.3V POWER", "MCU", "STATUS LED"])
    expect(netlistDiff(netlist(p), netlist(r.project))).toEqual([])
    for (const ref of ["U2", "C4", "R5", "R6"]) {
      const c = p.components.find((x) => x.ref === ref)!
      expect(r.project.components.find((x) => x.id === c.id)!.sch).toEqual(c.sch)
    }
    expect(tidySchematic(r.project).changed).toBe(false)
  })

  it("refuses with nothing changed when no block can be laid out", () => {
    failOn("U1", "U2", "U3", "J1", "D1")
    const p = firstRequest().project
    const r = tidySchematic(p)
    expect(r.ok).toBe(false)
    expect(r.project).toBe(p)
    expect(r.kept).toEqual([])
    expect(r.message).toBe("Tidy couldn't find room for everything; nothing was changed.")
    expect(r.problems).toHaveLength(5)
  })

  it("still refuses one block it can't lay out, tidied on its own", () => {
    failOn("U2")
    const p = firstRequest().project
    const r = tidySchematic(p, { blockId: p.blocks!.find((b) => b.name === "SENSOR")!.id })
    expect(r.ok).toBe(false)
    expect(r.project).toBe(p)
    expect(r.problems).toEqual(["Tidy: no room for U2: no room for a label of SCL"])
  })

  it("draws the tidied blocks clear of what it keeps on a sheet of made-up parts", () => {
    failOn("U1")
    const s = new Session()
    s.must("add_component", { part_id: "ne555", ref: "U1" })
    s.must("add_component", { part_id: "ne555", ref: "U2" })
    for (const [ref, v] of [["R1", "10k"], ["R2", "10k"]]) s.must("add_component", { part_id: "resistor", ref, props: { resistance: v } })
    s.must("connect", { pins: ["U1.3", "R1.1"], net_name: "OUT1" })
    s.must("connect", { pins: ["U2.3", "R2.1"], net_name: "OUT2" })
    s.must("connect", { pins: ["R1.2", "R2.2", "U2.2"], net_name: "TRIG" })
    s.must("group_parts", { block: "A", refs: ["U1", "R1"] })
    s.must("group_parts", { block: "B", refs: ["U2", "R2"] })
    const p = s.project
    const r = tidySchematic(p)
    expect(r.ok).toBe(true)
    expect((r.kept ?? []).map((k) => k.block)).toEqual(["A"])
    expect(netlistDiff(netlist(p), netlist(r.project))).toEqual([])
    const frames = blockFrames(r.project)
    const a = frames.find((f) => f.name === "A")!.box
    const b = frames.find((f) => f.name === "B")!.box
    expect(touch(a, b)).toBe(false)
    expect(tidySchematic(r.project).changed).toBe(false)
  })
})

describe("a whole-sheet tidy that keeps a block settles in one run", () => {
  /** Tidy with the block named failing, then again: the second changes nothing. */
  function settles(p: Project, block: string) {
    const b = p.blocks!.find((x) => x.name === block)!
    failOn(...p.components.filter((c) => b.components.includes(c.id)).map((c) => c.ref))
    const r = tidySchematic(structuredClone(p))
    expect(r.ok).toBe(true)
    expect((r.kept ?? []).map((k) => k.block)).toEqual([block])
    const again = tidySchematic(structuredClone(r.project))
    expect(again.ok).toBe(true)
    expect(again.changed).toBe(false)
    return r.project
  }

  it("places the rest beside the kept block's frame as the next tidy will find it", () => {
    // randomDesign(9007) as drawn, TIMER kept: what the cut left by a kept pin still touched a part
    // being tidied where it was drawn, so the kept frame left it out the first time and took it in
    // the second, and the 17 other parts moved.
    settles(randomDesign(9007, 3), "TIMER")
    // Rails wired across three blocks, A kept: the same, U2 and U3 moved.
    const d = new Designer("rails", rng(6))
    const chips = [d.add("lm358")]
    d.block("A")
    chips.push(d.add("lm358"))
    d.block("B")
    chips.push(d.add("ne555"))
    d.block("C")
    d.wire(chips[0], "8", chips[1], "8")
    d.wire(chips[1], "8", chips[2], "8")
    d.wire(chips[0], "4", chips[1], "4")
    d.wire(chips[1], "4", chips[2], "1")
    d.label(chips[0], "8", "VCC")
    d.label(chips[2], "1", "GND")
    d.wire(chips[0], "1", chips[1], "3")
    d.wire(chips[1], "1", chips[2], "2")
    d.wire(chips[2], "3", chips[0], "3")
    settles(d.project, "A")
  })

  it("never hangs a net's other name on wire that reaches no part", () => {
    // The session as the old packed replay built it (EN and USB_DP one net, so USB_DP is EN's other
    // name), tidied, knocked about, USB-C INPUT kept: USB_DP's label went on a stub stowed below the
    // blocks, so the next tidy stowed it as one more loose piece and every piece after it moved.
    const p = parseProjectFile(readFileSync(join(__dirname, "fixtures/tidy-repro/session-shorted-nudged.json"), "utf8"), { id: "p", createdAt: 0, updatedAt: 0 })
    settles(p, "USB-C INPUT")
  })

  it("puts what marks a cut on the grid where the cut was on wire drawn off it", () => {
    // randomDesign(9007), TIMER kept: U1_TRIG was cut at x = -0.7662, a corner of wire drawn off
    // the grid; its label goes where that wire's straight run meets the grid.
    const p = randomDesign(9007, 3)
    const out = settles(p, "TIMER")
    const was = new Set(p.labels.map((l) => l.id))
    expect(offGrid({ ...out, wires: [], components: [], labels: out.labels.filter((l) => !was.has(l.id)) })).toEqual([])
  })
})
