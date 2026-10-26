import { describe, expect, it } from "vitest"
import { linkFootprints, readSchematicTree, symbolRecords, timestampForm, type FootprintToLink } from "../src/model/kicad/schematic"
import { LIB_R, schematic, type SymSpec } from "./kicad-schematic-fixtures"

// Linking a footprint to its symbol, in the order of section 4 of docs/kicad-import-schematic.md:
// path, then timestamp, then reference, then nothing; with the path of KiCad 6 and 7 differing, a
// reused sheet linking several footprints to one symbol, and several symbols (the units of one part)
// to one footprint.

const U1 = "aaaaaaaa-0000-4000-8000-000000000001"
const U2 = "aaaaaaaa-0000-4000-8000-000000000002"
const U3 = "aaaaaaaa-0000-4000-8000-000000000003"
const sym = (ref: string, uuid: string, extra: Partial<SymSpec> = {}): SymSpec => ({ lib: "Device:R", at: "50.8 50.8", ref, uuid, ...extra })
const sheet = (name: string, file: string, uuid: string) => `(sheet (at 10 10) (size 20 10) (uuid ${uuid}) (property "Sheetname" "${name}" (at 0 0 0)) (property "Sheetfile" "${file}" (at 0 0 0)))`
const tree = (entries: Record<string, string>) => readSchematicTree(new Map(Object.entries(entries)), "root.kicad_sch")
const fp = (ref: string, path: string): FootprintToLink => ({ ref, path })

describe("by path", () => {
  it("a KiCad 7 symbol on the root sheet: the board's path has no root uuid, the instance's has", () => {
    const t = tree({ "root.kicad_sch": schematic({ uuid: "root", libs: [LIB_R], symbols: [sym("R1", U1)] }) })
    expect(symbolRecords(t).map((r) => [r.path, r.sheetPath, r.reference, r.from])).toEqual([[`/${U1}`, "/", "R1", "symbol"]])
    const r = linkFootprints(t, [fp("R1", `/${U1}`)])
    expect(r.links[0].how).toBe("path")
    expect(r.links[0].record?.symbol.uuid).toBe(U1)
    expect(r.counts).toMatchObject({ footprints: 1, path: 1, reference: 0, none: 0 })
  })

  it("a KiCad 6 symbol: the root list writes the path as the board does", () => {
    const t = tree({ "root.kicad_sch": schematic({ version: 20211123, uuid: "root", libs: [LIB_R], symbols: [sym("R1", U1)] }) })
    expect(symbolRecords(t).map((r) => [r.path, r.from])).toEqual([[`/${U1}`, "root-list"]])
    expect(linkFootprints(t, [fp("R1", `/${U1}`)]).links[0].how).toBe("path")
  })

  it("KiCad 6 and 7 find the same symbol by the same board path, on a sheet below the root", () => {
    const sub = (version: number) =>
      tree({
        "root.kicad_sch": schematic({ version, uuid: "root", body: [sheet("Sub", "sub.kicad_sch", "sheet1")] }),
        "sub.kicad_sch":
          version >= 20221002
            ? schematic({ version, uuid: "sub", libs: [LIB_R], symbols: [sym("R5", U1, { instances: ["/root/sheet1|R5"] })] })
            : schematic({ version, uuid: "sub", libs: [LIB_R], symbols: [sym("R5", U1)], rootList: false }),
      })
    // KiCad 6 lists the symbol once at the root, with the sheet in its path
    const six = sub(20211123)
    six.files.get("root.kicad_sch")!.schematic.rootInstances.push({ project: "", path: `/sheet1/${U1}`, reference: "R5", unit: 1, value: null, footprint: null, from: "root-list", variants: [] })
    for (const t of [six, sub(20230121)]) {
      expect(symbolRecords(t).map((r) => [r.path, r.sheetPath])).toEqual([[`/sheet1/${U1}`, "/sheet1"]])
      const r = linkFootprints(t, [fp("R5", `/sheet1/${U1}`)])
      expect([r.links[0].how, r.links[0].record?.file]).toEqual(["path", "sub.kicad_sch"])
    }
  })

  it("a sheet used twice: one symbol links two footprints, one by each path", () => {
    const t = tree({
      "root.kicad_sch": schematic({ uuid: "root", body: [sheet("Left", "ch.kicad_sch", "s1"), sheet("Right", "ch.kicad_sch", "s2")] }),
      "ch.kicad_sch": schematic({ uuid: "ch", libs: [LIB_R], symbols: [sym("R?", U1, { instances: ["/root/s1|R1", "/root/s2|R2"] })] }),
    })
    expect(symbolRecords(t).map((r) => [r.path, r.reference])).toEqual([
      [`/s1/${U1}`, "R1"],
      [`/s2/${U1}`, "R2"],
    ])
    const r = linkFootprints(t, [fp("R1", `/s1/${U1}`), fp("R2", `/s2/${U1}`)])
    expect(r.links.map((l) => l.how)).toEqual(["path", "path"])
    expect(r.links[0].record?.symbol).toBe(r.links[1].record?.symbol)
    expect(r.links.map((l) => l.record?.reference)).toEqual(["R1", "R2"])
    expect(r.symbolsOnSeveralFootprints).toBe(1)
  })

  it("a KiCad 6 sheet used twice has two paths in the root list", () => {
    const t = tree({
      "root.kicad_sch": schematic({ version: 20211123, uuid: "root", body: [sheet("Left", "ch.kicad_sch", "s1"), sheet("Right", "ch.kicad_sch", "s2")], rootEntries: [`/s1/${U1}|R1`, `/s2/${U1}|R2`] }),
      "ch.kicad_sch": schematic({ version: 20211123, uuid: "ch", libs: [LIB_R], symbols: [sym("R?", U1)], rootList: false }),
    })
    const r = linkFootprints(t, [fp("R2", `/s2/${U1}`), fp("R1", `/s1/${U1}`)])
    expect(r.links.map((l) => [l.how, l.record?.reference])).toEqual([["path", "R2"], ["path", "R1"]])
    expect(r.symbolsOnSeveralFootprints).toBe(1)
  })

  it("the path wins over the reference: a footprint whose reference was changed on the board still links by its path", () => {
    const t = tree({ "root.kicad_sch": schematic({ uuid: "root", libs: [LIB_R], symbols: [sym("R1", U1), sym("R2", U2)] }) })
    const r = linkFootprints(t, [fp("R2", `/${U1}`)])
    expect([r.links[0].how, r.links[0].record?.reference]).toEqual(["path", "R1"])
  })

  it("instance data of another project is not this project's: its root uuid is not ours, and the symbol's own reference stands", () => {
    const t = tree({ "root.kicad_sch": schematic({ uuid: "root", libs: [LIB_R], symbols: [sym("R7", U1, { instances: ["/other/sheet|R99"] })] }) })
    expect(symbolRecords(t).map((r) => [r.path, r.reference, r.from])).toEqual([[`/${U1}`, "R7", "none"]])
  })

  it("a file with no instance data at all is placed at every use of its sheet, with its own reference", () => {
    const t = tree({
      "root.kicad_sch": schematic({ uuid: "root", body: [sheet("A", "ch.kicad_sch", "s1"), sheet("B", "ch.kicad_sch", "s2")] }),
      "ch.kicad_sch": schematic({ version: 20230121, uuid: "ch", libs: [LIB_R], symbols: [sym("R1", U1, { instances: [] })] }),
    })
    expect(symbolRecords(t).map((r) => [r.path, r.reference, r.from])).toEqual([
      [`/s1/${U1}`, "R1", "none"],
      [`/s2/${U1}`, "R1", "none"],
    ])
  })
})

describe("by timestamp", () => {
  it("KiCad 6 re-encodes a KiCad 5 timestamp as a uuid: both are read as the timestamp", () => {
    expect(timestampForm("/00000000-0000-0000-0000-00005a1b2c3d")).toBe("/5A1B2C3D")
    expect(timestampForm("/5a1b2c3d")).toBe("/5A1B2C3D")
    expect(timestampForm("/00000000-0000-0000-0000-00005d8236a8/aaaa-bbbb")).toBe("/5D8236A8/AAAA-BBBB")
    const ts = "00000000-0000-0000-0000-00005a1b2c3d"
    const t = tree({ "root.kicad_sch": schematic({ uuid: "root", libs: [LIB_R], symbols: [sym("R1", ts)] }) })
    const r = linkFootprints(t, [fp("R1", "/5A1B2C3D")])
    expect([r.links[0].how, r.links[0].record?.symbol.uuid]).toEqual(["timestamp", ts])
    expect(linkFootprints(t, [fp("R1", "/5a1b2c3d")]).links[0].how).toBe("timestamp")
    expect(r.counts).toMatchObject({ path: 0, timestamp: 1, reference: 0, none: 0 })
  })

  it("a timestamp that nothing claims is not a link", () => {
    const t = tree({ "root.kicad_sch": schematic({ uuid: "root", libs: [LIB_R], symbols: [sym("R1", U1)] }) })
    const r = linkFootprints(t, [fp("R9", "/00000000-0000-0000-0000-00005a1b2c3d")])
    expect(r.links[0].how).toBeNull()
    expect(r.counts).toMatchObject({ none: 1, noneWithPath: 1, noneNoPath: 0 })
  })
})

describe("by reference, and by nothing", () => {
  const t = tree({ "root.kicad_sch": schematic({ uuid: "root", libs: [LIB_R], symbols: [sym("R1", U1), sym("R2", U2)] }) })

  it("a footprint with no path links to the symbol with its reference", () => {
    const r = linkFootprints(t, [fp("R2", "")])
    expect([r.links[0].how, r.links[0].record?.symbol.uuid]).toEqual(["reference", U2])
    expect(r.counts).toMatchObject({ reference: 1, none: 0 })
  })

  it("a footprint whose path no symbol claims links by its reference, and one with no symbol at all by nothing", () => {
    const r = linkFootprints(t, [fp("R1", "/ffffffff-0000-4000-8000-000000000000"), fp("MH1", ""), fp("LOGO", "/ffffffff-0000-4000-8000-000000000001")])
    expect(r.links.map((l) => l.how)).toEqual(["reference", null, null])
    expect(r.counts).toMatchObject({ footprints: 3, reference: 1, none: 2, noneNoPath: 1, noneWithPath: 1 })
  })

  it("a footprint whose reference has a star was never annotated: it is left out of the count and has no link", () => {
    const r = linkFootprints(t, [fp("REF**", ""), fp("R1", `/${U1}`)])
    expect(r.counts).toMatchObject({ footprints: 1, excluded: 1, path: 1 })
    expect(r.links[0].how).toBeNull()
  })

  it("the units of one part: several symbols, one footprint", () => {
    const units = tree({ "root.kicad_sch": schematic({ uuid: "root", libs: [LIB_R], symbols: [sym("U1", U1, { unit: 1 }), sym("U1", U2, { unit: 2 }), sym("U2", U3)] }) })
    const r = linkFootprints(units, [fp("U1", `/${U1}`)])
    expect(r.links[0].units.map((u) => u.symbol.uuid)).toEqual([U1, U2])
    expect(r.multiUnitReferences).toBe(1)
    // by reference the first unit found stands for the part, and its mates are the others
    const byRef = linkFootprints(units, [fp("U1", "")])
    expect(byRef.links[0].units.map((u) => u.symbol.uuid).sort()).toEqual([U1, U2])
  })

  it("two uses with one path: the one with the footprint's reference is taken, and the choice is flagged", () => {
    const dup = tree({ "root.kicad_sch": schematic({ uuid: "root", libs: [LIB_R], symbols: [sym("R1", U1, { instances: [`/root|R1`, `/root|R2`] })] }) })
    const r = linkFootprints(dup, [fp("R2", `/${U1}`)])
    expect([r.links[0].record?.reference, r.links[0].ambiguous]).toEqual(["R2", true])
  })

  it("a sheet that is in the project but whose file is missing leaves its footprints unlinked, as nothing", () => {
    const t2 = tree({ "root.kicad_sch": schematic({ uuid: "root", libs: [LIB_R], symbols: [sym("R1", U1)], body: [sheet("Gone", "gone.kicad_sch", "s9")] }) })
    expect(t2.errors).toHaveLength(1)
    expect(linkFootprints(t2, [fp("R50", `/s9/${U3}`)]).links[0].how).toBeNull()
  })
})
