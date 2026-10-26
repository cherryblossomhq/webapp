import { describe, expect, it } from "vitest"
import { kicadFiles } from "../src/export/kicad"
import { isKicadBoardProject } from "../src/export/kicadBoard"
import { computeConnectivity } from "../src/model/connectivity"
import { pcbPads } from "../src/model/instances"
import { findPart } from "../src/model/library"
import { PROJECT_FILE_VERSION } from "../src/model/projectFile"
import type { Project } from "../src/model/types"
import { imp, S1, S2 } from "./kicad-sheets-fixtures"

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
  it("the project file is at version 11", () => {
    expect(PROJECT_FILE_VERSION).toBe(11)
  })
})
