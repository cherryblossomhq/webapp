import type { PartSearchResponse } from "@cherryblossom/api-contract"
import { describe, expect, it } from "vitest"
import type { SupplierPartsSource } from "../src/ai/supplierParts"
import { addDraftToProject } from "../src/model/indexPart"
import { addComponent, createProject } from "../src/model/ops"
import { partFindings } from "../src/model/partChecks"
import { checkPlacedPart } from "../src/model/placedPartCheck"
import { draftFromSupplierPart } from "../src/model/supplierPart"
import type { CustomPartSpec, Project } from "../src/model/types"
import { recordedPart, recordedSource } from "./fixtures/supplier/source"

// A KiCad part placed from the library panel is checked against the supplier in the background.
// The part here is the TPS61023's supplier pinout and land, dressed as a stored KiCad part named
// the way a KiCad library names it (TPS61023), so the supplier's own record is the right answer.

function kicadPart(edit: (spec: CustomPartSpec) => CustomPartSpec = (s) => s): { project: Project; spec: CustomPartSpec } {
  const built = draftFromSupplierPart(recordedPart("C919459"))
  if ("error" in built) throw new Error(built.error)
  const draft = edit({
    ...built.draft,
    id: "",
    name: "TPS61023",
    props: { mpn: "TPS61023" },
    source: { pins: "database", land: "database", database: { origin: "kicad", key: "Regulator_Switching:TPS61023", licence: "CC-BY-SA-4.0", attribution: "KiCad" } },
  })
  const { id: _id, ...rest } = draft
  const added = addDraftToProject(createProject("boost"), { ...built, draft: rest })
  if ("error" in added) throw new Error(added.error)
  return { project: added.project, spec: added.spec }
}

function host(project: Project) {
  const state = { project: project as Project | null }
  return { state, open: () => state.project, record: (edit: (p: Project) => Project) => void (state.project = edit(state.project!)) }
}

const empty: PartSearchResponse = { query: "x", candidates: [], source: "easyeda", fetchedAt: "2026-10-22T00:00:00.000Z", attribution: "test" }

describe("checking a placed KiCad part against the supplier", () => {
  it("records that the drawing agrees with the supplier's record", async () => {
    const { project, spec } = kicadPart()
    const h = host(project)
    const result = await checkPlacedPart({ source: recordedSource(), spec, projectId: project.id, open: h.open, record: h.record })
    expect(result).toMatchObject({ verdict: "agrees", lcsc: "C919459" })
    expect(h.state.project!.parts![0].source).toMatchObject({ pins: "database", check: { verdict: "agrees" } })
  })

  it("records a contradiction, which Checks shows as an error once the part is on the board", async () => {
    // The input and the output pin swapped: the TPS61023 mistake that kills a board.
    const { project, spec } = kicadPart((s) => {
      const names = s.pins.map((p) => p.name)
      const vin = names.indexOf("VIN")
      const sw = names.indexOf("SW")
      const pins = s.pins.map((p, i) => (i === vin ? { ...p, name: "SW", kind: undefined } : i === sw ? { ...p, name: "VIN", kind: undefined } : p))
      return { ...s, pins }
    })
    const h = host(addComponent(project, spec.id).project)
    const result = await checkPlacedPart({ source: recordedSource(), spec, projectId: project.id, open: h.open, record: h.record })
    expect(result?.verdict).toBe("contradicted")
    const findings = partFindings(h.state.project!)
    expect(findings.some((f) => f.severity === "error" && f.message.includes("doesn't match LCSC"))).toBe(true)
  })

  it("does nothing for a part made from the supplier's record (EasyEDA)", async () => {
    const { project, spec } = kicadPart((s) => ({ ...s, source: { ...s.source!, database: { ...s.source!.database!, origin: "easyeda" } } }))
    const source = recordedSource()
    const h = host(project)
    expect(await checkPlacedPart({ source, spec, projectId: project.id, open: h.open, record: h.record })).toBeNull()
    expect(source.calls).toEqual([])
    expect(h.state.project!.parts![0].source?.check).toBeUndefined()
  })

  it("does nothing without a supplier, or when the part was checked already", async () => {
    const { project, spec } = kicadPart()
    const h = host(project)
    expect(await checkPlacedPart({ source: null, spec, projectId: project.id, open: h.open, record: h.record })).toBeNull()
    const checked = { ...spec, source: { ...spec.source!, check: { at: "2026-10-22T00:00:00.000Z", verdict: "agrees" as const, findings: [] } } }
    const source = recordedSource()
    expect(await checkPlacedPart({ source, spec: checked, projectId: project.id, open: h.open, record: h.record })).toBeNull()
    expect(source.calls).toEqual([])
  })

  it("records a failed lookup as pending, and what the supplier said about a name it lacks or whose parts have other pins", async () => {
    const { project, spec } = kicadPart()
    const failing: SupplierPartsSource = { search: async () => Promise.reject(new Error("Busy.")), part: async () => null }
    const none: SupplierPartsSource = { search: async () => empty, part: async () => null }
    // ADS1115 drawn with TPS61023's six pins: the supplier's ADS1115s have other pin counts.
    const several = recordedSource()
    const ads = { ...spec, name: "ADS1115", props: { mpn: "ADS1115" } }
    // A failed lookup is retried later (verify_parts takes a pending database part); the others are the
    // verdicts verify_parts would record, which Checks shows nothing for on a part built from data.
    for (const [source, part, verdict] of [[failing, spec, "pending"], [none, spec, "no_record"], [several, ads, "different_part"]] as const) {
      const h = host(project)
      expect(await checkPlacedPart({ source, spec: part, projectId: project.id, open: h.open, record: h.record })).toMatchObject({ verdict })
      expect(partFindings(h.state.project!)).toEqual(partFindings(project))
    }
  })

  it("records nothing when the project was closed or changed, and hands the history a verdict for a part undone meanwhile", async () => {
    const { project, spec } = kicadPart()
    const closed = host(project)
    closed.state.project = null
    expect(await checkPlacedPart({ source: recordedSource(), spec, projectId: project.id, open: closed.open, record: closed.record })).toBeNull()

    const other = host(createProject("another"))
    expect(await checkPlacedPart({ source: recordedSource(), spec, projectId: project.id, open: other.open, record: other.record })).toBeNull()

    // Undone while the lookup ran: the verdict still goes to `record` (the store's `patch` writes it
    // into the snapshot Redo brings back, and the panel's wrapper leaves a project without the part as it is).
    const undone = { ...project, parts: [] }
    const edits: ((p: Project) => Project)[] = []
    const result = await checkPlacedPart({ source: recordedSource(), spec, projectId: project.id, open: () => undone, record: (edit) => void edits.push(edit) })
    expect(result).toMatchObject({ verdict: "agrees" })
    expect(edits).toHaveLength(1)
    expect(edits[0](project).parts?.find((s) => s.id === spec.id)?.source?.check?.verdict).toBe("agrees")
  })

  it("keeps the edits made while the lookup ran", async () => {
    const { project, spec } = kicadPart()
    const h = host(project)
    const source = recordedSource({ delayMs: 5 })
    const checking = checkPlacedPart({ source, spec, projectId: project.id, open: h.open, record: h.record })
    h.state.project = { ...project, name: "renamed meanwhile" }
    await checking
    expect(h.state.project.name).toBe("renamed meanwhile")
    expect(h.state.project.parts![0].source?.check?.verdict).toBe("agrees")
  })
})
