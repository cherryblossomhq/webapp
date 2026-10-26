import { describe, expect, it } from "vitest"
import { runTool, type ToolOutcome } from "../src/ai/tools"
import { computeConnectivity } from "../src/model/connectivity"
import { unrequestedMerges } from "../src/model/merges"
import { addComponent, addLabel, addWire, createProject, findPin, resolvePinSpec } from "../src/model/ops"
import type { Project } from "../src/model/types"

const add = (p: Project, part_id: string, extra: Record<string, unknown> = {}) => {
  const out = runTool(p, "add_component", { part_id, ...extra })
  expect(out.isError, out.result).toBe(false)
  return out.project
}
const connect = (p: Project, pins: string[], net_name?: string): ToolOutcome =>
  runTool(p, "connect", net_name ? { pins, net_name } : { pins })
const update = (p: Project, input: Record<string, unknown>) => runTool(p, "update_component", input)

const pinOf = (p: Project, spec: string) => {
  const pin = resolvePinSpec(p, spec)!
  return `${pin.componentId}:${pin.pin}`
}
const sameNet = (p: Project, a: string, b: string) => {
  const conn = computeConnectivity(p)
  const na = conn.pinNet.get(pinOf(p, a))
  return !!na && na === conn.pinNet.get(pinOf(p, b))
}
const pinAt = (p: Project, spec: string) => findPin(p, resolvePinSpec(p, spec)!)!.pos

describe("update_component never joins nets", () => {
  /** R1 with R1.2 on VIN, R2 with R2.1 on 3V3, both placed without x/y. */
  const twoRails = () => {
    let p = createProject("t")
    p = add(p, "resistor")
    p = add(p, "resistor")
    p = connect(p, ["R1.2"], "VIN").project
    p = connect(p, ["R2.1"], "3V3").project
    return p
  }

  it("refuses a move that lays R2 on R1, names the pins and rails, and offers a spot that works", () => {
    const p = twoRails()
    const out = update(p, { ref: "R2", x: 0, y: 0 })
    expect(out.isError).toBe(true)
    expect(out.project).toBe(p)
    expect(out.result).toMatch(/R1/)
    expect(out.result).toMatch(/VIN/)
    expect(out.result).toMatch(/3V3/)
    expect(out.result).not.toMatch(/move it with update_component/)
    const spot = out.result.match(/x=(-?[\d.]+), y=(-?[\d.]+)/)
    expect(spot, out.result).not.toBeNull()
    const moved = update(p, { ref: "R2", x: Number(spot![1]), y: Number(spot![2]) })
    expect(moved.isError, moved.result).toBe(false)
    expect(sameNet(moved.project, "R1.2", "R2.1")).toBe(false)
    expect(computeConnectivity(moved.project).conflicts).toEqual([])
  })

  it("refuses a move that lands a pin on the other rail's wire end, even one step away from it", () => {
    const p = twoRails()
    const r1 = pinAt(p, "R1.2")
    // R2.1 goes to exactly where R1's label stub ends.
    const stub = p.labels.find((l) => l.name === "VIN")!
    const out = update(p, { ref: "R2", x: stub.x + 0.3, y: stub.y })
    expect(out.isError, out.result).toBe(true)
    expect(out.project).toBe(p)
    expect(r1.x).toBeLessThan(stub.x)
  })

  it("refuses a rotation that would join nets, and says which turn works", () => {
    // R1 lies flat at the origin. R2 stands on its end 0.6 above, with R2.1 low enough to meet
    // the pin R1.2 reaches when R1 stands up.
    let p = createProject("t")
    p = add(p, "resistor", { x: 0, y: 0 })
    p = add(p, "resistor", { x: 0, y: 0.6, rotation: 90 })
    p = connect(p, ["R1.2"], "VIN").project
    p = connect(p, ["R2.1"], "3V3").project
    const out = update(p, { ref: "R1", rotation: 90 })
    expect(out.isError, out.result).toBe(true)
    expect(out.project).toBe(p)
    expect(out.result).toMatch(/VIN/)
    expect(out.result).toMatch(/3V3/)
    expect(out.result).toMatch(/Rotation 180 works|x=-?[\d.]+, y=-?[\d.]+/)
  })

  it("turns a part's net labels with it, and keeps a drawn wire attached to its pin", () => {
    let p = createProject("t")
    p = add(p, "resistor", { x: 0, y: 0 })
    p = add(p, "resistor", { x: 3, y: 0 })
    p = add(p, "resistor", { x: 6, y: 0 })
    p = connect(p, ["R1.2", "R2.1"], "IN").project
    p = connect(p, ["R2.2", "R3.1"], "SIG").project
    for (const rotation of [90, 180, 270, 0]) {
      const out = update(p, { ref: "R2", rotation })
      expect(out.isError, out.result).toBe(false)
      expect(out.result).not.toMatch(/no longer/)
      p = out.project
      expect(sameNet(p, "R1.2", "R2.1")).toBe(true)
      expect(sameNet(p, "R2.2", "R3.1")).toBe(true)
      expect(sameNet(p, "R2.1", "R2.2")).toBe(false)
    }
    // A drawn wire follows its pin when the part stands up.
    let q = createProject("t")
    q = add(q, "resistor", { x: 0, y: 0 })
    q = add(q, "resistor", { x: 3, y: 2 })
    q = connect(q, ["R1.2", "R2.1"]).project
    const out = update(q, { ref: "R2", rotation: 90 })
    expect(out.isError, out.result).toBe(false)
    expect(out.result).not.toMatch(/no longer/)
    expect(sameNet(out.project, "R1.2", "R2.1")).toBe(true)
  })

  it("takes a part's net labels along when it moves, so a far move does not stretch them across the sheet", () => {
    let p = createProject("t")
    p = add(p, "ams1117_3v3")
    p = add(p, "ams1117_3v3")
    p = connect(p, ["U1.VIN", "U2.VIN"], "VIN").project
    p = connect(p, ["U1.VOUT", "U2.VOUT"], "3V3").project
    const before = p.wires.length
    const out = update(p, { ref: "U2", x: 30, y: 10 })
    expect(out.isError, out.result).toBe(false)
    expect(out.project.wires.length).toBe(before)
    const q = out.project
    // Every wire is still short: a stub, not a line back to where the label used to be.
    for (const w of q.wires) {
      const xs = w.points.map((pt) => pt.x)
      expect(Math.max(...xs) - Math.min(...xs)).toBeLessThan(2)
    }
    expect(sameNet(q, "U1.VIN", "U2.VIN")).toBe(true)
    expect(sameNet(q, "U1.VIN", "U1.VOUT")).toBe(false)
  })

  it("lets a power port change rails", () => {
    let p = createProject("t")
    p = add(p, "resistor")
    p = add(p, "power", { props: { net: "VCC" } })
    p = connect(p, ["R1.1", "#PWR1"]).project
    expect(sameNet(p, "R1.1", "#PWR1.1")).toBe(true)
    // Moving R1 and the port to a rail named 5V is what was asked for.
    const out = update(p, { ref: "#PWR1", props: { net: "5V" } })
    expect(out.isError, out.result).toBe(false)
    // Sending the port that holds R2 to the GND rail is asking for R2 to join GND.
    let q = createProject("t")
    q = add(q, "resistor")
    q = add(q, "resistor")
    q = add(q, "ground")
    q = add(q, "power", { props: { net: "VCC" } })
    q = connect(q, ["R1.1", "#GND1"]).project
    q = connect(q, ["R2.1", "#PWR1"]).project
    const joined = update(q, { ref: "#PWR1", props: { net: "GND" } })
    expect(joined.isError, joined.result).toBe(false)
    expect(sameNet(joined.project, "R1.1", "R2.1")).toBe(true)
  })

  it("reports pins that come loose when a part is removed from a wire others hang from", () => {
    let p = createProject("t")
    p = add(p, "resistor", { x: 0, y: 0 })
    p = add(p, "resistor", { x: 1.5, y: 0 })
    p = add(p, "resistor", { x: 0.75, y: 1.3, rotation: 90 })
    const a = pinAt(p, "R1.2")
    const b = pinAt(p, "R2.1")
    const c = pinAt(p, "R3.1")
    p = addWire(p, [a, b]).project
    p = addWire(p, [{ x: (a.x + b.x) / 2, y: a.y }, c]).project
    expect(sameNet(p, "R1.2", "R3.1")).toBe(true)
    const out = runTool(p, "remove_component", { ref: "R2" })
    expect(out.isError, out.result).toBe(false)
    expect(out.result).toMatch(/no longer on/)
  })
})

describe("connect leaves nothing it cannot reach unsaid", () => {
  /** Two resistors whose facing pins are 0.2 apart: R1.2 at 0.3 and R2.1 at 0.5. */
  const facing = () => {
    let p = createProject("t")
    p = add(p, "resistor", { x: 0, y: 0 })
    p = add(p, "resistor", { x: 0.8, y: 0 })
    p = add(p, "resistor", { x: 0, y: 4 })
    p = add(p, "resistor", { x: 0.8, y: 4 })
    return p
  }

  it("labels pins that face each other 0.2 apart, in either order", () => {
    for (const order of [["R1.2", "R2.1"], ["R2.1", "R1.2"]]) {
      let p = facing()
      const pairs: Record<string, string> = { "R1.2": "R3.1", "R2.1": "R4.2" }
      for (const first of order) {
        const out = connect(p, [first, pairs[first]])
        expect(out.isError, out.result).toBe(false)
        p = out.project
      }
      expect(sameNet(p, "R1.2", "R3.1")).toBe(true)
      expect(sameNet(p, "R2.1", "R4.2")).toBe(true)
      expect(sameNet(p, "R1.2", "R2.1")).toBe(false)
      expect(computeConnectivity(p).conflicts).toEqual([])
    }
  })

  it("does not draw a wire that ends or passes in front of another pin", () => {
    // A wire along y=0 from R1.2 to R3.1 would end 0.2 from R2's pin; the next label from that pin then
    // had no stub that cleared it. The wire is not drawn, and the next connect works.
    let p = createProject("t")
    p = add(p, "resistor", { x: 0, y: 0 })
    p = add(p, "resistor", { x: 15.6, y: 0 })
    p = add(p, "resistor", { x: 16.4, y: 0 })
    const first = connect(p, ["R1.2", "R2.2"])
    expect(first.isError, first.result).toBe(false)
    p = first.project
    const second = connect(p, ["R3.1", "R1.1"])
    expect(second.isError, second.result).toBe(false)
    p = second.project
    expect(sameNet(p, "R1.2", "R2.2")).toBe(true)
    expect(sameNet(p, "R3.1", "R1.1")).toBe(true)
    expect(sameNet(p, "R2.2", "R3.1")).toBe(false)
    expect(sameNet(p, "R2.1", "R2.2")).toBe(false)
  })

  /** R1.2 sits in the middle of another net's wire, so no label on it can avoid joining that net. */
  const pinnedOnAWire = () => {
    let p = createProject("t")
    p = add(p, "resistor", { x: 0, y: 0 })
    p = add(p, "resistor", { x: 4, y: 0 })
    p = addWire(p, [{ x: 0.3, y: -1 }, { x: 0.3, y: 1 }]).project
    p = addLabel(p, "FOREIGN", { x: 0.3, y: 1 }).project
    return p
  }

  it("refuses a pin it cannot reach with a reason that names the pin and what is in the way", () => {
    const p = pinnedOnAWire()
    const out = connect(p, ["R1.2", "R2.1"])
    expect(out.isError).toBe(true)
    expect(out.project).toBe(p)
    expect(out.result).toContain("R1.2")
    expect(out.result).toContain("FOREIGN")
    expect(out.result).toMatch(/Nothing was changed/)
  })

  it("connects what it can and says which pin it left out and how to fix it", () => {
    const p = pinnedOnAWire()
    const out = connect(p, ["R1.2", "R2.1"], "SIG")
    expect(out.isError, out.result).toBe(false)
    expect(out.result).toMatch(/^Partly connected/)
    expect(out.result).toMatch(/NOT connected: R1\.2/)
    expect(out.result).toContain("FOREIGN")
    expect(sameNet(out.project, "R2.1", "R2.2")).toBe(false)
    expect(out.project.labels.some((l) => l.name === "SIG")).toBe(true)
    expect(out.project.labels.some((l) => l.name === "FOREIGN" && l.x === 0.3)).toBe(true)
    const spot = out.result.match(/x=(-?[\d.]+), y=(-?[\d.]+)/)
    expect(spot, out.result).not.toBeNull()
    // The spot offered has been tried: moving there and connecting again works.
    const moved = update(p, { ref: "R1", x: Number(spot![1]), y: Number(spot![2]) })
    expect(moved.isError, moved.result).toBe(false)
    const again = connect(moved.project, ["R1.2", "R2.1"], "SIG")
    expect(again.isError, again.result).toBe(false)
    expect(again.result).not.toMatch(/Partly/)
    expect(sameNet(again.project, "R1.2", "R2.1")).toBe(true)
  })

  it("renames the names it made up when it joins their nets under another name", () => {
    let p = createProject("t")
    for (let i = 0; i < 4; i++) p = add(p, "resistor", { x: i * 3, y: 0 })
    // Two pins on the same row get labels (a wire would cross R2), so each net carries a NETn name.
    p = connect(p, ["R1.2", "R3.1"]).project
    p = connect(p, ["R2.2", "R4.1"]).project
    const out = connect(p, ["R1.2", "R2.2"], "BUS")
    expect(out.isError, out.result).toBe(false)
    expect(sameNet(out.project, "R3.1", "R4.1")).toBe(true)
    expect(computeConnectivity(out.project).conflicts).toEqual([])
    expect(out.project.labels.some((l) => /^NET\d+$/.test(l.name))).toBe(false)
  })
})

describe("unrequestedMerges reads labels too", () => {
  it("reports a pinless label that a new wire lands on", () => {
    let p = createProject("t")
    p = add(p, "resistor", { x: 0, y: 0 })
    p = addLabel(p, "FOO", { x: 0.6, y: 0 }).project
    const before = computeConnectivity(p)
    // R1.2 is at (0.3, 0); a wire from it to the label's point carries the name FOO onto R1.2.
    const wired = addWire(p, [{ x: 0.3, y: 0 }, { x: 0.6, y: 0 }]).project
    const problems = unrequestedMerges(wired, before, computeConnectivity(wired), new Set())
    expect(problems.join(" ")).toContain("FOO")
    expect(problems.join(" ")).toContain("R1.2")
  })

  it("does not call a loose wire with no pin and no name a merge", () => {
    let p = createProject("t")
    p = add(p, "resistor", { x: 0, y: 0 })
    p = addWire(p, [{ x: 0.6, y: 0 }, { x: 0.6, y: 1 }]).project
    const before = computeConnectivity(p)
    const wired = addWire(p, [{ x: 0.3, y: 0 }, { x: 0.6, y: 0 }]).project
    expect(unrequestedMerges(wired, before, computeConnectivity(wired), new Set())).toEqual([])
  })

  it("connect avoids a stray label in front of a pin", () => {
    let p = createProject("t")
    p = add(p, "resistor", { x: 0, y: 0 })
    p = add(p, "resistor", { x: 4, y: 0 })
    p = addLabel(p, "FOO", { x: 0.6, y: 0 }).project
    const out = connect(p, ["R1.2", "R2.1"], "SIG")
    expect(out.isError, out.result).toBe(false)
    expect(sameNet(out.project, "R1.2", "R2.1")).toBe(true)
    const conn = computeConnectivity(out.project)
    expect(conn.nets.find((n) => n.name === "FOO")?.pins ?? []).toEqual([])
    expect(conn.conflicts).toEqual([])
  })
})

describe("a connect on a big sheet is quick", () => {
  it("takes a 40 pin connect on 300 parts well under a second", () => {
    let p = createProject("t")
    const parts = ["resistor", "capacitor", "led", "ams1117_3v3", "atmega328p", "sn74hc595", "ne555", "lm358"]
    // Parts are laid out on a grid by hand: placing 300 through add_component checks each one.
    p = addMany(p, 300, parts)
    const specs: string[] = []
    for (let i = 0; specs.length < 40; i++) {
      const c = p.components[(i * 7) % p.components.length]
      const spec = `${c.ref}.${c.partId === "resistor" || c.partId === "capacitor" || c.partId === "led" ? 1 : i % 2 ? 1 : 2}`
      if (!specs.includes(spec)) specs.push(spec)
    }
    runTool(p, "get_design", {})
    const t0 = performance.now()
    const out = connect(p, specs, "BUS")
    const ms = performance.now() - t0
    expect(out.isError, out.result).toBe(false)
    expect(ms).toBeLessThan(1500)
  })
})

function addMany(p: Project, n: number, parts: string[]): Project {
  let next = p
  for (let i = 0; i < n; i++) {
    next = addComponent(next, parts[i % parts.length], { sch: { x: (i % 20) * 8, y: Math.floor(i / 20) * 8, rot: 0 } }).project
  }
  return next
}
