import { describe, expect, it } from "vitest"
import { dimensionDrawing, dimensionText, dimensionShapes, valueText, DEFAULT_EXTENSION_HEIGHT_IU } from "../src/model/dimensions"
import { addDimension, createGroup, expandToGroups, groupSelection, leafMembers, lockedByGroup, moveDimension, newDimension, patchDimension, pruneGroups, remapPartGroups, removeDimensions, rotateDimension, setGroupLocked, topGroup, touchesGroup, ungroup, updateDimensions } from "../src/model/boardObjects"
import { lockedInSelection, moveObjects, rotateObjects, selectionBounds } from "../src/model/groupMoves"
import { addTrace, addVia, createProject } from "../src/model/ops"
import { addGraphic } from "../src/model/shapeOps"
import { migrateProjectFile, parseProjectFile, PROJECT_FILE_VERSION, serializeProject } from "../src/model/projectFile"
import { packDimensions, packGroups, packImages, unpackDimensions, unpackGroups, unpackImages } from "../src/model/dimCodec"
import { imageFacts, sha256Hex } from "../src/lib/imageFacts"
import type { BoardDimension, ComponentInstance, DimensionKind, PcbGroup, Project, ReferenceImage } from "../src/model/types"
import { createHash } from "node:crypto"

// Dimensions as KiCad draws them (pcbnew/pcb_dimension.cpp), their value text, the compact stored form, groups of board items (what a group is, what
// moving, turning, locking, ungrouping and deleting do to it) and reference images' facts. Numbers are millimetres in the editor's frame (y up); KiCad's
// frame is y down, so a crossbar KiCad draws below its points (y larger) is above them in a negative y here.

const near = (a: number, b: number, eps = 1e-5) => Math.abs(a - b) <= eps
const EXT = DEFAULT_EXTENSION_HEIGHT_IU / 1e6

const dim = (kind: DimensionKind, a: { x: number; y: number }, b: { x: number; y: number }, extra: Partial<BoardDimension> = {}): BoardDimension => ({
  ...newDimension(kind, "Dwgs.User", a, b),
  id: "d1",
  extHeight: EXT,
  precision: 4,
  ...extra,
})

const segs = (d: BoardDimension) => dimensionDrawing(d).lines.map((l) => [l.a.x, l.a.y, l.b.x, l.b.y])
const has = (list: number[][], x1: number, y1: number, x2: number, y2: number, eps = 1e-5) => list.some((s) => (near(s[0], x1, eps) && near(s[1], y1, eps) && near(s[2], x2, eps) && near(s[3], y2, eps)) || (near(s[0], x2, eps) && near(s[1], y2, eps) && near(s[2], x1, eps) && near(s[3], y1, eps)))

describe("the value a dimension says", () => {
  it("is the measured length in the units asked for, with KiCad's digits (precision 6 to 9 depend on the unit)", () => {
    expect(valueText(10_000_000, 2, 4, false)).toBe("10.0000")
    expect(valueText(25_400_000, 0, 4, false)).toBe("1.0000")
    expect(valueText(25_400, 1, 2, false)).toBe("1.00")
    // V_VV: 0.00 in, 0 mils, 0.0 mm
    expect(valueText(25_400_000, 0, 6, false)).toBe("1.00")
    expect(valueText(25_400_000, 1, 6, false)).toBe("1000")
    expect(valueText(10_000_000, 2, 6, false)).toBe("10.0")
    // V_VVVVV: 0.00000 in, 0.00 mils, 0.0000 mm
    expect(valueText(10_000_000, 2, 9, false)).toBe("10.0000")
    expect(valueText(25_400, 1, 9, false)).toBe("1.00")
  })
  it("leaves trailing zeros off when asked, down to a whole number", () => {
    expect(valueText(10_500_000, 2, 4, true)).toBe("10.5")
    expect(valueText(10_000_000, 2, 4, true)).toBe("10")
    expect(valueText(10_000_000, 2, 0, true)).toBe("10")
  })
  it("takes automatic units as millimetres", () => {
    expect(valueText(10_000_000, 3, 1, false)).toBe("10.0")
  })
  it("has the unit after the value, in brackets, or none, then the prefix and suffix; a text that replaces the value keeps them", () => {
    const d = dim("aligned", { x: 0, y: 0 }, { x: 10, y: 0 }, { precision: 2 })
    expect(dimensionText({ ...d, format: 1 }, 10_000_000)).toBe("10.00 mm")
    expect(dimensionText({ ...d, format: 2 }, 10_000_000)).toBe("10.00 (mm)")
    expect(dimensionText({ ...d, format: 0, prefix: "L=", suffix: "!" }, 10_000_000)).toBe("L=10.00!")
    expect(dimensionText({ ...d, units: 1, format: 1 }, 25_400)).toBe("1.00 mils")
    expect(dimensionText({ ...d, format: 1, override: "width" }, 10_000_000)).toBe("width mm")
  })
})

describe("an aligned dimension", () => {
  const d = dim("aligned", { x: 0, y: 0 }, { x: 10, y: 0 }, { height: 3, keep: true, size: 1, tw: 0.15, x: 0, y: 0 })
  it("draws two extension lines, the crossbar and an arrow at each end, as KiCad does", () => {
    const l = segs(d)
    expect(l).toHaveLength(7)
    // a positive height is KiCad's (-dy, dx): towards larger y in its frame, so below the points there and at negative y here
    expect(has(l, 0, 0, 0, -(3 + EXT))).toBe(true)
    expect(has(l, 10, 0, 10, -(3 + EXT))).toBe(true)
    expect(has(l, 0, -3, 10, -3)).toBe(true)
    const barb = 1.27 * Math.cos((27.5 * Math.PI) / 180)
    const wing = 1.27 * Math.sin((27.5 * Math.PI) / 180)
    expect(has(l, 0, -3, barb, -3 + wing)).toBe(true)
    expect(has(l, 0, -3, barb, -3 - wing)).toBe(true)
    expect(has(l, 10, -3, 10 - barb, -3 + wing)).toBe(true)
    expect(has(l, 10, -3, 10 - barb, -3 - wing)).toBe(true)
  })
  it("says the measured length and puts the text beside the crossbar, turned with it", () => {
    const t = dimensionDrawing(d).text!
    expect(t.content).toBe("10.0000 mm")
    // beside the crossbar by the pen and the height, on KiCad's side (towards smaller y there, so the points' side here: the text sits above a horizontal bar that is below its points)
    expect(near(t.x, 5) && near(t.y, -3 + 1.15)).toBe(true)
    expect(t.rot).toBe(0)
  })
  it("is on the other side with a negative height, and the same length", () => {
    const n = dim("aligned", { x: 0, y: 0 }, { x: 10, y: 0 }, { height: -3, size: 1, tw: 0.15 })
    expect(has(segs(n), 0, -0, 0, 3 + EXT)).toBe(true)
    expect(has(segs(n), 0, 3, 10, 3)).toBe(true)
    expect(dimensionDrawing(n).measured).toBe(10_000_000)
  })
  it("starts its extension lines away from the points by the offset, and leaves a gap in the crossbar where the text would sit on it", () => {
    const o = dim("aligned", { x: 0, y: 0 }, { x: 10, y: 0 }, { height: 3, extOffset: 0.5, size: 1, tw: 0.15, textMode: 1, keep: true, override: "x", format: 0 })
    expect(has(segs(o), 0, -0.5, 0, -(3 + EXT))).toBe(true)
    // the text is on the crossbar, so the bar is cut where it is: two pieces, with the text between them
    const bars = segs(o).filter((s) => near(s[1], -3) && near(s[3], -3) && Math.abs(s[2] - s[0]) > 0.1)
    expect(bars).toHaveLength(2)
    const t = dimensionDrawing(o).text!
    expect(bars[0][2]).toBeLessThan(t.x)
    expect(bars[1][0]).toBeGreaterThan(t.x)
  })
  it("draws inward arrows with tails, from outside the crossbar", () => {
    const i = dim("aligned", { x: 0, y: 0 }, { x: 10, y: 0 }, { height: 3, inward: true, size: 1, tw: 0.15 })
    const l = segs(i)
    // a tail of two arrow lengths, outward from each end
    expect(has(l, 0, -3, -2.54, -3)).toBe(true)
    expect(has(l, 10, -3, 12.54, -3)).toBe(true)
  })
  it("keeps the text where it was put when its position is manual, and turns it with the crossbar only when asked", () => {
    const { keep: _keep, ...m } = dim("aligned", { x: 0, y: 0 }, { x: 0, y: 10 }, { height: 2, textMode: 2, x: 7, y: 8, rot: 33, size: 1, tw: 0.15 })
    const t = dimensionDrawing(m).text!
    expect(near(t.x, 7) && near(t.y, 8) && near(t.rot, 33)).toBe(true)
    const k = dimensionDrawing({ ...m, keep: true }).text!
    // a vertical crossbar turns the text a quarter: KiCad keeps it upright, so it reads from the right
    expect(near(k.rot, 90) || near(k.rot, 270)).toBe(true)
  })
})

describe("an orthogonal dimension", () => {
  it("measures along x between two points and draws its crossbar level, with an extension line from each point", () => {
    const d = dim("orthogonal", { x: 0, y: 0 }, { x: 10, y: -5 }, { height: 2, size: 1, tw: 0.15 })
    const l = segs(d)
    // KiCad: extension (0, height) in its frame, so the crossbar is at y = 2 there, -2 here
    expect(has(l, 0, 0, 0, -(2 + EXT))).toBe(true)
    expect(has(l, 0, -2, 10, -2)).toBe(true)
    // the second line runs from the point's side of the crossbar, KiCad's arrow-height past it, to the second point
    expect(has(l, 10, -2 + EXT, 10, -5)).toBe(true)
    expect(dimensionDrawing(d).measured).toBe(10_000_000)
    expect(dimensionDrawing(d).text!.content).toBe("10.0000 mm")
  })
  it("measures along y when it says so", () => {
    const d = dim("orthogonal", { x: 0, y: 0 }, { x: 3, y: -8 }, { vertical: true, height: 2, size: 1, tw: 0.15 })
    expect(dimensionDrawing(d).measured).toBe(8_000_000)
    expect(has(segs(d), 0, 0, 2 + EXT, 0)).toBe(true)
  })
})

describe("a leader, a centre mark and a radius", () => {
  it("a leader is a line with an arrowhead to the text, with its text's frame when it has one", () => {
    const d = dim("leader", { x: 0, y: 0 }, { x: 10, y: 0 }, { override: "Leader", x: 20, y: 0, size: 1, tw: 0.15, format: 0 })
    const plain = segs(d)
    expect(plain).toHaveLength(4)
    expect(has(plain, 0, 0, 10, 0)).toBe(true)
    // the line to the text stops at the text's box, not at its middle
    const toText = plain.find((s) => near(s[0], 10) && near(s[1], 0) && s[2] > 10)!
    expect(toText[2]).toBeLessThan(20)
    const framed = dimensionDrawing({ ...d, frame: 1 })
    expect(framed.lines).toHaveLength(8)
    const round = dimensionDrawing({ ...d, frame: 2 })
    expect(round.circles).toHaveLength(1)
    expect(dimensionDrawing({ ...d, frame: 3 }).lines).toHaveLength(4)
  })
  it("a centre mark is two crossing lines of the arm's length, and has no text", () => {
    const d = dim("center", { x: 5, y: 5 }, { x: 7, y: 5 }, { format: 0 })
    const l = segs(d)
    expect(l).toHaveLength(2)
    expect(has(l, 3, 5, 7, 5)).toBe(true)
    expect(has(l, 5, 3, 5, 7)).toBe(true)
    expect(dimensionDrawing(d).text).toBeNull()
  })
  it("a radius is a cross at the centre, a leader out from the circle, an arrow at the circle and the radius with its prefix", () => {
    const d = dim("radial", { x: 0, y: 0 }, { x: 5, y: 0 }, { leaderLength: 3.81, prefix: "R ", format: 0, x: 11, y: 0, size: 1, tw: 0.15, keep: true })
    const draw = dimensionDrawing(d)
    expect(has(draw.lines.map((l) => [l.a.x, l.a.y, l.b.x, l.b.y]), 0, -1.27, 0, 1.27)).toBe(true)
    expect(has(draw.lines.map((l) => [l.a.x, l.a.y, l.b.x, l.b.y]), -1.27, 0, 1.27, 0)).toBe(true)
    expect(draw.text!.content).toBe("R 5.0000")
    expect(draw.measured).toBe(5_000_000)
  })
})

describe("what a dimension draws goes to the layer it is on", () => {
  it("is lines with the dimension's width, and circles drawn unfilled", () => {
    const d = dim("leader", { x: 0, y: 0 }, { x: 10, y: 0 }, { override: "x", frame: 2, x: 12, y: 0, thickness: 0.2, size: 1, tw: 0.15, format: 0 })
    const shapes = dimensionShapes(d)
    expect(shapes.every((s) => s.layer === "Dwgs.User" && s.width === 0.2)).toBe(true)
    expect(shapes.filter((s) => s.type === "circle")).toHaveLength(1)
    expect(shapes.some((s) => s.type === "circle" && s.fill)).toBe(false)
  })
})

describe("editing dimensions", () => {
  const base = () => createProject("t")
  it("adds one with an id of its own, patches what is valid and ignores what is not", () => {
    const { project, dimension } = addDimension(base(), newDimension("aligned", "F.SilkS", { x: 0, y: 0 }, { x: 10, y: 0 }, { height: 2 }))
    expect(project.dimensions).toHaveLength(1)
    const p2 = updateDimensions(project, [dimension.id], { precision: 2, units: 1, prefix: "A", layer: "nonsense", thickness: -1, height: 4, locked: true })
    const d = p2.dimensions![0]
    expect(d).toMatchObject({ precision: 2, units: 1, prefix: "A", layer: "F.SilkS", height: 4, locked: true })
    expect(d.thickness).toBe(dimension.thickness)
    expect(updateDimensions(project, ["nope"], { precision: 1 })).toBe(project)
    // a patch that clears: no prefix, no lock, no height
    const p3 = updateDimensions(p2, [dimension.id], { prefix: null, locked: false, height: 0 })
    expect(p3.dimensions![0]).not.toHaveProperty("prefix")
    expect(p3.dimensions![0]).not.toHaveProperty("locked")
    expect(p3.dimensions![0]).not.toHaveProperty("height")
  })
  it("moves with its points and its text, unless locked, and turns a quarter turn with an orthogonal one changing its axis", () => {
    const d = dim("orthogonal", { x: 0, y: 0 }, { x: 10, y: -5 }, { height: 2, x: 5, y: -1 })
    const m = moveDimension(d, 1, 2)
    expect(m.a).toEqual({ x: 1, y: 2 })
    expect(m.b).toEqual({ x: 11, y: -3 })
    expect(m.x).toBe(6)
    const turned = rotateDimension(d, { x: 0, y: 0 })
    expect(turned.vertical).toBe(true)
    expect(turned.a).toEqual({ x: 0, y: 0 })
    expect(turned.b).toEqual({ x: 5, y: 10 })
    expect(turned.rot).toBe(90)
    // twice: back to x, with the crossbar on the other side
    const again = rotateDimension(turned, { x: 0, y: 0 })
    expect(again.vertical).toBeUndefined()
    expect(again.height).toBe(-2)
    expect(patchDimension(d, { locked: true }).locked).toBe(true)
  })
  it("deletes", () => {
    const { project, dimension } = addDimension(base(), newDimension("center", "Dwgs.User", { x: 0, y: 0 }, { x: 1, y: 0 }))
    const gone = removeDimensions(project, [dimension.id])
    expect(gone.dimensions).toBeUndefined()
    expect(removeDimensions(gone, [dimension.id])).toBe(gone)
  })
})

describe("dimensions, groups and images are stored compactly and read back as they were", () => {
  const dims: BoardDimension[] = [
    { ...dim("aligned", { x: 1.234567, y: -2 }, { x: 11.234567, y: -2 }, { id: "dm1", height: 3.5, keep: true, thickness: 0.15, size: 1.5, tw: 0.3, x: 6, y: -4.5, rot: 0 }) },
    { ...dim("leader", { x: 0, y: 0 }, { x: 5, y: 5 }, { id: "dmX", override: "NOTE \"A\"", frame: 2, x: 6, y: 5, rot: 45, size: 1, hj: "left", mirror: true, locked: true, format: 0, units: 3 }) },
    { ...dim("orthogonal", { x: 0, y: 0 }, { x: 4, y: 4 }, { id: "dm3", vertical: true, height: -1, inward: true, textMode: 2, prefix: "~", suffix: "" }) },
    { ...dim("radial", { x: 0, y: 0 }, { x: 4, y: 0 }, { id: "dm4", leaderLength: 3.81, prefix: "R ", zeros: true, keep: true, bold: true, italic: true, vj: "top", spacing: 1.2, w: 1.1 }) },
    { ...dim("center", { x: 0, y: 0 }, { x: 1, y: 0 }, { id: "dm5", format: 0 }) },
  ]
  it("shares what dimensions have in common and gives each only its own", () => {
    const same = { ...dims[0], id: "dm6", a: { x: 2, y: 2 }, b: { x: 12, y: 2 } }
    const all = [...dims, same]
    const packed = packDimensions(all)
    expect(packed.dm).toHaveLength(6)
    // the first and the sixth are one style
    expect(packed.dimStyles!).toHaveLength(5)
    expect(packed.dm![0][0]).toBe(packed.dm![5][0])
    expect(unpackDimensions(packed.dm, packed.dimStyles!)).toEqual(all)
  })
  it("drops an entry that does not read, and one whose id is taken", () => {
    const packed = packDimensions(dims)
    const broken = [...packed.dm!, ["x"], [99, "A", 0, 0, 1, 1, 0, 0, 0, 0, 0], packed.dm![1]]
    expect(unpackDimensions(broken, packed.dimStyles!)).toEqual(dims)
  })
  it("groups: a name, a lock, a design block and members, with its id stored only when it is not gp<place>", () => {
    const groups: PcbGroup[] = [
      { id: "gp1", name: "", members: ["a", "b"] },
      { id: "custom", name: "Antenna", members: ["c", "gp1"], locked: true, lib: "Lib:Block" },
    ]
    expect(unpackGroups(packGroups(groups))).toEqual(groups)
    expect(packGroups(groups)[0][0]).toBe(0)
    expect(unpackGroups([["x", 1, 2, "a"]])).toEqual([])
  })
  it("images: the id of their file, their size and their place", () => {
    const images: ReferenceImage[] = [{ id: "im1", x: 1, y: -2, layer: "User.1", scale: 0.666551, file: "a".repeat(64), format: "png", px: 100, py: 50, ppi: 96, locked: true }, { id: "pic", x: 0, y: 0, layer: "F.Cu", scale: 1, file: "b".repeat(64), format: "jpg", px: 3, py: 4, ppi: 300 }]
    expect(unpackImages(packImages(images))).toEqual(images)
    expect(unpackImages([[0, 0, 0, "F.Cu", 1, "not a hash", "png", 1, 1, 300, 0]])).toEqual([])
  })
  it("a project with all of them is saved as version 8 and opens the same", () => {
    let p = createProject("x")
    p = addDimension(p, { ...dims[0] } as Omit<BoardDimension, "id">).project
    const g = addGraphic(p, { type: "line", a: { x: 0, y: 0 }, b: { x: 1, y: 1 }, layer: "F.SilkS", width: 0.15 })
    p = createGroup(g.project, [`g:${g.graphic.id}`, `m:${p.dimensions![0].id}`], "pair")!.project
    p = { ...p, images: [{ id: "im1", x: 1, y: 2, layer: "Dwgs.User", scale: 1, file: "c".repeat(64), format: "png", px: 4, py: 4, ppi: 300 }] }
    const file = JSON.parse(serializeProject(p))
    expect(file.version).toBe(PROJECT_FILE_VERSION)
    expect(file.project.dimensions).toBeUndefined()
    expect(file.project.dm).toHaveLength(1)
    expect(file.project.grp).toHaveLength(1)
    expect(file.project.im).toHaveLength(1)
    const back = parseProjectFile(serializeProject(p), { id: p.id })
    expect(back.dimensions).toEqual(p.dimensions)
    expect(back.groups).toEqual(p.groups)
    expect(back.images).toEqual(p.images)
  })
  it("a document of version 2 opens as it was written, with none of them, and migrates unchanged", () => {
    const v4 = { format: "cherryblossom.project", version: 2, project: { name: "old", description: "", components: [], wires: [], labels: [], traces: [], vias: [], zones: [], texts: [] } }
    expect(migrateProjectFile(v4)).toEqual({ ...v4.project, sheets: [{ id: "root" }] })
    const read = parseProjectFile(v4, { id: "x" })
    expect(read.dimensions).toBeUndefined()
    expect(read.groups).toBeUndefined()
    expect(read.images).toBeUndefined()
    const written = JSON.parse(serializeProject(read))
    expect(written.version).toBe(PROJECT_FILE_VERSION)
    expect(written.project).not.toHaveProperty("dm")
    expect(written.project).not.toHaveProperty("grp")
    expect(written.project).not.toHaveProperty("im")
  })
  it("a newer file is still refused", () => {
    expect(() => parseProjectFile({ format: "cherryblossom.project", version: PROJECT_FILE_VERSION + 1, project: {} }, { id: "x" })).toThrow(/newer version/)
  })
})

// ---------- groups ----------

function scene(): { p: Project; ids: { t: string; v: string; g: string; m: string; c: string } } {
  let p = createProject("g")
  const t = addTrace(p, { layer: "top", width: 0.25, points: [{ x: 0, y: 0 }, { x: 5, y: 0 }] })
  p = t.project
  const v = addVia(p, { x: 5, y: 0 })
  p = v.project
  const g = addGraphic(p, { type: "line", a: { x: 1, y: 1 }, b: { x: 3, y: 1 }, layer: "F.SilkS", width: 0.15 })
  p = g.project
  const m = addDimension(p, newDimension("aligned", "Dwgs.User", { x: 0, y: 10 }, { x: 10, y: 10 }, { height: 2 }))
  p = m.project
  const c: ComponentInstance = { id: "cmp1", partId: "x", ref: "R1", props: {}, footprint: "", sch: { x: 0, y: 0, rot: 0 }, pcb: { x: 20, y: 20, rot: 0, side: "top", placed: true } }
  p = { ...p, components: [c] }
  return { p, ids: { t: t.trace!.id, v: v.via.id, g: g.graphic.id, m: m.dimension.id, c: "cmp1" } }
}

describe("a group of board items", () => {
  it("holds what was selected, in the order it was, and nests: grouping a grouped item brings its whole group in", () => {
    const { p, ids } = scene()
    const first = createGroup(p, [`t:${ids.t}`, `v:${ids.v}`], "copper")!
    expect(first.group.members).toEqual([ids.t, ids.v])
    const second = createGroup(first.project, [`t:${ids.t}`, `g:${ids.g}`])!
    // the trace is in the first group, so the second takes that group, not the trace
    expect(second.group.members).toEqual([first.group.id, ids.g])
    expect(topGroup(second.project, ids.t)?.id).toBe(second.group.id)
    expect(leafMembers(second.project, second.group).sort()).toEqual([ids.t, ids.v, ids.g].sort())
    expect(createGroup(p, ["w:nothing"])).toBeNull()
  })
  it("is picked whole: selecting one thing in it selects them all, and a selection with no group is the same list", () => {
    const { p, ids } = scene()
    const { project } = createGroup(p, [`t:${ids.t}`, `v:${ids.v}`, `m:${ids.m}`])!
    const sel = [`t:${ids.t}`]
    expect(expandToGroups(project, sel).sort()).toEqual([`m:${ids.m}`, `t:${ids.t}`, `v:${ids.v}`].sort())
    const other = [`g:${ids.g}`]
    expect(expandToGroups(project, other)).toBe(other)
    expect(expandToGroups(p, sel)).toBe(sel)
    expect(touchesGroup(project, sel)).toBe(true)
    expect(touchesGroup(project, other)).toBe(false)
    expect(groupSelection(project, project.groups![0]).length).toBe(3)
  })
  it("is taken apart with its members going into the group it was in, and its lock goes with it", () => {
    const { p, ids } = scene()
    const inner = createGroup(p, [`t:${ids.t}`, `v:${ids.v}`])!
    const outer = createGroup(inner.project, [`t:${ids.t}`, `g:${ids.g}`])!
    const apart = ungroup(outer.project, inner.group.id)
    expect(apart.groups).toHaveLength(1)
    expect(apart.groups![0].members).toEqual([ids.t, ids.v, ids.g])
    expect(ungroup(apart, apart.groups![0].id).groups).toBeUndefined()
    expect(ungroup(apart, "nope")).toBe(apart)
  })
  it("locks everything in it, at any depth, whatever the items' own flags say", () => {
    const { p, ids } = scene()
    const inner = createGroup(p, [`t:${ids.t}`, `v:${ids.v}`])!
    const outer = createGroup(inner.project, [`t:${ids.t}`, `g:${ids.g}`])!
    const locked = setGroupLocked(outer.project, outer.group.id, true)
    expect([...lockedByGroup(locked)].sort()).toEqual([ids.t, ids.v, ids.g].sort())
    expect(lockedByGroup(setGroupLocked(locked, outer.group.id, false)).size).toBe(0)
    // locking the inner group alone locks only its members
    expect([...lockedByGroup(setGroupLocked(outer.project, inner.group.id, true))].sort()).toEqual([ids.t, ids.v].sort())
    expect(lockedInSelection(locked, [`t:${ids.t}`, `m:${ids.m}`])).toEqual([`t:${ids.t}`])
  })
  it("loses what is deleted, and goes when nothing is left in it; a project with no group is returned as it is", () => {
    const { p, ids } = scene()
    expect(pruneGroups(p)).toBe(p)
    const { project } = createGroup(p, [`t:${ids.t}`, `v:${ids.v}`])!
    expect(pruneGroups(project)).toBe(project)
    const lessVia = { ...project, vias: [] }
    expect(pruneGroups(lessVia).groups![0].members).toEqual([ids.t])
    expect(pruneGroups({ ...lessVia, traces: [] }).groups).toBeUndefined()
    // a group that held only a group that goes
    const nested = createGroup(project, [`t:${ids.t}`, `g:${ids.g}`])!
    const gone = pruneGroups({ ...nested.project, traces: [], vias: [], graphics: [] })
    expect(gone.groups).toBeUndefined()
  })
  it("moves as one: every kind of object goes, a locked group stays, and a locked item stays within a free group", () => {
    const { p, ids } = scene()
    const { project, group } = createGroup(p, [`t:${ids.t}`, `v:${ids.v}`, `g:${ids.g}`, `m:${ids.m}`, `c:${ids.c}`])!
    const sel = groupSelection(project, group)
    const moved = moveObjects(project, sel, 2, 3)
    expect(moved.traces[0].points[0]).toEqual({ x: 2, y: 3 })
    expect(moved.vias[0]).toMatchObject({ x: 7, y: 3 })
    expect(moved.components[0].pcb).toMatchObject({ x: 22, y: 23 })
    expect(moved.dimensions![0].a).toEqual({ x: 2, y: 13 })
    expect((moved.graphics![0] as { a: { x: number } }).a.x).toBe(3)
    expect(moveObjects(setGroupLocked(project, group.id, true), sel, 2, 3).traces[0].points[0]).toEqual({ x: 0, y: 0 })
    const withLock = { ...project, components: [{ ...project.components[0], pcb: { ...project.components[0].pcb, locked: true } }] }
    const part = moveObjects(withLock, sel, 1, 1)
    expect(part.components[0].pcb.x).toBe(20)
    expect(part.vias[0].x).toBe(6)
    expect(moveObjects(project, sel, 0, 0)).toBe(project)
  })
  it("turns as one body a quarter turn counter-clockwise about the middle of its box", () => {
    const { p, ids } = scene()
    const { project, group } = createGroup(p, [`t:${ids.t}`, `v:${ids.v}`])!
    const sel = groupSelection(project, group)
    const box = selectionBounds(project, sel)!
    expect(box).toMatchObject({ minX: 0, maxX: 5, minY: 0, maxY: 0 })
    const turned = rotateObjects(project, sel)!
    // the pivot is the middle of the box on the 0.25 grid: (2.5, 0); (0,0) goes to (2.5, -2.5) and (5,0) to (2.5, 2.5)
    expect(turned.project.traces[0].points[0]).toEqual({ x: 2.5, y: -2.5 })
    expect(turned.project.traces[0].points[1]).toEqual({ x: 2.5, y: 2.5 })
    expect(turned.project.vias[0]).toMatchObject({ x: 2.5, y: 2.5 })
    expect(rotateObjects(project, ["w:x"])).toBeNull()
  })
  it("turns a picture round the pivot without turning it, and says so", () => {
    const { p, ids } = scene()
    const imaged: Project = { ...p, images: [{ id: "im1", x: 30, y: 0, layer: "Dwgs.User", scale: 1, file: "d".repeat(64), format: "png", px: 96, py: 96, ppi: 96 }] }
    const { project, group } = createGroup(imaged, [`t:${ids.t}`, "i:im1"])!
    const turned = rotateObjects(project, groupSelection(project, group))!
    expect(turned.notes.join(" ")).toMatch(/moved round the pivot, not turned/)
    expect(turned.project.images![0].x).not.toBe(10)
  })
})

describe("a part's own groups", () => {
  const part = (members: string[][]): ComponentInstance => ({
    id: "c",
    partId: "x",
    ref: "U1",
    props: {},
    footprint: "land",
    sch: { x: 0, y: 0, rot: 0 },
    pcb: { x: 0, y: 0, rot: 0, side: "top", placed: true },
    groups: members.map((m, i) => ({ id: `g${i}`, name: "", members: m })),
  })
  it("shifts the places after a removed drawing down, drops what named it, and removes a group left with nothing", () => {
    const c = part([["s0", "s2", "p1"], ["s1"], ["g0", "t0"]])
    const r = remapPartGroups(c, "s", new Set([1]))
    expect(r.groups!.map((g) => g.members)).toEqual([["s0", "s1", "p1"], ["g0", "t0"]])
    expect(r.groups!.map((g) => g.id)).toEqual(["g0", "g1"])
    const none = remapPartGroups(part([["s0"]]), "s", new Set([0]))
    expect(none.groups).toBeUndefined()
    expect(remapPartGroups(c, "t", new Set())).toBe(c)
  })
})

describe("what a picture's bytes say", () => {
  /** A PNG header of a given size with a `pHYs` chunk of `perMetre` pixels per metre (no pixel data: the header is what is read). */
  function png(px: number, py: number, perMetre?: number): Uint8Array {
    const b: number[] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
    const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]
    const chunk = (type: string, data: number[]) => [...u32(data.length), ...[...type].map((c) => c.charCodeAt(0)), ...data, 0, 0, 0, 0]
    b.push(...chunk("IHDR", [...u32(px), ...u32(py), 8, 6, 0, 0, 0]))
    if (perMetre !== undefined) b.push(...chunk("pHYs", [...u32(perMetre), ...u32(perMetre), 1]))
    b.push(...chunk("IDAT", [0]), ...chunk("IEND", []))
    return new Uint8Array(b)
  }
  it("reads the size and the resolution KiCad derives, with and without its truncation of pixels per centimetre", () => {
    expect(imageFacts(png(64, 32))).toMatchObject({ format: "png", px: 64, py: 32, ppi: 300, legacyPpi: 300 })
    // 3780 pixels per metre is 37.8 per centimetre: 96 per inch exactly, 94 when the .8 is cut off first
    expect(imageFacts(png(10, 10, 3780))).toMatchObject({ ppi: 96, legacyPpi: 94 })
    // 11811 per metre is 118.11 per centimetre: 300 per inch, and 118 cut: 300
    expect(imageFacts(png(10, 10, 11811))).toMatchObject({ ppi: 300, legacyPpi: 300 })
    expect(imageFacts(new Uint8Array([1, 2, 3]))).toMatchObject({ format: null })
  })
  it("reads a JPEG's size and its JFIF density", () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 1, 0, 150, 0, 150, 0, 0, 0xff, 0xc0, 0, 11, 8, 0, 20, 0, 30, 1, 1, 0x11, 0, 0xff, 0xd9])
    expect(imageFacts(jpeg)).toMatchObject({ format: "jpg", px: 30, py: 20, ppi: 150, legacyPpi: 150 })
  })
  it("hashes as the host's file store does", () => {
    const bytes = new Uint8Array([...Array(300).keys()].map((i) => (i * 7) & 255))
    expect(sha256Hex(bytes)).toBe(createHash("sha256").update(bytes).digest("hex"))
    expect(sha256Hex(new Uint8Array(0))).toBe(createHash("sha256").update(new Uint8Array(0)).digest("hex"))
    const big = new Uint8Array(100_000).map((_, i) => (i * 31) & 255)
    expect(sha256Hex(big)).toBe(createHash("sha256").update(big).digest("hex"))
  })
})

describe("a part's own groups follow its land and its edits", () => {
  const withLand = (): Project => {
    const p = createProject("l")
    const c: ComponentInstance = { id: "c1", partId: "x", ref: "U1", props: {}, footprint: "land", sch: { x: 0, y: 0, rot: 0 }, pcb: { x: 0, y: 0, rot: 0, side: "top", placed: true }, groups: [{ id: "g0", name: "", members: ["s0", "s2", "p0"] }] }
    return { ...p, components: [c], footprints: [{ name: "land", pads: [], silk: [], courtyard: { minX: -1, minY: -1, maxX: 1, maxY: 1 }, shapes: [0, 1, 2].map((i) => ({ type: "line" as const, a: { x: i, y: 0 }, b: { x: i, y: 1 }, layer: "F.SilkS", width: 0.1 })) }] }
  }
  it("a removed drawing of the land shifts the places in every part drawn with it", async () => {
    const { removeLandShapes } = await import("../src/model/shapeOps")
    const next = removeLandShapes(withLand(), "land", [1])
    expect(next.components[0].groups![0].members).toEqual(["s0", "s1", "p0"])
  })
  it("another footprint ends them, and a copy of the part in the schematic keeps its own", async () => {
    const { updateComponent } = await import("../src/model/ops")
    expect(updateComponent(withLand(), "c1", { footprint: "other" }).components[0].groups).toBeUndefined()
    expect(updateComponent(withLand(), "c1", { ref: "U9" }).components[0].groups).toHaveLength(1)
    const { pasteItems } = await import("../src/model/schematicEdit")
    const { EXAMPLES } = await import("../src/model/examples")
    const { isPhysical } = await import("../src/model/instances")
    const { findPart } = await import("../src/model/library")
    const { registerProjectParts } = await import("../src/model/customParts")
    const base = structuredClone(EXAMPLES.find((e) => e.id === "blinker")!.project) as Project
    registerProjectParts(base)
    const part = base.components.find((c) => isPhysical(findPart(c.partId)))!
    const grouped = { ...base, components: base.components.map((c) => (c.id === part.id ? { ...c, groups: [{ id: "g0", name: "", members: ["p0"] }] } : c)) }
    const pasted = pasteItems(grouped, { project: grouped, components: [part.id], wires: [], labels: [], blocks: [] }, { x: 5, y: 5 })
    expect(pasted.ok).toBe(true)
    if (pasted.ok) expect(pasted.project.components[pasted.project.components.length - 1].groups).toEqual([{ id: "g0", name: "", members: ["p0"] }])
  })
})
