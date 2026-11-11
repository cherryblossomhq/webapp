import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { ShapeDraw } from "../src/editor/pcb/ShapeGraphics"
import { litTrack, selectedTrack } from "../src/editor/pcb/traceGraphics"
import { mountingHoles, mountingHoleSelectionId, selectedMountingHoles, M3_HOLES } from "../src/model/board"
import type { BoardShape } from "../src/model/types"
import { selectionIds } from "../src/store/uiStore"

// A track's width, and a drawing's, is what the board is made with, so selecting or lighting one draws it at its own size: the glow round it that
// selection used to be read as a wider track.

const D = "M 0 0 L 10 0"

/** The stroke widths of a piece of SVG markup. */
const strokeWidths = (html: string) => [...html.matchAll(/stroke-width="([\d.e-]+)"/g)].map((m) => Number(m[1]))

describe("a lit or selected track", () => {
  const widths = [0.1, 0.15, 0.25, 0.4, 1, 3]
  const zooms = [0.002, 0.02, 0.1, 0.5]

  it("is lit at exactly its own width", () => {
    for (const w of widths) for (const behind of [false, true]) expect(litTrack(D, w, behind).props.strokeWidth).toBe(w)
  })

  it("is selected at its own width, never wider, with its copper showing inside the edge", () => {
    for (const w of widths) {
      for (const px of zooms) {
        const front = selectedTrack(D, w, px, "#ff3b3b")
        const sizes = front.map((p) => Number(p.props.strokeWidth))
        expect(Math.max(...sizes), `${w} mm at ${px} mm a pixel`).toBe(w)
        // The copper inside the edge is at least three fifths of the track, however far out the view is.
        expect(Math.min(...sizes)).toBeGreaterThanOrEqual(w * 0.6 - 1e-9)
        expect(front.some((p) => p.props.stroke === "#ff3b3b")).toBe(true)
        // A track behind the front layer is lit alone, at its width, with none of its copper over the front layer's.
        const behind = selectedTrack(D, w, px, null)
        expect(behind.map((p) => p.props.strokeWidth)).toEqual([w])
      }
    }
  })
})

describe("a selected drawing", () => {
  const px = 0.05
  const shapes: BoardShape[] = [
    { type: "line", a: { x: 0, y: 0 }, b: { x: 10, y: 0 }, width: 0.15, layer: "F.SilkS" },
    { type: "line", a: { x: 0, y: 0 }, b: { x: 10, y: 0 }, width: 0.5, layer: "F.Cu" },
    { type: "rect", a: { x: 0, y: 0 }, b: { x: 4, y: 3 }, width: 0.2, layer: "F.Cu", fill: true },
    { type: "circle", c: { x: 0, y: 0 }, r: 2, width: 0.12, layer: "Edge.Cuts", dash: "dash" },
  ]

  it("is drawn no wider than it is", () => {
    for (const shape of shapes) {
      const plain = strokeWidths(renderToStaticMarkup(<ShapeDraw shape={shape} color="#45ecff" px={px} />))
      const picked = strokeWidths(renderToStaticMarkup(<ShapeDraw shape={shape} color="#45ecff" px={px} selected />))
      expect(Math.max(...picked), shape.type).toBe(Math.max(...plain))
    }
  })
})

describe("the corner mounting holes' selection", () => {
  const board = { x: 0, y: 0, width: 50, height: 40, cornerRadius: 0, thickness: 1.6, mountingHoles: M3_HOLES } as Parameters<typeof mountingHoles>[0]

  it("names each hole, and is read back from a selection", () => {
    const ids = mountingHoles(board).map((h) => mountingHoleSelectionId(h.id))
    expect(ids).toHaveLength(4)
    expect(selectedMountingHoles(["c:u1", ...ids, "v:v1"])).toEqual(mountingHoles(board).map((h) => h.id))
  })

  it("is not taken for a dimension, whose ids start with m too", () => {
    const sel = [mountingHoleSelectionId("mh-bl"), "m:dim1"]
    expect(selectionIds(sel, "m")).toEqual(["dim1"])
    expect(selectedMountingHoles(sel)).toEqual(["mh-bl"])
  })
})
