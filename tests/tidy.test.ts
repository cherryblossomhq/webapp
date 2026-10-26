import { readdirSync, readFileSync } from "node:fs"
import { describe, expect, it, vi } from "vitest"
import { runTool } from "../src/ai/tools"
import { blockPorts } from "../src/model/blockPorts"
import { blockFrames, createBlock, drawnIslands } from "../src/model/blocks"
import { computeConnectivity, pinKey } from "../src/model/connectivity"
import { EXAMPLES } from "../src/model/examples"
import { isPhysical, schematicPins } from "../src/model/instances"
import { findPart } from "../src/model/library"
import { addComponent, addWire, createProject, labelPin } from "../src/model/ops"
import { normalizeProject, parseProjectFile, serializeProject } from "../src/model/projectFile"
import { tidySchematic } from "../src/model/tidy"
import { flowOrder } from "../src/model/tidy/flow"
import { netInfo } from "../src/model/tidy/nets"
import { Space } from "../src/model/tidy/space"
import { selectedItems } from "../src/editor/schematic/clipboard"
import { pasteItems } from "../src/model/schematicEdit"
import { onTidy, onTidyBusy, startTidy, stopTidy, tidySelected, viewForBlock, type TidyReply, type TidyRequest } from "../src/editor/schematic/tidyAction"
import { useProjectStore } from "../src/store/projectStore"
import { useUi } from "../src/store/uiStore"
import type { Project } from "../src/model/types"
import { Designer, largeDesign, randomDesign, rng } from "./tidy-designs"
import { frameProblems, offGrid, overlaps, pinsOnWires, wireProblems } from "./tidy-metrics"

// Tidy is held to what it promises on every drawing there is to hand: the shipped examples, the
// files written by older versions, the eight blog boards as the tscircuit importer brings them in,
// and designs made up from a seed. The blog boards are stored as imported (copper left out), so the
// test reads them as the editor would open them.

const origin = { id: "p", createdAt: 0, updatedAt: 0 }
const fixture = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8")

const BLOG = readdirSync(new URL("./fixtures/blog-boards/", import.meta.url)).filter((f) => f.endsWith(".json"))

const CASES: [string, () => Project][] = [
  ...EXAMPLES.map((ex): [string, () => Project] => [`example ${ex.id}`, () => normalizeProject(structuredClone(ex.project))]),
  ...["blinker", "imported", "sheet"].map((name): [string, () => Project] => [`v1 file ${name}`, () => parseProjectFile(JSON.parse(fixture(`./fixtures/project-v1/${name}.json`)).file, origin)]),
  ...BLOG.map((f): [string, () => Project] => [`blog board ${f.replace(/\.json$/, "")}`, () => parseProjectFile(fixture(`./fixtures/blog-boards/${f}`), origin)]),
  ...[1, 2, 3, 4, 5, 6, 7, 8].map((seed): [string, () => Project] => [`made-up design ${seed}`, () => randomDesign(seed, 2 + (seed % 5))]),
]

/**
 * The netlist as a partition of physical pins, each part named by its net's name when it has one:
 * computed here from scratch, not with Tidy's own check.
 */
function netlist(p: Project) {
  const conn = computeConnectivity(p)
  const byId = new Map(conn.nets.map((n) => [n.id, n]))
  const groups = new Map<string, string[]>()
  const names = new Map<string, string>()
  for (const c of p.components) {
    if (!isPhysical(findPart(c.partId))) continue
    for (const pin of schematicPins(c)) {
      const id = conn.pinNet.get(pinKey(c.id, pin.pin))
      const net = id ? byId.get(id) : undefined
      if (!net || (!net.named && net.pins.length < 2)) continue
      groups.set(net.id, [...(groups.get(net.id) ?? []), `${c.ref}.${pin.pin}`])
      if (net.named) names.set(net.id, net.name)
    }
  }
  const sets = [...groups.entries()].map(([id, pins]) => ({ pins: pins.sort().join(" "), name: names.get(id) ?? null }))
  return sets.sort((a, b) => (a.pins < b.pins ? -1 : 1))
}

/** Tidy may name an unnamed net, and settle a net with two names on the stronger; nothing else. */
function expectSameNetlist(before: Project, after: Project, renamed: Record<string, string>) {
  const a = netlist(before)
  const b = netlist(after)
  expect(b.map((n) => n.pins)).toEqual(a.map((n) => n.pins))
  a.forEach((n, i) => {
    if (n.name) expect(b[i].name).toBe(renamed[n.name] ?? n.name)
  })
}

/** The same sheet with every component under a new id, as a copy of a project has. */
function withFreshIds(p: Project): Project {
  const ids = new Map(p.components.map((c, i) => [c.id, `fresh${String(p.components.length - i).padStart(4, "0")}`]))
  return {
    ...structuredClone(p),
    components: p.components.map((c) => ({ ...structuredClone(c), id: ids.get(c.id)! })),
    blocks: p.blocks?.map((b) => ({ ...b, components: b.components.map((id) => ids.get(id)!) })),
  }
}

/** What a sheet looks like, by designator: where each part is, and the wires, labels and ports. */
function drawing(p: Project) {
  const physical = p.components.filter((c) => isPhysical(findPart(c.partId)))
  return {
    parts: physical.map((c) => `${c.ref} ${c.sch.x} ${c.sch.y} ${c.sch.rot}`).sort(),
    ports: p.components.filter((c) => !isPhysical(findPart(c.partId))).map((c) => `${c.partId} ${c.props.net ?? ""} ${c.sch.x} ${c.sch.y} ${c.sch.rot}`).sort(),
    wires: p.wires.map((w) => w.points.map((q) => `${q.x},${q.y}`).join(" ")).sort(),
    labels: p.labels.map((l) => `${l.name} ${l.x} ${l.y} ${l.rot}`).sort(),
  }
}

const physicalParts = (p: Project) => p.components.filter((c) => isPhysical(findPart(c.partId)))

describe("Tidy on every drawing to hand", () => {
  it.each(CASES)("%s", (_, make) => {
    const before = make()
    const r = tidySchematic(before)
    expect(r.problems).toEqual([])
    expect(r.ok).toBe(true)
    const after = r.project

    // 1. The same pins on the same nets, under the same names.
    expectSameNetlist(before, after, r.renamed)

    // Parts keep what they are; only where they sit and how they are turned changes.
    const was = new Map(before.components.map((c) => [c.id, c]))
    for (const c of physicalParts(after)) {
      const b = was.get(c.id)!
      expect({ ref: c.ref, partId: c.partId, props: c.props, footprint: c.footprint, pcb: c.pcb }).toEqual({ ref: b.ref, partId: b.partId, props: b.props, footprint: b.footprint, pcb: b.pcb })
    }
    expect(physicalParts(after)).toHaveLength(physicalParts(before).length)

    // 2. Nothing drawn over anything else, and no wire through text, a symbol, a label or a port.
    expect(overlaps(after)).toEqual([])
    const wires = wireProblems(after)
    expect(wires.through).toEqual([])
    expect(pinsOnWires(after)).toEqual([])

    // 3. No wires of two nets crossing or touching.
    expect(wires.crossings).toEqual([])

    // 4. Everything on the 0.1 grid, every wire across or up and down.
    expect(offGrid(after)).toEqual([])

    // 6. Every part in a block, each frame around its own and clear of the others.
    expect(frameProblems(after)).toEqual([])
    const blocked = new Set((after.blocks ?? []).flatMap((b) => b.components))
    for (const c of physicalParts(after)) expect(blocked.has(c.id)).toBe(true)

    // 5. Tidying a tidy sheet changes nothing, and the same sheet always comes out the same.
    const again = tidySchematic(after)
    expect(again.ok).toBe(true)
    expect(again.changed).toBe(false)
    const twice = tidySchematic(structuredClone(before))
    expect(serializeProject(twice.project)).toBe(serializeProject(r.project))
    // A copy of the sheet, its parts under new ids, comes out drawn the same.
    const copy = tidySchematic(withFreshIds(before)).project
    expect(drawing(copy)).toEqual(drawing(r.project))
  })
})

describe("reading order", () => {
  it.each(CASES.filter(([name]) => name.startsWith("blog") || name.startsWith("made-up")))("%s reads left to right, top to bottom, by flow", (_, make) => {
    const r = tidySchematic(make())
    const p = r.project
    const frames = blockFrames(p)
    const order = flowOrder(p, p.blocks ?? [], netInfo(p)).map((f) => f.id)
    // Rows top to bottom; in a row, columns left to right, a frame stacked under another after it.
    const byFrame = new Map(frames.map((f) => [f.id, f.box]))
    const rows: (typeof frames)[] = []
    for (const f of [...frames].sort((a, b) => b.box.maxY - a.box.maxY)) {
      const row = rows[rows.length - 1]
      if (row && f.box.maxY > Math.min(...row.map((x) => x.box.minY))) row.push(f)
      else rows.push([f])
    }
    const read = rows.flatMap((row) => row.sort((a, b) => a.box.minX - b.box.minX || b.box.maxY - a.box.maxY))
    expect(read.map((f) => f.id)).toEqual(order.filter((id) => byFrame.has(id)))
  })
})

describe("one block", () => {
  it("tidies a block where it is and leaves the rest alone", () => {
    const before = parseProjectFile(fixture("./fixtures/blog-boards/esp32-usb-c-sensor.json"), origin)
    const sheet = tidySchematic(before).project
    const block = sheet.blocks!.find((b) => b.name === "MCU_BLK")!
    // Move a part so the block has something to tidy.
    const moved: Project = { ...sheet, components: sheet.components.map((c) => (c.id === block.components[1] ? { ...c, sch: { ...c.sch, x: c.sch.x + 1, y: c.sch.y + 0.5 } } : c)) }
    const r = tidySchematic(moved, { blockId: block.id })
    expect(r.ok).toBe(true)
    expectSameNetlist(moved, r.project, r.renamed)
    const others = new Set(sheet.blocks!.filter((b) => b.id !== block.id).flatMap((b) => b.components))
    for (const c of r.project.components) if (others.has(c.id)) expect(c.sch).toEqual(moved.components.find((x) => x.id === c.id)!.sch)
    expect(overlaps(r.project)).toEqual([])
    expect(frameProblems(r.project)).toEqual([])
    expect(tidySchematic(r.project, { blockId: block.id }).changed).toBe(false)
  })

  it("refuses a block that is gone, and an empty sheet", () => {
    const p = createProject("empty")
    expect(tidySchematic(p).ok).toBe(false)
    expect(tidySchematic(p, { blockId: "nope" }).ok).toBe(false)
  })
})

describe("names", () => {
  /** A 5V label and a VCC port on one net, with a pour and a stitching via on 5V. */
  function twoNames() {
    const d = new Designer("names", rng(1))
    const r1 = d.add("resistor", { value: "10k" })
    const r2 = d.add("resistor", { value: "10k" })
    d.label(r1, "1", "5V")
    const port = d.add("power", { net: "VCC" })
    d.wire(port, "1", r1, "1")
    d.wire(r1, "2", r2, "1")
    d.label(r2, "2", "OUT")
    const p = d.project
    return { ...p, zones: [{ id: "z1", net: "5V", layer: "top" as const }], vias: [{ id: "v1", x: 1, y: 1, diameter: 0.6, drill: 0.3, net: "5V" }] }
  }

  it("keeps the name a net goes by, and every other name it had, so Checks still sees them", () => {
    const before = twoNames()
    // The editor's own rule: of a net's names, the first in order. This net goes by 5V.
    const net = (p: Project) => computeConnectivity(p).nets.find((n) => n.pins.some((x) => x.pin === "1" && p.components.find((c) => c.id === x.componentId)?.ref === "R1"))!
    expect(net(before).name).toBe("5V")
    const r = tidySchematic(before)
    expect(r.ok).toBe(true)
    expect(net(r.project).name).toBe("5V")
    // VCC is still drawn on the net, so the merge Checks warns about is still there to see.
    expect(computeConnectivity(r.project).conflicts.map((c) => c.names)).toEqual([["5V", "VCC"]])
    expect(r.renamed).toEqual({})
    expect(r.dropped).toEqual([])
    expect(r.project.zones.map((z) => z.net)).toEqual(["5V"])
    expect(r.project.vias.map((v) => v.net)).toEqual(["5V"])
    expectSameNetlist(before, r.project, r.renamed)
    expect(overlaps(r.project)).toEqual([])
    expect(tidySchematic(r.project).changed).toBe(false)
    const out = runTool(before, "tidy_schematic", {})
    expect(out.result).not.toMatch(/is now/)
  })

  it("deletes no label of a net with three names", () => {
    const d = new Designer("three", rng(7))
    const r1 = d.add("resistor", { value: "10k" })
    const r2 = d.add("resistor", { value: "10k" })
    const port = d.add("power", { net: "3V3" })
    d.wire(port, "1", r1, "1")
    d.label(r1, "1", "EN_A")
    d.label(r2, "1", "PULLUP")
    d.wire(r1, "1", r2, "1")
    d.label(r1, "2", "OUT")
    d.label(r2, "2", "GND")
    const before = d.project
    const names = (p: Project) => computeConnectivity(p).conflicts.flatMap((c) => c.names).sort()
    expect(names(before)).toEqual(["3V3", "EN_A", "PULLUP"])
    const r = tidySchematic(before)
    expect(r.ok).toBe(true)
    expect(names(r.project)).toEqual(["3V3", "EN_A", "PULLUP"])
    expect(r.project.labels.map((l) => l.name)).toEqual(expect.arrayContaining(["EN_A", "PULLUP"]))
    expectSameNetlist(before, r.project, r.renamed)
    expect(overlaps(r.project)).toEqual([])
    expect(tidySchematic(r.project).changed).toBe(false)
  })

  it("moves a pour and a stitching via with a net it names", () => {
    const d = new Designer("follow", rng(3))
    const u = d.add("ne555")
    const r = d.add("resistor", { value: "1k" })
    d.wire(u, "3", r, "1")
    d.label(r, "2", "OUT")
    for (const pin of ["8", "4"]) d.label(u, pin, "5V")
    d.label(u, "1", "GND")
    d.block("TIMER")
    const led = d.add("led")
    d.wire(led, "1", u, "3")
    d.label(led, "2", "GND")
    d.block("LED")
    const old = computeConnectivity(d.project).nets.find((n) => n.pins.some((x) => x.componentId === u.id && x.pin === "3"))!.name
    const before: Project = {
      ...d.project,
      zones: [{ id: "z1", net: old, layer: "bottom" }],
      vias: [{ id: "v1", x: 1, y: 1, diameter: 0.6, drill: 0.3, net: old }],
    }
    const t = tidySchematic(before)
    expect(t.ok).toBe(true)
    const now = t.renamed[old]
    expect(now).toBe("U1_OUT")
    expect(t.project.zones[0].net).toBe(now)
    expect(t.project.vias[0].net).toBe(now)
    expect(t.message).toContain("Named 1 unnamed net for its label.")
  })

  it("names an unnamed net it has to label after its most telling pin", () => {
    const d = new Designer("unnamed", rng(2))
    const u = d.add("ne555")
    const r = d.add("resistor", { value: "1k" })
    d.wire(u, "3", r, "1")
    d.label(r, "2", "OUT")
    for (const pin of ["8", "4"]) d.label(u, pin, "5V")
    d.label(u, "1", "GND")
    d.block("TIMER")
    // A part of the net in another block: the net leaves its block, so it needs a label.
    const led = d.add("led")
    d.wire(led, "1", u, "3")
    d.label(led, "2", "GND")
    d.block("LED")
    const t = tidySchematic(d.project)
    expect(t.ok).toBe(true)
    expect(Object.values(t.renamed)).toContain("U1_OUT")
    expect(t.project.labels.filter((l) => l.name === "U1_OUT").length).toBeGreaterThanOrEqual(2)
  })
})

describe("what reaches no part", () => {
  it("is kept as drawn, below the blocks, and said", () => {
    const d = new Designer("loose", rng(4))
    const r1 = d.add("resistor", { value: "10k" })
    const r2 = d.add("resistor", { value: "10k" })
    d.wire(r1, "2", r2, "1")
    d.label(r1, "1", "IN")
    d.label(r2, "2", "GND")
    d.block("DIVIDER")
    let p = d.project
    // A label, a port and a wire on their own, drawn by hand and touching nothing.
    p = { ...p, labels: [...p.labels, { id: "lone_label", name: "SPARE", x: 40, y: 30, rot: 0 }] }
    p = { ...p, wires: [...p.wires, { id: "lone_wire", points: [{ x: -20, y: 5 }, { x: -18, y: 5 }] }] }
    const port = d.add("power", { net: "3V3" })
    p = { ...p, components: [...p.components, { ...port, sch: { x: 30, y: 40, rot: 0 } }] }
    const r = tidySchematic(p)
    expect(r.ok).toBe(true)
    expect(r.loose).toEqual({ wires: 1, labels: 1, ports: 1 })
    expect(r.message).toContain("Kept 1 label, 1 port and 1 wire that reach no part, below the blocks.")
    const label = r.project.labels.find((l) => l.id === "lone_label")!
    const wire = r.project.wires.find((w) => w.id === "lone_wire")!
    const kept = r.project.components.find((c) => c.id === port.id)!
    expect(label.name).toBe("SPARE")
    expect(kept.props.net).toBe("3V3")
    // Drawn as they were, moved whole: the wire keeps its length and the label its turn.
    expect(Math.abs(wire.points[1].x - wire.points[0].x)).toBeCloseTo(2)
    expect(label.rot).toBe(0)
    const bottom = Math.min(...blockFrames(r.project).map((f) => f.box.minY))
    expect(label.y).toBeLessThan(bottom)
    expect(wire.points[0].y).toBeLessThan(bottom)
    expect(kept.sch.y).toBeLessThan(bottom)
    expectSameNetlist(p, r.project, r.renamed)
    expect(overlaps(r.project)).toEqual([])
    expect(tidySchematic(r.project).changed).toBe(false)
  })
})

describe("a wire from a pin to nowhere", () => {
  it("is kept and counted, not dropped", () => {
    const d = new Designer("stub", rng(8))
    const r1 = d.add("resistor", { value: "10k" })
    d.label(r1, "1", "IN")
    d.block("ONE")
    let p = d.project
    const pin = schematicPins(p.components.find((c) => c.id === r1.id)!).find((x) => x.pin === "2")!
    p = { ...p, wires: [...p.wires, { id: "stub", points: [pin.pos, { x: pin.pos.x + 0.5, y: pin.pos.y }] }] }
    const r = tidySchematic(p)
    expect(r.ok).toBe(true)
    expect(r.loose.wires).toBe(1)
    expect(r.message).toContain("Kept 1 wire that reaches no part, below the blocks.")
    expect(r.project.wires.find((w) => w.id === "stub")).toBeDefined()
    expectSameNetlist(p, r.project, r.renamed)
    expect(tidySchematic(r.project).changed).toBe(false)
  })
})

describe("one block, on a sheet drawn by hand", () => {
  const hand = (name: string) => parseProjectFile(fixture(`./fixtures/hand-drawn/${name}.json`), origin)
  const wireKey = (w: Project["wires"][number]) => w.points.map((q) => `${q.x},${q.y}`).join(" ")

  it("cuts the drawing at the first junction, and labels the wire left there", () => {
    // R1 in block A, wired to a junction that R2 and R3 in block B hang off.
    const d = new Designer("cut", rng(6))
    const r1 = d.add("resistor", { value: "1k" })
    const r2 = d.add("resistor", { value: "1k" })
    const r3 = d.add("resistor", { value: "1k" })
    for (const [c, n] of [[r1, "A_IN"], [r2, "B_IN"], [r3, "C_IN"]] as const) d.label(c, "1", n)
    let p = d.project
    const pin = (c: typeof r1, n: string) => schematicPins(p.components.find((x) => x.id === c.id)!).find((x) => x.pin === n)!.pos
    const j = { x: pin(r2, "2").x, y: -3 }
    p = {
      ...p,
      wires: [
        ...p.wires,
        { id: "wa", points: [pin(r1, "2"), { x: pin(r1, "2").x, y: -3 }, j] },
        { id: "wb", points: [pin(r2, "2"), j] },
        { id: "wc", points: [j, { x: pin(r3, "2").x, y: -3 }, pin(r3, "2")] },
      ],
    }
    p = createBlock(p, "A", [r1.id]).project
    p = createBlock(p, "B", [r2.id, r3.id]).project
    const r = tidySchematic(p, { blockId: p.blocks!.find((b) => b.name === "A")!.id })
    expect(r.ok).toBe(true)
    expectSameNetlist(p, r.project, r.renamed)
    // The wires on B's side of the junction are as they were; one label stands at the junction.
    const keys = new Set(r.project.wires.map(wireKey))
    expect(keys.has(wireKey(p.wires.find((w) => w.id === "wb")!))).toBe(true)
    expect(keys.has(wireKey(p.wires.find((w) => w.id === "wc")!))).toBe(true)
    expect(r.project.labels.filter((l) => l.x === j.x && l.y === j.y)).toHaveLength(1)
    expect(tidySchematic(r.project, { blockId: p.blocks!.find((b) => b.name === "A")!.id }).changed).toBe(false)
  })

  it("leaves the rest of a hand-drawn sheet alone when Sakura adds an LED to a chip's free pin", () => {
    const start = hand("node")
    const u1 = start.components.find((c) => c.ref === "U1")!
    const conn = computeConnectivity(start)
    const free = schematicPins(u1).find((x) => !conn.pinNet.get(pinKey(u1.id, x.pin)) && findPart(u1.partId)!.pins.find((y) => y.number === x.pin)?.kind !== "nc")!
    let now = start
    const r = addComponent(now, "resistor", { sch: { x: 60, y: -40, rot: 0 }, props: { value: "1k" } })
    now = r.project
    const led = addComponent(now, "led", { sch: { x: 63, y: -40, rot: 0 } })
    now = led.project
    now = runTool(now, "connect", { pins: [`${r.component.ref}.2`, `${led.component.ref}.1`] }).project
    now = runTool(now, "connect", { pins: [`${led.component.ref}.2`], net_name: "GND" }).project
    now = runTool(now, "connect", { pins: [`${r.component.ref}.1`, `U1.${free.pin}`] }).project
    now = createBlock(now, "STATUS", [r.component.id, led.component.id]).project
    const out = runTool(now, "tidy_schematic", {}, { start })
    expect(out.isError).toBe(false)
    expect(out.summary).toBe("Tidied STATUS.")
    for (const c of start.components) expect(out.project.components.find((x) => x.id === c.id)?.sch).toEqual(c.sch)
    const kept = new Set(out.project.wires.map(wireKey))
    expect(start.wires.filter((w) => !kept.has(wireKey(w)))).toEqual([])
  })

  it("tidies a block of a hand-drawn sheet once and for all", () => {
    const p = hand("blinker")
    const id = p.blocks!.find((b) => b.name === "555 TIMER")!.id
    const r = tidySchematic(p, { blockId: id })
    expect(r.ok).toBe(true)
    expectSameNetlist(p, r.project, r.renamed)
    expect(overlaps(r.project)).toEqual([])
    expect(tidySchematic(r.project, { blockId: id }).message).toBe("Already tidy.")
  })
})

describe("one block, with a port shared", () => {
  it("keeps a shared port with the wire it still has, and leaves no port floating", () => {
    const d = new Designer("shared", rng(5))
    const r1 = d.add("resistor", { value: "1k" })
    d.label(r1, "1", "A_IN")
    const r2 = d.add("resistor", { value: "1k" })
    d.label(r2, "1", "B_IN")
    const gnd = d.add("ground")
    d.wire(gnd, "1", r1, "2")
    d.wire(gnd, "1", r2, "2")
    let p = createBlock(d.project, "A", [r1.id]).project
    p = createBlock(p, "B", [r2.id]).project
    const blockA = p.blocks!.find((b) => b.name === "A")!
    const r = tidySchematic(p, { blockId: blockA.id })
    expect(r.ok).toBe(true)
    expectSameNetlist(p, r.project, r.renamed)
    // R2's ground pin is on a ground port, not a label.
    expect(r.project.labels.some((l) => l.name === "GND")).toBe(false)
    const conn = computeConnectivity(r.project)
    const r2gnd = conn.pinNet.get(pinKey(r2.id, "2"))
    const portsOnR2 = r.project.components.filter((c) => c.partId === "ground" && conn.pinNet.get(pinKey(c.id, "1")) === r2gnd)
    expect(portsOnR2.length).toBeGreaterThanOrEqual(1)
    // Every port is drawn to a part: none floats on its own.
    const islands = drawnIslands(r.project)
    for (const comps of islands.components.values()) {
      const ids = [...comps]
      if (ids.some((id) => r.project.components.find((c) => c.id === id)!.partId === "ground")) {
        expect(ids.some((id) => isPhysical(findPart(r.project.components.find((c) => c.id === id)!.partId)))).toBe(true)
      }
    }
    expect(overlaps(r.project)).toEqual([])
  })
})

describe("one block, tidied again and again", () => {
  /** Islands of wires, labels and ports that reach no physical part, as what they hold. */
  const strays = (p: Project) => {
    const isl = drawnIslands(p)
    const byId = new Map(p.components.map((c) => [c.id, c]))
    const out: string[] = []
    for (const root of new Set([...isl.components.keys(), ...isl.wires.keys(), ...isl.labels.keys()])) {
      const comps = [...(isl.components.get(root) ?? [])]
      if (comps.some((id) => isPhysical(findPart(byId.get(id)!.partId)))) continue
      const labels = (isl.labels.get(root) ?? []).map((id) => p.labels.find((l) => l.id === id)!.name)
      out.push(`${(isl.wires.get(root) ?? []).length} wires ${labels.sort().join("+")} ${comps.map((id) => byId.get(id)!.props.net ?? "").join("+")}`)
    }
    return out.sort()
  }
  /** Every name each net has, by its pins: what Checks shows. */
  const names = (p: Project) => {
    const conn = computeConnectivity(p)
    return conn.conflicts.map((c) => [...c.names].sort().join("+")).sort()
  }
  const reversed = (p: Project): Project => ({ ...p, components: [...p.components].reverse() })

  it("leaves no labels behind on a net with two names, however often it runs", () => {
    // R1 in block ONE and R2 in block TWO, wired together, labelled X1 at R1 and X2 at R2.
    const d = new Designer("two names", rng(12))
    const r1 = d.add("resistor", { value: "1k" })
    d.label(r1, "1", "A")
    d.block("ONE")
    const r2 = d.add("resistor", { value: "1k" })
    d.label(r2, "1", "B")
    d.block("TWO")
    d.wire(r1, "2", r2, "2")
    d.label(r1, "2", "X1")
    d.label(r2, "2", "X2")
    const start = d.project
    const one = start.blocks!.find((b) => b.name === "ONE")!.id
    let p = start
    const first = tidySchematic(p, { blockId: one })
    expect(first.changed).toBe(true)
    p = first.project
    for (let i = 0; i < 4; i++) {
      const again = tidySchematic(p, { blockId: one })
      expect(again.message).toBe("Already tidy.")
      p = again.project
    }
    expect(strays(p)).toEqual([])
    expect(names(p)).toEqual(names(start))
    expectSameNetlist(start, p, first.renamed)
  })

  it("strands no port where a chip pin has two wires, in either part order", () => {
    // 555 pin 8 wired to a 5V port and to a capacitor, both meeting at the pin.
    const d = new Designer("junction", rng(21))
    const u = d.add("ne555")
    const c = d.add("capacitor", { value: "100nF" })
    const vcc = d.add("power", { net: "5V" })
    const gnd = d.add("ground")
    d.label(u, "1", "GND")
    d.label(u, "3", "OUT")
    d.label(u, "4", "5V")
    let p = d.project
    const pin = (id: string, n: string) => schematicPins(p.components.find((x) => x.id === id)!).find((x) => x.pin === n)!.pos
    const [p8, c1, c2, v, g] = [pin(u.id, "8"), pin(c.id, "1"), pin(c.id, "2"), pin(vcc.id, "1"), pin(gnd.id, "1")]
    p = {
      ...p,
      wires: [
        ...p.wires,
        { id: "a", points: [p8, { x: p8.x, y: v.y }, v] },
        { id: "b", points: [p8, { x: c1.x, y: p8.y }, c1] },
        { id: "c", points: [c2, { x: c2.x, y: g.y }, g] },
      ],
      blocks: [{ id: "b1", name: "TIMER", components: [u.id, c.id] }],
    }
    const results = [p, reversed(p)].map((sheet) => {
      const r = tidySchematic(sheet, { blockId: "b1" })
      expect(r.ok).toBe(true)
      expect(strays(r.project)).toEqual([])
      expect(r.loose).toEqual({ wires: 0, labels: 0, ports: 0 })
      expectSameNetlist(sheet, r.project, r.renamed)
      expect(tidySchematic(r.project, { blockId: "b1" }).message).toBe("Already tidy.")
      return drawing(r.project)
    })
    expect(results[1]).toEqual(results[0])
  })

  it("keeps a stub off a labelled pin, and counts it, whole sheet or one block", () => {
    const d = new Designer("stubs", rng(13))
    const r1 = d.add("resistor", { value: "10k" })
    const r2 = d.add("resistor", { value: "10k" })
    d.label(r1, "1", "IN")
    d.wire(r1, "2", r2, "1")
    d.label(r2, "2", "GND")
    d.block("A")
    let p = d.project
    const at = schematicPins(p.components.find((x) => x.id === r1.id)!).find((x) => x.pin === "1")!.pos
    // A wire off the labelled pin that turns and ends in nothing: two wires to nowhere.
    p = {
      ...p,
      wires: [...p.wires, { id: "t1", points: [at, { x: at.x, y: at.y - 1 }] }, { id: "t2", points: [{ x: at.x, y: at.y - 1 }, { x: at.x + 1, y: at.y - 1 }] }],
    }
    for (const sheet of [p, reversed(p)]) {
      const whole = tidySchematic(sheet)
      expect(whole.ok).toBe(true)
      expect(whole.loose.wires).toBe(2)
      expect(whole.message).toContain("Kept 2 wires that reach no part, below the blocks.")
      expect(whole.project.wires.filter((w) => w.id === "t1" || w.id === "t2")).toHaveLength(2)
      expect(strays(whole.project)).toEqual(["2 wires  "])
      expectSameNetlist(sheet, whole.project, whole.renamed)
      expect(tidySchematic(whole.project).changed).toBe(false)

      const one = tidySchematic(sheet, { blockId: sheet.blocks![0].id })
      expect(one.ok).toBe(true)
      // The stub stays where it was drawn, and is said; the old IN label goes with the pin's wire.
      expect(one.loose).toEqual({ wires: 2, labels: 0, ports: 0 })
      expect(one.message).toContain("Kept 2 wires that reach no part, where they were drawn.")
      expect(strays(one.project)).toEqual(["2 wires  "])
      expectSameNetlist(sheet, one.project, one.renamed)
      expect(tidySchematic(one.project, { blockId: sheet.blocks![0].id }).message).toBe("Already tidy.")
    }
  })

  it("puts what it adds at a cut where there is room, never over another", () => {
    for (let seed = 101; seed <= 110; seed++) {
      const p = randomDesign(seed, 2 + ((seed - 101) % 6))
      const before = new Set(overlaps(p))
      for (const b of p.blocks ?? []) {
        const r = tidySchematic(p, { blockId: b.id })
        expect(r.ok).toBe(true)
        expect(overlaps(r.project).filter((o) => !before.has(o))).toEqual([])
        expect(strays(r.project)).toEqual(strays(p))
      }
    }
  })
})

describe("a chip's supply with two names", () => {
  const variants: [string, (d: Designer, u: ReturnType<Designer["add"]>) => void][] = [
    ["a VCC port and a 5V port", (d, u) => {
      d.wire(d.add("power", { net: "VCC" }), "1", u, "8")
      d.wire(d.add("power", { net: "5V" }), "1", u, "4")
      d.wire(u, "8", u, "4")
    }],
    ["a VCC label and a 5V port", (d, u) => {
      d.label(u, "8", "VCC")
      d.wire(d.add("power", { net: "5V" }), "1", u, "4")
      d.wire(u, "8", u, "4")
    }],
    ["two ports and a label", (d, u) => {
      d.wire(d.add("power", { net: "VCC" }), "1", u, "8")
      d.wire(d.add("power", { net: "5V" }), "1", u, "4")
      d.wire(u, "8", u, "4")
      d.label(u, "8", "VBUS")
    }],
    ["a VCC port and a 5V label on pin 8", (d, u) => {
      d.wire(d.add("power", { net: "VCC" }), "1", u, "8")
      d.label(u, "8", "5V")
      d.label(u, "4", "5V")
    }],
    ["two labels on pin 8", (d, u) => {
      d.label(u, "8", "5V")
      d.label(u, "8", "VCC")
      d.label(u, "4", "5V")
    }],
  ]
  it.each(variants)("tidies, every name kept: %s", (_, make) => {
    const d = new Designer("names", rng(31))
    const u = d.add("ne555")
    d.label(u, "1", "GND")
    d.label(u, "3", "OUT")
    make(d, u)
    d.block("T")
    const p = d.project
    const conflicts = (x: Project) => computeConnectivity(x).conflicts.map((c) => [...c.names].sort().join("+")).sort()
    for (const opts of [{}, { blockId: p.blocks![0].id }]) {
      const r = tidySchematic(p, opts)
      expect(r.ok).toBe(true)
      expect(r.dropped).toEqual([])
      expect(conflicts(r.project)).toEqual(conflicts(p))
      expectSameNetlist(p, r.project, r.renamed)
      expect(overlaps(r.project)).toEqual([])
      expect(tidySchematic(r.project, opts).changed).toBe(false)
    }
  })
})

describe("drawn as an engineer would", () => {
  const example = (id: string) => tidySchematic(normalizeProject(structuredClone(EXAMPLES.find((e) => e.id === id)!.project))).project
  /** Whether the pins of these parts on a net are joined by wires alone: no label, no port between. */
  const wiredWhole = (p: Project, net: string, refs: string[]) => {
    const conn = computeConnectivity(p)
    const id = conn.nets.find((n) => n.name === net)!.id
    const keys = p.components
      .filter((c) => refs.includes(c.ref))
      .flatMap((c) => schematicPins(c).map((x) => pinKey(c.id, x.pin)))
      .filter((k) => conn.pinNet.get(k) === id)
    const bare = computeConnectivity({ ...p, labels: [], components: p.components.filter((c) => isPhysical(findPart(c.partId))) })
    return keys.length >= refs.length && new Set(keys.map((k) => bare.pinNet.get(k))).size === 1
  }

  it("wires a supply's path in a line: connector, diode, regulator and its capacitors", () => {
    const node = example("node")
    expect(wiredWhole(node, "VRAW", ["J1", "D1"])).toBe(true)
    expect(wiredWhole(node, "VIN", ["D1", "U2"])).toBe(true)
    expect(wiredWhole(node, "5V", ["U2", "C2", "C3"])).toBe(true)
    const robot = example("esp32-robot")
    expect(wiredWhole(robot, "VBAT", ["D1", "U3", "C2"])).toBe(true)
    expect(wiredWhole(robot, "5V", ["U3", "C1"])).toBe(true)
  })

  it("ships no port drawn to nothing, and stands every capacitor from a supply to ground upright", () => {
    for (const ex of EXAMPLES) {
      const p = normalizeProject(structuredClone(ex.project))
      const islands = drawnIslands(p)
      for (const comps of islands.components.values()) {
        const parts = [...comps].map((id) => p.components.find((c) => c.id === id)!)
        if (parts.some((c) => findPart(c.partId)?.powerNet)) expect(parts.some((c) => isPhysical(findPart(c.partId))), ex.id).toBe(true)
      }
      const conn = computeConnectivity(p)
      const rail = (c: (typeof p.components)[number], pin: string) => {
        const n = conn.nets.find((x) => x.id === conn.pinNet.get(pinKey(c.id, pin)))?.name ?? ""
        return /GND/.test(n) ? "ground" : /^(\d|V|\+)/.test(n) ? "supply" : ""
      }
      for (const c of p.components) {
        if (!/^C\d/.test(c.ref)) continue
        const pins = schematicPins(c)
        const ground = pins.find((x) => rail(c, x.pin) === "ground")
        if (pins.length !== 2 || !ground || !pins.some((x) => rail(c, x.pin) === "supply")) continue
        expect(ground.dir, `${ex.id} ${c.ref}`).toBe("down")
      }
    }
  })

  it("labels read across, not down", () => {
    for (const id of ["node", "esp32-robot", "blinker", "mcu", "regulator"]) expect(example(id).labels.filter((l) => l.rot === 90 || l.rot === 270)).toEqual([])
  })

  it("wires a crystal to its pins, its load capacitors hanging to ground", () => {
    const node = example("node")
    expect(wiredWhole(node, "XTAL1", ["U1", "Y1", "C4"])).toBe(true)
    expect(wiredWhole(node, "XTAL2", ["U1", "Y1", "C5"])).toBe(true)
    const mcu = example("mcu")
    expect(wiredWhole(mcu, "XTAL1", ["U1", "Y1", "C1"])).toBe(true)
    expect(wiredWhole(mcu, "XTAL2", ["U1", "Y1", "C2"])).toBe(true)
  })

  it("wires a reset pin's pull-up and button to it, under one label", () => {
    const node = example("node")
    expect(wiredWhole(node, "RESET", ["U1", "R2", "SW1"])).toBe(true)
    const mcuBlock = blockFrames(node).find((f) => f.name === "MCU")!.box
    const inside = (l: { x: number; y: number }) => l.x >= mcuBlock.minX && l.x <= mcuBlock.maxX && l.y >= mcuBlock.minY && l.y <= mcuBlock.maxY
    expect(node.labels.filter((l) => l.name === "RESET" && inside(l))).toHaveLength(1)
    expect(wiredWhole(example("mcu"), "RESET", ["U1", "R1", "SW1"])).toBe(true)
  })

  it("hangs the capacitors of a wired supply off its wire", () => {
    const node = example("node")
    expect(wiredWhole(node, "5V", ["U1", "C6", "C7"])).toBe(true)
    expect(wiredWhole(node, "VIN", ["D1", "U2", "C1"])).toBe(true)
    expect(wiredWhole(example("mcu"), "5V", ["U1", "C3", "C4"])).toBe(true)
  })

  it("draws a 555's timing parts side by side, wired, with no label between them", () => {
    const blinker = example("blinker")
    expect(wiredWhole(blinker, "DIS", ["U1", "R2", "R3"])).toBe(true)
    expect(wiredWhole(blinker, "THR", ["U1", "R3", "C1"])).toBe(true)
  })

  it("stands ground ports upright, on a stub that bends where it must", () => {
    // A ground port at rot 0 hangs below the point it stands on.
    const grounds = (p: Project) => p.components.filter((c) => c.partId === "ground")
    expect(grounds(example("mcu")).filter((c) => c.sch.rot !== 0).map((c) => c.ref)).toEqual([])
    const node = example("node")
    const mcuBlock = blockFrames(node).find((f) => f.name === "MCU")!.box
    expect(grounds(node).filter((c) => c.sch.x > mcuBlock.minX && c.sch.x < mcuBlock.maxX && c.sch.y > mcuBlock.minY && c.sch.y < mcuBlock.maxY && c.sch.rot !== 0)).toEqual([])
  })

  it("puts a short frame under another rather than alone on a row", () => {
    const robot = example("esp32-robot")
    const frames = blockFrames(robot)
    const receiver = frames.find((f) => f.name === "RECEIVER")!.box
    // Some other frame shares its height on the sheet: it is not on a row of its own.
    expect(frames.some((f) => f.name !== "RECEIVER" && f.box.maxY > receiver.minY && f.box.minY < receiver.maxY)).toBe(true)
  })
})

describe("settled in one run", () => {
  /** A tidied sheet knocked about: some parts moved half a step or a step off their wires. */
  const nudged = (p: Project, seed: number): Project => {
    const r = rng(seed)
    const pick = new Set(physicalParts(p).filter(() => r.chance(0.12)).map((c) => c.id))
    const step = () => (r.int(5) - 2) * 0.5
    return { ...p, components: p.components.map((c) => (pick.has(c.id) ? { ...c, sch: { ...c.sch, x: Math.round((c.sch.x + step()) * 10) / 10, y: Math.round((c.sch.y + step()) * 10) / 10 } } : c)) }
  }

  it("tidies a sheet with a stub off a supply pin that nothing else is on, leaving the pin on nothing", () => {
    const d = new Designer("stub", rng(3))
    const u = d.add("lm358")
    d.label(u, "3", "IN")
    d.label(u, "1", "OUT")
    d.rail(u, "4", "GND")
    const v = schematicPins(u).find((x) => x.pin === "8")!
    // V+ is on nothing but a stub: an unnamed net of one pin, which must not become a supply.
    let p = addWire(d.project, [v.pos, { x: v.pos.x, y: Math.round((v.pos.y + 0.5) * 10) / 10 }]).project
    p = createBlock(p, "AMP", [u.id]).project
    const r = tidySchematic(p)
    expect(r.problems).toEqual([])
    expect(r.ok).toBe(true)
    expectSameNetlist(p, r.project, r.renamed)
    expect(r.project.components.filter((c) => c.partId === "power")).toEqual([])
    expect(tidySchematic(r.project).changed).toBe(false)
  })

  it("tidies one block of a net with two names in two blocks once, not twice", () => {
    const d = new Designer("n2", rng(12))
    const r1 = d.add("resistor", { value: "1k" })
    d.label(r1, "1", "A")
    const r2 = d.add("resistor", { value: "1k" })
    d.label(r2, "1", "B")
    d.wire(r1, "2", r2, "2")
    d.label(r1, "2", "X1")
    d.label(r2, "2", "X2")
    let base = createBlock(d.project, "ONE", [r1.id]).project
    base = createBlock(base, "TWO", [r2.id]).project
    for (const p0 of [base, { ...base, components: [...base.components].reverse() }]) {
      for (const b of p0.blocks!) {
        const first = tidySchematic(p0, { blockId: b.id })
        expect(first.changed).toBe(true)
        const second = tidySchematic(first.project, { blockId: b.id })
        expect(second.message).toBe("Already tidy.")
      }
    }
  })

  it("tidies a knocked-about sheet once and for all", () => {
    const tidied = tidySchematic(randomDesign(7443, 2 + (7443 % 6))).project
    const r = tidySchematic(nudged(tidied, 7443))
    expect(r.ok).toBe(true)
    expect(tidySchematic(r.project).changed).toBe(false)
  })

  it("puts a wire it took out back as it was when the attempt is undone", () => {
    const space = new Space()
    const path: [number, number][] = [
      [0, 0],
      [1, 0],
      [2, 0],
      [2, 1],
    ]
    space.addWire(path, "n")
    space.commit()
    const mark = space.mark()
    space.removeWire(path, "n")
    expect(space.nodes.size).toBe(0)
    space.rollback(mark)
    expect([...space.nodes.values()].map((n) => [n.ends, n.through])).toEqual([
      [1, 0],
      [0, 1],
      [0, 1],
      [1, 0],
    ])
    expect(space.hEdges.size + space.vEdges.size).toBe(3)
  })

  it("tidies a knocked-about sheet whose label on a wire of its own moves while parts are tried", () => {
    // randomDesign(9026), tidied, then knocked about (nudge 5180): a label of D4_A found room on a
    // wire of its own; moving it for a part tried and refused took the wire out, and putting it
    // back left it out, so the next move found no wire and every way of drawing it threw.
    const p = parseProjectFile(fixture("./fixtures/tidy-repro/random-9026-nudged.json"), origin)
    const r = tidySchematic(p)
    expect(r.problems).toEqual([])
    expect(r.ok).toBe(true)
    expectSameNetlist(p, r.project, r.renamed)
    expect(tidySchematic(r.project).changed).toBe(false)
  })

  it("stows what reaches no part the same way twice, an island on the row's edge included", () => {
    // The hand-drawn node, parts in reverse order, tidied, then knocked about (nudge 5191): an
    // island of what reaches no part just fit at the end of its row by a hair of float error the
    // first time and not the second, so every island after it moved.
    const p = parseProjectFile(fixture("./fixtures/tidy-repro/hand-node-nudged.json"), origin)
    const r = tidySchematic(p)
    expect(r.ok).toBe(true)
    expect(tidySchematic(r.project).changed).toBe(false)
  })

  it("never lays a label over the wire it found its own way out on", () => {
    // The imu board, parts in reverse order, tidied, knocked about (seed 7011): BOOT0's label found
    // room only at the end of a way out that doubled back under it.
    const p = parseProjectFile(fixture("./fixtures/tidy-repro/imu-nudged.json"), origin)
    const r = tidySchematic(p)
    expect(r.ok).toBe(true)
    expect(wireProblems(r.project).through).toEqual([])
    expect(overlaps(r.project)).toEqual([])
    expect(tidySchematic(r.project).changed).toBe(false)
  })

  it("places parts the same whether the nets it named have their names yet or not", () => {
    // A name a tidy gave a net counts for nothing in where the next one puts things.
    for (const seed of [14, 23, 28]) {
      const r = tidySchematic(randomDesign(seed, 2 + (seed % 5)))
      expect(r.ok).toBe(true)
      expect(tidySchematic(r.project).changed, `seed ${seed}`).toBe(false)
    }
  })
})

describe("sort order", () => {
  it("is one fixed language's, whatever the browser speaks", async () => {
    const Real = Intl.Collator
    const languages: unknown[] = []
    const spy = vi.spyOn(Intl, "Collator").mockImplementation(function (locales?: string | string[], options?: Intl.CollatorOptions) {
      languages.push(locales)
      return new Real(locales, options)
    } as typeof Intl.Collator)
    try {
      vi.resetModules()
      await import("../src/lib/natural")
      await import("../src/model/connectivity")
    } finally {
      spy.mockRestore()
    }
    expect(languages.length).toBeGreaterThan(0)
    expect(languages.every((l) => l === "en")).toBe(true)
  })
})

describe("block ports", () => {
  it("are the nets crossing a block's frame, facing by pin kind and flow", () => {
    const p = tidySchematic(parseProjectFile(fixture("./fixtures/blog-boards/esp32-usb-c-sensor.json"), origin)).project
    const ldo = p.blocks!.find((b) => b.name === "LDO_BLK")!
    const ports = blockPorts(p, ldo.id)
    const byName = new Map(ports.map((x) => [x.name, x]))
    expect(byName.get("GND")?.direction).toBe("ground")
    expect(byName.get("V3_3")?.direction).toBe("power")
    const i2c = p.blocks!.find((b) => b.name === "I2C_BLK")!
    const sda = blockPorts(p, i2c.id).find((x) => x.name === "SDA")
    expect(sda?.group).toBe("I2C")
  })
})

describe("speed", () => {
  /**
   * The fastest of a few runs, after one to warm up: wall-clock time, and the CPU time of this
   * thread alone, which other test files running at once on the same cores don't inflate. The
   * budget is held on the CPU time, the work a tidy takes; on an idle machine the two agree.
   */
  const measure = (f: () => void, n = 5) => {
    f()
    let wall = Infinity
    let cpu = Infinity
    for (let i = 0; i < n; i++) {
      const c0 = process.threadCpuUsage()
      const t0 = performance.now()
      f()
      wall = Math.min(wall, performance.now() - t0)
      const c = process.threadCpuUsage(c0)
      cpu = Math.min(cpu, (c.user + c.system) / 1000)
    }
    return { wall, cpu }
  }

  it("tidies the 38-part ATmega example in under 150 ms", () => {
    const p = normalizeProject(structuredClone(EXAMPLES.find((e) => e.id === "node")!.project))
    expect(physicalParts(p)).toHaveLength(38)
    // Every tidy lays the sheet out from scratch, whether it was tidy before or not.
    const { wall, cpu } = measure(() => tidySchematic(p))
    console.log(`38-part example: ${cpu.toFixed(0)} ms CPU, ${wall.toFixed(0)} ms wall`)
    expect(cpu).toBeLessThan(150)
  })

  it("tidies a 150-part design in under a second", () => {
    const p = largeDesign(150)
    expect(physicalParts(p).length).toBeGreaterThanOrEqual(150)
    const { wall, cpu } = measure(() => tidySchematic(p), 3)
    console.log(`${physicalParts(p).length}-part design: ${cpu.toFixed(0)} ms CPU, ${wall.toFixed(0)} ms wall`)
    expect(cpu).toBeLessThan(1000)
  })
})

describe("after Tidy", () => {
  const sheet = () => parseProjectFile(fixture("./fixtures/blog-boards/buck-24v-5v3a.json"), origin)

  it("is one undo step, and redo puts it back", () => {
    useProjectStore.getState().open(sheet())
    const before = useProjectStore.getState().project!
    const r = tidySelected()
    expect(r.changed).toBe(true)
    const after = useProjectStore.getState().project!
    expect(after).toBe(r.project)
    useProjectStore.getState().undo()
    expect(useProjectStore.getState().project).toBe(before)
    useProjectStore.getState().redo()
    expect(useProjectStore.getState().project).toBe(after)
  })

  it("tidies only the selected block from the toolbar", () => {
    const p = tidySchematic(sheet()).project
    useProjectStore.getState().open(p)
    const block = p.blocks!.find((b) => b.name === "LDO_BLK")!
    useUi.getState().select([`b:${block.id}`])
    expect(tidySelected().message).toBe("Already tidy.")
    useUi.getState().select([])
  })

  it("says it is working while a tidy from the toolbar runs, then what it did", async () => {
    useProjectStore.getState().open(sheet())
    useUi.getState().select([])
    const seen: string[] = []
    const offBusy = onTidyBusy((b) => seen.push(b ? "busy" : "idle"))
    const offDone = onTidy((r) => seen.push(r.message.split(".")[0]))
    const done = new Promise<void>((resolve) => {
      const off = onTidyBusy((b) => {
        if (!b) {
          off()
          resolve()
        }
      })
    })
    startTidy()
    // Not yet: the page gets to draw the busy state first.
    expect(seen).toEqual(["busy"])
    await done
    offBusy()
    offDone()
    expect(seen[0]).toBe("busy")
    expect(seen[1]).toMatch(/^Tidied \d+ parts into 7 blocks$/)
    expect(seen[2]).toBe("idle")
  })

  it("stops a tidy whose worker takes too long, and shuts the worker down with the editor", async () => {
    const made: { terminated: boolean; onmessage: unknown; onerror: unknown }[] = []
    class SilentWorker {
      onmessage: unknown = null
      onerror: unknown = null
      terminated = false
      constructor() {
        made.push(this)
      }
      postMessage() {}
      terminate() {
        this.terminated = true
      }
    }
    const scope = globalThis as unknown as { Worker?: unknown }
    const saved = scope.Worker
    scope.Worker = SilentWorker
    const busy: boolean[] = []
    const offBusy = onTidyBusy((b) => busy.push(b))
    try {
      useProjectStore.getState().open(sheet())
      useUi.getState().select([])
      const before = useProjectStore.getState().project
      const seen: string[] = []
      const off = onTidy((r) => seen.push(r.message))
      const done = new Promise<void>((resolve) => {
        const o = onTidyBusy((b) => {
          if (!b) {
            o()
            resolve()
          }
        })
      })
      startTidy(20)
      await done
      off()
      expect(seen).toEqual(["Tidy took too long and was stopped; nothing was changed."])
      expect(useProjectStore.getState().project).toBe(before)
      expect(made[0].terminated).toBe(true)
      // Its handlers are unhooked, so a reply already on its way is never heard.
      expect(made[0].onmessage).toBeNull()
      expect(made[0].onerror).toBeNull()
      // The next tidy gets a new worker; the editor closing stops it, and the button comes back.
      startTidy()
      expect(made).toHaveLength(2)
      stopTidy()
      expect(made[1].terminated).toBe(true)
      expect(busy).toEqual([true, false, true, false])
    } finally {
      offBusy()
      stopTidy()
      scope.Worker = saved
    }
  })

  it("brings a tidied block into view when it moved out of it", () => {
    const t = { scale: 100, tx: 0, ty: 0 }
    const size = { width: 800, height: 600 }
    // Screen y runs down from world y = 0, so this frame is on screen.
    expect(viewForBlock({ minX: 1, minY: -4, maxX: 3, maxY: -1 }, t, size)).toEqual({ kind: "none" })
    // Off to the right, small enough to show at this zoom: centred on it, the zoom kept.
    expect(viewForBlock({ minX: 20, minY: -4, maxX: 22, maxY: -1 }, t, size)).toEqual({ kind: "center", at: { x: 21, y: -2.5 }, scale: 100 })
    // Too big for the screen at this zoom: fitted.
    expect(viewForBlock({ minX: 20, minY: -40, maxX: 40, maxY: -1 }, t, size)).toEqual({ kind: "fit" })
  })

  it("tidies in a worker as it does on the page, the project going there and back as a file", async () => {
    const replies: TidyReply[] = []
    const scope = globalThis as unknown as { onmessage: ((e: { data: TidyRequest }) => void) | null; postMessage: (r: TidyReply) => void }
    const saved = { onmessage: scope.onmessage, postMessage: scope.postMessage }
    scope.postMessage = (r) => replies.push(r)
    try {
      await import("../src/editor/schematic/tidy.worker")
      const p = sheet()
      scope.onmessage!({ data: { file: serializeProject(p) } })
      const here = tidySchematic(p)
      const reply = replies[0]
      expect("error" in reply).toBe(false)
      if ("error" in reply) return
      expect(reply.message).toBe(here.message)
      const there = parseProjectFile(reply.project!, origin)
      expect(netlist(there)).toEqual(netlist(here.project))
      expect(there.components.map((c) => c.sch)).toEqual(here.project.components.map((c) => c.sch))
    } finally {
      scope.onmessage = saved.onmessage
      scope.postMessage = saved.postMessage
    }
  })

  it("saves and opens as it was drawn", () => {
    const r = tidySchematic(sheet())
    const reopened = parseProjectFile(serializeProject(r.project), origin)
    expect(netlist(reopened)).toEqual(netlist(r.project))
    expect({ c: reopened.components, w: reopened.wires, l: reopened.labels, b: reopened.blocks }).toEqual({ c: r.project.components, w: r.project.wires, l: r.project.labels, b: r.project.blocks })
    expect(tidySchematic(reopened).changed).toBe(false)
  })

  it("copies and pastes a tidied block, wired as the original", () => {
    const p = tidySchematic(sheet()).project
    const block = p.blocks!.find((b) => b.name === "PG_BLK")!
    const frame = blockFrames(p).find((f) => f.id === block.id)!
    const all = blockFrames(p).reduce((m, f) => Math.min(m, f.box.minY), Infinity)
    const clip = { project: p, ...selectedItems(p, [`b:${block.id}`]), blocks: [block.id] }
    // Below everything, so the copy touches nothing.
    const res = pasteItems(p, clip, { x: 0, y: Math.round((all - frame.box.maxY - 2) * 10) / 10 })
    if (!res.ok) throw new Error(res.message)
    const pasted = res.project.blocks!.find((b) => b.name !== block.name && b.name.startsWith(block.name))!
    expect(pasted.components).toHaveLength(block.components.length)
    expect(overlaps(res.project)).toEqual([])
    expect(frameProblems(res.project)).toEqual([])
    // Each copy sits on nets like its original's: wired among the copies, or on the same names.
    const conn = computeConnectivity(res.project)
    const kindOf = new Map(res.project.components.map((c) => [c.id, c.partId]))
    const shape = (ids: string[]) =>
      conn.nets
        .map((n) => n.pins.filter((x) => ids.includes(x.componentId)).map((x) => `${kindOf.get(x.componentId)}.${x.pin}`).sort().join(" "))
        .filter(Boolean)
        .sort()
    expect(shape(pasted.components)).toEqual(shape(block.components))
  })
})

describe("Sakura's tidy_schematic", () => {
  const sheet = () => parseProjectFile(fixture("./fixtures/blog-boards/buck-24v-5v3a.json"), origin)

  it("tidies the sheet, and names what it named", () => {
    const out = runTool(sheet(), "tidy_schematic", {})
    expect(out.isError).toBe(false)
    expect(out.summary).toMatch(/^Tidied \d+ parts into 7 blocks\.$/)
    expect(overlaps(out.project)).toEqual([])
  })

  it("tidies one block by name, and refuses one that isn't there", () => {
    const tidy = tidySchematic(sheet()).project
    const moved: Project = { ...tidy, components: tidy.components.map((c) => (c.ref === "R9" ? { ...c, sch: { ...c.sch, x: c.sch.x + 2 } } : c)) }
    const out = runTool(moved, "tidy_schematic", { blocks: ["pg_blk"] })
    expect(out.isError).toBe(false)
    expect(out.summary).toBe("Tidied PG_BLK.")
    const missing = runTool(moved, "tidy_schematic", { blocks: ["NOPE"] })
    expect(missing.isError).toBe(true)
    expect(missing.result).toContain("Blocks: INPUT_BLK")
  })

  it("extending a design, tidies only the blocks the request made or changed", () => {
    const start = tidySchematic(sheet()).project
    // The request adds an LED on 5V in a block of its own.
    let now = start
    const r = addComponent(now, "resistor", { sch: { x: 0, y: 20, rot: 0 }, props: { value: "1k" } })
    now = r.project
    const led = addComponent(now, "led", { sch: { x: 3, y: 20, rot: 0 } })
    now = labelPin(led.project, { componentId: r.component.id, pin: "1" }, "V5V")
    now = labelPin(now, { componentId: led.component.id, pin: "2" }, "GND")
    now = createBlock(now, "STATUS LED", [r.component.id, led.component.id]).project
    const out = runTool(now, "tidy_schematic", {}, { start })
    expect(out.isError).toBe(false)
    expect(out.summary).toBe("Tidied STATUS LED.")
    // Everything the user had stays where it was.
    for (const c of start.components) {
      if (!isPhysical(findPart(c.partId))) continue
      expect(out.project.components.find((x) => x.id === c.id)!.sch).toEqual(c.sch)
    }
    // Asked for the whole sheet, it tidies the whole sheet.
    const whole = runTool(now, "tidy_schematic", { whole_sheet: true }, { start })
    expect(whole.summary).toMatch(/^Tidied \d+ parts into 8 blocks\.$/)
    // On a sheet that was empty when the request began, the whole sheet is the request's.
    const fresh = runTool(sheet(), "tidy_schematic", {}, { start: createProject("empty") })
    expect(fresh.summary).toMatch(/^Tidied \d+ parts into 7 blocks\.$/)
    // Nothing changed in a block: it says so and leaves the sheet alone.
    const none = runTool(start, "tidy_schematic", {}, { start })
    expect(none.isError).toBe(true)
    expect(none.project).toBe(start)
  })

  it("lists each block's ports in get_design", () => {
    const design = JSON.parse(runTool(tidySchematic(sheet()).project, "get_design", {}).result)
    const ldo = design.blocks.find((b: { name: string }) => b.name === "LDO_BLK")
    expect(ldo.ports).toEqual(expect.arrayContaining([{ net: "GND", direction: "ground" }, { net: "V3V3", direction: "power" }]))
  })
})
