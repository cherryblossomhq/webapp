import { describe, expect, it } from "vitest"
import { runTool } from "../src/ai/tools"
import { computeConnectivity } from "../src/model/connectivity"
import { pcbCourtyard } from "../src/model/instances"
import { addComponent, autoPlacePcb, createProject, labelPin, resolvePinSpec, updateComponent } from "../src/model/ops"
import { analyzePcb } from "../src/model/pcb"
import { areaReport, areasOfPart, defaultPlacement, sheetNames, groupNamesOf, nearestInAreas, partInAreas, partSheet, placementAreas, placementProblems, ringInArea } from "../src/model/placementAreas"
import { zoneArea } from "../src/model/zones"
import { makeZone } from "../src/model/zoneOps"
import type { ComponentInstance, Project, Vec2, Zone, ZonePlacement } from "../src/model/types"
import { renameGroup } from "../src/model/boardObjects"
import { setSheetSymbol } from "../src/model/sheetOps"
import { imp } from "./kicad-sheets-fixtures"

// X20: placement rule areas on the model, in autoplace, in Checks and in Sakura's tools.

const rect = (x0: number, y0: number, x1: number, y1: number): Vec2[] => [
  { x: x0, y: y0 },
  { x: x1, y: y0 },
  { x: x1, y: y1 },
  { x: x0, y: y1 },
]

/** An area on both sides with a target (a rule area that keeps nothing out). */
function area(points: Vec2[], placement: ZonePlacement, extra: Partial<Zone> = {}): Zone {
  return { ...makeZone(points, { layers: ["top", "bottom"], keepout: {} })!, placement, ...extra }
}

/** A 60 by 40 board (centre 0, 0) with `n` resistors, the first `classed` of them in the class "Power" and on sheet "/Power/", none placed. */
function board(n: number, classed: number): Project {
  let p = createProject("X20")
  p = { ...p, board: { ...p.board, width: 60, height: 40, x: 0, y: 0 } }
  for (let i = 0; i < n; i++) {
    p = addComponent(p, "resistor", { sch: { x: i * 3, y: 0 } }).project
    const c = p.components[p.components.length - 1]
    p = updateComponent(p, c.id, i < classed ? { classes: ["Power"], sheetPath: "/Power/" } : { sheetPath: "/" })
  }
  return p
}

const withAreas = (p: Project, ...zones: Zone[]): Project => ({ ...p, zones: [...p.zones, ...zones] })
const byRef = (p: Project, ref: string) => p.components.find((c) => c.ref === ref)!
const inside = (c: ComponentInstance, z: Zone) => ringInArea(zoneArea(z)!, [
  { x: pcbCourtyard(c)!.minX, y: pcbCourtyard(c)!.minY },
  { x: pcbCourtyard(c)!.maxX, y: pcbCourtyard(c)!.minY },
  { x: pcbCourtyard(c)!.maxX, y: pcbCourtyard(c)!.maxY },
  { x: pcbCourtyard(c)!.minX, y: pcbCourtyard(c)!.maxY },
])

describe("which parts an area picks", () => {
  it("picks by sheet path, by component class and by group, on the side the area is on, when it is on and names something", () => {
    let p = board(4, 2)
    const c = (ref: string) => byRef(p, ref)
    p = { ...p, groups: [{ id: "g1", name: "Front end", members: [c("R3").id] }, { id: "g2", name: "Board", members: ["g1"] }] }
    const sheet = area(rect(-30, 0, 0, 20), { by: "sheet", name: "/Power/" })
    const cls = area(rect(0, 0, 30, 20), { by: "class", name: "Power" })
    const grp = area(rect(-30, -20, 0, 0), { by: "group", name: "Board" })
    p = withAreas(p, sheet, cls, grp)
    expect(areasOfPart(p, c("R1")).map((z) => z.id)).toEqual([sheet.id, cls.id])
    expect(areasOfPart(p, c("R2")).map((z) => z.id)).toEqual([sheet.id, cls.id])
    expect(areasOfPart(p, c("R3")).map((z) => z.id)).toEqual([grp.id])
    expect(areasOfPart(p, c("R4"))).toEqual([])
    // the group a group is in counts, and a part is not in a group it is not in
    expect([...groupNamesOf(p, c("R3").id)].sort()).toEqual(["Board", "Front end"])
    expect(groupNamesOf(p, c("R1").id).size).toBe(0)
    // another side, off, and no name pick nothing
    const topOnly = { ...sheet, id: "t", layer: "top" as const, layers: undefined }
    expect(areasOfPart(withAreas({ ...p, zones: [] }, topOnly), c("R1"), undefined, "bottom")).toEqual([])
    expect(placementAreas({ zones: [{ ...sheet, placement: { by: "sheet", name: "/Power/", off: true } }, { ...cls, placement: { by: "class", name: "" } }] })).toEqual([])
  })

  it("is on the sheet its symbol is on in a project with sheets, and the sheet its footprint says in one without", () => {
    const r = imp()
    expect(r.project.components.map((c) => partSheet(r.project, c))).toEqual(["/", "/Power/"])
    const flat = board(1, 1)
    expect(partSheet(flat, flat.components[0])).toBe("/Power/")
  })
})

describe("names an area keeps up with", () => {
  it("a group renamed takes the areas that name it, and a sheet renamed (or the one above it) the areas that name its path", () => {
    let p = board(2, 1)
    p = { ...p, groups: [{ id: "g1", name: "Tail", members: [byRef(p, "R1").id] }] }
    p = withAreas(p, area(rect(0, 0, 5, 5), { by: "group", name: "Tail" }), area(rect(0, 5, 5, 10), { by: "class", name: "Tail" }))
    const renamed = renameGroup(p, "g1", "Head")
    expect(renamed.zones.map((z) => z.placement)).toEqual([{ by: "group", name: "Head" }, { by: "class", name: "Tail" }])
    // another group still called Tail keeps its area
    const twin = renameGroup({ ...p, groups: [...p.groups!, { id: "g2", name: "Tail", members: [] }] }, "g1", "Head")
    expect(twin.zones[0].placement).toEqual({ by: "group", name: "Tail" })

    const r = imp().project
    const sym = r.sheetSymbols![0]
    const withArea = withAreas(r, area(rect(0, 0, 5, 5), { by: "sheet", name: "/Power/" }), area(rect(0, 5, 5, 10), { by: "sheet", name: "/" }))
    const moved = setSheetSymbol(withArea, sym.id, { name: "Supply" })
    expect(moved.zones.map((z) => z.placement?.name)).toEqual(["/Supply/", "/"])
    expect(setSheetSymbol(withArea, sym.id, { file: "other.kicad_sch" }).zones).toBe(withArea.zones)
  })
})

describe("sitting in an area", () => {
  const L = { zone: { ...makeZone([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 4 }, { x: 4, y: 4 }, { x: 4, y: 10 }, { x: 0, y: 10 }])! } }
  const a = zoneArea(L.zone)!

  it("holds a ring that lies inside, flush against an edge, and refuses one that crosses an edge, sits in the notch or covers a hole", () => {
    const box = (x0: number, y0: number, x1: number, y1: number) => rect(x0, y0, x1, y1)
    expect(ringInArea(a, box(1, 1, 3, 3))).toBe(true)
    expect(ringInArea(a, box(0, 0, 2, 2))).toBe(true)
    expect(ringInArea(a, box(5, 1, 10, 4))).toBe(true)
    expect(ringInArea(a, box(3, 1, 5, 3))).toBe(true)
    expect(ringInArea(a, box(3, 3, 5, 5))).toBe(false)
    expect(ringInArea(a, box(5, 5, 6, 6))).toBe(false)
    expect(ringInArea(a, box(-1, 1, 1, 2))).toBe(false)
    // a hole
    const donut = { ...makeZone(rect(0, 0, 10, 10))!, outline: [...makeZone(rect(0, 0, 10, 10))!.outline!, ...makeZone(rect(4, 4, 6, 6))!.outline!] }
    expect(ringInArea(zoneArea(donut)!, box(3, 3, 7, 7))).toBe(false)
    expect(ringInArea(zoneArea(donut)!, box(0.5, 0.5, 3, 3))).toBe(true)
  })

  it("moves a part the least to the nearest place it fits, and says when none does", () => {
    const p = board(1, 1)
    const c = p.components[0]
    const z = area(rect(10, 0, 20, 10), { by: "class", name: "Power" })
    const fit = nearestInAreas(c, [z], { x: 0, y: 5 })!
    const moved = { ...c, pcb: { ...c.pcb, ...fit } }
    expect(partInAreas(moved, [z])).toBe(true)
    // nearest: it is as far left as it can be, and the height is kept
    expect(fit.y).toBeCloseTo(5, 1)
    expect(Math.abs(fit.x - 10 - (-pcbCourtyard({ ...c, pcb: { ...c.pcb, x: 0, y: 0 } })!.minX))).toBeLessThan(0.02)
    expect(nearestInAreas(c, [z], { x: 15, y: 5 })).toEqual({ x: 15, y: 5 })
    expect(nearestInAreas(c, [area(rect(0, 0, 0.5, 0.5), { by: "class", name: "Power" })], { x: 0, y: 0 })).toBeNull()
    // an L: a part asked to go in the notch goes into the arm nearest
    const l = { ...L.zone, placement: { by: "class", name: "Power" } as ZonePlacement }
    const q = nearestInAreas(c, [l], { x: 7, y: 7 })!
    expect(partInAreas({ ...c, pcb: { ...c.pcb, ...q } }, [l])).toBe(true)
  })
})

describe("Checks", () => {
  it("names a part outside the area that holds it, by part and by area, and says nothing of one inside or of a part no area picks", () => {
    let p = board(3, 2)
    p = withAreas(p, area(rect(-30, -20, 0, 20), { by: "class", name: "Power" }, { name: "Power corner" }))
    p = updateComponent(p, byRef(p, "R1").id, { pcb: { x: -10, y: 0, placed: true } })
    p = updateComponent(p, byRef(p, "R2").id, { pcb: { x: 10, y: 0, placed: true } })
    p = updateComponent(p, byRef(p, "R3").id, { pcb: { x: 12, y: 0, placed: true } })
    const found = analyzePcb(p, computeConnectivity(p)).violations.filter((v) => v.kind === "placement-area")
    expect(found.map((v) => v.message)).toEqual(["R2 is outside placement area Power corner (the parts of class Power), where it has to sit"])
    expect(found[0].severity).toBe("error")
    expect(placementProblems(p).map((x) => x.component.ref)).toEqual(["R2"])
    expect(areaReport(p, p.zones[0])).toEqual({ picked: 2, outside: ["R2"] })
    // a switched off area says nothing
    const off = { ...p, zones: [{ ...p.zones[0], placement: { by: "class", name: "Power", off: true } as ZonePlacement }] }
    expect(analyzePcb(off, computeConnectivity(off)).violations.filter((v) => v.kind === "placement-area")).toEqual([])
  })

  it("is the same object of work for a project with no placement area: no violation of its kind", () => {
    const p = board(2, 0)
    expect(placementProblems(p)).toEqual([])
    expect(analyzePcb(p, computeConnectivity(p)).violations.some((v) => v.kind === "placement-area")).toBe(false)
  })
})

describe("automatic placement", () => {
  it("packs the parts an area holds inside it, for a class, a sheet and a group, and leaves the others anywhere", () => {
    let p = board(12, 6)
    p = { ...p, groups: [{ id: "g1", name: "Tail", members: [byRef(p, "R11").id, byRef(p, "R12").id] }] }
    p = withAreas(
      p,
      area(rect(-28, 4, -8, 18), { by: "class", name: "Power" }),
      area(rect(8, 4, 28, 18), { by: "group", name: "Tail" }),
    )
    const placed = autoPlacePcb(p, true)
    for (const c of placed.components) expect(c.pcb.placed).toBe(true)
    for (const ref of ["R1", "R2", "R3", "R4", "R5", "R6"]) expect(inside(byRef(placed, ref), placed.zones[0]), ref).toBe(true)
    for (const ref of ["R11", "R12"]) expect(inside(byRef(placed, ref), placed.zones[1]), ref).toBe(true)
    expect(placementProblems(placed)).toEqual([])
    expect(analyzePcb(placed, computeConnectivity(placed)).violations.filter((v) => v.kind === "overlap" || v.kind === "outside-board")).toEqual([])
  })

  it("keeps the parts in an L shaped area, off its notch, and holds them there when the wiring pulls them away", () => {
    let p = board(8, 8)
    // Every part is wired to a part of the other class on the far side of the board, so the improving step wants to pull them out of the area: they must still stay inside.
    p = addComponent(p, "resistor", { sch: { x: 40, y: 0 } }).project
    p = updateComponent(p, p.components[8].id, { pcb: { x: 25, y: 0, placed: true }, sheetPath: "/" })
    for (let i = 1; i <= 8; i++) {
      p = labelPin(p, resolvePinSpec(p, `R${i}.1`)!, "PULL")
    }
    p = labelPin(p, resolvePinSpec(p, "R9.1")!, "PULL")
    const l = { ...makeZone([{ x: -28, y: -18 }, { x: -8, y: -18 }, { x: -8, y: -8 }, { x: -18, y: -8 }, { x: -18, y: 18 }, { x: -28, y: 18 }], { layers: ["top", "bottom"], keepout: {} })!, placement: { by: "class", name: "Power" } as ZonePlacement }
    p = withAreas(p, l)
    const placed = autoPlacePcb(p, true)
    expect(placementProblems(placed)).toEqual([])
    for (const c of placed.components.filter((x) => x.classes?.length)) expect(inside(c, placed.zones[0]), c.ref).toBe(true)
  })

  it("puts what an area is too small for outside it, where Checks reports it, rather than on top of other parts", () => {
    let p = board(6, 6)
    p = withAreas(p, area(rect(-28, 10, -20, 16), { by: "class", name: "Power" }))
    const placed = autoPlacePcb(p, true)
    expect(placed.components.every((c) => c.pcb.placed)).toBe(true)
    const outside = placementProblems(placed)
    expect(outside.length).toBeGreaterThan(0)
    expect(outside.length).toBeLessThan(6)
    expect(analyzePcb(placed, computeConnectivity(placed)).violations.filter((v) => v.kind === "overlap")).toEqual([])
  })

  it("does not move a project with no area any differently", () => {
    const p = board(6, 3)
    const a = autoPlacePcb(p, true)
    const b = autoPlacePcb({ ...p, zones: [{ ...makeZone(rect(-5, -5, 5, 5), { keepout: {} })! }] }, true)
    expect(b.components.map((c) => c.pcb)).toEqual(a.components.map((c) => c.pcb))
  })
})

describe("Sakura", () => {
  const power = () => {
    let p = board(4, 2)
    for (const [i, ref] of ["R1", "R2", "R3", "R4"].entries()) p = updateComponent(p, byRef(p, ref).id, { pcb: { x: -20 + i * 10, y: 0, placed: true } })
    return p
  }

  it("makes a placement area from a polygon and a target, says which parts it picks and which sit outside it", () => {
    const r = runTool(power(), "set_pour", { layer: "both", polygon: [-30, -10, -12, -10, -12, 10, -30, 10], places: "class:Power" })
    expect(r.isError).toBe(false)
    expect(r.result).toMatch(/Added a placement area for the parts of class Power in a polygon of 4 corners \(id z/)
    expect(r.result).toMatch(/It picks 2 placed parts; outside it: R2\. Move them in with place_parts/)
    const z = r.project.zones[0]
    expect(z.placement).toEqual({ by: "class", name: "Power" })
    expect(z.keepout).toEqual({})
    expect(z.layers).toEqual(["top", "bottom"])
    expect(z.net).toBe("")
  })

  it("takes a sheet by its name, refuses one it does not know, and changes or takes off the target of an area by its id", () => {
    const p = power()
    expect(runTool(p, "set_pour", { layer: "both", polygon: [0, 0, 5, 0, 5, 5], places: "sheet:Nowhere" }).isError).toBe(true)
    expect(runTool(p, "set_pour", { layer: "both", polygon: [0, 0, 5, 0, 5, 5], places: "sheet:/Power/" }).isError).toBe(false)
    expect(runTool(p, "set_pour", { layer: "both", polygon: [0, 0, 5, 0, 5, 5], places: "planet:Mars" }).result).toMatch(/sheet:\/Power\/, class:NAME or group:NAME/)
    const made = runTool(p, "set_pour", { layer: "both", polygon: [-30, -10, -12, -10, -12, 10, -30, 10], places: "class:Power" }).project
    const id = made.zones[0].id
    const changed = runTool(made, "set_pour", { layer: "both", id, places: "group:Tail" })
    expect(changed.project.zones[0].placement).toEqual({ by: "group", name: "Tail" })
    const cleared = runTool(made, "set_pour", { layer: "both", id, places: "" })
    expect(cleared.project.zones[0].placement).toBeUndefined()
    expect(runTool(p, "set_pour", { layer: "both", net: "GND", places: "class:Power" }).isError).toBe(true)
  })

  it("keeps a part a placement area holds inside it when it is placed: a spot outside is moved in, and said", () => {
    const made = runTool(power(), "set_pour", { layer: "both", polygon: [-30, -10, -12, -10, -12, 10, -30, 10], places: "class:Power" }).project
    const r = runTool(made, "place_parts", { placements: [{ ref: "R1", x: 20, y: 5 }] })
    expect(r.isError).toBe(false)
    const c = byRef(r.project, "R1")
    expect(inside(c, r.project.zones[0])).toBe(true)
    expect(c.pcb.y).toBeCloseTo(5, 1)
    expect(r.result).toMatch(/R1: .*kept inside a placement area for the parts of class Power: \(20\.00, 5\.00\) is outside it, so it is at \(/)
    // a part no area holds goes where it is told
    const free = runTool(made, "place_parts", { placements: [{ ref: "R3", x: 20, y: 5 }] })
    expect(byRef(free.project, "R3").pcb.x).toBe(20)
    expect(free.result).not.toMatch(/kept inside/)
    // a move by dx and a turn are held the same way
    const far = runTool(made, "place_parts", { placements: [{ ref: "R1", dx: 100 }] })
    expect(inside(byRef(far.project, "R1"), far.project.zones[0])).toBe(true)
    // a part that does not fit is refused, and the area is told to be made bigger
    const tiny = { ...made, zones: [{ ...made.zones[0], outline: makeZone(rect(-30, -10, -29.5, -9.5))!.outline }] }
    const no = runTool(tiny, "place_parts", { placements: [{ ref: "R1", x: 20, y: 5 }] })
    expect(no.isError).toBe(true)
    expect(no.result).toMatch(/R1: it does not fit inside a placement area for the parts of class Power; make the area bigger/)
  })

  it("lists the areas, the classes and the parts outside in get_design, and sets classes with update_component", () => {
    const made = runTool(power(), "set_pour", { layer: "both", polygon: [-30, -10, -12, -10, -12, 10, -30, 10], places: "class:Power" }).project
    const design = JSON.parse(runTool(made, "get_design", {}).result)
    expect(design.zones[0]).toMatchObject({ places: "class:Power", parts_outside: ["R2"] })
    expect(design.zones[0].keepout).toBeUndefined()
    expect(design.components.find((c: { ref: string }) => c.ref === "R1").classes).toEqual(["Power"])
    const set = runTool(made, "update_component", { ref: "R4", classes: ["Power", " Fast ", "Power"] })
    expect(set.isError).toBe(false)
    expect(byRef(set.project, "R4").classes).toEqual(["Power", "Fast"])
    const none = runTool(set.project, "update_component", { ref: "R4", classes: [] })
    expect(byRef(none.project, "R4").classes).toBeUndefined()
  })

  it("says in layout_pcb what no area has room for", () => {
    let p = board(6, 6)
    p = withAreas(p, area(rect(-28, 10, -20, 16), { by: "class", name: "Power" }))
    const r = runTool(p, "layout_pcb", {})
    expect(r.isError).toBe(false)
    expect(r.result).toMatch(/part\(s\) are outside their placement area \(R\d/)
  })
})

describe("the sheets a placement area can name", () => {
  it("a board brought in without its schematic offers the sheets its parts say they are on", () => {
    const p = board(3, 2)
    expect(sheetNames(p)).toEqual(["/", "/Power/"])
    // the first sheet with no area of its own is the default
    const first = defaultPlacement(p, [])
    expect(first).toEqual({ by: "sheet", name: "/" })
    const taken = { ...p, zones: [area(rect(-5, -5, 5, 5), { by: "sheet", name: "/" })] }
    expect(defaultPlacement(taken, [])).toEqual({ by: "sheet", name: "/Power/" })
  })
})
