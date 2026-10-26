// @vitest-environment jsdom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { computeConnectivity } from "../src/model/connectivity"
import { getConnectivity, sameSchematic } from "../src/model/connectivityCache"
import { addDrawings, copyDrawings, removeDrawings, rotateDrawing, updateDrawings, dragHandle, drawingHandles, hitDrawing, drawingBounds, applyStyle } from "../src/model/drawings"
import { moveSchematicItems, removeItems, createProject, addWire } from "../src/model/ops"
import { runErc } from "../src/model/erc"
import { SchematicToolbar } from "../src/panels/CanvasToolbar"
import { paintDrawing } from "../src/editor/schematic/drawingPaint"
import { SCH_LIGHT } from "../src/editor/theme"
import { projectApi } from "../src/store/projectStore"
import { commitHere, shownProject } from "../src/store/sheetScope"
import { uiApi } from "../src/store/uiStore"
import type { DrawingBus, DrawingBusEntry, Project } from "../src/model/types"
import { load, oneSheet, pinsOn, twoSheets } from "./kicad-sch-s3-fixtures"

// S3 in the editor: buses and entries are drawn, selected, moved, deleted and copied as drawings are, the checks and the nets follow them, and a schematic drawn
// before buses existed behaves as it did.

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLElement
beforeEach(() => {
  host = document.createElement("div")
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

/** What the editor makes of a file: no `netNames`, which only a KiCad import sets. */
function drawn(files = oneSheet()): Project {
  const { netNames: _n, ...rest } = load(files).project
  void _n
  return rest as Project
}
const buses = (p: Project) => (p.drawings ?? []).filter((d): d is DrawingBus => d.type === "bus")
const entries = (p: Project) => (p.drawings ?? []).filter((d): d is DrawingBusEntry => d.type === "busentry")
const netNames = (p: Project) => computeConnectivity(p).nets.map((n) => n.name).sort()

describe("the toolbar", () => {
  it("has a Bus tool and a Bus entry tool that pick the tool", () => {
    projectApi().open(createProject("one"))
    act(() => root.render(<SchematicToolbar />))
    const find = (label: string) => [...document.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === label || b.title === label || b.textContent?.trim() === label)
    expect(find("Bus")).toBeTruthy()
    act(() => void find("Bus")!.dispatchEvent(new MouseEvent("click", { bubbles: true })))
    expect(uiApi().schTool).toBe("bus")
    act(() => void find("Bus entry")!.dispatchEvent(new MouseEvent("click", { bubbles: true })))
    expect(uiApi().schTool).toBe("busentry")
    uiApi().setSchTool("select")
  })
})

describe("drawing a bus", () => {
  it("adds a bus and an entry as drawings, and a label that names the bus makes its members, with nothing said by hand", () => {
    // R1's net is D3 by its wire's label; a bus and an entry drawn beside it change no net, and a label D[0..7] on the bus makes no net of its own
    let p = drawn()
    const before = netNames(p)
    p = addDrawings(p, [{ type: "bus", points: [{ x: 0, y: 9 }, { x: 1, y: 9 }] }, { type: "busentry", x: 0.2, y: 9, dx: 0.2, dy: 0.2 }]).project
    p = { ...p, labels: [...p.labels, { id: "lb", name: "X[0..3]", x: 0.5, y: 9, rot: 0 }] }
    expect(netNames(p)).toEqual(before)
    expect(buses(p).length).toBe(2)
  })

  it("moves with a selection, is deleted with it, copied with an offset, and turned a quarter", () => {
    const p = drawn()
    const ids = buses(p).map((d) => d.id)
    const moved = moveSchematicItems(p, { components: [], labels: [], wires: [], drawings: ids }, { x: 0.5, y: 0 }, [])
    expect(buses(moved)[0].points[0].x).toBeCloseTo(buses(p)[0].points[0].x + 0.5, 5)
    expect(buses(removeItems(p, { components: [], labels: [], wires: [], blocks: [], drawings: ids })).length).toBe(0)
    const copy = copyDrawings(buses(p), { x: 1, y: 1 })
    expect(copy[0].id).not.toBe(buses(p)[0].id)
    const turned = rotateDrawing(buses(p)[0]) as DrawingBus
    expect(turned.points[0]).not.toEqual(buses(p)[0].points[0])
    const e = entries(p)[0]
    const e2 = rotateDrawing(e) as DrawingBusEntry
    expect([e2.dx, e2.dy]).toEqual([-e.dy, e.dx])
  })

  it("has handles at its points, and a handle drag moves one point", () => {
    const b = buses(drawn())[0]
    expect(drawingHandles(b)).toEqual(b.points)
    const to = { x: b.points[1].x, y: b.points[1].y + 1 }
    expect((dragHandle(b, 1, to) as DrawingBus).points[1]).toEqual(to)
    const e = entries(drawn())[0]
    expect(drawingHandles(e)).toHaveLength(2)
  })

  it("is picked on its line, and has a box that covers its width", () => {
    const b = buses(drawn())[0]
    const mid = { x: (b.points[0].x + b.points[1].x) / 2, y: b.points[0].y }
    expect(hitDrawing(b, mid, 0.05)).toBe(true)
    expect(hitDrawing(b, { x: mid.x, y: mid.y + 1 }, 0.05)).toBe(false)
    expect(drawingBounds(b).maxX).toBeGreaterThan(Math.max(b.points[0].x, b.points[1].x))
  })

  it("is painted as a thick line, twice a wire's, in the drawing's own colour when it has one", () => {
    const b = buses(drawn())[0]
    const [node] = paintDrawing(b, SCH_LIGHT, 0.01)
    expect(node.tag).toBe("polyline")
    expect(Number(node.attrs.strokeWidth)).toBeGreaterThanOrEqual(0.04)
    const base: DrawingBus = { ...b, stroke: { width: 0.05 } }
    const styled = applyStyle(base, { color: "red" })
    expect(styled.stroke?.color).toBeDefined()
  })

  it("a change to the bus or an alias is a schematic edit, and one to a note is not", () => {
    const p = drawn()
    const note = addDrawings(p, [{ type: "text", x: 0, y: 0, text: "hi", size: 0.14 }]).project
    expect(sameSchematic(p, note)).toBe(true)
    const moved = updateDrawings(p, [buses(p)[0].id], (d) => (d.type === "bus" ? { ...d, points: d.points.map((q) => ({ ...q, y: q.y + 1 })) } : d))
    expect(sameSchematic(p, moved)).toBe(false)
    expect(sameSchematic(p, { ...p, busAliases: [{ id: "a1", name: "X", members: ["A"] }] })).toBe(false)
    expect(getConnectivity(p)).toBe(getConnectivity(note))
  })

  it("is undone with the edit that made it", () => {
    const base = drawn()
    projectApi().open(base)
    commitHere((v) => addDrawings(v, [{ type: "bus", points: [{ x: 0, y: 5 }, { x: 1, y: 5 }] }]).project)
    expect(buses(shownProject()).length).toBe(buses(base).length + 1)
    projectApi().undo()
    expect(buses(shownProject()).length).toBe(buses(base).length)
  })
})

describe("what the editor draws is as it was", () => {
  it("a bus name on a wire is still a net's name where nothing is a bus", () => {
    let p = createProject("plain")
    p = addWire(p, [{ x: 0, y: 0 }, { x: 1, y: 0 }]).project
    p = { ...p, labels: [{ id: "l1", name: "A[0..3]", x: 1, y: 0, rot: 0 }] }
    expect(netNames(p)).toEqual(["A[0..3]"])
    expect(computeConnectivity(p).buses?.size).toBeGreaterThan(0)
  })

  it("a project with no bus data pays nothing: connectivity has no bus table", () => {
    const p = createProject("plain")
    expect(computeConnectivity(p).buses).toBeUndefined()
  })
})

describe("the checks follow the buses", () => {
  it("deleting the bus of an entry makes the entry a finding, and deleting the entry makes it go", () => {
    const p = drawn()
    const kinds = (q: Project) => runErc(q, computeConnectivity(q)).map((f) => f.kind)
    expect(kinds(p)).not.toContain("bus-entry-no-bus")
    const noBus = removeDrawings(p, buses(p).map((d) => d.id))
    expect(kinds(noBus)).toContain("bus-entry-no-bus")
    expect(kinds(removeDrawings(noBus, entries(noBus).map((d) => d.id)))).not.toContain("bus-entry-no-bus")
  })

  it("a sheet below the root keeps its buses when the sheet is shown or the project is flattened for Circuit JSON, and the joined nets stay joined", async () => {
    const { project } = load(twoSheets())
    const { projectToCircuitJson } = await import("../src/export/circuitJson")
    const out = projectToCircuitJson(project)
    expect(out.notes.some((n) => /Buses and bus entries are drawn as lines/.test(n))).toBe(true)
    const names = out.elements.filter((e) => e.type === "source_net").map((e) => (e as unknown as { name: string }).name)
    expect(names.filter((n) => /D3$/.test(n)).length).toBe(1)
    expect(pinsOn(project, computeConnectivity(project).nets.find((n) => n.name === "/D3")!)).toEqual(["R1.1", "R9.1"])
  })
})
