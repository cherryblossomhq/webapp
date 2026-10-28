import { describe, expect, it } from "vitest"
import { kicadFiles } from "../src/export/kicad"
import { importKicadBoard } from "../src/model/kicad/board"
import type { Project } from "../src/model/types"
import { board, footprint, pad } from "./kicad-board-fixtures"

// X21/X22: what a KiCad 9 file cannot hold (via protection, backdrills, post-machining, die delay, net chains) stays in the project, and the notes say so.
const imported = (): Project => {
  const r = importKicadBoard(board({ body: [footprint({ ref: "R1", value: "10k", at: "5 5", pads: [pad({ number: "1", at: "-1 0" }), pad({ number: "2", at: "1 0" })] })] }))
  if (r.status !== "imported") throw new Error(r.message)
  return r.project
}
const notesOf = async (p: Project) => (await kicadFiles(p)).notes.join("\n")

describe("KiCad 9 export notes for KiCad 10 machining", () => {
  it("says nothing for a board that has none", async () => {
    const n = await notesOf(imported())
    expect(n).not.toMatch(/backdrills/)
    expect(n).not.toMatch(/die delay/)
    expect(n).not.toMatch(/Net chains/)
  })

  it("names a via's backdrill, a board's via protection, a pad's post-machining, die delay and net chains", async () => {
    const p = imported()
    const via = { id: "v1", x: 1, y: 1, drill: 0.3, diameter: 0.6, net: "", backdrill: { size: 0.5, from: "top", to: "in1", stub: 0.1 } } as unknown as Project["vias"][number]
    expect(await notesOf({ ...p, vias: [via] })).toMatch(/backdrills, tertiary drills and post-machining are KiCad 10's/)
    expect(await notesOf({ ...p, rules: { ...p.rules, viaProtect: { cap: true } } })).toMatch(/backdrills/)
    const pads = (fix: object) => ({ ...p, footprints: p.footprints!.map((f, i) => (i ? f : { ...f, pads: f.pads.map((q, j) => (j ? q : { ...q, ...fix })) })) }) as Project
    expect(await notesOf(pads({ post: { front: { kind: "counterbore", diameter: 1, depth: 0.2 } } }))).toMatch(/post-machining/)
    expect(await notesOf(pads({ dieDelay: 3 }))).toMatch(/die delay/)
    expect(await notesOf({ ...p, netChains: [{ name: "c", nets: ["A"] }] })).toMatch(/Net chains are KiCad 10's/)
  })
})
