// @vitest-environment jsdom
import { act, type ReactElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { buildDimension, dimensionClicks, hitImage, marqueeBoardObjects } from "../src/editor/pcb/boardObjectEditing"
import { groupSelected, lockSelectedGroups, ungroupSelected } from "../src/editor/pcb/groupActions"
import { addDimension, newDimension } from "../src/model/boardObjects"
import { dimensionDrawing } from "../src/model/dimensions"
import { addVia, createProject } from "../src/model/ops"
import { DimensionInspector, GroupSection, ImageInspector } from "../src/panels/BoardObjectPanels"
import type { Project } from "../src/model/types"
import { projectApi } from "../src/store/projectStore"
import { uiApi } from "../src/store/uiStore"

// Placing dimensions with clicks, picking images and the objects of a marquee, the group actions of the keys and the Inspector, and the panels, rendered for real.

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root
let host: HTMLElement
const mount = (ui: ReactElement) => act(() => root.render(ui))
const button = (name: RegExp) => [...document.querySelectorAll("button")].find((b) => name.test(b.textContent ?? ""))
const click = (b: Element | undefined) => act(() => void b!.dispatchEvent(new MouseEvent("click", { bubbles: true })))
const vis = { hidden: {} as Record<string, boolean>, layers: { top: true, bottom: true, silk: true } }

beforeEach(() => {
  host = document.createElement("div")
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  projectApi().close()
  uiApi().clearSelection()
})

describe("placing a dimension", () => {
  it("takes three clicks for an aligned one, with the third putting its crossbar, and two for the rest", () => {
    expect(dimensionClicks("aligned")).toBe(3)
    expect(dimensionClicks("orthogonal")).toBe(3)
    for (const k of ["leader", "center", "radial"] as const) expect(dimensionClicks(k)).toBe(2)
    const d = buildDimension("aligned", "Dwgs.User", [{ x: 0, y: 0 }, { x: 10, y: 0 }], { x: 5, y: -4 })!
    // a click below the line puts the crossbar there: KiCad's positive height points (dy, -dx), downward here
    expect(d.height).toBeCloseTo(4)
    const above = buildDimension("aligned", "Dwgs.User", [{ x: 0, y: 0 }, { x: 10, y: 0 }], { x: 5, y: 4 })!
    expect(above.height).toBeCloseTo(-4)
    expect(dimensionDrawing({ ...d, id: "x" }).lines.some((l) => Math.abs(l.a.y + 4) < 1e-6 && Math.abs(l.b.y + 4) < 1e-6)).toBe(true)
    expect(buildDimension("aligned", "Dwgs.User", [{ x: 1, y: 1 }], { x: 1, y: 1 })).toBeNull()
  })
  it("picks the axis of an orthogonal one by which way its points are further apart", () => {
    expect(buildDimension("orthogonal", "Dwgs.User", [{ x: 0, y: 0 }, { x: 10, y: 3 }], { x: 5, y: -2 })!.vertical).toBeUndefined()
    expect(buildDimension("orthogonal", "Dwgs.User", [{ x: 0, y: 0 }, { x: 3, y: 10 }], { x: 5, y: 5 })!.vertical).toBe(true)
  })
})

describe("picking images and the objects of a marquee", () => {
  const withObjects = (): Project => {
    let p = createProject("x")
    p = { ...p, images: [{ id: "im1", x: 0, y: 0, layer: "Dwgs.User", scale: 1, file: "a".repeat(64), format: "png", px: 96, py: 96, ppi: 96 }] }
    p = addDimension(p, newDimension("aligned", "Dwgs.User", { x: 40, y: 0 }, { x: 50, y: 0 }, { height: 2 })).project
    return p
  }
  it("hit an image inside its box, not outside, and not on a layer that is hidden", () => {
    const p = withObjects()
    expect(hitImage(p, { x: 1, y: 1 }, vis)).toBe("i:im1")
    expect(hitImage(p, { x: 20, y: 0 }, vis)).toBeNull()
    expect(hitImage(p, { x: 1, y: 1 }, { ...vis, hidden: { "Dwgs.User": true } })).toBeNull()
  })
  it("a marquee takes the dimensions and images it touches", () => {
    const p = withObjects()
    const all = marqueeBoardObjects(p, { minX: -50, minY: -50, maxX: 80, maxY: 50 }, vis)
    expect(all).toHaveLength(2)
    expect(marqueeBoardObjects(p, { minX: 35, minY: -10, maxX: 80, maxY: 10 }, vis)).toEqual([`m:${p.dimensions![0].id}`])
  })
})

describe("the group actions and panels", () => {
  function open() {
    let p = createProject("g")
    const v = addVia(p, { x: 1, y: 1 })
    const w = addVia(v.project, { x: 3, y: 1 })
    p = addDimension(w.project, newDimension("center", "Dwgs.User", { x: 5, y: 5 }, { x: 6, y: 5 })).project
    projectApi().open(p)
    return { v: v.via.id, w: w.via.id, m: p.dimensions![0].id }
  }
  it("groups the selection, selects it whole, locks it, and takes it apart", () => {
    const { v, w } = open()
    uiApi().select([`v:${v}`, `v:${w}`])
    expect(groupSelected("pair")).toBe(true)
    expect(projectApi().project!.groups).toHaveLength(1)
    expect(projectApi().project!.groups![0]).toMatchObject({ name: "pair", members: [v, w] })
    expect(lockSelectedGroups(true)).toBe(true)
    expect(projectApi().project!.groups![0].locked).toBe(true)
    expect(ungroupSelected()).toBe(true)
    expect(projectApi().project!.groups).toBeUndefined()
    // each of these is one undo step
    projectApi().undo()
    expect(projectApi().project!.groups).toHaveLength(1)
  })
  it("says so when there is nothing to group", () => {
    open()
    uiApi().clearSelection()
    expect(groupSelected()).toBe(false)
    expect(uiApi().notice?.text).toMatch(/Select something/)
  })
  it("the group section groups, locks and ungroups a selection from its buttons", () => {
    const { v, w } = open()
    uiApi().select([`v:${v}`, `v:${w}`])
    mount(<GroupSection project={projectApi().project!} />)
    click(button(/^\s*Group\s*$/))
    expect(projectApi().project!.groups).toHaveLength(1)
    mount(<GroupSection project={projectApi().project!} />)
    click(button(/Lock group/))
    expect(projectApi().project!.groups![0].locked).toBe(true)
    mount(<GroupSection project={projectApi().project!} />)
    click(button(/Ungroup/))
    expect(projectApi().project!.groups).toBeUndefined()
  })
  it("the dimension panel edits through one undo step each, and deletes", () => {
    const { m } = open()
    const dims = () => projectApi().project!.dimensions!
    mount(<DimensionInspector dims={dims()} project={projectApi().project!} />)
    const lock = document.querySelector('button[aria-label="Locked"]')!
    click(lock)
    expect(dims()[0].locked).toBe(true)
    click(button(/Delete dimension/))
    expect(projectApi().project!.dimensions).toBeUndefined()
    projectApi().undo()
    expect(dims()[0].id).toBe(m)
  })
  it("the image panel shows its size on the board and why a missing picture is a frame", () => {
    open()
    const image = { id: "im1", x: 0, y: 0, layer: "Dwgs.User", scale: 2, file: "b".repeat(64), format: "png" as const, px: 96, py: 48, ppi: 96 }
    projectApi().commit((p) => ({ ...p, images: [image] }))
    mount(<ImageInspector images={[image]} project={projectApi().project!} />)
    expect(document.body.textContent).toMatch(/96 by 48 pixels at 96 per inch/)
    expect(document.body.textContent).toMatch(/never in the Gerber files/)
    click(button(/Delete image/))
    expect(projectApi().project!.images).toBeUndefined()
  })
})
