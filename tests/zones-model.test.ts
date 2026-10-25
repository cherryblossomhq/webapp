import { describe, expect, it } from "vitest"
import { autoroute } from "../src/model/autoroute"
import { boardObstacles } from "../src/model/autoplace"
import { computeConnectivity } from "../src/model/connectivity"
import { addTrace, addVia, createProject } from "../src/model/ops"
import { analyzePcb } from "../src/model/pcb"
import { addZone, deleteZoneCorner, dedupe, insertZoneCorner, makeZone, moveCorner, moveZone, outlinePoints, removeZones, setZoneCorner, updateZone, zoneCorners } from "../src/model/zoneOps"
import { areaContains, areaDistance, areaTouches, higherPriority, isWholeBoardPour, keepoutsFor, needsZoneEngine, zoneArea, zoneLayers, zoneSettings } from "../src/model/zones"
import type { Zone } from "../src/model/types"
import { zoneHit, cornerAt, midpointAt, closesPolygon } from "../src/editor/pcb/zoneEditing"
import { rectangle, twoResistors, withZone } from "./zones-fixtures"

describe("which zone is the editor's own pour", () => {
  it("a zone with a net, a layer and a clearance is, and any other setting makes it a polygon zone", () => {
    const own: Zone = { id: "a", net: "GND", layer: "top", clearance: 0.4 }
    expect(isWholeBoardPour(own)).toBe(true)
    for (const extra of [{ priority: 1 }, { name: "x" }, { minWidth: 0.3 }, { connect: "solid" }, { keepout: {} }, { locked: true }, { edgeGap: 1 }, { holeGap: 0.2 }, { islands: "never" }, { layers: ["top", "bottom"] }, { teardrop: "padvia" }, { smoothing: { kind: "chamfer", radius: 1 } }, { thermalGap: 1 }, { spokeWidth: 1 }]) {
      expect(isWholeBoardPour({ ...own, ...extra } as Zone), JSON.stringify(extra)).toBe(false)
    }
    expect(needsZoneEngine({ zones: [own] })).toBe(false)
    expect(needsZoneEngine({ zones: [own, { ...own, id: "b", outline: [] }] })).toBe(true)
    expect(needsZoneEngine({ zones: [own, { ...own, id: "b", priority: 2 }] })).toBe(true)
  })

  it("settings default to the board's rules and are the zone's own when it has them", () => {
    const p = createProject("rules")
    const plain = zoneSettings(p, { id: "a", net: "GND", layer: "top" })
    expect(plain).toMatchObject({ clearance: p.rules.pourClearance, minWidth: p.rules.pourMinWidth, spokeWidth: p.rules.thermalSpokeWidth, priority: 0, islands: "always", edgeGap: p.rules.edgeClearance, smoothing: null })
    expect(plain.connect).toBe("tht")
    expect(plain.thermalGap).toBe(plain.clearance)
    const own = zoneSettings(p, { id: "a", net: "GND", layer: "top", clearance: 0.7, minWidth: 0.4, connect: "none", thermalGap: 0.9, spokeWidth: 0.6, priority: 3, islands: 12, edgeGap: 1, smoothing: { kind: "fillet", radius: 2 } })
    expect(own).toMatchObject({ clearance: 0.7, minWidth: 0.4, connect: "none", thermalGap: 0.9, spokeWidth: 0.6, priority: 3, islands: 12, edgeGap: 1, smoothing: { kind: "fillet", radius: 2 } })
  })

  it("the higher priority wins, a teardrop beats any other zone, and ties go to the later zone", () => {
    const p = withZone(withZone(createProject("x"), rectangle(0, 0, 1, 1), { net: "A", priority: 1 }, "a"), rectangle(0, 0, 1, 1), { net: "B" }, "b")
    const [a, b] = p.zones
    expect(higherPriority(p, a, b)).toBe(true)
    expect(higherPriority(p, b, a)).toBe(false)
    const tie = { ...p, zones: [{ ...a, priority: 0 }, { ...b, priority: 0 }] }
    expect(higherPriority(tie, tie.zones[1], tie.zones[0])).toBe(true)
    const drop = { ...b, teardrop: "padvia" as const }
    expect(higherPriority(p, drop, a)).toBe(true)
  })
})

describe("editing a zone's polygon", () => {
  const z0 = makeZone(rectangle(0, 0, 10, 6), { net: "GND" })!
  it("makes a zone of a drawn polygon, and none of a line or a repeated point", () => {
    expect(z0.outline).toHaveLength(1)
    expect(outlinePoints(z0)).toEqual(rectangle(0, 0, 10, 6))
    expect(makeZone([{ x: 0, y: 0 }, { x: 1, y: 1 }], {})).toBeNull()
    expect(makeZone([{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 }], {})).toBeNull()
    expect(dedupe([{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 0 }])).toEqual([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }])
    expect(makeZone(rectangle(0, 0, 1, 1), { keepout: { vias: true }, net: "GND" })).toMatchObject({ net: "", keepout: { vias: true } })
    expect(makeZone(rectangle(0, 0, 1, 1), { layers: ["bottom", "top"] })).toMatchObject({ layer: "bottom", layers: ["bottom", "top"] })
  })

  it("moves a corner, and the two pieces that meet there follow", () => {
    const moved = setZoneCorner(z0, 0, 2, { x: 12, y: 8 })
    expect(outlinePoints(moved)).toEqual([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 12, y: 8 }, { x: 0, y: 6 }])
    const segs = moved.outline![0].segs
    expect(segs[1]).toMatchObject({ kind: "line", b: { x: 12, y: 8 } })
    expect(segs[2]).toMatchObject({ kind: "line", a: { x: 12, y: 8 } })
  })

  it("adds a corner on a straight piece and takes one away, keeping three", () => {
    const more = insertZoneCorner(z0, 0, 0, { x: 5, y: 1 })
    expect(outlinePoints(more)).toEqual([{ x: 0, y: 0 }, { x: 5, y: 1 }, { x: 10, y: 0 }, { x: 10, y: 6 }, { x: 0, y: 6 }])
    const less = deleteZoneCorner(more, 0, 1)
    expect(outlinePoints(less)).toEqual(rectangle(0, 0, 10, 6))
    const tri = makeZone([{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 0, y: 4 }], {})!
    expect(deleteZoneCorner(tri, 0, 1)).toBe(tri)
  })

  it("moves a whole zone, arcs and all, and a locked zone does not move or change", () => {
    const arc: Zone = { ...z0, outline: [{ closed: true, segs: [{ kind: "line", a: { x: 0, y: 0 }, b: { x: 4, y: 0 } }, { kind: "arc", start: { x: 4, y: 0 }, mid: { x: 5, y: 2 }, end: { x: 4, y: 4 } }, { kind: "line", a: { x: 4, y: 4 }, b: { x: 0, y: 4 } }, { kind: "line", a: { x: 0, y: 4 }, b: { x: 0, y: 0 } }] }] }
    const shifted = moveZone(arc, 1, -1)
    expect(shifted.outline![0].segs[1]).toEqual({ kind: "arc", start: { x: 5, y: -1 }, mid: { x: 6, y: 1 }, end: { x: 5, y: 3 } })
    const locked = { ...z0, locked: true as const }
    expect(moveZone(locked, 1, 1)).toBe(locked)
    expect(setZoneCorner(locked, 0, 0, { x: 3, y: 3 })).toBe(locked)
    expect(insertZoneCorner(locked, 0, 0, { x: 5, y: 0 })).toBe(locked)
    expect(moveCorner(arc.outline![0], 1, { x: 4, y: 1 }).segs[0]).toMatchObject({ b: { x: 4, y: 1 } })
    expect(zoneCorners(arc)).toHaveLength(4)
  })

  it("changes fields of a zone in the project, one layer or both, and a rule area has no net", () => {
    let p = addZone(createProject("x"), z0)
    p = updateZone(p, z0.id, { priority: 2, layers: ["top", "bottom"] })
    expect(p.zones[0]).toMatchObject({ priority: 2, layer: "top", layers: ["top", "bottom"] })
    p = updateZone(p, z0.id, { layers: ["bottom"] })
    expect(p.zones[0]).toMatchObject({ layer: "bottom" })
    expect(p.zones[0].layers).toBeUndefined()
    p = updateZone(p, z0.id, { priority: undefined })
    expect(p.zones[0].priority).toBeUndefined()
    p = updateZone(p, z0.id, { keepout: { pour: true } })
    expect(p.zones[0].net).toBe("")
    p = updateZone(p, z0.id, { locked: true })
    expect(updateZone(p, z0.id, { priority: 5 })).toBe(p)
    expect(removeZones(p, ["nothing"])).toBe(p)
    expect(removeZones(p, [z0.id]).zones).toEqual([])
    expect(zoneLayers(p.zones[0])).toEqual(["bottom"])
  })
})

describe("the area of a zone", () => {
  const z = makeZone(rectangle(0, 0, 10, 6), {})!
  const area = zoneArea(z)!
  it("knows what is in it, with holes left out, and how far off a point is", () => {
    expect(areaContains(area, { x: 5, y: 3 })).toBe(true)
    expect(areaContains(area, { x: 11, y: 3 })).toBe(false)
    expect(areaDistance(area, { x: 5, y: 3 })).toBe(0)
    expect(areaDistance(area, { x: 12, y: 3 })).toBeCloseTo(2)
    expect(areaDistance(area, { x: 12, y: 3 }, 1)).toBe(Infinity)
    const holed = { ...z, outline: [...z.outline!, makeZone(rectangle(4, 2, 6, 4), {})!.outline![0]] }
    const a2 = zoneArea(holed)!
    expect(areaContains(a2, { x: 5, y: 3 })).toBe(false)
    expect(areaContains(a2, { x: 1, y: 1 })).toBe(true)
  })
  it("a polyline, or a ring, touches it by a point inside, by an edge within the width, or by holding it whole", () => {
    expect(areaTouches(area, [{ x: -3, y: 3 }, { x: 5, y: 3 }], 0)).toBe(true)
    expect(areaTouches(area, [{ x: -3, y: 3 }, { x: -1, y: 3 }], 0.5)).toBe(false)
    expect(areaTouches(area, [{ x: -3, y: 3 }, { x: -0.3, y: 3 }], 0.5)).toBe(true)
    expect(areaTouches(area, [{ x: 20, y: 20 }, { x: 21, y: 20 }], 0.5)).toBe(false)
    expect(areaTouches(area, rectangle(-5, -5, 15, 11), 0, true)).toBe(true)
  })
  it("picks a zone by its edge or its copper, and a corner or an edge middle by reach", () => {
    const p = withZone(twoResistors(), rectangle(-12, -8, 12, 4), { net: "GND" })
    expect(zoneHit(p, { x: -12.05, y: -3 }, 0.5, "top", [])).toBe("z1")
    expect(zoneHit(p, { x: 0, y: -3 }, 0.5, "top", [])).toBeNull()
    const k = withZone(twoResistors(), rectangle(-12, -8, 12, 4), { keepout: { vias: true } })
    expect(zoneHit(k, { x: 0, y: -3 }, 0.5, "top", [])).toBe("z1")
    const zone = p.zones[0]
    expect(cornerAt(zone, { x: -11.9, y: -8.1 }, 0.3)).toMatchObject({ ring: 0, index: 0 })
    expect(cornerAt(zone, { x: 0, y: 0 }, 0.3)).toBeNull()
    expect(midpointAt(zone, { x: 0.1, y: -8 }, 0.3)).toMatchObject({ index: 0, at: { x: 0, y: -8 } })
    expect(closesPolygon(rectangle(0, 0, 1, 1).slice(0, 3), { x: 0.05, y: 0 }, 0.2)).toBe(true)
    expect(closesPolygon(rectangle(0, 0, 1, 1).slice(0, 2), { x: 0.05, y: 0 }, 0.2)).toBe(false)
  })
})

describe("what a keepout keeps out", () => {
  const keep = (flags: object, layers: ("top" | "bottom")[] = ["top"]) => {
    let p = createProject("keepout")
    p = { ...p, board: { ...p.board, width: 40, height: 30, x: 0, y: 0 } }
    return withZone(p, rectangle(-5, -5, 5, 5), { keepout: flags, layers }, "k")
  }
  const violations = (p: ReturnType<typeof keep>) => analyzePcb(p, computeConnectivity(p)).violations.filter((v) => v.kind === "keepout")

  it("a trace or a via inside is an error, and only for what the area keeps out", () => {
    let p = keep({ tracks: true })
    p = addTrace(p, { layer: "top", width: 0.25, points: [{ x: -8, y: 0 }, { x: 8, y: 0 }] }).project
    p = addVia(p, { x: 0, y: 3 }).project
    expect(violations(p).map((v) => v.message)).toEqual(["A trace is inside a keepout that keeps tracks out"])
    const vias = { ...p, zones: p.zones.map((z) => ({ ...z, keepout: { vias: true as const } })) }
    expect(violations(vias).map((v) => v.message)).toEqual(["A via is inside a keepout that keeps vias out"])
  })

  it("a trace on the other layer is not inside a keepout on one layer, and one beside it is not inside", () => {
    let p = keep({ tracks: true }, ["bottom"])
    p = addTrace(p, { layer: "top", width: 0.25, points: [{ x: -8, y: 0 }, { x: 8, y: 0 }] }).project
    expect(violations(p)).toEqual([])
    let q = keep({ tracks: true })
    q = addTrace(q, { layer: "top", width: 0.25, points: [{ x: -8, y: 7 }, { x: 8, y: 7 }] }).project
    expect(violations(q)).toEqual([])
  })

  it("a part that sits in an area that keeps parts out, and a pad in one that keeps pads out, are errors", () => {
    const base = twoResistors()
    const area = withZone(base, rectangle(-8, -3, -4, 3), { keepout: { footprints: true } }, "k")
    expect(analyzePcb(area, computeConnectivity(area)).violations.some((v) => v.kind === "keepout" && /keeps parts out/.test(v.message))).toBe(true)
    const pads = withZone(base, rectangle(-8, -3, -4, 3), { keepout: { pads: true } }, "k")
    expect(analyzePcb(pads, computeConnectivity(pads)).violations.filter((v) => v.kind === "keepout")).toHaveLength(2)
    const far = withZone(base, rectangle(12, 8, 16, 12), { keepout: { pads: true, footprints: true } }, "k")
    expect(analyzePcb(far, computeConnectivity(far)).violations.filter((v) => v.kind === "keepout")).toEqual([])
  })

  it("a rule area that keeps nothing out has no violations and lists no keepouts", () => {
    const p = keep({})
    expect(violations(p)).toEqual([])
    expect(keepoutsFor(p, "tracks", "top")).toEqual([])
    expect(keepoutsFor(keep({ tracks: true }), "tracks", "top")).toHaveLength(1)
  })

  it("the router keeps tracks and vias out of an area that keeps them out, and parts are placed round one that keeps parts out", () => {
    const base = twoResistors()
    // The two SIG pads are joined already by a trace; take it away and route them with a keepout between them.
    const bare = { ...base, traces: [] }
    const blocked = withZone(bare, rectangle(-3, -12, 3, 12), { keepout: { tracks: true, vias: true }, layers: ["top", "bottom"] }, "k")
    const res = autoroute(blocked, { timeLimitMs: 5000 })
    for (const t of res.project.traces) {
      for (let i = 0; i + 1 < t.points.length; i++) expect(areaTouches(zoneArea(blocked.zones[0])!, [t.points[i], t.points[i + 1]], t.width / 2), "a routed trace in the keepout").toBe(false)
    }
    const parts = withZone(base, rectangle(-3, -3, 3, 3), { keepout: { footprints: true } }, "k")
    const obstacles = boardObstacles(parts)
    expect(obstacles.some((b) => b.minX <= 0 && b.maxX >= 0 && b.minY <= 0 && b.maxY >= 0)).toBe(true)
    expect(boardObstacles(base).length).toBeLessThan(obstacles.length)
  })
})

describe("a zone's net follows a rename in the schematic", () => {
  it("renames the net of a zone of its own shape with the labels that name it, and leaves the editor's own pours as they were", async () => {
    const { followNetRenames } = await import("../src/model/copperNets")
    let before = withZone(twoResistors(), rectangle(-12, -8, 12, 4), { net: "GND" })
    before = { ...before, zones: [...before.zones, { id: "own", net: "GND", layer: "bottom" }] }
    const after = { ...before, labels: before.labels.map((l) => (l.name === "GND" ? { ...l, name: "AGND" } : l)) }
    const next = followNetRenames(before, after)
    expect(next.zones.find((z) => z.id === "z1")!.net).toBe("AGND")
    expect(next.zones.find((z) => z.id === "own")!.net).toBe("GND")
    // Nothing renamed, nothing changed.
    expect(followNetRenames(before, before)).toBe(before)
  })
})
