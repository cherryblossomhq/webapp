// @vitest-environment jsdom
import { act, type ReactElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { KicadImportController, ImportState } from "../src/kicadImport/controller"
import { KicadImportDialog } from "../src/kicadImport/KicadImportDialog"
import { ReportView } from "../src/kicadImport/ReportView"
import { keepReportFile, loadProjectReport, loadReport, saveReport } from "../src/kicadImport/reportStore"
import { ImportedNote } from "../src/kicadImport/ImportedNote"
import { markJustImported } from "../src/kicadImport/justImported"
import { connectModelFiles } from "../src/store/modelFiles"
import { useProjectStore } from "../src/store/projectStore"
import { createProject } from "../src/model/ops"
import { stoppedSummary, summarize, unsupportedLead, type ImportSummary } from "../src/kicadImport/summary"
import { KicadReportSection } from "../src/panels/ProjectInspector"
import { EXTENSION_NAMES, importKicadBoard } from "../src/model/kicad/board"
import { board, footprint, pad, REFUSED_BOARD } from "./kicad-board-fixtures"
import { stubLocalStorage } from "./kicad-import-helpers"

const download = vi.hoisted(() => vi.fn())
vi.mock("../src/export/bundle", async (orig) => ({ ...(await orig<typeof import("../src/export/bundle")>()), downloadText: download }))

// The editor's own screens, rendered for real: the report, the dialog's steps with their keyboard
// and focus behaviour, and the project panel's section that shows a kept report again.

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const ctx = { used: ["b.kicad_pcb"], notRead: [{ file: "x.kicad_pro", why: "the schematic import is coming" }], ignored: [], boardBytes: 1 }
const refused = summarize(importKicadBoard(REFUSED_BOARD), ctx)
const withParts = summarize(importKicadBoard(board({ body: [footprint({ pads: [pad({ at: "0 0" })] })] }), { built: new Set(Object.keys(EXTENSION_NAMES)) }), ctx)

let root: Root
let host: HTMLElement
const mount = (ui: ReactElement) => act(() => root.render(ui))
const q = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel)
const text = () => document.body.textContent ?? ""
const key = (k: string, init: KeyboardEventInit = {}, target: EventTarget = document.activeElement ?? document.body) => {
  const e = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init })
  act(() => void target.dispatchEvent(e))
  return e
}
const button = (name: RegExp | string) => [...document.querySelectorAll("button")].find((b) => (typeof name === "string" ? b.textContent?.trim() === name : name.test(b.textContent ?? "")))!

function fakeController() {
  return { choose: vi.fn(), cancel: vi.fn(), close: vi.fn(), retry: vi.fn() } as unknown as KicadImportController & Record<"choose" | "cancel" | "close" | "retry", ReturnType<typeof vi.fn>>
}

beforeEach(() => {
  stubLocalStorage()
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  download.mockClear()
})

describe("the report", () => {
  it("a refusal names each thing the board uses with what in the board needs it, under one counted lead", () => {
    mount(<ReportView summary={refused} name="my board" />)
    expect(q("h2")!.textContent).toBe("Not supported yet")
    // What it uses is whatever the importer has not built yet, read from its own result.
    expect(refused.missing.length).toBeGreaterThan(0)
    expect(text()).toContain(unsupportedLead(refused.missing.length))
    for (const m of refused.missing) expect(text()).toContain(`${m.name}: ${m.why}`)
    expect(text()).toContain("Nothing was imported")
  })

  it("is out of PostHog's click capture", () => {
    mount(<ReportView summary={refused} name="n" />)
    expect(q("h2")!.closest(".ph-no-capture")).not.toBeNull()
    expect(button(/Full report \(text\)/).closest(".ph-no-capture")).not.toBeNull()
  })

  it("downloads the text and the JSON report, named for the project", () => {
    mount(<ReportView summary={refused} name="My Board" />)
    act(() => button(/Full report \(text\)/).click())
    act(() => button(/Full report \(JSON\)/).click())
    expect(download.mock.calls.map((c) => c[1])).toEqual(["my-board-import-report.txt", "my-board-import-report.json"])
    expect(download.mock.calls[0][0]).toContain("Result: not imported.")
    expect(JSON.parse(download.mock.calls[1][0]).missing[0].why).toBeTruthy()
  })

  it("a failed save is titled Not saved with the reason in an alert straight under the title, before every section", () => {
    mount(<ReportView summary={withParts} name="n" saveError="Couldn't save the project. It may not have been saved: check your projects list, then try again." />)
    expect(q("h2")!.textContent).toBe("Not saved")
    const alert = q('[role="alert"]')!
    expect(alert.textContent).toContain("may not have been saved")
    expect(alert.textContent).toContain("Try again, or download the report")
    expect(q("h2")!.compareDocumentPosition(alert) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(alert.compareDocumentPosition(q("h3")!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(q("svg")!.getAttribute("class")).toContain("text-danger")
    expect(text()).not.toContain("Imported from KiCad")
  })

  it("a clean import is titled Imported from KiCad in the green tone", () => {
    mount(<ReportView summary={withParts} name="n" />)
    expect(q("h2")!.textContent).toBe("Imported from KiCad")
    expect(q("svg")!.getAttribute("class")).toContain("text-ok")
  })

  it("a long list says how many are hidden", () => {
    const s: ImportSummary = { ...withParts, notBrought: Array.from({ length: 40 }, (_, i) => ({ code: "x", object: `model ${i}`, why: "w" })) }
    mount(<ReportView summary={s} name="n" />)
    expect(text()).toContain("and 15 more, in the full report.")
  })
})

describe("the dialog", () => {
  const working: ImportState = { step: "working", phase: "building" }
  const choose: ImportState = { step: "choose", boards: [{ id: "a/a.kicad_pcb", path: "a/a.kicad_pcb", size: 2048, legacy: false }, { id: "b/b.kicad_pcb", path: "b/b.kicad_pcb", size: null, legacy: false }] }

  it("draws nothing when idle", () => {
    mount(<KicadImportDialog state={{ step: "idle" }} controller={fakeController()} onOpen={() => {}} />)
    expect(q('[role="dialog"]')).toBeNull()
  })

  it("a running import: focus moves to Cancel, which cancels; Escape and a click outside do not", () => {
    const c = fakeController()
    mount(<KicadImportDialog state={working} controller={c} onOpen={() => {}} />)
    expect(document.activeElement).toBe(button("Cancel"))
    expect(text()).toContain("Building the project and checking its size")
    const esc = key("Escape")
    expect(esc.defaultPrevented).toBe(true)
    act(() => void q('[role="dialog"]')!.parentElement!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })))
    expect(c.cancel).not.toHaveBeenCalled()
    expect(c.close).not.toHaveBeenCalled()
    act(() => button("Cancel").click())
    expect(c.cancel).toHaveBeenCalledOnce()
  })

  it("the Cancel button is off while saving", () => {
    mount(<KicadImportDialog state={{ step: "working", phase: "saving" }} controller={fakeController()} onOpen={() => {}} />)
    expect((button("Cancel") as HTMLButtonElement).disabled).toBe(true)
  })

  it("the chooser: focus on the first board, sizes only where known, in click capture's blind spot; a click chooses", () => {
    const c = fakeController()
    mount(<KicadImportDialog state={choose} controller={c} onOpen={() => {}} />)
    const first = button(/a\/a\.kicad_pcb/)
    expect(document.activeElement).toBe(first)
    expect(first.textContent).toContain("2 KB")
    expect(button(/b\/b\.kicad_pcb/).textContent).not.toContain("KB")
    expect(first.closest(".ph-no-capture")).not.toBeNull()
    act(() => button(/b\/b\.kicad_pcb/).click())
    expect(c.choose).toHaveBeenCalledWith("b/b.kicad_pcb")
  })

  it("the chooser closes on Escape and on a click outside", () => {
    const c = fakeController()
    mount(<KicadImportDialog state={choose} controller={c} onOpen={() => {}} />)
    key("Escape")
    act(() => void q('[role="dialog"]')!.parentElement!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })))
    expect(c.close).toHaveBeenCalledTimes(2)
  })

  it("a saved import opens the project at once, marked for the editor's one line, with no dialog left on this page", () => {
    const c = fakeController()
    const onOpen = vi.fn()
    mount(<KicadImportDialog state={{ step: "report", summary: withParts, projectId: "p9", name: "n", saveError: null }} controller={c} onOpen={onOpen} />)
    expect(q('[role="dialog"]')).toBeNull()
    expect(onOpen).toHaveBeenCalledExactlyOnceWith("p9")
    expect(sessionStorage.getItem("cherryblossom:editor:kicad-just-imported")).toBe("p9")
    mount(<KicadImportDialog state={{ step: "report", summary: withParts, projectId: "p9", name: "n", saveError: null }} controller={c} onOpen={onOpen} />)
    expect(onOpen).toHaveBeenCalledOnce()
  })

  it("a report of a failed save offers Try again, focused, and no Open", () => {
    const c = fakeController()
    mount(<KicadImportDialog state={{ step: "report", summary: withParts, projectId: null, name: "n", saveError: "Couldn't save the project." }} controller={c} onOpen={() => {}} />)
    expect(q("h2")!.textContent).toBe("Not saved")
    expect(document.activeElement).toBe(button("Try again"))
    expect(button("Open the project")).toBeUndefined()
    act(() => button("Try again").click())
    expect(c.retry).toHaveBeenCalledOnce()
  })

  it("a refusal's report closes with Close", () => {
    const c = fakeController()
    mount(<KicadImportDialog state={{ step: "report", summary: stoppedSummary("no-board", "No board."), projectId: null, name: "n", saveError: null }} controller={c} onOpen={() => {}} />)
    act(() => button("Close").click())
    expect(c.close).toHaveBeenCalled()
  })
})

describe("the keyboard", () => {
  it("Tab stays inside the dialog, in both directions", () => {
    mount(<KicadImportDialog state={{ step: "report", summary: refused, projectId: null, name: "n", saveError: null }} controller={fakeController()} onOpen={() => {}} />)
    const items = [...q('[role="dialog"]')!.querySelectorAll<HTMLElement>("button")]
    items[items.length - 1].focus()
    expect(key("Tab").defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(items[0])
    expect(key("Tab", { shiftKey: true }).defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(items[items.length - 1])
  })

  it("Tab from outside the dialog comes back into it", () => {
    const outside = document.createElement("button")
    document.body.append(outside)
    mount(<KicadImportDialog state={{ step: "working", phase: "reading" }} controller={fakeController()} onOpen={() => {}} />)
    outside.focus()
    key("Tab", {}, outside)
    expect(q('[role="dialog"]')!.contains(document.activeElement)).toBe(true)
    outside.remove()
  })

  it("keys do not reach the editor's shortcuts behind it, and Escape does not either", () => {
    const behind = vi.fn()
    window.addEventListener("keydown", behind)
    mount(<KicadImportDialog state={{ step: "working", phase: "reading" }} controller={fakeController()} onOpen={() => {}} />)
    key("k")
    key("Delete", {}, document.body)
    key("Escape")
    window.removeEventListener("keydown", behind)
    expect(behind).not.toHaveBeenCalled()
  })

  it("keys reach them again once the dialog is gone", () => {
    const behind = vi.fn()
    window.addEventListener("keydown", behind)
    mount(<KicadImportDialog state={{ step: "working", phase: "reading" }} controller={fakeController()} onOpen={() => {}} />)
    mount(<KicadImportDialog state={{ step: "idle" }} controller={fakeController()} onOpen={() => {}} />)
    key("k", {}, document.body)
    window.removeEventListener("keydown", behind)
    expect(behind).toHaveBeenCalledOnce()
  })

  it("focus goes back to where it was when the dialog closes, through the dialog's own steps", () => {
    const opener = document.createElement("button")
    document.body.append(opener)
    opener.focus()
    mount(<KicadImportDialog state={{ step: "working", phase: "reading" }} controller={fakeController()} onOpen={() => {}} />)
    expect(document.activeElement).not.toBe(opener)
    mount(<KicadImportDialog state={{ step: "report", summary: refused, projectId: null, name: "n", saveError: null }} controller={fakeController()} onOpen={() => {}} />)
    expect(q('[role="dialog"]')!.contains(document.activeElement)).toBe(true)
    mount(<KicadImportDialog state={{ step: "idle" }} controller={fakeController()} onOpen={() => {}} />)
    expect(document.activeElement).toBe(opener)
    opener.remove()
  })
})

describe("the project panel's report", () => {
  it("shows nothing for a project with no kept report", () => {
    mount(<KicadReportSection projectId="none" file={undefined} />)
    expect(host.textContent).toBe("")
  })

  it("shows a button for one with a report, which opens it and closes again, with the keyboard behaving the same", async () => {
    saveReport("p1", withParts, "Imported board")
    expect(loadReport("p1")).not.toBeNull()
    mount(<KicadReportSection projectId="p1" file={undefined} />)
    expect(host.textContent).toContain("KiCad import")
    // A real click focuses the button first; `click()` alone does not.
    act(() => button("View import report").focus())
    await act(async () => button("View import report").click())
    const dialog = q('[role="dialog"]')!
    expect(dialog.getAttribute("aria-label")).toBe("KiCad import report")
    expect(dialog.textContent).toContain("Imported from KiCad")
    key("Escape")
    expect(q('[role="dialog"]')).toBeNull()
    expect(document.activeElement).toBe(button("View import report"))
  })

  it("reads the report from the file the project names when this browser has none: another computer, or someone it is shared with", async () => {
    const files = new Map<string, ArrayBuffer>()
    connectModelFiles({
      put: async ({ bytes }) => {
        const id = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((b) => b.toString(16).padStart(2, "0")).join("")
        files.set(id, bytes)
        return id
      },
      get: async (id) => files.get(id) ?? null,
    })
    try {
      const file = await keepReportFile(withParts, "Imported board")
      expect(file).toMatch(/^[0-9a-f]{64}$/)
      expect(files.has(file!)).toBe(true)
      // no copy in this browser: the file is what is read
      stubLocalStorage()
      const report = await loadProjectReport("p2", file!)
      expect(report?.name).toBe("Imported board")
      expect(report?.summary.status).toBe("imported")
    } finally {
      connectModelFiles(null)
    }
  })
})

describe("the line a just-imported project opens with", () => {
  it("says it was imported once, links the report, and is not said again", async () => {
    saveReport("p3", withParts, "Imported board")
    useProjectStore.setState({ project: { ...createProject(), id: "p3" } })
    markJustImported("p3")
    mount(<ImportedNote />)
    expect(q('[role="status"]')!.textContent).toBe("Imported from KiCad. See the report")
    await act(async () => button("See the report").click())
    expect(q('[role="dialog"]')!.textContent).toContain("Imported from KiCad")
    act(() => button("Close").click())
    expect(q('[role="dialog"]')).toBeNull()
    expect(q('[role="status"]')).toBeNull()
    act(() => root.unmount())
    root = createRoot(host)
    mount(<ImportedNote />)
    expect(q('[role="status"]')).toBeNull()
  })

  it("says nothing for a project the import did not just make", () => {
    useProjectStore.setState({ project: { ...createProject(), id: "p4" } })
    markJustImported("p5")
    mount(<ImportedNote />)
    expect(q('[role="status"]')).toBeNull()
  })
})
