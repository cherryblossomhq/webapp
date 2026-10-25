// @vitest-environment jsdom
import { act, type ReactElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { computeConnectivity } from "../src/model/connectivity"
import { EXAMPLES } from "../src/model/examples"
import { classIndex } from "../src/model/netClasses"
import { NetClassesSection, NetClassField } from "../src/panels/NetClassesSection"
import type { Project } from "../src/model/types"
import { projectApi } from "../src/store/projectStore"

// The Inspector's "Net classes" section, rendered for real: adding a class, naming it, giving it a size, putting nets in it and taking them out,
// and the class field a highlighted net shows. Every change is one undo step on the project.

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLElement
const mount = (ui: ReactElement) => act(() => root.render(ui))
const button = (name: RegExp | string) => [...document.querySelectorAll("button")].find((b) => (typeof name === "string" ? b.textContent?.trim() === name : name.test(`${b.textContent ?? ""}${b.getAttribute("aria-label") ?? ""}`)))
const click = (b: Element | undefined) => act(() => void b!.dispatchEvent(new MouseEvent("click", { bubbles: true })))
const byLabel = <T extends HTMLElement>(label: string) => document.querySelector<T>(`[aria-label="${label}"]`)!
const type = (input: HTMLInputElement, value: string) => {
  act(() => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!
    set.call(input, value)
    input.dispatchEvent(new Event("input", { bubbles: true }))
  })
  // React's onBlur listens for focusout
  act(() => void input.dispatchEvent(new FocusEvent("focusout", { bubbles: true })))
}
const choose = (select: HTMLSelectElement, value: string) =>
  act(() => {
    const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!
    set.call(select, value)
    select.dispatchEvent(new Event("change", { bubbles: true }))
  })

const blinker = () => structuredClone(EXAMPLES.find((e) => e.id === "blinker")!.project) as Project
const live = () => projectApi().project!
const view = () => <NetClassesSection project={live()} />
/** Draw the section for the project as it is now, then press Add. */
const add = () => {
  mount(view())
  click(button(/Add a net class/))
}

beforeEach(() => {
  host = document.createElement("div")
  document.body.appendChild(host)
  root = createRoot(host)
  projectApi().open(blinker())
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe("the Net classes section", () => {
  it("says every net is in Default while there is no class, and adds a class", () => {
    mount(view())
    expect(document.body.textContent).toMatch(/Every net is in the Default class/)
    click(button(/Add a net class/))
    expect(live().rules.netClasses).toEqual([{ name: "Class", nets: [] }])
    mount(view())
    expect(byLabel("Net class name")).toBeTruthy()
  })
  it("renames a class, refuses Default and a taken name, and gives a size that the class then holds", () => {
    add()
    add()
    expect(live().rules.netClasses!.map((c) => c.name)).toEqual(["Class", "Class 2"])
    mount(view())
    const names = [...document.querySelectorAll<HTMLInputElement>('[aria-label="Net class name"]')]
    type(names[0], "Power")
    expect(live().rules.netClasses!.map((c) => c.name)).toEqual(["Power", "Class 2"])
    mount(view())
    type([...document.querySelectorAll<HTMLInputElement>('[aria-label="Net class name"]')][1], "Default")
    type([...document.querySelectorAll<HTMLInputElement>('[aria-label="Net class name"]')][1], "Power")
    expect(live().rules.netClasses!.map((c) => c.name)).toEqual(["Power", "Class 2"])
    mount(view())
    type(byLabel<HTMLInputElement>("Power Clearance"), "0.45")
    expect(live().rules.netClasses![0].clearance).toBe(0.45)
    type(byLabel<HTMLInputElement>("Power Trace width"), "0.7")
    expect(live().rules.netClasses![0].traceWidth).toBe(0.7)
    // an empty field gives the size back to Default
    mount(view())
    type(byLabel<HTMLInputElement>("Power Clearance"), "")
    expect(live().rules.netClasses![0]).not.toHaveProperty("clearance")
  })
  it("puts a net in a class and takes it out again, one undo step each", () => {
    add()
    mount(view())
    const net = computeConnectivity(live()).nets.find((n) => n.pins.length > 1)!.name
    const steps = projectApi().past.length
    choose(byLabel<HTMLSelectElement>("Add a net to Class"), net)
    expect(live().rules.netClasses![0].nets).toEqual([net])
    expect(projectApi().past.length).toBe(steps + 1)
    mount(view())
    click(button(new RegExp(`Take ${net.replace(/[()]/g, "\\$&")} out of Class`)))
    expect(live().rules.netClasses![0].nets).toEqual([])
    projectApi().undo()
    expect(live().rules.netClasses![0].nets).toEqual([net])
  })
  it("a net moves from one class to another, and the highlighted net's class field changes it too", () => {
    add()
    add()
    const net = computeConnectivity(live()).nets.find((n) => n.pins.length > 1)!.name
    mount(view())
    choose(byLabel<HTMLSelectElement>("Add a net to Class"), net)
    mount(view())
    choose(byLabel<HTMLSelectElement>("Add a net to Class 2"), net)
    expect(live().rules.netClasses!.map((c) => c.nets)).toEqual([[], [net]])
    mount(<NetClassField project={live()} net={net} />)
    expect((byLabel<HTMLSelectElement>(`Net class of ${net}`)).value).toBe("Class 2")
    choose(byLabel<HTMLSelectElement>(`Net class of ${net}`), "Class")
    expect(classIndex(live().rules).classOf(net)?.name).toBe("Class")
    choose(byLabel<HTMLSelectElement>(`Net class of ${net}`), "")
    expect(classIndex(live().rules).classOf(net)).toBeNull()
  })
  it("patterns put nets in the class, and the section says how many", () => {
    add()
    mount(view())
    const net = computeConnectivity(live()).nets.find((n) => n.pins.length > 1)!.name
    type(byLabel<HTMLInputElement>("Class patterns"), `${net.slice(0, 1)}*`)
    expect(live().rules.netClasses![0].patterns).toEqual([`${net.slice(0, 1)}*`])
    mount(view())
    expect(document.body.textContent).toMatch(/Also takes \d+ nets? by pattern/)
  })
  it("deleting the last class leaves a board with no classes at all", () => {
    add()
    mount(view())
    click(button(/Delete the class Class/))
    expect(live().rules).not.toHaveProperty("netClasses")
  })
  it("shows nothing of classes in the net field for a board that has none", () => {
    mount(<NetClassField project={live()} net="GND" />)
    expect(host.textContent).toBe("")
  })
})
