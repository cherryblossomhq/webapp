import { describe, expect, it } from "vitest"
import { blockFrames } from "../src/model/blocks"
import { EXAMPLES } from "../src/model/examples"
import { DEFAULT_PAPER, holds, paperOf } from "../src/model/paper"
import { tidySchematic } from "../src/model/tidy"
import type { Project, SheetPaper } from "../src/model/types"

// A whole-sheet tidy lays the blocks out on the sheet's page: from the inner frame's top-left, inside the border and clear of the title
// block, and grows the page one size at a time, its corner kept, only when they don't fit. A one-block tidy leaves the page alone.

const example = (id: string) => EXAMPLES.find((e) => e.id === id)!.project
const onPaper = (p: Project, paper: SheetPaper): Project => ({ ...p, sheets: [{ id: "root", paper }] })
/** A4 landscape away from where the examples were tidied, so a tidy moves the whole drawing onto it. */
const ELSEWHERE: SheetPaper = { size: "A4", x: 40.2, y: -30.1 }

describe("a whole-sheet tidy on the page", () => {
  it("puts every block inside the border and clear of the title block, without growing a page it fits", () => {
    for (const id of ["blinker", "mcu", "node", "regulator"]) {
      const r = tidySchematic(onPaper(example(id), ELSEWHERE))
      expect(r.ok && r.changed, `${id}: ${r.message}`).toBe(true)
      expect(paperOf(r.project), id).toEqual(ELSEWHERE)
      expect(r.message).not.toMatch(/grew/)
      for (const f of blockFrames(r.project)) expect(holds(ELSEWHERE, f.box), `${id} ${f.name} ${JSON.stringify(f.box)}`).toBe(true)
    }
  })

  it("grows a page too small for the design one size, keeps its corner, and says so", () => {
    // The example was built on A4 and grew to A3: on A4 again, it grows the same way.
    const r = tidySchematic(onPaper(example("esp32-robot"), DEFAULT_PAPER))
    expect(r.ok && r.changed, r.message).toBe(true)
    const paper = paperOf(r.project)
    expect(paper).toEqual({ size: "A3", x: DEFAULT_PAPER.x, y: DEFAULT_PAPER.y })
    expect(r.message).toContain("The sheet grew from A4 to A3 to hold it.")
    for (const f of blockFrames(r.project)) expect(holds(paper, f.box), `${f.name} ${JSON.stringify(f.box)}`).toBe(true)
  })

  it("keeps a page's family and orientation when it grows", () => {
    const portrait: SheetPaper = { size: "USLetter", portrait: true, x: 0, y: 0 }
    const r = tidySchematic(onPaper(example("esp32-robot"), portrait))
    expect(r.ok, r.message).toBe(true)
    const paper = paperOf(r.project)
    expect(paper.portrait).toBe(true)
    expect(["USLedger", "C", "D", "E"]).toContain(paper.size)
    expect([paper.x, paper.y]).toEqual([0, 0])
    for (const f of blockFrames(r.project)) expect(holds(paper, f.box), `${f.name}`).toBe(true)
  })

  it("leaves the page alone in a one-block tidy", () => {
    const p = onPaper(example("blinker"), { size: "A5", x: 50, y: 50 })
    const block = p.blocks![0]
    const r = tidySchematic({ ...p, components: p.components.map((c) => (block.components.includes(c.id) ? { ...c, sch: { ...c.sch, x: c.sch.x + 0.5 } } : c)) }, { blockId: block.id })
    expect(r.ok, r.message).toBe(true)
    expect(r.project.sheets).toEqual(p.sheets)
  })
})
