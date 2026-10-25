import { describe, expect, it } from "vitest"
import { kicadFiles } from "../src/export/kicad"
import { importKicadSchematic } from "../src/model/kicad/schematic"
import type { Project, SchematicDrawing } from "../src/model/types"
import { parseSexpr } from "./kicad-census/sexpr.mjs"
import { kicad9SheetProblems } from "./kicad9-strict"
import { LIB_R, schematic } from "./kicad-schematic-fixtures"

// Fix round 1 of the join: what the exported sheet says, checked the way KiCad 9.0 reads it.

const R1 = "aaaaaaaa-0000-4000-8000-000000000001"
const sheet = (body: string[], version = 20250114) =>
  schematic({ version, libs: [LIB_R], symbols: [{ lib: "Device:R", at: "50.8 50.8", ref: "R1", value: "10k", footprint: "R_0603", uuid: R1 }], wires: ["50.8 54.61 50.8 70"], body })
const imp = (text: string): Project => {
  const r = importKicadSchematic(text)
  if (r.status !== "imported") throw new Error(`refused: ${r.message}\n${r.report.entries.map((e) => e.why).join("\n")}`)
  return r.project
}
const schOf = async (p: Project) => {
  const { files, notes } = await kicadFiles(p)
  return { sch: Object.entries(files).find(([k]) => k.endsWith(".kicad_sch"))![1], notes }
}
const withDrawings = (p: Project, drawings: SchematicDrawing[]): Project => ({ ...p, drawings })
const nodes = (sch: string, name: string) => (parseSexpr(sch)[0] as unknown[]).filter((n) => Array.isArray(n) && n[0] === name) as unknown[][]
const kid = (node: unknown[], name: string) => node.find((c) => Array.isArray(c) && c[0] === name) as unknown[] | undefined

describe("B1: a rounded rectangle in a KiCad 9 file", () => {
  it("the strict KiCad 9 reader rejects a radius on a rectangle (the checker is not blind)", () => {
    const bad = `(kicad_sch (version 20250114) (rectangle (start 0 0) (end 1 1) (radius 0.5) (stroke (width 0) (type default)) (fill (type none)) (uuid u)))`
    expect(kicad9SheetProblems(bad)).toEqual(["rectangle: KiCad 9 does not accept (radius ...)"])
  })

  it("writes a tool rectangle with a radius as four lines and four arcs, with no radius token", async () => {
    const base = imp(sheet([]))
    const p = withDrawings(base, [{ id: "d1", type: "rect", x: 1, y: 1, width: 2, height: 1, radius: 0.2, weight: "thick", dash: "dashed" }])
    const { sch, notes } = await schOf(p)
    expect(sch).not.toContain("(radius 2.54)")
    expect(kicad9SheetProblems(sch)).toEqual([])
    expect(nodes(sch, "rectangle")).toHaveLength(0)
    expect(nodes(sch, "polyline")).toHaveLength(4)
    expect(nodes(sch, "arc")).toHaveLength(4)
    expect(notes.join(" ")).toMatch(/no rounded rectangle/)
    // the outline closes: each line ends where an arc starts or ends, within a micrometre
    const pt = (n: unknown[] | undefined, i = 1) => [Number((n![i] as unknown[])[1]), Number((n![i] as unknown[])[2])]
    const at = (n: unknown[] | undefined) => [Number(n![1]), Number(n![2])]
    const ends: number[][] = []
    for (const l of nodes(sch, "polyline")) {
      const pts = kid(l, "pts")!
      ends.push(pt(pts, 1), pt(pts, 2))
    }
    for (const a of nodes(sch, "arc")) {
      const [s, e] = [at(kid(a, "start")), at(kid(a, "end"))]
      for (const q of [s, e]) expect(ends.some((x) => Math.hypot(x[0] - q[0], x[1] - q[1]) < 1e-3)).toBe(true)
      // the arc's radius is the rectangle's: 0.2 units of 12.7 mm
      const m = at(kid(a, "mid"))
      const c = [(s[0] + e[0]) / 2, (s[1] + e[1]) / 2]
      expect(Math.hypot(m[0] - c[0], m[1] - c[1])).toBeCloseTo(2.54 * (1 - Math.SQRT1_2), 2)
      expect(kid(a, "stroke")!.join(" ")).toMatch(/type,dash/)
    }
  })

  it("keeps a fill as a polygon behind the outline and says so", async () => {
    const base = imp(sheet([]))
    const p = withDrawings(base, [{ id: "d1", type: "rect", x: 1, y: 1, width: 2, height: 1, radius: 0.2, fill: "blue" }])
    const { sch, notes } = await schOf(p)
    expect(kicad9SheetProblems(sch)).toEqual([])
    const filled = nodes(sch, "polyline").filter((n) => kid(kid(n, "fill")!, "type")![1] === "color")
    expect(filled).toHaveLength(1)
    expect(kid(filled[0], "pts")!.length).toBeGreaterThan(60)
    expect(notes.join(" ")).toMatch(/fill as a polygon/)
  })

  it("a KiCad 10 rounded rectangle carried through an import is written the same way, and reads back", async () => {
    const p = imp(sheet([`(rectangle (start 20 20) (end 40 30) (radius 2.54) (stroke (width 0.254) (type dot) (color 255 0 0 1)) (fill (type color) (color 0 255 0 1)) (uuid r10))`], 20250829))
    expect(p.drawings?.some((d) => d.type === "rect" && d.radius)).toBe(true)
    const { sch } = await schOf(p)
    expect(kicad9SheetProblems(sch)).toEqual([])
    expect(sch).not.toMatch(/\(radius 2\.54\)/)
    expect(nodes(sch, "arc")).toHaveLength(4)
    expect(importKicadSchematic(sch).status).toBe("imported")
  })

  it("a radius bigger than half the shorter side is clamped, and a flat rectangle stays a rectangle", async () => {
    const base = imp(sheet([]))
    const p = withDrawings(base, [
      { id: "a", type: "rect", x: 1, y: 1, width: 2, height: 0.2, radius: 5 },
      { id: "b", type: "rect", x: 1, y: 3, width: 2, height: 0, radius: 0.3 },
    ])
    const { sch } = await schOf(p)
    expect(kicad9SheetProblems(sch)).toEqual([])
    expect(nodes(sch, "rectangle")).toHaveLength(1)
    expect(nodes(sch, "arc")).toHaveLength(4)
  })
})

describe("B6: a turned text with a border", () => {
  // KiCad 9 stores a text box as the box it draws (start and size in page space) and the text's angle apart
  // (parseSchTextBoxContent: `at` is start plus angle, `size` is end minus start; SCH_TEXTBOX::GetDrawPos puts
  // a turned text's start at the box's bottom-left plus the margins, for justify left top). So the box is the
  // turned frame, written with 90, and the text starts where the same text without a border starts.
  for (const rot of [0, 90] as const) {
    it(`rot ${rot}: the box carries the angle and the text starts where a plain text of it would`, async () => {
      const base = imp(sheet([]))
      const text = { type: "text" as const, x: 2, y: 3, text: "Turned\nnote", size: 0.1, rot }
      const { sch } = await schOf(withDrawings(base, [{ ...text, id: "a", border: true }, { ...text, id: "b" }]))
      const box = nodes(sch, "text_box")[0]
      const plain = nodes(sch, "text").find((n) => n[1] === "Turned\nnote")!
      const at = kid(box, "at")!
      expect(Number(at[3])).toBe(rot)
      const [sx, sy] = [Number(at[1]), Number(at[2])]
      const size = kid(box, "size")!
      const [w, h] = [Number(size[1]), Number(size[2])]
      // a turned text is taller than wide, an unturned one wider than tall
      expect(w > h).toBe(rot === 0)
      const m = kid(box, "margins")!.slice(1).map(Number)
      const [left, top, bottom] = [Math.min(sx, sx + w), Math.min(sy, sy + h), Math.max(sy, sy + h)]
      const draw = rot === 90 ? [left + m[0], bottom - m[3]] : [left + m[0], top + m[1]]
      const pat = kid(plain, "at")!
      expect(Math.abs(draw[0] - Number(pat[1]))).toBeLessThan(1e-3)
      expect(Math.abs(draw[1] - Number(pat[2]))).toBeLessThan(1e-3)
      expect(Number(pat[3])).toBe(rot)
      expect(kicad9SheetProblems(sch)).toEqual([])
    })
  }
})

describe("m2: ink is written as KiCad's default colour", () => {
  it("writes no colour for ink and a colour for a named one", async () => {
    const base = imp(sheet([]))
    const { sch } = await schOf(
      withDrawings(base, [
        { id: "l1", type: "line", points: [{ x: 1, y: 1 }, { x: 2, y: 1 }], arrows: "end" },
        { id: "l2", type: "line", points: [{ x: 1, y: 2 }, { x: 2, y: 2 }], color: "red" },
        { id: "t1", type: "text", x: 1, y: 3, text: "ink", size: 0.1 },
        { id: "t2", type: "text", x: 1, y: 4, text: "red", size: 0.1, color: "red" },
      ]),
    )
    const colorOf = (n: unknown[]) => kid(kid(n, "stroke") ?? [], "color")
    const lines = nodes(sch, "polyline")
    expect(lines.length).toBe(3)
    expect(colorOf(lines[0])).toBeUndefined()
    expect(colorOf(lines[1])).toBeUndefined()
    expect(colorOf(lines[2])).toBeDefined()
    // the arrowhead of an ink line is filled with the line's own colour, not a fixed near-black
    expect(kid(kid(lines[1], "fill")!, "type")![1]).toBe("outline")
    expect(sch).not.toContain("(color 36 33 28 1)")
    const texts = nodes(sch, "text")
    const fontColor = (n: unknown[]) => kid(kid(kid(n, "effects")!, "font")!, "color")
    expect(fontColor(texts.find((n) => n[1] === "ink")!)).toBeUndefined()
    expect(fontColor(texts.find((n) => n[1] === "red")!)).toBeDefined()
  })
})
