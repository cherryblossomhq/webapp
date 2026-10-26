import { describe, expect, it } from "vitest"
import { runTool } from "../src/ai/tools"
import { customPartId, registerProjectParts } from "../src/model/customParts"
import { addComponent, createProject, updateComponent } from "../src/model/ops"
import { partFindings } from "../src/model/partChecks"
import { parseProjectFile, serializeProject } from "../src/model/projectFile"
import type { CustomPartSpec, PartSource, Project } from "../src/model/types"

// What the Checks panel and run_checks say about project parts, and how a part's provenance is
// kept in the project file.

const draft = (source?: PartSource): Omit<CustomPartSpec, "id"> => ({
  name: "TPS61023",
  description: "boost",
  category: "Power",
  refPrefix: "U",
  footprint: "sot563",
  pins: "FB EN VIN GND SW VOUT".split(" ").map((name, i) => ({ number: String(i + 1), name })),
  props: { mpn: "TPS61023" },
  ...(source && { source }),
})

function withPart(source?: PartSource): Project {
  const d = draft(source)
  const spec = { id: customPartId(d), ...d }
  let p: Project = { ...createProject("p"), parts: [spec] }
  registerProjectParts(p)
  p = addComponent(p, spec.id).project
  return p
}

const supplier: PartSource = {
  pins: "supplier",
  land: "checked",
  supplier: { lcsc: "C919459", mpn: "TPS61023DRLR", confidence: "single_source", vendors: 1, fetchedAt: "2026-10-19T00:00:00.000Z" },
}

describe("part provenance in the Checks panel", () => {
  it("says nothing about a part built from supplier data", () => {
    expect(partFindings(withPart(supplier))).toEqual([])
  })

  it("warns about a part made from memory, or made before provenance existed", () => {
    const legacy = partFindings(withPart())
    expect(legacy).toEqual([
      expect.objectContaining({ severity: "warning", message: "U1 (TPS61023): pinout and footprint not verified against a supplier; made from memory" }),
    ])
    const memory = partFindings(withPart({ pins: "memory", land: "memory", note: "No supplier record for TPS61023" }))
    expect(memory[0].message).toBe("U1 (TPS61023): pinout and footprint not verified against a supplier; made from memory (No supplier record for TPS61023)")
  })

  it("makes a part a supplier contradicts an error, with what disagrees", () => {
    const found = partFindings(
      withPart({ pins: "memory", land: "memory", check: { at: "x", lcsc: "C919459", verdict: "contradicted", findings: ["pin 6 is VOUT (a supply output), drawn as VIN (a supply input)."] } }),
    )
    expect(found).toEqual([
      expect.objectContaining({ severity: "error", message: "U1 (TPS61023) doesn't match LCSC C919459. pin 6 is VOUT (a supply output), drawn as VIN (a supply input)." }),
    ])
  })

  it("warns when supplier drawings disagree, and when a checked land is swapped for another", () => {
    const disputed = withPart({ ...supplier, supplier: { ...supplier.supplier!, confidence: "disputed", disputes: ["LCSC C1's drawing disagrees: pin 1 is GND there, SIG here."] } })
    expect(partFindings(disputed)[0].message).toBe(
      "U1 (TPS61023): supplier drawings of LCSC C919459 disagree about its pins: LCSC C1's drawing disagrees: pin 1 is GND there, SIG here.",
    )
    let p = withPart(supplier)
    p = updateComponent(p, p.components[0].id, { footprint: "sot23_6" })
    expect(partFindings(p).map((f) => f.message)).toEqual(["U1 (TPS61023): footprint changed to sot23_6, which wasn't checked against the supplier's land"])
    expect(runTool(p, "run_checks", {}).result).toContain("- warning: U1 (TPS61023): footprint changed to sot23_6")
  })

  it("only reports parts that are on the board", () => {
    const d = draft()
    const p: Project = { ...createProject("p"), parts: [{ id: customPartId(d), ...d }] }
    expect(partFindings(p)).toEqual([])
  })
})

describe("part provenance in the project file", () => {
  it("is saved and read back, and doesn't change the part's id", () => {
    const p = withPart(supplier)
    const back = parseProjectFile(serializeProject(p), { id: "p" })
    expect(back.parts?.[0].source).toEqual(supplier)
    expect(customPartId(draft(supplier))).toBe(customPartId(draft()))
  })

  it("reads malformed provenance as none, keeping the part", () => {
    const p = withPart()
    const text = serializeProject({ ...p, parts: [{ ...p.parts![0], source: "verified" as unknown as PartSource }] })
    const back = parseProjectFile(text, { id: "p" })
    expect(back.parts).toHaveLength(1)
    expect(back.parts![0].source).toBeUndefined()
  })
})
