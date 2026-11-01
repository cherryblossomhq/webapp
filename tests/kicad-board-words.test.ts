import { describe, expect, it } from "vitest"
import { importKicadBoard } from "../src/model/kicad/board"
import { board, footprint, pad } from "./kicad-board-fixtures"

// Words of KiCad boards, from KiCad 6's nightlies to KiCad 10, that 1,146 open-source projects found the importer refusing.

const imported = (text: string) => {
  const r = importKicadBoard(text)
  if (r.status !== "imported") throw new Error(`refused: ${r.message}`)
  return r
}

describe("a footprint's own stackup (KiCad 10)", () => {
  it("is passed over: every pad and drawing names its layer", () => {
    const fp = footprint({ ref: "C1", pads: [pad({ at: "0 0" })], extra: '(stackup (layer "F.Cu") (layer "B.Cu") (layer "User.1"))' })
    const r = imported(board({ version: 20260206, body: [fp] }))
    expect(r.project.components.map((c) => c.ref)).toEqual(["C1"])
  })
})

describe("items on a layer no KiCad layer is (KiCad's EAGLE converter writes UNDEFINED)", () => {
  it("are on Cmts.User, as KiCad's rescue moves them, and the report counts them by name", () => {
    const body = [
      '(gr_line (start 1 1) (end 5 1) (stroke (width 0.1) (type solid)) (layer "UNDEFINED"))',
      '(gr_text "tPlace" (at 3 3 0) (layer "UNDEFINED") (effects (font (size 1 1) (thickness 0.15))))',
      footprint({ ref: "U1", pads: [pad({ at: "0 0" })], extra: '(fp_line (start -1 -1) (end 1 -1) (stroke (width 0.1) (type solid)) (layer "UNDEFINED"))' }),
      '(gr_line (start 1 2) (end 5 2) (stroke (width 0.1) (type solid)) (layer "F.SilkS"))',
    ]
    const r = imported(board({ version: 20240108, body }))
    expect(r.project.graphics!.map((g) => g.layer)).toEqual(["Cmts.User", "F.SilkS"])
    expect(r.project.texts!.map((t) => t.layer)).toEqual(["Cmts.User"])
    expect(r.report.entries.find((e) => e.code === "layer-rescued")).toMatchObject({ severity: "note", count: 3, object: '3 items on "UNDEFINED", which no KiCad layer is' })
  })
})

describe("the board's default for stroked fills (a KiCad 6 nightly, 2019)", () => {
  it("is passed over: every zone says it itself", () => {
    const r = imported(board({ version: 20190905, setup: "(setup (filled_areas_thickness no))", body: [footprint({ pads: [pad({ at: "0 0" })] })] }))
    expect(r.project.components).toHaveLength(1)
  })
})
