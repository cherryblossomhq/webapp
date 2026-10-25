import { describe, expect, it } from "vitest"
import { addComponent, createProject } from "../src/model/ops"
import { boardAreaMm2, boxOnBoard, describeOutline, outlineGeometry, outlineRegionsAt, outlineState, outsideBoxes, rasterizeInside } from "../src/model/outline"
import { packOutline, normalizeOutline, unpackOutline } from "../src/model/outlineCodec"
import {
  addOutlinePaths,
  addOutlineShape,
  addSlot,
  circlePath,
  joinPaths,
  moveOutlineArcMid,
  moveOutlineVertex,
  outlineSlots,
  pathVertices,
  rectPath,
  removeOutlinePath,
  resetOutline,
  setOutlinePaths,
  slotPath,
  splitOutlineSeg,
  syncOutlineBox,
  toggleOutlineArc,
  translateOutlinePath,
} from "../src/model/outlineOps"
import { cutoutTexts, edgeText, outlineToText, parseOutlineText } from "../src/model/outlineText"
import { parseProjectFile, serializeProject } from "../src/model/projectFile"
import { arcCircle, flattenPath, pathsBox, segEnd, segStart, type ShapePath } from "../src/model/shapes"
import type { BoardOutline, Project, Vec2 } from "../src/model/types"

const P = (x: number, y: number): Vec2 => ({ x, y })
const poly = (...pts: [number, number][]): ShapePath => ({ closed: true, segs: pts.map(([x, y], i) => ({ kind: "line" as const, a: P(x, y), b: P(pts[(i + 1) % pts.length][0], pts[(i + 1) % pts.length][1]) })) })
const plain = () => ({ ...createProject("outline test"), board: { ...createProject("x").board, width: 50, height: 40, x: 0, y: 0, cornerRadius: 0 } }) as Project
const withOutline = (paths: ShapePath[]): Project => setOutlinePaths(plain(), paths)
const length = (p: ShapePath) => {
  const pts = flattenPath(p, 0.0002)
  let l = 0
  for (let i = 0; i < pts.length; i++) l += Math.hypot(pts[(i + 1) % pts.length].x - pts[i].x, pts[(i + 1) % pts.length].y - pts[i].y)
  return l
}

describe("the geometry of an outline", () => {
  const board = withOutline([poly([0, 0], [30, 0], [30, 20], [0, 20]), circlePath(P(10, 10), 3)]).board
  const g = outlineGeometry(board)!

  it("nests loops: the rectangle is the board and the circle in it a cutout", () => {
    expect(g.state).toBe("closed")
    expect(g.rings.map((r) => r.hole)).toEqual([false, true])
    expect(g.regions).toHaveLength(1)
    expect(g.regions[0].holes).toHaveLength(1)
    // The board's own ring runs counter-clockwise, a cutout's clockwise.
    const area = (pts: Vec2[]) => pts.reduce((s, p, i) => s + (pts[(i + 1) % pts.length].x - p.x) * (pts[(i + 1) % pts.length].y + p.y), 0) / -2
    expect(area(g.regions[0].outer)).toBeGreaterThan(0)
    expect(area(g.regions[0].holes[0])).toBeLessThan(0)
  })

  it("says what is on the board and how far from its edge a point is, negative off it and inside a cutout", () => {
    expect(g.contains(P(25, 10))).toBe(true)
    expect(g.contains(P(10, 10))).toBe(false)
    expect(g.contains(P(40, 10))).toBe(false)
    expect(g.signedDistance(P(25, 10))).toBeCloseTo(5, 6)
    expect(g.signedDistance(P(35, 10))).toBeCloseTo(-5, 6)
    expect(g.signedDistance(P(10, 10))).toBeCloseTo(-3, 3)
    expect(g.signedDistance(P(10, 14))).toBeCloseTo(1, 3)
  })

  it("an island inside a cutout is board again", () => {
    const b = withOutline([poly([0, 0], [40, 0], [40, 40], [0, 40]), poly([5, 5], [35, 5], [35, 35], [5, 35]), poly([15, 15], [25, 15], [25, 25], [15, 25])]).board
    const q = outlineGeometry(b)!
    expect(q.rings.map((r) => r.hole)).toEqual([false, true, false])
    expect(q.regions).toHaveLength(2)
    expect(q.contains(P(20, 20))).toBe(true)
    expect(q.contains(P(10, 10))).toBe(false)
    expect(q.contains(P(2, 2))).toBe(true)
    expect(boardAreaMm2(b)).toBeCloseTo(1600 - 900 + 100, 6)
  })

  it("the box of an arc is the arc's, not its three points'", () => {
    const d: ShapePath = {
      closed: true,
      segs: [
        { kind: "line", a: P(0, 0), b: P(10, 0) },
        { kind: "arc", start: P(10, 0), mid: P(15, 5), end: P(10, 10) },
        { kind: "line", a: P(10, 10), b: P(0, 10) },
        { kind: "line", a: P(0, 10), b: P(0, 0) },
      ],
    }
    const b = pathsBox([d])
    expect(b.maxX).toBeCloseTo(15, 9)
    const board = syncOutlineBox({ ...plain().board, outline: { paths: [d] } })
    expect([board.width, board.height, board.x, board.y, board.cornerRadius]).toEqual([15, 10, 7.5, 5, 0])
    // An arc whose circle reaches further than any of its three points: x = 5 at 0 degrees, between -80 and 20.
    const at = (deg: number): Vec2 => P(5 * Math.cos((deg * Math.PI) / 180), 5 * Math.sin((deg * Math.PI) / 180))
    const open: ShapePath = { closed: false, segs: [{ kind: "arc", start: at(-80), mid: at(-30), end: at(20) }] }
    expect(pathsBox([open]).maxX).toBeCloseTo(5, 9)
    expect(Math.max(at(-80).x, at(-30).x, at(20).x)).toBeLessThan(4.8)
  })

  it("scan-fills which cells of a grid are on the board, as a point test says", () => {
    const grid = rasterizeInside(g, -2, -2, 40, 30, 1)
    let wrong = 0
    for (let j = 0; j < 30; j++) for (let i = 0; i < 40; i++) if (!!grid[j * 40 + i] !== g.contains(P(-2 + i, -2 + j))) wrong++
    expect(wrong).toBe(0)
  })

  it("blocks the off-board part of the box for placement, and keeps a margin from the edge", () => {
    const boxes = outsideBoxes(g, 0.5)
    const blocked = (p: Vec2) => boxes.some((b) => p.x >= b.minX && p.x <= b.maxX && p.y >= b.minY && p.y <= b.maxY)
    expect(blocked(P(10, 10))).toBe(true)
    expect(blocked(P(25, 10))).toBe(false)
    expect(blocked(P(29.9, 10))).toBe(true)
    expect(boxOnBoard(g, { minX: 18, maxX: 24, minY: 4, maxY: 12 })).toBe(true)
    expect(boxOnBoard(g, { minX: 5, maxX: 11, minY: 5, maxY: 11 })).toBe(false)
    // a cutout wholly inside a part's box is not the part being off the board (a module's mounting holes are under its courtyard)
    expect(boxOnBoard(g, { minX: 5, maxX: 15, minY: 5, maxY: 15 })).toBe(true)
  })

  it("is the same object while the outline is: it is kept with it", () => {
    expect(outlineGeometry(board)).toBe(g)
  })
})

describe("editing the outline", () => {
  it("joins drawn pieces into a loop and leaves the rest open", () => {
    const lines: ShapePath[] = [
      { closed: false, segs: [{ kind: "line", a: P(0, 0), b: P(10, 0) }] },
      { closed: false, segs: [{ kind: "line", a: P(10, 10), b: P(10, 0) }] },
      { closed: false, segs: [{ kind: "line", a: P(10, 10), b: P(0, 10) }] },
      { closed: false, segs: [{ kind: "line", a: P(0, 10), b: P(0, 0) }] },
      { closed: false, segs: [{ kind: "line", a: P(20, 0), b: P(25, 0) }] },
    ]
    const joined = joinPaths(lines)
    expect(joined.filter((p) => p.closed)).toHaveLength(1)
    expect(joined.filter((p) => !p.closed)).toHaveLength(1)
    const loop = joined.find((p) => p.closed)!
    expect(loop.segs).toHaveLength(4)
    // each piece ends where the next begins, exactly
    loop.segs.forEach((s, i) => expect(segEnd(s)).toEqual(segStart(loop.segs[(i + 1) % 4])))
  })

  it("a shape drawn inside a rectangle board is a cutout, and the rectangle becomes its first loop", () => {
    const res = addOutlineShape(plain(), { type: "circle", c: P(0, 0), r: 4 })
    expect(res.replacedRectangle).toBe(false)
    const b = res.project.board
    expect(b.outline!.paths).toHaveLength(2)
    expect([b.width, b.height, b.x, b.y]).toEqual([50, 40, 0, 0])
    expect(outlineGeometry(b)!.contains(P(0, 0))).toBe(false)
    expect(describeOutline(b)).toBe("1 piece of board, 1 cutout")
    expect(boardAreaMm2(b)).toBeCloseTo(2000 - Math.PI * 16, 1)
  })

  it("a closed shape that reaches outside the rectangle replaces it", () => {
    const res = addOutlineShape(plain(), { type: "polygon", pts: [P(0, 0), P(60, 0), P(60, 10), P(0, 10)] })
    expect(res.replacedRectangle).toBe(true)
    expect(res.project.board.outline!.paths).toHaveLength(1)
    expect([res.project.board.width, res.project.board.height, res.project.board.x, res.project.board.y]).toEqual([60, 10, 30, 5])
  })

  it("an open piece keeps the rectangle and the board is not closed until it closes", () => {
    const res = addOutlineShape(plain(), { type: "line", a: P(0, 0), b: P(5, 5) })
    expect(res.open).toBe(1)
    expect(outlineState(res.project.board)).toBe("open")
    const closed = addOutlinePaths(res.project, [{ closed: false, segs: [{ kind: "line", a: P(5, 5), b: P(5, -5) }] }, { closed: false, segs: [{ kind: "line", a: P(5, -5), b: P(0, 0) }] }])
    expect(closed.closedLoops).toBe(1)
    expect(outlineState(closed.project.board)).toBe("closed")
  })

  it("moves a corner and the two edges follow; an arc keeps its middle point", () => {
    const base = withOutline([poly([0, 0], [10, 0], [10, 10], [0, 10])])
    const moved = moveOutlineVertex(base, 0, 2, P(14, 12))!
    const path = moved.board.outline!.paths[0]
    expect(pathVertices(path)[2]).toEqual(P(14, 12))
    expect(segEnd(path.segs[1])).toEqual(P(14, 12))
    expect(segStart(path.segs[2])).toEqual(P(14, 12))
    expect([moved.board.width, moved.board.height]).toEqual([14, 12])
    expect(moveOutlineVertex(base, 0, 7, P(0, 0))).toBeNull()
    const arced = toggleOutlineArc(base, 0, 0)!
    const seg = arced.board.outline!.paths[0].segs[0]
    expect(seg.kind).toBe("arc")
    const bent = moveOutlineArcMid(arced, 0, 0, P(5, -3))!
    expect((bent.board.outline!.paths[0].segs[0] as { mid: Vec2 }).mid).toEqual(P(5, -3))
    expect(bent.board.height).toBeGreaterThan(10)
    const straight = toggleOutlineArc(bent, 0, 0)!
    expect(straight.board.outline!.paths[0].segs[0]).toEqual({ kind: "line", a: P(0, 0), b: P(10, 0) })
  })

  it("splits a straight edge and an arc without changing the shape", () => {
    const base = toggleOutlineArc(withOutline([poly([0, 0], [10, 0], [10, 10], [0, 10])]), 0, 0)!
    const before = base.board.outline!.paths[0]
    const arcSplit = splitOutlineSeg(base, 0, 0, P(5, -2))!.board.outline!.paths[0]
    expect(arcSplit.segs).toHaveLength(5)
    expect(length(arcSplit)).toBeCloseTo(length(before), 5)
    // both halves are on the original circle
    const c0 = arcCircle(...(["start", "mid", "end"].map((k) => (before.segs[0] as unknown as Record<string, Vec2>)[k]) as [Vec2, Vec2, Vec2]))!
    for (const s of arcSplit.segs.slice(0, 2)) {
      if (s.kind !== "arc") throw new Error("expected an arc")
      const c = arcCircle(s.start, s.mid, s.end)!
      expect(c.r).toBeCloseTo(c0.r, 9)
      expect(c.c.x).toBeCloseTo(c0.c.x, 9)
    }
    const lineSplit = splitOutlineSeg(base, 0, 1, P(10, 4))!.board.outline!.paths[0]
    expect(lineSplit.segs).toHaveLength(5)
    expect(segEnd(lineSplit.segs[1])).toEqual(segStart(lineSplit.segs[2]))
  })

  it("cuts a slot, finds it again with its width, and a stadium that is the board itself is no slot", () => {
    const cut = addSlot(plain(), P(-5, 0), P(5, 0), 2)
    const slots = outlineSlots(cut.board.outline!.paths)
    expect(slots).toHaveLength(1)
    expect(slots[0].width).toBeCloseTo(2, 9)
    expect([slots[0].a, slots[0].b].map((p) => [Math.round(p.x * 1e6) / 1e6, Math.round(p.y * 1e6) / 1e6]).sort()).toEqual([[-5, 0], [5, 0]])
    // the same loop starting at an arc is found too
    const p = slotPath(P(0, 0), P(0, 8), 3)
    const turned: ShapePath = { closed: true, segs: [...p.segs.slice(1), p.segs[0]] }
    expect(outlineSlots([poly([-20, -20], [20, -20], [20, 20], [-20, 20]), turned])).toHaveLength(1)
    expect(outlineSlots([p])).toHaveLength(0)
  })

  it("moves a shape, removes one, and with the last gone the board is the rectangle of its box again", () => {
    const base = addOutlineShape(plain(), { type: "circle", c: P(0, 0), r: 4 }).project
    const moved = translateOutlinePath(base, 1, 10, 0)
    expect(outlineGeometry(moved.board)!.contains(P(10, 0))).toBe(false)
    expect(outlineGeometry(moved.board)!.contains(P(0, 0))).toBe(true)
    const onlyCircle = removeOutlinePath(base, 0)
    expect(onlyCircle.board.outline!.paths).toHaveLength(1)
    const gone = removeOutlinePath(onlyCircle, 0)
    expect(gone.board.outline).toBeUndefined()
    expect([gone.board.width, gone.board.height]).toEqual([8, 8])
    expect(resetOutline(base).board.outline).toBeUndefined()
  })

  it("keeps a rectangle board exactly as it is: same object, same box", () => {
    const p = plain()
    expect(syncOutlineBox(p.board)).toBe(p.board)
    expect(outlineState(p.board)).toBe("closed")
    expect(outlineGeometry(p.board)).toBeNull()
    expect(rectPath({ ...p.board, cornerRadius: 3 }).segs).toHaveLength(8)
  })

  it("a board with an outline of no paths is a board missing its outline, and holds its box", () => {
    const b = { ...plain().board, outline: { paths: [] } }
    expect(outlineState(b)).toBe("missing")
    expect(outlineGeometry(b)).toBeNull()
    expect(describeOutline(b)).toBe("no outline")
  })

  it("flattens to a format with no arcs within the tolerance it is asked for", () => {
    const b = withOutline([circlePath(P(0, 0), 20)]).board
    const [ring] = outlineRegionsAt(b, 0.005)
    expect(ring.outer.length).toBeGreaterThan(40)
    for (const q of ring.outer) expect(Math.abs(Math.hypot(q.x, q.y) - 20)).toBeLessThan(0.005 + 1e-9)
  })
})

describe("storing an outline", () => {
  const every: ShapePath[] = [
    {
      closed: true,
      segs: [
        { kind: "line", a: P(0, 0), b: P(10.123456789, 0) },
        { kind: "arc", start: P(10.123456789, 0), mid: P(12, 3), end: P(10, 6) },
        { kind: "bezier", p0: P(10, 6), c1: P(8, 8), c2: P(4, 4), p1: P(0, 6) },
        { kind: "line", a: P(0, 6), b: P(0, 0) },
      ],
    },
    { closed: false, segs: [{ kind: "line", a: P(20, 0), b: P(25, 1) }, { kind: "ellipse", c: P(25, 5), rx: 4, ry: 2, rot: 0.3, t0: 0, t1: Math.PI }] },
    circlePath(P(3, 3), 1),
  ]

  it("round-trips every kind of piece exactly, compactly", () => {
    const packed = packOutline({ paths: every })
    const back = unpackOutline(JSON.parse(JSON.stringify(packed)))!
    expect(back.paths).toHaveLength(3)
    expect(back.paths[0].segs).toEqual(every[0].segs)
    expect(back.paths[1].closed).toBe(false)
    expect(back.paths[1].segs[0]).toEqual(every[1].segs[0])
    const e = back.paths[1].segs[1]
    expect(e.kind).toBe("ellipse")
    expect(JSON.stringify(packed).length).toBeLessThan(JSON.stringify({ paths: every }).length / 3)
  })

  it("drops a damaged path and keeps the rest", () => {
    const good = packOutline({ paths: [poly([0, 0], [5, 0], [5, 5])] })[0]
    const back = unpackOutline([good, ["c", 0, 0, "L", "x", 1], ["z", 1, 2], ["c", 0, 0, "A", 1, 2], good])!
    expect(back.paths).toHaveLength(2)
    expect(unpackOutline("nope")).toBeNull()
  })

  it("reads a hand-written outline and drops a path with a piece that does not read", () => {
    const read = normalizeOutline({ paths: [{ closed: true, segs: [{ kind: "line", a: P(0, 0), b: P(1, 1) }] }, { closed: true, segs: [{ kind: "line", a: P(0, 0) }] }, { segs: [] }] })!
    expect(read.paths).toHaveLength(1)
  })

  it("survives a save and a load with the box following it, and a board with none writes none", () => {
    const p = addOutlineShape(plain(), { type: "circle", c: P(2, 2), r: 3 }).project
    const text = serializeProject(p)
    const doc = JSON.parse(text)
    expect(doc.project.board.outline).toBeUndefined()
    expect(Array.isArray(doc.project.board.ol)).toBe(true)
    const back = parseProjectFile(text, { id: "x" })
    expect(back.board).toEqual(p.board)
    expect(serializeProject(back)).toBe(text)
    expect(JSON.parse(serializeProject(plain())).project.board.ol).toBeUndefined()
    // a missing outline is not a board with none
    const missing = { ...plain(), board: { ...plain().board, outline: { paths: [] } as BoardOutline } }
    expect(parseProjectFile(serializeProject(missing), { id: "x" }).board.outline).toEqual({ paths: [] })
  })

  it("a plain object outline in a hand-written file is read and sized", () => {
    const doc = { format: "cherryblossom.project", version: 6, project: { name: "h", components: [], board: { width: 1, height: 1, x: 0, y: 0, thickness: 1.6, cornerRadius: 1, outline: { paths: [{ closed: true, segs: poly([0, 0], [8, 0], [8, 6]).segs }] } } } }
    const p = parseProjectFile(doc, { id: "h" })
    expect([p.board.width, p.board.height, p.board.cornerRadius]).toEqual([8, 6, 0])
  })
})

describe("the outline as text", () => {
  it("prints and reads back the same shapes", () => {
    const paths = [poly([0, 0], [30, 0], [30, 20], [0, 20]), circlePath(P(10, 10), 3), slotPath(P(20, 5), P(20, 15), 2)]
    const text = outlineToText(paths)
    expect(text).toContain("Z")
    const back = parseOutlineText(text)
    if ("error" in back) throw new Error(back.error)
    expect(back.paths).toHaveLength(3)
    expect(back.paths.every((p) => p.closed)).toBe(true)
    expect(length(back.paths[0])).toBeCloseTo(100, 6)
    expect(length(back.paths[1])).toBeCloseTo(2 * Math.PI * 3, 2)
  })

  it("reads M, L, A, C, Z, O and S", () => {
    const t = parseOutlineText("M0 0 L10 0 A12 5 10 10 L0 10 Z O5 5 1 S1 1 4 1 0.5")
    if ("error" in t) throw new Error(t.error)
    expect(t.paths).toHaveLength(3)
    expect(t.paths[0].segs.map((s) => s.kind)).toEqual(["line", "arc", "line", "line"])
    expect(outlineSlots([poly([-9, -9], [20, -9], [20, 20], [-9, 20]), t.paths[2]])).toHaveLength(1)
    const c = parseOutlineText("M0 0 C3 5 6 5 9 0 L9 -5 Z")
    if ("error" in c) throw new Error(c.error)
    expect(c.paths[0].segs[0].kind).toBe("bezier")
  })

  it("closes a shape whose end meets its start without Z, and leaves an open one open", () => {
    const t = parseOutlineText("M0 0 L5 0 L5 5 L0 0 M10 0 L12 0")
    if ("error" in t) throw new Error(t.error)
    expect(t.paths.map((p) => p.closed)).toEqual([true, false])
  })

  it("says what is wrong", () => {
    const err = (s: string) => ("error" in parseOutlineText(s) ? (parseOutlineText(s) as { error: string }).error : "")
    expect(err("")).toMatch(/empty/)
    expect(err("M0 0 L1")).toMatch(/L needs 2 numbers/)
    expect(err("L1 1")).toMatch(/started with M/)
    expect(err("Z")).toMatch(/Z closes/)
    expect(err("M0 0 A1 1 2 2 3 3")).toMatch(/one line/)
    expect(err("M0 0 L1 0 Z")).toMatch(/three/)
    expect(err("O1 1 0")).toMatch(/radius/)
    expect(err("S0 0 1 1 0")).toMatch(/width/)
    expect(err("M0 0 L99999 0 L0 5 Z")).toMatch(/L needs 2 numbers/)
    expect(err("M0 0 Q1 1")).toMatch(/Unexpected/)
    expect(err(`M0 0${" L1 1".repeat(4100)}`)).toMatch(/more than 4000/)
  })

  it("lists the edge and the cutouts of a board apart, in the order remove_cutouts counts", () => {
    const b = withOutline([poly([0, 0], [30, 0], [30, 20], [0, 20]), circlePath(P(10, 10), 3), poly([20, 5], [25, 5], [25, 10])]).board
    expect(edgeText(b)).toMatch(/^M0 0 L30 0 L30 20 L0 20 Z$/)
    const cuts = cutoutTexts(b)
    expect(cuts).toHaveLength(2)
    expect(cuts[0].path).toBe(1)
    expect(cuts[1].text).toBe("M20 5 L25 5 L25 10 Z")
  })

  it("a part on the board is not asked about an outline it does not have", () => {
    const p = addComponent(plain(), "resistor", { sch: { x: 0, y: 0 }, pcb: { x: 0, y: 0, placed: true } }).project
    expect(p.board.outline).toBeUndefined()
  })
})
