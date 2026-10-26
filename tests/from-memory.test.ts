import { describe, expect, it } from "vitest"
import { verifyProjectParts, withPartChecks } from "../src/ai/partTools"
import type { SupplierPartsSource } from "../src/ai/supplierParts"
import { executeTool } from "../src/ai/tools"
import { customPartId, registerProjectParts } from "../src/model/customParts"
import { addComponent, createProject } from "../src/model/ops"
import { needsCheck, partFindings } from "../src/model/partChecks"
import { parseProjectFile, serializeProject } from "../src/model/projectFile"
import type { CustomPartSpec, Project } from "../src/model/types"
import { PRODUCTION_PARTS } from "./fixtures/supplier/production"
import { recordedSource } from "./fixtures/supplier/source"

// The check this work exists for must not have a way round it. `from_memory: true` once made a
// TPS61023 with its input on its output pin, silently, and verify_parts then called it "no
// record" although LCSC C919459 TPS61023DRLR exists. These are those cases.

const production = (name: string) => PRODUCTION_PARTS.find((p) => p.name === name)!

async function create(input: object, parts: SupplierPartsSource = recordedSource(), project = createProject("p")) {
  return executeTool(project, () => project, "create_part", input, { parts })
}

describe("from_memory is not a way round the check", () => {
  it("refuses the TPS61023 with its production pins, with or without from_memory", async () => {
    const p = production("TPS61023")
    const input = { name: p.name, description: "boost", category: "Power", pins: p.pins, footprint: "sot563" }
    const refused = await create(input)
    expect(refused.isError).toBe(true)
    expect(refused.result).toContain("5 pins contradict LCSC C919459 (TPS61023DRLR)")
    expect(refused.result).toContain("pin 6 is VOUT (a supply output), drawn as VIN (a supply input)")
    // The one it was made with in production: from_memory and the wrong SOT-23-6.
    const insisting = await create({ ...input, footprint: p.footprint, from_memory: true })
    expect(insisting.isError).toBe(true)
    expect(insisting.project.parts).toBeUndefined()
    expect(insisting.result).toContain("pin 6 is VOUT (a supply output), drawn as VIN (a supply input)")
  })

  it("refuses the AD8318 with its production pins and a footprint that fits, from_memory or not", async () => {
    const p = production("AD8318")
    const input = { name: p.name, description: "detector", category: "ICs", pins: p.pins, footprint: "qfn16_w4_h4_p0.65mm_thermalpad", from_memory: true }
    const out = await create(input)
    expect(out.isError).toBe(true)
    expect(out.project.parts).toBeUndefined()
    expect(out.result).toContain("11 pins contradict LCSC C578694")
    expect(out.result).toContain("pin 1 is CMIP (ground), drawn as VPSI (a supply input)")
  })

  it("refuses pins that contradict every package a name is sold in, naming how many it checked", async () => {
    // ULN2003A is sold in SOP-16 and DIP-16; a drawing that puts a supply on its first input is wrong in both.
    const pins = "1:VCC 2:2B 3:3B 4:4B 5:5B 6:6B 7:7B 8:E 9:COMPO 10:7C 11:6C 12:5C 13:4C 14:3C 15:2C 16:1C".split(" ").map((p) => ({ number: p.split(":")[0], name: p.split(":")[1] }))
    const out = await create({ name: "ULN2003A", description: "driver", category: "ICs", pins, from_memory: true })
    expect(out.isError).toBe(true)
    expect(out.project.parts).toBeUndefined()
    expect(out.result).toContain("contradict LCSC")
    expect(out.result).toMatch(/The same is true against the other 1 package numbered like it \(C\d+\)\./)
  })

  it("refuses a name sold in several packages even with from_memory, and lists them", async () => {
    const pins = "1:1B 2:2B 3:3B 4:4B 5:5B 6:6B 7:7B 8:E 9:COMPO 10:7C 11:6C 12:5C 13:4C 14:3C 15:2C 16:1C".split(" ").map((p) => ({ number: p.split(":")[0], name: p.split(":")[1] }))
    const out = await create({ name: "ULN2003A", description: "driver", category: "ICs", pins, from_memory: true })
    expect(out.isError).toBe(true)
    expect(out.project.parts).toBeUndefined()
    expect(out.result).toContain("ULN2003A is sold as")
    expect(out.result).toContain("SOP-16 vs DIP-16")
  })

  it("makes a part from memory only when the supplier has nothing to compare, and marks it", async () => {
    const p = production("HFCN-650+")
    const input = { name: p.name, description: "low pass filter", category: "Passives", pins: p.pins, footprint: p.footprint }
    // No supplier record at all: no flag is needed, and the part is marked unverified.
    const made = await create(input)
    expect(made.isError, made.result).toBe(false)
    expect(made.project.parts![0].source).toMatchObject({ pins: "memory", land: "memory" })
    expect(made.result).toContain("UNVERIFIED")
    expect(made.project.parts![0].source?.check).toBeUndefined()
  })
})

describe("verify_parts on a part made from memory", () => {
  function memoryProject(name: string): Project {
    const p = production(name)
    const draft: Omit<CustomPartSpec, "id"> = { name, description: "", category: "ICs", refPrefix: "U", footprint: p.footprint, pins: p.pins, props: { mpn: name } }
    const spec: CustomPartSpec = { id: customPartId(draft), ...draft }
    const project: Project = { ...createProject("legacy"), parts: [spec] }
    registerProjectParts(project)
    return addComponent(project, spec.id).project
  }

  it("marks the TPS61023 contradicted, an error in Checks, never 'no supplier record'", async () => {
    const project = memoryProject("TPS61023")
    const out = await executeTool(project, () => project, "verify_parts", {}, { parts: recordedSource() })
    expect(out.isError).toBe(false)
    const spec = out.project.parts![0]
    expect(spec.source?.check).toMatchObject({ verdict: "contradicted", lcsc: "C919459" })
    expect(out.result).toContain("contradicted against LCSC C919459")
    expect(out.result).not.toMatch(/no supplier record/i)
    const finding = partFindings(out.project)[0]
    expect(finding.severity).toBe("error")
    expect(finding.message).toMatch(/^U1 \(TPS61023\) doesn't match LCSC C919459\. 5 pins wrong/)
    expect(finding.message).not.toMatch(/no supplier record/i)
  })

  it("marks the AD8318 contradicted too", async () => {
    const project = memoryProject("AD8318")
    const { results } = await verifyProjectParts(project, recordedSource())
    expect(results.get(project.parts![0].id)).toMatchObject({ verdict: "contradicted", lcsc: "C578694" })
  })

  it("says 'no record' only when the supplier has nothing, and says what it found when it has parts but none fits", async () => {
    const none = memoryProject("HFCN-650+")
    expect((await verifyProjectParts(none, recordedSource())).results.get(none.parts![0].id)).toMatchObject({ verdict: "no_record" })
    expect(partFindings(withPartChecks(none, (await verifyProjectParts(none, recordedSource())).results))[0].message).toContain("no supplier record was found for HFCN-650+")

    // Eight pins against a name whose supplier parts all have six: other parts, said so.
    const eight = memoryProject("TPS61023")
    const spec = { ...eight.parts![0], pins: [...eight.parts![0].pins, { number: "7", name: "NC" }, { number: "8", name: "NC" }], footprint: "sot563" }
    const project: Project = { ...eight, parts: [spec] }
    const result = (await verifyProjectParts(project, recordedSource())).results.get(spec.id)!
    expect(result.verdict).toBe("different_part")
    expect(result.findings[0]).toMatch(/have another pin count than the 8 drawn \(C919459 TPS61023DRLR, 6 pins/)
    const finding = partFindings(withPartChecks(project, new Map([[spec.id, result]])))[0]
    expect(finding.message).toContain("supplier parts are numbered like TPS61023 but none has its pin count")
    expect(finding.message).not.toContain("no supplier record")
  })
})

describe("when the supplier lookup fails", () => {
  const down: SupplierPartsSource = {
    search: async () => {
      throw new Error("The parts supplier answered 503 (search).")
    },
    part: async () => {
      throw new Error("The parts supplier answered 503 (component).")
    },
  }
  const p = production("TPS61023")
  const input = { name: p.name, description: "boost", category: "Power", pins: p.pins, footprint: p.footprint }

  it("builds the part only as plainly unverified, with a re-check pending", async () => {
    const made = await create(input, down)
    expect(made.isError, made.result).toBe(false)
    expect(made.result).toContain("UNVERIFIED (the supplier lookup failed (The parts supplier answered 503 (search)))")
    expect(made.result).toContain("A re-check is pending: call verify_parts when the supplier lookup is back")
    const spec = made.project.parts![0]
    expect(spec.source).toMatchObject({ pins: "memory", land: "memory", check: { verdict: "pending" } })
    expect(spec.source?.check?.findings[0]).toContain("answered 503")
    // Still to be checked: verify_parts and the Checks button take it.
    expect(needsCheck(spec)).toBe(true)
  })

  it("shows in Checks until it is re-checked, and the re-check finds the wrong pins", async () => {
    const made = await create(input, down)
    let project = addComponent(made.project, made.project.parts![0].id).project
    expect(partFindings(project)[0]).toMatchObject({ severity: "warning" })
    expect(partFindings(project)[0].message).toContain("made while the supplier lookup was failing, and not checked since (The parts supplier answered 503 (search)")

    // Saved and read back, it is still pending.
    const back = parseProjectFile(serializeProject(project), { id: "p" })
    expect(back.parts![0].source?.check?.verdict).toBe("pending")

    // The supplier is back: the pending check is the first thing verify_parts takes, and it is wrong.
    const out = await executeTool(project, () => project, "verify_parts", {}, { parts: recordedSource() })
    expect(out.isError).toBe(false)
    project = out.project
    expect(project.parts![0].source?.check).toMatchObject({ verdict: "contradicted", lcsc: "C919459" })
    expect(needsCheck(project.parts![0])).toBe(false)
    expect(partFindings(project)[0].severity).toBe("error")
  })

  it("does not make a part when the lookup fails and there are no pins to make it from", async () => {
    const out = await create({ name: "TPS61023", category: "Power" }, down)
    expect(out.isError).toBe(true)
    expect(out.result).toContain("No supplier record to build TPS61023 from (the supplier lookup failed")
  })

  it("keeps a failed re-check pending rather than reading it as checked", async () => {
    const made = await create(input, down)
    const project = addComponent(made.project, made.project.parts![0].id).project
    const out = await executeTool(project, () => project, "verify_parts", {}, { parts: down })
    expect(out.isError).toBe(true)
    expect(out.project.parts![0].source?.check?.verdict).toBe("pending")
  })
})
