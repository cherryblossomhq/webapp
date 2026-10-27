import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { Clipper, FillRule, type Paths64 } from "@countertype/clipper2-ts"
import { describe, expect, it } from "vitest"
import { kicadFiles } from "../src/export/kicad"
import { computeConnectivity } from "../src/model/connectivity"
import { BUILT_EXTENSIONS, importKicadBoard } from "../src/model/kicad/board"
import { analyzePcb } from "../src/model/pcb"
import type { Project, Zone } from "../src/model/types"
import { parseSexpr } from "./kicad-census/sexpr.mjs"
import { BY_DESIGN, diffProjects, REPAIRED } from "./kicad-roundtrip-check"
import { unknownNodes } from "./kicad9-nodes"

// X24, X25 and X27 over the corpus boards that use them. The oracle shares nothing with `src`: its own reader (`kicad-census/sexpr.mjs`) takes what the file says, and the hatched fills are compared with
// the copper the file itself stored (`filled_polygon`), which KiCad drew with its own code.
//
//   KICAD_CORPUS=<corpus dir> npx vitest run tests/kicad-x24-corpus.test.ts

const CORPUS = process.env.KICAD_CORPUS
type Node = string | Node[]
const kids = (n: Node, name: string): Node[][] => (Array.isArray(n) ? (n.filter((c) => Array.isArray(c) && c[0] === name) as Node[][]) : [])
const kid = (n: Node, name: string) => kids(n, name)[0]
const word = (n: Node | undefined, at = 1) => (Array.isArray(n) && typeof n[at] === "string" ? (n[at] as string) : undefined)
const num = (n: Node | undefined, at = 1) => Number(word(n, at))
const read = (path: string) => parseSexpr(readFileSync(path, "utf8"))[0] as Node[]
const pcb = (rel: string) => join(CORPUS!, rel)

const HATCHED = [
  { rel: "kicad-source/qa/data/pcbnew/hatch_thermal_connectivity/hatch_thermal_connectivity.kicad_pcb", release: 10, xor: 0.1 },
  { rel: "projects/anway0404__Arduino_OpenTherm_shield/Arduino_OpenTherm_shield.kicad_pcb", release: 9, xor: 0.2 },
  { rel: "projects/michpro__Arduino_LMeter_shield/Arduino_LMeter_shield.kicad_pcb", release: 9, xor: 0.2 },
  { rel: "projects/rniwase__tsuraraGB/pcb/midi/tGB-midi.kicad_pcb", release: 6, xor: 0.8 },
  { rel: "projects/rniwase__tsuraraGB/pcb/programmer/tGB-prog.kicad_pcb", release: 6, xor: 0.8 },
  { rel: "projects/nodestark__mdb-esp32-cashless/kicad/mdb-slave-esp32s3-mini/mdb-slave-esp32s3-mini.kicad_pcb", release: 9, xor: 0.2 },
]

const U = 1e4
const mod = (a: number, g: number) => ((a % g) + g) % g

/** The lattice a polygon set shows: the two most common places, in the grid's own frame, at which its edges that are along the grid's axes lie, along each axis, modulo the pitch. */
function lattice(rings: { x: number; y: number }[][], angle: number, pitch: number) {
  const t = (angle * Math.PI) / 180
  // The polygons are in the file's frame (y down): KiCad lays the grid out after turning the copper by minus the angle
  const rot = (p: { x: number; y: number }) => ({ x: p.x * Math.cos(t) - p.y * Math.sin(t), y: p.x * Math.sin(t) + p.y * Math.cos(t) })
  const hist = [new Map<number, number>(), new Map<number, number>()]
  for (const ring of rings) {
    const q = ring.map(rot)
    for (let i = 0; i < q.length; i++) {
      const a = q[i]
      const b = q[(i + 1) % q.length]
      const dx = b.x - a.x
      const dy = b.y - a.y
      const len = Math.hypot(dx, dy)
      if (len < 0.4) continue
      const axis = Math.abs(dy) < 1e-3 * len ? 1 : Math.abs(dx) < 1e-3 * len ? 0 : -1
      if (axis < 0) continue
      const key = Math.round(mod(axis === 1 ? a.y : a.x, pitch) * 50) / 50
      hist[axis].set(key, (hist[axis].get(key) ?? 0) + len)
    }
  }
  return hist.map((m) =>
    [...m.entries()]
      .sort((x, y) => y[1] - x[1])
      .slice(0, 2)
      .map(([k]) => k)
      .sort((x, y) => x - y),
  )
}

/** The widths the two phases of an axis make: the band and the hole, whichever way round (they add up to the pitch). */
const widths = (phases: number[], pitch: number) => {
  const d = phases[1] - phases[0]
  return [d, pitch - d].sort((x, y) => x - y)
}

describe.skipIf(!CORPUS || !existsSync(CORPUS ?? ""))("X24 over the corpus", () => {
  for (const { rel, release, xor } of HATCHED) {
    it(`${rel.split("/").pop()}: every hatched pour is cut as its stored copper is, in its grid and its area`, () => {
      const text = readFileSync(pcb(rel), "utf8")
      const result = importKicadBoard(text)
      expect(result.status).toBe("imported")
      if (result.status !== "imported") return
      const root = read(pcb(rel))
      const zones = kids(root, "zone")
      // (a hatched pour with no stored copper is one KiCad never filled, or a sliver the importer does not bring)
      const hatched = zones.filter((z) => word(kid(kid(z, "fill") ?? [], "mode")) === "hatch" && kids(z, "filled_polygon").length > 0)
      expect(hatched.length).toBeGreaterThan(0)
      const project = result.project
      // the project's hatched pours are the file's, in the file's order
      const ofProject = project.zones.filter((z) => z.hatch)
      expect(ofProject).toHaveLength(hatched.length)
      const fills = analyzePcb(project, computeConnectivity(project)).zoneFills
      let compared = 0
      for (const [i, z] of hatched.entries()) {
        const mine = ofProject[i] as Zone
        const fill = kid(z, "fill")!
        expect(mine.hatch, `zone ${i}`).toMatchObject({ thickness: num(kid(fill, "hatch_thickness")), gap: num(kid(fill, "hatch_gap")) })
        expect(mine.hatch!.angle ?? 0).toBe(num(kid(fill, "hatch_orientation")))
        expect(!!mine.hatch!.fromFill).toBe(release < 10)
        const pitch = mine.hatch!.thickness + mine.hatch!.gap
        for (const layer of ["F.Cu", "B.Cu"]) {
          const stored = kids(z, "filled_polygon").filter((p) => word(kid(p, "layer")) === layer)
          if (!stored.length) continue
          const file = stored.map((p) => kids(kid(p, "pts")!, "xy").map((q) => ({ x: Number(q[1]), y: Number(q[2]) })))
          const f = fills.find((x) => x.zoneId === mine.id && x.layer === (layer === "F.Cu" ? "top" : "bottom"))!
          // ours are in the editor's frame (y up)
          const ours = f.polygons.flatMap((poly) => poly.map((ring) => ring.map((p) => ({ x: p.x, y: -p.y }))))
          // the band and the hole are the widths KiCad's grid has, to a hundredth of a millimetre (the file's and ours alike)
          const angle = mine.hatch!.angle ?? 0
          const a = lattice(ours, angle, pitch)
          const b = lattice(file, angle, pitch)
          // (a grid that is not turned has its lines along the pour's own edges and the clearances', which the edges of the copper are mostly, so only a turned one shows its grid in them)
          for (const axis of angle === 0 ? [] : [0, 1]) {
            if (a[axis].length < 2 || b[axis].length < 2) continue
            const [wa, wb] = [widths(a[axis], pitch), widths(b[axis], pitch)]
            expect(Math.abs(wa[0] - wb[0]), `${rel} ${layer} axis ${axis} band ${wa} vs ${wb}`).toBeLessThan(0.02)
            // where the grid starts: on a KiCad 10 board exactly where the file's is; on an older one at the corner of the copper, which moves with the copper's own corner (the editor's fill reaches the edge by its own rule)
            if (release === 10) a[axis].forEach((p, k) => expect(Math.min(Math.abs(p - b[axis][k]), pitch - Math.abs(p - b[axis][k])), `${layer} axis ${axis} phase`).toBeLessThan(0.02))
          }
          // the copper: the same amount, and the same place to the extent the grids line up
          const toPaths = (rings: { x: number; y: number }[][]): Paths64 => rings.map((r) => r.map((p) => ({ x: Math.round(p.x * U), y: Math.round(p.y * U) })))
          const fu = Clipper.union(toPaths(file.map((r) => r.map((p) => ({ x: p.x, y: -p.y })))), [], FillRule.NonZero)
          const mu = Clipper.union(toPaths(ours.map((r) => r.map((p) => ({ x: p.x, y: -p.y })))), [], FillRule.EvenOdd)
          const area = (p: Paths64) => Math.abs(Clipper.areaPaths(p)) / (U * U)
          const [af, am] = [area(fu), area(mu)]
          const diff = area(Clipper.difference(fu, mu, FillRule.NonZero)) + area(Clipper.difference(mu, fu, FillRule.NonZero))
          expect(diff / af, `${rel} ${layer}: stored ${af.toFixed(1)}, ours ${am.toFixed(1)}`).toBeLessThan(xor)
          expect(Math.abs(am - af) / af, `${rel} ${layer} area`).toBeLessThan(0.25)
          compared++
        }
      }
      expect(compared).toBeGreaterThan(0)
    })
  }

  it("a hatched pour of a KiCad 9 file is written and read back as it was", async () => {
    const result = importKicadBoard(readFileSync(pcb(HATCHED[0].rel), "utf8"))
    expect(result.status).toBe("imported")
    if (result.status !== "imported") return
    const written = Object.entries((await kicadFiles(result.project)).files).find(([k]) => k.endsWith(".kicad_pcb"))![1]
    expect(unknownNodes(written)).toEqual([])
    const again = importKicadBoard(written)
    expect(again.status).toBe("imported")
    if (again.status === "imported") expect(diffProjects(result.project, again.project).filter((d) => ![...BY_DESIGN, ...REPAIRED].some((re) => re.test(d.kind)))).toEqual([])
  })

  it("the copper thieving pattern of KiCad's own test is refused, named", () => {
    const r = importKicadBoard(readFileSync(pcb("kicad-source/qa/data/pcbnew/drc_copper_thieving/copper_thieving.kicad_pcb"), "utf8"))
    expect(r.status === "refused" && r.reason).toBe("inexact")
    expect(r.status === "refused" && r.message).toMatch(/copper thieving pattern/)
  })

  it("the board of KiCad's own test with tracks open through the mask has every one, in its own side's mask", () => {
    const rel = "kicad-source/qa/data/pcbnew/issue18878.kicad_pcb"
    const r = importKicadBoard(readFileSync(pcb(rel), "utf8"))
    expect(r.status).toBe("imported")
    if (r.status !== "imported") return
    const root = read(pcb(rel))
    const open = [...kids(root, "segment"), ...kids(root, "arc")].filter((t) => kid(t, "layers"))
    expect(open.length).toBeGreaterThan(0)
    // a polyline of joined segments is one trace, so count the segments each trace is
    const segments = (p: Project) => p.traces.filter((t) => t.bare).reduce((n, t) => n + (t.arc ? 1 : t.points.length - 1), 0)
    expect(segments(r.project)).toBe(open.length)
    for (const t of open) expect(word(kid(t, "layers"), 2)).toBe("F.Mask")
    expect(r.project.traces.filter((t) => t.bare).every((t) => t.layer === "top")).toBe(true)
  })

  it("the line ends and colours of KiCad's own tests are kept", () => {
    const ends = importKicadBoard(readFileSync(pcb("kicad-source/qa/data/pcbnew/line_ending_zone_flood/line_ending_zone_flood.kicad_pcb"), "utf8"))
    expect(ends.status).toBe("imported")
    if (ends.status === "imported") {
      const root = read(pcb("kicad-source/qa/data/pcbnew/line_ending_zone_flood/line_ending_zone_flood.kicad_pcb"))
      const withEnds = [...kids(root, "gr_line"), ...kids(root, "gr_arc"), ...kids(root, "gr_curve")].filter((s) => kid(s, "start_shape") || kid(s, "end_shape"))
      expect((ends.project.graphics ?? []).filter((g) => g.ends)).toHaveLength(withEnds.length)
      expect(withEnds.length).toBeGreaterThan(0)
    }
    const rel = "projects/cormoran__PMW3610-breakout/kicad_projects/PMW3610-breakout-v1/pmw2610-breakout.kicad_pcb"
    const coloured = importKicadBoard(readFileSync(pcb(rel), "utf8"))
    expect(coloured.status).toBe("imported")
    if (coloured.status === "imported") {
      const root = read(pcb(rel))
      // every coloured drawing of this board is on Edge.Cuts: the outline is cut along the line's centre, whatever colour it is drawn in (the report's accounting says so)
      const withColour = kids(root, "gr_poly").filter((s) => kid(kid(s, "stroke") ?? [], "color"))
      expect(withColour.length).toBeGreaterThan(0)
      expect(withColour.every((s) => word(kid(s, "layer")) === "Edge.Cuts")).toBe(true)
      expect((coloured.project.graphics ?? []).filter((g) => g.color)).toHaveLength(0)
      expect(coloured.report.account!.importedPaths.has("gr_poly>stroke>color")).toBe(false)
    }
  })

  it("a hatch position of KiCad's own tests is kept, on the layer it names, with no hatch", () => {
    const rel = "kicad-source/qa/data/pcbnew/plugins/kicad_sexpr/Issue19775_ZoneLayers/LayerEnumerate.kicad_pcb"
    const r = importKicadBoard(readFileSync(pcb(rel), "utf8"))
    expect(r.status).toBe("imported")
    if (r.status === "imported") {
      expect(r.project.zones[0].hatchAt).toEqual({ top: { x: 1, y: -1 } })
      expect(r.project.zones[0].hatch).toBeUndefined()
    }
  })
})

describe.skipIf(!CORPUS || !existsSync(CORPUS ?? ""))("X25 and X27 over the corpus", () => {
  it("KiCad's own board of tables inside parts: every table is its lines and its cells' text boxes", () => {
    const rel = "kicad-source/qa/data/pcbnew/embedded_table_rotated_legacy_v10.kicad_pcb"
    const r = importKicadBoard(readFileSync(pcb(rel), "utf8"))
    expect(r.status).toBe("imported")
    if (r.status !== "imported") return
    const root = read(pcb(rel))
    const fps = kids(root, "footprint").filter((fp) => kid(fp, "table"))
    expect(fps.length).toBe(5)
    const cells = fps.flatMap((fp) => kids(kid(kid(fp, "table")!, "cells")!, "table_cell"))
    const mine = r.project.components.flatMap((c) => (c.texts ?? []).filter((t) => t.box))
    expect(mine.map((t) => t.text).sort()).toEqual(cells.map((c) => word(c)!).sort())
    // every cell's box is the file's rectangle
    // (a table in a part that was turned writes its cells' corners as `pts`, a thousandth of a micrometre off the rectangle)
    const dims = (c: Node[]) => {
      const corners = kids(kid(c, "pts") ?? [], "xy").map((p) => [Number(p[1]), Number(p[2])])
      const [a, b] = corners.length ? [[Math.min(...corners.map((p) => p[0])), Math.min(...corners.map((p) => p[1]))], [Math.max(...corners.map((p) => p[0])), Math.max(...corners.map((p) => p[1]))]] : [[num(kid(c, "start"), 1), num(kid(c, "start"), 2)], [num(kid(c, "end"), 1), num(kid(c, "end"), 2)]]
      return [Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1])]
    }
    const sorted = (list: number[][]) => list.map((d) => d.map((v) => Math.round(v * 1e5)).join("x")).sort()
    expect(sorted(mine.map((t) => [t.box!.w, t.box!.h]))).toEqual(sorted(cells.map(dims)))
    expect(r.report.entries.find((e) => e.code === "tables-flattened")?.count).toBe(5)
    // the lines of each table are in the land of its part, on the table's layer
    const lands = r.project.footprints!.filter((f) => f.shapes?.some((s) => s.type === "line" && s.width === 0.2))
    expect(lands.length).toBeGreaterThan(0)
  })

  it("the boards whose dimensions are drawn inside a part import with every one of them, the points the file gives", () => {
    for (const rel of ["kicad-source/demos/cm5_minima/CM5_MINIMA_3.kicad_pcb", "kicad-source/demos/royalblue54L_feather/nfc_antenna/RoyalBlue54L-NFC-Antenna/RoyalBlue54L-NFC-Antenna.kicad_pcb"]) {
      const r = importKicadBoard(readFileSync(pcb(rel), "utf8"))
      expect(r.status, rel).toBe("imported")
      if (r.status !== "imported") continue
      const root = read(pcb(rel))
      const inParts = kids(root, "footprint").flatMap((fp) => kids(fp, "dimension"))
      expect(inParts.length).toBeGreaterThan(0)
      const mine = r.project.dimensions ?? []
      expect(mine.length).toBe(kids(root, "dimension").length + inParts.length)
      for (const d of inParts) {
        const pts = kids(kid(d, "pts")!, "xy")
        expect(mine.some((m) => Math.abs(m.a.x - Number(pts[0][1])) < 1e-6 && Math.abs(m.a.y + Number(pts[0][2])) < 1e-6 && Math.abs(m.b.x - Number(pts[1][1])) < 1e-6)).toBe(true)
      }
      expect(r.report.entries.find((e) => e.code === "dimensions-flattened")?.count).toBe(inParts.length)
    }
  })

  it("KiCad's API test board is stopped by its Data Matrix code alone (X23, variants, is another slice's), and a board with a hidden QR code gets past X24, X25 and X27", () => {
    const withVariants = new Set([...BUILT_EXTENSIONS, "X23"])
    const sink = importKicadBoard(readFileSync(pcb("kicad-source/qa/data/pcbnew/api_kitchen_sink.kicad_pcb"), "utf8"), { built: withVariants })
    expect(sink.status === "refused" && sink.report.entries.filter((e) => e.severity === "refused").map((e) => e.object)).toEqual(["a datamatrix barcode"])
    const antenna = importKicadBoard(readFileSync(pcb("projects/ICDT-Inatel-Cubesat-Design-Team__S-Band-Antenna/hardware/PCB/Antenna.kicad_pcb"), "utf8"), { built: withVariants })
    expect(antenna.status).toBe("imported")
    expect(antenna.status === "imported" && antenna.report.entries.find((e) => e.code === "barcodes-hidden")?.count).toBe(1)
  })
})
