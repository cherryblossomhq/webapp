import { describe, expect, it } from "vitest"
import { runTool } from "../src/ai/tools"
import { bomCsv } from "../src/export/bom"
import { autoroute } from "../src/model/autoroute"
import { gerberPaste } from "../src/export/gerber"
import { kicadFiles } from "../src/export/kicad"
import { fabricationNotes } from "../src/export/notes"
import { followNetRenames } from "../src/model/copperNets"
import { clearImportedNoConnect, pruneImportMarks } from "../src/model/importMarks"
import { renameNets } from "../src/model/tidy"
import { pnpCsv } from "../src/export/pnp"
import { computeConnectivity, pinKey } from "../src/model/connectivity"
import { EXAMPLES } from "../src/model/examples"
import { isPhysical } from "../src/model/instances"
import { findPart } from "../src/model/library"
import { runErc, splitIgnored } from "../src/model/erc"
import { buildKicadProject, EXTENSION_NAMES, importKicadBoard, outlineOf, readKicadBoard, type KicadImportResult } from "../src/model/kicad/board"
import { scanAtoms, ruleFor } from "../src/model/kicad/board/account"
import { BUILT_EXTENSIONS, needsOf } from "../src/model/kicad/board/needs"
import { fillTester } from "../src/model/pour"
import { analyzePcb, derivedCopperNets } from "../src/model/pcb"
import { setFlags } from "../src/model/partFlags"
import { parseProjectFile, PROJECT_FILE_VERSION, serializeProject } from "../src/model/projectFile"
import type { Project } from "../src/model/types"
import { useProjectStore } from "../src/store/projectStore"
import { board, footprint, pad } from "./kicad-board-fixtures"

// Slice 1b-i: what the slice-1a critic left open (Part A), and the two extensions built end to
// end (Part B): X13, the net of every track and via, and X15, footprint flags and net ties.

const ALL = new Set(Object.keys(EXTENSION_NAMES))
type Imported = Extract<KicadImportResult, { status: "imported" }>
const imported = (text: string): Imported => {
  const r = importKicadBoard(text, { built: ALL })
  if (r.status !== "imported") throw new Error(`refused: ${r.message}\n${r.report.entries.map((e) => e.why).join("\n")}`)
  return r
}
const analysis = (project: Project) => analyzePcb(project, computeConnectivity(project))
const net = (n: number, name: string) => `(net ${n} "${name}")`

describe("A1: a net with one pad is not a warning after import", () => {
  const text = board({
    nets: ['(net 0 "")', net(1, "Net-(R1-Pad1)"), net(2, "TP_ADC"), net(3, "GND"), net(4, "unconnected-(R2-Pad1)")],
    body: [
      footprint({ ref: "R1", at: "5 5", pads: [pad({ number: "1", at: "-1 0", net: net(1, "Net-(R1-Pad1)") }), pad({ number: "2", at: "1 0", net: net(3, "GND") })] }),
      footprint({ ref: "R2", at: "12 5", pads: [pad({ number: "1", at: "-1 0", net: net(4, "unconnected-(R2-Pad1)") }), pad({ number: "2", at: "1 0", net: net(3, "GND") })] }),
      footprint({ ref: "TP1", name: "TestPoint:TestPoint_Pad_D1.0mm", at: "16 5", pads: [pad({ number: "1", at: "0 0", net: net(2, "TP_ADC") })] }),
    ],
  })
  const r = imported(text)
  const conn = computeConnectivity(r.project)
  const findings = runErc(r.project, conn)

  it("Checks has no lone-label finding left active, and the three nets keep their names", () => {
    const split = splitIgnored(findings, r.project.ignoredChecks)
    expect(findings.filter((f) => f.kind === "lone-label")).toHaveLength(3)
    expect(split.active.filter((f) => f.kind === "lone-label")).toEqual([])
    expect(split.ignored.filter((f) => f.kind === "lone-label")).toHaveLength(3)
    expect(r.project.labels.map((l) => l.name).sort()).toEqual(["GND", "GND", "Net-(R1-Pad1)", "TP_ADC", "unconnected-(R2-Pad1)"].sort())
    expect(conn.nets.map((n) => n.name).sort()).toEqual(["GND", "Net-(R1-Pad1)", "TP_ADC", "unconnected-(R2-Pad1)"])
  })
  it("a net with two pads is not ignored, and the keys are the checks' own", () => {
    expect([...(r.project.ignoredChecks ?? [])].sort()).toEqual(findings.filter((f) => f.kind === "lone-label").map((f) => f.key).sort())
    // R1 pin 2 and R2 pin 2 share GND: neither is a finding
    for (const ref of ["R1", "R2"]) {
      const c = r.project.components.find((x) => x.ref === ref)!
      expect(r.project.ignoredChecks).not.toContain(`lone-label:${c.id}:2`)
    }
  })
  it("one report note says how many, and how many are KiCad's own names", () => {
    const e = r.report.entries.filter((x) => x.code === "lone-labels-accepted")
    expect(e).toHaveLength(1)
    expect(e[0]).toMatchObject({ severity: "note", count: 3 })
    expect(e[0].why).toMatch(/2 of these are KiCad's own Net-\(\.\.\.\) or unconnected-\(\.\.\.\) names, 1 were named by hand/)
    expect(e[0].items).toHaveLength(3)
  })
  it("only the imported ones are accepted: a pin an edit leaves alone on its label is a new finding", () => {
    const p = r.project
    const r1 = p.components.find((c) => c.ref === "R1")!
    // the label nearest R1 is the one on its pin 2; renamed, R1 pin 2 and R2 pin 2 each have a net of one pin
    const gnd = p.labels.filter((l) => l.name === "GND")
    const nearest = gnd.sort((a, b) => Math.hypot(a.x - r1.sch.x, a.y - r1.sch.y) - Math.hypot(b.x - r1.sch.x, b.y - r1.sch.y))[0]
    const renamed = { ...p, labels: p.labels.map((l) => (l.id === nearest.id ? { ...l, name: "GNDX" } : l)) }
    const active = splitIgnored(runErc(renamed, computeConnectivity(renamed)), renamed.ignoredChecks).active.filter((f) => f.kind === "lone-label")
    expect(active.map((f) => f.subject).sort()).toEqual(["R1 pin 2", "R2 pin 2"])
  })
  it("a board with no single-pad net has no note and no ignored check", () => {
    const two = imported(board({ nets: ['(net 0 "")', net(1, "A")], body: [footprint({ pads: [pad({ number: "1", at: "-1 0", net: net(1, "A") }), pad({ number: "2", at: "1 0", net: net(1, "A") })] })] }))
    expect(two.report.entries.some((e) => e.code === "lone-labels-accepted")).toBe(false)
    expect(two.project.ignoredChecks).toBeUndefined()
  })
})

describe("A1: a pad with no net is no connect, and is not a warning either", () => {
  const text = board({
    nets: ['(net 0 "")', net(1, "A")],
    body: [footprint({ ref: "U1", at: "5 5", pads: [pad({ number: "1", at: "-2 0", net: net(1, "A") }), pad({ number: "2", at: "0 0" }), pad({ number: "10", at: "2 0" }), pad({ number: "3", at: "4 0", net: net(1, "A") })] })],
  })
  const r = imported(text)
  const c = computeConnectivity(r.project)
  it("marks the pins the file puts on no net, in pin order, and only those", () => {
    expect(r.project.components[0].nc).toEqual(["2", "10"])
  })
  it("Checks has no 'isn't connected' warning for them: they are no-connect pins", () => {
    expect(c.unconnectedPins).toEqual([])
    expect(c.ncPins.map((p) => p.pin).sort()).toEqual(["10", "2"])
  })
  it("one note says how many, and clearing the flag brings the warning back", () => {
    const e = r.report.entries.find((x) => x.code === "unconnected-pins-marked")!
    expect(e).toMatchObject({ severity: "note", count: 2, object: "2 pads with no net" })
    const cleared = { ...r.project, components: r.project.components.map(({ nc: _nc, ...x }) => x) }
    expect(computeConnectivity(cleared).unconnectedPins.map((p) => p.pin).sort()).toEqual(["10", "2"])
  })
  it("a board whose pads all have nets has no note and no flag", () => {
    const all = imported(board({ nets: ['(net 0 "")', net(1, "A")], body: [footprint({ pads: [pad({ number: "1", at: "-1 0", net: net(1, "A") }), pad({ number: "2", at: "1 0", net: net(1, "A") })] })] }))
    expect(all.project.components[0].nc).toBeUndefined()
    expect(all.report.entries.some((x) => x.code === "unconnected-pins-marked")).toBe(false)
  })
  it("the pad is still on no net, and the file's nets are unchanged", () => {
    const u1 = r.project.components[0]
    expect(c.pinNet.get(pinKey(u1.id, "2"))).toBeUndefined()
    expect(c.pinNet.get(pinKey(u1.id, "1"))).toBe("net:A")
  })
})

describe("A2: a side drawn in pieces is one line only when the joint lies on it to 0.001 mm", () => {
  const line = (a: string, b: string) => `(gr_line (start ${a}) (end ${b}) (stroke (width 0.1) (type default)) (layer "Edge.Cuts"))`
  const shape = (body: string[]) => outlineOf(readKicadBoard(board({ outline: body.join("\n") })).board)
  /** A 100 by 50 rectangle whose top side runs through (50, k): a kink of k mm. */
  const topKink = (k: number) => [line("0 0", `50 ${k}`), line(`50 ${k}`, "100 0"), line("100 0", "100 50"), line("100 50", "0 50"), line("0 50", "0 0")]
  it.each([0.05, 0.2, 0.4])("a %f mm kink in the top side is a polygon, not a rectangle", (k) => {
    const o = shape(topKink(k))
    expect(o.shape).toBe("polygon")
    expect(o.representable).toBe(false)
    const r = importKicadBoard(board({ outline: topKink(k).join("\n") }), { built: new Set([...ALL].filter((e) => e !== "X2")) })
    expect(r.status === "refused" && r.needs.map((n) => n.ext)).toContain("X2")
  })
  it("the repair does not merge the two pieces either: the kink is a corner of the outline", () => {
    expect(shape(topKink(0.05)).repair.merged).toBe(0)
  })
  it("a joint within 0.001 mm of the line still merges: the side is straight", () => {
    expect(shape(topKink(0.0004)).shape).toBe("rect")
    expect(shape(topKink(0)).shape).toBe("rect")
    expect(shape(topKink(0)).representable).toBe(true)
  })
  it("a kink in a side drawn the other way round, and at the start of the chain, is found too", () => {
    const left = [line("0 50", "-0.2 25"), line("-0.2 25", "0 0"), line("0 0", "100 0"), line("100 0", "100 50"), line("100 50", "0 50")]
    expect(shape(left).shape).toBe("polygon")
    // the chain starts mid-side: the first and the last piece are one side
    const wrap = [line("50 0.2", "100 0"), line("100 0", "100 50"), line("100 50", "0 50"), line("0 50", "0 0"), line("0 0", "50 0.2")]
    expect(shape(wrap).shape).toBe("polygon")
    const flat = [line("50 0", "100 0"), line("100 0", "100 50"), line("100 50", "0 50"), line("0 50", "0 0"), line("0 0", "50 0")]
    expect(shape(flat).shape).toBe("rect")
  })
  it("joints are checked against the whole merged line, not only against the piece before: a drift of 0.0018 mm does not merge", () => {
    // the first two pieces merge (the joint at x = 30 is on the line to x = 60); the line to x = 100 then leaves the joint at x = 60 0.0018 mm off
    const drift = [line("0 0", "30 0.0009"), line("30 0.0009", "60 0.0018"), line("60 0.0018", "100 0"), line("100 0", "100 50"), line("100 50", "0 50"), line("0 50", "0 0")]
    const o = shape(drift)
    expect(o.shape).toBe("polygon")
    expect(o.representable).toBe(false)
  })
  it("a side drawn twice, the second a little off, is still repaired and reported", () => {
    const doubled = [line("0 0", "100 0"), line("20 0.05", "80 0.05"), line("100 0", "100 50"), line("100 50", "0 50"), line("0 50", "0 0")]
    const o = shape(doubled)
    expect(o.repair.merged).toBe(1)
    expect(o.shape).toBe("rect")
  })
})

describe("A3: a pin type the editor's roles fold is reported", () => {
  const types = [
    ["1", "tri_state"],
    ["2", "open_collector"],
    ["3", "open_emitter"],
    ["4", "power_out"],
    ["5", "unspecified"],
    ["6", "passive+no_connect"],
    ["7", "passive"],
    ["8", "input"],
    ["9", "power_in"],
  ] as const
  const text = (list: readonly (readonly [string, string])[]) =>
    board({ body: [footprint({ ref: "U1", pads: list.map(([n, t], i) => pad({ number: n, at: `${i * 2} 0`, extra: `(pinfunction "P${n}") (pintype "${t}")` })) })] })
  it("names each pin with what its type became", () => {
    const r = imported(text(types))
    const e = r.report.entries.find((x) => x.code === "pin-type-folded")!
    expect(e.severity).toBe("changed")
    expect(e.count).toBe(6)
    expect(e.items).toEqual(["U1 pin 1 tri_state as output", "U1 pin 2 open_collector as output", "U1 pin 3 open_emitter as output", "U1 pin 4 power_out as power", "U1 pin 5 unspecified as no role", "U1 pin 6 passive+no_connect as nc"])
    expect(r.project.parts![0].pins.map((p) => p.kind)).toEqual(["output", "output", "output", "power", undefined, "nc", "passive", "input", "power"])
  })
  it("says nothing when every type is kept", () => {
    const r = imported(text(types.slice(6)))
    expect(r.report.entries.some((x) => x.code === "pin-type-folded")).toBe(false)
  })
  it("the file's own type stays in the board that was read", () => {
    const r = imported(text(types))
    expect(r.board.footprints[0].pads.map((p) => p.pinType)).toEqual(types.map(([, t]) => t))
  })
})

describe("A4: a bare word is a name only where a name goes", () => {
  const unknown = (text: string) => [...scanAtoms(text)].flatMap(([path, words]) => [...words.keys()].map((w) => `${path} ${w}`))
  it("(net 1 \"A\" frob) is an unknown word, and the board is not imported", () => {
    const text = board({ nets: ['(net 0 "")', '(net 1 "A" frob)'] })
    expect(unknown(text)).toEqual(["net frob"])
    const r = importKicadBoard(text, { built: ALL })
    expect(r.status === "refused" && r.reason).toBe("unknown")
    expect(r.report.entries.find((e) => e.code === "unknown-value")?.object).toBe('the word "frob" in "net"')
  })
  it("the same goes for the rest of the free rows: status, tags, a title block's comment, a pad's pin function (a tstamp or uuid node is not needed, so its words are not asked about)", () => {
    expect(unknown(board({ body: ["(segment (start 0 0) (end 1 0) (width 0.2) (layer F.Cu) (net 0) (status 40000 frob))"] }))).toEqual(["segment>status frob"])
    expect(unknown(board({ body: [footprint({ extra: "(tags SMD frob)", pads: [pad({ at: "0 0" })] })] }))).toEqual(["footprint>tags frob"])
    expect(unknown(board({ body: [footprint({ pads: [pad({ at: "0 0", extra: "(pinfunction A frob)" })] })] }))).toEqual(["footprint>pad>pinfunction frob"])
    expect(unknown(board({ body: ["(title_block (comment 1 x frob))"] }))).toEqual(["title_block>comment frob"])
  })
  it("a name where a name goes is fine: a bare net name (KiCad 5), a bare comment, a uuid, a bare pin function", () => {
    expect(unknown(board({ version: 20171130, header: "(host pcbnew 5.1.12)", nets: ['(net 0 "")', "(net 1 GND)"], body: [footprint({ token: "module", pads: [pad({ at: "0 0", net: "(net 1 GND)", extra: "(pinfunction A) (pintype passive)" })], extra: "(tags SMD)" }), "(title_block (title X) (comment 1 hello))"] }))).toEqual([])
    expect(unknown(board({ nets: ['(net "GND")'], body: ["(segment (start 0 0) (end 1 0) (width 0.2) (layer F.Cu) (net \"GND\") (uuid 5a1b2c3d-0000-4000-8000-000000000001))"] }))).toEqual([])
  })
})

describe("A5: via_size, via_drill and trace_clearance are the Default net class's, written twice", () => {
  const kicad5 = (setup: string, body: string[] = []) => board({ version: 20171130, header: "(host pcbnew 5.1.12)", setup, body })
  it("the decision note says so, and does not say toolbar for them", () => {
    for (const path of ["setup>via_size", "setup>via_drill", "setup>trace_clearance"]) {
      const rule = ruleFor(path)!
      expect(rule.decision).toBe("not-needed")
      expect(rule.note).toMatch(/Default net class's via size, via drill and clearance a second time/)
      expect(rule.note).not.toMatch(/toolbar/)
    }
    expect(ruleFor("setup>last_trace_width")!.note).toMatch(/toolbar/)
  })
  it("a board with no class block has them as its rules", () => {
    const r = imported(kicad5("(setup (via_size 0.9) (via_drill 0.5) (trace_clearance 0.25) (pad_to_mask_clearance 0))"))
    expect(r.project.rules).toMatchObject({ viaDiameter: 0.9, viaDrill: 0.5, clearance: 0.25 })
  })
  it("with a class block the class's values are the rules, as KiCad reads the block after the setup", () => {
    const r = imported(kicad5("(setup (via_size 0.9) (via_drill 0.5) (trace_clearance 0.25) (pad_to_mask_clearance 0))", ['(net_class Default "This is the default net class." (clearance 0.2) (trace_width 0.25) (via_dia 0.8) (via_drill 0.4) (uvia_dia 0.3) (uvia_drill 0.1))']))
    expect(r.project.rules).toMatchObject({ viaDiameter: 0.8, viaDrill: 0.4, clearance: 0.2 })
  })
})

describe("A6: a non-plated hole whose pad is larger than its drill is flagged whatever its copper", () => {
  const hole = (layers: string, size = "3 3") => board({ body: [footprint({ pads: [pad({ number: "", at: "0 0", type: "np_thru_hole", shape: "circle", size, layers, extra: "(drill 1)" })] })] })
  const x7 = (text: string) => {
    const r = importKicadBoard(text, { built: new Set([...ALL].filter((e) => e !== "X7")) })
    return r.status === "refused" ? r.needs.find((n) => n.ext === "X7") : undefined
  }
  it("a mask-only pad of 3 mm over a 1 mm drill needs X7, and says why", () => {
    expect(x7(hole('"F.Mask" "B.Mask"'))?.why).toMatch(/non-plated hole whose pad is larger than its drill/)
  })
  it("so does one with copper, one on a single mask layer, and one with no layer at all; one the size of its drill needs nothing", () => {
    for (const layers of ['"*.Cu" "*.Mask"', '"F.Mask"', ""]) expect(x7(hole(layers))?.why, layers).toMatch(/larger than its drill/)
    expect(x7(hole('"F.Mask" "B.Mask"', "1 1"))).toBeUndefined()
  })
})

describe("A7: the name exactly as written wins a label", () => {
  const text = board({
    nets: ['(net 0 "")', net(1, " GND"), net(2, "GND")],
    body: [
      footprint({ ref: "R1", at: "5 5", pads: [pad({ number: "1", at: "-1 0", net: net(1, " GND") }), pad({ number: "2", at: "1 0", net: net(2, "GND") })] }),
      footprint({ ref: "R2", at: "12 5", pads: [pad({ number: "1", at: "-1 0", net: net(2, "GND") }), pad({ number: "2", at: "1 0", net: net(1, " GND") })] }),
    ],
  })
  it("the file's GND keeps GND and the variant is GND (2), and the pins sit on the nets the file puts them on", () => {
    const r = imported(text)
    const c = computeConnectivity(r.project)
    const at = (ref: string, pin: string) => c.pinNet.get(pinKey(r.project.components.find((x) => x.ref === ref)!.id, pin))
    expect(at("R1", "2")).toBe("net:GND")
    expect(at("R2", "1")).toBe("net:GND")
    expect(at("R1", "1")).toBe("net:GND (2)")
    expect(at("R2", "2")).toBe("net:GND (2)")
  })
  it("is reported, with the variant quoted so its space shows", () => {
    const r = imported(text)
    const e = r.report.entries.find((x) => x.code === "renamed-net")!
    expect(e.object).toContain('" GND" as GND (2)')
    expect(e.why).toMatch(/spelled exactly as the name keeps it/)
  })
  it("the order of the nets in the file does not matter", () => {
    const flipped = board({
      nets: ['(net 0 "")', net(1, "GND"), net(2, " GND")],
      body: [footprint({ ref: "R1", at: "5 5", pads: [pad({ number: "1", at: "-1 0", net: net(2, " GND") }), pad({ number: "2", at: "1 0", net: net(1, "GND") })] })],
    })
    const r = imported(flipped)
    expect(r.project.labels.map((l) => l.name).sort()).toEqual(["GND", "GND (2)"])
    const c = computeConnectivity(r.project)
    expect(c.pinNet.get(pinKey(r.project.components[0].id, "2"))).toBe("net:GND")
  })
})

// ---------------------------------------------------------------------------------------------

/** R1 at (5, 5) and R2 at (12, 5), pads 1 mm square 2 mm either side of the centre: R1.2 (7, 5) and R2.1 (10, 5) are on A, R1.1 and R2.2 on GND. */
const twoParts = (copper: string[], opts: { version?: number; header?: string; layers?: string } = {}) =>
  board({
    ...opts,
    nets: ['(net 0 "")', net(1, "A"), net(2, "GND")],
    body: [
      footprint({ ref: "R1", at: "5 5", pads: [pad({ number: "1", at: "-2 0", net: net(2, "GND") }), pad({ number: "2", at: "2 0", net: net(1, "A") })] }),
      footprint({ ref: "R2", at: "12 5", pads: [pad({ number: "1", at: "-2 0", net: net(1, "A") }), pad({ number: "2", at: "2 0", net: net(2, "GND") })] }),
      ...copper,
    ],
  })
const seg = (a: string, b: string, n: string, extra = "", layer = "F.Cu") => `(segment (start ${a}) (end ${b}) (width 0.25) (layer "${layer}") ${n}${extra ? ` ${extra}` : ""})`

describe("X13: a trace and a via keep the net the file puts them on", () => {
  it("Trace.net and Via.routedNet are the nets' names; Via.net, which marks a stitching via, is not set", () => {
    const r = imported(twoParts([seg("7 5", "10 5", "(net 1)"), '(via (at 7 5) (size 0.8) (drill 0.4) (layers "F.Cu" "B.Cu") (net 1))']))
    expect(r.project.traces).toHaveLength(1)
    expect(r.project.traces[0].net).toBe("A")
    expect(r.project.vias[0].routedNet).toBe("A")
    expect(r.project.vias[0].net).toBeUndefined()
    expect(r.report.entries.some((e) => e.code === "copper-net-differs")).toBe(false)
    expect(r.board.segments[0].net).toBe("A")
  })
  it("copper with no net has none stored", () => {
    const r = imported(twoParts([seg("0 0", "2 0", "(net 0)")]))
    expect(r.project.traces[0].net).toBeUndefined()
  })
  it("segments on two nets that read alike are two traces with two names (the raw name is the identity)", () => {
    const text = board({
      nets: ['(net 0 "")', net(1, "/A/B"), net(2, "/A{slash}B")],
      body: [
        footprint({ ref: "R1", at: "5 5", pads: [pad({ number: "1", at: "-2 0", net: net(1, "/A/B") }), pad({ number: "2", at: "2 0", net: net(2, "/A{slash}B") })] }),
        seg("3 5", "5 5", "(net 1)"),
        seg("5 5", "7 5", "(net 2)"),
      ],
    })
    const r = imported(text)
    expect(r.project.traces).toHaveLength(2)
    expect(r.project.traces.map((t) => t.net).sort()).toEqual(["/A/B", "/A{slash}B"])
  })
  it("a net that only copper is on is named like any other, and its traces say so", () => {
    const r = imported(board({ nets: ['(net 0 "")', net(1, "STUB")], body: [seg("0 0", "2 0", "(net 1)")] }))
    expect(r.project.traces[0].net).toBe("STUB")
  })
  it("the KiCad 4 and 5 track lock bit is `locked`, and a locked and an unlocked segment are not joined", () => {
    const old = (a: string, b: string, status: string) => seg(a, b, "(net 0)", `(status ${status})`, "F.Cu").replace('"F.Cu"', "F.Cu")
    const r = imported(board({ version: 20171130, header: "(host pcbnew 5.1.12)", body: [old("0 0", "5 0", "40000"), old("5 0", "9 0", "0"), old("20 0", "25 0", "40800")] }))
    const locked = r.project.traces.map((t) => !!t.locked).sort()
    expect(r.project.traces).toHaveLength(3)
    expect(locked).toEqual([false, true, true])
    // a via locked the same way
    const v = imported(board({ version: 20171130, header: "(host pcbnew 5.1.12)", body: ["(via (at 1 1) (size 0.8) (drill 0.4) (layers F.Cu B.Cu) (net 0) (status 40000))"] }))
    expect(v.project.vias[0].locked).toBe(true)
  })
})

describe("X13: the file's net against what the editor derives, reported by item", () => {
  it("copper that touches pads of its own net differs from nothing", () => {
    const r = imported(twoParts([seg("7 5", "10 5", "(net 1)"), seg("3 5", "3 9", "(net 2)")]))
    expect(r.report.entries.some((e) => e.code === "copper-net-differs")).toBe(false)
  })
  it("a trace on GND that touches pads of A is reported with where it is, and Checks shows the short", () => {
    const r = imported(twoParts([seg("7 5", "10 5", "(net 2)")]))
    const e = r.report.entries.find((x) => x.code === "copper-net-differs")!
    expect(e.severity).toBe("changed")
    expect(e.count).toBe(1)
    expect(e.items).toEqual(["trace on F.Cu from (7, 5) to (10, 5) (1 segment): the file puts it on net GND, the editor derives net A"])
    expect(analysis(r.project).violations.filter((v) => v.kind === "short").map((v) => v.message)).toEqual(["Short between A, GND"])
  })
  it("a trace on A that touches nothing is reported, and the editor keeps it as copper of A: unrouted, floating", () => {
    const r = imported(twoParts([seg("7 5", "10 5", "(net 1)"), seg("20 15", "25 15", "(net 1)")]))
    const e = r.report.entries.find((x) => x.code === "copper-net-differs")!
    expect(e.count).toBe(1)
    expect(e.items).toEqual(["trace on F.Cu from (20, 15) to (25, 15) (1 segment): the file puts it on net A, the editor derives no net, since no pad of that net touches it"])
    const a = analysis(r.project)
    expect(a.violations.some((v) => v.kind === "floating-copper")).toBe(true)
    // the pads of A are joined by the other trace, so the one line of the ratsnest is the stub's: it is an island of A
    const rats = a.ratsnest.filter((l) => l.netId === "net:A")
    expect(rats).toHaveLength(1)
    expect([rats[0].a.y, rats[0].b.y]).toContain(-15)
    const stub = r.project.traces.find((t) => t.points[0].y === -15)!
    expect(a.traceNet.get(stub.id)).toBe("net:A")
  })
  it("a trace on no net that touches a pad of A is reported: the file says none, the editor derives A", () => {
    const r = imported(twoParts([seg("7 5", "8 5", "(net 0)")]))
    const e = r.report.entries.find((x) => x.code === "copper-net-differs")!
    expect(e.items![0]).toMatch(/the file puts it on no net, the editor derives net A/)
  })
  it("a via is compared too", () => {
    const r = imported(twoParts(['(via (at 7 5) (size 0.8) (drill 0.4) (layers "F.Cu" "B.Cu") (net 2))', '(via (at 10 5) (size 0.8) (drill 0.4) (layers "F.Cu" "B.Cu") (net 1))']))
    const e = r.report.entries.find((x) => x.code === "copper-net-differs")!
    expect(e.items).toEqual(["via at (7, 5): the file puts it on net GND, the editor derives net A"])
    expect(e.count).toBe(1)
  })
  it("every mismatch is listed in `items`, and `object` names the first three", () => {
    const stubs = Array.from({ length: 5 }, (_, i) => seg(`${20 + i * 3} 15`, `${21 + i * 3} 15`, "(net 1)"))
    const r = imported(twoParts(stubs))
    const e = r.report.entries.find((x) => x.code === "copper-net-differs")!
    expect(e.count).toBe(5)
    expect(e.items).toHaveLength(5)
    expect(e.object).toMatch(/^5 traces and vias whose net the editor derives differently \(.+; \.\.\.\)$/)
  })
  it("derivedCopperNets ignores the stored nets: it is what the editor works out from the pads", () => {
    const r = imported(twoParts([seg("7 5", "10 5", "(net 2)")]))
    const d = derivedCopperNets(r.project, computeConnectivity(r.project))
    expect(d.traceNet.get(r.project.traces[0].id)).toBe("net:A")
    expect(analysis(r.project).traceNet.get(r.project.traces[0].id)).toBe("short")
  })
})

describe("X13: the editor keeps and uses the nets", () => {
  it("a stub of GND inside a GND pour joins it: the pour does not cut round copper of its own net", () => {
    const base = imported(twoParts([seg("30 15", "31 15", "(net 2)")]))
    const zoned = (p: Project): Project => ({ ...p, board: { ...p.board, width: 60, height: 40, x: 20, y: -15 }, zones: [{ id: "z1", net: "GND", layer: "top" }] })
    const covers = (p: Project, at: { x: number; y: number }) => analysis(zoned(p)).zoneFills.flatMap((f) => f.polygons).some((poly) => fillTester(poly)(at))
    const mid = { x: 30.5, y: -15 }
    expect(covers(base.project, mid)).toBe(true)
    const stripped = { ...base.project, traces: base.project.traces.map(({ net: _n, ...t }) => t) }
    expect(covers(stripped, mid)).toBe(false)
  })
  it("a trace of another net across a pad is a short in the editor's own check, and not once the file's net is the pad's", () => {
    const wrong = imported(twoParts([seg("9 5", "11 5", "(net 2)")]))
    expect(analysis(wrong.project).violations.some((v) => v.kind === "short")).toBe(true)
    const right = imported(twoParts([seg("9 5", "11 5", "(net 1)")]))
    expect(analysis(right.project).violations.filter((v) => v.kind === "short")).toEqual([])
  })
  it("the router treats a stub of GND as copper of GND: it joins it to the net, where netless copper would stay floating", () => {
    const text = twoParts([seg("8 8", "9 8", "(net 2)")])
    const routed = autoroute(imported(text).project).project
    const a = analysis(routed)
    expect(a.violations).toEqual([])
    expect(a.ratsnest).toEqual([])
    expect(routed.traces.length).toBeGreaterThan(1)
    // the same board with the net taken off the stub is left with a floating trace
    const bare = imported(text).project
    const stripped = autoroute({ ...bare, traces: bare.traces.map(({ net: _n, ...t }) => t) }).project
    expect(analysis(stripped).violations.some((v) => v.kind === "floating-copper")).toBe(true)
  })
  it("survives a save: the file keeps net and routedNet", () => {
    const r = imported(twoParts([seg("7 5", "10 5", "(net 1)"), '(via (at 7 5) (size 0.8) (drill 0.4) (layers "F.Cu" "B.Cu") (net 1))']))
    const back = parseProjectFile(serializeProject(r.project), { id: "x" })
    expect(back.traces[0].net).toBe("A")
    expect(back.vias[0].routedNet).toBe("A")
  })
  it("the nets reach the KiCad export: each segment is on the net its trace says", async () => {
    const r = imported(twoParts([seg("7 5", "10 5", "(net 1)"), seg("3 5", "3 9", "(net 2)")]))
    const { files } = await kicadFiles(r.project)
    const pcb = Object.entries(files).find(([k]) => k.endsWith(".kicad_pcb"))![1]
    const names = new Map([...pcb.matchAll(/\(net (\d+) "([^"]*)"\)/g)].map((m) => [m[1], m[2]]))
    const used = [...pcb.matchAll(/\(segment[^]*?\(net (\d+)\)/g)].map((m) => names.get(m[1]))
    expect(used.sort()).toEqual(["A", "GND"])
  }, 120_000)
})

describe("X13: a board drawn in the editor behaves as it did", () => {
  const example = EXAMPLES.find((e) => e.id === "blinker")!.project
  it("has no flags and no nets set, and its derived nets are the analysis's own", () => {
    expect(example.components.every((c) => c.flags === undefined)).toBe(true)
    expect(example.traces.every((t) => t.net === undefined)).toBe(true)
    expect(example.vias.every((v) => v.routedNet === undefined)).toBe(true)
    expect(example.traces.length).toBeGreaterThan(5)
    const a = analysis(example)
    const d = derivedCopperNets(example, computeConnectivity(example))
    expect([...d.traceNet]).toEqual([...a.traceNet])
    // a stitching via (`Via.net`) takes its net from the pours, which the derived nets leave out
    const routed = example.vias.filter((v) => !v.net).map((v) => v.id)
    expect(routed.map((id) => d.viaNet.get(id))).toEqual(routed.map((id) => a.viaNet.get(id)))
    expect(a.items.every((it) => it.kind === "pad" || it.kind === "zone" || it.netId === undefined)).toBe(true)
  })
  it("the BOM and the position file list every part", () => {
    const parts = example.components.filter((c) => isPhysical(findPart(c.partId)))
    const first = (l: string) => (l.startsWith('"') ? l.slice(1, l.indexOf('",')) : l.slice(0, l.indexOf(",")))
    const bomRefs = bomCsv(example).split("\n").slice(1).filter(Boolean).flatMap((l) => first(l).split(", "))
    expect(bomRefs.sort()).toEqual(parts.map((c) => c.ref).sort())
    expect(pnpCsv(example).split("\n").filter(Boolean)).toHaveLength(parts.length + 1)
  })
  it("a project with no copper nets and no flags serialises without a trace net, a via net or a flag", () => {
    const text = serializeProject(example)
    expect(text).not.toMatch(/"routedNet"|"flags"/)
    expect(JSON.parse(text).project.traces.every((t: object) => !("net" in t))).toBe(true)
  })
})

// ---------------------------------------------------------------------------------------------

describe("X15: every attribute of a footprint is carried", () => {
  const attrs = (attr: string, extra = "") => footprint({ ref: "R1", pads: [pad({ number: "1", at: "-1 0" }), pad({ number: "2", at: "1 0" })], extra: `${attr} ${extra}` })
  const flagsOf = (text: string) => imported(text).project.components[0].flags
  it("smd, through_hole and every other word", () => {
    expect(flagsOf(board({ body: [attrs("(attr smd)")] }))).toEqual({ mount: "smd" })
    expect(flagsOf(board({ body: [attrs("(attr through_hole)")] }))).toEqual({ mount: "through_hole" })
    expect(flagsOf(board({ body: [attrs("(attr smd board_only exclude_from_pos_files exclude_from_bom allow_missing_courtyard allow_soldermask_bridges dnp)")] }))).toEqual({
      mount: "smd",
      boardOnly: true,
      excludeFromPos: true,
      excludeFromBom: true,
      allowMissingCourtyard: true,
      allowMaskBridges: true,
      dnp: true,
    })
  })
  it("virtual is its own flag and no mounting, and a part with no attribute has none", () => {
    expect(flagsOf(board({ body: [attrs("(attr virtual)")] }))).toEqual({ virtual: true })
    expect(flagsOf(board({ body: [attrs("")] }))).toBeUndefined()
    expect(imported(board({ body: [attrs("(attr smd)")] })).project.components[0].flags).not.toHaveProperty("dnp")
  })
  it("a KiCad 5 footprint with no attribute is through-hole, a KiCad 6 one is neither", () => {
    const old = board({ version: 20171130, header: "(host pcbnew 5.1.12)", body: [footprint({ token: "module", pads: [pad({ number: "1", at: "0 0" })] })] })
    expect(flagsOf(old)).toEqual({ mount: "through_hole" })
    expect(flagsOf(board({ version: 20211014, body: [footprint({ pads: [pad({ number: "1", at: "0 0" })] })] }))).toBeUndefined()
  })
  it("net ties: the groups of net_tie_pad_groups, and the KiCad 5 tag that ties every pad", () => {
    expect(flagsOf(board({ body: [attrs("(attr smd)", '(net_tie_pad_groups "1, 2")')] }))?.netTies).toEqual([["1", "2"]])
    expect(flagsOf(board({ body: [attrs("(attr smd)", '(net_tie_pad_groups "1,2" "3")')] }))?.netTies).toEqual([["1", "2"], ["3"]])
    const tagged = board({ version: 20171130, header: "(host pcbnew 5.1.12)", body: [footprint({ token: "module", pads: [pad({ number: "1", at: "-1 0" }), pad({ number: "2", at: "1 0" })], extra: '(tags "net tie")' })] })
    expect(flagsOf(tagged)?.netTies).toEqual([["1", "2"]])
  })
  it("jumper pad groups and duplicate pad numbers as jumpers", () => {
    const f = flagsOf(board({ body: [attrs("(attr smd)", '(duplicate_pad_numbers_are_jumpers yes) (jumper_pad_groups ("1" "2"))')] }))
    expect(f).toMatchObject({ jumperDuplicates: true, jumperGroups: [["1", "2"]] })
    expect(flagsOf(board({ body: [attrs("(attr smd)", "(duplicate_pad_numbers_are_jumpers no)")] }))).toEqual({ mount: "smd" })
  })
  it("a jumper group of non-numeric pads is a known path, not an unknown node", () => {
    const r = importKicadBoard(board({ body: [footprint({ ref: "J1", pads: [pad({ number: "A", at: "-1 0" }), pad({ number: "B", at: "1 0" })], extra: '(jumper_pad_groups ("A" "B"))' })] }), { built: ALL })
    expect(r.report.account!.unknownPaths.size).toBe(0)
    expect(r.status).toBe("imported")
  })
  it("exclude from simulation has nowhere to go and is named", () => {
    const r = imported(board({ body: [attrs("(attr smd exclude_from_sim)")] }))
    expect(r.report.entries.find((e) => e.code === "attr-not-brought")?.items).toEqual(["R1"])
  })
  it("every attribute word of the corpus is a flag or reported: none is left", () => {
    const words = ["smd", "through_hole", "virtual", "board_only", "exclude_from_pos_files", "exclude_from_bom", "allow_missing_courtyard", "allow_soldermask_bridges", "dnp"]
    for (const w of words) expect(flagsOf(board({ body: [attrs(`(attr ${w})`)] })), w).toBeDefined()
  })
})

describe("X15: the BOM and the position file honour the flags", () => {
  const part = (ref: string, attr: string) => footprint({ ref, at: `${(Number(ref.slice(1)) - 1) * 6} 0`, pads: [pad({ number: "1", at: "-1 0" }), pad({ number: "2", at: "1 0" })], extra: attr })
  const text = board({
    body: [part("R1", "(attr smd)"), part("R2", "(attr smd dnp)"), part("R3", "(attr smd exclude_from_bom)"), part("R4", "(attr smd exclude_from_pos_files)"), part("R5", "(attr virtual)"), part("R6", "(attr smd board_only)"), part("R7", "")],
  })
  const p = imported(text).project
  const refs = (csv: string) => csv.split("\n").slice(1).filter(Boolean)
  it("the BOM leaves out virtual, not in BOM and do not populate parts; board only alone stays, as in KiCad's board-side BOM", () => {
    const rows = refs(bomCsv(p)).join("\n")
    // R1, R4, R6 and R7 are the parts left, which are one line: one value, one footprint
    expect(rows).toMatch(/R1, R4, R6, R7/)
    for (const gone of ["R2", "R3", "R5"]) expect(rows).not.toContain(gone)
    // board only and not in the BOM together does leave
    const both = setFlags(p, p.components.find((c) => c.ref === "R6")!.id, { excludeFromBom: true })
    expect(refs(bomCsv(both)).join("\n")).toMatch(/R1, R4, R7/)
  })
  it("the fabrication notes state each rule, and only for a board that has flags", () => {
    const notes = fabricationNotes(p, [], [])
    expect(notes).toMatch(/Do not populate\s+R2: left out of bom.csv and pnp.csv; their solder paste is still in the paste files/)
    expect(notes).toMatch(/Not in the BOM\s+R3: left out of bom.csv/)
    expect(notes).toMatch(/Not in position\s+R4: left out of pnp.csv/)
    expect(notes).toMatch(/Virtual\s+R5: left out of bom.csv and pnp.csv/)
    expect(notes).toMatch(/Board only\s+R6: .*still in bom.csv unless also not in the BOM/)
    expect(fabricationNotes(EXAMPLES[0].project, [], [])).not.toContain("PART FLAGS")
  })
  it("the import says once that do not populate parts are left out where KiCad keeps them", () => {
    const e = imported(text).report.entries.find((x) => x.code === "dnp-parts")!
    expect(e).toMatchObject({ severity: "note", count: 1, items: ["R2"] })
    expect(e.why).toMatch(/KiCad keeps such a part in both by default/)
    expect(imported(board({ body: [part("R1", "(attr smd)")] })).report.entries.some((x) => x.code === "dnp-parts")).toBe(false)
  })
  it("the position file leaves out virtual, not in position file and do not populate parts, and keeps the rest", () => {
    const listed = refs(pnpCsv(p)).map((l) => l.split(",")[0])
    expect(listed).toEqual(["R1", "R3", "R6", "R7"])
  })
  it("setFlags changes one flag and the files follow; clearing the last flag leaves the part as a part drawn in the editor", () => {
    let q = p
    const r7 = q.components.find((c) => c.ref === "R7")!
    q = setFlags(q, r7.id, { dnp: true })
    expect(refs(pnpCsv(q)).map((l) => l.split(",")[0])).toEqual(["R1", "R3", "R6"])
    q = setFlags(q, r7.id, { dnp: false })
    expect(q.components.find((c) => c.ref === "R7")).not.toHaveProperty("flags")
    expect(refs(pnpCsv(q))).toHaveLength(4)
  })
  it("a part with do not populate keeps its solder paste, as KiCad plots it: the stencil of an imported board does not change", () => {
    const flashes = (project: Project) => (gerberPaste(project, "top").match(/D03\*/g) ?? []).length
    const none = { ...p, components: p.components.map(({ flags: _f, ...c }) => c) }
    expect(flashes(p)).toBe(14)
    expect(flashes(none)).toBe(14)
    expect(gerberPaste(p, "top")).toBe(gerberPaste(none, "top"))
  })
})

describe("X15: a net tie is not a short", () => {
  /** A tie of two overlapping pads, A on the left and B on the right, R1 on A at its left and R2 on B at its right; `copper` is KiCad's segments. */
  const tie = (flags: string, copper: string[] = [seg("4 5", "11 5", "(net 1)")], more = "") =>
    board({
      nets: ['(net 0 "")', net(1, "A"), net(2, "B"), ...(more ? [more] : [])],
      setup: "(setup (pad_to_mask_clearance 0))",
      body: [
        footprint({ ref: "NT1", name: "NetTie:NetTie-2_SMD_Pad0.5mm", at: "10 5", pads: [pad({ number: "1", at: "-0.4 0", size: "1 1", net: net(1, "A") }), pad({ number: "2", at: "0.4 0", size: "1 1", net: net(2, "B") })], extra: flags }),
        footprint({ ref: "R1", at: "3 5", pads: [pad({ number: "1", at: "-1 0", net: net(1, "A") }), pad({ number: "2", at: "1 0", net: net(1, "A") })] }),
        footprint({ ref: "R2", at: "17 5", pads: [pad({ number: "1", at: "-1 0", net: net(2, "B") }), pad({ number: "2", at: "1 0", net: net(2, "B") })] }),
        ...copper,
      ],
    })
  const withTie = imported(tie('(net_tie_pad_groups "1, 2")')).project
  const without = imported(tie("")).project
  const shorts = (p: Project) => analysis(p).violations.filter((v) => v.kind === "short")
  it("copper of A that enters the tie's pad of A, and so touches its overlap with B, is no short; without the tie it is", () => {
    const enters = (flags: string) => imported(tie(flags, [seg("4 5", "10 5", "(net 1)")])).project
    expect(shorts(enters(""))).toHaveLength(1)
    expect(shorts(enters('(net_tie_pad_groups "1, 2")'))).toEqual([])
  })
  it("but copper of A that goes on onto the tie's pad of B is a short again, tie or not: only the tie's own copper is excused", () => {
    expect(shorts(without)).toHaveLength(1)
    expect(shorts(withTie)).toHaveLength(1)
  })
  it("a short that the tie does not explain is still one: a third net on the pad", () => {
    const three = imported(tie('(net_tie_pad_groups "1, 2")', [seg("4 5", "11 5", "(net 1)"), seg("10.4 5", "10.4 8", "(net 3)"), footprint({ ref: "R3", at: "10 12", pads: [pad({ number: "1", at: "0.4 -4", net: net(3, "C") }), pad({ number: "2", at: "5 0", net: net(3, "C") })] })], net(3, "C"))).project
    expect(analysis(three).violations.filter((v) => v.kind === "short")).toHaveLength(1)
  })
  it("copper of B that comes within the clearance of the tie's other pad is no clearance error; without the tie it is", () => {
    const text = (flags: string) => tie(flags, [seg("4 5", "9.6 5", "(net 1)"), seg("11 5", "17 5", "(net 2)")])
    const near = (p: Project) => analysis({ ...p, rules: { ...p.rules, clearance: 0.3 } }).violations.filter((v) => v.kind === "clearance")
    expect(near(imported(text("")).project).length).toBeGreaterThan(0)
    expect(near(imported(text('(net_tie_pad_groups "1, 2")')).project)).toEqual([])
  })
  it("the tie is read as groups of pad numbers on the part", () => {
    expect(withTie.components.find((c) => c.ref === "NT1")!.flags).toEqual({ netTies: [["1", "2"]] })
  })
})

describe("X15: the flags reach the KiCad export", () => {
  it("writes the attributes and the groups on the footprint, found by reference, and leaves unflagged parts as the converter wrote them", async () => {
    const text = board({
      nets: ['(net 0 "")', net(1, "A"), net(2, "B")],
      body: [
        footprint({ ref: "R1", at: "5 5", pads: [pad({ number: "1", at: "-1 0", net: net(1, "A") }), pad({ number: "2", at: "1 0", net: net(2, "B") })], extra: '(attr smd exclude_from_pos_files dnp) (net_tie_pad_groups "1, 2")' }),
        footprint({ ref: "R2", at: "12 5", pads: [pad({ number: "1", at: "-1 0", net: net(1, "A") }), pad({ number: "2", at: "1 0", net: net(2, "B") })] }),
      ],
    })
    const r = imported(text)
    const { files, notes } = await kicadFiles(r.project)
    const pcb = Object.entries(files).find(([k]) => k.endsWith(".kicad_pcb"))![1]
    const block = (ref: string) => pcb.split(/\n {2}\(footprint\b/).slice(1).find((b) => b.includes(`(property "Reference" "${ref}"`))!
    expect(block("R1")).toContain("(attr smd exclude_from_pos_files dnp)")
    expect(block("R1")).toContain('(net_tie_pad_groups "1,2")')
    expect(block("R2")).not.toContain("net_tie_pad_groups")
    expect(block("R2")).not.toContain("dnp")
    expect(notes.some((n) => /net ties/.test(n))).toBe(true)
  }, 120_000)
})

describe("X15 and X13: Sakura sees them", () => {
  const p = imported(
    board({
      nets: ['(net 0 "")', net(1, "A")],
      body: [footprint({ ref: "R1", at: "5 5", pads: [pad({ number: "1", at: "-1 0", net: net(1, "A") }), pad({ number: "2", at: "1 0" })], extra: '(attr smd dnp exclude_from_bom) (net_tie_pad_groups "1, 2")' })],
    }),
  ).project
  const design = (project: Project) => JSON.parse(runTool(project, "get_design", {}).result) as { components: { ref: string; flags?: string[]; net_ties?: string[] }[] }
  it("get_design lists a part's flags and net ties, and only for parts that have them", () => {
    const r1 = design(p).components.find((c) => c.ref === "R1")!
    expect(r1.flags).toEqual(["surface mount", "do not populate", "not in the BOM"])
    expect(r1.net_ties).toEqual(["1+2"])
    const editor = EXAMPLES.find((e) => e.id === "blinker")!.project
    expect(design(editor).components.every((c) => c.flags === undefined)).toBe(true)
  })
  it("update_component sets and clears the assembly flags", () => {
    const out = runTool(p, "update_component", { ref: "R1", flags: { dnp: false, virtual: true } })
    expect(out.isError).toBe(false)
    expect(out.project.components[0].flags).toMatchObject({ virtual: true, excludeFromBom: true, mount: "smd" })
    expect(out.project.components[0].flags?.dnp).toBeUndefined()
    expect(out.summary).toContain("flags dnp=false, virtual=true")
    expect(runTool(p, "update_component", { ref: "R1", flags: { frob: true } }).isError).toBe(true)
    expect(runTool(p, "update_component", { ref: "R1", flags: { dnp: "yes" } }).isError).toBe(true)
  })
})

describe("the project file, version 3", () => {
  it("is the current version, and a document of version 2 reads as it was written", () => {
    const v2 = { format: "cherryblossom.project", version: 2, project: { name: "old", description: "", components: [], wires: [], labels: [], traces: [{ id: "t", layer: "top", width: 0.25, points: [{ x: 0, y: 0 }, { x: 1, y: 0 }] }], vias: [{ id: "v", x: 0, y: 0, diameter: 0.8, drill: 0.4 }], zones: [], texts: [] } }
    const read = parseProjectFile(v2, { id: "x" })
    expect(read.traces[0]).toEqual(v2.project.traces[0])
    expect(read.vias[0]).toEqual(v2.project.vias[0])
    expect(JSON.parse(serializeProject(read)).version).toBe(PROJECT_FILE_VERSION)
  })
  it("junk in a flag, a trace net or a via net is dropped, a good value kept", () => {
    const doc = {
      format: "cherryblossom.project",
      version: 3,
      project: {
        name: "n",
        components: [
          { id: "a", partId: "resistor", ref: "R1", props: {}, footprint: "0603", sch: { x: 0, y: 0, rot: 0 }, pcb: { x: 0, y: 0, rot: 0, side: "top", placed: true }, flags: { dnp: true, mount: "wobbly", virtual: "yes", netTies: [["1", "2", 3], "x", []] } },
          { id: "b", partId: "resistor", ref: "R2", props: {}, footprint: "0603", sch: { x: 0, y: 0, rot: 0 }, pcb: { x: 0, y: 0, rot: 0, side: "top", placed: true }, flags: "dnp" },
        ],
        traces: [{ id: "t1", layer: "top", width: 0.2, points: [], net: "GND" }, { id: "t2", layer: "top", width: 0.2, points: [], net: 5 }, { id: "t3", layer: "top", width: 0.2, points: [], net: " " }],
        vias: [{ id: "v1", x: 0, y: 0, diameter: 0.8, drill: 0.4, routedNet: "GND" }, { id: "v2", x: 0, y: 0, diameter: 0.8, drill: 0.4, routedNet: false }],
      },
    }
    const read = parseProjectFile(doc, { id: "x" })
    expect(read.components[0].flags).toEqual({ dnp: true, netTies: [["1", "2"]] })
    expect(read.components[1]).not.toHaveProperty("flags")
    expect(read.traces.map((t) => t.net)).toEqual(["GND", undefined, undefined])
    expect(read.vias.map((v) => v.routedNet)).toEqual(["GND", undefined])
  })
})

describe("the gate after slice 1b-i", () => {
  it("builds X13 and X15 (and X8, which slice 1b-ii added, and X9, which slice 1b-iii did), and slice 2c-i X2 and X6", () => {
    expect([...BUILT_EXTENSIONS].sort()).toEqual(["X13", "X15", "X2", "X3", "X6", "X8", "X9"])
  })
  it("a board whose only needs are built is imported by the real gate with its parts; one that also needs text in another font is refused for that alone", () => {
    const onlyCopper = board({ nets: ['(net 0 "")', net(1, "A")], body: [seg("0 0", "5 0", "(net 1)"), '(via (at 5 0) (size 0.8) (drill 0.4) (layers "F.Cu" "B.Cu") (net 1))'] })
    const plain = importKicadBoard(onlyCopper)
    expect(plain.status).toBe("imported")
    expect(importKicadBoard(twoParts([seg("7 5", "10 5", "(net 1)")])).status).toBe("imported")
    const arial = importKicadBoard(twoParts([seg("7 5", "10 5", "(net 1)"), '(gr_text "x" (at 3 3) (layer "F.SilkS") (effects (font (face "Arial") (size 1 1) (thickness 0.15))))']))
    expect(arial.status).toBe("refused")
    if (arial.status === "refused") {
      expect(arial.needs.map((n) => n.ext)).toEqual(["X19"])
      expect(arial.message).toBe("This board uses text in a font other than KiCad's own, text outlines or embedded fonts, which is not supported yet.")
    }
  })
  it("a board with flags and net ties needs X15 and X13 in the census's sense, and they are built", () => {
    const text = board({ body: [footprint({ extra: '(attr smd dnp) (net_tie_pad_groups "1, 2")', pads: [pad({ number: "1", at: "-1 0" }), pad({ number: "2", at: "1 0" })] })] })
    const needs = needsOf(readKicadBoard(text).board, { paths: new Map([["footprint>attr", 1]]) }, outlineOf(readKicadBoard(text).board))
    expect(needs.map((n) => n.ext)).toContain("X15")
    const r = importKicadBoard(text)
    // every extension the board needs is built, so it comes in with its flags
    expect(r.status).toBe("imported")
    expect(r.status === "imported" && r.project.components[0].flags).toMatchObject({ dnp: true, mount: "smd" })
  })
  it("builds a project whose copper nets match, and reports none, for a board that needs only text", () => {
    const text = twoParts([seg("7 5", "10 5", "(net 1)")])
    const read = readKicadBoard(text)
    const built = buildKicadProject(read.board, outlineOf(read.board), { entries: [], account: null })
    expect(built.stats.copperNetMismatches).toBe(0)
  })
})

// ---------------------------------------------------------------------------------------------
// Fix round 1

describe("B1: flagging an editor part keeps its mounting word in the KiCad export", () => {
  const blinker = () => EXAMPLES.find((e) => e.id === "blinker")!.project
  const attrOf = (pcb: string, ref: string) => {
    const block = pcb.split(/\n {2}\(footprint\b/).slice(1).find((b) => b.includes(`(property "Reference" "${ref}"`))!
    return block.match(/\n {4}\(attr([^\n]*)\)/)![1].trim().split(/\s+/)
  }
  const pcbOf = async (p: Project) => Object.entries((await kicadFiles(p)).files).find(([k]) => k.endsWith(".kicad_pcb"))![1]
  it("every flag on the blinker's parts adds to the converter's attr line, which still says smd or through_hole", async () => {
    const example = blinker()
    const plain = await pcbOf(example)
    let flagged = example
    const physical = example.components.filter((c) => isPhysical(findPart(c.partId)))
    for (const c of physical) flagged = setFlags(flagged, c.id, { dnp: true, excludeFromBom: true, excludeFromPos: true, boardOnly: true, allowMissingCourtyard: true, allowMaskBridges: true })
    const after = await pcbOf(flagged)
    let mounted = 0
    for (const c of physical) {
      const was = attrOf(plain, c.ref)
      const now = attrOf(after, c.ref)
      for (const w of was.filter((x) => x === "smd" || x === "through_hole")) {
        mounted++
        expect(now, c.ref).toContain(w)
      }
      for (const w of ["dnp", "exclude_from_bom", "exclude_from_pos_files", "board_only", "allow_missing_courtyard", "allow_soldermask_bridges"]) expect(now, `${c.ref} ${w}`).toContain(w)
      expect(now[0]).toMatch(/^(smd|through_hole)$/)
    }
    expect(mounted).toBeGreaterThan(5)
  }, 180_000)
  it("a mounting the flags name replaces the converter's, and virtual is written as the two exclusions", async () => {
    const example = blinker()
    const u1 = example.components.find((c) => c.ref === "U1")!
    const set = setFlags(setFlags(example, u1.id, { mount: "through_hole" }), example.components.find((c) => c.ref === "R1")!.id, { virtual: true })
    const pcb = await pcbOf(set)
    expect(attrOf(pcb, "U1")).toEqual(["through_hole"])
    expect(attrOf(pcb, "R1").join(" ")).toMatch(/^smd exclude_from_pos_files exclude_from_bom$/)
  }, 180_000)
})

describe("M1: copper nets follow a net the schematic renames", () => {
  const text = twoParts([seg("7 5", "10 5", "(net 1)"), seg("3 5", "3 9", "(net 2)")])
  const swapLabels = (p: Project, a: string, b: string): Project => ({ ...p, labels: p.labels.map((l) => (l.name === a ? { ...l, name: b } : l.name === b ? { ...l, name: a } : l)) })
  const base = imported(text).project
  const swapped = swapLabels(base, "A", "GND")
  const shorts = (p: Project) => analysis(p).violations.filter((v) => v.kind === "short")
  it("swapping the names of two nets is two false shorts without the follow, none with it", () => {
    expect(shorts(swapped)).toHaveLength(2)
    const followed = followNetRenames(base, swapped)
    expect(shorts(followed)).toEqual([])
    expect(followed.traces.map((t) => t.net).sort()).toEqual(["A", "GND"])
    expect(followed.traces.find((t) => t.points[0].x === 7)!.net).toBe("GND")
  })
  it("and after autoroute nothing is unrouted or short, with the follow and with Tidy's renameNets", () => {
    const viaFollow = autoroute(followNetRenames(base, swapped)).project
    expect(analysis(viaFollow).violations).toEqual([])
    expect(analysis(viaFollow).ratsnest).toEqual([])
    const renamed = renameNets(swapped, { A: "GND", GND: "A" })
    // renameNets moves the copper names with the pours and widths; the labels were swapped by the caller, as Tidy does
    expect(renamed.traces.find((t) => t.points[0].x === 7)!.net).toBe("GND")
    expect(shorts(renamed)).toEqual([])
    const viaTidy = autoroute(renamed).project
    expect(analysis(viaTidy).violations).toEqual([])
    expect(analysis(viaTidy).ratsnest).toEqual([])
  })
  it("through the store, a label edit renames the copper, and the follow does not apply an edit twice", () => {
    const api = () => useProjectStore.getState()
    api().open(base)
    api().commit((p) => swapLabels(p, "A", "GND"))
    expect(shorts(api().project!)).toEqual([])
    expect(api().project!.traces.find((t) => t.points[0].x === 7)!.net).toBe("GND")
    // Tidy's pair: the labels are swapped and renameNets moves the copper itself
    api().commit((p) => renameNets(swapLabels(p, "GND", "A"), { GND: "A", A: "GND" }))
    expect(api().project!.traces.find((t) => t.points[0].x === 7)!.net).toBe("A")
    expect(shorts(api().project!)).toEqual([])
    api().commit((p) => ({ ...p, labels: p.labels.map((l) => (l.name === "A" ? { ...l, name: "SIG" } : l)) }))
    expect(api().project!.traces.find((t) => t.points[0].x === 7)!.net).toBe("SIG")
    expect(shorts(api().project!)).toEqual([])
  })
  it("a project with no stored nets, or an edit that touches no schematic, is returned as it is", () => {
    const editor = EXAMPLES.find((e) => e.id === "blinker")!.project
    expect(followNetRenames(editor, { ...editor, labels: [] }).traces).toBe(editor.traces)
    expect(followNetRenames(base, base)).toBe(base)
  })
})

describe("M3: the outline repair leaves what it does not merge exactly where it is", () => {
  const line = (a: string, b: string) => `(gr_line (start ${a}) (end ${b}) (stroke (width 0.1) (type default)) (layer "Edge.Cuts"))`
  const outline = (top: string[]) => outlineOf(readKicadBoard(board({ outline: [...top, line("100 0", "100 50"), line("100 50", "0 50"), line("0 50", "0 0")].join("\n") })).board)
  it("a top side of three pieces with the middle one 0.05 mm off is a polygon, with nothing merged and nothing moved", () => {
    const o = outline([line("0 0", "30 0"), line("30 0.05", "70 0.05"), line("70 0", "100 0")])
    expect(o.repair).toMatchObject({ merged: 0, dropped: 0, moved: 0 })
    expect(o.shape).toBe("polygon")
    expect(o.representable).toBe(false)
    expect(o.box).toEqual({ minX: 0, minY: 0, maxX: 100, maxY: 50 })
  })
  it("pieces that overlap are merged, and the one that was off the line is counted as moved and named in the note", () => {
    const text = board({ outline: [line("0 0", "100 0"), line("20 0.05", "80 0.05"), line("100 0", "100 50"), line("100 50", "0 50"), line("0 50", "0 0")].join("\n") })
    expect(outlineOf(readKicadBoard(text).board).repair).toMatchObject({ merged: 1, moved: 1 })
    const r = importKicadBoard(text, { built: ALL })
    expect(r.report.entries.find((e) => e.code === "outline-repaired")?.why).toMatch(/1 did not lie exactly on the line they were joined into and moved to it/)
  })
  it("a piece on the line is merged without a move", () => {
    const o = outline([line("0 0", "60 0"), line("40 0", "100 0")])
    expect(o.repair).toMatchObject({ merged: 1, moved: 0 })
    expect(o.shape).toBe("rect")
  })
})

describe("m2 and m3: what the import marked is retired, or handed back, without touching the user's own", () => {
  const text = board({
    nets: ['(net 0 "")', net(1, "A"), net(2, "TP_ADC")],
    body: [
      footprint({ ref: "U1", at: "5 5", pads: [pad({ number: "1", at: "-2 0", net: net(1, "A") }), pad({ number: "2", at: "0 0" }), pad({ number: "3", at: "2 0", net: net(2, "TP_ADC") })] }),
      footprint({ ref: "U2", at: "15 5", pads: [pad({ number: "1", at: "-2 0", net: net(1, "A") }), pad({ number: "2", at: "0 0" })] }),
    ],
  })
  const r = imported(text)
  const p0 = { ...r.project, ignoredChecks: [...(r.project.ignoredChecks ?? []), "bare-led:mine"] }
  it("the import records the keys and the pins it set", () => {
    expect(r.project.importMarks?.checks).toHaveLength(1)
    expect(Object.values(r.project.importMarks?.noConnect ?? {}).flat()).toEqual(["2", "2"])
    expect(r.project.ignoredChecks).toEqual(r.project.importMarks!.checks)
  })
  it("once a single-pad net gets a second pin its ignored key goes, and a key the user wrote stays", () => {
    const renamed = { ...p0, labels: p0.labels.map((l) => (l.name === "TP_ADC" ? { ...l, name: "A" } : l)) }
    const pruned = pruneImportMarks(p0, renamed)
    expect(pruned.ignoredChecks).toEqual(["bare-led:mine"])
    expect(pruned.importMarks?.checks).toBeUndefined()
    expect(splitIgnored(runErc(pruned, computeConnectivity(pruned)), pruned.ignoredChecks).active.filter((f) => f.kind === "lone-label")).toEqual([])
  })
  it("a no-connect pin the user cleared is dropped from the marks, and one the importer set stays marked", () => {
    const u1 = p0.components.find((c) => c.ref === "U1")!
    const cleared = { ...p0, components: p0.components.map((c) => (c.id === u1.id ? { ...c, nc: undefined } : c)) }
    const after = pruneImportMarks(p0, cleared)
    expect(after.importMarks?.noConnect?.[u1.id]).toBeUndefined()
    expect(Object.keys(after.importMarks?.noConnect ?? {})).toEqual([p0.components.find((c) => c.ref === "U2")!.id])
  })
  it("one action gives the imported marks back on a part or on the board, and leaves the user's own no-connect pins", () => {
    const u1 = p0.components.find((c) => c.ref === "U1")!
    const mine = { ...p0, components: p0.components.map((c) => (c.id === u1.id ? { ...c, nc: ["2", "3"] } : c)) }
    const part = clearImportedNoConnect(mine, [u1.id])
    expect(part.components.find((c) => c.id === u1.id)!.nc).toEqual(["3"])
    expect(part.components.find((c) => c.ref === "U2")!.nc).toEqual(["2"])
    const whole = clearImportedNoConnect(mine)
    expect(whole.components.find((c) => c.ref === "U2")!.nc).toBeUndefined()
    expect(whole.importMarks?.noConnect).toBeUndefined()
    expect(computeConnectivity(whole).unconnectedPins.map((x) => x.pin).sort()).toEqual(["2", "2"])
  })
  it("the marks survive a save and a bad one is dropped", () => {
    const back = parseProjectFile(serializeProject(r.project), { id: "x" })
    expect(back.importMarks).toEqual(r.project.importMarks)
    const bad = parseProjectFile({ format: "cherryblossom.project", version: 3, project: { name: "n", importMarks: { checks: [1], noConnect: { a: "2" } } } }, { id: "x" })
    expect(bad.importMarks).toBeUndefined()
  })
})
