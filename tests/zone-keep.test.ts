import { describe, expect, it } from "vitest"
import { kicadFiles } from "../src/export/kicad"
import { importKicadBoard } from "../src/model/kicad/board"
import { parseProjectFile, serializeProject } from "../src/model/projectFile"
import { refillZones } from "../src/model/zoneOps"
import type { Project } from "../src/model/types"
import { board, footprint, pad } from "./kicad-board-fixtures"
import { analyze } from "./zones-fixtures"

// KiCad's stored fill of a zone is kept (`Zone.kept`, model/zoneKeep.ts) until an edit near the zone would change it: it is the zone's fill, drawn, checked and written back exactly.

const nets = ['(net 0 "")', '(net 1 "GND")', '(net 2 "SIG")']
const r1 = footprint({ ref: "R1", at: "0 0", pads: [pad({ at: "4 5", net: '(net 1 "GND")' })] })
const r2 = footprint({ ref: "R2", at: "0 0", pads: [pad({ at: "16 5", net: '(net 2 "SIG")' })] })
const RING_A = "(xy 1.123456 1.5) (xy 7.5 1.5) (xy 7.5 8.123457) (xy 4.25 8.5) (xy 1.123456 8.5)"
const RING_B = "(xy 12.5 1.5) (xy 18.5 1.5) (xy 18.5 8.5) (xy 12.5 8.5)"
const settings = "(connect_pads (clearance 0.4)) (min_thickness 0.25) (filled_areas_thickness no) (fill yes (thermal_gap 0.45) (thermal_bridge_width 0.35))"
const polygon = (x0: number, x1: number) => `(polygon (pts (xy ${x0} 1) (xy ${x1} 1) (xy ${x1} 9) (xy ${x0} 9)))`
const filledPolygon = (layer: string, ring: string, island = false) => `(filled_polygon (layer "${layer}") ${island ? "(island) " : ""}(pts ${ring}))`
const zoneA = (fill = true) => `(zone (net 1) (net_name "GND") (layer "F.Cu") (uuid "a1") (hatch edge 0.5) ${settings} ${polygon(1, 8)} ${fill ? filledPolygon("F.Cu", RING_A) : ""})`
const zoneB = (fill = true) => `(zone (net 2) (net_name "SIG") (layer "F.Cu") (uuid "b2") (hatch edge 0.5) ${settings} ${polygon(12, 19)} ${fill ? filledPolygon("F.Cu", RING_B, true) : ""})`

const imported = (body: string[], version?: number): Project => {
  const r = importKicadBoard(board({ nets, body: [r1, r2, ...body], version }))
  if (r.status !== "imported") throw new Error(`${r.status}: ${r.message}`)
  return r.project
}
const out = async (p: Project) => {
  const { files } = await kicadFiles(p)
  return Object.entries(files).find(([name]) => name.endsWith(".kicad_pcb"))![1]
}
const fillOfZone = (p: Project, i: number) => analyze(p).zoneFills.find((f) => f.zoneId === p.zones[i].id)!
const withTrace = (p: Project, points: { x: number; y: number }[]): Project => ({ ...p, traces: [...p.traces, { id: "tx", layer: "top", width: 0.25, points }] })
const origin = (p: Project) => ({ id: p.id, createdAt: p.createdAt, updatedAt: p.updatedAt })

describe("a zone keeps KiCad's own fill", () => {
  it("the import keeps each zone's stored fill, y flipped, as the zone's fill from the file", () => {
    const p = imported([zoneA(), zoneB()])
    const [a, b] = p.zones
    expect(a.kept?.layers).toHaveLength(1)
    expect(a.kept!.layers[0].layer).toBe("top")
    expect(a.kept!.layers[0].rings[0][0]).toEqual({ x: 1.123456, y: -1.5 })
    expect(a.kept!.sig).not.toBe("")
    expect(b.kept!.layers[0].islands).toEqual([0])
    const fa = fillOfZone(p, 0)
    expect(fa.fromFile).toBe(true)
    // the copper is the file's polygon (its regions, to a micrometre), not the editor's
    expect(fa.polygons).toHaveLength(1)
    const outer = fa.polygons[0][0]
    expect(Math.min(...outer.map((q) => q.x))).toBeCloseTo(1.123456, 3)
    expect(Math.max(...outer.map((q) => q.y))).toBeCloseTo(-1.5, 3)
    expect(outer).toHaveLength(5)
    expect(fa.netName).toBe("GND")
  })

  it("reads the stored fill in KiCad's nanometres: two pieces 0.3 um apart stay two, where microns would join them", () => {
    const close = "(xy 1.5 1.5) (xy 4.0001 1.5) (xy 4.0001 8) (xy 1.5 8)"
    const far = "(xy 4.0004 1.5) (xy 7.5 1.5) (xy 7.5 8) (xy 4.0004 8)"
    const zone = `(zone (net 1) (net_name "GND") (layer "F.Cu") (uuid "a1") (hatch edge 0.5) ${settings} ${polygon(1, 8)} ${filledPolygon("F.Cu", close)} ${filledPolygon("F.Cu", far)})`
    const fill = fillOfZone(imported([zone]), 0)
    expect(fill.fromFile).toBe(true)
    expect(fill.polygons).toHaveLength(2)
  })

  it("the export writes the fill as the file had it: the same points in the same order, the island mark, the pen flag", async () => {
    const text = await out(imported([zoneA(), zoneB()]))
    const polys = text.match(/\(filled_polygon [^\n]*/g) ?? []
    expect(polys).toHaveLength(2)
    expect(polys[0]).toBe(filledPolygon("F.Cu", RING_A))
    expect(polys[1]).toBe(filledPolygon("F.Cu", RING_B, true))
    expect(text).toContain("(filled_areas_thickness no)")
  })

  it("a fill the file drew with a pen (filled_areas_thickness yes) is written back as one, and the editor sees the copper grown by half the minimum width", async () => {
    const stroked = zoneA().replace("(filled_areas_thickness no)", "(filled_areas_thickness yes)")
    const p = imported([stroked, zoneB()])
    expect(p.zones[0].kept?.stroked).toBe(true)
    const text = await out(p)
    expect(text.match(/\(filled_areas_thickness yes\)/g)).toHaveLength(1)
    expect(text).toContain(filledPolygon("F.Cu", RING_A))
    const grown = fillOfZone(p, 0).polygons[0][0]
    expect(Math.min(...grown.map((q) => q.x))).toBeCloseTo(1.123456 - 0.125, 2)
  })

  it("an edit inside a zone gives that zone the editor's fill and leaves the other zone's alone", async () => {
    const p = imported([zoneA(), zoneB()])
    const edited = withTrace(p, [
      { x: 2, y: -2 },
      { x: 3, y: -2 },
    ])
    const fills = analyze(edited).zoneFills
    expect(fills.find((f) => f.zoneId === p.zones[0].id)!.fromFile).toBeUndefined()
    expect(fills.find((f) => f.zoneId === p.zones[1].id)!.fromFile).toBe(true)
    const text = await out(edited)
    expect(text).toContain(filledPolygon("F.Cu", RING_B, true))
    expect(text).not.toContain(filledPolygon("F.Cu", RING_A))
  })

  it("an edit far from a zone, or on the other layer, does not touch it", () => {
    const p = imported([zoneA(), zoneB()])
    const far = analyze(
      withTrace(p, [
        { x: 14, y: -2 },
        { x: 15, y: -2 },
      ]),
    ).zoneFills
    expect(far.find((f) => f.zoneId === p.zones[0].id)!.fromFile).toBe(true)
    expect(far.find((f) => f.zoneId === p.zones[1].id)!.fromFile).toBeUndefined()
    const bottom: Project = {
      ...p,
      traces: [
        {
          id: "tb",
          layer: "bottom",
          width: 0.25,
          points: [
            { x: 2, y: -2 },
            { x: 3, y: -2 },
          ],
        },
      ],
    }
    expect(analyze(bottom).zoneFills.every((f) => f.fromFile === true)).toBe(true)
  })

  it("a change to the zone itself, a rule the fill reads, or a part inside it refills it; a rule no fill reads does not", () => {
    const p = imported([zoneA(), zoneB()])
    const isKept = (q: Project, i = 0) => fillOfZone(q, i).fromFile === true
    expect(isKept(p)).toBe(true)
    expect(isKept({ ...p, zones: p.zones.map((z, i) => (i === 0 ? { ...z, clearance: 0.6 } : z)) })).toBe(false)
    expect(isKept({ ...p, zones: p.zones.map((z, i) => (i === 0 ? { ...z, priority: 2 } : z)) })).toBe(false)
    expect(isKept({ ...p, rules: { ...p.rules, pourClearance: 0.9 } })).toBe(false)
    expect(isKept({ ...p, rules: { ...p.rules, traceWidth: 0.9 } })).toBe(true)
    const moved = { ...p, components: p.components.map((c) => (c.ref === "R1" ? { ...c, pcb: { ...c.pcb, x: c.pcb.x + 1 } } : c)) }
    expect(isKept(moved, 0)).toBe(false)
    expect(isKept(moved, 1)).toBe(true)
  })

  it("a zone with no fill in the file is filled by the editor, as before", () => {
    const p = imported([zoneA(false), zoneB()])
    expect(p.zones[0].kept).toBeUndefined()
    const fills = analyze(p).zoneFills
    expect(fills.find((f) => f.zoneId === p.zones[0].id)!.fromFile).toBeUndefined()
    expect(fills.find((f) => f.zoneId === p.zones[0].id)!.polygons.length).toBeGreaterThan(0)
    expect(fills.find((f) => f.zoneId === p.zones[1].id)!.fromFile).toBe(true)
  })

  it("a project with no stored fill has no kept fill and is filled as always", () => {
    const p = imported([zoneA(false), zoneB(false)])
    expect(p.zones.some((z) => z.kept)).toBe(false)
    expect(analyze(p).zoneFills.some((f) => f.fromFile)).toBe(false)
    expect(serializeProject(p)).not.toContain('"ff"')
  })

  it("the stored project keeps the fill exactly and still sees it as valid after it is loaded", () => {
    const p = imported([zoneA(), zoneB()])
    const text = serializeProject(p)
    expect(text).toContain('"ff"')
    const back = parseProjectFile(text, origin(p))
    expect(back.zones[0].kept).toEqual(p.zones[0].kept)
    expect(back.zones[1].kept).toEqual(p.zones[1].kept)
    expect(fillOfZone(back, 0).fromFile).toBe(true)
  })

  it("a stored project from before kept fills loads as it did", () => {
    const p = imported([zoneA(false)])
    const doc = JSON.parse(serializeProject(p))
    expect(doc.version).toBe(3)
    const back = parseProjectFile(doc, origin(p))
    expect(back.zones[0].kept).toBeUndefined()
    expect(back.zones[0].net).toBe("GND")
  })

  it("refill lets go of the kept fills, of the zones given or all of them", () => {
    const p = imported([zoneA(), zoneB()])
    const one = refillZones(p, [p.zones[0].id])
    expect(one.zones[0].kept).toBeUndefined()
    expect(one.zones[1].kept).toBeDefined()
    expect(fillOfZone(one, 0).fromFile).toBeUndefined()
    const plain = refillZones(p)
    expect(plain.zones.some((z) => z.kept)).toBe(false)
    expect(refillZones(plain)).toBe(plain)
  })
})

describe("a via in another net's zone outline but in a hole of its stored fill", () => {
  // SIG's zone on the top covers the via's place by its outline, but KiCad's fill of it stops short of the via; GND's zone on the bottom is filled over it.
  const zones = (fill: boolean) => [
    `(zone (net 2) (net_name "SIG") (layer "F.Cu") (uuid "c3") (hatch edge 0.5) ${settings} ${polygon(1, 19)} ${fill ? filledPolygon("F.Cu", "(xy 1.5 1.5) (xy 10 1.5) (xy 10 8.5) (xy 1.5 8.5)") : ""})`,
    `(zone (net 1) (net_name "GND") (layer "B.Cu") (uuid "d4") (hatch edge 0.5) ${settings} ${polygon(1, 19)} ${fill ? filledPolygon("B.Cu", "(xy 1.5 1.5) (xy 18.5 1.5) (xy 18.5 8.5) (xy 1.5 8.5)") : ""})`,
  ]
  const via = '(via (at 13 5) (size 0.8) (drill 0.4) (layers "F.Cu" "B.Cu") (net 1))'
  const differs = (fill: boolean) => {
    const r = importKicadBoard(board({ nets, body: [r1, r2, ...zones(fill), via] }))
    if (r.status !== "imported") throw new Error(r.message)
    return r.report.entries.filter((e) => e.code === "copper-net-differs").length
  }

  it("is on the net of the copper it is in, KiCad's fill, so the report does not call a stitching via netless", () => {
    expect(differs(true)).toBe(0)
  })

  it("with no stored fill, two zones' outlines of two nets leave it on neither, as before", () => {
    expect(differs(false)).toBe(1)
  })
})
