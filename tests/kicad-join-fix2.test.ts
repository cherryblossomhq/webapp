import { describe, expect, it } from "vitest"
import { kicadFiles } from "../src/export/kicad"
import { flagVoice } from "../src/model/kicad/schematic/read"
import { importKicadProject, type KicadProjectResult } from "../src/model/kicad/project"
import { EXTENSION_NAMES as BOARD_EXTENSION_NAMES } from "../src/model/kicad/board"
import { joinFlags, setFlags } from "../src/model/partFlags"
import { board, footprint, pad } from "./kicad-board-fixtures"
import { ALL_LIBS } from "./kicad-sch-parts"
import { LIB_R, schematic } from "./kicad-schematic-fixtures"

// Fix round 1 of the join, B2 and m3: which of a part's flags the symbol is the authority for depends on the
// KiCad that wrote the file. pcbnew/netlist_reader/board_netlist_updater.cpp, per branch: 6.0 and 7.0 copy
// exclude_from_bom from the symbol to the footprint; 8.0 and 9.0 add dnp; 10.0 adds exclude_from_pos_files;
// the simulation flag only on master, after 10.0. A KiCad 9 symbol has no in_pos_files word at all.

const BUILT = new Set([...Object.keys(BOARD_EXTENSION_NAMES), "S2", "S5", "S6", "S10", "S7"])
const U1 = "11111111-0000-4000-8000-000000000001"

const imported = (r: KicadProjectResult) => {
  if (r.status !== "imported") throw new Error(`refused (${r.reason}): ${r.message}`)
  return r
}

/** One resistor: the symbol written in a file of `version` with the flag words that file has, and a footprint with `attr`. */
function oneResistor(version: number, symbolWords: string, attr: string) {
  const sch = schematic({ version, libs: [LIB_R], symbols: [{ lib: "Device:R", at: "50.8 50.8", ref: "R1", value: "10k", footprint: "Resistor_SMD:R_0603_1608Metric", uuid: U1, extra: symbolWords }] })
  const pcb = board({ nets: ['(net 0 "")'], body: [footprint({ ref: "R1", at: "10 5", pads: [pad({ number: "1", at: "-1 0" }), pad({ number: "2", at: "1 0" })], extra: `(path "/${U1}") (attr smd ${attr})` })] })
  const r = imported(importKicadProject([{ path: "demo.kicad_pcb", data: pcb }, { path: "demo.kicad_sch", data: sch }], { built: BUILT }))
  return { r, flags: r.project.components.find((c) => c.ref === "R1")?.flags, differ: r.report.entries.find((e) => e.code === "symbol-footprint-flags-differ") }
}

const ALL_THREE = "dnp exclude_from_bom exclude_from_pos_files"

describe("B2: the symbol wins only for the flags its file's KiCad copies", () => {
  it("KiCad 7: the BOM is the symbol's; do not populate and the position file stay the footprint's, with no difference said for them", () => {
    const { flags, differ } = oneResistor(20230121, "(dnp no)", ALL_THREE)
    expect(flags).toEqual({ mount: "smd", dnp: true, excludeFromPos: true })
    expect(differ?.why).toMatch(/R1 not in the BOM \(the symbol says no, the footprint yes\)\./)
    expect(differ?.why).not.toMatch(/do not populate|position file/)
  })

  it("KiCad 7: a symbol that says do not populate keeps it, since the footprint has no word for it there", () => {
    const { flags, differ } = oneResistor(20230121, "(dnp yes)", "")
    expect(flags).toEqual({ mount: "smd", dnp: true })
    expect(differ).toBeUndefined()
  })

  it("KiCad 8 and 9: the symbol wins for do not populate and the BOM; the position file stays the footprint's", () => {
    for (const version of [20231120, 20250114]) {
      const { flags, differ } = oneResistor(version, "(dnp no)", ALL_THREE)
      expect(flags, String(version)).toEqual({ mount: "smd", excludeFromPos: true })
      expect(differ?.why, String(version)).toMatch(/R1 do not populate \(the symbol says no, the footprint yes\), not in the BOM \(the symbol says no, the footprint yes\)\./)
      expect(differ?.why).not.toMatch(/position file/)
    }
  })

  it("the position-file flag of KiCad 6 to 9 projects survives (J2, J3, SW2 of a rotary encoder, TP1 to TP3, J1 to J4): no symbol word, so no difference", () => {
    for (const version of [20211123, 20230121, 20231120, 20250114]) {
      const { flags, differ } = oneResistor(version, version >= 20231120 ? "(dnp no)" : "", "exclude_from_pos_files")
      expect(flags, String(version)).toEqual({ mount: "smd", excludeFromPos: true })
      expect(differ, String(version)).toBeUndefined()
    }
  })

  it("KiCad 10: the symbol has in_pos_files and wins for all three", () => {
    const { flags, differ } = oneResistor(20250829, "(dnp no) (in_pos_files yes)", ALL_THREE)
    expect(flags).toEqual({ mount: "smd" })
    expect(differ?.why).toMatch(/do not populate.*not in the BOM.*not in the position file/)
    // a symbol that leaves itself out of the position files, over a footprint that is in them
    const out = oneResistor(20250829, "(dnp no) (in_pos_files no)", "")
    expect(out.flags).toEqual({ mount: "smd", excludeFromPos: true })
    expect(out.differ?.why).toMatch(/position file \(the symbol says yes, the footprint no\)/)
  })

  it("KiCad 10 with a symbol that lacks the word keeps the footprint's flag", () => {
    const { flags, differ } = oneResistor(20250829, "(dnp no)", "exclude_from_pos_files")
    expect(flags).toEqual({ mount: "smd", excludeFromPos: true })
    expect(differ).toBeUndefined()
  })

  it("the symbol's simulation flag is kept in every version", () => {
    const sim = oneResistor(20250114, "(dnp no) (exclude_from_sim yes)", "")
    expect(sim.flags).toEqual({ mount: "smd", excludeFromSim: true })
  })

  it("our own export imported back keeps the position-file flag, do not populate and the BOM", async () => {
    const first = oneResistor(20250114, "(dnp no)", "")
    const flagged = setFlags(first.r.project, first.r.project.components.find((c) => c.ref === "R1")!.id, { excludeFromPos: true, dnp: true, excludeFromBom: true })
    const { files } = await kicadFiles(flagged)
    const entries = Object.entries(files)
    // the whole export, the project file too: our own file is not refused for the keys our own converter writes
    const back = imported(importKicadProject([{ path: "back.kicad_pcb", data: entries.find(([k]) => k.endsWith(".kicad_pcb"))![1] }, { path: "back.kicad_sch", data: entries.find(([k]) => k.endsWith(".kicad_sch"))![1] }, { path: "back.kicad_pro", data: entries.find(([k]) => k.endsWith(".kicad_pro"))![1] }]))
    const r1 = back.project.components.find((c) => c.ref === "R1")!
    expect(r1.flags).toMatchObject({ excludeFromPos: true, dnp: true, excludeFromBom: true })
    expect(back.report.entries.some((e) => e.code === "symbol-footprint-flags-differ")).toBe(false)
  })

  it("joinFlags without a voice keeps the symbol as the authority for all three (the old rule), and flagVoice says what each file's KiCad copies", () => {
    expect(joinFlags({ dnp: true }, { excludeFromPos: true }).flags).toEqual({ dnp: true })
    const has = { inBom: true, dnp: true, inPosFiles: false }
    expect([...flagVoice({ stamp: 20230121, stated: has }).authority]).toEqual(["excludeFromBom"])
    expect([...flagVoice({ stamp: 20231120, stated: has }).authority].sort()).toEqual(["dnp", "excludeFromBom"])
    expect([...flagVoice({ stamp: 20250114, stated: has }).authority].sort()).toEqual(["dnp", "excludeFromBom"])
    expect([...flagVoice({ stamp: 20250829, stated: { ...has, inPosFiles: true } }).authority].sort()).toEqual(["dnp", "excludeFromBom", "excludeFromPos"])
    expect([...flagVoice({ stamp: 20250829, stated: { inBom: true, dnp: false, inPosFiles: false } }).authority]).toEqual(["excludeFromBom"])
  })
})

describe("m3: the footprint's flags are the part's, on every unit", () => {
  it("a part of three units, with a footprint that is smd, board only and has net ties, carries them on all three", () => {
    const uuids = ["aaaaaaaa-0000-4000-8000-0000000000a1", "aaaaaaaa-0000-4000-8000-0000000000a2", "aaaaaaaa-0000-4000-8000-0000000000a3"]
    const sch = schematic({
      version: 20250114,
      libs: ALL_LIBS,
      symbols: uuids.map((u, i) => ({ lib: "Test:OPA2", at: `100 ${100 + i * 40}`, ref: "U1", value: "OPA2", footprint: "Package_SO:SOIC-8", uuid: u, unit: i + 1, extra: "(dnp no)" })),
    })
    const pads = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => pad({ number: String(n), at: `${n} 0` }))
    const pcb = board({ nets: ['(net 0 "")'], body: [footprint({ ref: "U1", name: "Package_SO:SOIC-8", at: "10 5", pads, extra: `(path "/${uuids[0]}") (attr smd board_only dnp) (net_tie_pad_groups "1, 2")` })] })
    const r = imported(importKicadProject([{ path: "demo.kicad_pcb", data: pcb }, { path: "demo.kicad_sch", data: sch }], { built: BUILT }))
    const units = r.project.components.filter((c) => c.ref === "U1")
    expect(units).toHaveLength(3)
    for (const u of units) expect(u.flags, `unit ${u.unit ?? 1}`).toEqual({ mount: "smd", boardOnly: true, netTies: [["1", "2"]] })
    // one note for the part, not one per unit
    expect(r.report.entries.find((e) => e.code === "symbol-footprint-flags-differ")?.items).toEqual(["U1"])
  })
})
