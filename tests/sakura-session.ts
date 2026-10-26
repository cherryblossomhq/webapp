import { readFileSync } from "node:fs"
import { join } from "node:path"
import { runTool, type ToolOutcome } from "../src/ai/tools"
import { computeConnectivity, pinKey } from "../src/model/connectivity"
import { registerProjectParts } from "../src/model/customParts"
import { isPhysical, schematicPins } from "../src/model/instances"
import { findPart } from "../src/model/library"
import { createProject } from "../src/model/ops"
import type { Project } from "../src/model/types"

// The Sakura session the owner ran on a review branch, replayed
// tool call by tool call through the real tools: an ESP32-C3-MINI-1, a BME280, an AP2112K-3.3, a
// USB-C receptacle, two buttons, an LED and passives, on a 40x30 mm 2-layer board.
//
// The two project parts are as create_part built them then (sakura-session-parts.json):
// U1 from LCSC C5290152 (pins and pads read back from the owner's exported Circuit JSON, since the
// supplier recording has no C5290152) and U2, the BME280, from the KiCad library fixture
// (Sensor:BME280). The rest are library parts. The nets are the log's connect calls, pin for pin.
// Two ways to lay the parts out, for two kinds of test. `firstRequest`: each part on a spot of its
// own, well apart (`apart`), then grouped into the five blocks, as the sheet stood when Sakura first
// tried to tidy it (where add_component used to put a part given no x/y, pins of neighbours met and
// the wires connect drew joined BOOT to GND and EN to USB_DP). `firstDrawn`: where add_component
// puts a part given no x/y now, or where a test says (`at`), and no blocks, for the tests of moving,
// turning and pasting parts on that sheet.

const FIXTURE = JSON.parse(readFileSync(join(__dirname, "sakura-session-parts.json"), "utf8")) as Pick<Project, "parts" | "footprints">

export const U1_PART = FIXTURE.parts!.find((p) => p.name === "ESP32-C3-MINI-1")!.id
export const U2_PART = FIXTURE.parts!.find((p) => p.name === "BME280")!.id

export interface Logged {
  tool: string
  input: unknown
  summary: string
  result: string
  isError: boolean
}

/** A replay: the project, the request's start (what `tidy_schematic` compares with), and the log. */
export class Session {
  project: Project
  start: Project
  log: Logged[] = []
  constructor(project?: Project) {
    const p = project ?? { ...createProject("untitled project"), parts: FIXTURE.parts, footprints: FIXTURE.footprints }
    registerProjectParts(p)
    this.project = p
    this.start = p
  }
  /** A new user request starts here. */
  request() {
    this.start = this.project
  }
  /** One tool call, kept when it works, as the copilot commits it. */
  run(tool: string, input: object = {}): ToolOutcome {
    const out = runTool(this.project, tool, input, { start: this.start })
    this.log.push({ tool, input, summary: out.summary, result: out.result, isError: out.isError })
    if (!out.isError) this.project = out.project
    return out
  }
  /** As `run`, but a refusal fails the replay. */
  must(tool: string, input: object = {}): ToolOutcome {
    const out = this.run(tool, input)
    if (out.isError) throw new Error(`${tool} ${JSON.stringify(input)}: ${out.result}`)
    return out
  }
  ref(ref: string) {
    const c = this.project.components.find((x) => x.ref === ref)
    if (!c) throw new Error(`no ${ref}`)
    return c
  }
}

/** Every physical pin's net name ("U2.4" -> "SCL"), null for a pin on nothing. */
export function netlist(project: Project): Map<string, string | null> {
  const conn = computeConnectivity(project)
  const byId = new Map(conn.nets.map((n) => [n.id, n]))
  const out = new Map<string, string | null>()
  for (const c of project.components) {
    if (!isPhysical(findPart(c.partId))) continue
    for (const p of schematicPins(c)) {
      const id = conn.pinNet.get(pinKey(c.id, p.pin))
      const n = id ? byId.get(id) : undefined
      out.set(`${c.ref}.${p.pin}`, n && (n.named || n.pins.length > 1) ? n.name : null)
    }
  }
  return out
}

/** The pins whose net differs between two netlists, as "J1.A8: null -> CC1". */
export function netlistDiff(a: Map<string, string | null>, b: Map<string, string | null>): string[] {
  const out: string[] = []
  for (const k of new Set([...a.keys(), ...b.keys()])) if ((a.get(k) ?? null) !== (b.get(k) ?? null)) out.push(`${k}: ${a.get(k) ?? null} -> ${b.get(k) ?? null}`)
  return out.sort()
}

const ESP_GND = ["1", "2", "11", "14", ...Array.from({ length: 13 }, (_, i) => String(36 + i)), "49", "50", "51", "52", "53"]

/** Where each part goes: in rows, far enough apart that no two parts' pins or drawn wires meet. */
const SPOTS = ["U1", "U2", "U3", "J1", "SW1", "SW2", "D1", "R1", "R2", "R3", "R4", "R5", "R6", "R7", "C1", "C2", "C3", "C4", "C5"]
const apart = (ref: string) => {
  const i = SPOTS.indexOf(ref)
  return { x: (i % 5) * 20, y: -Math.floor(i / 5) * 20 }
}

type At = Record<string, { x: number; y: number; rotation?: number }>

/**
 * The first request up to the grouping: board, parts and nets, as the log shows them. A part goes
 * where `at` says, else on its spot `apart` when `spread`, else where add_component puts it.
 */
export function buildDesign(s: Session, { j1Rot = 0, at = {}, spread = true }: { j1Rot?: number; at?: At; spread?: boolean } = {}) {
  const spot = (ref: string) => at[ref] ?? (spread ? apart(ref) : {})
  s.must("set_board", { width: 40, height: 30 })
  s.must("add_component", { part_id: U1_PART, ref: "U1", ...spot("U1") })
  s.must("add_component", { part_id: U2_PART, ref: "U2", ...spot("U2") })
  s.must("add_component", { part_id: "ap2112k_3v3", ref: "U3", ...spot("U3") })
  // The exported board has J1 turned 90, and Tidy never turns a box part (tidy/shapes.ts
  // allowedTurns), so that turn came from outside the log.
  s.must("add_component", { part_id: "usb_c", ref: "J1", ...spot("J1"), ...(j1Rot ? { rotation: j1Rot } : {}) })
  s.must("add_component", { part_id: "pushbutton_smd", ref: "SW1", ...spot("SW1") })
  s.must("add_component", { part_id: "pushbutton_smd", ref: "SW2", ...spot("SW2") })
  s.must("add_component", { part_id: "led", ref: "D1", props: { color: "green" }, ...spot("D1") })
  for (const [ref, v] of [["R1", "5.1k"], ["R2", "5.1k"], ["R3", "10k"], ["R4", "10k"], ["R5", "4.7k"], ["R6", "4.7k"], ["R7", "1k"]]) {
    s.must("add_component", { part_id: "resistor", ref, props: { resistance: v }, ...spot(ref) })
  }
  for (const [ref, v] of [["C1", "10uF"], ["C2", "10uF"], ["C3", "100nF"], ["C4", "100nF"], ["C5", "1uF"]]) {
    s.must("add_component", { part_id: "capacitor", ref, props: { capacitance: v }, ...spot(ref) })
  }
  const connect = (net: string, pins: string[]) => s.must("connect", { pins, net_name: net })
  connect("GND", [...ESP_GND.map((n) => `U1.${n}`), "U2.1", "U2.7", "U2.SDO", "U3.GND", "J1.A1", "J1.B1", "J1.SHIELD", "R1.2", "R2.2", "C1.2", "C2.2", "C3.2", "C4.2", "C5.2", "SW1.2", "SW2.2"])
  connect("VBUS", ["J1.A4", "J1.B4", "U3.VIN", "U3.EN", "C1.1"])
  connect("3V3", ["U3.VOUT", "C2.1", "C3.1", "U1.3V3", "R3.1", "R4.1", "R5.1", "R6.1", "U2.VDD", "U2.VDDIO", "U2.CSB", "C4.1"])
  connect("CC1", ["J1.CC1", "R1.1"])
  connect("CC2", ["J1.CC2", "R2.1"])
  connect("USB_DP", ["J1.A6", "J1.B6", "U1.IO19"])
  connect("USB_DM", ["J1.A7", "J1.B7", "U1.IO18"])
  connect("EN", ["U1.EN", "R3.2", "C5.1", "SW1.1"])
  connect("BOOT", ["U1.IO9", "R4.2", "SW2.1"])
  connect("SDA", ["U1.IO4", "U2.SDI", "R5.2"])
  connect("SCL", ["U1.IO5", "U2.SCK", "R6.2"])
  connect("LED_IO", ["U1.IO6", "R7.1"])
  connect("LED_A", ["R7.2", "D1.A"])
  connect("GND", ["D1.K"])
}

/** The five blocks, named as in the first request ("USB-C INPUT") or the Clean up plan ("USB INPUT"). */
export const BLOCKS = (usb = "USB-C INPUT"): [string, string[]][] => [
  [usb, ["J1", "R1", "R2"]],
  ["3.3V POWER", ["U3", "C1", "C2"]],
  ["MCU", ["U1", "C3", "C5", "R3", "R4", "SW1", "SW2"]],
  ["SENSOR", ["U2", "C4", "R5", "R6"]],
  ["STATUS LED", ["D1", "R7"]],
]

export function group(s: Session, usb = "USB-C INPUT") {
  for (const [block, refs] of BLOCKS(usb)) s.must("group_parts", { block, refs })
}

/** The first request's schematic: built and grouped, as the sheet stood when Sakura first tried to tidy it. */
export function firstRequest(opts: { j1Rot?: number } = {}): Session {
  const s = new Session()
  buildDesign(s, opts)
  group(s)
  return s
}

/** The first request's parts and nets where add_component puts them (or `at`), each net drawn by `connect` with labels, no blocks. */
export function firstDrawn(opts: { j1Rot?: number; at?: At } = {}): Session {
  const s = new Session()
  buildDesign(s, { ...opts, spread: false })
  return s
}
