import type { SupplierPin } from "@cherryblossom/api-contract"
import { describe, expect, it } from "vitest"
import { comparePins } from "../src/model/supplier/pinmap"
import { canonicalPin, pinRole } from "../src/model/supplier/roles"
import { recordedPart } from "./fixtures/supplier/source"

const vendor = (map: string): SupplierPin[] =>
  map.split(" ").map((pair) => {
    const [number, name] = pair.split(":")
    return { number, name, aliases: [], role: pinRole(name) }
  })
const drawn = (map: string) =>
  map.split(" ").map((pair) => {
    const [number, name] = pair.split(":")
    return { number, name }
  })

describe("pin roles", () => {
  it("reads what a pin is for from its name, spelling aside", () => {
    expect(["VIN", "VCC", "VDD_IO", "vddio", "AVDD", "VBUS", "V+", "3V3", "VPSI"].map(pinRole)).toEqual(Array(9).fill("power_in"))
    expect(["VOUT", "VO", "VOUT2"].map(pinRole)).toEqual(["power_out", "power_out", "power_out"])
    expect(["GND", "VSS", "AGND", "GROUND", "GND2", "CMIP"].map(pinRole)).toEqual(Array(6).fill("ground"))
    expect(["EP", "EPAD", "PAD", "Thermal Pad"].map(pinRole)).toEqual(Array(4).fill("exposed_pad"))
    expect(["NC", "N/C", "DNC", "NC3"].map(pinRole)).toEqual(Array(4).fill("nc"))
    // Names that read like supplies and aren't: a protector's monitor input, a Darlington common.
    expect(["VM", "COM", "EN", "FB", "SW", "1B", "SENSOR_VN"].map(pinRole)).toEqual(Array(7).fill("signal"))
  })

  it("keeps the sign of a differential pin", () => {
    expect(canonicalPin("UD+")).toBe(canonicalPin("ud_p"))
    expect(canonicalPin("UD+")).not.toBe(canonicalPin("UD-"))
    expect(canonicalPin("USB_DP")).toBe("UDP")
  })
})

describe("comparing a pin map with the supplier's", () => {
  it("refuses the production TPS61023, input and output swapped, with every pin number", () => {
    const tps = vendor("1:FB 2:EN 3:VIN 4:GND 5:SW 6:VOUT")
    const c = comparePins(drawn("1:SW 2:GND 3:EN 4:FB 5:VOUT 6:VIN"), tps)
    expect(c.verdict).toBe("contradicted")
    expect(c.fatal.map((f) => f.number)).toEqual(["2", "3", "4", "5", "6"])
    expect(c.fatal.find((f) => f.number === "6")?.text).toBe("pin 6 is VOUT (a supply output), drawn as VIN (a supply input)")
    expect(c.fatal.find((f) => f.number === "4")?.text).toBe("pin 4 is GND (ground), drawn as FB (a signal)")
  })

  it("catches a supply input and output swapped even when both are supplies", () => {
    const c = comparePins(drawn("1:FB 2:EN 3:VOUT 4:GND 5:SW 6:VIN"), vendor("1:FB 2:EN 3:VIN 4:GND 5:SW 6:VOUT"))
    expect(c.fatal.map((f) => f.number)).toEqual(["3", "6"])
  })

  it("passes a right map spelled differently: VCC for VDD, GND for VSS, an index on repeated grounds", () => {
    const c = comparePins(drawn("1:OD 2:VM 3:OC 4:TD 5:VCC 6:GND"), vendor("1:OD 2:VM 3:OC 4:TD 5:VDD 6:VSS"))
    expect(c.verdict).toBe("renamed")
    expect(c.fatal).toEqual([])
    expect(c.renamed.map((f) => f.number)).toEqual(["5"])
    expect(comparePins(drawn("1:GND1 2:GND2 3:IN"), vendor("1:GND 2:GND 3:IN")).verdict).toBe("agrees")
    // An index isn't a spelling: AIN0 is not AIN1.
    expect(comparePins(drawn("1:AIN0 2:AIN1"), vendor("1:AIN1 2:AIN0")).verdict).toBe("contradicted")
  })

  it("passes ULN2003A's 1B/1C names against a datasheet's IN1/OUT1, which only differ in spelling", () => {
    const uln = recordedPart("C482013").pins!
    const datasheet = drawn("1:IN1 2:IN2 3:IN3 4:IN4 5:IN5 6:IN6 7:IN7 8:GND 9:COM 10:OUT7 11:OUT6 12:OUT5 13:OUT4 14:OUT3 15:OUT2 16:OUT1")
    // Other drawings of the part spell it the datasheet's way, so the consensus knows both.
    expect(comparePins(datasheet, uln).verdict).toBe("agrees")
    // With one drawing's names alone (1B, 1C, E), nothing contradicts it either.
    const c = comparePins(datasheet, uln.map((p) => ({ ...p, aliases: [] })))
    expect(c.verdict).toBe("renamed")
    expect(c.fatal).toEqual([])
    expect(c.renamed.find((f) => f.number === "1")?.text).toBe("pin 1 is 1B, drawn as IN1")
  })

  it("refuses a name the supplier puts on another pin, once it happens twice or on a supply", () => {
    const v = vendor("1:A 2:B 3:C 4:D")
    expect(comparePins(drawn("1:B 2:A 3:C 4:D"), v).verdict).toBe("contradicted")
    // One swapped signal alone is more likely two names for a pin than a wrong map.
    expect(comparePins(drawn("1:A 2:B 3:C 4:X"), v).verdict).toBe("renamed")
    const supply = comparePins(drawn("1:IN 2:VCC 3:OUT"), vendor("1:VCC 2:IN 3:OUT"))
    expect(supply.verdict).toBe("contradicted")
  })

  it("refuses pin numbers the part doesn't have, saying how many it has", () => {
    const lfcn = recordedPart("C879846").pins!
    const c = comparePins(drawn("1:IN 2:GND2 3:GND3 4:OUT 5:GND5 6:GND6"), lfcn)
    expect(c.fatal.map((f) => f.text)).toContain("pin 5 (GND5) doesn't exist: the supplier's part has 4 pins, numbered 1-4")
    // The RF output drawn on a ground pad, and ground on the output.
    expect(c.fatal.map((f) => f.number)).toEqual(expect.arrayContaining(["3", "4"]))
  })

  it("reads a diode numbered the other way round as the supplier's convention, not a fault", () => {
    const ss34 = recordedPart("C908680").pins!
    expect(ss34.map((p) => `${p.number}:${p.name}`).sort()).toEqual(["1:C", "2:A"])
    const c = comparePins(drawn("1:A 2:K"), ss34)
    expect(c).toMatchObject({ verdict: "renamed", polaritySwapped: true, fatal: [] })
    expect(comparePins(drawn("1:K 2:A"), ss34)).toMatchObject({ verdict: "agrees", polaritySwapped: false })
  })

  it("tells the WS2812B 5050 from the 2020, whose same four pins are in another order", () => {
    const c = comparePins(recordedPart("C965555").pins!, recordedPart("C2846045").pins!)
    expect(c.verdict).toBe("contradicted")
  })

  it("matches an exposed pad named for its number, and lists supplier pins the drawing left out", () => {
    const sht = vendor("1:SDA 2:ADDR 3:ALERT 4:SCL 5:VDD 6:nRESET 7:R 8:VSS 9:EP")
    const c = comparePins(drawn("1:SDA 2:ADDR 3:ALERT 4:SCL 5:VDD 6:nRESET 7:R 8:VSS"), sht)
    expect(c.verdict).toBe("agrees")
    expect(c.missing.map((p) => p.number)).toEqual(["9"])
    expect(comparePins([...drawn("1:SDA 2:ADDR 3:ALERT 4:SCL 5:VDD 6:nRESET 7:R 8:VSS"), { number: "EP", name: "GND" }], sht).missing).toEqual([])
  })

  it("keeps a supply drawn on the supplier's exposed pad, and the AMS1117's tab, as the same pin", () => {
    const ams = recordedPart("C6186").pins!
    expect(comparePins(drawn("1:GND 2:VOUT 3:VIN 4:VOUT"), ams).verdict).toBe("agrees")
    expect(comparePins(drawn("1:GND 2:VIN 3:VOUT 4:VOUT"), ams).verdict).toBe("contradicted")
  })
})
