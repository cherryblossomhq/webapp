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
