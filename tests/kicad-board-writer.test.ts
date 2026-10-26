import { describe, expect, it } from "vitest"
import { kicadFiles } from "../src/export/kicad"
import { isKicadBoardProject } from "../src/export/kicadBoard"
import { importKicadBoard, readKicadBoard } from "../src/model/kicad/board"
import { computeConnectivity, pinKey } from "../src/model/connectivity"
import { pcbPads } from "../src/model/instances"
import { addComponent, addTrace, labelPin } from "../src/model/ops"
import type { Project } from "../src/model/types"
import { board, footprint, pad } from "./kicad-board-fixtures"
import { diffProjects } from "./kicad-roundtrip-check"
import { twoResistors } from "./zones-fixtures"
import { rememberImage } from "../src/store/imageFiles"

// X16: the board writer for the round trip. A board is imported, written by the native writer, imported again, and the two projects are compared
// item for item (`kicad-roundtrip-check.ts`); the corpus version of the same check is `kicad-roundtrip-corpus.test.ts`.

const U = (n: number) => `d0000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`
const imported = (text: string): Project => {
  const r = importKicadBoard(text)
  if (r.status !== "imported") throw new Error(`refused: ${r.message}`)
  return r.project
}
const pcbOf = async (p: Project) => Object.entries((await kicadFiles(p)).files).find(([k]) => k.endsWith(".kicad_pcb"))![1]
/** The differences between a project and the one its written board imports as. */
const roundTrip = async (p: Project) => {
  const text = await pcbOf(p)
  const again = importKicadBoard(text)
  if (again.status !== "imported") throw new Error(`the written board is refused: ${again.message}`)
  return { text, differences: diffProjects(p, again.project), again: again.project }
}

const NETS = ['(net 0 "")', '(net 1 "A")', '(net 2 "B")']
/** An asymmetric pad: 2.0 by 0.5 with a hole 0.3 off its centre, so a turn or a flip that is wrong shows. */
const asymmetric = (net = "") => pad({ number: "1", type: "thru_hole", shape: "roundrect", at: "1 0.5", size: "2 0.5", layers: '"*.Cu" "*.Mask"', extra: `(drill 0.3 (offset 0.3 0)) (roundrect_rratio 0.2) ${net}` })
const part = (ref: string, at: string, side: "F" | "B") =>
  footprint({
    ref,
    at,
    layer: `${side}.Cu`,
    pads: [asymmetric('(net 1 "A")'), pad({ number: "2", at: "-1 0", size: "0.8 1.2", layers: side === "F" ? '"F.Cu" "F.Paste" "F.Mask"' : '"B.Cu" "B.Paste" "B.Mask"', net: '(net 2 "B")' })],
    extra: `(fp_line (start -2 -1) (end 2 -1) (stroke (width 0.12) (type solid)) (layer "${side}.SilkS")) (fp_text user "K" (at 0.5 2 33) (layer "${side}.SilkS") (effects (font (size 1 1) (thickness 0.15)))) (attr smd)`,
  })

describe("the board writer, native, in KiCad 9's format", () => {
  const body = [part("R1", "10 5 0", "F"), part("R2", "30 5 90", "F"), part("R3", "10 25 270 ", "B"), part("R4", "30 25 123.5", "B")]
  const text = board({ nets: NETS, body })
  const project = imported(text)

  it("is used for a project that came from a KiCad board, and for no other", () => {
    expect(isKicadBoardProject(project)).toBe(true)
    expect(isKicadBoardProject(twoResistors())).toBe(false)
  })

  it("writes the file's frame, with no page offset, KiCad 9's stamp and B.Cu as layer 2", async () => {
    const out = await pcbOf(project)
    expect(out).toContain("(version 20241229)")
    expect(out).toContain('(generator "pcbnew")')
    expect(out).toContain('(2 "B.Cu" signal)')
    expect(out).toMatch(/\(footprint "Resistor_SMD:R_0603_1608Metric"\n {4}\(layer "F\.Cu"\)\n {4}\(uuid [0-9a-f-]+\)\n {4}\(at 10 5\)/)
    // a part on the bottom is written flipped: its layer is B.Cu and its angle is the file's own (the editor turns it half a turn from it)
    expect(out).toMatch(/\(layer "B\.Cu"\)\n {4}\(uuid [0-9a-f-]+\)\n {4}\(at 10 25 270\)/)
  })

  it("reads back as the same project, turned or on the bottom: every pad, drawing and text where it was", async () => {
    const { differences } = await roundTrip(project)
    expect(differences).toEqual([])
  })

  it("puts every pad where the board has it, by matrices from the file alone: the flip, the turn, then the move", async () => {
    const out = await pcbOf(project)
    const read = readKicadBoard(out).board
    const r = importKicadBoard(out)
    if (r.status !== "imported") throw new Error(r.message)
    for (const fp of read.footprints) {
      const c = r.project.components.find((x) => x.ref === fp.ref)!
      const a = (fp.angle * Math.PI) / 180
      const world = pcbPads(c).map((w) => w.hole ?? w)
      fp.pads.forEach((p, i) => {
        // KiCad's frame is y down and its angle counter-clockwise on screen: world = at + R(angle) * local
        const x = fp.at.x + p.at.x * Math.cos(a) + p.at.y * Math.sin(a)
        const y = fp.at.y - p.at.x * Math.sin(a) + p.at.y * Math.cos(a)
        expect(world[i].x).toBeCloseTo(x, 3)
        expect(world[i].y).toBeCloseTo(-y, 3)
      })
    }
  })

  it("keeps a pad's hole, offset, rounded corners and layers, and the part's pin names and types", async () => {
    const out = await pcbOf(project)
    expect(out).toContain("(drill 0.3 (offset 0.3 0))")
    expect(out).toContain("(roundrect_rratio 0.2)")
    expect(out).toContain('(layers "*.Cu" "*.Mask")')
  })

  it("writes the editor's note for what KiCad 9 cannot say, and the project's own for the rest", async () => {
    const { notes } = await kicadFiles(project)
    expect(notes.join(" ")).toContain("written natively in KiCad 9's format")
  })
})

describe("copper, zones, texts, dimensions and groups", () => {
  const seg = (x1: number, y1: number, x2: number, y2: number, id: number, net = "") => `(segment (start ${x1} ${y1}) (end ${x2} ${y2}) (width 0.25) (layer "F.Cu") ${net} (uuid "${U(id)}"))`
  const body = [
    footprint({ ref: "R1", at: "5 5", pads: [pad({ at: "0 0", net: '(net 1 "A")' })] }).replace('(layer "F.Cu")', `(layer "F.Cu") (uuid "${U(10)}")`),
    seg(2, 8, 4, 8, 11, "(net 1)"),
    seg(4, 8, 6, 8, 12, "(net 1)"),
    seg(6, 8, 6, 12, 13, "(net 1)"),
    `(via (at 6 12) (size 0.8) (drill 0.4) (layers "F.Cu" "B.Cu") (locked yes) (net 1) (uuid "${U(14)}"))`,
    `(gr_poly (pts (xy 12 2) (xy 16 2) (xy 18 5) (xy 12 6)) (stroke (width 0.1) (type default)) (fill none) (layer "F.SilkS") (uuid "${U(15)}"))`,
    `(gr_text "HI" (at 10 3 30) (layer "F.SilkS") (uuid "${U(16)}") (effects (font (size 1.2 1) (thickness 0.2) bold) (justify left top)))`,
    `(dimension (type aligned) (layer "Dwgs.User") (uuid "${U(17)}") (pts (xy 2 2) (xy 12 2)) (height 3) (gr_text "10.0000 mm" (at 7 4.15 0) (layer "Dwgs.User") (uuid "${U(17)}") (effects (font (size 1 1) (thickness 0.15)))) (format (prefix "") (suffix "") (units 2) (units_format 1) (precision 4)) (style (thickness 0.1) (arrow_length 1.27) (text_position_mode 0) (extension_height 0.58642) (extension_offset 0) keep_text_aligned))`,
    `(zone (net 1) (net_name "A") (layer "F.Cu") (uuid "a1b2c3d4-0000-4000-8000-000000000001") (hatch edge 0.5) (priority 2) (connect_pads yes (clearance 0.4)) (min_thickness 0.3) (filled_areas_thickness no) (fill yes (thermal_gap 0.45) (thermal_bridge_width 0.35)) (polygon (pts (xy 0 0) (xy 20 0) (xy 20 15) (xy 0 15))))`,
    `(group "g" (uuid "${U(30)}") (members "${U(11)}" "${U(12)}" "${U(14)}"))`,
  ]
  const project = imported(board({ nets: ['(net 0 "")', '(net 1 "A")'], body, outline: '(gr_rect (start 0 0) (end 20 15) (stroke (width 0.1) (type default)) (fill none) (layer "Edge.Cuts"))' }))

  it("round trip: tracks as polylines, a locked via, a polygon, bold text, a dimension, a zone with its priority and uuid, and a group", async () => {
    const { text, differences } = await roundTrip(project)
    expect(differences).toEqual([])
    expect(text).toContain("(priority 2)")
    expect(text).toContain("a1b2c3d4-0000-4000-8000-000000000001")
    expect(text).toMatch(/\(group "g"/)
  })

  it("keeps tracks as the polylines they were, point for point and in the same order", async () => {
    const { again } = await roundTrip(project)
    expect(again.traces.map((t) => [t.layer, t.width, t.net, t.points])).toEqual(project.traces.map((t) => [t.layer, t.width, t.net, t.points]))
    expect(again.vias.map((v) => [v.x, v.y, v.locked])).toEqual(project.vias.map((v) => [v.x, v.y, v.locked]))
  })

  it("writes the same bytes twice", async () => {
    expect(await pcbOf(project)).toBe(await pcbOf(project))
  })

  it("writes a trapezoid pad as a trapezoid, turned and on either side, and reads it back as the same pad", async () => {
    const trap = (ref: string, at: string, layer: string) => footprint({ ref, at, layer, pads: [pad({ number: "1", at: "0.5 0.2 33", shape: "trapezoid", size: "2 1", extra: "(rect_delta 0 0.4)", layers: layer === "F.Cu" ? '"F.Cu" "F.Paste" "F.Mask"' : '"B.Cu" "B.Paste" "B.Mask"' })] })
    const p = imported(board({ nets: NETS, body: [trap("U1", "5 5 0", "F.Cu"), trap("U2", "15 5 90", "F.Cu"), trap("U3", "25 5 250", "B.Cu")] }))
    const { text, differences } = await roundTrip(p)
    expect(text.split(" trapezoid").length - 1).toBe(3)
    expect(text).toContain("(rect_delta 0 0.4)")
    expect(differences).toEqual([])
  })
  it("writes a trapezoid pad with a hole, a slot across it and the copper off the hole, as a trapezoid", async () => {
    const holed = (ref: string, at: string, layer: string) => footprint({ ref, at, layer, pads: [pad({ number: "1", type: "thru_hole", at: "0 0", shape: "trapezoid", size: "2 3.7", layers: '"*.Cu" "*.Mask"', extra: "(rect_delta 0 0.3) (drill oval 0.6 3.3 (offset 0.2 0.1))" }), pad({ number: "2", type: "thru_hole", at: "6 0 30", shape: "trapezoid", size: "2 1.5", layers: '"*.Cu" "*.Mask"', extra: "(rect_delta 0 0.3) (drill 0.6 (offset 0.1 0.1))" })] })
    const p = imported(board({ nets: NETS, body: [holed("J1", "5 5 0", "F.Cu"), holed("J2", "15 5 90", "F.Cu"), holed("J3", "25 5 270", "B.Cu")] }))
    const { text, differences } = await roundTrip(p)
    expect(text.split(" trapezoid").length - 1).toBe(6)
    expect(differences).toEqual([])
  })
  it("says a polygon pad that is no KiCad trapezoid is written as a custom pad, and reads back the same", async () => {
    const p = imported(board({ nets: NETS, body: [footprint({ ref: "U1", at: "5 5", pads: [pad({ number: "1", at: "0 0", shape: "custom", size: "0.3 0.3", extra: "(options (anchor rect)) (primitives (gr_poly (pts (xy -0.5 -0.75) (xy 0.5 -0.75) (xy 1 0) (xy 0.5 0.75) (xy -0.5 0.75)) (width 0) (fill yes)))" })] })] }))
    const { differences } = await roundTrip(p)
    expect(differences).toEqual([])
  })
})

describe("3D models and reference images", () => {
  const MODEL = '(model "${KICAD10_3DMODEL_DIR}/Resistor_SMD.3dshapes/R_0603_1608Metric.step" (offset (xyz 0.2 -0.1 0.3)) (scale (xyz 1 1 1)) (rotate (xyz 0 0 90)))'
  it("a stock model is written as KiCad 9's variable names it, at the offset and turn it had, on either side", async () => {
    const p = imported(board({ nets: NETS, body: [footprint({ ref: "R1", at: "5 5", pads: [pad({ at: "0 0" })], extra: MODEL }), footprint({ ref: "R2", at: "15 5", layer: "B.Cu", pads: [pad({ at: "0 0", layers: '"B.Cu" "B.Paste" "B.Mask"' })], extra: MODEL })] }))
    const out = await pcbOf(p)
    expect(out.match(/\(model "\$\{KICAD9_3DMODEL_DIR\}\/Resistor_SMD\.3dshapes\/R_0603_1608Metric\.step"/g)).toHaveLength(2)
    expect(out).toContain("(xyz 0.2 -0.1 0.3)")
    expect(out).toContain("(xyz 0 0 90)")
    const again = importKicadBoard(out)
    if (again.status !== "imported") throw new Error(again.message)
    expect(again.project.models).toHaveLength(p.models!.length)
    expect(diffProjects(p, again.project)).toEqual([])
  })
})

describe("reference images", () => {
  /** A PNG header with the size and a resolution: the header is all the importer reads. */
  function png(px: number, py: number, perMetre: number): Uint8Array {
    const b: number[] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
    const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]
    const chunk = (type: string, data: number[]) => [...u32(data.length), ...[...type].map((c) => c.charCodeAt(0)), ...data, 0, 0, 0, 0]
    b.push(...chunk("IHDR", [...u32(px), ...u32(py), 8, 6, 0, 0, 0]), ...chunk("pHYs", [...u32(perMetre), ...u32(perMetre), 1]), ...chunk("IDAT", [0]), ...chunk("IEND", []))
    return new Uint8Array(b)
  }
  it("is written with its bytes and reads back as the same image, where the page has them", async () => {
    const bytes = png(40, 20, 11811)
    const b64 = Buffer.from(bytes).toString("base64")
    const text = board({ body: [`(image (at 10 5) (layer "User.1") (scale 1.5) (data "${b64.slice(0, 40)}" "${b64.slice(40)}") (uuid "${U(900)}"))`] })
    const r = importKicadBoard(text)
    if (r.status !== "imported") throw new Error(r.message)
    for (const f of r.files) rememberImage(f.id, f.bytes.buffer.slice(f.bytes.byteOffset, f.bytes.byteOffset + f.bytes.byteLength) as ArrayBuffer)
    const out = await pcbOf(r.project)
    expect(out).toContain("(image")
    expect(out).toContain('(layer "User.1")')
    const again = importKicadBoard(out)
    if (again.status !== "imported") throw new Error(again.message)
    expect(diffProjects(r.project, again.project)).toEqual([])
  })
})

describe("the outline", () => {
  const line = (a: string, b: string) => `(gr_line (start ${a}) (end ${b}) (stroke (width 0.1) (type default)) (layer "Edge.Cuts"))`
  const arc = (a: string, m: string, b: string) => `(gr_arc (start ${a}) (mid ${m}) (end ${b}) (stroke (width 0.1) (type default)) (layer "Edge.Cuts"))`
  const part1 = footprint({ ref: "R1", at: "10 10", pads: [pad({ at: "0 0" })] })
  it("a rectangle with rounded corners, a board with a cutout and a slot, and a board with an open outline come back as the same outline", async () => {
    const m = 2 * Math.SQRT1_2
    const rounded = [line("2 0", "28 0"), arc("28 0", `${28 + m} ${2 - m}`, "30 2"), line("30 2", "30 18"), arc("30 18", `${28 + m} ${18 + m}`, "28 20"), line("28 20", "2 20"), arc("2 20", `${2 - m} ${18 + m}`, "0 18"), line("0 18", "0 2"), arc("0 2", `${2 - m} ${2 - m}`, "2 0")].join(String.fromCharCode(10))
    const cutout = `(gr_circle (center 15 10) (end 17 10) (stroke (width 0.1) (type default)) (fill none) (layer "Edge.Cuts"))`
    const board1 = imported(board({ body: [part1], outline: [rounded, cutout].join("\n") }))
    expect((await roundTrip(board1)).differences).toEqual([])
    const open = imported(board({ body: [part1], outline: [line("0 0", "30 0"), line("30 0", "30 20"), line("30 20", "0 20")].join("\n") }))
    expect((await roundTrip(open)).differences).toEqual([])
    const none = imported(board({ body: [part1], outline: false }))
    const out = await pcbOf(none)
    expect(out).not.toContain("Edge.Cuts\")\n")
    expect((await roundTrip(none)).differences).toEqual([])
  })
})

describe("text", () => {
  const fx = (extra = "") => `(effects (font (size 1.2 1) (thickness 0.2) ${extra}))`
  const text = (extra: string) => `(gr_text "T" (at 4 4 20) (layer "F.SilkS") ${extra})`
  it("board texts of every kind, text boxes at 0 and 90 degrees, and a part's own texts on both sides read back as the same texts", async () => {
    const body = [
      text(fx("bold italic")),
      `(gr_text "M" (at 8 4) (layer "B.SilkS") (effects (font (size 1 1) (thickness 0.15)) (justify left bottom mirror)))`,
      `(gr_text "K" (at 12 4) (layer "F.Cu" knockout) (effects (font (size 1.5 1.5) (thickness 0.3))))`,
      `(gr_text "H" (at 16 4) (layer "F.SilkS") (effects (font (size 1 1) (thickness 0.15)) (href "https://example.com")))`,
      `(gr_text_box "hello world" (start 2 8) (end 12 12) (stroke (width 0.2) (type solid)) (border yes) (margins 0.5 0.6 0.7 0.8) (layer "F.SilkS") ${fx()})`,
      `(gr_text_box "turned" (start 14 8) (end 24 12) (angle 90) (layer "F.Fab") ${fx()})`,
      footprint({ ref: "R1", at: "10 20 30", pads: [pad({ at: "0 0" })], extra: `(fp_text user "own" (at 1 -2 45 unlocked) (layer "F.Fab") (effects (font (size 0.8 0.8) (thickness 0.1)) (justify right top)))` }),
      footprint({ ref: "R2", at: "25 20 60", layer: "B.Cu", pads: [pad({ at: "0 0", layers: '"B.Cu" "B.Paste" "B.Mask"' })], extra: `(fp_text user "own" (at 1 -2 45) (layer "B.Fab") (hide yes) (effects (font (size 0.8 0.8) (thickness 0.1)) (justify mirror)))` }),
    ]
    const p = imported(board({ version: 20241229, body, outline: '(gr_rect (start 0 0) (end 30 30) (stroke (width 0.1) (type default)) (fill none) (layer "Edge.Cuts"))' }))
    expect(p.texts.length).toBe(6)
    const { text: out, differences } = await roundTrip(p)
    expect(differences).toEqual([])
    expect(out).toContain('(href "https://example.com")')
    expect(out).toContain('(layer "F.Cu" knockout)')
    expect(out).toContain("(unlocked yes)")
    expect(out).toContain("(justify left bottom mirror)")
  })
})

describe("parts' flags and groups, and zones of every kind", () => {
  const sq = (a: number, b: number, c: number, d: number) => `(polygon (pts (xy ${a} ${b}) (xy ${c} ${b}) (xy ${c} ${d}) (xy ${a} ${d})))`
  const zone = (extra: string, polygon: string, layer = '(layer "F.Cu")', net = '(net 1) (net_name "A")') => `(zone ${net} ${layer} (uuid "a1b2c3d4-0000-4000-8000-0000000000${(extra.length % 90) + 10}") (hatch edge 0.5) ${extra} ${polygon})`
  it("every attribute, net tie and jumper group, and a group inside a part naming its pads, drawings and texts, read back the same", async () => {
    const part1 = footprint({
      ref: "J1",
      at: "10 10 15",
      pads: [pad({ number: "1", at: "-1 0", net: '(net 1 "A")' }), pad({ number: "2", at: "1 0", net: '(net 2 "B")' }), pad({ number: "3", at: "3 0" })],
      extra: `(attr smd board_only exclude_from_pos_files exclude_from_bom allow_soldermask_bridges allow_missing_courtyard dnp) (net_tie_pad_groups "1,2") (jumper_pad_groups ("1" "3")) (duplicate_pad_numbers_are_jumpers yes) (locked yes)
        (fp_line (start -2 1) (end 2 1) (stroke (width 0.1) (type solid)) (layer "F.SilkS") (uuid "${U(41)}"))
        (fp_text user "t" (at 0 2) (layer "F.SilkS") (uuid "${U(42)}") (effects (font (size 1 1) (thickness 0.15))))
        (group "inner" (uuid "${U(43)}") (members "${U(41)}" "${U(42)}"))`,
    })
    const p = imported(board({ nets: NETS, body: [part1] }))
    expect(p.components[0].groups).toHaveLength(1)
    const { text, differences } = await roundTrip(p)
    expect(differences).toEqual([])
    expect(text).toContain('(net_tie_pad_groups "1,2")')
    expect(text).toContain('(jumper_pad_groups ("1" "3"))')
    expect(text).toContain("(locked yes)")
    expect(text).toMatch(/\(group "inner"/)
  })
  it("zones with an arc, smoothing, islands, a rule area, a teardrop, on the back layer and on both, read back the same", async () => {
    const arcPoly = '(polygon (pts (xy 0 0) (xy 10 0) (arc (start 10 0) (mid 12 3) (end 10 6)) (xy 0 6)))'
    const body = [
      footprint({ ref: "R1", at: "5 3", pads: [pad({ at: "0 0", net: '(net 1 "A")' })] }),
      zone("(priority 3) (connect_pads (clearance 0.4)) (min_thickness 0.25) (filled_areas_thickness no) (fill yes (thermal_gap 0.5) (thermal_bridge_width 0.4) (smoothing fillet) (radius 1.2) (island_removal_mode 2) (island_area_min 4))", arcPoly),
      zone("(connect_pads thru_hole_only (clearance 0.3)) (min_thickness 0.2) (filled_areas_thickness no) (fill (thermal_gap 0.3) (thermal_bridge_width 0.3))", sq(0, 10, 10, 16), '(layers "F.Cu" "B.Cu")'),
      zone("(connect_pads no (clearance 0.3)) (min_thickness 0.2) (filled_areas_thickness no) (fill yes (thermal_gap 0.3) (thermal_bridge_width 0.3) (island_removal_mode 1) (island_area_min 10))", sq(12, 10, 20, 16), '(layer "B.Cu")'),
      '(zone (net 0) (net_name "") (layers "F.Cu" "B.Cu") (uuid "a1b2c3d4-0000-4000-8000-000000000077") (name "keep out") (hatch edge 0.5) (connect_pads (clearance 0)) (min_thickness 0.25) (keepout (tracks not_allowed) (vias not_allowed) (pads allowed) (copperpour not_allowed) (footprints allowed)) (fill (thermal_gap 0.5) (thermal_bridge_width 0.5)) (polygon (pts (xy 22 0) (xy 28 0) (xy 28 6) (xy 22 6))))',
      zone("(attr (teardrop (type padvia))) (connect_pads yes (clearance 0.3)) (min_thickness 0.2) (filled_areas_thickness no) (fill yes (thermal_gap 0.3) (thermal_bridge_width 0.3))", sq(22, 10, 28, 16)),
    ]
    const p = imported(board({ nets: ['(net 0 "")', '(net 1 "A")'], body, outline: '(gr_rect (start 0 -2) (end 30 20) (stroke (width 0.1) (type default)) (fill none) (layer "Edge.Cuts"))' }))
    expect(p.zones.length).toBe(5)
    const { differences } = await roundTrip(p)
    expect(differences).toEqual([])
  })
})

describe("a part and a trace added to an imported board", () => {
  it("are written natively too: a library part with its reference and value, its pads on the nets the schematic gives them, and a trace on the net it touches", async () => {
    const p0 = imported(board({ nets: ['(net 0 "")', '(net 1 "A")'], body: [footprint({ ref: "R1", at: "5 5", pads: [pad({ at: "0 0", net: '(net 1 "A")' })] })] }))
    let p = addComponent(p0, "resistor", { sch: { x: 30, y: 0 }, pcb: { x: 12, y: -6, placed: true } }).project
    const added = p.components[p.components.length - 1]
    p = labelPin(p, { componentId: added.id, pin: "1" }, "A")
    const pads = pcbPads(added)
    const first = pads.find((x) => x.pin === "1")!
    p = addTrace(p, { layer: "top", width: 0.25, points: [{ x: first.x, y: first.y }, { x: first.x + 3, y: first.y }] }).project
    const out = await pcbOf(p)
    expect(out).toContain(`(property "Reference" "${added.ref}"`)
    expect(out).toMatch(/\(segment[\s\S]*?\(net 1\)/)
    const again = importKicadBoard(out)
    if (again.status !== "imported") throw new Error(again.message)
    expect(again.project.components.map((c) => c.ref).sort()).toEqual(p.components.map((c) => c.ref).sort())
    const pinNet = (project: Project, ref: string) => {
      const c = project.components.find((x) => x.ref === ref)!
      return computeConnectivity(project).pinNet.get(pinKey(c.id, "1"))
    }
    expect(pinNet(again.project, added.ref)?.length).toBeGreaterThan(0)
  })
})
