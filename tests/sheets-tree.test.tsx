// @vitest-environment jsdom
import { act, type ReactElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { addWire, createProject } from "../src/model/ops"
import { addSheet } from "../src/model/sheetOps"
import { sheetUses } from "../src/model/sheets"
import { SheetsPanel, sheetRows } from "../src/panels/SheetsPanel"
import { projectApi, useProjectStore } from "../src/store/projectStore"
import { uiApi, useUi } from "../src/store/uiStore"
import { S1, S2, imp } from "./kicad-sheets-fixtures"

// The sheet tree: the rows it is built from (Main, a sheet on it, a sheet nested, a sheet used twice), what a click does, and renaming.

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLElement
const mount = (ui: ReactElement) => act(() => root.render(ui))
const click = (b: Element | null | undefined) => act(() => void b!.dispatchEvent(new MouseEvent("click", { bubbles: true })))
const rowButton = (text: string) => [...host.querySelectorAll<HTMLButtonElement>("li > button[title]")].find((b) => b.textContent?.includes(text))
const names = () => [...host.querySelectorAll("li > button[title] span.truncate")].map((s) => s.textContent)
const dblclick = (b: Element | null | undefined) => act(() => void b!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })))
/** Type into the rename field and leave it as a key does. */
const type = (value: string, key: "Enter" | "Escape") =>
  act(() => {
    const input = host.querySelector("input")!
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value)
    input.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }))
    if (key === "Enter") input.blur()
  })

beforeEach(() => {
  host = document.createElement("div")
  document.body.appendChild(host)
  root = createRoot(host)
  uiApi().setSheet("")
  uiApi().setView("schematic")
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe("the rows of the sheet tree", () => {
  it("lists Main first, never the project, and each use of a sheet used twice with how many uses it has", () => {
    const { project } = imp([{ uuid: S1, name: "A", y: 60.96 }, { uuid: S2, name: "B", y: 90 }])
    const rows = sheetRows(sheetUses(project))
    expect(rows.map((r) => [r.use.name, r.use.sheet, r.indent, r.copies])).toEqual([
      ["Main", "root", 0, 1],
      ["A", "s1", 0, 2],
      ["B", "s1", 0, 2],
    ])
  })

  it("puts the sheets on Main beside it and sets in a sheet drawn on one of those", () => {
    const base = imp().project
    const nested = addSheet(base, "/h1", { minX: 0, minY: 0, maxX: 2, maxY: 1 }, "Deep")
    const rows = sheetRows(sheetUses(nested.project))
    expect(rows.map((r) => [r.use.name, r.use.depth, r.indent])).toEqual([["Main", 0, 0], ["Power", 1, 0], ["Deep", 2, 1]])
  })
})

describe("the sheet tree panel", () => {
  it("draws the tree with the sheet shown marked, and a click shows that use", () => {
    const project = imp([{ uuid: S1, name: "A", y: 60.96 }, { uuid: S2, name: "B", y: 90 }]).project
    projectApi().open(project)
    mount(<SheetsPanel />)
    expect(names()).toEqual(["Main", "A", "B"])
    expect(rowButton("Main")!.getAttribute("aria-current")).toBe("true")
    expect(rowButton("A")!.getAttribute("aria-current")).toBeNull()
    expect(rowButton("A")!.textContent).toContain("×2")
    click(rowButton("B"))
    expect(uiApi().sheet).toBe("/h2")
    expect(rowButton("B")!.getAttribute("aria-current")).toBe("true")
    expect(rowButton("Main")!.getAttribute("aria-current")).toBeNull()
    click(rowButton("Main"))
    expect(uiApi().sheet).toBe("")
  })

  it("has no folds: nothing in it is a folder", () => {
    projectApi().open(addSheet(imp().project, "/h1", { minX: 0, minY: 0, maxX: 2, maxY: 1 }, "Deep").project)
    mount(<SheetsPanel />)
    expect(names()).toEqual(["Main", "Power", "Deep"])
    expect(host.querySelector("[aria-expanded]")).toBeNull()
  })

  it("takes the editor to the schematic when a sheet is picked from the PCB, and closes itself with its button", () => {
    projectApi().open(imp().project)
    uiApi().setView("pcb")
    uiApi().toggleSheets()
    expect(uiApi().sheetsOpen).toBe(true)
    mount(<SheetsPanel />)
    click(rowButton("Power"))
    expect(useUi.getState().view).toBe("schematic")
    expect(uiApi().sheet).toBe("/h1")
    click(host.querySelector("button[aria-label='Hide sheets']"))
    expect(uiApi().sheetsOpen).toBe(false)
  })

  it("renames Main and a sheet below it by a double-click, and Escape keeps the name", () => {
    projectApi().open(imp().project)
    mount(<SheetsPanel />)
    dblclick(rowButton("Main"))
    type("Top level", "Enter")
    expect(names()).toEqual(["Top level", "Power"])
    expect(projectApi().project!.sheets!.find((s) => s.id === "root")!.name).toBe("Top level")
    dblclick(rowButton("Power"))
    type("Supply", "Enter")
    expect(projectApi().project!.sheetSymbols![0].name).toBe("Supply")
    dblclick(rowButton("Supply"))
    type("Nope", "Escape")
    expect(names()).toEqual(["Top level", "Supply"])
    // Main again is no name of its own.
    dblclick(rowButton("Top level"))
    type("Main", "Enter")
    expect(projectApi().project!.sheets!.find((s) => s.id === "root")!.name).toBeUndefined()
  })

  it("lets a viewer look but not rename", () => {
    projectApi().open(imp().project)
    useProjectStore.setState({ role: "viewer" })
    mount(<SheetsPanel />)
    dblclick(rowButton("Power"))
    expect(host.querySelector("input")).toBeNull()
    useProjectStore.setState({ role: "owner" })
  })

  it("lists a project of one sheet as Main alone, for a host that draws it anyway", () => {
    projectApi().open(addWire(createProject("one"), [{ x: 0, y: 0 }, { x: 1, y: 0 }]).project)
    mount(<SheetsPanel />)
    expect(names()).toEqual(["Main"])
  })
})
