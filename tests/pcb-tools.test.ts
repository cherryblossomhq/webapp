import { beforeEach, describe, expect, it } from "vitest"
import { runTool } from "../src/ai/tools"
import { computeConnectivity } from "../src/model/connectivity"
import { padGap } from "../src/model/decoupling"
import { EXAMPLES } from "../src/model/examples"
import { pcbPads } from "../src/model/instances"
import { autoPlacePcb } from "../src/model/ops"
import { analyzePcb } from "../src/model/pcb"
import type { Project } from "../src/model/types"
import { useProjectStore } from "../src/store/projectStore"
import { buckDesign, step } from "./powerStageFixtures"

const comp = (p: Project, ref: string) => p.components.find((c) => c.ref === ref)!
const pad = (p: Project, ref: string, pin: string) => pcbPads(comp(p, ref)).find((x) => x.pin === pin)!
const gap = (p: Project, a: [string, string], b: [string, string]) => padGap(pad(p, ...a), pad(p, ...b))
const problems = (p: Project) => analyzePcb(p, computeConnectivity(p)).violations.filter((v) => v.kind === "overlap" || v.kind === "outside-board")
const bad = (p: Project) =>
  analyzePcb(p, computeConnectivity(p)).violations.filter((v) => v.severity === "error" && (v.kind === "short" || v.kind === "clearance")).map((v) => `${v.kind}: ${v.message}`)
const example = (id: string) => EXAMPLES.find((e) => e.id === id)!.project
const place = (p: Project, placements: object[], extra: object = {}) => runTool(p, "place_parts", { placements, ...extra })

let placed: Project
beforeEach(() => {
  placed = autoPlacePcb(buckDesign())
})

describe("place_parts", () => {
  it("moves, turns, flips and locks a part by absolute millimetres without touching the schematic", () => {
    const before = comp(placed, "C1")
    const out = place(placed, [{ ref: "C1", x: 5, y: -3, rotation: 90, side: "bottom", lock: true }])
    expect(out.isError).toBe(false)
    const c = comp(out.project, "C1")
    expect(c.pcb).toMatchObject({ x: 5, y: -3, rot: 90, side: "bottom", placed: true, locked: true })
    expect(c.sch).toEqual(before.sch)
    expect(out.result).toContain("C1: (5.00, -3.00) rot 90 bottom, locked")
  })

  it("moves several parts in one call, by absolute position and by offset", () => {
    const c2 = comp(placed, "C2").pcb
    const out = place(placed, [
      { ref: "C1", x: 10, y: 5 },
      { ref: "C2", dx: 1.5, dy: -0.5 },
      { ref: "R1", rotation: 180 },
    ])
    expect(out.isError).toBe(false)
    expect(comp(out.project, "C1").pcb).toMatchObject({ x: 10, y: 5 })
    expect(comp(out.project, "C2").pcb).toMatchObject({ x: Math.round((c2.x + 1.5) * 100) / 100, y: Math.round((c2.y - 0.5) * 100) / 100 })
    expect(comp(out.project, "R1").pcb.rot).toBe(180)
    expect(out.summary).toBe("Placed C1, C2, R1 on the PCB")
  })

  it("puts a part beside a pin, within the gap asked, on that part's side, clear of everything", () => {
    const far = place(placed, [{ ref: "C1", x: 14, y: 9 }]).project
    expect(gap(far, ["C1", "1"], ["U1", "3"])).toBeGreaterThan(5)
    const out = place(far, [{ ref: "C1", near: "U1.VIN", max_gap_mm: 1 }])
    expect(out.isError).toBe(false)
    expect(gap(out.project, ["C1", "1"], ["U1", "3"])).toBeLessThanOrEqual(1)
    expect(comp(out.project, "C1").pcb.side).toBe(comp(out.project, "U1").pcb.side)
    expect(problems(out.project)).toEqual([])
    expect(out.result).toMatch(/mm from U1\.VIN \(C1\.1\)/)
    expect(out.result).not.toContain("NOT within")
  })

  it("keeps the ground pin close too: a capacitor straddles VIN and GND", () => {
    const out = place(placed, [{ ref: "C2", near: "U1.VIN" }])
    expect(out.result).toMatch(/mm from U1\.GND \(C2\.2\)/)
    expect(gap(out.project, ["C2", "2"], ["U1", "1"])).toBeLessThan(gap(placed, ["C4", "2"], ["U1", "1"]))
  })

  it("follows the part's side and avoids courtyards when several parts go to one pin", () => {
    const flipped = place(placed, [{ ref: "U1", side: "bottom" }]).project
    const out = place(flipped, [
      { ref: "C1", near: "U1.VIN" },
      { ref: "C2", near: "U1.VIN" },
      { ref: "C4", near: "U1.VIN" },
      { ref: "C5", near: "U1.VIN" },
    ])
    expect(out.isError).toBe(false)
    for (const ref of ["C1", "C2", "C4", "C5"]) expect(comp(out.project, ref).pcb.side).toBe("bottom")
    expect(problems(out.project)).toEqual([])
  })

  it("prefers the side asked for", () => {
    // The pins of a SOT-23-6 face up and down, so the two sides of a pin are above and below it.
    const clear = place(
      placed,
      ["C1", "C3", "C4", "C5", "L1", "R1", "R2"].map((ref, i) => ({ ref, x: -16 + i * 5, y: 12 })),
    ).project
    const above = place(clear, [{ ref: "C2", near: "U1.VIN", direction: "above", max_gap_mm: 3 }]).project
    const below = place(clear, [{ ref: "C2", near: "U1.VIN", direction: "below", max_gap_mm: 3 }]).project
    expect(comp(above, "C2").pcb.y).toBeGreaterThan(comp(below, "C2").pcb.y)
  })

  it("stays inside the board when the chip sits at its edge", () => {
    const corner = place(placed, [{ ref: "U1", x: -17, y: -12 }]).project
    const out = place(corner, [{ ref: "C1", near: "U1.VIN" }, { ref: "L1", near: "U1.SW" }])
    expect(out.isError).toBe(false)
    expect(problems(out.project)).toEqual([])
  })

  it("says so when no clear spot is within reach, and changes nothing", () => {
    const tiny = { ...placed, board: { ...placed.board, width: 3, height: 3 } }
    const out = place(tiny, [{ ref: "C1", near: "U1.VIN" }])
    expect(out.isError).toBe(true)
    expect(out.result).toContain("no clear spot within")
    expect(out.project).toBe(tiny)
  })

  it("reports a gap it could not reach instead of pretending", () => {
    const out = place(placed, [{ ref: "C1", near: "U1.VIN", max_gap_mm: 0.001 }])
    expect(out.isError).toBe(false)
    expect(out.result).toMatch(/NOT within the 0\.001 mm asked; the closest clear spot is \d/)
  })

  it("refuses a locked part unless the entry unlocks it, and applies the rest", () => {
    const locked = place(placed, [{ ref: "C1", lock: true }]).project
    expect(comp(locked, "C1").pcb.locked).toBe(true)
    const refused = place(locked, [{ ref: "C1", x: 1, y: 1 }])
    expect(refused.isError).toBe(true)
    expect(refused.result).toContain("C1: locked")
    expect(refused.project).toBe(locked)

    const mixed = place(locked, [{ ref: "C1", x: 1, y: 1 }, { ref: "C2", x: 2, y: 2 }])
    expect(mixed.isError).toBe(false)
    expect(comp(mixed.project, "C1").pcb).toMatchObject({ x: comp(locked, "C1").pcb.x, locked: true })
    expect(comp(mixed.project, "C2").pcb).toMatchObject({ x: 2, y: 2 })
    expect(mixed.result).toContain("Not changed: C1: locked")

    const released = place(locked, [{ ref: "C1", x: 1, y: 1, lock: false }])
    expect(comp(released.project, "C1").pcb).toMatchObject({ x: 1, y: 1 })
    expect(comp(released.project, "C1").pcb.locked).toBeUndefined()
    // A lock-only entry on a locked part is allowed: it is not a move.
    expect(place(locked, [{ ref: "C1", lock: true }]).isError).toBe(false)
  })

  it("keeps a part it locked where it is through layout_pcb with relayout_all", () => {
    const pinned = place(placed, [{ ref: "L1", x: 14, y: 9, lock: true }]).project
    const again = runTool(pinned, "layout_pcb", { relayout_all: true }).project
    expect(comp(again, "L1").pcb).toMatchObject({ x: 14, y: 9, locked: true })
  })

  it("refuses what it can't do, with the fix in the message", () => {
    const unplaced = buckDesign()
    expect(place(unplaced, [{ ref: "C1", near: "U1.VIN" }]).result).toContain("U1 is not on the PCB yet")
    expect(place(unplaced, [{ ref: "C1", dx: 1 }]).result).toContain("is not on the PCB yet")
    expect(place(placed, [{ ref: "C1", near: "U1.NOPE" }]).result).toMatch(/U1 has pins 1\/GND/)
    expect(place(placed, [{ ref: "C1", near: "U1.VIN", x: 1, y: 1 }]).result).toContain("give one of near, x and y, or dx and dy")
    expect(place(placed, [{ ref: "C9", x: 1, y: 1 }]).result).toContain("C9: no such component")
    expect(place(placed, [{ ref: "C1" }]).result).toContain("nothing to change")
    expect(place(placed, [{ ref: "C1", near: "C1.1" }]).result).toContain("beside itself")
    expect(place(placed, [{ ref: "C1", near: "U1.VIN", pin: "9" }]).result).toMatch(/C1 has pins 1, 2/)
  })

  it("warns when an absolute position puts a part off the board or over another", () => {
    const off = place(placed, [{ ref: "C1", x: 60, y: 0 }])
    expect(off.result).toContain("sticks out of the board outline")
    const u1 = comp(placed, "U1").pcb
    const over = place(placed, [{ ref: "C1", x: u1.x, y: u1.y }])
    // Said by the overlap check once every part has moved, which tests a turned part by its turned courtyard.
    expect(over.result).toMatch(/Checks now report: .*(C1 overlaps U1|U1 overlaps C1)/)
  })

  describe("never leaves a short behind", () => {
    // Rotating a routed part in place used to leave its old traces across the swapped pads and say only that it moved.
    it("turns R3 on the shipped blinker without a short, with or without clear_traces", () => {
      const blinker = example("blinker")
      expect(bad(blinker)).toEqual([])
      for (const clear of [false, true]) {
        const out = place(blinker, [{ ref: "R3", rotation: 180 }], clear ? { clear_traces: true } : {})
        expect(out.isError).toBe(false)
        expect(bad(out.project)).toEqual([])
        expect(out.result).toMatch(/Removed \d+ traces? /)
      }
    })

    it("turns every routed part of every shipped example: copper never adds a short, and any new error is named in the result", () => {
      // The parts a review found shorting when turned in place, per example.
      const turned: Record<string, string[]> = { blinker: ["R1", "R2", "R3", "C1", "J1"], regulator: ["C1", "R1"], node: ["C1", "C2", "R1", "C4", "C5"], mcu: ["C1", "R1", "R2"] }
      for (const [id, refs] of Object.entries(turned)) {
        const p = example(id)
        const base = new Set(bad(p))
        const bare = new Set(bad({ ...p, traces: [], vias: [] }))
        for (const c of p.components.filter((x) => refs.includes(x.ref) && x.pcb.placed && !x.pcb.locked)) {
          for (const rotation of [90, 180] as const) {
            if (c.pcb.rot === rotation) continue
            const out = place(p, [{ ref: c.ref, rotation }])
            if (out.isError) continue
            // Pad against pad (no copper involved) is the part's own doing; every such error is named in the result.
            for (const m of bad(out.project).filter((x) => !base.has(x))) {
              expect(bare.has(m) || out.result.includes(m.slice(m.indexOf(": ") + 2)), `${id} ${c.ref} ${rotation}: ${m}`).toBe(true)
            }
            const withoutCopper = bad({ ...out.project, traces: [], vias: [] })
            expect(bad(out.project).filter((m) => m.startsWith("short") && !withoutCopper.includes(m) && !base.has(m)), `${id} ${c.ref} ${rotation}`).toEqual([])
          }
        }
      }
    }, 120_000)

    it("refuses a move that locked copper would make a short, naming the short", () => {
      const blinker = example("blinker")
      const locked = { ...blinker, traces: blinker.traces.map((t) => ({ ...t, locked: true })) }
      const out = place(locked, [{ ref: "R3", rotation: 180 }])
      expect(out.isError).toBe(true)
      expect(out.result).toMatch(/would leave Short between/)
      expect(out.project).toBe(locked)
    })

    it("reports a short two pads make, instead of only saying it moved", () => {
      const out = place(placed, [{ ref: "C1", x: comp(placed, "U1").pcb.x, y: comp(placed, "U1").pcb.y }])
      expect(out.isError).toBe(false)
      expect(out.result).toMatch(/Checks now report: Short between/)
    })
  })

  describe("copper", () => {
    let routed: Project
    beforeEach(() => {
      routed = runTool(placed, "route_pcb", {}).project
      expect(routed.traces.length).toBeGreaterThan(0)
    })

    it("keeps traces as dragging does and says how many now end on old pads", () => {
      const out = place(routed, [{ ref: "C1", x: 14, y: 9 }])
      expect(out.project.traces).toEqual(routed.traces)
      expect(out.result).toMatch(/[Ll]eft \d+ traces?.* that no longer reach(es)? (its|their) pad \(run route_pcb or clear_traces\)/)
    })

    it("words a mixed move as one summary of what was removed and what was left", () => {
      const regulator = example("regulator")
      const out = place(regulator, [{ ref: "C1", rotation: 180 }])
      expect(out.result).toMatch(/Removed 1 trace that touched the old pads or would have shorted; left 1 trace that no longer reaches its pad \(run route_pcb or clear_traces\)\./)
      expect(out.result).not.toMatch(/unlocked trace\(s\)/)
    })

    it("names the copper a new clearance error is between, and reports checks in one sentence", () => {
      const out = place(example("blinker"), [{ ref: "J1", rotation: 90 }])
      expect(out.result).toMatch(/Clearance \d\.\d{3} mm < 0\.2 mm between J1\.1 and a via/)
      expect(out.result.match(/Checks now report/g)).toHaveLength(1)
    })

    it("removes the unlocked copper that touched the old pads with clear_traces", () => {
      const out = place(routed, [{ ref: "C1", x: 14, y: 9 }], { clear_traces: true })
      expect(out.project.traces.length).toBeLessThan(routed.traces.length)
      expect(out.result).toMatch(/Removed \d+ traces? /)
      expect(out.result).not.toContain("no longer reach")
    })

    it("removes a via that a cleared trace leaves joining nothing", () => {
      const p = pad(placed, "C1", "1")
      const end = { x: p.x, y: p.y + 6 }
      const withVia = {
        ...placed,
        traces: [{ id: "tx", layer: "top" as const, width: 0.25, points: [{ x: p.x, y: p.y }, end] }],
        vias: [{ id: "vx", x: end.x, y: end.y, diameter: 0.6, drill: 0.3 }],
      }
      const out = runTool(withVia, "clear_routing", { refs: ["C1"] })
      expect(out.project.traces).toHaveLength(0)
      expect(out.project.vias).toHaveLength(0)
    })

    it("stays put when the part already stands as close as the search can get", () => {
      const out = place(routed, [{ ref: "C1", near: "U1.VIN", max_gap_mm: 1 }])
      const before = comp(routed, "C1").pcb
      const now = comp(out.project, "C1").pcb
      expect(Math.hypot(now.x - before.x, now.y - before.y)).toBeLessThan(0.01)
      expect(out.result).toContain("stays")
    })

    it("never removes locked copper, and says it no longer reaches the part", () => {
      const lockedTraces = routed.traces.map((t, i) => (i === 0 ? { ...t, locked: true } : t))
      const target = lockedTraces[0]
      const owner = routed.components.find((c) => pcbPads(c).some((p) => p.layers.includes(target.layer) && target.points.some((pt) => Math.hypot(pt.x - p.x, pt.y - p.y) < 0.01)))!
      const out = place({ ...routed, traces: lockedTraces }, [{ ref: owner.ref, dx: 3, dy: 3, lock: false }], { clear_traces: true })
      expect(out.project.traces.some((t) => t.id === target.id)).toBe(true)
      expect(out.result).toMatch(/locked trace\(s\) and \d+ locked via\(s\) touched the old pads and stay/)
    })
  })

  it("is one undo step in the editor", () => {
    const store = useProjectStore.getState()
    store.open(placed)
    const out = place(useProjectStore.getState().project!, [{ ref: "C1", x: 3, y: 3 }, { ref: "C2", x: 4, y: 4 }, { ref: "L1", rotation: 90 }])
    useProjectStore.getState().commit(() => out.project)
    expect(comp(useProjectStore.getState().project!, "C2").pcb).toMatchObject({ x: 4, y: 4 })
    useProjectStore.getState().undo()
    const back = useProjectStore.getState().project!
    for (const ref of ["C1", "C2", "L1"]) expect(comp(back, ref).pcb).toEqual(comp(placed, ref).pcb)
  })
})

describe("set_net_width", () => {
  it("sets per-net widths like the Inspector's net list", () => {
    const out = runTool(placed, "set_net_width", { widths: { VIN: 0.8, SW: 1 } })
    expect(out.isError).toBe(false)
    expect(out.project.rules.netWidths).toEqual({ VIN: 0.8, SW: 1 })
    expect(out.result).toContain("VIN: 0.8 mm (was 0.25, the default)")
    expect(out.result).toContain("Re-routing stays with route_pcb")
  })

  it("refuses a width under the design rules' minimum and names the fab class", () => {
    const out = runTool(placed, "set_net_width", { widths: { VIN: 0.1, SW: 0.5 } })
    expect(out.isError).toBe(true)
    expect(out.result).toContain("below the 0.15 mm minimum trace width of the design rules (Standard (6 mil) class)")
    expect(out.project).toBe(placed)
    const custom = runTool({ ...placed, rules: { ...placed.rules, minTraceWidth: 0.18 } }, "set_net_width", { widths: { VIN: 0.1 } })
    expect(custom.result).toContain("custom rules")
    expect(runTool(placed, "set_net_width", { widths: { VIN: 11 } }).result).toContain("wider than 10 mm")
  })

  it("suggests the right net for an unknown name", () => {
    const out = runTool(placed, "set_net_width", { widths: { vin: 0.8, "5V": 0.5 } })
    expect(out.isError).toBe(true)
    expect(out.result).toContain("no net named vin. Did you mean VIN?")
    expect(out.result).toContain("no net named 5V.")
  })

  it("resets a net to the default and leaves the others", () => {
    const set = runTool(placed, "set_net_width", { widths: { VIN: 0.8, VOUT: 0.6 } }).project
    const out = runTool(set, "set_net_width", { reset: ["VIN"] })
    expect(out.project.rules.netWidths).toEqual({ VOUT: 0.6 })
    expect(out.result).toContain("VIN: back to the default 0.25 mm")
    expect(runTool(placed, "set_net_width", {}).isError).toBe(true)
  })

  it("warns about pads too small for the width and traces that keep the old one", () => {
    const routed = runTool(placed, "route_pcb", {}).project
    const out = runTool(routed, "set_net_width", { widths: { VIN: 1.2 } })
    expect(out.result).toMatch(/\d+ pad\(s\) are narrower, down to/)
    expect(out.result).toMatch(/\d+ existing trace\(s\) keep their width/)
  })

  it("makes the router use it for new traces", () => {
    const wide = runTool(placed, "set_net_width", { widths: { VIN: 0.6 } }).project
    const routed = runTool(wide, "route_pcb", {}).project
    const analysis = analyzePcb(routed, computeConnectivity(routed))
    const vin = computeConnectivity(routed).nets.find((n) => n.name === "VIN")!.id
    const widths = routed.traces.filter((t) => analysis.traceNet.get(t.id) === vin).map((t) => t.width)
    expect(widths.length).toBeGreaterThan(0)
    // Pads here are 0.54 mm, so routes into them fall back to the next preferred width down.
    expect(Math.max(...widths)).toBeGreaterThan(0.25)
  })
})

describe("clear_routing", () => {
  it("clears unlocked traces and vias, keeps locked copper and stitching vias", () => {
    const routed = runTool(placed, "route_pcb", {}).project
    const withLocked = { ...routed, traces: routed.traces.map((t, i) => (i === 0 ? { ...t, locked: true } : t)) }
    const out = runTool(withLocked, "clear_routing", {})
    expect(out.project.traces).toHaveLength(1)
    expect(out.project.traces[0].locked).toBe(true)
    expect(out.result).toContain("Removed")
    const all = runTool(withLocked, "clear_routing", { include_locked: true })
    expect(all.project.traces).toHaveLength(0)
  })

  it("limits itself to nets or to the copper at parts", () => {
    const routed = runTool(placed, "route_pcb", {}).project
    const net = runTool(routed, "clear_routing", { nets: ["VIN"] })
    expect(net.project.traces.length).toBeLessThan(routed.traces.length)
    expect(net.project.traces.length).toBeGreaterThan(0)
    const part = runTool(routed, "clear_routing", { refs: ["L1"] })
    expect(part.project.traces.length).toBeLessThan(routed.traces.length)
    expect(runTool(routed, "clear_routing", { nets: ["NOPE"] }).isError).toBe(true)
    expect(runTool(placed, "clear_routing", {}).project).toBe(placed)
  })
})

describe("get_design", () => {
  const design = (p: Project) => JSON.parse(runTool(p, "get_design", {}).result) as {
    board_mm: { center_x: number; center_y: number }
    components: { ref: string; pcb?: { x: number; y: number; rot: number; side: string; locked?: boolean } }[]
  }

  it("reports where parts stand on the PCB, and whether they are locked", () => {
    const pinned = place(placed, [{ ref: "C1", x: 3.5, y: -2, rotation: 270, side: "bottom", lock: true }]).project
    const d = design(pinned)
    expect(d.components.find((c) => c.ref === "C1")!.pcb).toEqual({ x: 3.5, y: -2, rot: 270, side: "bottom", locked: true })
    expect(d.components.find((c) => c.ref === "C2")!.pcb).not.toHaveProperty("locked")
    expect(d.board_mm).toMatchObject({ center_x: 0, center_y: 0 })
    expect(design(buckDesign()).components.every((c) => c.pcb === undefined)).toBe(true)
  })

  it("adds a bounded amount on the biggest example", () => {
    const biggest = [...EXAMPLES].sort((a, b) => b.project.components.length - a.project.components.length)[0].project
    const full = runTool(biggest, "get_design", {}).result
    const bare = JSON.stringify(
      JSON.parse(full, (k, v) => (k === "pcb" && v && typeof v === "object" && "side" in v ? undefined : v)),
    )
    const parts = biggest.components.filter((c) => c.pcb.placed).length
    expect(full.length - bare.length).toBeLessThanOrEqual(parts * 70)
    expect(full.length).toBeLessThan(bare.length * 1.15)
  })
})

describe("wiring", () => {
  it("lists the new tools, with inputs checked before they run", () => {
    for (const name of ["place_parts", "set_net_width", "clear_routing"]) expect(runTool(placed, name, { placements: "x", widths: 5, nets: 3 }).result).toMatch(/Invalid input/)
    expect(step(placed, "set_net_width", { widths: { GND: 0.5 } }).rules.netWidths).toEqual({ GND: 0.5 })
  })
})
