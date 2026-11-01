import { describe, expect, it } from "vitest"
import { kicadFiles } from "../src/export/kicad"
import { isKicadBoardProject } from "../src/export/kicadBoard"
import { importKicadBoard } from "../src/model/kicad/board"
import { setCopperLayerCount } from "../src/model/layerOps"
import { addTrace } from "../src/model/ops"
import { copperLayers } from "../src/model/stack"
import { computeConnectivity } from "../src/model/connectivity"
import { pcbPads } from "../src/model/instances"
import { findPart } from "../src/model/library"
import { PROJECT_FILE_VERSION } from "../src/model/projectFile"
import type { Project } from "../src/model/types"
import { imp, S1, S2 } from "./kicad-sheets-fixtures"
import { bus, entry, label, load, pinsOn, resistor, sheetSymbol } from "./kicad-sch-s3-fixtures"
import { LIB_R, ROOT_UUID, schematic } from "./kicad-schematic-fixtures"

// The join of the board writer (X16) and multi-sheet schematics (S1): a board of a project with sheets names its nets as the sheets do.
const uses = [{ uuid: S1, name: "Power", y: 60.96 }, { uuid: S2, name: "Other", y: 80 }]
/** The hierarchical schematic of the fixtures, with a land on every part and, if asked, a board outline (what makes it a board import). */
const hierarchical = (withBoard: boolean): Project => {
  const p = imp(uses).project
  // The fixtures' symbols name no footprint: give the part a land so the board has pads.
  for (const c of p.components) { const part = findPart(c.partId); if (part) part.footprints = ["0603"] }
  return { ...p, components: p.components.map((c) => ({ ...c, footprint: "0603", pcb: { ...c.pcb, placed: true } })), board: withBoard ? { ...p.board, outline: { paths: [] } } : p.board } as Project
}

describe("the board writer and the sheets", () => {
  it("a board from a project with sheets: each pad's net is the sheet-path net the connectivity names", async () => {
    const p = hierarchical(true)
    expect(isKicadBoardProject(p)).toBe(true)
    const conn = computeConnectivity(p)
    const expected = new Map<string, string>()
    for (const c of p.components) for (const pad of pcbPads(c)) {
      const net = conn.nets.find((n) => n.pins.some((x) => x.componentId === c.id && x.pin === pad.pin))
      if (net) expected.set(`${c.ref}:${pad.padNumber}`, net.name)
    }
    expect(new Set(expected.values())).toEqual(new Set(["/Power/VIN", "/Other/VIN"]))
    const pcb = Object.entries((await kicadFiles(p)).files).find(([k]) => k.endsWith(".kicad_pcb"))![1]
    const found = new Map<string, string>()
    for (const fp of pcb.split(/\n\s*\(footprint /).slice(1)) {
      const ref = /\(property "Reference" "([^"]+)"/.exec(fp)![1]
      for (const pd of fp.split(/\n\s*\(pad /).slice(1)) {
        const net = /\(net (?:\d+ )?"([^"]*)"\)/.exec(pd)
        if (net?.[1]) found.set(`${ref}:${/^"([^"]*)"/.exec(pd)![1]}`, net[1])
      }
    }
    expect(found.size).toBe(expected.size)
    expect(Object.fromEntries(found)).toEqual(Object.fromEntries(expected))
  })
  it("the gate keeps a hierarchical schematic import on the converter's path", () => {
    expect(isKicadBoardProject(hierarchical(false))).toBe(false)
  })
  it("a four-layer board of a project with sheets keeps its inner copper and its sheet nets through the file", async () => {
    let p = setCopperLayerCount(hierarchical(true), 4).project
    p = addTrace(p, { layer: "in1", width: 0.2, points: [{ x: 0, y: 0 }, { x: 5, y: 0 }] }).project
    p = addTrace(p, { layer: "in2", width: 0.2, points: [{ x: 0, y: 2 }, { x: 5, y: 2 }] }).project
    const pcb = Object.entries((await kicadFiles(p)).files).find(([k]) => k.endsWith(".kicad_pcb"))![1]
    expect(pcb).toMatch(/\(layers[^]*"In1\.Cu"[^]*"In2\.Cu"/)
    expect(pcb).toMatch(/\(segment[^]*?\(layer "In1\.Cu"\)/)
    expect(pcb).toMatch(/\(segment[^]*?\(layer "In2\.Cu"\)/)
    const again = importKicadBoard(pcb)
    if (again.status !== "imported") throw new Error(again.message)
    expect(copperLayers(again.project.board)).toEqual(["top", "in1", "in2", "bottom"])
    expect(again.project.traces.map((t) => t.layer).sort()).toEqual(["in1", "in2"])
    expect(pcb).toContain('"/Power/VIN"')
    expect(pcb).toContain('"/Other/VIN"')
  })
  it("the project file is at version 5 (the whole KiCad import is the one step from 2 to 3)", () => {
    expect(PROJECT_FILE_VERSION).toBe(5)
  })
})

// The join of the flatten fix (a net of a sheet used twice is the use's own) and buses (S3): the members of a local bus are the use's own too.
describe("a sheet used twice with a local bus and a local net", () => {
  const A1 = "00000000-0000-4000-8000-0000000000a1"
  const A2 = "00000000-0000-4000-8000-0000000000a2"
  const files = () => {
    const root = schematic({
      libs: [LIB_R],
      symbols: [resistor("R1", 50.8, 50.8, "aaaaaaaa-0000-4000-8000-000000000001")],
      wires: ["50.8 46.99 50.8 40.64"],
      body: [label("D3", 50.8, 40.64), sheetSymbol(A1, "Sub1", "child.kicad_sch", 100, []), sheetSymbol(A2, "Sub2", "child.kicad_sch", 140, [])],
    })
    const child = schematic({
      uuid: "00000000-0000-4000-8000-0000000000c1",
      libs: [LIB_R],
      symbols: [resistor("R9", 50.8, 50.8, "bbbbbbbb-0000-4000-8000-000000000001", [`/${ROOT_UUID}/${A1}|R2`, `/${ROOT_UUID}/${A2}|R3`])],
      wires: ["50.8 46.99 50.8 40.64"],
      body: [bus(40.64, 38.1, 63.5, 38.1), label("D[0..7]", 43.18, 38.1), entry(50.8, 40.64, 2.54, -2.54), label("D3", 50.8, 40.64)],
    })
    return new Map([["root.kicad_sch", root], ["child.kicad_sch", child]])
  }

  it("keeps /D3, /Sub1/D3 and /Sub2/D3 as three separate nets, each with its own part", () => {
    const { project } = load(files())
    const nets = computeConnectivity(project).nets
    expect(nets.map((n) => n.name).sort()).toEqual(["/D3", "/Sub1/D3", "/Sub2/D3"])
    expect(pinsOn(project, nets.find((n) => n.name === "/D3")!)).toEqual(["R1.1"])
    expect(pinsOn(project, nets.find((n) => n.name === "/Sub1/D3")!)).toEqual(["R2.1"])
    expect(pinsOn(project, nets.find((n) => n.name === "/Sub2/D3")!)).toEqual(["R3.1"])
  })

  it("is still three nets when the project is flattened for Circuit JSON", async () => {
    const { project } = load(files())
    const { projectToCircuitJson } = await import("../src/export/circuitJson")
    const names = projectToCircuitJson(project).elements.filter((e) => e.type === "source_net").map((e) => (e as unknown as { name: string }).name)
    expect(names.filter((n) => /D3$/.test(n))).toHaveLength(3)
    expect(new Set(names).size).toBe(names.length)
  })
})
