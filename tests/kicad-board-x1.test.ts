import { describe, expect, it } from "vitest"
import { kicadFiles } from "../src/export/kicad"
import { arcOf } from "../src/model/arcTracks"
import { importKicadBoard } from "../src/model/kicad/board"
import { copperLayers, flipLayer, kicadLayerName, viaLayers } from "../src/model/stack"
import { pcbPads } from "../src/model/instances"
import type { Project } from "../src/model/types"
import { board, footprint, pad } from "./kicad-board-fixtures"
import { diffProjects } from "./kicad-roundtrip-check"
import { unknownNodes } from "./kicad9-nodes"

// X1, X4 and X5: the importer reads the copper layers, the stackup, arc tracks, the kinds of via and the pads of a board of more than two layers, exactly,
// and the board writer says each of them back so that the file imports as the same project (`kicad-roundtrip-check.ts`).

const L4 = '(layers (0 "F.Cu" signal) (4 "In1.Cu" power "Ground plane") (6 "In2.Cu" signal) (2 "B.Cu" signal) (44 "Edge.Cuts" user))'
const L6 = '(layers (0 "F.Cu" signal) (4 "In1.Cu" signal) (6 "In2.Cu" mixed) (8 "In3.Cu" signal) (10 "In4.Cu" jumper) (2 "B.Cu" signal) (44 "Edge.Cuts" user))'
const NETS = ['(net 0 "")', '(net 1 "A")', '(net 2 "B")']
const seg = (a: string, b: string, layer: string, net = '(net 1)') => `(segment (start ${a}) (end ${b}) (width 0.2) (layer "${layer}") ${net})`
const via = (kind: string, at: string, layers: string, extra = "") => `(via ${kind ? `${kind} ` : ""}(at ${at}) (size 0.8) (drill 0.4) (layers ${layers}) ${extra} (net 1))`

const imported = (text: string): Project => {
  const r = importKicadBoard(text)
  if (r.status !== "imported") throw new Error(`refused: ${r.message}\n${r.report.entries.filter((e) => e.severity === "refused").map((e) => e.why).join("\n")}`)
  return r.project
}
const pcbOf = async (p: Project) => Object.entries((await kicadFiles(p)).files).find(([k]) => k.endsWith(".kicad_pcb"))![1]
/** The differences between a project and the one its written board imports as. */
const roundTrip = async (p: Project) => {
  const text = await pcbOf(p)
  expect(unknownNodes(text)).toEqual([])
  const again = importKicadBoard(text)
  if (again.status !== "imported") throw new Error(`the written board is refused: ${again.message}`)
  return { text, differences: diffProjects(p, again.project), again: again.project }
}

describe("X1: the copper layers", () => {
  it("a board with two plain signal layers has no stack, as every board drawn in the editor", () => {
    const p = imported(board({ nets: NETS, body: [seg("0 0", "5 0", "F.Cu")] }))
    expect(p.board.stack).toBeUndefined()
    expect(copperLayers(p.board)).toEqual(["top", "bottom"])
  })

  it("reads the layer table of four layers: their names, their types and their places", () => {
    const p = imported(board({ layers: L4, nets: NETS, body: [seg("0 0", "5 0", "F.Cu"), seg("0 1", "5 1", "In1.Cu"), seg("0 2", "5 2", "In2.Cu"), seg("0 3", "5 3", "B.Cu")] }))
    expect(p.board.stack?.copper).toEqual([{}, { label: "Ground plane", type: "power" }, {}, {}])
    expect(copperLayers(p.board)).toEqual(["top", "in1", "in2", "bottom"])
    expect(p.traces.map((t) => t.layer)).toEqual(["top", "in1", "in2", "bottom"])
  })

  it("takes the layer by its place in the table and not by its name: a KiCad 4 board names its layers as it likes", () => {
    const text = board({
      version: 4,
      layers: "(layers (15 Front signal) (1 Ground power) (2 Signal2 mixed) (0 Back signal) (16 Adhes user))",
      nets: NETS,
      body: ["(segment (start 0 0) (end 5 0) (width 0.2) (layer Ground) (net 1))", "(segment (start 0 1) (end 5 1) (width 0.2) (layer Signal2) (net 1))"],
    })
    const p = imported(text)
    expect(p.traces.map((t) => t.layer)).toEqual(["in1", "in2"])
    expect(p.board.stack?.copper.map((c) => c.type ?? "signal")).toEqual(["signal", "power", "mixed", "signal"])
  })

  it("keeps up to 32 layers, and a layer named in a drawing and a text is on that layer", () => {
    const rows = ['(0 "F.Cu" signal)', ...Array.from({ length: 30 }, (_, i) => `(${4 + 2 * i} "In${i + 1}.Cu" signal)`), '(2 "B.Cu" signal)', '(44 "Edge.Cuts" user)'].join(" ")
    const text = board({
      layers: `(layers ${rows})`,
      nets: NETS,
      body: [seg("0 0", "5 0", "In30.Cu"), '(gr_line (start 0 0) (end 4 0) (stroke (width 0.2) (type solid)) (layer "In17.Cu"))', '(gr_text "x" (at 3 3) (layer "In30.Cu") (effects (font (size 1 1) (thickness 0.15))))'],
    })
    const p = imported(text)
    expect(copperLayers(p.board).length).toBe(32)
    expect(p.traces[0].layer).toBe("in30")
    expect(p.graphics?.[0].layer).toBe("In17.Cu")
    expect(p.texts[0].layer).toBe("In30.Cu")
  })

  it("refuses a track on a layer the table does not list, naming it", () => {
    const r = importKicadBoard(board({ nets: NETS, body: [seg("0 0", "5 0", "In3.Cu")] }))
    expect(r.status).toBe("refused")
    expect(r.status === "refused" && r.message).toMatch(/In3\.Cu/)
  })

  it("flips an inner layer the way KiCad's FlipLayer does: In1 of four is In2, the middle of five stays", () => {
    expect(flipLayer("in1", 4)).toBe("in2")
    expect(flipLayer("in2", 4)).toBe("in1")
    expect(flipLayer("in1", 6)).toBe("in4")
    expect(flipLayer("in3", 6)).toBe("in2")
    expect(flipLayer("in1", 3)).toBe("in1")
    expect(flipLayer("top", 8)).toBe("bottom")
    expect(kicadLayerName("in7")).toBe("In7.Cu")
  })

  it("writes and reads the layers back: names, types, tracks and drawings", async () => {
    const p = imported(board({ layers: L6, nets: NETS, body: [seg("0 0", "5 0", "In3.Cu"), seg("0 1", "5 1", "In4.Cu"), '(gr_line (start 0 0) (end 4 0) (stroke (width 0.2) (type solid)) (layer "In2.Cu"))'] }))
    const { text, differences, again } = await roundTrip(p)
    expect(differences).toEqual([])
    expect(text).toContain('(4 "In1.Cu" signal)')
    expect(text).toContain('(10 "In4.Cu" jumper)')
    expect(again.board.stack?.copper.map((c) => c.type ?? "signal")).toEqual(["signal", "signal", "mixed", "signal", "jumper", "signal"])
  })

  it("a board of four layers drawn in the editor is written natively too, with its layers", async () => {
    const p = imported(board({ layers: L4, nets: NETS, body: [seg("0 0", "5 0", "In1.Cu")] }))
    const { fpid: _f, ...rest } = { fpid: undefined }
    void rest
    const stripped: Project = { ...p, properties: [], components: p.components.map((c) => ({ ...c, fpid: undefined })) }
    const text = await pcbOf(stripped)
    expect(text).toContain('(layer "In1.Cu")')
    expect(text).toContain('(4 "In1.Cu" power "Ground plane")')
  })
})

describe("X1: the stackup", () => {
  const stackup = `(setup (pad_to_mask_clearance 0)
    (stackup
      (layer "F.SilkS" (type "Top Silk Screen"))
      (layer "F.Paste" (type "Top Solder Paste"))
      (layer "F.Mask" (type "Top Solder Mask") (color "Green") (thickness 0.01) (material "Epoxy") (epsilon_r 3.3) (loss_tangent 0))
      (layer "F.Cu" (type "copper") (thickness 0.035))
      (layer "dielectric 1" (type "prepreg") (thickness 0.1 locked) (material "FR4") (epsilon_r 4.5) (loss_tangent 0.02) addsublayer (thickness 0.05) (material "FR4 b") (epsilon_r 4.2) (loss_tangent 0.019))
      (layer "In1.Cu" (type "copper") (thickness 0.0175))
      (layer "dielectric 2" (type "core") (thickness 1.2) (material "FR4") (epsilon_r 4.5) (loss_tangent 0.02))
      (layer "In2.Cu" (type "copper") (thickness 0.0175))
      (layer "dielectric 3" (type "prepreg") (thickness 0.1) (material "FR4") (epsilon_r 4.5) (loss_tangent 0.02))
      (layer "B.Cu" (type "copper") (thickness 0.035))
      (layer "B.Mask" (type "Bottom Solder Mask") (thickness 0.01))
      (layer "B.Paste" (type "Bottom Solder Paste"))
      (layer "B.SilkS" (type "Bottom Silk Screen"))
      (copper_finish "ENIG")
      (dielectric_constraints yes)
      (edge_connector bevelled)
      (edge_plating yes)
    ))`

  it("reads every row with its fields, a dielectric's sublayers and a locked thickness, and the settings after them", () => {
    const p = imported(board({ layers: L4, setup: stackup, nets: NETS }))
    const s = p.board.stack!
    expect(s.rows).toHaveLength(13)
    expect(s.rows![2]).toEqual({ name: "F.Mask", type: "Top Solder Mask", color: "Green", thickness: 0.01, material: "Epoxy", epsilonR: 3.3, lossTangent: 0 })
    expect(s.rows![4]).toEqual({ name: "dielectric 1", type: "prepreg", thickness: 0.1, locked: true, material: "FR4", epsilonR: 4.5, lossTangent: 0.02, sub: [{ thickness: 0.05, material: "FR4 b", epsilonR: 4.2, lossTangent: 0.019 }] })
    expect(s.finish).toBe("ENIG")
    expect(s.dielectricConstraints).toBe(true)
    expect(s.edgeConnector).toBe("bevelled")
    expect(s.edgePlating).toBe(true)
    // ENIG is one of the editor's finishes, and 35 micrometres of outer copper its 1 oz
    expect(p.board.finish).toBe("enig")
    expect(p.board.copperWeight).toBe(1)
  })

  it("a stackup that appends itself twice ends at the repeat, as KiCad reads it", () => {
    const twice = stackup.replace('(copper_finish "ENIG")', '(layer "F.Cu" (type "copper") (thickness 0.07)) (copper_finish "ENIG")')
    const p = imported(board({ layers: L4, setup: twice, nets: NETS }))
    expect(p.board.stack!.rows).toHaveLength(13)
  })

  it("is written and read back the same, but for what a KiCad 9 file has no node for", async () => {
    const p = imported(board({ layers: L4, setup: stackup, nets: NETS }))
    const { differences, text } = await roundTrip(p)
    expect(differences).toEqual([])
    expect(text).toContain('(copper_finish "ENIG")')
    expect(text).toContain("addsublayer")
    expect(text).toContain("(thickness 0.1 locked)")
  })

  it("the stackup rows carry through the project file exactly, and stay small", async () => {
    const { parseProjectFile, serializeProject } = await import("../src/model/projectFile")
    const p = imported(board({ layers: L4, setup: stackup, nets: NETS }))
    const text = serializeProject(p)
    const again = parseProjectFile(text, { id: p.id })
    expect(again.board.stack).toEqual(p.board.stack)
    expect(text.length - serializeProject({ ...p, board: { ...p.board, stack: undefined } }).length).toBeLessThan(2500)
  })
})

describe("X4: arc tracks", () => {
  const arcAt = (cx: number, cy: number, r: number, a0: number, sweep: number) => {
    const at = (a: number) => `${(cx + r * Math.cos(a)).toFixed(6)} ${(cy + r * Math.sin(a)).toFixed(6)}`
    return `(arc (start ${at(a0)}) (mid ${at(a0 + sweep / 2)}) (end ${at(a0 + sweep)}) (width 0.25) (layer "F.Cu") (net 1))`
  }
  const angles = [0, 20, 45, 77, 90, 135, 180, 222, 270, 301, 350]

  it("imports an arc track at many angles, either way round, as the three points and the way it runs", () => {
    for (const deg of angles) {
      for (const sweepDeg of [75, -75, 200, -200]) {
        const p = imported(board({ nets: NETS, body: [arcAt(10, 8, 4, (deg * Math.PI) / 180, (sweepDeg * Math.PI) / 180)] }))
        const t = p.traces[0]
        expect(t.arc).toBe(true)
        expect(t.points).toHaveLength(3)
        const a = arcOf(t.points).circle!
        expect(a.r).toBeCloseTo(4, 5)
        // the file's y is down and the editor's up: the circle's centre is where the file's is, mirrored, and the sweep runs the other way
        expect(a.c.x).toBeCloseTo(10, 5)
        expect(a.c.y).toBeCloseTo(-8, 5)
        expect(Math.abs(a.sweep)).toBeCloseTo((Math.abs(sweepDeg) * Math.PI) / 180, 5)
        expect(Math.sign(a.sweep)).toBe(-Math.sign(sweepDeg))
      }
    }
  })

  it("writes each back as an arc, and the file reads as the same project", async () => {
    const body = angles.map((d, i) => arcAt(10 + i, 8, 3, (d * Math.PI) / 180, i % 2 ? 1.1 : -1.3))
    const p = imported(board({ nets: NETS, body }))
    const { differences, text } = await roundTrip(p)
    expect(differences).toEqual([])
    expect(text.match(/\(arc\b/g)?.length).toBe(angles.length)
  })

  it("a group of the file can hold an arc track", () => {
    const text = board({ nets: NETS, body: [arcAt(10, 8, 4, 0, 1).replace("(net 1)", '(net 1) (uuid "aaaaaaaa-0000-4000-8000-000000000001")'), '(group "g" (uuid "aaaaaaaa-0000-4000-8000-000000000002") (members "aaaaaaaa-0000-4000-8000-000000000001"))'] })
    const r = importKicadBoard(text)
    expect(r.status).toBe("imported")
  })
})

describe("X5: the kinds of via", () => {
  const body = [
    via("", "5 5", '"F.Cu" "B.Cu"'),
    via("blind", "6 5", '"F.Cu" "In1.Cu"'),
    via("blind", "7 5", '"In2.Cu" "B.Cu"'),
    via("blind", "8 5", '"In2.Cu" "In1.Cu"'),
    via("micro", "9 5", '"In1.Cu" "F.Cu"'),
    via("blind", "10 5", '"F.Cu" "B.Cu"'),
  ]

  it("tells through, blind, buried and micro, puts the ends in the stack's order, and calls a blind via between two inner layers buried", () => {
    const p = imported(board({ layers: L4, nets: NETS, body }))
    expect(p.vias.map((v) => [v.kind ?? "through", v.from, v.to])).toEqual([
      ["through", undefined, undefined],
      ["blind", "top", "in1"],
      ["blind", "in2", "bottom"],
      ["buried", "in1", "in2"],
      ["micro", "top", "in1"],
      ["blind", "top", "bottom"],
    ])
    expect(viaLayers(p.board, p.vias[3])).toEqual(["in1", "in2"])
    expect(viaLayers(p.board, p.vias[0])).toEqual(["top", "in1", "in2", "bottom"])
  })

  it("KiCad 10's `buried` word is a buried via", () => {
    const p = imported(board({ version: 20250926, layers: L4, nets: NETS, body: [via("buried", "5 5", '"In1.Cu" "In2.Cu"')] }))
    expect(p.vias[0]).toMatchObject({ kind: "buried", from: "in1", to: "in2" })
  })

  it("writes them back, a buried via as a blind one, and the file reads as the same project", async () => {
    const p = imported(board({ layers: L4, nets: NETS, body }))
    const { differences, text } = await roundTrip(p)
    expect(differences).toEqual([])
    expect(text).not.toContain("buried")
    expect(text).toContain("(via micro")
  })

  it("keeps the via's own settings: free, locked, the layers nothing joins, the pour layers, the tenting and the via stack", async () => {
    const extra = '(locked yes) (free yes) (remove_unused_layers yes) (keep_end_layers yes) (zone_layer_connections "F.Cu" "In1.Cu") (tenting front back) (padstack (mode front_inner_back) (layer "Inner" (size 0.6)) (layer "B.Cu" (size 0.7)))'
    const p = imported(board({ layers: L4, nets: NETS, body: [via("", "5 5", '"F.Cu" "B.Cu"', extra)] }))
    expect(p.vias[0]).toMatchObject({ locked: true, free: true, unused: "keepEnds", zoneLayers: ["top", "in1"], tent: { front: true, back: true }, stack: { inner: 0.6, back: 0.7 } })
    const { differences } = await roundTrip(p)
    expect(differences).toEqual([])
  })

  it("a custom via stack lists the layers that differ, and the mode stays", async () => {
    const extra = '(padstack (mode custom) (layer "In1.Cu" (size 0.8)) (layer "In2.Cu" (size 0.5)) (layer "B.Cu" (size 0.8)))'
    const p = imported(board({ layers: L4, nets: NETS, body: [via("", "5 5", '"F.Cu" "B.Cu"', extra)] }))
    expect(p.vias[0].stack).toEqual({ layers: { in2: 0.5 } })
    const { differences, text } = await roundTrip(p)
    expect(differences).toEqual([])
    expect(text).toContain("(mode custom)")
  })

  it("reads tenting as the file's release said it: words say both sides in KiCad 9 and before, a side not named is no choice later", () => {
    const words = imported(board({ version: 20241229, layers: L4, nets: NETS, body: [via("", "5 5", '"F.Cu" "B.Cu"', "(tenting front)"), via("", "6 5", '"F.Cu" "B.Cu"', "(tenting none)")] }))
    expect(words.vias.map((v) => v.tent)).toEqual([{ front: true, back: false }, { front: false, back: false }])
    const listed = imported(board({ version: 20250926, layers: L4, nets: NETS, body: [via("", "5 5", '"F.Cu" "B.Cu"', "(tenting (front yes))"), via("", "6 5", '"F.Cu" "B.Cu"', "(tenting (front yes) (back no))")] }))
    expect(listed.vias.map((v) => v.tent)).toEqual([{ front: true }, { front: true, back: false }])
  })

  it("reads the sides the board tents vias on: the words name them, and a side left out is not tented", () => {
    const only = imported(board({ version: 20241229, layers: L4, setup: "(setup (pad_to_mask_clearance 0) (tenting front))", nets: NETS }))
    expect(only.rules.tentSides).toEqual({ front: true, back: false })
    expect(only.rules.tentVias).toBe(false)
    const both = imported(board({ version: 20241229, layers: L4, setup: "(setup (pad_to_mask_clearance 0) (tenting front back))", nets: NETS }))
    expect(both.rules.tentSides).toBeUndefined()
    expect(both.rules.tentVias).toBe(true)
    const none = imported(board({ version: 20241229, layers: L4, setup: "(setup (pad_to_mask_clearance 0) (tenting none))", nets: NETS }))
    expect(none.rules.tentVias).toBe(false)
    expect(none.rules.tentSides).toBeUndefined()
  })

  it("the rules of a KiCad 5 board about micro vias are kept when it has one", () => {
    const text = board({ version: 20171130, layers: "(layers (0 F.Cu signal) (1 In1.Cu signal) (2 In2.Cu signal) (31 B.Cu signal) (44 Edge.Cuts user))", setup: "(setup (uvia_size 0.25) (uvia_drill 0.1) (uvias_allowed yes) (uvia_min_size 0.2) (uvia_min_drill 0.1) (blind_buried_vias_allowed no))", nets: NETS, body: ["(via micro (at 5 5) (size 0.25) (drill 0.1) (layers F.Cu In1.Cu) (net 1))"] })
    const p = imported(text)
    expect(p.rules.microVia).toEqual({ diameter: 0.25, drill: 0.1 })
    expect(p.rules.minMicroVia).toEqual({ diameter: 0.2, drill: 0.1 })
    expect(p.rules.microViasAllowed).toBe(true)
    expect(p.rules.blindBuriedViasAllowed).toBe(false)
  })
})

describe("X1 and X5: the pads of a board of more than two layers", () => {
  const fp = (pads: string[], layer = "F.Cu", ref = "J1") => footprint({ ref, layer, at: "10 5", pads })
  const thru = (layers: string, extra = "") => pad({ number: "1", type: "thru_hole", shape: "circle", at: "0 0", size: "1.6 1.6", layers, extra: `(drill 0.8) ${extra}` })

  it("a through-hole pad on `*.Cu` has copper on every inner layer, and one that names F.Cu and B.Cu only has none inside", () => {
    const p = imported(board({ layers: L4, nets: NETS, body: [fp([thru('"*.Cu" "*.Mask"')], "F.Cu", "J1"), footprint({ ref: "J2", at: "20 5", pads: [thru('"F.Cu" "B.Cu" "*.Mask"')] })] }))
    const [a, b] = p.components
    expect(pcbPads(a, 4)[0].layers).toEqual(["top", "in1", "in2", "bottom"])
    expect(pcbPads(b, 4)[0].layers).toEqual(["top", "bottom"])
    expect(p.footprints?.[0].pads[0].layers?.inner).toBeUndefined()
    expect(pcbPads(a)[0].layers).toEqual(["top", "bottom"])
  })

  it("a pad that has copper on one inner layer says so, and a part on the bottom has the layers turned over", () => {
    const text = board({ layers: L4, nets: NETS, body: [fp([thru('"F.Cu" "B.Cu" "In1.Cu"')], "F.Cu", "J1"), footprint({ ref: "J2", at: "20 5", layer: "B.Cu", pads: [thru('"F.Cu" "B.Cu" "In1.Cu"')] })] })
    const p = imported(text)
    expect(pcbPads(p.components[0], 4)[0].layers).toEqual(["top", "in1", "bottom"])
    expect(pcbPads(p.components[1], 4)[0].layers).toEqual(["top", "in1", "bottom"])
    // the land of the part on the bottom names its layer as seen from the part: the board's In1 is its In2
    expect(p.footprints!.find((f) => f.name !== p.footprints![0].name)?.pads[0].layers?.inner).toEqual(["in2"])
  })

  it("writes the pad's layers back", async () => {
    const text = board({ layers: L4, nets: NETS, body: [fp([thru('"F.Cu" "B.Cu" "In1.Cu"')]), footprint({ ref: "J2", at: "20 5", layer: "B.Cu", pads: [thru('"F.Cu" "B.Cu" "In1.Cu"')] }), footprint({ ref: "J3", at: "30 5", pads: [thru('"*.Cu" "*.Mask"')] })] })
    const { differences } = await roundTrip(imported(text))
    expect(differences).toEqual([])
  })

  it("a pad that removes the copper nothing joins and one that tents its own mask are kept and written", async () => {
    const text = board({
      layers: L4,
      nets: NETS,
      body: [fp([thru('"*.Cu" "*.Mask"', "(remove_unused_layers yes) (keep_end_layers no) (tenting front)")])],
    })
    const p = imported(text)
    expect(p.footprints![0].pads[0]).toMatchObject({ unused: "remove", tent: { top: true, bottom: false } })
    const { differences, text: out } = await roundTrip(p)
    expect(differences).toEqual([])
    expect(out).toContain("(remove_unused_layers yes)")
  })

  it("a pad stack gives each layer its own shape: the part's own side is the pad, the others are what differs", async () => {
    const stack = '(padstack (mode front_inner_back) (layer "Inner" (shape circle) (size 1 1)) (layer "B.Cu" (shape rect) (size 2.4 2.4)))'
    const text = board({ layers: L4, nets: NETS, body: [fp([thru('"*.Cu" "*.Mask"', stack)])] })
    const p = imported(text)
    const def = p.footprints![0].pads[0]
    expect(def.stack?.mode).toBe("front_inner_back")
    expect(def.stack?.layers.inner).toMatchObject({ shape: "circle", width: 1, height: 1 })
    expect(def.stack?.layers.bottom).toMatchObject({ shape: "rect", width: 2.4, height: 2.4 })
    const world = pcbPads(p.components[0], 4)[0]
    expect(Object.keys(world.variants ?? {}).sort()).toEqual(["bottom", "in1", "in2"])
    expect(world.variants!.in1!.width).toBe(1)
    const { differences, text: out } = await roundTrip(p)
    expect(differences).toEqual([])
    expect(out).toContain("(mode front_inner_back)")
  })

  it("a pad stack on a part on the bottom has its own side at the file's back layer", async () => {
    const stack = '(padstack (mode front_inner_back) (layer "Inner" (shape circle) (size 1 1)) (layer "B.Cu" (shape rect) (size 2.4 2.4)))'
    const text = board({ layers: L4, nets: NETS, body: [footprint({ ref: "J1", layer: "B.Cu", at: "10 5", pads: [thru('"*.Cu" "*.Mask"', stack)] })] })
    const p = imported(text)
    const def = p.footprints![0].pads[0]
    // the pad of the part's own side is the file's B.Cu entry; its far side, the front, is the shape at the top of the pad
    expect(def).toMatchObject({ shape: "rect", width: 2.4 })
    expect(def.stack?.layers.bottom).toMatchObject({ shape: "circle" })
    const world = pcbPads(p.components[0], 4)[0]
    expect(world.shape).toBe("rect")
    expect(world.variants?.top?.shape).toBe("circle")
    const { differences } = await roundTrip(p)
    expect(differences).toEqual([])
  })
})
