import { describe, expect, it } from "vitest"
import { kicadFiles } from "../src/export/kicad"
import { projectToCircuitJson } from "../src/export/circuitJson"
import { autoroute } from "../src/model/autoroute"
import { computeConnectivity } from "../src/model/connectivity"
import { setCopperLayerCount } from "../src/model/layerOps"
import { BUILT_EXTENSIONS, importKicadBoard, readKicadBoard } from "../src/model/kicad/board"
import { updateComponent } from "../src/model/ops"
import { analyzePcb } from "../src/model/pcb"
import { hasPartZones, withPartZones, worldPartZones } from "../src/model/partZones"
import { parseProjectFile, serializeProject } from "../src/model/projectFile"
import { zoneRings, zoneLayers } from "../src/model/zones"
import type { ComponentInstance, Project, Vec2, Zone } from "../src/model/types"
import { runTool } from "../src/ai/tools"
import { board, footprint, pad } from "./kicad-board-fixtures"
import { diffProjects } from "./kicad-roundtrip-check"
import { unknownNodes } from "./kicad9-nodes"
import { twoResistors } from "./zones-fixtures"

// X30: zones that belong to a part, a keepout or a pour drawn inside a footprint. KiCad writes them in board coordinates (before 20260616) and they move with the part; here they
// are the part's land's (`FootprintDef.zones`, in the land's frame), the board has them where the part stands (`partZones.ts`), and Checks, the router, the pours and the exports read
// them there.

const nets = ['(net 0 "")', '(net 1 "A")', '(net 2 "B")']
const KEEPOUT = (extra = "") => `(keepout (tracks not_allowed) (vias not_allowed) (pads allowed) (copperpour not_allowed) (footprints allowed)) (placement (enabled no) (sheetname "")) ${extra}`
const FILL = "(connect_pads (clearance 0)) (min_thickness 0.25) (filled_areas_thickness no) (fill (thermal_gap 0.5) (thermal_bridge_width 0.5))"
let n = 0
/** A zone inside a footprint, its corners in the board's frame as KiCad writes them. */
const zoneIn = (corners: [number, number][], layer = '(layer "F.Cu")', body = `${KEEPOUT()} ${FILL}`, net = '(net 0) (net_name "")') =>
  `(zone ${net} ${layer} (uuid "00000000-0000-4000-8000-${String(++n).padStart(12, "0")}") (hatch edge 0.5) ${body} (polygon (pts ${corners.map(([x, y]) => `(xy ${x} ${y})`).join(" ")})))`
const SQUARE: [number, number][] = [[9, 4], [11, 4], [11, 6], [9, 6]]
const part = (zones: string[], at = "10 5", layer = "F.Cu", ref = "U1", pads = [pad({ at: "-3 0" })]) => footprint({ ref, at, layer, pads, extra: zones.join(" ") })

const imported = (body: string[], extra: Parameters<typeof board>[0] = {}) => {
  const r = importKicadBoard(board({ nets, body, ...extra }))
  if (r.status !== "imported") throw new Error(`${r.status}: ${r.message}\n${r.report.entries.filter((e) => e.severity === "refused").map((e) => e.why).join("\n")}`)
  return r
}
const pcbOf = async (p: Project) => Object.entries((await kicadFiles(p)).files).find(([k]) => k.endsWith(".kicad_pcb"))![1]
/** The corners of a world zone's outline, rounded to a micron and sorted. */
const corners = (z: Zone): string[] =>
  zoneRings(z)[0].map((p) => `${(Math.round(p.x * 1e3) / 1e3 + 0).toFixed(3)},${(Math.round(p.y * 1e3) / 1e3 + 0).toFixed(3)}`).sort()
/** The file's corners as the project has them (y up), sorted. */
const expected = (pts: [number, number][]): string[] => pts.map(([x, y]) => `${(x + 0).toFixed(3)},${(-y + 0).toFixed(3)}`).sort()
const ofRef = (p: Project, ref: string) => p.components.find((c) => c.ref === ref)!
const move = (p: Project, c: ComponentInstance, pcb: Partial<ComponentInstance["pcb"]>) => updateComponent(p, c.id, { pcb: { ...c.pcb, ...pcb } })

describe("X30 is built, and the gate says so", () => {
  it("BUILT_EXTENSIONS holds X30, the need is still named, and a board with a zone in a part is imported", () => {
    expect(BUILT_EXTENSIONS.has("X30")).toBe(true)
    const text = board({ nets, body: [part([zoneIn(SQUARE)])] })
    expect(readKicadBoard(text).board.footprints[0].zones).toHaveLength(1)
    expect(importKicadBoard(text).status).toBe("imported")
  })

  it("the zone is the land's, in the land's frame, with none of the board's identity", () => {
    const r = imported([part([zoneIn(SQUARE)])])
    const land = r.project.footprints![0]
    expect(land.zones).toHaveLength(1)
    const z = land.zones![0]
    expect(z).toMatchObject({ id: "z0", net: "", layer: "top", keepout: { tracks: true, vias: true, pour: true } })
    expect(z.uuid).toBeUndefined()
    expect(z.unordered).toBeUndefined()
    // the part is at (10, -5) in the project; the zone is round it, y up
    expect(zoneRings(z)[0].map((p) => [p.x, p.y]).sort()).toEqual([[-1, -1], [-1, 1], [1, -1], [1, 1]].sort())
    expect(r.project.zones).toHaveLength(0)
    const e = r.report.entries.find((x) => x.code === "zones-in-parts")
    expect(e?.count).toBe(1)
    expect(e?.object).toMatch(/1 keepout inside 1 part/)
  })

  it("two parts with the same footprint and zone share a land, and the zone is the same for both", () => {
    const a = part([zoneIn(SQUARE)])
    const b = part([zoneIn([[19, 4], [21, 4], [21, 6], [19, 6]])], "20 5", "F.Cu", "U2")
    const r = imported([a, b])
    expect(r.project.footprints).toHaveLength(1)
    expect(worldPartZones(r.project)).toHaveLength(2)
  })
})

describe("the zone is where the file has it, for every way the part is placed", () => {
  const cases: [string, string][] = [
    ["top", "10 5"],
    ["top turned 90", "10 5 90"],
    ["top turned 180", "10 5 180"],
    ["top turned 270", "10 5 270"],
    ["top turned 33", "10 5 33"],
  ]
  for (const [name, at] of cases) {
    it(`a part on the ${name}`, () => {
      const r = imported([part([zoneIn(SQUARE)], at)])
      const [w] = worldPartZones(r.project)
      expect(corners(w)).toEqual(expected(SQUARE))
      expect(w.part).toBe(r.project.components[0].id)
      expect(zoneLayers(w)).toEqual(["top"])
    })
  }
  for (const [name, at] of [["bottom", "10 5"], ["bottom turned 90", "10 5 90"], ["bottom turned 215", "10 5 215"]] as const) {
    it(`a part on the ${name}: the file's B.Cu is the part's own side, and the world has it on the bottom`, () => {
      const r = imported([part([zoneIn(SQUARE, '(layer "B.Cu")')], at, "B.Cu")])
      const [w] = worldPartZones(r.project)
      expect(corners(w)).toEqual(expected(SQUARE))
      expect(zoneLayers(w)).toEqual(["bottom"])
      expect(r.project.footprints![0].zones![0].layer).toBe("top")
    })
  }

  it("a zone on both copper layers, and on the mask, in a part on the bottom", () => {
    const r = imported([part([zoneIn(SQUARE, '(layers "F&B.Cu" "F.Mask")', `${KEEPOUT()} ${FILL}`)], "10 5", "B.Cu")])
    const land = r.project.footprints![0].zones![0]
    // F.Mask of the file is the far side of a part on the bottom: the part's own side calls it its back
    expect(land).toMatchObject({ layers: ["top", "bottom"], other: ["B.Mask"] })
    const [w] = worldPartZones(r.project)
    expect(w).toMatchObject({ layers: ["top", "bottom"], other: ["F.Mask"] })
  })
})

describe("the zone moves, turns and flips with its part", () => {
  const base = () => imported([part([zoneIn(SQUARE)])]).project

  it("a move carries it, to the micron", () => {
    const p = base()
    const c = ofRef(p, "U1")
    const q = move(p, c, { x: c.pcb.x + 7, y: c.pcb.y - 3 })
    expect(corners(worldPartZones(q)[0])).toEqual(expected(SQUARE.map(([x, y]) => [x + 7, y + 3] as [number, number])))
  })

  it("a quarter turn turns it about the part", () => {
    const p = base()
    const c = ofRef(p, "U1")
    const q = move(p, c, { rot: 90 })
    const [w] = worldPartZones(q)
    const about = (pt: [number, number]): [number, number] => {
      // the part is at (10, 5) in the file's frame; a quarter turn counter-clockwise on the board (y up) is a quarter turn clockwise in the file's
      const dx = pt[0] - 10
      const dy = pt[1] - 5
      return [10 + dy, 5 - dx]
    }
    expect(corners(w)).toEqual(expected(SQUARE.map(about)))
  })

  it("a flip puts it on the other side: its layer, and its place mirrored about the part", () => {
    const p = base()
    const c = ofRef(p, "U1")
    const q = move(p, c, { side: "bottom" })
    const [w] = worldPartZones(q)
    expect(zoneLayers(w)).toEqual(["bottom"])
    // mirrored about the part's own vertical axis: x of the part's frame changes sign
    const mirrored = SQUARE.map(([x, y]) => [20 - x, y] as [number, number])
    expect(corners(w)).toEqual(expected(mirrored))
    // and back
    expect(corners(worldPartZones(move(q, ofRef(q, "U1"), { side: "top" }))[0])).toEqual(expected(SQUARE))
  })

  it("a part that is not placed has none on the board, and one deleted takes its zones", () => {
    const p = base()
    const c = ofRef(p, "U1")
    expect(worldPartZones(move(p, c, { placed: false }))).toHaveLength(0)
    expect(worldPartZones({ ...p, components: [] })).toHaveLength(0)
  })

  it("a board with no zone in a part is the very same project and the very same (empty) list", () => {
    const plain = twoResistors()
    expect(hasPartZones(plain)).toBe(false)
    expect(withPartZones(plain)).toBe(plain)
    expect(worldPartZones(plain)).toBe(worldPartZones(twoResistors()))
    const p = base()
    expect(withPartZones(p)).toBe(withPartZones(p))
    expect(withPartZones(withPartZones(p))).toBe(withPartZones(p))
    expect(withPartZones(p).zones).toHaveLength(1)
    expect(p.zones).toHaveLength(0)
    // while nothing changes, the zones are the same objects
    expect(worldPartZones(p)).toBe(worldPartZones(p))
  })
})

describe("Checks and the router keep to a keepout inside a part", () => {
  const withTrack = (track: string, extraBody: string[] = [], zones = [zoneIn(SQUARE)]) =>
    imported([part(zones, "10 5", "F.Cu", "U1", [pad({ at: "-3 0", net: '(net 1 "A")' }), pad({ number: "2", at: "-3 2", net: '(net 2 "B")' })]), track, ...extraBody])

  it("a track inside it is an error, and not when the part is moved away or the keepout lets tracks through", () => {
    const r = withTrack('(segment (start 8.5 5) (end 11.5 5) (width 0.2) (layer "F.Cu") (net 1))')
    const kinds = (p: Project) => analyzePcb(p, computeConnectivity(p)).violations.filter((v) => v.kind === "keepout").map((v) => v.message)
    expect(kinds(r.project)).toEqual(["A trace is inside a keepout that keeps tracks out"])
    // moved off the track
    expect(kinds(move(r.project, ofRef(r.project, "U1"), { y: ofRef(r.project, "U1").pcb.y - 6 }))).toEqual([])
    // the same track on the other layer is not inside a keepout that is on the top only
    const other = withTrack('(segment (start 8.5 5) (end 11.5 5) (width 0.2) (layer "B.Cu") (net 1))')
    expect(kinds(other.project)).toEqual([])
    // a part on the bottom has its keepout on the bottom
    const flipped = imported([part([zoneIn(SQUARE, '(layer "B.Cu")')], "10 5", "B.Cu", "U1", [pad({ at: "-3 0", net: '(net 1 "A")' })]), '(segment (start 8.5 5) (end 11.5 5) (width 0.2) (layer "B.Cu") (net 1))'])
    expect(kinds(flipped.project)).toHaveLength(1)
  })

  it("a part is not kept out of its own keepout that keeps parts out, and another one is", () => {
    const keep = `(keepout (tracks allowed) (vias allowed) (pads allowed) (copperpour allowed) (footprints not_allowed)) (placement (enabled no) (sheetname "")) ${FILL}`
    const r = imported([part([zoneIn(SQUARE, '(layer "F.Cu")', keep)], "10 5", "F.Cu", "U1", [pad({ at: "0 0", size: "0.5 0.5" })]), footprint({ ref: "U2", at: "10.5 5.2", pads: [pad({ at: "0 0", size: "0.5 0.5" })] })])
    const msgs = analyzePcb(r.project, computeConnectivity(r.project)).violations.filter((v) => v.kind === "keepout").map((v) => v.message)
    expect(msgs.some((m) => /U2 is inside/.test(m))).toBe(true)
    expect(msgs.some((m) => /U1 is inside/.test(m))).toBe(false)
  })

  it("the router keeps its tracks out of it", () => {
    const text = board({
      nets,
      body: [
        footprint({ ref: "J1", at: "3 5", pads: [pad({ at: "0 0", net: '(net 1 "A")' })] }),
        footprint({ ref: "J2", at: "17 5", pads: [pad({ at: "0 0", net: '(net 1 "A")' })] }),
        // a wall of keepout across the middle of the board on both layers, inside a part that has no pad there
        part([zoneIn([[8, 3], [12, 3], [12, 7], [8, 7]], '(layers "F.Cu" "B.Cu")')], "10 9", "F.Cu", "U9", [pad({ at: "0 0" })]),
      ],
    })
    const r = importKicadBoard(text)
    if (r.status !== "imported") throw new Error(r.message)
    const res = autoroute(r.project, { timeLimitMs: 20000 })
    const [w] = worldPartZones(res.project)
    const ring = zoneRings(w)[0]
    const inside = (p: Vec2) => p.x > Math.min(...ring.map((q) => q.x)) + 0.05 && p.x < Math.max(...ring.map((q) => q.x)) - 0.05 && p.y > Math.min(...ring.map((q) => q.y)) + 0.05 && p.y < Math.max(...ring.map((q) => q.y)) - 0.05
    expect(res.project.traces.length).toBeGreaterThan(0)
    for (const t of res.project.traces) for (const pt of t.points) expect(inside(pt)).toBe(false)
    expect(res.project.zones).toHaveLength(0)
  })
})

describe("pours", () => {
  const pour = `(connect_pads (clearance 0.3)) (min_thickness 0.25) (filled_areas_thickness no) (fill yes (thermal_gap 0.5) (thermal_bridge_width 0.5))`
  const board1 = '(zone (net 1) (net_name "A") (layer "F.Cu") (uuid "00000000-0000-4000-8000-0000000000ff") (hatch edge 0.5) ' + pour + " (polygon (pts (xy 1 1) (xy 19 1) (xy 19 9) (xy 1 9))))"
  const fillArea = (p: Project) => analyzePcb(p, computeConnectivity(p)).zoneFills.reduce((s, f) => s + f.polygons.reduce((a, poly) => a + poly.reduce((b, ring, i) => b + (i === 0 ? 1 : -1) * Math.abs(ring.reduce((t, q, k) => t + (ring[(k + 1) % ring.length].x - q.x) * (ring[(k + 1) % ring.length].y + q.y), 0) / 2), 0), 0), 0)

  it("a keepout in a part that keeps pours out takes a hole out of a pour on its layer, and moves with the part", () => {
    const withPart = (at: string) => imported([footprint({ ref: "J1", at: "2 2", pads: [pad({ at: "0 0", net: '(net 1 "A")' })] }), part([zoneIn(SQUARE.map(([x, y]) => [x + (Number(at.split(" ")[0]) - 10), y] as [number, number]))], at), board1]).project
    const a = fillArea(withPart("10 5"))
    const none = imported([footprint({ ref: "J1", at: "2 2", pads: [pad({ at: "0 0", net: '(net 1 "A")' })] }), part([], "10 5"), board1]).project
    expect(fillArea(none) - a).toBeGreaterThan(3.9)
    expect(fillArea(none) - a).toBeLessThan(4.2)
    // moved to a place where the pour is not (off the pour to the right), the hole closes
    const p = withPart("10 5")
    const away = move(p, ofRef(p, "U1"), { x: 40 })
    expect(Math.abs(fillArea(away) - fillArea(move(none, ofRef(none, "U1"), { x: 40 })))).toBeLessThan(0.05)
  })

  it("a pour inside a part is filled, on no net, and drawn where the part stands", () => {
    const r = imported([part([zoneIn([[8, 3], [12, 3], [12, 7], [8, 7]], '(layer "F.Cu")', pour)], "10 5")])
    expect(r.project.footprints![0].zones![0]).toMatchObject({ net: "", clearance: 0.3, minWidth: 0.25 })
    const fills = analyzePcb(r.project, computeConnectivity(r.project)).zoneFills
    expect(fills).toHaveLength(1)
    expect(fills[0].zoneId).toBe(`${r.project.components[0].id}~z0`)
    expect(fills[0].polygons.length).toBeGreaterThan(0)
  })

  it("a pour inside a part that is on a net is refused as inexact, in words", () => {
    const r = importKicadBoard(board({ nets, body: [part([zoneIn(SQUARE, '(layer "F.Cu")', pour, '(net 1) (net_name "A")')], "10 5", "F.Cu", "U1", [pad({ at: "0 0", net: '(net 1 "A")' })])] }))
    expect(r.status).toBe("refused")
    if (r.status === "refused") {
      expect(r.reason).toBe("inexact")
      expect(r.message).toMatch(/a pour inside a part that is on a net/)
    }
  })
})

describe("the KiCad file says it back", () => {
  const roundTrip = async (p: Project) => {
    const text = await pcbOf(p)
    expect(unknownNodes(text)).toEqual([])
    const again = importKicadBoard(text)
    if (again.status !== "imported") throw new Error(`the written board is refused: ${again.message}`)
    return { text, differences: diffProjects(p, again.project), again: again.project }
  }

  it("writes a zone inside its footprint, in the board's frame, and imports as the same project, for a part on each side and turned", async () => {
    const r = imported([
      part([zoneIn(SQUARE)], "10 5", "F.Cu", "U1"),
      part([zoneIn([[19, 4], [21, 4], [21, 6], [19, 6]], '(layer "B.Cu")')], "20 5 90", "B.Cu", "U2"),
      part([zoneIn([[2, 7], [4, 7], [4, 9], [2, 9]], '(layers "F&B.Cu" "F.SilkS")', `${KEEPOUT()} ${FILL}`)], "3 8 215", "F.Cu", "U3"),
    ])
    const { text, differences } = await roundTrip(r.project)
    expect(differences).toEqual([])
    // each zone is inside its footprint in the file, none among the board's
    const read = readKicadBoard(text).board
    expect(read.zones).toHaveLength(0)
    expect(read.footprints.map((f) => f.zones.length)).toEqual([1, 1, 1])
    // and where the file first had it
    expect(text).toContain("(xy 9 4)")
    expect(text).toContain("(xy 11 6)")
  })

  it("a pour inside a part is written with its fill and reads back", async () => {
    const pour = `(connect_pads (clearance 0.3)) (min_thickness 0.25) (filled_areas_thickness no) (fill yes (thermal_gap 0.5) (thermal_bridge_width 0.5))`
    const r = imported([part([zoneIn([[8, 3], [12, 3], [12, 7], [8, 7]], '(layer "F.Cu")', pour)])])
    const { text, differences } = await roundTrip(r.project)
    expect(differences).toEqual([])
    expect(text).toMatch(/\(filled_polygon/)
  })
})

describe("the project file", () => {
  it("stores the zones on the land, compactly and exactly, and reads them back the same", () => {
    const r = imported([part([zoneIn(SQUARE), zoneIn([[8, 7], [12, 7], [12, 8]], '(layer "F.Cu")', `${KEEPOUT()} ${FILL}`)])])
    const raw = JSON.parse(serializeProject(r.project)).project
    expect(raw.footprints[0].zones[0].ol[0][0]).toBe("p")
    expect(raw.footprints[0].zones[0].outline).toBeUndefined()
    const back = parseProjectFile(serializeProject(r.project), { id: "p", createdAt: 1, updatedAt: 1 })
    expect(back.footprints![0].zones).toEqual(r.project.footprints![0].zones)
    expect(back.zones).toEqual([])
    expect(serializeProject(back)).toBe(serializeProject(parseProjectFile(serializeProject(back), { id: "p", createdAt: 1, updatedAt: 1 })))
  })

  it("repairs a land whose zones do not read: a zone with no polygon is dropped, ids are made from the place", () => {
    const r = imported([part([zoneIn(SQUARE)])])
    const raw = JSON.parse(serializeProject(r.project))
    raw.project.footprints[0].zones = [{ id: "x", net: "", layer: "top" }, { ...raw.project.footprints[0].zones[0], id: "weird" }]
    const back = parseProjectFile(raw, { id: "p", createdAt: 1, updatedAt: 1 })
    expect(back.footprints![0].zones!.map((z) => z.id)).toEqual(["z0"])
  })

  it("a project with no zone in a part stores no `zones` on any land", () => {
    const r = imported([footprint({ pads: [pad({ at: "0 0" })] })])
    expect(JSON.stringify(JSON.parse(serializeProject(r.project)).project.footprints)).not.toContain("zones")
  })
})

describe("editing", () => {
  it("taking away a copper layer takes it from the zones of a part, and a part on the bottom keeps its inner layers where they were", () => {
    const L4 = '(layers (0 "F.Cu" signal) (4 "In1.Cu" signal) (6 "In2.Cu" signal) (2 "B.Cu" signal) (44 "Edge.Cuts" user))'
    const r = imported([part([zoneIn(SQUARE, '(layers "F.Cu" "In1.Cu")', `${KEEPOUT()} ${FILL}`)])], { layers: L4 })
    expect(r.project.footprints![0].zones![0].layers).toEqual(["top", "in1"])
    const two = setCopperLayerCount(r.project, 2).project
    expect(two.footprints![0].zones![0]).toMatchObject({ layer: "top" })
    expect(two.footprints![0].zones![0].layers).toBeUndefined()
    const only = imported([part([zoneIn(SQUARE, '(layer "In2.Cu")')], "10 5", "F.Cu", "U1")], { layers: L4 })
    expect(setCopperLayerCount(only.project, 2).project.footprints![0].zones).toBeUndefined()
  })

  it("Circuit JSON has a keepout where the part stands, and Sakura's get_design lists it with its part", () => {
    const r = imported([part([zoneIn(SQUARE)])])
    const cj = projectToCircuitJson(r.project).elements.filter((e) => e.type === "pcb_keepout")
    expect(cj).toHaveLength(1)
    const text = JSON.stringify(runTool(r.project, "get_design", {}))
    expect(text).toContain("U1")
    expect(text).toMatch(/keepout/)
  })
})
