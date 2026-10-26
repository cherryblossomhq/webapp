import { createBlock } from "../src/model/blocks"
import { pinStubPoint } from "../src/model/instances"
import { addComponent, addWire, createProject, findPin, labelPin } from "../src/model/ops"
import type { ComponentInstance, Project } from "../src/model/types"

// Designs to tidy that nobody drew: circuits put together from the parts a board is made of (a
// microcontroller with its crystal and reset, an LED bar on a shift register, a 555, a regulator,
// USB to serial, an op-amp stage, an I2C header, a motor driver), joined by named nets and
// grouped into blocks, with each part dropped in a cell of its own. A seed picks which modules,
// how many, which nets join them, which parts are left out of blocks and which supplies are drawn
// as ports, so a test can make as many different ones as it likes.

/** A small, fast, seeded random source (mulberry32). */
export function rng(seed: number) {
  let a = seed >>> 0
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  return {
    next,
    int: (n: number) => Math.floor(next() * n),
    pick: <T>(items: T[]): T => items[Math.floor(next() * items.length)],
    chance: (p: number) => next() < p,
  }
}
type Rng = ReturnType<typeof rng>

export class Designer {
  project: Project
  private cell = 0
  /** Parts of the module being built, to group into its block. */
  module: ComponentInstance[] = []
  constructor(
    name: string,
    readonly r: Rng,
  ) {
    this.project = createProject(name)
  }

  add(partId: string, props: Record<string, string> = {}): ComponentInstance {
    const i = this.cell++
    const sch = { x: (i % 14) * 8, y: -Math.floor(i / 14) * 8, rot: 0 as const }
    const res = addComponent(this.project, partId, { sch, props })
    this.project = res.project
    this.module.push(res.component)
    return res.component
  }

  /** Name a pin's net with a label on a stub. */
  label(c: ComponentInstance, pin: string, name: string) {
    this.project = labelPin(this.project, { componentId: c.id, pin }, name)
  }

  /** A supply: a label, or now and then a power or ground port wired to the pin. */
  rail(c: ComponentInstance, pin: string, name: string) {
    if (!this.r.chance(0.35)) return this.label(c, pin, name)
    const ground = /GND/.test(name)
    const port = this.add(ground ? "ground" : "power", ground ? {} : { net: name })
    this.module.pop()
    this.wire(port, "1", c, pin)
  }

  /**
   * A wire between two pins that touches nothing else: out of each pin, then along lines of its
   * own off the grid, where no pin, wire end or label can be, and below everything.
   */
  wire(a: ComponentInstance, pa: string, b: ComponentInstance, pb: string) {
    const k = ++this.wires
    const A = findPin(this.project, { componentId: a.id, pin: pa })!
    const B = findPin(this.project, { componentId: b.id, pin: pb })!
    const sa = pinStubPoint(A, 0.2)
    const sb = pinStubPoint(B, 0.2)
    const da = 0.013 + k * 0.0007
    const db = 0.031 + k * 0.0007
    const y = -9000 - k * 0.0113
    const points = [A.pos, sa, { x: sa.x + da, y: sa.y }, { x: sa.x + da, y }, { x: sb.x + db, y }, { x: sb.x + db, y: sb.y }, sb, B.pos]
    this.project = addWire(this.project, points).project
  }
  private wires = 0

  /** A two-pin part between two pins or nets: a wire to a pin, a label for a name. */
  between(partId: string, props: Record<string, string>, a: [ComponentInstance, string] | string, b: [ComponentInstance, string] | string, pins = ["1", "2"]) {
    const c = this.add(partId, props)
    for (const [end, pin] of [
      [a, pins[0]],
      [b, pins[1]],
    ] as const) {
      if (typeof end === "string") {
        if (/^(GND|5V|3V3|VIN|VBUS|VM)$/.test(end)) this.rail(c, pin, end)
        else this.label(c, pin, end)
      } else this.wire(c, pin, end[0], end[1])
    }
    return c
  }

  ledChain(from: [ComponentInstance, string] | string, ohms = "330") {
    const r = this.add("resistor", { value: ohms })
    if (typeof from === "string") this.label(r, "1", from)
    else this.wire(r, "1", from[0], from[1])
    const d = this.add("led", { color: "green" })
    this.wire(r, "2", d, "1")
    this.rail(d, "2", "GND")
  }

  decap(supply: string, value = "100nF") {
    this.between("capacitor", { value }, supply, "GND")
  }

  block(name: string) {
    const ids = this.module.map((c) => c.id)
    this.module = []
    if (!ids.length) return
    // Now and then a part is left out of its block, for OTHER to take in.
    const kept = ids.filter(() => !this.r.chance(0.08))
    if (kept.length) this.project = createBlock(this.project, name, kept).project
  }
}

type Module = (d: Designer, n: number) => void

const MODULES: Record<string, Module> = {
  mcu: (d, n) => {
    const u = d.add("atmega328p")
    for (const pin of ["4", "6", "18"]) d.rail(u, pin, "5V")
    for (const pin of ["3", "5", "21"]) d.rail(u, pin, "GND")
    const y = d.add("crystal", { value: "16MHz" })
    d.wire(y, "1", u, "7")
    d.wire(y, "2", u, "8")
    d.between("capacitor", { value: "22pF" }, [y, "1"], "GND")
    d.between("capacitor", { value: "22pF" }, [y, "2"], "GND")
    d.between("resistor", { value: "10k" }, [u, "29"], "5V")
    d.between("pushbutton", {}, [u, "29"], "GND")
    d.decap("5V")
    d.decap("5V")
    d.ledChain([u, "17"])
    d.label(u, "27", "SDA")
    d.label(u, "28", "SCL")
    d.label(u, "30", `RX${n}`)
    d.label(u, "31", `TX${n}`)
    d.label(u, "15", "DATA")
    d.label(u, "16", "CLK")
    d.label(u, "14", "LATCH")
    d.label(u, "23", `ADC${n}`)
    d.block(`MCU${n || ""}`)
  },
  ledbar: (d, n) => {
    const u = d.add("sn74hc595")
    d.rail(u, "16", "5V")
    d.rail(u, "8", "GND")
    d.rail(u, "13", "GND")
    d.rail(u, "10", "5V")
    d.label(u, "14", "DATA")
    d.label(u, "11", "CLK")
    d.label(u, "12", "LATCH")
    for (const pin of ["15", "1", "2", "3", "4", "5", "6", "7"]) d.ledChain([u, pin])
    d.decap("5V")
    d.block(`LED BAR${n || ""}`)
  },
  timer: (d, n) => {
    const u = d.add("ne555")
    d.rail(u, "8", "5V")
    d.rail(u, "4", "5V")
    d.rail(u, "1", "GND")
    d.between("resistor", { value: "1k" }, "5V", [u, "7"])
    d.between("resistor", { value: "10k" }, [u, "7"], [u, "6"])
    d.wire(u, "2", u, "6")
    d.between("capacitor", { value: "10uF" }, [u, "6"], "GND")
    d.between("capacitor", { value: "10nF" }, [u, "5"], "GND")
    d.ledChain([u, "3"], "470")
    d.decap("5V")
    d.block(`TIMER${n || ""}`)
  },
  regulator: (d, n) => {
    const u = d.add("ams1117_3v3")
    d.rail(u, "3", "5V")
    d.rail(u, "2", "3V3")
    d.rail(u, "1", "GND")
    d.decap("5V", "10uF")
    d.decap("3V3", "10uF")
    d.decap("3V3")
    d.ledChain("3V3", "1k")
    d.block(`3V3 POWER${n || ""}`)
  },
  usb: (d, n) => {
    const j = d.add("usb_c")
    d.rail(j, "A4", "VBUS")
    d.rail(j, "A1", "GND")
    d.between("resistor", { value: "5.1k" }, [j, "A5"], "GND")
    d.between("resistor", { value: "5.1k" }, [j, "B5"], "GND")
    const u = d.add("ch340g")
    d.rail(u, "16", "5V")
    d.rail(u, "1", "GND")
    d.wire(u, "5", j, "A6")
    d.wire(u, "6", j, "A7")
    const y = d.add("crystal", { value: "12MHz" })
    d.wire(y, "1", u, "7")
    d.wire(y, "2", u, "8")
    d.between("capacitor", { value: "22pF" }, [y, "1"], "GND")
    d.between("capacitor", { value: "22pF" }, [y, "2"], "GND")
    d.between("capacitor", { value: "100nF" }, [u, "4"], "GND")
    d.label(u, "2", `RX${n}`)
    d.label(u, "3", `TX${n}`)
    d.between("schottky", {}, "VBUS", "5V")
    d.decap("5V")
    d.block(`USB SERIAL${n || ""}`)
  },
  opamp: (d, n) => {
    const u = d.add("lm358")
    d.rail(u, "8", "5V")
    d.rail(u, "4", "GND")
    const j = d.add("screw_terminal_2")
    d.wire(j, "1", u, "3")
    d.rail(j, "2", "GND")
    d.between("resistor", { value: "10k" }, [u, "2"], "GND")
    d.between("resistor", { value: "100k" }, [u, "2"], [u, "1"])
    d.between("resistor", { value: "1k" }, [u, "1"], `ADC${n}`)
    d.between("capacitor", { value: "100nF" }, `ADC${n}`, "GND")
    d.decap("5V")
    d.block(`SENSOR${n || ""}`)
  },
  i2c: (d, n) => {
    const j = d.add("qwiic")
    d.rail(j, "1", "GND")
    d.rail(j, "2", "3V3")
    d.label(j, "3", "SDA")
    d.label(j, "4", "SCL")
    d.between("resistor", { value: "4.7k" }, "3V3", "SDA")
    d.between("resistor", { value: "4.7k" }, "3V3", "SCL")
    d.block(`I2C${n || ""}`)
  },
  motor: (d, n) => {
    const u = d.add("tb6612fng")
    for (const pin of ["13", "14", "24"]) d.rail(u, pin, "VM")
    d.rail(u, "20", "5V")
    for (const pin of ["3", "4", "9", "10", "18"]) d.rail(u, pin, "GND")
    const a = d.add("screw_terminal_2")
    d.wire(a, "1", u, "1")
    d.wire(a, "2", u, "5")
    const b = d.add("screw_terminal_2")
    d.wire(b, "1", u, "11")
    d.wire(b, "2", u, "7")
    for (const [pin, name] of [
      ["21", "AIN1"],
      ["22", "AIN2"],
      ["23", "PWMA"],
      ["17", "BIN1"],
      ["16", "BIN2"],
      ["15", "PWMB"],
      ["19", "STBY"],
    ]) d.label(u, pin, `${name}${n || ""}`)
    d.decap("VM", "47uF")
    d.decap("5V")
    d.block(`MOTOR${n || ""}`)
  },
}

/** A design of `modules` modules, chosen and joined by `seed`. */
export function randomDesign(seed: number, modules = 4): Project {
  const r = rng(seed)
  const d = new Designer(`random ${seed}`, r)
  const names = Object.keys(MODULES)
  const used = new Map<string, number>()
  for (let i = 0; i < modules; i++) {
    const m = r.pick(names)
    const n = used.get(m) ?? 0
    used.set(m, n + 1)
    MODULES[m](d, n)
  }
  return d.project
}

/** A large design: every module, again and again, until it has at least `parts` parts. */
export function largeDesign(parts: number): Project {
  const d = new Designer("large", rng(1))
  const names = Object.keys(MODULES)
  for (let i = 0; d.project.components.filter((c) => c.partId !== "power" && c.partId !== "ground").length < parts; i++) {
    MODULES[names[i % names.length]](d, Math.floor(i / names.length))
  }
  return d.project
}
