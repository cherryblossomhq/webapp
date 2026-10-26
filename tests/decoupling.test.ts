import { describe, expect, it } from "vitest"
import { parseFarads, parseValue } from "../src/lib/values"
import { computeConnectivity } from "../src/model/connectivity"
import { decouplingGaps, decouplingPairs, padGap } from "../src/model/decoupling"
import { EXAMPLES } from "../src/model/examples"
import { addComponent, autoPlacePcb, createProject, labelPin, repackPcb, resolvePinSpec, updateComponent } from "../src/model/ops"
import { analyzePcb } from "../src/model/pcb"
import type { Project } from "../src/model/types"

const example = (id: string) => EXAMPLES.find((e) => e.id === id)!.project

/** "C4 -> U2 VBAT 13,14,24" for each pair, by capacitor. */
function described(p: Project): string[] {
  const ref = new Map(p.components.map((c) => [c.id, c.ref]))
  return decouplingPairs(p)
    .map((x) => `${ref.get(x.capId)} -> ${ref.get(x.chipId)} ${x.netName} ${x.supplyPins.join(",")}`)
    .sort()
}

/** A small schematic: parts at schematic positions, nets by label. */
function sheet() {
  let project = createProject("t")
  return {
    add(partId: string, x: number, y: number, props?: Record<string, string>) {
      const r = addComponent(project, partId, { sch: { x, y, rot: 0 }, props })
      project = r.project
      return r.component.ref
    },
    net(name: string, ...pins: string[]) {
      for (const spec of pins) project = labelPin(project, resolvePinSpec(project, spec)!, name)
    },
    get project() {
      return project
    },
  }
}

describe("decoupling pairs", () => {
  // Written down by hand from the schematics: every 10 nF to 1 uF capacitor between a chip's
  // supply and ground, and the chip it was drawn beside.
  it.each([
    ["esp32-robot", ["C4 -> U2 VBAT 13,14,24"]],
    ["node", ["C3 -> U2 5V 3", "C6 -> U1 5V 4,6,18", "C7 -> U1 5V 4,6,18", "C9 -> U3 5V 16"]],
    ["blinker", ["C3 -> U1 VCC 8"]],
    ["regulator", ["C3 -> U1 3V3 2"]],
    ["mcu", ["C3 -> U1 5V 4,6,18", "C4 -> U1 5V 4,6,18"]],
  ])("pairs %s's capacitors with their chips", (id, pairs) => {
    expect(described(example(id))).toEqual(pairs)
  })

  it("leaves bulk, crystal, timing and coupling capacitors alone", () => {
    const refs = (id: string) => {
      const p = example(id)
      const paired = new Set(decouplingPairs(p).map((x) => x.capId))
      return p.components.filter((c) => c.ref.startsWith("C") && !paired.has(c.id)).map((c) => c.ref).sort()
    }
    // 100 uF and 10 uF bulk.
    expect(refs("esp32-robot")).toEqual(["C1", "C2", "C3"])
    // 47 uF and 10 uF bulk, 22 pF crystal loads, and C8, the DTR auto-reset capacitor with no ground leg.
    expect(refs("node")).toEqual(["C1", "C2", "C4", "C5", "C8"])
    // 10 uF timing and the 10 nF on the 555's control voltage, which is not a supply.
    expect(refs("blinker")).toEqual(["C1", "C2"])
    expect(refs("regulator")).toEqual(["C1", "C2"])
    expect(refs("mcu")).toEqual(["C1", "C2"])
  })

  it("gives a capacitor on a shared supply to the chip drawn beside it", () => {
    const s = sheet()
    s.add("ne555", 0, 0)
    s.add("ne555", 10, 0)
    s.add("capacitor", 9, 2, { capacitance: "100nF" })
    s.add("capacitor", 1, 2, { capacitance: "0.1uF" })
    s.net("5V", "U1.VCC", "U2.VCC", "C1.1", "C2.1")
    s.net("GND", "U1.GND", "U2.GND", "C1.2", "C2.2")
    expect(described(s.project)).toEqual(["C1 -> U2 5V 8", "C2 -> U1 5V 8"])
  })

  it("serves a regulator's input and output but not its enable pin", () => {
    const s = sheet()
    s.add("ap2112k_3v3", 0, 0)
    s.add("capacitor", -2, 0, { capacitance: "1uF" })
    s.add("capacitor", 2, 0, { capacitance: "1uF" })
    s.add("capacitor", -2, -2, { capacitance: "100nF" })
    s.net("5V", "U1.VIN", "C1.1")
    s.net("3V3", "U1.VOUT", "C2.1")
    s.net("EN", "U1.EN", "C3.1")
    s.net("GND", "U1.GND", "C1.2", "C2.2", "C3.2")
    expect(described(s.project)).toEqual(["C1 -> U1 5V 1", "C2 -> U1 3V3 5"])
  })

  it("skips dev boards, which carry their own decoupling", () => {
    const s = sheet()
    s.add("esp32_devkit_v1", 0, 0)
    s.add("capacitor", 3, 0, { capacitance: "100nF" })
    s.net("3V3", "U1.3V3", "C1.1")
    s.net("GND", "U1.2", "C1.2")
    expect(decouplingPairs(s.project)).toEqual([])
  })

  it("counts 10 nF to 1 uF and nothing else", () => {
    const s = sheet()
    s.add("ne555", 0, 0)
    const values = ["10nF", "100n", "0.1uF", "1uF", "1u", "4.7nF", "2.2uF", "22pF", "", "big"]
    values.forEach((v, i) => s.add("capacitor", 3 + i * 3, 3, { capacitance: v }))
    s.net("5V", "U1.VCC", ...values.map((_, i) => `C${i + 1}.1`))
    s.net("GND", "U1.GND", ...values.map((_, i) => `C${i + 1}.2`))
    expect(described(s.project).map((x) => x.split(" ")[0])).toEqual(["C1", "C2", "C3", "C4", "C5"])
  })

  it("needs a ground leg", () => {
    const s = sheet()
    s.add("ne555", 0, 0)
    s.add("capacitor", 2, 2, { capacitance: "100nF" })
    s.net("5V", "U1.VCC", "C1.1")
    s.net("3V3", "C1.2")
    s.net("GND", "U1.GND")
    expect(decouplingPairs(s.project)).toEqual([])
  })
})

describe("decoupling gaps", () => {
  it("measures pad edge to pad edge", () => {
    const rect = (x: number, width: number) => ({ shape: "rect" as const, x, y: 0, width, height: 1 })
    expect(padGap(rect(0, 1), rect(2, 1))).toBeCloseTo(1)
    expect(padGap(rect(0, 1), rect(0.5, 1))).toBe(0)
    expect(padGap({ shape: "circle", x: 0, y: 0, width: 2, height: 2 }, rect(3, 1))).toBeCloseTo(1.5)
    expect(padGap({ shape: "circle", x: 0, y: 0, width: 2, height: 2 }, { shape: "circle", x: 0, y: 4, width: 1, height: 1 })).toBeCloseTo(2.5)
  })

  it("measures the shipped examples as they were placed by hand", () => {
    const gaps = EXAMPLES.flatMap((e) => decouplingGaps(e.project).map((g) => `${e.id} ${g.cap.ref} ${g.pin} ${g.gap.toFixed(2)}`))
    expect(gaps.sort()).toEqual([
      "blinker C3 8 1.38",
      "esp32-robot C4 24 7.13",
      "mcu C3 4 2.80",
      "mcu C4 18 2.18",
      "node C3 3 5.49",
      "node C6 4 3.70",
      "node C7 18 1.85",
      "node C9 16 1.44",
      "regulator C3 2 3.87",
    ])
  })

  it("warns about a capacitor more than 3 mm from its pin in the checks", () => {
    const messages = (id: string) => {
      const p = example(id)
      return analyzePcb(p, computeConnectivity(p)).violations.filter((v) => v.kind === "decoupling").map((v) => `${v.severity}: ${v.message}`)
    }
    // 2.8 mm and 2.2 mm are reasonable placements and are left alone.
    expect(messages("mcu")).toEqual([])
    expect(messages("blinker")).toEqual([])
    expect(messages("esp32-robot")).toEqual(["warning: C4 is 7.1 mm from U2 pin 24 (VM1); aim for under 3 mm"])
    expect(messages("regulator")).toEqual(["warning: C3 is 3.9 mm from U1 pin 2 (VOUT); aim for under 3 mm"])
    expect(messages("node")).toEqual([
      "warning: C3 is 5.5 mm from U2 pin 3 (OUT); aim for under 3 mm",
      "warning: C6 is 3.7 mm from U1 pin 4 (VCC); aim for under 3 mm",
    ])
  })
})

/** An LM7805 and an ATmega328P on one 5 V rail, each with a 100 nF capacitor drawn beside it, placed on the board. */
function twoChipRail() {
  const s = sheet()
  s.add("lm7805", 0, 0)
  s.add("atmega328p", 30, 0)
  s.add("capacitor", 4, 3, { capacitance: "100nF" })
  s.add("capacitor", 34, 3, { capacitance: "100nF" })
  s.net("5V", "U1.OUT", "U2.4", "U2.6", "U2.18", "C1.1", "C2.1")
  s.net("GND", "U1.GND", "U2.3", "U2.5", "U2.21", "C1.2", "C2.2")
  const placed = autoPlacePcb(s.project)
  const ref = (p: Project, r: string) => p.components.find((c) => c.ref === r)!
  const swapped = updateComponent(updateComponent(placed, ref(placed, "C1").id, { sch: { x: 34, y: 3 } }), ref(placed, "C2").id, { sch: { x: 4, y: 3 } })
  return { placed, swapped, ref }
}

const decouplingWarnings = (p: Project) => analyzePcb(p, computeConnectivity(p)).violations.filter((v) => v.kind === "decoupling").map((v) => v.message)

describe("capacitors on a rail shared by two chips", () => {
  it("is placed at each chip's pin", () => {
    const { placed } = twoChipRail()
    expect(decouplingGaps(placed).map((g) => `${g.cap.ref} ${g.chip.ref} ${g.gap < 2}`).sort()).toEqual(["C1 U1 true", "C2 U2 true"])
    expect(decouplingWarnings(placed)).toEqual([])
  })

  it("is not reported when drawn beside the other chip but sitting at its own pin on the board", () => {
    // Swapping the capacitors' schematic positions, without touching the board, said "C1 is 5.6 mm
    // from U2 pin 6" and "C2 is 18.0 mm from U1 pin 3 (OUT)" although both sit at a supply pin.
    const { swapped } = twoChipRail()
    expect(decouplingWarnings(swapped)).toEqual([])
    const pairs = decouplingPairs(swapped).map((x) => `${swapped.components.find((c) => c.id === x.capId)!.ref} -> ${swapped.components.find((c) => c.id === x.chipId)!.ref}`)
    expect(pairs.sort()).toEqual(["C1 -> U1", "C2 -> U2"])
  })

  it("is reported when it is far from every chip on its rail", () => {
    const { placed, ref } = twoChipRail()
    const c1 = ref(placed, "C1")
    const far = updateComponent(placed, c1.id, { pcb: { x: c1.pcb.x + 25, y: c1.pcb.y + 25 } })
    const warnings = decouplingWarnings(far)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/^C1 is \d+\.\d mm from U1 pin 3 \(OUT\)/)
  })

  it("stays at its own chip when the board is re-packed", () => {
    const { swapped } = twoChipRail()
    const packed = repackPcb(swapped)
    expect(decouplingWarnings(packed)).toEqual([])
    const gaps = decouplingGaps(packed)
    expect(gaps.map((g) => `${g.cap.ref} ${g.chip.ref}`).sort()).toEqual(["C1 U1", "C2 U2"])
    for (const g of gaps) expect(g.gap).toBeLessThanOrEqual(2)
  })
})

describe("bare RF modules", () => {
  it("get a capacitor at their supply pin, unlike dev boards", () => {
    const s = sheet()
    s.add("esp32_wroom_32e", 0, 0)
    s.add("capacitor", 3, 0, { capacitance: "100nF" })
    s.net("3V3", "U1.3V3", "C1.1")
    s.net("GND", "U1.GND", "C1.2")
    expect(described(s.project)).toEqual(["C1 -> U1 3V3 2"])
  })
})

describe("value parsing", () => {
  it("reads capacitances in farads", () => {
    expect(parseValue("100nF")).toBeCloseTo(1e-7, 15)
    expect(parseValue("4u7")).toBeCloseTo(4.7e-6, 15)
    expect(parseValue("22pF")).toBeCloseTo(2.2e-11, 20)
    expect(parseValue("0.1uF")).toBeCloseTo(1e-7, 15)
    expect(parseValue("decoupling")).toBeNull()
  })

  it.each([
    ["100nF", 1e-7],
    ["100NF", 1e-7],
    ["100n", 1e-7],
    ["0.1uF", 1e-7],
    ["0,1uF", 1e-7],
    ["0.1 uF", 1e-7],
    ["4u7", 4.7e-6],
    ["4n7F", 4.7e-9],
    ["22pF", 2.2e-11],
    ["1uF", 1e-6],
    // The 3-digit code: two digits and a power of ten, in pF.
    ["104", 1e-7],
    ["103", 1e-8],
    ["474", 4.7e-7],
    ["105", 1e-6],
    // A rating or a dielectric after the value.
    ["100nF 50V", 1e-7],
    ["100nF/16V", 1e-7],
    ["100nF X7R", 1e-7],
    ["100nF 10%", 1e-7],
    ["100 nF  25V", 1e-7],
  ])("reads a capacitor written %j", (text, farads) => {
    expect(parseFarads(text)).toBeCloseTo(farads, 15)
  })

  it("leaves what is not a capacitance alone", () => {
    expect(parseFarads("")).toBeNull()
    expect(parseFarads(undefined)).toBeNull()
    expect(parseFarads("decoupling")).toBeNull()
    expect(parseFarads("X7R")).toBeNull()
  })

  it("counts all of them as decoupling capacitors", () => {
    const s = sheet()
    s.add("ne555", 0, 0)
    const values = ["104", "100NF", "100nF 50V", "100nF/16V", "0,1uF", "100nF X7R", "22pF", "105", "106"]
    values.forEach((v, i) => s.add("capacitor", 3 + i * 3, 3, { capacitance: v }))
    s.net("5V", "U1.VCC", ...values.map((_, i) => `C${i + 1}.1`))
    s.net("GND", "U1.GND", ...values.map((_, i) => `C${i + 1}.2`))
    // 22 pF is a crystal load, and 10 uF (106) is bulk.
    expect(described(s.project).map((x) => x.split(" ")[0])).toEqual(["C1", "C2", "C3", "C4", "C5", "C6", "C8"])
  })
})
