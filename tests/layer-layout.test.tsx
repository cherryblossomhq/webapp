// @vitest-environment jsdom
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { act } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, describe, expect, it } from "vitest"
import { CopperLayerList } from "../src/panels/CopperLayerList"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// A layer row is one line: "Layer 1" never breaks onto two lines, and a long name is cut with an ellipsis instead of pushing the menu wider.
// jsdom does no layout, so this checks the classes that make a row one line, on every row of a 32 layer board.

describe("the copper layer list layout", () => {
  afterEach(() => {
    document.body.innerHTML = ""
  })
  const render = (pick: boolean) => {
    const host = document.createElement("div")
    document.body.appendChild(host)
    const root = createRoot(host)
    const copper = Array.from({ length: 32 }, (_, i) => (i % 5 === 3 ? { label: `Very long custom layer name number ${i} for power distribution` } : {}))
    act(() => root.render(<CopperLayerList board={{ stack: { copper } } as never} pick={pick} />))
    return { host, root }
  }

  for (const pick of [false, true]) {
    it(`keeps all 32 rows on one line (${pick ? "picker" : "list"})`, () => {
      const { host, root } = render(pick)
      const rows = [...host.querySelectorAll("li")]
      expect(rows).toHaveLength(32)
      for (const li of rows) {
        expect(li.className).toContain("whitespace-nowrap")
        expect(li.className).toContain("min-w-0")
        const label = li.querySelector<HTMLElement>(pick ? "button.truncate" : "span.truncate")!
        expect(label.className).toContain("whitespace-nowrap")
        expect(label.className).toContain("truncate")
        expect(label.className).toContain("min-w-0")
        expect(li.querySelector("[data-layer-swatch]")!.className).toContain("shrink-0")
        expect(li.querySelector("button[aria-pressed]")!.className).toContain("shrink-0")
      }
      const long = rows.filter((li) => li.textContent!.includes("Very long"))
      expect(long.length).toBeGreaterThan(5)
      if (!pick) for (const li of long) expect(li.querySelector("span.truncate")!.getAttribute("title")).toContain("Very long")
      const list = host.querySelector("ul")!
      expect(list.className).toMatch(/max-h-/)
      expect(list.className).toContain("overflow-y-auto")
      expect(list.className).toContain("overflow-x-hidden")
      act(() => root.unmount())
    })
  }

  it("has the same one-line rules in the toolbar picker, the Inspector rows and the stackup tables", () => {
    const src = (f: string) => readFileSync(join(__dirname, "../src", f), "utf8")
    expect(src("panels/CanvasToolbar.tsx")).toMatch(/max-w-\[160px\][^"]*whitespace-nowrap/)
    expect(src("panels/CanvasToolbar.tsx")).toContain("max-h-[70vh]")
    expect(src("ui/controls.tsx")).toContain("whitespace-nowrap")
    expect(src("panels/LayersSection.tsx")).toMatch(/<li key=\{l\} className="[^"]*whitespace-nowrap/)
    expect(src("panels/LayersSection.tsx")).toContain("table-fixed")
    expect(src("panels/ProjectInspector.tsx")).toContain("table-fixed")
  })
})
