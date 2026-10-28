import { describe, expect, it } from "vitest"
import { runImport } from "../src/kicadImport/engine"
import { generatorLabel, reportText } from "../src/kicadImport/summary"
import { computeConnectivity } from "../src/model/connectivity"
import { importKicadProject, type KicadProjectResult, type ProjectFile } from "../src/model/kicad/project"
import { analyzePcb, derivedCopperNets } from "../src/model/pcb"
import { board, footprint, pad } from "./kicad-board-fixtures"
import { entry } from "./kicad-import-helpers"

// Three things a real project taught the importer: a via or trace in a copper pour is on the pour's net (the editor derives it, so the
// import does not report a difference), a `.kicad_pro`'s net classes and design rules are in the project, and the report says who wrote the file.
// The board is modelled on a tscircuit export (`circuit-json-to-kicad`): two GND pours with stitching vias that touch nothing but the pours.

const WRITER = `(generator "circuit-json-to-kicad") (generator_version "0.0.1")`
const zone = (net: string, layer: string, [x0, y0, x1, y1]: number[]) =>
  `(zone (net ${net ? 1 : 0}) (net_name "${net}") (layer "${layer}") (uuid "00000000-0000-4000-8000-0000000000${layer === "F.Cu" ? "01" : "02"}") (hatch edge 0.5) (connect_pads thru_hole_only (clearance 0.3)) (min_thickness 0.25) (fill yes (thermal_gap 0.3) (thermal_bridge_width 0.5)) (polygon (pts (xy ${x0} ${y0}) (xy ${x1} ${y0}) (xy ${x1} ${y1}) (xy ${x0} ${y1}))))`
let n = 0
const id = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`
const via = (x: number, y: number, net: number) => `(via (at ${x} ${y}) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net ${net}) (uuid "${id()}"))`
const seg = (x0: number, y0: number, x1: number, y1: number, layer: string, net: number) => `(segment (start ${x0} ${y0}) (end ${x1} ${y1}) (width 0.25) (layer "${layer}") (net ${net}) (uuid "${id()}"))`

/** R1 between VCC (pad 1) and GND (pad 2) on a 20 by 10 board, with GND pours on both sides over x 1..19, y 1..9. */
function fixture(extra: string[] = [], header = WRITER, pours = true) {
  return board({
    header,
    nets: ['(net 0 "")', '(net 1 "GND")', '(net 2 "VCC")'],
    body: [
      footprint({ ref: "R1", at: "10 5", pads: [pad({ number: "1", at: "-1 0", net: '(net 2 "VCC")' }), pad({ number: "2", at: "1 0", net: '(net 1 "GND")' })] }),
      zone(pours ? "GND" : "", "F.Cu", [1, 1, 19, 9]),
      zone(pours ? "GND" : "", "B.Cu", [1, 1, 19, 9]),
      // stitching vias: GND in the file, touching nothing but the pours
      via(4, 3, 1),
      via(16, 7, 1),
      ...extra,
    ],
  })
}

const PRO = JSON.stringify({
  meta: { version: 1 },
  net_settings: {
    classes: [
      { name: "Default", track_width: 0.25, clearance: 0.2, via_diameter: 0.6, via_drill: 0.3 },
      { name: "Trace 0.75 mm", priority: 0, track_width: 0.75, clearance: 0.2, via_diameter: 0.6, via_drill: 0.3 },
      { name: "Trace 1 mm", priority: 1, track_width: 1, clearance: 0.2, via_diameter: 0.6, via_drill: 0.3 },
    ],
    netclass_patterns: [{ netclass: "Trace 0.75 mm", pattern: "GND" }],
    netclass_assignments: { VCC: ["Trace 1 mm"] },
  },
  board: {
    design_settings: {
      rules: { min_clearance: 0.2, min_track_width: 0.15, min_via_diameter: 0.46, min_through_hole_diameter: 0.2, min_copper_edge_clearance: 0.5, min_hole_clearance: 0.2 },
      defaults: { track_widths: [0, 0.15, 0.25, 0.4, 0.75, 1], via_dimensions: [{ diameter: 0, drill: 0 }, { diameter: 0.6, drill: 0.3 }, { diameter: 0.8, drill: 0.4 }] },
    },
  },
})

const files = (pcb: string, pro?: string): ProjectFile[] => [{ path: "demo.kicad_pcb", data: pcb }, ...(pro ? [{ path: "demo.kicad_pro", data: pro }] : [])]
const ok = (r: KicadProjectResult) => {
  if (r.status !== "imported") throw new Error(`refused (${r.reason}): ${r.message}`)
  return r
}
const differs = (r: ReturnType<typeof ok>) => r.report.entries.find((e) => e.code === "copper-net-differs")

describe("a via or trace inside a pour is on the pour's net", () => {
  it("the stitching vias of the board are not a difference the report lists", () => {
    const r = ok(importKicadProject(files(fixture())))
    expect(r.project.vias.map((v) => v.routedNet)).toEqual(["GND", "GND"])
    expect(differs(r)).toBeUndefined()
  })

  it("derives the pour's net for a via and for a trace that touch no pad", () => {
    const r = ok(importKicadProject(files(fixture([seg(6, 3, 8, 3, "F.Cu", 1)]))))
    const conn = computeConnectivity(r.project)
    const d = derivedCopperNets(r.project, conn)
    const gnd = conn.nets.find((net) => net.name === "GND")!.id
    expect(r.project.vias.map((v) => d.viaNet.get(v.id))).toEqual([gnd, gnd])
    expect(r.project.traces.map((t) => d.traceNet.get(t.id))).toEqual([gnd])
    expect(differs(r)).toBeUndefined()
  })

  it("Checks find the board connected: no short, and the stitching vias are not unrouted", () => {
    const r = ok(importKicadProject(files(fixture([seg(6, 3, 8, 3, "F.Cu", 1)]))))
    const conn = computeConnectivity(r.project)
    const a = analyzePcb(r.project, conn)
    expect(a.violations.filter((v) => v.kind === "short")).toEqual([])
    const stitching = r.project.vias.map((v) => ({ x: v.x, y: v.y }))
    expect(a.ratsnest.filter((l) => [l.a, l.b].some((p) => stitching.some((v) => v.x === p.x && v.y === p.y)))).toEqual([])
  })

  it("a via outside every pour whose file says GND is still a difference", () => {
    const r = ok(importKicadProject(files(fixture([via(0.5, 0.5, 1)]))))
    expect(differs(r)?.count).toBe(1)
    expect(differs(r)?.items?.[0]).toMatch(/GND.*no net/)
  })

  it("a via of another net inside a pour keeps its own net: that is clearance, not a change of net", () => {
    // on the VCC pad of R1, inside the GND pours
    const r = ok(importKicadProject(files(fixture([via(9, 5, 2)]))))
    const conn = computeConnectivity(r.project)
    const d = derivedCopperNets(r.project, conn)
    const vcc = conn.nets.find((net) => net.name === "VCC")!.id
    const v = r.project.vias.find((x) => x.routedNet === "VCC")!
    expect(d.viaNet.get(v.id)).toBe(vcc)
    expect(differs(r)).toBeUndefined()
  })

  it("a pour on no net connects nothing, and a via beyond the pours' polygon is not in them", () => {
    const r = ok(importKicadProject(files(fixture([], WRITER, false))))
    expect(differs(r)?.count).toBe(2)
    const far = ok(importKicadProject(files(fixture([via(19.6, 9.6, 1)]))))
    expect(differs(far)?.count).toBe(1)
  })
})

describe("the project file's net classes and design rules", () => {
  it("sets the Default class, the other classes with their nets and patterns, and the board's rules", () => {
    const rules = ok(importKicadProject(files(fixture(), PRO))).project.rules
    expect([rules.clearance, rules.traceWidth, rules.viaDiameter, rules.viaDrill]).toEqual([0.2, 0.25, 0.6, 0.3])
    expect(rules.netClasses?.map((c) => [c.name, c.traceWidth, c.nets, c.patterns])).toEqual([
      ["Trace 0.75 mm", 0.75, [], ["GND"]],
      ["Trace 1 mm", 1, ["VCC"], undefined],
    ])
    expect(rules.minClearance).toBe(0.2)
    expect(rules.minTraceWidth).toBe(0.15)
    expect(rules.minViaDiameter).toBe(0.46)
    expect(rules.minDrill).toBe(0.2)
    expect(rules.edgeClearance).toBe(0.5)
    expect(rules.preferredWidths).toEqual([0.15, 0.25, 0.4, 0.75, 1])
    expect(rules.viaSizes).toEqual([{ diameter: 0.8, drill: 0.4 }])
  })

  it("says what it brought and what it could not, and no longer says the rules are pending", () => {
    const r = ok(importKicadProject(files(fixture(), PRO)))
    const entries = r.report.entries
    expect(entries.some((e) => e.code === "rules-in-project-file")).toBe(false)
    expect(entries.find((e) => e.code === "rules-from-project-file")?.why).toMatch(/Trace 0\.75 mm, Trace 1 mm.*1 listed net and 1 pattern/)
    expect(entries.find((e) => e.code === "rules-not-brought")?.why).toMatch(/min_hole_clearance 0\.2/)
    expect(r.accounts.pro?.importedPaths.get("net_settings>classes[]>track_width")).toBe(3)
  })

  it("a Default class with the editor's own numbers and nothing else changes nothing", () => {
    const plain = JSON.stringify({ meta: { version: 1 }, net_settings: { classes: [{ name: "Default", clearance: 0.2, track_width: 0.25, via_diameter: 0.6, via_drill: 0.3 }] } })
    const r = ok(importKicadProject(files(fixture(), plain)))
    expect(r.report.entries.some((e) => e.code === "rules-from-project-file")).toBe(false)
    expect(r.project.rules.netClasses).toBeUndefined()
  })

  it("a net two classes claim, or a pattern naming a class the file lacks, is not guessed", () => {
    const twice = JSON.stringify({ meta: { version: 1 }, net_settings: { classes: [{ name: "Default" }, { name: "A", track_width: 0.5 }, { name: "B", track_width: 0.6 }], netclass_assignments: { VCC: ["A", "B"] } } })
    const r = importKicadProject(files(fixture(), twice))
    expect(r.status).toBe("refused")
    if (r.status === "refused") expect(r.message).toMatch(/net "VCC" is claimed by more than one class/)
    const missing = JSON.stringify({ meta: { version: 1 }, net_settings: { classes: [{ name: "Default" }], netclass_patterns: [{ netclass: "Nope", pattern: "GND" }] } })
    expect(importKicadProject(files(fixture(), missing)).status).toBe("refused")
  })

  it("custom rules in a .kicad_dru are read but not applied, and the report says so", () => {
    const dru = `(version 1)\n(rule "HV clearance" (condition "A.NetClass == 'HV'") (constraint clearance (min 1mm)))\n`
    const r = ok(importKicadProject([...files(fixture(), PRO), { path: "demo.kicad_dru", data: dru }]))
    const note = r.report.entries.find((e) => e.code === "custom-rules-not-applied")!
    expect(note.severity).toBe("note")
    expect(note.why).toMatch(/"HV clearance".*no language for custom rules/)
    expect(r.project.rules.netClasses?.length).toBe(2)
  })

  it("a board alone still says its rules are in a project file it did not read", () => {
    const r = ok(importKicadProject(files(fixture())))
    expect(r.report.entries.find((e) => e.code === "rules-in-project-file")?.why).toMatch(/\.kicad_pro/)
  })
})

describe("who wrote the file", () => {
  it("names KiCad by its release and any other program by its own name", () => {
    expect(generatorLabel("pcbnew", "9.0")).toBe("KiCad 9.0")
    expect(generatorLabel("eeschema", "8.0")).toBe("KiCad 8.0")
    expect(generatorLabel(null, "6.99")).toBe("KiCad 6.99")
    expect(generatorLabel("circuit-json-to-kicad", "0.0.1")).toBe("circuit-json-to-kicad 0.0.1")
    expect(generatorLabel("circuit-json-to-kicad", null)).toBe("circuit-json-to-kicad")
    expect(generatorLabel(null, null)).toBeNull()
  })

  const reportOf = async (pcb: string) => {
    let text = ""
    await runImport({ type: "start", id: 1, files: [entry("demo.kicad_pcb", pcb)] }, (e) => {
      if (e.type === "done") text = reportText(e.outcome.summary, "demo")
    })
    return text
  }

  it("the report's header says circuit-json-to-kicad for a tscircuit export and KiCad for a KiCad file", async () => {
    expect(await reportOf(fixture())).toMatch(/\(written by circuit-json-to-kicad 0\.0\.1\)/)
    expect(await reportOf(fixture([], `(generator "pcbnew") (generator_version "9.0")`))).toMatch(/\(written by KiCad 9\.0\)/)
  })
})
