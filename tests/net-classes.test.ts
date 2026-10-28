import { describe, expect, it } from "vitest"
import { runTool } from "../src/ai/tools"
import { autoroute } from "../src/model/autoroute"
import { computeConnectivity } from "../src/model/connectivity"
import {
  addNetClass,
  assignNet,
  classIndex,
  classNameProblem,
  classPourClearance,
  defaultValues,
  freeClassName,
  mapKicadProjectNetClasses,
  normalizeNetClasses,
  overlappingNets,
  patternMatcher,
  pairClearance,
  removeNetClass,
  renameClassNets,
  renameNetClass,
  setClassField,
  setClassPatterns,
  setDefaultClassField,
  splitPatterns,
} from "../src/model/netClasses"
import { netTraceWidth, addVia } from "../src/model/ops"
import { analyzePcb } from "../src/model/pcb"
import { DEFAULT_RULES, normalizeRules } from "../src/model/rules"
import { renameNets } from "../src/model/tidy"
import type { DesignRules, NetClass, Project } from "../src/model/types"
import { built } from "./built"

const rules = (extra: Partial<DesignRules> = {}): DesignRules => ({ ...DEFAULT_RULES, ...extra })
const cls = (name: string, extra: Partial<NetClass> = {}): NetClass => ({ name, nets: [], ...extra })

describe("which class a net is in", () => {
  it("a net no class lists is in Default, and so is copper with no net", () => {
    const r = rules({ netClasses: [cls("Power", { nets: ["VCC"] })] })
    const index = classIndex(r)
    expect(index.classOf("VCC")?.name).toBe("Power")
    expect(index.classOf("SIG")).toBeNull()
    expect(index.classOf(null)).toBeNull()
    expect(index.classOf(undefined)).toBeNull()
    expect(index.classOf("")).toBeNull()
  })
  it("a listed net takes the first class that lists it, before any pattern", () => {
    const r = rules({ netClasses: [cls("A", { patterns: ["V*"] }), cls("B", { nets: ["VCC"] }), cls("C", { nets: ["VCC"] })] })
    expect(classIndex(r).classOf("VCC")?.name).toBe("B")
    expect(classIndex(r).classOf("VDD")?.name).toBe("A")
  })
  it("a pattern is a wildcard or a regular expression, anchored at both ends, and either matcher is enough (KiCad's net class matcher)", () => {
    const m = (p: string, n: string) => patternMatcher(p)(n)
    expect(m("USB_*", "USB_DP")).toBe(true)
    expect(m("USB_*", "XUSB_DP")).toBe(false)
    expect(m("D?", "D1")).toBe(true)
    expect(m("D?", "D12")).toBe(false)
    expect(m("/clk.*", "/clk.main")).toBe(true)
    expect(m("/clk.*", "clk.main")).toBe(false)
    expect(m("clk.*", "clk.main")).toBe(true)
    expect(m("^(A|B)[0-9]$", "B7")).toBe(true)
    // the wildcard matcher takes every other character literally
    expect(m("Net-(R1-Pad1)", "Net-(R1-Pad1)")).toBe(true)
    expect(m("a+b", "a+b")).toBe(true)
    // a pattern that is no regular expression has only the wildcard matcher
    expect(m("a[", "a[")).toBe(true)
    expect(m("a[", "a")).toBe(false)
    expect(m("*", "")).toBe(true)
    expect(m("a*b*c", "aXXbYYc")).toBe(true)
    expect(m("a*b*c", "aXXbYY")).toBe(false)
    expect(m("??", "\u00e9\u{1F600}")).toBe(true)
  })
  it("a hostile pattern cannot hang a lookup: stars take linear time, and a regular expression that repeats a group is not run", () => {
    const name = "a".repeat(200)
    const t0 = performance.now()
    expect(patternMatcher("a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*b")(name)).toBe(false)
    // (a+)+$ would take exponential time on a name that ends in b; it is read as a wildcard pattern only
    expect(patternMatcher("(a+)+$")("a".repeat(40) + "b")).toBe(false)
    expect(patternMatcher("(a|a)*b")("a".repeat(40) + "c")).toBe(false)
    // a back reference and a pattern over the limit are not run either
    expect(patternMatcher("(a)\\1")("aa")).toBe(false)
    expect(patternMatcher("a".repeat(500))("a".repeat(500))).toBe(true)
    expect(performance.now() - t0).toBeLessThan(500)
  })
  it("the Default class takes the rules' sizes, and a class's own sizes override them", () => {
    const r = rules({ clearance: 0.2, traceWidth: 0.25, viaDiameter: 0.6, viaDrill: 0.3, netClasses: [cls("HV", { nets: ["HV"], clearance: 0.6, traceWidth: 0.4 })], defaultClass: { diffPairWidth: 0.2 } })
    const hv = classIndex(r).values("HV")
    expect(hv).toMatchObject({ name: "HV", clearance: 0.6, traceWidth: 0.4, viaDiameter: 0.6, viaDrill: 0.3, diffPairWidth: 0.2 })
    expect(classIndex(r).values("X")).toEqual(defaultValues(r))
    expect(defaultValues(r)).toMatchObject({ name: "Default", clearance: 0.2, diffPairWidth: 0.2 })
  })
})

describe("the clearance two nets are checked at", () => {
  const r = rules({ clearance: 0.2, netClasses: [cls("HV", { nets: ["HV1", "HV2"], clearance: 0.6 }), cls("Fine", { nets: ["F1", "F2"], clearance: 0.1 })] })
  it("is the larger of their classes', Default's being the rules'", () => {
    expect(pairClearance(r, "HV1", "SIG")).toBe(0.6)
    expect(pairClearance(r, "SIG", "HV1")).toBe(0.6)
    expect(pairClearance(r, "HV1", "HV2")).toBe(0.6)
    expect(pairClearance(r, "SIG", "SIG2")).toBe(0.2)
    expect(pairClearance(r, "HV1", "F1")).toBe(0.6)
  })
  it("is the lower class's alone when both nets are in a class below Default, and Default's against Default or copper with no net", () => {
    expect(pairClearance(r, "F1", "F2")).toBe(0.1)
    expect(pairClearance(r, "F1", "SIG")).toBe(0.2)
    expect(pairClearance(r, "F1", null)).toBe(0.2)
    expect(pairClearance(r, null, null)).toBe(0.2)
  })
  it("never goes below the board's minimum clearance", () => {
    expect(pairClearance({ ...r, minClearance: 0.15 }, "F1", "F2")).toBe(0.15)
    expect(pairClearance({ ...rules({ clearance: 0.2 }), minClearance: 0.3 }, "A", "B")).toBe(0.3)
  })
  it("is the rules' clearance for a board with no classes, whatever the nets", () => {
    expect(pairClearance(rules({ clearance: 0.35 }), "A", "B")).toBe(0.35)
    expect(classIndex(rules({ clearance: 0.35 })).worst).toBe(0.35)
    expect(classIndex(r).worst).toBe(0.6)
  })
  it("a pour keeps a class's clearance only where the class names one, and the Default class adds nothing to the pour's own", () => {
    expect(classPourClearance(r, "GND", "HV1")).toBe(0.6)
    expect(classPourClearance(r, "HV1", "SIG")).toBe(0.6)
    expect(classPourClearance(r, "GND", "SIG")).toBe(0)
    expect(classPourClearance(r, "F1", "F2")).toBe(0.1)
    expect(classPourClearance(rules(), "GND", "SIG")).toBe(0)
  })
})

describe("editing classes (the Inspector's logic)", () => {
  it("adds, renames, sets, assigns and removes, one immutable step each", () => {
    const r0 = rules()
    const r1 = addNetClass(r0, "Power")
    expect(r0.netClasses).toBeUndefined()
    expect(r1.netClasses).toEqual([{ name: "Power", nets: [] }])
    const r2 = setClassField(setClassField(r1, "Power", "clearance", 0.4), "Power", "traceWidth", 0.5)
    expect(r2.netClasses![0]).toMatchObject({ clearance: 0.4, traceWidth: 0.5 })
    const r3 = assignNet(assignNet(r2, "VCC", "Power"), "GND", "Power")
    expect(r3.netClasses![0].nets).toEqual(["VCC", "GND"])
    const r4 = renameNetClass(r3, "Power", "Supply")
    expect(r4.netClasses![0].name).toBe("Supply")
    expect(assignNet(r4, "VCC", null).netClasses![0].nets).toEqual(["GND"])
    // removing the last class leaves a board with no classes at all, not an empty list
    expect(removeNetClass(r4, "Supply")).not.toHaveProperty("netClasses")
  })
  it("a net is in one class: assigning it to another takes it out of the first", () => {
    let r = addNetClass(addNetClass(rules(), "A"), "B")
    r = assignNet(assignNet(r, "X", "A"), "X", "B")
    expect(r.netClasses!.map((c) => c.nets)).toEqual([[], ["X"]])
    // assigning to a class that does not exist changes nothing
    expect(assignNet(r, "X", "Nope")).toBe(r)
  })
  it("a field set to undefined goes back to Default's, and a size that is not a positive number is refused (a clearance may be 0)", () => {
    const r = setClassField(addNetClass(rules(), "A", { traceWidth: 0.3 }), "A", "traceWidth", undefined)
    expect(r.netClasses![0]).not.toHaveProperty("traceWidth")
    expect(setClassField(r, "A", "traceWidth", -1)).toBe(r)
    expect(setClassField(r, "A", "viaDrill", 0)).toBe(r)
    expect(setClassField(r, "A", "clearance", 0).netClasses![0].clearance).toBe(0)
    expect(setClassField(r, "A", "clearance", Number.NaN)).toBe(r)
  })
  it("names: Default and a taken name are refused, and a new class gets a free one", () => {
    const r = addNetClass(rules(), "Power")
    expect(classNameProblem(r, "Default")).toMatch(/Default/)
    expect(classNameProblem(r, "")).toMatch(/name/)
    expect(classNameProblem(r, "Power")).toMatch(/already/)
    expect(classNameProblem(r, "Power", "Power")).toBeNull()
    expect(classNameProblem(r, "power")).toBeNull()
    expect(freeClassName(r, "Power")).toBe("Power 2")
    expect(freeClassName(addNetClass(r, "Power"), "Power")).toBe("Power 3")
    expect(renameNetClass(r, "Power", "Default")).toBe(r)
    // the Default class may have a name of its own, which a class cannot take either
    expect(classNameProblem({ ...r, defaultClass: { name: "Standard" } }, "Standard")).toMatch(/Default class/)
  })
  it("patterns and the Default class's own fields", () => {
    const r = setClassPatterns(addNetClass(rules(), "USB"), "USB", ["USB_*", " ", "USB_*", "D+"])
    expect(r.netClasses![0].patterns).toEqual(["USB_*", "D+"])
    expect(setClassPatterns(r, "USB", []).netClasses![0]).not.toHaveProperty("patterns")
    const d = setDefaultClassField(rules(), "diffPairGap", 0.25)
    expect(d.defaultClass).toEqual({ diffPairGap: 0.25 })
    expect(setDefaultClassField(d, "diffPairGap", undefined)).not.toHaveProperty("defaultClass")
    expect(setDefaultClassField(d, "diffPairGap", -1)).toBe(d)
  })
  it("the one line of patterns splits at commas outside brackets", () => {
    expect(splitPatterns("USB_*, (A|B)[0-9]{1,3}, D+")).toEqual(["USB_*", " (A|B)[0-9]{1,3}", " D+"])
    expect(splitPatterns("")).toEqual([""])
    expect(splitPatterns("a(b")).toEqual(["a(b"])
  })
  it("a class follows a net that was renamed, and a rename that touches no class is the same object", () => {
    const r = rules({ netClasses: [cls("A", { nets: ["N1", "N2"] }), cls("B", { nets: ["N3"] })] })
    const next = renameClassNets(r, { N1: "VCC" })
    expect(next.netClasses!.map((c) => c.nets)).toEqual([["VCC", "N2"], ["N3"]])
    expect(next.netClasses![1]).toBe(r.netClasses![1])
    expect(renameClassNets(r, { Z: "Y" })).toBe(r)
    expect(renameClassNets(rules(), { Z: "Y" }).netClasses).toBeUndefined()
  })
  it("the tidy's net renaming reaches the classes", () => {
    const base = built("blinker")
    const net = computeConnectivity(base).nets.find((n) => n.pins.length > 1)!.name
    const p: Project = { ...base, rules: { ...base.rules, netClasses: [cls("A", { nets: [net] })] } }
    expect(renameNets(p, { [net]: "RENAMED" }).rules.netClasses![0].nets).toEqual(["RENAMED"])
    expect(renameNets(base, {}).rules.netClasses).toBeUndefined()
  })
})

describe("the rules in a stored project", () => {
  it("a class with no name, a repeated name, or Default's name is dropped; sizes that are not numbers are left out; nets and patterns are clean lists", () => {
    const out = normalizeNetClasses([
      { name: "ok", nets: ["a", "a", "", 3], clearance: 0, traceWidth: -1, viaDiameter: "x", viaDrill: 0.3, patterns: ["p", "p", ""] },
      { name: "ok", nets: [] },
      { name: "Default", nets: [] },
      { name: "", nets: [] },
      { nets: [] },
      null,
      "text",
    ])
    expect(out).toEqual([{ name: "ok", nets: ["a"], clearance: 0, viaDrill: 0.3, patterns: ["p"] }])
    expect(normalizeNetClasses("nope")).toEqual([])
  })
  it("normalizeRules keeps valid X10 rules and removes invalid ones", () => {
    const r = normalizeRules({
      netClasses: [cls("A", { nets: ["N"], clearance: 0.3 })],
      defaultClass: { description: "mine", diffPairWidth: 0.2, microViaDrill: -1 },
      viaSizes: [{ diameter: 0.8, drill: 0.4 }, { diameter: 0.8, drill: 0.4 }, { diameter: 0, drill: 0.2 }],
      diffPairSizes: [{ width: 0.2, gap: 0.25, viaGap: 0.3 }, { width: -1, gap: 0.2 }],
      minViaDrill: 0.3,
      minClearance: 0,
      maskMinWidth: 0.1,
      pasteRatio: -0.1,
      maxError: Number.NaN,
      maskBridgesInParts: true,
    } as Partial<DesignRules>)
    expect(r.netClasses).toEqual([{ name: "A", nets: ["N"], clearance: 0.3 }])
    expect(r.defaultClass).toEqual({ description: "mine", diffPairWidth: 0.2 })
    expect(r.viaSizes).toEqual([{ diameter: 0.8, drill: 0.4 }])
    expect(r.diffPairSizes).toEqual([{ width: 0.2, gap: 0.25, viaGap: 0.3 }])
    expect(r).toMatchObject({ minViaDrill: 0.3, maskMinWidth: 0.1, pasteRatio: -0.1, maskBridgesInParts: true })
    for (const k of ["minClearance", "maxError"]) expect(r).not.toHaveProperty(k)
    // nothing is added for a board that has none of it
    const plain = normalizeRules({})
    for (const k of ["netClasses", "defaultClass", "viaSizes", "diffPairSizes", "minViaDrill", "minClearance", "maskMinWidth", "pasteRatio", "maxError", "maskBridgesInParts"]) expect(plain).not.toHaveProperty(k)
    expect(plain).toEqual(DEFAULT_RULES)
  })
})

describe("mapping a .kicad_pro into the model", () => {
  it("the Default class is the rules; another class is a NetClass with the nets and patterns the file gives it, in priority order", () => {
    const m = mapKicadProjectNetClasses(
      {
        classes: [
          { name: "Default", clearance: 0.15, track_width: 0.2, via_diameter: 0.5, via_drill: 0.25, diff_pair_width: 0.18, diff_pair_gap: 0.2, microvia_diameter: 0.3, microvia_drill: 0.1 },
          { name: "Low", priority: 5, clearance: 0.1 },
          { name: "High", priority: 1, clearance: 0.6, track_width: 0.5, via_diameter: 0.9, via_drill: 0.5 },
        ],
        patterns: [{ netclass: "High", pattern: "HV_*" }],
        assignments: { VCC: "High", GND: ["Low"], X: null },
      },
      DEFAULT_RULES,
      ["VCC", "GND", "HV_A", "SIG"],
    )
    expect(m.problems).toEqual([])
    expect(m.rules).toMatchObject({ clearance: 0.15, traceWidth: 0.2, viaDiameter: 0.5, viaDrill: 0.25 })
    expect(m.rules.defaultClass).toEqual({ diffPairWidth: 0.18, diffPairGap: 0.2, microViaDiameter: 0.3, microViaDrill: 0.1 })
    expect(m.rules.netClasses).toEqual([
      { name: "High", clearance: 0.6, traceWidth: 0.5, viaDiameter: 0.9, viaDrill: 0.5, nets: ["VCC"], patterns: ["HV_*"] },
      { name: "Low", clearance: 0.1, nets: ["GND"] },
    ])
    const r = { ...DEFAULT_RULES, ...m.rules }
    expect(classIndex(r).classOf("HV_A")?.name).toBe("High")
  })
  it("names what it cannot keep: a class the file does not define, a repeated class, a net in two classes", () => {
    const m = mapKicadProjectNetClasses({ classes: [{ name: "Default" }, { name: "A" }, { name: "B" }, { name: "A" }], patterns: [{ netclass: "Nope", pattern: "x" }, { netclass: "B", pattern: "V*" }], assignments: { VCC: ["A", "B"], Y: "Gone" } }, DEFAULT_RULES, ["VCC"])
    expect(m.problems.join("\n")).toMatch(/two net classes are named "A"/)
    expect(m.problems.join("\n")).toMatch(/pattern "x" names the class "Nope"/)
    expect(m.problems.join("\n")).toMatch(/net "Y" is in the class "Gone"/)
    expect(m.problems.join("\n")).toMatch(/net "VCC" is claimed by more than one class/)
    expect(m.overlapping).toEqual(["VCC"])
  })
  it("a file with no Default class has the base rules, and overlappingNets counts a listed net and a pattern as two claims", () => {
    const m = mapKicadProjectNetClasses({ classes: [{ name: "A", clearance: 0.3 }], patterns: [] }, { clearance: 0.21, traceWidth: 0.22, viaDiameter: 0.7, viaDrill: 0.35 })
    expect(m.rules).toMatchObject({ clearance: 0.21, traceWidth: 0.22, viaDiameter: 0.7, viaDrill: 0.35 })
    expect(overlappingNets({ netClasses: [cls("A", { nets: ["V1"] }), cls("B", { patterns: ["V*"] })] }, ["V1", "V2", "W"])).toEqual(["V1"])
  })
})

describe("what new copper starts with", () => {
  const base = built("regulator")
  const conn = computeConnectivity(base)
  const [n1, n2] = conn.nets.filter((n) => n.pins.length >= 2).map((n) => n.name)
  const classed = (extra: Partial<NetClass>, widths?: Record<string, number>): Project => ({
    ...base,
    rules: { ...base.rules, ...(widths ? { netWidths: widths } : {}), netClasses: [cls("Power", { nets: [n1], ...extra })] },
  })
  it("a trace takes its class's width, a width set for the net wins over it, and every other net keeps the rules'", () => {
    expect(netTraceWidth(classed({ traceWidth: 0.7 }).rules, n1)).toBe(0.7)
    expect(netTraceWidth(classed({ traceWidth: 0.7 }, { [n1]: 0.9 }).rules, n1)).toBe(0.9)
    expect(netTraceWidth(classed({ traceWidth: 0.7 }).rules, n2)).toBe(base.rules.traceWidth)
    expect(netTraceWidth(classed({}).rules, n1)).toBe(base.rules.traceWidth)
    expect(netTraceWidth(base.rules, n1)).toBe(base.rules.traceWidth)
    expect(netTraceWidth(base.rules, null)).toBe(base.rules.traceWidth)
  })
  it("a via takes its class's size", () => {
    const p = classed({ viaDiameter: 1, viaDrill: 0.5 })
    expect(addVia(p, { x: 0, y: 0 }, { net: n1 }).via).toMatchObject({ diameter: 1, drill: 0.5 })
    expect(addVia(p, { x: 0, y: 0 }, { net: n2 }).via).toMatchObject({ diameter: base.rules.viaDiameter, drill: base.rules.viaDrill })
    expect(addVia(p, { x: 0, y: 0 }).via).toMatchObject({ diameter: base.rules.viaDiameter })
  })
})

describe("Checks use the larger clearance of two nets' classes", () => {
  /** The regulator board with its copper cleared and two single traces laid a known distance apart on two nets. */
  const base = built("regulator")
  const conn = computeConnectivity(base)
  const nets = conn.nets.filter((n) => n.pins.length >= 2)
  it("a gap that passes Default fails once one of the nets is in a class that wants more, and passes again when the class wants less", () => {
    const flat = analyzePcb(base, conn).violations.filter((v) => v.kind === "clearance")
    expect(flat).toEqual([])
    const gaps = (p: Project) => analyzePcb(p, computeConnectivity(p)).violations.filter((v) => v.kind === "clearance")
    const tight = { ...base, rules: { ...base.rules, clearance: base.rules.clearance } }
    // every net in a class that wants a clearance far above any gap on the board: all of its copper fails
    const wide: Project = { ...tight, rules: { ...tight.rules, netClasses: [cls("Wide", { clearance: 5, nets: nets.map((n) => n.name) })] } }
    expect(gaps(wide).length).toBeGreaterThan(0)
    expect(gaps(wide).every((v) => /< 5 mm/.test(v.message))).toBe(true)
    // the class with a clearance below the rules' is the larger of itself and itself: nothing new fails, the board is checked at the lower one
    const narrow: Project = { ...tight, rules: { ...tight.rules, netClasses: [cls("Narrow", { clearance: 0.01, nets: nets.map((n) => n.name) })] } }
    expect(gaps(narrow)).toEqual([])
  })
  it("a board with no classes is checked exactly as before", () => {
    const withEmpty: Project = { ...base, rules: { ...base.rules, netClasses: undefined } }
    expect(analyzePcb(withEmpty, computeConnectivity(withEmpty)).violations).toEqual(analyzePcb(base, conn).violations)
  })
})

describe("the router uses each net's class", () => {
  const base = built("regulator")
  const conn = computeConnectivity(base)
  const sigNets = conn.nets.filter((n) => n.pins.length >= 2 && !base.zones.some((z) => z.net === n.name))
  const errors = (p: Project) => analyzePcb(p, computeConnectivity(p)).violations.filter((v) => v.severity === "error")
  it("lays a net at its class's width and vias at its class's size, and the result passes Checks at the class clearances", () => {
    const net = sigNets[0]
    const p: Project = { ...base, traces: [], vias: [], rules: { ...base.rules, netClasses: [cls("Fat", { nets: [net.name], traceWidth: 0.5, clearance: 0.3, viaDiameter: 0.9, viaDrill: 0.5 })] } }
    const res = autoroute(p)
    expect(errors(res.project)).toEqual([])
    const pcb = analyzePcb(res.project, computeConnectivity(res.project))
    const widths = res.project.traces.filter((t) => pcb.traceNet.get(t.id) === net.id).map((t) => t.width)
    expect(widths.length).toBeGreaterThan(0)
    // as with a width given by name: the class's width, or narrower only where a pad is too small
    expect(widths.every((w) => w === 0.5 || w <= 0.4)).toBe(true)
    for (const v of res.project.vias) {
      const viaNet = pcb.viaNet.get(v.id)
      if (viaNet === net.id) expect([v.diameter, v.drill]).toEqual([0.9, 0.5])
      else expect([v.diameter, v.drill]).toEqual([base.rules.viaDiameter, base.rules.viaDrill])
    }
  })
  it("keeps the larger of two classes' clearances between the copper of two nets", () => {
    const [a, b] = sigNets
    // the wide net keeps 0.5 mm from everything, including the other net, which is in Default
    const p: Project = { ...base, traces: [], vias: [], rules: { ...base.rules, netClasses: [cls("Wide", { nets: [a.name], clearance: 0.5 })] } }
    const res = autoroute(p)
    expect(errors(res.project)).toEqual([])
    const pcb = analyzePcb(res.project, computeConnectivity(res.project))
    // no trace of net b comes within 0.5 mm of a trace of net a (copper to copper)
    const segs = (id: string) => res.project.traces.filter((t) => pcb.traceNet.get(t.id) === id)
    const dist = (t1: Project["traces"][number], t2: Project["traces"][number]) => {
      let d = Infinity
      for (let i = 1; i < t1.points.length; i++)
        for (let j = 1; j < t2.points.length; j++) d = Math.min(d, segSeg(t1.points[i - 1], t1.points[i], t2.points[j - 1], t2.points[j]) - t1.width / 2 - t2.width / 2)
      return d
    }
    let closest = Infinity
    for (const x of segs(a.id)) for (const y of segs(b.id)) if (x.layer === y.layer) closest = Math.min(closest, dist(x, y))
    expect(closest).toBeGreaterThanOrEqual(0.5 - 1e-3)
  })
  it("a board with no classes routes exactly as it did", () => {
    const p: Project = { ...base, traces: [], vias: [] }
    const a = autoroute(p)
    const b = autoroute({ ...p, rules: { ...p.rules, netClasses: [] } })
    expect(b.project.traces.map((t) => ({ ...t, id: "" }))).toEqual(a.project.traces.map((t) => ({ ...t, id: "" })))
  })
})

describe("Sakura reads the classes compactly", () => {
  it("get_design says nothing new for a board with no classes, and lists each class with only what it sets", () => {
    const base = built("blinker")
    const plain = JSON.parse(runTool(base, "get_design", {}).result)
    expect(plain.design_rules_mm).not.toHaveProperty("net_classes")
    expect(plain.design_rules_mm).not.toHaveProperty("via_sizes")
    const net = computeConnectivity(base).nets.find((n) => n.pins.length > 1)!.name
    const p: Project = { ...base, rules: { ...base.rules, viaSizes: [{ diameter: 0.8, drill: 0.4 }], maskMinWidth: 0.1, netClasses: [cls("Power", { nets: [net], clearance: 0.4, traceWidth: 0.6, patterns: ["V*"] })] } }
    const d = JSON.parse(runTool(p, "get_design", {}).result).design_rules_mm
    expect(d.net_classes).toEqual([{ name: "Power", clearance: 0.4, trace_width: 0.6, nets: [net], patterns: ["V*"] }])
    expect(d.via_sizes).toEqual(["0.8/0.4"])
    expect(d.mask_min_width).toBe(0.1)
  })
  it("a class with many nets lists the first few and counts the rest", () => {
    const base = built("blinker")
    const nets = Array.from({ length: 60 }, (_, i) => `N${i}`)
    const p: Project = { ...base, rules: { ...base.rules, netClasses: [cls("Big", { nets })] } }
    const d = JSON.parse(runTool(p, "get_design", {}).result).design_rules_mm
    expect(d.net_classes[0].nets).toHaveLength(25)
    expect(d.net_classes[0].nets[24]).toBe("... 36 more")
  })
})

/** Distance between two segments. */
function segSeg(a: { x: number; y: number }, b: { x: number; y: number }, c: { x: number; y: number }, d: { x: number; y: number }): number {
  const pt = (p: { x: number; y: number }, s: { x: number; y: number }, e: { x: number; y: number }) => {
    const dx = e.x - s.x
    const dy = e.y - s.y
    const len = dx * dx + dy * dy
    const t = len === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - s.x) * dx + (p.y - s.y) * dy) / len))
    return Math.hypot(p.x - (s.x + t * dx), p.y - (s.y + t * dy))
  }
  const cross = (o: { x: number; y: number }, p: { x: number; y: number }, q: { x: number; y: number }) => (p.x - o.x) * (q.y - o.y) - (p.y - o.y) * (q.x - o.x)
  const intersects = cross(a, b, c) * cross(a, b, d) < 0 && cross(c, d, a) * cross(c, d, b) < 0
  if (intersects) return 0
  return Math.min(pt(a, c, d), pt(b, c, d), pt(c, a, b), pt(d, a, b))
}

describe("the fine-pitch router uses classes too", () => {
  it("routes the USB-C board with the supply nets in classes of their own: no clearance error, each net at its class's width and via size", async () => {
    const { firstRequest } = await import("./sakura-session")
    const { drcErrors } = await import("./finePitch")
    const s = firstRequest()
    s.must("layout_pcb")
    s.must("set_pour", { net: "GND", layer: "both" })
    const base = s.project
    const p: Project = {
      ...base,
      rules: {
        ...base.rules,
        netClasses: [
          cls("Supply", { nets: ["VBUS", "3V3"], traceWidth: 0.45, clearance: 0.25, viaDiameter: 0.7, viaDrill: 0.35 }),
          cls("Fine", { nets: ["USB_DP", "USB_DM"], clearance: 0.15, traceWidth: 0.2 }),
        ],
      },
    }
    const t0 = performance.now()
    const res = autoroute(p, { timeLimitMs: Infinity })
    const ms = performance.now() - t0
    expect(drcErrors(res.project).map((v) => v.message)).toEqual([])
    const pcb = analyzePcb(res.project, computeConnectivity(res.project))
    const conn = computeConnectivity(res.project)
    const id = (name: string) => conn.nets.find((n) => n.name === name)?.id
    const widths = (name: string) => res.project.traces.filter((t) => pcb.traceNet.get(t.id) === id(name)).map((t) => t.width)
    // the supply nets are laid at their class's width or narrower where a pad is too small, never wider
    for (const w of [...widths("VBUS"), ...widths("3V3")]) expect(w).toBeLessThanOrEqual(0.45 + 1e-9)
    expect(Math.max(...widths("VBUS"))).toBeCloseTo(0.45, 6)
    // vias on those nets are the class's, and every other via is the rules'
    for (const v of res.project.vias) {
      const net = pcb.viaNet.get(v.id)
      const own = net === id("VBUS") || net === id("3V3")
      expect([v.diameter, v.drill]).toEqual(own ? [0.7, 0.35] : [base.rules.viaDiameter, base.rules.viaDrill])
    }
    console.log("classed fine-pitch route", { ms: Math.round(ms), remaining: res.remaining, routed: res.routed })
  }, 240_000)
})
