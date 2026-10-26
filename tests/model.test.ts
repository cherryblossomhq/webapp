import { describe, expect, it } from "vitest"
import { autoroute } from "../src/model/autoroute"
import { computeConnectivity, pinKey } from "../src/model/connectivity"
import { LIBRARY_FOOTPRINTS } from "../src/model/footprintLibrary"
import { getFootprint } from "../src/model/footprints"
import { pcbPads, schematicPins, type WorldPad } from "../src/model/instances"
import { CUSTOM_SYMBOLS } from "../src/model/customParts"
import { discreteSymbol } from "../src/model/discreteSymbols"
import { PARTS } from "../src/model/library"
import { LIBRARY_PARTS, PROJECT_PART_SYMBOLS } from "../src/model/migrations/kicadSymbols"
import { addComponent, addTrace, addWire, autoPlacePcb, connectPins, createProject, labelPin, moveSchematicItems, findRubberBands, resolvePinSpec, updateComponent } from "../src/model/ops"
import { analyzePcb, segmentPadDistance } from "../src/model/pcb"
import type { PadDef } from "../src/model/types"

const onGrid = (n: number) => Math.abs(n * 10 - Math.round(n * 10)) < 1e-6

describe("library", () => {
  it.each(PARTS.map((p) => [p.id, p] as const))("%s symbol pins sit on the 0.1 grid", (_, part) => {
    for (const port of part.symbol.ports) {
      expect(onGrid(port.x), `${part.id} pin ${port.pin} x=${port.x}`).toBe(true)
      expect(onGrid(port.y), `${part.id} pin ${port.pin} y=${port.y}`).toBe(true)
    }
  })

  it.each(PARTS.map((p) => [p.id, p] as const))("%s symbol ports match pin definitions", (_, part) => {
    const portPins = part.symbol.ports.map((p) => p.pin).sort()
    const defPins = part.pins.map((p) => p.number).sort()
    expect(portPins).toEqual(defPins)
  })

  it.each(PARTS.filter((p) => p.footprints.length).flatMap((p) => p.footprints.map((f) => [p.id, f, p] as const)))(
    "%s footprint %s covers every pin",
    (_, fpName, part) => {
      const fp = getFootprint(fpName)
      expect(fp.pads.length).toBeGreaterThan(0)
      const padPins = new Set(fp.pads.map((pad) => (pad.pin ? (part.padAlias?.[pad.pin] ?? pad.pin) : null)))
      for (const pin of part.pins) expect(padPins.has(pin.number), `${part.id}/${fpName} pin ${pin.number}`).toBe(true)
      for (const pin of padPins) expect(pin === null || part.pins.some((p) => p.number === pin)).toBe(true)
    },
  )

  // Saved projects place parts by their origin, so a pin that moves leaves its wires behind
  // unless a file migration reconnects them: moving one again needs a migration of its own.
  it("draws every pin where the last symbol migration put it", () => {
    const at = (ports: { x: number; y: number }[]) => ports.map((p) => `${p.x},${p.y}`).sort()
    for (const [id, moves] of Object.entries(LIBRARY_PARTS)) {
      const ports = at(PARTS.find((p) => p.id === id)!.symbol.ports)
      for (const [, , x, y] of moves) expect(ports, id).toContain(`${x},${y}`)
    }
    for (const [kind, moves] of Object.entries(PROJECT_PART_SYMBOLS)) {
      const ports = at(discreteSymbol(CUSTOM_SYMBOLS[kind].symbol).ports)
      for (const [, , x, y] of moves) expect(ports, kind).toContain(`${x},${y}`)
    }
    expect(PARTS.find((p) => p.id === "power")!.symbol.ports).toEqual([{ pin: "1", x: 0, y: -0.2, dir: "down" }])
    expect(PARTS.find((p) => p.id === "ground")!.symbol.ports).toEqual([{ pin: "1", x: 0, y: 0.3, dir: "up" }])
  })
})

describe("schematic connectivity", () => {
  it("connects pins through wires, labels and power ports", () => {
    let p = createProject("t")
    let r1, d1, gnd, vcc
    ;({ project: p, component: r1 } = addComponent(p, "resistor", { sch: { x: 0, y: 0 } }))
    ;({ project: p, component: d1 } = addComponent(p, "led", { sch: { x: 2, y: 0 } }))
    ;({ project: p, component: gnd } = addComponent(p, "ground", { sch: { x: 4, y: -1 } }))
    ;({ project: p, component: vcc } = addComponent(p, "power", { sch: { x: -2, y: 1 }, props: { net: "5V" } }))
    p = connectPins(p, { componentId: r1.id, pin: "2" }, { componentId: d1.id, pin: "1" })
    p = connectPins(p, { componentId: d1.id, pin: "2" }, { componentId: gnd.id, pin: "1" })
    p = connectPins(p, { componentId: vcc.id, pin: "1" }, { componentId: r1.id, pin: "1" })

    const conn = computeConnectivity(p)
    const netOf = (cid: string, pin: string) => conn.nets.find((n) => n.id === conn.pinNet.get(pinKey(cid, pin)))
    expect(netOf(r1.id, "2")?.id).toBe(netOf(d1.id, "1")?.id)
    expect(netOf(d1.id, "2")?.name).toBe("GND")
    expect(netOf(r1.id, "1")?.name).toBe("5V")
    expect(netOf(r1.id, "2")?.name).toBe("Net-(D1-1)")
    expect(conn.unconnectedPins).toHaveLength(0)
  })

  it("joins same-named labels and detects T junctions", () => {
    let p = createProject("t")
    let a, b
    ;({ project: p, component: a } = addComponent(p, "resistor", { sch: { x: 0, y: 0 } }))
    ;({ project: p, component: b } = addComponent(p, "resistor", { sch: { x: 0, y: -3 } }))
    p = labelPin(p, { componentId: a.id, pin: "2" }, "SDA")
    p = labelPin(p, { componentId: b.id, pin: "2" }, "SDA")
    p = addWire(p, [{ x: -1, y: 2 }, { x: 1, y: 2 }]).project
    p = addWire(p, [{ x: 0, y: 2 }, { x: 0, y: 3 }]).project
    const conn = computeConnectivity(p)
    expect(conn.pinNet.get(pinKey(a.id, "2"))).toBe(conn.pinNet.get(pinKey(b.id, "2")))
    expect(conn.nets.find((n) => n.name === "SDA")?.pins).toHaveLength(2)
    expect(conn.junctions).toContainEqual({ x: 0, y: 2 })
  })

  it("rubber-bands wires when a component moves", () => {
    let p = createProject("t")
    let a, b
    ;({ project: p, component: a } = addComponent(p, "resistor", { sch: { x: 0, y: 0 } }))
    ;({ project: p, component: b } = addComponent(p, "resistor", { sch: { x: 3, y: 0 } }))
    p = connectPins(p, { componentId: a.id, pin: "2" }, { componentId: b.id, pin: "1" })
    const bands = findRubberBands(p, [b.id], [], [])
    expect(bands).toHaveLength(1)
    const moved = moveSchematicItems(p, { components: [b.id], labels: [], wires: [] }, { x: 0, y: 1 }, bands)
    const conn = computeConnectivity(moved)
    expect(conn.pinNet.get(pinKey(a.id, "2"))).toBe(conn.pinNet.get(pinKey(b.id, "1")))
    for (const w of moved.wires) {
      for (let i = 0; i < w.points.length - 1; i++) {
        const s = w.points[i]
        const e = w.points[i + 1]
        expect(Math.abs(s.x - e.x) < 1e-6 || Math.abs(s.y - e.y) < 1e-6).toBe(true)
      }
    }
  })

  it("resolves pin specs by number and name", () => {
    let p = createProject("t")
    p = addComponent(p, "ne555").project
    const u1 = p.components[0]
    expect(resolvePinSpec(p, "U1.8")).toEqual({ componentId: u1.id, pin: "8" })
    expect(resolvePinSpec(p, "u1.out")).toEqual({ componentId: u1.id, pin: "3" })
    expect(resolvePinSpec(p, "U2.1")).toBeNull()
  })
})

describe("pcb analysis", () => {
  function twoResistors() {
    let p = createProject("t")
    let a, b
    ;({ project: p, component: a } = addComponent(p, "resistor", { sch: { x: 0, y: 0 }, pcb: { x: -5, y: 0, placed: true } }))
    ;({ project: p, component: b } = addComponent(p, "resistor", { sch: { x: 3, y: 0 }, pcb: { x: 5, y: 0, placed: true } }))
    p = connectPins(p, { componentId: a.id, pin: "2" }, { componentId: b.id, pin: "1" })
    return { p, a, b }
  }

  it("reports a ratsnest line until the connection is routed", () => {
    const { p, a, b } = twoResistors()
    const conn = computeConnectivity(p)
    let pcb = analyzePcb(p, conn)
    expect(pcb.ratsnest).toHaveLength(1)
    const padA = pcbPads(p.components.find((c) => c.id === a.id)!).find((x) => x.pin === "2")!
    const padB = pcbPads(p.components.find((c) => c.id === b.id)!).find((x) => x.pin === "1")!
    const routed = addTrace(p, { layer: "top", width: 0.25, points: [padA, padB] }).project
    pcb = analyzePcb(routed, computeConnectivity(routed))
    expect(pcb.ratsnest).toHaveLength(0)
    expect(pcb.violations.filter((v) => v.severity === "error")).toHaveLength(0)
    expect(pcb.traceNet.get(routed.traces[0].id)).toBe(conn.pinNet.get(pinKey(a.id, "2")))
  })

  it("flags shorts between different nets", () => {
    const { p, a, b } = twoResistors()
    const padA = pcbPads(p.components.find((c) => c.id === a.id)!).find((x) => x.pin === "1")!
    const padB = pcbPads(p.components.find((c) => c.id === b.id)!).find((x) => x.pin === "2")!
    // R1.1 and R2.2 are both single-pin nets; give them names so they are distinct real nets.
    let named = labelPin(p, { componentId: a.id, pin: "1" }, "A")
    named = labelPin(named, { componentId: b.id, pin: "2" }, "B")
    const shorted = addTrace(named, { layer: "top", width: 0.25, points: [padA, { x: padA.x, y: 3 }, { x: padB.x, y: 3 }, padB] }).project
    const pcb = analyzePcb(shorted, computeConnectivity(shorted))
    expect(pcb.violations.some((v) => v.kind === "short")).toBe(true)
  })

  it("does not route the bottom layer into top-only pads", () => {
    const { p, a, b } = twoResistors()
    const padA = pcbPads(p.components.find((c) => c.id === a.id)!).find((x) => x.pin === "2")!
    const padB = pcbPads(p.components.find((c) => c.id === b.id)!).find((x) => x.pin === "1")!
    const routed = addTrace(p, { layer: "bottom", width: 0.25, points: [padA, padB] }).project
    expect(analyzePcb(routed, computeConnectivity(routed)).ratsnest).toHaveLength(1)
  })

  it("mirrors bottom-side footprints", () => {
    let p = createProject("t")
    p = addComponent(p, "resistor", { pcb: { x: 0, y: 0, placed: true } }).project
    const top = pcbPads(p.components[0])
    p = updateComponent(p, p.components[0].id, { pcb: { side: "bottom" } })
    const bottom = pcbPads(p.components[0])
    expect(bottom[0].x).toBeCloseTo(-top[0].x)
    expect(bottom[0].layers).toEqual(["bottom"])
  })

  it("auto-places unplaced parts inside the board without overlap", () => {
    let p = createProject("t")
    for (const id of ["ne555", "resistor", "resistor", "capacitor", "led", "header_1x4", "ground"]) p = addComponent(p, id).project
    p = autoPlacePcb(p)
    const pcb = analyzePcb(p, computeConnectivity(p))
    expect(pcb.violations.filter((v) => v.kind === "overlap" || v.kind === "outside-board")).toHaveLength(0)
    expect(p.components.filter((c) => c.partId !== "ground").every((c) => c.pcb.placed)).toBe(true)
  })
})

describe("schematic pins", () => {
  it("rotates pins with the component", () => {
    let p = createProject("t")
    p = addComponent(p, "resistor", { sch: { x: 1, y: 1, rot: 90 } }).project
    const pins = schematicPins(p.components[0])
    expect(pins.map((x) => x.dir).sort()).toEqual(["down", "up"])
    expect(pins.every((x) => Math.abs(x.pos.x - 1) < 1e-6)).toBe(true)
  })
})

describe("library footprints", () => {
  const byPin = (name: string) => new Map(getFootprint(name).pads.map((p) => [p.pin, p]))

  it.each([
    ["terminal_block_5mm_2", "pinrow2_p5mm_id1.3mm_od2.6mm"],
    ["terminal_block_5mm_3", "pinrow3_p5mm_id1.3mm_od2.6mm"],
    ["pin_header_1x4", "pinrow4"],
    ["diode_sma", "sma"],
    ["diode_smb", "smb"],
    ["diode_smc", "smc"],
  ])("%s is a drop-in for %s", (own, ref) => {
    const a = byPin(own)
    const b = byPin(ref)
    expect([...a.keys()].sort()).toEqual([...b.keys()].sort())
    for (const [pin, pad] of a) {
      const r = b.get(pin)!
      expect(pad.x, `${own} pad ${pin} x`).toBeCloseTo(r.x, 3)
      expect(pad.y, `${own} pad ${pin} y`).toBeCloseTo(r.y, 3)
      expect(pad.holeDiameter).toBe(r.holeDiameter)
      expect(pad.shape === "rect").toBe(r.shape === "rect")
    }
  })

  it("draws the terminal block body, wire entries and screws", () => {
    const fp = getFootprint("terminal_block_5mm_3")
    const ys = fp.silk.flat().map((p) => p.y)
    expect(Math.min(...ys)).toBeCloseTo(-5.3)
    expect(Math.max(...ys)).toBeCloseTo(4.06)
    for (const y of [-3.5, -4.6]) expect(fp.silk.some((s) => s.length === 2 && s.every((p) => p.y === y))).toBe(true)
    expect(fp.pads.filter((p) => p.shape === "rect").map((p) => p.pin)).toEqual(["1"])
  })

  it("marks the cathode, pad 2, of the DO-214 diodes with a band", () => {
    for (const name of ["diode_sma", "diode_smb", "diode_smc"]) {
      const fp = getFootprint(name)
      const k = fp.pads.find((p) => p.pin === "2")!
      expect(k.x).toBeGreaterThan(0)
      const band = fp.silk.filter((s) => s.length === 2 && s[0].x === s[1].x)
      expect(band.length, name).toBeGreaterThanOrEqual(4)
      expect(band.every((s) => s[0].x > 0 && s[0].x < k.x - k.width / 2)).toBe(true)
    }
  })

  it.each(LIBRARY_FOOTPRINTS)("%s silkscreen stays off copper and holes", (name) => {
    const fp = getFootprint(name)
    const asWorld = (p: PadDef): WorldPad => ({ ...p, componentId: "c", padNumber: p.pin, layers: ["top"] })
    for (const path of fp.silk) {
      for (let i = 0; i < path.length - 1; i++) {
        for (const pad of fp.pads) {
          // Centreline gap: half the 0.15 mm stroke plus a little.
          expect(segmentPadDistance(path[i], path[i + 1], asWorld(pad)), `${name} silk near pad ${pad.pin}`).toBeGreaterThan(0.12)
        }
      }
    }
  })
})

describe("modules and connectors", () => {
  const pad = (fp: string, pin: string) => getFootprint(fp).pads.find((p) => p.pin === pin)!

  it.each([
    ["arduino_nano", 30, 15.24],
    ["esp32_devkitc", 38, 25.4],
    ["wemos_d1_mini", 16, 22.86],
    ["xiao_esp32c3", 14, 15.24],
  ] as const)("%s numbers its two header rows like a DIP from the top left", (name, n, span) => {
    const fp = getFootprint(name)
    expect(fp.pads).toHaveLength(n)
    const first = pad(name, "1")
    const last = pad(name, String(n))
    expect(first.x).toBeLessThan(0)
    expect(last.x - first.x).toBeCloseTo(span, 3)
    expect(last.y).toBeCloseTo(first.y, 3)
    expect(first.y).toBe(Math.max(...fp.pads.map((p) => p.y)))
    for (let i = 1; i < n / 2; i++) expect(pad(name, String(i)).y - pad(name, String(i + 1)).y).toBeCloseTo(2.54, 3)
  })

  it("puts the castellated modules' pads on a 1.27 mm pitch round three sides", () => {
    for (const [name, side, end] of [
      ["esp32_wroom_32e", 14, 10],
      ["esp32_s3_wroom_1", 14, 12],
    ] as const) {
      const fp = getFootprint(name)
      const edge = fp.pads.filter((p) => Number(p.pin) <= 2 * side + end)
      expect(edge).toHaveLength(2 * side + end)
      for (let i = 1; i < side; i++) expect(pad(name, String(i)).y - pad(name, String(i + 1)).y).toBeCloseTo(1.27, 3)
      expect(pad(name, String(side + 1)).x).toBeCloseTo(-((end - 1) / 2) * 1.27, 3)
    }
  })

  it("keeps the USB-C receptacle's two D+ and D- contacts separate pins and ties its shell together", () => {
    const usb = PARTS.find((p) => p.id === "usb_c")!
    expect(usb.pins.filter((p) => p.name === "D+").map((p) => p.number)).toEqual(["A6", "B6"])
    expect(usb.pins.filter((p) => p.name === "D-").map((p) => p.number)).toEqual(["A7", "B7"])
    expect(usb.padAlias).toEqual({ S2: "S1", S3: "S1", S4: "S1" })
    const shell = getFootprint("usb_c_16p").pads.filter((p) => p.slotLength)
    expect(shell.map((p) => p.pin)).toEqual(["S1", "S2", "S3", "S4"])
  })

  it.each([
    ["usb_c_16p", -2.6],
    ["micro_usb_b", -4.13],
    ["barrel_jack_pj002a", -7.2],
  ])("lets %s sit flush on the board edge: its courtyard stops at the -y face", (name, face) => {
    expect(getFootprint(name).courtyard.minY).toBe(face)
  })

  it("draws Phoenix terminal blocks on their own pitch with the wire entries at -y", () => {
    for (const [name, pitch] of [
      ["terminal_block_5.08mm_3", 5.08],
      ["terminal_block_3.5mm_2", 3.5],
      ["phoenix_mc_3.81mm_4", 3.81],
      ["phoenix_mstba_5.08mm_2", 5.08],
    ] as const) {
      const fp = getFootprint(name)
      const xs = fp.pads.map((p) => p.x).sort((a, b) => a - b)
      for (let i = 1; i < xs.length; i++) expect(xs[i] - xs[i - 1], name).toBeCloseTo(pitch, 3)
      // A full-width line across the -y side: the wire entries, or the plug's mouth.
      const across = fp.silk.filter((s) => s.length === 2 && s[0].y === s[1].y && s[0].y < -1 && Math.abs(s[1].x - s[0].x) > xs[xs.length - 1] - xs[0])
      expect(across.length, name).toBeGreaterThan(0)
    }
  })
})

describe("non-plated holes", () => {
  function moduleBoard() {
    let p = createProject("t")
    p = { ...p, board: { ...p.board, width: 60, height: 70 } }
    const u = addComponent(p, "esp32_devkit_v1", { sch: { x: 0, y: 0 }, pcb: { x: 0, y: 0, placed: true } })
    return { p: u.project, u: u.component }
  }

  it("gives the ESP32 DevKit four 3 mm corner holes with no pin", () => {
    const { p } = moduleBoard()
    const holes = pcbPads(p.components[0]).filter((pad) => pad.plated === false)
    expect(holes.map((h) => [h.x, h.y])).toEqual([
      [-12.25, -21.21],
      [12.25, -21.21],
      [-12.25, 25.74],
      [12.25, 25.74],
    ])
    for (const h of holes) {
      expect(h.pin).toBeNull()
      expect(h.width).toBe(3)
      expect(h.holeDiameter).toBe(3)
    }
  })

  it("keeps copper clear of a hole without joining nets through it", () => {
    let { p, u } = moduleBoard()
    p = labelPin(p, { componentId: u.id, pin: "15" }, "A")
    p = labelPin(p, { componentId: u.id, pin: "16" }, "B")
    const pads = pcbPads(p.components[0])
    const pin = (n: string) => pads.find((x) => x.pin === n)!
    const hole = pads.find((x) => x.plated === false && x.x < 0)!
    // Both traces end inside the same hole, 1 mm apart.
    p = addTrace(p, { layer: "top", width: 0.25, points: [pin("15"), { x: hole.x - 0.5, y: hole.y }] }).project
    p = addTrace(p, { layer: "top", width: 0.25, points: [pin("16"), { x: pin("16").x, y: -24 }, { x: hole.x + 0.5, y: -24 }, { x: hole.x + 0.5, y: hole.y }] }).project
    const conn = computeConnectivity(p)
    const pcb = analyzePcb(p, conn)
    expect(pcb.violations.filter((v) => v.kind === "short")).toEqual([])
    expect(pcb.violations.some((v) => v.kind === "clearance" && v.message.startsWith("Hole clearance"))).toBe(true)
    expect(pcb.traceNet.get(p.traces[0].id)).toBe(conn.pinNet.get(pinKey(u.id, "15")))
    expect(pcb.traceNet.get(p.traces[1].id)).toBe(conn.pinNet.get(pinKey(u.id, "16")))
  })

  it("is routed around", () => {
    let { p } = moduleBoard()
    // Two resistors either side of the right-hand hole, joined straight across it.
    const a = addComponent(p, "resistor", { sch: { x: 5, y: 0 }, pcb: { x: 7, y: -21.21, placed: true } })
    const b = addComponent(a.project, "resistor", { sch: { x: 8, y: 0 }, pcb: { x: 18, y: -21.21, placed: true } })
    p = connectPins(b.project, { componentId: a.component.id, pin: "2" }, { componentId: b.component.id, pin: "1" })
    const res = autoroute(p, { timeLimitMs: 4000 })
    expect(res.remaining).toBe(0)
    const pcb = analyzePcb(res.project, computeConnectivity(res.project))
    expect(pcb.violations.filter((v) => v.severity === "error")).toEqual([])
  })
})
