import { describe, expect, it } from "vitest"
import { computeConnectivity } from "../src/model/connectivity"
import { addComponent, createProject } from "../src/model/ops"
import { parseProjectFile, serializeProject } from "../src/model/projectFile"
import { addSheet, addSheetUse, setSheetSymbol } from "../src/model/sheetOps"
import { commitOnUse, MAX_SHEET_DEPTH, MAX_SHEET_USES, refusedSheetSymbols, sheetUses } from "../src/model/sheets"
import { type Project, type SheetSymbol } from "../src/model/types"
import { projectApi } from "../src/store/projectStore"
import { files, imp, S1 } from "./kicad-sheets-fixtures"
import { runErc } from "../src/model/erc"
import { importKicadSchematic } from "../src/model/kicad/schematic"
import { removalNote } from "../src/store/sheetScope"

// Sheets from a file nobody checked: loops, depth, width, garbage numbers. A named refusal or a repair, never a hang or a crash.

const symbol = (id: string, sheet: string, child: string, extra: Partial<SheetSymbol> = {}): SheetSymbol => ({ id, sheet, child, x: 0, y: 0, w: 1, h: 1, name: id, pins: [], ...extra })
const withSheets = (symbols: SheetSymbol[]): Project => {
  const ids = [...new Set(symbols.flatMap((s) => [s.sheet, s.child]))].filter((id) => id !== "root")
  return { ...createProject("hostile"), sheets: [{ id: "root" }, ...ids.map((id) => ({ id }))], sheetSymbols: symbols }
}
const roundTrip = (p: Project) => parseProjectFile(serializeProject(p), { id: p.id })

describe("a project file with sheets that loop", () => {
  it("drops the sheet symbol that closes a loop, and one that holds its own sheet", () => {
    const p = roundTrip(withSheets([symbol("h1", "root", "s1"), symbol("h2", "s1", "s1"), symbol("h3", "s1", "s2"), symbol("h4", "s2", "s1"), symbol("h5", "s2", "root")]))
    expect(p.sheetSymbols?.map((s) => s.id)).toEqual(["h1", "h3"])
    expect(sheetUses(p).map((u) => u.path)).toEqual(["", "/h1", "/h1/h3"])
  })

  it("repairs a symbol with garbage numbers, a name twice and a pin with no name, and keeps the rest", () => {
    const raw = JSON.parse(serializeProject(withSheets([symbol("h1", "root", "s1"), symbol("h2", "root", "s1")])))
    raw.project.sheetSymbols[0].x = "nope"
    raw.project.sheetSymbols[1].id = "h1"
    raw.project.sheetSymbols.push({ ...raw.project.sheetSymbols[1], id: "h3", pins: [{ id: "p1", name: 5, x: 0, y: 0 }, { id: "p2", name: "OK", x: 1, y: 1, shape: "weird", rot: 45 }] })
    const p = parseProjectFile(raw, { id: "x" })
    // the symbol with a number that is not one is dropped; of two with one id the first that is valid is kept
    expect(p.sheetSymbols?.map((s) => s.id)).toEqual(["h1", "h3"])
    expect(p.sheetSymbols?.find((s) => s.id === "h3")?.pins).toEqual([{ id: "p2", name: "OK", shape: "bidirectional", x: 1, y: 1, rot: 0 }])
  })
})

describe("a tree too deep or too wide to use", () => {
  it("stops at the depth limit and names the symbols it left out", () => {
    const chain = Array.from({ length: MAX_SHEET_DEPTH + 40 }, (_, i) => symbol(`h${i}`, i === 0 ? "root" : `s${i - 1}`, `s${i}`))
    const p = withSheets(chain)
    const started = Date.now()
    expect(sheetUses(p).length).toBeLessThanOrEqual(MAX_SHEET_DEPTH + 1)
    expect(refusedSheetSymbols(p).length).toBeGreaterThan(0)
    computeConnectivity(p)
    expect(Date.now() - started).toBeLessThan(3000)
  })

  it("stops at the number of uses and is fast about it", () => {
    const wide: SheetSymbol[] = []
    for (let i = 0; i < 30; i++) wide.push(symbol(`a${i}`, "root", "s1"))
    for (let i = 0; i < 30; i++) wide.push(symbol(`b${i}`, "s1", "s2"))
    for (let i = 0; i < 30; i++) wide.push(symbol(`c${i}`, "s2", "s3"))
    const p = withSheets(wide)
    const started = Date.now()
    expect(sheetUses(p).length).toBeLessThanOrEqual(MAX_SHEET_USES)
    expect(refusedSheetSymbols(p).length).toBeGreaterThan(0)
    expect(Date.now() - started).toBeLessThan(3000)
  })

  it("a sheet used two thousand times is worked out in a moment", () => {
    const many = Array.from({ length: 2000 }, (_, i) => symbol(`h${i}`, "root", "s1"))
    const p = withSheets(many)
    const started = Date.now()
    const c = computeConnectivity(p)
    expect(c.nets).toEqual([])
    expect(Date.now() - started).toBeLessThan(3000)
  })
})

describe("what is keyed by a net's name follows a renamed sheet", () => {
  it("copper on /Power/VIN is on /Pwr/VIN after the sheet is renamed", () => {
    const { project } = imp()
    const net = computeConnectivity(project).nets.find((n) => n.pins.length === 2)!
    expect(net.name).toBe("/Power/VIN")
    const withTrace: Project = { ...project, traces: [{ id: "t1", net: net.name, layer: "top", width: 0.25, points: [{ x: 0, y: 0 }, { x: 1, y: 0 }] }] as Project["traces"] }
    projectApi().open(withTrace)
    projectApi().commit((p) => setSheetSymbol(p, p.sheetSymbols![0].id, { name: "Pwr" }))
    expect(computeConnectivity(projectApi().project!).nets.some((n) => n.name === "/Pwr/VIN")).toBe(true)
    expect(projectApi().project!.traces[0].net).toBe("/Pwr/VIN")
  })
})

describe("a big sheet used many times", () => {
  it("an edit on one use is made in the other nineteen in a moment, and the references stay one to a part", () => {
    let p = createProject("big")
    const added = addSheet(p, "", { minX: 0, minY: -2, maxX: 2, maxY: -1 }, "Cell")
    p = added.project
    // 100 parts on the sheet, in its only use
    const child = `/${added.symbol.id}`
    for (let i = 0; i < 100; i++) p = addComponent(p, "resistor", { sch: { x: (i % 10) * 2, y: -Math.floor(i / 10) * 2, rot: 0 } }).project
    p = { ...p, components: p.components.map((c) => ({ ...c, inst: child })) }
    for (let i = 0; i < 19; i++) p = addSheetUse(p, "", added.symbol.child, { minX: 3 + i * 2.2, minY: -2, maxX: 5 + i * 2.2, maxY: -1 })!.project
    expect(p.components).toHaveLength(2000)
    expect(new Set(p.components.map((c) => c.ref)).size).toBe(2000)
    const started = Date.now()
    const moved = commitOnUse(p, child, (v) => ({ ...v, components: v.components.map((c, i) => (i === 0 ? { ...c, sch: { ...c.sch, x: 99 } } : c)) }))
    expect(Date.now() - started).toBeLessThan(2000)
    expect(moved.components.filter((c) => c.sch.x === 99)).toHaveLength(20)
    expect(computeConnectivity(moved).nets).toEqual([])
  })
})

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
