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
const click = (label: string) => act(() => void button(label)!.dispatchEvent(new MouseEvent("click", { bubbles: true })))

describe("a viewer's toolbars", () => {
  // The tools on the bar, and the menus the rest are in (each group's chevron), with what each menu lists.
  const SCHEMATIC = ["Wire", "Net label", "Text"]
  const SCHEMATIC_GROUPS: Record<string, string[]> = { "Bus tools": ["Bus", "Bus entry"], "Block and sheet tools": ["Block", "Sheet"], "Drawing tools": ["Line", "Rectangle"] }
  const PCB = ["Route trace", "Place via", "Re-pack parts", "Autoroute"]
  const PCB_GROUPS: Record<string, string[]> = {
    "Zone tools": ["Draw a copper zone", "Draw a keepout"],
    "Drawing tools": ["Draw line", "Draw arc", "Draw circle", "Draw rectangle", "Draw polygon", "Cut a slot"],
    "Text and dimension tools": ["Add text", "Add dimension", "Add reference image"],
  }

  /** A group's chevron and the tool button beside it, which the group shows. */
  const group = (label: string) => {
    const chevron = button(label)!
    return [chevron, chevron.previousElementSibling as HTMLButtonElement]
  }

  it("has every schematic tool off, its menus shut, and picking one does nothing", () => {
    projectApi().open(createProject("one"))
    useProjectStore.setState({ role: "viewer" })
    act(() => root.render(<SchematicToolbar />))
    expect(button("Select")!.disabled).toBe(false)
    for (const label of SCHEMATIC) {
      expect(button(label), label).toBeTruthy()
      expect(button(label)!.disabled, label).toBe(true)
      click(label)
      expect(uiApi().schTool, label).toBe("select")
    }
    for (const label of Object.keys(SCHEMATIC_GROUPS)) {
      for (const b of group(label)) expect(b.disabled, label).toBe(true)
      for (const b of group(label)) act(() => void b.dispatchEvent(new MouseEvent("click", { bubbles: true })))
      expect(host.querySelector("[role=menu]"), label).toBeNull()
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
    for (const label of Object.keys(PCB_GROUPS)) {
      for (const b of group(label)) expect(b.disabled, label).toBe(true)
      for (const b of group(label)) act(() => void b.dispatchEvent(new MouseEvent("click", { bubbles: true })))
      expect(host.querySelector("[role=menu]"), label).toBeNull()
    }
    expect(uiApi().pcbTool).toBe("select")
  })

  it("has the tools on for an editor, every one in its menu, and a menu pick is the tool", () => {
    projectApi().open(createProject("one"))
    act(() => root.render(<SchematicToolbar />))
    for (const label of SCHEMATIC) expect(button(label)!.disabled, label).toBe(false)
    for (const [label, tools] of Object.entries(SCHEMATIC_GROUPS)) {
      click(label)
      expect([...host.querySelectorAll("[role=menu] button")].map((b) => b.getAttribute("aria-label")), label).toEqual(tools)
      click(tools[1])
      expect(host.querySelector("[role=menu]"), label).toBeNull()
      expect(button(tools[1])!.getAttribute("aria-pressed"), label).toBe("true")
    }
    expect(uiApi().schTool).toBe("rect")
    act(() => root.render(<PcbToolbar />))
    for (const label of PCB) expect(button(label)!.disabled, label).toBe(false)
    for (const [label, tools] of Object.entries(PCB_GROUPS)) {
      click(label)
      expect([...host.querySelectorAll("[role=menu] button")].map((b) => b.getAttribute("aria-label")), label).toEqual(tools)
      click(label)
    }
    click("Zone tools")
    click("Draw a keepout")
    expect(uiApi().pcbTool).toBe("keepout")
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
