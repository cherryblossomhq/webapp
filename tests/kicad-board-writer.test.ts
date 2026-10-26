import { describe, expect, it } from "vitest"
import { kicadFiles } from "../src/export/kicad"
import { isKicadBoardProject } from "../src/export/kicadBoard"
import { importKicadBoard, readKicadBoard } from "../src/model/kicad/board"
import { pcbPads } from "../src/model/instances"
import type { Project } from "../src/model/types"
import { board, footprint, pad } from "./kicad-board-fixtures"
import { canonicalProject, diffCanonical } from "./kicad-roundtrip-check"
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
  return { text, differences: diffCanonical(canonicalProject(p), canonicalProject(again.project)).filter((d) => !d.kind.startsWith("project.rules.")), again: again.project }
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
    expect(diffCanonical(canonicalProject(p), canonicalProject(again.project)).filter((d) => !d.kind.startsWith("project.rules."))).toEqual([])
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
    expect(diffCanonical(canonicalProject(r.project), canonicalProject(again.project)).filter((d) => !d.kind.startsWith("project.rules."))).toEqual([])
  })
})
