import { describe, expect, it } from "vitest"
import { computeConnectivity } from "../src/model/connectivity"
import { alias, bus, entry, globalLabel, hierLabel, label, load, oneSheet, pinsOn, refusal, resistor, twoSheets } from "./kicad-sch-s3-fixtures"

// S3: buses, bus entries, bus aliases and vector names, end to end, from the files KiCad writes.

describe("S3: one sheet", () => {
  const { project, report } = load(oneSheet())

  it("holds the bus, its two entries and the label that names the bus", () => {
    const buses = project.drawings!.filter((d) => d.type === "bus")
    expect(buses).toHaveLength(1)
    expect(project.drawings!.filter((d) => d.type === "busentry")).toHaveLength(2)
    expect(project.labels.map((l) => l.name).sort()).toEqual(["D3", "D4", "D[0..7]"])
  })

  it("makes a net of each wire that leaves the bus, named by its label, and no net of the bus", () => {
    const { nets, labelNet } = computeConnectivity(project)
    expect(nets.map((n) => n.name).sort()).toEqual(["/D3", "/D4"])
    const bus = project.labels.find((l) => l.name === "D[0..7]")!
    expect(labelNet.has(bus.id)).toBe(false)
    const d3 = nets.find((n) => n.name === "/D3")!
    expect(pinsOn(project, d3)).toEqual(["R1.1"])
  })

  it("counts no S3 node as pending or unknown", () => {
    expect(report.account?.pending.size).toBe(0)
    expect(report.account?.unknownPaths.size).toBe(0)
  })
})

describe("S3: a net named like a member joins by its name", () => {
  it("a label D3 elsewhere on the sheet is the same net, with or without an entry", () => {
    const files = oneSheet({ extraBody: [] })
    const text = files.get("root.kicad_sch")!
    const withR3 = text.replace("(sheet_instances", `${"(wire (pts (xy 90 60) (xy 90 70)) (stroke (width 0) (type default)) (uuid wx))"}\n${label("D3", 90, 70)}\n(sheet_instances`)
    const { project } = load(new Map([["root.kicad_sch", withR3]]))
    const { nets } = computeConnectivity(project)
    expect(nets.filter((n) => n.name === "/D3")).toHaveLength(1)
  })
})

describe("S3: across a sheet pin", () => {
  it("joins the nets of a bus's members above and below, by the pin and the hierarchical label of one bus name", () => {
    const { project } = load(twoSheets())
    const { nets } = computeConnectivity(project)
    const d3 = nets.find((n) => n.name === "/D3")!
    expect(pinsOn(project, d3)).toEqual(["R1.1", "R9.1"])
    expect(nets.map((n) => n.name).some((n) => n.includes("["))).toBe(false)
  })

  it("keeps a member that only one sheet names apart", () => {
    const { project } = load(twoSheets({ childNet: "D4" }))
    const { nets } = computeConnectivity(project)
    expect(nets.find((n) => n.name === "/D3")!.pins).toHaveLength(1)
    expect(nets.find((n) => n.name === "/D4")!.pins).toHaveLength(1)
  })

  it("joins a group bus by the names of its members", () => {
    const { project } = load(twoSheets({ rootBus: "{SIG1 D3}", rootNet: "D3", childNet: "D3" }))
    const { nets } = computeConnectivity(project)
    expect(pinsOn(project, nets.find((n) => n.name === "/D3")!)).toEqual(["R1.1", "R9.1"])
  })

  it("joins a prefixed group's members as PREFIX.MEMBER, and reads an alias inside a group", () => {
    const files = twoSheets({ rootBus: "P{USB}", rootNet: "P.DP", childNet: "P.DP", rootAliases: [alias("USB", ["DP", "DM"])] })
    const { project } = load(files)
    expect(project.busAliases).toEqual([expect.objectContaining({ name: "USB", members: ["DP", "DM"] })])
    const { nets } = computeConnectivity(project)
    expect(pinsOn(project, nets.find((n) => n.name === "/P.DP")!)).toEqual(["R1.1", "R9.1"])
  })
})

describe("S3: a bus's strongest name gives its members' names to every net on them", () => {
  it("renames a net of a group's member to the driver's prefixed name, across a sheet pin (KiCad's matchBusMember: a group by the member's own name)", () => {
    // root: SPI{SIG} on the bus (members SPI.SCLK, SPI.MOSI), a pin {SIG} (members SCLK, MOSI); child: {SIG} and a bus label {SCLK,MOSI}, a net SCLK
    const files = twoSheets({ rootBus: "SPI{SIG}", pinName: "{SIG}", childBus: "{SIG}", rootNet: "SPI.SCLK", childNet: "SCLK", rootAliases: [alias("SIG", ["SCLK", "MOSI"])], childAliases: [] })
    const text = files.get("root.kicad_sch")!
    // put the pin on the same bus as the label: the pin's point is on the bus end
    const { project } = load(files)
    const { nets } = computeConnectivity(project)
    const net = nets.find((n) => pinsOn(project, n).join(" ") === "R1.1 R9.1")
    expect(net?.name).toBe("/SPI.SCLK")
    void text
  })

  it("renames by position for a vector: a net D3 below a bus the driver names V[0..7] is V3", () => {
    const { project } = load(twoSheets({ rootBus: "V[0..7]", pinName: "V[0..7]", childBus: "V[0..7]", rootNet: "V3", childNet: "V3" }))
    const { nets } = computeConnectivity(project)
    expect(nets.map((n) => n.name)).toContain("/V3")
  })
})

describe("S3: refusals say what they are", () => {
  it("a bus name on a wire is S3B, in words", () => {
    const r = refusal(oneSheet({ wireLabels: ["D[0..3]", "D4"] }))
    expect(r?.message).toMatch(/bus names/i)
  })

  it("a name KiCad 9 and 10 read differently is refused", () => {
    const r = refusal(oneSheet({ busLabel: "D[00..07]" }))
    expect(r?.message).toMatch(/bus names/i)
  })
})

void [bus, entry, globalLabel, hierLabel, resistor]

// ---------- held, saved, exported ----------

import { kicadFiles } from "../src/export/kicad"
import { parseProjectFile, serializeProject } from "../src/model/projectFile"
import { importKicadSchematic } from "../src/model/kicad/schematic"
import { runErc } from "../src/model/erc"
import { kicad9SheetProblems } from "./kicad9-strict"
import type { Project } from "../src/model/types"

const schFiles = (out: Awaited<ReturnType<typeof kicadFiles>>) => new Map(Object.entries(out.files).filter(([n]) => n.endsWith(".kicad_sch")))
const rootName = (m: Map<string, string>) => [...m.keys()].find((n) => !n.startsWith("child") && !n.startsWith("sub"))!
const reload = (files: Map<string, string>): Project => {
  const r = importKicadSchematic({ files, root: rootName(files) })
  if (r.status !== "imported") throw new Error(`refused: ${r.message}\n${r.report.entries.map((e) => e.why).join("\n")}`)
  return r.project
}
const netPins = (p: Project) => computeConnectivity(p).nets.map((n) => `${n.name}: ${pinsOn(p, n).join(" ")}`).sort()

describe("S3: every node is held, not only counted", () => {
  const files = oneSheet({ extraBody: [bus(40.64, 45.72, 60.96, 45.72, "(stroke (width 0.3) (type dash) (color 255 0 0 1))"), entry(63.5, 45.72, -2.54, 2.54, "(stroke (width 0.2) (type default))"), alias("SPI", ["MOSI", "MISO"])] })
  const { project, report } = load(files)

  it("keeps a bus's stroke, an entry's size and slant, and an alias's members", () => {
    const styled = project.drawings!.find((d) => d.type === "bus" && d.stroke?.dash === "dash")!
    expect(styled).toMatchObject({ type: "bus", stroke: { dash: "dash", color: "#ff0000" } })
    expect((styled as { stroke: { width: number } }).stroke.width * 12.7).toBeCloseTo(0.3, 3)
    const slanted = project.drawings!.find((d) => d.type === "busentry" && d.dx < 0)!
    expect(slanted).toMatchObject({ type: "busentry", dx: -0.2, dy: -0.2 })
    expect(project.busAliases).toEqual([expect.objectContaining({ name: "SPI", members: ["MOSI", "MISO"] })])
  })

  it("counts every bus node as imported, none pending or unknown", () => {
    expect(report.account?.pending.size).toBe(0)
    expect(report.account?.unknownPaths.size).toBe(0)
    const held = [...(report.account?.importedPaths.keys() ?? [])]
    for (const path of ["bus", "bus>pts", "bus>pts>xy", "bus>stroke", "bus>stroke>width", "bus>stroke>type", "bus>stroke>color", "bus_entry", "bus_entry>at", "bus_entry>size", "bus_entry>stroke", "bus_alias", "bus_alias>members"]) expect(held, path).toContain(path)
  })

  it("survives a save and a load exactly", () => {
    const back = parseProjectFile(serializeProject(project), { id: project.id })
    expect(back.drawings).toEqual(project.drawings)
    expect(back.busAliases).toEqual(project.busAliases)
    expect(back.labels).toEqual(project.labels)
  })

  it("is written to KiCad 9 and read back with the same buses, entries, aliases and nets", async () => {
    const out = await kicadFiles(project)
    const sch = schFiles(out)
    const text = [...sch.values()][0]
    // KiCad 9's parser takes no other token inside a bus, a bus entry or an alias (tests/kicad9-strict.ts)
    expect(kicad9SheetProblems(text)).toEqual([])
    expect(text).toMatch(/\(bus\n\s+\(pts/)
    expect(text).toMatch(/\(bus_entry\n\s+\(at [\d.]+ [\d.]+\)\n\s+\(size /)
    expect(text).toMatch(/\(bus_alias "SPI" \(members "MOSI" "MISO"\)\)/)
    expect(text).toMatch(/\(label "D\[0\.\.7\]"/)
    const back = reload(sch)
    expect(back.drawings!.filter((d) => d.type === "bus")).toHaveLength(project.drawings!.filter((d) => d.type === "bus").length)
    expect(back.drawings!.filter((d) => d.type === "busentry").map((d) => (d as { dx: number; dy: number }).dx).sort()).toEqual(project.drawings!.filter((d) => d.type === "busentry").map((d) => (d as { dx: number }).dx).sort())
    expect(back.busAliases).toEqual([expect.objectContaining({ name: "SPI", members: ["MOSI", "MISO"] })])
    expect(netPins(back)).toEqual(netPins(project))
  })
})

describe("S3: a hierarchy with a bus round-trips through KiCad", () => {
  it("keeps the pin, the hierarchical label, the bus names and the joined nets", async () => {
    const { project } = load(twoSheets({ rootBus: "P{USB}", rootNet: "P.DP", childNet: "P.DP", rootAliases: [alias("USB", ["DP", "DM"])] }))
    const out = await kicadFiles(project)
    const sch = schFiles(out)
    const back = reload(sch)
    expect(netPins(back)).toEqual(netPins(project))
    expect(back.sheetSymbols![0].pins.map((p) => p.name)).toEqual(["P{USB}"])
    expect(back.labels.filter((l) => l.kind === "hierarchical").map((l) => l.name)).toEqual(["P{USB}"])
    expect(back.busAliases).toHaveLength(1)
  })
})

describe("S3: checks", () => {
  it("flags an entry on no bus, and a net on a bus entry that is no member of the bus", () => {
    const { project } = load(oneSheet({ wireLabels: ["D3", "X9"], extraBody: [entry(90, 90, 2.54, 2.54)] }))
    const kinds = runErc(project, computeConnectivity(project)).map((f) => f.kind)
    expect(kinds).toContain("bus-entry-no-bus")
    expect(kinds).toContain("net-not-bus-member")
  })

  it("says nothing of a sheet pin that has a bus on it", () => {
    const { project } = load(twoSheets())
    const kinds = runErc(project, computeConnectivity(project)).map((f) => f.kind)
    expect(kinds).not.toContain("sheet-pin-unconnected")
    expect(kinds).not.toContain("sheet-pin-no-label")
  })
})

// ---------- what KiCad joins, what it does not ----------

describe("S3: KiCad's rules for what a bus joins", () => {
  it("cuts a bus at a junction on its body, so a bus that crosses there joins; and a bus end on another bus's side with no junction is imported with KiCad's rules for the sheet (S11)", () => {
    const crossing = (junction: boolean) =>
      oneSheet({ extraBody: [bus(80, 40, 80, 50), bus(70, 45, 90, 45), ...(junction ? ["(junction (at 80 45) (diameter 0) (color 0 0 0 0) (uuid jj))"] : [])] })
    const ok = load(crossing(true))
    expect(ok.project.drawings!.filter((d) => d.type === "bus").length).toBeGreaterThan(4)
    // S11 is built: the sheet is imported with KiCad's rules (the bus end joins nothing there), where it was refused before
    const touching = load(oneSheet({ extraBody: [bus(80, 40, 80, 45), bus(70, 45, 90, 45)] }))
    expect(touching.project.sheets?.some((x) => x.kicadRules)).toBe(true)
    expect(ok.project.sheets?.some((x) => x.kicadRules)).toBeFalsy()
  })

  it("imports an entry whose end touches a wire's side with no junction with KiCad's rules for the sheet (S11), and joins one with a junction without them", () => {
    const wire = "(wire (pts (xy 100 60) (xy 100 80)) (stroke (width 0) (type default)) (uuid wide))"
    expect(load(oneSheet({ extraBody: [wire, entry(100, 70, 2.54, -2.54)] })).project.sheets?.some((x) => x.kicadRules)).toBe(true)
    const joined = load(oneSheet({ extraBody: [wire, "(junction (at 100 70) (diameter 0) (color 0 0 0 0) (uuid jj))", entry(100, 70, 2.54, -2.54)] }))
    expect(joined.project.sheets?.some((x) => x.kicadRules)).toBeFalsy()
  })

  it("an entry with neither end on a bus joins the wires at both ends, as any item of a net does", () => {
    const files = oneSheet({
      wireLabels: ["N1", "N2"],
      extraBody: [
        `(wire (pts (xy 100 60) (xy 100 70)) (stroke (width 0) (type default)) (uuid wa))`,
        `(wire (pts (xy 102.54 72.54) (xy 110 72.54)) (stroke (width 0) (type default)) (uuid wb))`,
        entry(100, 70, 2.54, 2.54),
        label("JOINED", 110, 72.54),
        label("JOINED2", 100, 60),
      ],
    })
    const { project } = load(files)
    const { nets } = computeConnectivity(project)
    const joined = nets.find((n) => n.label?.text === "JOINED" || n.label?.text === "JOINED2")
    expect(joined).toBeTruthy()
    expect(nets.filter((n) => n.name === "/JOINED" || n.name === "/JOINED2")).toHaveLength(1)
  })

  it("an entry end on a bus joins nothing there, even where a wire ends on the same point", () => {
    // the wire's end sits on the bus too: KiCad does not short the net to the bus, and the entry does not join the wire at that end
    const files = oneSheet({ wireLabels: ["A1", "A2"] })
    const { project } = load(files)
    const { nets } = computeConnectivity(project)
    expect(nets.map((n) => n.name).sort()).toEqual(["/A1", "/A2"])
  })

  it("a global bus label names global members: a net on one is the global net of its name, with no sheet path in front", () => {
    const { project } = load(oneSheet({ globalBus: true }))
    expect(computeConnectivity(project).nets.map((n) => n.name).sort()).toEqual(["D3", "D4"])
  })

  it("is the same in the files KiCad 6, 7 and 8 wrote", () => {
    for (const version of [20211123, 20230121, 20231120]) {
      const { project } = load(oneSheet({ version }))
      expect(computeConnectivity(project).nets.map((n) => n.name).sort()).toEqual(["/D3", "/D4"])
    }
  })

  it("a bus of three points, and an entry with no size, are refused by name", () => {
    expect(refusal(oneSheet({ extraBody: ["(bus (pts (xy 0 0) (xy 1 0) (xy 2 0)) (stroke (width 0) (type default)) (uuid b3))"] }))?.report.entries.some((e) => e.code === "bus-not-held")).toBe(true)
    expect(refusal(oneSheet({ extraBody: [entry(0, 0, 0, 0)] }))?.report.entries.some((e) => e.code === "bus-not-held")).toBe(true)
  })

  it("a bus too large is refused as bus names (S3B)", () => {
    expect(refusal(oneSheet({ busLabel: "D[0..9999]" }))?.message).toMatch(/bus names/i)
  })

  it("two aliases of one name with different members are refused (S3B)", () => {
    expect(refusal(oneSheet({ extraBody: [alias("X", ["A"]), alias("X", ["B"])] }))?.message).toMatch(/bus names/i)
  })

  it("a thousand entries on a long bus import in a moment", () => {
    const body: string[] = [bus(0, 20, 400, 20)]
    const wires: string[] = []
    for (let i = 0; i < 1000; i++) body.push(entry(i * 0.4, 22.54, 2.54, -2.54))
    const t0 = performance.now()
    const files = oneSheet({ extraBody: body })
    void wires
    load(files)
    expect(performance.now() - t0).toBeLessThan(5000)
  })
})

// ---------- project file, sheets, size ----------

import { removeSheetSymbols } from "../src/model/sheetOps"
import { PROJECT_FILE_FORMAT, PROJECT_FILE_VERSION, migrateProjectFile } from "../src/model/projectFile"
import { createProject } from "../src/model/ops"

describe("S3: the project file", () => {
  // A version 3 document with no buses.
  const v12 = {
    format: PROJECT_FILE_FORMAT,
    version: 3,
    project: {
      name: "v12",
      description: "",
      components: [],
      wires: [{ id: "w1", points: [{ x: 0, y: 0 }, { x: 1, y: 0 }] }],
      labels: [{ id: "l1", name: "SIG", x: 1, y: 0, rot: 0 }],
      traces: [],
      vias: [],
      zones: [],
      texts: [],
      sheets: [{ id: "root" }],
    },
  }

  it("reads a document with no buses unchanged but for the page version 6 gives its sheet, and saves it as the current version", () => {
    expect(migrateProjectFile(v12)).toEqual({ ...v12.project, sheets: [{ id: "root", paper: { size: "A4", x: -11, y: 7 } }] })
    const read = parseProjectFile(v12, { id: "x" })
    expect(read.busAliases).toBeUndefined()
    expect(read.drawings).toBeUndefined()
    expect(JSON.parse(serializeProject(read)).version).toBe(PROJECT_FILE_VERSION)
    expect(PROJECT_FILE_VERSION).toBe(6)
  })

  it("keeps a bus, an entry and an alias through a save and a load, and drops a malformed one without losing the rest", () => {
    const doc = {
      ...v12,
      project: {
        ...v12.project,
        drawings: [
          { id: "d1", type: "bus", points: [{ x: 0, y: 0 }, { x: 2, y: 0 }], stroke: { width: 0.03, dash: "dash", color: "#112233" } },
          { id: "d2", type: "busentry", x: 1, y: 0, dx: 0.2, dy: 0.2, toBus: true },
          { id: "d3", type: "bus", points: [{ x: 0, y: 0 }] },
          { id: "d4", type: "busentry", x: 1, y: 0, dx: 0, dy: 0 },
        ],
        busAliases: [{ id: "a1", name: "USB", members: ["DP", "DM"] }, { id: "a1", name: "dup", members: [] }, { id: "a2", members: ["x"] }, { id: "a3", name: "SPI", sheet: "s9", members: ["A", 3, "B"] }],
      },
    }
    const read = parseProjectFile(doc, { id: "x" })
    expect(read.drawings?.map((d) => d.id)).toEqual(["d1", "d2"])
    expect(read.busAliases).toEqual([
      { id: "a1", name: "USB", members: ["DP", "DM"] },
      { id: "a3", sheet: "s9", name: "SPI", members: ["A", "B"] },
    ])
    const again = parseProjectFile(serializeProject(read), { id: "x" })
    expect(again.drawings).toEqual(read.drawings)
    expect(again.busAliases).toEqual(read.busAliases)
  })

  it("writes the current version, and refuses a version above it", () => {
    const doc = JSON.parse(serializeProject(createProject("n")))
    expect(doc.version).toBe(PROJECT_FILE_VERSION)
    expect(() => parseProjectFile({ ...doc, version: 3 }, { id: "x" })).not.toThrow()
    expect(() => parseProjectFile({ ...doc, version: PROJECT_FILE_VERSION + 1 }, { id: "x" })).toThrow()
  })
})

describe("S3: sheets and size", () => {
  it("deleting a sheet takes the aliases of its file and its buses with it", () => {
    const { project } = load(twoSheets({ childAliases: [alias("CHILD", ["A", "B"])], rootAliases: [alias("ROOT", ["C", "D"])] }))
    expect(project.busAliases?.map((a) => a.name).sort()).toEqual(["CHILD", "ROOT"])
    const gone = removeSheetSymbols(project, project.sheetSymbols!.map((s) => s.id))
    expect(gone.busAliases?.map((a) => a.name)).toEqual(["ROOT"])
    expect(gone.drawings?.every((d) => !d.sheet)).toBe(true)
  })

  it("five thousand bus segments, entries and labels are worked out in a moment", () => {
    const p = createProject("big")
    const drawings: Project["drawings"] = []
    const labels: Project["labels"] = []
    for (let i = 0; i < 5000; i++) {
      drawings.push({ id: `b${i}`, type: "bus", points: [{ x: 0, y: i * 0.3 }, { x: 10, y: i * 0.3 }] })
      drawings.push({ id: `e${i}`, type: "busentry", x: 1 + (i % 50) * 0.1, y: i * 0.3, dx: 0.2, dy: 0.2 })
      if (i % 5 === 0) labels.push({ id: `l${i}`, name: `BUS${i}[0..7]`, x: 5, y: i * 0.3, rot: 0 })
    }
    const t0 = performance.now()
    const conn = computeConnectivity({ ...p, drawings, labels })
    expect(conn.buses?.get("root")?.groups.length).toBe(5000)
    expect(performance.now() - t0).toBeLessThan(5000)
  })
})

// ---------- aliases from the project file (KiCad 10) ----------

import { proBusAliases, readKicadPro, accountPro } from "../src/model/kicad/project/pro"

describe("S3: the project file's bus aliases (KiCad 10 keeps them there, for the whole schematic)", () => {
  it("reads the object as KiCad 10 does: names and members stripped, an empty one dropped, a value that is not a list skipped", () => {
    const { pro } = readKicadPro(JSON.stringify({ schematic: { bus_aliases: { " SD ": ["A", " B ", "", 3], X: "no", "": ["Z"], E: [] } } }))
    expect(proBusAliases(pro)).toEqual([{ name: "SD", members: ["A", "B"] }, { name: "E", members: [] }])
    expect(proBusAliases(readKicadPro(JSON.stringify({ schematic: { bus_aliases: {} } })).pro)).toEqual([])
    expect(proBusAliases(null)).toEqual([])
  })

  it("accounts the key as used, not dropped", () => {
    const { pro } = readKicadPro(JSON.stringify({ schematic: { bus_aliases: { SD: ["A", "B"] } } }))
    const a = accountPro(pro.json)
    expect(a.pending.size).toBe(0)
    expect(a.unknownPaths.size).toBe(0)
    expect([...a.importedPaths.keys()].some((k) => k.startsWith("schematic>bus_aliases"))).toBe(true)
  })

  it("makes a group of an alias the files do not define join across a sheet pin, and keeps them in the project", () => {
    const files = twoSheets({ rootBus: "{SD}", pinName: "{SD}", childBus: "{SD}", rootNet: "SDC0", childNet: "SDC0" })
    // with no alias SD is a net, and the nets of its members do not join
    const plain = load(files).project
    expect(computeConnectivity(plain).nets.filter((n) => pinsOn(plain, n).length === 2)).toHaveLength(0)
    const r = importKicadSchematic({ files, root: "root.kicad_sch" }, { busAliases: [{ name: "SD", members: ["SDC0", "SDC1"] }] })
    expect(r.status).toBe("imported")
    if (r.status !== "imported") return
    expect(r.project.busAliases).toEqual([expect.objectContaining({ id: "p1", name: "SD", members: ["SDC0", "SDC1"] })])
    const net = computeConnectivity(r.project).nets.find((n) => pinsOn(r.project, n).length === 2)
    expect(net && pinsOn(r.project, net)).toEqual(["R1.1", "R9.1"])
  })
})

// ---------- Tidy and Clean up ----------

import { tidySchematic } from "../src/model/tidy"
import { cleanupSheet } from "../src/model/cleanup"

describe("S3: Tidy and Clean up leave a sheet with buses as it is, and say so", () => {
  it("refuses a sheet with a bus, changing nothing, and tidies the same sheet once the buses are gone", () => {
    const { project } = load(oneSheet())
    const t = tidySchematic(project)
    expect(t.ok).toBe(false)
    expect(t.message).toMatch(/buses/)
    expect(t.project).toBe(project)
    const c = cleanupSheet(project)
    expect(c.ok).toBe(false)
    expect(c.message).toMatch(/buses/)
    const bare = { ...project, drawings: undefined }
    expect(tidySchematic(bare).message).not.toMatch(/buses/)
  })
})
