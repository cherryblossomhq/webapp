// @vitest-environment jsdom
import { act, type ReactElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { addComponent, createProject } from "../src/model/ops"
import { DEFAULT_PAPER, holds, paperOf, sheetDrawingBox, titleBlockOf } from "../src/model/paper"
import { setTitleField } from "../src/model/sheetOps"
import { sheetView } from "../src/model/sheets"
import type { Project } from "../src/model/types"
import { Inspector } from "../src/panels/Inspector"
import { ShownSheetInspector } from "../src/panels/SheetInspectors"
import { projectApi } from "../src/store/projectStore"
import { uiApi } from "../src/store/uiStore"
import { imp } from "./kicad-sheets-fixtures"

// The page and the title block of the sheet shown, in the Inspector: shown on every schematic, each edit one undo step of the whole project.

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLElement
const mount = (ui: ReactElement) => act(() => root.render(ui))
const button = (name: RegExp) => [...host.querySelectorAll("button")].find((b) => name.test(b.textContent ?? ""))
const click = (b: Element | undefined) => act(() => void b!.dispatchEvent(new MouseEvent("click", { bubbles: true })))
/** The control of the field with this label, in the section titled `section`. */
const field = <T extends HTMLElement>(label: string, section = "Sheet") => {
  const s = [...host.querySelectorAll("section")].find((x) => x.querySelector("h3")?.textContent === section)
  return [...(s?.querySelectorAll("label") ?? [])].find((l) => l.querySelector("span")?.textContent === label)?.querySelector("input, select") as T
}
const pick = (select: HTMLSelectElement, value: string) =>
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(select, value)
    select.dispatchEvent(new Event("change", { bubbles: true }))
  })
/** Type into a field and press Enter, which leaves it and commits what was typed. */
const type = (input: HTMLInputElement, value: string) => {
  act(() => {
    input.focus()
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value)
    input.dispatchEvent(new Event("input", { bubbles: true }))
  })
  act(() => void input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })))
}
const current = () => projectApi().project!
const shown = (path = "") => mount(<ShownSheetInspector project={current()} path={path} />)

beforeEach(() => {
  host = document.createElement("div")
  document.body.appendChild(host)
  root = createRoot(host)
  uiApi().setView("schematic")
  uiApi().setSheet("")
  uiApi().clearSelection()
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe("the Sheet section", () => {
  it("shows on a project of one sheet, with nothing selected, before the project's", () => {
    projectApi().open(createProject("one"))
    mount(<Inspector />)
    const titles = [...host.querySelectorAll("section h3")].map((h) => h.textContent)
    expect(titles[0]).toBe("Sheet")
    expect(field<HTMLInputElement>("Name").value).toBe("Main")
    expect(field<HTMLSelectElement>("Size").value).toBe("A4")
    expect(host.textContent).toContain("1 of 1")
  })

  it("picks a size, as one undo step that brings the page back", () => {
    projectApi().open(createProject("one"))
    shown()
    pick(field("Size"), "A3")
    expect(paperOf(current())).toEqual({ ...DEFAULT_PAPER, size: "A3" })
    projectApi().undo()
    expect(paperOf(current())).toEqual(DEFAULT_PAPER)
  })

  it("turns the page and takes a custom size in the range, keeping its corner", () => {
    projectApi().open(createProject("one"))
    shown()
    click(button(/^Portrait$/))
    expect(paperOf(current())).toMatchObject({ size: "A4", portrait: true, x: DEFAULT_PAPER.x, y: DEFAULT_PAPER.y })
    shown()
    pick(field("Size"), "User")
    shown()
    type(field("Width"), "500")
    expect(paperOf(current())).toMatchObject({ size: "User", width: 500, height: 297 })
    shown()
    // Out of range is refused, with a notice, and changes nothing.
    type(field("Height"), "50")
    expect(paperOf(current())).toMatchObject({ size: "User", width: 500, height: 297 })
    expect(uiApi().notice?.text).toMatch(/100 mm to 3048 mm/)
  })

  it("fits the page to the drawing", () => {
    const placed = addComponent(createProject("far"), "resistor", { sch: { x: 60, y: 40, rot: 0 } }).project
    projectApi().open(placed)
    expect(holds(paperOf(current()), sheetDrawingBox(sheetView(current(), ""))!)).toBe(false)
    shown()
    click(button(/Fit to drawing/))
    expect(holds(paperOf(current()), sheetDrawingBox(sheetView(current(), ""))!)).toBe(true)
    projectApi().undo()
    expect(paperOf(current())).toEqual(DEFAULT_PAPER)
  })
})

describe("the title block's fields", () => {
  it("edit the project's name, and add, change and remove its properties", () => {
    projectApi().open(createProject("one"))
    shown()
    type(field("Revision"), "B")
    expect(current().properties).toEqual([{ key: "Revision", value: "B" }])
    shown()
    type(field("Title"), "Motor driver")
    expect(current().name).toBe("Motor driver")
    shown()
    type(field("Drawn by"), "Ada")
    expect(current().properties).toEqual([
      { key: "Revision", value: "B" },
      { key: "Author", value: "Ada" },
    ])
    shown()
    type(field("Revision"), "")
    expect(current().properties).toEqual([{ key: "Author", value: "Ada" }])
    shown()
    expect(field<HTMLInputElement>("Revision").value).toBe("")
  })

  it("change the property the title block shows, matched by its key", () => {
    const p: Project = { ...createProject("one"), properties: [{ key: "Organisation", value: "Acme" }, { key: "rev", value: "" }] }
    const set = setTitleField(setTitleField(p, "root", "company", "Initech"), "root", "revision", "C")
    expect(set.properties).toEqual([
      { key: "Organisation", value: "Initech" },
      { key: "rev", value: "C" },
    ])
    expect(setTitleField(p, "root", "title", "  ")).toBe(p)
  })

  it("edit a KiCad sub-sheet's own entries, which it shows, and say it keeps its title block", () => {
    const { project } = imp()
    const child = project.sheetSymbols![0].child
    const own = { ...project, sheets: project.sheets!.map((s) => (s.id === child ? { ...s, titleBlock: [{ key: "Title", value: "Supply" }] } : s)) }
    projectApi().open(own)
    act(() => uiApi().setSheet("/h1"))
    shown("/h1")
    expect(field<HTMLInputElement>("Title").value).toBe("Supply")
    expect(host.textContent).toContain("keeps the title block it had in KiCad")
    type(field("Title"), "Power stage")
    expect(current().sheets!.find((s) => s.id === child)!.titleBlock).toEqual([{ key: "Title", value: "Power stage" }])
    expect(current().name).toBe(own.name)
    expect(titleBlockOf(current(), "/h1").title).toBe("Power stage")
    shown("/h1")
    type(field("Revision"), "2")
    expect(current().sheets!.find((s) => s.id === child)!.titleBlock).toEqual([
      { key: "Title", value: "Power stage" },
      { key: "Rev", value: "2" },
    ])
    expect(current().properties ?? []).not.toContainEqual(expect.objectContaining({ value: "2" }))
  })
})
