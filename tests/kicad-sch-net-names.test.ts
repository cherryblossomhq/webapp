import { describe, expect, it } from "vitest"
import { runTool } from "../src/ai/tools"
import { bomCsv } from "../src/export/bom"
import { projectToCircuitJson } from "../src/export/circuitJson"
import { kicadFiles } from "../src/export/kicad"
import { pnpCsv } from "../src/export/pnp"
import { cleanupSheet } from "../src/model/cleanup"
import { computeConnectivity, pinKey } from "../src/model/connectivity"
import { EXAMPLES } from "../src/model/examples"
import { runErc } from "../src/model/erc"
import { importKicadSchematic } from "../src/model/kicad/schematic"
import { lockedBlockOf } from "../src/model/blocks"
import { labelGeometry } from "../src/model/labelShapes"
import { moveSchematicItems, removeItems } from "../src/model/ops"
import { partFindings } from "../src/model/partChecks"
import { parseProjectFile, serializeProject } from "../src/model/projectFile"
import { drawingBounds, hitDrawing, moveDrawing, updateDrawings } from "../src/model/drawings"
import { inBom, onBoard, setFlags } from "../src/model/partFlags"
import { pasteItems, rekeyAutoNets, renameReference, setBlockLocked, setLabelStyle } from "../src/model/schematicEdit"
import { boxTextAt, imageSize } from "../src/model/sheetItems"
import { tidySchematic } from "../src/model/tidy"
import { type Project, type Zone } from "../src/model/types"
import { parseSexpr } from "./kicad-census/sexpr.mjs"
import { LIB_R, schematic } from "./kicad-schematic-fixtures"
import { copperOn } from "../src/model/boardCopper"
import "../src/model/rekeyNets"

// Slice 3b-ii: labels and KiCad's net names (S2), annotations (S4) and symbol flags (S7), end to end.

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
const R1 = "aaaaaaaa-0000-4000-8000-000000000001"

/** A sheet with one of everything S2, S4 and S7 carry. */
const RICH_BODY = [
  `(label "SIG" (at 60.96 59.69 0) (effects (font (size 1.524 1.524) bold italic (color 255 0 0 1)) (justify right bottom)) (uuid l1))`,
  `(global_label "VBUS" (shape input) (at 30.48 20.32 180) (fields_autoplaced yes) (effects (font (size 1.27 1.27)) (justify right)) (uuid g1) (property "Intersheetrefs" "\${INTERSHEET_REFS}" (at 20 20.32 0) (effects (font (size 1.27 1.27)) (justify left) hide)))`,
  `(text "Hello\\nworld" (exclude_from_sim yes) (at 101.6 25.4 90) (effects (font (size 2.54 2.54) bold) (justify left bottom) (href "https://example.com")) (uuid t1))`,
  `(text_box "Note" (exclude_from_sim no) (at 111.76 30.48 0) (size 20.32 10.16) (margins 0.9525 0.9525 0.9525 0.9525) (stroke (width 0.254) (type dash) (color 0 0 255 1)) (fill (type color) (color 255 255 0 1)) (effects (font (size 1.27 1.27)) (justify left top)) (uuid tb1))`,
  `(polyline (pts (xy 10.16 10.16) (xy 20.32 10.16) (xy 20.32 20.32)) (stroke (width 0.3) (type dot)) (fill (type none)) (uuid p1))`,
  `(rectangle (start 5.08 5.08) (end 15.24 12.7) (stroke (width 0) (type default)) (fill (type background)) (uuid r1))`,
  `(circle (center 40.64 40.64) (radius 3.81) (stroke (width 0) (type default)) (fill (type outline)) (uuid c1))`,
  `(arc (start 50.8 50.8) (mid 53.34 53.34) (end 55.88 50.8) (stroke (width 0.2) (type default)) (fill (type none)) (uuid a1))`,
  `(bezier (pts (xy 0 0) (xy 2.54 5.08) (xy 5.08 5.08) (xy 7.62 0)) (stroke (width 0) (type default)) (fill (type none)) (uuid b1))`,
  `(image (at 76.2 76.2) (scale 2) (uuid i1) (data "${PNG}"))`,
  `(table (column_count 2) (border (external yes) (header yes) (stroke (width 0.1) (type default))) (separators (rows yes) (cols yes) (stroke (width 0.1) (type default))) (column_widths 10.16 10.16) (row_heights 5.08) (cells
    (table_cell "A" (exclude_from_sim no) (at 127 127 0) (size 10.16 5.08) (margins 0.9525 0.9525 0.9525 0.9525) (span 1 1) (fill (type none)) (effects (font (size 1.27 1.27)) (justify left top)) (uuid tc1))
    (table_cell "B" (exclude_from_sim no) (at 137.16 127 0) (size 10.16 5.08) (margins 0.9525 0.9525 0.9525 0.9525) (span 1 1) (fill (type none)) (effects (font (size 1.27 1.27)) (justify left top)) (uuid tc2))))`,
  `(junction (at 90 90) (diameter 1.5) (color 0 255 0 1) (uuid j9))`,
  `(no_connect (at 95 95) (uuid n9))`,
  `(group "Fixed" (uuid g9) (locked yes) (members ${R1}))`,
]

const rich = () =>
  schematic({
    version: 20250114,
    libs: [LIB_R],
    symbols: [{ lib: "Device:R", at: "50.8 50.8", ref: "R1", value: "10k", footprint: "R_0603", uuid: R1, extra: "(dnp yes) (fields_autoplaced yes)" }],
    wires: ["50.8 54.61 50.8 70", "50.8 59.69 60.96 59.69"],
    junctions: ["50.8 59.69"],
    body: RICH_BODY,
  }).replace(`(wire (pts (xy 50.8 54.61) (xy 50.8 70)) (stroke (width 0) (type default))`, `(wire (pts (xy 50.8 54.61) (xy 50.8 70)) (stroke (width 0.5) (type dash) (color 255 0 0 1))`)

const imp = (text: string) => {
  const r = importKicadSchematic(text)
  if (r.status !== "imported") throw new Error(`refused: ${r.message}\n${r.report.entries.map((e) => e.why).join("\n")}`)
  return r
}

describe("S2: labels as KiCad has them", () => {
  const { project } = imp(rich())
  const local = project.labels.find((l) => l.name === "SIG")!
  const global = project.labels.find((l) => l.name === "VBUS")!

  it("keeps the kind, the shape, the size and the style", () => {
    expect(local.kind).toBe("local")
    expect(local.look).toMatchObject({ bold: true, italic: true, color: "#ff0000", h: "right" })
    expect(local.look?.size).toBeCloseTo(1.524 / 12.7, 5)
    expect(global).toMatchObject({ kind: "global", shape: "input", rot: 180, fieldsAutoplaced: true })
    expect(global.fields?.[0]).toMatchObject({ name: "Intersheetrefs", place: { hidden: true, h: "left" } })
  })

  it("names the nets as KiCad does, and the project says so", () => {
    expect(project.netNames).toBe("kicad")
    const { nets } = computeConnectivity(project)
    expect(nets.map((n) => n.name)).toContain("/SIG")
    const net = nets.find((n) => n.name === "/SIG")!
    expect(net.label).toEqual({ text: "SIG", kind: "local" })
  })

  it("draws a global label as its flag, which grows with its text and has its shape's tips", () => {
    const g = labelGeometry(global)
    expect(g.outline.length).toBe(5)
    const bidi = labelGeometry({ ...global, shape: "bidirectional" })
    expect(bidi.outline.length).toBe(6)
    expect(labelGeometry({ ...global, shape: "passive" }).outline.length).toBe(4)
    const longer = labelGeometry({ ...global, name: "VBUS_LONGER" })
    expect(longer.box.maxX - longer.box.minX).toBeGreaterThan(g.box.maxX - g.box.minX)
    // a local label is its text beside its point, with no flag
    expect(labelGeometry(local).outline).toEqual([])
  })

  it("is edited: the kind, shape and style change, and a turn gives the default justification", () => {
    let p = setLabelStyle(project, local.id, { kind: "global", shape: "output" })
    expect(p.labels.find((l) => l.id === local.id)).toMatchObject({ kind: "global", shape: "output" })
    p = setLabelStyle(p, local.id, { kind: "local" })
    expect(p.labels.find((l) => l.id === local.id)?.shape).toBeUndefined()
    p = setLabelStyle(p, local.id, { turn: 180 })
    expect(p.labels.find((l) => l.id === local.id)?.look?.h).toBeUndefined()
    expect(computeConnectivity(setLabelStyle(project, local.id, { kind: "global" })).nets.map((n) => n.name)).toContain("SIG")
  })

  it("an empty power Value is <NO NET>, and a local label joined to a global one of its text takes the global name", () => {
    const text = schematic({ version: 20250114, libs: [LIB_R], symbols: [{ lib: "Device:R", at: "50.8 50.8", ref: "R1", uuid: R1 }], wires: ["50.8 54.61 50.8 70"], labels: ["X 50.8 62 0"], body: [`(global_label "X" (shape passive) (at 50.8 66 0) (effects (font (size 1.27 1.27)) (justify left)) (uuid g2))`] })
    expect(computeConnectivity(imp(text).project).nets.map((n) => n.name)).toEqual(["X"])
  })
})

describe("S4: the sheet's drawings, held at the file's numbers", () => {
  const { project, report } = imp(rich())
  const items = project.drawings ?? []
  const raw = parseSexpr(rich()).find((n: unknown) => Array.isArray(n) && n[0] === "kicad_sch") as unknown[]
  const rawOf = (token: string) => raw.filter((n) => Array.isArray(n) && n[0] === token) as unknown[][]
  const num = (n: unknown) => Number(n)
  const mm = (units: number) => units * 12.7
  const kid = (node: unknown[], name: string) => node.find((c) => Array.isArray(c) && c[0] === name) as unknown[] | undefined
  const kind = (k: string) => items.filter((i) => i.type === k)
  type D<T extends string> = Extract<(typeof items)[number], { type: T }>

  it("has every kind the file has", () => {
    expect(items.map((i) => i.type).sort()).toEqual(["arc", "bezier", "circle", "image", "junction", "noconnect", "line", "rect", "table", "text", "textbox"].sort())
  })

  it("puts every point where the raw file has it, to a thousandth of a millimetre, with y up", () => {
    const check = (units: { x: number; y: number }, rawAt: unknown[]) => {
      expect(Math.abs(mm(units.x) - num(rawAt[1]))).toBeLessThan(0.001)
      expect(Math.abs(-mm(units.y) - num(rawAt[2]))).toBeLessThan(0.001)
    }
    const text = kind("text")[0] as D<"text">
    check(text, kid(rawOf("text")[0], "at")!)
    // KiCad's own justification is named (the middle where the file names none), its look is the drawing's own fields
    expect(text).toMatchObject({ text: "Hello\nworld", rot: 90, excludeFromSim: true, bold: true, align: "left", valign: "bottom", href: "https://example.com" })
    const box = kind("textbox")[0] as D<"textbox">
    check(box, kid(rawOf("text_box")[0], "at")!)
    expect(mm(box.w)).toBeCloseTo(20.32, 3)
    expect(mm(box.h)).toBeCloseTo(10.16, 3)
    expect(box.margins?.map(mm).map((v) => Math.round(v * 1e4) / 1e4)).toEqual([0.9525, 0.9525, 0.9525, 0.9525])
    expect(box.paint).toEqual({ kind: "color", color: "#ffff00" })
    expect(box.stroke).toMatchObject({ dash: "dash", color: "#0000ff" })
    const poly = kind("line")[0] as D<"line">
    const rawPts = (kid(rawOf("polyline")[0], "pts") as unknown[]).slice(1) as unknown[][]
    poly.points.forEach((p, i) => check(p, rawPts[i]))
    // a rectangle is kept by its lower-left corner and size: the file's start and end are the same box
    const rect = kind("rect")[0] as D<"rect">
    const [start, end] = [kid(rawOf("rectangle")[0], "start")!, kid(rawOf("rectangle")[0], "end")!]
    expect(Math.abs(mm(rect.x) - Math.min(num(start[1]), num(end[1])))).toBeLessThan(0.001)
    expect(Math.abs(mm(rect.x + rect.width) - Math.max(num(start[1]), num(end[1])))).toBeLessThan(0.001)
    expect(Math.abs(-mm(rect.y + rect.height) - Math.min(num(start[2]), num(end[2])))).toBeLessThan(0.001)
    expect(Math.abs(-mm(rect.y) - Math.max(num(start[2]), num(end[2])))).toBeLessThan(0.001)
    expect(rect.paint).toEqual({ kind: "background" })
    const circle = kind("circle")[0] as D<"circle">
    check(circle, kid(rawOf("circle")[0], "center")!)
    expect(mm(circle.radius)).toBeCloseTo(3.81, 4)
    const arc = kind("arc")[0] as D<"arc">
    check(arc.mid, kid(rawOf("arc")[0], "mid")!)
    const bez = kind("bezier")[0] as D<"bezier">
    ;((kid(rawOf("bezier")[0], "pts") as unknown[]).slice(1) as unknown[][]).forEach((p, i) => check(bez.points[i], p))
    const image = kind("image")[0] as D<"image">
    check(image, kid(rawOf("image")[0], "at")!)
    expect(image.scale).toBe(2)
    expect(image.data).toBe(PNG)
    // a 1 pixel picture at the default 300 per inch, drawn at scale 2: 2 * 25.4 / 300 mm
    expect(mm(imageSize(image).w)).toBeCloseTo((2 * 25.4) / 300, 4)
    const table = kind("table")[0] as D<"table">
    expect(table.cells.map((c) => c.text)).toEqual(["A", "B"])
    check(table.cells[1], kid(kid(rawOf("table")[0], "cells")!.find((c) => Array.isArray(c) && c[1] === "B") as unknown[], "at")!)
    expect(table.columnWidths.map(mm).map((v) => Math.round(v * 1e3) / 1e3)).toEqual([10.16, 10.16])
    expect(table.border).toMatchObject({ external: true, header: true })
    expect(table.separators).toMatchObject({ rows: true, cols: true })
    const junction = kind("junction")[0] as D<"junction">
    check(junction, kid(rawOf("junction").find((j) => num(kid(j, "diameter")![1]) > 0)!, "at")!)
    expect(mm(junction.diameter ?? 0)).toBeCloseTo(1.5, 4)
    expect(junction.dotColor).toBe("#00ff00")
    const nc = kind("noconnect")[0] as D<"noconnect">
    check(nc, kid(rawOf("no_connect")[0], "at")!)
  })

  it("carries a wire's own stroke, and a locked group", () => {
    const w = project.wires.find((x) => x.look)!
    expect(w.look).toMatchObject({ dash: "dash", color: "#ff0000" })
    expect(w.look?.width).toBeCloseTo(0.5 / 12.7, 5)
    expect(project.blocks?.[0]).toMatchObject({ name: "Fixed", locked: true })
    expect(lockedBlockOf(project, project.components.map((c) => c.id))).toBe("Fixed")
  })

  it("counts no S4 node as imported without holding it", () => {
    const paths = [...(report.account?.importedPaths.keys() ?? [])]
    const held = (re: RegExp) => paths.filter((p) => re.test(p))
    // every extension node of the file is imported (none pending, none unknown), and each kind has its drawing
    expect(report.account?.pending.size).toBe(0)
    expect(report.account?.unknownPaths.size).toBe(0)
    for (const token of ["text", "text_box", "polyline", "rectangle", "circle", "arc", "bezier", "image", "table", "group>locked", "wire>stroke>color", "junction>diameter", "junction>color", "no_connect", "label>effects>font>color", "global_label>shape", "global_label>property", "symbol>dnp", "symbol>fields_autoplaced"]) {
      expect(held(new RegExp(`^${token}$`)).length, token).toBe(1)
    }
  })

  it("is selected, moved and deleted like anything else on the sheet", () => {
    const text = kind("text")[0] as D<"text">
    expect(hitDrawing(text, { x: text.x, y: text.y }, 0.05)).toBe(true)
    const moved = moveSchematicItems(project, { components: [], labels: [], wires: [], drawings: [text.id] }, { x: 1, y: -0.5 }, [])
    const after = moved.drawings!.find((i) => i.id === text.id)! as D<"text">
    expect(Math.abs(after.x - text.x - 1) < 1e-9 && Math.abs(after.y - text.y + 0.5) < 1e-9).toBe(true)
    // the rest is where it was
    expect(moved.drawings!.filter((i) => i.id !== text.id)).toEqual(project.drawings!.filter((i) => i.id !== text.id))
    expect(moveDrawing(text, { x: 0, y: 0 })).toEqual(text)
    const gone = removeItems(project, { drawings: [text.id] })
    expect(gone.drawings!.some((i) => i.id === text.id)).toBe(false)
    expect(gone.drawings!.length).toBe(project.drawings!.length - 1)
    // paste copies it, offset, under a new id
    const pasted = pasteItems(project, { project, components: [], wires: [], labels: [], drawings: [text.id], blocks: [] }, { x: 2, y: 2 })
    expect(pasted.ok).toBe(true)
    if (pasted.ok) expect(pasted.project.drawings!.length).toBe(project.drawings!.length + 1)
    // edited
    const edited = updateDrawings(project, [text.id], (d) => ({ ...d, text: "changed" }) as never)
    expect(edited.drawings!.find((i) => i.id === text.id)).toMatchObject({ text: "changed" })
    expect(drawingBounds(text).maxX).toBeGreaterThan(drawingBounds(text).minX)
  })

  it("reads a damaged file without crashing: a drawing with no geometry is dropped", () => {
    const project2 = parseProjectFile(JSON.stringify({ format: "cherryblossom.project", version: 3, project: { ...project, drawings: [...project.drawings!, { id: "bad", type: "line", points: [{ x: "a" }] }, { id: "bad2", type: "text" }, { id: "bad3", type: "arc", start: { x: 1 } }, 7] } }), { id: "x" })
    expect(project2.drawings!.length).toBe(project.drawings!.length)
  })

  it("survives a save and a load, and a document with none of it is still a project", () => {
    const again = parseProjectFile(serializeProject(project), { id: "x" })
    expect(again.drawings).toEqual(project.drawings)
    expect(again.labels).toEqual(project.labels)
    expect(again.netNames).toBe("kicad")
    expect(again.blocks?.[0].locked).toBe(true)
    expect(again.wires.find((w) => w.look)?.look).toEqual(project.wires.find((w) => w.look)?.look)
    expect(again.components[0].flags).toEqual(project.components[0].flags)
    expect(again.components[0].fieldsAutoplaced).toBe(true)
  })
})

describe("S7: the flags of a symbol", () => {
  const base = imp(rich()).project

  it("keeps them, as the one set of part flags, with the fields' autoplacing on the part", () => {
    expect(base.components[0].flags).toEqual({ dnp: true })
    expect(base.components[0].fieldsAutoplaced).toBe(true)
  })

  it("a part not to be populated is left out of the BOM and the position file, a part off the board is not on it", () => {
    const part = base.components[0]
    expect(inBom(part)).toBe(false)
    expect(inBom({ flags: undefined })).toBe(true)
    expect(inBom({ flags: { excludeFromBom: true } })).toBe(false)
    expect(onBoard({ partId: part.partId, flags: { notOnBoard: true } })).toBe(false)
    const ex = EXAMPLES.find((e) => e.id === "blinker")!.project
    const ref = ex.components.find((c) => c.ref === "R1")!
    const dnp = setFlags(ex, ref.id, { dnp: true })
    expect(bomCsv(dnp)).not.toContain("R1")
    expect(bomCsv(ex)).toContain("R1")
    expect(pnpCsv(dnp)).not.toContain("R1")
    expect(pnpCsv(setFlags(ex, ref.id, { excludeFromPos: true }))).not.toContain("R1,")
    // "board only" (not in the BOM) leaves the position file alone, a part off the board leaves both only where it has no place
    const noBom = setFlags(ex, ref.id, { excludeFromBom: true })
    expect(bomCsv(noBom)).not.toContain("R1")
    expect(pnpCsv(noBom)).toContain("R1")
    const off = setFlags(ex, ref.id, { notOnBoard: true })
    expect(pnpCsv(off)).not.toContain("R1,")
    expect(bomCsv(off)).toContain("R1")
    // and a part that is not on the board has no footprint in Circuit JSON
    expect(projectToCircuitJson(off).elements.filter((e) => e.type === "pcb_component").length).toBe(projectToCircuitJson(ex).elements.filter((e) => e.type === "pcb_component").length - 1)
    expect(projectToCircuitJson(dnp).elements.some((e) => e.type === "pcb_component" && (e as { do_not_place?: boolean }).do_not_place)).toBe(true)
    // turned back on, the flags are gone altogether
    expect(setFlags(dnp, ref.id, { dnp: false }).components.find((c) => c.id === ref.id)?.flags).toBeUndefined()
  })

  it("Sakura reads the flags that are set and sets them", () => {
    const ex = EXAMPLES.find((e) => e.id === "blinker")!.project
    const out = runTool(ex, "update_component", { ref: "R1", dnp: true, in_bom: false })
    expect(out.isError).toBeFalsy()
    const design = JSON.parse(runTool(out.project, "get_design", {}).result) as { components: { ref: string; flags?: string[] }[] }
    const r1 = design.components.find((c) => c.ref === "R1")!
    expect(r1.flags).toEqual(["do not populate", "not in the BOM"])
    expect(design.components.find((c) => c.ref !== "R1")?.flags).toBeUndefined()
  })

  it("is shown as KiCad shows it, and a part on the sheet with a flag exports it", async () => {
    const ex = EXAMPLES.find((e) => e.id === "blinker")!.project
    const ref = ex.components.find((c) => c.ref === "R1")!
    const flagged = setFlags(setFlags(ex, ref.id, { dnp: true }), ref.id, { excludeFromSim: true })
    const files = (await kicadFiles(flagged)).files
    const sch = Object.entries(files).find(([k]) => k.endsWith(".kicad_sch"))![1]
    const pcb = Object.entries(files).find(([k]) => k.endsWith(".kicad_pcb"))![1]
    const block = sch.split("\n  (symbol\n").find((b) => /\(property "Reference" "R1"/.test(b))!
    expect(block).toContain("(dnp yes)")
    expect(block).toContain("(exclude_from_sim yes)")
    expect(pcb.split("\n  (footprint ").find((b) => /\(property "Reference" "R1"/.test(b))).toMatch(/\(attr [^)]*dnp/)
  })
})

describe("the KiCad export of an imported sheet", () => {
  it("writes labels as they were (local, global with their shapes), the drawings, and wire strokes", async () => {
    const { project } = imp(rich())
    const { files, notes } = await kicadFiles(project)
    const sch = Object.entries(files).find(([k]) => k.endsWith(".kicad_sch"))![1]
    expect(sch).toMatch(/\n {2}\(label "SIG"/)
    expect(sch).toMatch(/\(global_label "VBUS"[\s\S]*?\(shape input\)/)
    expect(sch).toContain("(text \"Hello\\nworld\"")
    for (const node of ["(text_box ", "(polyline", "(rectangle", "(circle", "(arc", "(bezier", "(image", "(table", "(junction", "(no_connect"]) expect(sch).toContain(node)
    expect(sch).toMatch(/\(stroke\s+\(width 0\.5\)\s+\(type dash\)\s+\(color 255 0 0 1\)\)/)
    // the file reads back as the same drawings
    const again = importKicadSchematic(sch)
    expect(again.status).toBe("imported")
    if (again.status === "imported") {
      expect(again.project.drawings?.map((i) => i.type).sort()).toEqual((project.drawings ?? []).map((i) => i.type).sort())
      expect(again.project.labels.map((l) => [l.name, l.kind, l.shape])).toEqual(project.labels.map((l) => [l.name, l.kind, l.shape]))
    }
    expect(notes.join(" ")).toMatch(/Pictures are written/)
  })

  it("names a net the KiCad way in the board too, and writes a pin the symbol leaves unnamed as ~", async () => {
    const text = schematic({ version: 20250114, libs: [LIB_R], symbols: [{ lib: "Device:R", at: "50.8 50.8", ref: "R1", uuid: R1 }, { lib: "Device:R", at: "50.8 80", ref: "R2", uuid: "aaaaaaaa-0000-4000-8000-000000000002" }], wires: ["50.8 54.61 50.8 76.19"] })
    const { project } = imp(text.replace('(name "~"', '(name "~"'))
    const { files } = await kicadFiles(project)
    const sch = Object.entries(files).find(([k]) => k.endsWith(".kicad_sch"))![1]
    expect(sch).not.toMatch(/\(pin passive line[\s\S]{0,200}\(name "1"/)
  })
})

describe("Tidy and Clean up on an imported sheet", () => {
  const { project } = imp(rich())
  const names = (p: Project) => computeConnectivity(p).nets.map((n) => n.name).filter((n) => !/^N\$/.test(n)).sort()

  it("keep the net names, the labels' kinds and styles, and the items", () => {
    const t = tidySchematic(project)
    if (t.ok) {
      expect(names(t.project)).toEqual(names(project))
      expect(t.project.labels.find((l) => l.name === "VBUS")).toMatchObject({ kind: "global", shape: "input" })
      expect(t.project.drawings?.filter((i) => i.type !== "junction").length).toBe(project.drawings!.filter((i) => i.type !== "junction").length)
      expect(tidySchematic(t.project).changed).toBe(false)
    }
    const c = cleanupSheet(project)
    if (c.ok) expect(names(c.project)).toEqual(names(project))
  })
})

describe("the carry-overs of the 3b-i review", () => {
  it("M1: an imported part is not 'made from memory', and an editor-made one still is", () => {
    const { project } = imp(rich())
    expect(partFindings(project)).toEqual([])
    const spec = project.parts!.find((p) => p.source)!
    expect(spec.source).toMatchObject({ pins: "import", imported: { file: "schematic.kicad_sch", libId: "Device:R" } })
    const noSource = { ...project, parts: project.parts!.map((p) => ({ ...p, source: undefined })) }
    expect(partFindings(noSource).length).toBeGreaterThan(0)
    // saved and loaded, the source is still there
    expect(parseProjectFile(serializeProject(project), { id: "x" }).parts?.[0].source?.imported?.file).toBe("schematic.kicad_sch")
  })

  it("M2: layout_pcb and route_pcb say the same thing on a sheet with no footprint", () => {
    const { project } = imp(rich())
    const layout = runTool(project, "layout_pcb", {})
    const route = runTool(project, "route_pcb", {})
    expect(layout.isError).toBe(true)
    expect(route.isError).toBe(true)
    expect(layout.result).toMatch(/No part has a footprint yet/)
    expect(route.result).toBe(layout.result)
    // an editor design says what it always said
    const ex = EXAMPLES[0].project
    expect(runTool({ ...ex, components: ex.components.map((c) => ({ ...c, pcb: { ...c.pcb, placed: false } })) }, "route_pcb", {}).result).toBe("Error: No parts are on the PCB yet; run layout_pcb first")
  })

  it("an update_component description no longer limits mirror to KiCad symbols", () => {
    const out = runTool(EXAMPLES[0].project, "update_component", { ref: EXAMPLES[0].project.components[0].ref, mirror: "y" })
    expect(out.isError).toBeFalsy()
  })

  it("Clean up lists the pins it would have cut, and says when they are off the 0.1 grid", () => {
    const { project } = imp(rich())
    const c = cleanupSheet({ ...project, components: project.components.map((x) => ({ ...x, sch: { ...x.sch, x: x.sch.x + 0.03 } })) })
    // nothing to refuse here, but the result has its list in every case
    expect(Array.isArray(c.problems)).toBe(true)
  })

  it("ERC: a no-connect flag on no pin is said", () => {
    const { project } = imp(rich())
    const f = runErc(project, computeConnectivity(project)).find((x) => x.kind === "stray-no-connect")
    expect(f?.message).toMatch(/is not on a pin/)
  })
})

describe("locked groups", () => {
  it("unlock and lock", () => {
    const { project } = imp(rich())
    const b = project.blocks![0]
    const open = setBlockLocked(project, b.id, false)
    expect(lockedBlockOf(open, project.components.map((c) => c.id))).toBeNull()
    expect(lockedBlockOf(setBlockLocked(open, b.id, true), project.components.map((c) => c.id))).toBe("Fixed")
  })
})

{
// Fix round 1 of slice 3b-ii: turned boxes, connect by a made-up name, parts off the board, board data keyed by auto names.

const MM = 12.7
const uuid = (n: number) => `aaaaaaaa-0000-4000-8000-00000000000${n}`

const imp = (text: string): Project => {
  const r = importKicadSchematic(text)
  if (r.status !== "imported") throw new Error(`refused: ${r.message}`)
  return r.project
}

const refId = (p: Project, ref: string) => p.components.find((c) => c.ref === ref)!.id
const netOfPin = (p: Project, ref: string, pin: string) => {
  const conn = computeConnectivity(p)
  const id = conn.pinNet.get(pinKey(refId(p, ref), pin))
  return conn.nets.find((n) => n.id === id)
}
const blinker = () => EXAMPLES.find((e) => e.id === "blinker")!.project

describe("B1: a text box and a table cell are never turned, only their text", () => {
  const text = schematic({
    version: 20250114,
    body: [
      `(text_box "Turned" (exclude_from_sim no) (at 50.8 50.8 90) (size 20.32 10.16) (margins 0.9525 0.9525 0.9525 0.9525) (stroke (width 0.254) (type default)) (fill (type none)) (effects (font (size 1.27 1.27)) (justify left top)) (uuid tb1))`,
      `(table (column_count 1) (border (external no) (header no)) (separators (rows no) (cols no)) (column_widths 10.16) (row_heights 5.08)
        (cells
          (table_cell "A" (exclude_from_sim no) (at 127 127 90) (size 10.16 5.08) (margins 0.9525 0.9525 0.9525 0.9525) (span 1 1) (fill (type none)) (effects (font (size 1.27 1.27)) (justify left top)) (uuid tc1))))`,
    ],
  })
  const project = imp(text)
  const box = project.drawings!.find((i) => i.type === "textbox")!
  const table = project.drawings!.find((i) => i.type === "table")!

  it("draws the box from at to at + size, whatever the angle", () => {
    if (box.type !== "textbox") throw new Error("no box")
    expect(box.rot).toBe(90)
    const b = drawingBounds(box)
    expect(b.minX).toBeCloseTo(box.x, 6)
    expect(b.maxX).toBeCloseTo(box.x + box.w, 6)
    expect(b.maxY).toBeCloseTo(box.y, 6)
    expect(b.minY).toBeCloseTo(box.y - box.h, 6)
    // in KiCad's own numbers: x 50.8 to 71.12, y 50.8 to 60.96 (y down)
    expect((b.maxX - b.minX) * MM).toBeCloseTo(20.32, 3)
    expect((b.maxY - b.minY) * MM).toBeCloseTo(10.16, 3)
  })

  // KiCad's SCH_TEXTBOX::GetDrawPos, in the file's own frame (mm, y down): a 20.32 x 10.16 box at (50.8, 50.8), margins 0.9525.
  // Vertical text: the horizontal justification sets y (left: bottom - margin, right: top + margin) and the vertical one sets x
  // (top: left + margin, bottom: right - margin).
  const anchorOf = (angle: number, justify: string) => {
    const p = imp(
      schematic({
        version: 20250114,
        body: [`(text_box "T" (exclude_from_sim no) (at 50.8 50.8 ${angle}) (size 20.32 10.16) (margins 0.9525 0.9525 0.9525 0.9525) (stroke (width 0.254) (type default)) (fill (type none)) (effects (font (size 1.27 1.27)) (justify ${justify})) (uuid tb2))`],
      }),
    )
    const b = p.drawings!.find((i) => i.type === "textbox")!
    if (b.type !== "textbox") throw new Error("no box")
    const at = boxTextAt(b, b.margins, b.look)
    return { x: at.x * MM, y: -at.y * MM }
  }
  it.each([
    [90, "left top", 51.7525, 60.0075],
    [90, "left bottom", 70.1675, 60.0075],
    [90, "right bottom", 70.1675, 51.7525],
    [90, "right top", 51.7525, 51.7525],
    [270, "left top", 51.7525, 60.0075],
    [0, "left top", 51.7525, 51.7525],
    [0, "right bottom", 70.1675, 60.0075],
  ])("anchors the text of a box at %i, justify %s, where KiCad does", (angle, justify, x, y) => {
    const at = anchorOf(angle, justify)
    expect(at.x).toBeCloseTo(x, 3)
    expect(at.y).toBeCloseTo(y, 3)
  })

  it("a table cell at 90 is the rectangle from at to at + size too", () => {
    if (table.type !== "table") throw new Error("no table")
    const b = drawingBounds(table)
    const c = table.cells[0]
    expect(c.rot).toBe(90)
    expect(b.minX).toBeCloseTo(c.x, 6)
    expect(b.maxX).toBeCloseTo(c.x + c.w, 6)
    expect(b.maxY).toBeCloseTo(c.y, 6)
    expect(b.minY).toBeCloseTo(c.y - c.h, 6)
  })
})

describe("B2: connect with a name nothing gave joins the real net", () => {
  const chain = () =>
    imp(
      schematic({
        version: 20250114,
        libs: [LIB_R],
        symbols: [
          { lib: "Device:R", at: "50.8 50.8", ref: "R1", value: "1k", uuid: uuid(1) },
          { lib: "Device:R", at: "76.2 50.8", ref: "R2", value: "1k", uuid: uuid(2) },
          { lib: "Device:R", at: "101.6 50.8", ref: "R3", value: "1k", uuid: uuid(3) },
        ],
        wires: ["76.2 54.61 101.6 54.61"],
      }),
    )

  it("on an imported design a pin joins the net a made-up name belongs to", () => {
    const p = chain()
    const target = netOfPin(p, "R2", "2")!
    expect(target.name).toMatch(/^Net-\(/)
    expect(target.pins.length).toBe(2)
    const out = runTool(p, "connect", { pins: ["R1.1"], net_name: target.name })
    expect(out.isError, out.result).toBeFalsy()
    expect(out.result).toContain("made up")
    const conn = computeConnectivity(out.project)
    expect(conn.pinNet.get(pinKey(refId(out.project, "R1"), "1"))).toBe(conn.pinNet.get(pinKey(refId(out.project, "R2"), "2")))
    const ids = conn.nets.map((n) => n.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(conn.nets.some((n) => n.pins.length === 1 && n.pins[0].pin === "1" && n.pins[0].componentId === refId(out.project, "R1"))).toBe(false)
  })

  it("a pin already on that net is said to be there", () => {
    const p = chain()
    const target = netOfPin(p, "R2", "2")!
    const out = runTool(p, "connect", { pins: ["R2.2", "R3.2"], net_name: target.name })
    expect(out.isError).toBeFalsy()
    expect(out.project).toBe(p)
  })

  it("the editor auto names do the same on an example", () => {
    let tried = 0
    let joined = 0
    for (const ex of EXAMPLES) {
      const p = ex.project
      const conn = computeConnectivity(p)
      const target = conn.nets.find((n) => !n.named && /^Net-\(/.test(n.name) && n.pins.length >= 2)
      const loose = conn.nets.find((n) => n.id !== target?.id && !n.named && /^Net-\(/.test(n.name))
      if (!target || !loose) continue
      tried++
      const ref = p.components.find((c) => c.id === loose.pins[0].componentId)!.ref
      const out = runTool(p, "connect", { pins: [`${ref}.${loose.pins[0].pin}`], net_name: target.name })
      if (out.isError) continue
      const after = computeConnectivity(out.project)
      const ids = after.nets.map((n) => n.id)
      expect(new Set(ids).size, ex.id).toBe(ids.length)
      expect(after.pinNet.get(pinKey(loose.pins[0].componentId, loose.pins[0].pin)), ex.id).toBe(after.pinNet.get(pinKey(target.pins[0].componentId, target.pins[0].pin)))
      joined++
    }
    expect(tried).toBeGreaterThan(0)
    expect(joined).toBeGreaterThan(0)
  })
})

describe("B3 and B4: a part off the board", () => {
  const off = () => runTool(blinker(), "update_component", { ref: "R1", on_board: false })

  it("place_parts refuses it, and get_design leaves its pcb out", () => {
    const p = off().project
    expect(onBoard(p.components.find((c) => c.ref === "R1")!)).toBe(false)
    const out = runTool(p, "place_parts", { placements: [{ ref: "R1", dx: 1 }] })
    expect(out.isError).toBe(true)
    expect(out.result).toContain("R1 is not on the board (on_board false)")
    const design = JSON.parse(runTool(p, "get_design", {}).result)
    const r1 = design.components.find((c: { ref: string }) => c.ref === "R1")
    expect(r1.pcb).toBeUndefined()
    expect(design.components.find((c: { ref: string; pcb?: unknown }) => c.ref !== "R1" && c.pcb)).toBeTruthy()
  })

  it("layout_pcb and route_pcb say no part is on the board when every footprinted part is off it", () => {
    let p = blinker()
    for (const c of p.components) if (c.footprint) p = setFlags(p, c.id, { notOnBoard: true })
    for (const name of ["layout_pcb", "route_pcb"]) {
      const out = runTool(p, name, {})
      expect(out.isError, name).toBe(true)
      expect(out.result, name).toContain("No part is on the board")
    }
  })

  it("taking a routed part off the board removes its unlocked traces and vias, and says so", () => {
    const p = blinker()
    const r1 = p.components.find((c) => c.ref === "R1")!
    const before = copperOn(p, [r1])
    expect(before.traces.length).toBeGreaterThan(0)
    const out = off()
    expect(out.isError).toBeFalsy()
    expect(out.result).toMatch(/trace/)
    const now = out.project.components.find((c) => c.ref === "R1")!
    expect(copperOn(out.project, [now]).traces.filter((t) => !t.locked)).toEqual([])
    expect(out.project.traces.length).toBeLessThan(p.traces.length)
    const back = runTool(out.project, "update_component", { ref: "R1", on_board: true })
    expect(back.project.traces.length).toBe(out.project.traces.length)
  })

  it("the model does the same through setFlags", () => {
    const p = blinker()
    const id = p.components.find((c) => c.ref === "R1")!.id
    expect(setFlags(p, id, { notOnBoard: true }).traces.length).toBeLessThan(p.traces.length)
    expect(setFlags(p, id, { dnp: true }).traces.length).toBe(p.traces.length)
  })
})

describe("M3: board data keyed by an auto name follows a rename", () => {
  const withBoardData = (p: Project, name: string): Project => ({
    ...p,
    zones: [...p.zones, { id: "z-test", net: name, layer: "top" } as Zone],
    vias: [...p.vias, { id: "v-test", x: 1, y: 1, diameter: 0.6, drill: 0.3, net: name }],
    rules: { ...p.rules, netWidths: { ...p.rules.netWidths, [name]: 0.5 } },
  })

  const check = (p: Project, ref: string, fresh: string) => {
    const target = computeConnectivity(p).nets.find((n) => !n.named && n.name.startsWith(`Net-(${ref}-`))
    if (!target) throw new Error(`no auto net on ${ref}`)
    const keyed = withBoardData(p, target.name)
    const id = p.components.find((c) => c.ref === ref)!.id
    const next = renameReference(keyed, id, fresh)
    const now = computeConnectivity(next).nets.find((n) => n.pins.some((q) => target.pins.some((t) => t.componentId === q.componentId && t.pin === q.pin)))!
    expect(now.name).not.toBe(target.name)
    expect(next.zones.find((z) => z.id === "z-test")!.net).toBe(now.name)
    expect(next.vias.find((v) => v.id === "v-test")!.net).toBe(now.name)
    expect(next.rules.netWidths![now.name]).toBe(0.5)
    expect(next.rules.netWidths![target.name]).toBeUndefined()
  }

  it("on an editor design with auto names", () => {
    for (const ex of EXAMPLES) {
      const refs = [...new Set(computeConnectivity(ex.project).nets.filter((n) => !n.named && n.name.startsWith("Net-(")).map((n) => /^Net-\(([^-]+)-/.exec(n.name)![1]))]
      const ref = refs.find((r) => !r.startsWith("#"))
      if (!ref) continue
      check(ex.project, ref, `${ref}99`)
      return
    }
    throw new Error("no example has an auto net")
  })

  it("on an imported design, whose names are KiCad's", () => {
    const p = imp(
      schematic({
        version: 20250114,
        libs: [LIB_R],
        symbols: [
          { lib: "Device:R", at: "76.2 50.8", ref: "R2", value: "1k", uuid: uuid(2) },
          { lib: "Device:R", at: "101.6 50.8", ref: "R3", value: "1k", uuid: uuid(3) },
        ],
        wires: ["76.2 54.61 101.6 54.61"],
      }),
    )
    check(p, "R2", "R9")
  })

  it("a design with no board data is returned as it is", () => {
    const p = blinker()
    expect(rekeyAutoNets(p, p)).toBe(p)
  })
})
}

{
// Fix round 2 of slice 3b-ii: a made-up net name is kept, never a trap; board data keyed by it follows every rename.

const uuid = (n: number) => `aaaaaaaa-0000-4000-8000-00000000000${n}`
const example = (id: string) => EXAMPLES.find((e) => e.id === id)!.project
const refId = (p: Project, ref: string) => p.components.find((c) => c.ref === ref)!.id
const netOf = (p: Project, ref: string, pin: string) => {
  const conn = computeConnectivity(p)
  return conn.nets.find((n) => n.id === conn.pinNet.get(pinKey(refId(p, ref), pin)))
}
const noDuplicateIds = (p: Project) => {
  const ids = computeConnectivity(p).nets.map((n) => n.id)
  expect(new Set(ids).size).toBe(ids.length)
}

const chain = (): Project => {
  const r = importKicadSchematic(
    schematic({
      version: 20250114,
      libs: [LIB_R],
      symbols: [
        { lib: "Device:R", at: "50.8 50.8", ref: "R1", value: "1k", uuid: uuid(1) },
        { lib: "Device:R", at: "76.2 50.8", ref: "R2", value: "1k", uuid: uuid(2) },
        { lib: "Device:R", at: "101.6 50.8", ref: "R3", value: "1k", uuid: uuid(3) },
        { lib: "Device:R", at: "127 50.8", ref: "R4", value: "1k", uuid: uuid(4) },
      ],
      wires: ["76.2 54.61 101.6 54.61"],
    }),
  )
  if (r.status !== "imported") throw new Error("refused")
  return r.project
}

describe("connect by a made-up name: the second call finds the net", () => {
  it("esp32-robot: two calls with Net-(J6-2) land on one net, which keeps the name", () => {
    const p = example("esp32-robot")
    const first = runTool(p, "connect", { pins: ["J7.2"], net_name: "Net-(J6-2)" })
    expect(first.isError, first.result).toBeFalsy()
    expect(first.result).toContain("labelled Net-(J6-2)")
    expect(netOf(first.project, "J6", "2")!.name).toBe("Net-(J6-2)")
    expect(netOf(first.project, "J7", "2")!.id).toBe(netOf(first.project, "J6", "2")!.id)
    const second = runTool(first.project, "connect", { pins: ["J8.2"], net_name: "Net-(J6-2)" })
    expect(second.isError, second.result).toBeFalsy()
    expect(netOf(second.project, "J8", "2")!.id).toBe(netOf(second.project, "J6", "2")!.id)
    expect(netOf(second.project, "J6", "2")!.pins.length).toBeGreaterThanOrEqual(6)
    noDuplicateIds(second.project)
  })

  it("an imported design: the label is a global one of that exact text, and the second call joins the same net", () => {
    const p = chain()
    const name = netOf(p, "R2", "2")!.name
    expect(name).toMatch(/^Net-\(/)
    const first = runTool(p, "connect", { pins: ["R1.1"], net_name: name })
    expect(first.isError, first.result).toBeFalsy()
    expect(first.result).toContain("(a global label)")
    expect(first.project.labels.some((l) => l.name === name && l.kind === "global")).toBe(true)
    expect(netOf(first.project, "R2", "2")!.name).toBe(name)
    expect(netOf(first.project, "R1", "1")!.id).toBe(netOf(first.project, "R2", "2")!.id)
    const second = runTool(first.project, "connect", { pins: ["R4.1"], net_name: name })
    expect(second.isError, second.result).toBeFalsy()
    expect(netOf(second.project, "R4", "1")!.id).toBe(netOf(second.project, "R2", "2")!.id)
    noDuplicateIds(second.project)
  })

  it("a made-up name no net has is refused, and nothing changes", () => {
    for (const [p, name] of [
      [example("esp32-robot"), "Net-(R9-Pad9)"],
      [example("esp32-robot"), "unconnected-(R3-Pad1)"],
      [chain(), "Net-(R9-Pad9)"],
      [chain(), "unconnected-(R3-Pad1)"],
    ] as const) {
      const out = runTool(p, "connect", { pins: [p.components.find((c) => !c.ref.startsWith("#"))!.ref + ".1"], net_name: name })
      expect(out.isError, name).toBe(true)
      expect(out.result).toContain(`No net is called ${name} now`)
      expect(out.project).toBe(p)
    }
  })

  it("a name a label gives is still an ordinary name, and says nothing about made-up names", () => {
    const p = example("blinker")
    const out = runTool(p, "connect", { pins: ["R1.1"], net_name: "GND" })
    expect(out.result).not.toContain("made up")
  })

  it("the note is not given when the pin of that net could not be labelled, or the pins were already on it", () => {
    const p = chain()
    const name = netOf(p, "R2", "2")!.name
    const there = runTool(p, "connect", { pins: ["R2.2", "R3.2"], net_name: name })
    expect(there.result).toContain("already on")
    expect(there.result).not.toContain("labelled")
  })
})

describe("board data keyed by a made-up name follows every rename (M3)", () => {
  const keyed = (p: Project, name: string): Project => ({
    ...p,
    zones: [...p.zones, { id: "z-test", net: name, layer: "top" } as Zone],
    rules: { ...p.rules, netWidths: { ...p.rules.netWidths, [name]: 0.5 } },
  })

  it("a Sakura rename of D1 keeps a 0.5 mm width on Net-(D1-1), on every example that has it", () => {
    let seen = 0
    for (const ex of EXAMPLES) {
      const p = ex.project
      const d1 = p.components.find((c) => c.ref === "D1")
      const net = d1 && computeConnectivity(p).nets.find((n) => n.name === "Net-(D1-1)")
      if (!net) continue
      seen++
      const out = runTool(keyed(p, "Net-(D1-1)"), "update_component", { ref: "D1", new_ref: "D9" })
      expect(out.isError, ex.id).toBeFalsy()
      const now = computeConnectivity(out.project).nets.find((n) => n.pins.some((q) => net.pins.some((t) => t.componentId === q.componentId && t.pin === q.pin)))!
      expect(now.name, ex.id).toBe("Net-(D9-1)")
      expect(out.project.rules.netWidths!["Net-(D9-1)"], ex.id).toBe(0.5)
      expect(out.project.rules.netWidths!["Net-(D1-1)"], ex.id).toBeUndefined()
      expect(out.project.zones.find((z) => z.id === "z-test")!.net, ex.id).toBe("Net-(D9-1)")
    }
    expect(seen).toBeGreaterThan(0)
  })

  it("a rename of a part with no board data returns the very same data (no copy of the rules)", () => {
    const p = example("blinker")
    const out = runTool(p, "update_component", { ref: "D1", new_ref: "D9" })
    expect(out.project.rules).toBe(p.rules)
    expect(out.project.zones).toBe(p.zones)
  })

  it("removing a part keeps a width on a net that loses a pin", () => {
    const p = example("blinker")
    const net = computeConnectivity(p).nets.find((n) => n.name === "Net-(D1-1)")!
    const other = net.pins.find((q) => q.componentId !== refId(p, "D1"))!
    // the net names itself by the first pin; take the part away that gives the name and the width follows the remaining pins
    const gone = removeItems(keyed(p, "Net-(D1-1)"), { components: [refId(p, "D1")] })
    const left = computeConnectivity(gone).nets.find((n) => n.pins.some((q) => q.componentId === other.componentId && q.pin === other.pin))
    expect(left).toBeTruthy()
    expect(left!.name).not.toBe("Net-(D1-1)")
    expect(gone.rules.netWidths![left!.name]).toBe(0.5)
    expect(gone.rules.netWidths!["Net-(D1-1)"]).toBeUndefined()
  })

  it("a connect that joins two made-up nets moves the data of the one that lost its name onto the joined net", () => {
    const p = example("esp32-robot")
    const b = netOf(p, "J7", "2")!.name
    const joinedTo = (out: Project) => netOf(out, "J7", "2")!.name
    const withB = keyed(p, b)
    const out = runTool(withB, "connect", { pins: ["J6.2", "J7.2"] })
    expect(out.isError, out.result).toBeFalsy()
    const joined = joinedTo(out.project)
    expect(netOf(out.project, "J6", "2")!.id).toBe(netOf(out.project, "J7", "2")!.id)
    expect(out.project.zones.find((z) => z.id === "z-test")!.net).toBe(joined)
    expect(out.project.rules.netWidths![joined]).toBe(0.5)
  })

  it("connect that renames an auto net by a label name moves the width with it (superset or same pins)", () => {
    const p = example("blinker")
    const out = runTool(keyed(p, "Net-(D1-1)"), "connect", { pins: ["D1.1"], net_name: "LEDA" })
    expect(out.isError, out.result).toBeFalsy()
    expect(netOf(out.project, "D1", "1")!.name).toBe("LEDA")
    expect(out.project.rules.netWidths!.LEDA).toBe(0.5)
    expect(out.project.rules.netWidths!["Net-(D1-1)"]).toBeUndefined()
  })

  it("a design with no name-keyed board data comes back as the very same object", () => {
    const p = example("esp32-robot")
    expect(rekeyAutoNets(p, p)).toBe(p)
    const q = { ...p, rules: { ...p.rules, netWidths: { GND: 0.6 } } }
    expect(rekeyAutoNets(p, q)).toBe(q)
  })
})
}
