import { describe, expect, it } from "vitest"
import { resolvePartName } from "../src/ai/partLookup"
import { verifyProjectParts, withPartChecks } from "../src/ai/partTools"
import { executeTool, runTool } from "../src/ai/tools"
import { customPartId, customPartProblems, registerProjectParts } from "../src/model/customParts"
import { getFootprint } from "../src/model/footprints"
import { addComponent, createProject } from "../src/model/ops"
import { partFindings } from "../src/model/partChecks"
import { checkAgainstSupplier } from "../src/model/supplier/verify"
import type { CustomPartSpec, Project } from "../src/model/types"
import { PRODUCTION_PARTS, type ProductionPart } from "./fixtures/supplier/production"
import { RECORDED, recordedSource } from "./fixtures/supplier/source"

// The 13 parts Sakura made in production, replayed against what the supplier answered for them.
// Three had pin maps that kill the board (TPS61023, AD8318, LFCN-1700+) and must be refused; the
// others' maps were right and must pass; and eight footprints didn't fit their part (nine, with
// the msop10 numbering the footprinter gets wrong) and must be flagged.

const call = (p: ProductionPart) => ({ name: p.name, description: "made in production", category: "ICs", pins: p.pins, footprint: p.footprint })

async function create(project: Project, input: object) {
  const source = recordedSource()
  return executeTool(project, () => project, "create_part", input, { parts: source })
}

describe("the 13 production parts, against the supplier", () => {
  for (const p of PRODUCTION_PARTS) {
    it(`${p.name}: pins ${p.expect.pins}, footprint ${p.expect.footprint}`, async () => {
      // By name alone, with the drawing's own pins and footprint as hints: no orderable number needed.
      const resolved = await resolvePartName(recordedSource(), p.name, { pins: p.pins, footprint: p.footprint })
      const record = resolved.kind === "found" ? resolved.part : null
      if (p.expect.pins === "unverified") {
        expect(resolved.kind).toBe("none")
      } else {
        expect(resolved.kind, resolved.kind === "found" ? "" : JSON.stringify(resolved)).toBe("found")
        expect(record).not.toBeNull()
        if (!record) return
        const pins = checkAgainstSupplier({ pins: p.pins, footprint: null }, record)
        const land = checkAgainstSupplier({ pins: null, footprint: p.footprint }, record)
        expect(pins.refusals.length ? "refuse" : "pass").toBe(p.expect.pins)
        expect(land.refusals.length ? "flag" : "pass").toBe(p.expect.footprint)
        // Every refusal names pin numbers or millimetres, which is what the copilot acts on.
        for (const r of pins.refusals) expect(r).toMatch(/pin \d+ /)
        for (const r of land.refusals) expect(r).toMatch(/\d+(\.\d+)? mm/)
      }

      // The call Sakura made in production: name, pins and footprint, no lcsc.
      const out = await create(createProject(p.name), call(p))
      const wrong = p.expect.pins === "refuse" || p.expect.footprint === "flag"
      expect(out.isError).toBe(wrong)
      if (wrong) {
        expect(out.result).toContain("Can't make")
        expect(out.result).toMatch(/lcsc "C\d+"/)
        // Saying it is from memory doesn't get a wrong part made: the supplier's parts exist.
        const insisting = await create(createProject(p.name), { ...call(p), from_memory: true })
        expect(insisting.isError).toBe(true)
        expect(insisting.project.parts).toBeUndefined()
      } else {
        const spec = out.project.parts![0]
        expect(spec.source?.pins).toBe(p.expect.pins === "unverified" ? "memory" : "supplier")
        if (p.expect.pins === "unverified") expect(out.result).toContain("UNVERIFIED")
      }

      // Built from the supplier's record instead, it is made, on the supplier's land.
      if (record) {
        const rebuilt = await create(createProject(p.name), { lcsc: record.lcsc, category: "ICs" })
        expect(rebuilt.isError, rebuilt.result).toBe(false)
        const spec = rebuilt.project.parts![0]
        expect(spec.source).toMatchObject({ pins: "supplier", supplier: { lcsc: record.lcsc } })
        expect(["supplier", "checked"]).toContain(spec.source!.land)
        expect(customPartProblems(spec)).toEqual([])
        expect(spec.props).toMatchObject({ mpn: record.mpn, lcsc: record.lcsc })
      }
    })
  }

  it("makes a part from memory when the user's part really has other pin counts than every supplier part numbered like it, saying so", async () => {
    // Eight pins drawn for a name whose supplier parts all have six: they are other parts.
    const pins = "1:FB 2:EN 3:VIN 4:GND 5:SW 6:VOUT 7:NC 8:NC".split(" ").map((p) => ({ number: p.split(":")[0], name: p.split(":")[1] }))
    const input = { name: "TPS61023", description: "boost", category: "Power", pins, footprint: "soic8" }
    const refused = await create(createProject("boost"), input)
    expect(refused.isError).toBe(true)
    expect(refused.result).toContain("none of those numbered like it has the 8 pins you drew, so they are other parts")
    const made = await create(createProject("boost"), { ...input, from_memory: true })
    expect(made.isError, made.result).toBe(false)
    expect(made.project.parts![0].source).toMatchObject({ pins: "memory", land: "memory" })
    expect(made.result).toContain("UNVERIFIED (no supplier part is numbered exactly TPS61023, and those numbered like it have another pin count than the 8 drawn (C")
  })

  it("builds the TPS61023 from its record with its pins, its SOT-563 land and its exposed pad numbering", async () => {
    const out = await create(createProject("boost"), { lcsc: "C919459", category: "Power" })
    expect(out.isError).toBe(false)
    const spec = out.project.parts![0]
    expect(spec.pins.map((p) => `${p.number}:${p.name}:${p.kind ?? ""}`)).toEqual(["1:FB:", "2:EN:", "3:VIN:power", "4:GND:ground", "5:SW:", "6:VOUT:output"])
    expect(spec.footprint).toMatch(/^sot563_c919459-/)
    expect(out.project.footprints?.map((f) => f.name)).toEqual([spec.footprint])
    expect(getFootprint(spec.footprint).pads).toHaveLength(6)
    expect(out.result).toContain("from LCSC C919459")
  })

  it("keeps the TP4056's exposed pad, which production dropped", async () => {
    const tp = PRODUCTION_PARTS.find((p) => p.name === "TP4056")!
    const out = await create(createProject("charger"), { name: "TP4056", category: "Power", pins: tp.pins })
    expect(out.isError, out.result).toBe(false)
    const spec = out.project.parts![0]
    expect(spec.pins.find((p) => p.number === "9")).toMatchObject({ kind: "ground" })
    expect(getFootprint(spec.footprint).pads.filter((p) => p.pin === "9")).toHaveLength(1)
  })

  it("builds a module whose ground is a grid of pads sharing one number", async () => {
    const out = await create(createProject("wifi"), { lcsc: "C6191510", category: "Modules" })
    expect(out.isError, out.result).toBe(false)
    const spec = out.project.parts![0]
    expect(spec.pins).toHaveLength(39)
    const pads = getFootprint(spec.footprint).pads
    expect(pads.filter((p) => p.pin === "39").length).toBeGreaterThan(1)
    expect(customPartProblems(spec)).toEqual([])
  })

  it("asks for a footprint when the supplier's record has no land, and marks the land unchecked", async () => {
    const tps = structuredClone(RECORDED.parts.C919459!)
    const noLand = { ...tps, lcsc: "C1", land: null }
    const source = { search: async () => Promise.reject(new Error("unused")), part: async () => noLand }
    const p = createProject("y")
    const ask = await executeTool(p, () => p, "create_part", { lcsc: "C1", category: "Power" }, { parts: source })
    expect(ask.result).toBe("Error: LCSC C1 has no land pattern. Pass footprint, a footprinter string for SOT-563_L1.6-W1.2-P0.50-LS1.6-BR, or land with its pads from the datasheet.")
    const made = await executeTool(p, () => p, "create_part", { lcsc: "C1", category: "Power", footprint: "sot563" }, { parts: source })
    expect(made.isError, made.result).toBe(false)
    expect(made.project.parts![0].source).toMatchObject({ pins: "supplier", land: "memory" })
    // A footprint name that draws another package is refused even with nothing to compare it to.
    const bad = await executeTool(p, () => p, "create_part", { lcsc: "C1", category: "Power", footprint: "tssop8" }, { parts: source })
    expect(bad.result).toContain("tssop8 draws 8 pads, 0.5 mm pitch")
  })

  it("refuses a name sold in several packages until one is chosen, listing each with its LCSC number", async () => {
    const out = await create(createProject("uln"), { name: "ULN2003A", category: "ICs" })
    expect(out.isError).toBe(true)
    expect(out.result).toMatch(/ULN2003A is sold as \d+ supplier part numbers in 2 packages or pinouts, so it isn't one part: C\d+ ULN2003A, SOP-16.*; C\d+ ULN2003A, DIP-16.* They differ in: SOP-16 vs DIP-16\./)
    const ws = await create(createProject("ws"), { name: "WS2812B", category: "Diodes" })
    expect(ws.result).toMatch(/WS2812B is sold as \d+ supplier part numbers in \d packages or pinouts, so it isn't one part/)
    expect(ws.result).toContain("in another size")
  })
})

/** A project as production left it: parts from memory with no provenance, each placed once. */
function legacyProject(): Project {
  let project = createProject("legacy")
  const parts: CustomPartSpec[] = []
  for (const p of PRODUCTION_PARTS) {
    const pads = new Set(getFootprint(p.footprint).pads.map((pad) => pad.pin))
    // Production refused a pin with no pad (TP4056's exposed pad), so Sakura left it out.
    const draft: Omit<CustomPartSpec, "id"> = {
      name: p.name,
      description: "",
      category: "ICs",
      refPrefix: "U",
      footprint: p.footprint,
      pins: p.pins.filter((pin) => pads.has(pin.number)),
      props: { mpn: p.name },
    }
    parts.push({ id: customPartId(draft), ...draft })
  }
  project = { ...project, parts }
  registerProjectParts(project)
  for (const spec of parts) project = addComponent(project, spec.id).project
  return project
}

describe("checking a project's existing parts", () => {
  it("reports every part made from memory as unverified, until it is checked", () => {
    const project = legacyProject()
    const findings = partFindings(project)
    expect(findings).toHaveLength(13)
    expect(findings.every((f) => f.severity === "warning")).toBe(true)
    expect(findings.find((f) => f.message.startsWith("U5 "))?.message).toBe("U5 (TPS61023): pinout and footprint not verified against a supplier; made from memory")
    expect(runTool(project, "run_checks", {}).result).toContain("Parts (13):")
  })

  it("checks a remembered pin map against the parts numbered like its name, and never says 'no record' when there are some", async () => {
    const project = legacyProject()
    const { results } = await verifyProjectParts(project, recordedSource(), { limit: 13 })
    const tps = results.get(project.parts!.find((s) => s.name === "TPS61023")!.id)!
    // TPS61023 is sold as TPS61023DRLR: the name is a family, and its pins contradict it.
    expect(tps.verdict).toBe("contradicted")
    expect(tps.lcsc).toBe("C919459")
    expect(tps.findings.join(" ")).not.toMatch(/no supplier record|No supplier record/)
    expect(results.get(project.parts!.find((s) => s.name === "LFCN-1700+")!.id)?.verdict).toBe("contradicted")
  })

  it("finds the dead parts among them, as errors with the pin numbers", async () => {
    const project = legacyProject()
    const { results } = await verifyProjectParts(project, recordedSource(), { limit: 13 })
    const verdict = (name: string) => results.get(project.parts!.find((s) => s.name === name)!.id)?.verdict
    expect(verdict("TPS61023")).toBe("contradicted")
    expect(verdict("AD8318")).toBe("contradicted")
    expect(verdict("LFCN-1700+")).toBe("contradicted")
    expect(verdict("HFCN-650+")).toBe("no_record")
    // Right pins on a wrong land are contradicted too: the board can't be assembled.
    expect(verdict("SHT31-DIS")).toBe("contradicted")
    expect(verdict("ADS1115")).toBe("contradicted")
    expect(verdict("DW01A")).toBe("renamed")
    expect(verdict("USBLC6-2SC6")).toBe("renamed")
    expect(verdict("BLM18PG221SN1D")).toBe("agrees")

    const checked = withPartChecks(project, results)
    const findings = partFindings(checked)
    const tps = findings.find((f) => f.message.startsWith("U5 "))!
    expect(tps.severity).toBe("error")
    // Short enough for a list, and still with the pin numbers and the millimetres.
    expect(tps.message).toBe(
      "U5 (TPS61023) doesn't match LCSC C919459. 5 pins wrong: pin 2 is EN (a signal), drawn as GND (ground); " +
        "pin 3 is VIN (a supply input), drawn as EN (a signal); and 3 more. " +
        "Footprint sot23_6 doesn't fit its land: 6 of 6 pads miss the supplier's leads, pad 1 by 0.71 mm.",
    )
    // Checked and right: no longer reported.
    expect(findings.some((f) => f.message.includes("(DW01A)"))).toBe(false)
    expect(findings.find((f) => f.message.includes("(HFCN-650+)"))?.message).toContain("no supplier record was found for HFCN-650+")
  })

  it("is what verify_parts does, recorded on the parts as one undoable edit", async () => {
    const project = legacyProject()
    const out = await executeTool(project, () => project, "verify_parts", {}, { parts: recordedSource() })
    expect(out.isError).toBe(false)
    // Ten a call, so one call stays inside the parts API's lookups a minute, and the rest is said.
    expect(out.summary).toMatch(/^Checked 10 part\(s\) against supplier data, \d+ wrong$/)
    expect(out.result).toContain("Checked 10. 3 more were not tried yet: run it again for the rest.")
    expect(out.result).toContain("TPS61023")
    expect(out.project.parts!.find((s) => s.name === "TPS61023")!.source?.check?.verdict).toBe("contradicted")
    // The definitions are untouched, so their ids are too.
    expect(out.project.parts!.map((s) => s.id)).toEqual(project.parts!.map((s) => s.id))
  })
})
