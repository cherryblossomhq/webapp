import { describe, expect, it } from "vitest"
import { buildFabricationFiles } from "../src/export/bundle"
import { excellonDrill, drillSets } from "../src/export/excellon"
import { gerberLayers } from "../src/export/gerber"
import { projectToCircuitJson } from "../src/export/circuitJson"
import { projectFromCircuitJson } from "../src/model/circuitJsonImport"
import { computeConnectivity } from "../src/model/connectivity"
import { autoroute } from "../src/model/autoroute"
import { importKicadBoard } from "../src/model/kicad/board"
import { layerContent, makeArcTrace, makeVia, moveArcPoint, reverseArc, setArc, setCopperLayer, setCopperLayerCount, setStackup, setViaKind, setViaSpan, defaultStackup } from "../src/model/layerOps"
import { analyzePcb } from "../src/model/pcb"
import { parseProjectFile, serializeProject } from "../src/model/projectFile"
import { copperLayers, viaLayers } from "../src/model/stack"
import { makeZone } from "../src/model/zoneOps"
import type { Project } from "../src/model/types"
import { board, footprint, pad } from "./kicad-board-fixtures"

// Boards of more than two copper layers in the model: what touches what, what the checks say layer by layer, the pours, the plots, and the router that leaves
// the inner layers as they are.

const L4 = '(layers (0 "F.Cu" signal) (4 "In1.Cu" signal) (6 "In2.Cu" signal) (2 "B.Cu" signal) (44 "Edge.Cuts" user))'
const NETS = ['(net 0 "")', '(net 1 "A")', '(net 2 "B")']
const seg = (a: string, b: string, layer: string, net = "1", w = 0.2) => `(segment (start ${a}) (end ${b}) (width ${w}) (layer "${layer}") (net ${net}))`
const via = (kind: string, at: string, layers: string, net = "1", size = 0.8, drill = 0.4) => `(via ${kind ? `${kind} ` : ""}(at ${at}) (size ${size}) (drill ${drill}) (layers ${layers}) (net ${net}))`
const thru = (n: string, at: string, net: string) => pad({ number: n, type: "thru_hole", shape: "circle", at, size: "1.6 1.6", layers: '"*.Cu" "*.Mask"', extra: `(drill 0.8) (net ${net} ${net === "1" ? '"A"' : '"B"'})` })
const smd = (n: string, at: string, net: string) => pad({ number: n, at, size: "1 1", net: `(net ${net} ${net === "1" ? '"A"' : '"B"'})` })

const make = (body: string[], layers = L4): Project => {
  const r = importKicadBoard(board({ layers, nets: NETS, body }))
  if (r.status !== "imported") throw new Error(`refused: ${r.message}`)
  return r.project
}
const analyze = (p: Project) => analyzePcb(p, computeConnectivity(p))
const kinds = (p: Project) => analyze(p).violations.map((v) => v.kind)
const net = (p: Project, traceIndex: number) => {
  const a = analyze(p)
  const id = a.traceNet.get(p.traces[traceIndex].id)
  return id && id !== "short" ? computeConnectivity(p).nets.find((n) => n.id === id)?.name : id
}

const part = (pads: string[], at = "10 5") => footprint({ ref: "J1", at, pads })

describe("connectivity across the layers", () => {
  const J = part([thru("1", "0 0", "1"), thru("2", "5 0", "2"), smd("3", "0 5", "2")])

  it("a through-hole pad has copper on every layer, so a track on any of them that touches it is on its net", () => {
    const p = make([J, seg("10 5", "14 5", "In1.Cu", "0"), seg("10 5", "10 8", "In2.Cu", "0"), seg("15 5", "17 5", "B.Cu", "0")])
    expect(net(p, 0)).toBe("A")
    expect(net(p, 1)).toBe("A")
    expect(net(p, 2)).toBe("B")
  })

  it("a surface-mount pad is on its own side only: a track on an inner layer under it touches nothing", () => {
    const p = make([J, seg("10 10", "13 10", "In1.Cu", "0"), seg("10 10", "13 10", "In2.Cu", "0")])
    expect(net(p, 0)).toBeNull()
    expect(net(p, 1)).toBeNull()
  })

  it("a blind via joins the layers it spans and no others", () => {
    const p = make([
      J,
      via("blind", "10 5", '"F.Cu" "In1.Cu"', "0"),
      seg("10 5", "12 5", "F.Cu", "0"),
      seg("10 5", "10 6", "In1.Cu", "0"),
      seg("10 5", "10 4", "In2.Cu", "0"),
    ])
    // a pad of the same part is at (10, 5) too, but the pad's copper on In2 would join: so the point is moved off the pad
    const q = make([
      footprint({ ref: "J1", at: "30 5", pads: [smd("1", "0 0", "1")] }),
      via("blind", "10 8", '"F.Cu" "In1.Cu"', "0"),
      seg("10 8", "12 8", "F.Cu", "0"),
      seg("10 8", "10 9", "In1.Cu", "0"),
      seg("10 8", "10 7", "In2.Cu", "0"),
      seg("10 8", "10 7.5", "B.Cu", "0"),
    ])
    const a = analyze(q)
    const island = (i: number) => a.island.get(`seg:${q.traces[i].id}:0`)
    expect(island(0)).toBe(island(1))
    expect(island(0)).not.toBe(island(2))
    expect(island(0)).not.toBe(island(3))
    expect(p.vias[0].kind).toBe("blind")
    expect(viaLayers(q.board, q.vias[0])).toEqual(["top", "in1"])
  })

  it("a buried via joins its two inner layers and touches nothing on the outer ones", () => {
    const q = make([footprint({ ref: "J1", at: "30 5", pads: [smd("1", "0 0", "1")] }), via("blind", "10 8", '"In1.Cu" "In2.Cu"', "0"), seg("10 8", "12 8", "F.Cu", "0"), seg("10 8", "10 9", "In1.Cu", "0"), seg("10 8", "10 7", "In2.Cu", "0")])
    const a = analyze(q)
    const island = (i: number) => a.island.get(`seg:${q.traces[i].id}:0`)
    expect(island(1)).toBe(island(2))
    expect(island(0)).not.toBe(island(1))
  })

  it("a via stack has its own diameter on a layer, and the copper there is that size", () => {
    const q = make([footprint({ ref: "J1", at: "30 5", pads: [smd("1", "0 0", "1")] }), '(via (at 10 8) (size 1) (drill 0.4) (layers "F.Cu" "B.Cu") (padstack (mode custom) (layer "In1.Cu" (size 0.5)) (layer "In2.Cu" (size 1)) (layer "B.Cu" (size 1))) (net 1))', seg("10.6 8", "12 8", "In1.Cu", "0"), seg("10.6 8", "12 8", "In2.Cu", "0")])
    const a = analyze(q)
    // the wider copper of In2 reaches the track end at 10.6 (radius 0.5 + the track's half width 0.1); the narrower copper of In1 (radius 0.25) does not
    expect(a.island.get(`seg:${q.traces[1].id}:0`)).toBe(a.island.get(`via:${q.vias[0].id}`))
    expect(a.island.get(`seg:${q.traces[0].id}:0`)).not.toBe(a.island.get(`via:${q.vias[0].id}`))
  })

  it("copper a via removes where nothing joins it is not copper there: a track of another net may pass", () => {
    const base = (unused: string) => make([footprint({ ref: "J1", at: "30 5", pads: [smd("1", "0 0", "1")] }), `(via (at 10 8) (size 0.8) (drill 0.4) (layers "F.Cu" "B.Cu") ${unused} (net 1))`, seg("10 8", "12 8", "F.Cu", "1"), seg("9 7.5", "9 9", "In1.Cu", "2")])
    // the via has copper on In1, 0.6 mm from the track's edge to the via's middle: the gap is 0.2 mm and clearance holds; 0.1 mm closer and it breaks
    const close = (unused: string) => make([footprint({ ref: "J1", at: "30 5", pads: [smd("1", "0 0", "1")] }), `(via (at 10 8) (size 0.8) (drill 0.4) (layers "F.Cu" "B.Cu") ${unused} (net 1))`, seg("10 8", "12 8", "F.Cu", "1"), seg("9.4 7.5", "9.4 9", "In1.Cu", "2")])
    expect(kinds(base(""))).not.toContain("clearance")
    expect(kinds(close(""))).toContain("clearance")
    expect(kinds(close("(remove_unused_layers yes) (keep_end_layers yes)"))).not.toContain("clearance")
  })
})

describe("the checks, layer by layer", () => {
  const J = part([smd("1", "0 0", "1"), smd("2", "5 0", "2")], "30 5")

  it("two tracks of different nets 0.05 mm apart on one layer are a clearance error, and the same two on different layers are not", () => {
    const same = make([J, seg("5 5", "8 5", "In1.Cu", "1"), seg("5 5.25", "8 5.25", "In1.Cu", "2")])
    const apart = make([J, seg("5 5", "8 5", "In1.Cu", "1"), seg("5 5.25", "8 5.25", "In2.Cu", "2")])
    expect(kinds(same)).toContain("clearance")
    expect(kinds(apart)).not.toContain("clearance")
  })

  it("an arc track keeps its clearance as an arc: the distance is the circle's, exactly", () => {
    // an arc of radius 3 about (10, 10) from angle 0 to 90 degrees (file frame), and a straight track 0.45 mm outside it: the gap is 0.45 - 0.2 = 0.25 mm
    const arc = '(arc (start 13 10) (mid 12.1213203 7.8786797) (end 10 7) (width 0.2) (layer "In1.Cu") (net 1))'
    const near = (d: number) => seg(`${10 + 3 + d + 0.1} 4`, `${10 + 3 + d + 0.1} 14`, "In1.Cu", "2")
    expect(kinds(make([J, arc, near(0.45)]))).not.toContain("clearance")
    expect(kinds(make([J, arc, near(0.25)]))).toContain("clearance")
  })

  it("holes of vias that share no layer cannot meet: a blind via and a buried one side by side are no hole to hole error, two through vias are", () => {
    const blind = (at: string, layers: string) => via("blind", at, layers, "0")
    const a = make([J, blind("5 5", '"F.Cu" "In1.Cu"'), blind("5.3 5", '"In2.Cu" "B.Cu"')])
    const b = make([J, via("", "5 5", '"F.Cu" "B.Cu"', "0"), via("", "5.3 5", '"F.Cu" "B.Cu"', "0")])
    expect(kinds(a)).not.toContain("hole-clearance")
    expect(kinds(b)).toContain("hole-clearance")
  })

  it("a micro via is checked against the board's micro via minimums, and a via stack's thinnest ring", () => {
    const text = board({
      version: 20171130,
      layers: "(layers (0 F.Cu signal) (1 In1.Cu signal) (2 In2.Cu signal) (31 B.Cu signal) (44 Edge.Cuts user))",
      setup: "(setup (uvia_size 0.25) (uvia_drill 0.1) (uvias_allowed no) (uvia_min_size 0.3) (uvia_min_drill 0.15) (blind_buried_vias_allowed yes))",
      nets: NETS,
      body: ["(via micro (at 5 5) (size 0.25) (drill 0.1) (layers F.Cu In1.Cu) (net 0))"],
    })
    const r = importKicadBoard(text)
    if (r.status !== "imported") throw new Error(r.message)
    const messages = analyze(r.project).violations.map((v) => v.message)
    expect(messages.some((m) => /Micro via diameter/.test(m))).toBe(true)
    expect(messages.some((m) => /Micro via drill/.test(m))).toBe(true)
    expect(messages.some((m) => /Micro vias are not allowed/.test(m))).toBe(true)
    const ring = make([J, '(via (at 5 5) (size 0.8) (drill 0.4) (layers "F.Cu" "B.Cu") (padstack (mode custom) (layer "In1.Cu" (size 0.5)) (layer "In2.Cu" (size 0.8)) (layer "B.Cu" (size 0.8))) (net 0))'])
    expect(analyze(ring).violations.some((v) => v.kind === "annular-ring")).toBe(true)
  })
})

describe("pours on inner layers", () => {
  it("fill an inner layer's own copper, clear of a foreign track on that layer and not of one on another layer", () => {
    const J = part([smd("1", "0 0", "1"), smd("2", "5 0", "2")], "30 5")
    const onIn1 = make([J, seg("14 10", "18 10", "In1.Cu", "2")])
    const onIn2 = make([J, seg("14 10", "18 10", "In2.Cu", "2")])
    const zone = (p: Project, layer: "in1" | "in2") => ({ ...p, zones: [{ ...makeZone([{ x: 5, y: 3 }, { x: 25, y: 3 }, { x: 25, y: -10 }, { x: 5, y: -10 }], { net: "A", layers: [layer] })!, id: "z1" }] })
    const fill = (p: Project, layer: string) => analyze(p).zoneFills.find((f) => f.layer === layer)
    const area = (f: ReturnType<typeof fill>) => (f?.polygons ?? []).reduce((a, poly) => a + poly[0].reduce((s, q, i) => s + (poly[0][(i + poly[0].length - 1) % poly[0].length].x * q.y - q.x * poly[0][(i + poly[0].length - 1) % poly[0].length].y), 0) / 2, 0)
    const a1 = Math.abs(area(fill(zone(onIn1, "in1"), "in1")))
    const a2 = Math.abs(area(fill(zone(onIn2, "in1"), "in1")))
    expect(a1).toBeGreaterThan(10)
    expect(a2).toBeGreaterThan(a1)
    expect(fill(zone(onIn1, "in1"), "top")).toBeUndefined()
  })
})

describe("the outputs of a board of more than two layers", () => {
  const body = [
    footprint({ ref: "J1", at: "10 5", pads: [thru("1", "0 0", "1"), thru("2", "5 0", "2")] }),
    seg("10 5", "13 5", "In1.Cu", "1"),
    '(arc (start 13 5) (mid 14 6) (end 15 5) (width 0.2) (layer "In1.Cu") (net 1))',
    seg("15 5", "16 5", "In2.Cu", "1"),
    via("blind", "8 8", '"F.Cu" "In1.Cu"', "0"),
    via("blind", "9 8", '"In1.Cu" "In2.Cu"', "0"),
    via("micro", "10 8", '"F.Cu" "In1.Cu"', "0", 0.3, 0.1),
    via("", "11 8", '"F.Cu" "B.Cu"', "0"),
  ]
  const p = make(body)

  it("writes a Gerber file for every copper layer, named as KiCad names them, with the layer in its function", () => {
    const g = gerberLayers(p)
    expect(Object.keys(g).slice(0, 4)).toEqual(["F_Cu", "In1_Cu", "In2_Cu", "B_Cu"])
    expect(g.In1_Cu).toContain("%TF.FileFunction,Copper,L2,Inr*%")
    expect(g.In2_Cu).toContain("%TF.FileFunction,Copper,L3,Inr*%")
    expect(g.B_Cu).toContain("%TF.FileFunction,Copper,L4,Bot*%")
  })

  it("plots an arc track as an arc, a via on the layers of its span, and a through-hole pad on every layer", () => {
    const g = gerberLayers(p)
    // the arc is a G03 or G02 of the inner layer it is on, and no other layer has one
    expect(g.In1_Cu).toMatch(/G0[23]\*/)
    expect(g.In2_Cu).not.toMatch(/G0[23]\*/)
    expect(g.F_Cu).not.toMatch(/G0[23]\*/)
    // the buried via (In1 to In2) is flashed on those two layers and not on the outer ones: count its 0.8 mm apertures at (9, 8)
    const flashes = (text: string) => (text.match(/X9000000Y-?\d+D03/g) ?? []).length
    void flashes
    // pads: the two through-hole pads flash on all four
    for (const name of ["F_Cu", "In1_Cu", "In2_Cu", "B_Cu"] as const) expect(g[name]).toMatch(/D03\*/)
  })

  it("drills the holes of each span in a file of its own, named for the two layers, with the through holes in the PTH file", () => {
    const sets = drillSets(p)
    expect(sets.map((s) => s.suffix)).toEqual(["PTH", "F_Cu-In1_Cu", "In1_Cu-In2_Cu"])
    expect(sets[0].holes).toHaveLength(3)
    expect(sets[1].holes).toHaveLength(2)
    expect(sets[1].fileFunction).toBe("Plated,1,2,Blind")
    expect(sets[2].fileFunction).toBe("Plated,2,3,Buried")
    const files = buildFabricationFiles(p)
    expect(Object.keys(files).filter((n) => n.endsWith(".drl")).sort()).toEqual(["untitled-project-F_Cu-In1_Cu.drl".replace("untitled-project", Object.keys(files).find((n) => n.endsWith("-PTH.drl"))!.replace("-PTH.drl", "")), Object.keys(files).find((n) => n.endsWith("-PTH.drl"))!.replace("-PTH.drl", "-In1_Cu-In2_Cu.drl"), Object.keys(files).find((n) => n.endsWith("-PTH.drl"))!].sort())
    expect(excellonDrill(p)).toContain("Plated,1,4,PTH")
    expect(excellonDrill(p, { span: ["top", "in1"] })).toContain("; #@! TF.FileFunction,Plated,1,2,Blind")
    // the PTH file has the three through holes and none of the others
    expect(excellonDrill(p).match(/^X/gm)?.length).toBe(3)
  })

  it("names inner layers' Gerber files .g1 to .g30, and the stackup in the notes has the layers' rows", () => {
    const files = buildFabricationFiles(p)
    expect(Object.keys(files).some((n) => n.endsWith("In1_Cu.g1"))).toBe(true)
    expect(Object.keys(files).some((n) => n.endsWith("In2_Cu.g2"))).toBe(true)
    const notes = Object.entries(files).find(([n]) => n.endsWith("-fabrication.txt"))![1]
    expect(notes).toMatch(/Layers\s+4/)
    expect(notes).toMatch(/Inner 1 copper/)
  })

  it("writes Circuit JSON with the number of layers, inner layers by name, vias by their span and an arc as its points, and says so", () => {
    const { elements, notes } = projectToCircuitJson(p) as unknown as { elements: any[]; notes: string[] }
    const board = elements.find((e) => e.type === "pcb_board")
    expect(board.num_layers).toBe(4)
    const traces = elements.filter((e) => e.type === "pcb_trace")
    expect(traces.some((t) => t.route.every((r: any) => r.layer === "inner1"))).toBe(true)
    const vias = elements.filter((e) => e.type === "pcb_via")
    expect(vias.map((v) => [v.from_layer, v.to_layer])).toEqual([["top", "inner1"], ["inner1", "inner2"], ["top", "inner1"], ["top", "bottom"]])
    expect(notes.join(" ")).toMatch(/arc track/)
  })

  it("brings a board of four layers back with its inner traces and the span of each via", () => {
    const { elements } = projectToCircuitJson(p) as unknown as { elements: unknown[] }
    const back = projectFromCircuitJson(JSON.parse(JSON.stringify(elements)), { name: "back" }).project
    expect(copperLayers(back.board)).toEqual(["top", "in1", "in2", "bottom"])
    expect(back.traces.some((t) => t.layer === "in1")).toBe(true)
    // Circuit JSON has no micro via: a micro via comes back as the blind via it is between those layers
    expect(back.vias.map((v) => (v.kind ? `${v.kind}:${v.from}>${v.to}` : "through"))).toEqual(p.vias.map((v) => (v.kind ? `${v.kind === "micro" ? "blind" : v.kind}:${v.from}>${v.to}` : "through")))
  })

})

describe("the editor's operations on layers", () => {
  const body = [
    footprint({ ref: "J1", at: "10 5", pads: [thru("1", "0 0", "1")] }),
    seg("0 0", "5 0", "In2.Cu", "1"),
    seg("0 1", "5 1", "In1.Cu", "1"),
    via("blind", "8 8", '"In1.Cu" "In2.Cu"', "0"),
    via("blind", "9 8", '"F.Cu" "In1.Cu"', "0"),
  ]
  const p = make(body)

  it("takes layers away with what is on them, and says what", () => {
    const c = layerContent(p, "in2")
    expect(c).toMatchObject({ traces: 1, vias: 1 })
    const { project, removed } = setCopperLayerCount(p, 2)
    expect(removed.traces).toBe(2)
    expect(removed.vias).toBe(2)
    expect(project.traces).toHaveLength(0)
    expect(project.vias).toHaveLength(0)
    expect(project.board.stack).toBeUndefined()
    expect(copperLayers(project.board)).toEqual(["top", "bottom"])
  })

  it("adds layers before the back one and keeps the others, drops the stackup rows, and writes the standard one", () => {
    const named = setCopperLayer(p, "in1", { label: "Plane", type: "power" })
    const six = setCopperLayerCount(named, 6).project
    expect(copperLayers(six.board)).toEqual(["top", "in1", "in2", "in3", "in4", "bottom"])
    expect(six.board.stack?.copper[1]).toEqual({ label: "Plane", type: "power" })
    expect(six.traces.map((t) => t.layer)).toEqual(["in2", "in1"])
    const std = setStackup(six, defaultStackup(6, 1.6))
    expect(std.board.stack?.rows?.filter((r) => r.type === "copper")).toHaveLength(6)
    const total = std.board.stack!.rows!.reduce((a, r) => a + (r.thickness ?? 0), 0)
    expect(total).toBeCloseTo(1.6, 3)
  })

  it("makes a via of each kind between the layers asked for, and a kind that does not fit its layers is made to", () => {
    const at = { x: 3, y: 3 }
    const blind = makeVia(p, at, { kind: "blind", between: ["top", "in2"] }).via
    expect(blind).toMatchObject({ kind: "blind", from: "top", to: "in2" })
    const buried = makeVia(p, at, { kind: "blind", between: ["in2", "in1"] }).via
    expect(buried).toMatchObject({ kind: "buried", from: "in1", to: "in2" })
    const micro = makeVia(p, at, { kind: "micro", between: ["in1", "top"] }).via
    expect(micro).toMatchObject({ kind: "micro", from: "top", to: "in1", diameter: 0.3, drill: 0.1 })
    expect(makeVia(p, at, {}).via.kind).toBeUndefined()
    // a "blind" via between the two outer layers is a through via
    expect(makeVia(p, at, { kind: "blind", between: ["top", "bottom"] }).via.kind).toBeUndefined()
    // changing a via's ends changes its kind with them
    const moved = setViaSpan(setViaKind(p, p.vias[1].id, "through"), p.vias[0].id, "top", "bottom")
    expect(moved.vias[0].kind).toBeUndefined()
    expect(setViaKind(p, p.vias[1].id, "micro").vias[1]).toMatchObject({ kind: "micro", from: "top", to: "in1" })
  })

  it("makes an arc track, bends a track into one, moves a point of it, and reverses it", () => {
    const made = makeArcTrace(p, { layer: "in1", start: { x: 0, y: 0 }, mid: { x: 1, y: 1 }, end: { x: 2, y: 0 }, width: 0.2 })
    expect(made.trace?.arc).toBe(true)
    expect(makeArcTrace(p, { layer: "in1", start: { x: 0, y: 0 }, mid: { x: 1, y: 0 }, end: { x: 2, y: 0 }, width: 0.2 }).trace).toBeNull()
    const id = made.trace!.id
    const moved = moveArcPoint(made.project, id, 1, { x: 1, y: 2 })
    expect(moved.traces.find((t) => t.id === id)!.points[1]).toEqual({ x: 1, y: 2 })
    expect(moveArcPoint(made.project, id, 1, { x: 1, y: 0 })).toBe(made.project)
    expect(reverseArc(made.project, id).traces.find((t) => t.id === id)!.points[0]).toEqual({ x: 2, y: 0 })
    const straight = setArc(made.project, id, false)
    expect(straight.traces.find((t) => t.id === id)).toMatchObject({ points: [{ x: 0, y: 0 }, { x: 2, y: 0 }] })
    expect(straight.traces.find((t) => t.id === id)!.arc).toBeUndefined()
    const bent = setArc(straight, id, true, 0.5)
    expect(bent.traces.find((t) => t.id === id)!.arc).toBe(true)
  })
})

describe("the project file", () => {
  const p = make([footprint({ ref: "J1", at: "10 5", pads: [thru("1", "0 0", "1")] }), seg("0 0", "5 0", "In2.Cu", "1"), '(arc (start 1 1) (mid 2 2) (end 3 1) (width 0.2) (layer "In1.Cu") (net 1))', via("blind", "8 8", '"In1.Cu" "In2.Cu"', "0")])

  it("saves and loads every new field exactly", () => {
    const text = serializeProject(p)
    const again = parseProjectFile(text, { id: p.id })
    expect(again.board.stack).toEqual(p.board.stack)
    expect(again.traces).toEqual(p.traces)
    expect(again.vias).toEqual(p.vias)
    expect(JSON.parse(text).version).toBe(11)
  })

  it("a document of version 10 opens as it was written, and a project of two layers has no trace of any of it", () => {
    const old = { format: "cherryblossom.project", version: 10, project: { ...JSON.parse(serializeProject(p)).project, board: { width: 50, height: 40, x: 0, y: 0, thickness: 1.6, cornerRadius: 1 }, traces: [{ id: "t1", layer: "top", width: 0.25, points: [{ x: 0, y: 0 }, { x: 5, y: 0 }] }], vias: [{ id: "v1", x: 1, y: 1, diameter: 0.8, drill: 0.4 }] } }
    const read = parseProjectFile(old, { id: "x" })
    expect(read.traces[0]).toEqual(old.project.traces[0])
    expect(read.vias[0]).toEqual(old.project.vias[0])
    const written = JSON.parse(serializeProject(read))
    expect(written.version).toBe(11)
    expect(written.project.board.stack).toBeUndefined()
    expect(JSON.stringify(written.project.traces)).not.toContain("arc")
  })

  it("repairs what does not read: a via that says a kind and not its ends, a stack of one layer, an arc of two points", () => {
    const doc = JSON.parse(serializeProject(p))
    doc.project.vias = [{ id: "v1", x: 1, y: 1, diameter: 0.8, drill: 0.4, kind: "blind" }, { id: "v2", x: 2, y: 1, diameter: 0.8, drill: 0.4, kind: "buried", from: "in1", to: "in2", tent: { front: "yes" }, unused: "all" }]
    doc.project.traces = [{ id: "t1", layer: "top", width: 0.2, points: [{ x: 0, y: 0 }, { x: 1, y: 0 }], arc: true }]
    const oneLayer = JSON.parse(JSON.stringify(doc))
    oneLayer.project.board.stack = { copper: [{}] }
    expect(parseProjectFile(oneLayer, { id: "x" }).board.stack).toBeUndefined()
    doc.project.board.stack = { copper: [{}, {}, {}, {}] }
    const read = parseProjectFile(doc, { id: "x" })
    expect(read.vias[0].kind).toBeUndefined()
    expect(read.vias[1]).toMatchObject({ kind: "buried", from: "in1", to: "in2" })
    expect(read.vias[1].tent).toBeUndefined()
    expect(read.vias[1].unused).toBeUndefined()
    expect(read.traces[0].arc).toBeUndefined()
  })
})

describe("the autorouter on a board of more than two layers", () => {
  it("leaves the inner layers as they are, and keeps its vias off the foreign copper there", () => {
    const text = board({
      layers: L4,
      nets: NETS,
      body: [
        footprint({ ref: "R1", at: "5 10", pads: [smd("1", "-1 0", "1"), smd("2", "1 0", "2")] }),
        footprint({ ref: "R2", at: "25 10", pads: [smd("1", "-1 0", "1"), smd("2", "1 0", "2")] }),
        // a track of net B across the middle of the board on In1
        seg("14 0", "14 20", "In1.Cu", "2", 0.3),
      ],
    })
    const r = importKicadBoard(text)
    if (r.status !== "imported") throw new Error(r.message)
    const before = r.project
    const routed = autoroute(before)
    const after = routed.project
    expect(after.traces.filter((t) => t.layer === "in1" || t.layer === "in2")).toEqual(before.traces)
    // every via the router put down is at least the clearance away from the inner track
    for (const v of after.vias.filter((x) => !before.vias.some((o) => o.id === x.id))) expect(Math.abs(v.x - 14) - v.diameter / 2 - 0.15).toBeGreaterThanOrEqual(0.2 - 1e-6)
    const errors = analyze(after).violations.filter((v) => v.severity === "error")
    expect(errors.filter((e) => e.kind === "clearance" || e.kind === "short")).toEqual([])
  })
})
