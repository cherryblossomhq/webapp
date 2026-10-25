import { describe, expect, it } from "vitest"
import { runTool } from "../src/ai/tools"
import { EXAMPLES } from "../src/model/examples"
import { cleanFlags, flagWords, inBom, inPositionFile, joinFlags, kicadAttributes, onBoard, setFlags } from "../src/model/partFlags"
import { importSheet, place } from "./kicad-sch-parts"

// One set of part flags for a part's symbol and its footprint: the helpers, the rules and what sets them.

const blinker = () => EXAMPLES.find((e) => e.id === "blinker")!.project

describe("the one set of part flags", () => {
  it("keeps only what is set, for the symbol's keys and the footprint's alike, and drops what is not one of them", () => {
    expect(cleanFlags({ dnp: true, excludeFromBom: true, excludeFromPos: true, notOnBoard: true, excludeFromSim: true, boardOnly: true, virtual: true, mount: "smd", netTies: [["1", "2"]], inBom: false, onBoard: false, frob: true })).toEqual({
      dnp: true,
      excludeFromBom: true,
      excludeFromPos: true,
      notOnBoard: true,
      excludeFromSim: true,
      boardOnly: true,
      virtual: true,
      mount: "smd",
      netTies: [["1", "2"]],
    })
    expect(cleanFlags({ dnp: false, excludeFromBom: "yes" })).toBeUndefined()
  })

  it("the rules: do not populate and virtual leave the BOM and the position file, board only stays in the BOM, not on the board leaves the position file and the board", () => {
    const part = blinker().components.find((c) => c.ref === "R1")!
    const at = (flags: Parameters<typeof cleanFlags>[0]) => ({ partId: part.partId, flags: cleanFlags(flags) })
    expect([inBom(at({})), inPositionFile(at({})), onBoard(at({}))]).toEqual([true, true, true])
    expect([inBom(at({ dnp: true })), inPositionFile(at({ dnp: true }))]).toEqual([false, false])
    expect([inBom(at({ virtual: true })), inPositionFile(at({ virtual: true }))]).toEqual([false, false])
    expect([inBom(at({ boardOnly: true })), inPositionFile(at({ boardOnly: true }))]).toEqual([true, true])
    expect([inBom(at({ excludeFromBom: true })), inPositionFile(at({ excludeFromBom: true }))]).toEqual([false, true])
    expect([inBom(at({ excludeFromPos: true })), inPositionFile(at({ excludeFromPos: true }))]).toEqual([true, false])
    expect([inBom(at({ notOnBoard: true })), inPositionFile(at({ notOnBoard: true })), onBoard(at({ notOnBoard: true }))]).toEqual([true, false, false])
    // a part with no footprint is on no board whatever its flags say
    expect(onBoard({ partId: "no-such-part", flags: undefined })).toBe(false)
  })

  it("is said in words, and written as the footprint's attributes where it is a footprint's", () => {
    const flags = cleanFlags({ mount: "smd", dnp: true, notOnBoard: true, excludeFromSim: true, excludeFromPos: true })
    expect(flagWords(flags)).toEqual(["surface mount", "do not populate", "not in the position file", "not on the board", "left out of simulation"])
    // the symbol's own (not on the board, left out of simulation) are not attributes of a footprint
    expect(kicadAttributes(flags)).toEqual(["smd", "exclude_from_pos_files", "dnp"])
  })

  it("setFlags sets and clears, with no flags left when none is set", () => {
    const p = blinker()
    const id = p.components.find((c) => c.ref === "R1")!.id
    const flagged = setFlags(p, id, { dnp: true, excludeFromSim: true })
    expect(flagged.components.find((c) => c.id === id)?.flags).toEqual({ dnp: true, excludeFromSim: true })
    const cleared = setFlags(flagged, id, { dnp: false, excludeFromSim: false })
    expect(cleared.components.find((c) => c.id === id)).not.toHaveProperty("flags")
    expect(setFlags(p, "nobody", { dnp: true })).toBe(p)
  })

  it("every unit of a part carries its flags, the part's own and the symbols placed as its other units", () => {
    const p = importSheet({ symbols: [place("Test:OPA2", "100 100", "U1", { unit: 1 }), place("Test:OPA2", "100 140", "U1", { unit: 2 })] })
    expect(p.components).toHaveLength(2)
    const flagged = setFlags(p, p.components[1].id, { dnp: true })
    expect(flagged.components.map((c) => c.flags)).toEqual([{ dnp: true }, { dnp: true }])
    expect(setFlags(flagged, p.components[0].id, { dnp: false }).components.some((c) => c.flags)).toBe(false)
  })

  it("Sakura sets them with one set of inputs for symbol and footprint, and reads them as one list", () => {
    const p = blinker()
    const out = runTool(p, "update_component", { ref: "R1", dnp: true, board_only: true, in_pos_files: false })
    expect(out.isError).toBe(false)
    expect(out.project.components.find((c) => c.ref === "R1")?.flags).toEqual({ dnp: true, excludeFromPos: true, boardOnly: true })
    const design = JSON.parse(runTool(out.project, "get_design", {}).result) as { components: { ref: string; flags?: string[] }[] }
    expect(design.components.find((c) => c.ref === "R1")?.flags).toEqual(["do not populate", "not in the position file", "board only"])
    // a symbol that is no part on the board is not board only or virtual
    const sym = importSheet({ symbols: [place("Test:OPA2", "100 100", "U1", { unit: 1 })] })
    expect(runTool(sym, "update_component", { ref: "U1", virtual: true }).isError).toBe(true)
    expect(runTool(sym, "update_component", { ref: "U1", dnp: true }).isError).toBe(false)
  })

  it("joins a symbol's flags and a footprint's: the symbol's keys from the symbol, the footprint's from the footprint, and says where they differ", () => {
    const joined = joinFlags({ dnp: true, notOnBoard: true }, { mount: "through_hole", excludeFromPos: true, boardOnly: true, netTies: [["1", "2"]], jumperGroups: [["3", "4"]] })
    expect(joined.flags).toEqual({ dnp: true, notOnBoard: true, mount: "through_hole", boardOnly: true, netTies: [["1", "2"]], jumperGroups: [["3", "4"]] })
    expect(joined.differ).toEqual(["do not populate (the symbol says yes, the footprint no)", "not in the position file (the symbol says no, the footprint yes)"])
    expect(joinFlags({ dnp: true }, { dnp: true }).differ).toEqual([])
  })
})
