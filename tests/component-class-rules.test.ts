import { describe, expect, it } from "vitest"
import { importKicadProject, projectNeeds, readKicadPro, type KicadProjectResult, type ProjectFile } from "../src/model/kicad/project"
import { applyClassRules, readClassRules } from "../src/model/kicad/project/classRules"
import { EXTENSION_NAMES as BOARD_EXTENSION_NAMES } from "../src/model/kicad/board"
import type { ComponentInstance } from "../src/model/types"
import { board, footprint, pad } from "./kicad-board-fixtures"

// X20: the component class rules of a project file. The ones that can be worked out without doubt (a reference or a list, a footprint's library link, a side) give their
// class to the footprints they hold; a rule with a wildcard, a rotation, a field, a sheet or a custom expression is a report entry, and no part is given a class by a guess.

const ALL = new Set([...Object.keys(BOARD_EXTENSION_NAMES), "S2", "S5", "S6", "S10"])

const proFile = (assignments: unknown[], extra: Record<string, unknown> = {}): ProjectFile => ({
  path: "demo.kicad_pro",
  data: JSON.stringify({ meta: { filename: "demo.kicad_pro", version: 3 }, component_class_settings: { assignments, meta: { version: 0 }, sheet_component_classes: { enabled: false }, ...extra } }),
})
const rule = (cls: string, conditions: Record<string, { primary?: string; secondary?: string }>, op = "ALL") => ({ component_class: cls, conditions, conditions_operator: op })

const pcb = board({
  body: [
    footprint({ ref: "R1", at: "5 5", pads: [pad({ at: "0 0" })], extra: '(component_classes (class "Static"))' }),
    footprint({ ref: "R2", at: "10 5", name: "Capacitor_SMD:C_0603_1608Metric", pads: [pad({ at: "0 0" })] }),
    footprint({ ref: "C7", at: "15 5", layer: "B.Cu", pads: [pad({ at: "0 0", layers: '"B.Cu" "B.Paste" "B.Mask"' })] }),
  ],
})
const imp = (assignments: unknown[], extra: Record<string, unknown> = {}): Extract<KicadProjectResult, { status: "imported" }> => {
  const r = importKicadProject([{ path: "demo.kicad_pcb", data: pcb }, proFile(assignments, extra)], { built: ALL })
  if (r.status !== "imported") throw new Error(`${r.status}: ${r.message}`)
  return r
}
const classesOf = (r: { project: { components: ComponentInstance[] } }) => Object.fromEntries(r.project.components.map((c) => [c.ref, c.classes]))

describe("component class rules of the project file", () => {
  it("give their class to the parts a reference, a list of references, a footprint or a side holds, on top of the classes the board lists", () => {
    const r = imp([
      rule("ByRef", { REFERENCE: { primary: "R1, C7" } }),
      rule("ByFootprint", { FOOTPRINT: { primary: "Capacitor_SMD:C_0603_1608Metric" } }),
      rule("Back", { SIDE: { primary: "Back" } }),
      rule("Both", { REFERENCE: { primary: "R2" }, SIDE: { primary: "Front" } }),
      rule("Either", { REFERENCE: { primary: "R1" }, "REFERENCE-1": { primary: "R2" } }, "ANY"),
      rule("Everyone", {}),
    ])
    expect(classesOf(r)).toEqual({
      R1: ["Static", "ByRef", "Either", "Everyone"],
      R2: ["ByFootprint", "Both", "Either", "Everyone"],
      C7: ["ByRef", "Back", "Everyone"],
    })
    expect(r.report.entries.find((e) => e.code === "component-class-rules")?.why).toMatch(/6 class rules of the project file were worked out as KiCad does, and 3 parts have a class from them/)
    expect(r.report.entries.filter((e) => e.code === "component-class-rule-not-worked-out")).toEqual([])
  })

  it("report each rule they cannot work out, and give no part a class by a guess", () => {
    const r = imp(
      [rule("Wild", { REFERENCE: { primary: "C?" } }), rule("Custom", { CUSTOM: { primary: "A.intersectsArea('RULE_1')" }, REFERENCE: { primary: "R1" } }), rule("Rot", { ROTATION: { primary: "90" } }), rule("Field", { FOOTPRINT_FIELD: { primary: "F", secondary: "V" } }), rule("Plain", { REFERENCE: { primary: "R2" } })],
      { sheet_component_classes: { enabled: true } },
    )
    expect(classesOf(r)).toEqual({ R1: ["Static"], R2: ["Plain"], C7: undefined })
    const out = r.report.entries.filter((e) => e.code === "component-class-rule-not-worked-out")
    expect(out.map((e) => e.object)).toEqual(["the component class rule for Wild", "the component class rule for Custom", "the component class rule for Rot", "the component class rule for Field", "the class of each sheet"])
    expect(out[0].why).toMatch(/a wildcard in a reference/)
    expect(out[1].why).toMatch(/a custom expression/)
    expect(out.every((e) => e.severity === "not-brought")).toBe(true)
  })

  it("name no extension that is not built, and leave a project file with none as it was", () => {
    const pro = readKicadPro(proFile([rule("A", { REFERENCE: { primary: "R1" } })]).data as string).pro
    expect(projectNeeds(pro, null).map((n) => n.ext)).not.toContain("X20")
    const none = imp([])
    expect(classesOf(none)).toEqual({ R1: ["Static"], R2: undefined, C7: undefined })
    expect(none.report.entries.some((e) => e.code.startsWith("component-class-rule"))).toBe(false)
    const parts = none.project.components
    expect(applyClassRules(null, parts).components).toBe(parts)
    expect(readClassRules(null)).toEqual({ rules: [], sheetClasses: false })
  })
})
