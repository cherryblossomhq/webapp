import type { PartCandidate, PartSearchResponse } from "@cherryblossom/api-contract"
import { describe, expect, it } from "vitest"
import type { SupplierPartsSource } from "../src/ai/supplierParts"
import { createProject } from "../src/model/ops"
import type { Project } from "../src/model/types"
import { addSupplierPart, indexFailureLine, looksLikePartNumber, matchNote, searchSupplier, stockLine, supplierCandidates, wantsSupplier } from "../src/panels/partSearch"
import { candidate } from "./fixtures/supplier/candidates"
import { recordedPart, recordedSource } from "./fixtures/supplier/source"

// What the library panel's search says about the parts database's hits and failures, and when it
// asks the supplier's catalogue (LCSC) for a part number nothing else has: the decisions are plain
// functions, since the panel has no DOM tests.

describe("how a database hit matches", () => {
  it("says a typo is a close match and a family may be another package", () => {
    expect(matchNote("typo")).toBe("Close match")
    expect(matchNote("family")).toBe("Same family, check the package")
  })

  it("says nothing new for a hit that is the number or starts with it", () => {
    expect(matchNote("exact")).toBeNull()
    expect(matchNote("prefix")).toBeNull()
    expect(matchNote("keyword")).toBeNull()
  })
})

describe("a database search that failed", () => {
  it("says so in one line with the server's sentence", () => {
    expect(indexFailureLine(new Error("Sign in again to look parts up from the supplier."), false)).toBe(
      "The parts database couldn't be searched: Sign in again to look parts up from the supplier.",
    )
    expect(indexFailureLine(new Error("The part lookup failed (502)."), false)).toContain("(502)")
  })

  it("says nothing when the deployment has no database", () => {
    expect(indexFailureLine(new Error("The parts index is not configured on this deployment."), false)).toBeNull()
  })

  it("says nothing for a request that was aborted", () => {
    expect(indexFailureLine(new DOMException("aborted", "AbortError"), false)).toBeNull()
    expect(indexFailureLine(new Error("whatever"), true)).toBeNull()
  })
})

describe("what looks like a part number", () => {
  it("takes letters and digits, three or more, no spaces", () => {
    for (const q of ["TPS61023", "lm358", "MPU-6050", "STM32F103C8T6", "74HC00", "1N4148", "2N3904", "U.FL-R-SMT-1"]) expect(looksLikePartNumber(q), q).toBe(true)
  })

  it("leaves out words, values, sizes and anything with a space", () => {
    for (const q of ["resistor", "10k", "4k7", "100nF", "2.2uF", "16MHz", "3V3", "0603", "555", "ab", "lm 358", "buck converter", "TPS61023 boost", "R1"]) expect(looksLikePartNumber(q), q).toBe(false)
  })
})

describe("when to offer the supplier", () => {
  const settled = { query: "TPS61023", databaseSettled: true, hits: [], libraryHasIt: false }

  it("offers it for a part number the database has nothing for", () => {
    expect(wantsSupplier(settled)).toBe(true)
    expect(wantsSupplier({ ...settled, hits: [{ match: "typo" as const, mpn: "TPS6102" }, { match: "keyword" as const, mpn: "TPS" }] })).toBe(true)
  })

  it("does not, for a query the database already answers", () => {
    for (const match of ["exact", "prefix"] as const) expect(wantsSupplier({ ...settled, hits: [{ match, mpn: "TPS61023" }] }), match).toBe(false)
  })

  it("waits for the database, and leaves out what the library has or no part number looks like", () => {
    expect(wantsSupplier({ ...settled, databaseSettled: false })).toBe(false)
    expect(wantsSupplier({ ...settled, libraryHasIt: true })).toBe(false)
    expect(wantsSupplier({ ...settled, query: "10k" })).toBe(false)
  })
})

const response = (candidates: PartCandidate[]): PartSearchResponse => ({ query: "x", candidates, source: "easyeda", fetchedAt: "2026-10-22T00:00:00.000Z", attribution: "test" })

describe("the supplier's candidates", () => {
  it("lists those with a named pinout and a land, not user uploads, at most six", () => {
    const good = Array.from({ length: 8 }, (_, i) => candidate({ lcsc: `C${i + 1}` }))
    const rows = supplierCandidates(
      response([
        candidate({ lcsc: "C90", hasVendorPinout: false }),
        candidate({ lcsc: "C91", hasVendorLand: false }),
        candidate({ lcsc: "C92", hasVendorLand: null }),
        candidate({ lcsc: "C99000000001", userUpload: true }),
        ...good,
      ]),
    )
    expect(rows.map((c) => c.lcsc)).toEqual(["C1", "C2", "C3", "C4", "C5", "C6"])
  })

  it("says stock in words", () => {
    expect(stockLine(12500)).toBe("12,500 in stock")
    expect(stockLine(0)).toBe("Out of stock")
    expect(stockLine(null)).toBe("Stock unknown")
  })
})

describe("asking the supplier", () => {
  it("asks each query once per source, however it is spelled", async () => {
    const source = recordedSource()
    const first = await searchSupplier(source, "TPS61023")
    expect(first.length).toBeGreaterThan(0)
    await searchSupplier(source, " tps61023 ")
    await searchSupplier(source, "TPS61023")
    expect(source.calls).toEqual(["search:TPS61023"])
    // Another source is another session.
    const other = recordedSource()
    await searchSupplier(other, "TPS61023")
    expect(other.calls).toEqual(["search:TPS61023"])
  })

  it("does not keep a failure, so asking again tries again", async () => {
    let calls = 0
    const source: SupplierPartsSource = {
      search: async () => {
        calls++
        throw new Error("Busy.")
      },
      part: async () => null,
    }
    await expect(searchSupplier(source, "TPS61023")).rejects.toThrow("Busy.")
    await expect(searchSupplier(source, "TPS61023")).rejects.toThrow("Busy.")
    expect(calls).toBe(2)
  })

  it("shares a search still on its way, so a second ask never pays again", async () => {
    const source = recordedSource({ delayMs: 5 })
    const [a, b] = await Promise.all([searchSupplier(source, "TPS61023"), searchSupplier(source, " tps61023")])
    expect(a).toBe(b)
    expect(source.calls).toEqual(["search:TPS61023"])
  })
})

describe("picking a supplier part", () => {
  const open = (project: Project) => {
    const holder = { project }
    return { holder, commit: (edit: (p: Project) => Project) => void (holder.project = edit(holder.project)) }
  }

  it("reads it and adds a part built from the supplier's pins and land, with its 3D model", async () => {
    const source = recordedSource()
    const { holder, commit } = open(createProject("boost"))
    const added = await addSupplierPart(source, "C919459", commit)
    if ("error" in added) throw new Error(added.error)
    expect(source.calls).toEqual(["part:C919459"])
    const spec = holder.project.parts!.find((s) => s.id === added.partId)!
    expect(spec).toMatchObject({ name: "TPS61023DRLR", source: { pins: "supplier", supplier: { lcsc: "C919459" } }, props: { mpn: "TPS61023DRLR", lcsc: "C919459" } })
    expect(holder.project.models?.some((m) => m.part === spec.id && m.footprint === spec.footprint)).toBe(true)
  })

  it("answers with the supplier's sentence when the read fails, and with a line when there is no record", async () => {
    const { commit } = open(createProject("x"))
    const failing: SupplierPartsSource = { search: async () => response([]), part: async () => Promise.reject(new Error("Sign in again to look parts up from the supplier.")) }
    expect(await addSupplierPart(failing, "C1", commit)).toEqual({ error: "Sign in again to look parts up from the supplier." })
    const none: SupplierPartsSource = { search: async () => response([]), part: async () => null }
    expect(await addSupplierPart(none, "C1", commit)).toEqual({ error: "LCSC has no record for C1 any more." })
  })

  it("keeps the supplier's disputes and a user upload on the part, where Checks reads them", async () => {
    const part = recordedPart("C88374")
    part.provenance = { ...part.provenance, userUpload: true }
    const source: SupplierPartsSource = { search: async () => response([]), part: async () => part }
    const { holder, commit } = open(createProject("rf"))
    const added = await addSupplierPart(source, "C88374", commit)
    if ("error" in added) throw new Error(added.error)
    expect(holder.project.parts![0].source?.supplier).toMatchObject({ userUpload: true, disputes: expect.any(Array) })
    expect(holder.project.parts![0].source?.supplier?.disputes?.length).toBeGreaterThan(0)
  })
})
