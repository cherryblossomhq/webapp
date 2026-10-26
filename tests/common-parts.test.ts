import { describe, expect, it } from "vitest"
import { resolvePartName } from "../src/ai/partLookup"
import { executeTool } from "../src/ai/tools"
import { createProject } from "../src/model/ops"
import { COMMON_PARTS } from "./fixtures/supplier/common"
import { recordedSource } from "./fixtures/supplier/source"

// Twenty common parts, looked up by the name a person gives, against recorded supplier answers.
// Thirteen of them failed before part families (each came back as a different part number):
// which resolve now, which are a real choice, and why. `fixtures/supplier/common.ts` is the table.

describe("twenty common parts, by name alone", () => {
  for (const c of COMMON_PARTS) {
    it(`${c.name}: ${c.expect === "found" ? `resolves to ${c.lcsc}` : `is a choice of ${c.choices.length}`}, ${c.why}`, async () => {
      const out = await resolvePartName(recordedSource(), c.name, {})
      expect(out.kind, out.kind === "found" ? "" : JSON.stringify(out)).toBe(c.expect)
      if (c.expect === "found" && out.kind === "found") {
        expect(out.part.lcsc).toBe(c.lcsc)
        expect(out.family).toHaveLength(c.members)
        expect(out.part.provenance.userUpload).toBeUndefined()
        // A part number that is not the name says which one was chosen, and why.
        if (out.part.mpn !== c.name) expect(out.chosen).toContain(`${c.name} resolved to ${c.lcsc} ${out.part.mpn}`)
      }
      if (c.expect === "ambiguous" && out.kind === "ambiguous") {
        expect(out.candidates.map((x) => x.lcsc)).toEqual(c.choices)
        // Spelled out: what is on offer and what differs, never a bare refusal.
        expect(out.text).toContain("is sold as")
        expect(out.text).toContain("They differ in:")
        expect(out.text).toContain("Pass lcsc for the one the user means")
        // The better stocked comes first.
        const stock = out.candidates.map((x) => x.stock ?? -1)
        expect(stock).toEqual([...stock].sort((a, b) => b - a))
      }
    })
  }

  it("resolves most of them, and the rest are the ones sold in several packages", () => {
    const found = COMMON_PARTS.filter((c) => c.expect === "found")
    expect(found.length).toBe(11)
    expect(COMMON_PARTS.length - found.length).toBe(9)
  })
})

describe("what Sakura's normal path ends in", () => {
  it("builds a verified part from a bare name: create_part TPS61023 with no pins and no orderable number", async () => {
    const project = createProject("p")
    const out = await executeTool(project, () => project, "create_part", { name: "TPS61023", category: "Power" }, { parts: recordedSource() })
    expect(out.isError, out.result).toBe(false)
    const spec = out.project.parts![0]
    expect(spec.source).toMatchObject({ pins: "supplier", land: "supplier", supplier: { lcsc: "C919459", mpn: "TPS61023DRLR" } })
    // The result says which part number it chose, so the copilot can tell the user.
    expect(out.result).toContain("TPS61023 resolved to C919459 TPS61023DRLR (SOT-563, 42690 in stock), the best stocked of 2 supplier part numbers with the same package and the same function on every pin number")
  })

  it("ends in a verified part for a name sold in several packages too: the list, then the first listed", async () => {
    const project = createProject("p")
    const ask = await executeTool(project, () => project, "create_part", { name: "ADS1115", category: "ICs" }, { parts: recordedSource() })
    expect(ask.isError).toBe(true)
    expect(ask.result).toContain("ADS1115 is sold as")
    expect(ask.result).toContain("C37593 ADS1115IDGSR, MSOP-10")
    // The first listed is the best stocked: pass its lcsc and the part is built from the record.
    const made = await executeTool(project, () => project, "create_part", { lcsc: "C37593", category: "ICs" }, { parts: recordedSource() })
    expect(made.isError, made.result).toBe(false)
    expect(made.project.parts![0].source).toMatchObject({ pins: "supplier", supplier: { lcsc: "C37593" } })
    // With the footprint family the drawing names, the name alone is enough.
    const hinted = await executeTool(project, () => project, "create_part", { name: "ADS1115", category: "ICs", footprint: "vssop10" }, { parts: recordedSource() })
    expect(hinted.isError, hinted.result).toBe(false)
    expect(hinted.project.parts![0].source).toMatchObject({ supplier: { lcsc: "C37593" } })
  })

  it("takes a footprint size to pick a WS2812B, which is sold in three sizes with nothing to tell them apart", async () => {
    const project = createProject("p")
    const ask = await executeTool(project, () => project, "create_part", { name: "WS2812B", category: "Diodes" }, { parts: recordedSource() })
    expect(ask.isError).toBe(true)
    expect(ask.result).toContain("in another size")
  })
})
