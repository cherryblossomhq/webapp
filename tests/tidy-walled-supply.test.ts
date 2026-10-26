import { describe, expect, it } from "vitest"
import { tidySchematic } from "../src/model/tidy"
import type { Project } from "../src/model/types"
import { netlist, netlistDiff, Session } from "./sakura-session"
import { frameProblems, offGrid, overlaps, pinsOnWires, wireProblems } from "./tidy-metrics"

// A supply the block wires (one decoupling capacitor of its own) used to be drawn as one wire
// joining all of a chip's pins on it. Where a supply pin sits below or between signal pins on a side
// (the BME280's CSB tied to 3V3 under SDI and SCK), that wire goes round the side and walls the
// signal pins in: their labels can only run straight out, so the chip had no spot and the whole
// sheet was refused. Now the cluster is drawn with a port at each of that supply's pins instead
// (`supplyDrops` in tidy/clusters.ts). These are such symbols, each tidied whole and on its own.

type Side = "left" | "right" | "top" | "bottom"
/** A chip's pins in order, side by side: a name, and the net it goes to ("3V3", "GND" or a signal). */
type Pin = [name: string, side: Side, net: string]

/** A chip of these pins with a capacitor on each supply, its signals going to a header in another block. */
function sheet(pins: Pin[], footprint: string, caps = ["3V3"]): Project {
  const s = new Session()
  const made = s.must("create_part", {
    name: "ADV-CHIP",
    description: "Adversarial test chip",
    category: "ICs",
    footprint,
    pins: [...pins.map(([name, side, net], i) => ({ number: String(i + 1), name, kind: net === "GND" ? "ground" : net === "3V3" && /^V/.test(name) ? "power" : "io", side }))],
  })
  s.must("add_component", { part_id: /part_id "([^"]+)"/.exec(made.result)![1], ref: "U1" })
  const signals = [...new Set(pins.map((p) => p[2]).filter((n) => n !== "3V3" && n !== "GND"))]
  // Headers of up to ten pins, in another block, so every signal leaves the chip's block.
  const headers = Math.ceil(signals.length / 10)
  for (let h = 0; h < headers; h++) s.must("add_component", { part_id: "header_1x10", ref: `J${h + 1}` })
  caps.forEach((_, i) => s.must("add_component", { part_id: "capacitor", ref: `C${i + 1}`, props: { capacitance: "100nF" } }))
  const by = new Map<string, string[]>()
  pins.forEach(([, , net], i) => by.set(net, [...(by.get(net) ?? []), `U1.${i + 1}`]))
  signals.forEach((n, i) => by.set(n, [...by.get(n)!, `J${Math.floor(i / 10) + 1}.${(i % 10) + 1}`]))
  caps.forEach((rail, i) => {
    by.set(rail, [...(by.get(rail) ?? []), `C${i + 1}.1`])
    by.set("GND", [...(by.get("GND") ?? []), `C${i + 1}.2`])
  })
  for (const [net, list] of by) s.must("connect", { pins: list, net_name: net })
  s.must("group_parts", { block: "CHIP", refs: ["U1", ...caps.map((_, i) => `C${i + 1}`)] })
  s.must("group_parts", { block: "HEADER", refs: Array.from({ length: headers }, (_, h) => `J${h + 1}`) })
  return s.project
}

function clean(p: Project) {
  const w = wireProblems(p)
  return { overlaps: overlaps(p), crossings: w.crossings, through: w.through, pinsOnWires: pinsOnWires(p), grid: offGrid(p), frames: frameProblems(p) }
}

const NONE = { overlaps: [], crossings: [], through: [], pinsOnWires: [], grid: [], frames: [] }

function holds(before: Project) {
  const r = tidySchematic(before)
  expect(r.problems).toEqual([])
  expect(r.ok).toBe(true)
  expect(r.kept).toEqual([])
  expect(netlistDiff(netlist(before), netlist(r.project))).toEqual([])
  expect(clean(r.project)).toEqual(NONE)
  const again = tidySchematic(r.project)
  expect(again.changed).toBe(false)
  for (const b of before.blocks ?? []) {
    const one = tidySchematic(before, { blockId: b.id })
    expect(one.problems).toEqual([])
    expect(one.ok).toBe(true)
    expect(netlistDiff(netlist(before), netlist(one.project))).toEqual([])
  }
}

const sides: Side[] = ["left", "right", "top", "bottom"]

describe("Tidy draws a chip whose wired supply would wall its pins in", () => {
  it("the BME280's way: a chip select on the rail below the bus pins", () => {
    holds(
      sheet(
        [["GND", "bottom", "GND"], ["CSB", "right", "3V3"], ["SDI", "right", "SDA"], ["SCK", "right", "SCL"], ["SDO", "right", "GND"], ["VDDIO", "top", "3V3"], ["GND", "bottom", "GND"], ["VDD", "top", "3V3"]],
        "soic8",
      ),
    )
  })

  for (const side of sides) {
    for (const at of [0, 1, 2]) {
      it(`a supply pin ${["first", "between signals", "last"][at]} on the ${side}, with the supply's own pin on top`, () => {
        const run: Pin[] = [["A", side, "SIG_A"], ["B", side, "SIG_B"]]
        run.splice(at, 0, ["CS", side, "3V3"])
        holds(sheet([...run, ["VDD", side === "top" ? "left" : "top", "3V3"], ["GND", side === "bottom" ? "left" : "bottom", "GND"], ["X", side === "left" ? "right" : "left", "SIG_X"], ["Y", side === "left" ? "right" : "left", "SIG_Y"], ["Z", side === "left" ? "right" : "left", "SIG_Z"]], "soic8"))
      })
    }
  }

  it("supply and ground pins between signal pins on every side", () => {
    const pins: Pin[] = []
    for (const side of sides) pins.push([`${side[0].toUpperCase()}1`, side, `${side.toUpperCase()}_1`], ["VDD", side, "3V3"], [`${side[0].toUpperCase()}2`, side, `${side.toUpperCase()}_2`], ["GND", side, "GND"])
    holds(sheet(pins, "soic16"))
  })

  it("three supply pins on one side, between signals", () => {
    holds(
      sheet(
        [["VDD", "right", "3V3"], ["A", "right", "SIG_A"], ["VDD", "right", "3V3"], ["B", "right", "SIG_B"], ["VDD", "right", "3V3"], ["C", "left", "SIG_C"], ["D", "left", "SIG_D"], ["GND", "bottom", "GND"]],
        "soic8",
      ),
    )
  })

  it("an SPI flash with write protect and hold tied to the rail, two capacitors on it", () => {
    holds(
      sheet(
        [["/CS", "left", "FLASH_CS"], ["DO", "left", "MISO"], ["/WP", "left", "3V3"], ["GND", "left", "GND"], ["DI", "right", "MOSI"], ["CLK", "right", "SCK"], ["/HOLD", "right", "3V3"], ["VCC", "right", "3V3"]],
        "soic8",
        ["3V3", "3V3"],
      ),
    )
  })

  it("chip selects on the rail on both sides of a twenty-pin chip", () => {
    const pins: Pin[] = []
    for (let i = 0; i < 8; i++) pins.push([`P${i}`, "left", i % 3 === 1 ? "3V3" : `L_${i}`])
    for (let i = 0; i < 8; i++) pins.push([`Q${i}`, "right", i % 3 === 2 ? "3V3" : `R_${i}`])
    pins.push(["VDD", "top", "3V3"], ["VDDA", "top", "3V3"], ["GND", "bottom", "GND"], ["AGND", "bottom", "GND"])
    holds(sheet(pins, "tssop20_p0.65mm"))
  })
})
