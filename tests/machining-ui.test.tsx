// @vitest-environment jsdom
import { act, type ReactElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { runTool } from "../src/ai/tools"
import { setCopperLayerCount } from "../src/model/layerOps"
import { addComponent, addTrace, addVia, createProject } from "../src/model/ops"
import { registerProjectFootprints } from "../src/model/footprints"
import type { FootprintDef, Project } from "../src/model/types"
import { PartPadsSection } from "../src/panels/PadPanels"
import { ProjectInspector } from "../src/panels/ProjectInspector"
import { ViaMachiningSection } from "../src/panels/MachiningPanels"
import { projectApi } from "../src/store/projectStore"
import { uiApi } from "../src/store/uiStore"

// X22 in the panels: a via's protection, backdrill and post-machining, a pad's post-machining, and the board's protection rule, rendered for real.

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root
let host: HTMLElement
const mount = (ui: ReactElement) => act(() => root.render(ui))
const el = <T extends Element>(selector: string) => document.querySelector(selector) as T
const choose = (select: HTMLSelectElement, value: string) =>
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(select, value)
    select.dispatchEvent(new Event("change", { bubbles: true }))
  })
const type = (input: HTMLInputElement, value: string) => {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value)
    input.dispatchEvent(new Event("input", { bubbles: true }))
  })
  // React's onBlur listens for focusout
  act(() => void input.dispatchEvent(new FocusEvent("focusout", { bubbles: true })))
}
const click = (b: Element) => act(() => void b.dispatchEvent(new MouseEvent("click", { bubbles: true })))

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

/** A four layer board with two vias. */
function viaProject() {
  const p = setCopperLayerCount(createProject("x22"), 4).project
  const a = addVia(p, { x: 1, y: 1 })
  const b = addVia(a.project, { x: 3, y: 1 })
  projectApi().open(b.project)
  return { a: a.via.id, b: b.via.id }
}
const vias = () => projectApi().project!.vias
const showFirst = () => mount(<ViaMachiningSection vias={[vias()[0]]} project={projectApi().project!} />)

describe("the via panel", () => {
  it("is hidden on a board drawn in the editor", () => {
    projectApi().open(addVia(createProject("plain"), { x: 0, y: 0 }).project)
    mount(<ViaMachiningSection vias={vias()} project={projectApi().project!} />)
    expect(document.body.textContent).toBe("")
  })

  it("says a via's filling over the board's default, in words, and follows the board again", () => {
    const { a } = viaProject()
    showFirst()
    expect(document.body.textContent).toMatch(/Result: none/)
    expect(el<HTMLSelectElement>('select[aria-label="Via filling"]').textContent).toMatch(/Board's default \(off\)/)
    choose(el('select[aria-label="Via filling"]'), "yes")
    expect(vias().find((v) => v.id === a)!.protect).toEqual({ fill: true })
    showFirst()
    expect(document.body.textContent).toMatch(/Result: filled/)
    choose(el('select[aria-label="Via filling"]'), "")
    expect(vias().find((v) => v.id === a)!.protect).toBeUndefined()
    // one undo step each
    projectApi().undo()
    expect(vias().find((v) => v.id === a)!.protect).toEqual({ fill: true })
  })

  it("edits several selected vias together", () => {
    viaProject()
    mount(<ViaMachiningSection vias={vias()} project={projectApi().project!} />)
    choose(el('select[aria-label="Via capping"]'), "yes")
    expect(vias().map((v) => v.protect)).toEqual([{ cap: true }, { cap: true }])
  })

  it("turns a backdrill on, picks its layers from the board's, and turns it off", () => {
    viaProject()
    showFirst()
    expect(el('select[aria-label="Backdrill from"]')).toBeNull()
    choose(el('select[aria-label="Backdrill"]'), "on")
    const first = vias()[0].backdrill!
    expect(first.from).toBe("top")
    expect(first.size).toBeGreaterThan(vias()[0].drill)
    showFirst()
    expect([...el<HTMLSelectElement>('select[aria-label="Backdrill to"]').options].map((o) => o.value)).toEqual(["top", "in1", "in2", "bottom"])
    choose(el('select[aria-label="Backdrill to"]'), "in2")
    expect(vias()[0].backdrill).toMatchObject({ from: "top", to: "in2" })
    type(el('input[aria-label="Backdrill size"]'), "0.6")
    expect(vias()[0].backdrill).toMatchObject({ size: 0.6, to: "in2" })
    showFirst()
    choose(el('select[aria-label="Backdrill"]'), "off")
    expect(vias()[0].backdrill).toBeUndefined()
  })

  it("sets a countersink on the back of a via", () => {
    viaProject()
    showFirst()
    choose(el('select[aria-label="Post-machining, back"]'), "countersink")
    expect(vias()[0].post?.back).toMatchObject({ mode: "countersink", angle: 90 })
    expect(vias()[0].post?.front).toBeUndefined()
    showFirst()
    type(el('input[aria-label="Post-machining, back angle"]'), "82")
    expect(vias()[0].post?.back?.angle).toBe(82)
  })
})

describe("the pad panel", () => {
  const land: FootprintDef = {
    name: "x22-land",
    pads: [
      { pin: "1", shape: "circle", x: 0, y: 0, width: 1.6, height: 1.6, layer: "through", holeDiameter: 0.8, round: 0.25 },
      { pin: "2", shape: "circle", x: 2.54, y: 0, width: 1.6, height: 1.6, layer: "through", holeDiameter: 0.8, round: 0.25 },
    ],
    silk: [],
    courtyard: { minX: -1, minY: -1, maxX: 4, maxY: 1 },
  }
  function open(): { project: Project; id: string } {
    registerProjectFootprints({ footprints: [land] })
    const c = addComponent(setCopperLayerCount(createProject("pads"), 4).project, "resistor", { footprint: land.name, pcb: { x: 5, y: 5, rot: 0, side: "top", placed: true } })
    const p = { ...c.project, footprints: [land] }
    projectApi().open(p)
    return { project: p, id: c.component.id }
  }
  it("edits the post-machining and the package length of the picked pad", () => {
    const { id } = open()
    const show = () => mount(<PartPadsSection c={projectApi().project!.components.find((c) => c.id === id)!} project={projectApi().project!} />)
    show()
    const pad = () => projectApi().project!.footprints![0].pads[0]
    const face = "Post-machining, part's face"
    choose(el(`select[aria-label="${face}"]`), "counterbore")
    expect(pad().post?.front).toMatchObject({ mode: "counterbore" })
    show()
    type(el(`input[aria-label="${face} depth"]`), "0.3")
    expect(pad().post?.front?.depth).toBe(0.3)
    type(el('input[aria-label="Length in package"]'), "1.25")
    expect(pad().dieLength).toBe(1.25)
    type(el('input[aria-label="Delay in package"]'), "8")
    expect(pad().dieDelay).toBe(8)
    // the other pad is untouched
    expect(projectApi().project!.footprints![0].pads[1].post).toBeUndefined()
    show()
    choose(el('select[aria-label="Backdrill"]'), "on")
    expect(pad().backdrill).toMatchObject({ from: "top" })
  })
})

describe("the board's rule", () => {
  it("switches the board's protection on and off, and a via that says nothing follows it", () => {
    viaProject()
    mount(<ProjectInspector project={projectApi().project!} />)
    click(el('button[aria-label="Rule: filling"]'))
    expect(projectApi().project!.rules.viaProtect).toMatchObject({ fill: true })
    showFirst()
    expect(el<HTMLSelectElement>('select[aria-label="Via filling"]').textContent).toMatch(/Board's default \(on\)/)
    expect(document.body.textContent).toMatch(/Result: filled/)
    mount(<ProjectInspector project={projectApi().project!} />)
    click(el('button[aria-label="Rule: filling"]'))
    expect(projectApi().project!.rules.viaProtect?.fill).toBeFalsy()
  })
})

describe("what Sakura reads", () => {
  it("lists protection, drills, post-machining and tuning only when the board has them", () => {
    viaProject()
    const read = () => JSON.parse(runTool(projectApi().project!, "get_design", {}).result)
    const plain = read()
    for (const k of ["via_protection", "backdrills", "post_machining", "tuning_patterns", "package_lengths"]) expect(plain).not.toHaveProperty(k)
    showFirst()
    choose(el('select[aria-label="Via filling"]'), "yes")
    showFirst()
    choose(el('select[aria-label="Backdrill"]'), "on")
    showFirst()
    choose(el('select[aria-label="Post-machining, front"]'), "counterbore")
    projectApi().commit((p) => {
      const t = addTrace(p, { points: [{ x: 0, y: 0 }, { x: 5, y: 0 }], layer: "top", width: 0.2 })
      return { ...t.project, groups: [{ id: "g", name: "Tune", members: [t.trace!.id], gen: { kind: "tuning_pattern", layer: "top", props: { target_length: 40 } } }] }
    })
    const d = read()
    expect(d.via_protection).toEqual({ filled: 1 })
    expect(d.backdrills).toEqual({ vias: 1, pads: 0 })
    expect(d.post_machining).toEqual({ vias: 1, pads: 0 })
    expect(d.tuning_patterns).toEqual([{ name: "Tune", layer: "F.Cu", target_mm: 40 }])
  })
})
