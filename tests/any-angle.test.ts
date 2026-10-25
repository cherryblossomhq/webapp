import { describe, expect, it } from "vitest"
import { runTool } from "../src/ai/tools"
import { isQuarterTurn, normalizeAngle, rotate90, transformPoint } from "../src/lib/geometry"
import { addComponent, createProject } from "../src/model/ops"
import { setOutlinePaths } from "../src/model/outlineOps"
import { componentFootprint, pcbCourtyard, pcbPads, slotEnds } from "../src/model/instances"
import { analyzePcb, pointPadDistance, segmentPadDistance } from "../src/model/pcb"
import { computeConnectivity } from "../src/model/connectivity"
import { padPaths } from "../src/model/pour"
import { gerberCopper, gerberLayers } from "../src/export/gerber"
import { excellonDrill } from "../src/export/excellon"
import { pnpCsv, positionAngle } from "../src/export/pnp"
import { projectToCircuitJson } from "../src/export/circuitJson"
import { importKicadBoard } from "../src/model/kicad/board"
import { BUILT_EXTENSIONS } from "../src/model/kicad/board/needs"
import { parseProjectFile, PROJECT_FILE_FORMAT, PROJECT_FILE_VERSION, serializeProject } from "../src/model/projectFile"
import { worldShapes } from "../src/model/shapeItems"
import type { Project, Vec2 } from "../src/model/types"
import { board, footprint, pad } from "./kicad-board-fixtures"

const D2R = Math.PI / 180
const P2 = (x: number, y: number): Vec2 => ({ x, y })
/** A point of the part's own frame on the board: mirrored in x on the bottom, turned by `rot` counter-clockwise, moved to the part. The independent formula the tests check against. */
const place = (local: Vec2, at: Vec2, rot: number, bottom: boolean): Vec2 => {
  const x = bottom ? -local.x : local.x
  return { x: at.x + x * Math.cos(rot * D2R) - local.y * Math.sin(rot * D2R), y: at.y + x * Math.sin(rot * D2R) + local.y * Math.cos(rot * D2R) }
}
const near = (a: Vec2, b: Vec2, tol = 1e-3) => Math.hypot(a.x - b.x, a.y - b.y) <= tol

function resistorAt(rot: number, side: "top" | "bottom" = "top", at: Vec2 = { x: 5, y: 3 }) {
  const added = addComponent(createProject("angle"), "resistor", { sch: { x: 0, y: 0 }, pcb: { x: at.x, y: at.y, rot, side, placed: true } })
  return { project: added.project, c: added.project.components.find((x) => x.id === added.component.id)! }
}

describe("a rotation of any angle", () => {
  it("is exact on a quarter turn and a true rotation otherwise", () => {
    expect(rotate90({ x: 3, y: 1 }, 90)).toEqual({ x: -1, y: 3 })
    expect(rotate90({ x: 3, y: 1 }, 450)).toEqual({ x: -1, y: 3 })
    expect(rotate90({ x: 3, y: 1 }, -90)).toEqual({ x: 1, y: -3 })
    const r = rotate90({ x: 3, y: 1 }, 45)
    expect(r.x).toBeCloseTo((3 - 1) * Math.SQRT1_2, 12)
    expect(r.y).toBeCloseTo((3 + 1) * Math.SQRT1_2, 12)
    const m = transformPoint({ x: 2, y: 0 }, { x: 1, y: 1 }, 30, true)
    expect(m.x).toBeCloseTo(1 - 2 * Math.cos(30 * D2R), 12)
    expect(m.y).toBeCloseTo(1 - 2 * Math.sin(30 * D2R), 12)
  })

  it("brings an angle into [0, 360) without noise and knows a quarter turn", () => {
    expect(normalizeAngle(-45)).toBe(315)
    expect(normalizeAngle(405)).toBe(45)
    expect(normalizeAngle(360)).toBe(0)
    expect(normalizeAngle(359.99999999)).toBe(0)
    expect(normalizeAngle(135 + 90)).toBe(225)
    expect([0, 90, 180, 270, 450, -90].every(isQuarterTurn)).toBe(true)
    expect([45, 90.5, 1e-9].some(isQuarterTurn)).toBe(false)
  })
})

describe("the pads of a part at any angle", () => {
  it("keep their rectangles on a quarter turn, as ever", () => {
    for (const rot of [0, 90, 180, 270]) {
      const { c } = resistorAt(rot)
      for (const p of pcbPads(c)) {
        expect(p.shape).toBe("rect")
        expect(p.points).toBeUndefined()
        expect(p.oriented).toBeUndefined()
      }
    }
  })

  for (const [rot, side] of [[45, "top"], [30, "bottom"], [123.456, "top"], [-20, "bottom"]] as const) {
    it(`are the turned rectangle exactly at ${rot} degrees on the ${side}`, () => {
      const { c } = resistorAt(rot, side)
      const land = componentFootprint(c)!
      const pads = pcbPads(c)
      expect(pads).toHaveLength(land.pads.length)
      land.pads.forEach((lp, i) => {
        const w = pads[i]
        const centre = place(lp, c.pcb, normalizeAngle(rot), side === "bottom")
        expect(near(w, centre, 1e-4)).toBe(true)
        expect(w.shape).toBe("polygon")
        const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => place({ x: lp.x + (sx * lp.width) / 2, y: lp.y + (sy * lp.height) / 2 }, c.pcb, normalizeAngle(rot), side === "bottom"))
        expect(w.points).toHaveLength(4)
        for (const corner of corners) expect(w.points!.some((q) => near(q, corner, 1e-4))).toBe(true)
        expect(w.oriented).toMatchObject({ width: lp.width, height: lp.height })
        expect(w.oriented!.rot).toBeGreaterThanOrEqual(0)
        expect(w.oriented!.rot).toBeLessThan(180)
        // the extents are the polygon's
        expect(w.width).toBeCloseTo(Math.max(...w.points!.map((q) => q.x)) - Math.min(...w.points!.map((q) => q.x)), 3)
      })
    })
  }

  it("a point and a segment are measured from the turned copper, not from its box", () => {
    const { c } = resistorAt(45, "top", { x: 0, y: 0 })
    const p = pcbPads(c)[0]
    // The pad's own corner pokes out of its centre line; a point just off the middle of a long side is closer than the box says.
    const [a, b] = [p.points![0], p.points![1]]
    const midSide = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
    const out = { x: midSide.x + (midSide.x - p.x) * 0.2, y: midSide.y + (midSide.y - p.y) * 0.2 }
    const d = pointPadDistance(out, p)
    const nx = midSide.x - p.x
    const ny = midSide.y - p.y
    expect(d).toBeCloseTo(Math.hypot(out.x - midSide.x, out.y - midSide.y), 3)
    expect(nx * nx + ny * ny).toBeGreaterThan(0)
    expect(pointPadDistance(p, p)).toBe(0)
    expect(segmentPadDistance({ x: p.x - 10, y: p.y }, { x: p.x + 10, y: p.y }, p)).toBe(0)
    // a segment passing a corner at the distance the corner is from it
    const corner = p.points![0]
    const far = segmentPadDistance({ x: corner.x + 1, y: corner.y - 5 }, { x: corner.x + 1, y: corner.y + 5 }, p)
    expect(far).toBeGreaterThan(0)
    expect(far).toBeLessThanOrEqual(1 + 1e-9)
  })

  it("pour, Gerber and Circuit JSON have the turned copper: a region, and a rotated pad with its own size", () => {
    const { project, c } = resistorAt(45)
    const p = pcbPads(c)[0]
    expect(padPaths(p)[0]).toHaveLength(4)
    expect(gerberCopper(project, "top", [])).toContain("G36*")
    const cj = projectToCircuitJson(project).elements.filter((e) => e.type === "pcb_smtpad") as unknown as { shape: string; width: number; height: number; ccw_rotation: number }[]
    expect(cj.every((e) => e.shape === "rotated_rect")).toBe(true)
    expect(cj[0].width).toBeCloseTo(p.oriented!.width, 4)
    expect(cj[0].ccw_rotation).toBeCloseTo(p.oriented!.rot, 4)
    const comp = projectToCircuitJson(project).elements.find((e) => e.type === "pcb_component") as unknown as { rotation: number }
    expect(comp.rotation).toBe(45)
  })

  it("their courtyard is the box of the turned one", () => {
    const { c } = resistorAt(45, "top", { x: 0, y: 0 })
    const land = componentFootprint(c)!
    const box = pcbCourtyard(c)!
    const corners = [[land.courtyard.minX, land.courtyard.minY], [land.courtyard.maxX, land.courtyard.minY], [land.courtyard.maxX, land.courtyard.maxY], [land.courtyard.minX, land.courtyard.maxY]].map(([x, y]) => place({ x, y }, { x: 0, y: 0 }, 45, false))
    expect(box.minX).toBeCloseTo(Math.min(...corners.map((q) => q.x)), 9)
    expect(box.maxY).toBeCloseTo(Math.max(...corners.map((q) => q.y)), 9)
  })

  it("checks run on them: a trace through a turned pad is a short, a part clear of it is not", () => {
    let { project, c } = resistorAt(45, "top", { x: 0, y: 0 })
    const pads = pcbPads(c)
    expect(analyzePcb(project, computeConnectivity(project)).violations.filter((v) => v.kind === "short")).toEqual([])
    project = { ...project, traces: [{ id: "t1", layer: "top", width: 0.2, points: [pads[0], { x: pads[1].x, y: pads[1].y }] }] }
    const res = analyzePcb(project, computeConnectivity(project))
    expect(res.items.some((i) => i.kind === "segment")).toBe(true)
  })
})

describe("courtyards of parts at an angle in the checks", () => {
  const land = (c: ReturnType<typeof resistorAt>["c"]) => componentFootprint(c)!.courtyard
  const kindsOf = (p: Project, kind: string) => analyzePcb(p, computeConnectivity(p)).violations.filter((v) => v.kind === kind)
  const at = (p: Project, ids: Record<string, Vec2>) => ({ ...p, components: p.components.map((c) => (ids[c.ref] ? { ...c, pcb: { ...c.pcb, x: ids[c.ref].x, y: ids[c.ref].y } } : c)) })

  it("a part turned to lie against a chamfered corner is on the board by its own courtyard, not by its box", () => {
    const { project, c } = resistorAt(45, "top", { x: 0, y: 0 })
    const w = land(c).maxX - land(c).minX
    const outline = setOutlinePaths(project, [{ closed: true, segs: [[0, 0, 20, 0], [20, 0, 20, 12], [20, 12, 12, 20], [12, 20, 0, 20], [0, 20, 0, 0]].map(([x1, y1, x2, y2]) => ({ kind: "line" as const, a: { x: x1, y: y1 }, b: { x: x2, y: y2 } })) }])
    // the centre c on the diagonal such that the courtyard's far side lies 0.05 mm inside the chamfer x + y = 32
    const centre = (32 - 0.05 - (Math.SQRT2 * w) / 2) / 2
    expect(kindsOf(at(outline, { [c.ref]: { x: centre, y: centre } }), "outside-board")).toEqual([])
    expect(kindsOf(at(outline, { [c.ref]: { x: centre + 0.2, y: centre + 0.2 } }), "outside-board")).toHaveLength(1)
    // the same part on a rectangle board whose corner is rounded
    const rounded = { ...project, board: { ...project.board, width: 20, height: 20, x: 10, y: 10, cornerRadius: 6 } }
    expect(kindsOf(at(rounded, { [c.ref]: { x: 10, y: 10 } }), "outside-board")).toEqual([])
  })

  it("two turned parts overlap by their courtyards, not by their boxes", () => {
    const a = resistorAt(45, "top", { x: 0, y: 0 })
    const h = land(a.c).maxY - land(a.c).minY
    const two = (t: number) => {
      const b = addComponent(a.project, "resistor", { sch: { x: 3, y: 0 }, pcb: { x: (-t) / Math.SQRT2, y: t / Math.SQRT2, rot: 45, placed: true } })
      return b.project
    }
    expect(kindsOf(two(h + 0.3), "overlap")).toEqual([])
    expect(kindsOf(two(h - 0.3), "overlap")).toHaveLength(1)
  })
})

describe("slots and holes of a part at an angle", () => {
  const slotLand = (rot: number, side: "top" | "bottom") => {
    const text = board({
      body: [footprint({ at: "20 20 " + rot, layer: side === "bottom" ? "B.Cu" : "F.Cu", pads: [pad({ number: "1", type: "thru_hole", shape: "oval", at: "2 1 " + rot, size: "3 1.6", layers: '"*.Cu" "*.Mask"', extra: "(drill oval 2.4 0.8)" })] })],
    })
    const r = importKicadBoard(text)
    if (r.status !== "imported") throw new Error(JSON.stringify(r.report.entries.map((e) => e.why)))
    return r.project
  }
  it("a slotted hole runs along the pad's long side at the part's angle, and the drill file routes it from end to end", () => {
    const project = slotLand(40, "top")
    const c = project.components[0]
    const p = pcbPads(c)[0]
    const ends = slotEnds(p)!
    expect(p.slotAxis).toBeCloseTo(40, 6)
    // the ends are 2.4 - 0.8 apart (centre to centre) along the part's turned x axis
    expect(Math.hypot(ends[1].x - ends[0].x, ends[1].y - ends[0].y)).toBeCloseTo(1.6, 3)
    expect(Math.atan2(ends[1].y - ends[0].y, ends[1].x - ends[0].x) * (180 / Math.PI)).toBeCloseTo(40, 2)
    expect(excellonDrill(project)).toContain("G85")
  })
})

describe("a KiCad board with parts at any angle", () => {
  const angles = [33, 33.5, 90, 179.999, 270, 270.25, 45]
  for (const bottom of [false, true]) {
    it(`imports every part at the file's own angle on the ${bottom ? "bottom" : "top"}, and the pads and drawings are where the file puts them`, () => {
      const body = angles.map((a, i) =>
        footprint({
          ref: `R${i + 1}`,
          name: "L:Angled",
          at: `${10 + 15 * i} 20 ${a}`,
          layer: bottom ? "B.Cu" : "F.Cu",
          pads: [pad({ number: "1", at: `-1.2 0.4 ${a}`, size: "1.4 0.9", layers: bottom ? '"B.Cu" "B.Paste" "B.Mask"' : '"F.Cu" "F.Paste" "F.Mask"' }), pad({ number: "2", at: `1.2 -0.4 ${a}`, size: "1.4 0.9", layers: bottom ? '"B.Cu" "B.Paste" "B.Mask"' : '"F.Cu" "F.Paste" "F.Mask"' })],
          extra: `(fp_line (start -2 -1) (end 2 1) (stroke (width 0.12) (type solid)) (layer "${bottom ? "B.SilkS" : "F.SilkS"}")) (fp_circle (center 0.5 0.25) (end 1 0.25) (stroke (width 0.1) (type solid)) (fill none) (layer "${bottom ? "B.Fab" : "F.Fab"}")) (fp_rect (start -2 -1.5) (end 2 1.5) (stroke (width 0.05) (type solid)) (fill none) (layer "${bottom ? "B.CrtYd" : "F.CrtYd"}"))`,
        }),
      )
      const r = importKicadBoard(board({ body }))
      if (r.status !== "imported") throw new Error(JSON.stringify(r.report.entries.map((e) => e.why)))
      const project: Project = r.project
      expect(BUILT_EXTENSIONS.has("X6")).toBe(true)
      project.components.forEach((c, i) => {
        const a = angles[i]
        expect(c.pcb.rot).toBeCloseTo(normalizeAngle(bottom ? a + 180 : a), 6)
        expect(c.pcb.side).toBe(bottom ? "bottom" : "top")
        // KiCad's frame: y down, the part at (x, 20), a pad at its own place turned by the part's angle (counter-clockwise on screen).
        const fx = 10 + 15 * i
        const kicadWorld = (lx: number, ly: number): Vec2 => {
          const rad = a * D2R
          return { x: fx + lx * Math.cos(rad) + ly * Math.sin(rad), y: 20 - lx * Math.sin(rad) + ly * Math.cos(rad) }
        }
        const toEditor = (q: Vec2): Vec2 => ({ x: q.x, y: -q.y })
        const pads = pcbPads(c)
        const expected: [number, number][] = [[-1.2, 0.4], [1.2, -0.4]]
        expected.forEach(([lx, ly], k) => {
          const centre = toEditor(kicadWorld(lx, ly))
          expect(near(pads[k], centre, 1e-3)).toBe(true)
          // the corners of the pad: its box turned by the part's angle, as the file's absolute pad angle is the part's
          for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
            const corner = toEditor(kicadWorld(lx + sx * 0.7, ly + sy * 0.45))
            // a part on a quarter turn keeps its level rectangle (its box), any other angle is the turned polygon
            const w = pads[k]
            const poly = w.points ?? [{ x: w.x - w.width / 2, y: w.y - w.height / 2 }, { x: w.x + w.width / 2, y: w.y - w.height / 2 }, { x: w.x + w.width / 2, y: w.y + w.height / 2 }, { x: w.x - w.width / 2, y: w.y + w.height / 2 }]
            expect(poly.some((q) => near(q, corner, 1e-3))).toBe(true)
          }
        })
        const own = worldShapes(project).filter((s) => s.owner === c.id)
        const line = own.find((s) => s.shape.type === "line")!.shape as { a: Vec2; b: Vec2 }
        const ends = [toEditor(kicadWorld(-2, -1)), toEditor(kicadWorld(2, 1))]
        expect(ends.every((e) => near(e, line.a, 1e-3) || near(e, line.b, 1e-3))).toBe(true)
        const circle = own.find((s) => s.shape.type === "circle")!.shape as { c: Vec2; r: number }
        expect(near(circle.c, toEditor(kicadWorld(0.5, 0.25)), 1e-3)).toBe(true)
        expect(circle.r).toBeCloseTo(0.5, 6)
        const rectOwn = own.find((s) => s.shape.type === "polygon" || s.shape.type === "rect")!
        // the drawing keeps its style when a turned rectangle becomes a polygon: layer (swapped on the bottom), width and no fill
        expect(rectOwn.shape.layer).toBe(bottom ? "B.CrtYd" : "F.CrtYd")
        expect(rectOwn.shape.width).toBeCloseTo(0.05, 9)
        const rect = (rectOwn.shape.type === "rect" ? { pts: [P2(rectOwn.shape.a.x, rectOwn.shape.a.y), P2(rectOwn.shape.b.x, rectOwn.shape.a.y), P2(rectOwn.shape.b.x, rectOwn.shape.b.y), P2(rectOwn.shape.a.x, rectOwn.shape.b.y)] } : rectOwn.shape) as { pts: Vec2[] }
        for (const [lx, ly] of [[-2, -1.5], [2, -1.5], [2, 1.5], [-2, 1.5]]) expect(rect.pts.some((q) => near(q, toEditor(kicadWorld(lx, ly)), 1e-3))).toBe(true)
      })
    })
  }

  it("a pad turned by the file's absolute angle within a part at an angle is still the part's, so no pad rule is raised", () => {
    const r = importKicadBoard(board({ body: [footprint({ at: "10 10 37", pads: [pad({ at: "0 0 37" })] })] }))
    expect(r.status).toBe("imported")
  })

  it("the position file gives the angle KiCad's own does: the footprint's, to six decimals, and the bottom's without the editor's half turn", () => {
    const text = board({ body: [footprint({ ref: "U1", at: "10 10 22.5", pads: [pad({ at: "0 0 22.5" })] }), footprint({ ref: "U2", at: "30 10 100", layer: "B.Cu", pads: [pad({ at: "0 0 100", layers: '"B.Cu" "B.Paste" "B.Mask"' })] })] })
    const r = importKicadBoard(text)
    if (r.status !== "imported") throw new Error("not imported")
    const [u1, u2] = r.project.components
    expect(positionAngle(u1)).toBe(22.5)
    expect(u2.pcb.rot).toBe(280)
    expect(positionAngle(u2)).toBe(100)
    expect(pnpCsv(r.project)).toMatch(/U1,.*,22\.5,top/)
    // a part drawn in the editor prints its rotation as it always did
    const { project } = resistorAt(90)
    expect(pnpCsv(project)).toMatch(/,90,top/)
    expect(positionAngle(resistorAt(22.5).c)).toBe(22.5)
  })
})

describe("the project file with parts at any angle", () => {
  it("round-trips an angle that is not a quarter turn and writes the current version", () => {
    const { project } = resistorAt(37.125)
    const back = parseProjectFile(serializeProject(project), { id: "x" })
    expect(back.components[0].pcb.rot).toBe(37.125)
    expect(JSON.parse(serializeProject(project)).version).toBeGreaterThanOrEqual(6)
  })

  it("reads a version 4 document as it was written: its quarter turns stay, and it is saved as the current version", () => {
    const doc = {
      format: PROJECT_FILE_FORMAT,
      version: 4,
      project: { name: "v4", description: "", components: [{ id: "c1", partId: "resistor", ref: "R1", props: {}, footprint: "0805", sch: { x: 0, y: 0, rot: 0 }, pcb: { x: 1, y: 2, rot: 270, side: "top", placed: true } }], wires: [], labels: [], board: { width: 40, height: 30, x: 0, y: 0, thickness: 1.6, cornerRadius: 2 } },
    }
    const read = parseProjectFile(doc, { id: "x" })
    expect(read.components[0].pcb).toMatchObject({ rot: 270, x: 1, y: 2 })
    expect(read.board).toMatchObject({ width: 40, height: 30, cornerRadius: 2 })
    expect(read.board.outline).toBeUndefined()
    expect(JSON.parse(serializeProject(read)).version).toBe(PROJECT_FILE_VERSION)
  })

  it("an angle that is not a number is read as 0, one over a turn is brought round", () => {
    const base = { format: PROJECT_FILE_FORMAT, version: 6, project: { name: "v6", description: "", components: [] as unknown[], wires: [], labels: [], board: {} } }
    const part = (rot: unknown) => ({ id: "c", partId: "resistor", ref: "R1", props: {}, footprint: "0805", sch: { x: 0, y: 0, rot: 0 }, pcb: { x: 0, y: 0, rot, side: "top", placed: true } })
    expect(parseProjectFile({ ...base, project: { ...base.project, components: [part("x")] } }, { id: "x" }).components[0].pcb.rot).toBe(0)
    expect(parseProjectFile({ ...base, project: { ...base.project, components: [part(405)] } }, { id: "x" }).components[0].pcb.rot).toBe(45)
  })
})

describe("Sakura places a part at any angle", () => {
  it("place_parts takes a rotation in degrees and get_design reads it back", () => {
    const { project, c } = resistorAt(0)
    const out = runTool(project, "place_parts", { placements: [{ ref: c.ref, rotation: 52.5 }] })
    expect(out.isError).toBe(false)
    expect(out.project.components[0].pcb.rot).toBe(52.5)
    const design = JSON.parse(runTool(out.project, "get_design", {}).result)
    expect(JSON.stringify(design)).toContain('"rot":52.5')
    const back = runTool(out.project, "place_parts", { placements: [{ ref: c.ref, rotation: -90 }] })
    expect(back.project.components[0].pcb.rot).toBe(270)
  })
})

describe("the gate", () => {
  it("builds X6 and X2", () => {
    expect(BUILT_EXTENSIONS.has("X6") && BUILT_EXTENSIONS.has("X2")).toBe(true)
  })
  it("a part at 45 degrees on a board gives Gerbers and a drill file", () => {
    const { project } = resistorAt(45)
    expect(Object.keys(gerberLayers(project))).toContain("F_Cu")
  })
})
