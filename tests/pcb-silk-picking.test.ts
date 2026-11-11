import { beforeEach, describe, expect, it } from "vitest"
import { hitTest } from "../src/editor/pcb/PcbEditor"
import { computeConnectivity } from "../src/model/connectivity"
import { pcbSilk } from "../src/model/instances"
import { analyzePcb, type CopperItem } from "../src/model/pcb"
import { getDesignators } from "../src/model/silk"
import type { ComponentInstance, Project, Trace, Vec2 } from "../src/model/types"
import { useUi } from "../src/store/uiStore"
import { built } from "./built"

// The silkscreen is drawn over the copper, so a click on a part's silkscreen picks the part, as it is seen, even with a track under it: the track
// used to win, and a part whose outline or designator lay over a track could not be picked there.

/** A click's reach on the board, in mm (`tol` in the PCB view is a few pixels' worth). */
const TOL = 0.1

const project = built("esp32-robot")
const items: CopperItem[] = analyzePcb(project, computeConnectivity(project)).items

/** A track across a point, square to `dir`, on the top layer. */
const across = (at: Vec2, dir: Vec2, id = "t-across"): Trace => {
  const len = Math.hypot(dir.x, dir.y)
  const n = { x: -dir.y / len, y: dir.x / len }
  return { id, layer: "top", width: 0.25, points: [{ x: at.x - 2 * n.x, y: at.y - 2 * n.y }, { x: at.x + 2 * n.x, y: at.y + 2 * n.y }] }
}

const withTrace = (t: Trace): Project => ({ ...project, traces: [...project.traces, t] })

/** A top part, and the middle of a line of its outline that picks the part on the bare board (no pad or other copper there). */
function silkSpot(): { c: ComponentInstance; at: Vec2; dir: Vec2 } {
  for (const c of project.components) {
    if (!c.pcb.placed || c.pcb.side !== "top") continue
    for (const path of pcbSilk(c)) {
      for (let i = 0; i < path.length - 1; i++) {
        const a = path[i]
        const b = path[i + 1]
        if (Math.hypot(b.x - a.x, b.y - a.y) < 1) continue
        const at = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
        const h = hitTest(project, at, TOL, "top", items)
        if (h?.type === "component" && h.id === c.id) return { c, at, dir: { x: b.x - a.x, y: b.y - a.y } }
      }
    }
  }
  throw new Error("no top part with an outline clear of copper")
}

beforeEach(() => {
  useUi.setState({ layers: { ...useUi.getState().layers, top: true, bottom: true, silk: true }, hiddenCopper: {} })
})

describe("picking a part's silkscreen over a track", () => {
  const { c, at, dir } = silkSpot()
  const p = withTrace(across(at, dir))

  it("picks the part where its outline crosses the track", () => {
    expect(hitTest(p, at, TOL, "top", items)).toEqual({ type: "component", id: c.id })
  })

  it("still picks the track beside the outline", () => {
    const len = Math.hypot(dir.x, dir.y)
    const n = { x: -dir.y / len, y: dir.x / len }
    // Along the track, clear of the silkscreen line, on whichever side of it is not a pad.
    const hits = [1, -1].map((s) => hitTest(p, { x: at.x + s * 0.6 * n.x, y: at.y + s * 0.6 * n.y }, TOL, "top", items))
    expect(hits.some((h) => h?.type === "trace" && h.id === "t-across")).toBe(true)
  })

  it("leaves the track to a tool snapping to copper", () => {
    expect(hitTest(p, at, TOL, "top", items, [], { copper: true })).toMatchObject({ type: "trace", id: "t-across" })
  })

  it("leaves the track when the bottom is in front, or the silkscreen is hidden", () => {
    expect(hitTest(p, at, TOL, "bottom", items)).toMatchObject({ type: "trace", id: "t-across" })
    useUi.setState({ layers: { ...useUi.getState().layers, silk: false } })
    expect(hitTest(p, at, TOL, "top", items)).toMatchObject({ type: "trace", id: "t-across" })
  })
})

describe("picking a part's designator", () => {
  const designators = getDesignators(project)
  const top = project.components.find((c) => c.pcb.placed && c.pcb.side === "top" && designators.has(c.id))!
  const box = designators.get(top.id)!.box
  const mid = { x: (box.minX + box.maxX) / 2, y: (box.minY + box.maxY) / 2 }

  it("picks its part, with a track under it or without", () => {
    expect(hitTest(project, mid, TOL, "top", items)).toEqual({ type: "component", id: top.id })
    expect(hitTest(withTrace(across(mid, { x: 1, y: 0 })), mid, TOL, "top", items)).toEqual({ type: "component", id: top.id })
  })
})
