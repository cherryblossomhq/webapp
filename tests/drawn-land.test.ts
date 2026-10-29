import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { executeTool, runTool, validateInput } from "../src/ai/tools"
import { EXAMPLES } from "../src/model/examples"
import { footprintOptions, getFootprint } from "../src/model/footprints"
import { pcbPads } from "../src/model/instances"
import { PARTS } from "../src/model/library"
import { createProject } from "../src/model/ops"
import { partFindings } from "../src/model/partChecks"
import { parseProjectFile, serializeProject } from "../src/model/projectFile"
import type { Project } from "../src/model/types"
import { recordedSource } from "./fixtures/supplier/source"

// Parts on lands no footprint string draws. An assistant asked over MCP for a Phoenix 1777558 (three
// pins, the middle one 9 mm behind the others, 1.3 mm holes) had only footprint strings, tried
// `pinrow3_p6.35mm_zigzag9mm_...` and `..._stagger9mm_...`, and got three pads in a row each time,
// without a word: the footprinter drops an option its family doesn't take. Both are refused now, and
// create_part takes the land pad by pad.

const PHOENIX_PINS = [
  { number: "1", name: "1", kind: "passive" },
  { number: "2", name: "2", kind: "passive" },
  { number: "3", name: "3", kind: "passive" },
]

/** The 1777558's drilling diagram, as the assistant read it. */
const PHOENIX_LAND = {
  pads: [
    { number: "1", x: 0, y: 0, shape: "rect", w: 2.6, h: 2.6, drill: 1.3 },
    { number: "2", x: 6.35, y: -9, shape: "circle", d: 2.6, drill: 1.3 },
    { number: "3", x: 12.7, y: 0, shape: "circle", d: 2.6, drill: 1.3 },
  ],
  body: { x1: -1.6, y1: 2.1, x2: 14.25, y2: -12.95 },
  courtyard_margin: 0.5,
}

const phoenix = (extra: object = {}) => ({
  name: "1777558",
  description: "Phoenix Contact 3-position PCB terminal block, staggered, 6.35 mm pitch",
  category: "Connectors",
  pins: PHOENIX_PINS,
  ...extra,
})

const partIdOf = (result: string) => result.match(/part_id "([^"]+)"/)?.[1]

describe("footprint strings with options the footprinter ignores", () => {
  it("refuses the staggered pin rows the assistant tried, naming the option and what it takes", () => {
    for (const option of ["zigzag9mm", "stagger9mm"]) {
      const out = runTool(createProject("p"), "create_part", phoenix({ footprint: `pinrow3_p6.35mm_${option}_id1.3mm_od2.8mm` }))
      expect(out.isError).toBe(true)
      expect(out.project.parts).toBeUndefined()
      expect(out.result).toContain(`doesn't take ${option} for pinrow3`)
      expect(out.result).toContain("pinrow3 takes rows, p, id, od")
      expect(out.result).toContain("pass land with each pad")
    }
  })

  it("refuses a misspelt option and a stray token, and reads what it does take", () => {
    expect(footprintOptions("soic8_pitch1.27").ignored).toEqual(["pitch1.27"])
    expect(footprintOptions("pinrow3_p6.35mm_5").ignored).toEqual(["5"])
    expect(footprintOptions("0603_foo3").ignored).toEqual(["foo3"])
    // Options read under another name, a pin count after the family, a family's own spelling.
    for (const ok of ["pinrow3_p6.35mm_id1.3mm_od2.8mm", "sot23_5", "to220_3", "jst_ph_4", "smtpad_circle_d1.2", "0603_metric", "qfn16_w4_h4_p0.65mm_thermalpad", "dfn8_w2.5_p0.5mm_pl0.5mm_pw0.25mm", "pinrow6_rows2_p2.54mm_female"]) {
      expect(footprintOptions(ok).ignored, ok).toEqual([])
    }
  })

  it("finds nothing ignored in any footprint the library or the examples use", () => {
    const names = new Set([...PARTS.flatMap((p) => p.footprints), ...EXAMPLES.flatMap((e) => e.project.components.map((c) => c.footprint))])
    for (const name of names) expect(footprintOptions(name).ignored, name).toEqual([])
  })

  it("refuses one on add_component and update_component too", () => {
    const added = runTool(createProject("p"), "add_component", { part_id: "resistor", footprint: "0603_foo3" })
    expect(added.isError).toBe(true)
    expect(added.result).toContain("doesn't take foo3 for 0603")
    let p = runTool(createProject("p"), "add_component", { part_id: "resistor", footprint: "0805" }).project
    const updated = runTool(p, "update_component", { ref: "R1", footprint: "0603_pitch1.6" })
    expect(updated.isError).toBe(true)
    expect(updated.result).toContain("pitch1.6")
    p = runTool(p, "update_component", { ref: "R1", footprint: "0603" }).project
    expect(p.components[0].footprint).toBe("0603")
  })
})

describe("create_part with a land drawn pad by pad", () => {
  it("makes the Phoenix 1777558 on its staggered land, marked unverified, and keeps it through a reload", () => {
    const made = runTool(createProject("p"), "create_part", phoenix({ land: PHOENIX_LAND }))
    expect(made.isError, made.result).toBe(false)
    expect(made.summary).toBe("Created part 1777558 from memory (unverified)")
    expect(made.result).toContain("UNVERIFIED")
    expect(made.result).toContain("Land from the pads you gave: 3 pads")
    const spec = made.project.parts![0]
    expect(spec.source).toMatchObject({ pins: "memory", land: "memory" })
    expect(spec.footprint).toMatch(/^land_1777558-[0-9a-z]{6}$/)
    const land = made.project.footprints!.find((f) => f.name === spec.footprint)!
    expect(land.pads).toEqual([
      { pin: "1", shape: "rect", x: 0, y: 0, width: 2.6, height: 2.6, holeDiameter: 1.3, layer: "through" },
      { pin: "2", shape: "circle", x: 6.35, y: -9, width: 2.6, height: 2.6, holeDiameter: 1.3, layer: "through" },
      { pin: "3", shape: "circle", x: 12.7, y: 0, width: 2.6, height: 2.6, holeDiameter: 1.3, layer: "through" },
    ])
    expect(land.silk).toEqual([[{ x: -1.6, y: -12.95 }, { x: 14.25, y: -12.95 }, { x: 14.25, y: 2.1 }, { x: -1.6, y: 2.1 }, { x: -1.6, y: -12.95 }]])
    expect(land.courtyard).toEqual({ minX: -2.1, minY: -13.45, maxX: 14.75, maxY: 2.6 })

    const placed = runTool(made.project, "add_component", { part_id: partIdOf(made.result) })
    expect(placed.isError, placed.result).toBe(false)
    const pads = pcbPads(placed.project.components[0])
    const at = (pin: string) => pads.find((p) => p.pin === pin)!
    expect(at("2").y - at("1").y).toBeCloseTo(-9)
    expect(at("3").x - at("1").x).toBeCloseTo(12.7)
    // Checks warns about it as about any part made from memory.
    expect(partFindings(placed.project)[0]).toMatchObject({ severity: "warning" })
    expect(partFindings(placed.project)[0].message).toContain("pinout and footprint not verified")

    const reloaded = parseProjectFile(serializeProject(placed.project), { id: "p" })
    expect(reloaded.footprints).toEqual(placed.project.footprints)
    expect(pcbPads(reloaded.components[0]).map((p) => [p.pin, p.x, p.y])).toEqual(pads.map((p) => [p.pin, p.x, p.y]))
  })

  it("makes pads with one number one pin, and draws slots, bare holes and paste as given", () => {
    const made = runTool(createProject("p"), "create_part", {
      name: "USB-C-PWR-6P",
      description: "USB-C power-only receptacle, 6 pins, through-hole shell",
      category: "Connectors",
      pins: [
        { number: "A5", name: "CC1" },
        { number: "B5", name: "CC2" },
        { number: "V", name: "VBUS", kind: "power" },
        { number: "G", name: "GND", kind: "ground" },
        { number: "S", name: "SHIELD" },
      ],
      land: {
        pads: [
          { number: "A5", x: -0.5, y: 0, w: 0.6, h: 1.2, paste_ratio: -0.1 },
          { number: "B5", x: 0.5, y: 0, w: 0.6, h: 1.2, mask_margin: 0.05 },
          { number: "V", x: -1.8, y: 0, shape: "roundrect", w: 0.8, h: 1.2, corner_ratio: 0.2 },
          { number: "G", x: 1.8, y: 0, w: 0.8, h: 1.2, paste: false },
          { number: "S", x: -4.3, y: -1, shape: "oval", w: 1, h: 2.1, drill: 0.6, slot_length: 1.7 },
          { number: "S", x: 4.3, y: -1, shape: "oval", w: 1, h: 2.1, drill: 0.6, slot_length: 1.7 },
          { x: -2.9, y: -1.5, drill: 0.65, plated: false },
          { x: 2.9, y: -1.5, drill: 0.65, plated: false },
        ],
      },
    })
    expect(made.isError, made.result).toBe(false)
    const land = getFootprint(made.project.parts![0].footprint)
    expect(land.pads.filter((p) => p.pin === "S")).toHaveLength(2)
    expect(land.pads[0]).toMatchObject({ layer: "top", pasteRatio: -0.1 })
    expect(land.pads[1]).toMatchObject({ maskMargin: 0.05 })
    expect(land.pads[2]).toMatchObject({ shape: "rect", round: 0.2 })
    expect(land.pads[3]).toMatchObject({ layers: { paste: "none" } })
    expect(land.pads[4]).toMatchObject({ shape: "pill", holeDiameter: 0.6, slotLength: 1.7, layer: "through" })
    expect(land.pads[6]).toEqual({ pin: null, shape: "circle", x: -2.9, y: -1.5, width: 0.65, height: 0.65, holeDiameter: 0.65, layer: "through", plated: false })

    const p = runTool(made.project, "add_component", { part_id: partIdOf(made.result) }).project
    expect(pcbPads(p.components[0]).filter((pad) => pad.pin === "S")).toHaveLength(2)
  })

  it("turns a pad by a quarter turn as its size, and by any other angle as its own", () => {
    const made = runTool(createProject("p"), "create_part", {
      name: "TURNED",
      description: "A part with turned pads",
      category: "ICs",
      pins: [
        { number: "1", name: "A" },
        { number: "2", name: "B" },
      ],
      land: {
        pads: [
          { number: "1", x: 0, y: 0, w: 1, h: 2, rotation: 90 },
          { number: "2", x: 4, y: 0, w: 1, h: 2, rotation: 45 },
        ],
      },
    })
    expect(made.isError, made.result).toBe(false)
    const [one, two] = getFootprint(made.project.parts![0].footprint).pads
    expect(one).toMatchObject({ width: 2, height: 1 })
    expect(one.rot).toBeUndefined()
    expect(two).toMatchObject({ width: 1, height: 2, rot: 45 })
  })

  it("refuses what it can't draw as given, naming the pad, and makes nothing", () => {
    const refused = (land: object, extra: object = {}) => {
      const out = runTool(createProject("p"), "create_part", phoenix({ land, ...extra }))
      expect(out.isError).toBe(true)
      expect(out.project.parts).toBeUndefined()
      return out.result
    }
    const pads = PHOENIX_LAND.pads
    // A misspelt field is refused by the schema, not read past.
    expect(refused({ pads: [{ ...pads[0], hole: 1.3 }, ...pads.slice(1)] })).toContain("input.land.pads[0].hole is not a field here")
    expect(refused({ ...PHOENIX_LAND, origin: "pin1" })).toContain("input.land.origin is not a field here")
    expect(refused({ pads: [{ ...pads[0], drill: 2.6 }, ...pads.slice(1)] })).toContain("pad 1: its 2.6 mm hole leaves no copper round it")
    expect(refused({ pads: [pads[0], { ...pads[1], x: 1, y: 0 }, pads[2]] })).toContain("pads 1 at (0, 0) and 2 at (1, 0) overlap")
    expect(refused({ pads: [pads[0], { ...pads[1], w: 2, h: 3 }, pads[2]] })).toContain("pad 2: a circle has one size, d")
    expect(refused({ pads: [{ ...pads[0], paste: false }, ...pads.slice(1)] })).toContain("pad 1: paste settings are for surface-mount pads")
    expect(refused({ pads: [{ ...pads[0], slot_length: 2 }, ...pads.slice(1)] })).toContain("a slot runs along a pad's longer side")
    expect(refused({ pads: [{ number: "1", x: 0, y: 0, w: 1, h: 1, drill: 0.5, plated: false }, ...pads.slice(1)] })).toContain("a non-plated hole is no pin")
    expect(refused({ pads: [...pads, { number: "4", x: 300, y: 0, d: 2, drill: 1 }] })).toContain("over 250 mm out")
    expect(refused(PHOENIX_LAND, { footprint: "pinrow3" })).toContain("Pass footprint or land, not both")
    // Pins and pads still have to match one to one.
    expect(refused({ pads: pads.slice(0, 2) })).toContain("pin(s) 3 have no pad")
  })

  it("takes a KiCad footprint file's text as the land", () => {
    const text = readFileSync(join(__dirname, "fixtures", "kicad", "footprints/Package_TO_SOT_SMD.pretty/SOT-23-5.kicad_mod"), "utf8")
    const pins = ["VIN", "GND", "EN", "NC", "VOUT"].map((name, i) => ({ number: String(i + 1), name }))
    const made = runTool(createProject("p"), "create_part", { name: "MYLDO", description: "An LDO", category: "Power", pins, land: { kicad_mod: text } })
    expect(made.isError, made.result).toBe(false)
    expect(made.result).toContain("Land from the KiCad footprint SOT-23-5: 5 pads")
    expect(made.project.parts![0].source).toMatchObject({ pins: "memory", land: "memory" })
    expect(made.project.footprints).toHaveLength(1)

    const bad = runTool(createProject("p"), "create_part", { name: "MYLDO", description: "An LDO", category: "Power", pins, land: { kicad_mod: "(not a footprint)" } })
    expect(bad.isError).toBe(true)
    expect(bad.result).toContain("Can't read land.kicad_mod")
    expect(runTool(createProject("p"), "create_part", { name: "MYLDO", description: "An LDO", category: "Power", pins, land: { kicad_mod: text, pads: PHOENIX_LAND.pads } }).result).toContain("pass it alone")
  })

  it("is compared with the supplier's land when the supplier has one", async () => {
    const project: Project = createProject("p")
    const pins = ["VIN", "SW", "GND", "VOUT", "FB", "EN"].map((name, i) => ({ number: String(i + 1), name }))
    const out = await executeTool(
      project,
      () => project,
      "create_part",
      {
        lcsc: "C919459",
        category: "Power",
        pins,
        land: { pads: pins.map((p, i) => ({ number: p.number, x: (i % 3) * 2.54, y: i < 3 ? 0 : 2.54, d: 1.6, drill: 0.9 })) },
      },
      { parts: recordedSource() },
    )
    expect(out.isError).toBe(true)
    expect(out.result).toContain("The land from the pads you gave doesn't fit LCSC C919459")
    expect(out.result).toContain("Leave land out")
  })

  it("refuses unknown fields wherever a schema says so", () => {
    const schema = { type: "object" as const, additionalProperties: false, properties: { a: { type: "number" as const } } }
    expect(validateInput(schema, { a: 1 })).toBeNull()
    expect(validateInput(schema, { a: 1, b: 2 })).toBe("input.b is not a field here; use a")
  })
})
