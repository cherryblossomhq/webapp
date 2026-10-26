import { describe, expect, it } from "vitest"
import { runTool } from "../src/ai/tools"
import { buildCustomPart, customPartProblems, withPartsFrom } from "../src/model/customParts"
import { pcbPads, schematicPins } from "../src/model/instances"
import { findPart } from "../src/model/library"
import { createProject } from "../src/model/ops"
import type { CustomPartSpec, Project } from "../src/model/types"
import { normalizeProject } from "../src/model/projectFile"

/** A TPS7A02-style LDO in SOT-23-5. */
const ldo = {
  name: "TPS7A0233",
  description: "200 mA 3.3 V nano-power LDO, SOT-23-5",
  category: "Power",
  footprint: "sot23_5",
  pins: [
    { number: "1", name: "IN", kind: "power" },
    { number: "2", name: "GND", kind: "ground" },
    { number: "3", name: "EN", kind: "input" },
    { number: "4", name: "NC", kind: "nc" },
    { number: "5", name: "OUT", kind: "output" },
  ],
  props: { manufacturer: "Texas Instruments" },
}

function create(project: Project, input: object) {
  const out = runTool(project, "create_part", input)
  const id = out.result.match(/part_id "([^"]+)"/)?.[1]
  return { ...out, id }
}

describe("create_part", () => {
  it("makes a part the library doesn't have, stores it in the project and lets the copilot place and wire it", () => {
    let p = createProject("ldo")
    const made = create(p, ldo)
    expect(made.isError).toBe(false)
    // No supplier lookup here, so it is made from memory and says so.
    expect(made.summary).toBe("Created part TPS7A0233 from memory (unverified)")
    expect(made.result).toContain("UNVERIFIED")
    expect(made.id).toMatch(/^tps7a0233-[0-9a-z]{6}$/)
    p = made.project
    expect(p.parts).toHaveLength(1)
    expect(p.parts![0].source).toEqual({ pins: "memory", land: "memory", note: "no supplier lookup was made" })

    const part = findPart(made.id!)!
    expect(part).toMatchObject({ name: "TPS7A0233", refPrefix: "U", custom: true, mpn: "TPS7A0233", valueProp: "mpn" })
    // Supply on top, ground below, input left, output right.
    const dir = (name: string) => part.symbol.ports.find((port) => port.pin === part.pins.find((x) => x.name === name)!.number)!.dir
    expect([dir("IN"), dir("GND"), dir("EN"), dir("OUT")]).toEqual(["up", "down", "left", "right"])

    p = runTool(p, "add_component", { part_id: made.id, x: 0, y: 0 }).project
    p = runTool(p, "connect", { pins: ["U1.IN", "U1.EN"], net_name: "VIN" }).project
    const u1 = p.components[0]
    expect(schematicPins(u1)).toHaveLength(5)
    expect(pcbPads(u1).map((pad) => pad.pin).sort()).toEqual(["1", "2", "3", "4", "5"])

    // The library search finds it, and creating it again changes nothing.
    expect(runTool(p, "search_parts", { query: "tps7a02" }).result).toContain(`"part_id":"${made.id}"`)
    const again = create(p, ldo)
    expect(again.project).toBe(p)
    expect(again.result).toContain("already exists")
  })

  it("rejects pinouts that don't fit the footprint, with what to fix", () => {
    const p = createProject("bad")
    const short = runTool(p, "create_part", { ...ldo, pins: ldo.pins.slice(0, 4) })
    expect(short.isError).toBe(true)
    expect(short.result).toContain("pad(s) 5 of sot23_5 have no pin")

    const extra = runTool(p, "create_part", { ...ldo, footprint: "sot23" })
    expect(extra.result).toContain("pin(s) 4, 5 have no pad")

    expect(runTool(p, "create_part", { ...ldo, footprint: "nope99" }).result).toContain('unknown footprint "nope99"')
    expect(runTool(p, "create_part", { ...ldo, pins: [...ldo.pins, { number: "1", name: "X" }] }).result).toContain("pin 1 is listed twice")
    expect(runTool(p, "create_part", { ...ldo, category: "Gadgets" }).result).toContain("input.category must be one of")
  })

  it("maps shared pads with pad_alias", () => {
    const reg = {
      name: "LM1117-5.0",
      description: "800 mA 5 V LDO",
      category: "Power",
      footprint: "sot223",
      pins: [
        { number: "1", name: "GND", kind: "ground" },
        { number: "2", name: "VOUT", kind: "output" },
        { number: "3", name: "VIN", kind: "power" },
      ],
    }
    expect(runTool(createProject("x"), "create_part", reg).result).toContain("pad(s) 4 of sot223 have no pin")
    const made = create(createProject("x"), { ...reg, pad_alias: { "4": "2" } })
    expect(made.isError).toBe(false)
    const p = runTool(made.project, "add_component", { part_id: made.id }).project
    expect(pcbPads(p.components[0]).find((pad) => pad.padNumber === "4")?.pin).toBe("2")
  })

  it("draws discretes with their own symbol, matching polarized pins by name", () => {
    const fet = {
      name: "IRLZ44N",
      description: "55 V 47 A logic-level N-MOSFET, TO-220",
      category: "Transistors",
      footprint: "to220_3",
      symbol: "nmos",
      pins: [
        { number: "1", name: "G" },
        { number: "2", name: "D" },
        { number: "3", name: "S" },
      ],
    }
    const made = create(createProject("fet"), fet)
    expect(made.isError).toBe(false)
    const part = findPart(made.id!)!
    expect(part.refPrefix).toBe("Q")
    // The gate is the symbol's left-hand pin, whatever its number.
    expect(part.symbol.ports.find((port) => port.dir === "left")?.pin).toBe("1")

    const unnamed = runTool(createProject("fet"), "create_part", { ...fet, pins: fet.pins.map((p, i) => ({ ...p, name: `P${i}` })) })
    expect(unnamed.result).toContain("the nmos symbol needs a pin named D or DRAIN")
  })

  it("replaces a part made earlier and switches its components over", () => {
    let p = createProject("fix")
    const first = create(p, { ...ldo, pins: ldo.pins.map((x) => (x.number === "3" ? { ...x, name: "SHDN" } : x)) })
    p = runTool(first.project, "add_component", { part_id: first.id }).project
    const fixed = create(p, { ...ldo, replaces: first.id })
    expect(fixed.isError).toBe(false)
    expect(fixed.id).not.toBe(first.id)
    expect(fixed.project.parts?.map((s) => s.id)).toEqual([fixed.id])
    expect(fixed.project.components[0].partId).toBe(fixed.id)
    expect(runTool(p, "create_part", { ...ldo, replaces: "resistor" }).isError).toBe(true)
  })

  it("survives a reload: specs are saved in the project and rebuilt on load", () => {
    const made = create(createProject("save"), ldo)
    const p = runTool(made.project, "add_component", { part_id: made.id }).project
    const loaded = normalizeProject(JSON.parse(JSON.stringify(p)))
    expect(loaded.parts).toEqual(p.parts)
    expect(loaded.components[0].footprint).toBe("sot23_5")

    // A spec that no longer builds is dropped instead of breaking the project.
    const broken = normalizeProject({ ...JSON.parse(JSON.stringify(p)), parts: [{ ...p.parts![0], id: "broken-1", footprint: "nope99" }] })
    expect(broken.parts).toBeUndefined()
  })

  it("carries a project's parts along when its components are pasted into another", () => {
    const made = create(createProject("a"), ldo)
    const target = createProject("b")
    const next = withPartsFrom(target, made.project, [made.id!, "resistor"])
    expect(next.parts?.map((s) => s.id)).toEqual([made.id])
    expect(withPartsFrom(next, made.project, [made.id!])).toBe(next)
  })
})

describe("custom part specs", () => {
  const spec = (over: Partial<CustomPartSpec> = {}): CustomPartSpec => ({
    id: "x-1",
    name: "X",
    description: "",
    category: "ICs",
    refPrefix: "U",
    footprint: "soic8",
    pins: Array.from({ length: 8 }, (_, i) => ({ number: String(i + 1), name: `P${i + 1}` })),
    props: {},
    ...over,
  })

  it("splits pins without a side evenly between left and right", () => {
    expect(customPartProblems(spec())).toEqual([])
    const ports = buildCustomPart(spec()).symbol.ports
    expect(ports.filter((p) => p.dir === "left").map((p) => p.pin)).toEqual(["1", "2", "3", "4"])
    expect(ports.filter((p) => p.dir === "right").map((p) => p.pin)).toEqual(["5", "6", "7", "8"])
  })

  it("checks designator prefixes and categories", () => {
    expect(customPartProblems(spec({ refPrefix: "u1" }))).toContain("ref_prefix must be 1-3 capital letters, e.g. U, J, Q")
    expect(customPartProblems(spec({ category: "Symbols" }))[0]).toMatch(/^category must be one of/)
  })
})
