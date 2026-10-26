import type { PartIndexPart } from "@cherryblossom/api-contract"
import { join } from "node:path"
import { beforeAll, describe, expect, it } from "vitest"
import { describeSource } from "../src/ai/partTools"
import { buildCustomPart, customPartProblems } from "../src/model/customParts"
import { addDraftToProject, draftFromIndexPart } from "../src/model/indexPart"
import { pcbPads } from "../src/model/instances"
import { convertLibraries, type Imported } from "../src/model/kicad/library"
import { addComponent, createProject } from "../src/model/ops"
import { needsCheck, partFindings } from "../src/model/partChecks"
import { partSourceLine } from "../src/model/partSource"
import { parseProjectFile, serializeProject } from "../src/model/projectFile"
import type { CustomPartSpec, Project } from "../src/model/types"

// Parts the parts index stores whole (KiCad's libraries, converted by `model/kicad` when the
// database is filled), placed from the library panel: the wire part `GET /api/v1/parts/index/{id}`
// answers, built into a project part and added to a project.

const FIXTURES = join(__dirname, "fixtures", "kicad")
const ATTRIBUTION = "Symbols, footprints and 3D models from the KiCad libraries (https://gitlab.com/kicad/libraries), © KiCad library contributors, CC BY-SA 4.0."

let imported: Imported
beforeAll(async () => {
  imported = await convertLibraries({ symbols: join(FIXTURES, "symbols"), footprints: join(FIXTURES, "footprints"), release: "10.0.7" })
})

/** A converted fixture part as the route serves it, as the parts database stores and reads it. */
function stored(key: string, id = "42"): PartIndexPart {
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
      converter: "kicad@1",
      release: row.release,
      footprint: row.footprintKey,
      licence: "CC-BY-SA-4.0 WITH KiCad-libraries-exception",
      attribution: ATTRIBUTION,
      fetchedAt: "2026-10-22T00:00:00.000Z",
    },
  }
}

function place(project: Project, key: string) {
  const built = draftFromIndexPart(stored(key))
  if ("error" in built) throw new Error(built.error)
  const added = addDraftToProject(project, built)
  if ("error" in added) throw new Error(added.error)
  return added
}

describe("a stored KiCad part as a project part", () => {
  it("AMS1117-3.3: pins by role, the SOT-223's own land with its tab, and where it came from", () => {
    const { project, spec, added } = place(createProject("ldo"), "Regulator_Linear:AMS1117-3.3")
    expect(added).toBe(true)
    expect(spec).toMatchObject({ name: "AMS1117-3.3", category: "Power", refPrefix: "U", valueProp: "mpn", props: { mpn: "AMS1117-3.3" } })
    expect(spec.pins).toEqual([
      { number: "3", name: "VI", kind: "power", side: "left" },
      { number: "2", name: "VO", kind: "output", side: "right" },
      { number: "1", name: "GND", kind: "ground", side: "bottom" },
    ])
    expect(spec.source).toEqual({
      pins: "database",
      land: "database",
      database: {
        origin: "kicad",
        key: "Regulator_Linear:AMS1117-3.3",
        release: "10.0.7",
        footprint: "Package_TO_SOT_SMD:SOT-223-3_TabPin2",
        licence: "CC-BY-SA-4.0 WITH KiCad-libraries-exception",
        attribution: ATTRIBUTION,
      },
    })
    // The land is the project's own, named for its package family so the 3D view draws a SOT-223.
    expect(spec.footprint).toMatch(/^sot223_kicad_regulator_linear_ams1117_3_3-[0-9a-z]{6}$/)
    const land = project.footprints!.find((f) => f.name === spec.footprint)!
    expect(land.pads.filter((p) => p.pin === "2")).toHaveLength(2)
    expect(customPartProblems(spec)).toEqual([])

    const placed = addComponent(project, spec.id, { sch: { x: 0, y: 0 } }).project
    expect(pcbPads(placed.components[0]).map((p) => p.pin).sort()).toEqual(["1", "2", "2", "3"])
  })

  it("is trusted as data: no check is asked for, nothing is reported, and it says its source and credit", () => {
    const { project, spec } = place(createProject("ldo"), "Regulator_Linear:AMS1117-3.3")
    const placed = addComponent(project, spec.id, { sch: { x: 0, y: 0 } }).project
    expect(needsCheck(spec)).toBe(false)
    expect(partFindings(placed)).toEqual([])
    expect(describeSource(spec)).toBe("from the KiCad library part Regulator_Linear:AMS1117-3.3 (release 10.0.7), pins and land from the library")
    expect(partSourceLine(spec)).toEqual({
      label: "KiCad library",
      detail: "Regulator_Linear:AMS1117-3.3, release 10.0.7",
      credit: `${ATTRIBUTION} Licence: CC-BY-SA-4.0 WITH KiCad-libraries-exception.`,
    })
  })

  it("says how a memory part's supplier check came out, as Checks does", () => {
    const memory = (check?: NonNullable<CustomPartSpec["source"]>["check"]) =>
      ({ source: { pins: "memory", land: "memory", ...(check ? { check } : {}) } }) as CustomPartSpec
    const at = "2026-10-22T00:00:00Z"
    expect(partSourceLine(memory())?.detail).toBe("Pins and footprint not checked against a supplier.")
    expect(partSourceLine(memory({ at, lcsc: "C919459", verdict: "agrees", findings: [] }))?.detail).toBe("Checked against LCSC C919459: it agrees.")
    expect(partSourceLine(memory({ at, lcsc: "C919459", verdict: "contradicted", findings: ["Pin 5 is VOUT, drawn as VIN."] }))?.detail).toBe(
      "Contradicted by LCSC C919459: Pin 5 is VOUT, drawn as VIN.",
    )
  })

  it("keeps its source through a save and a reload, and reads one that names no part as memory", () => {
    const { project, spec } = place(createProject("ldo"), "Regulator_Linear:AMS1117-3.3")
    const again = parseProjectFile(serializeProject(project), { id: project.id })
    expect(again.parts![0].source).toEqual(spec.source)
    const nameless = JSON.parse(serializeProject(project))
    delete nameless.project.parts[0].source.database
    expect(parseProjectFile(nameless, { id: project.id }).parts![0].source).toMatchObject({ pins: "memory", land: "memory" })
  })

  it("is added once: the same part picked again is the one already there", () => {
    const first = place(createProject("ldo"), "Regulator_Linear:AMS1117-3.3")
    const second = place(first.project, "Regulator_Linear:AMS1117-3.3")
    expect(second.added).toBe(false)
    expect(second.spec.id).toBe(first.spec.id)
    expect(second.project.parts).toHaveLength(1)
  })

  it("builds every fixture part that converts: QFN exposed pads, multi-unit op-amps, BGAs, slots, mounting pads", () => {
    let project = createProject("all")
    for (const row of imported.parts) {
      const added = place(project, row.key)
      project = added.project
      expect(customPartProblems(added.spec), row.key).toEqual([])
      expect(() => buildCustomPart(added.spec), row.key).not.toThrow()
    }
    expect(project.parts).toHaveLength(imported.parts.length)
    // The exposed pad TPS61040DRV's symbol leaves out is a pin, and its pad is marked as one.
    const boost = project.parts!.find((s) => s.name === "TPS61040DRV")!
    expect(boost.pins.find((p) => p.name === "EP")).toMatchObject({ kind: "ground" })
    const ep = boost.pins.find((p) => p.name === "EP")!.number
    expect(project.footprints!.find((f) => f.name === boost.footprint)!.pads.find((p) => p.pin === ep)).toMatchObject({ exposed: true })
  })

  it("says what stops a part with no land or no pins", () => {
    expect(draftFromIndexPart({ ...stored("Regulator_Linear:AMS1117-3.3"), land: { pads: [], silk: [], from: "x" } })).toEqual({ error: "AMS1117-3.3 has no land pattern" })
    expect(draftFromIndexPart({ ...stored("Regulator_Linear:AMS1117-3.3"), pins: [] })).toEqual({ error: "AMS1117-3.3 has no pins" })
  })
})
