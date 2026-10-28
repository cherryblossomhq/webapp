import { beforeEach, describe, expect, it, vi } from "vitest"
import type { SchematicConnectivity } from "../src/model/connectivity"
import { EXAMPLES } from "../src/model/examples"
import { schematicPins } from "../src/model/instances"
import { importKicadBoard } from "../src/model/kicad/board"
import type { Project } from "../src/model/types"
import { board, footprint, pad } from "./kicad-board-fixtures"
import { ALL } from "./kicad-test-helpers"

// Slice 1b-ii carry-overs from the slice 1b-i review: the store's two commit hooks cost nothing
// for an edit that leaves the schematic alone and one connectivity for one that does not (M1),
// "Use the net it touches" clears the whole run of copper (M2), and a drag settles what a commit does (m1).

const calls = vi.hoisted(() => ({ n: 0 }))
vi.mock("../src/model/connectivity", async (orig) => {
  const m = await orig<typeof import("../src/model/connectivity")>()
  return { ...m, computeConnectivity: (p: Project): SchematicConnectivity => (calls.n++, m.computeConnectivity(p)) }
})

const { followNetRenames, forgetStoredNets, sameStoredNet } = await import("../src/model/copperNets")
const { pruneImportMarks } = await import("../src/model/importMarks")
const { getConnectivity } = await import("../src/model/connectivityCache")
const { analyzePcb } = await import("../src/model/pcb")
const { useProjectStore } = await import("../src/store/projectStore")

const net = (n: number, name: string) => `(net ${n} "${name}")`
const seg = (a: string, b: string, n: string) => `(segment (start ${a}) (end ${b}) (width 0.25) (layer "F.Cu") ${n})`

/** Parts in a row with a net each between neighbours, a loose pad on each, a lone-pad net, and a three-piece track on net 1. */
function stress(parts = 30): Project {
  const nets = ['(net 0 "")', net(1, "N1")]
  const fps: string[] = []
  for (let i = 0; i < parts; i++) {
    nets.push(net(i + 2, `L${i}`))
    fps.push(footprint({ ref: `U${i + 1}`, at: `${5 + i * 6} 5`, name: "Pkg:Tri", pads: [pad({ number: "1", at: "-1 0", net: net(1, "N1") }), pad({ number: "2", at: "1 0" }), pad({ number: "3", at: "0 2", net: net(i + 2, `L${i}`) })] }))
  }
  const r = importKicadBoard(board({ nets, body: [...fps, seg("4 5", "4 8", net(1, "N1")), seg("4 8", "8 8", net(1, "N1")), seg("8 8", "8 5", net(1, "N1"))], outline: '(gr_rect (start 0 0) (end 400 40) (stroke (width 0.1) (type default)) (fill none) (layer "Edge.Cuts"))' }), { built: ALL })
  if (r.status !== "imported") throw new Error(r.message)
  return r.project
}

const pcbEdit = (p: Project, locked = false): Project => ({ ...p, components: p.components.map((c, i) => (i === 0 ? { ...c, pcb: { ...c.pcb, x: c.pcb.x + (locked ? 0 : 1), ...(locked ? { locked: true } : {}) } } : c)) })
const schEdit = (p: Project): Project => ({ ...p, components: p.components.map((c, i) => (i === 0 ? { ...c, sch: { ...c.sch, x: c.sch.x + 1 } } : c)) })

describe("M1: the commit hooks", () => {
  const p = stress()
  beforeEach(() => {
    calls.n = 0
  })

  it("the board has what the hooks work on: stored copper nets and import marks of both kinds", () => {
    expect(p.traces.every((t) => t.net === "N1")).toBe(true)
    expect(p.importMarks?.checks?.length).toBeGreaterThan(0)
    expect(Object.keys(p.importMarks?.noConnect ?? {}).length).toBe(30)
  })

  it("a move, a turn, a lock or a flag on the PCB runs neither hook's connectivity, and returns the edit as it is", () => {
    getConnectivity(p)
    calls.n = 0
    for (const made of [pcbEdit(p), pcbEdit(p, true), { ...p, components: p.components.map((c) => ({ ...c, pcb: { ...c.pcb, rot: 90 as const } })) }, { ...p, components: p.components.map((c) => ({ ...c, flags: { dnp: true as const } })) }]) {
      expect(followNetRenames(p, made)).toBe(made)
      expect(pruneImportMarks(p, made)).toBe(made)
    }
    expect(calls.n).toBe(0)
  })

  it("a schematic edit computes connectivity once for both hooks together, when the state before is known", () => {
    getConnectivity(p)
    calls.n = 0
    const made = schEdit(p)
    pruneImportMarks(p, followNetRenames(p, made))
    expect(calls.n).toBe(1)
  })

  it("through the store, a PCB edit computes nothing and a drag that moves a part does not either", () => {
    const api = () => useProjectStore.getState()
    api().open(p)
    getConnectivity(p)
    calls.n = 0
    api().commit((x) => pcbEdit(x))
    expect(calls.n).toBe(0)
    api().beginTransient()
    api().setTransient((b) => pcbEdit(b))
    api().endTransient()
    expect(calls.n).toBe(0)
  })

  it("the shipped examples return the same object from both hooks, for a PCB edit and for a schematic one", () => {
    for (const e of EXAMPLES) {
      for (const made of [pcbEdit(e.project), schEdit(e.project)]) {
        expect(followNetRenames(e.project, made)).toBe(made)
        expect(pruneImportMarks(e.project, made)).toBe(made)
      }
    }
  })

  it("is fast on a large board: a PCB edit costs a thousandth of what it did", () => {
    const big = stress(300)
    getConnectivity(big)
    const t0 = performance.now()
    for (let i = 0; i < 20; i++) pruneImportMarks(big, followNetRenames(big, pcbEdit(big)))
    expect((performance.now() - t0) / 20).toBeLessThan(10)
  })

  it("m1: a drag that connects a no-connect pin retires its import mark when it ends, as a commit would", () => {
    const api = () => useProjectStore.getState()
    api().open(p)
    const u1 = p.components[0]
    const before = api().project!.importMarks!.noConnect![u1.id]
    expect(before).toContain("2")
    api().beginTransient()
    // The drag drops a label on the loose pin: it now has a net, so it is no longer a pin left unconnected on purpose.
    api().setTransient((b) => {
      const at = schematicPins(b.components.find((x) => x.id === u1.id)!).find((q) => q.pin === "2")!.pos
      return { ...b, labels: [...b.labels, { id: "lab-m1", name: "N1", x: at.x, y: at.y, rot: 0 as const }] }
    })
    api().endTransient()
    expect(api().project!.importMarks?.noConnect?.[u1.id]).toBeUndefined()
  })
})

describe("M2: Use the net it touches clears the whole run", () => {
  const p = stress(3)
  const pcb = analyzePcb(p, getConnectivity(p))
  it("the three pieces of a track and the via on it are one run that carries the one name", () => {
    const withVia: Project = { ...p, vias: [{ id: "v1", x: 8, y: -8, diameter: 0.8, drill: 0.4, routedNet: "N1" }] }
    const a = analyzePcb(withVia, getConnectivity(withVia))
    const ids = sameStoredNet(withVia, a.island, { trace: withVia.traces[0].id })
    expect(ids.traces.sort()).toEqual(withVia.traces.map((t) => t.id).sort())
    expect(ids.vias).toEqual(["v1"])
    const cleared = forgetStoredNets(withVia, ids)
    expect(cleared.traces.every((t) => t.net === undefined)).toBe(true)
    expect(cleared.vias[0].routedNet).toBeUndefined()
    // From the via it is the same run.
    expect(sameStoredNet(withVia, a.island, { via: "v1" }).traces).toHaveLength(withVia.traces.length)
  })

  it("copper of the same name that is not connected to it keeps it, and copper of another name too", () => {
    const far: Project = { ...p, traces: [...p.traces, { id: "far", layer: "top", width: 0.25, points: [{ x: 300, y: -30 }, { x: 310, y: -30 }], net: "N1" }, { id: "other", layer: "top", width: 0.25, points: [{ x: 4, y: -5 }, { x: 4, y: -2 }], net: "L0" }] }
    const a = analyzePcb(far, getConnectivity(far))
    const ids = sameStoredNet(far, a.island, { trace: far.traces[0].id })
    expect(ids.traces).not.toContain("far")
    expect(ids.traces).not.toContain("other")
    const cleared = forgetStoredNets(far, ids)
    expect(cleared.traces.find((t) => t.id === "far")!.net).toBe("N1")
    expect(cleared.traces.find((t) => t.id === "other")!.net).toBe("L0")
  })

  it("an item with no stored name has nothing to clear", () => {
    expect(pcb.items.length).toBeGreaterThan(0)
    expect(forgetStoredNets(p, { traces: [], vias: [] })).toBe(p)
  })
})
