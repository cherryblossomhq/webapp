// @vitest-environment jsdom
import { act, type ReactElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { addWire, createProject } from "../src/model/ops"
import { addSheet } from "../src/model/sheetOps"
import { sheetUses } from "../src/model/sheets"
import { SheetsPanel, sheetRows } from "../src/panels/SheetsPanel"
import { projectApi } from "../src/store/projectStore"
import { uiApi, useUi } from "../src/store/uiStore"
import { S1, S2, imp } from "./kicad-sheets-fixtures"

// The sheet tree: the rows it is built from (the root, a sheet below it, a sheet nested, a sheet used twice) and what a click does.

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLElement
const mount = (ui: ReactElement) => act(() => root.render(ui))
const click = (b: Element | null | undefined) => act(() => void b!.dispatchEvent(new MouseEvent("click", { bubbles: true })))
const rowButton = (text: string) => [...host.querySelectorAll<HTMLButtonElement>("li > button[title]")].find((b) => b.textContent?.includes(text))
const names = () => [...host.querySelectorAll("li > button[title] span.truncate")].map((s) => s.textContent)

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
  it("lists the root, then each use under the sheet that holds it, a sheet used twice once per symbol", () => {
    const { project } = imp([{ uuid: S1, name: "A", y: 60.96 }, { uuid: S2, name: "B", y: 90 }])
    const rows = sheetRows(sheetUses(project), new Set())
    expect(rows.map((r) => [r.use.name, r.use.depth, r.use.sheet])).toEqual([[project.name, 0, "root"], ["A", 1, "s1"], ["B", 1, "s1"]])
    expect(rows.map((r) => r.hasChildren)).toEqual([true, false, false])
  })

  it("nests a sheet inside a sheet and leaves out what is under a folded use", () => {
    const base = imp().project
    const nested = addSheet(base, "/h1", { minX: 0, minY: 0, maxX: 2, maxY: 1 }, "Deep")
    const uses = sheetUses(nested.project)
    expect(uses.map((u) => [u.name, u.depth])).toEqual([[base.name, 0], ["Power", 1], ["Deep", 2]])
    expect(sheetRows(uses, new Set()).map((r) => r.hasChildren)).toEqual([true, true, false])
    expect(sheetRows(uses, new Set(["/h1"])).map((r) => r.use.name)).toEqual([base.name, "Power"])
    expect(sheetRows(uses, new Set([""])).map((r) => r.use.name)).toEqual([base.name])
  })
})

describe("the sheet tree panel", () => {
  it("draws the tree with the sheet shown marked, and a click shows that use", () => {
    const project = imp([{ uuid: S1, name: "A", y: 60.96 }, { uuid: S2, name: "B", y: 90 }]).project
    projectApi().open(project)
    mount(<SheetsPanel />)
    expect(names()).toEqual([project.name, "A", "B"])
    expect(rowButton(project.name)!.getAttribute("aria-current")).toBe("true")
    expect(rowButton("A")!.getAttribute("aria-current")).toBeNull()
    click(rowButton("B"))
    expect(uiApi().sheet).toBe("/h2")
    expect(rowButton("B")!.getAttribute("aria-current")).toBe("true")
    expect(rowButton(project.name)!.getAttribute("aria-current")).toBeNull()
    click(rowButton(project.name))
    expect(uiApi().sheet).toBe("")
  })

  it("takes the editor to the schematic when a sheet is picked from the PCB", () => {
    projectApi().open(imp().project)
    uiApi().setView("pcb")
    mount(<SheetsPanel />)
    click(rowButton("Power"))
    expect(useUi.getState().view).toBe("schematic")
    expect(uiApi().sheet).toBe("/h1")
  })

  it("folds and unfolds the sheets under a use, and closes itself with its button", () => {
    projectApi().open(imp().project)
    uiApi().toggleSheets()
    expect(uiApi().sheetsOpen).toBe(true)
    mount(<SheetsPanel />)
    expect(names()).toHaveLength(2)
    click(host.querySelector("button[aria-expanded]"))
    expect(names()).toHaveLength(1)
    click(host.querySelector("button[aria-expanded]"))
    expect(names()).toHaveLength(2)
    click(host.querySelector("button[aria-label='Hide sheets']"))
    expect(uiApi().sheetsOpen).toBe(false)
  })

  it("lists a project of one sheet as its one root, for a host that draws it anyway", () => {
    projectApi().open(addWire(createProject("one"), [{ x: 0, y: 0 }, { x: 1, y: 0 }]).project)
    mount(<SheetsPanel />)
    expect(names()).toEqual(["one"])
  })
})
