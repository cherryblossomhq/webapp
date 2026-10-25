import { describe, expect, it } from "vitest"
import { runTool } from "../src/ai/tools"
import { gerberMask, gerberPaste } from "../src/export/gerber"
import { applyProjectSettings } from "../src/export/kicadPost"
import { autoroute } from "../src/model/autoroute"
import { computeConnectivity, pinKey } from "../src/model/connectivity"
import { buildKicadProject, BUILT_EXTENSIONS, importKicadBoard, outlineOf, readKicadBoard, type ImportReport } from "../src/model/kicad/board"
import { accountNodes, countPaths } from "../src/model/kicad/board/account"
import { settleFor } from "../src/model/kicad/board/carried"
import { needsOf, unbuilt } from "../src/model/kicad/board/needs"
import { classIndex, pairClearance } from "../src/model/netClasses"
import { analyzePcb } from "../src/model/pcb"
import { parseProjectFile, serializeProject } from "../src/model/projectFile"
import type { Project } from "../src/model/types"
import { board, footprint, pad } from "./kicad-board-fixtures"

// Net classes and design rules (X10), as the importer reads them from a KiCad 4 or 5 board, which keeps its classes in the board file.

const K5 = { version: 20171130, header: "(host pcbnew 5.1.12)" }
const klass = (name: string, fields: Partial<Record<"clearance" | "trace_width" | "via_dia" | "via_drill" | "uvia_dia" | "uvia_drill", number | null>> = {}, extra = "", description = "") => {
  const f = { clearance: 0.2, trace_width: 0.25, via_dia: 0.8, via_drill: 0.4, uvia_dia: 0.3, uvia_drill: 0.1, ...fields }
  const nodes = Object.entries(f)
    .filter(([, v]) => v !== null)
    .map(([k, v]) => `(${k} ${v})`)
    .join(" ")
  return `(net_class ${name.includes(" ") ? `"${name}"` : name} "${description}" ${nodes} ${extra})`
}
const NETS = ['(net 0 "")', "(net 1 GND)", "(net 2 VCC)", "(net 3 SIG)", "(net 4 /A/B)"]
const k5 = (classes: string[], setup = "(setup (pad_to_mask_clearance 0))", nets = NETS, pads: [string, string][] = [["1", "GND"], ["2", "VCC"], ["3", "SIG"]]) =>
  board({ ...K5, setup, nets, body: [fpWith(pads), ...classes] })
function fpWith(pads: [string, string][]) {
  const idx = (name: string) => NETS.findIndex((n) => new RegExp(`^\\(net \\d+ ${name.replace(/[/]/g, "\\/")}\\)$`).test(n))
  return footprint({ token: "module", at: "10 5", pads: pads.map(([number, net], i) => pad({ number, at: `${i * 2 - 2} 0`, net: net ? `(net ${idx(net)} ${net})` : undefined })) })
}
const imp = (text: string, built: ReadonlySet<string> = BUILT_EXTENSIONS) => {
  const r = importKicadBoard(text, { built })
  if (r.status !== "imported") throw new Error(`refused: ${r.message}\n${r.report.entries.map((e) => e.why).join("\n")}`)
  return r
}
const refused = (text: string) => {
  const r = importKicadBoard(text)
  if (r.status === "imported") throw new Error("imported")
  return r
}

describe("net classes of a KiCad 5 board", () => {
  const text = k5([
    klass("Default", {}, "(add_net GND) (add_net SIG)"),
    klass("Power", { clearance: 0.3, trace_width: 0.6, via_dia: 1, via_drill: 0.5 }, "(add_net VCC) (add_net GND)".replace(" (add_net GND)", ""), "Supplies"),
    klass("HV", { clearance: 0.6, trace_width: 0.3, uvia_dia: 0.5 }, "(diff_pair_width 0.18) (diff_pair_gap 0.22) (add_net /A/B)"),
  ])
  it("imports, and each class is a class of the project with its nets by the labels they have there", () => {
    const r = imp(text)
    expect(r.project.rules.netClasses).toEqual([
      { name: "Power", nets: ["VCC"], clearance: 0.3, traceWidth: 0.6, viaDiameter: 1, viaDrill: 0.5, description: "Supplies" },
      { name: "HV", nets: ["/A/B"], clearance: 0.6, traceWidth: 0.3, viaDiameter: 0.8, viaDrill: 0.4, microViaDiameter: 0.5, diffPairWidth: 0.18, diffPairGap: 0.22 },
    ])
    // the Default class is the rules, and says nothing else: its description is KiCad's, its micro via size is KiCad's
    expect(r.project.rules).toMatchObject({ clearance: 0.2, traceWidth: 0.25, viaDiameter: 0.8, viaDrill: 0.4 })
    expect(r.project.rules).not.toHaveProperty("defaultClass")
    expect(classIndex(r.project.rules).classOf("VCC")?.name).toBe("Power")
    expect(classIndex(r.project.rules).classOf("GND")).toBeNull()
  })
  it("the nets of a class are found by the project's own connectivity, and checked at the larger of their classes", () => {
    const r = imp(text)
    const conn = computeConnectivity(r.project)
    const names = new Set(conn.nets.map((n) => n.name))
    for (const n of ["VCC", "GND", "SIG"]) expect(names.has(n)).toBe(true)
    expect(pairClearance(r.project.rules, "VCC", "GND")).toBe(0.3)
    expect(pairClearance(r.project.rules, "GND", "SIG")).toBe(0.2)
    expect(pairClearance(r.project.rules, "VCC", "/A/B")).toBe(0.6)
  })
  it("the project saves and loads with the classes as they were", () => {
    const r = imp(text)
    const back = parseProjectFile(serializeProject(r.project), { id: "p" })
    expect(back.rules).toEqual(r.project.rules)
  })
  it("the Default class's own description (a translation) and micro via size and pair are kept; its listed nets say nothing", () => {
    const r = imp(k5([klass("Default", { uvia_dia: 0.508 }, "(diff_pair_width 0.2) (diff_pair_gap 0.25) (add_net GND)", "Dies ist die voreingestellte Netzklasse.")]))
    expect(r.project.rules.defaultClass).toEqual({ description: "Dies ist die voreingestellte Netzklasse.", microViaDiameter: 0.508, diffPairWidth: 0.2, diffPairGap: 0.25 })
    expect(r.project.rules.netClasses).toBeUndefined()
  })
  it("a class's micro via size that is the Default class's is left to it; one that is not, is kept", () => {
    const r = imp(k5([klass("Default", { uvia_dia: 0.508, uvia_drill: 0.254 }), klass("A", { uvia_dia: 0.508, uvia_drill: 0.127 }, "(add_net VCC)")]))
    expect(r.project.rules.netClasses![0]).toMatchObject({ name: "A", microViaDrill: 0.127 })
    expect(r.project.rules.netClasses![0]).not.toHaveProperty("microViaDiameter")
    expect(r.project.rules.defaultClass).toEqual({ microViaDiameter: 0.508, microViaDrill: 0.254 })
  })
  it("a board whose only class is the plain Default has no classes in the project, and imports as it did", () => {
    const r = imp(k5([klass("Default", {}, "(add_net GND) (add_net VCC) (add_net SIG)", "This is the default net class.")]))
    expect(r.project.rules.netClasses).toBeUndefined()
    expect(r.project.rules.defaultClass).toBeUndefined()
    expect(r.report.account!.importedPaths.has("net_class")).toBe(false)
    expect(r.report.account!.importedPaths.has("net_class>add_net")).toBe(false)
  })
  it("nets a class lists that have no pad or copper are kept by name and counted in the report", () => {
    const r = imp(k5([klass("Default"), klass("Ghost", {}, "(add_net VCC) (add_net NOPE)")]))
    expect(r.project.rules.netClasses![0].nets).toEqual(["VCC", "NOPE"])
    expect(r.report.entries.find((e) => e.code === "net-class-unknown-nets")?.count).toBe(1)
  })
  it("nets of two names that read alike keep their own labels, and the class lists the right one", () => {
    const nets = ['(net 0 "")', '(net 1 "/A/B")', '(net 2 "/A{slash}B")']
    const body = [
      footprint({ token: "module", pads: [pad({ number: "1", at: "-1 0", net: '(net 1 "/A/B")' }), pad({ number: "2", at: "1 0", net: '(net 2 "/A{slash}B")' })] }),
      klass("Default"),
      klass("X", {}, '(add_net "/A{slash}B")'),
    ]
    const r = imp(board({ ...K5, setup: "(setup (pad_to_mask_clearance 0))", nets, body }))
    const c = computeConnectivity(r.project)
    const fpId = r.project.components[0].id
    const net2 = c.nets.find((n) => n.id === c.pinNet.get(pinKey(fpId, "2")))!.name
    expect(r.project.rules.netClasses![0].nets).toEqual([net2])
    expect(net2).not.toBe(c.nets.find((n) => n.id === c.pinNet.get(pinKey(fpId, "1")))!.name)
  })
})

describe("what the importer cannot take exactly it refuses", () => {
  it("two classes of one name, a net in two classes, a class that leaves a field out or has a size that is no number", () => {
    const msg = (classes: string[]) => refused(k5(classes)).message
    expect(msg([klass("Default"), klass("A", {}, "(add_net VCC)"), klass("A", {}, "(add_net GND)")])).toMatch(/two net classes named "A"/)
    expect(msg([klass("Default"), klass("A", {}, "(add_net VCC)"), klass("B", {}, "(add_net VCC)")])).toMatch(/listed in the net classes "A" and "B"/)
    expect(msg([klass("Default"), klass("A", { via_drill: null }, "(add_net VCC)")])).toMatch(/leaves out via_drill/)
    expect(msg([klass("Default"), klass("A", { trace_width: 0 }, "(add_net VCC)")])).toMatch(/trace_width that is not a positive number/)
  })
  it("a creepage rule the editor cannot check is refused by name (X26), and a zero one is not", () => {
    const r = refused(board({ setup: "(setup (pad_to_mask_clearance 0) (creepage 2))", body: [footprint({ pads: [pad({ at: "0 0" })] })] }))
    expect(r.needs.map((n) => n.ext)).toEqual(["X26"])
    expect(r.message).toMatch(/creepage/)
    imp(board({ setup: "(setup (pad_to_mask_clearance 0) (creepage 0))", body: [footprint({ pads: [pad({ at: "0 0" })] })] }))
  })
  it("a board with classes but none named Default does not take a class's sizes for the rules", () => {
    const r = imp(k5([klass("Power", { clearance: 0.9, trace_width: 0.9 }, "(add_net VCC)")], "(setup (trace_clearance 0.21) (via_size 0.7) (via_drill 0.35) (pad_to_mask_clearance 0))"))
    expect(r.project.rules).toMatchObject({ clearance: 0.21, viaDiameter: 0.7, viaDrill: 0.35 })
    expect(r.project.rules.traceWidth).not.toBe(0.9)
  })
})

describe("the rules of setup", () => {
  const rulesOf = (setup: string, version = 20240108) => imp(board({ version, setup, body: [footprint({ pads: [pad({ at: "0 0" })] })] })).project.rules
  it("user_via and user_diff_pair are the sizes offered while routing", () => {
    const r = rulesOf("(setup (user_via 0.8 0.4) (user_via 1 0.6) (user_via 0.8 0.4) (user_diff_pair 0.2 0.25 0.3) (user_diff_pair 0.15 0.2) (pad_to_mask_clearance 0))")
    expect(r.viaSizes).toEqual([{ diameter: 0.8, drill: 0.4 }, { diameter: 1, drill: 0.6 }])
    expect(r.diffPairSizes).toEqual([{ width: 0.2, gap: 0.25, viaGap: 0.3 }, { width: 0.15, gap: 0.2 }])
  })
  it("a mask web, a paste ratio, a board minimum clearance, a max_error of its own and mask bridges are rules; KiCad's defaults are not", () => {
    const r = rulesOf("(setup (pad_to_mask_clearance 0) (solder_mask_min_width 0.1) (pad_to_paste_clearance_ratio -0.1) (clearance_min 0.15) (max_error 0.01) (allow_soldermask_bridges_in_footprints yes))")
    expect(r).toMatchObject({ maskMinWidth: 0.1, pasteRatio: -0.1, minClearance: 0.15, maxError: 0.01, maskBridgesInParts: true })
    const d = rulesOf("(setup (pad_to_mask_clearance 0) (solder_mask_min_width 0) (pad_to_paste_clearance_ratio 0) (clearance_min 0) (max_error 0.005) (allow_soldermask_bridges_in_footprints no))")
    for (const k of ["maskMinWidth", "pasteRatio", "minClearance", "maxError", "maskBridgesInParts"]) expect(d).not.toHaveProperty(k)
  })
  it("the smallest through hole drill and via drill are two rules when they differ, and one when they do not", () => {
    expect(rulesOf("(setup (pad_to_mask_clearance 0) (through_hole_min 0.3) (via_min_drill 0.2))")).toMatchObject({ minDrill: 0.3, minViaDrill: 0.2 })
    const same = rulesOf("(setup (pad_to_mask_clearance 0) (through_hole_min 0.3) (via_min_drill 0.3))")
    expect(same.minDrill).toBe(0.3)
    expect(same).not.toHaveProperty("minViaDrill")
    expect(rulesOf("(setup (pad_to_mask_clearance 0) (via_min_drill 0.25))")).toMatchObject({ minDrill: 0.25 })
  })
  it("a via size that is no two positive numbers is refused", () => {
    expect(refused(board({ setup: "(setup (user_via 0.8 0) (pad_to_mask_clearance 0))", body: [footprint({ pads: [pad({ at: "0 0" })] })] })).message).toMatch(/user_via/)
  })
})

describe("every node of X10 that is counted as imported is in the built project", () => {
  const text = board({
    ...K5,
    nets: NETS,
    setup:
      "(setup (last_trace_width 0.3) (trace_min 0.15) (trace_clearance 0.2) (via_size 0.8) (via_drill 0.4) (via_min_size 0.45) (via_min_drill 0.25) (user_via 0.9 0.5) (user_diff_pair 0.2 0.25 0.3) (solder_mask_min_width 0.12) (pad_to_paste_clearance_ratio -0.05) (clearance_min 0.1) (max_error 0.02) (allow_soldermask_bridges_in_footprints yes) (pad_to_mask_clearance 0.05))",
    body: [
      fpWith([["1", "GND"], ["2", "VCC"], ["3", "SIG"]]),
      klass("Default", { uvia_dia: 0.4 }, "(diff_pair_width 0.21) (diff_pair_gap 0.26) (add_net GND)", "Beschreibung"),
      klass("Power", { clearance: 0.3, trace_width: 0.6, via_dia: 1, via_drill: 0.5, uvia_dia: 0.45, uvia_drill: 0.12 }, "(diff_pair_width 0.1) (diff_pair_gap 0.12) (add_net VCC)", "Supplies"),
    ],
  })
  it("every imported path has a check, and every check holds", () => {
    const read = readKicadBoard(text)
    const b = read.board
    const outline = outlineOf(b)
    const paths = countPaths(b.tree)
    const needs = needsOf(b, { paths }, outline)
    expect(unbuilt(needs).map((n) => n.ext)).toEqual([])
    const account = accountNodes(b.tree, read.text, new Set(unbuilt(needs).map((n) => n.ext)), paths, settleFor(b))
    const report: ImportReport = { entries: [], account }
    const p = buildKicadProject(b, outline, report, { allowLossy: true }).project
    const r = p.rules
    const power = r.netClasses?.[0]
    const checks: [RegExp, () => boolean][] = [
      [/^setup(>trace_min|>pad_to_mask_clearance|>via_min_size|>via_min_drill)?$/, () => r.minTraceWidth === 0.15 && r.maskExpansion === 0.05 && r.minViaDiameter === 0.45 && r.minDrill === 0.25],
      [/^setup>user_via$/, () => JSON.stringify(r.viaSizes) === JSON.stringify([{ diameter: 0.9, drill: 0.5 }])],
      [/^setup>user_diff_pair$/, () => JSON.stringify(r.diffPairSizes) === JSON.stringify([{ width: 0.2, gap: 0.25, viaGap: 0.3 }])],
      [/^setup>solder_mask_min_width$/, () => r.maskMinWidth === 0.12],
      [/^setup>pad_to_paste_clearance_ratio$/, () => r.pasteRatio === -0.05],
      [/^setup>clearance_min$/, () => r.minClearance === 0.1],
      [/^setup>max_error$/, () => r.maxError === 0.02],
      [/^setup>allow_soldermask_bridges_in_footprints$/, () => r.maskBridgesInParts === true],
      [/^net_class$/, () => power?.name === "Power" && power.description === "Supplies" && r.defaultClass?.description === "Beschreibung"],
      [/^net_class>clearance$/, () => r.clearance === 0.2 && power?.clearance === 0.3],
      [/^net_class>trace_width$/, () => r.traceWidth === 0.25 && power?.traceWidth === 0.6],
      [/^net_class>via_dia$/, () => r.viaDiameter === 0.8 && power?.viaDiameter === 1],
      [/^net_class>via_drill$/, () => r.viaDrill === 0.4 && power?.viaDrill === 0.5],
      [/^net_class>uvia_dia$/, () => r.defaultClass?.microViaDiameter === 0.4 && power?.microViaDiameter === 0.45],
      [/^net_class>uvia_drill$/, () => power?.microViaDrill === 0.12 && r.defaultClass?.microViaDrill === undefined],
      [/^net_class>diff_pair_width$/, () => r.defaultClass?.diffPairWidth === 0.21 && power?.diffPairWidth === 0.1],
      [/^net_class>diff_pair_gap$/, () => r.defaultClass?.diffPairGap === 0.26 && power?.diffPairGap === 0.12],
      [/^net_class>add_net$/, () => JSON.stringify(power?.nets) === JSON.stringify(["VCC"])],
    ]
    const imported = [...account.importedPaths.keys()].filter((k) => /^(setup|net_class)/.test(k))
    expect(imported).toEqual(expect.arrayContaining(["setup>user_via", "setup>user_diff_pair", "setup>solder_mask_min_width", "net_class", "net_class>uvia_dia", "net_class>add_net", "net_class>diff_pair_gap"]))
    const unchecked = imported.filter((path) => !checks.some(([re]) => re.test(path)))
    expect(unchecked).toEqual([])
    const failed = imported.filter((path) => checks.filter(([re]) => re.test(path)).some(([, check]) => !check()))
    expect(failed).toEqual([])
    // the Default class's one listed net says nothing: of two add_net nodes one is imported, the Default's is not
    expect(account.importedPaths.get("net_class>add_net")).toBe(1)
    expect(account.importedPaths.get("net_class")).toBe(2)
  })
  it("the gate lets such a board in", () => {
    expect(importKicadBoard(text).status).toBe("imported")
  })
})

describe("an imported board with classes, through the editor's own machinery", () => {
  const text = k5(
    [klass("Default", { clearance: 0.15 }), klass("Wide", { clearance: 0.5, trace_width: 0.4, via_dia: 1, via_drill: 0.6 }, "(add_net VCC)")],
    "(setup (pad_to_mask_clearance 0) (solder_mask_min_width 0.3) (pad_to_paste_clearance_ratio -0.1))",
  )
  it("Checks run at the classes' clearances, the export and the Gerbers carry the rules, and Sakura reads them", async () => {
    const r = imp(text)
    const p = r.project
    expect(analyzePcb(p, computeConnectivity(p)).violations.filter((v) => v.kind === "clearance")).toEqual([])
    const design = JSON.parse(runTool(p, "get_design", {}).result).design_rules_mm
    expect(design.net_classes[0]).toMatchObject({ name: "Wide", clearance: 0.5, nets: ["VCC"] })
    expect(design.mask_min_width).toBe(0.3)
    expect(gerberMask(p, "top")).toMatch(/G36\*/)
    expect(gerberPaste(p, "top")).toMatch(/D03\*/)
    const pro = JSON.parse(applyProjectSettings(JSON.stringify({ board: { design_settings: { rules: {}, defaults: {} } }, net_settings: {} }), p).text)
    expect(pro.net_settings.classes.map((c: { name: string }) => c.name)).toEqual(["Default", "Wide"])
  })
  it("the router lays the board's classed net at its class's width, and a project with its copper cleared routes", () => {
    const r = imp(text)
    const p: Project = { ...r.project, traces: [], vias: [] }
    const res = autoroute(p, { timeLimitMs: 5000 })
    expect(analyzePcb(res.project, computeConnectivity(res.project)).violations.filter((v) => v.kind === "clearance")).toEqual([])
  })
})
