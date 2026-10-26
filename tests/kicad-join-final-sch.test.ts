import { describe, expect, it } from "vitest"
import { importKicadSchematic } from "../src/model/kicad/schematic"
import { schematic } from "./kicad-schematic-fixtures"
import { runTool } from "../src/ai/tools"
import { addSheetPin, addSheetUse, removeSheetSymbols, setSheetSymbol } from "../src/model/sheetOps"
import { kicadFiles } from "../src/export/kicad"
import { kicad9SheetProblems } from "./kicad9-strict"
import { commitOnUse, sheetUses } from "../src/model/sheets"
import { pasteItems } from "../src/model/schematicEdit"
import { setActiveVariant, setVariantOverride } from "../src/model/variants"
import type { ComponentInstance, Project } from "../src/model/types"
import { computeConnectivity } from "../src/model/connectivity"
import { getConnectivity, sameSchematic } from "../src/model/connectivityCache"
import { followNetRenames } from "../src/model/copperNets"
import { setSymbolVariant } from "../src/model/schematicEdit"
import { importSheet, place } from "./kicad-sch-parts"
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

describe("B2: the connectivity cache sees what changes a symbol's pins", () => {
  /** What the nets are, by name and the pins on each. */
  const netsOf = (c: ReturnType<typeof computeConnectivity>) => c.nets.map((n) => `${n.name}: ${n.pins.map((p) => `${p.componentId}.${p.pin}`).join(",")}`)
  const edit = (p: Project, id: string, patch: Partial<ComponentInstance>): Project => ({ ...p, components: p.components.map((c) => (c.id === id ? { ...c, ...patch } : c)) })
  /** The cache is primed with the project before the edit, as the editor has it; what it answers for the project after must be what a fresh computation answers. */
  const expectFresh = (before: Project, after: Project) => {
    getConnectivity(before)
    expect(sameSchematic(before, after)).toBe(false)
    expect(netsOf(getConnectivity(after))).toEqual(netsOf(computeConnectivity(after)))
    expect(netsOf(computeConnectivity(after))).not.toEqual(netsOf(computeConnectivity(before)))
  }
  // An MCU at (60, 120): pin 1 (PA0) at (52.38, 114.92), wired to R1's pin 2 at (40, 114.92).
  const mcu = () => importSheet({ symbols: [place("Test:MCU", "60 120", "U3"), place("Device:R", "40 111.11", "R1")], wires: ["52.38 114.92 40 114.92"] })

  it("the scenario: a pin function picked with setSymbolVariant renames the net, and the trace follows", () => {
    const before = mcu()
    const u3 = before.components.find((c) => c.ref === "U3")!
    expect(computeConnectivity(before).nets.some((n) => n.name === "Net-(U3-PA0)")).toBe(true)
    const withTrace: Project = { ...before, traces: [{ id: "t1", layer: "top", width: 0.2, points: [{ x: 0, y: 0 }, { x: 1, y: 0 }], net: "Net-(U3-PA0)" }] }
    getConnectivity(withTrace)
    const res = setSymbolVariant(withTrace, u3.id, { pinAlt: { pin: "1", alternate: "TX" } }, { conn: getConnectivity })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(getConnectivity(res.project).nets.some((n) => n.name === "Net-(U3-TX)")).toBe(true)
    expect(followNetRenames(withTrace, res.project).traces[0].net).toBe("Net-(U3-TX)")
  })

  it("pinAlt", () => {
    const before = mcu()
    const u3 = before.components.find((c) => c.ref === "U3")!
    expectFresh(before, edit(before, u3.id, { pinAlt: { "1": "TX" } }))
  })

  it("mirror", () => {
    const before = importSheet({ symbols: [place("Test:MCU", "60 120", "U3")], wires: ["52.38 114.92 40 114.92"], labels: ["M 40 114.92 0"] })
    const u3 = before.components[0]
    expectFresh(before, edit(before, u3.id, { sch: { ...u3.sch, mirror: "y" } }))
  })

  it("unit", () => {
    const before = importSheet({ symbols: [place("Test:OPA2", "100 100", "U1", { unit: 1 })], wires: ["107.62 100 115 100"], labels: ["A 115 100 0"] })
    const u1 = before.components[0]
    expectFresh(before, edit(before, u1.id, { unit: 2 }))
  })

  it("bodyStyle", () => {
    const font = "(effects (font (size 1.27 1.27)))"
    const pin = (at: string) => `(pin input line (at ${at}) (length 3.81) (name "A" ${font}) (number "1" ${font}))`
    const lib = `(symbol "Test:BS" (in_bom yes) (on_board yes)
      (property "Reference" "U" (at 0 5.08 0) ${font}) (property "Value" "BS" (at 0 -5.08 0) ${font})
      (symbol "BS_1_1" (rectangle (start -3.81 5.08) (end 3.81 -5.08) (stroke (width 0) (type default)) (fill (type none))) ${pin("-7.62 2.54 0")})
      (symbol "BS_1_2" (rectangle (start -3.81 5.08) (end 3.81 -5.08) (stroke (width 0) (type default)) (fill (type none))) ${pin("-7.62 -2.54 0")}))`
    const r = importKicadSchematic(schematic({ libs: [lib], symbols: [place("Test:BS", "100 100", "U1")], wires: ["92.38 102.54 85 102.54"], labels: ["B 85 102.54 0"] }))
    if (r.status !== "imported") throw new Error(r.message)
    const before = r.project
    expectFresh(before, edit(before, before.components[0].id, { bodyStyle: 2 }))
  })

  it("the net naming rule of the project, and the symbol drawings parts are made of", () => {
    const before = mcu()
    getConnectivity(before)
    const kicad5 = { ...before, netNames: "kicad5" as const }
    expect(sameSchematic(before, kicad5)).toBe(false)
    expect(netsOf(getConnectivity(kicad5))).toEqual(netsOf(computeConnectivity(kicad5)))
    expect(sameSchematic(before, { ...before, symbols: { ...before.symbols } })).toBe(false)
  })

  it("an edit that no net can see is still not a schematic edit: a footprint, a PCB move and the fields' places", () => {
    const before = mcu()
    const u3 = before.components.find((c) => c.ref === "U3")!
    expect(sameSchematic(before, edit(before, u3.id, { footprint: "other", pcb: { ...u3.pcb, x: 9, y: 9, placed: true } }))).toBe(true)
    expect(sameSchematic(before, edit(before, u3.id, { fields: { Value: { x: 1, y: 1, angle: 0, size: 1.27 } as never } }))).toBe(true)
  })
})

describe("B3: the KiCad 9 export of a sheet used twice", () => {
  /** The root file and the shared child file of an export. */
  async function exported(p: Project) {
    const { files, notes } = await kicadFiles(p)
    const names = Object.keys(files).filter((k) => k.endsWith(".kicad_sch"))
    const root = names.find((k) => files[k].includes("(sheet\n"))!
    const child = names.find((k) => k !== root)!
    return { root: files[root], child: files[child], childName: child, notes: notes.join("\n"), all: files }
  }
  /** The text of the placed symbols of a file (the child file holds R9 once, with a reference for each use). */
  const symbolText = (sch: string) => sch.slice(sch.indexOf("\n  (symbol\n    (lib_id"))
  const sheetNodes = (root: string) => root.split("\n  (sheet\n").slice(1).map((n) => n.slice(0, n.indexOf("\n  )")))

  it("scenario 1: only the first sheet symbol is do not populate: that is on its node in the parent file, and not on the shared symbols", async () => {
    const p = twoUses()
    const first = p.sheetSymbols![0]
    const flagged = setSheetSymbol(p, first.id, { flags: { dnp: true } })
    const out = await exported(flagged)
    const nodes = sheetNodes(out.root)
    expect(nodes).toHaveLength(2)
    expect(nodes[0]).toMatch(/\(dnp yes\)/)
    expect(nodes[1]).toMatch(/\(dnp no\)/)
    // the file both uses share does not say do not populate: the second use is not
    expect(symbolText(out.child)).toMatch(/\(dnp no\)/)
    expect(symbolText(out.child)).not.toMatch(/\(dnp yes\)/)
    expect(out.notes).toMatch(/The flags of a sheet symbol are written on the sheet symbol/)
    expect(kicad9SheetProblems(out.root)).toEqual([])
    expect(kicad9SheetProblems(out.child)).toEqual([])
  })

  it("a part's own flag is in the shared file, for every use", async () => {
    const p = twoUses()
    const own = { ...p, components: p.components.map((c) => (c.ref === "R2" || c.ref === "R3" ? { ...c, flags: { dnp: true as const } } : c)) }
    const out = await exported(own)
    expect(symbolText(out.child)).toMatch(/\(dnp yes\)/)
    expect(out.notes).not.toMatch(/KiCad 9 keeps a sheet used more than once/)
  })

  it("scenario 2: do not populate under the active variant on the second use only: the file has the first use's, and the note names the part and what was written", async () => {
    const p = setActiveVariant(twoUses(), "Lite")
    const out = await exported(p)
    expect(symbolText(out.child)).toMatch(/\(dnp no\)/)
    const line = out.notes.split("\n").find((l) => l.startsWith("R3 on "))!
    expect(line).toBeDefined()
    expect(line).toMatch(/R3 on \/Power2\/ has do not populate/)
    expect(line).toMatch(/says what R2 on \/Power\/ has, no flag/)
    expect(line).toContain(out.childName)
    // the variant note no longer claims the flags are on every symbol
    expect(out.notes).toMatch(/the active variant "Lite" makes them/)
    expect(out.notes).not.toMatch(/are on each symbol/)
  })

  it("a variant that is the same on every use is written in the shared file with no difference said", async () => {
    let p = twoUses()
    p = setVariantOverride(p, ref(p, "R2").id, "Lite", { dnp: true })
    const out = await exported(setActiveVariant(p, "Lite"))
    expect(symbolText(out.child)).toMatch(/\(dnp yes\)/)
    expect(out.notes).not.toMatch(/KiCad 9 keeps a sheet used more than once/)
  })

  it("a sheet symbol whose variant differs between the uses of its parent sheet is said", async () => {
    // Power sits on the root; a sheet Inner below it is drawn once and used twice (a symbol on each use of Power would need Power used twice), so the case is
    // the sheet symbols of a sheet used twice: give the first use's symbol a variant for the second parent use.
    const { project } = imp([{ uuid: S1, name: "Power", y: 60.96 }, { uuid: S2, name: "Power2", y: 90 }])
    const [a, b] = project.sheetSymbols!
    const inner = { id: "h9", sheet: a.child, child: "s9", x: 0, y: 0, w: 5, h: 5, name: "Inner", file: "inner.kicad_sch", pins: [], variants: { [`/${b.id}`]: { Lite: { dnp: true } } } }
    const p = setActiveVariant({ ...project, sheets: [...(project.sheets ?? []), { id: "s9" }], sheetSymbols: [...project.sheetSymbols!, inner], variants: { list: [{ name: "Lite" }] } }, "Lite")
    const out = await exported(p)
    expect(out.notes).toMatch(/The sheet symbol Inner is do not populate on \/Power2\/ but not flagged on \/Power\//)
  })
})

describe("minors", () => {
  it("a pin added to a sheet symbol on a sheet joined by KiCad's rules keeps six digits", () => {
    const { project } = imp([{ uuid: S1, name: "Power", y: 60.96 }])
    const rules: Project = { ...project, sheets: (project.sheets ?? []).map((s) => (s.id === "root" ? { ...s, kicadRules: true as const } : s)), sheetSymbols: project.sheetSymbols!.map((s) => ({ ...s, x: 6.096123, y: 1.234567 })) }
    const sym = rules.sheetSymbols![0]
    const left = addSheetPin(rules, sym.id, "LEFT", "input", "left")
    expect(left.sheetSymbols![0].pins.at(-1)!.x).toBe(6.096123)
    // an editor sheet keeps its four
    const plain = addSheetPin({ ...rules, sheets: project.sheets }, sym.id, "LEFT", "input", "left")
    expect(plain.sheetSymbols![0].pins.at(-1)!.x).toBe(6.0961)
  })
})
