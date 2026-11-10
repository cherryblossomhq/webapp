// @vitest-environment jsdom
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { act } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, describe, expect, it } from "vitest"
import { shapeLayerColor } from "../src/editor/pcb/ShapeGraphics"
import { copperColor, copperLook, COLOURED_INNER_LAYERS, otherSideOpacity, PCB, pourColor } from "../src/editor/theme"
import { kicadLayerName } from "../src/model/stack"
import type { CopperLayer } from "../src/model/types"
import { CopperLayerList } from "../src/panels/CopperLayerList"
import { DEFAULT_SETTINGS, loadSettings, OTHER_LAYERS } from "../src/store/settings"
import { cycleOtherLayers, uiApi, useUi } from "../src/store/uiStore"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// Every copper layer, up to the 32 a board can have, has a colour of its own, and every place that draws or lists a layer asks the same function for it.

const lab = (hex: string): [number, number, number] => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116)
  const x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b
  const z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))]
}
const deltaE = (a: string, b: string) => Math.hypot(...lab(a).map((v, i) => v - lab(b)[i]) as [number, number, number])

/** The ids of a board of `count` layers, front to back. */
const stack = (count: number): CopperLayer[] => Array.from({ length: count }, (_, i) => (i === 0 ? "top" : i === count - 1 ? "bottom" : (`in${i}` as CopperLayer)))

describe("copper layer colours", () => {
  const all = stack(32)

  it("gives layers in1 to in30 colours that are all different", () => {
    expect(COLOURED_INNER_LAYERS).toBeGreaterThanOrEqual(30)
    const inner = all.slice(1, -1)
    expect(inner).toHaveLength(30)
    expect(new Set(inner.map(copperColor)).size).toBe(30)
    expect(new Set(inner.map(pourColor)).size).toBe(30)
    expect(new Set(all.map(copperColor)).size).toBe(32)
  })

  it("keeps any two of the 32 layers clearly apart, and neighbours in the stack further", () => {
    let nearest = Infinity
    for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) nearest = Math.min(nearest, deltaE(copperColor(all[i]), copperColor(all[j])))
    expect(nearest).toBeGreaterThan(20)
    for (let i = 1; i < all.length; i++) expect(deltaE(copperColor(all[i - 1]), copperColor(all[i])), `${all[i - 1]} and ${all[i]}`).toBeGreaterThan(30)
  })

  it("keeps the pours apart too, and each darker than its layer's copper", () => {
    for (const l of all) {
      const light = (h: string) => lab(h)[0]
      expect(light(pourColor(l)), l).toBeLessThan(light(copperColor(l)))
    }
    let nearest = Infinity
    for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) nearest = Math.min(nearest, deltaE(pourColor(all[i]), pourColor(all[j])))
    expect(nearest).toBeGreaterThan(10)
  })

  it("is how drawings on copper layers are coloured, KiCad's names included", () => {
    for (const l of all) expect(shapeLayerColor(kicadLayerName(l)), l).toBe(copperColor(l))
  })

  it("is the one function the places that draw or list a layer use, and none keeps a copper colour of its own", () => {
    const src = (f: string) => readFileSync(join(__dirname, "../src", f), "utf8")
    for (const f of ["editor/pcb/PcbEditor.tsx", "editor/pcb/ZoneDraw.tsx", "editor/pcb/ShapeGraphics.tsx", "panels/CanvasToolbar.tsx", "panels/LayersSection.tsx", "panels/CopperLayerList.tsx", "ai/vision/pcbSvg.ts"]) {
      expect(src(f), f).toMatch(/\bcopperColor\b/)
      expect(src(f), f).not.toMatch(/PCB\.(top|bottom)Copper|INNER_COPPER/)
    }
    // the pours, wherever they are drawn: Sakura's picture in the pour colour, the board view in the look of the layer (`copperLook`, made from `copperColor`)
    expect(src("ai/vision/pcbSvg.ts")).toMatch(/\bpourColor\b/)
    expect(src("editor/pcb/PcbEditor.tsx")).toMatch(/\bcopperLook\b/)
  })
})

describe("the layers drawn against each other", () => {
  const all = stack(32)
  /** A colour laid over the board's black at an opacity. */
  const over = (hex: string, a: number) => `#${[1, 3, 5].map((i) => Math.round(parseInt(hex.slice(i, i + 2), 16) * a + parseInt(PCB.board.slice(i, i + 2), 16) * (1 - a)).toString(16).padStart(2, "0")).join("")}`
  const light = (h: string) => lab(h)[0]
  const chroma = (h: string) => Math.hypot(lab(h)[1], lab(h)[2])

  it("draws the layer worked on in its own colour, its tracks and pads plain on its pour", () => {
    for (const l of all) {
      for (const others of OTHER_LAYERS) {
        const front = copperLook(l, true, others)
        expect(front.track, l).toBe(copperColor(l))
        expect(front.pad).toBe(PCB.pad)
        // a track on its own pour (the front pour is a little see-through, here over the bare board) is told from it at a glance
        expect(deltaE(front.track, over(front.pour, front.pourOpacity)), l).toBeGreaterThan(30)
        expect(front.pourOpacity).toBeLessThan(1)
      }
    }
  })

  it("draws the other layers softer, dimmed nearly to grey, and their pours so dark that the gaps round a track read as the bare board", () => {
    for (const l of all) {
      const front = copperLook(l, true, "show")
      const shown = copperLook(l, false, "show")
      const dimmed = copperLook(l, false, "dim")
      expect(light(shown.track), l).toBeLessThan(light(front.track))
      expect(light(dimmed.track), l).toBeLessThan(light(shown.track))
      expect(chroma(dimmed.track), l).toBeLessThan(chroma(shown.track))
      for (const look of [shown, dimmed]) {
        expect(light(look.pour), l).toBeLessThan(light(look.track))
        expect(look.pourOpacity).toBe(1)
      }
      // A pour behind the front layer is what its clearance gaps show: it used to be the other layer's bright pour, a ring of its colour round every track.
      expect(light(shown.pour), l).toBeLessThan(20)
      expect(light(dimmed.pour), l).toBeLessThan(light(shown.pour))
    }
  })

  it("draws the other side's silkscreen and parts fainter as the other layers dim, and not at all when they are hidden", () => {
    expect(otherSideOpacity("show")).toBeGreaterThan(otherSideOpacity("dim"))
    expect(otherSideOpacity("dim")).toBeGreaterThan(0)
    expect(otherSideOpacity("hide")).toBe(0)
  })
})

describe("how the other layers and the pours are drawn, as a setting", () => {
  afterEach(() => {
    localStorage.clear()
    useUi.setState({ settings: { ...DEFAULT_SETTINGS } })
  })

  it("starts with every layer shown and the pours filled", () => {
    localStorage.clear()
    expect(loadSettings()).toMatchObject({ otherLayers: "show", pours: "filled" })
  })

  it("goes from shown to dimmed to hidden and back with each ⇧S, kept for the next visit", () => {
    useUi.setState({ settings: { ...DEFAULT_SETTINGS } })
    const seen: string[] = []
    for (let i = 0; i < 4; i++) {
      cycleOtherLayers()
      seen.push(uiApi().settings.otherLayers)
    }
    expect(seen).toEqual(["dim", "hide", "show", "dim"])
    expect(loadSettings().otherLayers).toBe("dim")
    uiApi().updateSettings({ pours: "outline" })
    expect(loadSettings().pours).toBe("outline")
  })

  it("reads a value it does not know as the default", () => {
    localStorage.setItem("cherryblossom:editor:settings", JSON.stringify({ otherLayers: "solo", pours: 3 }))
    expect(loadSettings()).toMatchObject({ otherLayers: "show", pours: "filled" })
  })
})

describe("the copper layer list", () => {
  afterEach(() => {
    document.body.innerHTML = ""
    uiApi().setActiveLayer("top")
    useUi.setState({ hiddenCopper: {} })
  })

  it("shows every layer of a 12 layer board with its own colour, hides one with its eye, and picks the layer to work on", () => {
    const host = document.createElement("div")
    document.body.appendChild(host)
    const root = createRoot(host)
    const board = { stack: { copper: Array.from({ length: 12 }, () => ({})) } } as never
    let picked: CopperLayer | null = null
    act(() => root.render(<CopperLayerList board={board} pick onPicked={(l) => (picked = l)} />))
    const swatches = [...host.querySelectorAll<HTMLElement>("[data-layer-swatch]")]
    expect(swatches).toHaveLength(12)
    expect(new Set(swatches.map((s) => s.style.background)).size).toBe(12)
    swatches.forEach((s, i) => expect(s.dataset.layerSwatch).toBe(stack(12)[i]))
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="Hide Inner 5 copper"]')!.click())
    expect(useUi.getState().hiddenCopper.in5).toBe(true)
    expect(host.querySelector('[aria-label="Show Inner 5 copper"]')).not.toBeNull()
    act(() => host.querySelector<HTMLButtonElement>('button[title="Work on Inner 7 copper"]')!.click())
    expect(useUi.getState().activeLayer).toBe("in7")
    expect(picked).toBe("in7")
    act(() => root.unmount())
  })
})
