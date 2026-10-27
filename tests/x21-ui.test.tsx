// @vitest-environment jsdom
import { act, type ReactElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { addTrace, createProject } from "../src/model/ops"
import type { PcbGroup, Project } from "../src/model/types"
import { GroupSection } from "../src/panels/BoardObjectPanels"
import { updateGeneratorProps } from "../src/panels/generatorEdits"
import { NetChainsSection, NetLengthSection } from "../src/panels/GeneratorPanels"
import { projectApi } from "../src/store/projectStore"
import { uiApi } from "../src/store/uiStore"

// X21 in the panels: a generated group says what made it and its numbers, a tuning pattern's numbers are changed in place, and "Take apart" leaves the tracks.

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root
let host: HTMLElement
const mount = (ui: ReactElement) => act(() => root.render(ui))
const button = (name: RegExp) => [...document.querySelectorAll("button")].find((b) => name.test(b.textContent ?? ""))
const click = (b: Element | undefined) => act(() => void b!.dispatchEvent(new MouseEvent("click", { bubbles: true })))
const type = (input: HTMLInputElement, value: string) => {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value)
    input.dispatchEvent(new Event("input", { bubbles: true }))
  })
  // React's onBlur listens for focusout
  act(() => void input.dispatchEvent(new FocusEvent("focusout", { bubbles: true })))
}
const input = (label: string) => document.querySelector(`input[aria-label="${label}"]`) as HTMLInputElement

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

/** Two tracks in a tuning pattern, and the project open with both selected. */
function open(extra: Partial<PcbGroup> = {}): { project: Project; ids: string[] } {
  let p = createProject("x21")
  const a = addTrace(p, { points: [{ x: 0, y: 0 }, { x: 5, y: 0 }], layer: "top", width: 0.2 })
  const b = addTrace(a.project, { points: [{ x: 5, y: 0 }, { x: 5, y: 4 }], layer: "top", width: 0.2 })
  const ids = [a.trace!.id, b.trace!.id]
  p = {
    ...b.project,
    groups: [
      {
        id: "gp1",
        name: "Tuning pattern",
        members: ids,
        gen: {
          kind: "tuning_pattern",
          layer: "top",
          props: { target_length: 55.5, target_length_min: 55, min_spacing: 0.6, single_sided: true, last_tuning: "54.9 mm (too short)", origin: { xy: [0, 0] }, base_line: { pts: [[0, 0], [5, 0]] } },
        },
        ...extra,
      },
    ],
  }
  projectApi().open(p)
  uiApi().select(ids.map((id) => `t:${id}`))
  return { project: p, ids }
}
const group = () => projectApi().project!.groups?.[0]
const show = () => mount(<GroupSection project={projectApi().project!} />)

describe("a generated group", () => {
  it("says what made it, its layer, its target and its other numbers, and not its points", () => {
    open()
    show()
    const text = document.body.textContent!
    expect(text).toMatch(/Made by.*Tuning pattern/)
    expect(text).toMatch(/Layer.*Top/)
    expect(input("Target length").value).toBe("55.5")
    expect(input("Shortest length").value).toBe("55")
    expect(input("Longest length").value).toBe("")
    expect(text).toMatch(/single_sided.*yes/)
    expect(text).toMatch(/last_tuning.*too short/)
    // the points are not in the table, and the numbers that have a field of their own are not either
    expect(text).not.toMatch(/origin|base_line/)
    expect(document.querySelector('table[aria-label="Parameters"]')!.textContent).not.toMatch(/target_length/)
  })

  it("changes a tuning number in place, as one undo step, and clears one that is emptied", () => {
    open()
    show()
    type(input("Target length"), "60.25")
    expect(group()!.gen!.props.target_length).toBe(60.25)
    // the points and the other numbers stay
    expect(group()!.gen!.props.origin).toEqual({ xy: [0, 0] })
    expect(group()!.gen!.props.min_spacing).toBe(0.6)
    show()
    type(input("Shortest length"), "")
    expect(group()!.gen!.props.target_length_min).toBeUndefined()
    expect(group()!.gen!.props.target_length).toBe(60.25)
    projectApi().undo()
    expect(group()!.gen!.props.target_length_min).toBe(55)
    projectApi().undo()
    expect(group()!.gen!.props.target_length).toBe(55.5)
  })

  it("is taken apart with a button that says the tracks stay, and the tracks stay", () => {
    const { ids } = open()
    show()
    expect(document.body.textContent).toMatch(/The tracks stay as plain tracks/)
    expect(button(/Ungroup/)).toBeUndefined()
    click(button(/Take apart/))
    expect(projectApi().project!.groups).toBeUndefined()
    expect(projectApi().project!.traces.map((t) => t.id)).toEqual(ids)
    projectApi().undo()
    expect(group()!.gen!.kind).toBe("tuning_pattern")
  })

  it("names a via stack and via stitching in words, with no editable numbers", () => {
    open({ gen: { kind: "via_stitch", layer: "bottom", props: { spacing: 2, count: 4 } } })
    show()
    expect(document.body.textContent).toMatch(/Made by.*Via stitching/)
    expect(document.body.textContent).toMatch(/Layer.*Bottom/)
    expect(input("Target length")).toBeNull()
    expect(document.body.textContent).toMatch(/spacing.*2/)
    expect(button(/Take apart/)).toBeDefined()
  })

  it("leaves an ordinary group as it was: Ungroup, and no generator block", () => {
    open()
    projectApi().commit((p) => ({ ...p, groups: p.groups!.map(({ gen: _gen, ...g }) => g) }))
    show()
    expect(button(/Ungroup/)).toBeDefined()
    expect(button(/Take apart/)).toBeUndefined()
    expect(document.body.textContent).not.toMatch(/Made by/)
  })
})

describe("the generator edit", () => {
  it("changes only a number that is usable, and nothing for a group that is not generated", () => {
    const { project } = open()
    expect(updateGeneratorProps(project, "gp1", { target_length: Number.NaN })).toBe(project)
    expect(updateGeneratorProps(project, "gp1", { target_length: -1 })).toBe(project)
    expect(updateGeneratorProps(project, "gp1", { target_length: 55.5 })).toBe(project)
    expect(updateGeneratorProps(project, "nope", { target_length: 3 })).toBe(project)
    expect(updateGeneratorProps(project, "gp1", { max_amplitude: 2 }).groups![0].gen!.props.max_amplitude).toBe(2)
  })
})

describe("net chains and net lengths", () => {
  it("lists the chains of a board that has them, and nothing for one that has none", () => {
    mount(<NetChainsSection project={createProject("none")} />)
    expect(document.body.textContent).toBe("")
    mount(<NetChainsSection project={{ ...createProject("chains"), netChains: [{ name: "CLK", nets: ["CLK_A", "CLK_B"] }] }} />)
    expect(document.body.textContent).toMatch(/CLK/)
    expect(document.body.textContent).toMatch(/CLK_A > CLK_B/)
  })

  it("shows no net length for a project with no pattern and no package length", () => {
    projectApi().open(createProject("plain"))
    mount(<NetLengthSection project={projectApi().project!} net="GND" />)
    expect(document.body.textContent).toBe("")
  })
})
