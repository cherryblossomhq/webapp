import { uid, withStableIds } from "../lib/id"
import { strokeTextWidth } from "../lib/strokeFont"
import { autoroute } from "./autoroute"
import { createBlock } from "./blocks"
import { M3_HOLES } from "./board"
import { stitchVias } from "./stitch"
import { findPin, addComponent, addLabel, addTrace, addVia, autoPlacePcb, connectPins, createProject, labelPin, resolvePinSpec } from "./ops"
import { SCH_GRID } from "./symbols"
import { tidySchematic } from "./tidy"
import type { BoardText, CopperLayer, MountingHoles, PcbSide, Project, Rotation, Vec2 } from "./types"

interface Builder {
  project: Project
  add: (
    partId: string,
    x: number,
    y: number,
    opts?: { rot?: Rotation; props?: Record<string, string>; footprint?: string; ref?: string },
  ) => string
  wire: (a: string, b: string) => void
  net: (name: string, ...pins: string[]) => void
  /**
   * Wire two neighbouring pins straight together and name the net with one flag standing on
   * the wire, where labels on both pins would face each other and collide.
   */
  link: (name: string, a: string, b: string) => void
  /** Mark pins (by number or name) as unused on purpose. */
  nc: (ref: string, ...pins: string[]) => void
  /** Group parts into a named block. A design with blocks is tidied when it is finished. */
  group: (name: string, ...refs: string[]) => void
  /** Put a part on the board at (x, y) mm. */
  place: (ref: string, x: number, y: number, rot?: Rotation, side?: PcbSide) => void
  text: (text: string, x: number, y: number, size: number, rot?: Rotation) => void
  /** Hand-routed copper, e.g. the fan-out of a fine-pitch part, kept by the autorouter. */
  track: (points: [number, number][], width?: number, layer?: CopperLayer) => void
  via: (x: number, y: number) => void
  /** Trace width for nets that carry current. */
  netWidth: (width: number, ...nets: string[]) => void
  /** Board size, corner holes and ground pours, then route everything and stitch the pours. */
  finish: (opts: {
    width: number
    height: number
    holes?: MountingHoles | null
    pour?: string | null
    /** Nets to route and lock before the rest, as a designer does with critical nets. */
    routeFirst?: string[]
  }) => Project
}

const segLength = (p: Vec2, q: Vec2) => Math.abs(p.x - q.x) + Math.abs(p.y - q.y)
const snap = (v: number) => Math.round(v / SCH_GRID) * SCH_GRID

const M2_HOLES: MountingHoles = { drill: 2.2, diameter: 4.4, inset: 2.8 }

function builder(name: string, description: string): Builder {
  const b: Builder = {
    project: createProject(name, description),
    add(partId, x, y, opts = {}) {
      const res = addComponent(b.project, partId, { sch: { x, y, rot: opts.rot ?? 0 }, props: opts.props, footprint: opts.footprint, ref: opts.ref })
      b.project = res.project
      return res.component.ref
    },
    wire(a, c) {
      const pa = resolvePinSpec(b.project, a)
      const pc = resolvePinSpec(b.project, c)
      if (!pa || !pc) throw new Error(`Template pin not found: ${a} / ${c}`)
      b.project = connectPins(b.project, pa, pc)
    },
    link(netName, a, c) {
      b.wire(a, c)
      const w = b.project.wires[b.project.wires.length - 1]
      let best = 0
      for (let i = 1; i < w.points.length - 1; i++) {
        if (segLength(w.points[i], w.points[i + 1]) > segLength(w.points[best], w.points[best + 1])) best = i
      }
      const [p, q] = [w.points[best], w.points[best + 1]]
      const horizontal = p.y === q.y
      // Middle of the longest run, on the grid; the flag's point touches the wire.
      const mid = { x: snap((p.x + q.x) / 2), y: snap((p.y + q.y) / 2) }
      b.project = addLabel(b.project, netName, mid, horizontal ? 90 : 0).project
    },
    net(netName, ...pins) {
      for (const spec of pins) {
        const ref = resolvePinSpec(b.project, spec)
        if (!ref || !findPin(b.project, ref)) throw new Error(`Template pin not found: ${spec}`)
        b.project = labelPin(b.project, ref, netName)
      }
    },
    group(name, ...refs) {
      const ids = refs.map((ref) => {
        const c = b.project.components.find((x) => x.ref === ref)
        if (!c) throw new Error(`Template part not found: ${ref}`)
        return c.id
      })
      b.project = createBlock(b.project, name, ids).project
    },
    nc(ref, ...pins) {
      const numbers = pins.map((spec) => {
        const pin = resolvePinSpec(b.project, `${ref}.${spec}`)
        if (!pin) throw new Error(`Template pin not found: ${ref}.${spec}`)
        return pin.pin
      })
      b.project = {
        ...b.project,
        components: b.project.components.map((c) => (c.ref === ref ? { ...c, nc: [...new Set([...(c.nc ?? []), ...numbers])] } : c)),
      }
    },
    place(ref, x, y, rot = 0, side = "top") {
      if (!b.project.components.some((c) => c.ref === ref)) throw new Error(`Template part not found: ${ref}`)
      b.project = {
        ...b.project,
        components: b.project.components.map((c) => (c.ref === ref ? { ...c, pcb: { x, y, rot, side, placed: true } } : c)),
      }
    },
    text(text, x, y, size, rot = 0) {
      const t: BoardText = { id: uid("tx"), text, x, y, size, rot, side: "top" }
      b.project = { ...b.project, texts: [...b.project.texts, t] }
    },
    track(points, width = b.project.rules.traceWidth, layer = "top") {
      b.project = addTrace(b.project, { layer, width, points: points.map(([x, y]) => ({ x, y })), locked: true }).project
    },
    via(x, y) {
      const res = addVia(b.project, { x, y })
      b.project = { ...res.project, vias: res.project.vias.map((v) => (v.id === res.via.id ? { ...v, locked: true } : v)) }
    },
    netWidth(width, ...nets) {
      const netWidths = { ...b.project.rules.netWidths }
      for (const n of nets) netWidths[n] = width
      b.project = { ...b.project, rules: { ...b.project.rules, netWidths } }
    },
    finish({ width, height, holes = null, pour = "GND", routeFirst }) {
      let p: Project = { ...b.project, board: { ...b.project.board, width, height, mountingHoles: holes } }
      // Drawn in blocks, the schematic is laid out by Tidy, as a user would after grouping it.
      if (p.blocks?.length) {
        const tidied = tidySchematic(p)
        if (!tidied.ok) throw new Error(`Template ${p.name} doesn't tidy: ${tidied.message} ${tidied.problems.join("; ")}`)
        p = tidied.project
      }
      if (pour) {
        p = {
          ...p,
          zones: [
            { id: uid("z"), net: pour, layer: "top" },
            { id: uid("z"), net: pour, layer: "bottom" },
          ],
        }
      }
      p = autoPlacePcb(p)
      // No time limit: an example is a fixed design that routes fully, and it should come out
      // the same on every machine. They ship already built (examples.ts), so nobody waits on it.
      const untimed = { timeLimitMs: Infinity }
      if (routeFirst?.length) {
        const before = new Set([...p.traces.map((t) => t.id), ...p.vias.map((v) => v.id)])
        p = autoroute(p, { ...untimed, nets: routeFirst.map((n) => `net:${n}`) }).project
        p = {
          ...p,
          traces: p.traces.map((t) => (before.has(t.id) ? t : { ...t, locked: true })),
          vias: p.vias.map((v) => (before.has(v.id) ? v : { ...v, locked: true })),
        }
      }
      p = autoroute(p, untimed).project
      return pour ? stitchVias(p, pour).project : p
    },
  }
  return b
}

export function blinkerTemplate(): Project {
  const b = builder("555 LED blinker", "Astable NE555 flashing an LED at about 1.4 Hz")
  b.add("ne555", 0, 0)
  b.add("power", 0, 1.8, { props: { net: "VCC" } })
  b.add("ground", 0, -1.9)
  b.wire("#PWR1.1", "U1.VCC")
  b.wire("U1.GND", "#GND1.1")

  b.add("resistor", 1.7, 0.4, { props: { resistance: "470" } })
  b.add("led", 3.4, 0.4, { props: { color: "red" } })
  b.add("ground", 4.4, -0.7)
  b.wire("U1.OUT", "R1.1")
  b.wire("R1.2", "D1.A")
  b.wire("D1.K", "#GND2.1")

  b.add("resistor", -3.2, 1.5, { props: { resistance: "10k" } })
  b.add("resistor", -3.2, 0.4, { props: { resistance: "68k" } })
  b.add("capacitor_polarized", -3.2, -0.9, { props: { capacitance: "10uF", voltage: "16V" } })
  b.add("capacitor", -3.2, -2.1, { props: { capacitance: "10nF" } })
  b.net("VCC", "R2.1", "U1.RST")
  b.net("DIS", "R2.2", "R3.1", "U1.DIS")
  b.net("THR", "R3.2", "C1.1", "U1.THR", "U1.TRIG")
  b.net("CV", "C2.1", "U1.CV")
  b.net("GND", "C1.2", "C2.2")

  b.add("capacitor", 1.9, 1.9, { rot: 270, props: { capacitance: "100nF" } })
  b.net("VCC", "C3.1")
  b.net("GND", "C3.2")

  b.add("header_1x2", -3.4, -3.3)
  b.net("VCC", "J1.1")
  b.net("GND", "J1.2")

  b.place("U1", 0, 1)
  b.place("C3", 4.5, 2.9, 90)
  b.place("R2", 7.5, 2.9, 90)
  b.place("R3", 10, 2.9, 90)
  b.place("C2", 4.5, -2.2, 90)
  b.place("C1", 9.5, -5)
  b.place("R1", -5.5, 0.4, 180)
  b.place("D1", -9, 0.4, 180)
  b.place("J1", -10, -7.5)
  b.text("555 BLINKER", 0, 8.6, 1.5)
  b.text("REV A", 11.5, -10.6, 0.8)
  b.group("POWER IN", "J1")
  b.group("555 TIMER", "U1", "R2", "R3", "C1", "C2", "C3")
  b.group("LED", "R1", "D1")
  return b.finish({ width: 40, height: 26, holes: M2_HOLES })
}

export function regulatorTemplate(): Project {
  const b = builder("3.3 V supply", "AMS1117-3.3 regulator from a 5 V screw terminal, with power LED")
  b.add("screw_terminal_2", -4, 0)
  b.add("ams1117_3v3", 0, 0)
  b.add("capacitor", -1.9, -0.9, { rot: 270, props: { capacitance: "10uF" } })
  b.add("capacitor", 1.9, -0.9, { rot: 270, props: { capacitance: "10uF" } })
  b.add("capacitor", 2.9, -0.9, { rot: 270, props: { capacitance: "100nF" } })
  b.add("resistor", 4.3, -0.9, { rot: 270, props: { resistance: "1k" } })
  b.add("led", 4.3, -2.6, { rot: 270, props: { color: "green" } })
  b.add("ground", 0, -1.6)
  b.wire("U1.GND", "#GND1.1")
  b.net("VIN", "J1.1", "U1.VIN", "C1.1")
  b.net("GND", "J1.2", "C1.2", "C2.2", "C3.2", "D1.K")
  b.net("3V3", "U1.VOUT", "C2.1", "C3.1", "R1.1")
  b.wire("R1.2", "D1.A")

  b.place("J1", -12, 0, 90)
  b.place("C1", -6.5, -3.5, 90)
  b.place("U1", 0, 0)
  b.place("C2", 6.5, 0.5, 90)
  b.place("C3", 8.5, 0.5, 90)
  b.place("R1", 12, 2.5, 90)
  b.place("D1", 12, -2.5, 90)
  b.text("3V3 SUPPLY", 0, 8.3, 1.4)
  b.text("5V IN", -10.4, 7.6, 0.9)
  b.group("INPUT", "J1")
  b.group("3.3V LDO", "U1", "C1", "C2", "C3")
  b.group("POWER LED", "R1", "D1")
  return b.finish({ width: 36, height: 24, holes: M2_HOLES })
}

export function mcuTemplate(): Project {
  const b = builder("ATmega328P minimal", "Bare ATmega328P with 16 MHz crystal, reset button and ISP header")
  b.add("atmega328p", 0, 0)
  b.net("5V", "U1.4", "U1.6", "U1.AVCC")
  b.net("GND", "U1.3", "U1.5", "U1.21")

  b.add("crystal", -4.4, 1.1, { props: { frequency: "16MHz" } })
  b.add("capacitor", -5.6, 0.2, { rot: 270, props: { capacitance: "22pF" } })
  b.add("capacitor", -3.2, 0.2, { rot: 270, props: { capacitance: "22pF" } })
  b.link("XTAL1", "Y1.1", "C1.1")
  b.link("XTAL2", "Y1.2", "C2.1")
  b.net("XTAL1", "U1.XTAL1")
  b.net("XTAL2", "U1.XTAL2")
  b.net("GND", "C1.2", "C2.2")

  b.add("resistor", -4.4, 2.6, { props: { resistance: "10k" } })
  b.add("pushbutton", -4.4, -1.8)
  b.net("5V", "R1.1")
  b.net("RESET", "R1.2", "U1.RESET", "SW1.1")
  b.net("GND", "SW1.2")

  b.add("capacitor", 3.4, 3.0, { rot: 270, props: { capacitance: "100nF" } })
  b.add("capacitor", 4.4, 3.0, { rot: 270, props: { capacitance: "100nF" } })
  b.net("5V", "C3.1", "C4.1")
  b.net("GND", "C3.2", "C4.2")

  b.add("header_1x6", 4.6, -0.6)
  b.net("PB4", "J1.1", "U1.PB4")
  b.net("PB5", "J1.2", "U1.PB5")
  b.net("PB3", "J1.3", "U1.PB3")
  b.net("RESET", "J1.4")
  b.net("5V", "J1.5")
  b.net("GND", "J1.6")

  b.add("resistor", 4.0, -3.2, { props: { resistance: "1k" } })
  b.add("led", 5.8, -3.2, { props: { color: "yellow" } })
  b.add("ground", 7.0, -4.2)
  b.net("PB5", "R2.1")
  b.wire("R2.2", "D1.A")
  b.wire("D1.K", "#GND1.1")

  b.nc("U1", "AREF", "ADC6", "ADC7", "PC0", "PC1", "PC2", "PC3", "PC4", "PC5", "PD0", "PD1", "PD2", "PD3", "PD4", "PD5", "PD6", "PD7", "PB0", "PB1", "PB2")
  b.place("U1", 0, 0)
  b.place("Y1", -11, -4, 90)
  b.place("C1", -16, -6.44)
  b.place("C2", -16, -1.56)
  b.place("C3", -8.5, 4, 90)
  b.place("C4", 8.5, -3, 90)
  b.place("R1", -2, 9)
  b.place("SW1", -13, 11)
  b.place("J1", 19, 0, 90)
  b.place("R2", 9, -10)
  b.place("D1", 13, -10)
  b.text("ATMEGA328P", 2, 14.4, 1.6)
  b.text("ISP", 19, -9.6, 1)
  b.group("MCU", "U1", "Y1", "C1", "C2", "R1", "SW1", "C3", "C4")
  b.group("ISP", "J1")
  b.group("LED", "R2", "D1")
  return b.finish({ width: 50, height: 36, holes: M3_HOLES })
}

/** A fuller board: protected 5 V supply, ATmega328P, trimmer input and an 8-LED bar on a 74HC595. */
export function nodeTemplate(): Project {
  const b = builder("Node-328 LED bar", "ATmega328P with a 7805 supply, trimmer input, FTDI and I2C headers, and a 74HC595 driving an 8-LED bar")

  b.add("atmega328p", 0, -2)

  // Power: screw terminal, reverse-polarity Schottky, bulk cap, 7805, output caps, power LED.
  b.add("screw_terminal_2", -14, 6)
  b.add("schottky", -11.4, 6.6)
  b.add("capacitor_polarized", -9.6, 5.4, { props: { capacitance: "47uF", voltage: "25V" }, footprint: "electrolytic_d6.3mm_p2.5mm" })
  b.add("lm7805", -7, 6.6)
  b.add("capacitor", -4.6, 5.4, { rot: 270, props: { capacitance: "10uF" }, footprint: "0805" })
  b.add("capacitor", -3.6, 5.4, { rot: 270, props: { capacitance: "100nF" } })
  b.add("resistor", -2.2, 6.2, { rot: 270, props: { resistance: "1k" } })
  b.add("led", -2.2, 4.6, { rot: 270, props: { color: "green" } })
  b.net("VRAW", "J1.1", "D1.A")
  b.net("VIN", "D1.K", "C1.+", "U2.IN")
  b.net("5V", "U2.OUT", "C2.1", "C3.1", "R1.1")
  b.wire("R1.2", "D2.A")
  b.net("GND", "J1.2", "C1.-", "U2.GND", "C2.2", "C3.2", "D2.K")

  // MCU with crystal, reset and decoupling.
  b.add("crystal", -4.6, -1.4, { rot: 90, props: { frequency: "16MHz" } })
  b.add("capacitor", -5.8, -2.6, { rot: 270, props: { capacitance: "22pF" } })
  b.add("capacitor", -3.4, -2.6, { rot: 270, props: { capacitance: "22pF" } })
  b.add("resistor", -4.2, 1.6, { rot: 270, props: { resistance: "10k" } })
  b.add("pushbutton", -5.8, 0.4)
  b.add("capacitor", 2.6, 1.6, { rot: 270, props: { capacitance: "100nF" } })
  b.add("capacitor", 3.6, 1.6, { rot: 270, props: { capacitance: "100nF" } })
  b.add("capacitor", 4.6, 1.6, { rot: 270, props: { capacitance: "100nF" } })
  b.net("5V", "U1.4", "U1.6", "U1.AVCC", "R2.1", "C6.1", "C7.1")
  b.net("GND", "U1.3", "U1.5", "U1.21", "C4.2", "C5.2", "SW1.2", "C6.2", "C7.2")
  b.net("XTAL1", "Y1.1", "C4.1", "U1.XTAL1")
  b.net("XTAL2", "Y1.2", "C5.1", "U1.XTAL2")
  b.net("RESET", "R2.2", "SW1.1", "U1.RESET", "C8.1")

  // FTDI serial header with auto-reset through C8.
  b.add("header_1x6", 8.4, 3)
  b.net("GND", "J2.1", "J2.2")
  b.net("5V", "J2.3")
  b.net("TXD", "J2.4", "U1.PD0")
  b.net("RXD", "J2.5", "U1.PD1")
  b.net("DTR", "J2.6", "C8.2")

  // Trimmer on ADC0 and an I2C header.
  b.add("potentiometer", -5.4, -5.6, { props: { resistance: "10k" } })
  b.net("5V", "RV1.1")
  b.net("ADC0", "RV1.W", "U1.PC0")
  b.net("GND", "RV1.3")
  b.add("header_1x4", 8.4, -0.6)
  b.net("GND", "J3.1")
  b.net("5V", "J3.2")
  b.net("SDA", "J3.3", "U1.PC4")
  b.net("SCL", "J3.4", "U1.PC5")

  // 74HC595 LED bar.
  b.add("sn74hc595", 4.6, -5.4)
  b.add("capacitor", 2.4, -3.4, { rot: 270, props: { capacitance: "100nF" } })
  b.net("5V", "U3.VCC", "U3.SRCLR", "C9.1")
  b.net("GND", "U3.GND", "U3.OE", "C9.2")
  b.net("MOSI", "U1.PB3", "U3.SER")
  b.net("SCK", "U1.PB5", "U3.SRCLK")
  b.net("LATCH", "U1.PB2", "U3.RCLK")
  const outputs = ["QA", "QB", "QC", "QD", "QE", "QF", "QG", "QH"]
  const colors = ["green", "green", "green", "green", "yellow", "yellow", "orange", "red"]
  outputs.forEach((q, i) => {
    const r = b.add("resistor", 7.4 + i * 0.8, -4.2, { rot: 270, props: { resistance: "330" } })
    const d = b.add("led", 7.4 + i * 0.8, -6.2, { rot: 270, props: { color: colors[i] } })
    b.net(`LED${i + 1}`, `U3.${q}`, `${r}.1`)
    b.wire(`${r}.2`, `${d}.A`)
    b.net("GND", `${d}.K`)
  })

  b.nc("U1", "AREF", "PC1", "PC2", "PC3", "ADC6", "ADC7", "PD2", "PD3", "PD4", "PD5", "PD6", "PD7", "PB0", "PB1", "PB4")
  b.nc("U3", "QH'")

  // Board: 74 x 48 mm.
  b.place("J1", -32, 4, 90)
  b.place("D1", -23.5, 11, 0)
  b.place("C1", -23, 3.5)
  b.place("U2", -12, 16.5)
  b.place("C2", -4.5, 15.5, 90)
  b.place("C3", -2.5, 15.5, 90)
  b.place("R1", -26, 16.5)
  b.place("D2", -26, 19.5)

  b.place("U1", 4, 1)
  b.place("Y1", -8, -1, 90)
  b.place("C4", -12.5, -3.44)
  b.place("C5", -12.5, 1.44)
  b.place("C6", -3.5, 6.5, 90)
  b.place("C7", 12.5, -0.5, 90)
  b.place("R2", 2, 10.5)
  b.place("SW1", 4, 17)
  b.place("C8", 14, 10.5)
  b.place("J2", 34, 3, 90)
  b.place("RV1", -22, -18, 90)
  b.place("J3", 18, 19.5)
  b.place("U3", 16, -8, 90)
  b.place("C9", 13.5, -3.5)
  for (let i = 0; i < 8; i++) {
    const x = -6 + i * 4.2
    b.place(`R${3 + i}`, x, -14, 90)
    b.place(`D${3 + i}`, x, -18.5, 90)
  }
  b.text("NODE-328", -21, -7.5, 2)
  b.text("VIN 7-12V", -32, 12.4, 0.9)
  b.text("FTDI", 30.8, 3, 1, 90)
  b.text("I2C", 26.5, 19.5, 1)
  b.text("LED BAR", 8.7, -22.2, 1)
  b.group("POWER", "J1", "D1", "C1", "U2", "C2", "C3", "R1", "D2")
  b.group("MCU", "U1", "Y1", "C4", "C5", "R2", "SW1", "C6", "C7", "RV1")
  b.group("FTDI", "J2", "C8")
  b.group("I2C", "J3")
  b.group("LED BAR", "U3", "C9", ...Array.from({ length: 8 }, (_, i) => [`R${3 + i}`, `D${3 + i}`]).flat())
  return b.finish({ width: 74, height: 48, holes: M3_HOLES })
}

/**
 * ESP32 robot controller: TB6612FNG dual motor driver, 7805 supply from a switched battery input,
 * seven 5 V sensor inputs through 10k/20k dividers, two encoder headers, an IBUS receiver port,
 * an I2C OLED and three buttons.
 */
export function esp32RobotTemplate(): Project {
  const b = builder(
    "ESP32 robot controller",
    "Control board for autonomous or radio-controlled robots: ESP32 DevKit, TB6612FNG motor driver, sensor, encoder and IBUS inputs, OLED and three buttons",
  )
  const terminal5mm = (pins: 2 | 3) => `terminal_block_5mm_${pins}`
  const R = (ref: string, x: number, y: number, resistance: string, rot: Rotation = 0) =>
    b.add("resistor", x, y, { ref, rot, props: { resistance } })

  // MCU and motor driver.
  b.add("esp32_devkit_v1", 0, 0, { ref: "U1" })
  b.add("tb6612fng", 7.4, 0.2, { ref: "U2" })
  b.net("5V", "U1.VIN")
  b.net("3V3", "U1.3V3")
  b.net("GND", "U1.2", "U1.29")
  b.net("VBAT", "U2.VM1", "U2.VM2", "U2.VM3")
  b.net("3V3", "U2.VCC", "U2.PWMA", "U2.PWMB", "U2.STBY")
  b.net("GND", "U2.18", "U2.3", "U2.4", "U2.9", "U2.10")
  b.net("MotorA_IN1", "U2.AIN1", "U1.D27")
  b.net("MotorA_IN2", "U2.AIN2", "U1.D14")
  b.net("MotorB_IN1", "U2.BIN1", "U1.D4")
  b.net("MotorB_IN2", "U2.BIN2", "U1.D13")
  b.nc("U1", "EN", "D2", "TX0", "RX0")

  // Motor outputs and driver decoupling.
  b.add("screw_terminal_2", 11.6, 1.1, { ref: "J1", footprint: terminal5mm(2) })
  b.add("screw_terminal_2", 11.6, -0.9, { ref: "J2", footprint: terminal5mm(2) })
  b.net("MOTA1", "U2.1", "U2.2", "J1.1")
  b.net("MOTA2", "U2.5", "U2.6", "J1.2")
  b.net("MOTB1", "U2.11", "U2.12", "J2.2")
  b.net("MOTB2", "U2.7", "U2.8", "J2.1")
  b.add("capacitor_tantalum", 10.4, 3.2, { ref: "C3", rot: 270, props: { capacitance: "10uF", voltage: "25V" } })
  b.add("capacitor", 11.6, 3.2, { ref: "C4", rot: 270, props: { capacitance: "100nF" } })
  b.net("VBAT", "C3.+", "C4.1")
  b.net("GND", "C3.-", "C4.2")

  // Battery input, power switch, reverse-polarity diode, 7805 and bulk caps.
  const bulk = { capacitance: "100uF", voltage: "50V" }
  b.add("screw_terminal_2", -10.4, 5.6, { ref: "J3", footprint: terminal5mm(2) })
  b.add("slide_switch", -8.2, 5.6, { ref: "SW8" })
  b.add("schottky", -6.2, 5.8, { ref: "D1", props: { mpn: "SS34" }, footprint: "diode_smc" })
  b.add("lm7805", -3.4, 5.8, { ref: "U3", props: { mpn: "L7805" }, footprint: "to220_3_vertical" })
  b.add("capacitor_polarized", -5, 4.4, { ref: "C2", rot: 270, props: bulk, footprint: "cap_elec_8x10.5" })
  b.add("capacitor_polarized", -1.6, 4.4, { ref: "C1", rot: 270, props: bulk, footprint: "cap_elec_8x10.5" })
  b.net("GND", "J3.2")
  b.link("VBAT_IN", "J3.1", "SW8.C")
  b.link("VSW", "SW8.1", "D1.A")
  b.nc("SW8", "3")
  b.link("VBAT", "D1.K", "U3.IN")
  b.net("VBAT", "C2.+")
  b.net("5V", "U3.OUT", "C1.+")
  b.net("GND", "U3.GND", "C1.-", "C2.-")

  // Seven sensor inputs (GND, signal, 5V) with 10k/20k dividers down to 3.3 V logic.
  const sensors: [string, string][] = [
    ["QTR1", "D35"],
    ["S1", "D33"],
    ["S2", "D25"],
    ["S3", "D26"],
    ["S4", "D34"],
    ["S5", "D15"],
    ["QTR2", "D32"],
  ]
  sensors.forEach(([net, gpio], i) => {
    const x = -10.6 + i * 3.6
    const j = b.add("screw_terminal_3", x, 10.6, { ref: `J${6 + i}`, footprint: terminal5mm(3) })
    const top = R(`R${4 + i * 2}`, x + 1.6, 10.6, "10k")
    const bottom = R(`R${5 + i * 2}`, x + 2.4, 9.4, "20k", 270)
    b.net("GND", `${j}.1`, `${bottom}.2`)
    b.net("5V", `${j}.3`)
    b.wire(`${j}.2`, `${top}.1`)
    b.link(net, `${top}.2`, `${bottom}.1`)
    b.net(net, `U1.${gpio}`)
  })

  // Three buttons to 3V3 with 10k pull-downs.
  const buttons: [string, string][] = [
    ["Button1", "VP"],
    ["Button2", "VN"],
    ["Button3", "D12"],
  ]
  buttons.forEach(([net, gpio], i) => {
    const y = -4.2 - i * 2.2
    const sw = b.add("pushbutton_smd", -8.4, y, { ref: `SW${i + 1}` })
    const r = R(`R${i + 1}`, -6.4, y - 0.6, "10k", 270)
    b.net("3V3", `${sw}.1`)
    b.link(net, `${sw}.2`, `${r}.1`)
    b.net(net, `U1.${gpio}`)
    b.net("GND", `${r}.2`)
  })

  // OLED, encoder headers and the IBUS receiver port (RX divided down to 3.3 V).
  b.add("oled_096_i2c", 5.6, -4.6, { ref: "J13" })
  b.net("GND", "J13.GND")
  b.net("3V3", "J13.VDD")
  b.net("I2C_SCL", "J13.SCK", "U1.D22")
  b.net("I2C_SDA", "J13.SDA", "U1.D21")
  const encoders: [string, string, string][] = [
    ["Encoder1", "D5", "D18"],
    ["Encoder2", "D19", "D23"],
  ]
  encoders.forEach(([name, a, c], i) => {
    const j = b.add("header_1x4", 8.4 + i * 3.4, -4.4, { ref: `J${4 + i}`, footprint: "pin_header_1x4" })
    b.net("3V3", `${j}.1`)
    b.net(`${name}_ChA`, `${j}.2`, `U1.${a}`)
    b.net(`${name}_ChB`, `${j}.3`, `U1.${c}`)
    b.net("GND", `${j}.4`)
  })
  b.add("header_1x4", 5.6, -7.6, { ref: "J14", footprint: "pin_header_1x4" })
  R("R19", 8.2, -6.9, "10k")
  R("R18", 9, -8.1, "20k", 270)
  b.wire("J14.1", "R19.1")
  b.link("IBUS_RX", "R19.2", "R18.1")
  b.net("IBUS_RX", "U1.RX2")
  b.net("GND", "R18.2")
  b.net("5V", "J14.2")
  b.net("GND", "J14.3")
  b.net("IBUS_TX", "J14.4", "U1.TX2")

  // Trace widths: 1 mm for battery and motor current, 0.75 mm for 5 V.
  b.netWidth(1, "VBAT_IN", "VSW", "VBAT", "MOTA1", "MOTA2", "MOTB1", "MOTB2")
  b.netWidth(0.75, "5V")

  // Board: 100 x 100 mm, terminals on the edges, MCU in the middle.
  b.place("U1", 2.27, 14.47, 90)
  b.place("U2", 0, -14.55, 90)
  fanOutDriver(b, 0, -14.55)
  b.place("J1", -44, -14.5, 270)
  b.place("J2", 44, -14.5, 90)
  b.place("C3", -7.85, -12.96, 90)
  b.place("C4", -7.84, -17.41, 90)

  b.place("J3", 0, -40)
  b.place("SW8", -16.34, -38.99, 270)
  b.place("D1", 0, -30, 180)
  b.place("U3", -30.5, -30.81, 180)
  b.place("C1", -35.67, -41.25, 270)
  b.place("C2", -24.62, -41.17, 270)

  // Sensor terminals: five along the top edge, one on each side, dividers just inside.
  const sensorPlaces: [number, number, Rotation, [number, number, Rotation], [number, number, Rotation]][] = [
    [-34, 44, 180, [-31, 34, 180], [-27.38, 34, 180]],
    [-44, 15, 270, [-33.44, 17.79, 270], [-33.46, 21.22, 270]],
    [-17, 44, 180, [-14.05, 34, 180], [-10.38, 34, 180]],
    [0, 44, 180, [3, 34, 180], [6.63, 34, 180]],
    [17, 44, 180, [19.63, 34, 180], [23.52, 34, 180]],
    [44.13, 14.81, 90, [35.21, 14.38, 90], [35.28, 10.57, 90]],
    [34, 44, 180, [36.82, 34, 180], [40.56, 34, 180]],
  ]
  sensorPlaces.forEach(([x, y, rot, top, bottom], i) => {
    b.place(`J${6 + i}`, x, y, rot)
    b.place(`R${4 + i * 2}`, ...top)
    b.place(`R${5 + i * 2}`, ...bottom)
  })

  b.place("SW1", 33.55, -41.75)
  b.place("SW2", 22.75, -41.76)
  b.place("SW3", 12.05, -41.75)
  b.place("R1", 33.53, -36.35)
  b.place("R2", 22.73, -36.41)
  b.place("R3", 12.01, -36.28)

  b.place("J13", 23.04, -6.81)
  b.place("J4", -47.19, -28.01, 270)
  b.place("J5", 47.23, -28.16, 270)
  b.place("J14", -37.1, 0.64)
  b.place("R19", -40.14, 4.43, 180)
  b.place("R18", -36.92, 4.44, 180)

  // Silkscreen: the title left-aligned, connector pin names beside the pins.
  const left = (text: string, x: number, y: number, size: number) => b.text(text, x + strokeTextWidth(text, size) / 2, y, size)
  left("ESP32", -33.7, -18.7, 2.8)
  left("ROBOT CONTROLLER", -33.7, -22.5, 2.6)
  left("AUTONOMOUS & RADIO CONTROLLED", -33.7, -25.8, 1.15)
  for (const x of [-34, -17, 0, 17, 34]) {
    b.text("+ 5V", x - 5, 37.2, 1.4)
    b.text("S", x, 37.2, 1.4)
    b.text("GND", x + 5, 37.2, 1.4)
  }
  for (const [label, y] of [["GND", 20], ["S", 15], ["+ 5V", 10]] as const) b.text(label, -38.3, y, 1.4, 90)
  for (const [label, y] of [["GND", 9.81], ["S", 14.81], ["+ 5V", 19.81]] as const) b.text(label, 38.4, y, 1.4, 90)
  b.text("MOTOR_A", -38.3, -14.5, 1.4, 90)
  b.text("MOTOR_B", 38.4, -14.5, 1.4, 90)
  for (const [label, dx] of [["IBUS_RX", 0], ["+ 5V", 2.54], ["GND", 5.08], ["IBUS_TX", 7.62]] as const) b.text(label, -40.91 + dx, -4.2, 1.15, 90)
  // Encoder pin names beside each header, reading inwards from the board edge.
  for (const [n, sign] of [[1, -1], [2, 1]] as const) {
    ;["+3.3V", `ENC${n}_ChA`, `ENC${n}_ChB`, "GND"].forEach((label, i) => {
      const half = strokeTextWidth(label, 1.2) / 2
      b.text(label, sign * (45.6 - half), -24.2 - i * 2.54 - (n === 2 ? 0.15 : 0), 1.2)
    })
  }
  b.text("+ BAT -", 0, -46.9, 2.2)
  b.text("ON", -12, -36.45, 2)
  b.text("OFF", -11.4, -41.53, 2)
  b.text("OK", 33.55, -47, 2.2)
  b.text("DOWN", 22.75, -47, 2.2)
  b.text("UP", 12.05, -47, 2.2)
  b.group("POWER", "J3", "SW8", "D1", "U3", "C1", "C2")
  b.group("MCU", "U1")
  b.group("BUTTONS", "SW1", "SW2", "SW3", "R1", "R2", "R3")
  b.group("MOTOR DRIVER", "U2", "C3", "C4", "J1", "J2")
  b.group("LINE SENSORS", ...Array.from({ length: 7 }, (_, i) => [`J${6 + i}`, `R${4 + i * 2}`, `R${5 + i * 2}`]).flat())
  b.group("ENCODERS", "J4", "J5")
  b.group("OLED", "J13")
  b.group("RECEIVER", "J14", "R18", "R19")
  return b.finish({
    width: 100,
    height: 100,
    holes: { drill: 2.2, diameter: 4.4, inset: 4.2 },
    // The driver's control pins sit between its 3V3 pins at 0.65 mm pitch; give them first pick.
    routeFirst: ["MotorA_IN1", "MotorA_IN2", "MotorB_IN1", "MotorB_IN2"],
  })
}

/**
 * Hand fan-out of the TB6612FNG (SSOP-24, 0.65 mm pitch) placed at (x, y) with rotation 90, so
 * its control pins face +y. VM1, VM2 and VM3 join on a bus under the body; the 3V3 and GND pins
 * escape outwards to staggered vias that leave room for the control lines between them.
 */
function fanOutDriver(b: Builder, x: number, y: number) {
  const p = (dx: number, dy: number): [number, number] => [x + dx, y + dy]
  const pin = (n: number) => (n >= 13 ? 3.575 - (n - 13) * 0.65 : -3.575 + (n - 1) * 0.65)
  const top = 3.625
  const inner = top - 0.75
  const outer = top + 0.75
  // VBAT: VM1 (24), VM3 (14) and VM2 (13) on a wide bus between the pad rows, which leaves
  // the part sideways at full width past both ends of the rows.
  const bus = inner - 0.75
  b.track([p(pin(24), top), p(pin(24), bus), p(pin(13), bus), p(pin(13), top)], 0.5)
  b.track([p(pin(14), top), p(pin(14), bus)], 0.4)
  b.track([p(pin(24), bus), p(pin(24) - 2.2, bus)], 1)
  b.track([p(pin(13), bus), p(pin(13) + 2.2, bus)], 1)
  // 3V3: VCC (20) and STBY (19) joined at their pads; PWMA (23) and PWMB (15) step outwards.
  b.track([p(pin(20), top + 0.4), p(pin(19), top + 0.4)])
  b.track([p(pin(20), top), p(pin(20), outer + 0.9)])
  b.via(...p(pin(20), outer + 0.9))
  b.track([p(pin(23), top), p(pin(23), outer + 0.5), p(pin(23) - 0.55, outer + 1.05)])
  b.via(...p(pin(23) - 0.55, outer + 1.05))
  b.track([p(pin(15), top), p(pin(15), outer + 0.5), p(pin(15) + 0.55, outer + 1.05)])
  b.via(...p(pin(15) + 0.55, outer + 1.05))
  // Motor outputs AO1 (1, 2), AO2 (5, 6), BO2 (7, 8) and BO1 (11, 12): each pair joins and
  // runs out past the PGND vias, where the 1 mm motor traces can start.
  for (const [a, c] of [
    [1, 2],
    [5, 6],
    [7, 8],
    [11, 12],
  ]) {
    const mid = (pin(a) + pin(c)) / 2
    b.track([p(pin(a), -top - 0.4), p(pin(c), -top - 0.4)], 0.4)
    b.track([p(pin(a), -top), p(pin(a), -outer - 0.3), p(mid, -outer - 0.95), p(mid, -outer - 2.2)], 0.4)
    b.track([p(pin(c), -top), p(pin(c), -outer - 0.3), p(mid, -outer - 0.95)], 0.4)
  }
  // GND (18) up to a via; PGND1 (3, 4) and PGND2 (9, 10) in pairs down to vias.
  b.track([p(pin(18), top), p(pin(18), outer + 0.9)])
  b.via(...p(pin(18), outer + 0.9))
  for (const [a, c] of [
    [3, 4],
    [9, 10],
  ]) {
    const mid = (pin(a) + pin(c)) / 2
    b.track([p(pin(a), -top - 0.4), p(pin(c), -top - 0.4)])
    b.track([p(pin(a), -top), p(pin(a), -outer - 0.3), p(mid, -outer - 0.95)])
    b.track([p(pin(c), -top), p(pin(c), -outer - 0.3), p(mid, -outer - 0.95)])
    b.via(...p(mid, -outer - 0.95))
  }
}

/**
 * The same document on every build, down to ids and timestamps, so the shipped examples
 * (`examples.ts`) can be checked against a fresh one.
 */
const reproducible = (template: () => Project) => (): Project => ({ ...withStableIds(template), createdAt: 0, updatedAt: 0 })

export const TEMPLATES = [
  { id: "esp32-robot", name: "ESP32 robot controller", description: "ESP32, TB6612FNG motor driver, sensors, OLED.", build: reproducible(esp32RobotTemplate) },
  { id: "node", name: "Node-328 LED bar", description: "MCU, 5 V supply, headers and an LED bar.", build: reproducible(nodeTemplate) },
  { id: "blinker", name: "555 LED blinker", description: "Timer, RC network and an LED.", build: reproducible(blinkerTemplate) },
  { id: "regulator", name: "3.3 V supply", description: "LDO with input, output and indicator.", build: reproducible(regulatorTemplate) },
  { id: "mcu", name: "ATmega328P minimal", description: "Crystal, reset and ISP header.", build: reproducible(mcuTemplate) },
]
