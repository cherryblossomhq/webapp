import { beforeEach, describe, expect, it } from "vitest"
import { hitsUnder, hitTest } from "../src/editor/pcb/PcbEditor"
import { pickRows } from "../src/editor/pcb/PickMenu"
import { computeConnectivity } from "../src/model/connectivity"
import { pcbCourtyard } from "../src/model/instances"
import { padSelectionId, selectedPad } from "../src/model/padSelection"
import { pointPadDistance } from "../src/model/padDistance"
import { analyzePcb } from "../src/model/pcb"
import type { ComponentInstance, Project, Vec2 } from "../src/model/types"
import { useUi } from "../src/store/uiStore"
import { built } from "./built"
import { rectangle, withZone } from "./zones-fixtures"

// A double click where several things are under the pointer lists them all, as Altium does, the one a click picks first: a track or a via
// inside a part's body was the only thing a double click there could open, and the part (or a pad apart from its part) could not be opened.

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

  it("lists a rule area under them too, last", () => {
    const zoned = withZone(project, rectangle(at.x - 3, at.y - 3, at.x + 3, at.y + 3), { keepout: { tracks: true } }, "k-pick")
    expect(under(zoned, at)).toEqual([`c:${c.id}`, "z:k-pick"])
  })

  it("lists two parts over each other", () => {
    const p = { ...project, components: [...project.components, { ...c, id: "c-over", ref: "U99" }] }
    expect(under(p, at)).toEqual(expect.arrayContaining([`c:${c.id}`, "c:c-over"]))
  })
})

describe("a via or a pad over tracks, and a part over its pads", () => {
  it("lists a via's own tracks after it", () => {
    const a = analysis(project)
    const lists = project.vias.slice(0, 20).map((v) => hitsUnder(project, { x: v.x, y: v.y }, TOL, "top", a).map((h) => h.id))
    for (const [i, ids] of lists.entries()) expect(ids[0]).toBe(`v:${project.vias[i].id}`)
    expect(lists.some((ids) => ids.some((id) => id.startsWith("t:")))).toBe(true)
  })

  it("lists a pad on its own, the track that ends on it, and its part, while a click still picks the part by the pad", () => {
    const a = analysis(project)
    // A top pad of a part with a top track ending inside it.
    let found: { at: Vec2; pad: string; part: string; track: string } | null = null
    for (const it of a.items) {
      if (it.kind !== "pad" || it.pad.componentId === "#board" || !it.layers.includes("top")) continue
      const seg = a.items.find((s) => s.kind === "segment" && s.layers.includes("top") && [s.a, s.b].some((e) => pointPadDistance(e, it.pad) <= 0))
      if (seg?.kind !== "segment") continue
      const end = pointPadDistance(seg.a, it.pad) <= 0 ? seg.a : seg.b
      found = { at: end, pad: padSelectionId(it.pad.componentId, parseInt(it.id.split(":").pop()!, 10)), part: `c:${it.pad.componentId}`, track: `t:${seg.traceId}` }
      break
    }
    expect(found).not.toBeNull()
    const { at: end, pad, part, track } = found!
    const ids = hitsUnder(project, end, TOL, "top", a).map((h) => h.id)
    expect(ids[0]).toBe(pad)
    expect(ids).toContain(track)
    expect(ids).toContain(part)
    expect(ids.indexOf(track)).toBeLessThan(ids.indexOf(part))
    expect(hitTest(project, end, TOL, "top", a.items)).toMatchObject({ type: "pad" })
    // The pad's selection names the pad, on the net the analysis puts it on.
    const sp = selectedPad(project, a.items, pad)!
    const item = a.items.find((it) => it.kind === "pad" && it.id === `pad:${sp.c.id}:${sp.index}`)
    expect(item?.kind === "pad" && item.netId).toBe(sp.netId)
    expect(`c:${sp.c.id}`).toBe(part)
    // Its row says it is a pad, by its part and number.
    const rows = pickRows(project, hitsUnder(project, end, TOL, "top", a), { traceNet: a.traceNet, viaNet: a.viaNet, netName: () => null, unit: "mm" })
    expect(rows[0]).toMatchObject({ id: pad, kind: "Pad", name: `${sp.c.ref}.${sp.pad.padNumber ?? sp.pad.pin}` })
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
