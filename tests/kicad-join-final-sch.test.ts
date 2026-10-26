import { describe, expect, it } from "vitest"
import { runTool } from "../src/ai/tools"
import { addSheetUse, removeSheetSymbols } from "../src/model/sheetOps"
import { commitOnUse, sheetUses } from "../src/model/sheets"
import { pasteItems } from "../src/model/schematicEdit"
import { setVariantOverride } from "../src/model/variants"
import type { Project } from "../src/model/types"
import { imp, S1, S2 } from "./kicad-sheets-fixtures"

// The final schematic review of the join: per-use variant changes (B1), the connectivity cache (B2), the KiCad 9 export of a shared sheet (B3) and Sakura's edit_sheet (B4).

const ref = (p: Project, r: string) => p.components.find((c) => c.ref === r)!

/** The S9 fixture: a sheet used twice (R2 on the first use, R3 on the second), with R3 do-not-populate under the variant Lite on its own use. */
function twoUses(): Project {
  const { project } = imp([{ uuid: S1, name: "Power", y: 60.96 }, { uuid: S2, name: "Power2", y: 90 }])
  return setVariantOverride(project, ref(project, "R3").id, "Lite", { dnp: true })
}

describe("B1: the variant changes of one use of a sheet are that use's", () => {
  it("moving a part on the first use keeps R3's variants (commitOnUse)", () => {
    const p = twoUses()
    const first = sheetUses(p)[1].path
    expect(ref(p, "R3").variants).toEqual({ Lite: { dnp: true } })
    const moved = commitOnUse(p, first, (v) => ({ ...v, components: v.components.map((c) => (c.ref === "R2" ? { ...c, sch: { ...c.sch, x: c.sch.x + 5 } } : c)) }))
    expect(ref(moved, "R2").sch.x).toBe(ref(p, "R2").sch.x + 5)
    expect(ref(moved, "R3").sch.x).toBe(ref(p, "R3").sch.x + 5)
    expect(ref(moved, "R3").variants).toEqual({ Lite: { dnp: true } })
    expect(ref(moved, "R2").variants).toBeUndefined()
  })

  it("a variant set on the first use is not copied to the second", () => {
    const p = twoUses()
    const first = sheetUses(p)[1].path
    const made = commitOnUse(p, first, (v) => setVariantOverride(v, ref(v, "R2").id, "Lite", { excludeFromBom: true }))
    expect(ref(made, "R2").variants).toEqual({ Lite: { excludeFromBom: true } })
    expect(ref(made, "R3").variants).toEqual({ Lite: { dnp: true } })
  })

  it("Sakura's tools on a sheet (onSheet) keep R3's variants", () => {
    const p = twoUses()
    const out = runTool(p, "add_component", { part_id: "resistor", sheet: "Power", x: 20, y: 0 })
    expect(out.isError, out.result).toBe(false)
    expect(ref(out.project, "R3").variants).toEqual({ Lite: { dnp: true } })
    // the symbol that was added to the first use comes to the second with no variants
    const added = out.project.components.filter((c) => c.inst === sheetUses(p)[2].path && c.ref !== "R3")
    expect(added.length).toBe(1)
    expect(added[0].variants).toBeUndefined()
  })

  it("Sakura's tools on the project (syncEdited) keep R3's variants", () => {
    const p = twoUses()
    const out = runTool(p, "update_component", { ref: "R2", props: { resistance: "22k" } })
    expect(out.isError, out.result).toBe(false)
    expect(ref(out.project, "R3").props).toEqual(ref(out.project, "R2").props)
    expect(ref(out.project, "R3").variants).toEqual({ Lite: { dnp: true } })
  })

  it("a use added with addSheetUse starts with no variants, and the other uses keep theirs", () => {
    const p = twoUses()
    const r = addSheetUse(p, "", p.sheetSymbols![0].child, { minX: 10, minY: 120, maxX: 30, maxY: 130 })!
    expect(r).not.toBeNull()
    const third = sheetUses(r.project).at(-1)!.path
    const copies = r.project.components.filter((c) => c.inst === third)
    expect(copies.length).toBe(1)
    expect(copies[0].variants).toBeUndefined()
    expect(ref(r.project, "R3").variants).toEqual({ Lite: { dnp: true } })
  })

  it("a paste starts a new copy with no variants", () => {
    const p = twoUses()
    const r3 = ref(p, "R3")
    const res = pasteItems(p, { project: p, components: [r3.id], wires: [], labels: [], blocks: [] }, { x: 3, y: 3 })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const added = res.project.components.filter((c) => !p.components.some((x) => x.id === c.id))
    expect(added.length).toBe(1)
    expect(added[0].variants).toBeUndefined()
    expect(ref(res.project, "R3").variants).toEqual({ Lite: { dnp: true } })
  })

  it("a removed use's variant keys are gone, so a symbol that takes its id does not inherit them", () => {
    const { project } = imp([{ uuid: S1, name: "Power", y: 60.96 }, { uuid: S2, name: "Power2", y: 90 }])
    // A sheet symbol on the child sheet, with variants for each use of it; the first use of the child goes.
    const [a, b] = project.sheetSymbols!
    const uses = sheetUses(project)
    const withInner: Project = {
      ...project,
      sheets: [...(project.sheets ?? []), { id: "s9" }],
      sheetSymbols: [
        ...project.sheetSymbols!,
        { id: "h9", sheet: a.child, child: "s9", x: 0, y: 0, w: 5, h: 5, name: "Inner", file: "inner.kicad_sch", pins: [], variants: { [uses[1].path]: { Lite: { dnp: true } }, [uses[2].path]: { Lite: { excludeFromBom: true } } }, pages: { [`${uses[1].path}/h9`]: "7", [`${uses[2].path}/h9`]: "8" } },
      ],
    }
    const without = removeSheetSymbols(withInner, [a.id])
    const inner = without.sheetSymbols!.find((s) => s.id === "h9")!
    expect(inner.variants).toEqual({ [uses[2].path]: { Lite: { excludeFromBom: true } } })
    expect(inner.pages).toEqual({ [`${uses[2].path}/h9`]: "8" })
    void b
  })
})
