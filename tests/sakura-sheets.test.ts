import { describe, expect, it } from "vitest"
import { runTool } from "../src/ai/tools"
import type { ToolContext } from "../src/ai/toolKit"
import { getConnectivity } from "../src/store/analysis"
import { createProject } from "../src/model/ops"
import { isHierarchical, mergeSheetView, sheetUses, sheetView, syncCopies } from "../src/model/sheets"
import { addDrawings } from "../src/model/drawings"
import { kicadFiles } from "../src/export/kicad"
import type { Project } from "../src/model/types"

// Sakura builds sheets: add_sheet (new, or another use), edit_sheet, add_hier_label, wire_sheet_pin and show_sheet, one undo step each (a tool call
// returns a whole new project, which the copilot commits once), with a clear refusal for what can't be done.

const run = (p: Project, name: string, input: Record<string, unknown>, ctx?: ToolContext) => {
  const out = runTool(p, name, input, ctx)
  return out
}
const good = (p: Project, name: string, input: Record<string, unknown>, ctx?: ToolContext) => {
  const out = run(p, name, input, ctx)
  expect(out.isError, out.result).toBe(false)
  return out.project
}
const refused = (p: Project, name: string, input: Record<string, unknown>, ctx?: ToolContext) => {
  const out = run(p, name, input, ctx)
  expect(out.isError, out.result).toBe(true)
  expect(out.project).toBe(p)
  return out.result
}

/** A root with a part, and a sheet POWER holding a resistor and a capacitor. */
function withPower() {
  let p = createProject("t")
  p = good(p, "add_component", { part_id: "resistor", x: 0, y: 0 })
  p = good(p, "add_sheet", { name: "POWER", page: "2" })
  p = good(p, "add_component", { part_id: "resistor", sheet: "POWER", x: 0, y: 0 })
  p = good(p, "add_component", { part_id: "capacitor", sheet: "POWER", x: 5, y: 0 })
  return p
}

describe("add_sheet", () => {
  it("makes a sheet symbol on the root and the empty sheet it stands for, with a name and a page", () => {
    const p = good(createProject("t"), "add_sheet", { name: "POWER", page: "7" })
    expect(isHierarchical(p)).toBe(true)
    const uses = sheetUses(p)
    expect(uses.map((u) => u.human)).toEqual(["/", "/POWER/"])
    expect(uses[1].page).toBe("7")
    expect(p.sheetSymbols![0]).toMatchObject({ name: "POWER", sheet: "root" })
  })

  it("puts the next sheet in free space beside the first, and names a default sheet", () => {
    let p = good(createProject("t"), "add_sheet", { name: "A" })
    p = good(p, "add_sheet", {})
    const [a, b] = p.sheetSymbols!
    expect(b.x).toBeGreaterThan(a.x + a.w)
    expect(b.name).toBe("Sheet")
  })

  it("refuses a duplicate name on the same sheet, a taken page, and too small a box", () => {
    const p = good(createProject("t"), "add_sheet", { name: "POWER", page: "2" })
    expect(refused(p, "add_sheet", { name: "power" })).toMatch(/already has a sheet called power/)
    expect(refused(p, "add_sheet", { name: "IO", page: "2" })).toMatch(/Page 2 is already \/POWER\//)
    expect(refused(p, "add_sheet", { name: "IO", w: 0.1 })).toMatch(/too small/)
    expect(refused(p, "add_sheet", { name: "IO", parent: "Nowhere" })).toMatch(/No sheet Nowhere/)
  })

  it("puts another use of a sheet, with its own references, and refuses one that would hold itself", () => {
    let p = withPower()
    p = good(p, "add_sheet", { reuse: "POWER", name: "POWER2" })
    expect(sheetUses(p).map((u) => u.human)).toEqual(["/", "/POWER/", "/POWER2/"])
    const refs = p.components.filter((c) => c.inst).map((c) => c.ref)
    expect(new Set(refs).size).toBe(refs.length)
    expect(p.components.filter((c) => c.inst === `/${p.sheetSymbols![1].id}`)).toHaveLength(2)
    // POWER on POWER, directly and through the sheet inside it
    expect(refused(p, "add_sheet", { reuse: "POWER", parent: "POWER", name: "SELF" })).toMatch(/can't hold itself/)
    const q = good(p, "add_sheet", { name: "INNER", parent: "POWER" })
    expect(refused(q, "add_sheet", { reuse: "POWER", parent: "/POWER/INNER/", name: "LOOP" })).toMatch(/can't hold itself/)
  })

  it("refuses to use the root again or an unknown sheet", () => {
    const p = withPower()
    expect(refused(p, "add_sheet", { reuse: "root" })).toMatch(/root sheet can't be used again/)
    expect(refused(p, "add_sheet", { reuse: "Nope" })).toMatch(/No sheet Nope/)
  })
})

describe("building on a sheet", () => {
  it("add_component and group_parts take sheet, and the shown sheet is the default", () => {
    let p = withPower()
    const power = sheetUses(p)[1]
    expect(p.components.filter((c) => c.inst === power.path)).toHaveLength(2)
    expect(p.components.filter((c) => !c.inst)).toHaveLength(1)
    const ctx: ToolContext = { sheet: { shown: () => power.path, show: () => {} } }
    p = good(p, "add_component", { part_id: "led", x: 10, y: 0 }, ctx)
    expect(p.components.find((c) => c.partId === "led")!.inst).toBe(power.path)
    p = good(p, "group_parts", { block: "REG", refs: [p.components.find((c) => c.partId === "led")!.ref], sheet: "POWER" })
    expect(p.blocks![0].inst).toBe(power.path)
  })

  it("a project with sheets and no shown sheet adds to the root", () => {
    const p = good(withPower(), "add_component", { part_id: "led", x: 20, y: 0 })
    expect(p.components.find((c) => c.partId === "led")!.inst).toBeUndefined()
  })
})

describe("add_hier_label and wire_sheet_pin", () => {
  it("takes a net out of a sheet and wires the pin on the parent, so one net crosses", () => {
    let p = withPower()
    const power = sheetUses(p)[1]
    const inner = p.components.filter((c) => c.inst === power.path)
    const r = inner.find((c) => c.partId === "resistor")!
    p = good(p, "add_hier_label", { sheet: "POWER", name: "VOUT", pins: [`${r.ref}.2`], shape: "output" })
    const labels = p.labels.filter((l) => l.name === "VOUT")
    expect(labels.filter((l) => l.kind === "hierarchical")).toHaveLength(1)
    expect(labels[0].sheet).toBe(power.sheet)
    expect(p.sheetSymbols![0].pins).toMatchObject([{ name: "VOUT", shape: "output", rot: 0 }])
    const root = p.components.find((c) => !c.inst)!
    p = good(p, "wire_sheet_pin", { sheet: "POWER", pin: "VOUT", to: [`${root.ref}.1`] })
    const net = getConnectivity(p).nets.find((n) => n.pins.some((x) => x.componentId === root.id && x.pin === "1"))!
    expect(net.pins.some((x) => x.componentId === r.id && x.pin === "2")).toBe(true)
  })

  it("a second pin of the same name joins the first label instead of making another hierarchical one", () => {
    let p = withPower()
    const [r, c] = p.components.filter((x) => x.inst)
    p = good(p, "add_hier_label", { sheet: "POWER", name: "VOUT", pins: [`${r.ref}.2`] })
    p = good(p, "add_hier_label", { sheet: "POWER", name: "VOUT", pins: [`${c.ref}.1`] })
    expect(p.labels.filter((l) => l.name === "VOUT" && l.kind === "hierarchical")).toHaveLength(1)
    expect(p.sheetSymbols![0].pins).toHaveLength(1)
  })

  it("refuses the root, an unknown pin, a project with no sheets, and unknown sheet pins", () => {
    const p = withPower()
    expect(refused(p, "add_hier_label", { sheet: "root", name: "X", pins: ["R1.1"] })).toMatch(/root sheet has no sheet above/)
    expect(refused(createProject("t"), "add_hier_label", { sheet: "root", name: "X", pins: ["R1.1"] })).toMatch(/no sheets yet/)
    expect(refused(p, "wire_sheet_pin", { sheet: "POWER", pin: "NOPE", to: ["R1.1"] })).toMatch(/has no pin NOPE/)
    expect(refused(p, "wire_sheet_pin", { sheet: "root", pin: "NOPE", to: ["R1.1"] })).toMatch(/root sheet/)
  })
})

describe("edit_sheet", () => {
  it("renames, pages, resizes and moves in one call, and the pins follow the move", () => {
    let p = withPower()
    const r = p.components.find((c) => c.inst)!
    p = good(p, "add_hier_label", { sheet: "POWER", name: "VOUT", pins: [`${r.ref}.2`], shape: "output" })
    const before = p.sheetSymbols![0]
    const pin = before.pins[0]
    p = good(p, "edit_sheet", { sheet: "POWER", name: "SUPPLY", page: "3", w: 14, h: 10, x: before.x + 4, y: before.y + 2 })
    const sym = p.sheetSymbols![0]
    expect(sym).toMatchObject({ name: "SUPPLY", w: 14, h: 10 })
    expect(sheetUses(p)[1]).toMatchObject({ human: "/SUPPLY/", page: "3" })
    expect(sym.pins[0].x).toBeCloseTo(sym.x + 14, 3)
    expect(sym.pins[0].y).toBeGreaterThan(pin.y)
  })

  it("adds and removes pins by name", () => {
    let p = withPower()
    p = good(p, "edit_sheet", { sheet: "POWER", add_pins: [{ name: "EN", shape: "input" }, { name: "PG", shape: "output" }] })
    expect(p.sheetSymbols![0].pins.map((x) => [x.name, x.rot])).toEqual([["EN", 180], ["PG", 0]])
    p = good(p, "edit_sheet", { sheet: "POWER", remove_pins: ["EN"] })
    expect(p.sheetSymbols![0].pins.map((x) => x.name)).toEqual(["PG"])
    expect(refused(p, "edit_sheet", { sheet: "POWER", add_pins: [{ name: "PG" }] })).toMatch(/already has a pin PG/)
    expect(refused(p, "edit_sheet", { sheet: "POWER", remove_pins: ["ZZ"] })).toMatch(/no pin ZZ/)
  })

  it("is all or nothing: a refused part leaves the project as it was", () => {
    let p = withPower()
    p = good(p, "add_sheet", { name: "IO" })
    expect(refused(p, "edit_sheet", { sheet: "IO", w: 20, name: "POWER" })).toMatch(/already has a sheet called POWER/)
    expect(refused(p, "edit_sheet", { sheet: "IO", w: 20, remove_pins: ["x"] })).toMatch(/no pin x/)
    expect(refused(p, "edit_sheet", { sheet: "IO" })).toMatch(/Nothing to change/)
    expect(refused(p, "edit_sheet", { sheet: "IO", page: "2" })).toMatch(/Page 2 is already/)
  })

  it("refuses the root and an unknown sheet", () => {
    const p = withPower()
    expect(refused(p, "edit_sheet", { sheet: "root", name: "X" })).toMatch(/root sheet/)
    expect(refused(p, "edit_sheet", { sheet: "Nowhere", name: "X" })).toMatch(/No sheet Nowhere/)
  })

  it("deletes a sheet with what is on it, in one step, and says what went", () => {
    const p = withPower()
    const out = run(p, "edit_sheet", { sheet: "POWER", delete: true })
    expect(out.isError).toBe(false)
    expect(out.result).toMatch(/Deleted the sheet POWER with 2 parts/)
    expect(out.project.components.filter((c) => c.inst)).toHaveLength(0)
    expect(out.project.components).toHaveLength(1)
    expect(isHierarchical(out.project)).toBe(false)
    // the earlier project is untouched, which is what undo restores
    expect(p.components).toHaveLength(3)
    expect(refused(p, "edit_sheet", { sheet: "POWER", delete: true, name: "X" })).toMatch(/can't be combined/)
  })

  it("deleting one use of a sheet used twice keeps the sheet for the other", () => {
    let p = withPower()
    p = good(p, "add_sheet", { reuse: "POWER", name: "POWER2" })
    p = good(p, "edit_sheet", { sheet: "POWER2", delete: true })
    expect(sheetUses(p).map((u) => u.human)).toEqual(["/", "/POWER/"])
    expect(p.components.filter((c) => c.inst)).toHaveLength(2)
  })
})

describe("show_sheet", () => {
  it("shows a sheet and goes up, through the editor's own view, and changes no design", () => {
    let p = withPower()
    p = good(p, "add_sheet", { name: "INNER", parent: "POWER" })
    let shown = ""
    const ctx: ToolContext = { sheet: { shown: () => shown, show: (path) => (shown = path) } }
    const inner = sheetUses(p).find((u) => u.name === "INNER")!
    const out = run(p, "show_sheet", { sheet: "/POWER/INNER/" }, ctx)
    expect(out.isError).toBe(false)
    expect(out.project).toBe(p)
    expect(shown).toBe(inner.path)
    run(p, "show_sheet", { sheet: "up" }, ctx)
    expect(shown).toBe(inner.parent)
    run(p, "show_sheet", { sheet: "up" }, ctx)
    expect(shown).toBe("")
    expect(refused(p, "show_sheet", { sheet: "up" }, ctx)).toMatch(/root sheet/)
    expect(refused(p, "show_sheet", { sheet: "Nowhere" }, ctx)).toMatch(/No sheet Nowhere/)
    expect(refused(p, "show_sheet", { sheet: "POWER" })).toMatch(/No schematic is open/)
  })
})

describe("get_design lists the hierarchy", () => {
  it("gives each sheet its path, page, box and pins", () => {
    let p = withPower()
    p = good(p, "edit_sheet", { sheet: "POWER", add_pins: [{ name: "EN", shape: "input" }] })
    const d = JSON.parse(run(p, "get_design", {}).result)
    expect(d.sheets[0]).toMatchObject({ path: "/", page: "1" })
    expect(d.sheets[1]).toMatchObject({ path: "/POWER/", page: "2", box: { w: 10, h: 8 }, pins: ["EN (input)"] })
  })
})

// The join with buses (S3): the draw tool has no bus shape, so the bus is drawn the way the editor's Bus tool does (the same drawings), on the sheet's own view.
describe("Sakura's sheets with a bus", () => {
  function built() {
    let p = withPower()
    p = good(p, "connect", { sheet: "POWER", net_name: "D3", pins: ["R2.1"] })
    const path = sheetUses(p)[1].path
    const view = sheetView(p, path)
    const label = view.labels.find((l) => l.name === "D3")!
    let v2 = addDrawings(view, [{ type: "bus", points: [{ x: label.x - 1.4, y: label.y + 0.2 }, { x: label.x + 0.1, y: label.y + 0.2 }] }, { type: "busentry", x: label.x, y: label.y, dx: -0.2, dy: 0.2 }]).project
    v2 = { ...v2, labels: [...v2.labels, { id: "lbus", name: "D[0..3]", x: label.x - 0.9, y: label.y + 0.2, rot: 0, sheet: label.sheet }] }
    p = syncCopies(mergeSheetView(p, view, v2), path)
    p = good(p, "add_sheet", { reuse: "POWER", name: "POWER2" })
    p = good(p, "add_hier_label", { sheet: "POWER", name: "ENA", pins: ["C1.1"] })
    p = good(p, "wire_sheet_pin", { sheet: "POWER", pin: "ENA", to: ["R1.1"] })
    return p
  }

  it("exports the bus, with the bus member as each use's own net and the hierarchical net shared", async () => {
    const p = built()
    const names = getConnectivity(p).nets.map((n) => n.name).sort()
    expect(names).toEqual(["/ENA", "/POWER/D3", "/POWER2/D3", "/POWER2/ENA"])
    const sch = Object.entries((await kicadFiles(p)).files).find(([k]) => k.startsWith("POWER") && k.endsWith(".kicad_sch"))![1] as string
    expect(sch).toMatch(/\(bus\b/)
    expect(sch).toMatch(/\(bus_entry\b/)
    expect(sch).toContain('(label "D[0..3]"')
    expect(sch).toContain('(hierarchical_label "ENA"')
  })

  it("draw on the sheet keeps the bus, and Tidy still refuses a sheet with buses", () => {
    let p = built()
    p = good(p, "draw", { sheet: "POWER", shapes: [{ type: "text", x: 0, y: 4, text: "note" }] })
    const view = sheetView(p, sheetUses(p)[1].path)
    expect(view.drawings?.some((d) => d.type === "bus")).toBe(true)
    expect(view.drawings?.some((d) => d.type === "text")).toBe(true)
    expect(refused(p, "tidy_schematic", { sheet: "POWER", whole_sheet: true })).toMatch(/sheet with buses/)
  })
})
