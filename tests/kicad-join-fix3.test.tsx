// @vitest-environment jsdom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { runTool } from "../src/ai/tools"
import { Inspector } from "../src/panels/Inspector"
import { multiStyleControls } from "../src/panels/SheetInspectors"
import { addDrawings } from "../src/model/drawings"
import { importKicadSchematic } from "../src/model/kicad/schematic"
import { createProject } from "../src/model/ops"
import type { DrawingBox, DrawingLine, Project, SchematicDrawing } from "../src/model/types"
import { projectApi } from "../src/store/projectStore"
import { uiApi } from "../src/store/uiStore"
import { LIB_R, schematic } from "./kicad-schematic-fixtures"
import { stubLocalStorage } from "./kicad-import-helpers"

// Fix round 1 of the join, B4 (the Inspector for several drawings, one of them from a KiCad sheet), B5 (Sakura
// restyling a KiCad line) and m1 (what Sakura's get_design lists first).

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLElement
beforeEach(() => {
  stubLocalStorage()
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const kicadLine = (y: number): Parameters<typeof addDrawings>[1][number] => ({ type: "line", points: [{ x: 0, y }, { x: 2, y }], stroke: { width: 0.02, dash: "dash" } })
const toolLine = (y: number): Parameters<typeof addDrawings>[1][number] => ({ type: "line", points: [{ x: 0, y }, { x: 2, y }], color: "blue" })
const kicadRect = (): Parameters<typeof addDrawings>[1][number] => ({ type: "rect", x: 0, y: 5, width: 2, height: 1, stroke: { width: 0.01, color: "#112233" }, paint: { kind: "background" } })

function open(drawings: Parameters<typeof addDrawings>[1]) {
  const { project, added } = addDrawings(createProject("d"), drawings)
  projectApi().open(project)
  uiApi().setView("schematic")
  return added
}
const select = (ids: string[]) => act(() => uiApi().select(ids.map((id) => `d:${id}`)))
const button = (name: string) => document.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`)
const click = (el: Element | null | undefined) => {
  expect(el).toBeTruthy()
  act(() => void el!.dispatchEvent(new MouseEvent("click", { bubbles: true })))
}
const drawingsNow = () => projectApi().project!.drawings as SchematicDrawing[]

describe("B4: several drawings picked together, one of them from KiCad", () => {
  it("the colour, line and fill controls act on every one, each in its own way", () => {
    const added = open([kicadLine(0), kicadLine(1), kicadRect(), toolLine(2)])
    const ids = added.map((d) => d.id)
    select(ids)
    act(() => root.render(<Inspector />))
    expect(document.body.textContent).toContain("4 drawings")
    click(button("Colour: red"))
    const [a, b, rect, tool] = drawingsNow() as [DrawingLine, DrawingLine, DrawingBox, DrawingLine]
    // the KiCad lines are red and keep their width and their dash; the rectangle keeps its width and its fill; the tool's line is red by name
    for (const l of [a, b]) expect(l.stroke).toEqual({ width: 0.02, dash: "dash", color: "#c02a2a" })
    expect(rect.stroke).toEqual({ width: 0.01, color: "#c02a2a" })
    expect(rect.paint).toEqual({ kind: "background" })
    expect(tool.color).toBe("red")
    click(button("Dotted") ?? [...document.querySelectorAll("button")].find((x) => x.textContent === "Dotted"))
    const after = drawingsNow() as [DrawingLine, DrawingLine, DrawingBox, DrawingLine]
    expect(after[0].stroke).toEqual({ width: 0.02, dash: "dot", color: "#c02a2a" })
    expect(after[3].dash).toBe("dotted")
    click(button("Fill: blue"))
    expect((drawingsNow()[2] as DrawingBox).paint).toEqual({ kind: "color", color: "rgba(58,81,194,0.13)" })
  })

  it("offers no colour or line for dots, flags, pictures and tables, and leaves them as they are", () => {
    const sch = importKicadSchematic(
      schematic({
        version: 20250114,
        libs: [LIB_R],
        body: [`(junction (at 10 10) (diameter 0) (color 0 0 0 0) (uuid j1))`, `(no_connect (at 20 20) (uuid n1))`, `(polyline (pts (xy 0 0) (xy 10 0)) (stroke (width 0) (type default)) (fill (type none)) (uuid p1))`],
      }),
    )
    if (sch.status !== "imported") throw new Error("refused")
    const drawings = sch.project.drawings!
    expect(multiStyleControls(drawings.filter((d) => d.type === "junction" || d.type === "noconnect"))).toMatchObject({ colour: false, fill: false, line: false, ids: [] })
    expect(multiStyleControls(drawings)).toMatchObject({ colour: true, fill: false, line: true })
    projectApi().open(sch.project)
    uiApi().setView("schematic")
    select(drawings.map((d) => d.id))
    act(() => root.render(<Inspector />))
    click(button("Colour: green"))
    const now = drawingsNow()
    expect(now.find((d) => d.type === "junction")).toEqual(drawings.find((d) => d.type === "junction"))
    expect(now.find((d) => d.type === "noconnect")).toEqual(drawings.find((d) => d.type === "noconnect"))
    expect((now.find((d) => d.type === "line") as DrawingLine).stroke?.color).toBe("#1f7f43")
  })

  it("a selection of the tools' drawings alone keeps the tools' Inspector, with its own controls", () => {
    const added = open([toolLine(0), toolLine(1)])
    select(added.map((d) => d.id))
    act(() => root.render(<Inspector />))
    // the tools' Inspector has a Closed switch only for polygons and the Corners row only for rectangles: for two lines it has colour, line and arrows
    expect(button("Colour: red")).toBeTruthy()
    expect(document.body.textContent).toContain("Arrows")
    click(button("Colour: red"))
    expect(drawingsNow().every((d) => d.color === "red" && !("stroke" in d))).toBe(true)
  })
})

describe("B5: Sakura restyles a KiCad line", () => {
  // IamPhytan's christmas-tree sheet has dashed lines (stroke width 0, type dash) that a user may ask to be red.
  const tree = () => {
    const r = importKicadSchematic(
      schematic({ version: 20231120, libs: [LIB_R], body: [`(polyline (pts (xy 92.075 53.975) (xy 52.07 53.975)) (stroke (width 0) (type dash)) (uuid 046ed71c-aaf7-4228-8e4a-b7d91ea90000))`] }),
    )
    if (r.status !== "imported") throw new Error("refused")
    return r.project
  }

  it("a dashed line given a colour stays dashed, keeps its dash, and is red", () => {
    const p = tree()
    const line = p.drawings!.find((d) => d.type === "line") as DrawingLine
    expect(line.stroke).toEqual({ dash: "dash" })
    const out = runTool(p, "edit_drawings", { ids: [line.id], color: "red" })
    expect(out.isError).toBeFalsy()
    const after = out.project!.drawings!.find((d) => d.id === line.id) as DrawingLine
    expect(after.stroke).toEqual({ dash: "dash", color: "#c02a2a" })
  })

  it("a weight changes only the width, a dash only the dash; the colour stays", () => {
    const p = tree()
    const line = p.drawings!.find((d) => d.type === "line") as DrawingLine
    const red = runTool(p, "edit_drawings", { ids: [line.id], color: "red" }).project!
    const thick = runTool(red, "edit_drawings", { ids: [line.id], weight: "thick" }).project!.drawings![0] as DrawingLine
    expect(thick.stroke).toEqual({ width: 0.045, dash: "dash", color: "#c02a2a" })
    const dotted = runTool(red, "edit_drawings", { ids: [line.id], dash: "dotted" }).project!.drawings![0] as DrawingLine
    expect(dotted.stroke).toEqual({ dash: "dot", color: "#c02a2a" })
  })

  it("the restyled line is still written to KiCad as it is, dashed and red", async () => {
    const { kicadFiles } = await import("../src/export/kicad")
    const base = tree()
    const withPart = importKicadSchematic(schematic({ version: 20231120, libs: [LIB_R], symbols: [{ lib: "Device:R", at: "50.8 50.8", ref: "R1", value: "1k", uuid: "aaaaaaaa-0000-4000-8000-000000000001" }], body: [`(polyline (pts (xy 92.075 53.975) (xy 52.07 53.975)) (stroke (width 0) (type dash)) (uuid 046ed71c-aaf7-4228-8e4a-b7d91ea90000))`] }))
    if (withPart.status !== "imported") throw new Error("refused")
    void base
    const line = withPart.project.drawings!.find((d) => d.type === "line")!
    const red = runTool(withPart.project, "edit_drawings", { ids: [line.id], color: "red" }).project as Project
    const { files } = await kicadFiles(red)
    const sch = Object.entries(files).find(([k]) => k.endsWith(".kicad_sch"))![1]
    expect(sch).toMatch(/\(stroke \(width 0\) \(type dash\) \(color 192 42 42 1\)\)/)
  })
})

describe("m1: what get_design lists above 100 drawings", () => {
  it("lists the tools' drawings first, then KiCad's, and says what is capped", () => {
    const many: Parameters<typeof addDrawings>[1] = [
      ...Array.from({ length: 120 }, (_, i): Parameters<typeof addDrawings>[1][number] => ({ type: "line", points: [{ x: 0, y: -i }, { x: 1, y: -i }], stroke: { width: 0.01 } })),
      { type: "text", text: "Mine", x: 3, y: 3, size: 0.14 },
      { type: "rect", x: 5, y: 5, width: 2, height: 2 },
    ]
    const { project } = addDrawings(createProject("big"), many)
    const out = JSON.parse(runTool(project, "get_design", {}).result)
    const listed = out.drawings as { id: string; type: string }[]
    expect(listed).toHaveLength(100)
    expect(listed[0].type).toBe("text")
    expect(listed[1].type).toBe("rect")
    expect(listed.slice(2).every((d) => d.type === "line")).toBe(true)
    expect(out.drawings_more).toBe("and 22 more: 22 line")
  })
})
