// @vitest-environment jsdom
import { act, type ReactElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { ZoneOutlines } from "../src/editor/pcb/ZoneDraw"
import { zoneHit } from "../src/editor/pcb/zoneEditing"
import { defaultPlacement } from "../src/model/placementAreas"
import { Inspector, parseClasses } from "../src/panels/Inspector"
import { ZoneInspector } from "../src/panels/ZonePanels"
import { projectApi } from "../src/store/projectStore"
import { uiApi } from "../src/store/uiStore"
import { rectangle, twoResistors, withZone } from "./zones-fixtures"

// The placement area in the editor, rendered: drawn as an outline with its target's name, its target and switch edited in the Inspector, and a part's
// component classes seen and edited in the Inspector.

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLElement
const mount = (ui: ReactElement) => act(() => root.render(ui))
const q = (label: string) => document.querySelector(`[aria-label="${label}"]`) as HTMLInputElement | HTMLSelectElement | null
const change = (el: HTMLSelectElement | null, value: string) =>
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!
    setter.call(el, value)
    el!.dispatchEvent(new Event("change", { bubbles: true }))
  })
const typeInto = (el: HTMLInputElement | HTMLSelectElement | null, value: string) =>
  act(() => {
    el!.focus()
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!
    setter.call(el, value)
    el!.dispatchEvent(new Event("input", { bubbles: true }))
    el!.blur()
  })

beforeEach(() => {
  host = document.createElement("div")
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  uiApi().clearSelection()
})

const open = () => {
  const p = withZone(twoResistors(), rectangle(-15, -10, -2, 8), { keepout: {}, layers: ["top", "bottom"] }, "a")
  const placed = { ...p, zones: p.zones.map((z) => ({ ...z, placement: { by: "class" as const, name: "Power" } })) }
  projectApi().open(placed)
  return placed
}
const zone = () => projectApi().project!.zones[0]

describe("the placement area", () => {
  it("is drawn with its target's name, in its own colour, and says so when it is off", () => {
    const p = open()
    mount(
      <svg>
        <ZoneOutlines project={p} selected={new Set()} px={1} active="top" />
      </svg>,
    )
    expect(document.body.textContent).toContain("class Power")
    expect(document.querySelector('path[stroke="#4aa8ff"]')).not.toBeNull()
    mount(
      <svg>
        <ZoneOutlines project={{ ...p, zones: [{ ...p.zones[0], placement: { by: "sheet", name: "/Power/", off: true } }] }} selected={new Set()} px={1} active="top" />
      </svg>,
    )
    expect(document.body.textContent).toContain("sheet /Power/ (off)")
    // a plain keepout is drawn as it was, with no label
    mount(
      <svg>
        <ZoneOutlines project={{ ...p, zones: [{ ...p.zones[0], placement: undefined }] }} selected={new Set()} px={1} active="top" />
      </svg>,
    )
    expect(document.body.textContent).not.toContain("class Power")
    expect(document.querySelector('path[stroke="#ff5470"]')).not.toBeNull()
  })

  it("is edited in the Inspector: its target kind and name, and whether the parts have to sit in it, each one change of the project", () => {
    const p = open()
    mount(<ZoneInspector project={p} zone={p.zones[0]} />)
    expect(document.body.textContent).toContain("Placement area")
    expect((q("Placement target kind") as HTMLSelectElement).value).toBe("class")
    expect((q("Placement target") as HTMLInputElement).value).toBe("Power")
    typeInto(q("Placement target"), "Analog")
    expect(zone().placement).toEqual({ by: "class", name: "Analog" })
    mount(<ZoneInspector project={projectApi().project!} zone={zone()} />)
    change(q("Placement target kind") as HTMLSelectElement, "sheet")
    expect(zone().placement).toEqual({ by: "sheet", name: "" })
    mount(<ZoneInspector project={projectApi().project!} zone={zone()} />)
    const on = [...document.querySelectorAll('[role="switch"]')].find((s) => s.getAttribute("aria-label") === "Parts have to sit in it") as HTMLElement
    act(() => on.click())
    expect(zone().placement).toEqual({ by: "sheet", name: "", off: true })
    projectApi().undo()
    expect(zone().placement).toEqual({ by: "sheet", name: "" })
    mount(<ZoneInspector project={projectApi().project!} zone={zone()} />)
    change(q("Placement target kind") as HTMLSelectElement, "none")
    expect(zone().placement).toBeUndefined()
    expect(zone().keepout).toEqual({})
  })

  it("is picked by its edge only, so the parts and the board's edge inside it stay in reach; a keepout is also picked by its inside", () => {
    const p = open()
    expect(zoneHit(p, { x: -8, y: 0 }, 0.5, "top", [])).toBeNull()
    expect(zoneHit(p, { x: -15, y: 0 }, 0.5, "top", [])).toBe("a")
    const k = { ...p, zones: [{ ...p.zones[0], placement: undefined }] }
    expect(zoneHit(k, { x: -8, y: 0 }, 0.5, "top", [])).toBe("a")
    // one that also keeps something out is picked inside, as any keepout
    const both = { ...p, zones: [{ ...p.zones[0], keepout: { tracks: true as const } }] }
    expect(zoneHit(both, { x: -8, y: 0 }, 0.5, "top", [])).toBe("a")
  })

  it("starts with the sheet of the selected part, else the first sheet with no area", () => {
    const p = open()
    expect(defaultPlacement(p, [])).toEqual({ by: "sheet", name: "/" })
    expect(defaultPlacement({ ...p, components: p.components.map((c, i) => (i ? c : { ...c, sheetPath: "/Power/" })) }, [p.components[0].id])).toEqual({ by: "sheet", name: "/Power/" })
  })
})

describe("component classes on a part", () => {
  it("are listed in the Inspector and edited there, each name once", () => {
    const p = open()
    projectApi().open({ ...p, components: p.components.map((c, i) => (i ? c : { ...c, classes: ["Power"] })) })
    uiApi().select([`c:${p.components[0].id}`])
    mount(<Inspector />)
    expect((q("Component classes") as HTMLInputElement).value).toBe("Power")
    typeInto(q("Component classes"), "Power, Fast,, Power")
    expect(projectApi().project!.components[0].classes).toEqual(["Power", "Fast"])
    typeInto(q("Component classes"), "")
    expect(projectApi().project!.components[0].classes).toBeUndefined()
    expect(parseClasses(" a, b ,a,")).toEqual(["a", "b"])
  })
})
