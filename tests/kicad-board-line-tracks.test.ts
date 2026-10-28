import { describe, expect, it } from "vitest"
import { importKicadBoard } from "../src/model/kicad/board"
import { board } from "./kicad-board-fixtures"

// A KiCad 4 file may write a line on a drawing layer as a `segment` (a track on Dwgs.User or F.SilkS). KiCad draws and plots it there, so it is a drawing; one that is on a net, or on a copper layer
// the board lacks, is still refused as inexact.

const nets = ['(net 0 "")', '(net 1 "A")']
const seg = (layer: string, net = 0, extra = "") => `(segment (start 1 1) (end 5 1) (width 0.25) (layer ${layer}) (net ${net}) ${extra}`.trimEnd() + ")"

describe("a segment on a layer that is not copper", () => {
  it("is a line drawing on that layer when it has no net", () => {
    const r = importKicadBoard(board({ nets, body: [seg("Dwgs.User"), seg("F.SilkS")] }))
    expect(r.status).toBe("imported")
    if (r.status !== "imported") return
    const lines = (r.project.graphics ?? []).filter((s) => s.type === "line")
    expect(lines.map((s) => s.layer).sort()).toEqual(["Dwgs.User", "F.SilkS"])
    expect(r.project.traces ?? []).toHaveLength(0)
    for (const s of lines) expect(s.width).toBe(0.25)
  })
  it("is refused when it is on a net, or on an inner layer the board lacks", () => {
    expect(importKicadBoard(board({ nets, body: [seg("Dwgs.User", 1)] })).status).toBe("refused")
    expect(importKicadBoard(board({ nets, body: [seg("In1.Cu")] })).status).toBe("refused")
  })
})
