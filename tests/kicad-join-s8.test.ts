import { describe, expect, it } from "vitest"
import { buildFabricationFiles } from "../src/export/bundle"
import { schematicSvg } from "../src/ai/vision/schematicSvg"
import { measureSchematic } from "../src/ai/vision/measure"
import { getConnectivity, sameSchematic } from "../src/model/connectivityCache"
import { onBoard } from "../src/model/partFlags"
import { resolvedComponents, symbolBox } from "../src/model/ruleAreas"
import type { ComponentInstance, DrawingLine, Project } from "../src/model/types"
import { built } from "./built"

// The merge of S8 (rule areas) into the join: readers of the part flags that the multilayer and fab work added go through the resolved flags.

const base: Project = { ...built("regulator"), netNames: "kicad" }
const areaOver = (c: ComponentInstance, ruleArea: NonNullable<DrawingLine["ruleArea"]>): DrawingLine => {
  const b = symbolBox(c)
  const x = (b.minX + b.maxX) / 2
  const y = (b.minY + b.maxY) / 2
  const d = 0.01
  return { id: `area-${c.id}`, type: "line", closed: true, points: [{ x: x - d, y: y - d }, { x: x + d, y: y - d }, { x: x + d, y: y + d }, { x: x - d, y: y + d }], ruleArea }
}
const target = base.components.find((c) => c.pcb.placed && onBoard(c) && c.ref === "D1")!
const withArea = (p: Project, ruleArea: NonNullable<DrawingLine["ruleArea"]>): Project => ({ ...p, drawings: [...(p.drawings ?? []), areaOver(target, ruleArea)] })

describe("S8 flags reach the readers added by the other lanes", () => {
  it("the fab notes list a part a rule area marks do not populate", () => {
    const notes = Object.values(buildFabricationFiles(withArea(base, { dnp: true }))).find((t) => t.includes("PART FLAGS")) ?? ""
    expect(notes).toContain(`Do not populate   ${target.ref}:`)
    expect(Object.values(buildFabricationFiles(base)).some((t) => t.includes("PART FLAGS"))).toBe(false)
  })

  it("Sakura's schematic image draws the DNP cross for a part a rule area marks", () => {
    const box = { minX: -20, minY: -20, maxX: 20, maxY: 20 }
    const draw = (p: Project) => schematicSvg(p, box, { width: 800, height: 600 }, measureSchematic(p))
    const plain = draw(base)
    const marked = draw(withArea(base, { dnp: true }))
    expect(marked).not.toEqual(plain)
    expect(resolvedComponents(withArea(base, { dnp: true })).find((c) => c.id === target.id)!.flags?.dnp).toBe(true)
  })

  it("an edit of only a rule area's on_board flag refreshes the net names", () => {
    const a = withArea(base, {})
    const b: Project = { ...a, drawings: a.drawings!.map((d) => (d.type === "line" && d.ruleArea ? { ...d, ruleArea: { notOnBoard: true } } : d)) }
    expect(sameSchematic(a, b)).toBe(false)
    expect(sameSchematic(a, { ...a })).toBe(true)
    expect(sameSchematic(a, { ...a, drawings: [...a.drawings!] })).toBe(true)
    const names = (p: Project) => getConnectivity(p).nets.map((n) => n.name).sort()
    const before = names(a)
    expect(names(b)).not.toEqual(before)
    expect(names(a)).toEqual(before)
  })
})
