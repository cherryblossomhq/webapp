// @vitest-environment jsdom
import { act, type ReactElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { computeConnectivity } from "../src/model/connectivity"
import { runErc } from "../src/model/erc"
import { addMissingPins, addSheet, addSheetPin, addSheetUse, missingPins, moveSheetSymbols, removeSheetSymbols, resizeSheetSymbol, setSheetSymbol } from "../src/model/sheetOps"
import { addWire, createProject } from "../src/model/ops"
import { sheetUses } from "../src/model/sheets"
import { SheetNavigator } from "../src/panels/SheetNavigator"
import { SheetSymbolInspector } from "../src/panels/SheetInspectors"
import { projectApi } from "../src/store/projectStore"
import { commitHere, shownProject } from "../src/store/sheetScope"
import { uiApi } from "../src/store/uiStore"
import { tidySelected } from "../src/editor/schematic/tidyAction"
import { S1, S2, imp } from "./kicad-sheets-fixtures"

// The editor with sheets: the navigator, the edits of one sheet at a time, the sheet symbol's panel and the operations on sheets.

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLElement
const mount = (ui: ReactElement) => act(() => root.render(ui))
const button = (name: RegExp | string) => [...document.querySelectorAll("button")].find((b) => (typeof name === "string" ? b.textContent?.trim() === name : name.test(b.textContent ?? "") || name.test(b.getAttribute("aria-label") ?? "")))
const click = (b: Element | undefined) => act(() => void b!.dispatchEvent(new MouseEvent("click", { bubbles: true })))

beforeEach(() => {
  host = document.createElement("div")
  document.body.appendChild(host)
  root = createRoot(host)
  uiApi().setSheet("")
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const open = (uses?: Parameters<typeof imp>[0]) => {
  const { project } = imp(uses)
  projectApi().open(project)
  return project
}

describe("the sheet navigator", () => {
  it("is not there for a project of one sheet", () => {
    projectApi().open(createProject("one"))
    mount(<SheetNavigator />)
    expect(host.textContent).toBe("")
  })

  it("shows the path to the sheet shown, goes up, and lists every sheet with its page", () => {
    open()
    mount(<SheetNavigator />)
    expect(host.textContent).toContain("Power")
    expect((button(/Up to the sheet above/) as HTMLButtonElement).disabled).toBe(true)
    act(() => uiApi().setSheet("/h1"))
    expect((button(/Up to the sheet above/) as HTMLButtonElement).disabled).toBe(false)
    click(button(/Up to the sheet above/))
    expect(uiApi().sheet).toBe("")
    const options = [...host.querySelectorAll("option")].map((o) => o.textContent?.replace(/\s+/g, " ").trim())
    expect(options).toEqual(["Imported KiCad schematic (page 1)", "Power (page 2)"])
  })
})

describe("editing the sheet shown", () => {
  it("an edit made on a sheet is on that sheet's items and no other, and undo takes it back", () => {
    open()
    act(() => uiApi().setSheet("/h1"))
    expect(shownProject().components.map((c) => c.ref)).toEqual(["R2"])
    commitHere((v) => addWire(v, [{ x: 0, y: 0 }, { x: 1, y: 0 }]).project)
    const p = projectApi().project!
    expect(p.wires.filter((w) => w.sheet === "s1")).toHaveLength(1)
    expect(shownProject().wires.filter((w) => w.sheet === "s1")).toHaveLength(1)
    act(() => uiApi().setSheet(""))
    expect(shownProject().wires.some((w) => w.sheet === "s1")).toBe(false)
    projectApi().undo()
    expect(projectApi().project!.wires.some((w) => w.sheet === "s1")).toBe(false)
  })

  it("Tidy works on the sheet shown and leaves the others where they are", () => {
    const before = open()
    act(() => uiApi().setSheet("/h1"))
    tidySelected()
    const after = projectApi().project!
    expect(after.components.find((c) => c.ref === "R1")).toEqual(before.components.find((c) => c.ref === "R1"))
    expect(after.wires.filter((w) => !w.sheet)).toEqual(before.wires.filter((w) => !w.sheet))
  })

  it("a project of one sheet is edited as it always was: the edit is made on the project itself", () => {
    projectApi().open(createProject("one"))
    commitHere((v) => addWire(v, [{ x: 0, y: 0 }, { x: 1, y: 0 }]).project)
    expect(projectApi().project!.wires).toHaveLength(1)
    expect(projectApi().project!.wires[0].sheet).toBeUndefined()
    expect(projectApi().project!.sheets).toBeUndefined()
  })
})

describe("the sheet symbol's panel", () => {
  it("opens the sheet, and adds the pins the sheet's labels have no pin for", () => {
    const project = open()
    const sym = project.sheetSymbols![0]
    mount(<SheetSymbolInspector sym={sym} project={project} />)
    click(button(/Open/))
    expect(uiApi().sheet).toBe("/h1")
    const lone = { ...project.labels.find((l) => l.kind === "hierarchical")!, id: "lone", name: "EXTRA" }
    const withLabel = { ...project, labels: [...project.labels, lone] }
    projectApi().open(withLabel)
    mount(<SheetSymbolInspector sym={sym} project={withLabel} />)
    expect(button(/Pins for 1 label/)).toBeDefined()
    click(button(/Pins for 1 label/))
    expect(projectApi().project!.sheetSymbols![0].pins.map((p) => p.name)).toEqual(["VIN", "EXTRA"])
  })
})

describe("the operations on sheets", () => {
  it("add a sheet, use it again, move it with the wires at its pins, resize it, and delete it with what is on it", () => {
    let p = imp().project
    const added = addSheet(p, "", { minX: 3, minY: -4, maxX: 4.5, maxY: -3 }, "Regulator")
    p = added.project
    expect(p.sheets?.map((s) => s.id)).toEqual(["root", "s1", "s2"])
    expect(added.symbol).toMatchObject({ sheet: "root", child: "s2", name: "Regulator", file: "Regulator.kicad_sch" })
    p = addSheetPin(p, added.symbol.id, "VIN", "input", "left")
    p = addSheetPin(p, added.symbol.id, "VOUT", "output", "right")
    const pins = p.sheetSymbols!.find((s) => s.id === added.symbol.id)!.pins
    expect(pins.map((q) => [q.name, q.rot])).toEqual([["VIN", 180], ["VOUT", 0]])
    expect(pins[0].x).toBeCloseTo(3)
    expect(pins[1].x).toBeCloseTo(4.5)
    // a wire to the pin follows when the symbol moves
    const wired = addWire(p, [{ x: 2, y: pins[0].y }, { x: pins[0].x, y: pins[0].y }]).project
    const moved = moveSheetSymbols(wired, [added.symbol.id], { x: 0, y: -1 })
    const wire = moved.wires.at(-1)!
    expect(wire.points.at(-1)!.x).toBeCloseTo(3)
    expect(wire.points.at(-1)!.y).toBeCloseTo(pins[0].y - 1)
    expect(moved.sheetSymbols!.find((s) => s.id === added.symbol.id)!.pins[0].y).toBeCloseTo(pins[0].y - 1)
    const bigger = resizeSheetSymbol(moved, added.symbol.id, 2.5, 1)
    expect(bigger.sheetSymbols!.find((s) => s.id === added.symbol.id)!.pins[1].x).toBeCloseTo(5.5)
    // a second use of the first sheet: its part is copied with a reference of its own
    const again = addSheetUse(bigger, "", "s1", { minX: 6, minY: -4, maxX: 8, maxY: -3 })!
    expect(sheetUses(again.project).filter((u) => u.sheet === "s1")).toHaveLength(2)
    expect(again.project.components.filter((c) => c.inst)).toHaveLength(2)
    expect(new Set(again.project.components.map((c) => c.ref)).size).toBe(again.project.components.length)
    // deleting a use removes its parts; deleting the last symbol removes the sheet and everything on it
    const one = removeSheetSymbols(again.project, [again.symbol.id])
    expect(one.components.filter((c) => c.inst)).toHaveLength(1)
    const none = removeSheetSymbols(one, [one.sheetSymbols![0].id])
    expect(none.components.filter((c) => c.inst)).toHaveLength(0)
    expect(none.labels.some((l) => l.sheet === "s1")).toBe(false)
    expect(none.sheets?.some((s) => s.id === "s1")).toBe(false)
  })

  it("a flag on a sheet is kept, and a sheet cannot hold itself", () => {
    const { project } = imp()
    const flagged = setSheetSymbol(project, project.sheetSymbols![0].id, { flags: { dnp: true } })
    expect(flagged.sheetSymbols![0].flags).toEqual({ dnp: true })
    expect(setSheetSymbol(flagged, flagged.sheetSymbols![0].id, { flags: { dnp: false } }).sheetSymbols![0].flags).toBeUndefined()
    expect(addSheetUse(project, "/h1", "s1", { minX: 0, minY: 0, maxX: 1, maxY: 1 })).toBeNull()
  })

  it("the checks name a pin with no label, a label with no pin and a pin nothing is wired to", () => {
    const { project } = imp()
    const p1 = addSheetPin(project, project.sheetSymbols![0].id, "NOPE", "input", "left")
    const p2 = { ...p1, labels: [...p1.labels, { ...project.labels.find((l) => l.kind === "hierarchical")!, id: "extra", name: "ALONE" }] }
    const kinds = runErc(p2, computeConnectivity(p2)).map((f) => f.kind)
    expect(kinds).toContain("sheet-pin-no-label")
    expect(kinds).toContain("label-no-sheet-pin")
    expect(kinds).toContain("sheet-pin-unconnected")
    expect(runErc(project, computeConnectivity(project)).some((f) => f.kind.startsWith("sheet-") || f.kind === "label-no-sheet-pin")).toBe(false)
    expect(missingPins(p2, project.sheetSymbols![0].id).map((m) => m.name)).toEqual(["ALONE"])
    expect(addMissingPins(p2, project.sheetSymbols![0].id).sheetSymbols![0].pins.map((q) => q.name)).toEqual(["VIN", "NOPE", "ALONE"])
  })

  it("a sheet used twice has a use of each name", () => {
    const { project } = imp([{ uuid: S1, name: "A", y: 60.96 }, { uuid: S2, name: "B", y: 90 }])
    expect(sheetUses(project).map((u) => u.name)).toEqual([project.name, "A", "B"])
  })
})
