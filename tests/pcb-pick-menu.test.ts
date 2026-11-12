import { beforeEach, describe, expect, it } from "vitest"
import { hitsUnder, hitTest } from "../src/editor/pcb/PcbEditor"
import { pickRows } from "../src/editor/pcb/PickMenu"
import { computeConnectivity } from "../src/model/connectivity"
import { pcbCourtyard } from "../src/model/instances"
import { analyzePcb } from "../src/model/pcb"
import type { ComponentInstance, Project, Vec2 } from "../src/model/types"
import { useUi } from "../src/store/uiStore"
import { built } from "./built"
import { rectangle, withZone } from "./zones-fixtures"

// A double click where several things are under the pointer lists them, as Altium does, the one a click picks first: a track or a via inside a
// part's body was the only thing a double click there could open, and the part could not be opened from it.

const TOL = 0.1
const project = built("esp32-robot")

const analysis = (p: Project) => analyzePcb(p, computeConnectivity(p))
const under = (p: Project, at: Vec2) => hitsUnder(p, at, TOL, "top", analysis(p)).map((h) => h.id)

/** A top part, and a point inside its body with nothing else there. */
function bareBody(): { c: ComponentInstance; at: Vec2 } {
  for (const c of project.components) {
    const cy = c.pcb.placed && c.pcb.side === "top" ? pcbCourtyard(c) : null
    if (!cy) continue
    for (const f of [0.5, 0.3, 0.7]) {
      const at = { x: cy.minX + (cy.maxX - cy.minX) * f, y: cy.minY + (cy.maxY - cy.minY) * 0.5 }
      const ids = under(project, at)
      if (ids.length === 1 && ids[0] === `c:${c.id}`) return { c, at }
    }
  }
  throw new Error("no part with a bare body")
}

const { c, at } = bareBody()
const withTrack = (p: Project): Project => ({ ...p, traces: [...p.traces, { id: "t-pick", layer: "top", width: 0.25, points: [{ x: at.x - 0.1, y: at.y }, { x: at.x + 0.1, y: at.y }] }] })
const withVia = (p: Project): Project => ({ ...p, vias: [...p.vias, { id: "v-pick", x: at.x, y: at.y, diameter: 0.6, drill: 0.3 }] })

beforeEach(() => {
  useUi.setState({ layers: { ...useUi.getState().layers, top: true, bottom: true, silk: true }, hiddenCopper: {} })
})

describe("what a double click lists", () => {
  it("is the one thing there, alone", () => {
    expect(under(project, at)).toEqual([`c:${c.id}`])
  })

  it("lists a track inside a part's body, and the part, in the order a click picks them", () => {
    const p = withTrack(project)
    expect(under(p, at)).toEqual(["t:t-pick", `c:${c.id}`])
    expect(hitTest(p, at, TOL, "top", analysis(p).items)).toMatchObject({ type: "trace", id: "t-pick" })
  })

  it("picks and lists the track under the pointer, not one only within a click's reach beside it, drawn later", () => {
    // At a usual zoom a click reaches a few tenths of a millimetre: the second track's edge is within it, but not under the pointer. It was
    // picked for being drawn later, and the double click listed both.
    const reach = 0.6
    const beside = { id: "t-beside", layer: "top" as const, width: 0.25, points: [{ x: at.x - 0.1, y: at.y + 0.275 }, { x: at.x + 0.1, y: at.y + 0.275 }] }
    const tracked = withTrack(project)
    const p = { ...tracked, traces: [...tracked.traces, beside] }
    expect(hitTest(p, at, reach, "top", analysis(p).items)).toMatchObject({ type: "trace", id: "t-pick" })
    expect(hitsUnder(p, at, reach, "top", analysis(p)).map((h) => h.id)).toEqual(["t:t-pick", `c:${c.id}`])
  })

  it("lists a via on the track first", () => {
    expect(under(withVia(withTrack(project)), at)).toEqual(["v:v-pick", "t:t-pick", `c:${c.id}`])
  })

  it("leaves out a rule area the point is inside when anything else is there, but lists it alone", () => {
    const zoned = withZone(project, rectangle(at.x - 3, at.y - 3, at.x + 3, at.y + 3), { keepout: { tracks: true } }, "k-pick")
    expect(under(zoned, at)).toEqual([`c:${c.id}`])
    const clear = { x: project.board.x - project.board.width / 2 + 0.6, y: project.board.y - project.board.height / 2 + 0.6 }
    const corner = withZone(project, rectangle(clear.x - 0.5, clear.y - 0.5, clear.x + 0.5, clear.y + 0.5), { keepout: { tracks: true } }, "k-pick")
    expect(under(corner, clear)).toEqual(["z:k-pick"])
  })
})

describe("a via or a pad over the tracks of its net", () => {
  it("is listed without the tracks that end on it, which it is drawn over", () => {
    const p = withVia(withTrack(project))
    const via = p.vias.find((v) => v.id === "v-pick")!
    // Give the via the track's net, as a routed one has: a track of the net ends on it.
    const a = analysis(p)
    const net = "n-test"
    const nets = { ...a, viaNet: new Map([...a.viaNet, [via.id, net]]), traceNet: new Map([...a.traceNet, ["t-pick", net]]) }
    expect(hitsUnder(p, at, TOL, "top", nets).map((h) => h.id)).toEqual(["v:v-pick", `c:${c.id}`])
    // A track of another net under it is a short, and is listed.
    const other = { ...nets, traceNet: new Map([...nets.traceNet, ["t-pick", "n-other"]]) }
    expect(hitsUnder(p, at, TOL, "top", other).map((h) => h.id)).toEqual(["v:v-pick", "t:t-pick", `c:${c.id}`])
  })

  it("is not listed on a routed board's vias with their tracks", () => {
    const a = analysis(project)
    let checked = 0
    for (const v of project.vias.slice(0, 20)) {
      const ids = hitsUnder(project, { x: v.x, y: v.y }, TOL, "top", a).map((h) => h.id)
      expect(ids.filter((id) => id.startsWith("t:"))).toEqual([])
      expect(ids[0]).toBe(`v:${v.id}`)
      checked++
    }
    expect(checked).toBeGreaterThan(0)
  })
})

describe("the rows of the list", () => {
  it("names each thing, with what tells it apart", () => {
    const p = withVia(withTrack(project))
    const a = analysis(p)
    const conn = computeConnectivity(p)
    const rows = pickRows(p, hitsUnder(p, at, TOL, "top", a), {
      traceNet: a.traceNet,
      viaNet: a.viaNet,
      netName: (id) => conn.nets.find((n) => n.id === id)?.name ?? null,
      unit: "mm",
    })
    expect(rows.map((r) => [r.id, r.kind])).toEqual([
      ["v:v-pick", "Via"],
      ["t:t-pick", "Track"],
      [`c:${c.id}`, "Part"],
    ])
    expect(rows[0].detail).toBe("0.6 / 0.3 mm")
    expect(rows[1].detail).toBe("Top · 0.25 mm")
    expect(rows[2].name).toBe(c.ref)
  })
})
