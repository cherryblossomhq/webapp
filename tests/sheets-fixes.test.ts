import { describe, expect, it } from "vitest"
import { computeConnectivity } from "../src/model/connectivity"
import { runErc } from "../src/model/erc"
import { importKicadSchematic } from "../src/model/kicad/schematic"
import { removalNote } from "../src/store/sheetScope"
import { setSheetSymbol } from "../src/model/sheetOps"
import { imp, files, S1 } from "./kicad-sheets-fixtures"

describe("a sheet pin joins only a hierarchical label", () => {
  const withLocal = () => {
    const f = files([{ uuid: S1, name: "Power", y: 60.96 }])
    f.set("child.kicad_sch", f.get("child.kicad_sch")!.replace("(hierarchical_label", "(label").replace("(shape input) ", "").replace("(justify left)", "(justify left bottom)"))
    const r = importKicadSchematic({ files: f, root: "root.kicad_sch" })
    if (r.status !== "imported") throw new Error(r.message)
    return r.project
  }
  it("a child with only a local label of the pin's name is not joined, and the ERC says so", () => {
    const project = withLocal()
    expect(project.labels[0].kind).not.toBe("hierarchical")
    const { nets } = computeConnectivity(project)
    // R1 and R2 are in no common net
    expect(nets.some((n) => n.pins.length === 2)).toBe(false)
    expect(runErc(project, computeConnectivity(project)).some((f) => f.kind === "sheet-pin-no-label")).toBe(true)
  })
  it("with a hierarchical label it is joined", () => {
    const { project } = imp()
    expect(computeConnectivity(project).nets.some((n) => n.pins.length === 2)).toBe(true)
    expect(runErc(project, computeConnectivity(project)).some((f) => f.kind === "sheet-pin-no-label")).toBe(false)
  })
})

describe("removalNote", () => {
  it("does not count the root as a sheet nothing uses when the only sheet goes", () => {
    const { project } = imp()
    const note = removalNote(project, [project.sheetSymbols![0].id])!
    expect(note).toMatch(/1 sheet that nothing else uses/)
    expect(note).not.toMatch(/2 sheets/)
  })
})

describe("sheet names are unique among siblings", () => {
  it("a rename to a sibling's name gets a free one, and the root-level name check ignores other sheets", () => {
    const { project } = imp([{ uuid: S1, name: "A", y: 60.96 }, { uuid: "00000000-0000-4000-8000-0000000000a2", name: "B", y: 90 }])
    const [a, b] = project.sheetSymbols!
    const next = setSheetSymbol(project, b.id, { name: "a" })
    expect(next.sheetSymbols!.find((s) => s.id === b.id)!.name).toBe("a2")
    expect(setSheetSymbol(project, a.id, { name: "A" }).sheetSymbols![0].name).toBe("A")
  })
})
