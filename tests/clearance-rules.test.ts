import { describe, expect, it } from "vitest"
import { runTool } from "../src/ai/tools"
import { kicadCustomRules } from "../src/export/kicadPost"
import { fabricationNotes } from "../src/export/notes"
import { autoroute } from "../src/model/autoroute"
import { computeConnectivity } from "../src/model/connectivity"
import { pcbPads } from "../src/model/instances"
import { classIndex, classPourClearance, normalizeClearanceRules, removeClearanceRule, renameClassNets, setClearanceRule } from "../src/model/netClasses"
import { addComponent, createProject, labelPin, removeItems, resolvePinSpec, updateComponent } from "../src/model/ops"
import { analyzePcb } from "../src/model/pcb"
import { normalizeProject } from "../src/model/projectFile"
import { DEFAULT_RULES } from "../src/model/rules"
import { settleEdit } from "../src/model/settleEdit"
import { renameNets } from "../src/model/tidy"
import type { DesignRules, Project } from "../src/model/types"
import { chipBoard, drcErrors } from "./finePitch"

// Clearance rules: a clearance of its own for one pair of nets, or for one part's pads against every other net, in place of what the
// classes give, smaller or larger (KiCad's custom rules). An assistant over MCP had no way to let a relay's own pins sit closer than
// its Mains class, or to set one pair of nets apart: a class can only hold its nets from every other.

const rules = (extra: Partial<DesignRules> = {}): DesignRules => ({ ...DEFAULT_RULES, ...extra })

/** Two 0603 resistors side by side on the board, R1.2 on A and R2.1 on B, their facing pads `gap` mm apart. */
function pair(gap: number): Project {
  let p = createProject("pair")
  p = addComponent(p, "resistor", { ref: "R1", sch: { x: 0, y: 0, rot: 0 } }).project
  p = addComponent(p, "resistor", { ref: "R2", sch: { x: 6, y: 0, rot: 0 } }).project
  for (const [pin, net] of [["R1.1", "C"], ["R1.2", "A"], ["R2.1", "B"], ["R2.2", "D"]]) p = labelPin(p, resolvePinSpec(p, pin)!, net)
  const place = (q: Project, ref: string, x: number) => updateComponent(q, q.components.find((c) => c.ref === ref)!.id, { pcb: { x, y: 0, rot: 0, side: "top", placed: true } })
  p = place(p, "R1", 0)
  const [a, b] = pcbPads(p.components.find((c) => c.ref === "R1")!).sort((x, y) => x.x - y.x)
  // R2's left pad sits `gap` past R1's right pad: R2's origin is as far from its left pad as R1's from its own.
  return place(p, "R2", b.x + b.width / 2 + gap + b.width / 2 + (0 - a.x))
}

const clearanceErrors = (p: Project) =>
  analyzePcb(p, computeConnectivity(p))
    .violations.filter((v) => v.kind === "clearance")
    .map((v) => v.message)

const idOf = (p: Project, ref: string) => p.components.find((c) => c.ref === ref)!.id

describe("the clearance two pieces of copper keep", () => {
  it("is a pair rule's for those two nets, either way round, smaller or larger than the classes'", () => {
    const r = rules({ netClasses: [{ name: "Mains", nets: ["L", "N"], clearance: 2.5 }] })
    expect(classIndex(r).pair("L", "N")).toBe(2.5)
    const ruled = setClearanceRule(r, { nets: ["N", "L"], clearance: 1.5 })
    expect(classIndex(ruled).pair("L", "N")).toBe(1.5)
    expect(classIndex(ruled).pair("N", "L")).toBe(1.5)
    // Every other pair keeps what the classes give.
    expect(classIndex(ruled).pair("L", "GND")).toBe(2.5)
    expect(classIndex(setClearanceRule(r, { nets: ["L", "N"], clearance: 4 })).pair("L", "N")).toBe(4)
  })

  it("is a part rule's for that part's pads against any net, the largest where several apply, never below the board minimum", () => {
    let r = rules({ netClasses: [{ name: "Mains", nets: ["L"], clearance: 2.5 }] })
    r = setClearanceRule(r, { component: "k1", clearance: 1 })
    const index = classIndex(r)
    expect(index.pair("L", "COIL", "k1")).toBe(1)
    expect(index.pair("COIL", "L", null, "k1")).toBe(1)
    expect(index.pair("L", "COIL")).toBe(2.5)
    expect(index.pair("L", "COIL", "u2")).toBe(2.5)
    r = setClearanceRule(r, { nets: ["L", "COIL"], clearance: 1.5 })
    expect(classIndex(r).pair("L", "COIL", "k1")).toBe(1.5)
    expect(classIndex({ ...r, minClearance: 1.2 }).pair("X", "Y", "k1")).toBe(1.2)
    expect(classIndex(r).worst).toBe(2.5)
    expect(classIndex(setClearanceRule(r, { nets: ["A", "B"], clearance: 3 })).worst).toBe(3)
  })

  it("reaches the pours the same way, max'ed with the zone's own", () => {
    const r = setClearanceRule(rules({ netClasses: [{ name: "Mains", nets: ["L"], clearance: 2.5 }] }), { component: "k1", clearance: 1 })
    expect(classPourClearance(r, "GND", "L")).toBe(2.5)
    expect(classPourClearance(r, "GND", "L", "k1")).toBe(1)
    expect(classPourClearance(setClearanceRule(rules(), { nets: ["GND", "L"], clearance: 0.8 }), "GND", "L")).toBe(0.8)
  })

  it("is set, replaced and removed one target at a time, and reads back from a file only when valid", () => {
    let r = setClearanceRule(rules(), { nets: ["A", "B"], clearance: 0.5 })
    r = setClearanceRule(r, { nets: ["B", "A"], clearance: 0.6 })
    expect(r.clearanceRules).toEqual([{ nets: ["B", "A"], clearance: 0.6 }])
    expect(setClearanceRule(r, { nets: ["A", "A"], clearance: 1 })).toBe(r)
    expect(setClearanceRule(r, { clearance: 1 })).toBe(r)
    expect(removeClearanceRule(r, { nets: ["A", "B"] }).clearanceRules).toBeUndefined()
    expect(removeClearanceRule(r, { component: "x" })).toBe(r)
    expect(
      normalizeClearanceRules([{ nets: ["A", "B"], clearance: 1 }, { nets: ["B", "A"], clearance: 2 }, { component: "c1", clearance: 0.3 }, { nets: ["A"], clearance: 1 }, { component: "c2", clearance: -1 }, { nets: ["A", "B"], component: "c3", clearance: 1 }, null]),
    ).toEqual([
      { nets: ["A", "B"], clearance: 1 },
      { component: "c1", clearance: 0.3 },
    ])
  })

  it("follows a net that is renamed, merging rules that end up on one pair", () => {
    let r = setClearanceRule(rules(), { nets: ["A", "B"], clearance: 0.5 })
    r = setClearanceRule(r, { nets: ["A2", "B"], clearance: 0.7 })
    r = setClearanceRule(r, { nets: ["A", "C"], clearance: 0.9 })
    const next = renameClassNets(r, { A2: "A", C: "B" })
    expect(next.clearanceRules).toEqual([{ nets: ["A", "B"], clearance: 0.9 }])
    expect(renameClassNets(r, { Z: "Y" })).toBe(r)
  })
})

describe("checks with clearance rules", () => {
  it("hold a pair of nets to its rule and a part's pads to theirs, in place of the board's clearance", () => {
    const p = pair(0.25)
    expect(clearanceErrors(p)).toEqual([])
    const wider = { ...p, rules: setClearanceRule(p.rules, { nets: ["A", "B"], clearance: 0.4 }) }
    expect(clearanceErrors(wider)).toEqual(["Clearance 0.250 mm < 0.4 mm between R1.2 and R2.1"])
    const tight = { ...p, rules: { ...p.rules, clearance: 0.3 } }
    expect(clearanceErrors(tight)).toHaveLength(1)
    expect(clearanceErrors({ ...tight, rules: setClearanceRule(tight.rules, { component: idOf(p, "R2"), clearance: 0.2 }) })).toEqual([])
    expect(clearanceErrors({ ...tight, rules: setClearanceRule(tight.rules, { nets: ["A", "B"], clearance: 0.2 }) })).toEqual([])
  })

  it("survive a reload and a rename of the net", () => {
    const p = { ...pair(0.25), rules: setClearanceRule(pair(0.25).rules, { nets: ["A", "B"], clearance: 0.4 }) }
    expect(normalizeProject(JSON.parse(JSON.stringify(p))).rules.clearanceRules).toEqual([{ nets: ["A", "B"], clearance: 0.4 }])
    expect(renameNets(p, { A: "AA" }).rules.clearanceRules).toEqual([{ nets: ["AA", "B"], clearance: 0.4 }])
  })
})

describe("routing with a part's clearance rule", () => {
  it("routes a 0.5 mm pitch chip whose pads sit closer than the board's clearance, and adds no clearance error", () => {
    // 0.3 mm pads 0.2 mm apart on a board at 0.3 mm: no trace can leave a pad.
    let p = chipBoard({ name: "TSSOP28", footprint: "tssop28_p0.5mm", leads: 28, board: { width: 44, height: 38 } })
    p = { ...p, rules: { ...p.rules, clearance: 0.3 } }
    const before = drcErrors(p).map((v) => v.message)
    expect(autoroute(p, { timeLimitMs: Infinity }).remaining).toBe(28)
    const ruled = { ...p, rules: setClearanceRule(p.rules, { component: idOf(p, "U1"), clearance: 0.2 }) }
    const res = autoroute(ruled, { timeLimitMs: Infinity })
    expect(res.remaining).toBeLessThanOrEqual(3)
    // Only the resistors' own placement errors, which were there before routing.
    expect(drcErrors(res.project).map((v) => v.message)).toEqual(before)
    // The copper it laid needs the rule: without it the checks find the chip's pads too close.
    expect(drcErrors({ ...res.project, rules: p.rules }).length).toBeGreaterThan(before.length)
  }, 120_000)

  it("keeps a larger rule for a pair of nets while routing", () => {
    const p = pair(3)
    const wide = { ...p, rules: setClearanceRule(p.rules, { nets: ["A", "B"], clearance: 1.2 }) }
    const res = autoroute(wide, { timeLimitMs: Infinity })
    expect(clearanceErrors(res.project)).toEqual([])
  })
})

describe("set_clearance_rule", () => {
  it("sets a rule for two nets or a part's pads, says what the classes gave, lists and removes them", () => {
    const p = pair(0.25)
    const none = runTool(p, "set_clearance_rule", {})
    expect(none.result).toContain("There are no clearance rules")
    const set = runTool(p, "set_clearance_rule", { nets: ["A", "B"], clearance: 0.4 })
    expect(set.isError).toBe(false)
    expect(set.result).toContain("Clearance rule: A and B at 0.4 mm (their classes give 0.2 mm)")
    expect(set.result).toContain("1 check error(s)")
    const both = runTool(set.project, "set_clearance_rule", { ref: "R2", clearance: 0.15 })
    expect(both.result).toContain("R2's pads at 0.15 mm, from copper of every other net")
    expect(both.result).toContain("Clearance rules: A and B at 0.4 mm; R2's pads at 0.15 mm.")
    const design = runTool(both.project, "get_design", {})
    expect(design.result).toContain('"clearance_rules":[{"nets":["A","B"],"clearance":0.4},{"ref":"R2","clearance":0.15}]')
    const gone = runTool(both.project, "set_clearance_rule", { nets: ["B", "A"], remove: true })
    expect(gone.project.rules.clearanceRules).toEqual([{ component: idOf(p, "R2"), clearance: 0.15 }])
  })

  it("refuses an unknown net or part, one net twice, both targets, and a clearance below what the board allows", () => {
    const p = pair(0.25)
    expect(runTool(p, "set_clearance_rule", { nets: ["A", "Q"], clearance: 0.3 }).result).toContain("No net named Q")
    expect(runTool(p, "set_clearance_rule", { nets: ["A", "A"], clearance: 0.3 }).isError).toBe(true)
    expect(runTool(p, "set_clearance_rule", { nets: ["A", "B"], ref: "R1", clearance: 0.3 }).isError).toBe(true)
    expect(runTool(p, "set_clearance_rule", { ref: "R9", clearance: 0.3 }).result).toContain("No part R9")
    expect(runTool(p, "set_clearance_rule", { ref: "R1", clearance: 0.05 }).result).toContain("below the 0.1 mm the finest fab class makes")
    expect(runTool({ ...p, rules: { ...p.rules, minClearance: 0.15 } }, "set_clearance_rule", { ref: "R1", clearance: 0.12 }).result).toContain("minimum clearance of the board")
    expect(runTool(p, "set_clearance_rule", { ref: "R1", remove: true }).result).toContain("There is no clearance rule for R1's pads")
  })
})

describe("a part's clearance rule and the part", () => {
  it("goes when the part is deleted, and leaves the other rules and an edit that deletes nothing alone", () => {
    const p = pair(0.25)
    const ruled = { ...p, rules: setClearanceRule(setClearanceRule(p.rules, { nets: ["A", "B"], clearance: 0.4 }), { component: idOf(p, "R2"), clearance: 0.15 }) }
    const out = settleEdit(ruled, removeItems(ruled, { components: [idOf(p, "R2")] }))
    expect(out.rules.clearanceRules).toEqual([{ nets: ["A", "B"], clearance: 0.4 }])
    const alone = { ...p, rules: setClearanceRule(p.rules, { component: idOf(p, "R1"), clearance: 0.15 }) }
    expect(settleEdit(alone, removeItems(alone, { components: [idOf(p, "R1")] })).rules.clearanceRules).toBeUndefined()
    const moved = updateComponent(ruled, idOf(p, "R1"), { pcb: { x: 0, y: 5, rot: 0, side: "top", placed: true } })
    expect(settleEdit(ruled, moved).rules).toBe(moved.rules)
  })
})

describe("the KiCad export of clearance rules", () => {
  it("writes custom rules smallest first, each condition both ways round, and lowers the board minimum to the smallest", () => {
    let p = pair(0.25)
    p = { ...p, rules: setClearanceRule(setClearanceRule(p.rules, { nets: ["A", "B"], clearance: 0.4 }), { component: idOf(p, "R2"), clearance: 0.15 }) }
    const out = kicadCustomRules(p)!
    expect(out.text).toBe(
      [
        "(version 1)",
        "",
        '(rule "Clearance R2 pads"',
        "\t(constraint clearance (min 0.15mm))",
        "\t(condition \"(A.Type == 'Pad' && A.memberOfFootprint('R2')) || (B.Type == 'Pad' && B.memberOfFootprint('R2'))\"))",
        "",
        '(rule "Clearance A to B"',
        "\t(constraint clearance (min 0.4mm))",
        "\t(condition \"(A.NetName == 'A' && B.NetName == 'B') || (A.NetName == 'B' && B.NetName == 'A')\"))",
        "",
      ].join("\n"),
    )
    expect(kicadCustomRules(pair(0.25))).toBeNull()
  })

  it("says why a rule is left out even when none is left to write, and skips a part no longer in the project", () => {
    const p = pair(0.25)
    const quoted = { ...p, rules: setClearanceRule(p.rules, { nets: ["A'1", "B"], clearance: 0.4 }) }
    const out = kicadCustomRules(quoted)!
    expect(out.text).toBeNull()
    expect(out.notes.join(" ")).toContain("The clearance rule for A'1 and B is left out")
    const gone = { ...p, rules: setClearanceRule(p.rules, { component: "nobody", clearance: 0.05 }) }
    expect(kicadCustomRules(gone)).toEqual({ text: null, notes: [] })
  })
})

describe("the fabrication notes of clearance rules", () => {
  it("names each rule whole, at the space it is checked at, and leaves out a part no longer in the project", () => {
    const p = pair(0.25)
    let r = setClearanceRule(p.rules, { nets: ["A", "B"], clearance: 0.4 })
    r = setClearanceRule(r, { component: "nobody", clearance: 0.05 })
    r = setClearanceRule(r, { component: idOf(p, "R2"), clearance: 0.08 })
    const notes = fabricationNotes({ ...p, rules: { ...r, minClearance: 0.1 } }, [], []).split("\n")
    const block = notes.slice(notes.indexOf("CLEARANCE RULES"), notes.indexOf("CLEARANCE RULES") + 4)
    expect(block[1]).toMatch(/^ {2}A to B +0\.4 mm space$/)
    expect(block[2]).toMatch(/^ {2}R2 pads +0\.1 mm space to every other net$/)
    expect(block[3]).toMatch(/^ {2}Tightest space +0\.1 mm/)
    const long = setClearanceRule(p.rules, { nets: ["MAINS_LIVE", "MAINS_N"], clearance: 2 })
    expect(fabricationNotes({ ...p, rules: long }, [], [])).toContain("MAINS_LIVE to MAINS_N 2 mm space")
  })
})
