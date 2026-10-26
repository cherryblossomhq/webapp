import { fp } from "@tscircuit/footprinter"
import { describe, expect, it } from "vitest"
import { rotate90 } from "../src/lib/geometry"
import { projectFromCircuitJson } from "../src/model/circuitJsonImport"
import { computeConnectivity, pinKey } from "../src/model/connectivity"
import { withPartsFrom } from "../src/model/customParts"
import { pcbPads } from "../src/model/instances"
import { findPart } from "../src/model/library"
import { createProject } from "../src/model/ops"
import { parseProjectFile, serializeProject } from "../src/model/projectFile"
import type { Rotation } from "../src/model/types"

// A small board as tscircuit builds it: a regulator with its own land pattern, a resistor and an
// LED with footprinter ones, one on the bottom and one turned, nets named and unnamed.

type El = Record<string, unknown> & { type: string }

interface PartIn {
  name: string
  ftype: string
  ports: string[]
  at: { x: number; y: number; rot?: Rotation; side?: "top" | "bottom" }
  sch: { x: number; y: number; symbol?: string }
  /** A footprinter string, drawn by the footprinter like tscircuit does. */
  footprint?: string
  /** Or pads of its own: [x, y, width, height] in the part's frame, numbered from 1. */
  pads?: [number, number, number, number][]
  props?: Record<string, unknown>
}

function board(parts: PartIn[], connections: string[][], extra: El[] = []): El[] {
  const out: El[] = [{ type: "pcb_board", center: { x: 0, y: 0 }, width: 30, height: 20, thickness: 1.6, num_layers: 2 }]
  const port = new Map<string, string>()
  for (const [i, part] of parts.entries()) {
    const sc = `sc${i}`
    const pc = `pc${i}`
    const rot = part.at.rot ?? 0
    const mirror = part.at.side === "bottom"
    out.push({ type: "source_component", source_component_id: sc, name: part.name, ftype: part.ftype, ...part.props })
    out.push({ type: "schematic_component", source_component_id: sc, center: { x: part.sch.x, y: part.sch.y }, symbol_name: part.sch.symbol })
    out.push({ type: "pcb_component", pcb_component_id: pc, source_component_id: sc, center: { x: part.at.x, y: part.at.y }, rotation: rot, layer: part.at.side ?? "top" })
    out.push({ type: "cad_component", pcb_component_id: pc, footprinter_string: part.footprint })
    part.ports.forEach((name, n) => {
      const id = `${part.name}.${name}`
      port.set(id, `sp_${id}`)
      out.push({ type: "source_port", source_port_id: `sp_${id}`, source_component_id: sc, name, pin_number: n + 1 })
      out.push({ type: "pcb_port", pcb_port_id: `pp_${id}`, source_port_id: `sp_${id}` })
      out.push({ type: "schematic_port", source_port_id: `sp_${id}`, center: { x: part.sch.x + (n % 2 ? 1 : -1), y: part.sch.y - n * 0.2 }, side_of_component: n % 2 ? "right" : "left" })
    })
    const pads: [number, number, number, number][] = part.pads ?? (fp.string(part.footprint!).circuitJson() as unknown as El[])
      .filter((e) => e.type === "pcb_smtpad")
      .sort((a, b) => Number((a.port_hints as string[])[0]) - Number((b.port_hints as string[])[0]))
      .map((e) => [e.x as number, e.y as number, e.width as number, e.height as number])
    pads.forEach(([x, y, w, h], n) => {
      const r = rotate90({ x: mirror ? -x : x, y }, rot)
      const turned = rot === 90 || rot === 270
      out.push({
        type: "pcb_smtpad",
        shape: "rect",
        pcb_component_id: pc,
        pcb_port_id: `pp_${part.name}.${part.ports[n]}`,
        layer: part.at.side ?? "top",
        x: part.at.x + r.x,
        y: part.at.y + r.y,
        width: turned ? h : w,
        height: turned ? w : h,
      })
    })
  }
  for (const [i, ids] of connections.entries()) {
    out.push({
      type: "source_trace",
      source_trace_id: `st${i}`,
      connected_source_port_ids: ids.filter((id) => !id.startsWith("net.")).map((id) => port.get(id)),
      connected_source_net_ids: ids.filter((id) => id.startsWith("net.")).map((id) => id.slice(4)),
    })
  }
  out.push({ type: "source_net", source_net_id: "GND", name: "GND" }, { type: "source_net", source_net_id: "V5", name: "V5" })
  return [...out, ...extra]
}

const parts: PartIn[] = [
  {
    name: "U1",
    ftype: "simple_chip",
    ports: ["VIN", "GND", "VOUT"],
    at: { x: -8, y: 2 },
    sch: { x: -2, y: 0 },
    pads: [
      [-1, 0.95, 1, 0.6],
      [-1, -0.95, 1, 0.6],
      [1.2, 0, 1.4, 2],
    ],
    props: { manufacturer_part_number: "XC6206P332MR", supplier_part_numbers: { jlcpcb: ["C5446"] } },
  },
  {
    name: "R1",
    ftype: "simple_resistor",
    ports: ["pin1", "pin2"],
    at: { x: 4, y: -3, rot: 90, side: "bottom" },
    sch: { x: 1, y: 0, symbol: "boxresistor_up" },
    footprint: "res0402",
    props: { display_resistance: "1kΩ" },
  },
  {
    name: "LED1",
    ftype: "simple_led",
    ports: ["anode", "cathode"],
    at: { x: 9, y: 4 },
    sch: { x: 3, y: 0, symbol: "led_right" },
    footprint: "0603",
    props: { color: "red" },
  },
]

const connections = [["U1.VIN", "net.V5"], ["U1.GND", "net.GND"], ["U1.VOUT", "R1.pin1"], ["R1.pin2", "LED1.anode"], ["LED1.cathode", "net.GND"]]

const extra: El[] = [
  { type: "pcb_trace", route: [
    { route_type: "wire", x: -6.8, y: 2, width: 0.3, layer: "top" },
    { route_type: "wire", x: 0, y: 2, width: 0.3, layer: "top" },
    { route_type: "via", x: 0, y: 2, from_layer: "top", to_layer: "bottom" },
    { route_type: "wire", x: 0, y: 2, width: 0.3, layer: "bottom" },
    { route_type: "wire", x: 4, y: 2, width: 0.3, layer: "bottom" },
    { route_type: "wire", x: 4, y: -2.5, width: 0.5, layer: "bottom" },
  ] },
  { type: "pcb_via", x: 0, y: 2, outer_diameter: 0.6, hole_diameter: 0.3 },
  { type: "pcb_copper_pour", layer: "bottom", source_net_id: "GND" },
  { type: "pcb_silkscreen_text", text: "REV A", anchor_position: { x: 10, y: -8 }, font_size: 1.2, layer: "top", ccw_rotation: 90 },
  { type: "pcb_silkscreen_text", text: "R1", anchor_position: { x: 4, y: -2 }, font_size: 0.4, layer: "bottom", pcb_component_id: "pc1" },
]

const imported = () => projectFromCircuitJson(board(parts, connections, extra), { name: "Blinky" })

describe("projectFromCircuitJson", () => {
  it("brings every part across: library parts where tscircuit's kind is one, the rest as the project's own", () => {
    const { project } = imported()
    const byRef = Object.fromEntries(project.components.map((c) => [c.ref, c]))
    expect(Object.keys(byRef)).toEqual(["U1", "R1", "LED1"])
    expect(byRef.R1).toMatchObject({ partId: "resistor", props: { resistance: "1k" }, footprint: "0402" })
    expect(byRef.LED1).toMatchObject({ partId: "led", props: { color: "red" }, footprint: "0603" })
    expect(byRef.R1.sch.rot).toBe(90)

    const u1 = findPart(byRef.U1.partId)!
    expect(u1).toMatchObject({ name: "XC6206P332MR", custom: true, refPrefix: "U" })
    expect(u1.pins.map((p) => [p.number, p.name])).toEqual([["1", "VIN"], ["2", "GND"], ["3", "VOUT"]])
    expect(byRef.U1.props).toEqual({ mpn: "XC6206P332MR", lcsc: "C5446" })
    // Its land is the board's own, carried in the project.
    expect(project.footprints?.map((f) => f.name)).toEqual([byRef.U1.footprint])
  })

  it("puts every pad exactly where it was, on whichever side and however turned", () => {
    const elements = board(parts, connections)
    const { project } = projectFromCircuitJson(elements, { name: "Blinky" })
    const before = elements.filter((e) => e.type === "pcb_smtpad").map((e) => `${(e.x as number).toFixed(3)},${(e.y as number).toFixed(3)} ${e.width}x${e.height}`)
    const after = project.components.flatMap((c) => pcbPads(c)).map((p) => `${p.x.toFixed(3)},${p.y.toFixed(3)} ${p.width}x${p.height}`)
    expect(after.sort()).toEqual(before.sort())
    const r1 = project.components.find((c) => c.ref === "R1")!
    expect(r1.pcb).toEqual({ x: 4, y: -3, rot: 90, side: "bottom", placed: true })
  })

  it("draws the netlist as labelled pins that connect exactly as the board did", () => {
    const { project } = imported()
    const { nets, pinNet } = computeConnectivity(project)
    const ref = (r: string) => project.components.find((c) => c.ref === r)!.id
    const net = (r: string, pin: string) => nets.find((n) => n.id === pinNet.get(pinKey(ref(r), pin)))?.name
    expect(net("U1", "1")).toBe("V5")
    expect(net("U1", "2")).toBe("GND")
    expect(net("LED1", "2")).toBe("GND")
    // Unnamed in tscircuit, named after the regulator's pin.
    expect(net("U1", "3")).toBe("U1_VOUT")
    expect(net("R1", "1")).toBe("U1_VOUT")
    expect(net("R1", "2")).toBe("LED1_anode")
    expect(net("LED1", "1")).toBe("LED1_anode")
    expect(nets.map((n) => n.name).sort()).toEqual(["GND", "LED1_anode", "U1_VOUT", "V5"])
  })

  it("makes tscircuit's named groups the schematic's blocks", () => {
    expect(imported().project.blocks).toBeUndefined()
    const grouped = parts.map((p, i) => ({ ...p, props: { ...p.props, source_group_id: ["g_power", "g_led", "g_inner"][i] } }))
    const groups: El[] = [
      // The board is a group too, and isn't a block even when it has a name.
      { type: "source_group", source_group_id: "g_board", name: "Blinky", is_subcircuit: true },
      { type: "source_group", source_group_id: "g_power", name: "POWER", parent_source_group_id: "g_board" },
      { type: "source_group", source_group_id: "g_led", name: "LED_BLK", parent_source_group_id: "g_board" },
      // A group tscircuit named itself belongs to the named one above it.
      { type: "source_group", source_group_id: "g_inner", name: "unnamed_group1", parent_source_group_id: "g_led", was_automatically_named: true },
    ]
    const { project } = projectFromCircuitJson(board(grouped, connections, groups), { name: "Blinky" })
    const refs = (ids: string[]) => ids.map((id) => project.components.find((c) => c.id === id)?.ref)
    expect(project.blocks?.map((b) => [b.name, refs(b.components)])).toEqual([
      ["POWER", ["U1"]],
      ["LED_BLK", ["R1", "LED1"]],
    ])
  })

  it("keeps two-layer copper, outer pours and free silkscreen text", () => {
    const { project, notes } = imported()
    expect(project.traces.map((t) => [t.layer, t.width, t.points.length])).toEqual([
      ["top", 0.3, 2],
      ["bottom", 0.3, 2],
      ["bottom", 0.5, 2],
    ])
    expect(project.vias).toMatchObject([{ x: 0, y: 2, diameter: 0.6, drill: 0.3 }])
    expect(project.zones).toMatchObject([{ net: "GND", layer: "bottom" }])
    expect(project.texts).toMatchObject([{ text: "REV A", x: 10, y: -8, size: 1.2, rot: 90, side: "top" }])
    expect(project.board).toMatchObject({ width: 30, height: 20, x: 0, y: 0, thickness: 1.6 })
    expect(notes).toEqual([])
  })

  it("keeps a board of four layers as one, with its copper on every layer", () => {
    const four = board(parts, connections, extra).map((e) => (e.type === "pcb_board" ? { ...e, num_layers: 4 } : e))
    const { project, notes } = projectFromCircuitJson(four, { name: "Blinky" })
    expect(project.board.stack?.copper.length).toBe(4)
    expect(project.traces.map((t) => t.layer).every((l) => ["top", "in1", "in2", "bottom"].includes(l))).toBe(true)
    expect(notes).toEqual([])
  })

  it("leaves copper behind, and says so, on a board of more layers than the editor has", () => {
    const elements = board(parts, connections, extra).map((e) => (e.type === "pcb_board" ? { ...e, num_layers: 40 } : e))
    const { project, notes } = projectFromCircuitJson(elements, { name: "Blinky" })
    expect(project.traces).toEqual([])
    expect(project.vias).toEqual([])
    expect(notes).toEqual([expect.stringContaining("has 40 copper layers")])
  })

  it("takes a turned part's slots and courtyard back into its frame, and pads tied to a port by name", () => {
    const j1: PartIn = { name: "J1", ftype: "simple_connector", ports: ["A", "B"], at: { x: 0, y: -6, rot: 90 }, sch: { x: 0, y: 0 }, pads: [[-1, 0, 1, 0.6], [1, 0, 1, 0.6]] }
    // As tscircuit writes them: sized as drawn, with the part's turn in `ccw_rotation`.
    const { project } = projectFromCircuitJson(
      board([j1], [], [
        { type: "pcb_plated_hole", shape: "pill", pcb_component_id: "pc0", port_hints: ["B"], x: 0, y: -4, outer_width: 1.1, outer_height: 2, hole_width: 0.6, hole_height: 1.5, ccw_rotation: 90 },
        { type: "pcb_courtyard_rect", pcb_component_id: "pc0", center: { x: 0, y: -6 }, width: 6, height: 2, ccw_rotation: 90 },
      ]),
      { name: "Connector" },
    )
    const [land] = project.footprints!
    expect(land.courtyard).toEqual({ minX: -3, minY: -1, maxX: 3, maxY: 1 })
    expect(land.pads.find((p) => p.layer === "through")).toMatchObject({ pin: "2", shape: "pill", x: 2, y: 0, width: 1.1, height: 2, holeDiameter: 0.6, slotLength: 1.5 })
  })

  it("writes a file that reads back whole, its own land patterns included", () => {
    const { project } = imported()
    const back = parseProjectFile(serializeProject(project), { id: "p" })
    expect(back.footprints).toEqual(project.footprints)
    expect(back.parts).toEqual(project.parts)
    const u1 = back.components.find((c) => c.ref === "U1")!
    expect(pcbPads(u1).map((p) => p.pin)).toEqual(["1", "2", "3"])
  })
})

describe("a project's own land patterns", () => {
  it("are dropped whole when a pad is malformed, rather than drawn without it", () => {
    const { project } = imported()
    const [land] = project.footprints!
    const broken = { ...land, name: "broken-000000", pads: [...land.pads, { pin: "4", shape: "rect", x: "1" }] }
    const back = parseProjectFile(serializeProject({ ...project, footprints: [land, broken as never] }), { id: "p" })
    expect(back.footprints?.map((f) => f.name)).toEqual([land.name])
  })

  it("go with a pasted part into another project", () => {
    const { project } = imported()
    const u1 = project.components.find((c) => c.ref === "U1")!
    const target = withPartsFrom(createProject("other"), project, [u1.partId], [u1.footprint])
    expect(target.parts?.map((s) => s.id)).toEqual([u1.partId])
    expect(target.footprints?.map((f) => f.name)).toEqual([u1.footprint])
  })
})
