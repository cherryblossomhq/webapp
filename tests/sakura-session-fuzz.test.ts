import { expect, it } from "vitest"
import { findPart } from "../src/model/library"
import { schematicPins } from "../src/model/instances"
import type { Project } from "../src/model/types"
import { netlist, netlistDiff, Session, U1_PART, U2_PART } from "./sakura-session"
import { comb, portOnPin, teeToPort } from "./tidy-shapes"

// The Sakura session from random starting layouts (part spots and turns, J1 included), every
// connect call of it in order, then U2 drawn the way Tidy draws a part's supplies, and then
// moves of U2 (to (30, -30) as in the log, back to (-8, -2), and to random spots). The oracle:
//
//   - no connect call moves a pin to another net, puts a pin on a net it was not named for, or cuts one loose;
//   - every move of U2 either leaves the netlist pin for pin the same, or is refused and changes nothing.
//
// SEEDS=40 for more.

const rng = (seed: number) => () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff
  return seed / 0x7fffffff
}

const ESP_GND = ["1", "2", "11", "14", ...Array.from({ length: 13 }, (_, i) => String(36 + i)), "49", "50", "51", "52", "53"]
const NETS: [string, string[]][] = [
  ["GND", [...ESP_GND.map((n) => `U1.${n}`), "U2.1", "U2.7", "U2.SDO", "U3.GND", "J1.A1", "J1.B1", "J1.SHIELD", "R1.2", "R2.2", "C1.2", "C2.2", "C3.2", "C4.2", "C5.2", "SW1.2", "SW2.2"]],
  ["VBUS", ["J1.A4", "J1.B4", "U3.VIN", "U3.EN", "C1.1"]],
  ["3V3", ["U3.VOUT", "C2.1", "C3.1", "U1.3V3", "R3.1", "R4.1", "R5.1", "R6.1", "U2.VDD", "U2.VDDIO", "U2.CSB", "C4.1"]],
  ["CC1", ["J1.CC1", "R1.1"]],
  ["CC2", ["J1.CC2", "R2.1"]],
  ["USB_DP", ["J1.A6", "J1.B6", "U1.IO19"]],
  ["USB_DM", ["J1.A7", "J1.B7", "U1.IO18"]],
  ["EN", ["U1.EN", "R3.2", "C5.1", "SW1.1"]],
  ["BOOT", ["U1.IO9", "R4.2", "SW2.1"]],
  ["SDA", ["U1.IO4", "U2.SDI", "R5.2"]],
  ["SCL", ["U1.IO5", "U2.SCK", "R6.2"]],
  ["LED_IO", ["U1.IO6", "R7.1"]],
  ["LED_A", ["R7.2", "D1.A"]],
  ["GND", ["D1.K"]],
]

it("keeps every pin's net through the session's tool calls, from random layouts", () => {
  const seeds = Number(process.env.SEEDS ?? 10)
  const broken: string[] = []
  let total = 0
  let styled = 0
  for (let seed = 1; seed <= seeds; seed++) {
    const r = rng(seed)
    const s = new Session()
    s.must("set_board", { width: 40, height: 30 })
    const parts: [string, string][] = [
      [U1_PART, "U1"], [U2_PART, "U2"], ["ap2112k_3v3", "U3"], ["usb_c", "J1"], ["pushbutton_smd", "SW1"], ["pushbutton_smd", "SW2"], ["led", "D1"],
      ...["R1", "R2", "R3", "R4", "R5", "R6", "R7"].map((x): [string, string] => ["resistor", x]),
      ...["C1", "C2", "C3", "C4", "C5"].map((x): [string, string] => ["capacitor", x]),
    ]
    for (const [part_id, ref] of parts) {
      const at = { x: Math.round(r() * 300) / 10 - 15, y: Math.round(r() * 200) / 10 - 10, rotation: [0, 90, 180, 270][Math.floor(r() * 4)] }
      if (s.run("add_component", { part_id, ref, ...at }).isError) s.must("add_component", { part_id, ref })
    }
    /** "U1.IO19" to "U1.27": the netlist's keys are pin numbers. */
    const keys = (pins: string[]) =>
      pins.map((spec) => {
        const [ref, pin] = spec.split(".")
        const def = findPart(s.ref(ref).partId)!
        const named = def.pins.filter((p) => p.number === pin || p.name === pin)
        return named.map((p) => `${ref}.${p.number}`)
      }).flat()
    const step = (what: string, f: () => { summary: string }, named: string[] = []) => {
      const before = netlist(s.project)
      const out = f()
      for (const [k, a] of netlist(s.project)) {
        const was = before.get(k) ?? null
        if (was === a || named.includes(k)) continue
        broken.push(`seed ${seed}, ${what}: ${k} ${was} -> ${a} (${out.summary})`)
      }
    }
    for (const [net, pins] of NETS) step(`connect ${net}`, () => s.run("connect", { pins, net_name: net }), keys(pins))
    // U2's supplies as Tidy draws them, each in a shape chosen at random.
    const before = netlist(s.project)
    const before0 = s.project
    let p: Project = s.project
    const pin = (n: string) => schematicPins(p.components.find((c) => c.ref === "U2")!).find((q) => q.pin === n)!
    const draw = (f: () => Project | null) => {
      const next = f()
      if (next) p = next
    }
    const style = (nums: string[], net: string) => {
      const how = r()
      if (how < 0.35 && nums.length > 1) draw(() => comb(p, nums.map(pin), net))
      else if (how < 0.7) for (const n of nums) draw(() => portOnPin(p, pin(n), net))
      else if (how < 0.9) for (const n of nums) draw(() => teeToPort(p, pin(n), net))
    }
    style(["1", "7"], "GND")
    style(["5"], "GND")
    style(["6", "8"], "3V3")
    style(["2"], "3V3")
    // A shape that landed on another net's drawing is not what Tidy would draw; keep the plain sheet then.
    if (netlistDiff(before, netlist(p)).length === 0) {
      s.project = p
      s.start = p
      if (p !== before0) styled++
    }
    let moves = 0
    const move = (x: number, y: number) => {
      const was = s.project
      const names = netlist(was)
      const out = s.run("update_component", { ref: "U2", x, y })
      if (out.isError) {
        if (out.project !== was) broken.push(`seed ${seed}, move U2 to (${x}, ${y}): refused but changed the project`)
        return
      }
      moves++
      const diff = netlistDiff(names, netlist(s.project))
      if (diff.length) broken.push(`seed ${seed}, move U2 to (${x}, ${y}): ${diff.join("; ")} (${out.summary})`)
    }
    move(30, -30)
    move(-8, -2)
    for (let i = 0; i < 4; i++) move(Math.round(r() * 600) / 10 - 20, Math.round(r() * 400) / 10 - 30)
    total += moves
  }
  // Moves are not all refused: the fuzz would prove nothing if every one were.
  expect(styled).toBeGreaterThan(seeds / 2)
  expect(total).toBeGreaterThan(seeds)
  expect(broken.filter((b) => !b.includes("move U2"))).toEqual([])
  expect(broken.filter((b) => b.includes("move U2"))).toEqual([])
})
