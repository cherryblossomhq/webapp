import { describe, expect, it } from "vitest"
import { runTool } from "../src/ai/tools"
import { copperOn } from "../src/model/boardCopper"
import { computeConnectivity, pinKey } from "../src/model/connectivity"
import { EXAMPLES } from "../src/model/examples"
import { importKicadSchematic } from "../src/model/kicad/schematic"
import { drawingBounds } from "../src/model/drawings"
import { onBoard, setFlags } from "../src/model/partFlags"
import { renameReference, rekeyAutoNets } from "../src/model/schematicEdit"
import { boxTextAt } from "../src/model/sheetItems"
import type { Project, Zone } from "../src/model/types"
import { LIB_R, schematic } from "./kicad-schematic-fixtures"

// Fix round 1 of slice 3b-ii: turned boxes, connect by a made-up name, parts off the board, board data keyed by auto names.

const MM = 12.7
const uuid = (n: number) => `aaaaaaaa-0000-4000-8000-00000000000${n}`

const imp = (text: string): Project => {
  const r = importKicadSchematic(text)
  if (r.status !== "imported") throw new Error(`refused: ${r.message}`)
  return r.project
}

const refId = (p: Project, ref: string) => p.components.find((c) => c.ref === ref)!.id
const netOfPin = (p: Project, ref: string, pin: string) => {
  const conn = computeConnectivity(p)
  const id = conn.pinNet.get(pinKey(refId(p, ref), pin))
  return conn.nets.find((n) => n.id === id)
}
const blinker = () => EXAMPLES.find((e) => e.id === "blinker")!.project

describe("B1: a text box and a table cell are never turned, only their text", () => {
  const text = schematic({
    version: 20250114,
    body: [
      `(text_box "Turned" (exclude_from_sim no) (at 50.8 50.8 90) (size 20.32 10.16) (margins 0.9525 0.9525 0.9525 0.9525) (stroke (width 0.254) (type default)) (fill (type none)) (effects (font (size 1.27 1.27)) (justify left top)) (uuid tb1))`,
      `(table (column_count 1) (border (external no) (header no)) (separators (rows no) (cols no)) (column_widths 10.16) (row_heights 5.08)
        (cells
          (table_cell "A" (exclude_from_sim no) (at 127 127 90) (size 10.16 5.08) (margins 0.9525 0.9525 0.9525 0.9525) (span 1 1) (fill (type none)) (effects (font (size 1.27 1.27)) (justify left top)) (uuid tc1))))`,
    ],
  })
  const project = imp(text)
  const box = project.drawings!.find((i) => i.type === "textbox")!
  const table = project.drawings!.find((i) => i.type === "table")!

  it("draws the box from at to at + size, whatever the angle", () => {
    if (box.type !== "textbox") throw new Error("no box")
    expect(box.rot).toBe(90)
    const b = drawingBounds(box)
    expect(b.minX).toBeCloseTo(box.x, 6)
    expect(b.maxX).toBeCloseTo(box.x + box.w, 6)
    expect(b.maxY).toBeCloseTo(box.y, 6)
    expect(b.minY).toBeCloseTo(box.y - box.h, 6)
    // in KiCad's own numbers: x 50.8 to 71.12, y 50.8 to 60.96 (y down)
    expect((b.maxX - b.minX) * MM).toBeCloseTo(20.32, 3)
    expect((b.maxY - b.minY) * MM).toBeCloseTo(10.16, 3)
  })

  // KiCad's SCH_TEXTBOX::GetDrawPos, in the file's own frame (mm, y down): a 20.32 x 10.16 box at (50.8, 50.8), margins 0.9525.
  // Vertical text: the horizontal justification sets y (left: bottom - margin, right: top + margin) and the vertical one sets x
  // (top: left + margin, bottom: right - margin).
  const anchorOf = (angle: number, justify: string) => {
    const p = imp(
      schematic({
        version: 20250114,
        body: [`(text_box "T" (exclude_from_sim no) (at 50.8 50.8 ${angle}) (size 20.32 10.16) (margins 0.9525 0.9525 0.9525 0.9525) (stroke (width 0.254) (type default)) (fill (type none)) (effects (font (size 1.27 1.27)) (justify ${justify})) (uuid tb2))`],
      }),
    )
    const b = p.drawings!.find((i) => i.type === "textbox")!
    if (b.type !== "textbox") throw new Error("no box")
    const at = boxTextAt(b, b.margins, b.look)
    return { x: at.x * MM, y: -at.y * MM }
  }
  it.each([
    [90, "left top", 51.7525, 60.0075],
    [90, "left bottom", 70.1675, 60.0075],
    [90, "right bottom", 70.1675, 51.7525],
    [90, "right top", 51.7525, 51.7525],
    [270, "left top", 51.7525, 60.0075],
    [0, "left top", 51.7525, 51.7525],
    [0, "right bottom", 70.1675, 60.0075],
  ])("anchors the text of a box at %i, justify %s, where KiCad does", (angle, justify, x, y) => {
    const at = anchorOf(angle, justify)
    expect(at.x).toBeCloseTo(x, 3)
    expect(at.y).toBeCloseTo(y, 3)
  })

  it("a table cell at 90 is the rectangle from at to at + size too", () => {
    if (table.type !== "table") throw new Error("no table")
    const b = drawingBounds(table)
    const c = table.cells[0]
    expect(c.rot).toBe(90)
    expect(b.minX).toBeCloseTo(c.x, 6)
    expect(b.maxX).toBeCloseTo(c.x + c.w, 6)
    expect(b.maxY).toBeCloseTo(c.y, 6)
    expect(b.minY).toBeCloseTo(c.y - c.h, 6)
  })
})

describe("B2: connect with a name nothing gave joins the real net", () => {
  const chain = () =>
    imp(
      schematic({
        version: 20250114,
        libs: [LIB_R],
        symbols: [
          { lib: "Device:R", at: "50.8 50.8", ref: "R1", value: "1k", uuid: uuid(1) },
          { lib: "Device:R", at: "76.2 50.8", ref: "R2", value: "1k", uuid: uuid(2) },
          { lib: "Device:R", at: "101.6 50.8", ref: "R3", value: "1k", uuid: uuid(3) },
        ],
        wires: ["76.2 54.61 101.6 54.61"],
      }),
    )

  it("on an imported design a pin joins the net a made-up name belongs to", () => {
    const p = chain()
    const target = netOfPin(p, "R2", "2")!
    expect(target.name).toMatch(/^Net-\(/)
    expect(target.pins.length).toBe(2)
    const out = runTool(p, "connect", { pins: ["R1.1"], net_name: target.name })
    expect(out.isError, out.result).toBeFalsy()
    expect(out.result).toContain("made up")
    const conn = computeConnectivity(out.project)
    expect(conn.pinNet.get(pinKey(refId(out.project, "R1"), "1"))).toBe(conn.pinNet.get(pinKey(refId(out.project, "R2"), "2")))
    const ids = conn.nets.map((n) => n.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(conn.nets.some((n) => n.pins.length === 1 && n.pins[0].pin === "1" && n.pins[0].componentId === refId(out.project, "R1"))).toBe(false)
  })

  it("a pin already on that net is said to be there", () => {
    const p = chain()
    const target = netOfPin(p, "R2", "2")!
    const out = runTool(p, "connect", { pins: ["R2.2", "R3.2"], net_name: target.name })
    expect(out.isError).toBeFalsy()
    expect(out.project).toBe(p)
  })

  it("the editor auto names do the same on an example", () => {
    let tried = 0
    let joined = 0
    for (const ex of EXAMPLES) {
      const p = ex.project
      const conn = computeConnectivity(p)
      const target = conn.nets.find((n) => !n.named && /^Net-\(/.test(n.name) && n.pins.length >= 2)
      const loose = conn.nets.find((n) => n.id !== target?.id && !n.named && /^Net-\(/.test(n.name))
      if (!target || !loose) continue
      tried++
      const ref = p.components.find((c) => c.id === loose.pins[0].componentId)!.ref
      const out = runTool(p, "connect", { pins: [`${ref}.${loose.pins[0].pin}`], net_name: target.name })
      if (out.isError) continue
      const after = computeConnectivity(out.project)
      const ids = after.nets.map((n) => n.id)
      expect(new Set(ids).size, ex.id).toBe(ids.length)
      expect(after.pinNet.get(pinKey(loose.pins[0].componentId, loose.pins[0].pin)), ex.id).toBe(after.pinNet.get(pinKey(target.pins[0].componentId, target.pins[0].pin)))
      joined++
    }
    expect(tried).toBeGreaterThan(0)
    expect(joined).toBeGreaterThan(0)
  })
})

describe("B3 and B4: a part off the board", () => {
  const off = () => runTool(blinker(), "update_component", { ref: "R1", on_board: false })

  it("place_parts refuses it, and get_design leaves its pcb out", () => {
    const p = off().project
    expect(onBoard(p.components.find((c) => c.ref === "R1")!)).toBe(false)
    const out = runTool(p, "place_parts", { placements: [{ ref: "R1", dx: 1 }] })
    expect(out.isError).toBe(true)
    expect(out.result).toContain("R1 is not on the board (on_board false)")
    const design = JSON.parse(runTool(p, "get_design", {}).result)
    const r1 = design.components.find((c: { ref: string }) => c.ref === "R1")
    expect(r1.pcb).toBeUndefined()
    expect(design.components.find((c: { ref: string; pcb?: unknown }) => c.ref !== "R1" && c.pcb)).toBeTruthy()
  })

  it("layout_pcb and route_pcb say no part is on the board when every footprinted part is off it", () => {
    let p = blinker()
    for (const c of p.components) if (c.footprint) p = setFlags(p, c.id, { notOnBoard: true })
    for (const name of ["layout_pcb", "route_pcb"]) {
      const out = runTool(p, name, {})
      expect(out.isError, name).toBe(true)
      expect(out.result, name).toContain("No part is on the board")
    }
  })

  it("taking a routed part off the board removes its unlocked traces and vias, and says so", () => {
    const p = blinker()
    const r1 = p.components.find((c) => c.ref === "R1")!
    const before = copperOn(p, [r1])
    expect(before.traces.length).toBeGreaterThan(0)
    const out = off()
    expect(out.isError).toBeFalsy()
    expect(out.result).toMatch(/trace/)
    const now = out.project.components.find((c) => c.ref === "R1")!
    expect(copperOn(out.project, [now]).traces.filter((t) => !t.locked)).toEqual([])
    expect(out.project.traces.length).toBeLessThan(p.traces.length)
    const back = runTool(out.project, "update_component", { ref: "R1", on_board: true })
    expect(back.project.traces.length).toBe(out.project.traces.length)
  })

  it("the model does the same through setFlags", () => {
    const p = blinker()
    const id = p.components.find((c) => c.ref === "R1")!.id
    expect(setFlags(p, id, { notOnBoard: true }).traces.length).toBeLessThan(p.traces.length)
    expect(setFlags(p, id, { dnp: true }).traces.length).toBe(p.traces.length)
  })
})

describe("M3: board data keyed by an auto name follows a rename", () => {
  const withBoardData = (p: Project, name: string): Project => ({
    ...p,
    zones: [...p.zones, { id: "z-test", net: name, layer: "top" } as Zone],
    vias: [...p.vias, { id: "v-test", x: 1, y: 1, diameter: 0.6, drill: 0.3, net: name }],
    rules: { ...p.rules, netWidths: { ...p.rules.netWidths, [name]: 0.5 } },
  })

  const check = (p: Project, ref: string, fresh: string) => {
    const target = computeConnectivity(p).nets.find((n) => !n.named && n.name.startsWith(`Net-(${ref}-`))
    if (!target) throw new Error(`no auto net on ${ref}`)
    const keyed = withBoardData(p, target.name)
    const id = p.components.find((c) => c.ref === ref)!.id
    const next = renameReference(keyed, id, fresh)
    const now = computeConnectivity(next).nets.find((n) => n.pins.some((q) => target.pins.some((t) => t.componentId === q.componentId && t.pin === q.pin)))!
    expect(now.name).not.toBe(target.name)
    expect(next.zones.find((z) => z.id === "z-test")!.net).toBe(now.name)
    expect(next.vias.find((v) => v.id === "v-test")!.net).toBe(now.name)
    expect(next.rules.netWidths![now.name]).toBe(0.5)
    expect(next.rules.netWidths![target.name]).toBeUndefined()
  }

  it("on an editor design with auto names", () => {
    for (const ex of EXAMPLES) {
      const refs = [...new Set(computeConnectivity(ex.project).nets.filter((n) => !n.named && n.name.startsWith("Net-(")).map((n) => /^Net-\(([^-]+)-/.exec(n.name)![1]))]
      const ref = refs.find((r) => !r.startsWith("#"))
      if (!ref) continue
      check(ex.project, ref, `${ref}99`)
      return
    }
    throw new Error("no example has an auto net")
  })

  it("on an imported design, whose names are KiCad's", () => {
    const p = imp(
      schematic({
        version: 20250114,
        libs: [LIB_R],
        symbols: [
          { lib: "Device:R", at: "76.2 50.8", ref: "R2", value: "1k", uuid: uuid(2) },
          { lib: "Device:R", at: "101.6 50.8", ref: "R3", value: "1k", uuid: uuid(3) },
        ],
        wires: ["76.2 54.61 101.6 54.61"],
      }),
    )
    check(p, "R2", "R9")
  })

  it("a design with no board data is returned as it is", () => {
    const p = blinker()
    expect(rekeyAutoNets(p, p)).toBe(p)
  })
})
