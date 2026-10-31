import { describe, expect, it } from "vitest"
import { boardCheckSeverity, DEFAULT_PIN_MAP, ercCheckSeverity, fromKicad, kicadChecksOf, unconnectedPinSeverity } from "../src/model/checkRules"
import { computeConnectivity } from "../src/model/connectivity"
import { EXTENSION_NAMES, importKicadBoard } from "../src/model/kicad/board"
import { importKicadProject } from "../src/model/kicad/project"
import { partFindings } from "../src/model/partChecks"
import { analyzePcb } from "../src/model/pcb"
import type { ZoneFill } from "../src/model/pour"
import type { Project } from "../src/model/types"
import { board, footprint, pad } from "./kicad-board-fixtures"

// Checks of a project from KiCad say what KiCad's DRC says, at the project's severities (`model/checkRules.ts`): KiCad's tolerance, net ties,
// courtyards as drawn, connections through a pour's spokes, the checks KiCad does not have left out, and the project file's severities applied.

const ALL = new Set(Object.keys(EXTENSION_NAMES))
const imp = (text: string): Project => {
  const r = importKicadBoard(text, { built: ALL })
  if (r.status !== "imported") throw new Error(`refused: ${r.message}`)
  return r.project
}
const analysis = (p: Project, opts: Parameters<typeof analyzePcb>[2] = {}) => analyzePcb(p, computeConnectivity(p), opts)
const kinds = (p: Project, kind: string) => analysis(p).violations.filter((v) => v.kind === kind)
const net = (n: number, name: string) => `(net ${n} "${name}")`
const NETS = ['(net 0 "")', net(1, "A"), net(2, "B")]
const OUTLINE = '(gr_rect (start 0 0) (end 40 20) (stroke (width 0.1) (type default)) (fill none) (layer "Edge.Cuts"))'
const seg = (a: string, b: string, n: number, width = 0.2) => `(segment (start ${a}) (end ${b}) (width ${width}) (layer "F.Cu") (net ${n}))`
/** The same project as if drawn here: none of what marks an import. */
const drawnHere = (p: Project): Project => ({ ...p, kicad: undefined, netNames: undefined, properties: undefined })

describe("which project is from KiCad", () => {
  it("is one an import made, not one drawn here", () => {
    const p = imp(board({ nets: NETS, body: [], outline: OUTLINE }))
    expect(fromKicad(p)).toBe(true)
    expect(fromKicad(drawnHere(p))).toBe(false)
  })
})

describe("KiCad's tolerance on a clearance", () => {
  // Two tracks of A and B, 0.2 mm wide, whose centre lines are 0.4 mm less what the gap lacks of the 0.2 mm clearance apart.
  const pair = (short: number) => imp(board({ nets: NETS, setup: "(setup (pad_to_mask_clearance 0))", body: [seg("5 5", "15 5", 1), seg(`5 ${5 + 0.4 - short}`, `15 ${5 + 0.4 - short}`, 2)], outline: OUTLINE }))
  it("passes a gap a few tenths of a micrometre under it, as KiCad's half micrometre does, and reports one a micrometre under", () => {
    const at = pair(0)
    expect(at.rules.clearance).toBe(0.2)
    expect(kinds(at, "clearance")).toEqual([])
    expect(kinds(pair(0.0004), "clearance")).toEqual([])
    expect(kinds(pair(0.001), "clearance").map((v) => v.message)).toEqual(["Clearance 0.199 mm < 0.2 mm between a trace and a trace"])
  })
})

describe("a net tie's bridge inside another part's pad of the tie's net", () => {
  // A kelvin connection: the tie's pad of B and its bridge lie in R1's pad of B, its pad of A just outside it (moteus's NT1 to NT7 on their shunts).
  const tie = (flags: string) =>
    imp(
      board({
        nets: NETS,
        body: [
          footprint({ ref: "NT1", name: "NetTie:NetTie-2_SMD_Pad0.2", at: "10 5", pads: [pad({ number: "1", shape: "circle", at: "-0.127 0", size: "0.254 0.254", net: net(1, "A") }), pad({ number: "2", shape: "circle", at: "0.127 0", size: "0.254 0.254", net: net(2, "B") })], extra: `${flags} (fp_poly (pts (xy -0.12 -0.127) (xy 0.13 -0.127) (xy 0.13 0.127) (xy -0.12 0.127)) (stroke (width 0) (type solid)) (fill solid) (layer "F.Cu"))` }),
          footprint({ ref: "R1", at: "10.7 5", pads: [pad({ number: "1", at: "0 0", size: "1.4 1", net: net(2, "B") })] }),
        ],
        outline: OUTLINE,
      }),
    )
  it("is the tie's own copper, not a clearance error; without the tie it is one", () => {
    const about = (p: Project) => analysis(p).violations.filter((v) => /copper drawing of NT1/.test(v.message))
    expect(about(tie('(net_tie_pad_groups "1, 2")'))).toEqual([])
    expect(about(tie("")).length).toBeGreaterThan(0)
  })
})

describe("courtyards as the footprint draws them", () => {
  // An L: the box of two Ls fitted into each other overlaps, the Ls do not. One drawn as a polygon, the other as lines end to end.
  const lPoly = '(fp_poly (pts (xy 0 0) (xy 4 0) (xy 4 1) (xy 1 1) (xy 1 4) (xy 0 4)) (stroke (width 0.05) (type solid)) (fill none) (layer "F.CrtYd"))'
  const lLines = [
    [0, 0, 4, 0],
    [4, 0, 4, 1],
    [4, 1, 1, 1],
    [1, 1, 1, 4],
    [1, 4, 0, 4],
    [0, 4, 0, 0],
  ]
    .map(([a, b, c, d]) => `(fp_line (start ${-a} ${-b}) (end ${-c} ${-d}) (stroke (width 0.05) (type solid)) (layer "F.CrtYd"))`)
    .join(" ")
  const two = (at: string) => imp(board({ nets: NETS, body: [footprint({ ref: "U1", at: "10 5", pads: [pad({ at: "0.5 0.5", size: "0.5 0.5" })], extra: lPoly }), footprint({ ref: "U2", at, pads: [pad({ at: "-0.5 -0.5", size: "0.5 0.5" })], extra: lLines })], outline: OUTLINE }))
  it("two Ls whose boxes overlap but whose outlines do not are no overlap; pushed together they are", () => {
    expect(kinds(two("15.5 10.5"), "overlap")).toEqual([])
    expect(kinds(two("14 9"), "overlap").map((v) => v.message)).toEqual(["U1 overlaps U2"])
  })
  it("a footprint that draws no courtyard has none, as in KiCad", () => {
    const bare = imp(board({ nets: NETS, body: [footprint({ ref: "R1", at: "10 5", pads: [pad({ at: "0 0" })] }), footprint({ ref: "R2", at: "10.5 5", pads: [pad({ at: "0 0" })] })], outline: OUTLINE }))
    expect(kinds(bare, "overlap")).toEqual([])
    // drawn here, the same lands are their box, which overlaps
    expect(kinds(drawnHere(bare), "overlap").length).toBeGreaterThan(0)
  })
})

describe("a pad joined to a pour by its spokes", () => {
  // A fill of A that reaches the two pads of A only at their edges (the spokes), never their centres, and one of B that meets a pad of A.
  const p = imp(board({ nets: NETS, body: [footprint({ ref: "R1", at: "5 5", pads: [pad({ number: "1", at: "0 0", net: net(1, "A") })] }), footprint({ ref: "R2", at: "15 5", pads: [pad({ number: "1", at: "0 0", net: net(1, "A") })] })], outline: OUTLINE }))
  const conn = computeConnectivity(p)
  const a = conn.nets.find((n) => n.name === "A")!.id
  const strip = (netId: string): ZoneFill => ({ zoneId: "z1", netId, netName: "", layer: "top", polygons: [[[{ x: 5.4, y: -5.1 }, { x: 14.6, y: -5.1 }, { x: 14.6, y: -4.9 }, { x: 5.4, y: -4.9 }]]] } as ZoneFill)
  it("is connected through it, as KiCad joins a pad its fill touches", () => {
    expect(analysis(p).ratsnest).toHaveLength(1)
    expect(analysis(p, { fills: [strip(a)] }).ratsnest).toEqual([])
  })
  it("but not through a fill of another net", () => {
    expect(analysis(p, { fills: [strip("net:B")] }).ratsnest).toHaveLength(1)
  })
})

describe("the checks KiCad does not have", () => {
  const text = board({
    nets: NETS,
    body: [
      // a via in an SMD pad, and a part whose courtyard runs past the outline
      footprint({ ref: "R1", at: "10 5", pads: [pad({ at: "0 0", size: "1 1", net: net(1, "A") })], extra: '(fp_rect (start -0.6 -0.6) (end 0.6 0.6) (stroke (width 0.05) (type solid)) (fill none) (layer "F.CrtYd"))' }),
      `(via (at 10 5) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net 1))`,
      footprint({ ref: "J1", at: "39.8 10", pads: [pad({ at: "-1 0", size: "1 1" })], extra: '(fp_rect (start -2 -1) (end 1 1) (stroke (width 0.05) (type solid)) (fill none) (layer "F.CrtYd"))' }),
    ],
    outline: OUTLINE,
  })
  it("are not run on a project from KiCad, and are on the same project drawn here", () => {
    const p = imp(text)
    expect(kinds(p, "via-in-pad")).toEqual([])
    expect(kinds(p, "outside-board")).toEqual([])
    expect(kinds(drawnHere(p), "via-in-pad").length).toBeGreaterThan(0)
    expect(kinds(drawnHere(p), "outside-board").map((v) => v.message)).toEqual(["J1 is outside the board outline"])
  })
  it("and a part only the board has is the user's own footprint, not one made from memory", () => {
    const p = imp(text)
    expect(p.parts?.every((s) => s.source?.pins === "import")).toBe(true)
    expect(partFindings(p)).toEqual([])
    // an import made before the board's parts said so: the same, by their footprints from the board
    expect(partFindings({ ...p, parts: p.parts!.map((s) => ({ ...s, source: undefined })) })).toEqual([])
  })
})

describe("a hole against the copper of its own part", () => {
  it("is held to the board's hole clearance on a project from KiCad, as KiCad's hole_clearance is (a USB-C receptacle's pegs by its pads)", () => {
    const p = imp(board({ nets: NETS, body: [footprint({ ref: "J1", at: "10 5", pads: [pad({ number: "1", at: "0 0", size: "0.6 1", net: net(1, "A") }), pad({ number: "", type: "np_thru_hole", shape: "circle", at: "0.75 0", size: "0.65 0.65", layers: '"*.Cu" "*.Mask"', extra: "(drill 0.65)" })] })], outline: OUTLINE }))
    const found = kinds(p, "clearance").map((v) => v.message)
    expect(found).toHaveLength(1)
    expect(found[0]).toMatch(/^Hole clearance 0\.125 mm < 0\.25 mm between the hole of J1\.pad and J1\.1$/)
  })
})

describe("pads of one number", () => {
  const twoPegs = (netText: string, flags = "") =>
    imp(board({ nets: ['(net 0 "")', net(1, "A"), net(3, "unconnected-(J1-MP)")], body: [footprint({ ref: "J1", at: "10 5", pads: [pad({ number: "MP", at: "-3 0", net: netText }), pad({ number: "MP", at: "3 0", net: netText }), pad({ number: "1", at: "0 0", net: net(1, "A") })], extra: flags })], outline: OUTLINE }))
  it("on a net the board file gives them are a connection to make, as KiCad draws one", () => {
    expect(kinds(twoPegs(net(3, "unconnected-(J1-MP)")), "unrouted").map((v) => v.message)).toEqual(["Unrouted connection on unconnected-(J1-MP)"])
  })
  it("but not on a footprint that says they are jumpers, or when the file left them on no net", () => {
    expect(kinds(twoPegs(net(3, "unconnected-(J1-MP)"), "(duplicate_pad_numbers_are_jumpers yes)"), "unrouted")).toEqual([])
    expect(kinds(twoPegs(""), "unrouted")).toEqual([])
  })
})

describe("the project file's severities", () => {
  const pro = (settings: Record<string, unknown>) => ({ board: { design_settings: { rule_severities: settings.drc ?? {}, rules: settings.rules ?? {} } }, erc: { rule_severities: settings.erc ?? {}, ...(settings.pinMap ? { pin_map: settings.pinMap } : {}) } })
  it("are kept for the rules the editor maps, KiCad 7's name of hole_to_hole included, and the pin table only when it is not KiCad's", () => {
    expect(kicadChecksOf(pro({ drc: { clearance: "warning", courtyards_overlap: "ignore", silk_overlap: "ignore", hole_near_hole: "error" }, erc: { pin_not_connected: "ignore", lib_symbol_issues: "ignore" } }))).toEqual({
      drc: { clearance: "warning", courtyards_overlap: "ignore", hole_to_hole: "error" },
      erc: { pin_not_connected: "ignore" },
    })
    const table = DEFAULT_PIN_MAP.map((r) => [...r].map(Number))
    expect(kicadChecksOf(pro({ pinMap: table }))).toBeNull()
    table[1][1] = 1
    expect(kicadChecksOf(pro({ pinMap: table }))?.pinMap?.[1]).toBe("010100102222")
    expect(kicadChecksOf(pro({ rules: { min_hole_clearance: 0.3, min_track_width: 0 } }))).toEqual({ holeClearance: 0.3, noMinimum: ["minTraceWidth"] })
  })
  it("set what a project from KiCad reports: ignore hides a check, warning makes one a warning, and KiCad's default stands for the rest", () => {
    const p = { ...imp(board({ nets: NETS, body: [], outline: OUTLINE })), kicad: { checks: kicadChecksOf(pro({ drc: { clearance: "warning", courtyards_overlap: "ignore" }, erc: { pin_not_connected: "ignore" } }))! } }
    expect(boardCheckSeverity(p, "clearance", "error")).toBe("warning")
    expect(boardCheckSeverity(p, "overlap", "warning")).toBeNull()
    // KiCad's defaults: an unrouted connection is an error there, a dangling track a warning
    expect(boardCheckSeverity(p, "unrouted", "warning")).toBe("error")
    expect(boardCheckSeverity(p, "floating-copper", "warning", "track_dangling")).toBe("warning")
    // a check KiCad does not have is not reported at all
    expect(boardCheckSeverity(p, "via-in-pad", "error")).toBeNull()
    expect(unconnectedPinSeverity(p)).toBeNull()
    expect(ercCheckSeverity(p, "pin-conflict", "error")).toBe("error")
    expect(ercCheckSeverity(p, "bare-led")).toBeNull()
    // a project drawn here keeps the editor's own
    expect(boardCheckSeverity(drawnHere(p), "overlap", "warning")).toBe("warning")
    expect(unconnectedPinSeverity(drawnHere(p))).toBe("warning")
  })
  it("reach the checks through the import of a project file", () => {
    const pcb = board({ nets: NETS, body: [seg("5 5", "15 5", 1), seg("5 5.35", "15 5.35", 2), footprint({ ref: "R1", at: "20 10", pads: [pad({ at: "0 0" })], extra: '(fp_rect (start -1 -1) (end 1 1) (stroke (width 0.05) (type solid)) (fill none) (layer "F.CrtYd"))' }), footprint({ ref: "R2", at: "21 10", pads: [pad({ at: "0 0" })], extra: '(fp_rect (start -1 -1) (end 1 1) (stroke (width 0.05) (type solid)) (fill none) (layer "F.CrtYd"))' })], outline: OUTLINE })
    const run = (severities: Record<string, string>) => {
      const r = importKicadProject(
        [
          { path: "demo.kicad_pcb", data: pcb },
          { path: "demo.kicad_pro", data: JSON.stringify({ meta: { filename: "demo.kicad_pro", version: 1 }, board: { design_settings: { rule_severities: severities } } }) },
        ],
        { built: ALL },
      )
      if (r.status !== "imported") throw new Error(`refused: ${r.message}`)
      return analysis(r.project).violations
    }
    const plain = run({})
    expect(plain.filter((v) => v.kind === "clearance").map((v) => v.severity)).toEqual(["error"])
    expect(plain.filter((v) => v.kind === "overlap").map((v) => v.severity)).toEqual(["error"])
    const set = run({ clearance: "warning", courtyards_overlap: "ignore" })
    expect(set.filter((v) => v.kind === "clearance").map((v) => v.severity)).toEqual(["warning"])
    expect(set.filter((v) => v.kind === "overlap")).toEqual([])
  })
})
