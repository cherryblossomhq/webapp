import { describe, expect, it } from "vitest"
import { BusTooLarge, MAX_BUS_MEMBERS, differsBetweenGenerations, isBusName, parseBusGroup, parseBusName, parseBusVector } from "../src/model/busNames"
import { memberPairs } from "../src/model/busConnectivity"
import { computeConnectivity } from "../src/model/connectivity"
import { createProject } from "../src/model/ops"
import type { Project } from "../src/model/types"

// S3: bus names as KiCad reads them (`ParseBusVector`, `ParseBusGroup`, `ConfigureFromLabel`). KiCad 6, 7, 8 and 9 read one grammar (the functions are
// identical in 6.0.11, 7.0.11, 8.0.9 and 9.0.6); KiCad 10 reads more.

const names = (t: string, aliases?: Record<string, string[]>, gen: "kicad9" | "kicad10" = "kicad9") => parseBusName(t, aliases ? (n) => aliases[n] : undefined, gen)?.names

describe("vectors", () => {
  it("is PREFIX[a..b], in either order, its members the numbers from the low end to the high", () => {
    expect(names("D[0..3]")).toEqual(["D0", "D1", "D2", "D3"])
    expect(names("D[3..0]")).toEqual(["D0", "D1", "D2", "D3"])
    expect(names("IRQ-[1..3]")).toEqual(["IRQ-1", "IRQ-2", "IRQ-3"])
    expect(names("[0..1]")).toEqual(["0", "1"])
  })

  it("is no vector with one member, a space, a stray bracket or a letter in the range", () => {
    for (const t of ["D[3..3]", "D [0..3]", "D]0..3]", "D[a..3]", "D[0..b]", "D[0-3]", "D[0..3", "D[]", "D"]) expect(isBusName(t, "kicad9"), t).toBe(false)
  })

  it("reads text markup as markup: V_{IO} and ~{RESET} are nets, and ~{BE[0..3]} is a vector inside an overbar", () => {
    expect(names("V_{IO}")).toBeUndefined()
    expect(names("~{RESET}")).toBeUndefined()
    expect(names("I^{2}C[0..1]")).toEqual(["I^{2}C0", "I^{2}C1"])
  })

  it("KiCad 9 reads a missing closing bracket as a range from 0 (the end is only set at a bracket), which KiCad 10 does not", () => {
    expect(names("D[1..5")).toEqual(["D0", "D1"])
    expect(names("D[1..5", undefined, "kicad10")).toBeUndefined()
    expect(differsBetweenGenerations("D[1..5")).toBe(true)
  })

  it("KiCad 10 reads a zero-padded range, a suffix after it and an escaped space; KiCad 9 reads none of them", () => {
    expect(names("D[00..03]", undefined, "kicad10")).toEqual(["D00", "D01", "D02", "D03"])
    expect(names("D[00..03]")).toEqual(["D0", "D1", "D2", "D3"])
    expect(names("A[0..1]P", undefined, "kicad10")).toEqual(["A0P", "A1P"])
    expect(names("A[0..1]P")).toBeUndefined()
    expect(differsBetweenGenerations("D[00..03]")).toBe(true)
    expect(differsBetweenGenerations("A[0..1]P")).toBe(true)
    expect(differsBetweenGenerations("D[0..7]")).toBe(false)
    expect(differsBetweenGenerations("{A B}")).toBe(false)
  })
})

describe("groups", () => {
  it("takes its members at spaces or commas, with a prefix and a dot when it has one", () => {
    expect(names("{SIG1 SIG2}")).toEqual(["SIG1", "SIG2"])
    expect(names("{SCLK,MOSI,CS}")).toEqual(["SCLK", "MOSI", "CS"])
    expect(names("USB{DP DM}")).toEqual(["USB.DP", "USB.DM"])
    expect(names("SPI{SCK, MOSI, MISO}")).toEqual(["SPI.SCK", "SPI.MOSI", "SPI.MISO"])
  })

  it("expands a vector inside a group, behind the group's prefix, and an alias by name", () => {
    expect(names("ANALOG{A[0..2]}")).toEqual(["ANALOG.A0", "ANALOG.A1", "ANALOG.A2"])
    expect(names("DIG{D5 D6 D[9..10]}")).toEqual(["DIG.D5", "DIG.D6", "DIG.D9", "DIG.D10"])
    expect(names("P{USB}", { USB: ["DP", "DM"] })).toEqual(["P.DP", "P.DM"])
    expect(names("{USB CLK}", { USB: ["DP", "DM"] })).toEqual(["DP", "DM", "CLK"])
    // a bare alias name is a net's, not a bus
    expect(names("USB", { USB: ["DP", "DM"] })).toBeUndefined()
  })

  it("a brace inside a member list that is not text markup is no group (KiCad's parser returns false), and a group in an alias has its own prefix, not the outer one", () => {
    expect(names("A{B{C D} E}")).toBeUndefined()
    expect(names("P{X}", { X: ["Q{C D}", "E"] })).toEqual(["Q.C", "Q.D", "P.E"])
  })

  it("keeps the members' own names for the matching of two groups", () => {
    const a = parseBusName("SPI{SIG}", (n) => (n === "SIG" ? ["SCLK", "MOSI"] : undefined), "kicad9")!
    const b = parseBusName("{SCLK,MOSI,CS}", undefined, "kicad9")!
    expect(a.locals).toEqual(["SCLK", "MOSI"])
    expect(memberPairs(a, b)).toEqual([["SPI.SCLK", "SCLK"], ["SPI.MOSI", "MOSI"]])
    expect(memberPairs(a, b, true)).toEqual([])
  })

  it("matches two vectors by position, whatever their names", () => {
    const a = parseBusName("D[0..3]")!
    const b = parseBusName("DATA[4..7]")!
    expect(memberPairs(a, b)).toEqual([["D0", "DATA4"], ["D1", "DATA5"], ["D2", "DATA6"], ["D3", "DATA7"]])
    expect(memberPairs(a, parseBusName("{A B}")!)).toEqual([])
  })

  it("parseBusVector and parseBusGroup are the two readers", () => {
    expect(parseBusVector("D[0..1]", "kicad9")).toEqual({ prefix: "D", members: ["D0", "D1"] })
    expect(parseBusGroup("P{A B}", "kicad9")).toEqual({ prefix: "P", members: ["A", "B"] })
    expect(parseBusGroup("P{A B", "kicad9")).toBeNull()
  })
})

describe("hostile names", () => {
  it("a range of more than the limit is refused by name, before anything is made", () => {
    expect(() => parseBusName(`D[0..${MAX_BUS_MEMBERS}]`)).toThrow(BusTooLarge)
    expect(() => parseBusName("D[0..99999999999999999999999]")).toThrow(BusTooLarge)
    expect(parseBusName(`D[0..${MAX_BUS_MEMBERS - 1}]`)?.names).toHaveLength(MAX_BUS_MEMBERS)
  })

  it("aliases that hold themselves, or that multiply, stop at the limit", () => {
    expect(() => parseBusName("{A}", (n) => (n === "A" ? ["{A}"] : undefined))).toThrow(BusTooLarge)
    const big = (n: string) => (n.length === 1 ? Array.from({ length: 80 }, () => `{${String.fromCharCode(n.charCodeAt(0) + 1)}}`) : undefined)
    expect(() => parseBusName("{a}", big)).toThrow(BusTooLarge)
  })

  it("a deep run of braces or brackets is read in a line", () => {
    const t0 = performance.now()
    for (const t of ["{".repeat(50000), "}".repeat(50000), "[".repeat(50000), `${"A{".repeat(5000)}x${"}".repeat(5000)}`, "D[" + "9".repeat(50000) + "..1]"]) {
      try {
        parseBusName(t)
      } catch (e) {
        expect(e).toBeInstanceOf(BusTooLarge)
      }
    }
    expect(performance.now() - t0).toBeLessThan(2000)
  })

  it("an editor project with a label that is too large for a bus keeps it as a net's name and does not crash", () => {
    const p: Project = { ...createProject("hostile"), labels: [{ id: "l", name: `D[0..${MAX_BUS_MEMBERS + 10}]`, x: 0, y: 0, rot: 0 }], wires: [{ id: "w", points: [{ x: 0, y: 0 }, { x: 1, y: 0 }] }] }
    expect(computeConnectivity(p).nets.map((n) => n.name)).toEqual([`D[0..${MAX_BUS_MEMBERS + 10}]`])
  })
})
