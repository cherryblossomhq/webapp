import { describe, expect, it } from "vitest"
import { groupLooseParts } from "../src/model/cleanup/group"
import { customPartId, registerProjectParts } from "../src/model/customParts"
import { addComponent, createProject, labelPin } from "../src/model/ops"
import type { CustomPartSpec, Project } from "../src/model/types"
import { rng } from "./tidy-designs"

// Supply capacitors on sheets nobody tidied: parts 5 to 15 units apart with jitter, in an order a
// seed shuffles, so that the nearest chip is often the wrong one. Five kinds of sheet, 24 seeds each.
// What belongs with what is known from how each was built: a regulator keeps the capacitors on its
// input and output (behind its inductor for a switcher), a header keeps its pull-ups, and a USB
// connector with no regulator on VBUS keeps its VBUS capacitors.

const spec = (name: string, footprint: string, pins: string[]): CustomPartSpec => {
  const base = { name, description: name, category: "ICs" as const, refPrefix: "U", footprint, pins: pins.map((n, i) => ({ number: String(i + 1), name: n })), props: {} }
  return { ...base, id: customPartId(base) }
}
/** Regulators brought in as ICs: one the name gives away, one only its pins do. */
const LDO_NAMED = spec("TPS7A0233", "sot23_5", ["IN", "GND", "EN", "NC", "OUT"])
const LDO_PINS = spec("XQ9100", "sot23_5", ["VIN", "GND", "EN", "NC", "VOUT"])
const BUCK_PINS = spec("XQ5000", "sot23_6", ["BOOT", "VIN", "EN", "FB", "GND", "SW"])
/** Small generic chips: a 6-pin DAC and a 5-pin op-amp. They are real chips and keep their own capacitors. */
const DAC = spec("MCP4725", "sot23_6", ["VOUT", "VSS", "VDD", "SCL", "SDA", "A0"])
const OPAMP = spec("TLV9061", "sot23_5", ["OUT", "V-", "IN+", "IN-", "V+"])
registerProjectParts({ parts: [LDO_NAMED, LDO_PINS, BUCK_PINS, DAC, OPAMP] })

type Pin = [string, string]

class Sheet {
  project: Project
  readonly r: ReturnType<typeof rng>
  private ids = new Map<string, string>()
  private queue: { key: string; partId: string; props: Record<string, string>; near?: string }[] = []
  /** Range of the gap between neighbours in the row. */
  gap: [number, number] = [5, 15]
  private nets: [string, string, string][] = []
  constructor(seed: number) {
    this.r = rng(seed)
    this.project = createProject(`supply ${seed}`)
  }
  /** `near` puts the part 3 to 6 units from another, whatever the row says. */
  part(key: string, partId: string, props: Record<string, string> = {}, near?: string) {
    this.queue.push({ key, partId, props, near })
  }
  net(name: string, ...pins: Pin[]) {
    for (const [key, pin] of pins) this.nets.push([key, pin, name])
  }
  /** Place everything in a shuffled row, 5 to 15 units apart with a little jitter, and name the nets. */
  build() {
    const order = this.queue.filter((q) => !q.near)
    for (let i = order.length - 1; i > 0; i--) {
      const j = this.r.int(i + 1)
      ;[order[i], order[j]] = [order[j], order[i]]
    }
    let x = 0
    for (const q of order) {
      x += this.gap[0] + this.r.next() * (this.gap[1] - this.gap[0])
      const y = Math.round((this.r.next() * 4 - 2) * 10) / 10
      const res = addComponent(this.project, q.partId, { sch: { x: Math.round(x * 10) / 10, y, rot: 0 }, props: q.props })
      this.project = res.project
      this.ids.set(q.key, res.component.id)
    }
    for (const q of this.queue.filter((q) => q.near)) {
      const at = this.project.components.find((c) => c.id === this.ids.get(q.near!))!.sch
      const angle = this.r.next() * Math.PI * 2
      const d = 3 + this.r.next() * 3
      const sch = { x: Math.round((at.x + Math.cos(angle) * d) * 10) / 10, y: Math.round((at.y + Math.sin(angle) * d) * 10) / 10, rot: 0 as const }
      const res = addComponent(this.project, q.partId, { sch, props: q.props })
      this.project = res.project
      this.ids.set(q.key, res.component.id)
    }
    for (const [key, pin, name] of this.nets) this.project = labelPin(this.project, { componentId: this.ids.get(key)!, pin }, name)
    return this
  }
  members(...keys: string[]) {
    return keys.map((k) => this.ids.get(k)!).sort()
  }
  /** What the grouping put with the main part `key`. */
  group(key: string) {
    return groupLooseParts(this.project).groups.find((g) => g.main === this.ids.get(key))?.parts.slice().sort()
  }
}

const caps = (s: Sheet, prefix: string, count: number, net: string, values: string[], near?: string) => {
  const keys: string[] = []
  for (let i = 0; i < count; i++) {
    const key = `${prefix}${i}`
    s.part(key, "capacitor", { capacitance: values[i % values.length] }, near)
    s.net(net, [key, "1"])
    s.net("GND", [key, "2"])
    keys.push(key)
  }
  return keys
}

/** An I2C header on `rail` with pull-ups; returns the keys that belong to it. */
function header(s: Sheet, rail: string) {
  s.part("i2c", "qwiic")
  s.part("ru", "resistor", { resistance: "4.7k" })
  s.part("rl", "resistor", { resistance: "4.7k" })
  s.net("GND", ["i2c", "1"])
  s.net(rail, ["i2c", "2"], ["ru", "1"], ["rl", "1"])
  s.net("SDA", ["i2c", "3"], ["ru", "2"])
  s.net("SCL", ["i2c", "4"], ["rl", "2"])
  return ["i2c", "ru", "rl"]
}

/** A regulator from `vin` to `vout`, with an input capacitor and 2 to 3 on its output. */
function regulator(s: Sheet, key: string, partId: string, pins: { in: string; out: string; gnd: string }, vin: string, vout: string) {
  s.part(key, partId)
  s.net(vin, [key, pins.in])
  s.net(vout, [key, pins.out])
  s.net("GND", [key, pins.gnd])
  const input = caps(s, `${key}in`, 1, vin, ["10uF"])
  const output = caps(s, `${key}out`, 2 + s.r.int(2), vout, ["100nF", "10uF", "100nF"])
  return [key, ...input, ...output]
}

const POWER_LDO = { in: "3", out: "2", gnd: "1" }
const LM7805 = { in: "1", out: "3", gnd: "2" }
const IC_LDO = { in: "1", out: "5", gnd: "2" }

/** A USB-C connector with 2 to 4 capacitors on VBUS and its two CC resistors. */
function usb(s: Sheet) {
  s.part("usb", "usb_c")
  s.net("VBUS", ["usb", "A4"])
  s.net("GND", ["usb", "A1"])
  const vbus = caps(s, "cv", 2 + s.r.int(3), "VBUS", ["100nF", "10uF"])
  const cc = ["rcc1", "rcc2"]
  cc.forEach((key, i) => {
    s.part(key, "resistor", { resistance: "5.1k" })
    s.net(`CC${i + 1}`, [key, "1"], ["usb", i ? "B5" : "A5"])
    s.net("GND", [key, "2"])
  })
  return ["usb", ...vbus, ...cc]
}

/** A buck with its inductor, boot capacitor and feedback divider, input capacitors on `vin` and output capacitors on `vout`. */
function buck(s: Sheet, vin: string, vout: string) {
  s.part("buck", BUCK_PINS.id)
  s.part("coil", "inductor", { inductance: "10uH" })
  s.net(vin, ["buck", "2"])
  s.net("GND", ["buck", "5"])
  s.net("SW", ["buck", "6"], ["coil", "1"])
  s.net(vout, ["coil", "2"])
  const input = caps(s, "ci", 1 + s.r.int(2), vin, ["10uF"])
  const output = caps(s, "co", 2 + s.r.int(2), vout, ["22uF", "100nF"])
  s.part("boot", "capacitor", { capacitance: "100nF" })
  s.net("BOOT", ["boot", "1"], ["buck", "1"])
  s.net("SW", ["boot", "2"])
  s.part("rt", "resistor", { resistance: "100k" })
  s.part("rb", "resistor", { resistance: "22k" })
  s.net(vout, ["rt", "1"])
  s.net("FB", ["rt", "2"], ["rb", "1"], ["buck", "4"])
  s.net("GND", ["rb", "2"])
  return ["buck", "coil", ...input, ...output, "boot", "rt", "rb"]
}

interface Variant {
  name: string
  /** The sheet and, for each main part, what belongs with it. */
  make: (seed: number) => { sheet: Sheet; expected: Record<string, string[]> }
}

const VARIANTS: Variant[] = [
  {
    name: "two LDOs in the Power category and an I2C header",
    make: (seed) => {
      const s = new Sheet(seed)
      const a = regulator(s, "u1", "ams1117_3v3", POWER_LDO, "5V", "3V3")
      const b = regulator(s, "u2", "lm7805", LM7805, "9V", "VDD2")
      const h = header(s, "3V3")
      s.build()
      return { sheet: s, expected: { u1: s.members(...a), u2: s.members(...b), i2c: s.members(...h) } }
    },
  },
  {
    name: "two LDOs brought in as ICs (one known by name, one by its pins) and an I2C header",
    make: (seed) => {
      const s = new Sheet(seed)
      const a = regulator(s, "u1", LDO_NAMED.id, IC_LDO, "5V", "3V3")
      const b = regulator(s, "u2", LDO_PINS.id, IC_LDO, "9V", "VDD2")
      const h = header(s, "VDD2")
      s.build()
      return { sheet: s, expected: { u1: s.members(...a), u2: s.members(...b), i2c: s.members(...h) } }
    },
  },
  {
    name: "USB-C with 2 to 4 VBUS capacitors and no regulator on VBUS",
    make: (seed) => {
      const s = new Sheet(seed)
      const u = usb(s)
      const h = header(s, "3V3")
      const ldo = regulator(s, "ldo", "ams1117_3v3", POWER_LDO, "5V", "3V3")
      s.build()
      return { sheet: s, expected: { usb: s.members(...u), i2c: s.members(...h), ldo: s.members(...ldo) } }
    },
  },
  {
    name: "a buck with an inductor and a 3-pin header on each side",
    make: (seed) => {
      const s = new Sheet(seed)
      const b = buck(s, "12V", "5V")
      s.part("jin", "screw_terminal_3")
      s.part("jout", "screw_terminal_3")
      s.net("12V", ["jin", "2"])
      s.net("GND", ["jin", "1"], ["jout", "1"])
      s.net("5V", ["jout", "2"])
      s.net("EN_IN", ["buck", "3"], ["jin", "3"])
      s.build()
      return { sheet: s, expected: { buck: s.members(...b), jin: s.members("jin"), jout: s.members("jout") } }
    },
  },
  {
    name: "all of them on one sheet",
    make: (seed) => {
      const s = new Sheet(seed)
      const a = regulator(s, "u1", LDO_NAMED.id, IC_LDO, "5V", "3V3")
      const h = header(s, "3V3")
      const u = usb(s)
      const b = buck(s, "12V", "9V")
      s.part("jout", "screw_terminal_3")
      s.net("GND", ["jout", "1"])
      s.net("9V", ["jout", "2"])
      s.build()
      return { sheet: s, expected: { u1: s.members(...a), i2c: s.members(...h), usb: s.members(...u), buck: s.members(...b), jout: s.members("jout") } }
    },
  },
]

/** A DAC and an op-amp on a supply with an LDO, each with its own 100 nF 3 to 6 units away, the LDO with its capacitors beside it. */
VARIANTS.push({
  name: "a 6-pin DAC and a 5-pin op-amp, each with its own capacitor, on a supply with an LDO",
  make: (seed) => {
    const s = new Sheet(seed)
    s.gap = [25, 40]
    s.part("ldo", "ams1117_3v3")
    s.net("5V", ["ldo", "3"])
    s.net("3V3", ["ldo", "2"])
    s.net("GND", ["ldo", "1"])
    const ldo = ["ldo", ...caps(s, "li", 1, "5V", ["10uF"], "ldo"), ...caps(s, "lo", 2, "3V3", ["100nF", "10uF"], "ldo")]
    s.part("dac", DAC.id)
    s.net("3V3", ["dac", "3"])
    s.net("GND", ["dac", "2"])
    const dac = ["dac", ...caps(s, "cd", 1, "3V3", ["100nF"], "dac")]
    s.part("amp", OPAMP.id)
    s.net("3V3", ["amp", "5"])
    s.net("GND", ["amp", "2"])
    s.net("SIG", ["amp", "3"], ["dac", "1"])
    const amp = ["amp", ...caps(s, "ca", 1, "3V3", ["100nF"], "amp")]
    s.build()
    return { sheet: s, expected: { ldo: s.members(...ldo), dac: s.members(...dac), amp: s.members(...amp) } }
  },
})

const SEEDS = Array.from({ length: 24 }, (_, i) => i + 1)

describe("supply capacitors on a spread-out sheet, 24 seeds of each kind", () => {
  for (const v of VARIANTS) {
    it(v.name, () => {
      const wrong: string[] = []
      for (const seed of SEEDS) {
        const { sheet, expected } = v.make(seed)
        for (const [key, parts] of Object.entries(expected)) {
          const got = sheet.group(key)
          if (JSON.stringify(got) !== JSON.stringify(parts)) wrong.push(`seed ${seed} ${key}: ${got?.length ?? "no group"} parts, expected ${parts.length}`)
        }
      }
      expect(wrong).toEqual([])
    })
  }
})
