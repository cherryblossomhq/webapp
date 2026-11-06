import { describe, expect, it } from "vitest"
import { computeConnectivity } from "../src/model/connectivity"
import { createProject } from "../src/model/ops"
import { analyzePcb, type CopperItem } from "../src/model/pcb"
import { dragSegment, dragVertex, planSegmentDrag, planVertexDrag, snapSegmentMove } from "../src/model/traceDrag"
import type { Project, Trace, Vec2 } from "../src/model/types"

// Dragging a segment of a track as Altium does: it moves square to itself, its neighbours stretch along their own lines, a jog joins it to what
// holds an end (a pad, a via, a junction), and the tracks that meet it stay on it.

const P = (x: number, y: number): Vec2 => ({ x, y })
const tr = (id: string, points: [number, number][], extra: Partial<Trace> = {}): Trace => ({ id, layer: "top", width: 0.25, points: points.map(([x, y]) => P(x, y)), ...extra })
const board = (...traces: Trace[]): Project => ({ ...createProject("drag"), traces })
const via = (x: number, y: number, diameter = 0.6): CopperItem => ({
  kind: "via",
  id: `via:${x},${y}`,
  viaId: `${x},${y}`,
  at: P(x, y),
  diameter,
  layers: ["top", "bottom"],
  box: { minX: x - diameter / 2, minY: y - diameter / 2, maxX: x + diameter / 2, maxY: y + diameter / 2 },
})
const pad = (x: number, y: number, size = 1.5): CopperItem => ({
  kind: "pad",
  id: `pad:${x},${y}`,
  pad: { componentId: "c", pin: "1", padNumber: "1", shape: "rect", x, y, width: size, height: size, layers: ["top"] },
  netId: null,
  layers: ["top"],
  box: { minX: x - size / 2, minY: y - size / 2, maxX: x + size / 2, maxY: y + size / 2 },
})

function drag(p: Project, id: string, index: number, delta: Vec2, items: CopperItem[] = []): Project {
  const plan = planSegmentDrag(p, id, index, items)
  expect(plan).not.toBeNull()
  return dragSegment(p, plan!, delta)
}
const pts = (p: Project, id: string) => p.traces.find((t) => t.id === id)?.points.map((q) => [q.x, q.y])

describe("dragging a segment", () => {
  it("stretches the 45° bends either side, keeping their angles", () => {
    const p = board(tr("t", [[0, 0], [2, 2], [8, 2], [10, 0]]))
    expect(pts(drag(p, "t", 1, P(0, -1)), "t")).toEqual([[0, 0], [1, 1], [9, 1], [10, 0]])
    expect(pts(drag(p, "t", 1, P(0, 1)), "t")).toEqual([[0, 0], [3, 3], [7, 3], [10, 0]])
  })

  it("counts only the part of the pointer's move square to the segment", () => {
    const p = board(tr("t", [[0, 0], [2, 2], [8, 2], [10, 0]]))
    expect(pts(drag(p, "t", 1, P(5, -1)), "t")).toEqual([[0, 0], [1, 1], [9, 1], [10, 0]])
    expect(drag(p, "t", 1, P(3, 0))).toBe(p)
  })

  it("pulls a bump flat, and on through turns it the other way round with 45° jogs", () => {
    const p = board(tr("t", [[0, 0], [2, 2], [8, 2], [10, 0]]))
    expect(pts(drag(p, "t", 1, P(0, -2)), "t")).toEqual([[0, 0], [10, 0]])
    expect(pts(drag(p, "t", 1, P(0, -3)), "t")).toEqual([[0, 0], [1, -1], [9, -1], [10, 0]])
  })

  it("carries an end on past a short stub the grid left, along the segment before it", () => {
    const p = board(tr("t", [[0, 0], [2, 2], [8, 2], [8, 1.75], [9.75, 0]]))
    expect(pts(drag(p, "t", 1, P(0, -1)), "t")).toEqual([[0, 0], [1, 1], [8.75, 1], [9.75, 0]])
    // Across the next track too, when the first one carries on into it.
    const q = board(tr("a", [[0, 0], [2, 2], [8, 2]]), tr("b", [[8, 2], [8, 1.75], [9.75, 0]]))
    const out = drag(q, "a", 1, P(0, -1))
    expect(pts(out, "a")).toEqual([[0, 0], [1, 1], [8.75, 1]])
    expect(pts(out, "b")).toEqual([[8.75, 1], [9.75, 0]])
  })

  it("stops at a corner where something else meets the track, and jogs from it", () => {
    // A via on the corner past the stub: the end may not pass it.
    const p = board(tr("t", [[0, 0], [2, 2], [8, 2], [8, 1.5], [9.5, 0]]))
    expect(pts(drag(p, "t", 1, P(0, -1), [via(8, 1.5, 0.3)]), "t")).toEqual([[0, 0], [1, 1], [7.5, 1], [8, 1.5], [9.5, 0]])
    // A segment in line past a collapsed one: the corner before it stays.
    const q = board(tr("t", [[-5, 0], [0, 0], [2, 2], [8, 2], [10, 0]]))
    expect(pts(drag(q, "t", 2, P(0, -3)), "t")).toEqual([[-5, 0], [0, 0], [1, -1], [9, -1], [10, 0]])
  })

  it("moves a diagonal segment between two straight ones", () => {
    const p = board(tr("t", [[0, 0], [2, 0], [5, 3], [7, 3]]))
    expect(pts(drag(p, "t", 1, P(1, 0)), "t")).toEqual([[0, 0], [3, 0], [6, 3], [7, 3]])
  })

  it("puts a 45° jog in where a via holds an end, and moves an end nothing joins", () => {
    const p = board(tr("t", [[0, 0], [10, 0]]))
    const out = drag(p, "t", 0, P(0, 2), [via(0, 0)])
    expect(pts(out, "t")).toEqual([[0, 0], [2, 2], [10, 2]])
  })

  it("joins a track between two pads to both by jogs: a dog-leg", () => {
    const p = board(tr("t", [[0, 0], [10, 0]]))
    expect(pts(drag(p, "t", 0, P(0, -1), [pad(0, 0), pad(10, 0)]), "t")).toEqual([[0, 0], [1, -1], [9, -1], [10, 0]])
  })

  it("makes the jogs square when two 45° ones would cross", () => {
    const p = board(tr("t", [[0, 0], [3, 0]]))
    expect(pts(drag(p, "t", 0, P(0, 2), [pad(0, 0), pad(3, 0)]), "t")).toEqual([[0, 0], [0, 2], [3, 2], [3, 0]])
  })

  it("stops a segment where pulling it further would turn it round", () => {
    const p = board(tr("t", [[0, 0], [3, 3], [4, 3], [7, 0]]))
    const out = pts(drag(p, "t", 1, P(0, 2)), "t")!
    expect(out).toHaveLength(4)
    const [, a, b] = out
    expect(b[0] - a[0]).toBeGreaterThan(0)
    expect(b[0] - a[0]).toBeLessThan(0.01)
    expect(a[1]).toBeCloseTo(3.5, 2)
  })

  it("slides the end of another track that carries on from an end, and locks neither", () => {
    const p = board(tr("a", [[0, 0], [5, 0]]), tr("b", [[5, 0], [5, 5]]), tr("far", [[20, 20], [30, 20]]))
    const out = drag(p, "a", 0, P(0, 1))
    expect(pts(out, "a")).toEqual([[0, 1], [5, 1]])
    expect(pts(out, "b")).toEqual([[5, 1], [5, 5]])
    expect(out.traces.find((t) => t.id === "a")!.locked).toBeUndefined()
    expect(out.traces.find((t) => t.id === "b")!.locked).toBeUndefined()
    // A locked track stays locked.
    const held = board(tr("a", [[0, 0], [5, 0]], { locked: true }))
    expect(drag(held, "a", 0, P(0, 1)).traces[0].locked).toBe(true)
    // A track the drag does not touch is the same object.
    expect(out.traces.find((t) => t.id === "far")).toBe(p.traces.find((t) => t.id === "far"))
  })

  it("holds an end where several tracks meet, or one carries on in line", () => {
    const junction = board(tr("a", [[0, 0], [5, 0]]), tr("b", [[5, 0], [5, 5]]), tr("c", [[5, 0], [5, -5]]))
    expect(pts(drag(junction, "a", 0, P(0, 1)), "a")).toEqual([[0, 1], [4, 1], [5, 0]])
    expect(pts(drag(junction, "a", 0, P(0, 1)), "b")).toEqual([[5, 0], [5, 5]])
    const inLine = board(tr("a", [[0, 0], [5, 0]]), tr("b", [[5, 0], [10, 0]]))
    expect(pts(drag(inLine, "a", 0, P(0, 1)), "a")).toEqual([[0, 1], [4, 1], [5, 0]])
    expect(pts(drag(inLine, "a", 0, P(0, 1)), "b")).toEqual([[5, 0], [10, 0]])
  })

  it("keeps a track that ends on the middle of the segment on it, at its own angle", () => {
    const square = board(tr("a", [[0, 0], [10, 0]]), tr("b", [[5, 0], [5, -5]]))
    expect(pts(drag(square, "a", 0, P(0, 1)), "b")).toEqual([[5, 1], [5, -5]])
    const slanted = board(tr("a", [[0, 0], [10, 0]]), tr("b", [[5, 0], [8, -3]]))
    expect(pts(drag(slanted, "a", 0, P(0, 1)), "b")).toEqual([[4, 1], [8, -3]])
  })

  it("leaves arc tracks and segments that are not there alone", () => {
    const p = board(tr("arc", [[0, 0], [1, 1], [2, 0]], { arc: true }), tr("t", [[0, 0], [1, 0]]))
    expect(planSegmentDrag(p, "arc", 0, [])).toBeNull()
    expect(planSegmentDrag(p, "t", 1, [])).toBeNull()
    expect(planSegmentDrag(p, "nope", 0, [])).toBeNull()
  })

  it("keeps the track on its pads on a real board, through the board's own copper items", () => {
    let p = createProject("pads")
    p = {
      ...p,
      vias: [{ id: "v1", x: 0, y: 0, diameter: 0.6, drill: 0.3 }],
      traces: [tr("t", [[0, 0], [6, 0], [8, 2]])],
    }
    const items = analyzePcb(p, computeConnectivity(p)).items
    const out = drag(p, "t", 0, P(0, 1), items)
    expect(pts(out, "t")).toEqual([[0, 0], [1, 1], [7, 1], [8, 2]])
  })
})

describe("dragging a corner", () => {
  it("moves the corner and the ends of the tracks there", () => {
    const p = board(tr("a", [[0, 0], [5, 0]]), tr("b", [[5, 0], [5, 5]]))
    const plan = planVertexDrag(p, "a", 1)!
    const out = dragVertex(p, plan, P(6, 1))
    expect(pts(out, "a")).toEqual([[0, 0], [6, 1]])
    expect(pts(out, "b")).toEqual([[6, 1], [5, 5]])
    expect(dragVertex(p, plan, P(5, 0))).toBe(p)
  })

  it("drops a corner pulled into line with its neighbours", () => {
    const p = board(tr("t", [[0, 0], [5, 2], [10, 0]]))
    expect(pts(dragVertex(p, planVertexDrag(p, "t", 1)!, P(5, 0)), "t")).toEqual([[0, 0], [10, 0]])
  })
})

describe("snapping the drag", () => {
  it("puts a straight or 45° segment's line on the grid, and moves another by whole steps", () => {
    const p = board(tr("h", [[0, 0.1], [10, 0.1]]), tr("d", [[0, 0], [5, 5]]), tr("s", [[0, 0], [10, 5]]))
    const h = planSegmentDrag(p, "h", 0, [])!
    expect(snapSegmentMove(h, P(3, 0.3), 0.25).y).toBeCloseTo(0.4)
    expect(snapSegmentMove(h, P(3, 0.3), 0.25).x).toBeCloseTo(0)
    // A 45° line through grid points: its corners with straight neighbours land on the grid.
    const d = planSegmentDrag(p, "d", 0, [])!
    const m = snapSegmentMove(d, P(0.3, 0), 0.25)
    expect(m.x).toBeCloseTo(0.125)
    expect(m.y).toBeCloseTo(-0.125)
    const s = planSegmentDrag(p, "s", 0, [])!
    expect(Math.hypot(snapSegmentMove(s, P(0, 0.6), 0.25).x, snapSegmentMove(s, P(0, 0.6), 0.25).y)).toBeCloseTo(0.5)
  })
})
