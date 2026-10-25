import { describe, expect, it } from "vitest"
import { computeConnectivity } from "../src/model/connectivity"
import { ignoreCheck, pinPairLevel, restoreCheck, runErc, splitIgnored, type ErcFinding } from "../src/model/erc"
import { EXAMPLES } from "../src/model/examples"
import { findPart, registerPart, unregisterPart } from "../src/model/library"
import { labelPin } from "../src/model/ops"
import { normalizeProject } from "../src/model/projectFile"
import type { PinType, Project } from "../src/model/types"
import { ALL_LIBS, importSheet as imported, place } from "./kicad-sch-parts"
import type { SchSpec } from "./kicad-schematic-fixtures"

// ERC for symbols imported from KiCad: units that are not all placed, pin types that conflict on a
// net (KiCad's own table), hidden power pins as supply, and the pins of every unit of a part.

/**
 * A sheet imported on its own has no footprints (they come from a board), so none of its parts is
 * physical. A part with a footprint is what Tidy, the netlist and the physical checks work on, so the
 * parts of a sheet are given one here, as a project that came with its board has them.
 */
/** KiCad's PWR_FLAG: a symbol with one pin of the type power output, on whatever it is put on. */
const LIB_FLAG = `(symbol "power:PWR_FLAG" (power) (pin_names (offset 0)) (in_bom no) (on_board no)
  (property "Reference" "#FLG" (at 0 1.905 0) (effects (font (size 1.27 1.27)) hide))
  (property "Value" "PWR_FLAG" (at 0 3.81 0) (effects (font (size 1.27 1.27))))
  (symbol "PWR_FLAG_0_0" (pin power_out line (at 0 0 90) (length 0) (name "pwr" (effects (font (size 1.27 1.27)))) (number "1" (effects (font (size 1.27 1.27)))))))`

function importSheet(spec: SchSpec): Project {
  const p = imported({ libs: [...ALL_LIBS, LIB_FLAG], ...spec })
  const done = new Set<string>()
  for (const c of p.components) {
    const part = findPart(c.partId)
    if (!part || part.powerNet || part.unitOf || done.has(part.id)) continue
    done.add(part.id)
    unregisterPart(part.id)
    registerPart({ ...part, footprints: ["0603"] })
  }
  return { ...p, components: p.components.map((c) => (findPart(c.partId)?.powerNet || findPart(c.partId)?.unitOf ? c : { ...c, footprint: "0603" })) }
}
const erc = (p: Project): ErcFinding[] => runErc(p, computeConnectivity(p))
const kinds = (p: Project, kind: ErcFinding["kind"]) => erc(p).filter((f) => f.kind === kind)
const comp = (p: Project, ref: string, unit = 1) => p.components.find((c) => c.ref === ref && (c.unit ?? 1) === unit)!
const label = (p: Project, ref: string, pin: string, name: string, unit = 1) => labelPin(p, { componentId: comp(p, ref, unit).id, pin }, name)

describe("the shipped examples", () => {
  // The findings of the five examples before the checks for imported symbols were added: none.
  it.each(EXAMPLES.map((e) => e.id))("%s has the findings it had", (id) => {
    const p = normalizeProject(structuredClone(EXAMPLES.find((e) => e.id === id)!.project))
    expect(erc(p)).toEqual([])
  })
})

describe("KiCad's table of pin pairs", () => {
  const TYPES: PinType[] = ["input", "output", "bidirectional", "tri_state", "passive", "free", "unspecified", "power_in", "power_out", "open_collector", "open_emitter", "no_connect"]

  it("is symmetric", () => {
    for (const a of TYPES) for (const b of TYPES) expect(pinPairLevel(a, b), `${a} ${b}`).toBe(pinPairLevel(b, a))
  })

  it("says what the common pairs make", () => {
    expect(pinPairLevel("output", "output")).toBe("error")
    expect(pinPairLevel("power_out", "power_out")).toBe("error")
    expect(pinPairLevel("output", "power_out")).toBe("error")
    expect(pinPairLevel("output", "input")).toBe("ok")
    expect(pinPairLevel("power_out", "power_in")).toBe("ok")
    expect(pinPairLevel("output", "tri_state")).toBe("warning")
    expect(pinPairLevel("unspecified", "input")).toBe("warning")
    expect(pinPairLevel("free", "input")).toBe("ok")
    expect(pinPairLevel("passive", "passive")).toBe("ok")
    expect(pinPairLevel("no_connect", "passive")).toBe("error")
    expect(pinPairLevel("open_collector", "open_collector")).toBe("ok")
    expect(pinPairLevel("open_collector", "output")).toBe("error")
  })
})

describe("units that are not all placed", () => {
  const sheet = (...units: number[]) =>
    importSheet({ symbols: units.map((u, i) => place("Test:OPA2", `${60 + i * 60} 100`, "U1", { unit: u })) })

  it("names the units left out, once per part", () => {
    const p = sheet(1)
    const found = kinds(p, "missing-unit")
    expect(found).toHaveLength(1)
    expect(found[0].message).toBe("U1 has unplaced units: B and C")
    expect(found[0].key).toBe(`missing-unit:${comp(p, "U1").id}`)
    expect(found[0].subject).toBe("U1")
  })

  it("names one unit left out", () => {
    const found = kinds(sheet(1, 3), "missing-unit")
    expect(found.map((f) => f.message)).toEqual(["U1 has an unplaced unit: B"])
  })

  it("is quiet when every unit is placed, in any order and on any spot", () => {
    expect(kinds(sheet(1, 2, 3), "missing-unit")).toEqual([])
    expect(kinds(sheet(3, 1, 2), "missing-unit")).toEqual([])
    expect(kinds(sheet(2, 3, 1), "missing-unit")).toEqual([])
  })

  it("looks at the part's own unit, whichever it is", () => {
    // Only unit 2 placed: B is placed, A and C are not.
    expect(kinds(sheet(2), "missing-unit").map((f) => f.message)).toEqual(["U1 has unplaced units: A and C"])
  })

  it("names every placed unit of the part in the finding, so a click selects them", () => {
    const p = sheet(1, 2)
    const [f] = kinds(p, "missing-unit")
    expect(f.message).toBe("U1 has an unplaced unit: C")
    expect(f.componentIds.sort()).toEqual(p.components.map((c) => c.id).sort())
  })

  it("counts a part of one unit as complete", () => {
    const p = importSheet({ symbols: [place("Test:MCU", "60 60", "U2"), place("Test:AND2", "100 60", "U3")] })
    expect(kinds(p, "missing-unit")).toEqual([])
  })

  it("ignores a part with a body style of its own as having one unit", () => {
    // The De Morgan gate has two body styles and one unit.
    const p = importSheet({ symbols: [place("Test:AND2", "100 60", "U3")] })
    expect(kinds(p, "missing-unit")).toEqual([])
  })
})

describe("pin types on one net", () => {
  it("two outputs on a net are a conflict, named by their pins", () => {
    let p = importSheet({
      symbols: [place("Test:OPA2", "60 100", "U1", { unit: 1 }), place("Test:OPA2", "60 160", "U1", { unit: 2 }), place("Test:OPA2", "120 100", "U1", { unit: 3 })],
    })
    p = label(p, "U1", "1", "SIG", 1)
    p = label(p, "U1", "7", "SIG", 2)
    const found = kinds(p, "pin-conflict")
    expect(found).toHaveLength(1)
    expect(found[0].message).toBe("U1 pin 1 is an output and U1 pin 7 is an output, which cannot share a net")
    expect(found[0].componentIds).toHaveLength(2)
    expect(found[0].key).toMatch(/^pin-conflict:/)
    expect(erc(p).some((f) => f.kind === "missing-unit")).toBe(false)
  })

  it("an output on an input is fine, so is a correct multi-unit part", () => {
    let p = importSheet({
      symbols: [place("Test:OPA2", "60 100", "U1", { unit: 1 }), place("Test:OPA2", "60 160", "U1", { unit: 2 }), place("Test:OPA2", "120 100", "U1", { unit: 3 })],
    })
    p = label(p, "U1", "1", "SIG", 1)
    p = label(p, "U1", "6", "SIG", 2)
    expect(erc(p)).toEqual([])
  })

  it("is one finding per bad pin, as KiCad reports: three outputs make two", () => {
    let p = importSheet({
      symbols: [place("Test:OPA2", "60 100", "U1", { unit: 1 }), place("Test:OPA2", "60 160", "U1", { unit: 2 }), place("Test:AND2", "120 100", "U2")],
    })
    p = label(p, "U1", "1", "SIG", 1)
    p = label(p, "U1", "7", "SIG", 2)
    p = label(p, "U2", "3", "SIG")
    expect(kinds(p, "pin-conflict")).toHaveLength(2)
  })

  it("an alternate function changes the pin's type", () => {
    // PA0 is bidirectional; as TX it is an output, which clashes with another output.
    let p = importSheet({ symbols: [place("Test:MCU", "60 100", "U3"), place("Test:AND2", "120 100", "U2")] })
    p = label(p, "U3", "1", "NET")
    p = label(p, "U2", "3", "NET")
    expect(kinds(p, "pin-conflict")).toEqual([])
    const withTx = { ...p, components: p.components.map((c) => (c.ref === "U3" ? { ...c, pinAlt: { "1": "TX" } } : c)) }
    expect(kinds(withTx, "pin-conflict").map((f) => f.message)).toEqual(["U2 pin 3 (Y) is an output and U3 pin 1 (TX) is an output, which cannot share a net"])
  })

  it("a pin of the type no connect is on no net, so it conflicts with nothing", () => {
    let p = importSheet({ symbols: [place("Test:MCU", "60 100", "U3"), place("Test:AND2", "120 100", "U2")] })
    p = label(p, "U3", "3", "NET")
    p = label(p, "U2", "3", "NET")
    expect(kinds(p, "pin-conflict")).toEqual([])
  })

  it("ignores the editor's own parts, which have no pin types", () => {
    const p = normalizeProject(structuredClone(EXAMPLES[0].project))
    expect(kinds(p, "pin-conflict")).toEqual([])
    expect(kinds(p, "missing-unit")).toEqual([])
  })
})

describe("power symbols and flags on one net", () => {
  it("two power symbols are fine, two flags are a conflict, a flag and a symbol are fine", () => {
    let p = importSheet({ symbols: [place("power:VCC", "40 40", "#PWR01"), place("power:VCC", "80 40", "#PWR02"), place("power:PWR_FLAG", "40 80", "#FLG01"), place("power:PWR_FLAG", "80 80", "#FLG02")] })
    // The power symbols are on VCC by their value; a flag is on what its pin touches: a label.
    p = label(p, "#FLG01", "1", "VCC")
    expect(kinds(p, "pin-conflict")).toEqual([])
    p = label(p, "#FLG02", "1", "VCC")
    const found = kinds(p, "pin-conflict")
    expect(found).toHaveLength(1)
    expect(found[0].message).toBe("#FLG01 pin 1 (pwr) is a power output and #FLG02 pin 1 (pwr) is a power output, which cannot share a net")
  })
})

describe("ignoring a finding", () => {
  it("is by key, for the new kinds as for the others", () => {
    let p = importSheet({ symbols: [place("Test:OPA2", "60 100", "U1", { unit: 1 }), place("Test:OPA2", "60 160", "U1", { unit: 2 })] })
    p = label(p, "U1", "1", "SIG", 1)
    p = label(p, "U1", "7", "SIG", 2)
    const all = erc(p)
    expect(all.map((f) => f.kind).sort()).toEqual(["missing-unit", "pin-conflict"])
    const ignored = ignoreCheck(p, all[0].key)
    const split = splitIgnored(erc(ignored), ignored.ignoredChecks)
    expect(split.ignored.map((f) => f.key)).toEqual([all[0].key])
    expect(split.active.map((f) => f.key)).toEqual([all[1].key])
    expect(splitIgnored(erc(restoreCheck(ignored, all[0].key)), restoreCheck(ignored, all[0].key).ignoredChecks).active).toHaveLength(2)
  })
})

describe("hidden power-input pins are supply", () => {
  it("a hidden VDD pin makes its net a rail, so a lone pin on it is not a lone label", () => {
    const p = importSheet({ symbols: [place("Test:MCU", "60 100", "U3")] })
    const conn = computeConnectivity(p)
    const vdd = conn.pinNet.get(`${comp(p, "U3").id}:4`)
    expect(vdd).toBe("net:VDD")
    // The net is named and has one physical pin: without the rail it would be a lone label.
    expect(kinds(p, "lone-label").filter((f) => f.message.includes("VDD"))).toEqual([])
  })
})

describe("lone labels and the pins of other units", () => {
  it("finds a lone label on a pin of unit 2, which lives on a twin component", () => {
    let p = importSheet({
      symbols: [place("Test:OPA2", "60 100", "U1", { unit: 1 }), place("Test:OPA2", "60 160", "U1", { unit: 2 }), place("Test:OPA2", "120 100", "U1", { unit: 3 })],
    })
    p = label(p, "U1", "7", "ONLY_HERE", 2)
    const found = kinds(p, "lone-label")
    expect(found.map((f) => f.message)).toEqual(["U1 pin 7 goes only to the label ONLY_HERE, which no other pin has"])
    expect(found[0].key).toBe(`lone-label:${comp(p, "U1", 2).id}:7`)
    // A wire to a pin of unit 1 under the same name is two pins: no finding.
    p = label(p, "U1", "2", "ONLY_HERE", 1)
    expect(kinds(p, "lone-label")).toEqual([])
  })

  it("a two-pin imported part with both pins on one net is shorted", () => {
    let p = importSheet({ symbols: [place("Device:R", "60 100", "R1"), place("Device:R", "100 100", "R2")] })
    p = label(p, "R1", "1", "A")
    p = label(p, "R1", "2", "A")
    p = label(p, "R2", "1", "A")
    p = label(p, "R2", "2", "B")
    expect(kinds(p, "shorted").map((f) => f.subject)).toEqual(["R1"])
  })
})
