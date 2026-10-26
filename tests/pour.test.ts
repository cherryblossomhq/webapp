import { describe, expect, it } from "vitest"
import { gerberLayers } from "../src/export/gerber"
import { drillHoles } from "../src/export/excellon"
import { M3_HOLES, mountingHoles } from "../src/model/board"
import { zoneClearance } from "../src/model/rules"
import { computeConnectivity } from "../src/model/connectivity"
import { pcbPads } from "../src/model/instances"
import { addComponent, addTrace, createProject, labelPin } from "../src/model/ops"
import { analyzePcb } from "../src/model/pcb"
import { fillTester } from "../src/model/pour"
import type { Project } from "../src/model/types"

/** Two resistors whose pin 2 is GND and pin 1 is SIG, joined by a SIG trace on top. */
function board(): Project {
  let p = createProject("Pour test")
  p = { ...p, board: { ...p.board, width: 30, height: 20 } }
  const a = addComponent(p, "resistor", { sch: { x: 0, y: 0 }, pcb: { x: -6, y: 0, placed: true } })
  p = a.project
  const b = addComponent(p, "resistor", { sch: { x: 3, y: 0 }, pcb: { x: 6, y: 0, placed: true } })
  p = b.project
  for (const c of [a.component, b.component]) {
    p = labelPin(p, { componentId: c.id, pin: "1" }, "SIG")
    p = labelPin(p, { componentId: c.id, pin: "2" }, "GND")
  }
  const pad = (id: string, pin: string) => pcbPads(p.components.find((c) => c.id === id)!).find((x) => x.pin === pin)!
  const s1 = pad(a.component.id, "1")
  const s2 = pad(b.component.id, "1")
  p = addTrace(p, { layer: "top", width: 0.25, points: [s1, { x: s1.x, y: 4 }, { x: s2.x, y: 4 }, s2] }).project
  return p
}

const analyze = (p: Project) => analyzePcb(p, computeConnectivity(p))

describe("copper pours", () => {
  it("connects same-net pads through the fill and clears other nets", () => {
    const p = board()
    const before = analyze(p)
    expect(before.ratsnest.length).toBe(1)

    const poured = { ...p, zones: [{ id: "z1", net: "GND", layer: "top" as const }] }
    const res = analyze(poured)
    expect(res.zoneFills).toHaveLength(1)
    expect(res.zoneFills[0].polygons.length).toBeGreaterThan(0)
    // GND pads are joined by the pour, SIG by the trace: nothing left to route.
    expect(res.ratsnest).toEqual([])
    expect(res.violations.filter((v) => v.severity === "error")).toEqual([])

    // A point just outside a SIG pad (closer than the zone clearance) is not filled.
    const sig = pcbPads(poured.components[0]).find((x) => x.pin === "1")!
    const tests = res.zoneFills[0].polygons.map(fillTester)
    const near = { x: sig.x - sig.width / 2 - 0.15, y: sig.y }
    expect(tests.some((t) => t(near))).toBe(false)
    // Open board far from copper is filled.
    expect(tests.some((t) => t({ x: 0, y: -7 }))).toBe(true)
  })

  it("drops a pour whose net has no pins", () => {
    const p = { ...board(), zones: [{ id: "z1", net: "NOPE", layer: "bottom" as const }] }
    const res = analyze(p)
    expect(res.zoneFills[0].polygons).toEqual([])
  })

  it("exports fills as Gerber regions before pads", () => {
    const p = { ...board(), zones: [{ id: "z1", net: "GND", layer: "top" as const }] }
    const res = analyze(p)
    const layers = gerberLayers(p, res.zoneFills)
    const top = layers.F_Cu
    expect(top).toContain("G36*")
    expect(top).toContain("%LPC*%")
    expect(top.indexOf("G36*")).toBeLessThan(top.indexOf("D03*"))
    expect(layers.B_Cu).not.toContain("G36*")
  })
})

describe("mounting holes", () => {
  it("adds plated corner holes to copper, drill and DRC", () => {
    const p = { ...board(), board: { ...board().board, mountingHoles: M3_HOLES } }
    const holes = mountingHoles(p.board)
    expect(holes).toHaveLength(4)
    expect(drillHoles(p).filter((h) => h.diameter === M3_HOLES.drill)).toHaveLength(4)
    const res = analyze(p)
    expect(res.items.filter((i) => i.kind === "pad" && i.pad.componentId === "#board")).toHaveLength(4)
    const top = gerberLayers(p).F_Cu
    expect(top).toContain("C,6*")
  })

  it("skips holes on boards too small for them", () => {
    const p = createProject()
    expect(mountingHoles({ ...p.board, width: 5, height: 5, mountingHoles: M3_HOLES })).toEqual([])
  })
})

describe("non-plated holes", () => {
  it("are cleared by the zone clearance, with no thermal spokes", () => {
    let p = createProject("NPTH pour")
    p = { ...p, board: { ...p.board, width: 40, height: 60 } }
    const u = addComponent(p, "esp32_devkit_v1", { sch: { x: 0, y: 0 }, pcb: { x: 0, y: 0, placed: true } })
    p = labelPin(u.project, { componentId: u.component.id, pin: "2" }, "GND")
    p = labelPin(p, { componentId: u.component.id, pin: "29" }, "GND")
    p = { ...p, zones: [{ id: "z1", net: "GND", layer: "top" as const }] }
    const res = analyze(p)
    expect(res.violations.filter((v) => v.severity === "error")).toEqual([])
    const tests = res.zoneFills[0].polygons.map(fillTester)
    const inFill = (q: { x: number; y: number }) => tests.some((t) => t(q))
    const gap = zoneClearance(p)
    const holes = pcbPads(p.components[0]).filter((pad) => pad.plated === false)
    expect(holes).toHaveLength(4)
    for (const h of holes) {
      const r = h.width / 2
      for (let i = 0; i < 16; i++) {
        const a = (i / 16) * Math.PI * 2
        // Nothing inside the clearance ring, spokes included.
        expect(inFill({ x: h.x + Math.cos(a) * (r + gap - 0.05), y: h.y + Math.sin(a) * (r + gap - 0.05) })).toBe(false)
        // Solid pour just outside it, away from the header pins above the hole.
        if (Math.sin(a) <= 0) expect(inFill({ x: h.x + Math.cos(a) * (r + gap + 0.3), y: h.y + Math.sin(a) * (r + gap + 0.3) })).toBe(true)
      }
    }
  })
})
