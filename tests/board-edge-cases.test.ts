import { describe, expect, it } from "vitest"
import { runTool } from "../src/ai/tools"
import { pcbToolSpecs } from "../src/ai/pcbTools"
import { excellonDrill } from "../src/export/excellon"
import { gerberLayers, gerberMask, gerberPaste, offsetConvexRing } from "../src/export/gerber"
import { OutlineNotClosedError, requireClosedOutline } from "../src/export/outlineGuard"
import { projectToCircuitJson } from "../src/export/circuitJson"
import { mountingHoles } from "../src/model/board"
import { computeConnectivity } from "../src/model/connectivity"
import { projectFromCircuitJson } from "../src/model/circuitJsonImport"
import { pcbPads } from "../src/model/instances"
import { importKicadBoard } from "../src/model/kicad/board"
import { addComponent, createProject } from "../src/model/ops"
import { outlineCrossings } from "../src/model/outlineCrossing"
import { addOutlinePaths, addSlot, circlePath, removeOutlinePath, resetOutline, setOutlinePaths, slotPath } from "../src/model/outlineOps"
import { parseOutlineText } from "../src/model/outlineText"
import { analyzePcb } from "../src/model/pcb"
import { placeDesignators } from "../src/model/silk"
import type { Project, Vec2 } from "../src/model/types"
import { built } from "./built"
import { board as kicadBoard } from "./kicad-board-fixtures"

const drc = (p: Project) => analyzePcb(p, computeConnectivity(p)).violations

/** How many holes of this drill size the plated drill file lists. */
const holeCount = (p: Project, drill: number) => {
  const lines = excellonDrill(p).split("\n")
  const size = `C${drill.toFixed(3)}`
  const toolLine = lines.find((l) => /^T\d+C/.test(l) && l.endsWith(size))
  if (!toolLine) return 0
  const tool = toolLine.slice(0, -size.length)
  let n = 0
  for (let i = lines.indexOf(tool, lines.indexOf("G05")) + 1; i < lines.length && /^X/.test(lines[i]); i++) n++
  return n
}

const polyPath = (pts: [number, number][]) => ({
  closed: true,
  segs: pts.map(([x, y], i) => ({ kind: "line" as const, a: { x, y }, b: { x: pts[(i + 1) % pts.length][0], y: pts[(i + 1) % pts.length][1] } })),
})

describe("the corner mounting holes of a board with a cutout or a slot", () => {
  it("stay while the rectangle is the board: a slot on the regulator leaves 4 holes in the drill file", () => {
    const p = built("regulator")
    const drill = p.board.mountingHoles!.drill
    expect(holeCount(p, drill)).toBe(4)
    const r = runTool(p, "set_board", { add_cutouts: `S ${p.board.x - 5} ${p.board.y} ${p.board.x + 5} ${p.board.y} 2` })
    expect(r.isError).toBeFalsy()
    const q = r.project
    expect(q.board.outline?.seed).toBe(true)
    expect(mountingHoles(q.board)).toHaveLength(4)
    expect(holeCount(q, drill)).toBe(4)
    expect(mountingHoles(q.board).map((h) => [h.x, h.y])).toEqual(mountingHoles(p.board).map((h) => [h.x, h.y]))
    expect(() => gerberLayers(q)).not.toThrow()
  })

  it("stay after addSlot, and after the last cutout goes the board is the rectangle again with its holes", () => {
    const p = built("regulator")
    const q = addSlot(p, { x: p.board.x - 4, y: p.board.y }, { x: p.board.x + 4, y: p.board.y }, 2)
    expect(mountingHoles(q.board)).toHaveLength(4)
    const back = removeOutlinePath(q, 1)
    expect(back.board.outline).toBeUndefined()
    expect(mountingHoles(back.board)).toHaveLength(4)
  })

  it("go when a closed shape that reaches outside replaces the rectangle", () => {
    const p = built("regulator")
    const far = circlePath({ x: p.board.x + p.board.width, y: p.board.y }, 5)
    const res = addOutlinePaths(p, [far])
    expect(res.replacedRectangle).toBe(true)
    expect(mountingHoles(res.project.board)).toEqual([])
  })

  it("set_board says so when its own outline takes the rectangle and the holes with it", () => {
    const p = built("regulator")
    const r = runTool(p, "set_board", { outline: "M0 0 L30 0 L30 20 L0 20 Z" })
    expect(r.isError).toBeFalsy()
    expect(mountingHoles(r.project.board)).toEqual([])
    expect(JSON.stringify(r)).toMatch(/corner mounting holes were removed with the rectangle/)
  })
})

describe("back to a rectangle", () => {
  it("restores the rounding the board had", () => {
    const p0 = built("regulator")
    const p = { ...p0, board: { ...p0.board, cornerRadius: 2 } }
    const q = addSlot(p, { x: p.board.x - 4, y: p.board.y }, { x: p.board.x + 4, y: p.board.y }, 2)
    expect(q.board.cornerRadius).toBe(0)
    expect(resetOutline(q).board.cornerRadius).toBe(2)
    expect(resetOutline(q).board.outline).toBeUndefined()
    expect(removeOutlinePath(q, 1).board.cornerRadius).toBe(2)
    const t = runTool(q, "set_board", { outline: "rect" })
    expect(t.project.board.cornerRadius).toBe(2)
  })
})

describe("an outline that crosses itself or another loop", () => {
  const bow = "M0 0 L10 0 L0 10 L10 10 Z"
  const bowTie = () => setOutlinePaths(createProject("bow"), [polyPath([[0, 0], [10, 0], [0, 10], [10, 10]])])

  it("is found: a bow tie, overlapping circles, a shape across another; and not nested or apart", () => {
    expect(outlineCrossings([polyPath([[0, 0], [10, 0], [0, 10], [10, 10]])])[0]).toMatchObject({ kind: "self", at: { x: 5, y: 5 } })
    const bad = [circlePath({ x: 10, y: 10 }, 3), circlePath({ x: 11, y: 10 }, 3)]
    expect(outlineCrossings(bad)).toHaveLength(1)
    expect(outlineCrossings(bad)[0].kind).toBe("cross")
    const sq = (x: number, y: number, s: number) => polyPath([[x, y], [x + s, y], [x + s, y + s], [x, y + s]])
    expect(outlineCrossings([sq(0, 0, 10), sq(5, 5, 10)])).toHaveLength(1)
    expect(outlineCrossings([sq(0, 0, 10), sq(2, 2, 3)])).toEqual([])
    expect(outlineCrossings([sq(0, 0, 10), sq(20, 0, 10)])).toEqual([])
    expect(outlineCrossings([sq(0, 0, 10), circlePath({ x: 5, y: 5 }, 3), slotPath({ x: 2, y: 9 }, { x: 8, y: 9 }, 1)])).toEqual([])
  })

  it("is refused by the outline text, with the reason", () => {
    expect(parseOutlineText(bow)).toMatchObject({ error: expect.stringMatching(/crosses itself/) })
    expect(parseOutlineText("O 10 10 3 O 11 10 3")).toMatchObject({ error: expect.stringMatching(/cross each other/) })
    expect(parseOutlineText("M0 0 L10 0 L10 10 L0 10 Z M5 5 L15 5 L15 15 L5 15 Z")).toMatchObject({ error: expect.stringMatching(/cross each other/) })
  })

  it("is refused by Sakura's set_board outline and add_cutouts, and the board is left as it was", () => {
    const p = built("regulator")
    const a = runTool(p, "set_board", { outline: bow })
    expect(a.isError).toBe(true)
    expect(JSON.stringify(a)).toMatch(/crosses itself/)
    const b = runTool(p, "set_board", { add_cutouts: "O 10 10 3 O 11 10 3" })
    expect(b.isError).toBe(true)
    expect(JSON.stringify(b)).toMatch(/cross each other/)
    const withCut = runTool(p, "set_board", { add_cutouts: `O ${p.board.x} ${p.board.y} 3` })
    expect(withCut.isError).toBeFalsy()
    const c = runTool(withCut.project, "set_board", { add_cutouts: `O ${p.board.x + 1} ${p.board.y} 3` })
    expect(c.isError).toBe(true)
  })

  it("is refused when drawn on Edge.Cuts: the outline stays as it was", () => {
    const p = built("regulator")
    const first = addOutlinePaths(p, [circlePath({ x: p.board.x, y: p.board.y }, 3)])
    const second = addOutlinePaths(first.project, [circlePath({ x: p.board.x + 1, y: p.board.y }, 3)])
    expect(second.crossing).toMatch(/cross each other/)
    expect(second.project).toBe(first.project)
    const slot = addOutlinePaths(first.project, [slotPath({ x: p.board.x + 1, y: p.board.y }, { x: p.board.x + 4, y: p.board.y }, 2)])
    expect(slot.crossing).toBeTruthy()
  })

  it("is an outline error in the checks and stops the exports with a sentence", () => {
    const fine = setOutlinePaths(createProject("sq"), [polyPath([[0, 0], [10, 0], [10, 10], [0, 10]])])
    expect(drc(fine).filter((v) => v.kind === "outline")).toEqual([])
    const errs = drc(bowTie()).filter((v) => v.kind === "outline")
    expect(errs).toHaveLength(1)
    expect(errs[0].severity).toBe("error")
    expect(errs[0].message).toMatch(/crosses itself/)
    expect(() => requireClosedOutline(bowTie(), "The Gerber and drill files")).toThrow(OutlineNotClosedError)
    expect(() => requireClosedOutline(bowTie(), "The Gerber and drill files")).toThrow(/The Gerber and drill files cannot be made: the board outline crosses itself/)
    expect(() => gerberLayers(bowTie())).toThrow(/crosses itself/)
  })

  it("imports from KiCad as drawn, with the checks' error and a report note, not a refusal", () => {
    const outline = `(gr_poly (pts (xy 0 0) (xy 10 0) (xy 0 10) (xy 10 10)) (stroke (width 0.1) (type default)) (fill none) (layer "Edge.Cuts"))`
    const r = importKicadBoard(kicadBoard({ outline }))
    expect(r.status).toBe("imported")
    if (r.status !== "imported") return
    expect(r.project.board.outline?.paths).toHaveLength(1)
    expect(r.report.entries.some((e) => e.code === "outline-crossing" && /crosses itself/.test(e.why))).toBe(true)
    expect(drc(r.project).some((v) => v.kind === "outline" && v.severity === "error")).toBe(true)
  })
})

describe("the mask and paste opening of a pad at any angle", () => {
  const at: Vec2 = { x: 5, y: 3 }
  const make = (rot: number, rules: Partial<Project["rules"]>) => {
    const added = addComponent(createProject("angle"), "resistor", { sch: { x: 0, y: 0 }, pcb: { x: at.x, y: at.y, rot, side: "top", placed: true } })
    const p = { ...added.project, rules: { ...added.project.rules, ...rules } }
    return { p, c: p.components[0] }
  }
  const D2R = Math.PI / 180
  const turn = (v: Vec2, rot: number): Vec2 => ({ x: at.x + v.x * Math.cos(rot * D2R) - v.y * Math.sin(rot * D2R), y: at.y + v.x * Math.sin(rot * D2R) + v.y * Math.cos(rot * D2R) })
  const regions = (g: string): Vec2[][] => {
    const out: Vec2[][] = []
    let cur: Vec2[] | null = null
    for (const l of g.split("\n")) {
      if (l === "G36*") cur = []
      else if (l === "G37*") {
        out.push(cur!)
        cur = null
      } else if (cur) {
        const m = /^X(-?\d+)Y(-?\d+)D0[12]\*$/.exec(l)
        if (m) cur.push({ x: Number(m[1]) / 1e6, y: Number(m[2]) / 1e6 })
      }
    }
    return out
  }
  const area = (r: Vec2[]) => Math.abs(r.reduce((s, p, i) => s + p.x * r[(i + 1) % r.length].y - r[(i + 1) % r.length].x * p.y, 0) / 2)
  const flashed = (g: string) => [...g.matchAll(/%ADD\d+R,([\d.]+)X([\d.]+)\*%/g)].map((m) => [Number(m[1]), Number(m[2])])
  const centre = (r: Vec2[]) => ({ x: r.reduce((s, q) => s + q.x, 0) / r.length, y: r.reduce((s, q) => s + q.y, 0) / r.length })

  it.each([
    ["paste shrunk", -0.05, "paste"],
    ["paste grown", 0.1, "paste"],
    ["mask grown", 0.08, "mask"],
    ["mask shrunk", -0.04, "mask"],
  ] as const)("%s: a part at 33 degrees gets the opening it has at 0, turned", (_n, g, kind) => {
    const rules = kind === "paste" ? { pasteExpansion: g } : { maskExpansion: g }
    const out = (p: Project) => (kind === "paste" ? gerberPaste(p, "top") : gerberMask(p, "top"))
    const flat = make(0, rules)
    const [w, h] = flashed(out(flat.p))[0]
    const base = pcbPads(flat.c)[0]
    expect(w).toBeCloseTo(base.width + 2 * g, 5)
    expect(h).toBeCloseTo(base.height + 2 * g, 5)
    const rs = regions(out(make(33, rules).p))
    expect(rs).toHaveLength(2)
    // The first pad: the opening it has at 0 degrees, its corners turned about the part.
    const local = { x: base.x - at.x, y: base.y - at.y }
    const expected = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => turn({ x: local.x + (sx * w) / 2, y: local.y + (sy * h) / 2 }, 33))
    const want = centre(expected)
    const first = rs.find((r) => Math.hypot(centre(r.slice(0, 4)).x - want.x, centre(r.slice(0, 4)).y - want.y) < 1e-3)!
    expect(first).toBeTruthy()
    expect(area(first)).toBeCloseTo(w * h, 3)
    for (const e of expected) expect(first.some((q) => Math.hypot(q.x - e.x, q.y - e.y) < 3e-4)).toBe(true)
    // Mitred like a rectangle's: the pad's four corners and the closing point, no rounded corners.
    expect(first).toHaveLength(5)
  })

  it("the quarter turn is the same opening, swapped", () => {
    const g = -0.05
    const [w, h] = flashed(gerberPaste(make(90, { pasteExpansion: g }).p, "top"))[0]
    const base = pcbPads(make(0, {}).c)[0]
    expect([w, h].map((x) => Number(x.toFixed(4)))).toEqual([base.height + 2 * g, base.width + 2 * g].map((x) => Number(x.toFixed(4))))
  })

  it("a shrink past the pad's size leaves no opening; a ring with a dent is left to the old way", () => {
    expect(offsetConvexRing([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }], -0.6)).toEqual([])
    expect(offsetConvexRing([{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 4 }, { x: 2, y: 1 }, { x: 0, y: 4 }], 0.1)).toBeNull()
    const grown = offsetConvexRing([{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 1 }, { x: 0, y: 1 }], 0.25)!
    expect(grown.map((p) => [p.x, p.y])).toEqual([[-0.25, -0.25], [2.25, -0.25], [2.25, 1.25], [-0.25, 1.25]])
  })
})

describe("place_parts and a rotation that is not a number", () => {
  it("is refused with a message", () => {
    const p = built("regulator")
    const ref = p.components.find((c) => c.pcb.placed && !c.ref.startsWith("#"))!.ref
    for (const rotation of [Number.NaN, Number.POSITIVE_INFINITY, "left"]) {
      const r = runTool(p, "place_parts", { placements: [{ ref, rotation }] })
      expect(r.summary).toMatch(/rotation must be a number/)
      expect(r.project).toBe(p)
      // and the tool itself, run with no validation in front of it, refuses it too and moves nothing
      const spec = pcbToolSpecs.find((t) => t.name === "place_parts")!
      const direct = spec.run(p, { placements: [{ ref, x: 1, y: 1, rotation }] } as never)
      expect(direct.result).toMatch(/rotation must be a number of degrees/)
      expect(direct.project.components.find((c) => c.ref === ref)!.pcb).toEqual(p.components.find((c) => c.ref === ref)!.pcb)
    }
  })
})

describe("the designator of a part at another angle", () => {
  it("is placed by the part's real angle: near 90 as on 90, near 270 as on 270, near 0 as on 0", () => {
    const sideOf = (rot: number) => {
      const added = addComponent(createProject("d"), "resistor", { sch: { x: 0, y: 0 }, pcb: { x: 0, y: 0, rot, side: "top", placed: true } })
      const p = { ...added.project, board: { ...added.project.board, width: 60, height: 60, x: 0, y: 0 } }
      const d = placeDesignators(p).get(p.components[0].id)!
      return { x: d.x, y: d.y, rot: d.rot }
    }
    const same = (a: number, b: number) => expect(sideOf(a)).toEqual(sideOf(b))
    same(450, 90)
    same(-90, 270)
    expect(sideOf(90)).not.toEqual(sideOf(270))
    // 85 degrees puts the designator on the same side of the part as 90 does, 265 as 270 does
    expect(Math.sign(sideOf(85).x)).toBe(Math.sign(sideOf(90).x))
    expect(Math.sign(sideOf(265).x)).toBe(Math.sign(sideOf(270).x))
    expect(Math.sign(sideOf(85).x)).not.toBe(Math.sign(sideOf(265).x))
  })
})

describe("Circuit JSON keeps a part's real angle", () => {
  it("a part at 33 degrees comes back at 33, with its pads where they were", () => {
    const added = addComponent(createProject("angle"), "resistor", { sch: { x: 0, y: 0 }, pcb: { x: 5, y: 3, rot: 33, side: "top", placed: true } })
    const before = pcbPads(added.project.components[0])
    const json = projectToCircuitJson(added.project).elements
    const back = projectFromCircuitJson(json, { name: "back" }).project
    expect(back.components[0].pcb.rot).toBe(33)
    const after = pcbPads(back.components[0])
    expect(after).toHaveLength(before.length)
    for (const [i, a] of after.entries()) {
      expect(a.x).toBeCloseTo(before[i].x, 2)
      expect(a.y).toBeCloseTo(before[i].y, 2)
      expect(a.oriented?.rot).toBeCloseTo(33, 3)
    }
  })
})
