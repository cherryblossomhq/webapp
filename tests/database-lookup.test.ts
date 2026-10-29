import type { PartIndexHit, PartIndexMatch, PartIndexPart, PartIndexSearchResponse } from "@cherryblossom/api-contract"
import { join } from "node:path"
import { beforeAll, describe, expect, it } from "vitest"
import { isWildcardOf, resolveStored } from "../src/ai/databaseLookup"
import type { PartsIndexSource, SupplierPartsSource } from "../src/ai/supplierParts"
import { executeTool } from "../src/ai/tools"
import { convertLibraries, type Imported } from "../src/model/kicad/library"
import { addComponent, createProject } from "../src/model/ops"
import { needsCheck, partFindings } from "../src/model/partChecks"
import { candidate, candidateSource } from "./fixtures/supplier/candidates"

// The parts database in Sakura's part tools: stored parts (KiCad's libraries here) listed by
// find_part, read by get_part_data, built by create_part by id, and by name when the supplier has no
// part or its lookup fails, so a part the database has is never written from memory.

const FIXTURES = join(__dirname, "fixtures", "kicad")

let imported: Imported
beforeAll(async () => {
  imported = await convertLibraries({ symbols: join(FIXTURES, "symbols"), footprints: join(FIXTURES, "footprints"), release: "10.0.7" })
})

/** A converted fixture part as `GET /api/v1/parts/index/{id}` answers it. */
function stored(key: string, id: string): PartIndexPart {
  const row = imported.parts.find((p) => p.key === key)
  const land = imported.lands.find((l) => l.key === row?.landKey)
  if (!row || !land) throw new Error(`${key} isn't in the converted fixtures`)
  return {
    id,
    source: "kicad",
    sourceKey: row.key,
    mpn: row.name,
    manufacturer: null,
    package: row.package,
    description: row.description || null,
    datasheet: row.datasheet,
    lcsc: null,
    keywords: row.keywords,
    refPrefix: row.refPrefix,
    category: row.category,
    pins: row.pins,
    land: land.land,
    verification: null,
    model3d: null,
    provenance: {
      converter: "kicad@2",
      release: row.release,
      footprint: row.footprintKey,
      licence: "CC-BY-SA-4.0 WITH KiCad-libraries-exception",
      attribution: "KiCad credit",
      fetchedAt: "2026-10-22T00:00:00.000Z",
    },
  }
}

const hitOf = (part: PartIndexPart, match: PartIndexMatch): PartIndexHit => ({
  id: part.id,
  source: part.source,
  sourceKey: part.sourceKey,
  mpn: part.mpn,
  manufacturer: part.manufacturer,
  package: part.package,
  category: part.category,
  description: part.description,
  lcsc: part.lcsc,
  stock: null,
  pinCount: part.pins.length,
  datasheet: part.datasheet,
  verification: part.verification,
  match,
  assets: ["symbol", "footprint"],
  hasRecord: true,
  fetchedAt: "2026-10-22T00:00:00.000Z",
})

/** A database that answers every search with `hits` and reads the parts given. */
function database(parts: PartIndexPart[], hits: PartIndexHit[]): PartsIndexSource & { reads: string[] } {
  const reads: string[] = []
  return {
    reads,
    search: async (query): Promise<PartIndexSearchResponse> => ({ query, hits, attribution: ["KiCad credit"] }),
    part: async (id) => {
      reads.push(id)
      return parts.find((p) => p.id === id) ?? null
    },
  }
}

const failing = (message: string): SupplierPartsSource => ({
  search: async () => {
    throw new Error(message)
  },
  part: async () => {
    throw new Error(message)
  },
})

const nothing = (): SupplierPartsSource => candidateSource()

/** A supplier whose records come with a land (the candidates' records have none). */
const landed = (source: SupplierPartsSource, land: PartIndexPart["land"]): SupplierPartsSource => ({
  ...source,
  part: async (lcsc) => {
    const part = await source.part(lcsc)
    return part && { ...part, land: { ...land, from: lcsc } }
  },
})

/** The supplier's pins for a stored part, as `1:NAME 2:NAME`, with two of them swapped when asked. */
const pinMapOf = (part: PartIndexPart, swap?: [string, string]) =>
  part.pins
    .map((p) => {
      const name = swap && p.number === swap[0] ? part.pins.find((q) => q.number === swap[1])!.name : swap && p.number === swap[1] ? part.pins.find((q) => q.number === swap[0])!.name : p.name
      return `${p.number}:${name.replace(/\s+/g, "")}`
    })
    .join(" ")

describe("what a stored name is", () => {
  it("fills a KiCad wildcard, and only to its length", () => {
    expect(isWildcardOf("STM32F103C8T6", "STM32F103C8Tx")).toBe(true)
    expect(isWildcardOf("stm32f103c8t6", "STM32F103C8Tx")).toBe(true)
    expect(isWildcardOf("STM32F103C8T", "STM32F103C8Tx")).toBe(false)
    expect(isWildcardOf("STM32F103C8T66", "STM32F103C8Tx")).toBe(false)
    // Ordering letters are not a wildcard.
    expect(isWildcardOf("NE555PW", "NE555P")).toBe(false)
    expect(isWildcardOf("MAX232X", "MAX232X")).toBe(false)
  })

  it("is the part for an exact name, and reads it whole", async () => {
    const ldo = stored("Regulator_Linear:AMS1117-3.3", "7")
    const db = database([ldo], [hitOf(ldo, "exact")])
    const out = await resolveStored(db, "AMS1117-3.3", {})
    expect(out.kind).toBe("found")
    if (out.kind !== "found") return
    expect(out.part.sourceKey).toBe("Regulator_Linear:AMS1117-3.3")
    expect(out.note).toBe("Built from the KiCad library part Regulator_Linear:AMS1117-3.3.")
  })

  it("is the part through KiCad's wildcard", async () => {
    const mcu = stored("MCU_ST_STM32F1:STM32F103C8Tx", "9")
    const out = await resolveStored(database([mcu], [hitOf(mcu, "family")]), "STM32F103C8T6", {})
    expect(out).toMatchObject({ kind: "found", note: expect.stringContaining("whose symbol covers STM32F103C8T6") })
  })

  it("only offers a number less its ordering letters, which can be another package", async () => {
    // ATtiny85-20P is the DIP: ATtiny85-20PU is too, but nothing here says so, and SU would be SOIC.
    const dip = stored("MCU_Microchip_ATtiny:ATtiny85-20P", "11")
    const db = database([dip], [hitOf(dip, "family")])
    const out = await resolveStored(db, "ATtiny85-20PU", {})
    expect(out.kind).toBe("offered")
    if (out.kind !== "offered") return
    expect(out.text).toContain("database_id 11: ATtiny85-20P")
    expect(out.text).toContain("may be another package of it")
    expect(db.reads).toEqual([])
  })

  it("builds a number less its ordering letters when the drawing names the same package", async () => {
    const dip = stored("MCU_Microchip_ATtiny:ATtiny85-20P", "11")
    const out = await resolveStored(database([dip], [hitOf(dip, "family")]), "ATtiny85-20PU", { footprint: "dip8" })
    expect(out).toMatchObject({ kind: "found", note: expect.stringContaining("the same package as the one named") })
    // A SOIC drawing doesn't make the DIP the part.
    const soic = await resolveStored(database([dip], [hitOf(dip, "family")]), "ATtiny85-20SU", { footprint: "soic8" })
    expect(soic.kind).toBe("offered")
  })

  it("lists a name stored in two packages instead of picking one", async () => {
    const ldo = stored("Regulator_Linear:AMS1117-3.3", "7")
    const other = { ...stored("MCU_Microchip_ATtiny:ATtiny85-20P", "11"), mpn: "AMS1117-3.3" }
    const out = await resolveStored(database([ldo, other], [hitOf(ldo, "exact"), hitOf(other, "exact")]), "AMS1117-3.3", {})
    expect(out.kind).toBe("offered")
    if (out.kind !== "offered") return
    expect(out.text).toContain("AMS1117-3.3 is stored as 2 different parts")
    expect(out.text).toContain("database_id 7")
    expect(out.text).toContain("database_id 11")
  })

  it("refuses pins that contradict the stored part", async () => {
    const ldo = stored("Regulator_Linear:AMS1117-3.3", "7")
    const wrong = ldo.pins.map((p) => ({ number: p.number, name: p.name === "GND" ? "VI" : p.name === "VI" ? "GND" : p.name }))
    const out = await resolveStored(database([ldo], [hitOf(ldo, "exact")]), "AMS1117-3.3", { pins: wrong })
    expect(out.kind).toBe("contradicted")
  })
})

describe("create_part with the parts database", () => {
  const base = { description: "LDO", category: "Power" }

  it("builds from the database, not memory, when the supplier lookup fails", async () => {
    const ldo = stored("Regulator_Linear:AMS1117-3.3", "7")
    const parts: SupplierPartsSource = { ...failing("The supplier is busy. Try again in a moment."), index: database([ldo], [hitOf(ldo, "exact")]) }
    const project = createProject("p")
    const out = await executeTool(project, () => project, "create_part", { ...base, name: "AMS1117-3.3" }, { parts })
    expect(out.isError).toBeFalsy()
    const spec = out.project.parts?.[0]
    expect(spec?.source).toMatchObject({ pins: "database", database: { origin: "kicad", key: "Regulator_Linear:AMS1117-3.3" } })
    expect(spec?.source?.note).toBeUndefined()
    expect(out.result).toContain("The supplier lookup failed (The supplier is busy. Try again in a moment)")
    expect(out.result).toContain("Built from the KiCad library part Regulator_Linear:AMS1117-3.3.")
    expect(out.result).not.toContain("UNVERIFIED")
  })

  it("builds from the database when the supplier has no part numbered like the name", async () => {
    const mcu = stored("MCU_ST_STM32F1:STM32F103C8Tx", "9")
    const parts: SupplierPartsSource = { ...nothing(), index: database([mcu], [hitOf(mcu, "family")]) }
    const project = createProject("p")
    const out = await executeTool(project, () => project, "create_part", { description: "MCU", category: "ICs", name: "STM32F103C8T6" }, { parts })
    expect(out.isError).toBeFalsy()
    expect(out.project.parts?.[0].source?.database?.key).toBe("MCU_ST_STM32F1:STM32F103C8Tx")
    // A KiCad wildcard is drawn for a family of numbers: the one asked for is the part's number, the one to order.
    expect(out.project.parts?.[0].name).toBe("STM32F103C8T6")
    expect(out.project.parts?.[0].props.mpn).toBe("STM32F103C8T6")
  })

  it("asks to choose rather than falling back to memory when only another package may be stored", async () => {
    const dip = stored("MCU_Microchip_ATtiny:ATtiny85-20P", "11")
    const parts: SupplierPartsSource = { ...nothing(), index: database([dip], [hitOf(dip, "family")]) }
    const project = createProject("p")
    const out = await executeTool(project, () => project, "create_part", { description: "MCU", category: "ICs", name: "ATtiny85-20SU" }, { parts })
    expect(out.isError).toBe(true)
    expect(out.project.parts).toBeUndefined()
    expect(out.result).toContain("database_id 11: ATtiny85-20P")
    expect(out.result).toContain("If none of them is the part, pass from_memory true with pins and footprint (or land).")
  })

  it("builds the exact stored part over a shorter number in the drawn package, and says the package", async () => {
    // NE555P is the DIP whatever footprint Sakura remembered; the shorter number in a SOIC is not it.
    const dip = stored("MCU_Microchip_ATtiny:ATtiny85-20P", "11")
    const soic = { ...dip, id: "12", sourceKey: "MCU_Microchip_ATtiny:ATtiny85-20", mpn: "ATtiny85-20", package: "SOIC-8_3.9x4.9mm_P1.27mm" }
    const out = await resolveStored(database([dip, soic], [hitOf(dip, "exact"), hitOf(soic, "family")]), "ATtiny85-20P", { footprint: "soic8" })
    expect(out.kind).toBe("found")
    if (out.kind !== "found") return
    expect(out.part.id).toBe("11")
    expect(out.note).toContain("It is DIP-8_W7.62mm, not the soic8 named")
  })

  it("builds a stored LCSC record of an orderable number of the name when the supplier is busy", async () => {
    const kicad = stored("Regulator_Switching:TPS61040DRV", "21")
    const kept: PartIndexPart = {
      ...kicad,
      source: "easyeda",
      sourceKey: "C1852149",
      mpn: "TPS61040DRVR",
      lcsc: "C1852149",
      verification: "consensus",
      provenance: { converter: "easyeda@1", licence: "LicenseRef-EasyEDA-Library", attribution: "EasyEDA credit", fetchedAt: "2026-10-22T00:00:00.000Z" },
    }
    const parts: SupplierPartsSource = { ...failing("Parts lookup limit reached."), index: database([kept], [hitOf(kept, "prefix")]) }
    const project = createProject("p")
    const out = await executeTool(project, () => project, "create_part", { description: "boost", category: "Power", name: "TPS61040" }, { parts })
    expect(out.isError).toBeFalsy()
    expect(out.project.parts?.[0].source).toMatchObject({ pins: "database", database: { origin: "easyeda", key: "C1852149" } })
    expect(out.result).toContain("an orderable number of TPS61040")
  })

  it("prefers the stored part to a supplier record that is only a user's upload", async () => {
    const dip = stored("MCU_Microchip_ATtiny:ATtiny85-20P", "11")
    const upload = landed(candidateSource(candidate({ lcsc: "C9900000001", mpn: "ATtiny85-20P", match: "exact", userUpload: true, package: "DIP-8_L9.5-W6.4-P2.54-LS7.6-BL", pinMap: pinMapOf(dip) })), dip.land)
    const parts: SupplierPartsSource = { ...upload, index: database([dip], [hitOf(dip, "exact")]) }
    const project = createProject("p")
    const out = await executeTool(project, () => project, "create_part", { description: "MCU", category: "ICs", name: "ATtiny85-20P" }, { parts })
    expect(out.isError).toBeFalsy()
    expect(out.project.parts?.[0].source?.pins).toBe("database")
    expect(out.result).toContain("is an EasyEDA user's upload, so it was built from the parts database")
  })

  it("leaves a KiCad part built while the supplier is failing pending, and records the verdict when it is built again", async () => {
    const dip = stored("MCU_Microchip_ATtiny:ATtiny85-20P", "11")
    const busy: SupplierPartsSource = { ...failing("The supplier is busy."), index: database([dip], [hitOf(dip, "exact")]) }
    const project = createProject("p")
    const first = await executeTool(project, () => project, "create_part", { description: "MCU", category: "ICs", name: "ATtiny85-20P" }, { parts: busy })
    const spec = first.project.parts![0]
    expect(spec.source?.check?.verdict).toBe("pending")
    expect(needsCheck(spec)).toBe(true)
    const supplier = candidateSource(candidate({ lcsc: "C89852", mpn: "ATtiny85-20P", match: "exact", package: "DIP-8_L9.5-W6.4-P2.54-LS7.6-BL", pinMap: pinMapOf(dip) }))
    const again = await executeTool(first.project, () => first.project, "create_part", { description: "MCU", category: "ICs", name: "ATtiny85-20P", database_id: "11" }, { parts: { ...supplier, index: database([dip], []) } })
    expect(again.project.parts).toHaveLength(1)
    expect(again.project.parts![0].source?.check).toMatchObject({ verdict: "agrees", lcsc: "C89852" })
    expect(needsCheck(again.project.parts![0])).toBe(false)
  })

  it("replaces an agreeing verdict with a contradiction found when the part is built again, as the result says", async () => {
    const dip = stored("MCU_Microchip_ATtiny:ATtiny85-20P", "11")
    const vcc = dip.pins.find((p) => /VCC/i.test(p.name))!.number
    const gnd = dip.pins.find((p) => /GND/i.test(p.name))!.number
    const input = { description: "MCU", category: "ICs", name: "ATtiny85-20P", database_id: "11" }
    const agreeing = candidateSource(candidate({ lcsc: "C89852", mpn: "ATtiny85-20P", match: "exact", package: "DIP-8_L9.5-W6.4-P2.54-LS7.6-BL", pinMap: pinMapOf(dip) }))
    const project = createProject("p")
    const first = await executeTool(project, () => project, "create_part", input, { parts: { ...agreeing, index: database([dip], []) } })
    expect(first.project.parts![0].source?.check?.verdict).toBe("agrees")
    const swapped = candidateSource(candidate({ lcsc: "C89852", mpn: "ATtiny85-20P", match: "exact", package: "DIP-8_L9.5-W6.4-P2.54-LS7.6-BL", pinMap: pinMapOf(dip, [vcc, gnd]) }))
    const again = await executeTool(first.project, () => first.project, "create_part", input, { parts: { ...swapped, index: database([dip], []) } })
    expect(again.result).toContain("Checks shows the disagreement as an error")
    expect(again.project.parts![0].source?.check?.verdict).toBe("contradicted")
  })

  it("builds a KiCad wildcard by database_id under the name asked, and compares that number", async () => {
    const mcu = stored("MCU_ST_STM32F1:STM32F103C8Tx", "9")
    const searched: string[] = []
    const supplier: SupplierPartsSource = { ...nothing(), search: async (query) => (searched.push(query), { query, candidates: [], source: "easyeda", fetchedAt: "", attribution: "" }) }
    const project = createProject("p")
    const named = await executeTool(project, () => project, "create_part", { description: "MCU", category: "ICs", name: "STM32F103C8T6", database_id: "9" }, { parts: { ...supplier, index: database([mcu], []) } })
    expect(named.isError).toBeFalsy()
    expect(named.project.parts![0].props.mpn).toBe("STM32F103C8T6")
    expect(searched).toEqual(["STM32F103C8T6"])
    // Without a name that fills the x's there is no number to ask about: nothing is looked up.
    searched.length = 0
    const bare = await executeTool(project, () => project, "create_part", { description: "MCU", category: "ICs", database_id: "9" }, { parts: { ...supplier, index: database([mcu], []) } })
    expect(bare.isError).toBeFalsy()
    expect(searched).toEqual([])
    expect(bare.result).toContain("pass name with the one the user means")
  })

  it("still makes a memory part, marked pending, when both the supplier and the database have nothing to say", async () => {
    const parts: SupplierPartsSource = { ...failing("The supplier is busy."), index: database([], []) }
    const project = createProject("p")
    const input = { description: "chip", category: "ICs", name: "XYZ123", footprint: "soic8", pins: [1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({ number: String(n), name: `P${n}` })) }
    const out = await executeTool(project, () => project, "create_part", input, { parts })
    expect(out.isError).toBeFalsy()
    expect(out.project.parts?.[0].source).toMatchObject({ pins: "memory", check: { verdict: "pending" } })
  })

  it("prefers the supplier's part when it has one, and says where KiCad draws it differently", async () => {
    const dip = stored("MCU_Microchip_ATtiny:ATtiny85-20P", "11")
    const vcc = dip.pins.find((p) => /VCC/i.test(p.name))!.number
    const gnd = dip.pins.find((p) => /GND/i.test(p.name))!.number
    const supplier = landed(candidateSource(candidate({ lcsc: "C89852", mpn: "ATtiny85-20P", match: "exact", package: "DIP-8_L9.5-W6.4-P2.54-LS7.6-BL", pinMap: pinMapOf(dip, [vcc, gnd]) })), dip.land)
    const parts: SupplierPartsSource = { ...supplier, index: database([dip], [hitOf(dip, "exact")]) }
    const project = createProject("p")
    const out = await executeTool(project, () => project, "create_part", { description: "MCU", category: "ICs", name: "ATtiny85-20P" }, { parts })
    expect(out.isError).toBeFalsy()
    expect(out.project.parts?.[0].source).toMatchObject({ pins: "supplier", supplier: { lcsc: "C89852" } })
    expect(out.result).toContain("KiCad's library draws ATtiny85-20P differently from LCSC C89852")
  })

  it("builds a stored part by database_id, and keeps the supplier's agreement on it", async () => {
    const dip = stored("MCU_Microchip_ATtiny:ATtiny85-20P", "11")
    const supplier = candidateSource(candidate({ lcsc: "C89852", mpn: "ATtiny85-20P", match: "exact", package: "DIP-8_L9.5-W6.4-P2.54-LS7.6-BL", pinMap: pinMapOf(dip) }))
    const parts: SupplierPartsSource = { ...supplier, index: database([dip], []) }
    const project = createProject("p")
    const out = await executeTool(project, () => project, "create_part", { category: "ICs", database_id: "11" }, { parts })
    expect(out.isError).toBeFalsy()
    const spec = out.project.parts![0]
    expect(spec.name).toBe("ATtiny85-20P")
    expect(spec.source).toMatchObject({ pins: "database", land: "database", check: { verdict: "agrees", lcsc: "C89852" } })
    expect(out.result).toContain("Its pins agree with LCSC C89852.")
  })

  it("builds a stored part the supplier contradicts as asked, with the contradiction an error in Checks", async () => {
    const dip = stored("MCU_Microchip_ATtiny:ATtiny85-20P", "11")
    const vcc = dip.pins.find((p) => /VCC/i.test(p.name))!.number
    const gnd = dip.pins.find((p) => /GND/i.test(p.name))!.number
    const supplier = candidateSource(candidate({ lcsc: "C89852", mpn: "ATtiny85-20P", match: "exact", package: "DIP-8_L9.5-W6.4-P2.54-LS7.6-BL", pinMap: pinMapOf(dip, [vcc, gnd]) }))
    const parts: SupplierPartsSource = { ...supplier, index: database([dip], []) }
    const project = createProject("p")
    const out = await executeTool(project, () => project, "create_part", { category: "ICs", database_id: "11" }, { parts })
    expect(out.isError).toBeFalsy()
    const spec = out.project.parts![0]
    expect(spec.source?.check?.verdict).toBe("contradicted")
    expect(out.result).toContain("disagrees with KiCad's drawing")
    const placed = addComponent(out.project, spec.id, { sch: { x: 0, y: 0 } }).project
    const findings = partFindings(placed)
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({ severity: "error", message: expect.stringContaining("doesn't match LCSC C89852") })
  })

  it("refuses an unknown database_id and drawn pins that contradict the stored part", async () => {
    const ldo = stored("Regulator_Linear:AMS1117-3.3", "7")
    const parts: SupplierPartsSource = { ...nothing(), index: database([ldo], []) }
    const project = createProject("p")
    const missing = await executeTool(project, () => project, "create_part", { category: "Power", database_id: "404" }, { parts })
    expect(missing.isError).toBe(true)
    expect(missing.result).toContain("No part 404 is stored whole in the parts database")
    const pins = ldo.pins.map((p) => ({ number: p.number, name: p.name === "GND" ? "VI" : p.name === "VI" ? "GND" : p.name }))
    const wrong = await executeTool(project, () => project, "create_part", { category: "Power", database_id: "7", pins }, { parts })
    expect(wrong.isError).toBe(true)
    expect(wrong.result).toContain("contradict the KiCad library part Regulator_Linear:AMS1117-3.3")
  })
})

describe("find_part and get_part_data with the parts database", () => {
  it("lists stored parts beside the supplier's, with their ids", async () => {
    const ldo = stored("Regulator_Linear:AMS1117-3.3", "7")
    const supplier = candidateSource(candidate({ lcsc: "C6186", mpn: "AMS1117-3.3", match: "exact", package: "SOT-223-3_L6.5-W3.4-P2.30-LS7.0-BR", pinMap: "1:GND 2:VOUT 3:VIN 4:VOUT" }))
    const parts: SupplierPartsSource = { ...supplier, index: database([ldo], [hitOf(ldo, "exact")]) }
    const project = createProject("p")
    const out = await executeTool(project, () => project, "find_part", { query: "AMS1117-3.3" }, { parts })
    expect(out.isError).toBeFalsy()
    expect(out.result).toContain("C6186 AMS1117-3.3")
    expect(out.result).toContain("From the parts database")
    expect(out.result).toContain("database_id 7: AMS1117-3.3, SOT-223-3_TabPin2, 3 pins, KiCad library Regulator_Linear:AMS1117-3.3 [exact]")
  })

  it("still answers from the database when the supplier search fails", async () => {
    const ldo = stored("Regulator_Linear:AMS1117-3.3", "7")
    const parts: SupplierPartsSource = { ...failing("Parts lookup limit reached."), index: database([ldo], [hitOf(ldo, "exact")]) }
    const project = createProject("p")
    const out = await executeTool(project, () => project, "find_part", { query: "AMS1117" }, { parts })
    expect(out.isError).toBeFalsy()
    expect(out.result).toContain("The supplier search failed (Parts lookup limit reached), but the parts database answered.")
    expect(out.result).toContain("database_id 7")
  })

  it("reads a stored part by database_id", async () => {
    const ldo = stored("Regulator_Linear:AMS1117-3.3", "7")
    const parts: SupplierPartsSource = { ...nothing(), index: database([ldo], []) }
    const project = createProject("p")
    const out = await executeTool(project, () => project, "get_part_data", { database_id: "7" }, { parts })
    expect(out.isError).toBeFalsy()
    expect(out.result).toContain("database_id 7: AMS1117-3.3, SOT-223-3_TabPin2, from the KiCad library part Regulator_Linear:AMS1117-3.3 (release 10.0.7).")
    expect(out.result).toContain("Pins (3):")
    expect(out.result).toContain("Land (from Package_TO_SOT_SMD:SOT-223-3_TabPin2)")
    const none = await executeTool(project, () => project, "get_part_data", {}, { parts })
    expect(none.isError).toBe(true)
  })
})
