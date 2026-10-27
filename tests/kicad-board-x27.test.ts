import { describe, expect, it } from "vitest"
import { kicadFiles } from "../src/export/kicad"
import { importKicadBoard } from "../src/model/kicad/board"
import { parseProjectFile, serializeProject } from "../src/model/projectFile"
import type { Project } from "../src/model/types"
import { board, footprint, pad } from "./kicad-board-fixtures"
import { diffProjects } from "./kicad-roundtrip-check"
import { unknownNodes } from "./kicad9-nodes"

// X27: a dimension drawn inside a footprint. KiCad keeps its points as the board's in every file up to stamp 20260616, whichever way the part sits, so it is the board's dimension of those points; the
// part's own pose is not applied to it, and it no longer moves with the part (the report says so).

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

  it("is refused, named, in a file that keeps a part's drawings in the part's own frame", () => {
    const r = importKicadBoard(board({ version: 20260616, body: [part("10 5", "F.Cu", dim(ID(1)))] }))
    expect(r.status === "refused" && r.reason).toBe("inexact")
    expect(r.status === "refused" && r.message).toMatch(/dimension inside U1 in a file that stores a part's drawings in the part's own frame \(stamp 20260616\)/)
  })

  it("a dimension inside a part that a group of the part names is one the group cannot hold: it is the board's now", () => {
    const g = `(group "" (uuid "${ID(9)}") (members "${ID(1)}"))`
    const r = imp([part("10 5", "F.Cu", `${dim(ID(1))} ${g}`)])
    expect(r.project.dimensions).toHaveLength(1)
    expect(r.project.components[0].groups ?? []).toHaveLength(0)
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
