import type { PartCandidate, PartSearchResponse } from "@cherryblossom/api-contract"
import { describe, expect, it } from "vitest"
import { resolvePartName } from "../src/ai/partLookup"
import { describeVerify, verifyProjectParts, withPartChecks } from "../src/ai/partTools"
import type { SupplierPartsSource } from "../src/ai/supplierParts"
import { executeTool } from "../src/ai/tools"
import { customPartId, registerProjectParts } from "../src/model/customParts"
import { addComponent, createProject } from "../src/model/ops"
import { partFindings } from "../src/model/partChecks"
import { parseProjectFile, serializeProject } from "../src/model/projectFile"
import type { CustomPartSpec, PartSource, Project } from "../src/model/types"
import { pinsOf } from "./fixtures/supplier/candidates"
import { recordedSource } from "./fixtures/supplier/source"

// What happens when a lookup doesn't give a straight answer: a longer part number standing in for
// the one asked for, records that couldn't be read, lookups that failed or hit a limit. None of
// them may read as "nothing to check" or "no pinout".

const candidate = (over: Partial<PartCandidate>): PartCandidate => ({
  lcsc: "C1",
  mpn: "WS2812B",
  manufacturer: null,
  package: "LED-5050",
  description: null,
  stock: 10,
  match: "exact",
  pinCount: 4,
  hasVendorPinout: true,
  hasVendorLand: true,
  pins: pinsOf("1:VDD 2:DOUT 3:VSS 4:DIN"),
  ...over,
})

const searching = (...candidates: PartCandidate[]): SupplierPartsSource => ({
  search: async (query): Promise<PartSearchResponse> => ({ query, candidates, source: "easyeda", fetchedAt: "2026-10-20T00:00:00.000Z", attribution: "test" }),
  part: async () => {
    throw new Error("no record should have been read")
  },
})

describe("a longer part number is another part", () => {
  it("is not used when exact records exist but name no pins", async () => {
    // The critic's case: WS2812B has records of its own with no named pinout, and WS2812B-2020 has one.
    const src = searching(candidate({ lcsc: "C1", mpn: "WS2812B", hasVendorPinout: false }), candidate({ lcsc: "C2", mpn: "WS2812B-2020", match: "prefix", pinCount: 4 }))
    const out = await resolvePartName(src, "WS2812B", {})
    expect(out.kind).toBe("none")
    // Nothing resolves from the variant (it may be another part), and the sentence doesn't deny that a pinned variant exists.
    expect(out).toMatchObject({ text: expect.stringContaining("No supplier record numbered exactly WS2812B names its pins (1 found), but an ordering variant does: C2 WS2812B-2020") })
    expect(out).toMatchObject({ text: expect.stringContaining("Pass lcsc of the one the user means after checking it is the same part.") })
  })

  it("is a short list, never the part, when variants in different sizes are all there is", async () => {
    const small = candidate({ lcsc: "C2", mpn: "WS2812B-2020", match: "prefix", package: "LED-SMD_4P-L2.0-W2.0-TL" })
    const big = candidate({ lcsc: "C3", mpn: "WS2812B-3535", match: "prefix", package: "LED-SMD_4P-L3.5-W3.5-TL", pins: pinsOf("1:DO 2:GND 3:DI 4:VDD") })
    const out = await resolvePartName(searching(small, big), "WS2812B", {})
    expect(out.kind).toBe("ambiguous")
    if (out.kind !== "ambiguous") return
    expect(out.candidates.map((c) => c.lcsc)).toEqual(["C2", "C3"])
    expect(out.text).toContain("WS2812B is sold as 2 supplier part numbers in 2 packages or pinouts")
    expect(out.text).toContain("C2 WS2812B-2020")
  })

  it("tells a drawing with another pin count that the numbers like its name are other parts", async () => {
    const src = searching(candidate({ lcsc: "C2", mpn: "WS2812B-2020", match: "prefix" }), candidate({ lcsc: "C3", mpn: "WS2812B-3535", match: "prefix" }))
    const out = await resolvePartName(src, "WS2812B", { pins: [{ number: "1", name: "A" }, { number: "2", name: "K" }] })
    expect(out.kind).toBe("different")
    if (out.kind !== "different") return
    expect(out.candidates.map((c) => c.lcsc)).toEqual(["C2", "C3"])
    expect(out.text).toContain("none of those numbered like it has the 2 pins you drew, so they are other parts")
    expect(out.note).toBe("no supplier part is numbered exactly WS2812B, and those numbered like it have another pin count than the 2 drawn (C2 WS2812B-2020, 4 pins; C3 WS2812B-3535, 4 pins)")
  })

  it("makes create_part refuse a name it only has longer numbers for, and says how to go on", async () => {
    const src = searching(candidate({ lcsc: "C2", mpn: "WS2812B-2020", match: "prefix" }))
    const project = createProject("p")
    const input = { name: "WS2812B", description: "led", category: "Diodes", footprint: "0603", pins: [{ number: "1", name: "A" }, { number: "2", name: "K" }] }
    const out = await executeTool(project, () => project, "create_part", input, { parts: src })
    expect(out.isError).toBe(true)
    expect(out.project.parts).toBeUndefined()
    expect(out.result).toContain("Pass lcsc for the one the user means")
    const memory = await executeTool(project, () => project, "create_part", { ...input, from_memory: true }, { parts: src })
    expect(memory.isError, memory.result).toBe(false)
    expect(memory.result).toContain("UNVERIFIED (no supplier part is numbered exactly WS2812B")
  })
})

describe("records that couldn't be read", () => {
  it("make a name 'couldn't check', not 'no pinout'", async () => {
    const src = searching(candidate({ hasVendorPinout: null, hasVendorLand: null, pinCount: null }), candidate({ lcsc: "C2", mpn: "WS2812B", hasVendorPinout: false }))
    const out = await resolvePartName(src, "WS2812B", {})
    expect(out.kind).toBe("failed")
    expect(out).toMatchObject({ text: "Couldn't check WS2812B: 1 supplier record couldn't be read. Try again in a moment." })
  })

  it("are listed by find_part as unknown, with the instruction to ask again", async () => {
    const project = createProject("p")
    const src = searching(candidate({ hasVendorPinout: null, hasVendorLand: null, pinCount: null }), candidate({ lcsc: "C2", mpn: "WS2812B-B" }))
    const out = await executeTool(project, () => project, "find_part", { query: "WS2812B" }, { parts: src })
    expect(out.isError).toBe(false)
    expect(out.result).toContain("C1 WS2812B: LED-5050, ? pins, couldn't read this record, so its pinout and land are unknown")
    expect(out.result).not.toContain("no pinout or land")
    expect(out.result).toContain("1 record couldn't be read, so it may have a pinout: call find_part again before saying there is none.")
  })
})

/** A project of parts named by `names`, each placed once, made from memory with a part number to look up. */
function projectOf(names: string[]): Project {
  const parts: CustomPartSpec[] = names.map((name) => {
    const draft: Omit<CustomPartSpec, "id"> = {
      name,
      description: "",
      category: "ICs",
      refPrefix: "U",
      footprint: "0603",
      pins: [
        { number: "1", name: "A" },
        { number: "2", name: "B" },
      ],
      props: { mpn: name },
    }
    return { id: customPartId(draft), ...draft }
  })
  let project: Project = { ...createProject("many"), parts }
  registerProjectParts(project)
  for (const spec of parts) project = addComponent(project, spec.id).project
  return project
}

const LIMIT = "Part lookup limit reached (60 lookups a minute). Try again in a minute."
const limited: SupplierPartsSource = {
  search: async () => {
    throw new Error(LIMIT)
  },
  part: async () => {
    throw new Error(LIMIT)
  },
}
/** No supplier has anything: every part is a clean "no record". */
const nothing: SupplierPartsSource = { ...searching(), part: async () => null }

describe("verify_parts when lookups fail", () => {
  it("says what failed and how many, never 'nothing to check'", async () => {
    const project = projectOf(["FAILA", "FAILB", "FAILC"])
    const out = await executeTool(project, () => project, "verify_parts", {}, { parts: limited })
    expect(out.isError).toBe(true)
    expect(out.result).not.toContain("No unverified project parts")
    expect(out.result).toContain(`Checked 0, couldn't check 3: ${LIMIT.replace(/\.$/, "")}.`)
    expect(out.result).toContain("FAILA")
    expect(out.summary).toBe(`Checked 0, couldn't check 3: ${LIMIT.replace(/\.$/, "")}.`)
    // Nothing was recorded on the parts, so they are still to be checked.
    expect(out.project).toBe(project)
  })

  it("reports the failures beside the parts it did check", async () => {
    const project = projectOf(["MIXOK", "MIXBAD"])
    const mixed: SupplierPartsSource = {
      search: async (q, signal) => {
        if (q === "MIXBAD") throw new Error("The parts supplier didn't answer (search took longer than 8 s).")
        return nothing.search(q, signal)
      },
      part: nothing.part,
    }
    const out = await executeTool(project, () => project, "verify_parts", {}, { parts: mixed })
    expect(out.isError).toBe(false)
    expect(out.result).toContain("Checked 1, couldn't check 1: The parts supplier didn't answer (search took longer than 8 s).")
    expect(out.summary).toBe("Checked 1 part(s) against supplier data, couldn't check 1")
    expect(out.project.parts!.find((s) => s.name === "MIXOK")!.source?.check?.verdict).toBe("no_record")
    expect(out.project.parts!.find((s) => s.name === "MIXBAD")!.source?.check).toBeUndefined()
  })

  it("moves a part that failed to the back, so the parts behind it get checked", async () => {
    const project = projectOf(["ROTSTUCK", "ROTLATER"])
    const stuck: SupplierPartsSource = {
      search: async (q, signal) => {
        if (q === "ROTSTUCK") throw new Error("The parts supplier answered 503 (search).")
        return nothing.search(q, signal)
      },
      part: nothing.part,
    }
    const first = await verifyProjectParts(project, stuck, { limit: 1 })
    expect([...first.failed.keys()]).toEqual([project.parts![0].id])
    expect(first.results.size).toBe(0)
    expect(first.waiting).toBe(1)
    // The next call, same project, starts with the one that didn't get its turn.
    const second = await verifyProjectParts(project, stuck, { limit: 1 })
    expect([...second.results.keys()]).toEqual([project.parts![1].id])
    expect(second.failed.size).toBe(0)
  })

  it("says so when more parts are waiting than one call checks, and a second call takes them", async () => {
    const names = Array.from({ length: 12 }, (_, i) => `BULK${i}`)
    const project = projectOf(names)
    const first = await executeTool(project, () => project, "verify_parts", { part_ids: project.parts!.map((s) => s.id) }, { parts: nothing })
    expect(first.result).toContain("Checked 10. 2 more were not tried yet: run it again for the rest.")
    const second = await executeTool(first.project, () => first.project, "verify_parts", { part_ids: project.parts!.map((s) => s.id) }, { parts: nothing })
    // Already-checked parts go behind the ones not checked yet, so the same ids make progress.
    expect(second.result).toContain("BULK10")
    expect(second.result).toContain("BULK11")
    expect(second.result).toMatch(/^Checked 10\./)
    // Without part_ids only the parts nobody has checked are taken, so the last call has no leftovers.
    const rest = await executeTool(first.project, () => first.project, "verify_parts", {}, { parts: nothing })
    expect(rest.result).toMatch(/^Checked 2\.$/m)
    expect(rest.result).not.toContain("not tried yet")
  })

  it("still says there is nothing to check when there is nothing to check", async () => {
    const project = createProject("empty")
    const out = await executeTool(project, () => project, "verify_parts", {}, { parts: nothing })
    expect(out.isError).toBe(false)
    expect(out.result).toBe("No unverified project parts to check.")
    expect(describeVerify({ results: new Map(), failed: new Map(), waiting: 0 })).toBe("")
  })

  it("words the Checks panel's note the same way", async () => {
    const project = projectOf(["PANELA", "PANELB"])
    const outcome = await verifyProjectParts(project, limited)
    expect(describeVerify(outcome)).toBe(`Checked 0, couldn't check 2: ${LIMIT.replace(/\.$/, "")}.`)
    expect(withPartChecks(project, outcome.results)).toBe(project)
  })

  it("stops when Stop is pressed, rather than reporting a half-checked batch", async () => {
    const project = projectOf(["STOPA"])
    const controller = new AbortController()
    const slow: SupplierPartsSource = {
      search: async () => {
        controller.abort()
        return searching().search("x")
      },
      part: nothing.part,
    }
    await expect(verifyProjectParts(project, slow, { signal: controller.signal })).rejects.toThrow()
  })
})

describe("provenance read from a project file", () => {
  const spec = (source: unknown): CustomPartSpec => {
    const draft: Omit<CustomPartSpec, "id"> = {
      name: "TPS61023",
      description: "boost",
      category: "Power",
      refPrefix: "U",
      footprint: "sot563",
      pins: "FB EN VIN GND SW VOUT".split(" ").map((name, i) => ({ number: String(i + 1), name })),
      props: { mpn: "TPS61023" },
    }
    return { id: customPartId(draft), ...draft, source: source as PartSource }
  }
  const read = (source: unknown) => {
    const part = spec(source)
    let p: Project = { ...createProject("p"), parts: [part] }
    registerProjectParts(p)
    p = addComponent(p, part.id).project
    return parseProjectFile(serializeProject(p), { id: "p" })
  }

  it("survives a check with no findings list, which partFindings would have crashed on", () => {
    const back = read({ pins: "memory", land: "memory", check: { at: "x", verdict: "contradicted" } })
    expect(back.parts).toHaveLength(1)
    expect(back.parts![0].source?.check).toBeUndefined()
    expect(() => partFindings(back)).not.toThrow()
    expect(partFindings(back)[0].message).toContain("not verified against a supplier")
  })

  it("drops a check with an unknown verdict and keeps the good ones' strings only", () => {
    expect(read({ pins: "memory", land: "memory", check: { at: "x", verdict: "perfect", findings: [] } }).parts![0].source?.check).toBeUndefined()
    const kept = read({ pins: "memory", land: "memory", check: { at: "x", verdict: "contradicted", lcsc: "C9", findings: ["pin 1 is wrong", 7, null] } })
    expect(kept.parts![0].source?.check).toEqual({ at: "x", lcsc: "C9", verdict: "contradicted", findings: ["pin 1 is wrong"] })
    expect(partFindings(kept)[0].message).toBe("U1 (TPS61023) doesn't match LCSC C9. pin 1 is wrong")
  })

  it("repairs a supplier record with missing fields, and reads pins 'from the supplier' with none as memory", () => {
    const fixed = read({ pins: "supplier", land: "bogus", supplier: { lcsc: "C9", disputes: "no" } })
    expect(fixed.parts![0].source).toEqual({ pins: "supplier", land: "memory", supplier: { lcsc: "C9", mpn: "C9", confidence: "single_source", vendors: 1, fetchedAt: "" } })
    expect(() => partFindings(fixed)).not.toThrow()
    const bare = read({ pins: "supplier", land: "supplier" })
    expect(bare.parts![0].source).toMatchObject({ pins: "memory" })
  })
})

describe("the recorded source", () => {
  it("is still what the production tests replay", async () => {
    // A guard for this file's stubs: a real record resolves, so a failing lookup isn't a broken fixture.
    const out = await resolvePartName(recordedSource(), "DW01A", {})
    expect(out.kind).toBe("found")
  })
})
