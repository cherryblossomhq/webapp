// @vitest-environment jsdom
import { act, type ReactElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { Inspector } from "../src/panels/Inspector"
import { ZoneInspector } from "../src/panels/ZonePanels"
import { projectApi } from "../src/store/projectStore"
import { uiApi } from "../src/store/uiStore"
import { zoneFacts } from "../src/panels/zoneInspector"
import { analyze, rectangle, twoResistors, withZone } from "./zones-fixtures"

// The zone panel, rendered for real: it shows a zone's settings and changing one is a change of the project, undoable; a rule area shows
// what it keeps out; the Inspector shows it for a selected zone and the delete button takes it away.

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLElement
const mount = (ui: ReactElement) => act(() => root.render(ui))
const q = (label: string) => document.querySelector(`[aria-label="${label}"]`) as HTMLInputElement | HTMLSelectElement | null
const button = (name: RegExp) => [...document.querySelectorAll("button")].find((b) => name.test(b.textContent ?? ""))
const change = (el: HTMLSelectElement | null, value: string) =>
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!
    setter.call(el, value)
    el!.dispatchEvent(new Event("change", { bubbles: true }))
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
  const p = withZone(twoResistors(), rectangle(-12, -8, 12, 4), { net: "GND", priority: 1 })
  const k = withZone(p, rectangle(-3, -7, 3, -4), { keepout: { tracks: true } }, "k")
  projectApi().open(k)
  return k
}
const zone = (id = "z1") => projectApi().project!.zones.find((z) => z.id === id)!

describe("the zone panel", () => {
  it("shows a pour's net, layers and settings, and a change to one changes the zone", () => {
    const p = open()
    mount(<ZoneInspector project={p} zone={p.zones[0]} />)
    expect((q("Zone net") as HTMLSelectElement).value).toBe("GND")
    expect((q("Priority") as HTMLInputElement).value).toBe("1")
    change(q("Pad connection") as HTMLSelectElement, "none")
    expect(zone().connect).toBe("none")
    change(q("Corner smoothing") as HTMLSelectElement, "fillet")
    expect(zone().smoothing).toEqual({ kind: "fillet", radius: 1 })
    change(q("Islands") as HTMLSelectElement, "never")
    expect(zone().islands).toBe("never")
    const before = projectApi().project!
    projectApi().undo()
    expect(projectApi().project).not.toBe(before)
    expect(zone().islands).toBeUndefined()
  })

  it("a rule area lists what it keeps out and has no net", () => {
    const p = open()
    mount(<ZoneInspector project={p} zone={p.zones[1]} />)
    expect(document.body.textContent).toContain("Keepout")
    expect(q("Zone net")).toBeNull()
    const vias = [...document.querySelectorAll('[role="switch"]')].find((s) => s.getAttribute("aria-label") === "Vias") as HTMLElement
    expect(vias.getAttribute("aria-checked")).toBe("false")
    act(() => vias.click())
    expect(zone("k").keepout).toEqual({ tracks: true, vias: true })
  })

  it("the Inspector shows the selected zone, and Delete takes it away, but not a locked one", () => {
    open()
    uiApi().select(["z:z1"])
    mount(<Inspector />)
    expect(q("Zone net")).not.toBeNull()
    act(() => button(/Delete zone/)!.click())
    expect(projectApi().project!.zones.map((z) => z.id)).toEqual(["k"])
    uiApi().select(["z:k"])
    projectApi().commit((p) => ({ ...p, zones: p.zones.map((z) => ({ ...z, locked: true as const })) }))
    mount(<Inspector />)
    expect((button(/Delete keepout/) as HTMLButtonElement).disabled).toBe(true)
  })

  it("says how much copper a pour has, and that a pour with nothing to fill has none", () => {
    const p = open()
    const facts = zoneFacts(p, p.zones[0], analyze(p).zoneFills)
    expect(facts.corners).toBe(4)
    expect(facts.area).toBeCloseTo(24 * 12, 6)
    expect(facts.empty).toBe(false)
    const away = withZone(twoResistors(), rectangle(100, 100, 110, 110), { net: "GND" })
    expect(zoneFacts(away, away.zones[0], analyze(away).zoneFills).empty).toBe(true)
  })
})
