// @vitest-environment jsdom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { customPartId } from "../src/model/customParts"
import { fileModel, setModel } from "../src/model/models3d"
import { addComponent, createProject } from "../src/model/ops"
import type { CustomPartSpec, Project } from "../src/model/types"
import { LibraryPanel } from "../src/panels/LibraryPanel"
import { PartEditor } from "../src/panels/PartEditor"
import { projectApi } from "../src/store/projectStore"
import { uiApi } from "../src/store/uiStore"

// The library panel's project parts and the part editor, rendered for real: removing a part nothing
// uses at once, asking before removing one that is placed, and editing one, saved as one undo step.

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const LDO: Omit<CustomPartSpec, "id"> = {
  name: "TPS7A0233",
  description: "200 mA 3.3 V LDO",
  category: "Power",
  refPrefix: "U",
  footprint: "sot23_5",
  pins: [
    { number: "1", name: "IN", kind: "power" },
    { number: "2", name: "GND", kind: "ground" },
    { number: "3", name: "EN", kind: "input" },
    { number: "4", name: "NC", kind: "nc" },
    { number: "5", name: "OUT", kind: "output" },
  ],
  props: { mpn: "TPS7A0233" },
  valueProp: "mpn",
}
const SENSOR: Omit<CustomPartSpec, "id"> = { ...LDO, name: "SHT31", description: "Humidity sensor", category: "ICs", footprint: "soic8", pins: Array.from({ length: 8 }, (_, i) => ({ number: String(i + 1), name: `P${i + 1}` })), props: { mpn: "SHT31" } }
const ldo: CustomPartSpec = { id: customPartId(LDO), ...LDO }
const sensor: CustomPartSpec = { id: customPartId(SENSOR), ...SENSOR }

let root: Root
let host: HTMLElement
const render = () =>
  act(() =>
    root.render(
      <>
        <LibraryPanel />
        <PartEditor />
      </>,
    ),
  )
const text = () => document.body.textContent ?? ""
const byLabel = <T extends HTMLElement = HTMLElement>(label: string) => document.querySelector<T>(`[aria-label="${label}"]`)
const button = (name: string | RegExp) => [...document.querySelectorAll("button")].find((b) => (typeof name === "string" ? b.textContent?.trim() === name : name.test(b.textContent ?? "")))
const click = (el: Element | null | undefined) => act(() => void el!.dispatchEvent(new MouseEvent("click", { bubbles: true })))
const type = (input: HTMLInputElement | HTMLTextAreaElement, value: string) =>
  act(() => {
    const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(input, value)
    input.dispatchEvent(new Event("input", { bubbles: true }))
  })
const live = () => projectApi().project!

beforeEach(() => {
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
  let p: Project = { ...createProject("parts"), parts: [ldo, sensor] }
  projectApi().open(p)
  p = addComponent(live(), ldo.id, { sch: { x: 0, y: 0 } }).project
  projectApi().open(p)
  uiApi().openPartEditor(null)
  uiApi().clearNotice()
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe("the library panel's built-in parts", () => {
  it("lists the basic parts only: a specific chip or module is found in the parts database", () => {
    render()
    const headings = [...document.querySelectorAll("h3")].map((h) => h.textContent ?? "")
    expect(headings.filter((h) => /^(ICs|Modules)\d/.test(h))).toEqual([])
    expect(text()).toContain("Resistor")
    expect(text()).not.toContain("ATmega328P")
    expect(text()).not.toContain("AMS1117")
  })

  it("offers Sakura and a KiCad import for a part no search found, and says where it looked", () => {
    render()
    type(byLabel<HTMLInputElement>("Search parts")!, "ne555")
    expect(text()).toContain('Can\'t find "ne555"?')
    expect(button("Create it with Sakura")).toBeTruthy()
    expect(button("Import KiCad files")).toBeTruthy()
    expect(text()).toMatch(/basic parts first, then in our parts database .*, then at LCSC/)
  })
})

describe("the project's parts in the library panel", () => {
  it("marks the part nothing is placed from, and removes it at once, as one undo step", () => {
    render()
    const rows = [...document.querySelectorAll("li")].filter((li) => /TPS7A0233|SHT31/.test(li.textContent ?? ""))
    expect(rows.map((r) => /Unused/.test(r.textContent ?? ""))).toEqual([false, true])
    click(byLabel("Remove SHT31 from the project"))
    expect(live().parts!.map((s) => s.name)).toEqual(["TPS7A0233"])
    expect(uiApi().notice?.text).toBe("Removed SHT31 from the project. Undo brings it back.")
    act(() => projectApi().undo())
    expect(live().parts!.map((s) => s.name)).toEqual(["TPS7A0233", "SHT31"])
  })

  it("asks before removing a part that is placed, and takes its components with it", () => {
    render()
    click(byLabel("Remove TPS7A0233 from the project"))
    expect(live().parts).toHaveLength(2)
    expect(document.querySelector('[role="dialog"]')).toBeTruthy()
    expect(text()).toMatch(/U1 is placed from it and will be deleted from the schematic and the board too/)
    click(button("Keep it"))
    expect(live().parts).toHaveLength(2)
    click(button(/Remove from project$/))
    click(button(/Remove part and U1/))
    expect(live().parts!.map((s) => s.name)).toEqual(["SHT31"])
    expect(live().components).toEqual([])
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })
})

describe("the part editor", () => {
  it("shows the part's details and saves an edit for every component placed from it", () => {
    render()
    click(byLabel("Edit TPS7A0233"))
    expect(document.querySelector('[role="dialog"]')).toBeTruthy()
    expect(text()).toMatch(/Placed as U1/)
    expect(button("Save")!.disabled).toBe(true)
    type(byLabel<HTMLInputElement>("Part name")!, "TPS7A02")
    type(byLabel<HTMLTextAreaElement>("Description")!, "Nano-power LDO")
    expect(button("Save")!.disabled).toBe(false)
    click(button("Save"))
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    const [edited] = live().parts!
    expect(edited).toMatchObject({ name: "TPS7A02", description: "Nano-power LDO" })
    expect(live().components[0].partId).toBe(edited.id)
    act(() => projectApi().undo())
    expect(live().parts![0].id).toBe(ldo.id)
    expect(live().components[0].partId).toBe(ldo.id)
  })

  it("edits pins, and won't save a pin with no pad", () => {
    render()
    click(byLabel("Edit TPS7A0233"))
    click(button("Pins (5)"))
    type(byLabel<HTMLInputElement>("Pin 3 name")!, "ENABLE")
    click(button("Add pin"))
    expect(text()).toMatch(/pin\(s\) 6 have no pad/)
    expect(button("Save")!.disabled).toBe(true)
    click(byLabel("Remove pin 6"))
    click(button("Save"))
    expect(live().parts![0].pins.find((p) => p.number === "3")!.name).toBe("ENABLE")
  })

  it("reads a parameter and adds one, and tells a footprint that doesn't exist", () => {
    render()
    click(byLabel("Edit TPS7A0233"))
    click(button("Add parameter"))
    type(byLabel<HTMLInputElement>("Parameter 2 name")!, "datasheet")
    type(byLabel<HTMLInputElement>("Parameter datasheet value")!, "https://www.ti.com/lit/gpn/tps7a02")
    expect(byLabel("Open datasheet")).toBeTruthy()
    click(button("Footprint"))
    type(byLabel<HTMLInputElement>("Footprint")!, "not_a_footprint")
    expect(text()).toMatch(/Unknown footprint "not_a_footprint"/)
    type(byLabel<HTMLInputElement>("Footprint")!, "sot23_5")
    click(button("Save"))
    expect(live().parts![0].props).toEqual({ mpn: "TPS7A0233", datasheet: "https://www.ti.com/lit/gpn/tps7a02" })
    expect(live().components[0].props.datasheet).toBe("https://www.ti.com/lit/gpn/tps7a02")
  })

  it("shows the part's 3D model and takes it off on Save, as one undo step", async () => {
    projectApi().open(setModel(live(), ldo.id, "sot23_5", fileModel("c".repeat(64), "ldo.step", "step")))
    render()
    click(byLabel("Edit TPS7A0233"))
    click(button("3D model"))
    expect(text()).toMatch(/ldo\.step/)
    expect(text()).toMatch(/Every component of this part on sot23_5 is drawn with it/)
    click(byLabel("Remove 3D model"))
    expect(text()).toMatch(/Generated body/)
    click(button("Save"))
    expect(live().models).toBeUndefined()
    expect(live().parts![0].id).toBe(ldo.id)
    act(() => projectApi().undo())
    expect(live().models).toHaveLength(1)
    // The preview loads with three.js; jsdom has no WebGL, so it says so rather than failing.
    click(byLabel("Edit TPS7A0233"))
    click(button("3D model"))
    await act(async () => void (await import("../src/editor/three/PartPreview3D")))
    await act(async () => void (await new Promise((r) => setTimeout(r, 0))))
    expect(text()).toMatch(/The 3D preview needs WebGL/)
  })

  it("keeps the model on a new footprint only when asked", () => {
    const step = fileModel("c".repeat(64), "ldo.step", "step")
    projectApi().open(setModel(live(), ldo.id, "sot23_5", step))
    render()
    click(byLabel("Edit TPS7A0233"))
    click(button("Footprint"))
    type(byLabel<HTMLInputElement>("Footprint")!, "sot23_5_p0.95mm")
    expect(text()).toMatch(/Its 3D model sat on the old footprint/)
    click(button("3D model"))
    click(button("Keep it anyway"))
    click(button("Save"))
    const [part] = live().parts!
    expect(live().models).toEqual([{ part: part.id, footprint: "sot23_5_p0.95mm", model: step }])
  })

  it("is read only for a viewer", () => {
    projectApi().open(live(), { revision: 0, role: "viewer" })
    render()
    click(byLabel("View TPS7A0233"))
    expect(byLabel<HTMLInputElement>("Part name")!.closest("fieldset")!.disabled).toBe(true)
    expect(button("Save")).toBeUndefined()
    expect(button(/Remove from project/)).toBeUndefined()
    expect(byLabel("Remove TPS7A0233 from the project")).toBeNull()
  })
})
