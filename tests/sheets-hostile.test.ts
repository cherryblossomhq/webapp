import { describe, expect, it } from "vitest"
import { computeConnectivity } from "../src/model/connectivity"
import { createProject } from "../src/model/ops"
import { parseProjectFile, serializeProject } from "../src/model/projectFile"
import { setSheetSymbol } from "../src/model/sheetOps"
import { MAX_SHEET_DEPTH, MAX_SHEET_USES, refusedSheetSymbols, sheetUses } from "../src/model/sheets"
import type { Project, SheetSymbol } from "../src/model/types"
import { projectApi } from "../src/store/projectStore"
import { imp } from "./kicad-sheets-fixtures"

// Sheets from a file nobody checked: loops, depth, width, garbage numbers. A named refusal or a repair, never a hang or a crash.

const symbol = (id: string, sheet: string, child: string, extra: Partial<SheetSymbol> = {}): SheetSymbol => ({ id, sheet, child, x: 0, y: 0, w: 1, h: 1, name: id, file: `${id}.kicad_sch`, pins: [], ...extra })
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
