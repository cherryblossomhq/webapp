import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { runTool } from "../src/ai/tools"
import { computeConnectivity } from "../src/model/connectivity"
import { ignoreCheck, restoreCheck, runErc, splitIgnored, type ErcFinding } from "../src/model/erc"
import { EXAMPLES } from "../src/model/examples"
import { createProject, updateComponent } from "../src/model/ops"
import { parseProjectFile, serializeProject } from "../src/model/projectFile"
import type { Project } from "../src/model/types"
import { parseValue } from "../src/lib/values"

/**
 * Circuits are built the way Sakura builds them, through the tools: parts by ref, then nets.
 * A net named "~" is an unnamed one, labelled n1, n2...; "wire" draws a wire between two pins
 * instead (only where it can't run across another pin). "#PWR" and "#GND" refs are power and
 * ground ports, which make their net a supply rail. Parts go down a diagonal, far apart.
 */
type PartSpec = string | [partId: string, props: Record<string, string>]

function must(out: ReturnType<typeof runTool>) {
  if (out.isError) throw new Error(out.result)
  return out.project
}

function circuit(parts: Record<string, PartSpec>, nets: [name: string, ...pins: string[]][], project = createProject("erc")) {
  let p = project
  for (const [ref, spec] of Object.entries(parts)) {
    const [part_id, props] = typeof spec === "string" ? [spec, undefined] : spec
    const at = p.components.length * 8
    p = must(runTool(p, "add_component", { part_id, ref, x: at, y: -at, ...(props && { props }) }))
  }
  let n = 0
  for (const [name, ...pins] of nets) {
    p = must(runTool(p, "connect", name === "wire" ? { pins } : { pins, net_name: name === "~" ? `n${++n}` : name }))
  }
  return p
}

function createPart(project: Project, input: object) {
  const out = runTool(project, "create_part", input)
  if (out.isError) throw new Error(out.result)
  return { project: out.project, id: out.result.match(/part_id "([^"]+)"/)![1] }
}

const erc = (p: Project) => runErc(p, computeConnectivity(p))
const messages = (p: Project, kind?: ErcFinding["kind"]) => erc(p).filter((f) => !kind || f.kind === kind).map((f) => f.message)
const idOf = (p: Project, ref: string) => p.components.find((c) => c.ref === ref)!.id

/** Supply ports for the nets the examples below use. */
const PORTS: Record<string, PartSpec> = {
  "#PWR1": ["power", { net: "3V3" }],
  "#PWR2": ["power", { net: "5V" }],
  "#GND1": "ground",
}

describe("a pin only on a label nothing else shares", () => {
  it("catches a misspelt label, which connectivity counts as connected", () => {
    const p = circuit({ R1: "resistor", R2: "resistor", ...PORTS }, [
      ["LED_EN", "R1.1"],
      ["LED_ENN", "R2.1"],
      ["GND", "R1.2", "R2.2"],
    ])
    expect(computeConnectivity(p).unconnectedPins).toEqual([])
    expect(messages(p, "lone-label")).toEqual([
      "R1 pin 1 goes only to the label LED_EN, which no other pin has",
      "R2 pin 1 goes only to the label LED_ENN, which no other pin has",
    ])
    const [first] = erc(p)
    expect(first.key).toBe(`lone-label:${idOf(p, "R1")}:1`)
    expect(first.labelIds).toHaveLength(1)
  })

  it("names the pin when it has a name of its own", () => {
    const p = circuit({ U1: "attiny85" }, [["SENSE", "U1.PB3"]])
    expect(messages(p, "lone-label")).toContain("U1 pin 2 (PB3) goes only to the label SENSE, which no other pin has")
  })

  it("says nothing once another pin shares the label", () => {
    const p = circuit({ R1: "resistor", R2: "resistor" }, [["SDA", "R1.1"], ["SDA", "R2.1"], ["~", "R1.2", "R2.2"]])
    expect(messages(p, "lone-label")).toEqual([])
  })

  it("leaves a pin marked no-connect alone", () => {
    let p = circuit({ R1: "resistor", R2: "resistor" }, [["SPARE", "R1.1"], ["~", "R1.2", "R2.2", "R2.1"]])
    expect(messages(p, "lone-label")).toHaveLength(1)
    p = updateComponent(p, idOf(p, "R1"), { nc: ["1"] })
    expect(messages(p, "lone-label")).toEqual([])
  })

  it("leaves a supply rail with one pin to the other checks", () => {
    // A power port on the net makes it a rail, not a stray label.
    const p = circuit({ R1: "resistor", ...PORTS }, [["3V3", "R1.1"], ["GND", "R1.2"]])
    expect(messages(p, "lone-label")).toEqual([])
  })

  it("does not repeat a pin wired to nothing, which is the unconnected pin check's", () => {
    const p = circuit({ R1: "resistor", ...PORTS }, [["GND", "R1.2"]])
    expect(computeConnectivity(p).unconnectedPins.map((x) => x.pin)).toEqual(["1"])
    expect(messages(p, "lone-label")).toEqual([])
  })
})

describe("an LED with no series resistor", () => {
  // Ported from PR #88's electrical.test.mjs, then the cases it didn't cover.

  it("passes an LED with a resistor in series", () => {
    const p = circuit({ D1: "led", R1: ["resistor", { resistance: "330" }], ...PORTS }, [
      ["3V3", "R1.1"],
      ["~", "R1.2", "D1.A"],
      ["GND", "D1.K"],
    ])
    expect(messages(p, "bare-led")).toEqual([])
  })

  it("flags an LED straight across a rail, naming the rail", () => {
    const p = circuit({ D3: "led", ...PORTS }, [["3V3", "D3.A"], ["GND", "D3.K"]])
    const [f] = erc(p)
    expect(f).toMatchObject({ kind: "bare-led", message: "D3 has no resistor between it and 3V3", subject: "D3", key: `bare-led:${idOf(p, "D3")}` })
    expect(f.componentIds).toEqual([idOf(p, "D3")])
  })

  it("is not fooled by a resistor that merely shares the rail", () => {
    // PR #88's reason for a private node rather than "a resistor is somewhere on this net".
    const p = circuit({ D1: "led", R9: "resistor", U1: "attiny85", ...PORTS }, [
      ["3V3", "D1.A", "R9.1", "U1.VCC"],
      ["GND", "D1.K", "U1.GND"],
      ["~", "R9.2", "U1.PB0"],
    ])
    expect(messages(p, "bare-led")).toEqual(["D1 has no resistor between it and 3V3"])
  })

  it("never counts ground as the link to a resistor", () => {
    // GND holding only the LED's cathode and one resistor leg is a coincidence, not a node
    // between them: the LED is still straight across 3V3.
    const p = circuit({ D1: "led", R1: "resistor", U1: "attiny85", ...PORTS }, [
      ["3V3", "D1.A", "U1.VCC"],
      ["GND", "D1.K", "R1.2"],
      ["~", "R1.1", "U1.PB4"],
    ])
    expect(messages(p, "bare-led")).toEqual(["D1 has no resistor between it and 3V3"])
  })

  it("passes an LED with its resistor on the ground side", () => {
    const p = circuit({ D1: "led", R1: "resistor", ...PORTS }, [
      ["3V3", "D1.A"],
      ["~", "D1.K", "R1.1"],
      ["GND", "R1.2"],
    ])
    expect(messages(p, "bare-led")).toEqual([])
  })

  it("flags an LED driven straight from an IC pin, even with a pull resistor on that pin", () => {
    const p = circuit({ D1: "led", R1: "resistor", U1: "attiny85", ...PORTS }, [
      ["3V3", "U1.VCC", "R1.1"],
      ["GND", "U1.GND", "D1.K"],
      ["LED_DRV", "U1.PB1", "D1.A", "R1.2"],
    ])
    expect(messages(p, "bare-led")).toEqual(["D1 has no resistor between it and LED_DRV"])
  })

  it("names an unnamed net by the pin that drives it", () => {
    // D1 sinks into U1's PB3 over a drawn wire, so its net has no name of its own.
    const p = circuit({ D1: "led", U1: "attiny85", ...PORTS }, [["wire", "D1.K", "U1.PB3"], ["3V3", "D1.A", "U1.VCC"], ["GND", "U1.GND"]])
    expect(messages(p, "bare-led")).toEqual(["D1 has no resistor between 3V3 and U1 pin 2 (PB3)"])
  })

  it("follows a string of LEDs to the one resistor they share", () => {
    // 5V -> R1 -> D1 -> D2 -> D3 -> GND: one resistor limits all three.
    const p = circuit({ D1: "led", D2: "led", D3: "led", R1: "resistor", ...PORTS }, [
      ["5V", "R1.1"],
      ["~", "R1.2", "D1.A"],
      ["~", "D1.K", "D2.A"],
      ["~", "D2.K", "D3.A"],
      ["GND", "D3.K"],
    ])
    expect(messages(p, "bare-led")).toEqual([])
  })

  it("flags every LED of a string with no resistor, naming where the string starts", () => {
    const p = circuit({ D1: "led", D2: "led", ...PORTS }, [["5V", "D1.A"], ["~", "D1.K", "D2.A"], ["GND", "D2.K"]])
    expect(messages(p, "bare-led")).toEqual(["D1 has no resistor between it and 5V", "D2 has no resistor between it and 5V"])
  })

  it("passes LEDs in parallel that share one resistor", () => {
    const p = circuit({ D1: "led", D2: "led", D3: "led", R1: "resistor", ...PORTS }, [
      ["5V", "R1.1"],
      ["LEDS", "R1.2", "D1.A", "D2.A", "D3.A"],
      ["GND", "D1.K", "D2.K", "D3.K"],
    ])
    expect(messages(p, "bare-led")).toEqual([])
  })

  it("follows the current through a switch and a diode to the resistor", () => {
    const p = circuit({ D1: "led", D2: "diode", SW1: "pushbutton", Q1: "npn", R1: "resistor", R2: "resistor", ...PORTS }, [
      ["5V", "R1.1"],
      ["~", "R1.2", "SW1.1"],
      ["~", "SW1.2", "D2.A"],
      ["~", "D2.K", "D1.A"],
      ["~", "D1.K", "Q1.C"],
      ["GND", "Q1.E"],
      ["~", "Q1.B", "R2.1"],
      ["3V3", "R2.2"],
    ])
    expect(messages(p, "bare-led")).toEqual([])
  })

  it("does not count a transistor's base resistor, and flags a bare emitter on ground", () => {
    const bare = circuit({ D1: "led", Q1: "npn", R2: "resistor", ...PORTS }, [
      ["5V", "D1.A"],
      ["wire", "D1.K", "Q1.C"],
      ["GND", "Q1.E"],
      ["~", "Q1.B", "R2.1"],
      ["3V3", "R2.2"],
    ])
    expect(messages(bare, "bare-led")).toEqual(["D1 has no resistor between it and 5V"])
  })

  it("passes a constant-current sink: the emitter resistor is the LED's, not the base resistor", () => {
    // 5V to D1.A, D1.K to Q1.C, Q1.E through R1 to ground, base through R2 to an MCU pin.
    const npn = circuit({ D1: "led", Q1: "npn", R1: "resistor", R2: "resistor", U1: "attiny85", ...PORTS }, [
      ["5V", "D1.A", "U1.VCC"],
      ["wire", "D1.K", "Q1.C"],
      ["~", "Q1.E", "R1.1"],
      ["GND", "R1.2", "U1.GND"],
      ["~", "Q1.B", "R2.1"],
      ["~", "R2.2", "U1.PB0"],
    ])
    expect(messages(npn, "bare-led")).toEqual([])
    // The same with a MOSFET: drain to source, never the gate.
    const fet = circuit({ D1: "led", Q1: "nmos", R1: "resistor", ...PORTS }, [["5V", "D1.A"], ["wire", "D1.K", "Q1.D"], ["~", "Q1.S", "R1.1"], ["GND", "R1.2"]])
    expect(messages(fet, "bare-led")).toEqual([])
    // A resistor only on the base is not it.
    const base = circuit({ D1: "led", Q1: "nmos", R1: "resistor", ...PORTS }, [["5V", "D1.A"], ["wire", "D1.K", "Q1.D"], ["GND", "Q1.S"], ["~", "Q1.G", "R1.1"], ["3V3", "R1.2"]])
    expect(messages(base, "bare-led")).toEqual(["D1 has no resistor between it and 5V"])
  })

  it("is not cancelled by a test point, a 1x2 header jumper or a solder jumper between resistor and LED", () => {
    const wired = (extra: Record<string, PartSpec>, nets: [string, ...string[]][], project?: Project) =>
      circuit({ D1: "led", R1: "resistor", ...extra, ...PORTS }, [["5V", "R1.1"], ...nets, ["GND", "D1.K"]], project)
    const tp = createPart(createProject("tp"), { name: "Test point", description: "Test point", category: "Connectors", footprint: "pinrow1", ref_prefix: "TP", pins: [{ number: "1", name: "1" }] })
    expect(messages(wired({ TP1: tp.id }, [["~", "R1.2", "D1.A", "TP1.1"]], tp.project), "bare-led")).toEqual([])
    expect(messages(wired({ J1: "header_1x2" }, [["~", "R1.2", "J1.1"], ["~", "J1.2", "D1.A"]]), "bare-led")).toEqual([])
    const jp = createPart(createProject("jp"), { name: "Solder jumper", description: "Solder jumper", category: "Passives", footprint: "0603", ref_prefix: "JP", pins: [{ number: "1", name: "1" }, { number: "2", name: "2" }] })
    expect(messages(wired({ JP1: jp.id }, [["~", "R1.2", "JP1.1"], ["~", "JP1.2", "D1.A"]], jp.project), "bare-led")).toEqual([])
    // And a jumper doesn't hide a bare LED.
    const bare = circuit({ D1: "led", J1: "header_1x2", ...PORTS }, [["5V", "J1.1"], ["~", "J1.2", "D1.A"], ["GND", "D1.K"]])
    expect(messages(bare, "bare-led")).toEqual(["D1 has no resistor between it and 5V"])
  })

  it("still flags a bare LED after a switch whose other pin is unused", () => {
    const p = circuit({ D1: "led", SW1: "slide_switch", ...PORTS }, [["5V", "SW1.C"], ["~", "SW1.1", "D1.A"], ["GND", "D1.K"]])
    expect(messages(p, "bare-led")).toEqual(["D1 has no resistor between it and 5V"])
    const nc = updateComponent(p, idOf(p, "SW1"), { nc: ["3"] })
    expect(messages(nc, "bare-led")).toEqual(["D1 has no resistor between it and 5V"])
  })

  it("does not join an SPDT switch's two throws, only the common to each", () => {
    // R1 hangs off throw 3 and runs to 3V3. The LED is on throw 1, so R1 is not in its path.
    const p = circuit({ D1: "led", SW1: "slide_switch", R1: "resistor", ...PORTS }, [
      ["5V", "SW1.C"],
      ["~", "SW1.1", "D1.A"],
      ["~", "SW1.3", "R1.1"],
      ["3V3", "R1.2"],
      ["GND", "D1.K"],
    ])
    expect(messages(p, "bare-led")).toEqual(["D1 has no resistor between it and 5V"])
    // A resistor between the common and the supply is in its path, from either throw.
    const ok = circuit({ D1: "led", SW1: "slide_switch", R1: "resistor", ...PORTS }, [["5V", "R1.1"], ["~", "R1.2", "SW1.C"], ["~", "SW1.3", "D1.A"], ["GND", "D1.K"]])
    expect(messages(ok, "bare-led")).toEqual([])
  })

  it("reads a half-wired resistor as still being drawn, not as no resistor", () => {
    const p = circuit({ D1: "led", R1: "resistor", ...PORTS }, [["3V3", "D1.A"], ["~", "D1.K", "R1.1"]])
    expect(messages(p, "bare-led")).toEqual([])
  })

  it("does not count a resistor across the LED, only one in series", () => {
    // SW1 switches 3V3 onto the LED; R1 pulls the switched node to ground, alongside the LED.
    const p = circuit({ D1: "led", SW1: "pushbutton", R1: "resistor", ...PORTS }, [
      ["3V3", "SW1.1"],
      ["SWITCHED", "SW1.2", "D1.A", "R1.1"],
      ["GND", "D1.K", "R1.2"],
    ])
    expect(messages(p, "bare-led")).toEqual(["D1 has no resistor between it and 3V3"])
  })

  it("does not count a 0 ohm link as a resistor", () => {
    const p = circuit({ D1: "led", R1: ["resistor", { resistance: "0R" }], ...PORTS }, [["5V", "R1.1"], ["~", "R1.2", "D1.A"], ["GND", "D1.K"]])
    expect(messages(p, "bare-led")).toEqual(["D1 has no resistor between it and 5V"])
  })

  it("ignores an LED that is not wired up yet, which the unconnected pin check reports", () => {
    expect(messages(circuit({ D1: "led" }, []))).toEqual([])
    expect(messages(circuit({ D1: "led", ...PORTS }, [["3V3", "D1.A"]]), "bare-led")).toEqual([])
  })

  it("leaves an LED with both legs on one net to the shorted part check", () => {
    const p = circuit({ D1: "led", ...PORTS }, [["GND", "D1.A", "D1.K"]])
    expect(erc(p).map((f) => f.kind)).toEqual(["shorted"])
  })

  it("says nothing about a board with no LEDs", () => {
    expect(messages(circuit({ R1: "resistor", ...PORTS }, [["3V3", "R1.1"], ["GND", "R1.2"]]))).toEqual([])
  })

  it("leaves addressable LEDs alone, and lets an LED on a constant-current driver off", () => {
    const p = circuit({ D1: "ws2812b", ...PORTS }, [["5V", "D1.VDD"], ["GND", "D1.VSS"], ["DATA", "D1.DIN"]])
    expect(messages(p, "bare-led")).toEqual([])
    let q: Project = createProject("cc")
    const driver = createPart(q, {
      name: "TLC5916",
      description: "8-channel constant-current LED sink driver",
      category: "ICs",
      footprint: "soic16",
      pins: Array.from({ length: 16 }, (_, i) => ({ number: String(i + 1), name: i === 4 ? "OUT0" : i === 15 ? "VDD" : i === 0 ? "GND" : `P${i + 1}` })),
    })
    q = circuit({ U1: driver.id, D1: "led", ...PORTS }, [["5V", "D1.A", "U1.VDD"], ["~", "D1.K", "U1.OUT0"], ["GND", "U1.GND"]], driver.project)
    expect(messages(q, "bare-led")).toEqual([])
  })

  it("still flags an LED straight on a 74HC595 output, which is not a constant-current driver", () => {
    const p = circuit({ U1: "sn74hc595", D1: "led", ...PORTS }, [["5V", "U1.VCC"], ["GND", "U1.GND", "D1.K"], ["wire", "U1.QA", "D1.A"]])
    expect(messages(p, "bare-led")).toEqual(["D1 has no resistor between it and U1 pin 15 (QA)"])
  })

  it("checks a project part drawn with the LED symbol, and not one with a built-in resistor", () => {
    let p: Project = createProject("custom")
    const plain = createPart(p, { name: "XL-1608UGC", description: "Green 0603 LED", category: "Diodes", footprint: "0603", symbol: "led", pins: [{ number: "1", name: "K" }, { number: "2", name: "A" }] })
    const resisted = createPart(plain.project, {
      name: "WP7104LSRD5V",
      description: "Red 3 mm LED with built-in resistor for 5 V",
      category: "Diodes",
      footprint: "0603",
      symbol: "led",
      pins: [{ number: "1", name: "K" }, { number: "2", name: "A" }],
    })
    p = circuit({ D1: plain.id, D2: resisted.id, ...PORTS }, [["5V", "D1.A", "D2.A"], ["GND", "D1.K", "D2.K"]], resisted.project)
    expect(messages(p, "bare-led")).toEqual(["D1 has no resistor between it and 5V"])
  })

  it("checks each LED of an LED bar, keyed by its anode pin", () => {
    let p: Project = createProject("bar")
    const bar = createPart(p, {
      name: "Bar graph 3",
      description: "3-segment LED bar graph",
      category: "Diodes",
      footprint: "dip6",
      pins: [
        { number: "1", name: "A1" },
        { number: "2", name: "A2" },
        { number: "3", name: "A3" },
        { number: "4", name: "K3" },
        { number: "5", name: "K2" },
        { number: "6", name: "K1" },
      ],
    })
    p = circuit({ U1: bar.id, R1: "resistor", R2: "resistor", ...PORTS }, [
      ["5V", "R1.1", "R2.1", "U1.A3"],
      ["~", "R1.2", "U1.A1"],
      ["~", "R2.2", "U1.A2"],
      ["GND", "U1.K1", "U1.K2", "U1.K3"],
    ], bar.project)
    const found = erc(p).filter((f) => f.kind === "bare-led")
    expect(found.map((f) => f.message)).toEqual(["U1's LED A3/K3 has no resistor between it and 5V"])
    expect(found[0].key).toBe(`bare-led:${idOf(p, "U1")}:3`)
  })

  it("checks each colour of a common-anode RGB LED", () => {
    let p: Project = createProject("rgb")
    const rgb = createPart(p, {
      name: "RGB LED CA",
      description: "Common anode RGB LED, 5 mm",
      category: "Diodes",
      footprint: "pinrow4",
      pins: [
        { number: "1", name: "R" },
        { number: "2", name: "CA" },
        { number: "3", name: "G" },
        { number: "4", name: "B" },
      ],
    })
    p = circuit({ D1: rgb.id, R1: "resistor", U1: "attiny85", ...PORTS }, [
      ["5V", "D1.CA", "U1.VCC"],
      ["~", "D1.R", "R1.1"],
      ["~", "R1.2", "U1.PB0"],
      ["GREEN", "D1.G", "U1.PB1"],
      ["BLUE", "D1.B", "U1.PB2"],
      ["GND", "U1.GND"],
    ], rgb.project)
    expect(messages(p, "bare-led")).toEqual([
      "D1's LED B/CA has no resistor between BLUE and 5V",
      "D1's LED G/CA has no resistor between GREEN and 5V",
    ])
  })

  it("checks an optocoupler's input LED", () => {
    const bare = circuit({ U1: "pc817", U2: "attiny85", ...PORTS }, [["OPTO", "U2.PB0", "U1.A"], ["GND", "U1.K", "U2.GND"], ["3V3", "U2.VCC"]])
    expect(messages(bare, "bare-led")).toEqual(["U1's LED A/K has no resistor between it and OPTO"])
    const ok = circuit({ U1: "pc817", R1: "resistor", U2: "attiny85", ...PORTS }, [
      ["~", "U2.PB0", "R1.1"],
      ["~", "R1.2", "U1.A"],
      ["GND", "U1.K", "U2.GND"],
      ["3V3", "U2.VCC"],
    ])
    expect(messages(ok, "bare-led")).toEqual([])
  })

  it("never looks inside modules or connectors", () => {
    let p: Project = createProject("module")
    const mod = createPart(p, {
      name: "LED module",
      description: "Red LED on a breakout board",
      category: "Modules",
      footprint: "pinrow2",
      pins: [{ number: "1", name: "A" }, { number: "2", name: "K" }],
    })
    p = circuit({ M1: mod.id, ...PORTS }, [["5V", "M1.A"], ["GND", "M1.K"]], mod.project)
    expect(messages(p)).toEqual([])
  })
})

describe("a two-pin part with both pins on one net", () => {
  // Ported from PR #97's findShortedParts tests.

  it("catches the fuse that fuses nothing", () => {
    let p: Project = createProject("fuse")
    const fuse = createPart(p, { name: "0466001", description: "1 A fuse, 1206", category: "Passives", footprint: "1206", symbol: "fuse", pins: [{ number: "1", name: "1" }, { number: "2", name: "2" }] })
    p = circuit({ F1: fuse.id, J1: "header_1x2", ...PORTS }, [["V12", "J1.1", "F1.1", "F1.2"], ["GND", "J1.2"]], fuse.project)
    const [f] = erc(p)
    expect(f).toMatchObject({ kind: "shorted", message: "F1 has both pins on V12, so it does nothing", key: `shorted:${idOf(p, "F1")}` })
  })

  it("says nothing about a fuse doing its job", () => {
    const p = circuit({ R1: "resistor", J1: "header_1x2", ...PORTS }, [["VIN", "J1.1", "R1.1"], ["V12", "R1.2"], ["GND", "J1.2"]])
    expect(messages(p, "shorted")).toEqual([])
  })

  it("says nothing about a part wired to nothing", () => {
    expect(messages(circuit({ C1: "capacitor" }, []), "shorted")).toEqual([])
  })

  it("ignores parts that are not two-terminal", () => {
    const p = circuit({ RV1: "potentiometer", ...PORTS }, [["GND", "RV1.1", "RV1.W", "RV1.3"]])
    expect(messages(p, "shorted")).toEqual([])
  })

  it("names the net by a pin on it when it has no name, and says so when the part is all there is", () => {
    const named = circuit({ C1: "capacitor", ...PORTS }, [["GND", "C1.1", "C1.2"]])
    expect(messages(named)).toEqual(["C1 has both pins on GND, so it does nothing"])
    const unnamed = circuit({ R1: "resistor", U1: "attiny85" }, [["wire", "R1.1", "U1.PB3"], ["wire", "R1.2", "U1.PB3"]])
    expect(messages(unnamed, "shorted")).toEqual(["R1 has both pins on the same net as U1 pin 2 (PB3), so it does nothing"])
    const wired = circuit({ R1: "resistor" }, [["wire", "R1.1", "R1.2"]])
    expect(messages(wired)).toEqual(["R1 has its two pins wired to each other, so it does nothing"])
  })

  it("leaves connectors and test points alone, where two contacts on one net are ordinary", () => {
    const p = circuit({ J1: "header_1x2", J2: "screw_terminal_2", ...PORTS }, [["GND", "J1.1", "J1.2"], ["5V", "J2.1", "J2.2"]])
    expect(messages(p, "shorted")).toEqual([])
  })

  it("leaves a part whose two pins are declared ground pads, or one of them unused", () => {
    let p: Project = createProject("shield")
    const shield = createPart(p, { name: "Shield clip", description: "RF shield clip", category: "Electromechanical", footprint: "0805", pins: [{ number: "1", name: "GND1", kind: "ground" }, { number: "2", name: "GND2", kind: "ground" }] })
    const post = createPart(shield.project, { name: "Probe post", description: "Probe post", category: "Electromechanical", footprint: "0805", pins: [{ number: "1", name: "P", kind: "passive" }, { number: "2", name: "NC", kind: "nc" }] })
    p = circuit({ X1: shield.id, X2: post.id, ...PORTS }, [["GND", "X1.1", "X1.2", "X2.1", "X2.2"]], post.project)
    expect(messages(p, "shorted")).toEqual([])
  })
})

describe("the shipped examples", () => {
  it.each(EXAMPLES.map((e) => [e.id, e.project] as const))("%s has no electrical warnings, and every LED is checked", (_, project) => {
    expect(erc(project)).toEqual([])
    // Make every resistor a 0 ohm link: then each LED on the board has nothing limiting it.
    const zeroed = {
      ...project,
      components: project.components.map((c) => (c.partId === "resistor" ? { ...c, props: { ...c.props, resistance: "0" } } : c)),
    }
    const leds = project.components.filter((c) => c.partId === "led").map((c) => c.ref)
    expect(erc(zeroed).filter((f) => f.kind === "bare-led").map((f) => f.subject).sort()).toEqual(leds.sort())
  })

  it("finds the three mistakes on the v1 symbol sheet, a page of every symbol wired any old way", () => {
    const { file } = JSON.parse(readFileSync(new URL("./fixtures/project-v1/sheet.json", import.meta.url), "utf8"))
    expect(messages(parseProjectFile(file, { id: "sheet" }))).toEqual([
      // D1 is no longer one of them: it hangs off Q1's collector and a slide switch, and R1 is in
      // series through the switch's common. Before the collector was followed, it read as bare.
      "SW3 has both pins on BTN, so it does nothing",
      "RV1 pin 2 (W) goes only to the label WIPER, which no other pin has",
      "Y1 pin 1 goes only to the label XI, which no other pin has",
    ])
  })
})

describe("ignoring a finding", () => {
  const bare = () => circuit({ D1: "led", ...PORTS }, [["3V3", "D1.A"], ["GND", "D1.K"]])

  it("moves it out of the list until it is restored", () => {
    const p = bare()
    const key = `bare-led:${idOf(p, "D1")}`
    const ignored = ignoreCheck(p, key)
    expect(ignored.ignoredChecks).toEqual([key])
    expect(ignoreCheck(ignored, key)).toBe(ignored)
    const split = splitIgnored(erc(ignored), ignored.ignoredChecks)
    expect(split.active).toEqual([])
    expect(split.ignored.map((f) => f.subject)).toEqual(["D1"])
    const restored = restoreCheck(ignored, key)
    expect(restored.ignoredChecks).toBeUndefined()
    expect(splitIgnored(erc(restored), restored.ignoredChecks).active).toHaveLength(1)
  })

  it("follows the part through a rename, and doesn't pass to a new part given its old name", () => {
    let p = bare()
    p = ignoreCheck(p, `bare-led:${idOf(p, "D1")}`)
    p = updateComponent(p, idOf(p, "D1"), { ref: "D7" })
    expect(splitIgnored(erc(p), p.ignoredChecks).active).toEqual([])
    p = circuit({ D1: "led" }, [["3V3", "D1.A"], ["GND", "D1.K"]], p)
    expect(splitIgnored(erc(p), p.ignoredChecks).active.map((f) => f.message)).toEqual(["D1 has no resistor between it and 3V3"])
  })

  it("survives saving and opening the project", () => {
    let p = bare()
    p = ignoreCheck(p, `bare-led:${idOf(p, "D1")}`)
    const text = serializeProject(p)
    expect(JSON.parse(text).project.ignoredChecks).toEqual([`bare-led:${idOf(p, "D1")}`])
    const read = parseProjectFile(text, { id: "again" })
    expect(read.ignoredChecks).toEqual(p.ignoredChecks)
    expect(splitIgnored(erc(read), read.ignoredChecks).active).toEqual([])
  })

  it("reads a hand-edited list leniently: strings once each, and nothing when empty", () => {
    const file = (ignoredChecks: unknown) => JSON.stringify({ format: "cherryblossom.project", version: 2, project: { name: "x", components: [], ignoredChecks } })
    expect(parseProjectFile(file(["a", "a", 3, "", "b"]), { id: "1" }).ignoredChecks).toEqual(["a", "b"])
    expect(parseProjectFile(file([]), { id: "2" }).ignoredChecks).toBeUndefined()
    expect(parseProjectFile(file("bare-led:x"), { id: "3" }).ignoredChecks).toBeUndefined()
  })
})

describe("Sakura's view of the electrical checks", () => {
  it("run_checks lists them in their own section and counts what the user ignored", () => {
    let p = circuit({ D1: "led", D2: "led", R1: "resistor", ...PORTS }, [["3V3", "D1.A", "D2.A"], ["GND", "D1.K", "D2.K", "R1.1", "R1.2"]])
    let out = runTool(p, "run_checks", {})
    expect(out.result).toContain("Electrical (3 warning(s)")
    expect(out.result).toContain("- D1 has no resistor between it and 3V3")
    expect(out.result).toContain("- R1 has both pins on GND, so it does nothing")
    expect(out.summary).toContain("3 electrical warning(s)")

    p = ignoreCheck(p, `bare-led:${idOf(p, "D2")}`)
    out = runTool(p, "run_checks", {})
    expect(out.result).toContain("Electrical (2 warning(s)")
    expect(out.result).not.toContain("- D2 has")
    expect(out.result).toContain("1 electrical warning(s) ignored by the user (D2): don't try to fix those warnings.")

    const design = JSON.parse(runTool(p, "get_design", {}).result)
    expect(design.checks).toMatchObject({ electrical_warnings: 2, electrical_ignored_by_user: 1 })
  })

  it("still says the ignored ones are there when everything else passes", () => {
    // D1 is the only physical part, placed in the middle of the board: nothing to route.
    let p = circuit({ D1: "led", ...PORTS }, [["3V3", "D1.A"], ["GND", "D1.K"]])
    p = ignoreCheck(p, `bare-led:${idOf(p, "D1")}`)
    p = updateComponent(p, idOf(p, "D1"), { pcb: { placed: true } })
    expect(runTool(p, "run_checks", {}).result).toBe("All checks pass. 1 electrical warning(s) ignored by the user (D1): don't try to fix those warnings.")
  })
})

describe("parseValue", () => {
  it("reads values as written on schematics", () => {
    expect(parseValue("100nF")).toBeCloseTo(1e-7)
    expect(parseValue("4k7")).toBe(4700)
    expect(parseValue("10uF")).toBeCloseTo(1e-5)
    expect(parseValue("2R2")).toBeCloseTo(2.2)
    expect(parseValue("1M")).toBe(1e6)
    expect(parseValue("10 kΩ")).toBe(10000)
    expect(parseValue("16MHz")).toBe(16e6)
    expect(parseValue("0R")).toBe(0)
    expect(parseValue("red")).toBeNull()
    expect(parseValue(undefined)).toBeNull()
  })
})

describe("LED driver chips and multi-common digits", () => {
  const driverPins = (extra: string[]) => [{ number: "1", name: "V+" }, { number: "2", name: "GND" }, ...extra.map((n, i) => ({ number: String(i + 3), name: n }))]

  it("lets an LED on an LM3914, a TM1637 or other driver family off, whatever the suffix or prefix", () => {
    for (const [name, pin, category] of [["LM3914", "OUT1", "ICs"], ["LM3915N-1", "OUT1", "ICs"], ["TM1637", "SEG1", "ICs"], ["GY-TM1637 module", "GRID1", "ICs"], ["ht16k33", "ROW0", "ICs"], ["AS1115-BSST", "SEGA", "ICs"], ["LP5024RSMR", "OUT0", "ICs"]] as const) {
      const part = createPart(createProject("drv"), { name, description: "LED driver", category, footprint: "sot23", pins: driverPins([pin]) })
      const p = circuit({ U1: part.id, D1: "led", ...PORTS }, [["5V", "D1.A", "U1.V+"], ["~", "D1.K", `U1.${pin}`], ["GND", "U1.GND"]], part.project)
      expect(messages(p, "bare-led"), name).toEqual([])
    }
  })

  it("checks a 7-segment digit whose common is on two pins", () => {
    const pins = [["1", "E"], ["2", "D"], ["3", "COM"], ["4", "C"], ["5", "DP"], ["6", "B"], ["7", "A"], ["8", "COM"], ["9", "F"], ["10", "G"]]
    const seg = createPart(createProject("seg"), {
      name: "5161AS",
      description: "1-digit 7-segment display, common cathode",
      category: "Diodes",
      footprint: "dip10",
      pins: pins.map(([number, name]) => ({ number, name })),
    })
    const p = circuit({ U1: seg.id, M1: "attiny85", ...PORTS }, [["~", "U1.A", "M1.PB0"], ["GND", "U1.3", "U1.8", "M1.GND"], ["3V3", "M1.VCC"]], seg.project)

    expect(messages(p, "bare-led")).toHaveLength(1)
    expect(messages(p, "bare-led")[0]).toContain("U1's LED A/COM has no resistor")
  })
})
