import { describe, expect, it } from "vitest"
import { bomCsv } from "../src/export/bom"
import { kicadFiles } from "../src/export/kicad"
import { pnpCsv } from "../src/export/pnp"
import { computeConnectivity } from "../src/model/connectivity"
import { hitDrawing, moveDrawing, removeDrawings, updateDrawings } from "../src/model/drawings"
import { isDirective, labelNetClasses, newDirective, setDirectiveClass, settleLabelNetClasses, withLabelNetClasses } from "../src/model/directives"
import { classNameOf, classValues } from "../src/model/netClasses"
import { importKicadSchematic } from "../src/model/kicad/schematic"
import { parseProjectFile, serializeProject } from "../src/model/projectFile"
import { isRuleArea, ruleAreaFlags, withRuleAreaFlags } from "../src/model/ruleAreas"
import { directiveShape, kicadOnlyBox } from "../src/model/sheetItems"
import type { DrawingDirective, DrawingLine, Project } from "../src/model/types"
import { kicad9SheetProblems } from "./kicad9-strict"
import { LIB_R, schematic } from "./kicad-schematic-fixtures"

// S8: directive labels (`netclass_flag`) and rule areas (`rule_area`): imported into the project, drawn, picked, moved and deleted, given their meaning (the
// net class on the net a label is on, the area's flags on the symbols it touches) and written back to a KiCad 9 file.

const R1 = "aaaaaaaa-0000-4000-8000-000000000001"
const R2 = "aaaaaaaa-0000-4000-8000-000000000002"
const VERSION = 20260306

const directive = (at: string, cls: string, extra = "", fields = "") =>
  `(netclass_flag "" (length 2.54) (shape round) (at ${at}) (fields_autoplaced yes)
    (effects (font (size 1.27 1.27)) (justify left bottom)) (uuid 11111111-0000-4000-8000-000000000001)
    (property "Netclass" "${cls}" (at 51.5 54.61 0) (show_name no) (do_not_autoplace no) (effects (font (size 1.27 1.27))))
    (property "Component Class" "" (at 51.5 59 0) (show_name no) (do_not_autoplace no) (effects (font (size 1.27 1.27) (italic yes))))
    ${fields} ${extra})`

const AREA = (flags: string, pts = "(xy 40 58) (xy 65 58) (xy 65 70) (xy 40 70)") =>
  `(rule_area ${flags} (polyline (pts ${pts}) (stroke (width 0) (type dash)) (fill (type none)) (uuid 22222222-0000-4000-8000-000000000002)))`

/** R1 above R2, wired pin to pin; a local label on each end. `body` is added to the sheet. */
const sheet = (body: string[] = [], version = VERSION) =>
  schematic({
    version,
    libs: [LIB_R],
    symbols: [
      { lib: "Device:R", at: "50.8 50.8", ref: "R1", uuid: R1 },
      { lib: "Device:R", at: "50.8 63.5", ref: "R2", uuid: R2 },
    ],
    wires: ["50.8 54.61 50.8 59.69"],
    labels: ["A 50.8 46.99 0", "B 50.8 67.31 0"],
    body,
  })

const load = (text: string): Project => {
  const r = importKicadSchematic(text)
  if (r.status !== "imported") throw new Error(`${r.message}\n${r.report.entries.map((e) => `${e.code} (${e.severity}): ${e.why}`).join("\n")}`)
  return r.project
}
const report = (text: string) => importKicadSchematic(text).report
const MID = "Net-(R1-Pad2)"

const dirs = (p: Project) => (p.drawings ?? []).filter(isDirective)
const areas = (p: Project) => (p.drawings ?? []).filter(isRuleArea)
const ref = (p: Project, r: string) => p.components.find((c) => c.ref === r)!
const mm = (n: number) => Math.round(n * 12.7 * 1e4) / 1e4

describe("S8: directive labels", () => {
  const text = sheet([directive("50.8 57.15 0", "Power")])
  const p = load(text)

  it("imports a directive label as a drawing with its place, turn, shape, pin, look and every property", () => {
    const [d] = dirs(p)
    expect([mm(d.x), mm(-d.y), d.rot, d.shape, mm(d.length), d.text]).toEqual([50.8, 57.15, 0, "round", 2.54, ""])
    expect(d.fieldsAutoplaced).toBe(true)
    expect(d.uuid).toBe("11111111-0000-4000-8000-000000000001")
    expect(d.look).toMatchObject({ h: "left", v: "bottom" })
    expect(d.fields.map((f) => [f.name, f.value])).toEqual([["Netclass", "Power"], ["Component Class", ""]])
    expect(d.fields[1].place).toMatchObject({ italic: true })
    // The place of a property is relative to the label's point (y up).
    expect([mm(d.fields[0].place.x), mm(d.fields[0].place.y)]).toEqual([0.7, 2.54])
  })

  it("holds every node of the table: none is pending or unknown, and each is in the account as imported", () => {
    const r = importKicadSchematic(text)
    if (r.status !== "imported") throw new Error(r.message)
    expect(r.report.account?.pending.size).toBe(0)
    expect(r.report.account?.unknownPaths.size).toBe(0)
    const held = [...(r.report.account?.importedPaths.keys() ?? [])]
    for (const path of ["netclass_flag", "netclass_flag>at", "netclass_flag>length", "netclass_flag>shape", "netclass_flag>fields_autoplaced", "netclass_flag>uuid", "netclass_flag>effects", "netclass_flag>effects>justify", "netclass_flag>property", "netclass_flag>property>at", "netclass_flag>property>effects>font>italic", "netclass_flag>property>show_name", "netclass_flag>property>do_not_autoplace"]) {
      expect(held, path).toContain(path)
    }
  })

  it("puts the net it is on in the class, as KiCad's implicit class, and says what it does not use", () => {
    expect(p.rules.netClasses).toEqual([{ name: "Power", nets: [], labelNets: [MID], implicit: true }])
    expect(classNameOf(p.rules, MID)).toBe("Power")
    expect(classNameOf(p.rules, "/A")).toBe("Default")
    // An implicit class sets no size: the net keeps the rules' own.
    expect(classValues(p.rules, MID).traceWidth).toBe(p.rules.traceWidth)
    const r = report(text)
    expect(r.entries.filter((e) => e.severity === "refused")).toEqual([])
    expect(r.entries.find((e) => e.code === "component-class-not-used")).toBeUndefined()
  })

  it("reads a Component Class field, keeps it, and says the editor uses none", () => {
    const r = report(sheet([directive("50.8 57.15 0", "Power", "", "")].map((x) => x.replace('"Component Class" ""', '"Component Class" "Class2"'))))
    const e = r.entries.find((x) => x.code === "component-class-not-used")!
    expect(e.severity).toBe("note")
    expect(e.object).toContain("Class2")
  })

  it("gives the class to the net where the label sits on a pin, a wire's end and a label, and to every use of a net by its name", () => {
    for (const at of ["50.8 54.61 0", "50.8 59.69 0", "50.8 57.15 90", "50.8 57.15 180", "50.8 57.15 270"]) {
      expect([...labelNetClasses(load(sheet([directive(at, "Power")])))], at).toEqual([[MID, ["Power"]]])
    }
    // On a label it names the label's net.
    expect([...labelNetClasses(load(sheet([directive("50.8 46.99 0", "Power")])))]).toEqual([["/A", ["Power"]]])
    // On nothing it names no net, and no class is made.
    const free = load(sheet([directive("80 80 0", "Power")]))
    expect(labelNetClasses(free).size).toBe(0)
    expect(free.rules.netClasses).toBeUndefined()
  })

  it("reads a net class a plain label carries in its own property", () => {
    const withField = sheet().replace(/\(label "A" \(at 50.8 46.99 0\)/, '(label "A" (at 50.8 46.99 0) (property "Netclass" "Clk" (at 51 47 0) (effects (font (size 1.27 1.27))))')
    const q = load(withField)
    expect([...labelNetClasses(q)]).toEqual([["/A", ["Clk"]]])
  })

  it("reads the name KiCad writes in another language, and says so", () => {
    const french = sheet([directive("50.8 57.15 0", "Power").replace('"Netclass"', `"Classe d'Equipot"`)])
    const q = load(french)
    expect([...labelNetClasses(q)]).toEqual([[MID, ["Power"]]])
    expect(report(french).entries.find((e) => e.code === "netclass-field-translated")!.severity).toBe("note")
    // Two names for the plain field give no note.
    expect(report(sheet([directive("50.8 57.15 0", "Power").replace('"Netclass"', '"Net Class"')])).entries.find((e) => e.code === "netclass-field-translated")).toBeUndefined()
  })

  it("applies the class of a directive on the edge of a rule area to the wires, labels and pins inside it", () => {
    // The area is round R2 and the wire's lower half; the directive is on its top edge.
    const q = load(sheet([AREA("", "(xy 40 56) (xy 65 56) (xy 65 70) (xy 40 70)"), directive("45 56 0", "Inside")]))
    const claims = [...labelNetClasses(q)].sort()
    // The wire (Net-(R1-Pad2)), R2's pin 1 (the same net), the label B and R2's pin 2 (net /B) are inside; R1 and the label A are not.
    expect(claims).toEqual([["/B", ["Inside"]], [MID, ["Inside"]]])
  })

  it("refuses a net two classes claim, and a directive turned a quarter turn off", () => {
    const two = sheet([directive("50.8 57.15 0", "Power"), directive("50.8 56 0", "Other")])
    const r = importKicadSchematic(two)
    expect(r.status).toBe("refused")
    expect(r.report.entries.find((e) => e.code === "netclass-conflict")!.object).toContain(MID)
    const skew = importKicadSchematic(sheet([directive("50.8 57.15 45", "Power")]))
    expect(skew.status).toBe("refused")
    expect(skew.report.entries.find((e) => e.code === "label-not-held")!.why).toMatch(/quarter turn/)
    const shape = importKicadSchematic(sheet([directive("50.8 57.15 0", "Power").replace("(shape round)", "(shape triangle)")]))
    expect(shape.status).toBe("refused")
  })
})

describe("S8: the shape of a directive label", () => {
  const at = { x: 1, y: 2, length: 0.2 }
  const r4 = (n: number) => Math.round(n * 1e4) / 1e4
  const near = (a: { x: number; y: number }, b: [number, number]) => expect([r4(a.x), r4(a.y)]).toEqual([r4(b[0]), r4(b[1])])

  it("runs the pin up, left, down and right for the turns 0, 90, 180 and 270, as KiCad's file and painter do", () => {
    // Pin length 2.54 mm = 0.2 units. y is up here.
    near(directiveShape({ ...at, rot: 0, shape: "round" }).pin[1], [1, 2 + 0.2 - 0.04])
    near(directiveShape({ ...at, rot: 90, shape: "round" }).pin[1], [1 - 0.2 + 0.04, 2])
    near(directiveShape({ ...at, rot: 180, shape: "round" }).pin[1], [1, 2 - 0.2 + 0.04])
    near(directiveShape({ ...at, rot: 270, shape: "round" }).pin[1], [1 + 0.2 - 0.04, 2])
  })

  it("draws a dot filled and 0.7 of the size, a round flag empty, a diamond and a rectangle as outlines", () => {
    const dot = directiveShape({ ...at, rot: 0, shape: "dot" })
    expect(dot.circle).toMatchObject({ filled: true })
    expect(dot.circle!.r).toBeCloseTo((0.508 * 0.7) / 12.7, 5)
    const round = directiveShape({ ...at, rot: 0, shape: "round" })
    expect(round.circle).toMatchObject({ filled: false })
    expect(round.circle!.r).toBeCloseTo(0.04, 5)
    expect(directiveShape({ ...at, rot: 0, shape: "diamond" }).outline).toHaveLength(7)
    expect(directiveShape({ ...at, rot: 0, shape: "rectangle" }).outline).toHaveLength(8)
  })

  it("is picked on its flag and its anchor, and not across the sheet", () => {
    const d = dirs(load(sheet([directive("50.8 57.15 0", "Power")])))[0]
    expect(hitDrawing(d, { x: d.x, y: d.y }, 0.03)).toBe(true)
    const end = directiveShape(d).circle!.at
    expect(hitDrawing(d, end, 0.03)).toBe(true)
    expect(hitDrawing(d, { x: d.x + 1, y: d.y }, 0.03)).toBe(false)
    const box = kicadOnlyBox(d)
    expect(box.maxY - box.minY).toBeGreaterThan(0.2)
  })
})

describe("S8: rule areas", () => {
  const text = sheet([AREA("(exclude_from_sim yes) (in_bom no) (on_board yes) (dnp yes)")])
  const p = load(text)

  it("imports a rule area as a closed line with its flags, its stroke and its uuid", () => {
    const [a] = areas(p)
    expect(a.closed).toBe(true)
    expect(a.points.map((q) => [mm(q.x), mm(-q.y)])).toEqual([[40, 58], [65, 58], [65, 70], [40, 70]])
    expect(a.ruleArea).toEqual({ dnp: true, excludeFromBom: true, excludeFromSim: true, uuid: "22222222-0000-4000-8000-000000000002" })
    expect(a.stroke).toMatchObject({ dash: "dash" })
  })

  it("holds every node of the table", () => {
    const r = importKicadSchematic(text)
    if (r.status !== "imported") throw new Error(r.message)
    expect(r.report.account?.pending.size).toBe(0)
    const held = [...(r.report.account?.importedPaths.keys() ?? [])]
    for (const path of ["rule_area", "rule_area>dnp", "rule_area>in_bom", "rule_area>on_board", "rule_area>exclude_from_sim", "rule_area>polyline", "rule_area>polyline>pts", "rule_area>polyline>pts>xy", "rule_area>polyline>stroke", "rule_area>polyline>stroke>type", "rule_area>polyline>stroke>width", "rule_area>polyline>fill", "rule_area>polyline>fill>type", "rule_area>polyline>uuid"]) {
      expect(held, path).toContain(path)
    }
  })

  it("flags the part it touches and not the one it does not, as KiCad 10 resolves a symbol's flags", () => {
    const flags = ruleAreaFlags(p)
    expect(flags.get(ref(p, "R2").id)).toEqual({ dnp: true, excludeFromBom: true, excludeFromSim: true })
    expect(flags.has(ref(p, "R1").id)).toBe(false)
    const eff = withRuleAreaFlags(p)
    expect(ref(eff, "R2").flags).toEqual({ dnp: true, excludeFromBom: true, excludeFromSim: true })
    expect(ref(eff, "R1").flags).toBeUndefined()
    // The project itself keeps the flags on the area only.
    expect(ref(p, "R2").flags).toBeUndefined()
  })

  it("takes a symbol the area only touches, not one wholly outside, and a symbol's own flag stays", () => {
    // An area that clips R2's top pin only.
    const clip = load(sheet([AREA("(dnp yes)", "(xy 40 66) (xy 65 66) (xy 65 80) (xy 40 80)")]))
    expect(ruleAreaFlags(clip).has(ref(clip, "R2").id)).toBe(true)
    // An area below everything.
    const below = load(sheet([AREA("(dnp yes)", "(xy 40 90) (xy 65 90) (xy 65 99) (xy 40 99)")]))
    expect(ruleAreaFlags(below).size).toBe(0)
    expect(withRuleAreaFlags(below)).toBe(below)
    // An area with no flags does nothing.
    const none = load(sheet([AREA("")]))
    expect(withRuleAreaFlags(none)).toBe(none)
  })

  it("is read by the BOM and the position file: a part in a do-not-populate area is out of both", () => {
    const rows = (csv: string) => csv.trim().split("\n").slice(1)
    expect(rows(bomCsv(p)).join("\n")).toContain("R1")
    expect(rows(bomCsv(p)).join("\n")).not.toContain("R2")
    expect(pnpCsv(p)).not.toContain("R2")
    // A part with the flag of its own and no area is out too, and the project with none of either lists both.
    const plain = load(sheet())
    expect(bomCsv(plain)).toContain("R2")
  })

  it("moves with the edit: a part moved out of the area takes the flags with it", () => {
    const r2 = ref(p, "R2")
    const moved: Project = { ...p, components: p.components.map((c) => (c.id === r2.id ? { ...c, sch: { ...c.sch, x: c.sch.x + 0.5 } } : c)) }
    expect(ruleAreaFlags(moved).has(r2.id)).toBe(true)
    const away: Project = { ...p, components: p.components.map((c) => (c.id === r2.id ? { ...c, sch: { ...c.sch, y: c.sch.y + 20 } } : c)) }
    expect(ruleAreaFlags(away).has(r2.id)).toBe(false)
  })

  it("takes the polygon's own shape, not its bounding box (a part in the notch of an L is not in it)", () => {
    // An L whose notch is the corner (52..65, 58..70): R2 is at x 50.8, so it touches the arm; a copy at x 60 does not.
    const l = "(xy 40 58) (xy 52 58) (xy 52 66) (xy 65 66) (xy 65 80) (xy 40 80)"
    // The symbols are written by hand with their fields hidden, so that only their bodies and pins are tested.
    const bare = (r: string, at: string, uuid: string) => `(symbol (lib_id "Device:R") (at ${at} 0) (unit 1) (exclude_from_sim no) (in_bom yes) (on_board yes) (dnp no) (uuid ${uuid})
      (property "Reference" "${r}" (at 0 0 0) (effects (font (size 1.27 1.27)) (hide yes)))
      (property "Value" "R" (at 0 0 0) (effects (font (size 1.27 1.27)) (hide yes)))
      (property "Footprint" "" (at 0 0 0) (effects (font (size 1.27 1.27)) (hide yes)))
      (pin "1" (uuid ${uuid}-p1)) (pin "2" (uuid ${uuid}-p2))
      (instances (project "demo" (path "/00000000-0000-4000-8000-000000000001" (reference "${r}") (unit 1)))))`
    const q = load(schematic({ version: VERSION, libs: [LIB_R], body: [bare("R5", "60 60", R1), bare("R6", "45 70", R2), AREA("(dnp yes)", l)] }))
    expect(ruleAreaFlags(q).has(ref(q, "R6").id)).toBe(true)
    expect(ruleAreaFlags(q).has(ref(q, "R5").id)).toBe(false)
  })
})

describe("S8: edits", () => {
  const p = load(sheet([directive("50.8 57.15 0", "Power"), AREA("(dnp yes)")]))

  it("a directive moved off its net leaves the class, and back onto it joins again; deleting it removes the class", () => {
    const d = dirs(p)[0]
    const off = { ...p, drawings: p.drawings!.map((x) => (x.id === d.id ? moveDrawing(x, { x: 3, y: 0 }) : x)) }
    const settled = settleLabelNetClasses(p, off)
    expect(settled.rules.netClasses).toBeUndefined()
    const back = { ...settled, drawings: settled.drawings!.map((x) => (x.id === d.id ? moveDrawing(x, { x: -3, y: 0 }) : x)) }
    expect(settleLabelNetClasses(settled, back).rules.netClasses).toEqual(p.rules.netClasses)
    const gone = settleLabelNetClasses(p, removeDrawings(p, [d.id]))
    expect(gone.rules.netClasses).toBeUndefined()
    expect((gone.drawings ?? []).some(isDirective)).toBe(false)
  })

  it("a directive's class changed in the Inspector changes the net's class; a class the project defines keeps its sizes", () => {
    const d = dirs(p)[0]
    const changed = settleLabelNetClasses(p, updateDrawings(p, [d.id], (x) => (isDirective(x) ? setDirectiveClass(x, "Clk") : x)))
    expect(changed.rules.netClasses).toEqual([{ name: "Clk", nets: [], labelNets: [MID], implicit: true }])
    const defined: Project = { ...p, rules: { ...p.rules, netClasses: [{ name: "Power", nets: [], traceWidth: 0.5 }] } }
    const settled = withLabelNetClasses(defined)
    expect(settled.rules.netClasses).toEqual([{ name: "Power", nets: [], traceWidth: 0.5, labelNets: [MID] }])
    expect(classValues(settled.rules, MID).traceWidth).toBe(0.5)
    // The class the project defines stays when the label goes; the one a label made does not.
    const without = settleLabelNetClasses(settled, removeDrawings(settled, [d.id]))
    expect(without.rules.netClasses).toEqual([{ name: "Power", nets: [], traceWidth: 0.5 }])
  })

  it("does no work on a project with no directive label, and returns the very same object", () => {
    const plain = load(sheet())
    expect(settleLabelNetClasses(plain, { ...plain, updatedAt: 5 })).toEqual({ ...plain, updatedAt: 5 })
    const next = { ...plain, updatedAt: 5 }
    expect(settleLabelNetClasses(plain, next)).toBe(next)
    expect(withLabelNetClasses(plain)).toBe(plain)
    expect(withRuleAreaFlags(plain)).toBe(plain)
    // A schematic edit that does not touch the labels leaves the classes as they were (the same list).
    const moved = { ...p, components: p.components.map((c) => (c.ref === "R1" ? { ...c, sch: { ...c.sch, x: c.sch.x } } : c)) }
    expect(settleLabelNetClasses(p, moved).rules.netClasses).toBe(p.rules.netClasses)
  })

  it("makes a new directive label with the class in its field", () => {
    const n = newDirective({ x: 1, y: 1 }, "Fast") as Omit<DrawingDirective, "id">
    expect(n).toMatchObject({ type: "directive", shape: "round", length: 0.2, rot: 0 })
    expect(n.fields).toHaveLength(1)
    expect(n.fields[0]).toMatchObject({ name: "Netclass", value: "Fast" })
  })

  it("survives a save and a load exactly", () => {
    const back = parseProjectFile(serializeProject(p), { id: p.id })
    expect(back.drawings).toEqual(p.drawings)
    expect(back.rules.netClasses).toEqual(p.rules.netClasses)
    expect(isRuleArea(back.drawings!.find((d) => d.type === "line")!)).toBe(true)
  })

  it("drops a rule area mark that is not on a closed line and malformed flags, and keeps what is valid", () => {
    const raw = JSON.parse(serializeProject(p))
    raw.project.drawings = raw.project.drawings.map((d: Record<string, unknown>) => (d.type === "line" ? { ...d, ruleArea: { dnp: "yes", excludeFromBom: true, junk: 1 } } : d))
    const back = parseProjectFile(JSON.stringify(raw), { id: p.id })
    expect((back.drawings!.find((d) => d.type === "line") as DrawingLine).ruleArea).toEqual({ excludeFromBom: true })
    raw.project.drawings = raw.project.drawings.map((d: Record<string, unknown>) => (d.type === "line" ? { ...d, closed: false } : d.type === "directive" ? { ...d, length: -1 } : d))
    const open = parseProjectFile(JSON.stringify(raw), { id: p.id })
    expect((open.drawings ?? []).some((d) => d.type === "directive")).toBe(false)
    expect((open.drawings!.find((d) => d.type === "line") as DrawingLine).ruleArea).toBeUndefined()
  })
})

describe("S8: the KiCad 9 file", () => {
  const p = load(sheet([directive("50.8 57.15 0", "Power"), AREA("(dnp yes) (in_bom no)")]))

  it("writes the directive label and the rule area as KiCad 9 reads them, and the area's flags on the symbols it touches", async () => {
    const out = await kicadFiles(p)
    const name = Object.keys(out.files).find((n) => n.endsWith(".kicad_sch"))!
    const text = String(out.files[name])
    expect(text).toMatch(/\(version 20250114\)/)
    // Every token of a directive label, a property and a rule area is one KiCad 9.0's parser reads in that place.
    expect(kicad9SheetProblems(text)).toEqual([])
    expect(text).toMatch(/\(netclass_flag/)
    // KiCad 9's parser reads nothing but the polyline in a rule area.
    const area = /\(rule_area[\s\S]*?\n {2}\)\n/.exec(text)![0]
    expect(area).toContain("(polyline")
    expect(area).not.toMatch(/\((dnp|in_bom|on_board|exclude_from_sim)\b/)
    expect(area).toContain("(uuid 22222222-0000-4000-8000-000000000002)")
    expect(text).toMatch(/\(netclass_flag ""\n {4}\(length 2\.54\)\n {4}\(shape round\)\n {4}\(at [\d.]+ [\d.]+ 0\)/)
    expect(text).toContain('(property "Netclass" "Power"')
    expect(text).toContain("(fields_autoplaced yes)")
    // R2 is in the area: it is written do not populate and out of the BOM, R1 is not.
    const sym = (r: string) => text.split("\n  (symbol\n").find((chunk) => chunk.includes(`(property "Reference" "${r}"`))!
    expect(sym("R2")).toMatch(/\(dnp yes\)/)
    expect(sym("R2")).toMatch(/\(in_bom no\)/)
    expect(sym("R1")).toMatch(/\(dnp no\)/)
  })

  it("reads back as the same directive, the same area polygon, the same classes and the same flags per symbol", async () => {
    const out = await kicadFiles(p)
    const name = Object.keys(out.files).find((n) => n.endsWith(".kicad_sch"))!
    const again = importKicadSchematic(String(out.files[name]))
    if (again.status !== "imported") throw new Error(`${again.message}\n${again.report.entries.map((e) => e.why).join("\n")}`)
    const q = again.project
    const [d0] = dirs(p)
    const [d1] = dirs(q)
    expect(d1).toMatchObject({ rot: 0, shape: "round", length: d0.length, text: "", fieldsAutoplaced: true, uuid: d0.uuid })
    expect(d1.fields.map((f) => [f.name, f.value])).toEqual(d0.fields.map((f) => [f.name, f.value]))
    // The export puts the sheet on its page: everything moved by the same amount, to the ten-thousandth of a unit the editor keeps a wire end to.
    const dx = d1.x - d0.x
    const dy = d1.y - d0.y
    const close = (a: number, b: number) => Math.abs(a - b) < 1e-4
    expect(d1.fields[0].place.angle).toBe(d0.fields[0].place.angle)
    expect(close(d1.fields[0].place.x, d0.fields[0].place.x) && close(d1.fields[0].place.y, d0.fields[0].place.y)).toBe(true)
    expect(areas(q)[0].points.every((pt, i) => close(pt.x - dx, areas(p)[0].points[i].x) && close(pt.y - dy, areas(p)[0].points[i].y))).toBe(true)
    expect(q.rules.netClasses).toEqual(p.rules.netClasses)
    // The flags are now the symbol's own, and the effective flags are the same.
    expect(ref(q, "R2").flags).toMatchObject({ dnp: true, excludeFromBom: true })
    expect(areas(q)[0].ruleArea).toEqual({ uuid: "22222222-0000-4000-8000-000000000002" })
    const eff = (x: Project) => x.components.map((c) => [c.ref, !!withRuleAreaFlags(x).components.find((y) => y.id === c.id)!.flags?.dnp])
    expect(eff(q)).toEqual(eff(p))
    expect(computeConnectivity(q).nets.map((n) => n.name).sort()).toEqual(computeConnectivity(p).nets.map((n) => n.name).sort())
  })

  it("writes every turn and shape of a directive, and a field of a plain label, the way KiCad 9 reads them", async () => {
    for (const shape of ["dot", "round", "diamond", "rectangle"]) {
      for (const turn of [0, 90, 180, 270]) {
        const q = load(sheet([directive(`50.8 57.15 ${turn}`, "Power").replace("(shape round)", `(shape ${shape})`)]))
        const out = await kicadFiles(q)
        const text = String(out.files[Object.keys(out.files).find((n) => n.endsWith(".kicad_sch"))!])
        expect(text, `${shape} ${turn}`).toContain(`(shape ${shape})`)
        const again = importKicadSchematic(text)
        expect(again.status, `${shape} ${turn}`).toBe("imported")
        if (again.status === "imported") expect(dirs(again.project)[0]).toMatchObject({ shape, rot: turn })
      }
    }
  })
})

describe("S8: hostile files and cost", () => {
  it("refuses a damaged directive label or rule area by name, and never reads a bad number as 0", () => {
    const bad = (body: string) => importKicadSchematic(sheet([body]))
    const length = bad(directive("50.8 57.15 0", "Power").replace("(length 2.54)", "(length abc)"))
    expect(length.status).toBe("refused")
    expect(length.report.entries.find((e) => e.code === "label-not-held")!.why).toMatch(/pin length "abc"/)
    expect(bad(directive("50.8 57.15 0", "Power").replace("(length 2.54)", "(length -3)")).status).toBe("refused")
    expect(bad(directive("50.8 57.15 0", "Power").replace("(at 50.8 57.15 0)", "(at 50.8 NaN 0)")).status).toBe("refused")
    expect(bad(AREA("(dnp yes)", "(xy 40 58) (xy 65 x) (xy 65 70)")).status).toBe("refused")
    expect(bad(AREA("(dnp yes)", "(xy 40 58) (xy 65 58)")).status).toBe("refused")
    for (const text of ["(netclass_flag)", '(netclass_flag "" (at 1 1 0))', "(rule_area)", "(rule_area (polyline))", "(rule_area (dnp maybe) (polyline (pts (xy 0 0) (xy 1 0) (xy 1 1))))"]) {
      const r = importKicadSchematic(sheet([text]))
      expect(["imported", "refused"], text).toContain(r.status)
    }
  })

  it("reads thousands of directive labels and big rule areas without a blow-up", () => {
    const many = Array.from({ length: 3000 }, (_, i) => directive(`${10 + (i % 60)} ${10 + Math.floor(i / 60)} 0`, `C${i % 7}`))
    const big = AREA("(dnp yes)", Array.from({ length: 20000 }, (_, i) => `(xy ${100 + 50 * Math.cos((i / 20000) * 2 * Math.PI)} ${100 + 50 * Math.sin((i / 20000) * 2 * Math.PI)})`).join(" "))
    const t0 = Date.now()
    const r = importKicadSchematic(sheet([...many, big]))
    expect(r.status === "imported" || r.status === "refused").toBe(true)
    expect(Date.now() - t0).toBeLessThan(20000)
  })

  it("costs nothing on a board with no directive label: the settle returns the very same object, on 2,000 parts, many times over", () => {
    const base = load(sheet())
    const parts = Array.from({ length: 2000 }, (_, i) => ({ ...base.components[0], id: `x${i}`, ref: `X${i}` }))
    const before: Project = { ...base, components: parts }
    const t0 = performance.now()
    let last: Project = before
    for (let i = 0; i < 2000; i++) {
      const next = { ...last, components: i % 2 ? last.components : [...last.components], updatedAt: i }
      const settled = settleLabelNetClasses(last, next)
      if (settled !== next) throw new Error("not the very same object")
      last = settled
    }
    expect(performance.now() - t0).toBeLessThan(500)
  })

  it("settles a sheet that has a directive label in a few milliseconds a commit", () => {
    const p = load(sheet([directive("50.8 57.15 0", "Power")]))
    const parts = Array.from({ length: 300 }, (_, i) => ({ ...p.components[0], id: `x${i}`, ref: `X${i}`, sch: { ...p.components[0].sch, x: 20 + i * 0.5 } }))
    const before: Project = { ...p, components: [...p.components, ...parts] }
    const after: Project = { ...before, wires: [...before.wires] }
    const t0 = performance.now()
    for (let i = 0; i < 20; i++) settleLabelNetClasses(before, { ...after, wires: [...after.wires] })
    expect((performance.now() - t0) / 20).toBeLessThan(250)
  })
})

describe("S8: copies", () => {
  it("a copy of a directive label or a rule area is another item: it has no KiCad uuid, and the copy still counts (a net it is on is in its class)", async () => {
    const { copyDrawings } = await import("../src/model/drawings")
    const p = load(sheet([directive("50.8 57.15 0", "Power"), AREA("(dnp yes)")]))
    const copies = copyDrawings(p.drawings!, { x: 0, y: 0 })
    expect(copies.map((c) => c.id)).not.toEqual(p.drawings!.map((c) => c.id))
    expect(copies.find(isDirective)!.uuid).toBeUndefined()
    expect(copies.find(isRuleArea)!.ruleArea.uuid).toBeUndefined()
    expect(copies.find(isRuleArea)!.ruleArea.dnp).toBe(true)
    expect(p.drawings!.find(isDirective)!.uuid).toBeDefined()
  })
})

describe("S8 with sheets (S1)", () => {
  it("a directive label on a sheet used twice puts the net of each use in its class", async () => {
    const { files, S1, S2 } = await import("./kicad-sheets-fixtures")
    const f = files([{ uuid: S1, name: "Power", y: 60.96 }, { uuid: S2, name: "Power2", y: 90 }])
    f.set("child.kicad_sch", f.get("child.kicad_sch")!.replace('(hierarchical_label "VIN"', `${directive("50.8 54.61 0", "Hier")} (hierarchical_label "VIN"`))
    const r = importKicadSchematic({ files: f, root: "root.kicad_sch" })
    if (r.status !== "imported") throw new Error(`${r.message}\n${r.report.entries.map((e) => e.why).join("\n")}`)
    const claims = labelNetClasses(r.project)
    expect([...claims.values()]).toEqual([["Hier"], ["Hier"]])
    expect(new Set(claims.keys()).size).toBe(2)
    expect(r.project.rules.netClasses?.[0]).toMatchObject({ name: "Hier", implicit: true })
    expect(r.project.rules.netClasses?.[0].labelNets).toHaveLength(2)
    // The directive belongs to the child sheet, which both uses share.
    expect(dirs(r.project)).toHaveLength(1)
    expect(dirs(r.project)[0].sheet).toBeDefined()
  })
})
