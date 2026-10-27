// @vitest-environment jsdom
import { act, type ReactElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { paintDrawing } from "../src/editor/schematic/drawingPaint"
import { SCH_LIGHT } from "../src/editor/theme"
import { isDirective } from "../src/model/directives"
import { importKicadSchematic } from "../src/model/kicad/schematic"
import { isRuleArea, ruleAreaFlags } from "../src/model/ruleAreas"
import { ExactDrawingInspector } from "../src/panels/SheetInspectors"
import { projectApi } from "../src/store/projectStore"
import type { Project } from "../src/model/types"
import { LIB_R, schematic } from "./kicad-schematic-fixtures"

// S8 in the editor: a directive label and a rule area are drawn, listed in the Inspector, edited there and deleted, and the store settles what they mean after
// each of those edits (the net class of the net, the flags of the parts).

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLElement
const mount = (ui: ReactElement) => act(() => root.render(ui))
beforeEach(() => {
  host = document.createElement("div")
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const sheet = schematic({
  version: 20260306,
  libs: [LIB_R],
  symbols: [
    { lib: "Device:R", at: "50.8 50.8", ref: "R1", uuid: "aaaaaaaa-0000-4000-8000-000000000001" },
    { lib: "Device:R", at: "50.8 63.5", ref: "R2", uuid: "aaaaaaaa-0000-4000-8000-000000000002" },
  ],
  wires: ["50.8 54.61 50.8 59.69"],
  labels: ["A 50.8 46.99 0", "B 50.8 67.31 0"],
  body: [
    `(netclass_flag "" (length 2.54) (shape diamond) (at 50.8 57.15 0) (effects (font (size 1.27 1.27)) (justify left bottom)) (uuid 11111111-0000-4000-8000-000000000001)
      (property "Netclass" "Power" (at 51.5 54.61 0) (effects (font (size 1.27 1.27)))))`,
    `(rule_area (dnp no) (polyline (pts (xy 40 58) (xy 65 58) (xy 65 70) (xy 40 70)) (stroke (width 0) (type dash)) (fill (type none)) (uuid 22222222-0000-4000-8000-000000000002)))`,
  ],
})
const imported = (): Project => {
  const r = importKicadSchematic(sheet)
  if (r.status !== "imported") throw new Error(r.message)
  return r.project
}
const now = () => projectApi().project!
const input = (label: string) => [...host.querySelectorAll("label")].find((l) => l.textContent?.trim().startsWith(label))?.querySelector("input,select") as HTMLInputElement
const type = (el: HTMLInputElement, value: string) => {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!
  act(() => {
    set.call(el, value)
    el.dispatchEvent(new Event("input", { bubbles: true }))
  })
  act(() => void el.blur())
  act(() => void el.dispatchEvent(new FocusEvent("focusout", { bubbles: true })))
}

describe("S8 in the editor", () => {
  it("draws a directive label as its pin, its flag and its shown fields, and a rule area as its dashed polygon", () => {
    const p = imported()
    const d = p.drawings!.find(isDirective)!
    const nodes = paintDrawing(d, SCH_LIGHT, 0.01)
    expect(nodes.map((n) => n.tag)).toEqual(["line", "polyline", "ktext"])
    expect(nodes.find((n) => n.tag === "ktext")!.text).toBe("Power")
    // Hidden or empty fields draw nothing.
    expect(paintDrawing({ ...d, fields: [{ ...d.fields[0], value: "" }] }, SCH_LIGHT, 0.01).map((n) => n.tag)).toEqual(["line", "polyline"])
    const area = p.drawings!.find(isRuleArea)!
    const drawn = paintDrawing(area, SCH_LIGHT, 0.01)
    expect(drawn.length).toBeGreaterThan(0)
    expect(JSON.stringify(drawn)).toMatch(/strokeDasharray/)
  })

  it("lists a directive label's net class in the Inspector and changes it: the net follows, and an empty class takes the net out", () => {
    const p = imported()
    projectApi().open(p)
    const d = now().drawings!.find(isDirective)!
    mount(<ExactDrawingInspector drawing={d} />)
    expect(host.textContent).toContain("Directive label")
    expect(input("Net class").value).toBe("Power")
    type(input("Net class"), "Clk")
    expect(now().rules.netClasses).toEqual([{ name: "Clk", nets: [], labelNets: ["Net-(R1-Pad2)"], implicit: true }])
    mount(<ExactDrawingInspector drawing={now().drawings!.find(isDirective)!} />)
    type(input("Net class"), "")
    expect(now().rules.netClasses).toBeUndefined()
    // One undo brings the class back, and the project is the one before.
    act(() => projectApi().undo())
    expect(now().rules.netClasses).toEqual([{ name: "Clk", nets: [], labelNets: ["Net-(R1-Pad2)"], implicit: true }])
  })

  it("deletes a directive label from the Inspector and the class goes with it, in one undo step", () => {
    projectApi().open(imported())
    mount(<ExactDrawingInspector drawing={now().drawings!.find(isDirective)!} />)
    const before = now()
    expect(before.rules.netClasses).toHaveLength(1)
    act(() => void [...host.querySelectorAll("button")].find((b) => b.textContent?.includes("Delete"))!.dispatchEvent(new MouseEvent("click", { bubbles: true })))
    expect(now().drawings!.some(isDirective)).toBe(false)
    expect(now().rules.netClasses).toBeUndefined()
    act(() => projectApi().undo())
    // An undo puts back what the step changed (`store/projectStore.ts`), so the project is the one before in everything but its saved date.
    expect({ ...now(), updatedAt: 0 }).toEqual({ ...before, updatedAt: 0 })
  })

  it("turns the flags of a rule area on and off in the Inspector, and the parts it touches follow", () => {
    projectApi().open(imported())
    const area = () => now().drawings!.find(isRuleArea)!
    mount(<ExactDrawingInspector drawing={area()} />)
    const sw = (label: string) => [...host.querySelectorAll('button[role="switch"]')].find((b) => b.getAttribute("aria-label") === label) as HTMLButtonElement
    expect(host.textContent).toContain("Rule area")
    expect(sw("Do not populate").getAttribute("aria-checked")).toBe("false")
    act(() => void sw("Do not populate").dispatchEvent(new MouseEvent("click", { bubbles: true })))
    expect(area().ruleArea).toMatchObject({ dnp: true })
    const refs = (p: Project) => [...ruleAreaFlags(p).keys()].map((id) => p.components.find((c) => c.id === id)!.ref)
    expect(refs(now())).toEqual(["R2"])
    mount(<ExactDrawingInspector drawing={area()} />)
    act(() => void sw("Do not populate").dispatchEvent(new MouseEvent("click", { bubbles: true })))
    expect(area().ruleArea?.dnp).toBeUndefined()
    expect(refs(now())).toEqual([])
  })

  it("changes the flag's shape and turns the pin from the Inspector", () => {
    projectApi().open(imported())
    mount(<ExactDrawingInspector drawing={now().drawings!.find(isDirective)!} />)
    const select = input("Flag") as unknown as HTMLSelectElement
    act(() => {
      const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!
      set.call(select, "dot")
      select.dispatchEvent(new Event("change", { bubbles: true }))
    })
    expect(now().drawings!.find(isDirective)!.shape).toBe("dot")
    act(() => void [...host.querySelectorAll("button")].find((b) => b.textContent?.includes("Turn"))!.dispatchEvent(new MouseEvent("click", { bubbles: true })))
    expect(now().drawings!.find(isDirective)!.rot).toBe(90)
  })
})
