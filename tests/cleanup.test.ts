import { readdirSync, readFileSync } from "node:fs"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { applyCleanup, cancelCleanup, openCleanup, stopCleanup, useCleanup } from "../src/editor/schematic/cleanupAction"
import { naturalCompare } from "../src/lib/natural"
import { cleanupSheet, cleanupSummary, finishCleanup, hasParts, planCleanup } from "../src/model/cleanup"
import { groupLooseParts } from "../src/model/cleanup/group"
import { createBlock, renameBlock } from "../src/model/blocks"
import { computeConnectivity, pinKey } from "../src/model/connectivity"
import { EXAMPLES } from "../src/model/examples"
import { isPhysical, schematicPins } from "../src/model/instances"
import { findPart } from "../src/model/library"
import { addComponent, createProject, labelPin } from "../src/model/ops"
import { tidySchematic, type TidyResult } from "../src/model/tidy"
import { normalizeProject, parseProjectFile } from "../src/model/projectFile"
import { useProjectStore } from "../src/store/projectStore"
import type { Project } from "../src/model/types"
import { randomDesign } from "./tidy-designs"

// Clean up, the free version: the parts in no block grouped by how they are wired, then Tidy. The
// groups are written down below for the shipped examples with their blocks taken off, and what has
// to hold for every drawing to hand (the examples, the version-1 files, hand-drawn sheets, the blog
// boards and made-up designs) is checked on all of them: the same netlist, every part in a block,
// user blocks untouched, one undo step.

const origin = { id: "p", createdAt: 0, updatedAt: 0 }
const fixture = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8")
const BLOG = readdirSync(new URL("./fixtures/blog-boards/", import.meta.url)).filter((f) => f.endsWith(".json"))

const bare = (p: Project): Project => ({ ...p, blocks: undefined })
const example = (id: string) => bare(normalizeProject(structuredClone(EXAMPLES.find((e) => e.id === id)!.project)))

const CASES: [string, () => Project][] = [
  ...EXAMPLES.map((ex): [string, () => Project] => [`example ${ex.id}`, () => example(ex.id)]),
  ...["blinker", "imported", "sheet"].map((n): [string, () => Project] => [`v1 file ${n}`, () => bare(parseProjectFile(JSON.parse(fixture(`./fixtures/project-v1/${n}.json`)).file, origin))]),
  ...["blinker", "node"].map((n): [string, () => Project] => [`hand-drawn ${n}`, () => bare(parseProjectFile(fixture(`./fixtures/hand-drawn/${n}.json`), origin))]),
  ...BLOG.map((f): [string, () => Project] => [`blog board ${f.replace(/\.json$/, "")}`, () => bare(parseProjectFile(fixture(`./fixtures/blog-boards/${f}`), origin))]),
  ...[1, 2, 3, 4, 5, 6].map((seed): [string, () => Project] => [`made-up design ${seed}`, () => bare(randomDesign(seed, 2 + (seed % 4)))]),
]

const physical = (p: Project) => p.components.filter((c) => isPhysical(findPart(c.partId)))

/** The netlist as a partition of physical pins, each net by its name when it has one, computed from scratch. */
function netlist(p: Project) {
  const conn = computeConnectivity(p)
  const byId = new Map(conn.nets.map((n) => [n.id, n]))
  const groups = new Map<string, string[]>()
  const names = new Map<string, string>()
  for (const c of physical(p)) {
    for (const pin of schematicPins(c)) {
      const id = conn.pinNet.get(pinKey(c.id, pin.pin))
      const net = id ? byId.get(id) : undefined
      if (!net || (!net.named && net.pins.length < 2)) continue
      groups.set(net.id, [...(groups.get(net.id) ?? []), `${c.ref}.${pin.pin}`])
      if (net.named) names.set(net.id, net.name)
    }
  }
  return [...groups.entries()].map(([id, pins]) => ({ pins: pins.sort().join(" "), name: names.get(id) ?? null })).sort((a, b) => (a.pins < b.pins ? -1 : 1))
}

/** Tidy may name an unnamed net; nothing else about a net's pins or names changes. */
function expectSameNetlist(before: Project, after: Project, renamed: Record<string, string>) {
  const a = netlist(before)
  const b = netlist(after)
  expect(b.map((n) => n.pins)).toEqual(a.map((n) => n.pins))
  a.forEach((n, i) => {
    if (n.name) expect(b[i].name).toBe(renamed[n.name] ?? n.name)
  })
}

/** What each planned block holds, by designator: [name, "C1 C2 U1"], sorted by name. */
function groupsOf(project: Project): [string, string][] {
  const refOf = new Map(project.components.map((c) => [c.id, c.ref]))
  return planCleanup(project)
    .groups.map((g): [string, string] => [g.name, g.parts.map((id) => refOf.get(id)!).sort(naturalCompare).join(" ")])
    .sort((a, b) => naturalCompare(a[0], b[0]))
}

describe("what Clean up groups, on the shipped examples with their blocks taken off", () => {
  it("regulator: the LDO with its terminal and capacitors, and the power LED chain on its own", () => {
    expect(groupsOf(example("regulator"))).toEqual([
      ["LED D1", "D1 R1"],
      ["REGULATOR U1 AMS1117-3.3", "C1 C2 C3 J1 U1"],
    ])
  })

  it("blinker: the 555 with its timing parts, the LED chain on its output and the supply header", () => {
    expect(groupsOf(example("blinker"))).toEqual([["TIMER U1 NE555", "C1 C2 C3 D1 J1 R1 R2 R3 U1"]])
  })

  it("mcu: the ATmega with its decoupling, crystal and load capacitors, reset parts and the LED chain on PB5; the ISP header apart", () => {
    expect(groupsOf(example("mcu"))).toEqual([
      ["CONNECTOR J1", "J1"],
      ["MCU U1 ATMEGA328P-AU", "C1 C2 C3 C4 D1 R1 R2 SW1 U1 Y1"],
    ])
  })

  it("node: the 7805 with its caps, diode and input terminal; the ATmega; the 74HC595 with its eight LED chains; the FTDI header with its coupling cap", () => {
    expect(groupsOf(example("node"))).toEqual([
      ["CONNECTOR J2", "C8 J2"],
      ["CONNECTOR J3", "J3"],
      ["LED D2", "D2 R1"],
      ["MCU U1 ATMEGA328P-AU", "C4 C5 C6 C7 R2 RV1 SW1 U1 Y1"],
      ["REGULATOR U2 LM7805", "C1 C2 C3 D1 J1 U2"],
      ["SHIFT REGISTER U3", "C9 D3 D4 D5 D6 D7 D8 D9 D10 R3 R4 R5 R6 R7 R8 R9 R10 U3"],
    ])
  })

  it("esp32-robot: the seven alike sensor inputs are one block, a divider stays with its connector and the 7805 takes its switch and diode", () => {
    expect(groupsOf(example("esp32-robot"))).toEqual([
      ["CONNECTOR J4", "J4"],
      ["CONNECTOR J5", "J5"],
      ["CONNECTOR J14", "J14 R18 R19"],
      ["DISPLAY J13 SSD1306 0.96IN", "J13"],
      ["DRIVER U2 TB6612FNG", "C3 C4 J1 J2 U2"],
      ["MCU U1 ESP32-DEVKIT-V1", "R1 R2 R3 SW1 SW2 SW3 U1"],
      ["REGULATOR U3 L7805", "C1 C2 D1 J3 SW8 U3"],
      ["SCREW TERMINAL 3P x7", "J6 J7 J8 J9 J10 J11 J12 R4 R5 R6 R7 R8 R9 R10 R11 R12 R13 R14 R15 R16 R17"],
    ])
  })

  it("says what it will do in one question", () => {
    expect(cleanupSummary(planCleanup(example("regulator")))).toBe("Group 7 parts into 2 blocks and tidy the sheet?")
    expect(cleanupSummary(planCleanup(example("blinker")))).toBe("Group 9 parts into 1 block and tidy the sheet?")
  })
})

describe("on every drawing to hand", () => {
  it.each(CASES)("%s", (_, make) => {
    const before = make()
    const grouping = groupLooseParts(before)

    // Every part is in a block, once; no block is empty or has a name twice.
    const blocks = grouping.project.blocks ?? []
    const seen = new Set<string>()
    for (const b of blocks) {
      expect(b.components.length).toBeGreaterThan(0)
      for (const id of b.components) {
        expect(seen.has(id)).toBe(false)
        seen.add(id)
      }
    }
    for (const c of physical(grouping.project)) expect(seen.has(c.id)).toBe(true)
    expect(new Set(blocks.map((b) => b.name.toLowerCase())).size).toBe(blocks.length)
    expect(grouping.grouped).toBe(physical(before).length)

    // Grouping changes the blocks and nothing else.
    expect({ ...grouping.project, blocks: undefined, updatedAt: 0 }).toEqual({ ...before, blocks: undefined, updatedAt: 0 })

    // Cleaning up keeps every connection, tidies, and is then done.
    const r = cleanupSheet(before)
    expect(r.ok).toBe(true)
    expect(r.changed).toBe(true)
    expectSameNetlist(before, r.project, r.tidy?.renamed ?? {})
    for (const c of physical(r.project)) expect(r.project.blocks!.some((b) => b.components.includes(c.id))).toBe(true)
    const again = cleanupSheet(r.project)
    expect(again.ok).toBe(true)
    expect(again.changed).toBe(false)
    expect(again.plan.grouped).toBe(0)
  })

  it.each(CASES.filter(([name]) => !name.startsWith("v1")))("%s keeps a block the user made, as it is", (_, make) => {
    const whole = make()
    // The user's own block: the first chip alone (or the first part), made before cleaning up.
    const first = physical(whole).find((c) => /^U|^J/.test(c.ref)) ?? physical(whole)[0]
    const withBlock = createBlock(whole, "MY BLOCK", [first.id]).project
    const mine = withBlock.blocks![0]
    const r = cleanupSheet(withBlock)
    expect(r.ok).toBe(true)
    const kept = r.project.blocks!.find((b) => b.id === mine.id)!
    expect(kept.name).toBe("MY BLOCK")
    // It keeps every part it had; it may take in loose parts wired to its chip.
    expect(kept.components).toContain(first.id)
    expect(kept.components.slice(0, 1)).toEqual([first.id])
    expectSameNetlist(withBlock, r.project, r.tidy?.renamed ?? {})
    // And every other part is in a block of its own: none left out, none twice.
    const all = r.project.blocks!.flatMap((b) => b.components)
    expect(new Set(all).size).toBe(all.length)
    for (const c of physical(r.project)) expect(all).toContain(c.id)
  })
})

describe("grouping rules, on small sheets", () => {
  /** Two chips far apart, each with its own supply labelled; returns helpers to add parts beside them. */
  function sheet() {
    let p = createProject("rules")
    const add = (partId: string, x: number, y: number, props: Record<string, string> = {}) => {
      const r = addComponent(p, partId, { sch: { x, y, rot: 0 }, props })
      p = r.project
      return r.component
    }
    const label = (c: { id: string }, pin: string, name: string) => {
      p = labelPin(p, { componentId: c.id, pin }, name)
    }
    return { add, label, project: () => p }
  }
  const members = (p: Project, name: string) => {
    const refOf = new Map(p.components.map((c) => [c.id, c.ref]))
    return (groupLooseParts(p).groups.find((g) => g.name === name)?.parts ?? []).map((id) => refOf.get(id)!).sort(naturalCompare)
  }

  it("gives a supply capacitor to the chip it stands beside, wherever it was added", () => {
    const s = sheet()
    const a = s.add("atmega328p", 0, 0)
    const b = s.add("sn74hc595", 40, 0)
    s.label(a, "4", "5V")
    s.label(b, "16", "5V")
    s.label(a, "3", "GND")
    s.label(b, "8", "GND")
    // A third and fourth pin on the supply, so it is a crowded rail with no wire to follow.
    const nearB = s.add("capacitor", 38, -6)
    const nearA = s.add("capacitor", 2, -6)
    for (const c of [nearB, nearA]) {
      s.label(c, "1", "5V")
      s.label(c, "2", "GND")
    }
    const p = s.project()
    expect(members(p, "SHIFT REGISTER U2")).toEqual(["C1", "U2"])
    expect(members(p, "MCU U1 ATMEGA328P-AU")).toEqual(["C2", "U1"])
  })

  it("keeps a pull-up with the chip pin it is wired to, however far it was put", () => {
    const s = sheet()
    const a = s.add("atmega328p", 0, 0)
    const b = s.add("sn74hc595", 40, 0)
    s.label(a, "4", "5V")
    s.label(b, "16", "5V")
    const pull = s.add("resistor", 41, -8)
    s.label(pull, "2", "RESET")
    s.label(pull, "1", "5V")
    s.label(a, "29", "RESET")
    expect(members(s.project(), "MCU U1 ATMEGA328P-AU")).toContain("R1")
  })

  it("hangs an LED and its resistor from a pin of a chip, but gives a power LED a block of its own", () => {
    const s = sheet()
    const u = s.add("sn74hc595", 0, 0)
    s.label(u, "16", "5V")
    // Q0 to a resistor to an LED, drawn far from the chip.
    const r1 = s.add("resistor", 20, 20, { resistance: "330" })
    const d1 = s.add("led", 24, 20)
    s.label(u, "15", "Q0")
    s.label(r1, "1", "Q0")
    s.label(r1, "2", "Q0_LED")
    s.label(d1, "1", "Q0_LED")
    s.label(d1, "2", "GND")
    // A power LED: a resistor from the supply, an LED to ground, on a supply four parts share.
    const r2 = s.add("resistor", -20, 20, { resistance: "1k" })
    const d2 = s.add("led", -24, 20)
    s.label(r2, "1", "5V")
    s.label(r2, "2", "PWR_LED")
    s.label(d2, "1", "PWR_LED")
    s.label(d2, "2", "GND")
    for (const x of [10, 12]) {
      const c = s.add("capacitor", x, -10)
      s.label(c, "1", "5V")
      s.label(c, "2", "GND")
    }
    const p = s.project()
    expect(members(p, "SHIFT REGISTER U1")).toEqual(["C1", "C2", "D1", "R1", "U1"])
    expect(members(p, "LED D2")).toEqual(["D2", "R2"])
  })

  it("puts a part nothing is wired to in the nearest block if it is near, else OTHER", () => {
    const s = sheet()
    const u = s.add("sn74hc595", 0, 0)
    s.label(u, "16", "5V")
    s.add("resistor", 2, -2)
    s.add("resistor", 60, 60)
    const p = s.project()
    expect(members(p, "SHIFT REGISTER U1")).toEqual(["R1", "U1"])
    expect(members(p, "OTHER")).toEqual(["R2"])
  })

  it("leaves a user's block as it is and adds the loose parts wired to its chip", () => {
    const s = sheet()
    const u = s.add("sn74hc595", 0, 0)
    s.label(u, "16", "5V")
    const cap = s.add("capacitor", 3, -3)
    s.label(cap, "1", "5V")
    s.label(cap, "2", "GND")
    const mine = createBlock(s.project(), "SHIFT", [u.id])
    const g = groupLooseParts(mine.project)
    expect(g.project.blocks!.map((b) => [b.id, b.name])).toEqual([[mine.block!.id, "SHIFT"]])
    expect(g.project.blocks![0].components).toEqual([u.id, cap.id])
    expect(g.created).toBe(0)
    expect(g.joined).toBe(1)
  })

  it("is not swayed by what order the parts are listed in or what ids they have", () => {
    const base = example("node")
    const shuffled: Project = {
      ...base,
      components: [...base.components].reverse().map((c, i) => ({ ...c, id: `x${String(i).padStart(4, "0")}` })),
    }
    // Wires and labels are drawn, not tied to ids, so a renumbered sheet is the same sheet.
    const names = (p: Project) => groupsOf(p)
    expect(names(shuffled)).toEqual(names(base))
  })
})

describe("after Tidy", () => {
  const tidied = (id: string) => {
    const r = tidySchematic(example(id))
    expect(r.ok).toBe(true)
    return r.project
  }

  it("takes the parts Tidy put in OTHER as loose: node is grouped exactly as on the raw sheet, capacitors included", () => {
    const after = tidied("node")
    expect(after.blocks!.map((b) => [b.name, !!b.leftover])).toEqual([["OTHER", true]])
    expect(groupsOf(after)).toEqual(groupsOf(example("node")))
    const r = cleanupSheet(after)
    expect(r.ok).toBe(true)
    expect(r.plan.grouped).toBe(38)
    expect(r.plan.created).toBe(6)
    expect(r.project.blocks!.some((b) => b.name === "OTHER")).toBe(false)
    expectSameNetlist(after, r.project, r.tidy?.renamed ?? {})
    // The 7805 keeps C1 C2 C3, the MCU C6 C7, the shift register C9.
    const groups = Object.fromEntries(groupsOf(after))
    expect(groups["REGULATOR U2 LM7805"]).toBe("C1 C2 C3 D1 J1 U2")
    expect(groups["MCU U1 ATMEGA328P-AU"]).toBe("C4 C5 C6 C7 R2 RV1 SW1 U1 Y1")
    expect(groups["SHIFT REGISTER U3"]).toContain("C9")
  })

  it.each(["regulator", "mcu", "esp32-robot", "blinker"])("%s: the same blocks, capacitors included, after Tidy as before it", (id) => {
    expect(groupsOf(tidied(id))).toEqual(groupsOf(example(id)))
  })

  it.each(BLOG.map((f) => f.replace(/\.json$/, "")))("blog board %s: the same blocks after Tidy as before it", (name) => {
    const raw = bare(parseProjectFile(fixture(`./fixtures/blog-boards/${name}.json`), origin))
    const tidy = tidySchematic(raw)
    // A board Tidy refuses is left as it was, with nothing to compare.
    if (!tidy.ok) return
    // Parts nothing is near and nothing is wired to stay in the OTHER block Tidy made; on the raw sheet they are a new one.
    const named = (p: Project) => groupsOf(p).filter(([name]) => name !== "OTHER")
    expect(named(tidy.project)).toEqual(named(raw))
  })

  it("falls back to where the parts are when one was moved since Tidy", () => {
    const after = tidied("node")
    const moved: Project = { ...after, components: after.components.map((c, i) => (i === 0 ? { ...c, sch: { ...c.sch, x: c.sch.x + 3 } } : c)) }
    // Read where the parts are now: no crash, and everything but what nothing is near is grouped.
    expect(groupLooseParts(moved).grouped).toBeGreaterThanOrEqual(36)
  })

  it("remembers the first drawing through a second Tidy, and starts over when a part was added in between", () => {
    const once = tidied("node")
    const twice = tidySchematic(once)
    const origins = (p: Project) => p.blocks!.find((b) => b.leftover)?.origins
    if (twice.changed) expect(Object.values(origins(twice.project)!).map((o) => o.from)).toEqual(Object.values(origins(once)!).map((o) => o.from))
    const added = addComponent(once, "resistor", { sch: { x: 400, y: 400, rot: 0 } }).project
    const third = tidySchematic(added)
    expect(third.ok).toBe(true)
    const kept = origins(third.project)!
    // The added part is in the block too, and its entry starts from where it was put.
    expect(Object.keys(kept)).toHaveLength(39)
  })

  it("is one undo step back to the Tidy-made sheet", async () => {
    const after = tidied("regulator")
    useProjectStore.getState().close()
    useProjectStore.getState().open(after)
    openCleanup()
    applyCleanup()
    await vi.waitFor(() => expect(useCleanup.getState().phase.kind).toBe("idle"))
    const state = useProjectStore.getState()
    expect(state.past).toHaveLength(1)
    expect(state.project!.blocks!.map((b) => b.name).sort()).toEqual(["LED D1", "REGULATOR U1 AMS1117-3.3"])
    state.undo()
    expect(useProjectStore.getState().project).toBe(after)
  })

  it("renaming the OTHER block makes it the user's: its parts stay in it", () => {
    const after = tidied("regulator")
    const renamed = renameBlock(after, after.blocks![0].id, "MY STUFF")
    expect(renamed.blocks![0].leftover).toBeUndefined()
    const g = groupLooseParts(renamed)
    expect(g.grouped).toBe(0)
    expect(g.project.blocks).toEqual(renamed.blocks)
  })

  it("never puts a leftover in a block the user named OTHER", () => {
    const s = example("mcu")
    // A part nothing is wired to and nothing is near, and the user's own block called OTHER.
    const far = addComponent(s, "resistor", { sch: { x: 400, y: 400, rot: 0 } })
    const j1 = far.project.components.find((c) => c.ref === "J1")!
    const mine = createBlock(far.project, "OTHER", [j1.id]).project
    const g = groupLooseParts(mine)
    const userBlock = g.project.blocks!.find((b) => b.id === mine.blocks![0].id)!
    expect(userBlock.name).toBe("OTHER")
    expect(userBlock.components).toEqual([j1.id])
    expect(g.project.blocks!.find((b) => b.components.includes(far.component.id))!.name).toBe("OTHER 2")
  })

  it("keeps the leftovers that are still nobody's in the block Tidy made for them", () => {
    const far = addComponent(example("mcu"), "resistor", { sch: { x: 400, y: 400, rot: 0 } })
    // The block Tidy would have made, with the far part in it.
    const made = createBlock(far.project, "OTHER", [far.component.id])
    const after: Project = { ...made.project, blocks: made.project.blocks!.map((b) => ({ ...b, leftover: true })) }
    const g = groupLooseParts(after)
    const other = g.project.blocks!.find((b) => b.name === "OTHER")!
    expect(other.id).toBe(made.block!.id)
    expect(other.components).toEqual([far.component.id])
    expect(g.grouped).toBe(physical(after).length - 1)
  })

  it("reads the leftover flag as a boolean, so a hand-edited \"no\" is a block like any other", () => {
    const base = example("regulator")
    const ids = base.components.filter((c) => !c.partId.startsWith("power") && c.partId !== "ground").map((c) => c.id)
    const read = (leftover: unknown) => normalizeProject({ ...base, blocks: [{ id: "b1", name: "OTHER", components: ids, leftover }] } as never).blocks![0]
    expect(read("no").leftover).toBeUndefined()
    expect(read(1).leftover).toBeUndefined()
    expect(read(true).leftover).toBe(true)
  })

  it("names a load switch as one, not as a regulator, and keeps a small chip's own capacitor", () => {
    const hub = bare(parseProjectFile(fixture("./fixtures/blog-boards/usb2-hub-4port.json"), origin))
    expect(groupLooseParts(hub).groups.map((g) => g.name)).toContain("LOAD SWITCH U7")
    const imu = bare(parseProjectFile(fixture("./fixtures/blog-boards/imu-logger-footprints.json"), origin))
    const refOf = new Map(imu.components.map((c) => [c.id, c.ref]))
    const of = (prefix: string) => groupLooseParts(imu).groups.find((g) => g.name.startsWith(prefix))!.parts.map((id) => refOf.get(id)!)
    // C15 stands 2.5 units from the load switch and 8.8 from the regulator; the MCU's 4.7 uF stays in its row.
    expect(of("LOAD SWITCH U4")).toContain("C15")
    expect(of("MCU U3")).toContain("C5")
  })

  it("puts C2 of the BLE tag with the charger, not the battery connector", () => {
    const board = bare(parseProjectFile(fixture("./fixtures/blog-boards/ble-tag-lipo.json"), origin))
    const refOf = new Map(board.components.map((c) => [c.id, c.ref]))
    const g = groupLooseParts(board).groups
    expect(g.find((x) => x.name.startsWith("CHARGER"))!.parts.map((id) => refOf.get(id))).toContain("C2")
  })
})

describe("what it keeps when Tidy goes wrong", () => {
  const tidyResult = (project: Project, patch: Partial<TidyResult> = {}): TidyResult => ({
    project,
    changed: true,
    ok: true,
    message: "Tidied.",
    renamed: {},
    dropped: [],
    loose: { wires: 0, labels: 0, ports: 0 },
    problems: [],
    ...patch,
  })

  it("leaves the sheet as it was when Tidy refuses", () => {
    const before = example("regulator")
    const plan = planCleanup(before)
    const r = finishCleanup(plan, tidyResult(before, { ok: false, changed: false, message: "Tidy couldn't find room for everything; nothing was changed." }))
    expect(r.ok).toBe(false)
    expect(r.changed).toBe(false)
    expect(r.project).toBe(before)
    expect(r.message).toBe("Tidy couldn't find room for everything; nothing was changed.")
  })

  it("refuses a result whose connections differ, however it came about", () => {
    const before = example("regulator")
    const plan = planCleanup(before)
    // A wire gone: the same blocks, one connection fewer.
    const cut: Project = { ...plan.project, wires: plan.project.wires.slice(1), labels: plan.project.labels.slice(1) }
    const r = finishCleanup(plan, tidyResult(cut))
    expect(r.ok).toBe(false)
    expect(r.project).toBe(before)
    expect(r.message).toBe("Clean up would have changed a connection, so nothing was changed.")
  })

  it("names the blocks a whole-sheet Tidy kept as drawn when it says so, and needs no such list", () => {
    const before = example("regulator")
    const plan = planCleanup(before)
    const plain = finishCleanup(plan, tidyResult(plan.project, { changed: true }))
    expect(plain.message).not.toContain("Kept")
    // The shape Tidy reports them in: the block and why, said as Tidy says it.
    const kept = [{ block: "MCU", why: "no room" }, { block: "USB INPUT", why: "a wire runs through it" }]
    const reported = { ...tidyResult(plan.project, { changed: true }), kept }
    const withKept = finishCleanup(plan, reported)
    expect(withKept.message).toContain("Kept MCU as it was drawn: no room.")
    expect(withKept.message).toContain("Kept USB INPUT as it was drawn: a wire runs through it.")
    const none = { ...tidyResult(plan.project, { changed: true }), kept: [] }
    expect(finishCleanup(plan, none).message).not.toContain("Kept")
  })

  it("keeps the grouped sheet when it was tidy already", () => {
    const before = example("regulator")
    const plan = planCleanup(before)
    const r = finishCleanup(plan, tidyResult(plan.project, { changed: false, message: "Already tidy." }))
    expect(r.ok).toBe(true)
    expect(r.project).toBe(plan.project)
    expect(r.message).toBe("Grouped 7 parts into 2 blocks and tidied the sheet.")
  })
})

describe("the toolbar's Clean up", () => {
  beforeEach(() => {
    stopCleanup()
    useProjectStore.getState().close()
  })

  const open = (p: Project) => useProjectStore.getState().open(p)
  const settled = () => vi.waitFor(() => expect(useCleanup.getState().phase.kind).toBe("idle"))

  it("has nothing to do on an empty sheet", () => {
    const empty = createProject("empty")
    open(empty)
    expect(hasParts(empty)).toBe(false)
    openCleanup()
    expect(useCleanup.getState().phase.kind).toBe("idle")
  })

  it("shows what it would do, changes nothing until Apply, then is one undo step", async () => {
    const before = example("node")
    open(before)
    openCleanup()
    const phase = useCleanup.getState().phase
    if (phase.kind !== "preview") throw new Error("no preview")
    expect(cleanupSummary(phase.plan)).toBe("Group 38 parts into 6 blocks and tidy the sheet?")
    expect(useProjectStore.getState().project).toBe(before)

    applyCleanup()
    expect(useCleanup.getState().phase.kind).toBe("running")
    await settled()
    const state = useProjectStore.getState()
    expect(state.past).toHaveLength(1)
    expect(state.project!.blocks).toHaveLength(6)
    state.undo()
    expect(useProjectStore.getState().project).toBe(before)
    useProjectStore.getState().redo()
    expect(useProjectStore.getState().project!.blocks).toHaveLength(6)
  })

  it("stops on cancel, with the sheet as it was", async () => {
    const before = example("regulator")
    open(before)
    openCleanup()
    applyCleanup()
    cancelCleanup()
    expect(useCleanup.getState().phase.kind).toBe("idle")
    await new Promise((r) => setTimeout(r, 30))
    expect(useProjectStore.getState().project).toBe(before)
    expect(useProjectStore.getState().past).toHaveLength(0)
  })

  it("closing the preview changes nothing", () => {
    const before = example("regulator")
    open(before)
    openCleanup()
    cancelCleanup()
    expect(useCleanup.getState().phase.kind).toBe("idle")
    expect(useProjectStore.getState().project).toBe(before)
  })

  it("asks again when the sheet was edited since the preview", () => {
    const before = example("regulator")
    open(before)
    openCleanup()
    useProjectStore.getState().commit((p) => ({ ...p, name: "edited" }))
    applyCleanup()
    const phase = useCleanup.getState().phase
    expect(phase.kind).toBe("preview")
    expect(useProjectStore.getState().past).toHaveLength(1)
  })

  it("leaves a sheet edited while it worked as the user left it", async () => {
    const before = example("node")
    open(before)
    openCleanup()
    applyCleanup()
    useProjectStore.getState().commit((p) => ({ ...p, name: "edited meanwhile" }))
    await settled()
    const state = useProjectStore.getState()
    expect(state.project!.name).toBe("edited meanwhile")
    expect(state.project!.blocks).toBeUndefined()
    expect(state.past).toHaveLength(1)
  })

  it("is quick: the 38-part example plans in well under a second", () => {
    const p = example("node")
    const t0 = performance.now()
    planCleanup(p)
    expect(performance.now() - t0).toBeLessThan(500)
  })
})
