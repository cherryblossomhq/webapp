// @vitest-environment jsdom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Dashboard } from "../src/pages/Dashboard"
import { stubLocalStorage, fakeStorage } from "./kicad-import-helpers"

// The editor's own dashboard (the development harness's home): what a drop and the new button do.

const actions = vi.hoisted(() => ({ importProjectFile: vi.fn(async () => "imported-id") }))
vi.mock("../src/store/projectActions", async (orig) => ({ ...(await orig<typeof import("../src/store/projectActions")>()), ...actions }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLElement
beforeEach(() => {
  stubLocalStorage()
  vi.stubGlobal("IntersectionObserver", class { observe() {} disconnect() {} })
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

const drop = (files: File[]) => {
  const e = new Event("drop", { bubbles: true, cancelable: true })
  Object.defineProperty(e, "dataTransfer", { value: { types: ["Files"], files, items: files.map(() => ({ kind: "file", webkitGetAsEntry: () => null })) } })
  act(() => void host.querySelector("[data-scroll-root]")!.dispatchEvent(e))
}

describe("the editor's dashboard", () => {
  it("has Import KiCad beside Import, and a picker that takes KiCad's files", () => {
    act(() => root.render(<Dashboard storage={fakeStorage().storage} />))
    const names = [...host.querySelectorAll("button")].map((b) => b.textContent?.trim())
    expect(names).toEqual(expect.arrayContaining(["Import", "Import KiCad"]))
    const input = host.querySelector<HTMLInputElement>('input[aria-label="KiCad files"]')!
    expect(input.multiple).toBe(true)
    expect(input.accept).toContain(".kicad_pcb")
    expect(input.accept).toContain(".zip")
  })

  it("a dropped .json goes to the project file import, as before", () => {
    act(() => root.render(<Dashboard storage={fakeStorage().storage} />))
    const json = new File(["{}"], "project.json")
    drop([json])
    expect(actions.importProjectFile).toHaveBeenCalledWith(expect.anything(), json)
  })

  it("two dropped .json files still go to the project file import", () => {
    act(() => root.render(<Dashboard storage={fakeStorage().storage} />))
    const a = new File(["{}"], "a.json")
    drop([a, new File(["{}"], "b.json")])
    expect(actions.importProjectFile).toHaveBeenCalledWith(expect.anything(), a)
  })

  it("a dropped board goes to the KiCad import: its progress shows, not the project file import", () => {
    act(() => root.render(<Dashboard storage={fakeStorage().storage} />))
    drop([new File(["x"], "board.kicad_pcb")])
    expect(actions.importProjectFile).not.toHaveBeenCalled()
    expect(document.querySelector('[role="dialog"]')?.getAttribute("aria-label")).toBe("Importing from KiCad")
  })

  it("a drop with a .json among KiCad files is KiCad's", () => {
    act(() => root.render(<Dashboard storage={fakeStorage().storage} />))
    drop([new File(["{}"], "a.json"), new File(["x"], "b.kicad_pcb")])
    expect(actions.importProjectFile).not.toHaveBeenCalled()
    expect(document.querySelector('[role="dialog"]')).not.toBeNull()
  })
})
