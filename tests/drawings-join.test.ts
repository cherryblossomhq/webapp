import { describe, expect, it } from "vitest"
import { runTool } from "../src/ai/tools"
import { schematicContent } from "../src/ai/vision/framing"
import { measureSchematic } from "../src/ai/vision/measure"
import { schematicSvg } from "../src/ai/vision/schematicSvg"
import { paintDrawing } from "../src/editor/schematic/drawingPaint"
import { SCH_LIGHT } from "../src/editor/theme"
import { circuitJsonFile } from "../src/export/circuitJson"
import { kicadFiles } from "../src/export/kicad"
import { addDrawings, applyStyle, clean, drawingBounds, hitDrawing, moveDrawing, updateDrawings } from "../src/model/drawings"
import { EXAMPLES } from "../src/model/examples"
import { createProject } from "../src/model/ops"
import { parseProjectFile, serializeProject } from "../src/model/projectFile"
import { importKicadSchematic } from "../src/model/kicad/schematic"
import { isExact, isKicadOnly, kicadText } from "../src/model/sheetItems"
import { tidySchematic } from "../src/model/tidy"
import type { DrawingLine, Project, SchematicDrawing } from "../src/model/types"
import { divider } from "./kicad-schematic-fixtures"

// The one model of the sheet's drawings: what the drawing tools make and what a KiCad sheet draws are one
// list. The drawing tools and Sakura's keep working as they did (`drawings.test.ts` and the golden outputs
// say so); this is about the two meeting: the exact look, the kinds only KiCad has, what is painted, written
// and left out, and what Tidy leaves where it is.

const origin = { id: "p_join" }
const blinker = () => EXAMPLES.find((e) => e.id === "blinker")!.project

const toolLine = (extra: Partial<DrawingLine> = {}): Parameters<typeof addDrawings>[1][number] => ({ type: "line", points: [{ x: 0, y: 0 }, { x: 2, y: 0 }], color: "red", ...extra })
const kicadLine = (): Parameters<typeof addDrawings>[1][number] => ({ type: "line", points: [{ x: 0, y: 2 }, { x: 2, y: 2 }], stroke: { width: 0.02, color: "#112233", dash: "dash" } })

describe("the exact look and the editor's styles", () => {
  it("a drawing from a KiCad sheet keeps what the file said; styling it in the editor replaces that look, and a tool-made one is styled as ever", () => {
    const { added } = addDrawings(createProject("d"), [toolLine(), kicadLine()])
    const [tool, kicad] = added as DrawingLine[]
    expect(isExact(tool)).toBe(false)
    expect(isExact(kicad)).toBe(true)
    expect(applyStyle(tool, { color: "blue" })).toMatchObject({ color: "blue" })
    // a colour changes the stroke's colour and nothing else of the file's look: the width and the dash stay (and so does the drawing's exactness, so the KiCad export writes it as it is)
    const restyled = applyStyle(kicad, { color: "green" }) as DrawingLine
    expect(restyled.stroke).toEqual({ width: 0.02, color: SCH_LIGHT.drawing.green, dash: "dash" })
    expect(restyled.color).toBeUndefined()
    expect(isExact(restyled)).toBe(true)
    // a fill replaces the file's fill, nothing else
    const closed = { ...kicad, points: [...kicad.points, { x: 1, y: 3 }], closed: true as const }
    const filled = applyStyle({ ...closed, paint: { kind: "background" as const } }, { fill: "blue" }) as DrawingLine
    expect(filled.paint).toEqual({ kind: "color", color: "rgba(58,81,194,0.13)" })
    expect(filled.stroke).toEqual(kicad.stroke)
    // an open line takes no fill: asking for one only clears the file's
    expect((applyStyle({ ...kicad, paint: { kind: "background" as const } }, { fill: "blue" }) as DrawingLine).paint).toBeUndefined()
  })

  it("an empty stroke says KiCad's own line: 6 mil wide in wire blue; a named look is the editor's medium ink", () => {
    const { added } = addDrawings(createProject("d"), [{ type: "line", points: [{ x: 0, y: 0 }, { x: 1, y: 0 }], stroke: {} }, { type: "line", points: [{ x: 0, y: 0 }, { x: 1, y: 0 }] }])
    const [kicad, tool] = added.map((d) => paintDrawing(d, SCH_LIGHT, 0.001)[0].attrs)
    expect(kicad).toMatchObject({ stroke: SCH_LIGHT.wire, strokeWidth: 0.012 })
    expect(tool).toMatchObject({ stroke: SCH_LIGHT.drawing.ink, strokeWidth: 0.022 })
  })

  it("cleans a tool-made drawing to four digits and a KiCad one to six, and keeps a KiCad text's left alignment", () => {
    expect(clean({ id: "a", type: "rect", x: 0.1234567, y: 0, width: 1, height: 1 }).x).toBe(0.1235)
    expect(clean({ id: "b", type: "rect", x: 0.1234567, y: 0, width: 1, height: 1, stroke: {} }).x).toBe(0.123457)
    const left = kicadText("t", "x", { x: 0, y: 0 }, 0, { h: "left" })
    expect(clean(left).align).toBe("left")
    expect(clean({ id: "u", type: "text", text: "x", x: 0, y: 0, size: 0.14, align: "left" })).not.toHaveProperty("align")
  })

  it("moves a tool-made drawing to four digits and a KiCad one to a millionth", () => {
    const tool = moveDrawing({ id: "a", type: "rect", x: 0, y: 0, width: 1, height: 1 }, { x: 0.1234567, y: 0 }) as { x: number }
    const kicad = moveDrawing({ id: "b", type: "rect", x: 0, y: 0, width: 1, height: 1, stroke: {} }, { x: 0.1234567, y: 0 }) as { x: number }
    expect([tool.x, kicad.x]).toEqual([0.1235, 0.123457])
  })
})

describe("the kinds only a KiCad sheet has", () => {
  const sheet = (): Project => {
    const { project } = addDrawings(createProject("d"), [
      { type: "circle", x: 1, y: 1, radius: 0.5 },
      { type: "arc", start: { x: 0, y: 0 }, mid: { x: 1, y: 1 }, end: { x: 2, y: 0 } },
      { type: "bezier", points: [{ x: 0, y: 0 }, { x: 1, y: 2 }, { x: 2, y: 2 }, { x: 3, y: 0 }] },
      { type: "textbox", text: "hello", x: 0, y: 0, w: 2, h: 1, rot: 0, paint: { kind: "color", color: "#ffff00" } },
      { type: "table", columns: 1, columnWidths: [1], rowHeights: [0.5], cells: [{ text: "A", x: 0, y: 0, w: 1, h: 0.5, rot: 0, colSpan: 1, rowSpan: 1 }], border: { external: true, header: false }, separators: { rows: false, cols: false } },
      { type: "image", x: 5, y: 5, scale: 1, data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==" },
      { type: "junction", x: 2, y: 2, diameter: 0.1, dotColor: "#00ff00" },
      { type: "noconnect", x: 3, y: 3 },
    ])
    return project
  }

  it("each has a box, a hit test, a move and a paint", () => {
    const p = sheet()
    for (const d of p.drawings!) {
      expect(isKicadOnly(d), d.type).toBe(true)
      const b = drawingBounds(d)
      expect(b.maxX, d.type).toBeGreaterThan(b.minX)
      expect(paintDrawing(d, SCH_LIGHT, 0.01).length, d.type).toBeGreaterThan(0)
      const moved = moveDrawing(d, { x: 1, y: -1 })
      const mb = drawingBounds(moved)
      expect(Math.abs(mb.minX - b.minX - 1), d.type).toBeLessThan(1e-9)
      expect(Math.abs(mb.minY - b.minY + 1), d.type).toBeLessThan(1e-9)
    }
    expect(hitDrawing(p.drawings![0], { x: 1.5, y: 1 }, 0.05)).toBe(true)
    expect(hitDrawing(p.drawings![0], { x: 1, y: 1 }, 0.05)).toBe(false)
    expect(hitDrawing(p.drawings![3], { x: 1, y: -0.5 }, 0.05)).toBe(true)
    expect(hitDrawing(p.drawings![7], { x: 3, y: 3 }, 0.05)).toBe(true)
  })

  it("paints a table's cells and lines, a picture as an image and a text box's text where KiCad anchors it", () => {
    const p = sheet()
    const tags = (type: string) => paintDrawing(p.drawings!.find((d) => d.type === type)!, SCH_LIGHT, 0.01).map((n) => n.tag)
    expect(tags("table")).toEqual(["ktext", "line", "line", "line", "line"])
    expect(tags("image")).toEqual(["image"])
    expect(tags("textbox")).toEqual(["polygon", "ktext"])
    expect(tags("junction")).toEqual(["circle"])
  })

  it("is read from a file, saved and loaded, and a damaged one is dropped", () => {
    const p = sheet()
    const back = parseProjectFile(serializeProject(p), origin)
    expect(back.drawings).toEqual(p.drawings)
    const broken = JSON.parse(serializeProject(p))
    broken.project.drawings.push({ id: "x", type: "table", columns: 1, columnWidths: [1], rowHeights: [1], cells: [{ text: 5 }] }, { id: "y", type: "bezier", points: [{ x: 1, y: 2 }] })
    expect(parseProjectFile(broken, origin).drawings).toEqual(p.drawings)
  })

  it("Sakura reads them in get_design, the first hundred when there are many, and counts the rest", () => {
    const dots = Array.from({ length: 60 }, (_, i) => ({ type: "junction" as const, x: i, y: 0 }))
    const lines = Array.from({ length: 120 }, (_, i) => ({ type: "line" as const, points: [{ x: 0, y: i }, { x: 1, y: i }], stroke: {} }))
    const { project } = addDrawings(createProject("many"), [...dots, ...lines])
    const design = JSON.parse(runTool(project, "get_design", {}).result) as { drawings: { type: string }[]; drawings_more?: string }
    expect(design.drawings).toHaveLength(100)
    expect(design.drawings.every((d) => d.type === "line")).toBe(true)
    expect(design.drawings_more).toBe("and 80 more: 20 line, 60 junction")
    const few = JSON.parse(runTool(sheet(), "get_design", {}).result) as { drawings: { type: string }[]; drawings_more?: string }
    expect(few.drawings.map((d) => d.type)).toEqual(["circle", "arc", "bezier", "textbox", "table", "image", "junction", "noconnect"])
    expect(few.drawings_more).toBeUndefined()
  })

  it("Sakura's edit_drawings moves and deletes them, and ignores a style on them", () => {
    const p = sheet()
    const circle = p.drawings![0]
    const moved = runTool(p, "edit_drawings", { ids: [circle.id], move_by: { x: 1, y: 0 }, color: "red" })
    expect(moved.isError).toBe(false)
    expect(moved.project.drawings![0]).toMatchObject({ type: "circle", x: 2, y: 1 })
    expect(moved.project.drawings![0]).not.toHaveProperty("color")
    expect(runTool(p, "edit_drawings", { ids: [circle.id], remove: true }).project.drawings).toHaveLength(7)
  })

  it("a stray no-connect flag is found by Checks as before, now from the drawings", () => {
    const p = sheet()
    expect(runTool(p, "run_checks", {}).result).toMatch(/no-connect flag at \(3, 3\)/)
  })
})

describe("what is painted for Sakura", () => {
  const withNote = (): Project => addDrawings(blinker(), [toolLine({ points: [{ x: 0, y: -6 }, { x: 2, y: -6 }] }), { type: "circle", x: 3, y: -6, radius: 0.4, stroke: { color: "#ff0000" } }]).project

  it("one paint is the editor's and the picture's: a KiCad circle is a circle in its own colour, a tool line is as it was", () => {
    const p = withNote()
    const box = schematicContent(p)!
    const svg = schematicSvg(p, box, { width: 1200, height: 800 }, measureSchematic(p))
    expect(svg).toContain('stroke="#ff0000"')
    expect(svg).toMatch(/<circle cx="3" cy="-6" r="0.4"/)
    expect(svg).toContain(`stroke="${SCH_LIGHT.drawing.red}"`)
  })
})

describe("the exports", () => {
  const withDrawings = (): Project =>
    addDrawings(blinker(), [
      { type: "text", text: "Power", x: 1, y: -7, size: 0.2, bold: true, color: "red" },
      { type: "text", text: "Boxed", x: 4, y: -7, size: 0.14, border: true, fill: "blue" },
      { type: "line", points: [{ x: 0, y: -8 }, { x: 3, y: -8 }], arrows: "end", color: "green", weight: "thick", dash: "dashed" },
      { type: "rect", x: 0, y: -9.5, width: 2, height: 1, fill: "yellow", radius: 0.1 },
      { type: "circle", x: 6, y: -8, radius: 0.5, stroke: { width: 0.03, color: "#0000ff" } },
    ]).project

  it("the KiCad export writes every drawing: the tools' with exact strokes, the arrowhead as a triangle, a bordered text as a text box", async () => {
    const { files, notes } = await kicadFiles(withDrawings())
    const sch = Object.entries(files).find(([k]) => k.endsWith(".kicad_sch"))![1]
    expect(sch).toMatch(/\(text "Power"[\s\S]*?\(justify left top\)/)
    expect(sch).toMatch(/\(text_box "Boxed"/)
    // the line, its arrowhead, and the rounded rectangle as KiCad 9 reads it: four lines and four arcs, and its fill as a polygon behind them (no radius, which KiCad 9 does not read)
    expect((sch.match(/\n {2}\(polyline\n/g) ?? []).length).toBe(7)
    expect((sch.match(/\n {2}\(arc\n/g) ?? []).length).toBe(4)
    expect(sch).not.toMatch(/\(rectangle|\(radius 1\.27\)/)
    expect(sch).toMatch(/\(circle\n[\s\S]*?\(color 0 0 255 1\)/)
    expect(sch).toMatch(/\(stroke \(width [\d.]+\) \(type dash\) \(color 31 127 67 1\)\)/)
    expect(notes.join(" ")).toMatch(/no arrowheads/)
    expect(notes.join(" ")).not.toMatch(/left out/)
  })

  it("what the KiCad export wrote of the drawings reads back as drawings", async () => {
    const { files } = await kicadFiles(withDrawings())
    const sch = Object.entries(files).find(([k]) => k.endsWith(".kicad_sch"))![1]
    const back = importKicadSchematic(sch)
    expect(back.status).toBe("imported")
    if (back.status !== "imported") return
    const types = back.project.drawings?.map((d) => d.type).sort()
    // the rounded rectangle is its eight pieces and a fill polygon now (KiCad 9 has no rounded rectangle)
    expect(types).toEqual(["arc", "arc", "arc", "arc", "circle", ...Array(7).fill("line"), "text", "textbox"].sort())
  })

  it("Circuit JSON still leaves out the drawings the tools made, and says so, and writes the ones a KiCad sheet drew", () => {
    const p = withDrawings()
    const file = circuitJsonFile(p)
    expect(file.notes.join(" ")).toMatch(/drawings \(texts, lines and shapes\) are left out/)
    const elements = JSON.parse(file.text) as { type: string }[]
    // only the circle (a KiCad look) is in the file
    expect(elements.filter((e) => e.type === "schematic_circle")).toHaveLength(1)
    expect(elements.filter((e) => e.type === "schematic_text" && (e as { text?: string }).text === "Power")).toHaveLength(0)
  })

  it("a project with no drawings writes none, in either export", async () => {
    const { files } = await kicadFiles(blinker())
    const sch = Object.entries(files).find(([k]) => k.endsWith(".kicad_sch"))![1]
    // at the sheet's own level (two spaces), not in the symbols' drawings
    expect(sch).not.toMatch(/\n {2}\((polyline|rectangle|circle|text_box|table|image)\n/)
    expect(sch).not.toMatch(/\n {2}\(text "/)
  })
})

describe("Tidy", () => {
  const imported = () => {
    const r = importKicadSchematic(divider())
    if (r.status !== "imported") throw new Error("refused")
    return r.project
  }

  it("a note the drawing tools made and a shape a KiCad sheet gave, both under the sheet's parts, are treated each its way", () => {
    const base = imported()
    // under R1's place: a KiCad note stays and the tidied blocks go clear of it
    const note = { type: "textbox" as const, text: "keep clear", x: 3, y: -3, w: 6, h: 6, rot: 0 as const }
    const withKicad = addDrawings(base, [note]).project
    const tidied = tidySchematic(withKicad)
    expect(tidied.ok).toBe(true)
    expect(tidied.project.drawings!.find((d) => d.type === "textbox")).toEqual(withKicad.drawings![0])
    const placed = tidied.project.components.filter((c) => !c.ref.startsWith("#"))
    const box = drawingBounds(withKicad.drawings![0])
    for (const c of placed) {
      const overlaps = c.sch.x > box.minX && c.sch.x < box.maxX && c.sch.y > box.minY && c.sch.y < box.maxY
      expect(overlaps, c.ref).toBe(false)
    }
  })

  it("a tool-made drawing is not an obstacle: Tidy lays the sheet out as if it were not there, and keeps it where it is", () => {
    const base = imported()
    const without = tidySchematic(base)
    const withTool = tidySchematic(addDrawings(base, [{ type: "rect", x: 3, y: -3, width: 6, height: 6 }]).project)
    expect(withTool.project.components.map((c) => [c.ref, c.sch])).toEqual(without.project.components.map((c) => [c.ref, c.sch]))
  })

  it("keeps the drawings of the sheet as they are, and a junction dot of its own that no wire meets any more is dropped", () => {
    const base = imported()
    const dots = addDrawings(base, [{ type: "junction", x: 500, y: 500, diameter: 0.1 }, { type: "noconnect", x: 501, y: 500 }]).project
    const tidied = tidySchematic(dots)
    expect(tidied.project.drawings?.map((d) => d.type)).toEqual(["noconnect"])
  })
})

describe("the migration of the old items keeps drawings safe", () => {
  it("a tool-made drawing in any older version is as it was", () => {
    const doc = JSON.parse(serializeProject({ ...createProject("old"), drawings: [{ id: "d1", type: "text", text: "Mine", x: 1, y: 2, size: 0.14, align: "left" as const }] as SchematicDrawing[] }))
    for (const version of [2, 3]) {
      doc.version = version
      expect(parseProjectFile(doc, origin).drawings).toEqual([{ id: "d1", type: "text", text: "Mine", x: 1, y: 2, size: 0.14 }])
    }
  })

  it("updateDrawings is the one way to change a drawing: unchanged is the same project", () => {
    const { project } = addDrawings(createProject("d"), [toolLine()])
    expect(updateDrawings(project, [project.drawings![0]?.id ?? "x"], (d) => d)).toBe(project)
  })
})
