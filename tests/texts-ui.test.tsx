// @vitest-environment jsdom
import { act, type ReactElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { registerProjectParts } from "../src/model/customParts"
import { EXAMPLES } from "../src/model/examples"
import { isPhysical } from "../src/model/instances"
import { findPart } from "../src/model/library"
import { PartTextsSection } from "../src/panels/TextPanels"
import { addPartText, withDesignatorText } from "../src/model/textOps"
import type { Project } from "../src/model/types"
import { projectApi } from "../src/store/projectStore"

// The part panel's text section, rendered for real: "Automatic designator" says what it removes before it removes anything
// from a part that holds more than its own reference.

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLElement
const mount = (ui: ReactElement) => act(() => root.render(ui))
const button = (name: RegExp | string) => [...document.querySelectorAll("button")].find((b) => (typeof name === "string" ? b.textContent?.trim() === name : name.test(b.textContent ?? "")))
const click = (b: Element | undefined) => act(() => void b!.dispatchEvent(new MouseEvent("click", { bubbles: true })))

const blinker = () => {
  const p = structuredClone(EXAMPLES.find((e) => e.id === "blinker")!.project) as Project
  registerProjectParts(p)
  return p
}
const partOf = (p: Project) => p.components.find((c) => isPhysical(findPart(c.partId)) && c.pcb.placed)!

beforeEach(() => {
  host = document.createElement("div")
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

function open(extra: number) {
  let p = blinker()
  const id = partOf(p).id
  p = withDesignatorText(p, id)
  for (let i = 0; i < extra; i++) p = addPartText(p, id, { text: `NOTE${i}`, at: { x: partOf(p).pcb.x, y: partOf(p).pcb.y } }).project
  projectApi().open(p)
  return id
}
const current = (id: string) => projectApi().project!.components.find((c) => c.id === id)!
const section = (id: string) => <PartTextsSection c={current(id)} project={projectApi().project!} />

describe("Automatic designator", () => {
  it("gives a part that holds only its own reference back at once", () => {
    const id = open(0)
    mount(section(id))
    click(button(/Automatic designator/))
    expect(current(id).texts).toBeUndefined()
  })
  it("says what it removes first for a part that holds more, and removes nothing until the user agrees", () => {
    const id = open(2)
    expect(current(id).texts).toHaveLength(3)
    mount(section(id))
    click(button(/Automatic designator/))
    // nothing is removed yet, and the panel says how many texts go
    expect(current(id).texts).toHaveLength(3)
    expect(document.body.textContent).toMatch(/This removes all 3 texts of/)
    click(button("Keep them"))
    expect(current(id).texts).toHaveLength(3)
    expect(document.body.textContent).not.toMatch(/This removes all/)
    click(button(/Automatic designator/))
    click(button("Remove the 3 texts"))
    expect(current(id).texts).toBeUndefined()
  })
})
