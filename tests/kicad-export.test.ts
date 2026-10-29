import { describe, expect, it } from "vitest"
import { kicadFiles, scaleSchematic, tidyNumbers } from "../src/export/kicad"
import { projectToCircuitJson } from "../src/export/circuitJson"
import { computeConnectivity } from "../src/model/connectivity"
import { EXAMPLES } from "../src/model/examples"
import { findPart } from "../src/model/library"
import type { Project } from "../src/model/types"

// There is no KiCad here to open the files, so these read them back the way a netlist export
// would: every pad of the board file and every pin of the schematic file against the netlist the
// project has.

/** "REF:pad" -> net name, from a .kicad_pcb: each footprint is read whole, since its reference can follow its pads. */
function boardPadNets(pcb: string): Map<string, string> {
  const nets = new Map<string, string>()
  for (const block of pcb.split(/\r?\n {2}\(footprint\b/).slice(1)) {
    const ref = block.match(/\(property "Reference" "([^"]*)"/)?.[1] ?? ""
    for (const pad of block.split(/\r?\n {4}\(pad /).slice(1)) {
      const number = pad.match(/^"([^"]*)"/)?.[1]
      const net = pad.match(/\(net \d+ "([^"]*)"\)/)?.[1] ?? ""
      if (number !== undefined) nets.set(`${ref}:${number}`, net)
    }
  }
  return nets
}

describe("kicadFiles", () => {
  const example = EXAMPLES.find((e) => e.id === "blinker")!.project

  it("writes a schematic, a board and a project file named for the project", async () => {
    const { files, notes } = await kicadFiles(example)
    expect(Object.keys(files).sort()).toEqual(["555-led-blinker.kicad_pcb", "555-led-blinker.kicad_pro", "555-led-blinker.kicad_sch"])
    expect(files["555-led-blinker.kicad_sch"]).toMatch(/^\(kicad_sch/)
    expect(files["555-led-blinker.kicad_pcb"]).toMatch(/^\(kicad_pcb/)
    expect(() => JSON.parse(files["555-led-blinker.kicad_pro"])).not.toThrow()
    expect(notes.join(" ")).toMatch(/Net-\(REF-PIN\)/)
    expect(notes.every((n) => !n.includes("—"))).toBe(true)
  }, 120_000)

  it("puts every pad on the net the project's netlist says, naming the ones the schematic left unnamed", async () => {
    const { files } = await kicadFiles(example)
    const pads = boardPadNets(files["555-led-blinker.kicad_pcb"])
    const ref = new Map(example.components.map((c) => [c.id, c.ref]))
    let checked = 0
    for (const net of computeConnectivity(example).nets.filter((n) => n.pins.length > 1)) {
      for (const pin of net.pins) {
        expect(pads.get(`${ref.get(pin.componentId)}:${pin.pin}`), `${ref.get(pin.componentId)}:${pin.pin}`).toBe(net.name)
        checked++
      }
    }
    expect(checked).toBeGreaterThan(15)
  }, 120_000)

  it("scales the schematic onto KiCad's 1.27 mm grid, and only the schematic", () => {
    const { elements } = projectToCircuitJson(example)
    const scaled = scaleSchematic(elements)
    const port = (list: typeof elements) => list.filter((e) => e.type === "schematic_port").map((e) => (e as { center: { x: number } }).center.x)
    const k = 12.7 / 15
    port(elements).forEach((x, i) => {
      // 15 mm per unit in the converter: a pin on the editor's 0.1 grid lands on a multiple of 1.27 mm.
      const mm = port(scaled)[i] * 15
      expect(Math.abs(mm / 1.27 - Math.round(mm / 1.27))).toBeLessThan(1e-6)
      expect(port(scaled)[i]).toBeCloseTo(x * k, 9)
    })
    expect(scaled.filter((e) => e.type === "pcb_smtpad")).toEqual(elements.filter((e) => e.type === "pcb_smtpad"))
  })

  it("rounds the floating point dust the converter leaves on coordinates", () => {
    expect(tidyNumbers("(xy 70.07499999999999 1.1102230246251565e-16) (width 0.12700004999999998) (at 3 4 90)")).toBe("(xy 70.075 0) (width 0.127) (at 3 4 90)")
  })

  it("leaves text in quotes alone, such as silkscreen text with a long decimal", () => {
    expect(tidyNumbers('(gr_text "v1.23456789012 rev" (at 1.23456789012 2)) (xy 0.12345678901234 3)')).toBe('(gr_text "v1.23456789012 rev" (at 1.234568 2)) (xy 0.123457 3)')
    expect(tidyNumbers(String.raw`(property "MPN" "A 0.123456789 \" 0.987654321" (at 0.5 1e-17))`)).toBe(String.raw`(property "MPN" "A 0.123456789 \" 0.987654321" (at 0.5 0))`)
  })
})

// ---------- What the converter drops, put back ----------

const exampleById = (id: string) => EXAMPLES.find((e) => e.id === id)!.project
const schematicOf = (files: Record<string, string>) => Object.entries(files).find(([name]) => name.endsWith(".kicad_sch"))![1]

interface PlacedSymbol {
  libId: string
  x: number
  y: number
  ref: string
  props: Map<string, { value: string; hidden: boolean }>
}

/** The placed symbols of a .kicad_sch other than the power symbols the converter draws for ports (references start with #): where each sits and its properties, hidden or not. */
function placedSymbols(sch: string): PlacedSymbol[] {
  return [...sch.matchAll(/\n {2}\(symbol\n {4}\(lib_id "([^"]*)"\)\n {4}\(at (\S+) (\S+) \S+\)[\s\S]*?\n {2}\)(?=\n)/g)].map((m) => {
    const props = new Map<string, { value: string; hidden: boolean }>()
    for (const p of m[0].matchAll(/\(property "([^"]*)" "((?:[^"\\]|\\.)*)"((?:\n {6,}.*)*)/g)) {
      // Each property's lines run until the next one starts at the same indent.
      const body = p[3].split(/\n {4}\(/)[0]
      props.set(p[1], { value: p[2], hidden: /\(hide yes\)/.test(body) })
    }
    return { libId: m[1], x: Number(m[2]), y: Number(m[3]), ref: props.get("Reference")!.value, props }
  }).filter((s) => !s.ref.startsWith("#"))
}

/** Pin number to its place in a library symbol, which KiCad draws y up. */
function libraryPins(sch: string, libId: string): Map<string, [number, number]> {
  const start = sch.indexOf(`\n    (symbol "${libId}"`)
  const end = sch.indexOf("\n    (symbol ", start + 10)
  const block = sch.slice(start, end < 0 ? undefined : end)
  return new Map([...block.matchAll(/\(pin \w+ \w+\s+\(at (\S+) (\S+) \S+\)[\s\S]*?\(number "([^"]*)"/g)].map((m) => [m[3], [Number(m[1]), Number(m[2])]]))
}

const noConnectsOf = (sch: string) => [...sch.matchAll(/\(no_connect\s+\(at (\S+) (\S+)\)\s+\(uuid [0-9a-f-]+\)/g)].map((m) => ({ x: Number(m[1]), y: Number(m[2]) }))

/** Reference to footprint library id, read from the board file by hand rather than with the code under test. */
function boardLibraryIds(pcb: string): Map<string, string> {
  const ids = new Map<string, string>()
  for (const block of pcb.split(/\r?\n {2}\(footprint\b/).slice(1)) {
    const ref = block.match(/\(property "Reference" "([^"]*)"/)?.[1]
    if (ref) ids.set(ref, block.match(/^\s*"([^"]+)"/)![1])
  }
  return ids
}

describe("KiCad 9 compatibility", () => {
  it("writes power symbols as a bare (power), the only form KiCad 9's parser reads", async () => {
    const project = EXAMPLES.find((e) => e.id === "blinker")!.project
    const sch = (await kicadFiles(project)).files["555-led-blinker.kicad_sch"]
    expect(sch).toMatch(/\(version 20250114\)/)
    const tokens = sch.match(/\(power[^)]*\)/g) ?? []
    expect(tokens.length).toBeGreaterThan(0)
    for (const token of tokens) expect(token).toBe("(power)")
  }, 120_000)
})

describe("KiCad no-connect flags", () => {
  for (const id of ["mcu", "node", "esp32-robot"]) {
    it(`flags every pin ${id} marks as unused, at the pin`, async () => {
      const project = exampleById(id)
      const sch = schematicOf((await kicadFiles(project)).files)
      const pins = project.components.flatMap((c) => (c.nc ?? []).map((pin) => ({ c, pin })))
      expect(pins.length).toBeGreaterThan(0)
      const flags = noConnectsOf(sch)
      expect(flags).toHaveLength(pins.length)
      // Where KiCad puts each pin: the symbol's place plus the pin's, y flipped. The flags are on exactly those.
      const symbols = placedSymbols(sch)
      for (const { c, pin } of pins) {
        const symbol = symbols.find((s) => s.ref === c.ref)!
        const offset = libraryPins(sch, symbol.libId).get(pin)
        expect(offset, `${c.ref} pin ${pin}`).toBeDefined()
        const at = { x: symbol.x + offset![0], y: symbol.y - offset![1] }
        expect(flags.some((f) => Math.abs(f.x - at.x) < 2e-3 && Math.abs(f.y - at.y) < 2e-3), `${c.ref} pin ${pin}`).toBe(true)
      }
    }, 120_000)
  }

  it("adds none to a board with no unused pins", async () => {
    const { files } = await kicadFiles(exampleById("blinker"))
    expect(noConnectsOf(schematicOf(files))).toHaveLength(0)
  }, 120_000)
})

describe("KiCad symbol fields", () => {
  const blinker = exampleById("blinker")
  const withParts: Project = {
    ...blinker,
    components: blinker.components.map((c) => (c.ref === "R1" ? { ...c, props: { ...c.props, lcsc: "C25900", mpn: "RC0603FR-074K7L", manufacturer: "Yageo" } } : c)),
  }

  it("gives a symbol the footprint of its board footprint and its part numbers, hidden", async () => {
    const { files } = await kicadFiles(withParts)
    const symbols = placedSymbols(schematicOf(files))
    const boardIds = boardLibraryIds(files["555-led-blinker.kicad_pcb"])
    const r1 = symbols.find((s) => s.ref === "R1")!
    expect(r1.props.get("MPN")).toEqual({ value: "RC0603FR-074K7L", hidden: true })
    expect(r1.props.get("LCSC")).toEqual({ value: "C25900", hidden: true })
    expect(r1.props.get("Manufacturer")).toEqual({ value: "Yageo", hidden: true })
    expect(r1.props.get("Footprint")).toEqual({ value: boardIds.get("R1"), hidden: true })
    expect(boardIds.get("R1")).toBeTruthy()
    for (const s of symbols) expect(s.props.get("Footprint")!.value, s.ref).toBe(boardIds.get(s.ref))
  }, 120_000)

  it("carries a capacitor's voltage into the symbol, and into Circuit JSON", async () => {
    const cap = withParts.components.find((c) => findPart(c.partId)?.id.startsWith("capacitor") && c.props.voltage)!
    const { files } = await kicadFiles(withParts)
    expect(placedSymbols(schematicOf(files)).find((s) => s.ref === cap.ref)!.props.get("Voltage")).toEqual({ value: cap.props.voltage, hidden: true })
    const source = projectToCircuitJson(withParts).elements.find((e) => e.type === "source_component" && e.name === cap.ref)
    expect(source).toMatchObject({ max_voltage_rating: Number.parseFloat(cap.props.voltage) })
  }, 120_000)

  it("leaves no part without the footprint and part number the project has for it", async () => {
    for (const id of ["mcu", "esp32-robot"]) {
      const project = exampleById(id)
      const symbols = placedSymbols(schematicOf((await kicadFiles(project)).files))
      expect(symbols.length).toBeGreaterThan(10)
      for (const s of symbols) {
        const c = project.components.find((x) => x.ref === s.ref)!
        expect(s.props.get("Footprint")!.value, s.ref).not.toBe("")
        expect(s.props.get("MPN")?.value, s.ref).toBe(c.props.mpn ?? findPart(c.partId)?.mpn)
      }
    }
  }, 120_000)
})

describe("KiCad project settings", () => {
  const robot = exampleById("esp32-robot")
  const rules = { ...robot.rules, clearance: 0.127, minTraceWidth: 0.127, traceWidth: 0.3, minDrill: 0.25, minAnnularRing: 0.11, holeClearance: 0.31, edgeClearance: 0.35, viaDiameter: 0.7, viaDrill: 0.35 }

  it("writes the project's design rules, default sizes and widths by net into the project file", async () => {
    const { files } = await kicadFiles({ ...robot, rules })
    const pro = JSON.parse(files["esp32-robot-controller.kicad_pro"])
    expect(pro.board.design_settings.rules).toMatchObject({
      min_clearance: 0.127,
      min_track_width: 0.127,
      min_through_hole_diameter: 0.25,
      min_via_annular_width: 0.11,
      min_hole_to_hole: 0.31,
      min_copper_edge_clearance: 0.35,
    })
    expect(pro.board.design_settings.rules.min_via_diameter).toBeCloseTo(0.47, 9)
    expect(pro.board.design_settings.defaults.via_dimensions).toContainEqual({ diameter: 0.7, drill: 0.35 })
    expect(pro.board.design_settings.defaults.track_widths).toEqual(expect.arrayContaining([0.3, ...rules.preferredWidths]))
    const classes: { name: string; track_width: number; clearance: number; via_diameter: number; via_drill: number }[] = pro.net_settings.classes
    expect(classes[0]).toMatchObject({ name: "Default", track_width: 0.3, clearance: 0.127, via_diameter: 0.7, via_drill: 0.35 })
    // Each net with a width of its own is in the class of that width.
    const widths = rules.netWidths!
    expect(Object.keys(widths).length).toBeGreaterThan(3)
    const patterns: { netclass: string; pattern: string }[] = pro.net_settings.netclass_patterns
    expect(patterns).toHaveLength(Object.keys(widths).length)
    for (const [net, width] of Object.entries(widths)) {
      const pattern = patterns.find((p) => p.pattern === net)!
      expect(classes.find((c) => c.name === pattern.netclass)!.track_width, net).toBe(width)
    }
  }, 120_000)

  it("has no net class beyond the default when no net has a width of its own", async () => {
    const blinker = exampleById("blinker")
    const { files } = await kicadFiles({ ...blinker, rules: { ...blinker.rules, netWidths: undefined } })
    const pro = JSON.parse(files["555-led-blinker.kicad_pro"])
    expect(pro.net_settings.classes).toHaveLength(1)
    expect(pro.net_settings.netclass_patterns).toEqual([])
  }, 120_000)

  it("sets each pour's clearance, thinnest neck, thermal gap and bridge, and the mask opening", async () => {
    const zoned: Project = {
      ...robot,
      zones: robot.zones.map((z, i) => (i === 0 ? { ...z, clearance: 0.5 } : z)),
      rules: { ...robot.rules, pourClearance: 0.35, pourMinWidth: 0.3, thermalSpokeWidth: 0.4, thermalRelief: "direct", maskExpansion: 0.07 },
    }
    const pcb = (await kicadFiles(zoned)).files["esp32-robot-controller.kicad_pcb"]
    const zones = pcb.split(/\n {2}\(zone\n/).slice(1)
    expect(zones.length).toBeGreaterThan(0)
    const first = zoned.zones[0]
    let ownGap = 0
    for (const zone of zones) {
      const net = zone.match(/\(net_name (?:"([^"]*)"|(\S+?))\)/)!
      const layer = zone.match(/\(layer "?([^"\s)]+)"?\)/)![1]
      const own = zoned.zones.find((z) => z.net === (net[1] ?? net[2]) && (z.layer === "top" ? "F.Cu" : "B.Cu") === layer)
      const gap = own === first ? 0.5 : 0.35
      if (own === first) ownGap++
      expect(zone).toMatch(new RegExp(`\\(connect_pads yes\\s+\\(clearance ${gap}\\)`))
      expect(zone).toContain("(min_thickness 0.3)")
      expect(zone).toContain(`(thermal_gap ${gap})`)
      expect(zone).toContain("(thermal_bridge_width 0.4)")
    }
    expect(ownGap).toBeGreaterThan(0)
    expect(pcb).toContain("(pad_to_mask_clearance 0.07)")
  }, 120_000)

  it("writes reliefs on through-hole pads only, and plain reliefs, as KiCad names them", async () => {
    const make = async (thermalRelief: "relief" | "relief-tht") => (await kicadFiles({ ...robot, rules: { ...robot.rules, thermalRelief } })).files["esp32-robot-controller.kicad_pcb"]
    expect(await make("relief-tht")).toMatch(/\(connect_pads thru_hole_only\s+\(clearance/)
    expect(await make("relief")).toMatch(/\(connect_pads\s+\(clearance/)
  }, 120_000)

  it("puts the project's name, description and properties into the title block and the project's variables", async () => {
    const described: Project = {
      ...exampleById("blinker"),
      description: "Blinks an LED",
      updatedAt: Date.UTC(2026, 9, 20, 12),
      properties: [
        { key: "Revision", value: "B" },
        { key: "Company", value: "Cherry Blossom" },
        { key: "Author", value: "Ana" },
      ],
    }
    const { files, notes } = await kicadFiles(described)
    expect(schematicOf(files)).toMatch(/\(title_block\s+\(title "555 LED blinker"\)\s+\(date "2026-10-20"\)\s+\(rev "B"\)\s+\(company "Cherry Blossom"\)\s+\(comment 1 "Blinks an LED"\)\s+\(comment 2 "Author: Ana"\)/)
    expect(JSON.parse(files["555-led-blinker.kicad_pro"]).text_variables).toEqual({ DESCRIPTION: "Blinks an LED", REVISION: "B", COMPANY: "Cherry Blossom", AUTHOR: "Ana" })
    expect(notes.join(" ")).toMatch(/title block/)
    expect(notes.join(" ")).toMatch(/press B/i)
    expect(notes.every((n) => !n.includes("—"))).toBe(true)
  }, 120_000)

  it("exports a project that was never saved, with no date in the title block", async () => {
    const { files } = await kicadFiles({ ...exampleById("blinker"), updatedAt: Number.NaN })
    expect(schematicOf(files)).not.toMatch(/\(date /)
  }, 120_000)
})

describe("Circuit JSON notes", () => {
  it("say the description and properties are not carried, since the format has no field for them", () => {
    const base = exampleById("blinker")
    expect(projectToCircuitJson({ ...base, description: "x", properties: [{ key: "Revision", value: "B" }] }).notes.join(" ")).toMatch(/description and properties/)
    expect(projectToCircuitJson({ ...base, description: "", properties: [] }).notes.join(" ")).not.toMatch(/description and properties/)
  })
})
