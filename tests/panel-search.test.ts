import { describe, expect, it } from "vitest"
import { customPartId, registerProjectParts } from "../src/model/customParts"
import { addComponent, createProject, updateComponent } from "../src/model/ops"
import { partFindings } from "../src/model/partChecks"
import { partSourceLine } from "../src/model/partSource"
import { draftFromSupplierPart } from "../src/model/supplierPart"
import type { CustomPartSpec, PartSource, Project } from "../src/model/types"
import { createCheckQueue, isWildcardOf, looksLikePartNumber, matchNote, wantsSupplier, worthChecking } from "../src/panels/partSearch"
import { recordedPart } from "./fixtures/supplier/source"

// Library panel decisions that are plain functions: which hits keep LCSC from being offered, what
// looks like a part number, the queue that runs background checks, and the source line and category
// of the parts the panel adds.

describe("a family hit and the supplier", () => {
  const settled = { query: "NE555PW", databaseSettled: true, libraryHasIt: false }

  it("still offers LCSC beside an ordering-letter family hit, which may be another package", () => {
    expect(wantsSupplier({ ...settled, hits: [{ match: "family", mpn: "NE555P" }] })).toBe(true)
  })

  it("leaves LCSC alone for a KiCad wildcard the query fills", () => {
    expect(wantsSupplier({ ...settled, query: "STM32F103C8T6", hits: [{ match: "family", mpn: "STM32F103C8Tx" }] })).toBe(false)
    expect(wantsSupplier({ ...settled, query: "STM32F103C8T6", hits: [{ match: "family", mpn: "STM32F103C8T" }] })).toBe(true)
    expect(isWildcardOf("ATmega328P-AU", "ATmega328P-xU")).toBe(false)
    expect(isWildcardOf("STM32F103C8T6", "STM32F103C8Tx")).toBe(true)
    expect(isWildcardOf("STM32F103C8T66", "STM32F103C8Tx")).toBe(false)
    expect(isWildcardOf("STM32F103C8T6", "STM32F103C8Txxx")).toBe(false)
    expect(isWildcardOf("STM32F103C6U", "STM32F103C8Tx")).toBe(false)
  })

  it("still leaves it alone for exact and prefix hits", () => {
    for (const match of ["exact", "prefix"] as const) expect(wantsSupplier({ ...settled, hits: [{ match, mpn: "NE555PW" }] })).toBe(false)
  })

  it("tells the package only on an ordering-letter family hit", () => {
    expect(matchNote("family", false)).toBe("Same family, check the package")
    expect(matchNote("family", true)).toBeNull()
  })
})

describe("what looks like a part number", () => {
  it("keeps real part numbers", () => {
    for (const q of ["74HC00", "1N4148", "NE555PW", "STM32F103C8T6", "AMS1117-3.3", "TPS61023DRLR", "74F00", "C919459", "2N3904", "U.FL-R-SMT-1"]) {
      expect(looksLikePartNumber(q), q).toBe(true)
    }
  })

  it("leaves out sizes, units, codes and packages", () => {
    for (const q of ["12mm", "M3x10", "10uF0805", "R010", "2.2uF", "100nF", "4k7", "0.5x3mm", "1206", "SOT-23", "SOIC8", "TO-220", "QFN-16", "C12", "10kohm"]) {
      expect(looksLikePartNumber(q), q).toBe(false)
    }
  })
})

describe("background checks of placed parts", () => {
  const spec = (name: string, source?: PartSource): CustomPartSpec => ({ id: name, name, description: "", category: "ICs", refPrefix: "U", footprint: "soic8", pins: [], props: { mpn: name }, source })

  it("skips a KiCad wildcard name and a part that already has a check", () => {
    expect(worthChecking(spec("STM32F103C8T6"))).toBe(true)
    expect(worthChecking(spec("STM32F103C8Tx"))).toBe(false)
    expect(worthChecking(spec("ATSAMD21E1xA"))).toBe(true)
    expect(worthChecking(spec("NE555", { pins: "database", land: "database", check: { at: "x", lcsc: "C1", verdict: "agrees", findings: [] } }))).toBe(false)
  })

  it("runs one at a time, in order, and drops what is past the backlog", async () => {
    const queue = createCheckQueue(2)
    let active = 0
    let most = 0
    const ran: number[] = []
    const gates: (() => void)[] = []
    const job = (n: number) => () =>
      new Promise<void>((resolve) => {
        active++
        most = Math.max(most, active)
        ran.push(n)
        gates.push(() => {
          active--
          resolve()
        })
      })
    // The first starts at once; two wait; the fourth is dropped.
    expect([1, 2, 3, 4].map((n) => queue.push(job(n)))).toEqual([true, true, true, false])
    for (let i = 0; i < 3; i++) {
      await new Promise((r) => setTimeout(r, 0))
      gates[i]()
    }
    await new Promise((r) => setTimeout(r, 0))
    expect(ran).toEqual([1, 2, 3])
    expect(most).toBe(1)
  })

  it("goes on after a check that throws", async () => {
    const queue = createCheckQueue()
    const ran: number[] = []
    queue.push(() => Promise.reject(new Error("boom")))
    queue.push(async () => void ran.push(2))
    await new Promise((r) => setTimeout(r, 0))
    expect(ran).toEqual([2])
  })
})

describe("the source line of a part built from the database", () => {
  const easyeda: PartSource = {
    pins: "database",
    land: "database",
    database: { origin: "easyeda", key: "C123", licence: "EasyEDA terms", attribution: "Pins, land patterns and 3D models from the JLCEDA/EasyEDA Official Library (easyeda.com)." },
  }
  const spec = (source: PartSource): CustomPartSpec => ({ id: "x", name: "X", description: "", category: "ICs", refPrefix: "U", footprint: "soic8", pins: [], props: {}, source })

  it("names a stored supplier record and gives its credit", () => {
    expect(partSourceLine(spec(easyeda))).toEqual({
      label: "LCSC C123",
      detail: "A supplier record the parts database kept",
      credit: "Pins, land patterns and 3D models from the JLCEDA/EasyEDA Official Library (easyeda.com). Licence: EasyEDA terms.",
    })
  })

  it("says in a few words that a part disagrees with LCSC", () => {
    const line = partSourceLine(spec({ ...easyeda, check: { at: "x", lcsc: "C919459", verdict: "contradicted", findings: [] } }))
    expect(line?.detail).toContain("Disagrees with LCSC C919459")
    const kicad = partSourceLine(
      spec({ pins: "database", land: "database", database: { origin: "kicad", key: "Lib:X", licence: "CC", attribution: "KiCad" }, check: { at: "x", lcsc: "C5", verdict: "contradicted", findings: [] } }),
    )
    expect(kicad?.label).toBe("KiCad library")
    expect(kicad?.detail).toContain("Disagrees with LCSC C5")
  })
})

describe("a swapped footprint on a stored part", () => {
  const swapped = (source: PartSource): Project => {
    const d: Omit<CustomPartSpec, "id"> = { name: "X1", description: "", category: "ICs", refPrefix: "U", footprint: "soic8", pins: [], props: { mpn: "X1" }, source }
    const spec = { id: customPartId(d), ...d }
    const p: Project = { ...createProject("p"), parts: [spec] }
    registerProjectParts(p)
    const added = addComponent(p, spec.id)
    return updateComponent(added.project, added.component.id, { footprint: "soic16" })
  }

  it("says its stored land for a database part and the supplier's land for the rest", () => {
    const stored = partFindings(swapped({ pins: "database", land: "database", database: { origin: "kicad", key: "L:X", licence: "", attribution: "" } }))
    expect(stored[0].message).toContain("its stored land")
    const supplier = partFindings(swapped({ pins: "supplier", land: "supplier", supplier: { lcsc: "C1", mpn: "X", confidence: "curated", vendors: 1, fetchedAt: "x" } }))
    expect(supplier[0].message).toContain("the supplier's land")
  })
})

describe("the category guessed from a supplier's words", () => {
  const categoryOf = (description: string) => {
    const part = recordedPart("C919459")
    part.description = description
    part.mpn = "XYZ123"
    const built = draftFromSupplierPart(part)
    if ("error" in built) throw new Error(built.error)
    return built.draft.category
  }

  it("lets the chip's own word win over the device it works with", () => {
    expect(categoryOf("MOSFET driver, 4A")).toBe("ICs")
    expect(categoryOf("LED driver 1A")).toBe("ICs")
    expect(categoryOf("Battery charge controller for diode OR-ing")).toBe("ICs")
    expect(categoryOf("Zener voltage regulator")).toBe("Power")
  })

  it("still reads plain devices", () => {
    expect(categoryOf("N-channel MOSFET 30V")).toBe("Transistors")
    expect(categoryOf("Schottky diode 1A")).toBe("Diodes")
    expect(categoryOf("Chip resistor 10k")).toBe("Passives")
    expect(categoryOf("Boost converter 5V")).toBe("Power")
  })
})
