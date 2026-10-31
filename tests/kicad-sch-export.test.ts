import { createHash } from "node:crypto"
import * as circuitJson from "circuit-json"
import { describe, expect, it } from "vitest"
import { runTool } from "../src/ai/tools"
import { schematicContent } from "../src/ai/vision/framing"
import { measureSchematic } from "../src/ai/vision/measure"
import { schematicSvg } from "../src/ai/vision/schematicSvg"
import { bomCsv } from "../src/export/bom"
import { circuitJsonFile, projectToCircuitJson } from "../src/export/circuitJson"
import { kicadFiles, scaleSchematic } from "../src/export/kicad"
import { drawingKey, registerProjectParts } from "../src/model/customParts"
import { EXAMPLES } from "../src/model/examples"
import { findPart } from "../src/model/library"
import { addComponent, createProject } from "../src/model/ops"
import type { ComponentInstance, CustomPartSpec, DrawingItem, DrawingPin, Mirror, Project, Rotation, SymbolDrawing } from "../src/model/types"
import { FROZEN_EXAMPLES } from "./frozen-examples"
import { importSheet, place } from "./kicad-sch-parts"
import { LIB_GND, LIB_R, LIB_VCC } from "./kicad-schematic-fixtures"

// Symbols that came from KiCad, in Circuit JSON, KiCad, the BOM and the picture Sakura looks at:
// units, mirrors, every shape. And the editor's own examples, which none of it may change.

// ---------- helpers ----------

/** The same sheet with a footprint on every part (an imported schematic has none until it is linked to a board), so the parts are on the board. */
function withFootprint(p: Project, fp = "soic8"): Project {
  const parts = (p.parts ?? []).map((s) => ({ ...s, id: s.id + "-fp", footprint: s.refPrefix === "#" ? "" : fp }))
  const q = { ...p, parts }
  registerProjectParts(q)
  const had = new Set((p.parts ?? []).filter((s) => s.refPrefix !== "#").map((s) => s.id))
  return {
    ...q,
    components: q.components.map((c) => {
      const base = c.partId.replace("@sub", "")
      const rename = c.partId.endsWith("@sub") ? `${base}-fp@sub` : `${base}-fp`
      return { ...c, partId: rename, footprint: had.has(base) && !c.partId.endsWith("@sub") ? fp : "" }
    }),
  }
}

/** A project with one part drawn from the given drawing, on the board. */
function drawn(drawing: SymbolDrawing, footprint = "soic8"): Project {
  const key = drawingKey(drawing)
  const spec: CustomPartSpec = { id: `drawn-${key}`, name: drawing.name, description: "", category: "ICs", refPrefix: "U", footprint, pins: [], drawing: key, props: {} }
  const project: Project = { ...createProject("drawn"), symbols: { [key]: drawing }, parts: [spec] }
  registerProjectParts(project)
  return addComponent(project, spec.id, { sch: { x: 1, y: 2, rot: 0 }, footprint }).project
}

const OPA = (extra: Parameters<typeof place>[3] = {}) => (at: string, unit: number) => place("Test:OPA2", at, "U1", { unit, ...extra })

/** The dual op-amp with all three units on the sheet, as a part on the board. */
const opamp = () => withFootprint(importSheet({ symbols: [OPA()("100 100", 1), OPA()("100 140", 2), OPA()("140 100", 3)] }))

type El = Record<string, unknown> & { type: string }
const els = (p: Project, options?: Parameters<typeof projectToCircuitJson>[1]) => projectToCircuitJson(p, options).elements as El[]
const of = (list: El[], type: string) => list.filter((e) => e.type === type)

/** Every element must be one circuit-json accepts, with no field dropped for not being in its schema. */
function schemaProblems(elements: unknown[]): string[] {
  const schemaOf = (type: string) => (circuitJson as unknown as Record<string, { safeParse: (v: unknown) => { success: boolean; data?: unknown; error?: { issues: unknown[] } } } | undefined>)[type]
  const problems: string[] = []
  for (const el of elements as Record<string, unknown>[]) {
    const schema = schemaOf(String(el.type))
    if (!schema) continue
    const parsed = schema.safeParse(el)
    if (!parsed.success) {
      problems.push(`${String(el.type)}: ${JSON.stringify(parsed.error?.issues[0]).slice(0, 200)}`)
      continue
    }
    for (const key of Object.keys(el)) if (!(key in (parsed.data as object))) problems.push(`${String(el.type)}.${key} would be stripped`)
  }
  return problems
}

/** No number in the elements is missing or infinite (JSON writes those as null). */
function finite(value: unknown, path = "$"): string[] {
  if (typeof value === "number") return Number.isFinite(value) ? [] : [path]
  if (Array.isArray(value)) return value.flatMap((v, i) => finite(v, `${path}[${i}]`))
  if (value && typeof value === "object") return Object.entries(value).flatMap(([k, v]) => finite(v, `${path}.${k}`))
  return []
}

const near = (a: number, b: number) => Math.abs(a - b) < 2e-4

// ---------- what the editor's own projects give, taken before any of this was built ----------

const sha = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16)

/**
 * Hashes of the Circuit JSON text, its notes, the schematic picture and get_design, taken from the code as it was before units, mirrors and
 * drawings existed. The picture of the shipped examples is the one main draws since it frames their blocks and paints drawings (the golden outputs
 * in `tests/golden` hold the same picture); the frozen examples have no blocks, so theirs is still the first. Since the library held basic parts
 * only (file version 4), the shipped examples' chips are their own parts: the same Circuit JSON and picture, a note that says parts made for the
 * project have no library link, and get_design naming each chip by its part's id.
 */
const BEFORE: Record<string, { circuit: string; notes: string; svg: string; design: string }> = {
  "esp32-robot": { circuit: "c62f5c073b4216f8", notes: "1c3eb23971c052c9", svg: "c494fdf7fd9da98c", design: "0d556351697db72d" },
  node: { circuit: "8c25f23fa2131473", notes: "1c3eb23971c052c9", svg: "80a9fd3babf7591e", design: "10131824a2130a1a" },
  blinker: { circuit: "51cb1a459952ff8e", notes: "1c3eb23971c052c9", svg: "d47e7e1b0e8856f5", design: "f36466f25da0aa02" },
  regulator: { circuit: "322e01a20d7dfc72", notes: "1c3eb23971c052c9", svg: "70e18bc28b56ec8e", design: "2ebca66d732e60a2" },
  mcu: { circuit: "beea3a0b6b98297f", notes: "1c3eb23971c052c9", svg: "38e3d9a1edc04938", design: "da2a35ea9a601755" },
  "frozen-esp32-robot": { circuit: "730bfa45500b69ff", notes: "ecde5db8bdf09607", svg: "299271660a4155b1", design: "7f38678ff141de94" },
  "frozen-node": { circuit: "7306744c065a5c8c", notes: "ecde5db8bdf09607", svg: "4b107b7ad8115ed8", design: "42abfae5421666e4" },
  "frozen-blinker": { circuit: "e6b3dc44a58a612f", notes: "ecde5db8bdf09607", svg: "c87ee948dc652b73", design: "ee03b0c27a4e4c41" },
  "frozen-regulator": { circuit: "fcb711afa8d98b8e", notes: "ecde5db8bdf09607", svg: "38d9477f5e779253", design: "1cdb315050a8f11f" },
  // get_design now says its one stray supply port (#PWR1, touching nothing) reaches no part: `loose_wiring`.
  "frozen-mcu": { circuit: "847672861b48a2b6", notes: "ecde5db8bdf09607", svg: "26075a811bfaf2f1", design: "673701354994462c" },
}

describe("the editor's own projects", () => {
  const all = [...EXAMPLES.map((e) => ({ id: e.id, project: e.project })), ...FROZEN_EXAMPLES.map((e) => ({ id: `frozen-${e.id}`, project: e.project }))]
  it.each(all.map((a) => [a.id, a.project] as const))("give the Circuit JSON, notes, schematic picture and get_design of %s they always gave", (id, project) => {
    const file = circuitJsonFile(project)
    const box = schematicContent(project)!
    const svg = schematicSvg(project, box, { width: 1200, height: 800 }, measureSchematic(project))
    expect({
      circuit: sha(file.text),
      notes: sha(JSON.stringify(file.notes)),
      svg: sha(svg),
      design: sha(runTool(project, "get_design", {}).result),
    }).toEqual(BEFORE[id])
  })
})

// ---------- units ----------

describe("a part with three units in Circuit JSON", () => {
  const p = opamp()
  const list = els(p)

  it("is one source component with a schematic component for each unit", () => {
    const sources = of(list, "source_component")
    expect(sources.map((s) => s.name)).toEqual(["U1"])
    const comps = of(list, "schematic_component")
    expect(comps).toHaveLength(3)
    expect(new Set(comps.map((c) => c.source_component_id))).toEqual(new Set([sources[0].source_component_id]))
    expect(new Set(comps.map((c) => c.schematic_component_id)).size).toBe(3)
  })

  it("puts each unit's ports on the part's own source ports, one schematic port a pin", () => {
    const sources = of(list, "source_port")
    expect(sources).toHaveLength(8)
    const pinOf = new Map(sources.map((s) => [s.source_port_id as string, s.pin_number as number]))
    const comps = of(list, "schematic_component")
    const pinsOfUnit = comps.map((c) =>
      of(list, "schematic_port")
        .filter((x) => x.schematic_component_id === c.schematic_component_id)
        .map((x) => pinOf.get(x.source_port_id as string)!)
        .sort((a, b) => a - b),
    )
    expect(pinsOfUnit).toEqual([[1, 2, 3], [5, 6, 7], [4, 8]])
    const ported = of(list, "schematic_port").map((x) => x.source_port_id)
    expect(new Set(ported).size).toBe(8)
  })

  it("draws each unit at its own place with its own drawing", () => {
    const comps = of(list, "schematic_component")
    const centres = comps.map((c) => c.center as { x: number; y: number })
    // 100 mm is 7.874 units, and the units sit 40 mm apart.
    expect(near(centres[0].x, 7.874)).toBe(true)
    expect(near(centres[1].y - centres[0].y, -3.1496)).toBe(true)
    expect(near(centres[2].x - centres[0].x, 3.1496)).toBe(true)
    // The power unit is the box, the amplifiers triangles: three paths with 4 points, one with 5.
    const first = (id: unknown) => of(list, "schematic_path").find((e) => e.schematic_component_id === id && (e.points as unknown[]).length >= 4)!
    expect((first(comps[0].schematic_component_id).points as unknown[]).length).toBe(4)
    expect((first(comps[2].schematic_component_id).points as unknown[]).length).toBe(5)
  })

  it("writes the part's reference with its unit letter on each unit", () => {
    const comps = of(list, "schematic_component").map((c) => c.schematic_component_id)
    const refs = comps.map((id) => of(list, "schematic_text").filter((t) => t.schematic_component_id === id && /^U1/.test(String(t.text))).map((t) => t.text))
    expect(refs).toEqual([["U1A"], ["U1B"], ["U1C"]])
  })

  it("is one part in the BOM, and the nets list it once", () => {
    const lines = bomCsv(p).trim().split("\n")
    expect(lines).toHaveLength(2)
    expect(lines[1].startsWith("U1,1,")).toBe(true)
    const traces = of(list, "source_trace")
    for (const t of traces) {
      const ports = t.connected_source_port_ids as string[]
      expect(new Set(ports).size).toBe(ports.length)
    }
  })

  it("is valid Circuit JSON with no missing number, and says nothing about units that carry over", () => {
    expect(schemaProblems(list)).toEqual([])
    expect(finite(list)).toEqual([])
    const { notes } = projectToCircuitJson(p)
    expect(notes.join(" ")).not.toMatch(/unit/i)
    expect(notes.every((n) => !/[\u2013\u2014]/.test(n))).toBe(true)
  })

  it("keeps a wire that ends on a pin of another unit on that pin's port", () => {
    // U1 pin 7 (output of unit 2) wired to U2 pin 1 and labelled.
    const q = withFootprint(
      importSheet({
        symbols: [OPA()("100 100", 1), OPA()("100 140", 2), place("Test:OPA2", "160 140", "U2", { unit: 1 })],
        // Unit 2's output is at (107.62, 140); U2 unit 1's inverting input is at (152.38, 142.54).
        wires: ["107.62 140 130 140", "130 140 130 142.54", "130 142.54 152.38 142.54"],
        labels: ["SIG 130 140 0"],
      }),
    )
    const out = els(q)
    const ports = new Map(of(out, "source_port").map((s) => [s.source_port_id as string, s]))
    const comps = new Map(of(out, "source_component").map((s) => [s.source_component_id as string, s.name as string]))
    const trace = of(out, "source_trace").find((t) => (t.connected_source_net_ids as string[]).length)!
    const members = (trace.connected_source_port_ids as string[]).map((id) => `${comps.get(ports.get(id)!.source_component_id as string)}.${ports.get(id)!.pin_number}`).sort()
    expect(members).toEqual(["U1.7", "U2.2"])
  })
})

// ---------- twins without a part, and symbols with no footprint ----------

describe("what is left out", () => {
  it("draws a unit whose part is not on the sheet as a symbol of its own (the part's other units are on another sheet)", () => {
    const p = opamp()
    const owner = p.components.find((c) => !findPart(c.partId)?.unitOf)!
    const orphan = { ...p, components: p.components.filter((c) => c.id !== owner.id) }
    const { elements, notes } = projectToCircuitJson(orphan)
    expect(of(elements as El[], "schematic_component")).toHaveLength(2)
    expect(notes.join(" ")).not.toMatch(/Left out/)
  })

  it("keeps KiCad symbols that have no footprint on the sheet, with no board part and no note about them", () => {
    const bare = importSheet({ symbols: [OPA()("100 100", 1), place("Test:MCU", "60 120", "U3")] })
    const { notes, elements } = projectToCircuitJson(bare)
    expect(notes.join(" ")).not.toMatch(/no footprint/)
    expect(of(elements as El[], "schematic_component").length).toBe(2)
    expect(of(elements as El[], "pcb_component")).toHaveLength(0)
  })
})

// ---------- mirror ----------

/** Where a point of the symbol lies on the sheet, worked out by hand: turned counter-clockwise, then mirrored. */
function world(p: { x: number; y: number }, at: { x: number; y: number }, rot: Rotation, mirror?: Mirror) {
  let { x, y } = p
  for (let i = 0; i < rot / 90; i++) [x, y] = [-y, x]
  if (mirror === "x") y = -y
  if (mirror === "y") x = -x
  return { x: at.x + x, y: at.y + y }
}

describe("mirrored and turned symbols in Circuit JSON", () => {
  const base = withFootprint(importSheet({ symbols: [OPA()("100 100", 1)] }))
  const c0 = base.components[0]
  const at = c0.sch
  // Pin 1 (the output) is at (0.6, 0) from the origin, pin 2 at (-0.6, 0.2) and pin 3 at (-0.6, -0.2) in the editor's y-up units: KiCad's y is down.
  const pinsIn: Record<string, { x: number; y: number }> = { "1": { x: 0.6, y: 0 }, "2": { x: -0.6, y: -0.2 }, "3": { x: -0.6, y: 0.2 } }
  const dirIn: Record<string, string> = { "1": "right", "2": "left", "3": "left" }
  const DIRS = ["right", "up", "left", "down"]
  const facing = (d: string, rot: Rotation, mirror?: Mirror) => {
    let v = DIRS[(DIRS.indexOf(d) + rot / 90) % 4]
    if (mirror === "x") v = v === "up" ? "down" : v === "down" ? "up" : v
    if (mirror === "y") v = v === "left" ? "right" : v === "right" ? "left" : v
    return v
  }
  const cases: [Rotation, Mirror | undefined][] = []
  for (const rot of [0, 90, 180, 270] as Rotation[]) for (const m of [undefined, "x", "y"] as const) cases.push([rot, m])

  it.each(cases)("turned %s mirrored %s: ports, facing and drawing agree with the turn then the flip", (rot, mirror) => {
    const p: Project = { ...base, components: [{ ...c0, sch: { ...c0.sch, rot, ...(mirror ? { mirror } : {}) } }] }
    const list = els(p)
    const pinOf = new Map(of(list, "source_port").map((s) => [s.source_port_id as string, String(s.pin_number)]))
    for (const port of of(list, "schematic_port")) {
      const pin = pinOf.get(port.source_port_id as string)!
      const want = world(pinsIn[pin], { x: at.x, y: at.y }, rot, mirror)
      const got = port.center as { x: number; y: number }
      expect(near(got.x, want.x) && near(got.y, want.y), `pin ${pin} at ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`).toBe(true)
      expect(port.facing_direction).toBe(facing(dirIn[pin], rot, mirror))
    }
    // The triangle's tip (0.4, 0) goes where the output pin's line starts.
    const body = of(list, "schematic_path").find((e) => (e.points as unknown[]).length === 4)!
    const tip = (body.points as { x: number; y: number }[])[1]
    const wantTip = world({ x: 0.4, y: 0 }, { x: at.x, y: at.y }, rot, mirror)
    expect(near(tip.x, wantTip.x) && near(tip.y, wantTip.y)).toBe(true)
    expect(finite(list)).toEqual([])
  })

  it("moves the pin names with the pins and keeps the text readable", () => {
    const p: Project = { ...base, components: [{ ...c0, sch: { ...c0.sch, rot: 0, mirror: "y" } }] }
    const texts = of(els(p), "schematic_text")
    // A mirror flips the amplifier left to right: pin 1's number is now on the left of the symbol.
    const one = texts.find((t) => t.text === "1")!
    expect((one.position as { x: number }).x).toBeLessThan(at.x)
    for (const t of texts) expect([0, 90]).toContain(t.rotation)
  })
})

// ---------- every shape ----------

describe("every shape of a symbol in Circuit JSON", () => {
  const p = withFootprint(importSheet({ symbols: [place("Test:SHAPES", "100 100", "U1")] }))
  const list = els(p)
  const { notes } = projectToCircuitJson(p)

  it("writes the arc as an arc with its own colour, and nothing for it as a path", () => {
    const arcs = of(list, "schematic_arc")
    expect(arcs).toHaveLength(1)
    const a = arcs[0]
    expect(a.color).toBe("#ff0000")
    expect(near(a.radius as number, 0.25)).toBe(true)
    // (-2.54, -5.08) through (0, -6.35) to (2.54, -5.08) in KiCad's y-up lib frame: counter-clockwise below the origin.
    expect(a.direction).toBe("counterclockwise")
    expect(near(a.start_angle_degrees as number, -143.1301)).toBe(true)
    expect(near(a.end_angle_degrees as number, -36.8699)).toBe(true)
    const centre = a.center as { x: number; y: number }
    // The circle through those points has its centre a quarter unit below the symbol's origin.
    expect(near(centre.x, p.components[0].sch.x) && near(centre.y, p.components[0].sch.y - 0.25)).toBe(true)
  })

  it("keeps each shape's width, dash and colours", () => {
    const circle = of(list, "schematic_circle").find((c) => c.radius === 0.2)!
    expect(circle.is_filled).toBe(true)
    expect(circle.is_dashed).toBe(true)
    expect(near(circle.stroke_width as number, 0.1 / 12.7)).toBe(true)
    const green = of(list, "schematic_path").find((e) => e.fill_color === "#008000")!
    expect(green.is_filled).toBe(true)
    expect(green.is_dashed).toBe(true)
    expect(near(green.stroke_width as number, 0.02)).toBe(true)
    expect(green.dash_length).toBeGreaterThan(0)
    const body = of(list, "schematic_path").find((e) => e.fill_color === "#ffffc2" && (e.points as unknown[]).length > 20)!
    expect(body.is_filled).toBe(true)
    expect(body.is_dashed).toBe(true)
    expect(near(body.stroke_width as number, 0.04)).toBe(true)
  })

  it("writes a Bezier curve as a path of short lines through its four points' hull", () => {
    const curve = of(list, "schematic_path").find((e) => (e.points as unknown[]).length === 25)!
    const pts = curve.points as { x: number; y: number }[]
    // Ends at (-5.08, 2.54) and (5.08, 2.54) mm from the symbol: 0.4 units either side, 0.2 above.
    const o = p.components[0].sch
    expect(near(pts[0].x, o.x - 0.4) && near(pts[0].y, o.y + 0.2)).toBe(true)
    expect(near(pts[24].x, o.x + 0.4) && near(pts[24].y, o.y + 0.2)).toBe(true)
    // The control points pull it above the straight line between the ends.
    expect(Math.max(...pts.map((q) => q.y))).toBeGreaterThan(o.y + 0.2 + 0.1)
  })

  it("says what Circuit JSON cannot carry, once, and only what this symbol uses", () => {
    const text = notes.join("\n")
    expect(text).toMatch(/Bezier curves and ellipses/)
    expect(text).toMatch(/Dash-dot and dash-dot-dot lines/)
    expect(text).toMatch(/Bold and italic text/)
    expect(text).toMatch(/overbar/)
    expect(text).toMatch(/pin types/)
    expect(text.match(/Bold and italic/g)).toHaveLength(1)
    // The op-amp has no curve, no dash and no styled text.
    const plain = projectToCircuitJson(opamp()).notes.join("\n")
    expect(plain).not.toMatch(/Bezier|Dash-dot|Bold and italic|overbar/)
  })

  it("turns the text by its own angle: 90 degrees is upright text on its side", () => {
    const t = of(list, "schematic_text").find((e) => e.text === "TXT")!
    expect(t.rotation).toBe(90)
    expect(t.font_size).toBeCloseTo(1.016 / 12.7, 4)
    // Text kept to the left and below its anchor, turned a quarter: the anchor sits at the start of the text's bottom edge.
    expect(t.anchor).toBe("bottom_left")
  })

  it("is valid Circuit JSON with no missing number", () => {
    expect(schemaProblems(list)).toEqual([])
    expect(finite(list)).toEqual([])
  })

  it("writes pin names and numbers, the number across or up beside its pin", () => {
    const texts = of(list, "schematic_text")
    const q = texts.find((t) => t.text === "EN#")
    expect(q, "the overbar name is written with a trailing #").toBeTruthy()
    const x = texts.find((t) => t.text === "X")!
    // A pin on top of the symbol: its name reads upward.
    expect(x.rotation).toBe(90)
    expect(texts.filter((t) => /^[1-8]$/.test(String(t.text)))).toHaveLength(8)
  })
})

describe("the shapes only a drawing can have", () => {
  const items: DrawingItem[] = [
    { kind: "ellipse", c: { x: 0, y: 0 }, rx: 0.3, ry: 0.15, rotation: 30, fill: "background" },
    { kind: "ellipse", c: { x: 0.2, y: 0.5 }, rx: 0.2, ry: 0.2, rotation: 0, from: 0, to: 90 },
    { kind: "arc", start: { x: -0.3, y: -0.4 }, mid: { x: 0, y: -0.7 }, end: { x: 0.3, y: -0.4 }, fill: "outline", color: "#0000ff" },
    { kind: "text", text: "UP", at: { x: 0, y: 0.9 }, angle: 90, size: 0.1, h: "left", bold: true },
  ]
  const pins: DrawingPin[] = [{ number: "1", name: "A", type: "passive", shape: "line", x: -0.6, y: 0, angle: 0, length: 0.2 }]
  const drawing: SymbolDrawing = { name: "Shapes", items, pins, fields: [{ name: "Reference", value: "U", place: { x: 0, y: 1, angle: 0 } }] }
  const p = drawn(drawing)
  const list = els(p)

  it("writes an ellipse as a closed path of lines and its arc piece as an open one", () => {
    const paths = of(list, "schematic_path").filter((e) => (e.points as unknown[]).length > 20)
    expect(paths.length).toBeGreaterThanOrEqual(3)
    const full = paths.find((e) => e.fill_color === "#ffffc2")!
    const pts = full.points as { x: number; y: number }[]
    expect(pts[0]).toEqual(pts[pts.length - 1])
    // The long axis is 0.3 turned 30 degrees: no point is further than that from the centre.
    const o = p.components[0].sch
    expect(Math.max(...pts.map((q) => Math.hypot(q.x - o.x, q.y - o.y)))).toBeLessThanOrEqual(0.3001)
    expect(Math.max(...pts.map((q) => Math.hypot(q.x - o.x, q.y - o.y)))).toBeGreaterThan(0.29)
  })

  it("writes a filled arc as an arc with a pie under it", () => {
    const arcs = of(list, "schematic_arc")
    expect(arcs).toHaveLength(1)
    expect(arcs[0].color).toBe("#0000ff")
    const pie = of(list, "schematic_path").find((e) => e.is_filled && (e.points as unknown[]).length > 5 && e.stroke_width === 0 && !e.fill_color)
    // Outline fill takes the line's colour.
    const blue = of(list, "schematic_path").find((e) => e.is_filled && e.fill_color === "#0000ff")
    expect(pie ?? blue).toBeTruthy()
    const o = p.components[0].sch
    const points = (pie ?? blue)!.points as { x: number; y: number }[]
    // Starts and ends at the centre of the circle the arc is on.
    expect(points[0]).toEqual(points[points.length - 1])
    expect(near(points[0].x, o.x) && near(points[0].y, o.y - 0.4)).toBe(true)
  })

  it("keeps the angle and weight of its text and names what it cannot carry", () => {
    const t = of(list, "schematic_text").find((e) => e.text === "UP")!
    expect(t.rotation).toBe(90)
    expect(t.anchor).toBe("left")
    expect(projectToCircuitJson(p).notes.join(" ")).toMatch(/Bold and italic text is written in plain type/)
    expect(projectToCircuitJson(p).notes.join(" ")).toMatch(/Bezier curves and ellipses, and the fill of filled arcs/)
    expect(schemaProblems(list)).toEqual([])
    expect(finite(list)).toEqual([])
  })
})

// ---------- fields, pin functions, hidden pins ----------

describe("fields and pin functions in Circuit JSON", () => {
  const mcu = (pinAlt?: Record<string, string>) => {
    const p = withFootprint(importSheet({ symbols: [place("Test:MCU", "100 100", "U3")] }))
    return pinAlt ? { ...p, components: p.components.map((c) => ({ ...c, pinAlt })) } : p
  }

  it("writes the fields that are shown where they are, and not the hidden ones", () => {
    const texts = of(els(mcu()), "schematic_text")
    expect(texts.filter((t) => t.text === "U3")).toHaveLength(1)
    expect(texts.filter((t) => t.text === "MCU")).toHaveLength(1)
  })

  it("writes the function a pin was switched to, not its own name", () => {
    expect(of(els(mcu()), "schematic_text").some((t) => t.text === "PA0")).toBe(true)
    const texts = of(els(mcu({ "1": "SCL" })), "schematic_text")
    expect(texts.some((t) => t.text === "SCL")).toBe(true)
    expect(texts.some((t) => t.text === "PA0")).toBe(false)
  })

  it("says that a pin has other functions, and that every pin is passive", () => {
    const text = projectToCircuitJson(mcu()).notes.join(" ")
    expect(text).toMatch(/other functions a pin can take/)
    expect(text).toMatch(/every pin is written as passive/)
  })

  it("keeps a hidden power pin as a port and puts it on the net of its name", () => {
    const p = mcu()
    const list = els(p)
    const port = of(list, "source_port").find((s) => s.pin_number === 4)!
    expect(port).toBeTruthy()
    expect(of(list, "schematic_port").some((s) => s.source_port_id === port.source_port_id)).toBe(true)
    const net = of(list, "source_net").find((n) => n.name === "VDD")
    expect(net).toBeTruthy()
    const trace = of(list, "source_trace").find((t) => (t.connected_source_net_ids as string[]).includes(net!.source_net_id as string))
    expect(trace?.connected_source_port_ids).toContain(port.source_port_id)
  })

  it("leaves a no-connect pin on no net, with its port", () => {
    const list = els(mcu())
    const nc = of(list, "source_port").find((s) => s.pin_number === 3)!
    expect(of(list, "source_trace").some((t) => (t.connected_source_port_ids as string[]).includes(nc.source_port_id as string))).toBe(false)
    expect(of(list, "schematic_port").some((s) => s.source_port_id === nc.source_port_id)).toBe(true)
  })
})

// ---------- power symbols ----------

describe("power symbols that came with a drawing", () => {
  const divider = () => {
    const p = importSheet({
      libs: [LIB_R, LIB_GND, LIB_VCC],
      symbols: [
        { lib: "Device:R", at: "50.8 50.8", ref: "R1", value: "10k", footprint: "", uuid: "21111111-0000-4000-8000-000000000001" },
        { lib: "power:VCC", at: "50.8 43.18", ref: "#PWR01", value: "VCC", uuid: "21111111-0000-4000-8000-000000000003" },
        { lib: "power:GND", at: "50.8 76.2", ref: "#PWR02", value: "GND", uuid: "21111111-0000-4000-8000-000000000004" },
      ],
      wires: ["50.8 43.18 50.8 46.99", "50.8 54.61 50.8 76.2"],
    })
    return withFootprint(p, "0603")
  }

  it("are net labels, not parts: no schematic component, no BOM line", () => {
    const p = divider()
    const list = els(p)
    expect(of(list, "schematic_component")).toHaveLength(1)
    expect(of(list, "source_component").map((s) => s.name)).toEqual(["R1"])
    const labels = of(list, "schematic_net_label").map((l) => l.text).sort()
    expect(labels).toEqual(["GND", "VCC"])
    expect(bomCsv(p).trim().split("\n")).toHaveLength(2)
    expect(bomCsv(p)).not.toContain("#PWR")
  })
})

// ---------- the BOM ----------

describe("the BOM", () => {
  it("counts each part once however many units it has, and lists its reference once", () => {
    const p = withFootprint(
      importSheet({
        symbols: [OPA()("100 100", 1), OPA()("100 140", 2), OPA()("140 100", 3), place("Test:OPA2", "100 200", "U2", { unit: 1 }), place("Test:OPA2", "100 240", "U2", { unit: 2 }), place("Test:OPA2", "140 200", "U2", { unit: 3 })],
      }),
    )
    const rows = bomCsv(p).trim().split("\n").slice(1)
    expect(rows).toHaveLength(1)
    expect(rows[0].startsWith('"U1, U2",2,')).toBe(true)
    expect(p.components).toHaveLength(6)
  })

  it("lists an imported part with no land pattern, with the footprint its file names as text", () => {
    const p = importSheet({ symbols: [place("Device:R", "100 100", "R1", { value: "10k", footprint: "Resistor_SMD:R_0603_1608Metric" }), place("Device:R", "100 140", "R2", { value: "10k", footprint: "Resistor_SMD:R_0603_1608Metric" })] })
    expect(p.components.every((c) => c.footprint === "")).toBe(true)
    const rows = bomCsv(p).trim().split("\n").slice(1)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toContain('"R1, R2",2,10k,Resistor_SMD:R_0603_1608Metric,')
    // the text is the footprint column's, not also a property
    expect(rows[0]).not.toContain("Footprint=")
  })

  it("counts a part with no footprint once, however many unit symbols it has", () => {
    const bare = importSheet({ symbols: [OPA()("100 100", 1), OPA()("100 140", 2)] })
    const rows = bomCsv(bare).trim().split("\n").slice(1)
    expect(rows).toHaveLength(1)
    expect(rows[0].startsWith('U1,1,')).toBe(true)
  })
})

// ---------- picture ----------

describe("the schematic picture", () => {
  const picture = (p: Project) => schematicSvg(p, schematicContent(p)!, { width: 1200, height: 800 }, measureSchematic(p))

  it("draws every kind of shape with its own width, dash and colours", () => {
    const svg = picture(withFootprint(importSheet({ symbols: [place("Test:SHAPES", "100 100", "U1")] })))
    expect(svg).not.toMatch(/NaN|undefined/)
    // The arc, in its own red, as an arc command.
    expect(svg).toMatch(/<path d="M[-\d.,]+A0\.25,0\.25 0 0 1 [-\d.,]+"[^>]*stroke="#ff0000"/)
    // The Bezier curve.
    expect(svg).toMatch(/<path d="M[-\d.,]+C[-\d.,]+ [-\d.,]+ [-\d.,]+"[^>]*stroke-dasharray=/)
    // The green fill and the background fill, the dashes.
    expect(svg).toContain('fill="#008000"')
    expect(svg).toContain(`fill="#ffffc2"`)
    expect(svg.match(/stroke-dasharray="/g)!.length).toBeGreaterThanOrEqual(4)
    // The circle drawn with its fill in the line's colour and a width of its own.
    expect(svg).toMatch(/<circle cx="[-\d.]+" cy="[-\d.]+" r="0\.2" fill="#840000" stroke="#840000" stroke-width="0\.0079" stroke-dasharray=/)
    // Text turned on its side, bold and italic.
    expect(svg).toMatch(/font-weight="700"/)
    expect(svg).toMatch(/font-style="italic"/)
    expect(svg).toMatch(/rotate\(-90\)[^>]*>TXT</)
  })

  it("writes the fields and the pins' names and numbers from the symbol's own layout", () => {
    const svg = picture(withFootprint(importSheet({ symbols: [OPA()("100 100", 1), OPA()("100 140", 2), OPA()("140 100", 3)] })))
    for (const ref of ["U1A", "U1B", "U1C"]) expect(svg).toContain(`>${ref}<`)
    expect(svg).toContain(">V+<")
    expect(svg).toContain(">V-<")
    expect(svg.match(/>OPA2</g)).toHaveLength(3)
    // The numbers of the vertical power pins read upward.
    expect(svg).toMatch(/rotate\(-90\)[^>]*>8</)
  })

  it("draws a pin switched to another function under that function's name", () => {
    const p = withFootprint(importSheet({ symbols: [place("Test:MCU", "100 100", "U3")] }))
    const switched = { ...p, components: p.components.map((c) => ({ ...c, pinAlt: { "1": "TX" } })) }
    expect(picture(p)).toContain(">PA0<")
    expect(picture(switched)).toContain(">TX<")
    expect(picture(switched)).not.toContain(">PA0<")
  })

  it("mirrors and turns the drawing as the model does", () => {
    const base = withFootprint(importSheet({ symbols: [OPA()("100 100", 1)] }))
    const c = base.components[0]
    const at = (sch: Partial<ComponentInstance["sch"]>): Project => ({ ...base, components: [{ ...c, sch: { ...c.sch, ...sch } }] })
    expect(picture(at({ mirror: "x" }))).toMatch(/transform="translate\([-\d.]+,[-\d.]+\) scale\(1,-1\) rotate\(0\)"/)
    expect(picture(at({ mirror: "y", rot: 90 }))).toMatch(/scale\(-1,1\) rotate\(90\)/)
    expect(picture(base)).toMatch(/transform="translate\([-\d.]+,[-\d.]+\) rotate\(0\)"/)
    // A turned symbol keeps its pin numbers across or upward, never upside down.
    const turned = picture(at({ rot: 180 }))
    expect(turned).not.toMatch(/rotate\(90\)[^>]*>1</)
  })

  it("draws what only a drawing can have", () => {
    const svg = picture(
      drawn({
        name: "Shapes",
        items: [
          { kind: "ellipse", c: { x: 0, y: 0 }, rx: 0.3, ry: 0.15, rotation: 30, fill: "background" },
          { kind: "arc", start: { x: -0.3, y: -0.4 }, mid: { x: 0, y: -0.7 }, end: { x: 0.3, y: -0.4 }, fill: "outline", color: "#0000ff" },
        ],
        pins: [{ number: "1", name: "A", type: "passive", shape: "line", x: -0.6, y: 0, angle: 0, length: 0.2 }],
        fields: [{ name: "Reference", value: "U", place: { x: 0, y: 1, angle: 0 } }],
      }),
    )
    expect(svg).not.toMatch(/NaN|undefined/)
    // An ellipse is two arcs and a close; a filled arc is a pie.
    expect(svg).toMatch(/<path d="M[-\d.,]+A0\.3,0\.15 30 1 1 [-\d.,]+A0\.3,0\.15 30 1 1 [-\d.,]+Z" fill="#ffffc2"/)
    expect(svg).toMatch(/<path d="M[-\d.,]+L[-\d.,]+A[-\d.,]+ 0 [01] [01] [-\d.,]+Z" fill="#0000ff"/)
  })

  it("draws the editor's own parts as before even when one is mirrored", () => {
    const own = EXAMPLES.find((e) => e.id === "blinker")!.project
    const c = own.components.find((x) => x.ref === "R1")!
    const mirrored = { ...own, components: own.components.map((x) => (x.id === c.id ? { ...x, sch: { ...x.sch, mirror: "y" as const } } : x)) }
    const svg = picture(mirrored)
    expect(svg).toContain("scale(-1,1)")
    expect(svg).not.toMatch(/NaN/)
  })
})

// ---------- KiCad ----------

describe("the KiCad schematic", () => {
  const sheet = () =>
    withFootprint(importSheet({ symbols: [OPA()("100 100", 1), OPA()("100 140", 2), OPA({ mirror: "y" })("140 100", 3), place("Test:SHAPES", "220 100", "U4")] }))

  it("scales arcs with the rest of the schematic", () => {
    const list = els(sheet())
    const scaled = scaleSchematic(list as never) as El[]
    const arc = of(list, "schematic_arc")[0]
    const out = of(scaled, "schematic_arc")[0]
    const k = 12.7 / 15
    expect(out.radius).toBeCloseTo((arc.radius as number) * k, 9)
    expect((out.center as { x: number }).x).toBeCloseTo((arc.center as { x: number }).x * k, 9)
    expect(out.stroke_width).toBeCloseTo((arc.stroke_width as number) * k, 9)
  })

  it("writes the units of a part as the units of one symbol, with one reference", async () => {
    const { files, notes } = await kicadFiles(sheet())
    const text = Object.entries(files).find(([k]) => k.endsWith(".kicad_sch"))![1]
    const libs = [...text.matchAll(/\n {4}\(symbol "(Device:[^"]+)"/g)].map((m) => m[1])
    // The op-amp (three units) and the shapes part.
    expect(libs).toHaveLength(2)
    const opa = libs.find((n) => n.includes("schematic_component_0"))!
    const short = opa.slice(opa.indexOf(":") + 1)
    for (const unit of [1, 2, 3]) expect(text).toContain(`(symbol "${short}_${unit}_1"`)
    expect(text).not.toContain(`(symbol "${short}_0_1"`)
    const placed = [...text.matchAll(/\n {2}\(symbol\n {4}\(lib_id "([^"]+)"\)\n {4}\(at [^\n]*\)\n {4}\(unit (\d+)\)/g)].map((m) => [m[1], Number(m[2])] as const)
    expect(placed.filter(([id]) => id === opa).map(([, u]) => u).sort()).toEqual([1, 2, 3])
    expect([...text.matchAll(/\(reference "(U\d)"\)\n\s+\(unit (\d)\)/g)].map((m) => `${m[1]}:${m[2]}`).sort()).toEqual(["U1:1", "U1:2", "U1:3", "U4:1"])
    // Pins stay one each: unit 3 holds pins 8 and 4.
    const unit3 = text.slice(text.indexOf(`(symbol "${short}_3_1"`))
    expect(unit3.slice(0, unit3.indexOf('(symbol "', 10) > 0 ? unit3.indexOf('(symbol "', 10) : undefined)).toMatch(/\(number "8"/)
    expect(notes.join(" ")).toMatch(/units come across/)
    expect(notes.every((n) => !/[\u2013\u2014]/.test(n))).toBe(true)
  }, 120_000)

  it("writes each pin with the name and the electrical type the symbol gave it", async () => {
    const { files } = await kicadFiles(sheet())
    const text = Object.entries(files).find(([k]) => k.endsWith(".kicad_sch"))![1]
    const all = text.slice(text.indexOf("(lib_symbols"), text.indexOf("\n  (symbol\n    (lib_id"))
    // the op-amp's library symbol, not the shapes part's
    const lib = all.split('\n    (symbol "').find((b) => b.startsWith("Device:") && b.includes("schematic_component_0"))!
    const pins = new Map<string, { type: string; name: string }>()
    for (const m of lib.matchAll(/\(pin (\w+) \w+\n[\s\S]*?\(name "([^"]*)"[\s\S]*?\(number "([^"]*)"/g)) pins.set(m[3], { type: m[1], name: m[2] })
    // The op-amp: output 1, inputs 2 and 3, the other unit's 5, 6 and 7, and the power pins 8 and 4.
    expect(pins.get("1")?.type).toBe("output")
    expect(pins.get("2")).toEqual({ type: "input", name: "-" })
    expect(pins.get("3")).toEqual({ type: "input", name: "+" })
    expect(pins.get("5")).toEqual({ type: "input", name: "+" })
    expect(pins.get("7")?.type).toBe("output")
    expect(pins.get("8")).toEqual({ type: "power_in", name: "V+" })
    expect(pins.get("4")).toEqual({ type: "power_in", name: "V-" })
    // Nothing is written as passive that was not.
    expect([...pins.values()].filter((p) => p.type === "passive")).toEqual([])
  }, 120_000)

  it("writes the reference and the value where the symbol had them, on show", async () => {
    const { files } = await kicadFiles(sheet())
    const text = Object.entries(files).find(([k]) => k.endsWith(".kicad_sch"))![1]
    const block = text.match(/\(property "Reference" "U4"\n {6}\(id 0\)\n {6}\(at ([-\d.]+) ([-\d.]+) 0\)\n {6}\(effects\n {8}\(font\n {10}\(size 1\.27 1\.27\)\n {8}\)\n {6}\)/)
    expect(block, "the reference is shown").toBeTruthy()
    expect(text).toMatch(/\(property "Value" "SHAPES"\n {6}\(id 1\)/)
  }, 120_000)

  it("writes the arc as an arc in the symbol's own frame", async () => {
    const { files } = await kicadFiles(sheet())
    const text = Object.entries(files).find(([k]) => k.endsWith(".kicad_sch"))![1]
    expect(text).toMatch(/\(arc\n {10}\(start -2\.54 -5\.08\)\n {10}\(mid 0 -6\.35\)\n {10}\(end 2\.54 -5\.08\)/)
  }, 120_000)

  it("writes a mirrored unit's geometry mirrored", async () => {
    const { files } = await kicadFiles(sheet())
    const text = Object.entries(files).find(([k]) => k.endsWith(".kicad_sch"))![1]
    // Unit 3 is mirrored left to right: its box is symmetric, but its V+ pin (at the top in the symbol) stays on top.
    const unit3 = text.slice(text.indexOf("_3_1"))
    expect(unit3).toMatch(/\(at 0 -?[\d.]+ \d+\)\n\s+\(length[^\n]*\n\s+\(name "V\+"/)
  }, 120_000)

  it("says what does not come across, only when it applies", async () => {
    const { notes } = await kicadFiles(sheet())
    const text = notes.join("\n")
    expect(text).toMatch(/pin numbers, names and electrical types/)
    expect(text).toMatch(/text drawn inside a symbol is written on the sheet beside it/)
    expect(text).not.toMatch(/every pin is written as passive/)
    expect(text).toMatch(/colours of lines are not written/)
    expect(text).toMatch(/Dashed, dotted and dash-dot lines are all written as KiCad's dash/)
    // A project drawn here has none of these.
    const own = await kicadFiles(EXAMPLES.find((e) => e.id === "blinker")!.project)
    expect(own.notes.join("\n")).not.toMatch(/units come across|colours of lines|Dashed, dotted/)
  }, 120_000)
})
