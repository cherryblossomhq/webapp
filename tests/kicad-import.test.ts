import JSZip from "jszip"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { describeSource, verifyProjectParts } from "../src/ai/partTools"
import { customPartProblems } from "../src/model/customParts"
import { addDraftToProject } from "../src/model/indexPart"
import { pcbPads } from "../src/model/instances"
import { importKicadFiles, type KicadFile, type KicadImportPart } from "../src/model/kicadImport"
import { modelAssignment } from "../src/model/models3d"
import { addComponent, createProject } from "../src/model/ops"
import { needsCheck, partFindings } from "../src/model/partChecks"
import { partSourceLine } from "../src/model/partSource"
import { parseProjectFile, serializeProject } from "../src/model/projectFile"
import type { Project } from "../src/model/types"
import { importKicadPart, unpackFiles } from "../src/panels/kicadImport"
import { connectModelFiles, modelFileId } from "../src/store/modelFiles"
import { recordedSource } from "./fixtures/supplier/source"

// A user's own KiCad files imported from the library panel: a symbol library, the footprints its
// symbols name and their 3D models, read into project parts by the converter the parts database
// uses. The files are the KiCad library fixtures (`fixtures/kicad`), handed over as a user would.

const FIXTURES = join(__dirname, "fixtures", "kicad")
const file = (path: string, name = path): KicadFile => ({ name, text: readFileSync(join(FIXTURES, path), "utf8") })
const AP2204K = "symbols/Regulator_Linear.kicad_symdir/AP2204K-1.5.kicad_sym"
const SOT23_5 = "footprints/Package_TO_SOT_SMD.pretty/SOT-23-5.kicad_mod"
const SOIC8 = "footprints/Package_SO.pretty/SOIC-8_3.9x4.9mm_P1.27mm.kicad_mod"
const DIP8 = "footprints/Package_DIP.pretty/DIP-8_W7.62mm.kicad_mod"

/** A one-symbol library as a vendor's download writes one, with the fields given. */
const vendorSymbol = (fields: Record<string, string>) => ({
  name: "LDO.kicad_sym",
  text: readFileSync(join(FIXTURES, AP2204K), "utf8").replace(
    /\(property "Footprint" "[^"]*"/,
    Object.entries(fields)
      .map(([k, v]) => `(property "${k}" "${v}")`)
      .join(" ")
      .replace(/\)$/, ""),
  ),
})

function only(files: KicadFile[], models?: string[]): KicadImportPart {
  const found = importKicadFiles(files, models)
  expect(found.parts).toHaveLength(1)
  return found.parts[0]
}

function add(project: Project, part: KicadImportPart) {
  const added = addDraftToProject(project, part)
  if ("error" in added) throw new Error(added.error)
  return added
}

describe("pairing a symbol with its footprint", () => {
  it("puts a symbol on the footprint its field names, with the library left off", () => {
    const part = only([file(AP2204K), file(SOT23_5), file(SOIC8)])
    expect(part.draft).toMatchObject({ name: "AP2204K-1.5", category: "Power", refPrefix: "U", props: { mpn: "AP2204K-1.5" } })
    expect(part.draft.pins.map((p) => `${p.number}:${p.name}`).sort()).toEqual(["1:VIN", "2:GND", "3:EN", "4:NC", "5:VOUT"])
    expect(part.draft.source).toEqual({ pins: "file", land: "file", file: { symbol: "Regulator_Linear:AP2204K-1.5", footprint: "SOT-23-5" } })
    // The user's own land, named for its package family so the 3D view draws a SOT-23 body.
    expect(part.land?.name).toMatch(/^sot23_5_file_sot_23_5-[0-9a-z]{6}$/)
    expect(part.land?.package).toBe("SOT-23-5")
    expect(part.draft.footprint).toBe(part.land?.name)
  })

  it("puts one symbol on the one footprint given whatever its field says, and says so", () => {
    const found = importKicadFiles([vendorSymbol({ Footprint: "SOT95P280X145-5N" }), file(SOT23_5)])
    expect(found.parts).toHaveLength(1)
    expect(found.parts[0].draft.source?.file).toEqual({ symbol: "LDO:AP2204K-1.5", footprint: "SOT-23-5" })
    expect(found.problems).toEqual(["AP2204K-1.5 names the footprint SOT95P280X145-5N; it was put on SOT-23-5, the one given."])
  })

  it("among several, pairs by name only, so no symbol lands on another part's pads", () => {
    // NE555P extends NE555D, in its own file as KiCad 10 keeps them; given with the DIP only.
    const found = importKicadFiles([file("symbols/Timer.kicad_symdir/NE555P.kicad_sym"), file("symbols/Timer.kicad_symdir/NE555D.kicad_sym"), file(DIP8)])
    expect(found.parts.map((p) => p.draft.name)).toEqual(["NE555P"])
    expect(found.parts[0].draft.source?.file).toEqual({ symbol: "Timer:NE555P", footprint: "DIP-8_W7.62mm" })
    expect(found.problems).toEqual([])

    const two = importKicadFiles([file(AP2204K), file(DIP8), file(SOIC8)])
    expect(two.parts).toEqual([])
    expect(two.problems).toEqual(["AP2204K-1.5: its footprint Package_TO_SOT_SMD:SOT-23-5 wasn't among the files. Add its .kicad_mod file."])
  })

  it("imports a base symbol given in a library file of many, beside another library", () => {
    // Timer as one file of two symbols (NE555P extends NE555D), given with another library.
    const lib = (name: string, paths: string[]) => {
      const bodies = paths.map((p) => readFileSync(join(FIXTURES, p), "utf8")).map((t) => t.slice(t.indexOf('(symbol "'), t.lastIndexOf(")")))
      return { name, text: `(kicad_symbol_lib (version 20241209) (generator "test")\n${bodies.join("\n")}\n)` }
    }
    const found = importKicadFiles([lib("Timer.kicad_sym", ["symbols/Timer.kicad_symdir/NE555D.kicad_sym", "symbols/Timer.kicad_symdir/NE555P.kicad_sym"]), file(AP2204K), file(DIP8), file(SOIC8), file(SOT23_5)])
    expect(found.parts.map((p) => p.draft.name).sort()).toEqual(["AP2204K-1.5", "NE555D", "NE555P"])
  })

  it("says what's missing: no footprint, the base a symbol extends, a footprint the symbol doesn't fit", () => {
    expect(importKicadFiles([file(AP2204K)]).problems).toEqual(["AP2204K-1.5: its footprint Package_TO_SOT_SMD:SOT-23-5 wasn't among the files. Add its .kicad_mod file."])
    expect(importKicadFiles([vendorSymbol({ Footprint: "" })]).problems).toEqual(["AP2204K-1.5: no footprint was given. Add its .kicad_mod file."])
    expect(importKicadFiles([file("symbols/Timer.kicad_symdir/NE555P.kicad_sym"), file(DIP8)]).problems[0]).toMatch(/^NE555P can't be read: .*NE555D.*Add the symbol it extends\.$/)
    const misfit = importKicadFiles([vendorSymbol({ Footprint: "x" }), file(SOIC8)])
    expect(misfit.parts).toEqual([])
    expect(misfit.problems.at(-1)).toMatch(/^AP2204K-1\.5: a pad on the footprint has no pin on the symbol \(.*pads 6, 7, 8\)\.$/)
  })

  it("names a symbol picked from its own file by its name alone, not as its own library", () => {
    expect(only([file(AP2204K, "AP2204K-1.5.kicad_sym"), file(SOT23_5)]).draft.source?.file?.symbol).toBe("AP2204K-1.5")
  })

  it("passes power symbols over, and says so when that is all there was", () => {
    expect(importKicadFiles([file("symbols/power.kicad_symdir/+5V.kicad_sym"), file(SOT23_5)]).problems).toEqual([
      "The symbol library holds only power symbols, which are nets, not parts.",
    ])
  })

  it("refuses files that aren't KiCad's, with the file's name", () => {
    const found = importKicadFiles([
      { name: "broken.kicad_mod", text: "(footprint" },
      { name: "notes.kicad_sym", text: "(something_else)" },
    ])
    expect(found.parts).toEqual([])
    expect(found.problems[0]).toMatch(/^broken\.kicad_mod can't be read: /)
    expect(found.problems[1]).toMatch(/^notes\.kicad_sym can't be read: not a KiCad symbol library/)
  })

  it("reads a vendor's part number, maker and LCSC number from the symbol's fields", () => {
    const part = only([vendorSymbol({ Footprint: "SOT-23-5", MP: "AP2204K-1.5TRG1", MF: "Diodes Inc.", "LCSC Part": "c460333" }), file(SOT23_5)])
    expect(part.draft.name).toBe("AP2204K-1.5")
    expect(part.draft.props).toMatchObject({ mpn: "AP2204K-1.5TRG1", manufacturer: "Diodes Inc.", lcsc: "C460333" })
  })
})

describe("a footprint alone", () => {
  it("is a part with a pin for each pad, down one side and up the other", () => {
    const part = only([file(DIP8)])
    expect(part.draft).toMatchObject({ name: "DIP-8_W7.62mm", refPrefix: "U", props: { mpn: "DIP-8_W7.62mm" } })
    // Each side top to bottom, as a DIP's pins sit: 1 to 4 down the left, 8 to 5 down the right.
    expect(part.draft.pins.map((p) => `${p.number}${p.side?.[0]}`)).toEqual(["1l", "2l", "3l", "4l", "8r", "7r", "6r", "5r"])
    expect(part.draft.source?.file).toEqual({ symbol: null, footprint: "DIP-8_W7.62mm" })
    expect(partSourceLine({ ...part.draft, id: "x" })).toEqual({ label: "Imported KiCad files", detail: "Footprint DIP-8_W7.62mm, a pin for each pad" })
  })
})

describe("3D models", () => {
  it("takes KiCad's own model when the footprint names one from its 3D library and no file is given", () => {
    const part = only([file(AP2204K), file(SOT23_5)])
    expect(part.modelFile).toBeNull()
    expect(part.model).toMatchObject({ source: "kicad", id: "10.0.7/Package_TO_SOT_SMD.3dshapes/SOT-23-5.step", origin: "model", format: "step" })
  })

  it("takes a file given for the model the footprint names, placed as the footprint places it", () => {
    const fp = {
      name: "SOT-23-5.kicad_mod",
      text: readFileSync(join(FIXTURES, SOT23_5), "utf8").replace(
        /\(model "[^"]*"[\s\S]*?\(rotate\s*\(xyz [^)]*\)\s*\)\s*\)/,
        `(model "\${KIPRJMOD}/3d/ap2204.wrl" (offset (xyz 0.5 -0.25 0.1)) (scale (xyz 1 1 1)) (rotate (xyz -90 0 90)))`,
      ),
    }
    // Asked for the WRL, given the STEP of the same name: the STEP is taken, by its own units.
    const step = only([file(AP2204K), fp], ["readme.txt", "ap2204.step"])
    expect(step.model).toBeNull()
    expect(step.modelFile).toEqual({ name: "ap2204.step", placement: { offset: { x: 0.5, y: -0.25, z: 0.1 }, rotation: { x: 90, y: 0, z: -90 } } })
    // Given the WRL itself: KiCad's VRML is in tenths of an inch.
    expect(only([file(AP2204K), fp], ["AP2204.WRL"]).modelFile).toEqual({
      name: "AP2204.WRL",
      placement: { offset: { x: 0.5, y: -0.25, z: 0.1 }, rotation: { x: 90, y: 0, z: -90 }, scale: 2.54 },
    })
  })

  it("reads a KiCad 5 footprint's model: its offset in inches, KiCad's library by its old name", () => {
    const legacy = (model: string) => ({
      name: "SOT-23-5.kicad_mod",
      text: readFileSync(join(FIXTURES, SOT23_5), "utf8").replace(/\(model "[^"]*"[\s\S]*?\(rotate\s*\(xyz [^)]*\)\s*\)\s*\)/, model),
    })
    const given = only([file(AP2204K), legacy(`(model "ap2204.step" (at (xyz 0.1 0 0)) (scale (xyz 1 1 1)) (rotate (xyz 0 0 0)))`)], ["ap2204.step"])
    expect(given.modelFile?.placement?.offset).toEqual({ x: 2.54, y: 0, z: 0 })
    const library = only([file(AP2204K), legacy(`(model "\${KISYS3DMOD}/Package_TO_SOT_SMD.3dshapes/SOT-23-5.wrl" (at (xyz 0 0 0)) (scale (xyz 1 1 1)) (rotate (xyz 0 0 0)))`)])
    expect(library.model).toMatchObject({ source: "kicad", id: "10.0.7/Package_TO_SOT_SMD.3dshapes/SOT-23-5.step" })
  })

  it("takes the one model file given for the one part, to be fitted, when the footprint names none it has", () => {
    const part = only([file(AP2204K), file(SOT23_5)], ["vendor_model.step"])
    expect(part.modelFile).toEqual({ name: "vendor_model.step", placement: null })
    expect(part.model).toBeNull()
  })
})

describe("in the project", () => {
  it("is a part that builds, places on its own pads, and comes back from a save", () => {
    const { project, spec, added } = add(createProject("ldo"), only([file(AP2204K), file(SOT23_5)]))
    expect(added).toBe(true)
    expect(customPartProblems(spec)).toEqual([])
    expect(project.footprints?.map((f) => f.name)).toEqual([spec.footprint])
    expect(modelAssignment(project, spec.id, spec.footprint)?.source).toBe("kicad")
    const placed = addComponent(project, spec.id, { sch: { x: 0, y: 0 } }).project
    expect(pcbPads(placed.components[0]).map((p) => p.pin).sort()).toEqual(["1", "2", "3", "4", "5"])

    const again = parseProjectFile(serializeProject(placed), { id: project.id })
    expect(again.parts![0].source).toEqual(spec.source)
    const nameless = JSON.parse(serializeProject(placed))
    delete nameless.project.parts[0].source.file
    expect(parseProjectFile(nameless, { id: project.id }).parts![0].source).toMatchObject({ pins: "memory", land: "memory" })
  })

  it("is the user's word for the part: no check asked for, nothing reported, its files named", () => {
    const { project, spec } = add(createProject("ldo"), only([file(AP2204K), file(SOT23_5)]))
    const placed = addComponent(project, spec.id, { sch: { x: 0, y: 0 } }).project
    expect(needsCheck(spec)).toBe(false)
    expect(partFindings(placed)).toEqual([])
    expect(partSourceLine(spec)).toEqual({ label: "Imported KiCad files", detail: "Regulator_Linear:AP2204K-1.5 on SOT-23-5" })
    expect(describeSource(spec)).toBe(
      "imported from the user's own KiCad files (symbol Regulator_Linear:AP2204K-1.5, footprint SOT-23-5), pins and land from them",
    )
  })

  it("is compared with the supplier by its pins only when named: its land is the user's own", async () => {
    const part = only([file("symbols/Regulator_Linear.kicad_symdir/AMS1117-3.3.kicad_sym"), file("symbols/Regulator_Linear.kicad_symdir/AP1117-15.kicad_sym"), file("footprints/Package_TO_SOT_SMD.pretty/SOT-223-3_TabPin2.kicad_mod")])
    const { project, spec } = add(createProject("ldo"), { ...part, draft: { ...part.draft, props: { ...part.draft.props, lcsc: "C6186" } } })
    // KiCad's SOT-223 is drawn with other pads than LCSC's: that is no reason to call the part wrong.
    const { results } = await verifyProjectParts(project, recordedSource(), { only: [spec.id] })
    expect(results.get(spec.id)).toMatchObject({ lcsc: "C6186", verdict: "renamed" })
  })

  it("is added once: the same files imported again give the part already there", () => {
    const first = add(createProject("ldo"), only([file(AP2204K), file(SOT23_5)]))
    const second = add(first.project, only([file(AP2204K), file(SOT23_5)]))
    expect(second.added).toBe(false)
    expect(second.project.parts).toHaveLength(1)
  })
})

// ---------- the panel's side: files and zips ----------

const asFile = (path: string, name = path.slice(path.lastIndexOf("/") + 1)) => new File([readFileSync(join(FIXTURES, path))], name)

describe("the files a user hands over", () => {
  it("opens a vendor's zip, wherever in it the KiCad files are, and leaves out the rest", async () => {
    const zip = new JSZip()
    zip.file("KiCad/AP2204K.kicad_sym", readFileSync(join(FIXTURES, AP2204K)))
    zip.file("KiCad/footprints.pretty/SOT-23-5.kicad_mod", readFileSync(join(FIXTURES, SOT23_5)))
    zip.file("Altium/AP2204K.SchLib", "x")
    zip.file("__MACOSX/KiCad/._AP2204K.kicad_sym", "x")
    zip.file("how-to-import.htm", "x")
    const bytes = await zip.generateAsync({ type: "arraybuffer" })
    const { files, problems } = await unpackFiles([new File([bytes], "AP2204K.zip"), new File(["x"], "old.lib"), new File(["x"], "photo.png")])
    expect(files.map((f) => f.name)).toEqual(["KiCad/AP2204K.kicad_sym", "KiCad/footprints.pretty/SOT-23-5.kicad_mod"])
    expect(problems).toEqual([
      "old.lib is a KiCad 5 library, which isn't read. Save it from KiCad 6 or later, or download the part for KiCad 6+.",
      "photo.png isn't a KiCad symbol (.kicad_sym), footprint (.kicad_mod) or 3D model file.",
    ])
  })

  it("adds the parts to the open project as one edit, and keeps a model file only where they can be kept", async () => {
    let project = createProject("import")
    let edits = 0
    const commit = (edit: (p: Project) => Project) => {
      edits++
      project = edit(project)
    }
    const outcome = await importKicadPart([asFile(AP2204K), asFile(SOT23_5), new File(["solid"], "ap2204.step")], project.id, commit)
    expect(edits).toBe(1)
    expect(outcome.names).toEqual(["AP2204K-1.5"])
    expect(project.parts?.map((p) => p.id)).toEqual(outcome.partIds)
    // This editor has no model store: the part comes in on its generated body, and that is said.
    expect(outcome.problems).toEqual(["AP2204K-1.5 came in without its 3D model: model files can't be kept in this editor."])
    expect(modelAssignment(project, outcome.partIds[0], project.parts![0].footprint)).toBeNull()
  })

  it("gives a part already in the project the model file handed over with it again", async () => {
    const kept = new Map<string, ArrayBuffer>()
    connectModelFiles({
      async put({ bytes }) {
        const id = await modelFileId(bytes)
        kept.set(id, bytes)
        return id
      },
      get: async (id) => kept.get(id) ?? null,
    })
    try {
      let project = createProject("import")
      const commit = (edit: (p: Project) => Project) => {
        project = edit(project)
      }
      const first = await importKicadPart([asFile(AP2204K), asFile(SOT23_5)], project.id, commit)
      expect(modelAssignment(project, first.partIds[0], project.parts![0].footprint)?.source).toBe("kicad")
      const cube = new File(["v 0 0 0\nv 1 0 0\nv 0 1 0\nv 0 0 1\nf 1 2 3\nf 1 2 4\nf 1 3 4\nf 2 3 4\n"], "ap2204.obj")
      const again = await importKicadPart([asFile(AP2204K), asFile(SOT23_5), cube], project.id, commit)
      expect(again.problems).toEqual([])
      expect(again.partIds).toEqual(first.partIds)
      expect(project.parts).toHaveLength(1)
      expect(modelAssignment(project, first.partIds[0], project.parts![0].footprint)).toMatchObject({ source: "file", name: "ap2204.obj" })
    } finally {
      connectModelFiles(null)
    }
  })

  it("adds nothing to a project that is no longer the open one", async () => {
    const project = createProject("closed")
    const outcome = await importKicadPart([asFile(AP2204K), asFile(SOT23_5)], "another", (edit) => edit(project))
    expect(outcome.partIds).toEqual([])
    expect(outcome.problems).toEqual(["The project was closed before the parts were ready."])
  })

  it("says a model file alone isn't a part", async () => {
    const outcome = await importKicadPart([new File(["solid"], "part.step")], "p", () => {})
    expect(outcome.problems).toEqual(["A 3D model file alone isn't a part: add the part's symbol and footprint, or add the model to a placed part in the Inspector."])
  })
})
