// @vitest-environment jsdom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createProject } from "../src/model/ops"
import { PcbToolbar, SchematicToolbar } from "../src/panels/CanvasToolbar"
import { VariantsSection } from "../src/panels/VariantPanels"
import { projectApi, useProjectStore } from "../src/store/projectStore"
import { uiApi } from "../src/store/uiStore"
import { addComponent } from "../src/model/ops"
import { addVariant } from "../src/model/variants"

// A viewer looks and does not edit: the KiCad model's tools (sheets, buses, zones, keepouts, slots, dimensions, text, reference images, the repack) are off
// in their toolbars as the drawing and Block tools are, and the variants panel offers no change. The store refuses what they would do anyway
// (`tests/sync-kicad-model.test.ts`); this is the buttons and keys saying so before the user tries.

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
  useProjectStore.setState({ role: "owner" })
  uiApi().setSchTool("select")
  uiApi().setPcbTool("select")
})

const button = (label: string) => [...host.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === label) as HTMLButtonElement | undefined

describe("a viewer's toolbars", () => {
  const SCHEMATIC = ["Wire", "Net label", "Bus", "Bus entry", "Sheet", "Block", "Text", "Line", "Rectangle"]
  const PCB = ["Route trace", "Place via", "Cut a slot", "Draw a copper zone", "Draw a keepout", "Add text", "Add dimension", "Add reference image", "Re-pack parts", "Autoroute"]

  it("has every schematic tool off, and picking one does nothing", () => {
    projectApi().open(createProject("one"))
    useProjectStore.setState({ role: "viewer" })
    act(() => root.render(<SchematicToolbar />))
    expect(button("Select")!.disabled).toBe(false)
    for (const label of SCHEMATIC) {
      expect(button(label), label).toBeTruthy()
      expect(button(label)!.disabled, label).toBe(true)
      act(() => void button(label)!.dispatchEvent(new MouseEvent("click", { bubbles: true })))
      expect(uiApi().schTool, label).toBe("select")
    }
  })

  it("has every board tool off, the zone, keepout, slot, dimension, text and image ones too", () => {
    projectApi().open(createProject("one"))
    useProjectStore.setState({ role: "viewer" })
    act(() => root.render(<PcbToolbar />))
    for (const label of PCB) {
      expect(button(label), label).toBeTruthy()
      expect(button(label)!.disabled, label).toBe(true)
    }
    for (const b of host.querySelectorAll("button")) {
      if (b.getAttribute("aria-label")?.startsWith("Draw ") || b.getAttribute("aria-label") === "Line" || b.getAttribute("aria-label") === "Rectangle") expect(b.disabled).toBe(true)
    }
    act(() => void button("Draw a copper zone")!.dispatchEvent(new MouseEvent("click", { bubbles: true })))
    expect(uiApi().pcbTool).toBe("select")
  })

  it("has the tools on for an editor", () => {
    projectApi().open(createProject("one"))
    act(() => root.render(<SchematicToolbar />))
    for (const label of SCHEMATIC) expect(button(label)!.disabled, label).toBe(false)
    act(() => root.render(<PcbToolbar />))
    for (const label of ["Route trace", "Draw a copper zone", "Draw a keepout", "Add dimension", "Add reference image"]) expect(button(label)!.disabled, label).toBe(false)
  })

  it("offers no change of the variants", () => {
    const p = addVariant(addComponent(createProject("one"), "resistor").project, "Lite")!
    projectApi().open(p)
    useProjectStore.setState({ role: "viewer" })
    act(() => root.render(<VariantsSection project={p} />))
    expect((host.querySelector('select[aria-label="Active variant"]') as HTMLSelectElement).disabled).toBe(true)
    expect(button("Remove variant Lite")!.disabled).toBe(true)
    expect((host.querySelector('input[aria-label="New variant name"]') as HTMLInputElement).disabled).toBe(true)
    expect([...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Add")!.disabled).toBe(true)
  })
})
