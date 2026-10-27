// @vitest-environment jsdom
import { act, type ReactElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { computeConnectivity } from "../src/model/connectivity"
import { runErc } from "../src/model/erc"
import { addMissingPins, addSheet, addSheetPin, addSheetUse, missingPins, moveSheetSymbols, removeSheetSymbols, renameSheetUse, resizeSheetSymbol, setSheetSymbol, setSheetUsePage } from "../src/model/sheetOps"
import { addWire, createProject } from "../src/model/ops"
import { sheetUses } from "../src/model/sheets"
import { SheetSymbolInspector, ShownSheetInspector } from "../src/panels/SheetInspectors"
import { SheetTabs } from "../src/panels/SheetTabs"
import { ReadOnly } from "../src/ui/form"
import { projectApi } from "../src/store/projectStore"
import { commitHere, shownProject } from "../src/store/sheetScope"
import { uiApi } from "../src/store/uiStore"
import { tidySelected } from "../src/editor/schematic/tidyAction"
import { S1, S2, imp } from "./kicad-sheets-fixtures"

// The editor with sheets: the tabs, the edits of one sheet at a time, the panels of the sheet shown and of a sheet symbol, and the operations on sheets.

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

describe("the sheet tabs", () => {
  const tabs = () => [...host.querySelectorAll("[role=tab]")]

  it("are not there for a project of one sheet", () => {
    projectApi().open(createProject("one"))
    mount(<SheetTabs />)
    expect(host.textContent).toBe("")
  })

  it("are one per use, Main first, each with its page, the sheet shown selected; a click shows that use", () => {
    open([{ uuid: S1, name: "A", y: 60.96 }, { uuid: S2, name: "B", y: 90 }])
    mount(<SheetTabs />)
    expect(tabs().map((t) => t.textContent)).toEqual(["1Main", "2A", "3B"])
    expect(tabs().map((t) => t.getAttribute("aria-selected"))).toEqual(["true", "false", "false"])
    click(tabs()[2])
    expect(uiApi().sheet).toBe("/h2")
    expect(tabs()[2].getAttribute("aria-selected")).toBe("true")
  })

  it("open and close the sheet tree", () => {
    open()
    mount(<SheetTabs />)
    const before = uiApi().sheetsOpen
    click(button(/sheet tree/))
    expect(uiApi().sheetsOpen).toBe(!before)
  })
})

describe("the panel of the sheet shown", () => {
  it("names and numbers the sheet, and goes up to the one it is on", () => {
    const project = open()
    act(() => uiApi().setSheet("/h1"))
    mount(<ShownSheetInspector project={project} path="/h1" />)
    const values = [...host.querySelectorAll("input")].map((i) => i.value)
    expect(values).toEqual(["Power", "2"])
    click(button(/Up to Main/))
    expect(uiApi().sheet).toBe("")
  })

  it("lets a viewer go up but not rename", () => {
    const project = open()
    act(() => uiApi().setSheet("/h1"))
    mount(
      <ReadOnly.Provider value={true}>
        <ShownSheetInspector project={project} path="/h1" />
      </ReadOnly.Provider>,
    )
    expect(host.querySelector("fieldset")!.disabled).toBe(true)
    expect((button(/Up to Main/) as HTMLButtonElement).closest("fieldset")).toBeNull()
    click(button(/Up to Main/))
    expect(uiApi().sheet).toBe("")
  })

  it("renames and renumbers Main and the sheets below it where each keeps its name and page", () => {
    const p = imp().project
    const top = setSheetUsePage(renameSheetUse(p, "", "Board"), "", "0")
    expect(top.sheets!.find((s) => s.id === "root")).toMatchObject({ name: "Board", page: "0" })
    expect(sheetUses(top)[0]).toMatchObject({ name: "Board", page: "0" })
    const below = setSheetUsePage(renameSheetUse(top, "/h1", "Supply"), "/h1", "7")
    expect(below.sheetSymbols![0]).toMatchObject({ name: "Supply", pages: { "/h1": "7" } })
    // An empty name or page, or a use the project hasn't, changes nothing.
    expect(renameSheetUse(below, "/h1", "  ")).toBe(below)
    expect(setSheetUsePage(below, "/gone", "3")).toBe(below)
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
    expect(sheetUses(project).map((u) => u.name)).toEqual(["Main", "A", "B"])
  })
})
