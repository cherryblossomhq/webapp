import { describe, expect, it } from "vitest"
import { gerberCopper, gerberMask, gerberPaste } from "../src/export/gerber"
import { excellonDrill, drillHoles } from "../src/export/excellon"
import { kicadFiles } from "../src/export/kicad"
import { projectToCircuitJson } from "../src/export/circuitJson"
import { stepBoard } from "../src/export/step3d"
import { runTool } from "../src/ai/tools"
import { computeConnectivity } from "../src/model/connectivity"
import { componentFootprint, pcbPads } from "../src/model/instances"
import { importKicadBoard } from "../src/model/kicad/board"
import { analyzePcb } from "../src/model/pcb"
import { padSummary, patchPad, updateLandPad } from "../src/model/padOps"
import { pointPadDistance } from "../src/model/padDistance"
import { fillZones } from "../src/model/pour"
import { parseProjectFile, PROJECT_FILE_VERSION, serializeProject } from "../src/model/projectFile"
import type { PadDef, Project } from "../src/model/types"
import { board, footprint, pad } from "./kicad-board-fixtures"

const imp = (text: string): Project => {
  const r = importKicadBoard(text)
  if (r.status !== "imported") throw new Error(`refused: ${r.message}`)
  return r.project
}
const NETS = ['(net 0 "")', '(net 1 "A")', '(net 2 "B")']
const near = (a: number, b: number, eps = 1e-6) => expect(Math.abs(a - b)).toBeLessThanOrEqual(eps)

describe("Gerber: copper, mask and paste of pads with X7 features", () => {
  const project = imp(
    board({
      nets: NETS,
      body: [
        footprint({
          ref: "U1",
          at: "10 5",
          pads: [
            pad({ number: "1", at: "-3 0", shape: "roundrect", size: "2 1", net: '(net 1 "A")', extra: "(roundrect_rratio 0.25) (solder_mask_margin 0.1) (solder_paste_margin -0.1)" }),
            pad({ number: "2", at: "0 0", shape: "rect", size: "2 1", extra: "(solder_paste_margin_ratio -0.1)" }),
            pad({ number: "3", at: "3 0", shape: "circle", size: "1 1", layers: '"F.Cu" "F.Mask"' }),
          ],
        }),
      ],
    }),
  )
  const regions = (g: string) => g.split("G36*").length - 1
  it("a rounded pad is plotted as a region, a plain rectangle and circle as flashes", () => {
    const g = gerberCopper(project, "top")
    // pads 1 (rounded) and 2 (a margin of its own) are regions; the circle is a flash
    expect(regions(g)).toBe(2)
    expect(g).toMatch(/%ADD\d+C,1\*%/)
  })
  it("the mask opening of a pad with its own margin follows the margin, and has the round corners KiCad plots", () => {
    const g = gerberMask(project, "top")
    // pad 1: 2 by 1 grown 0.1 all round, rounded; the plain rectangle (the board's 0 margin) keeps a flash
    expect(regions(g)).toBeGreaterThanOrEqual(1)
    const xs = [...g.matchAll(/X(-?\d+)Y(-?\d+)D0[12]\*/g)].map((m) => Number(m[1]) / 1e6)
    expect(Math.max(...xs.filter((x) => x < 9))).toBeCloseTo(7 + 0 + 1 + 0.1 + 0, 5)
  })
  it("the paste aperture is the pad less its own margin and ratio on each axis; a pad with no paste layer has none", () => {
    const g = gerberPaste(project, "top")
    // pad 2: ratio -0.1 of 2 by 1 is -0.2 and -0.1: an aperture of 1.6 by 0.8, as a region; pad 1: -0.1 each side; pad 3 has no paste layer
    const xs = [...g.matchAll(/X(-?\d+)Y(-?\d+)D0[12]\*/g)].map((m) => Number(m[1]) / 1e6)
    expect(xs.length).toBeGreaterThan(0)
    expect(regions(g)).toBe(2)
    expect(Math.max(...xs)).toBeLessThan(12.5)
  })
})

describe("drill files: slots at any angle and holes off the pad's centre", () => {
  it("a slot on a part at 30 degrees is routed along its axis, and an off-centre hole is drilled where the hole is", () => {
    const p = imp(
      board({
        body: [
          footprint({
            ref: "J1",
            at: "20 10 30",
            pads: [
              pad({ number: "1", type: "thru_hole", shape: "oval", at: "0 0 30", size: "2 1.4", layers: '"*.Cu" "*.Mask"', extra: "(drill oval 1.4 0.7)" }),
              pad({ number: "2", type: "thru_hole", shape: "rect", at: "4 0 30", size: "2 2", layers: '"*.Cu" "*.Mask"', extra: "(drill 0.8 (offset 0.5 0))" }),
            ],
          }),
        ],
      }),
    )
    const holes = drillHoles(p)
    const slot = holes.find((h) => h.slot)!
    near(Math.hypot(slot.slot![1].x - slot.slot![0].x, slot.slot![1].y - slot.slot![0].y), 0.7, 1e-4)
    near((((Math.atan2(slot.slot![1].y - slot.slot![0].y, slot.slot![1].x - slot.slot![0].x) * (180 / Math.PI)) % 180) + 180) % 180, 30, 1e-3)
    const round = holes.find((h) => !h.slot && Math.abs(h.diameter - 0.8) < 1e-9)!
    // the hole is at the pad's place, 4 along the part's x from its origin, not at the copper
    near(round.x, 20 + 4 * Math.cos(Math.PI / 6), 1e-4)
    near(round.y, -10 + 4 * Math.sin(Math.PI / 6), 1e-4)
    expect(excellonDrill(p)).toContain("G85")
  })
  it("a non-plated slot goes to the non-plated file, and its copper ring does not make it plated", () => {
    const p = imp(board({ body: [footprint({ ref: "H1", pads: [pad({ number: "", type: "np_thru_hole", shape: "oval", at: "0 0", size: "3 2", layers: '"*.Cu" "*.Mask"', extra: "(drill oval 2 1)" }), pad({ number: "1", at: "6 0" })] })] }))
    expect(excellonDrill(p, { plated: true })).not.toContain("G85")
    expect(excellonDrill(p, { plated: false })).toContain("G85")
    // its copper ring is plotted on both sides
    expect(gerberCopper(p, "top")).toMatch(/G36\*/)
    expect(gerberCopper(p, "bottom")).toMatch(/G36\*/)
  })
})

describe("the checks", () => {
  const two = (clear: string) =>
    imp(
      board({
        nets: NETS,
        body: [
          footprint({ ref: "R1", at: "10 5", pads: [pad({ number: "1", at: "0 0", size: "1 1", net: '(net 1 "A")', extra: clear })] }),
          footprint({ ref: "R2", at: "11.1 5", pads: [pad({ number: "1", at: "0 0", size: "1 1", net: '(net 2 "B")' })] }),
        ],
      }),
    )
  const clearance = (p: Project) => analyzePcb(p, computeConnectivity(p)).violations.filter((v) => v.kind === "clearance")
  it("a pad's own clearance replaces the rules': a gap of 0.1 passes at 0.05 and fails at 0.3", () => {
    // rules.clearance is KiCad's 0.2 here; the pads are 0.1 apart
    expect(clearance(two("")).length).toBe(1)
    expect(clearance(two("(clearance 0.05)"))).toEqual([])
    expect(clearance(two("(clearance 0.5)")).length).toBe(1)
  })
  it("the openings of pads of two nets that run together are an error, and a part that allows it is not", () => {
    const joined = (extra: string) => {
      const p = imp(
        board({
          nets: NETS,
          body: [footprint({ ref: "U1", extra, pads: [pad({ number: "1", at: "0 0", size: "1 1", net: '(net 1 "A")', extra: "(solder_mask_margin 0.1)" }), pad({ number: "2", at: "1.15 0", size: "1 1", net: '(net 2 "B")', extra: "(solder_mask_margin 0.1)" })] })],
        }),
      )
      return analyzePcb(p, computeConnectivity(p)).violations.filter((v) => v.kind === "mask-bridge")
    }
    expect(joined("").length).toBe(1)
    expect(joined("(attr smd allow_soldermask_bridges)")).toEqual([])
  })
  it("a board with no pad of X7 and no minimum web has no mask check", () => {
    const p = imp(board({ nets: NETS, body: [footprint({ ref: "U1", pads: [pad({ number: "1", at: "0 0", size: "1 1", net: '(net 1 "A")' }), pad({ number: "2", at: "1.05 0", size: "1 1", net: '(net 2 "B")' })] })] }))
    expect(analyzePcb(p, computeConnectivity(p)).violations.filter((v) => v.kind === "mask-bridge")).toEqual([])
  })
  it("the annular ring of a hole off its pad's centre is what the pad leaves on the thin side", () => {
    const p = imp(board({ body: [footprint({ ref: "J1", pads: [pad({ number: "1", type: "thru_hole", shape: "circle", at: "0 0", size: "1.6 1.6", layers: '"*.Cu" "*.Mask"', extra: "(drill 0.8 (offset 0.3 0))" })] })] }))
    // the copper is 0.3 from the hole to one side: its edge is 0.8 - 0.3 = 0.5 from the hole's centre on the near side, a ring of 0.1 against a 0.2 minimum
    const v = analyzePcb(p, computeConnectivity(p)).violations.filter((x) => x.kind === "annular-ring")
    expect(v.length).toBe(1)
  })
})

describe("pours: the connection a pad asks for", () => {
  const pour = (extra: string) => {
    const p0 = imp(board({ nets: NETS, body: [footprint({ ref: "J1", at: "10 5", pads: [pad({ number: "1", at: "0 0", size: "1.5 1.5", net: '(net 1 "A")', extra })] })] }))
    const p: Project = { ...p0, zones: [{ id: "z", net: "A", layer: "top" }] }
    const sch = computeConnectivity(p)
    const a = analyzePcb(p, sch)
    return { fills: fillZones(p, sch, { items: a.items, netOf: (i) => (a.items[i].kind === "pad" ? (a.items[i] as { netId: string | null }).netId : null) }), pad: pcbPads(p.components[0])[0] }
  }
  const inside = (fills: ReturnType<typeof pour>["fills"], x: number, y: number) =>
    fills.some((f) => f.polygons.some((poly) => poly[0].length && poly.slice(1).every(() => true) && pointIn(poly[0], x, y) && !poly.slice(1).some((h) => pointIn(h, x, y))))
  function pointIn(ring: { x: number; y: number }[], x: number, y: number) {
    let c = false
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) if (ring[i].y > y !== ring[j].y > y && x < ((ring[j].x - ring[i].x) * (y - ring[i].y)) / (ring[j].y - ring[i].y) + ring[i].x) c = !c
    return c
  }
  it("a pad that is not to join the pour is cleared by the clearance, and one that joins solidly is covered", () => {
    const none = pour("(zone_connect 0)")
    const solid = pour("(zone_connect 2)")
    // on the pad: filled only when it joins solidly
    expect(inside(solid.fills, 10, -5)).toBe(true)
    expect(inside(none.fills, 10, -5)).toBe(false)
    // beside the pad within the clearance (0.5 default zone clearance 0.5): cleared when the pad is not joined
    expect(inside(none.fills, 10.75 + 0.15, -5)).toBe(false)
  })
  it("a pad's own spoke width and gap reach the relief: wider spokes leave more copper", () => {
    const area = (extra: string) => pour(`(zone_connect 1) ${extra}`).fills[0].polygons.reduce((a, poly) => a + poly.reduce((s, ring, i) => s + (i === 0 ? 1 : -1) * Math.abs(ring.reduce((t, p, k) => t + (ring[(k + 1) % ring.length].x - p.x) * (ring[(k + 1) % ring.length].y + p.y), 0)) / 2, 0), 0)
    expect(area("(thermal_bridge_width 0.8)")).toBeGreaterThan(area("(thermal_bridge_width 0.2)"))
  })
})

describe("the stored form and the other exports", () => {
  const src = board({
    nets: NETS,
    body: [
      footprint({
        ref: "U1",
        at: "10 5 30",
        layer: "B.Cu",
        pads: [
          pad({ number: "1", at: "-3 0 30", shape: "custom", size: "0.5 0.5", layers: '"B.Cu" "B.Mask" "B.Paste"', net: '(net 1 "A")', extra: "(options (clearance outline) (anchor circle)) (primitives (gr_poly (pts (xy 0 0) (xy 1 0) (xy 1 1)) (width 0.1) (fill yes)) (gr_line (start 0 0) (end -1 0.5) (width 0.2)))" }),
          pad({ number: "2", at: "0 0 30", shape: "roundrect", size: "2 1", layers: '"B.Cu" "B.Mask" "B.Paste"', extra: "(roundrect_rratio 0.2) (chamfer_ratio 0.2) (chamfer top_left) (solder_mask_margin 0.03) (zone_connect 1)" }),
          pad({ number: "3", at: "3 0 30", type: "thru_hole", shape: "rect", size: "2 1", layers: '"*.Cu" "*.Mask"', extra: "(drill oval 1.2 0.6 (offset 0.3 0.1))" }),
          pad({ number: "", at: "6 0", net: '(net 2 "B")', layers: '"B.Cu" "B.Mask" "B.Paste"' }),
        ],
      }),
    ],
  })
  const project = imp(src)

  it("a project with pads of every kind is saved and loaded as it is, the custom drawings stored compactly", () => {
    const text = serializeProject(project)
    const file = JSON.parse(text)
    expect(file.version).toBe(PROJECT_FILE_VERSION)
    const land = file.project.footprints[0]
    const custom = land.pads.find((p: { custom?: unknown }) => p.custom).custom
    expect(custom.shapes).toBeUndefined()
    expect(Array.isArray(custom.g.g)).toBe(true)
    const back = parseProjectFile(text, { id: project.id })
    expect(back.footprints).toEqual(project.footprints)
    expect(serializeProject(back)).toBe(text)
  })

  it("a document of version 3 reads as written, and a damaged pad drops its land rather than being drawn without a field", () => {
    const file = JSON.parse(serializeProject(project))
    const v3 = { ...file, version: 3 }
    expect(parseProjectFile(v3, { id: "x" }).footprints).toEqual(project.footprints)
    const bad = JSON.parse(JSON.stringify(file))
    bad.project.footprints[0].pads[1].round = 3
    expect(parseProjectFile(bad, { id: "x" }).footprints ?? []).toEqual([])
    const bad2 = JSON.parse(JSON.stringify(file))
    bad2.project.footprints[0].pads[1].layers = { copper: "sideways" }
    expect(parseProjectFile(bad2, { id: "x" }).footprints ?? []).toEqual([])
  })

  it("a pad of the previous version's document (no X7 field) is stored with none", () => {
    const plain = imp(board({ body: [footprint({ ref: "U1", pads: [pad({ number: "1", at: "0 0" })] })] }))
    expect(JSON.stringify(JSON.parse(serializeProject(plain)).project.footprints[0].pads)).not.toMatch(/custom|round|rot|layers/)
  })

  it("the KiCad export writes a slot across its pad's frame tall, as KiCad reads x then y, and it reads back the same way", async () => {
    const tall = imp(
      board({
        body: [
          footprint({
            ref: "J1",
            pads: [
              pad({ number: "1", at: "0 0", type: "thru_hole", shape: "rect", size: "2.4 1.4", layers: '"*.Cu" "*.Mask"', extra: "(drill oval 0.8 1.6)" }),
              pad({ number: "2", at: "4 0 30", type: "thru_hole", shape: "circle", size: "2 2", layers: '"*.Cu" "*.Mask"', extra: "(drill oval 0.8 1.6)" }),
            ],
          }),
        ],
      }),
    )
    const out = await kicadFiles(tall)
    const pcb = Object.entries(out.files).find(([k]) => k.endsWith(".kicad_pcb"))![1]
    expect(pcb).toContain("(drill oval 0.8 1.6)")
    expect(pcb).not.toContain("(drill oval 1.6 0.8)")
    const before = pcbPads(tall.components[0])
    const after = pcbPads(imp(pcb).components[0])
    for (let j = 0; j < before.length; j++) {
      near(after[j].slotAxis ?? 0, before[j].slotAxis ?? 0, 1e-6)
      near(after[j].slotLength ?? 0, before[j].slotLength ?? 0, 1e-6)
    }
  })

  it("the KiCad export writes each pad as KiCad has it, and the file reads back to the same copper, layers, hole and number", async () => {
    const out = await kicadFiles(project)
    const pcb = Object.entries(out.files).find(([k]) => k.endsWith(".kicad_pcb"))![1]
    expect(pcb).toContain("(pad \"2\" smd roundrect")
    expect(pcb).toContain("(chamfer top_left)")
    expect(pcb).toContain("(drill oval 1.2 0.6 (offset")
    expect(pcb).toContain('(pad "" smd rect')
    const again = imp(pcb)
    const before = pcbPads(project.components[0])
    const after = pcbPads(again.components[0])
    expect(after).toHaveLength(before.length)
    const a = project.components[0].pcb
    const b = again.components[0].pcb
    // every point near each pad is as far from its copper in both, once the part's frame is taken back
    for (let j = 0; j < before.length; j++) {
      expect(after[j].layers).toEqual(before[j].layers)
      expect(after[j].padNumber).toBe(before[j].padNumber)
      expect(after[j].holeDiameter).toBe(before[j].holeDiameter)
      near(after[j].slotLength ?? 0, before[j].slotLength ?? 0, 1e-6)
      for (const [dx, dy] of [[0, 0], [0.3, 0.2], [-0.8, 0.1], [1.2, -0.4], [0.2, 0.9], [2, 2]]) {
        // a point at an offset from the pad's centre, in each project (the export moves the board by its own origin)
        const p = { x: before[j].x + dx, y: before[j].y + dy }
        const q = { x: after[j].x + dx, y: after[j].y + dy }
        near(pointPadDistance(p, before[j]), pointPadDistance(q, after[j]), 0.0025)
      }
    }
    void a
    void b
    const fb = componentFootprint(project.components[0])!.pads
    const fa = componentFootprint(again.components[0])!.pads
    expect(fa.map((p) => p.pin === null ? null : p.pin)).toEqual(fb.map((p) => (p.pin === null ? null : p.pin)))
    expect(fa.map((p) => p.maskMargin)).toEqual(fb.map((p) => p.maskMargin))
    expect(fa.map((p) => p.zoneConnect)).toEqual(fb.map((p) => p.zoneConnect))
  })

  it("Circuit JSON carries a rounded pad's radius, a pad's margins, and says what a custom pad loses", () => {
    const p = imp(board({ body: [footprint({ ref: "U1", pads: [pad({ number: "1", at: "0 0", shape: "roundrect", size: "2 1", extra: "(roundrect_rratio 0.25) (solder_mask_margin 0.07)" }), pad({ number: "2", at: "3 0", shape: "custom", size: "0.5 0.5", extra: "(options (anchor circle)) (primitives (gr_poly (pts (xy 0 0) (xy 1 0) (xy 1 1)) (width 0.1) (fill yes)))" })] })] }))
    const cj = projectToCircuitJson(p)
    const smt = cj.elements.filter((e) => e.type === "pcb_smtpad") as unknown as { shape: string; rect_border_radius?: number; soldermask_margin?: number }[]
    expect(smt.find((e) => e.shape === "rect")).toMatchObject({ rect_border_radius: 0.25, soldermask_margin: 0.07 })
    expect(smt.some((e) => e.shape === "polygon")).toBe(true)
    expect(cj.notes.join(" ")).toMatch(/custom pad/)
  })

  it("the STEP board drills a hole where the hole is", () => {
    const holes = stepBoard(project).holes
    const pads = pcbPads(project.components[0])
    const at = pads[2].hole!
    expect(holes.some((h) => Math.abs(h.x - at.x) < 1e-6 && Math.abs(h.y - at.y) < 1e-6)).toBe(true)
  })

  it("Sakura reads the number of a pad that is not its pin's, and nothing more for a part that has none", () => {
    const design = JSON.parse(runTool(project, "get_design", {}).result)
    const pins = design.components[0].pins as { pin: string; pad_number?: string }[]
    expect(pins.find((p) => p.pin === "_1")?.pad_number).toBe("")
    expect(pins.find((p) => p.pin === "1")?.pad_number).toBeUndefined()
    const plain = imp(board({ body: [footprint({ ref: "U1", pads: [pad({ number: "1", at: "0 0" })] })] }))
    expect(JSON.stringify(JSON.parse(runTool(plain, "get_design", {}).result).components[0].pins)).not.toContain("pad_number")
  })
})

describe("editing a pad of an imported part's land", () => {
  const project = imp(board({ body: [footprint({ ref: "U1", pads: [pad({ number: "1", at: "0 0", shape: "roundrect", size: "2 1", extra: "(roundrect_rratio 0.2)" }), pad({ number: "2", at: "3 0" })] })] }))
  const land = componentFootprint(project.components[0])!
  it("sets and clears a pad's own margins, clearance and pour connection, and refuses what is not a number", () => {
    const set = updateLandPad(project, land.name, 0, { maskMargin: 0.04, clearance: 0.3, zoneConnect: "solid", pasteRatio: -0.1 })
    expect(set.footprints![0].pads[0]).toMatchObject({ maskMargin: 0.04, clearance: 0.3, zoneConnect: "solid", pasteRatio: -0.1 })
    // the other pad and the pad's shape are untouched, and every part with the land has it
    expect(set.footprints![0].pads[1]).toEqual(land.pads[1])
    expect(set.footprints![0].pads[0].round).toBe(0.2)
    expect(pcbPads(set.components[0])[0].maskMargin).toBe(0.04)
    const cleared = updateLandPad(set, land.name, 0, { maskMargin: null, zoneConnect: null })
    expect(cleared.footprints![0].pads[0].maskMargin).toBeUndefined()
    expect(cleared.footprints![0].pads[0].zoneConnect).toBeUndefined()
    expect(cleared.footprints![0].pads[0].clearance).toBe(0.3)
    expect(updateLandPad(project, land.name, 0, { maskMargin: Number.NaN })).toBe(project)
    expect(updateLandPad(project, land.name, 9, { maskMargin: 1 })).toBe(project)
    expect(updateLandPad(project, "nope", 0, { maskMargin: 1 })).toBe(project)
    expect(patchPad(land.pads[0], { zoneConnect: "sideways" as never })).toEqual(land.pads[0])
  })
  it("a pad's summary names its number, shape, size, turn and hole", () => {
    expect(padSummary(land.pads[0])).toBe("1  rounded 20% 2 x 1")
    const def: PadDef = { pin: "3", shape: "pill", x: 0, y: 0, width: 2, height: 1, layer: "through", holeDiameter: 0.6, slotLength: 1.2, rot: 30, holeOffset: { x: 0.1, y: 0 } }
    expect(padSummary(def)).toBe("3  oval 2 x 1, turned 30°, slot 0.6 x 1.2, off centre")
  })
})
