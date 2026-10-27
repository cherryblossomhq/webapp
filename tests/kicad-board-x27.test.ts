import { describe, expect, it } from "vitest"
import { kicadFiles } from "../src/export/kicad"
import { importKicadBoard } from "../src/model/kicad/board"
import { parseProjectFile, serializeProject } from "../src/model/projectFile"
import type { Project } from "../src/model/types"
import { board, footprint, pad } from "./kicad-board-fixtures"
import { diffProjects } from "./kicad-roundtrip-check"
import { unknownNodes } from "./kicad9-nodes"

// X27: a dimension drawn inside a footprint. KiCad keeps its points as the board's in every file, whichever way the part sits and whatever the stamp (`PCB_DIMENSION_BASE::GetStart` and `SetStart` apply the
// footprint's transform, and the writer writes the result), so it is the board's dimension of those points; the part's own pose is not applied to it, and it no longer moves with the part (the report says so).

const dim = (id: string, extra = "") =>
  `(dimension (type orthogonal) (layer "Dwgs.User") (uuid "${id}") (pts (xy 3 4) (xy 13 9)) (height 6) (orientation 1) (format (prefix "") (suffix "") (units 3) (units_format 0) (precision 4) (suppress_zeroes yes)) (style (thickness 0.1) (arrow_length 1.27) (text_position_mode 0) (arrow_direction outward) (extension_height 0.58642) (extension_offset 0.5) (keep_text_aligned yes)) (gr_text "10" (at 16 6.5 90) (layer "Dwgs.User") (uuid "${id}") (effects (font (size 1 1) (thickness 0.15)))) ${extra})`
const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`
const part = (at: string, layer: string, inner: string) => footprint({ ref: "U1", at, layer, pads: [pad({ at: "0 0", layers: layer === "B.Cu" ? '"B.Cu" "B.Paste" "B.Mask"' : undefined })], extra: inner })
const imp = (body: string[], extra: Parameters<typeof board>[0] = {}) => {
  const r = importKicadBoard(board({ body, ...extra }))
  if (r.status !== "imported") throw new Error(`${r.status}: ${r.message}`)
  return r
}
const pcbOf = async (p: Project) => Object.entries((await kicadFiles(p)).files).find(([k]) => k.endsWith(".kicad_pcb"))![1]

describe("a dimension inside a footprint", () => {
  const alone = imp([footprint({ ref: "U1", at: "10 5", pads: [pad({ at: "0 0" })] }), dim(ID(1))]).project.dimensions!

  it("is the board's dimension of the same points, whatever the part's place, turn and side", () => {
    for (const [at, layer] of [["10 5", "F.Cu"], ["10 5 90", "F.Cu"], ["30 40 33", "F.Cu"], ["10 5", "B.Cu"], ["10 5 180", "B.Cu"]] as const) {
      const r = imp([part(at, layer, dim(ID(1)))])
      expect(r.project.dimensions, `${at} ${layer}`).toEqual(alone)
    }
  })

  it("comes after the board's own, with ids in order, and the report counts the ones that left their part", () => {
    const r = imp([dim(ID(1)), part("10 5", "F.Cu", `${dim(ID(2))} ${dim(ID(3)).replace("orthogonal", "aligned")}`)])
    expect(r.project.dimensions!.map((d) => [d.id, d.kind])).toEqual([["dm1", "orthogonal"], ["dm2", "orthogonal"], ["dm3", "aligned"]])
    const e = r.report.entries.find((x) => x.code === "dimensions-flattened")!
    expect(e).toMatchObject({ severity: "changed", count: 2 })
    expect(e.items).toEqual(["U1: orthogonal", "U1: aligned"])
    // the part moves and its dimension stays where it was drawn
    expect(r.project.dimensions![1]).toMatchObject({ a: { x: 3, y: -4 }, b: { x: 13, y: -9 } })
  })

  it("is the same dimension in a file of stamp 20260616, whose part is placed by a transform with a scale: KiCad writes the board's points all the same", () => {
    for (const [transform, layer] of [["(translate 10 5) (rotate 0) (scale 1)", "F.Cu"], ["(translate 30 40) (rotate 33) (scale 1)", "F.Cu"], ["(translate 10 5) (rotate 90) (scale 1)", "B.Cu"]] as const) {
      const text = part("10 5", layer, dim(ID(1))).replace("(at 10 5)", `(transform ${transform})`)
      expect(text).toContain("(transform")
      const r = importKicadBoard(board({ version: 20260616, body: [text] }))
      expect(r.status, transform).toBe("imported")
      expect(r.status === "imported" && r.project.dimensions, transform).toEqual(alone)
    }
  })

  it("a part on the bottom, flipped, has its dimension on a back layer with its text mirrored, as the file says, and it is the board's the same", () => {
    const back = dim(ID(1)).replaceAll("Dwgs.User", "B.SilkS").replace("(thickness 0.15))", "(thickness 0.15)) (justify mirror)")
    const onBoard = imp([footprint({ ref: "U1", at: "10 5", pads: [pad({ at: "0 0" })] }), back]).project.dimensions!
    expect(onBoard[0]).toMatchObject({ layer: "B.SilkS", mirror: true })
    for (const at of ["10 5 180", "10 5", "30 40 33"]) expect(imp([part(at, "B.Cu", back)]).project.dimensions, at).toEqual(onBoard)
  })

  it("a radial, a leader and a center dimension inside a part are the board's the same way, the leader as a corpus board (RoyalBlue54L-NFC-Antenna) draws it", () => {
    const leader = `(dimension (type leader) (layer "Cmts.User") (uuid "${ID(4)}") (pts (xy 152.94971 67.310695) (xy 156.29971 63.960695)) (format (prefix "") (suffix "") (units 0) (units_format 0) (precision 4) (override_value "0.3mm Thickness")) (style (thickness 0.1) (arrow_length 1.27) (text_position_mode 0) (text_frame 0) (extension_offset 0.5)) (gr_text "0.3mm Thickness" (at 168.99971 63.960695 0) (layer "Cmts.User") (uuid "${ID(4)}") (effects (font (size 1 1) (thickness 0.15)))))`
    const radial = `(dimension (type radial) (layer "Dwgs.User") (uuid "${ID(5)}") (pts (xy 5 5) (xy 8 5)) (gr_text "R 3" (at 10 5 0) (layer "Dwgs.User") (uuid "${ID(5)}") (effects (font (size 1 1) (thickness 0.15)))))`
    const center = `(dimension (type center) (layer "Dwgs.User") (uuid "${ID(6)}") (pts (xy 5 5) (xy 7 5)) (style (thickness 0.1) (arrow_length 1.27) (text_position_mode 0) (extension_offset 0)))`
    for (const [kind, text] of [["leader", leader], ["radial", radial], ["center", center]] as const) {
      const onBoard = imp([footprint({ ref: "U1", at: "10 5", pads: [pad({ at: "0 0" })] }), text]).project.dimensions!
      expect(onBoard.map((d) => d.kind)).toEqual([kind])
      for (const [at, layer] of [["10 5", "F.Cu"], ["10 5 90", "F.Cu"], ["10 5 180", "B.Cu"]] as const) expect(imp([part(at, layer, text)]).project.dimensions, `${kind} ${at} ${layer}`).toEqual(onBoard)
    }
  })

  it("names its part by the project's reference, and fills the part's reference, value and fields into its text", () => {
    const text = dim(ID(1)).replace('(prefix "")', '(prefix "${REFERENCE} ")').replace('(suffix "")', '(suffix " ${VALUE} ${Datasheet} ${Colour}")')
    const field = `(property "Datasheet" "ds.pdf" (at 0 0 0) (layer "F.Fab") (hide yes) (effects (font (size 1 1) (thickness 0.15))))`
    const r = imp([footprint({ ref: "REF**", value: "47k", at: "10 5", pads: [pad({ at: "0 0" })], extra: `${field} ${text}` })])
    const ref = r.project.components[0].ref
    expect(ref).not.toBe("REF**")
    expect(r.project.dimensions![0]).toMatchObject({ prefix: `${ref} `, suffix: " 47k ds.pdf ${Colour}" })
    const e = r.report.entries.find((x) => x.code === "dimensions-flattened")!
    expect(e.items).toEqual([`${ref}: orthogonal`])
    // what it could not fill in stays as typed, and the report says so
    expect(e.why).toMatch(/uses \$\{Colour\}, which the editor cannot fill in/)
  })

  it("a dimension on one of the part's private layers is not brought in, like any drawing on one", () => {
    const r = imp([part("10 5", "F.Cu", `(private_layers "Dwgs.User") ${dim(ID(1))}`)])
    expect(r.project.dimensions ?? []).toHaveLength(0)
    expect(r.report.entries.find((x) => x.code === "private-layer-drawings")).toMatchObject({ severity: "not-brought", count: 1 })
    expect(r.report.entries.some((x) => x.code === "dimensions-flattened")).toBe(false)
  })

  it("a dimension inside a part that a group of the part names is one the group cannot hold: it is the board's now", () => {
    const g = `(group "" (uuid "${ID(9)}") (members "${ID(1)}"))`
    const r = imp([part("10 5", "F.Cu", `${dim(ID(1))} ${g}`)])
    expect(r.project.dimensions).toHaveLength(1)
    expect(r.project.components[0].groups ?? []).toHaveLength(0)
    expect(r.report.entries.find((e) => e.code === "group-member-not-brought")?.why).toMatch(/dimensions of a part \(the board's now/)
  })

  it("is written as KiCad 9 writes a dimension, and read back as the same project", async () => {
    const a = imp([part("10 5", "F.Cu", dim(ID(1)))])
    const text = await pcbOf(a.project)
    expect(unknownNodes(text)).toEqual([])
    const b = importKicadBoard(text)
    expect(b.status).toBe("imported")
    if (b.status === "imported") expect(diffProjects(a.project, b.project)).toEqual([])
  })

  it("is kept by a save and a load", () => {
    const a = imp([part("10 5", "F.Cu", dim(ID(1)))])
    expect(parseProjectFile(serializeProject(a.project), { id: "x" }).dimensions).toEqual(a.project.dimensions)
  })
})
