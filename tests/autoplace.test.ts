import { describe, expect, it } from "vitest"
import { type Box } from "../src/lib/geometry"
import { splitLocked } from "../src/editor/pcb/PcbEditor"
import { pasteItems } from "../src/model/schematicEdit"
import { autoroute } from "../src/model/autoroute"
import { exitCorridors } from "../src/model/autoplace"
import { mountingHoles } from "../src/model/board"
import { computeConnectivity, pinKey } from "../src/model/connectivity"
import { decouplingGaps, decouplingPairs } from "../src/model/decoupling"
import { EXAMPLES } from "../src/model/examples"
import { pcbCourtyard, pcbPads } from "../src/model/instances"
import { addComponent, addTrace, addVia, autoPlacePcb, createProject, labelPin, repackCopper, repackPcb, resolvePinSpec } from "../src/model/ops"
import { analyzePcb } from "../src/model/pcb"
import { parseProjectFile, serializeProject } from "../src/model/projectFile"
import { routeAroundStitching } from "../src/model/stitch"
import type { ComponentInstance, Project, Rotation } from "../src/model/types"
import { synthetic } from "./synthetic"

const example = (id: string) => EXAMPLES.find((e) => e.id === id)!.project
const repacked = new Map<string, Project>()
/** An example re-packed, once per file: the ESP32 robot takes a moment. */
function repack(id: string): Project {
  let p = repacked.get(id)
  if (!p) repacked.set(id, (p = autoPlacePcb(example(id), true)))
  return p
}

const placementProblems = (p: Project) =>
  analyzePcb(p, computeConnectivity(p))
    .violations.filter((v) => v.kind === "overlap" || v.kind === "outside-board")
    .map((v) => v.message)

const byRef = (p: Project, ref: string) => p.components.find((c) => c.ref === ref)!
const boxPointDistance = (b: Box, x: number, y: number) => Math.hypot(Math.max(b.minX - x, 0, x - b.maxX), Math.max(b.minY - y, 0, y - b.maxY))
const overlaps = (a: Box, b: Box) => a.minX < b.maxX - 1e-9 && a.maxX > b.minX + 1e-9 && a.minY < b.maxY - 1e-9 && a.maxY > b.minY + 1e-9

/** A schematic with an ATmega328P, its two supply capacitors and a few loose parts, nothing on the board. */
function mcuSheet(): Project {
  let p = createProject("t")
  const add = (partId: string, x: number, y: number, props?: Record<string, string>) => (p = addComponent(p, partId, { sch: { x, y, rot: 0 }, props }).project)
  const net = (name: string, ...pins: string[]) => {
    for (const spec of pins) p = labelPin(p, resolvePinSpec(p, spec)!, name)
  }
  add("atmega328p", 0, 0)
  add("capacitor", 4, 3, { capacitance: "100nF" })
  add("capacitor", 6, 3, { capacitance: "100nF" })
  add("resistor", 8, 0)
  add("led", 10, 0)
  net("5V", "U1.4", "U1.6", "U1.18", "C1.1", "C2.1", "R1.1")
  net("GND", "U1.3", "U1.5", "U1.21", "C1.2", "C2.2", "D1.K")
  net("LED", "U1.PB5", "R1.2", "D1.A")
  return p
}

describe("re-packing the examples", () => {
  it.each(EXAMPLES.map((e) => e.id))("%s keeps its hand placement when nothing is new", (id) => {
    expect(autoPlacePcb(example(id))).toBe(example(id))
  })

  it.each(EXAMPLES.map((e) => e.id))("%s re-packs with no part on another and every decoupling capacitor at its pin", (id) => {
    const p = repack(id)
    expect(placementProblems(p)).toEqual([])
    const gaps = decouplingGaps(p)
    expect(gaps.length).toBe(decouplingPairs(example(id)).length)
    for (const g of gaps) expect(g.gap, `${g.cap.ref} to ${g.chip.ref} pin ${g.pin}`).toBeLessThanOrEqual(2)
  })

  it.each(EXAMPLES.map((e) => e.id))("%s puts each capacitor on its chip's side with its ground pad facing away", (id) => {
    const p = repack(id)
    for (const g of decouplingGaps(p)) {
      expect(g.cap.pcb.side).toBe(g.chip.pcb.side)
      const chip = pcbCourtyard(g.chip)!
      const pad = (pin: string) => pcbPads(g.cap).find((x) => x.pin === pin)!
      const supply = pad(g.pair.capSupplyPin)
      const ground = pad(g.pair.capGroundPin)
      expect(boxPointDistance(chip, ground.x, ground.y), g.cap.ref).toBeGreaterThan(boxPointDistance(chip, supply.x, supply.y))
    }
  })

  it.each(EXAMPLES.map((e) => e.id))("%s keeps parts off its mounting holes", (id) => {
    const p = repack(id)
    for (const h of mountingHoles(p.board)) {
      for (const c of p.components) {
        const box = c.pcb.placed ? pcbCourtyard(c) : null
        if (box) expect(boxPointDistance(box, h.x, h.y), `${c.ref} on hole ${h.id}`).toBeGreaterThan(h.diameter / 2)
      }
    }
  })

  it("keeps the TB6612's fine-pitch pins free to escape", () => {
    const p = repack("esp32-robot")
    const conn = computeConnectivity(p)
    const driver = byRef(p, "U2")
    const cap = byRef(p, "C4")
    const vbat = conn.nets.find((n) => n.name === "VBAT")!.id
    const corridors = exitCorridors(driver, (pin) => conn.pinNet.get(pinKey(driver.id, pin)), new Set([vbat]))
    expect(corridors.length).toBeGreaterThan(10)
    for (const box of corridors) expect(overlaps(pcbCourtyard(cap)!, box)).toBe(false)
  })

  it("keeps the ESP32 robot's hand fan-out and the parts it reaches, and clears the rest of the copper", () => {
    const before = example("esp32-robot")
    const p = repack("esp32-robot")
    expect(p.traces).toEqual(before.traces.filter((t) => t.locked))
    expect(p.vias).toEqual(before.vias.filter((v) => v.locked))
    expect(p.traces.length).toBeGreaterThan(0)
    for (const ref of ["U1", "U2"]) expect(byRef(p, ref).pcb).toEqual(byRef(before, ref).pcb)
    expect(byRef(p, "C4").pcb).not.toEqual(byRef(before, "C4").pcb)
  })

  // The ESP32 robot routes fully too (see tests/placement.measure.test.ts), in longer than a unit test should take.
  it.each(["blinker", "regulator", "mcu", "node"])("%s still routes completely after a re-pack", (id) => {
    expect(autoroute(repack(id), { timeLimitMs: Infinity }).remaining).toBe(0)
  })
})

describe("automatic placement", () => {
  it("turns each part's courtyard with the part, so rotated parts never land on each other", () => {
    let p = createProject("t")
    p = { ...p, board: { ...p.board, width: 60, height: 40 } }
    const rots: Rotation[] = [0, 90, 180, 270, 90, 270, 180, 90]
    rots.forEach((rot, i) => {
      // TO-220s stand off-centre on their pads, which is what a turn has to carry along.
      p = addComponent(p, "lm7805", { footprint: "to220_3_vertical", pcb: { rot } }).project
      p = addComponent(p, "resistor", { pcb: { rot: rots[(i + 1) % rots.length] } }).project
    })
    p = autoPlacePcb(p)
    expect(p.components.every((c) => c.pcb.placed)).toBe(true)
    expect(placementProblems(p)).toEqual([])
    expect(p.components.map((c) => c.pcb.rot)).toEqual(rots.flatMap((rot, i) => [rot, rots[(i + 1) % rots.length]]))
  })

  it("flips the courtyards of parts on the bottom", () => {
    let p = createProject("t")
    p = { ...p, board: { ...p.board, width: 60, height: 40 } }
    // A trimmer's courtyard is 2 mm off its origin, so a flip has to carry it to the other side.
    for (const rot of [0, 180, 0, 90, 0, 270] as Rotation[]) p = addComponent(p, "potentiometer", { pcb: { side: "bottom", rot } }).project
    expect(placementProblems(autoPlacePcb(p))).toEqual([])
  })

  it("places a chip with its decoupling capacitors on its supply pins, one at each", () => {
    const p = autoPlacePcb(mcuSheet())
    expect(placementProblems(p)).toEqual([])
    const gaps = decouplingGaps(p)
    expect(gaps.map((g) => g.cap.ref)).toEqual(["C1", "C2"])
    for (const g of gaps) expect(g.gap).toBeLessThanOrEqual(2)
    // VCC (4 and 6, side by side) and AVCC (18) are on opposite sides of the chip.
    expect(new Set(gaps.map((g) => (g.pin === "18" ? "AVCC" : "VCC")))).toEqual(new Set(["VCC", "AVCC"]))
  })

  it("puts a new capacitor beside a chip already on the board, on the chip's side, without moving anything", () => {
    let p = mcuSheet()
    const ids = new Map(p.components.map((c) => [c.ref, c.id]))
    const place = (ref: string, pcb: Partial<ComponentInstance["pcb"]>) => {
      p = { ...p, components: p.components.map((c) => (c.ref === ref ? { ...c, pcb: { ...c.pcb, ...pcb, placed: true } } : c)) }
    }
    place("U1", { x: 5, y: -3, rot: 90, side: "bottom" })
    place("R1", { x: -15, y: 10 })
    place("D1", { x: -15, y: 5 })
    place("C2", { x: 18, y: -15 })
    const next = autoPlacePcb(p)
    for (const ref of ["U1", "R1", "D1", "C2"]) expect(byRef(next, ref).pcb).toEqual(byRef(p, ref).pcb)
    const c1 = byRef(next, "C1")
    expect(c1.pcb).toMatchObject({ placed: true, side: "bottom" })
    const gap = decouplingGaps(next).find((g) => g.cap.id === ids.get("C1"))!
    expect(gap.gap).toBeLessThanOrEqual(2)
    expect(placementProblems(next)).toEqual([])
  })

  it("never moves a locked part", () => {
    let p = autoPlacePcb(mcuSheet())
    const u1 = byRef(p, "U1")
    p = { ...p, components: p.components.map((c) => (c.id === u1.id ? { ...c, pcb: { ...c.pcb, x: -10, y: 8, locked: true } } : c)) }
    const next = autoPlacePcb(p, true)
    expect(byRef(next, "U1").pcb).toEqual({ ...u1.pcb, x: -10, y: 8, locked: true })
    expect(byRef(next, "R1").pcb).not.toEqual(byRef(p, "R1").pcb)
    // Its capacitors come to it rather than it going to them.
    for (const g of decouplingGaps(next)) expect(g.gap).toBeLessThanOrEqual(2)
    expect(placementProblems(next)).toEqual([])
    // Nothing to do when every part is locked.
    const all = { ...p, components: p.components.map((c) => ({ ...c, pcb: { ...c.pcb, locked: true } })) }
    expect(autoPlacePcb(all, true)).toBe(all)
  })

  it("keeps parts that locked copper reaches and clears unlocked copper on a re-pack", () => {
    let p = autoPlacePcb(mcuSheet())
    const pad = (ref: string, pin: string) => pcbPads(byRef(p, ref)).find((x) => x.pin === pin)!
    const r1 = pad("R1", "2")
    const d1 = pad("D1", "1")
    p = addTrace(p, { layer: "top", width: 0.25, points: [r1, d1], locked: true }).project
    p = addTrace(p, { layer: "top", width: 0.25, points: [pad("U1", "4"), pad("C1", "1")] }).project
    const next = autoPlacePcb(p, true)
    expect(next.traces).toEqual([p.traces[0]])
    expect(byRef(next, "R1").pcb).toEqual(byRef(p, "R1").pcb)
    expect(byRef(next, "D1").pcb).toEqual(byRef(p, "D1").pcb)
    expect(placementProblems(next)).toEqual([])
    // Placing new parts never clears anything.
    expect(autoPlacePcb(p)).toBe(p)
  })

  it("parks what doesn't fit beside the board instead of on other parts", () => {
    let p = createProject("t")
    p = { ...p, board: { ...p.board, width: 12, height: 10 } }
    for (let i = 0; i < 4; i++) p = addComponent(p, "lm7805", { footprint: "to220_3_vertical" }).project
    const next = autoPlacePcb(p)
    const problems = analyzePcb(next, computeConnectivity(next)).violations
    expect(problems.filter((v) => v.kind === "overlap")).toEqual([])
    expect(problems.filter((v) => v.kind === "outside-board").length).toBeGreaterThan(0)
  })

  it("lays out a big board in seconds, not minutes", () => {
    let p = createProject("t")
    p = { ...p, board: { ...p.board, width: 160, height: 120 } }
    for (let i = 0; i < 12; i++) {
      p = addComponent(p, "atmega328p", { sch: { x: i * 20, y: 0, rot: 0 } }).project
      const u = p.components[p.components.length - 1].ref
      for (let k = 0; k < 3; k++) {
        p = addComponent(p, "capacitor", { sch: { x: i * 20 + 5 + k * 3, y: 6, rot: 0 } }).project
        const c = p.components[p.components.length - 1].ref
        p = labelPin(p, resolvePinSpec(p, `${c}.1`)!, `V${i}`)
        p = labelPin(p, resolvePinSpec(p, `${c}.2`)!, "GND")
      }
      p = labelPin(p, resolvePinSpec(p, `${u}.4`)!, `V${i}`)
      p = labelPin(p, resolvePinSpec(p, `${u}.18`)!, `V${i}`)
      p = labelPin(p, resolvePinSpec(p, `${u}.5`)!, "GND")
    }
    for (let i = 0; i < 80; i++) p = addComponent(p, "resistor", { sch: { x: i * 3, y: -30, rot: 0 } }).project
    const t0 = performance.now()
    const next = autoPlacePcb(p)
    const ms = performance.now() - t0
    expect(placementProblems(next)).toEqual([])
    expect(decouplingGaps(next).every((g) => g.gap <= 2)).toBe(true)
    // About 0.7 s on a laptop; CI has run these tests seven times slower.
    expect(ms).toBeLessThan(15_000)
  })
})

describe("parts with no position", () => {
  const lock = (p: Project, ref: string, patch: Partial<ComponentInstance["pcb"]> = {}) => ({
    ...p,
    components: p.components.map((c) => (c.ref === ref ? { ...c, pcb: { ...c.pcb, locked: true, ...patch } } : c)),
  })

  it("places a locked part that is not on the board yet, and moves nothing else", () => {
    const base = autoPlacePcb(mcuSheet())
    const p = lock(base, "R1", { placed: false, x: 0, y: 0 })
    const next = autoPlacePcb(p)
    expect(byRef(next, "R1").pcb).toMatchObject({ placed: true, locked: true })
    expect(byRef(next, "R1").pcb).not.toMatchObject({ x: 0, y: 0 })
    for (const ref of ["U1", "C1", "C2", "D1"]) expect(byRef(next, ref).pcb).toEqual(byRef(p, ref).pcb)
    expect(placementProblems(next)).toEqual([])
    // A re-pack places it too, while a locked part on the board stays.
    const all = autoPlacePcb(lock(p, "U1"), true)
    expect(byRef(all, "R1").pcb.placed).toBe(true)
    expect(byRef(all, "U1").pcb).toEqual(byRef(lock(p, "U1"), "U1").pcb)
  })

  it("gives a pasted copy of a locked part no lock, and layout_pcb's placer puts it on the board", () => {
    // Pasting copied pcb with placed false but locked true, so the copy stayed at 0, 0 and
    // layout_pcb said every part was already placed.
    const base = lock(autoPlacePcb(mcuSheet()), "R1")
    const r1 = byRef(base, "R1")
    const pasted = pasteItems(base, { project: base, components: [r1.id], wires: [], labels: [], blocks: [] }, { x: 1, y: -1 })
    if (!pasted.ok) throw new Error(pasted.message)
    const copy = pasted.project.components.find((c) => `c:${c.id}` === pasted.selection[0])!
    expect(copy.pcb.placed).toBe(false)
    expect(copy.pcb.locked).toBeFalsy()
    const next = autoPlacePcb(pasted.project)
    expect(next).not.toBe(pasted.project)
    expect(next.components.find((c) => c.id === copy.id)!.pcb.placed).toBe(true)
    expect(byRef(next, "R1").pcb).toEqual(r1.pcb)
    expect(placementProblems(next)).toEqual([])
  })
})

describe("re-packing a poured board", () => {
  it.each(["blinker", "regulator", "mcu"])("%s keeps its stitching vias instead of deleting them", (id) => {
    const before = example(id)
    expect(before.vias.some((v) => v.net)).toBe(true)
    // The placer clears every via that isn't locked, stitching ones included...
    expect(autoPlacePcb(before, true).vias.filter((v) => v.net)).toEqual([])
    // ...and the re-pack the button and Sakura use stitches the pour again.
    const next = repackPcb(before)
    const stitching = next.vias.filter((v) => v.net)
    expect(stitching.length).toBeGreaterThan(before.vias.filter((v) => v.net).length / 2)
    expect(new Set(stitching.map((v) => v.net))).toEqual(new Set(before.vias.filter((v) => v.net).map((v) => v.net)))
    // On the new layout: clear of every part and pad, no new violations.
    const problems = analyzePcb(next, computeConnectivity(next)).violations.filter((v) => v.severity === "error")
    expect(problems.map((v) => v.message)).toEqual([])
    const copper = repackCopper(before, next)
    expect(copper.stitchedAfter).toBe(stitching.length)
    expect(copper.stitchedBefore).toBe(before.vias.filter((v) => v.net).length)
  })

  it.each(["blinker", "regulator", "mcu"])("%s routes completely with the stitching lifted for routing and put back after", (id) => {
    const packed = repackPcb(example(id))
    const seen: number[] = []
    const route = (p: Project) => {
      seen.push(p.vias.filter((v) => v.net).length)
      return autoroute(p, { timeLimitMs: Infinity })
    }
    const routed = routeAroundStitching(packed, route)
    expect(seen).toEqual([0])
    expect(routed.remaining).toBe(0)
    expect(routed.project.vias.filter((v) => v.net).length).toBeGreaterThan(0)
    const errors = analyzePcb(routed.project, computeConnectivity(routed.project)).violations.filter((v) => v.severity === "error")
    expect(errors.map((v) => v.message)).toEqual([])
    // Nothing to route: nothing changes, stitching included.
    expect(routeAroundStitching(routed.project, route).project).toBe(routed.project)
  })

  it("leaves a board without pours alone", () => {
    const p = autoPlacePcb(mcuSheet())
    const next = repackPcb(p)
    expect(next.vias).toEqual([])
    expect(repackCopper(p, next)).toEqual({ traces: 0, vias: 0, stitchedBefore: 0, stitchedAfter: 0 })
  })
})

describe("hand-routed copper", () => {
  it("is kept by a re-pack when it is locked, with the parts it reaches", () => {
    let p = autoPlacePcb(mcuSheet())
    const pad = (ref: string, pin: string) => pcbPads(byRef(p, ref)).find((x) => x.pin === pin)!
    // What the PCB editor now draws: a locked trace and a locked via.
    p = addTrace(p, { layer: "top", width: 0.25, points: [pad("R1", "2"), pad("D1", "1")], locked: true }).project
    p = addVia(p, { x: pad("R1", "1").x, y: pad("R1", "1").y }, { locked: true }).project
    expect(p.vias[0].locked).toBe(true)
    const next = autoPlacePcb(p, true)
    expect(next.traces).toEqual(p.traces)
    expect(next.vias).toEqual(p.vias)
    expect(byRef(next, "R1").pcb).toEqual(byRef(p, "R1").pcb)
    expect(byRef(next, "D1").pcb).toEqual(byRef(p, "D1").pcb)
  })
})

describe("speed", () => {
  const best = (runs: number, fn: () => void) => {
    let ms = Infinity
    for (let i = 0; i < runs; i++) {
      const t = performance.now()
      fn()
      ms = Math.min(ms, performance.now() - t)
    }
    return ms
  }

  // Re-packing the ESP32 robot took about 2 ms before capacitors were placed at their pins, then 1.8 s
  // while that was done by brute force. It takes under 0.1 s on a laptop now; CI has been seven
  // times slower than that, and a loaded one more, so the limits are loose: they catch a return to
  // seconds, not a few milliseconds.
  it("re-packs the ESP32 robot in a fraction of a second", () => {
    const robot = example("esp32-robot")
    expect(best(3, () => autoPlacePcb(robot, true))).toBeLessThan(1000)
  })

  it("lays out a 460-part board in seconds", () => {
    const board = synthetic(77)
    expect(board.components).toHaveLength(462)
    let placed: Project | undefined
    const ms = best(2, () => (placed = autoPlacePcb(board)))
    // About 0.5 s on a laptop.
    expect(ms).toBeLessThan(6000)
    expect(placed!.components.every((c) => c.pcb.placed)).toBe(true)
    expect(placementProblems(placed!)).toEqual([])
    expect(decouplingGaps(placed!).every((g) => g.gap <= 2)).toBe(true)
  })
})

describe("the locked flag", () => {
  it("keeps locked parts out of a drag, a rotation and a flip in the PCB editor", () => {
    let p = autoPlacePcb(mcuSheet())
    p = { ...p, components: p.components.map((c) => (c.ref === "U1" ? { ...c, pcb: { ...c.pcb, locked: true } } : c)) }
    const ids = p.components.map((c) => c.id)
    const split = splitLocked(p, ids)
    expect(split.locked).toEqual(["U1"])
    expect(split.free).toEqual(p.components.filter((c) => c.ref !== "U1").map((c) => c.id))
    expect(splitLocked(p, [byRef(p, "U1").id])).toEqual({ free: [], locked: ["U1"] })
  })

  it("survives a save and a load", () => {
    let p = createProject("t")
    p = addComponent(p, "resistor", { pcb: { x: 1, y: 2, placed: true, locked: true } }).project
    const back = parseProjectFile(serializeProject(p), p)
    expect(back.components[0].pcb.locked).toBe(true)
  })
})

describe("paste carries a part's 3D model", () => {
  it("gives the copy the model its part had on that footprint, in another project too", async () => {
    const { modelAssignment, setModel, supplierModel } = await import("../src/model/models3d")
    const placed = addComponent(createProject("source"), "resistor", { sch: { x: 0, y: 0 } })
    const model = supplierModel({ id: "0123456789abcdef0123456789abcdef", title: "R0603", center: { x: 0, y: 0 }, bottom: 0, rotation: { x: 0, y: 0, z: 0 } })
    const source = setModel(placed.project, placed.component.partId, placed.component.footprint, model)
    const pasted = pasteItems(createProject("target"), { project: source, components: [placed.component.id], wires: [], labels: [], blocks: [] }, { x: 20, y: 0 })
    expect(pasted.ok).toBe(true)
    if (!pasted.ok) return
    expect(modelAssignment(pasted.project, placed.component.partId, placed.component.footprint)?.id).toBe(model.id)
  })
})
