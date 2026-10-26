import { describe, expect, it } from "vitest"
import { runTool, TOOL_DEFINITIONS, validateInput } from "../src/ai/tools"
import { createProject } from "../src/model/ops"
import type { Project } from "../src/model/types"

function design(project: Project) {
  const out = runTool(project, "get_design", {})
  expect(out.isError).toBe(false)
  return JSON.parse(out.result) as {
    components: { ref: string; part: string; value?: string; pins?: { pin: string; name: string; net: string | null }[] }[]
    nets: { name: string; pins: string[] }[]
  }
}

describe("copilot tools", () => {
  it("adds parts, connects them and reports nets through get_design", () => {
    let p = createProject("t")
    let out = runTool(p, "add_component", { part_id: "ne555", x: 0, y: 0 })
    expect(out.isError).toBe(false)
    expect(out.result).toContain("U1")
    p = out.project

    out = runTool(p, "add_component", { part_id: "resistor", props: { resistance: "4.7k" }, x: -3.04, y: 1 })
    expect(out.summary).toBe("Added R1 (Resistor, 4.7k)")
    p = out.project
    expect(p.components.find((c) => c.ref === "R1")?.sch.x).toBe(-3)

    p = runTool(p, "connect", { pins: ["R1.2", "U1.DIS"] }).project
    out = runTool(p, "connect", { pins: ["U1.VCC", "U1.RST", "R1.1"], net_name: "5V" })
    expect(out.isError).toBe(false)
    p = out.project
    p = runTool(p, "connect", { pins: ["U1.GND"], net_name: "GND" }).project

    const d = design(p)
    const u1 = d.components.find((c) => c.ref === "U1")!
    const pinNet = (name: string) => u1.pins!.find((x) => x.name === name)?.net
    expect(pinNet("VCC")).toBe("5V")
    expect(pinNet("RST")).toBe("5V")
    expect(pinNet("GND")).toBe("GND")
    expect(pinNet("DIS")).toBe("Net-(R1-2)")
    expect(pinNet("OUT")).toBeNull()
    expect(d.nets.find((n) => n.name === "5V")?.pins.sort()).toEqual(["R1.1", "U1.4", "U1.8"])
  })

  it("reports already-connected pins without changing the design", () => {
    let p = createProject("t")
    p = runTool(p, "add_component", { part_id: "resistor" }).project
    p = runTool(p, "add_component", { part_id: "led" }).project
    p = runTool(p, "connect", { pins: ["R1.2", "D1.A"] }).project
    const again = runTool(p, "connect", { pins: ["R1.2", "D1.1"] })
    expect(again.project).toBe(p)
    expect(again.result).toMatch(/already connected/)
  })

  it("returns errors for unknown pins, parts and refs instead of throwing", () => {
    let p = createProject("t")
    p = runTool(p, "add_component", { part_id: "resistor" }).project

    const badPin = runTool(p, "connect", { pins: ["R1.9", "R2.1"] })
    expect(badPin.isError).toBe(true)
    expect(badPin.project).toBe(p)
    expect(badPin.result).toMatch(/^Error: Unknown pin/)
    expect(badPin.result).toContain("R1 has pins 1, 2")
    expect(badPin.result).toContain("no component R2")

    const badPart = runTool(p, "add_component", { part_id: "esp32" })
    expect(badPart.isError).toBe(true)
    expect(badPart.result).toContain('Unknown part "esp32"')

    expect(runTool(p, "remove_component", { ref: "Q7" }).result).toBe("Error: No component Q7")
    expect(runTool(p, "add_component", { part_id: "resistor", ref: "R1" }).result).toContain("already used")
  })

  it("validates inputs against the tool schema", () => {
    const p = createProject("t")
    expect(runTool(p, "add_component", { part_id: "resistor", rotation: 45 }).result).toContain("input.rotation must be one of")
    expect(runTool(p, "connect", { pins: "R1.1" }).result).toContain("input.pins must be an array")
    expect(runTool(p, "set_board", { width: 30 }).result).toContain("input.height is required")
    expect(runTool(p, "nope", {}).isError).toBe(true)
    for (const def of TOOL_DEFINITIONS) expect(validateInput(def.function.parameters, {})).toSatisfy((e) => e === null || e.includes("required"))
  })

  it("removes a component with its labels and moves parts with attached wires", () => {
    let p = createProject("t")
    p = runTool(p, "add_component", { part_id: "resistor", x: 0, y: 0 }).project
    p = runTool(p, "add_component", { part_id: "capacitor", x: 3, y: 0 }).project
    p = runTool(p, "connect", { pins: ["R1.2", "C1.1"] }).project
    p = runTool(p, "connect", { pins: ["R1.1"], net_name: "VIN" }).project

    const moved = runTool(p, "update_component", { ref: "C1", y: 1 })
    expect(moved.isError).toBe(false)
    expect(design(moved.project).nets.some((n) => n.pins.includes("C1.1") && n.pins.includes("R1.2"))).toBe(true)

    const removed = runTool(p, "remove_component", { ref: "R1" })
    expect(removed.project.components.map((c) => c.ref)).toEqual(["C1"])
    expect(removed.project.labels).toHaveLength(0)
    expect(removed.project.wires).toHaveLength(0)
  })

  it("lays out the PCB and resizes the board", () => {
    let p = createProject("t")
    p = runTool(p, "add_component", { part_id: "resistor" }).project
    p = runTool(p, "add_component", { part_id: "power" }).project
    const placed = runTool(p, "layout_pcb", {})
    expect(placed.result).toContain("Placed 1 part(s)")
    expect(placed.project.components.find((c) => c.ref === "R1")?.pcb.placed).toBe(true)
    expect(runTool(placed.project, "layout_pcb", {}).project).toBe(placed.project)
    expect(runTool(p, "set_board", { width: 20, height: 15 }).project.board).toMatchObject({ width: 20, height: 15 })
    expect(runTool(p, "set_board", { width: 2, height: 15 }).isError).toBe(true)
  })
})

describe("copilot board tools", () => {
  it("pours ground and routes the board", () => {
    let p = createProject("route")
    for (const [part, x] of [["resistor", 0], ["led", 2]] as const) p = runTool(p, "add_component", { part_id: part, x, y: 0 }).project
    // Rail symbols, so 5V and GND are supplies rather than labels no other pin has.
    p = runTool(p, "add_component", { part_id: "power", props: { net: "5V" }, x: 0, y: 3 }).project
    p = runTool(p, "add_component", { part_id: "ground", x: 2, y: -3 }).project
    p = runTool(p, "connect", { pins: ["R1.2", "D1.A"] }).project
    p = runTool(p, "connect", { pins: ["R1.1"], net_name: "5V" }).project
    p = runTool(p, "connect", { pins: ["D1.K"], net_name: "GND" }).project
    expect(runTool(p, "route_pcb", {}).isError).toBe(true)
    p = runTool(p, "layout_pcb", {}).project

    let out = runTool(p, "set_pour", { net: "GND", layer: "both" })
    expect(out.summary).toBe("Poured GND on top and bottom")
    p = out.project
    expect(p.zones).toHaveLength(2)
    expect(runTool(p, "set_pour", { net: "NOPE", layer: "top" }).isError).toBe(true)

    out = runTool(p, "route_pcb", {})
    expect(out.isError).toBe(false)
    expect(out.project.traces.length).toBeGreaterThan(0)
    expect(runTool(out.project, "run_checks", {}).summary).toBe("Checks pass")

    // Only SMD parts on top: the bottom pour has no GND copper until the vias reach it.
    out = runTool(out.project, "set_pour", { net: "GND", layer: "both", stitch: true })
    expect(out.summary).toMatch(/^Stitched GND with \d+ vias$/)
    expect(out.project.vias.some((v) => v.net === "GND")).toBe(true)
    expect(runTool(out.project, "run_checks", {}).summary).toBe("Checks pass")

    p = runTool(out.project, "set_pour", { net: "GND", layer: "both", remove: true }).project
    expect(p.zones).toEqual([])
    expect(p.vias.some((v) => v.net)).toBe(false)
  })
})

describe("board and rule tools", () => {
  it("sets board properties without resizing it", () => {
    const p = createProject("t")
    const out = runTool(p, "set_board", { thickness: 1, copper_oz: 2, finish: "osp", mask_color: "#16161A", mounting_holes: "m2.5" })
    expect(out.isError).toBe(false)
    expect(out.project.board).toMatchObject({ width: 50, height: 40, thickness: 1, copperWeight: 2, finish: "osp", maskColor: "#16161a" })
    expect(out.project.board.mountingHoles?.drill).toBe(2.7)
    expect(runTool(p, "set_board", { thickness: 1.3 }).isError).toBe(true)
    expect(runTool(p, "set_board", { mask_color: "green" }).result).toContain("#rrggbb")
    expect(runTool(p, "set_board", {}).isError).toBe(true)
  })

  it("applies a fab capability and single rules, and reads them back", () => {
    const p = createProject("t")
    const out = runTool(p, "set_design_rules", { fab_capability: "fine", trace_width: 0.2, tent_vias: false, thermal_relief: "relief" })
    expect(out.isError).toBe(false)
    expect(out.project.rules).toMatchObject({ minTraceWidth: 0.127, clearance: 0.127, traceWidth: 0.2, tentVias: false, thermalRelief: "relief" })
    const read = JSON.parse(runTool(out.project, "get_design", {}).result) as { design_rules_mm: { fab_capability: string; trace_width: number } }
    expect(read.design_rules_mm).toMatchObject({ fab_capability: "fine", trace_width: 0.2 })
    expect(runTool(p, "set_design_rules", { trace_width: 0.1 }).result).toContain("below min_trace_width")
    expect(runTool(p, "set_design_rules", { via_drill: 0.7 }).result).toContain("smaller than via_diameter")
    expect(runTool(p, "set_design_rules", { clearance: 9 }).isError).toBe(true)
  })
})

describe("block tools", () => {
  type Blocks = { name: string; parts: string[]; frame?: { min_x: number; min_y: number; max_x: number; max_y: number } }[]
  const blocks = (project: Project) => (JSON.parse(runTool(project, "get_design", {}).result) as { blocks?: Blocks }).blocks

  function board() {
    let p = createProject("t")
    for (const [part_id, x] of [["ams1117_3v3", 0], ["capacitor", 2], ["capacitor", 3], ["led", 8], ["resistor", 10]] as const) {
      p = runTool(p, "add_component", { part_id, x, y: 0 }).project
    }
    return p
  }

  it("groups parts into a named block, which get_design reports with its frame", () => {
    const p = board()
    expect(blocks(p)).toBeUndefined()
    const out = runTool(p, "group_parts", { block: "3.3V  power", refs: ["U1", "c1", "C2"] })
    expect(out.isError).toBe(false)
    expect(out.summary).toBe("Grouped U1, C1, C2 into 3.3V power")
    const [block] = blocks(out.project)!
    expect(block).toMatchObject({ name: "3.3V power", parts: ["U1", "C1", "C2"] })
    expect(block.frame!.min_x).toBeLessThan(0)
    expect(block.frame!.max_x).toBeGreaterThan(3)
  })

  it("adds to a block of the same name, and moves parts out of the block they were in", () => {
    let p = runTool(board(), "group_parts", { block: "LED", refs: ["D1"] }).project
    p = runTool(p, "group_parts", { block: "POWER", refs: ["U1", "R1"] }).project
    const out = runTool(p, "group_parts", { block: "led", refs: ["R1"] })
    expect(out.result).toContain("Block LED holds D1, R1.")
    expect(out.result).toContain("R1 (POWER)")
    expect(blocks(out.project)?.map((b) => [b.name, b.parts])).toEqual([
      ["LED", ["D1", "R1"]],
      ["POWER", ["U1"]],
    ])
  })

  it("renames a block, takes parts out of it and ungroups it", () => {
    const p = runTool(board(), "group_parts", { block: "POWER", refs: ["U1", "C1", "C2"] }).project
    const renamed = runTool(p, "edit_block", { block: "power", new_name: "3.3V POWER", remove_refs: ["C2"] })
    expect(renamed.isError).toBe(false)
    expect(blocks(renamed.project)?.map((b) => [b.name, b.parts])).toEqual([["3.3V POWER", ["U1", "C1"]]])

    const emptied = runTool(renamed.project, "edit_block", { block: "3.3V POWER", remove_refs: ["U1", "C1"] })
    expect(emptied.result).toContain("gone")
    expect(emptied.project.blocks).toBeUndefined()

    const ungrouped = runTool(p, "edit_block", { block: "POWER", ungroup: true })
    expect(ungrouped.project.blocks).toBeUndefined()
    expect(ungrouped.project.components).toEqual(p.components)
  })

  it("explains what it can't do instead of changing the design", () => {
    const p = runTool(board(), "group_parts", { block: "POWER", refs: ["U1"] }).project
    expect(runTool(p, "group_parts", { block: "MCU", refs: ["U1", "U9"] }).result).toBe("Error: No component U9")
    expect(runTool(p, "group_parts", { block: "  ", refs: ["U1"] }).isError).toBe(true)
    expect(runTool(p, "group_parts", { block: "MCU", refs: [] }).result).toContain("at least 1 items")
    expect(runTool(p, "edit_block", { block: "MCU", ungroup: true }).result).toBe("Error: No block MCU. Blocks: POWER")
    expect(runTool(p, "edit_block", { block: "POWER", remove_refs: ["C1"] }).result).toContain("C1 isn't in POWER")
    expect(runTool(p, "edit_block", { block: "POWER" }).isError).toBe(true)
  })

  it("drops a removed component from its block", () => {
    const p = runTool(board(), "group_parts", { block: "LED", refs: ["D1", "R1"] }).project
    const out = runTool(p, "remove_component", { ref: "D1" })
    expect(blocks(out.project)?.map((b) => b.parts)).toEqual([["R1"]])
  })
})
