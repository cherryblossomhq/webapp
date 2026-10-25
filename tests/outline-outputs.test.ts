import { createRequire } from "node:module"
import type { Occt } from "occt-import-js"
import * as THREE from "three"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { runTool } from "../src/ai/tools"
import { measurePcb, describePcb } from "../src/ai/vision/measure"
import { pcbSvg } from "../src/ai/vision/pcbSvg"
import { buildBoard, createSharedMaterials } from "../src/editor/three/buildBoard"
import { buildFabricationFiles } from "../src/export/bundle"
import { projectToCircuitJson } from "../src/export/circuitJson"
import { excellonDrill, npthHoles } from "../src/export/excellon"
import { gerberEdgeCuts, gerberLayers } from "../src/export/gerber"
import { kicadFiles } from "../src/export/kicad"
import { applyOutline } from "../src/export/kicadOutline"
import { OutlineNotClosedError } from "../src/export/outlineGuard"
import { stepBoard, stepFile } from "../src/export/step3d"
import { writeStep } from "../src/export/step"
import { autoroute } from "../src/model/autoroute"
import { computeConnectivity } from "../src/model/connectivity"
import { addComponent, addVia, autoPlacePcb, createProject, labelPin } from "../src/model/ops"
import { boardAreaMm2, boxOnBoard, outlineGeometry } from "../src/model/outline"
import { addOutlinePaths, addSlot, circlePath, setOutlinePaths } from "../src/model/outlineOps"
import { analyzePcb } from "../src/model/pcb"
import { fillTester } from "../src/model/pour"
import { parseProjectFile, serializeProject } from "../src/model/projectFile"
import { pcbCourtyard } from "../src/model/instances"
import type { Project, Vec2 } from "../src/model/types"
import type { ShapePath as Path } from "../src/model/shapes"

const require = createRequire(import.meta.url)

let occt: Occt
beforeAll(async () => {
  occt = await (require("occt-import-js") as () => Promise<Occt>)()
})

/** The volume of the solids in a STEP file as OCCT reads it back (the kernel FreeCAD and KiCad's viewer use), and how many meshes there are. */
function stepVolume(text: string, deflection = 0.002) {
  const r = occt.ReadStepFile(new TextEncoder().encode(text), { linearDeflectionType: "absolute_value", linearDeflection: deflection } as never)
  expect(r.success).toBe(true)
  let v = 0
  for (const m of r.meshes) {
    const pos = m.attributes.position.array
    const idx = m.index.array
    for (let i = 0; i < idx.length; i += 3) {
      const [a, b, c] = [idx[i] * 3, idx[i + 1] * 3, idx[i + 2] * 3]
      v += (pos[a] * (pos[b + 1] * pos[c + 2] - pos[b + 2] * pos[c + 1]) - pos[a + 1] * (pos[b] * pos[c + 2] - pos[b + 2] * pos[c]) + pos[a + 2] * (pos[b] * pos[c + 1] - pos[b + 1] * pos[c])) / 6
    }
  }
  return { volume: v, solids: r.meshes.length }
}
const P = (x: number, y: number): Vec2 => ({ x, y })

/** A board 40 by 30 with a half circle of radius 15 on its right, a round cutout and a slot: lines, arcs, holes. */
const dShape = (): Path => ({
  closed: true,
  segs: [
    { kind: "line", a: P(0, 0), b: P(40, 0) },
    { kind: "arc", start: P(40, 0), mid: P(55, 15), end: P(40, 30) },
    { kind: "line", a: P(40, 30), b: P(0, 30) },
    { kind: "line", a: P(0, 30), b: P(0, 0) },
  ],
})
const AREA = 40 * 30 + (Math.PI * 15 * 15) / 2 - Math.PI * 16 - (14 * 2 + Math.PI)

function drawn(): Project {
  let p = createProject("scratch")
  p = { ...p, board: { ...p.board, width: 50, height: 40, x: 0, y: 0, cornerRadius: 0 } }
  p = addOutlinePaths(p, [dShape()]).project
  p = addOutlinePaths(p, [circlePath(P(15, 15), 4)]).project
  p = addSlot(p, P(28, 8), P(28, 22), 2)
  return p
}

/** Two resistors either side of the round cutout on one net, a trace and a via placed as each test wants. */
function populated(base: Project = drawn()): Project {
  let p = base
  const a = addComponent(p, "resistor", { sch: { x: 0, y: 0 }, pcb: { x: 5, y: 15, placed: true } })
  p = a.project
  const b = addComponent(p, "resistor", { sch: { x: 3, y: 0 }, pcb: { x: 23, y: 15, placed: true } })
  p = b.project
  for (const c of [a.component, b.component]) {
    p = labelPin(p, { componentId: c.id, pin: "1" }, "SIG")
    p = labelPin(p, { componentId: c.id, pin: "2" }, "GND")
  }
  return p
}

const analyze = (p: Project) => analyzePcb(p, computeConnectivity(p))
const kinds = (p: Project, kind: string) => analyze(p).violations.filter((v) => v.kind === kind)

describe("a board drawn from scratch with an outline, a cutout and a slot", () => {
  const p = drawn()
  it("is one piece of board with two cutouts, the right size and area", () => {
    const g = outlineGeometry(p.board)!
    expect(g.regions).toHaveLength(1)
    expect(g.regions[0].holes).toHaveLength(2)
    expect([p.board.width, p.board.height, p.board.x, p.board.y, p.board.cornerRadius]).toEqual([55, 30, 27.5, 15, 0])
    expect(boardAreaMm2(p.board)).toBeCloseTo(AREA, 0)
  })

  describe("checks", () => {
    it("measures copper to the edge against the real outline: a straight edge, an arc, a cutout and a slot", () => {
      const track = (points: Vec2[]) => ({ ...populated(), traces: [{ id: "t", layer: "top" as const, width: 0.2, points }] })
      const msg = (q: Project) => kinds(q, "edge-clearance").map((v) => v.message)
      // 0.3 mm from the straight edge x = 0, centre line 0.4 mm away less half the width: 0.3
      expect(msg(track([P(0.4, 5), P(0.4, 10)]))[0]).toMatch(/Trace is 0\.3 mm from the board edge/)
      // the arc: its circle is centre (40, 15) radius 15, so the point (54.6, 15) is 0.4 from it and the trace's edge 0.3
      expect(msg(track([P(54.6, 14.9), P(54.6, 15.1)]))[0]).toMatch(/0\.3\d* mm from the board edge/)
      // beside the round cutout (centre (15,15) r 4): the trace edge 0.3 from it
      expect(msg(track([P(15, 19.4), P(16, 19.4)]))[0]).toMatch(/0\.3\d* mm/)
      // beside the slot (x = 28, 2 wide, so its wall is x = 27): 0.3 from it
      expect(msg(track([P(26.6, 10), P(26.6, 12)]))[0]).toMatch(/0\.3\d* mm/)
      // well inside: nothing
      expect(msg(track([P(10, 5), P(20, 5)]))).toEqual([])
      // across a cutout and out past the edge: the board edge is crossed
      expect(msg(track([P(10, 15), P(20, 15)]))[0]).toMatch(/crosses the board edge/)
      expect(msg(track([P(30, 15), P(60, 15)]))[0]).toMatch(/crosses the board edge/)
      // a via on the cutout is off the board
      expect(msg({ ...populated(), vias: [{ id: "v", x: 15, y: 15, diameter: 0.6, drill: 0.3 }] })[0]).toMatch(/crosses the board edge/)
    })

    it("a part wholly in a cutout, or off the board, is outside the outline; one on the board is not", () => {
      const q = populated()
      expect(kinds(q, "outside-board")).toEqual([])
      const moved = { ...q, components: q.components.map((c, i) => (i === 0 ? { ...c, pcb: { ...c.pcb, x: 15, y: 15 } } : c)) }
      expect(kinds(moved, "outside-board").map((v) => v.message)).toEqual([`${q.components[0].ref} is outside the board outline`])
      const bits = { ...q, components: q.components.map((c, i) => (i === 0 ? { ...c, pcb: { ...c.pcb, x: 60, y: 15 } } : c)) }
      expect(kinds(bits, "outside-board")).toHaveLength(1)
    })

    it("a board whose outline does not close, or has none, has the one error that says so", () => {
      const open = addOutlinePaths(populated({ ...drawn(), board: { ...drawn().board } }), [{ closed: false, segs: [{ kind: "line", a: P(2, 2), b: P(6, 2) }] }]).project
      const v = kinds(open, "outline")
      expect(v).toHaveLength(1)
      expect(v[0].severity).toBe("error")
      expect(v[0].message).toMatch(/not closed: 1 piece of it ends in the open/)
      const missing = { ...populated(), board: { ...populated().board, outline: { paths: [] } } }
      expect(kinds(missing, "outline")[0].message).toMatch(/no outline/)
      expect(kinds(populated(), "outline")).toEqual([])
    })
  })

  describe("the router and the pours", () => {
    it("routes round the cutout, inside the board and clear of the edge", () => {
      const q = populated()
      const res = autoroute(q)
      expect(res.remaining).toBe(0)
      expect(res.addedTraces).toBeGreaterThan(0)
      const g = outlineGeometry(res.project.board)!
      for (const t of res.project.traces) {
        for (let i = 0; i < t.points.length; i++) {
          expect(g.contains(t.points[i])).toBe(true)
          if (i) expect(g.nearestToSegment(t.points[i - 1], t.points[i])).toBeGreaterThanOrEqual(res.project.rules.edgeClearance + t.width / 2 - 1e-6)
        }
      }
      expect(analyze(res.project).violations.filter((v) => v.severity === "error" && v.kind !== "unrouted")).toEqual([])
    })

    it("pours inside the outline, out of the cutouts and away from the edge", () => {
      const q = { ...populated(), zones: [{ id: "z", net: "GND", layer: "top" as const }] }
      const fill = analyze(q).zoneFills[0]
      const tests = fill.polygons.map(fillTester)
      const filled = (pt: Vec2) => tests.some((t) => t(pt))
      expect(filled(P(10, 25))).toBe(true)
      expect(filled(P(15, 15))).toBe(false)
      expect(filled(P(28, 15))).toBe(false)
      expect(filled(P(0.2, 25))).toBe(false)
      expect(filled(P(54.8, 15))).toBe(false)
      expect(filled(P(50, 15))).toBe(true)
      // and the whole fill is on the board
      const g = outlineGeometry(q.board)!
      for (const poly of fill.polygons) for (const ring of poly) for (const pt of ring) expect(g.signedDistance(pt)).toBeGreaterThanOrEqual(q.rules.edgeClearance - 0.02)
    })
  })

  describe("placement", () => {
    it("keeps every part on the board, out of the cutouts, wherever it is packed", () => {
      let q = createProject("pack")
      q = { ...q, board: { ...q.board, width: 50, height: 40, x: 0, y: 0, cornerRadius: 0 } }
      q = setOutlinePaths(q, [{ closed: true, segs: [{ kind: "line", a: P(0, 0), b: P(30, 0) }, { kind: "line", a: P(30, 0), b: P(30, 12) }, { kind: "line", a: P(30, 12), b: P(12, 12) }, { kind: "line", a: P(12, 12), b: P(12, 30) }, { kind: "line", a: P(12, 30), b: P(0, 30) }, { kind: "line", a: P(0, 30), b: P(0, 0) }] }, circlePath(P(6, 6), 3)])
      for (let i = 0; i < 6; i++) q = addComponent(q, "resistor", { sch: { x: i * 3, y: 0 } }).project
      const placed = autoPlacePcb(q)
      const g = outlineGeometry(placed.board)!
      expect(placed.components.every((c) => c.pcb.placed)).toBe(true)
      for (const c of placed.components) expect(boxOnBoard(g, pcbCourtyard(c)!)).toBe(true)
      expect(kinds(placed, "outside-board")).toEqual([])
    })
  })

  describe("the files", () => {
    it("the Gerber edge layer draws every loop as drawn, arcs as arcs", () => {
      const edge = gerberEdgeCuts(populated())
      expect(edge.split("\n").filter((l) => l.endsWith("D02*"))).toHaveLength(3)
      // the board's arc, the cutout's two halves and the slot's two ends: five arcs, counter-clockwise or clockwise as they run
      expect(edge.split("\n").filter((l) => l === "G03*" || l === "G02*")).toHaveLength(5)
      expect(edge.split("\n").length).toBeLessThan(60)
      // the arc of the board: from (40, 0) to (40, 30) with its centre (40, 15): offset I0 J15
      expect(edge).toContain("X40000000Y30000000I0J15000000D01*")
      expect(gerberLayers(populated()).Edge_Cuts).toBe(edge)
    })

    it("the drill file routes the slot, from end to end, in the non-plated file", () => {
      const q = populated()
      expect(npthHoles(q)).toHaveLength(1)
      const drl = excellonDrill(q, { plated: false })
      expect(drl).toContain("T1C2.000")
      expect(drl).toContain("X28.000Y8.000G85X28.000Y22.000")
      const files = buildFabricationFiles(q)
      expect(Object.keys(files).some((f) => f.endsWith("-NPTH.drl"))).toBe(true)
      const notes = Object.entries(files).find(([k]) => k.endsWith("fabrication.txt"))![1]
      expect(notes).toMatch(/bounding box; outline of its own \(1 piece of board, 2 cutouts\), area/)
    })

    it("the KiCad export has the outline as KiCad's own lines and arcs, exactly, and no other outline", async () => {
      const { files, notes } = await kicadFiles(populated())
      const pcb = Object.entries(files).find(([k]) => k.endsWith(".kicad_pcb"))![1]
      const edge = [...pcb.matchAll(/\n {2}\(gr_(line|arc|curve)\b[\s\S]*?\n {2}\)/g)].map((m) => m[0]).filter((b) => /Edge\.Cuts/.test(b))
      // the board's 4 pieces, the circle's 2 arcs, the slot's 2 lines and 2 arcs
      expect(edge).toHaveLength(10)
      const arcs = edge.filter((b) => b.includes("(gr_arc"))
      expect(arcs).toHaveLength(5)
      // the board's arc, in KiCad's frame: x + 100, 100 - y
      const board = arcs.find((b) => b.includes("(start 140 100)"))!
      expect(board).toContain("(mid 155 85)")
      expect(board).toContain("(end 140 70)")
      expect(notes.join(" ")).toMatch(/Edge\.Cuts lines, arcs and curves, exactly/)
    })

    it("an outline-less board is written as it always was", () => {
      const p = populated({ ...createProject("plain") })
      expect(applyOutline("(kicad_pcb\n)", p).text).toBe("(kicad_pcb\n)")
    })

    it("Circuit JSON has the biggest piece as the outline, each cutout as a cutout, and says what it cannot hold", () => {
      const out = projectToCircuitJson(populated())
      const board = out.elements.find((e) => e.type === "pcb_board") as unknown as { outline: Vec2[]; width: number; height: number }
      expect(board.outline.length).toBeGreaterThan(20)
      expect(board.width).toBe(55)
      expect(out.elements.filter((e) => e.type === "pcb_cutout")).toHaveLength(2)
      expect(out.notes.join(" ")).toMatch(/arcs or curves/)
    })

    it("Sakura's picture draws the outline with its cutouts, and the numbers say what it is", () => {
      const q = populated()
      const svg = pcbSvg(q, { minX: -2, maxX: 58, minY: -2, maxY: 32 }, { width: 600, height: 300 }, { side: "top", extras: new Set() }, measurePcb(q))
      expect(svg).toContain('fill-rule="evenodd"')
      expect(svg).toContain("A15 15")
      expect(describePcb(measurePcb(q))[0]).toMatch(/Board 55 x 30 mm bounding box, an outline of its own \(1 piece of board, 2 cutouts, \d+(\.\d+)? cm2\)/)
    })

    it("saves and loads exactly, and compactly", () => {
      const q = populated()
      const text = serializeProject(q)
      const back = parseProjectFile(text, { id: "x" })
      expect(back.board).toEqual(q.board)
      expect(serializeProject(back)).toBe(text)
      expect(JSON.stringify(JSON.parse(text).project.board.ol).length).toBeLessThan(700)
    })
  })

  describe("a board that does not close", () => {
    const open = () => addOutlinePaths(populated(), [{ closed: false, segs: [{ kind: "line", a: P(2, 2), b: P(6, 2) }] }]).project
    it("refuses the exports that need it, with a message that says what to do", async () => {
      expect(() => gerberLayers(open())).toThrow(OutlineNotClosedError)
      expect(() => buildFabricationFiles(open())).toThrow(/outline is not closed \(1 piece of it ends in the open\)/)
      await expect(stepFile(open())).rejects.toThrow(/STEP model cannot be made/)
      const none = { ...populated(), board: { ...populated().board, outline: { paths: [] } } }
      expect(() => gerberLayers(none)).toThrow(/the board has no outline/)
      await expect(stepFile(none)).rejects.toThrow(/Draw one on the Edge\.Cuts layer/)
    })
    it("keeps its edges as drawn in the KiCad export, and Circuit JSON says it has none", async () => {
      const { files } = await kicadFiles(open())
      const pcb = Object.entries(files).find(([k]) => k.endsWith(".kicad_pcb"))![1]
      expect([...pcb.matchAll(/\(layer "Edge\.Cuts"\)/g)]).toHaveLength(11)
      expect(projectToCircuitJson(open()).notes.join(" ")).toMatch(/not closed/)
    })
  })
})

describe("the 3D board and the STEP solid", () => {
  afterEach(() => vi.unstubAllGlobals())
  const volume = (text: string, deflection = 0.002) => stepVolume(text, deflection)
  const step = (p: Project) => writeStep({ name: "t", board: stepBoard(p), models: [], placements: [] })

  it("the STEP solid is the outline extruded with its cutouts cut, to the volume the outline says", () => {
    const p = drawn()
    const out = step(p)
    expect(out.notes).toEqual([])
    const { volume: v } = volume(out.text)
    expect(v).toBeCloseTo(AREA * p.board.thickness, -1)
    expect(Math.abs(v / (AREA * p.board.thickness) - 1)).toBeLessThan(0.002)
  })

  it("a concave corner (an arc that bends into the board) and a panel of two pieces are solids too", () => {
    const notch: Path = {
      closed: true,
      segs: [
        { kind: "line", a: P(0, 0), b: P(20, 0) },
        { kind: "line", a: P(20, 0), b: P(20, 10) },
        // a half circle of radius 5 bitten out of the top edge, bulging down into the board
        { kind: "line", a: P(20, 10), b: P(15, 10) },
        { kind: "arc", start: P(15, 10), mid: P(10, 5), end: P(5, 10) },
        { kind: "line", a: P(5, 10), b: P(0, 10) },
        { kind: "line", a: P(0, 10), b: P(0, 0) },
      ],
    }
    const one = setOutlinePaths(createProject("n"), [notch])
    expect(Math.abs(volume(step(one).text).volume / ((200 - (Math.PI * 25) / 2) * one.board.thickness) - 1)).toBeLessThan(0.002)
    const panel = setOutlinePaths(createProject("p"), [notch, { closed: true, segs: [{ kind: "line", a: P(30, 0), b: P(40, 0) }, { kind: "line", a: P(40, 0), b: P(40, 10) }, { kind: "line", a: P(40, 10), b: P(30, 10) }, { kind: "line", a: P(30, 10), b: P(30, 0) }] }])
    const both = volume(step(panel).text)
    expect(both.solids).toBeGreaterThanOrEqual(2)
    expect(Math.abs(both.volume / ((200 - (Math.PI * 25) / 2 + 100) * panel.board.thickness) - 1)).toBeLessThan(0.002)
  })

  it("a drill through a cutout or off the board is left out and counted; one on the board is cut", () => {
    let p = drawn()
    p = addVia(p, P(15, 15), { locked: true }).project
    p = addVia(p, P(5, 5), { locked: true }).project
    const input = stepBoard(p)
    expect(input.holes.map((h) => h.region)).toEqual([-1, 0])
    expect(step(p).notes[0]).toMatch(/1 hole is left out of the board solid: 1 reaches the board edge/)
  })

  it("the 3D board is the outline's substrate with its cutouts cut, to the same volume", () => {
    const calls: unknown[] = []
    vi.stubGlobal("document", {
      createElement: () => ({
        width: 0,
        height: 0,
        getContext: () => new Proxy({}, { get: (_t, prop) => (prop === "canvas" ? {} : (...a: unknown[]) => void calls.push([prop, a])), set: () => true }),
      }),
    })
    const p = drawn()
    const built = buildBoard(p, [], createSharedMaterials(), 1)
    const substrate = built.group.getObjectByName("substrate") as THREE.Mesh
    const g = substrate.geometry
    const pos = g.attributes.position
    const idx = g.index
    const at = (i: number) => (idx ? idx.getX(i) : i)
    let v = 0
    const t = (i: number) => new THREE.Vector3(pos.getX(at(i)), pos.getY(at(i)), pos.getZ(at(i)))
    for (let i = 0; i < (idx ? idx.count : pos.count); i += 3) {
      const a = t(i)
      const b = t(i + 1)
      const c = t(i + 2)
      v += a.dot(b.clone().cross(c)) / 6
    }
    expect(Math.abs(Math.abs(v) / (AREA * p.board.thickness) - 1)).toBeLessThan(0.002)
    expect(built.group.getObjectByName("mask-top")).toBeTruthy()
  })
})

describe("Sakura draws the same board from scratch", () => {
  const start = () => {
    let p = createProject("tool")
    p = { ...p, board: { ...p.board, width: 50, height: 40, x: 0, y: 0, cornerRadius: 0 } }
    return p
  }
  const text = "M0 0 L40 0 A55 15 40 30 L0 30 Z"
  const made = () => {
    const out = runTool(start(), "set_board", { outline: text, add_cutouts: "O15 15 4 S28 8 28 22 2" })
    expect(out.isError).toBe(false)
    return out.project
  }

  it("sets an outline of lines and an arc, with a round cutout and a slot, exactly what the drawing gave", () => {
    const p = made()
    const q = drawn()
    expect(p.board.outline!.paths).toHaveLength(3)
    expect([p.board.width, p.board.height, p.board.x, p.board.y]).toEqual([q.board.width, q.board.height, q.board.x, q.board.y])
    expect(boardAreaMm2(p.board)).toBeCloseTo(AREA, 0)
    expect(gerberEdgeCuts(populated(p))).toBe(gerberEdgeCuts(populated(q)))
    expect(excellonDrill(populated(p), { plated: false })).toBe(excellonDrill(populated(q), { plated: false }))
  })

  it("get_design describes the outline compactly: the edge and each cutout, numbered", () => {
    const design = JSON.parse(runTool(populated(made()), "get_design", {}).result)
    expect(design.board_mm.outline).toBe("M0 0 L40 0 A55 15 40 30 L0 30 Z")
    expect(design.board_mm.cutouts).toHaveLength(2)
    expect(design.board_mm.cutouts[0]).toMatch(/^M/)
    expect(design.board_mm.outline_state).toBeUndefined()
    // a rectangle board says nothing new
    expect(JSON.parse(runTool(populated(start()), "get_design", {}).result).board_mm).toEqual({ width: 50, height: 40, thickness: 1.6, center_x: 0, center_y: 0 })
  })

  it("adds and removes cutouts by number, and goes back to the rectangle", () => {
    const p = made()
    const added = runTool(p, "set_board", { add_cutouts: "M5 5 L8 5 L8 8 Z" })
    expect(added.isError).toBe(false)
    expect(JSON.parse(runTool(added.project, "get_design", {}).result).board_mm.cutouts).toHaveLength(3)
    const removed = runTool(added.project, "set_board", { remove_cutouts: [0, 2] })
    expect(removed.isError).toBe(false)
    expect(JSON.parse(runTool(removed.project, "get_design", {}).result).board_mm.cutouts).toHaveLength(1)
    const rect = runTool(removed.project, "set_board", { outline: "rect" })
    expect(rect.project.board.outline).toBeUndefined()
  })

  it("says why it cannot", () => {
    const err = (input: Record<string, unknown>, p = made()) => {
      const o = runTool(p, "set_board", input)
      expect(o.isError).toBe(true)
      return o.result
    }
    expect(err({ outline: "M0 0 L1" })).toMatch(/L needs 2 numbers/)
    expect(err({ outline: "M0 0 L10 0" })).toMatch(/at least one closed shape/)
    expect(err({ add_cutouts: "O60 60 3" })).toMatch(/wholly inside the board/)
    expect(err({ add_cutouts: "O15 15 1" })).toMatch(/wholly inside the board/)
    expect(err({ add_cutouts: "M0 0 L1 0" })).toMatch(/closed shape/)
    expect(err({ remove_cutouts: [9] })).toMatch(/counts from 0 to 1/)
    expect(err({ width: 60, height: 40 })).toMatch(/has an outline of its own/)
    expect(err({ remove_cutouts: [0] }, start())).toMatch(/no cutouts/)
  })

  it("then everything the drawing was checked for holds: checks, files, solid", () => {
    const p = populated(made())
    expect(kinds(p, "outline")).toEqual([])
    expect(() => buildFabricationFiles(p)).not.toThrow()
    const out = writeStep({ name: "t", board: stepBoard(p), models: [], placements: [] })
    expect(Math.abs(stepVolume(out.text).volume / (AREA * p.board.thickness) - 1)).toBeLessThan(0.002)
    const back = parseProjectFile(serializeProject(p), { id: "x" })
    expect(back.board).toEqual(p.board)
    expect(boardAreaMm2(p.board)).toBeCloseTo(boardAreaMm2(drawn().board), 6)
  })
})
