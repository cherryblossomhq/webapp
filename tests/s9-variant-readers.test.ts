import { describe, expect, it } from "vitest"
import { runTool } from "../src/ai/tools"
import { addComponent, createProject } from "../src/model/ops"
import { getDesignators, placeDesignators } from "../src/model/silk"
import { setVariantOverride, setActiveVariant } from "../src/model/variants"
import type { Project } from "../src/model/types"

// S9: what the active variant takes off the board is read as off the board by everything that reads a part's flags: the silkscreen designators (editor, Gerbers and
// 3D board), the counts Sakura reports, the Inspector's.

function board(): Project {
  let p = createProject("v")
  for (const x of [-8, 8]) p = addComponent(p, "resistor", { sch: { x: x / 4, y: 0 }, pcb: { x, y: 0, rot: 0, side: "top", placed: true } }).project
  return { ...p, board: { ...p.board, width: 60, height: 60, x: 0, y: 0 } }
}

describe("a part the active variant takes off the board has no designator", () => {
  it("placeDesignators and getDesignators leave it out, and the cache follows the active variant", () => {
    const p0 = board()
    const r2 = p0.components[1]
    expect(placeDesignators(p0).has(r2.id)).toBe(true)
    const p1 = setActiveVariant(setVariantOverride(p0, r2.id, "NoR2", { notOnBoard: true }), "NoR2")
    expect(placeDesignators(p1).has(r2.id)).toBe(false)
    expect(placeDesignators(p1).has(p0.components[0].id)).toBe(true)
    // the same parts and board with the variant switched: the cached answer is not reused
    expect(getDesignators(p0).has(r2.id)).toBe(true)
    expect(getDesignators(p1).has(r2.id)).toBe(false)
    expect(getDesignators(setActiveVariant(p1, undefined)).has(r2.id)).toBe(true)
  })

  it("Sakura's count of parts still to place does not count a part the variant takes off the board", () => {
    const p0 = board()
    const unplaced = { ...p0, components: p0.components.map((c, i) => (i === 1 ? { ...c, pcb: { ...c.pcb, placed: false } } : c)) }
    const get = (p: Project) => (JSON.parse(runTool(p, "get_design", {}).result) as { checks: { unplaced_on_pcb: number } }).checks.unplaced_on_pcb
    const before = get(unplaced)
    const off = setActiveVariant(setVariantOverride(unplaced, unplaced.components[1].id, "NoR2", { notOnBoard: true }), "NoR2")
    const after = get(off)
    expect(before).toBe(1)
    expect(after).toBe(0)
  })
})
