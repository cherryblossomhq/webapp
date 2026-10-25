import { describe, expect, it } from "vitest"
import { computeConnectivity, pinKey } from "../src/model/connectivity"
import { findPart, projectPartIds } from "../src/model/library"
import { EXTENSION_NAMES as BOARD_EXTENSION_NAMES } from "../src/model/kicad/board"
import { importKicadProject, pickProjectFiles, projectNeeds, readKicadPro, readKicadRules, accountPro, accountRules, stripComments, KicadProjectFileError, KicadRulesFileError, type KicadProjectResult, type ProjectFile } from "../src/model/kicad/project"
import { board, footprint, pad } from "./kicad-board-fixtures"
import { LIB_R, divider, schematic } from "./kicad-schematic-fixtures"

// The project import: a board and its schematic as one project, linked, with every pad's net on the
// board checked against its pin's net in the schematic. The board and schematic importers each have
// their own tests; this is about what happens between them.

const BOARD_ALL = new Set([...Object.keys(BOARD_EXTENSION_NAMES), "S2", "S5", "S6", "S10"])
/** Everything built but net classes and rules, so a project file that has them is refused. */
const NO_X10 = new Set([...BOARD_ALL].filter((x) => x !== "X10"))
const U1 = "11111111-0000-4000-8000-000000000001"
const U2 = "11111111-0000-4000-8000-000000000002"

const text = (data: string): ProjectFile["data"] => data

/** R1 and R2 of the divider on a board, each with its pads on the nets the schematic gives them. */
function dividerBoard(opts: { nets?: [string, string, string, string]; path1?: string; path2?: string; extra?: string[] } = {}): string {
  const [vcc, mid1, mid2, gnd] = opts.nets ?? ["VCC", "/MID", "/MID", "GND"]
  const names = [...new Set([vcc, mid1, mid2, gnd])]
  const id = (n: string) => names.indexOf(n) + 1
  const net = (n: string) => `(net ${id(n)} "${n}")`
  return board({
    nets: ['(net 0 "")', ...names.map((n, i) => `(net ${i + 1} "${n}")`)],
    body: [
      footprint({ ref: "R1", at: "10 5", pads: [pad({ number: "1", at: "-1 0", net: net(vcc) }), pad({ number: "2", at: "1 0", net: net(mid1) })], extra: opts.path1 === undefined ? `(path "/${U1}")` : opts.path1 }),
      footprint({ ref: "R2", at: "15 5", pads: [pad({ number: "1", at: "-1 0", net: net(mid2) }), pad({ number: "2", at: "1 0", net: net(gnd) })], extra: opts.path2 === undefined ? `(path "/${U2}")` : opts.path2 }),
      ...(opts.extra ?? []),
    ],
  })
}

const files = (b: string, s: string, more: ProjectFile[] = []): ProjectFile[] => [{ path: "demo.kicad_pcb", data: text(b) }, { path: "demo.kicad_sch", data: text(s) }, ...more]

const imported = (r: KicadProjectResult) => {
  if (r.status !== "imported") throw new Error(`refused (${r.reason}): ${r.message}`)
  return r
}
const refused = (r: KicadProjectResult) => {
  if (r.status !== "refused") throw new Error("imported")
  return r
}

describe("a board and its schematic", () => {
  it("are one project: the schematic's parts, wires and labels, on the board's footprints and copper", () => {
    const r = imported(importKicadProject(files(dividerBoard(), divider()), { built: BOARD_ALL }))
    expect(r.differences).toEqual([])
    const refs = r.project.components.map((c) => c.ref).sort()
    expect(refs).toEqual(["#PWR01", "#PWR02", "R1", "R2"])
    const r1 = r.project.components.find((c) => c.ref === "R1")!
    // on the board where the file has it (y is up in the editor), and with the footprint the board made
    expect([r1.pcb.x, r1.pcb.y, r1.pcb.placed, r1.pcb.side]).toEqual([10, -5, true, "top"])
    expect(r1.footprint).not.toBe("")
    expect(r.project.footprints?.some((f) => f.name === r1.footprint)).toBe(true)
    // on the sheet where the schematic has it
    expect([r1.sch.x, r1.sch.y]).toEqual([4, -4])
    expect(r.project.wires.length).toBe(5)
    expect(r.project.labels.map((l) => l.name)).toEqual(["MID"])
    // the part is the symbol's, with the board's land: pins 1 and 2 are pads 1 and 2
    const part = findPart(r1.partId)!
    expect(part.footprints).toEqual([r1.footprint])
    expect(part.symbol.ports.map((p) => p.pin)).toEqual(["1", "2"])
  })

  it("keeps what became of every node of each file: the board's, the sheets', the project file's and the rules file's", () => {
    const r = imported(importKicadProject(files(dividerBoard(), divider(), [{ path: "demo.kicad_pro", data: JSON.stringify({ meta: { version: 1 }, net_settings: { classes: [{ name: "Default" }] } }) }, { path: "demo.kicad_dru", data: "(version 1)" }]), { built: BOARD_ALL }))
    expect(Object.keys(r.accounts).sort()).toEqual(["board", "pro", "rules", "schematic"])
    expect(r.accounts.board?.unknownPaths.size).toBe(0)
    expect(r.accounts.schematic?.unknownPaths.size).toBe(0)
    expect(r.accounts.schematic?.paths.get("symbol")).toBe(4)
    expect(r.accounts.pro?.pending.get("X10")).toBeGreaterThan(0)
    expect(r.accounts.rules?.notNeeded.get("the rules file's own version")).toBe(1)
  })

  it("two footprints with one reference are both linked, each by its own path", () => {
    const b = board({
      nets: ['(net 0 "")'],
      body: [footprint({ ref: "R1", at: "10 5", pads: [pad({ number: "1", at: "-1 0" }), pad({ number: "2", at: "1 0" })], extra: `(path "/${U1}")` }), footprint({ ref: "R1", at: "20 5", pads: [pad({ number: "1", at: "-1 0" }), pad({ number: "2", at: "1 0" })], extra: `(path "/${U2}")` })],
    })
    const r = imported(importKicadProject(files(b, divider()), { built: BOARD_ALL }))
    expect(r.link?.counts).toMatchObject({ path: 2, none: 0 })
    const at = (ref: string) => r.project.components.find((c) => c.ref === ref)!.pcb.x
    expect([at("R1"), at("R2")]).toEqual([10, 20])
  })

  it("the nets of the project are the schematic's, and every pad is on the net the board gives it", () => {
    const r = imported(importKicadProject(files(dividerBoard(), divider()), { built: BOARD_ALL }))
    const c = computeConnectivity(r.project)
    const id = (ref: string) => r.project.components.find((x) => x.ref === ref)!.id
    expect(c.pinNet.get(pinKey(id("R1"), "2"))).toBe("net:MID")
    expect(c.pinNet.get(pinKey(id("R2"), "1"))).toBe("net:MID")
    expect(c.pinNet.get(pinKey(id("R1"), "1"))).toBe("net:VCC")
    expect(c.pinNet.get(pinKey(id("R2"), "2"))).toBe("net:GND")
    expect(r.link?.counts).toMatchObject({ footprints: 2, path: 2, reference: 0, none: 0 })
  })

  it("a board not updated from its schematic is a list of differences, by part and pin", () => {
    // R2 pin 1 is on /OTHER on the board, where the schematic has it on MID with R1 pin 2
    const r = imported(importKicadProject(files(dividerBoard({ nets: ["VCC", "/MID", "/OTHER", "GND"] }), divider()), { built: BOARD_ALL }))
    expect(r.differences.map((d) => [d.ref, d.pin, d.board, d.schematic]).sort()).toEqual([
      ["R1", "2", "/MID", "MID"],
      ["R2", "1", "/OTHER", "MID"],
    ])
    expect(r.differences[0].why).toBe("R1 pin 2: the board puts it on /MID, the schematic on MID. The board has not been updated from its schematic.")
    expect(r.report.entries.filter((e) => e.code === "board-differs-from-schematic").map((e) => e.object).sort()).toEqual(["R1 pin 2", "R2 pin 1"])
    expect(r.report.entries.find((e) => e.code === "board-differs-from-schematic")?.severity).toBe("changed")
  })

  it("a net with the same pads on both sides but another name is a difference too", () => {
    const r = imported(importKicadProject(files(dividerBoard({ nets: ["VCC", "/MIDDLE", "/MIDDLE", "GND"] }), divider()), { built: BOARD_ALL }))
    expect(r.differences.map((d) => [d.ref, d.pin, d.why])).toEqual([
      ["R1", "2", "R1 pin 2: the net is called /MIDDLE on the board and MID in the schematic. The editor names this net by its own rule, not KiCad's (the names are S2), so the board may well be up to date."],
      ["R2", "1", "R2 pin 1: the net is called /MIDDLE on the board and MID in the schematic. The editor names this net by its own rule, not KiCad's (the names are S2), so the board may well be up to date."],
    ])
  })

  it("a net the editor names by its pads, not by a name the user gave, agrees with KiCad's own `Net-(R1-Pad2)`", () => {
    const bare = schematic({
      libs: [LIB_R],
      symbols: [
        { lib: "Device:R", at: "50.8 50.8", ref: "R1", footprint: "x", uuid: U1 },
        { lib: "Device:R", at: "50.8 68.58", ref: "R2", footprint: "x", uuid: U2 },
      ],
      wires: ["50.8 54.61 50.8 64.77"],
    })
    const r = imported(importKicadProject(files(dividerBoard({ nets: ["Net-(R1-Pad1)", "Net-(R1-Pad2)", "Net-(R1-Pad2)", "Net-(R2-Pad2)"] }), bare), { built: BOARD_ALL }))
    expect(r.differences).toEqual([])
  })

  it("a pad the symbol has no pin for, with a net on the board, is a difference", () => {
    const b = board({
      nets: ['(net 0 "")', '(net 1 "GND")'],
      body: [footprint({ ref: "R1", at: "10 5", pads: [pad({ number: "1", at: "-1 0" }), pad({ number: "2", at: "1 0" }), pad({ number: "EP", at: "0 2", net: '(net 1 "GND")' })], extra: `(path "/${U1}")` })],
    })
    const s = schematic({ libs: [LIB_R], symbols: [{ lib: "Device:R", at: "50.8 50.8", ref: "R1", footprint: "x", uuid: U1 }] })
    const r = imported(importKicadProject(files(b, s), { built: BOARD_ALL }))
    expect(r.differences.map((d) => d.why)).toEqual(["R1 pad EP: the board puts it on GND, but the symbol has no pin EP. The board has not been updated from its schematic."])
  })

  it("a footprint with no symbol stays a part on the board, below the schematic, and the report says so", () => {
    const tp = footprint({ ref: "TP1", at: "30 5", pads: [pad({ number: "1", at: "0 0" })] })
    const r = imported(importKicadProject(files(dividerBoard({ extra: [tp] }), divider()), { built: BOARD_ALL }))
    const part = r.project.components.find((c) => c.ref === "TP1")!
    expect(part.sch.y).toBeLessThan(Math.min(...r.project.components.filter((c) => c.ref !== "TP1").map((c) => c.sch.y)))
    expect(part.footprint).not.toBe("")
    expect(r.link?.counts).toMatchObject({ footprints: 3, path: 2, none: 1, noneNoPath: 1 })
    expect(r.report.entries.find((e) => e.code === "footprint-without-symbol")?.object).toBe("1 footprint (TP1)")
    expect(r.report.entries.find((e) => e.code === "footprint-links")?.why).toBe("2 of 3 footprints were linked to their symbol by path, 0 by reference designator, and 1 have no symbol (1 placed by hand with no link, 0 with a link to a symbol that is not in the schematic).")
    // its pins are not wired, and the board's own nets for it are none
    expect(r.differences).toEqual([])
  })

  it("a footprint with no symbol keeps its board nets: a pad on GND and VCC is on those nets in the schematic too (H1)", () => {
    const tp = footprint({ ref: "H1", at: "30 5", pads: [pad({ number: "1", at: "0 0", net: '(net 3 "GND")' }), pad({ number: "2", at: "2 0", net: '(net 1 "VCC")' })] })
    const r = imported(importKicadProject(files(dividerBoard({ extra: [tp] }), divider()), { built: BOARD_ALL }))
    const part = r.project.components.find((c) => c.ref === "H1")!
    const { nets, pinNet } = computeConnectivity(r.project)
    const nameOf = (id: string | undefined) => nets.find((n) => n.id === id)?.name
    expect(nameOf(pinNet.get(pinKey(part.id, "1")))).toBe("GND")
    expect(nameOf(pinNet.get(pinKey(part.id, "2")))).toBe("VCC")
    // and it shares those nets with the divider's own pins
    const r1 = r.project.components.find((c) => c.ref === "R1")!
    expect(pinNet.get(pinKey(part.id, "2"))).toBe(pinNet.get(pinKey(r1.id, "1")))
    expect(r.differences).toEqual([])
  })

  it("a loose pad on a net that has linked pads is labelled with the schematic's name for it: the board's /MID is the schematic's MID", () => {
    const tp = footprint({ ref: "TP2", at: "30 5", pads: [pad({ number: "1", at: "0 0", net: '(net 2 "/MID")' })] })
    const r = imported(importKicadProject(files(dividerBoard({ extra: [tp] }), divider()), { built: BOARD_ALL }))
    const { nets, pinNet } = computeConnectivity(r.project)
    const part = r.project.components.find((c) => c.ref === "TP2")!
    const r1 = r.project.components.find((c) => c.ref === "R1")!
    const id = pinNet.get(pinKey(part.id, "1"))
    expect(id).toBe(pinNet.get(pinKey(r1.id, "2")))
    expect(nets.find((n) => n.id === id)?.name).toBe("MID")
    expect(r.differences).toEqual([])
    expect(r.project.labels.filter((l) => l.name === "/MID")).toEqual([])
  })

  it("a loose part with a pad on GND alone gets it too (H2), and a mounting hole pad on GND is not left floating", () => {
    const h2 = footprint({ ref: "H2", at: "30 5", pads: [pad({ number: "1", at: "0 0", net: '(net 3 "GND")' })] })
    const hole = footprint({ ref: "MH1", name: "MountingHole:MountingHole_3.2mm_M3_Pad", at: "40 5", pads: [pad({ number: "1", at: "0 0", net: '(net 3 "GND")' })] })
    const r = imported(importKicadProject(files(dividerBoard({ extra: [h2, hole] }), divider()), { built: BOARD_ALL }))
    const { nets, pinNet } = computeConnectivity(r.project)
    const gnd = (ref: string) => nets.find((n) => n.id === pinNet.get(pinKey(r.project.components.find((c) => c.ref === ref)!.id, "1")))?.name
    expect(gnd("H2")).toBe("GND")
    expect(gnd("MH1")).toBe("GND")
    expect(r.differences).toEqual([])
    // the two loose parts do not sit on each other or on the schematic
    const boxes = ["H2", "MH1"].map((ref) => r.project.components.find((c) => c.ref === ref)!.sch)
    expect(`${boxes[0].x},${boxes[0].y}`).not.toBe(`${boxes[1].x},${boxes[1].y}`)
  })

  it("a padless footprint with no reference at R1's place does not take R1's part: R1 keeps its pads and its nets", () => {
    const logo = footprint({ ref: "", at: "10 5", pads: [] })
    const r = imported(importKicadProject(files(dividerBoard({ extra: [logo] }), divider()), { built: BOARD_ALL, allowLossyBoard: true }))
    expect(r.differences).toEqual([])
    expect(r.link?.counts).toMatchObject({ footprints: 3, path: 2 })
    const r1 = r.project.components.find((c) => c.ref === "R1")!
    expect(r1.footprint).not.toBe("")
  })

  it("two stacked footprints of one reference and a padless one are matched in the board builder's order, not refused", () => {
    const stacked = footprint({ ref: "R1", at: "10 5", pads: [pad({ number: "1", at: "-1 0" }), pad({ number: "2", at: "1 0" })] })
    const logo = footprint({ ref: "LOGO1", at: "10 5", pads: [] })
    const r = importKicadProject(files(dividerBoard({ extra: [stacked, logo] }), divider()), { built: BOARD_ALL, allowLossyBoard: true })
    expect(r.status === "refused" ? r.message : "").not.toMatch(/cannot be told apart/)
    expect(r.status).toBe("imported")
  })

  it("a footprint with no path is linked by its reference", () => {
    const r = imported(importKicadProject(files(dividerBoard({ path1: "", path2: "" }), divider()), { built: BOARD_ALL }))
    expect(r.link?.counts).toMatchObject({ path: 0, reference: 2, none: 0 })
    expect(r.differences).toEqual([])
    expect(r.project.components.find((c) => c.ref === "R1")!.footprint).not.toBe("")
  })

  it("a symbol with a footprint the board does not have is named in the report", () => {
    const b = board({
      nets: ['(net 0 "")', '(net 1 "VCC")', '(net 2 "/MID")'],
      body: [footprint({ ref: "R1", at: "10 5", pads: [pad({ number: "1", at: "-1 0", net: '(net 1 "VCC")' }), pad({ number: "2", at: "1 0", net: '(net 2 "/MID")' })], extra: `(path "/${U1}")` })],
    })
    const r = imported(importKicadProject(files(b, divider()), { built: BOARD_ALL }))
    expect(r.report.entries.find((e) => e.code === "symbol-without-footprint")?.object).toBe("1 symbol (R2)")
    expect(r.project.components.find((c) => c.ref === "R2")!.footprint).toBe("")
  })
})

describe("refused whole when one half is", () => {
  const withGlobal = divider().replace("(sheet_instances", `(bus (pts (xy 80 80) (xy 90 80)) (stroke (width 0) (type default)) (uuid b1))\n  (sheet_instances`)

  it("the schematic is refused but the board is fine: the project is refused, and the message says what the board alone gives", () => {
    const r = refused(importKicadProject(files(dividerBoard(), withGlobal), { built: BOARD_ALL }))
    expect(r.reason).toBe("unsupported")
    expect(r.message).toBe("This schematic uses buses, which are not supported yet. The project is not imported; importing the .kicad_pcb alone gives the board with a schematic generated from its nets.")
    expect(r.needs.map((n) => n.ext)).toEqual(["S3"])
    expect(r.boardAloneImports).toBe(true)
    expect(r.report.entries.find((e) => e.code === "board-alone-imports")).toMatchObject({ severity: "note", why: "Importing the .kicad_pcb alone gives the board with a schematic generated from its nets." })
  })

  it("the parts the board importer registered are taken out of memory when the project is refused after it", () => {
    const unique = footprint({ ref: "ZQ1", name: "Unique:Zq-Footprint-Only-Here", at: "40 5", pads: [pad({ number: "1", at: "0 0" }), pad({ number: "7", at: "3 0" })] })
    const before = projectPartIds()
    const r = refused(importKicadProject(files(dividerBoard({ extra: [unique] }), withGlobal), { built: BOARD_ALL }))
    expect(r.reason).toBe("unsupported")
    expect(projectPartIds()).toEqual(before)
    // the same board imported with a good schematic keeps them
    imported(importKicadProject(files(dividerBoard({ extra: [unique] }), divider()), { built: BOARD_ALL }))
    expect(projectPartIds().length).toBeGreaterThan(before.length)
  })

  it("the board is refused: the project is, with the board's own reason, and the board alone is no help", () => {
    const r = refused(importKicadProject(files(dividerBoard(), divider())))
    expect(r.reason).toBe("unsupported")
    expect(r.message).toMatch(/^This board uses .+, which (is|are) not supported yet\.$/)
    expect(r.boardAloneImports).toBe(false)
  })

  it("a schematic that cannot be read, or whose sheet is missing, is refused with that said", () => {
    const damaged = refused(importKicadProject(files(dividerBoard(), divider().slice(0, 900)), { built: BOARD_ALL }))
    expect(damaged.reason).toBe("unreadable")
    expect(damaged.message).toMatch(/cut short\. The project is not imported; importing the \.kicad_pcb alone/)
    const gone = divider().replace("(sheet_instances", `(sheet (at 10 10) (size 20 10) (uuid s1) (property "Sheetname" "Power" (at 0 0 0)) (property "Sheetfile" "power.kicad_sch" (at 0 0 0)))\n  (sheet_instances`)
    const r = refused(importKicadProject(files(dividerBoard(), gone), { built: BOARD_ALL }))
    expect(r.message).toMatch(/^the sheet "Power" \(power.kicad_sch\) is not among the files, so its pages are missing\./)
    expect(r.boardAloneImports).toBe(true)
  })

  it("a schematic that the build cannot hold exactly is refused as inexact", () => {
    const wire = divider().replace("(wire (pts (xy 50.8 59.69) (xy 60.96 59.69))", "(wire (pts (xy 50.8 59.69) (xy 60.96 59.69))").replace("(junction (at 50.8 59.69) (diameter 0) (color 0 0 0 0) (uuid j0))", "")
    const r = refused(importKicadProject(files(dividerBoard(), wire), { built: BOARD_ALL }))
    expect(r.reason).toBe("unsupported")
    expect(r.message).toContain("KiCad's rules for what a wire joins")
    expect(r.message).toContain("importing the .kicad_pcb alone")
  })

  it("a project over the size limit is refused, saying how big it is", () => {
    const r = refused(importKicadProject(files(board({}), schematic({ wires: ["10 10 20 10"] })), { limitBytes: 50 }))
    expect(r.reason).toBe("too-large")
    expect(r.message).toMatch(/^This (board|project) needs \d+ KB and projects hold up to 0 KB\.$/)
    // between the board's own size and the merged project's: the board passes, the project does not
    const boardBytes = imported(importKicadProject([{ path: "demo.kicad_pcb", data: dividerBoard() }], { built: BOARD_ALL })).bytes
    const fullBytes = imported(importKicadProject(files(dividerBoard(), divider()), { built: BOARD_ALL })).bytes
    expect(fullBytes).toBeGreaterThan(boardBytes)
    const merged = refused(importKicadProject(files(dividerBoard(), divider()), { built: BOARD_ALL, limitBytes: Math.floor((boardBytes + fullBytes) / 2) }))
    expect(merged.reason).toBe("too-large")
    expect(merged.message).toMatch(/^This (project|schematic) needs \d+ KB and projects hold up to \d+ KB\./)
  })

  it("no board among the files is a refusal that says so", () => {
    const r = refused(importKicadProject([{ path: "demo.kicad_sch", data: divider() }]))
    expect(r.reason).toBe("no-board")
    expect(r.message).toBe("This project has no board (.kicad_pcb). A schematic alone can be imported by itself.")
  })

  it("no schematic among the files gives the board with its generated schematic, and says so", () => {
    const r = imported(importKicadProject([{ path: "demo.kicad_pcb", data: dividerBoard() }], { built: BOARD_ALL }))
    expect(r.tree).toBeNull()
    expect(r.report.entries.find((e) => e.code === "no-schematic")?.why).toBe("There is no schematic among the files, so the board came with a schematic generated from its nets.")
  })

  it("a board with no footprints and an empty schematic need nothing: slice 3a's own files import", () => {
    const r = imported(importKicadProject(files(board({}), schematic({ version: 20230121 }))))
    expect(r.project.components).toEqual([])
    expect(r.link?.counts).toMatchObject({ footprints: 0, none: 0 })
    expect(r.differences).toEqual([])
  })
})

describe("the project file and the design rules", () => {
  const proJson = (extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      board: { design_settings: { rules: { min_clearance: 0 }, defaults: {}, track_widths: [], via_dimensions: [] } },
      meta: { filename: "demo.kicad_pro", version: 1 },
      net_settings: { classes: [{ name: "Default", clearance: 0.2, track_width: 0.25, via_diameter: 0.6, via_drill: 0.3 }], meta: { version: 3 }, netclass_assignments: null, netclass_patterns: [] },
      schematic: { drawing: { default_line_thickness: 6 }, meta: { version: 1 } },
      sheets: [["uuid", ""]],
      text_variables: {},
      ...extra,
    })
  const run = (more: ProjectFile[], built: ReadonlySet<string> = NO_X10) => importKicadProject(files(dividerBoard(), divider(), more), { built })

  it("reads a project file with only the defaults, and says that its rules are not brought yet", () => {
    const r = imported(run([{ path: "demo.kicad_pro", data: proJson() }]))
    expect(r.pro?.netClasses.map((c) => c.name)).toEqual(["Default"])
    const note = r.report.entries.find((e) => e.code === "rules-in-project-file")!
    expect(note.severity).toBe("note")
    expect(note.why).toBe("The project file's net classes and design rules are read and accounted for, but not brought into the project yet: they are pending the net class and rules extension (X10). The project has the editor's default rules.")
    // the board importer's own note about the rules being in a file it did not read is replaced
    expect(r.report.entries.filter((e) => e.code === "rules-in-project-file")).toHaveLength(1)
  })

  it("net classes beyond the default, nets assigned to them, or custom rules are pending X10: the project is refused until it is built", () => {
    const custom = refused(run([{ path: "demo.kicad_pro", data: proJson({ net_settings: { classes: [{ name: "Default" }, { name: "Power" }], netclass_assignments: { VCC: "Power" }, netclass_patterns: [] } }) }]))
    expect(custom.reason).toBe("unsupported")
    expect(custom.needs.map((n) => [n.ext, n.why])).toEqual([["X10", "1 net class besides the default (Power)"]])
    expect(custom.message).toBe("This project's settings use net classes and design rules beyond the defaults, which are not supported yet. The project is not imported; importing the .kicad_pcb alone gives the board with a schematic generated from its nets.")
    expect(custom.boardAloneImports).toBe(true)
    expect(refused(run([{ path: "demo.kicad_pro", data: proJson({ net_settings: { classes: [{ name: "Default" }], netclass_assignments: { VCC: "Default" } } }) }])).needs[0].why).toBe("nets assigned to net classes")
    expect(refused(run([{ path: "demo.kicad_pro", data: proJson({ net_settings: { classes: [{ name: "Default" }], netclass_patterns: [{ netclass: "A", pattern: "x*" }] } }) }])).needs[0].ext).toBe("X10")
    // built: it imports, and the rest is a note
    const ok = imported(importKicadProject(files(dividerBoard(), divider(), [{ path: "demo.kicad_pro", data: proJson({ net_settings: { classes: [{ name: "Default" }, { name: "Power" }] } }) }]), { built: new Set([...BOARD_ALL, "X10"]) }))
    expect(ok.pro?.netClasses).toHaveLength(2)
  })

  it("rules and sizes that differ from the editor's defaults are pending X10, each named, and the editor's own values are plain", () => {
    const why = (extra: Record<string, unknown>) => refused(run([{ path: "demo.kicad_pro", data: proJson(extra) }])).needs.filter((n) => n.ext === "X10").map((n) => n.why)
    const ds = (over: Record<string, unknown>) => ({ board: { design_settings: { rules: { min_clearance: 0, ...over }, defaults: {}, track_widths: [], via_dimensions: [] } } })
    expect(why(ds({ min_track_width: 0.2 }))[0]).toMatch(/min_track_width/)
    expect(why(ds({ min_via_annular_width: 0.1 }))[0]).toMatch(/min_via_annular_width/)
    const cls = (c: Record<string, unknown>) => ({ net_settings: { classes: [{ name: "Default", clearance: 0.2, track_width: 0.25, via_diameter: 0.6, via_drill: 0.3, ...c }], meta: { version: 3 }, netclass_assignments: null, netclass_patterns: [] } })
    expect(why(cls({ clearance: 0.3 }))[0]).toMatch(/clearance/)
    expect(why(cls({ track_width: 0.4 }))[0]).toMatch(/track_width/)
    expect(why(cls({ via_diameter: 0.8, via_drill: 0.4 }))[0]).toMatch(/via/)
    expect(why({ board: { design_settings: { rules: { min_clearance: 0 }, defaults: {}, track_widths: [0, 0.3], via_dimensions: [] } } })[0]).toMatch(/track/)
    // the editor's own numbers are plain
    expect(imported(run([{ path: "demo.kicad_pro", data: proJson(ds({ min_track_width: 0.15, min_via_annular_width: 0.13 })) }])).status).toBe("imported")
  })

  it("text variables, bus aliases, variants and several sheets in the project file need what they stand for", () => {
    const needs = (j: string) => projectNeeds(readKicadPro(j).pro, null).map((n) => n.ext)
    expect(needs(proJson({ text_variables: { REV: "B" } }))).toEqual(["S4"])
    expect(needs(proJson({ schematic: { bus_aliases: { DATA: { members: ["D0"] } } } }))).toEqual(["S3"])
    expect(needs(proJson({ schematic: { variants: [{ name: "A" }] } }))).toEqual(["S9"])
    expect(needs(proJson({ sheets: [["a", ""], ["b", "Power"]] }))).toEqual(["S1"])
    expect(needs(proJson())).toEqual([])
  })

  it("a damaged project file is named, and so is a file that is not an object", () => {
    expect(() => readKicadPro("")).toThrow(KicadProjectFileError)
    expect(() => readKicadPro("{ not json")).toThrow(/not valid JSON/)
    expect(() => readKicadPro("[1,2]")).toThrow(/not the object a KiCad project file is/)
    const r = refused(run([{ path: "demo.kicad_pro", data: "{ \"board\": " }]))
    expect(r.reason).toBe("unreadable")
    expect(r.message).toMatch(/^demo\.kicad_pro: The project file is not valid JSON/)
  })

  it("a setting this importer does not know refuses the project, naming the key", () => {
    const r = refused(run([{ path: "demo.kicad_pro", data: proJson({ frobnicate: { a: 1 } }) }]))
    expect(r.reason).toBe("unknown")
    expect(r.message).toBe(`This project's settings have something this importer does not know yet: the key "frobnicate" in demo.kicad_pro.`)
  })

  it("every key of a project file is accounted for: not needed with its reason, or pending an extension", () => {
    const a = accountPro(JSON.parse(proJson({ text_variables: { REV: "B" } })))
    expect(a.unknownPaths.size).toBe(0)
    expect(a.pending.get("X10")).toBeGreaterThan(0)
    expect(a.pending.get("S4")).toBeGreaterThan(0)
    expect([...a.notNeeded.keys()]).toContain("the file's own name and version")
    expect([...a.pending.values(), ...a.notNeeded.values()].reduce((x, y) => x + y, 0)).toBe(a.total)
  })

  it("a rules file: comments are cut out, every rule is pending X10, and a damaged file is named", () => {
    const dru = `(version 1)\n# a comment (with a bracket\n(rule "clearance 2"\n  (condition "A.NetClass == 'HV'")\n  (constraint clearance (min 1mm))\n  (severity error))\n`
    expect(stripComments(dru)).not.toContain("a comment")
    expect(stripComments(`(rule "has # inside")`)).toBe(`(rule "has # inside")`)
    const { rules } = readKicadRules(dru)
    expect(rules.version).toBe(1)
    expect(rules.rules.map((r) => [r.name, r.condition, r.severity, r.constraints.map((c) => [c.type, c.min])])).toEqual([["clearance 2", "A.NetClass == 'HV'", "error", [["clearance", "1mm"]]]])
    const a = accountRules(rules.tree)
    expect(a.unknownPaths.size).toBe(0)
    expect(a.pending.get("X10")).toBe(5)
    expect(() => readKicadRules("(rule (")).toThrow(KicadRulesFileError)
    expect(() => readKicadRules("(rule (")).toThrow(/The design rules file is damaged/)
    const r = refused(run([{ path: "demo.kicad_dru", data: dru }]))
    expect(r.needs.map((n) => [n.ext, n.why])).toEqual([["X10", "1 custom design rule"]])
    expect(refused(run([{ path: "demo.kicad_dru", data: "(rule (" }])).reason).toBe("unreadable")
    // a rules file with nothing in it needs nothing
    expect(imported(run([{ path: "demo.kicad_dru", data: "(version 1)" }])).rules?.rules).toEqual([])
  })

  it("a node of a rules file that the table does not know refuses the project", () => {
    const r = refused(run([{ path: "demo.kicad_dru", data: `(version 1) (rule "x" (frobnicate 1))` }]))
    expect(r.reason).toBe("unknown")
    expect(r.message).toContain(`the node "rule>frobnicate" in demo.kicad_dru`)
  })
})

describe("which files are the project's", () => {
  it("takes the board and project file of the same name, and the root schematic of that name", () => {
    const p = pickProjectFiles([
      { path: "other.kicad_pcb", data: "" },
      { path: "demo.kicad_pcb", data: "" },
      { path: "demo.kicad_pro", data: "" },
      { path: "other.kicad_sch", data: "" },
      { path: "demo.kicad_sch", data: "" },
      { path: "sub.kicad_sch", data: "" },
    ])
    expect([p.board?.path, p.pro?.path, p.root?.path]).toEqual(["demo.kicad_pcb", "demo.kicad_pro", "demo.kicad_sch"])
    expect(p.notes).toEqual(["There are 2 boards among the files; demo.kicad_pcb was imported."])
  })

  it("finds the root of a schematic that is not named like the board: the one no other sheet uses", () => {
    const sheetFile = (file: string) => `(kicad_sch (sheet (property "Sheetfile" "${file}")))`
    const p = pickProjectFiles([
      { path: "x/board.kicad_pcb", data: "" },
      { path: "x/child.kicad_sch", data: "(kicad_sch)" },
      { path: "x/top.kicad_sch", data: sheetFile("child.kicad_sch") },
    ])
    expect(p.root?.path).toBe("x/top.kicad_sch")
  })

  it("paths with backslashes and a folder are read as they are", () => {
    const p = pickProjectFiles([
      { path: "proj\\demo.kicad_pcb", data: "" },
      { path: "proj\\demo.kicad_sch", data: "" },
    ])
    expect([p.board?.path, p.root?.path]).toEqual(["proj/demo.kicad_pcb", "proj/demo.kicad_sch"])
  })
})
