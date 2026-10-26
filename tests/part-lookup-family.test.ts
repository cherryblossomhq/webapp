import { describe, expect, it } from "vitest"
import { resolvePartName } from "../src/ai/partLookup"
import { partNumberKey, relateName } from "../src/model/supplier/partNumber"
import { candidate, candidateSource, pinsOf } from "./fixtures/supplier/candidates"

// A name is rarely the number a supplier sells under. These are the rules by which supplier part
// numbers that start with a name become one part, or a short list to choose from.

const ADS = "1:ADDR 2:ALERT/RDY 3:GND 4:AIN0 5:AIN1 6:AIN2 7:AIN3 8:VDD 9:SDA 10:SCL"
const VSSOP = "VSSOP-10_L3.0-W3.0-P0.50-LS4.9-BL"
const X2QFN = "X2QFN-10_L2.0-W1.5-P0.50-BL"
const ads = (over: Parameters<typeof candidate>[0]) => candidate({ pinMap: ADS, package: VSSOP, ...over })

describe("which part numbers are the name", () => {
  it("reads an ordering suffix as a variant, a longer number as another part", () => {
    expect(relateName("ADS1115", "ADS1115IDGSR")).toBe("variant")
    expect(relateName("TPS61023", "TPS61023DRLR")).toBe("variant")
    expect(relateName("SHT31-DIS", "SHT31-DIS-F2.5kS")).toBe("variant")
    expect(relateName("AP2112K-3.3", "AP2112K-3.3TRG1(MS)")).toBe("variant")
    expect(relateName("INA219", "INA2191A1IYBJR")).toBe("related")
    expect(relateName("LM358", "LM3580")).toBe("related")
    expect(relateName("ADS1115", "ADS1015IDGSR")).toBe("related")
    // A separator ends the number: ATtiny85-20PU is an ATtiny85, and WS2812B-2020 starts as a WS2812B
    // (its size and pin order, not its spelling, say it is another part).
    expect(relateName("ATTINY85", "ATTINY85-20PU")).toBe("variant")
    expect(relateName("WS2812B", "WS2812B-2020")).toBe("variant")
  })

  it("ignores punctuation, case and a packaging note", () => {
    expect(relateName("MPU6050", "MPU-6050")).toBe("exact")
    expect(relateName("mpu-6050", "MPU6050")).toBe("exact")
    expect(relateName("U.FL-R-SMT-1", "U.FL-R-SMT-1(80)")).toBe("exact")
    expect(partNumberKey("ESD101-B1-02ELS E6327")).toBe("ESD101B102ELS")
  })
})

describe("variants of one name", () => {
  it("are one part when they share a package and pin roles, resolved to the best stocked", async () => {
    // The automotive grade is listed first and the standard part is the one in stock.
    const src = candidateSource(
      ads({ lcsc: "C2868291", mpn: "ADS1115BQDGSRQ1", stock: 1679 }),
      ads({ lcsc: "C172375", mpn: "ADS1115QDGSRQ1", stock: 0 }),
      ads({ lcsc: "C37593", mpn: "ADS1115IDGSR", stock: 4800 }),
      ads({ lcsc: "C468683", mpn: "ADS1115IDGST", stock: 0 }),
    )
    const out = await resolvePartName(src, "ADS1115", {})
    expect(out.kind).toBe("found")
    if (out.kind !== "found") return
    expect(out.part.lcsc).toBe("C37593")
    expect(out.family.map((c) => c.lcsc)).toEqual(["C37593", "C2868291", "C172375", "C468683"])
    // It says which one it chose, so the copilot can tell the user.
    expect(out.chosen).toBe("ADS1115 resolved to C37593 ADS1115IDGSR (VSSOP-10, 4800 in stock), the best stocked of 4 supplier part numbers with the same package and the same function on every pin number (ADS1115IDGSR, ADS1115BQDGSRQ1, ADS1115QDGSRQ1, ADS1115IDGST).")
  })

  it("take no read of the other records: the pins come with the search", async () => {
    const src = candidateSource(ads({ lcsc: "C1", mpn: "ADS1115IDGSR" }), ads({ lcsc: "C2", mpn: "ADS1115IDGST" }))
    await resolvePartName(src, "ADS1115", {})
    expect(src.reads).toEqual(["C1"])
  })

  it("name the same package under different strings as one: SOT-23-5 and SOT-25-5", async () => {
    const pins = "1:VIN 2:GND 3:EN 4:NC 5:VOUT"
    const src = candidateSource(
      candidate({ lcsc: "C22365427", mpn: "AP2112K-3.3TRG1(MS)", package: "SOT-23-5_L2.9-W1.6-P0.95-LS2.7-BR", pinMap: pins, stock: 42440 }),
      candidate({ lcsc: "C51118", mpn: "AP2112K-3.3TRG1", package: "SOT-25-5_L2.9-W1.6-P0.95-LS2.8-BL", pinMap: pins, stock: 14915 }),
    )
    const out = await resolvePartName(src, "AP2112K-3.3", {})
    expect(out).toMatchObject({ kind: "found", part: { lcsc: "C22365427" } })
  })

  it("are a short list when they differ in package, with what differs spelled out", async () => {
    const src = candidateSource(
      ads({ lcsc: "C2868291", mpn: "ADS1115BQDGSRQ1", stock: 1679 }),
      ads({ lcsc: "C37593", mpn: "ADS1115IDGSR", stock: 4800 }),
      ads({ lcsc: "C701611", mpn: "ADS1115IRUGT", package: X2QFN, stock: 218 }),
      ads({ lcsc: "C2651328", mpn: "ADS1115IRUGR", package: X2QFN, stock: 37 }),
    )
    const out = await resolvePartName(src, "ADS1115", {})
    expect(out.kind).toBe("ambiguous")
    if (out.kind !== "ambiguous") return
    // One entry per package, the best stocked of each, the better stocked package first.
    expect(out.candidates.map((c) => c.lcsc)).toEqual(["C37593", "C701611"])
    expect(out.text).toContain("ADS1115 is sold as 4 supplier part numbers in 2 packages or pinouts")
    expect(out.text).toContain("C37593 ADS1115IDGSR, VSSOP-10_L3.0-W3.0-P0.50-LS4.9-BL, 10 pins, 4800 in stock (1 more part number with the same package and the same function on every pin number)")
    expect(out.text).toContain("C701611 ADS1115IRUGT, X2QFN-10_L2.0-W1.5-P0.50-BL, 10 pins, 218 in stock (1 more part number with the same package and the same function on every pin number)")
    expect(out.text).toContain("They differ in: VSSOP-10 vs X2QFN-10.")
    expect(out.text).toContain("Pass lcsc for the one the user means")
  })

  it("are narrowed by the footprint the drawing names: msop10 is VSSOP-10", async () => {
    const src = candidateSource(
      ads({ lcsc: "C37593", mpn: "ADS1115IDGSR", stock: 4800 }),
      ads({ lcsc: "C701611", mpn: "ADS1115IRUGT", package: X2QFN, stock: 218 }),
    )
    const out = await resolvePartName(src, "ADS1115", { footprint: "msop10" })
    expect(out).toMatchObject({ kind: "found", part: { lcsc: "C37593" } })
  })

  it("are a short list when the package is one but the pin roles differ", async () => {
    const src = candidateSource(
      candidate({ lcsc: "C1", mpn: "XYZ100A", pinMap: "1:VIN 2:GND 3:EN 4:FB 5:SW 6:VOUT", package: "SOT-23-6_L2.9-W1.6-P0.95", stock: 500 }),
      candidate({ lcsc: "C2", mpn: "XYZ100B", pinMap: "1:EN 2:GND 3:VIN 4:FB 5:SW 6:VOUT", package: "SOT-23-6_L2.9-W1.6-P0.95", stock: 90 }),
    )
    const out = await resolvePartName(src, "XYZ100", {})
    expect(out.kind).toBe("ambiguous")
    if (out.kind !== "ambiguous") return
    expect(out.text).toContain("pin names or roles (pin 1 is EN on C2 but VIN on C1; pin 3 is VIN on C2 but EN on C1)")
  })

  it("never include a longer number that is another size: WS2812B-2020 is not a WS2812B", async () => {
    const pins = "1:VDD 2:DOUT 3:VSS 4:DIN"
    const src = candidateSource(
      candidate({ lcsc: "C1", mpn: "WS2812B", match: "exact", package: "LED-SMD_4P-L5.0-W5.0-TL", pinMap: pins, stock: 0 }),
      candidate({ lcsc: "C2", mpn: "WS2812B-2020", package: "LED-SMD_4P-L2.0-W2.0-TL", pinMap: "1:DO 2:GND 3:DI 4:VDD", stock: 900 }),
    )
    // The part number's own record is the part, and the 2020 stays out however well stocked.
    const exact = await resolvePartName(src, "WS2812B", {})
    expect(exact).toMatchObject({ kind: "found", part: { lcsc: "C1" } })
    // With no record of its own the two are different packages and pinouts: a choice, not a pick.
    const noOwn = candidateSource(
      candidate({ lcsc: "C3", mpn: "WS2812B-5050", package: "LED-SMD_4P-L5.0-W5.0-TL", pinMap: pins, stock: 40 }),
      candidate({ lcsc: "C2", mpn: "WS2812B-2020", package: "LED-SMD_4P-L2.0-W2.0-TL", pinMap: "1:DO 2:GND 3:DI 4:VDD", stock: 900 }),
    )
    const list = await resolvePartName(noOwn, "WS2812B", {})
    expect(list.kind).toBe("ambiguous")
    if (list.kind !== "ambiguous") return
    expect(list.text).toContain("in 2 packages or pinouts")
    expect(list.text).toContain("in another size (C2 vs C3)")
  })
})

describe("records that are not equally good", () => {
  it("prefers a reviewed LCSC record to a user's upload, even one with more pins listed first", async () => {
    const src = candidateSource(
      candidate({ lcsc: "C9900042518", mpn: "MPU6050", match: "exact", userUpload: true, stock: null, pinMap: "1:CLKIN 2:NC 3:VDD 4:GND" }),
      candidate({ lcsc: "C24112", mpn: "MPU-6050", match: "exact", stock: 120, pinMap: "1:CLKIN 2:NC 3:VDD 4:GND" }),
    )
    const out = await resolvePartName(src, "MPU6050", {})
    expect(out).toMatchObject({ kind: "found", part: { lcsc: "C24112" } })
  })

  it("marks a user's upload as lower confidence when it is all there is", async () => {
    const src = candidateSource(candidate({ lcsc: "C9900042518", mpn: "MPU6050", match: "exact", userUpload: true, stock: null, pinMap: "1:CLKIN 2:NC 3:VDD 4:GND" }))
    const out = await resolvePartName(src, "MPU6050", {})
    expect(out.kind).toBe("found")
    if (out.kind !== "found") return
    expect(out.part.provenance.userUpload).toBe(true)
    expect(out.chosen).toContain("an EasyEDA user upload: lower confidence")
  })

  it("drops an unfinished symbol (a DIP-8 drawn with 5 pins) when a finished one exists", async () => {
    const pins = "1:IN1M 2:IN1P 3:GND 4:IN2P 5:IN2M 6:OUT2 7:OUT1 8:VCC"
    const src = candidateSource(
      candidate({ lcsc: "C5157924", mpn: "LM358", match: "exact", package: "DIP-8_L9.8-W6.4-P2.54-LS7.6-BL", pinMap: "1:OUT1 2:IN1M 3:IN1P 4:GND 5:VCC", stock: null }),
      candidate({ lcsc: "C2984960", mpn: "LM358", match: "exact", package: "SOP-8_L4.9-W3.9-P1.27-LS6.0-BL", pinMap: pins, stock: 640 }),
    )
    expect(await resolvePartName(src, "LM358", {})).toMatchObject({ kind: "found", part: { lcsc: "C2984960" } })
  })
})

describe("what the drawing says picks among the choices", () => {
  const led5050 = candidate({ lcsc: "C4", mpn: "WS2812B-A", package: "LED-SMD_4P-L5.0-W5.0-TL", pinMap: "1:VDD 2:DOUT 3:VSS 4:DIN", stock: 10 })
  const led3535 = candidate({ lcsc: "C3", mpn: "WS2812B-B", package: "LED-SMD_4P-L3.5-W3.5-TL", pinMap: "1:VDD 2:DOUT 3:VSS 4:DIN", stock: 900 })

  it("takes the size in a footprint name: 5050 is the 5.0 x 5.0 mm record, not the 3535 that is better stocked", async () => {
    const out = await resolvePartName(candidateSource(led5050, led3535), "WS2812B", { footprint: "led5050" })
    expect(out).toMatchObject({ kind: "found", part: { lcsc: "C4" } })
    const small = await resolvePartName(candidateSource(led5050, led3535), "WS2812B", { footprint: "led_3535" })
    expect(small).toMatchObject({ kind: "found", part: { lcsc: "C3" } })
    // No hint: a choice.
    expect((await resolvePartName(candidateSource(led5050, led3535), "WS2812B", {})).kind).toBe("ambiguous")
  })

  it("takes the records its pins don't contradict: the 5050's numbering is not the 3535's", async () => {
    // The two sizes number their pins differently, and the drawing follows the 5050.
    const other = candidate({ lcsc: "C3", mpn: "WS2812B-B", package: "LED-SMD_4P-L3.5-W3.5-TL", pinMap: "1:DO 2:GND 3:DI 4:VDD", stock: 900 })
    const pins = pinsOf("1:VDD 2:DOUT 3:VSS 4:DIN")
    const out = await resolvePartName(candidateSource(led5050, other), "WS2812B", { pins })
    expect(out).toMatchObject({ kind: "found", part: { lcsc: "C4" } })
  })

  it("says a drawing's pins are wrong when they contradict every package the name could mean", async () => {
    const pins = pinsOf("1:VOUT 2:GND 3:VIN 4:EN 5:SW 6:FB")
    const real = "1:FB 2:EN 3:VIN 4:GND 5:SW 6:VOUT"
    const src = candidateSource(
      candidate({ lcsc: "C919459", mpn: "TPS61023DRLR", package: "SOT-563_L1.6-W1.2-P0.50-LS1.6-BR", pinMap: real, stock: 42690 }),
      candidate({ lcsc: "C1", mpn: "TPS61023DBVR", package: "SOT-23-6_L2.9-W1.6-P0.95-LS2.8-BR", pinMap: real, stock: 300 }),
    )
    const out = await resolvePartName(src, "TPS61023", { pins })
    expect(out.kind).toBe("contradicted")
    if (out.kind !== "contradicted") return
    expect(out.candidate.lcsc).toBe("C919459")
    expect(out.text).toContain("contradict LCSC C919459")
    expect(out.text).toContain("pin 6 is VOUT (a supply output), drawn as FB (a signal)")
    expect(out.text).toContain("The same is true against the other 1 package numbered like it (C1).")
    expect(out.briefs[0]).toMatch(/^\d+ pins? wrong:/)
  })

  it("leaves a drawing with another pin count to the caller: numbers like the name are other parts", async () => {
    const src = candidateSource(candidate({ lcsc: "C919459", mpn: "TPS61023DRLR", pinMap: "1:FB 2:EN 3:VIN 4:GND 5:SW 6:VOUT", pinCount: 6 }))
    const out = await resolvePartName(src, "TPS61023", { pins: pinsOf("1:A 2:B 3:C 4:D 5:E 6:F 7:G 8:H") })
    expect(out.kind).toBe("different")
    if (out.kind !== "different") return
    expect(out.note).toContain("have another pin count than the 8 drawn (C919459 TPS61023DRLR, 6 pins)")
  })
})

describe("what a name cannot resolve to", () => {
  it("is none, plainly, with no candidate at all", async () => {
    expect(await resolvePartName(candidateSource(), "NOSUCH", {})).toEqual({ kind: "none", text: "No supplier record for NOSUCH." })
  })

  it("is none, saying so, when candidates exist but name no pins: never 'no record'", async () => {
    const src = candidateSource(candidate({ lcsc: "C1", mpn: "LM358", match: "exact", hasVendorPinout: false, pins: null, pinCount: 0 }))
    const out = await resolvePartName(src, "LM358", {})
    expect(out).toEqual({ kind: "none", text: "No supplier record for LM358 names its pins (1 found, none with a pinout)." })
    const variants = candidateSource(candidate({ lcsc: "C2", mpn: "LM358DR", hasVendorPinout: false, pins: null, pinCount: 0 }))
    const v = await resolvePartName(variants, "LM358", {})
    expect(v).toEqual({ kind: "none", text: "1 supplier part number is listed under LM358 but none names its pins." })
  })

  it("does not take a part number that only continues the digits for a variant", async () => {
    const src = candidateSource(candidate({ lcsc: "C1", mpn: "INA2191A1IYBJR", match: "related" }))
    expect((await resolvePartName(src, "INA219", {})).kind).toBe("none")
  })
})
