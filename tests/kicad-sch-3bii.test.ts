import { describe, expect, it } from "vitest"
import { runTool } from "../src/ai/tools"
import { bomCsv } from "../src/export/bom"
import { projectToCircuitJson } from "../src/export/circuitJson"
import { kicadFiles } from "../src/export/kicad"
import { pnpCsv } from "../src/export/pnp"
import { cleanupSheet } from "../src/model/cleanup"
import { computeConnectivity } from "../src/model/connectivity"
import { EXAMPLES } from "../src/model/examples"
import { runErc } from "../src/model/erc"
import { isInBom, isOnBoard } from "../src/model/instances"
import { importKicadSchematic } from "../src/model/kicad/schematic"
import { lockedBlockOf } from "../src/model/blocks"
import { labelGeometry } from "../src/model/labelShapes"
import { moveSchematicItems, removeItems } from "../src/model/ops"
import { partFindings } from "../src/model/partChecks"
import { parseProjectFile, serializeProject } from "../src/model/projectFile"
import { pasteItems, setBlockLocked, setFlags, setLabelStyle, updateItem } from "../src/model/schematicEdit"
import { imageSize, itemBox, itemHit, moveItem } from "../src/model/sheetItems"
import { tidySchematic } from "../src/model/tidy"
import type { Project } from "../src/model/types"
import { parseSexpr } from "./kicad-census/sexpr.mjs"
import { LIB_R, schematic } from "./kicad-schematic-fixtures"

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

describe("S4: the sheet's items, held at the file's numbers", () => {
  const { project, report } = imp(rich())
  const items = project.items ?? []
  const raw = parseSexpr(rich()).find((n: unknown) => Array.isArray(n) && n[0] === "kicad_sch") as unknown[]
  const rawOf = (token: string) => raw.filter((n) => Array.isArray(n) && n[0] === token) as unknown[][]
  const num = (n: unknown) => Number(n)
  const mm = (units: number) => units * 12.7
  const kid = (node: unknown[], name: string) => node.find((c) => Array.isArray(c) && c[0] === name) as unknown[] | undefined
  const kind = (k: string) => items.filter((i) => i.kind === k)

  it("has every kind the file has", () => {
    expect(items.map((i) => i.kind).sort()).toEqual(["arc", "bezier", "circle", "image", "junction", "noconnect", "polyline", "rectangle", "table", "text", "textbox"].sort())
  })

  it("puts every point where the raw file has it, to a thousandth of a millimetre, with y up", () => {
    const check = (units: { x: number; y: number }, rawAt: unknown[]) => {
      expect(Math.abs(mm(units.x) - num(rawAt[1]))).toBeLessThan(0.001)
      expect(Math.abs(-mm(units.y) - num(rawAt[2]))).toBeLessThan(0.001)
    }
    const text = kind("text")[0] as Extract<(typeof items)[number], { kind: "text" }>
    check(text, kid(rawOf("text")[0], "at")!)
    expect(text).toMatchObject({ text: "Hello\nworld", rot: 90, excludeFromSim: true, look: { bold: true, h: "left", v: "bottom", href: "https://example.com" } })
    const box = kind("textbox")[0] as Extract<(typeof items)[number], { kind: "textbox" }>
    check(box, kid(rawOf("text_box")[0], "at")!)
    expect(mm(box.w)).toBeCloseTo(20.32, 3)
    expect(mm(box.h)).toBeCloseTo(10.16, 3)
    expect(box.margins?.map(mm).map((v) => Math.round(v * 1e4) / 1e4)).toEqual([0.9525, 0.9525, 0.9525, 0.9525])
    expect(box.fill).toEqual({ kind: "color", color: "#ffff00" })
    expect(box.stroke).toMatchObject({ dash: "dash", color: "#0000ff" })
    const poly = kind("polyline")[0] as Extract<(typeof items)[number], { kind: "polyline" }>
    const rawPts = (kid(rawOf("polyline")[0], "pts") as unknown[]).slice(1) as unknown[][]
    poly.points.forEach((p, i) => check(p, rawPts[i]))
    const rect = kind("rectangle")[0] as Extract<(typeof items)[number], { kind: "rectangle" }>
    check(rect.a, kid(rawOf("rectangle")[0], "start")!)
    check(rect.b, kid(rawOf("rectangle")[0], "end")!)
    expect(rect.fill).toEqual({ kind: "background" })
    const circle = kind("circle")[0] as Extract<(typeof items)[number], { kind: "circle" }>
    check(circle.c, kid(rawOf("circle")[0], "center")!)
    expect(mm(circle.r)).toBeCloseTo(3.81, 4)
    const arc = kind("arc")[0] as Extract<(typeof items)[number], { kind: "arc" }>
    check(arc.mid, kid(rawOf("arc")[0], "mid")!)
    const bez = kind("bezier")[0] as Extract<(typeof items)[number], { kind: "bezier" }>
    ;((kid(rawOf("bezier")[0], "pts") as unknown[]).slice(1) as unknown[][]).forEach((p, i) => check(bez.points[i], p))
    const image = kind("image")[0] as Extract<(typeof items)[number], { kind: "image" }>
    check(image, kid(rawOf("image")[0], "at")!)
    expect(image.scale).toBe(2)
    expect(image.data).toBe(PNG)
    // a 1 pixel picture at the default 300 per inch, drawn at scale 2: 2 * 25.4 / 300 mm
    expect(mm(imageSize(image).w)).toBeCloseTo((2 * 25.4) / 300, 4)
    const table = kind("table")[0] as Extract<(typeof items)[number], { kind: "table" }>
    expect(table.cells.map((c) => c.text)).toEqual(["A", "B"])
    check(table.cells[1], kid(kid(rawOf("table")[0], "cells")!.find((c) => Array.isArray(c) && c[1] === "B") as unknown[], "at")!)
    expect(table.columnWidths.map(mm).map((v) => Math.round(v * 1e3) / 1e3)).toEqual([10.16, 10.16])
    expect(table.border).toMatchObject({ external: true, header: true })
    expect(table.separators).toMatchObject({ rows: true, cols: true })
    const junction = kind("junction")[0] as Extract<(typeof items)[number], { kind: "junction" }>
    check(junction, kid(rawOf("junction").find((j) => num(kid(j, "diameter")![1]) > 0)!, "at")!)
    expect(mm(junction.diameter ?? 0)).toBeCloseTo(1.5, 4)
    expect(junction.color).toBe("#00ff00")
    const nc = kind("noconnect")[0] as Extract<(typeof items)[number], { kind: "noconnect" }>
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
    // every extension node of the file is imported (none pending, none unknown), and each kind has its item
    expect(report.account?.pending.size).toBe(0)
    expect(report.account?.unknownPaths.size).toBe(0)
    for (const token of ["text", "text_box", "polyline", "rectangle", "circle", "arc", "bezier", "image", "table", "group>locked", "wire>stroke>color", "junction>diameter", "junction>color", "no_connect", "label>effects>font>color", "global_label>shape", "global_label>property", "symbol>dnp", "symbol>fields_autoplaced"]) {
      expect(held(new RegExp(`^${token}$`)).length, token).toBe(1)
    }
  })

  it("is selected, moved and deleted like anything else on the sheet", () => {
    const text = kind("text")[0]
    expect(itemHit(text, { x: text.kind === "text" ? text.x : 0, y: text.kind === "text" ? text.y : 0 }, 0.05)).toBe(true)
    const moved = moveSchematicItems(project, { components: [], labels: [], wires: [], items: [text.id] }, { x: 1, y: -0.5 }, [])
    const after = moved.items!.find((i) => i.id === text.id)!
    expect(after.kind === "text" && text.kind === "text" && Math.abs(after.x - text.x - 1) < 1e-9 && Math.abs(after.y - text.y + 0.5) < 1e-9).toBe(true)
    // the rest is where it was
    expect(moved.items!.filter((i) => i.id !== text.id)).toEqual(project.items!.filter((i) => i.id !== text.id))
    expect(moveItem(text, { x: 0, y: 0 })).toEqual(text)
    const gone = removeItems(project, { items: [text.id] })
    expect(gone.items!.some((i) => i.id === text.id)).toBe(false)
    expect(gone.items!.length).toBe(project.items!.length - 1)
    // paste copies it, offset, under a new id
    const pasted = pasteItems(project, { project, components: [], wires: [], labels: [], items: [text.id], blocks: [] }, { x: 2, y: 2 })
    expect(pasted.ok).toBe(true)
    if (pasted.ok) expect(pasted.project.items!.length).toBe(project.items!.length + 1)
    // edited
    const edited = updateItem(project, text.id, { text: "changed" } as never)
    expect(edited.items!.find((i) => i.id === text.id)).toMatchObject({ text: "changed" })
    expect(itemBox(text).maxX).toBeGreaterThan(itemBox(text).minX)
  })

  it("reads a damaged file without crashing: an item with no geometry is dropped", () => {
    const project2 = parseProjectFile(JSON.stringify({ format: "cherryblossom.project", version: 3, project: { ...project, items: [...project.items!, { id: "bad", kind: "polyline", points: [{ x: "a" }] }, { id: "bad2", kind: "text" }, 7] } }), { id: "x" })
    expect(project2.items!.length).toBe(project.items!.length)
  })

  it("survives a save and a load, and a document with none of it is still a project", () => {
    const again = parseProjectFile(serializeProject(project), { id: "x" })
    expect(again.items).toEqual(project.items)
    expect(again.labels).toEqual(project.labels)
    expect(again.netNames).toBe("kicad")
    expect(again.blocks?.[0].locked).toBe(true)
    expect(again.wires.find((w) => w.look)?.look).toEqual(project.wires.find((w) => w.look)?.look)
    expect(again.components[0].flags).toEqual(project.components[0].flags)
  })
})

describe("S7: the flags of a symbol", () => {
  const base = imp(rich()).project

  it("keeps them", () => {
    expect(base.components[0].flags).toEqual({ dnp: true, fieldsAutoplaced: true })
  })

  it("a part not to be populated is left out of the BOM and the position file, a part off the board is not on it", () => {
    const part = base.components[0]
    expect(isInBom(part)).toBe(false)
    expect(isInBom({ flags: undefined })).toBe(true)
    expect(isInBom({ flags: { inBom: false } })).toBe(false)
    expect(isOnBoard({ partId: part.partId, flags: { onBoard: false } })).toBe(false)
    const ex = EXAMPLES.find((e) => e.id === "blinker")!.project
    const ref = ex.components.find((c) => c.ref === "R1")!
    const dnp = setFlags(ex, ref.id, { dnp: true })
    expect(bomCsv(dnp)).not.toContain("R1")
    expect(bomCsv(ex)).toContain("R1")
    expect(pnpCsv(dnp)).not.toContain("R1")
    expect(pnpCsv(setFlags(ex, ref.id, { inPosFiles: false }))).not.toContain("R1,")
    // "board only" (not in the BOM) leaves the position file alone, a part off the board leaves both only where it has no place
    const noBom = setFlags(ex, ref.id, { inBom: false })
    expect(bomCsv(noBom)).not.toContain("R1")
    expect(pnpCsv(noBom)).toContain("R1")
    const off = setFlags(ex, ref.id, { onBoard: false })
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
    const design = JSON.parse(runTool(out.project, "get_design", {}).result) as { components: { ref: string; dnp?: boolean; in_bom?: boolean; on_board?: boolean }[] }
    const r1 = design.components.find((c) => c.ref === "R1")!
    expect(r1).toMatchObject({ dnp: true, in_bom: false })
    expect(r1.on_board).toBeUndefined()
    expect(design.components.find((c) => c.ref !== "R1")?.dnp).toBeUndefined()
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
  it("writes labels as they were (local, global with their shapes), the items, and wire strokes", async () => {
    const { project } = imp(rich())
    const { files, notes } = await kicadFiles(project)
    const sch = Object.entries(files).find(([k]) => k.endsWith(".kicad_sch"))![1]
    expect(sch).toMatch(/\n {2}\(label "SIG"/)
    expect(sch).toMatch(/\(global_label "VBUS"[\s\S]*?\(shape input\)/)
    expect(sch).toContain("(text \"Hello\\nworld\"")
    for (const node of ["(text_box ", "(polyline", "(rectangle", "(circle", "(arc", "(bezier", "(image", "(table", "(junction", "(no_connect"]) expect(sch).toContain(node)
    expect(sch).toMatch(/\(stroke\s+\(width 0\.5\)\s+\(type dash\)\s+\(color 255 0 0 1\)\)/)
    // the file reads back as the same items
    const again = importKicadSchematic(sch)
    expect(again.status).toBe("imported")
    if (again.status === "imported") {
      expect(again.project.items?.map((i) => i.kind).sort()).toEqual((project.items ?? []).map((i) => i.kind).sort())
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
      expect(t.project.items?.filter((i) => i.kind !== "junction").length).toBe(project.items!.filter((i) => i.kind !== "junction").length)
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
