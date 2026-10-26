import { describe, expect, it } from "vitest"
import { gerberMask, gerberPaste } from "../src/export/gerber"
import { fabricationNotes } from "../src/export/notes"
import { boardColors, defaultSilkColor } from "../src/model/board"
import { computeConnectivity } from "../src/model/connectivity"
import { pcbPads } from "../src/model/instances"
import { addComponent, addTrace, addVia, createProject, labelPin } from "../src/model/ops"
import { analyzePcb, edgeDistance, type DrcViolation } from "../src/model/pcb"
import { fillTester } from "../src/model/pour"
import {
  applyCapability,
  boardStackup,
  DEFAULT_RULES,
  FAB_CAPABILITIES,
  formatLength,
  fromUnit,
  matchCapability,
  nextPreferredWidth,
  normalizeRules,
} from "../src/model/rules"
import type { DesignRules, Project } from "../src/model/types"
import { normalizeProject } from "../src/model/projectFile"

const analyze = (p: Project) => analyzePcb(p, computeConnectivity(p))
const kinds = (p: Project, kind: DrcViolation["kind"]) => analyze(p).violations.filter((v) => v.kind === kind)
const withRules = (p: Project, patch: Partial<DesignRules>): Project => ({ ...p, rules: { ...p.rules, ...patch } })

/** Two resistors on SIG (pin 1) and GND (pin 2), and a header whose pin 1 is GND. */
function board(): Project {
  let p = createProject("Rules")
  p = { ...p, board: { ...p.board, width: 40, height: 30 } }
  const a = addComponent(p, "resistor", { sch: { x: 0, y: 0 }, pcb: { x: -8, y: 0, placed: true } })
  const b = addComponent(a.project, "resistor", { sch: { x: 3, y: 0 }, pcb: { x: 8, y: 0, placed: true } })
  const h = addComponent(b.project, "header_1x2", { sch: { x: 6, y: 0 }, pcb: { x: 0, y: -8, placed: true } })
  p = h.project
  for (const c of [a.component, b.component]) {
    p = labelPin(p, { componentId: c.id, pin: "1" }, "SIG")
    p = labelPin(p, { componentId: c.id, pin: "2" }, "GND")
  }
  p = labelPin(p, { componentId: h.component.id, pin: "1" }, "GND")
  return p
}

const padOf = (p: Project, index: number, pin: string) => pcbPads(p.components[index]).find((x) => x.pin === pin)!

describe("design rule checks", () => {
  it("flags traces narrower than the minimum width", () => {
    const p = board()
    const s1 = padOf(p, 0, "1")
    const s2 = padOf(p, 1, "1")
    const traced = addTrace(p, { layer: "top", width: 0.12, points: [s1, { x: s1.x, y: 5 }, { x: s2.x, y: 5 }, s2] }).project
    expect(kinds(traced, "trace-width")).toHaveLength(1)
    expect(kinds(traced, "trace-width")[0].message).toBe("Trace 0.12 mm is narrower than the 0.15 mm minimum")
    expect(kinds(withRules(traced, { minTraceWidth: 0.1 }), "trace-width")).toEqual([])
  })

  it("flags small drills and thin annular rings, once per via", () => {
    let p = board()
    p = { ...addVia(p, { x: 0, y: 8 }).project }
    p = { ...p, vias: p.vias.map((v) => ({ ...v, diameter: 0.4, drill: 0.15 })) }
    const drill = kinds(p, "drill")
    expect(drill).toHaveLength(1)
    expect(drill[0].message).toBe("Via drill 0.15 mm is below the 0.2 mm minimum")
    expect(kinds(p, "annular-ring")[0].message).toBe("Via annular ring 0.125 mm is below the 0.13 mm minimum")
    const loose = withRules(p, { minDrill: 0.1, minAnnularRing: 0.1 })
    expect(kinds(loose, "drill")).toEqual([])
    expect(kinds(loose, "annular-ring")).toEqual([])
  })

  it("flags holes closer than the hole-to-hole minimum", () => {
    let p = board()
    p = addVia(p, { x: 0, y: 8 }).project
    p = addVia(p, { x: 0.5, y: 8 }).project
    expect(kinds(p, "hole-clearance")[0].message).toBe("Holes 0.2 mm apart, closer than the 0.25 mm minimum")
    expect(kinds(withRules(p, { holeClearance: 0.15 }), "hole-clearance")).toEqual([])
  })

  it("finds a big hole near a small one with another small hole between their centres", () => {
    let p = board()
    for (const x of [0, 0.7, 1.5]) p = addVia(p, { x, y: 8 }).project
    // The middle via starts past the first one's reach; the big one reaches back over it.
    p = { ...p, vias: p.vias.map((v) => (v.x === 1.5 ? { ...v, diameter: 3, drill: 2.6 } : v)) }
    expect(kinds(p, "hole-clearance")).toHaveLength(2)
  })

  it("flags copper closer to the board edge than the edge clearance", () => {
    const p = board()
    const near = addVia(p, { x: 19.4, y: 0 }).project
    const edge = kinds(near, "edge-clearance")
    expect(edge).toHaveLength(1)
    expect(edge[0].message).toBe("Via is 0.3 mm from the board edge, closer than 0.4 mm")
    expect(edge[0].severity).toBe("error")
    expect(kinds(withRules(near, { edgeClearance: 0.2 }), "edge-clearance")).toEqual([])
    const out = addTrace(p, { layer: "top", width: 0.25, points: [{ x: 15, y: 10 }, { x: 25, y: 10 }] }).project
    expect(kinds(out, "edge-clearance")[0].message).toBe("Trace crosses the board edge")
  })

  it("measures the edge around rounded corners", () => {
    const b = { width: 20, height: 20, x: 0, y: 0, thickness: 1.6, cornerRadius: 5 }
    expect(edgeDistance(b, { x: 0, y: 0 })).toBeCloseTo(10)
    expect(edgeDistance(b, { x: 9, y: 0 })).toBeCloseTo(1)
    // Corner centre at (5, 5), radius 5: the corner point (9, 9) is outside the arc.
    expect(edgeDistance(b, { x: 9, y: 9 })).toBeCloseTo(5 - Math.hypot(4, 4))
  })

  it("flags vias in SMD pads unless via-in-pad is allowed", () => {
    const p = board()
    const pad = padOf(p, 0, "2")
    const inPad = addVia(p, { x: pad.x, y: pad.y }).project
    expect(kinds(inPad, "via-in-pad")).toHaveLength(1)
    expect(kinds(withRules(inPad, { viaInPad: true }), "via-in-pad")).toEqual([])
  })

  it("warns about copper that reaches no pad", () => {
    const p = addTrace(board(), { layer: "bottom", width: 0.25, points: [{ x: -5, y: 10 }, { x: 5, y: 10 }] }).project
    const floating = kinds(p, "floating-copper")
    expect(floating).toHaveLength(1)
    expect(floating[0].severity).toBe("warning")
  })
})

describe("pour rules", () => {
  const poured = (patch: Partial<DesignRules> = {}) => withRules({ ...board(), zones: [{ id: "z", net: "GND", layer: "top" as const }] }, patch)
  const filled = (p: Project) => {
    const tests = analyze(p).zoneFills[0].polygons.map(fillTester)
    return (q: { x: number; y: number }) => tests.some((t) => t(q))
  }

  it("insets the pour by the edge clearance", () => {
    expect(filled(poured())({ x: 19.7, y: 10 })).toBe(false)
    expect(filled(poured({ edgeClearance: 0.2 }))({ x: 19.7, y: 10 })).toBe(true)
  })

  it("relieves through-hole pads by default and joins them solidly when direct", () => {
    const tht = padOf(board(), 2, "1")
    expect(tht.shape).toBe("rect")
    // Just off the pad's corner, inside the relief gap and clear of the spokes.
    const probe = { x: tht.x + tht.width / 2 + 0.15, y: tht.y + tht.height / 2 + 0.15 }
    expect(filled(poured())(probe)).toBe(false)
    expect(filled(poured({ thermalRelief: "direct" }))(probe)).toBe(true)
  })

  it("relieves SMD pads only when every pad is relieved", () => {
    const smd = padOf(board(), 0, "2")
    const probe = { x: smd.x + smd.width / 2 + 0.15, y: smd.y + smd.height / 2 + 0.15 }
    expect(filled(poured())(probe)).toBe(true)
    expect(filled(poured({ thermalRelief: "relief" }))(probe)).toBe(false)
  })

  it("turns the spokes to 45 degrees", () => {
    const tht = padOf(board(), 2, "1")
    const across = { x: tht.x + tht.width / 2 + 0.15, y: tht.y }
    // Square spokes leave copper beside the pad; diagonal ones clear it.
    expect(filled(poured())(across)).toBe(true)
    expect(filled(poured({ thermalSpokeAngle: 45 }))(across)).toBe(false)
  })
})

describe("fabrication outputs follow the rules", () => {
  it("tents vias unless told not to, and grows mask openings by the expansion", () => {
    const p = addVia(board(), { x: 0, y: 8 }).project
    // A 0.6 mm via opens 0.7 mm with the 0.05 mm expansion; no pad on this board is that size.
    expect(gerberMask(p, "top")).not.toContain("C,0.7*")
    expect(gerberMask(withRules(p, { tentVias: false }), "top")).toContain("C,0.7*")
    const pad = padOf(p, 0, "1")
    const grown = gerberMask(withRules(p, { maskExpansion: 0.1 }), "top")
    expect(grown).toContain(`R,${Number((pad.width + 0.2).toFixed(6))}X${Number((pad.height + 0.2).toFixed(6))}`)
  })

  it("asks the fab to fill and cap only the vias that sit in pads", () => {
    const p = withRules(addVia(board(), { x: 0, y: 8 }).project, { viaInPad: true })
    const notes = (q: Project) => fabricationNotes(q, [], analyze(q).items)
    expect(notes(p)).not.toContain("fill and cap")
    const pad = padOf(p, 0, "2")
    expect(notes(addVia(p, { x: pad.x, y: pad.y }).project)).toContain("Vias              2, tented, 1 in SMD pads: fill and cap")
  })

  it("shrinks paste apertures by a negative expansion", () => {
    const p = board()
    const pad = padOf(p, 0, "1")
    const paste = gerberPaste(withRules(p, { pasteExpansion: -0.05 }), "top")
    expect(paste).toContain(`R,${Number((pad.width - 0.1).toFixed(6))}X${Number((pad.height - 0.1).toFixed(6))}`)
  })
})

describe("rule sets", () => {
  it("starts new projects on the standard capability", () => {
    expect(matchCapability(createProject().rules)?.id).toBe("standard")
    expect(matchCapability({ ...DEFAULT_RULES, clearance: 0.18 })).toBeNull()
  })

  it("applies a capability and grows sizes that would break it", () => {
    const conservative = FAB_CAPABILITIES.find((f) => f.id === "conservative")!
    const next = applyCapability({ ...DEFAULT_RULES, traceWidth: 0.15 }, conservative)
    expect(matchCapability(next)?.id).toBe("conservative")
    expect(next.traceWidth).toBe(0.2)
    expect(next.viaDrill).toBe(0.4)
    expect(next.viaDiameter).toBeCloseTo(0.8)
    expect(next.preferredWidths.every((w) => w >= 0.2)).toBe(true)
  })

  it("fills rules older projects predate", () => {
    const rules = normalizeRules({ traceWidth: 0.3, clearance: 0.25, viaDiameter: 0.7, viaDrill: 0.35 })
    expect(rules).toMatchObject({ traceWidth: 0.3, clearance: 0.25, minTraceWidth: 0.15, tentVias: true, thermalRelief: "relief-tht" })
    expect(normalizeRules({ preferredWidths: [0.5, 0.2, 0.5, -1] }).preferredWidths).toEqual([0.2, 0.5])
    const p = normalizeProject({ id: "old", rules: { traceWidth: 0.3 } as DesignRules, properties: [{ key: " Rev ", value: "B" }, { key: "", value: "x" }] })
    expect(p.rules.edgeClearance).toBe(0.4)
    expect(p.properties).toEqual([{ key: "Rev", value: "B" }])
  })

  it("cycles preferred widths while routing", () => {
    const rules = { ...DEFAULT_RULES, preferredWidths: [0.2, 0.5, 1] }
    expect(nextPreferredWidth(rules, 0.25)).toBe(0.5)
    expect(nextPreferredWidth(rules, 1)).toBe(0.2)
  })

  it("converts lengths to mil", () => {
    expect(formatLength(0.254, "mil", true)).toBe("10 mil")
    expect(formatLength(0.15, "mil")).toBe("5.9")
    expect(fromUnit(6, "mil")).toBeCloseTo(0.1524)
    expect(formatLength(0.25, "mm", true)).toBe("0.25 mm")
  })
})

describe("board", () => {
  it("builds a two-layer stackup that adds up to the board thickness", () => {
    const layers = boardStackup({ width: 10, height: 10, x: 0, y: 0, thickness: 1.6, cornerRadius: 0, copperWeight: 2 })
    expect(layers.map((l) => l.name)).toEqual(["Top silkscreen", "Top solder mask", "Top copper", "Core", "Bottom copper", "Bottom solder mask", "Bottom silkscreen"])
    expect(layers.find((l) => l.name === "Top copper")?.thickness).toBeCloseTo(0.07)
    expect(layers.reduce((s, l) => s + (l.thickness ?? 0), 0)).toBeCloseTo(1.6)
  })

  it("pairs light masks with black silkscreen", () => {
    expect(boardColors({ width: 1, height: 1, x: 0, y: 0, thickness: 1.6, cornerRadius: 0 })).toEqual({ mask: "#1f6b3a", silk: "#f4f4f0" })
    expect(defaultSilkColor("#eceae4")).toBe("#1a1a1a")
    expect(defaultSilkColor("#d9b21f")).toBe("#1a1a1a")
    expect(defaultSilkColor("#16161a")).toBe("#f4f4f0")
  })
})
