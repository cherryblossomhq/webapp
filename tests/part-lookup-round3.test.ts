import { describe, expect, it } from "vitest"
import { resolvePartName } from "../src/ai/partLookup"
import { verifyProjectParts } from "../src/ai/partTools"
import { executeTool } from "../src/ai/tools"
import { customPartId, registerProjectParts } from "../src/model/customParts"
import { addComponent, createProject } from "../src/model/ops"
import { partFindings } from "../src/model/partChecks"
import type { CustomPartSpec, Project } from "../src/model/types"
import { candidate, candidateSource, pinsOf } from "./fixtures/supplier/candidates"
import { PRODUCTION_PARTS } from "./fixtures/supplier/production"
import { recordedSource } from "./fixtures/supplier/source"

// Review round 3: a blank exact record must not let wrong pins through, signal-only differences
// must not merge into one part, a user's upload must not outrank a reviewed record, and a ranking
// must not call the first listed "best stocked" when no stock is known. Hand-built supplier
// answers, no network.

const TPS = production("TPS61023")
const SOT563 = "SOT-563_L1.6-W1.2-P0.50-LS1.6-BR"
const REAL = "1:FB 2:EN 3:VIN 4:GND 5:SW 6:VOUT"

function production(name: string) {
  return PRODUCTION_PARTS.find((p) => p.name === name)!
}

/** The search answer of the repro: an exact TPS61023 record that names no pins, and the real, pinned DRLR. */
const blankExactSource = () =>
  candidateSource(
    candidate({ lcsc: "C1", mpn: "TPS61023", match: "exact", package: SOT563, hasVendorPinout: false, hasVendorLand: false, pins: null, pinCount: 0, stock: 120 }),
    candidate({ lcsc: "C919459", mpn: "TPS61023DRLR", package: SOT563, pinMap: REAL, stock: 42690 }),
  )

describe("a record numbered exactly like the name that names no pins", () => {
  it("still refuses the production TPS61023 pins, checked against the pinned variant of the same package", async () => {
    const out = await resolvePartName(blankExactSource(), "TPS61023", { pins: TPS.pins, footprint: "sot563" })
    expect(out.kind).toBe("contradicted")
    if (out.kind !== "contradicted") return
    expect(out.candidate.lcsc).toBe("C919459")
    expect(out.text).toContain("The 1 supplier record numbered exactly TPS61023 names no pins")
    expect(out.text).toContain("pin 6 is VOUT (a supply output), drawn as VIN (a supply input)")
    expect(out.briefs[0]).toMatch(/^\d+ pins? wrong:/)
  })

  it("is refused by create_part, with or without from_memory, and never made from memory", async () => {
    const input = { name: "TPS61023", description: "boost", category: "Power", pins: TPS.pins, footprint: "sot563" }
    for (const extra of [{}, { from_memory: true }]) {
      const project = createProject("p")
      const out = await executeTool(project, () => project, "create_part", { ...input, ...extra }, { parts: blankExactSource() })
      expect(out.isError).toBe(true)
      expect(out.project.parts).toBeUndefined()
      expect(out.result).toContain("pin 6 is VOUT (a supply output), drawn as VIN (a supply input)")
      expect(out.result).not.toContain("names its pins (1 found")
      expect(out.result).toContain("C919459")
    }
  })

  it("is `contradicted` in verify_parts, never `no_record`", async () => {
    const draft: Omit<CustomPartSpec, "id"> = { name: "TPS61023", description: "", category: "ICs", refPrefix: "U", footprint: "sot563", pins: TPS.pins, props: { mpn: "TPS61023" } }
    const spec: CustomPartSpec = { id: customPartId(draft), ...draft }
    const project: Project = { ...createProject("legacy"), parts: [spec] }
    registerProjectParts(project)
    const placed = addComponent(project, spec.id).project
    const { results } = await verifyProjectParts(placed, blankExactSource())
    expect(results.get(spec.id)).toMatchObject({ verdict: "contradicted", lcsc: "C919459" })
    const out = await executeTool(placed, () => placed, "verify_parts", {}, { parts: blankExactSource() })
    expect(out.result).toContain("contradicted against LCSC C919459")
    expect(out.result).not.toMatch(/no supplier record/i)
    expect(partFindings(out.project)[0].severity).toBe("error")
  })

  it("does not say 'no record' or 'names its pins' when a pinned variant exists, and builds nothing from it", async () => {
    const out = await resolvePartName(blankExactSource(), "TPS61023", {})
    expect(out.kind).toBe("none")
    if (out.kind !== "none") return
    expect(out.text).not.toContain("none with a pinout")
    expect(out.text).not.toMatch(/^No supplier record for TPS61023/)
    expect(out.text).toContain("C919459 TPS61023DRLR")
    expect(out.text).toContain("Pass lcsc")
  })

  it("says the drawn pins are not contradicted, without resolving the name, when they agree", async () => {
    const good = pinsOf(REAL)
    const out = await resolvePartName(blankExactSource(), "TPS61023", { pins: good.map((p) => ({ number: p.number, name: p.name })), footprint: "sot563" })
    expect(out.kind).toBe("none")
    if (out.kind !== "none") return
    expect(out.text).toContain("do not contradict it")
  })

  it("leaves another size alone: WS2812B-2020 does not check a WS2812B's pins", async () => {
    const src = candidateSource(
      candidate({ lcsc: "C1", mpn: "WS2812B", match: "exact", package: "LED-SMD_4P-L5.0-W5.0-TL", hasVendorPinout: false, pins: null, pinCount: 4, stock: 10 }),
      candidate({ lcsc: "C2", mpn: "WS2812B-2020", package: "LED-SMD_4P-L2.0-W2.0-TL", pinMap: "1:DO 2:GND 3:DI 4:VDD", stock: 900 }),
    )
    const pins = pinsOf("1:VDD 2:DOUT 3:VSS 4:DIN").map((p) => ({ number: p.number, name: p.name }))
    const out = await resolvePartName(src, "WS2812B", { pins })
    expect(out).toEqual({ kind: "none", text: "No supplier record for WS2812B names its pins (1 found, none with a pinout)." })
  })

  it("keeps the plain sentence only when nothing pinned exists", async () => {
    const src = candidateSource(candidate({ lcsc: "C1", mpn: "LM358", match: "exact", hasVendorPinout: false, pins: null, pinCount: 0 }))
    expect(await resolvePartName(src, "LM358", {})).toEqual({ kind: "none", text: "No supplier record for LM358 names its pins (1 found, none with a pinout)." })
  })

  it("is read from the recorded answers too: a blank exact record would not hide the DRLR", async () => {
    const recorded = recordedSource()
    const real = await recorded.search("TPS61023")
    const withBlank = {
      ...recorded,
      search: async () => ({ ...real, candidates: [candidate({ lcsc: "C1", mpn: "TPS61023", match: "exact" as const, package: SOT563, hasVendorPinout: false, pins: null, pinCount: 0 }), ...real.candidates] }),
    }
    const out = await resolvePartName(withBlank, "TPS61023", { pins: TPS.pins, footprint: "sot563" })
    expect(out.kind).toBe("contradicted")
  })
})

describe("variants that differ only in a signal", () => {
  const PKG = "SOIC-8_L4.9-W3.9-P1.27-LS6.0-BL"

  it("are a list, not one part: SDA and SCL swapped, with the differing pins spelled out", async () => {
    const src = candidateSource(
      candidate({ lcsc: "C1", mpn: "XYZ200A", package: PKG, pinMap: "1:VDD 2:SDA 3:SCL 4:GND 5:ALERT 6:A0 7:A1 8:A2", stock: 900 }),
      candidate({ lcsc: "C2", mpn: "XYZ200B", package: PKG, pinMap: "1:VDD 2:SCL 3:SDA 4:GND 5:ALERT 6:A0 7:A1 8:A2", stock: 500 }),
    )
    const out = await resolvePartName(src, "XYZ200", {})
    expect(out.kind).toBe("ambiguous")
    if (out.kind !== "ambiguous") return
    expect(out.candidates.map((c) => c.lcsc)).toEqual(["C1", "C2"])
    expect(out.text).toContain("pin 2 is SCL on C2 but SDA on C1")
    expect(out.text).toContain("pin 3 is SDA on C2 but SCL on C1")
  })

  it("still merge when only a name is spelled another way: OD and DOUT, TEMP and TS, VDD and VCC", async () => {
    const src = candidateSource(
      candidate({ lcsc: "C1", mpn: "XYZ300A", package: PKG, pinMap: "1:OD 2:VM 3:OC 4:NC 5:VCC 6:GND", stock: 900 }),
      candidate({ lcsc: "C2", mpn: "XYZ300B", package: PKG, pinMap: "1:DOUT 2:CSI 3:COUT 4:NC 5:VDD 6:VSS", stock: 500 }),
    )
    const out = await resolvePartName(src, "XYZ300", {})
    expect(out).toMatchObject({ kind: "found", part: { lcsc: "C1" } })
    if (out.kind !== "found") return
    expect(out.family).toHaveLength(2)
    // The sentence is literally true: the same package, the same function on every pin number.
    expect(out.chosen).toContain("with the same package and the same function on every pin number")
  })

  it("name the pins that differ in a two-way list, never a bare 'pin roles'", async () => {
    const src = candidateSource(
      candidate({ lcsc: "C1", mpn: "XYZ400A", package: PKG, pinMap: "1:VDD 2:EN 3:SDA 4:SCL 5:GND 6:A0 7:A1 8:A2", stock: 900 }),
      candidate({ lcsc: "C2", mpn: "XYZ400B", package: PKG, pinMap: "1:VDD 2:EN 3:SCL 4:SDA 5:GND 6:A0 7:A1 8:A2", stock: 100 }),
    )
    const out = await resolvePartName(src, "XYZ400", {})
    expect(out.kind).toBe("ambiguous")
    if (out.kind !== "ambiguous") return
    expect(out.text).toContain("They differ in: pin names or roles (pin 3 is SCL on C2 but SDA on C1; pin 4 is SDA on C2 but SCL on C1)")
  })
})

describe("an EasyEDA user upload against a reviewed record", () => {
  const UPLOAD = (over: object = {}) => candidate({ lcsc: "C9900042518", mpn: "ADS1115", match: "exact", userUpload: true, stock: null, pinMap: "1:ADDR 2:ALERT 3:GND 4:AIN0 5:AIN1 6:AIN2 7:AIN3 8:VDD 9:SDA 10:SCL", package: "VSSOP-10_L3.0-W3.0-P0.50-LS4.9-BL", ...over })

  it("loses to a reviewed, stocked variant even when the upload is the exact name", async () => {
    const src = candidateSource(UPLOAD(), candidate({ lcsc: "C37593", mpn: "ADS1115IDGSR", stock: 4800, pinMap: "1:ADDR 2:ALERT/RDY 3:GND 4:AIN0 5:AIN1 6:AIN2 7:AIN3 8:VDD 9:SDA 10:SCL", package: "VSSOP-10_L3.0-W3.0-P0.50-LS4.9-BL" }))
    const out = await resolvePartName(src, "ADS1115", {})
    expect(out.kind).toBe("found")
    if (out.kind !== "found") return
    expect(out.part.lcsc).toBe("C37593")
    expect(out.part.provenance.userUpload).toBeUndefined()
    expect(out.chosen).toContain("An EasyEDA user upload spelled like the name (C9900042518) was not used: a reviewed record outranks it.")
  })

  it("is kept as the fallback when nothing reviewed exists", async () => {
    const out = await resolvePartName(candidateSource(UPLOAD()), "ADS1115", {})
    expect(out).toMatchObject({ kind: "found", part: { lcsc: "C9900042518" } })
    if (out.kind !== "found") return
    expect(out.chosen).toContain("an EasyEDA user upload: lower confidence")
  })

  it("is dropped from the choices when a reviewed record sits beside it in another package", async () => {
    const src = candidateSource(
      UPLOAD({ package: "WLCSP-12_L1.4-W1.9-P0.40-TL" }),
      candidate({ lcsc: "C37593", mpn: "ADS1115IDGSR", match: "exact", stock: null, pinMap: "1:ADDR 2:ALERT/RDY 3:GND 4:AIN0 5:AIN1 6:AIN2 7:AIN3 8:VDD 9:SDA 10:SCL", package: "VSSOP-10_L3.0-W3.0-P0.50-LS4.9-BL" }),
    )
    const out = await resolvePartName(src, "ADS1115", {})
    expect(out).toMatchObject({ kind: "found", part: { lcsc: "C37593" } })
  })
})

describe("when stock is unknown for every record", () => {
  const SOIC = "SOIC-8_L4.9-W3.9-P1.27-LS6.0-BL"
  const ODD = "XYZ-8_L3.0-W3.0-P0.65-BL"
  const pins = "1:VDD 2:SDA 3:SCL 4:GND 5:A0 6:A1 7:A2 8:ALERT"

  it("never says 'best stocked': it says the stock is unknown, and lists the most common package first", async () => {
    const src = candidateSource(
      candidate({ lcsc: "C1", mpn: "XYZ500A", package: ODD, pinMap: pins, stock: null }),
      candidate({ lcsc: "C2", mpn: "XYZ500B", package: SOIC, pinMap: pins, stock: null }),
      candidate({ lcsc: "C3", mpn: "XYZ500C", package: SOIC, pinMap: pins, stock: null, hasVendorLand: false }),
    )
    const out = await resolvePartName(src, "XYZ500", {})
    expect(out.kind).toBe("ambiguous")
    if (out.kind !== "ambiguous") return
    // The SOIC-8 (a package with a footprint of its own, and the one most candidates come in) is first.
    expect(out.candidates.map((c) => c.lcsc)).toEqual(["C2", "C1"])
    expect(out.text).not.toContain("the first listed is the best stocked")
    expect(out.text).toContain("stock unknown")
    expect(out.text).toContain("the stock of none of them is known, so the first listed is only the most common package, not the best stocked")
  })

  it("says so in a resolved part too: the first of N, stock unknown for all", async () => {
    const src = candidateSource(
      candidate({ lcsc: "C1", mpn: "XYZ600A", package: SOIC, pinMap: pins, stock: null }),
      candidate({ lcsc: "C2", mpn: "XYZ600B", package: SOIC, pinMap: pins, stock: null }),
    )
    const out = await resolvePartName(src, "XYZ600", {})
    expect(out.kind).toBe("found")
    if (out.kind !== "found") return
    expect(out.chosen).not.toContain("best stocked")
    expect(out.chosen).toContain("(SOIC-8, stock unknown)")
    expect(out.chosen).toContain("the first of 2 supplier part numbers")
    expect(out.chosen).toContain("stock is unknown for all of them")
  })

  it("keeps 'best stocked' when some stock is known", async () => {
    const src = candidateSource(
      candidate({ lcsc: "C1", mpn: "XYZ700A", package: ODD, pinMap: pins, stock: null }),
      candidate({ lcsc: "C2", mpn: "XYZ700B", package: SOIC, pinMap: pins, stock: 40 }),
    )
    // The package with stock is the choice; the one nobody stocks is only said.
    const out = await resolvePartName(src, "XYZ700", {})
    expect(out).toMatchObject({ kind: "found", part: { lcsc: "C2" } })
  })

  it("brings in the stocked variants when the exact record's stock is unknown: the WS2812B's 5.0 mm part is listed, first", async () => {
    // Recorded 2026-10-20: the exact records are a 3535 and two uploads with no stock, and the
    // standard 5050 WS2812B-B/T (30155 in stock) is a prefix match that used to never appear.
    const out = await resolvePartName(recordedSource(), "WS2812B", {})
    expect(out.kind).toBe("ambiguous")
    if (out.kind !== "ambiguous") return
    expect(out.candidates[0]).toMatchObject({ lcsc: "C2761795", stock: 30155 })
    expect(out.candidates.every((c) => !c.userUpload)).toBe(true)
    expect(out.text).toContain("the first listed is the best stocked")
  })
})

describe("what differs is spelled out among every choice", () => {
  it("names the pins that tell two variants of one package apart, not only the first against the rest", async () => {
    const SOIC = "SOIC-8_L4.9-W3.9-P1.27-LS6.0-BL"
    const SOT = "SOT-23-8_L2.9-W1.6-P0.65-LS2.8-BL"
    const src = candidateSource(
      candidate({ lcsc: "C1", mpn: "XYZ800A", package: SOIC, pinMap: "1:VDD 2:SDA 3:SCL 4:GND 5:A0 6:A1 7:A2 8:ALERT", stock: 900 }),
      candidate({ lcsc: "C2", mpn: "XYZ800B", package: SOT, pinMap: "1:VDD 2:SDA 3:SCL 4:GND 5:A0 6:A1 7:A2 8:ALERT", stock: 500 }),
      candidate({ lcsc: "C3", mpn: "XYZ800C", package: SOT, pinMap: "1:VDD 2:SCL 3:SDA 4:GND 5:A0 6:A1 7:A2 8:ALERT", stock: 100 }),
    )
    const out = await resolvePartName(src, "XYZ800", {})
    expect(out.kind).toBe("ambiguous")
    if (out.kind !== "ambiguous") return
    expect(out.text).toContain("pin 2 is SCL on C3 but SDA on C2")
  })
})
