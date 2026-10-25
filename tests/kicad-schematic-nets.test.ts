import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { computeConnectivity } from "../src/model/connectivity"
import { schematicPins } from "../src/model/instances"
import { findPart } from "../src/model/library"
import { importKicadSchematic } from "../src/model/kicad/schematic"
import { buildSchematicProject } from "../src/model/kicad/schematic/build"
import { gateSchematic } from "../src/model/kicad/schematic/import"
import { deriveNets } from "./kicad-census/netlist-sch.mjs"
import { LIB_GND, LIB_R, LIB_U, LIB_VCC, divider, schematic, type SchSpec, type SymSpec } from "./kicad-schematic-fixtures"

// The nets check of slice 3a: the nets the editor computes (`computeConnectivity`) over an imported
// schematic equal the nets KiCad would compute, pin by pin. KiCad's are derived from the raw file by
// `tests/kicad-census/netlist-sch.mjs`, which shares no code with the importer (it has its own
// s-expression reader and its own matrices for a symbol's turn and mirror). Slice 3a builds none of
// the extensions every symbol needs (S5, S6, S10), so these files are imported with them raised:
// the project is the one the later slices will build, its symbols held in memory.
//
// Each case also says what the groups are, by hand, so that a turn done the wrong way round cannot
// make both sides agree on nothing.

const BUILT = new Set(["S2", "S5", "S6", "S10"])

const dir = mkdtempSync(join(tmpdir(), "kicad-nets-"))
let counter = 0

function write(text: string): string {
  const d = join(dir, `t${counter++}`)
  mkdirSync(d)
  const file = join(d, "root.kicad_sch")
  writeFileSync(file, text)
  return file
}

interface Groups {
  /** The pins that share a net with another pin, as sorted groups of `REF.pin`, in the editor's reading. */
  mine: string[][]
  /** The same by KiCad's rules, from the raw file. */
  theirs: string[][]
}

const sorted = (groups: string[][]) => groups.map((g) => [...g].sort()).sort((a, b) => a.join().localeCompare(b.join()))

/** Imports a schematic and derives its nets both ways. Power symbols count as pins (`#PWR01.1`). */
function nets(text: string, opts: { hiddenPower?: boolean } = {}): Groups {
  const imported = importKicadSchematic(text, { built: BUILT })
  if (imported.status !== "imported") throw new Error(`not imported: ${imported.status === "refused" ? imported.message : ""}`)
  const { pinNet } = computeConnectivity(imported.project)
  const refOf = new Map(imported.project.components.map((c) => [c.id, c.ref]))
  const uuidOf = new Map([...imported.build.bySymbol].map(([sym, c]) => [c.id, sym.uuid]))
  const byNet = new Map<string, string[]>()
  for (const [key, netId] of pinNet) {
    const at = key.lastIndexOf(":")
    const id = key.slice(0, at)
    if (!refOf.has(id)) continue
    const list = byNet.get(netId) ?? []
    // A pin of another unit is also listed under the component that is the part: one pin, once.
    const pin = `${refOf.get(id)}.${key.slice(at + 1)}`
    if (!list.includes(pin)) list.push(pin)
    byNet.set(netId, list)
  }
  const derived = deriveNets(write(text), { hiddenPower: opts.hiddenPower ?? true, localJoinsGlobal: "same" })
  const refByUuid = new Map([...uuidOf].map(([id, uuid]) => [uuid, refOf.get(id)!]))
  const byGroup = new Map<number, string[]>()
  for (const [key, g] of derived.pins) {
    const [, uuid, pin] = /^\/([^#]+)#(.*)$/.exec(key)!
    for (const x of ([] as number[]).concat(g)) (byGroup.get(x) ?? byGroup.set(x, []).get(x)!).push(`${refByUuid.get(uuid)}.${pin}`)
  }
  return { mine: sorted([...byNet.values()].filter((l) => l.length > 1)), theirs: sorted([...byGroup.values()].filter((l) => l.length > 1)) }
}

const R = (ref: string, at: string, n: number, extra: Partial<SymSpec> = {}): SymSpec => ({ lib: "Device:R", at, ref, uuid: `22222222-0000-4000-8000-0000000000${String(n).padStart(2, "0")}`, ...extra })
const U = (ref: string, at: string, n: number, extra: Partial<SymSpec> = {}): SymSpec => ({ lib: "Test:U", at, ref, uuid: `33333333-0000-4000-8000-0000000000${String(n).padStart(2, "0")}`, ...extra })
const P = (lib: "power:GND" | "power:VCC", ref: string, at: string, n: number, extra: Partial<SymSpec> = {}): SymSpec => ({ lib, at, ref, uuid: `44444444-0000-4000-8000-0000000000${String(n).padStart(2, "0")}`, ...extra })

/** A case: the file, and the groups it must have. */
function expectNets(spec: SchSpec, groups: string[][], opts?: { hiddenPower?: boolean }) {
  const r = nets(schematic({ libs: [LIB_R, LIB_U, LIB_GND, LIB_VCC], ...spec }), opts)
  expect(r.theirs).toEqual(sorted(groups))
  expect(r.mine).toEqual(r.theirs)
}

describe("the nets of an imported schematic are KiCad's", () => {
  it("a divider with a junction, a label and two power symbols", () => {
    const r = nets(divider())
    expect(r.mine).toEqual(r.theirs)
    expect(r.mine).toEqual(sorted([["#PWR01.1", "R1.1"], ["R1.2", "R2.1"], ["#PWR02.1", "R2.2"]]))
  })

  for (const version of [20211123, 20230121, 20231120, 20250114, 20250227, 20260306]) {
    it(`reads the divider of stamp ${version} to the same nets`, () => {
      const r = nets(divider(version))
      expect(r.mine).toEqual(r.theirs)
      expect(r.mine.length).toBe(3)
    })
  }

  it("a quarter turn is counter-clockwise on screen: pin 1 of a symbol turned 90 degrees is to its left", () => {
    // R at (100,100) turned 90: pin 1 at (96.19,100), pin 2 at (103.81,100). R turned 270 at (120,100): pin 1 at (123.81,100), pin 2 at (116.19,100).
    expectNets({ symbols: [R("R1", "100 100 90", 1), R("R2", "120 100 270", 2)], wires: ["103.81 100 116.19 100"] }, [["R1.2", "R2.2"]])
  })

  it("a half turn puts pin 1 below", () => {
    // R at (100,100) turned 180: pin 1 at (100,103.81), pin 2 at (100,96.19). R unturned at (100,120): pin 1 at (100,116.19).
    expectNets({ symbols: [R("R1", "100 100 180", 1), R("R2", "100 120 0", 2)], wires: ["100 103.81 100 116.19"] }, [["R1.1", "R2.1"]])
  })

  it("a mirror about x flips the symbol top to bottom, a mirror about y left to right, after the turn", () => {
    // U1 mirrored about x at (100,100): input A at (93.65,102.54), output Y at (106.35,102.54).
    // U2 mirrored about y at (130,100): input A at (136.35,97.46), output Y at (123.65,97.46).
    expectNets(
      { symbols: [U("U1", "100 100 0", 1, { mirror: "x" }), U("U2", "130 100 0", 2, { mirror: "y" })], wires: ["106.35 102.54 115 102.54", "115 102.54 115 97.46", "115 97.46 123.65 97.46"] },
      [["U1.2", "U2.2"]],
    )
  })

  it("mirror and turn together: the turn is done first, then the mirror", () => {
    // U at (100,100) turned 90 and mirrored about x: output Y (lib 6.35,2.54) is turned to (-2.54,-6.35) on the y-down sheet and then mirrored to (-2.54,6.35): (97.46,106.35).
    // Mirrored before the turn it would be at (102.54,106.35), where nothing is.
    expectNets({ symbols: [U("U1", "100 100 90", 1, { mirror: "x" }), R("R1", "97.46 130 0", 2)], wires: ["97.46 106.35 97.46 126.19"] }, [["R1.1", "U1.2"]])
  })

  it("a junction on the body of a wire joins the wires that cross it, and wires that cross with none stay apart", () => {
    // A vertical wire x=100 from 80 to 120 between R1.1 (100,76.19... ) and a horizontal one y=100 between two more resistors turned 90.
    const common = { libs: [LIB_R, LIB_U, LIB_GND, LIB_VCC] }
    const base = {
      ...common,
      symbols: [R("R1", "100 72.19 0", 1), R("R2", "100 127.81 180", 2), R("R3", "76.19 100 90", 3), R("R4", "123.81 100 270", 4)],
      wires: ["100 76 100 124", "80 100 120 100"],
    }
    // pin positions: R1.2 at (100,76), R2.2 at (100,124), R3.2 at (80,100), R4.2 at (120,100)
    const apart = nets(schematic(base))
    expect(apart.mine).toEqual(apart.theirs)
    expect(apart.mine).toEqual(sorted([["R1.2", "R2.2"], ["R3.2", "R4.2"]]))
    const joined = nets(schematic({ ...base, junctions: ["100 100"] }))
    expect(joined.mine).toEqual(joined.theirs)
    expect(joined.mine).toEqual(sorted([["R1.2", "R2.2", "R3.2", "R4.2"]]))
  })

  it("a pin on a wire's body joins it only through a junction", () => {
    // R1 turned 90 at (100,100): pin 2 at (103.81,100); the wire runs along y=100 from 90 to 130, R2 at its end.
    const wires = ["90 100 130 100"]
    const symbols = [R("R1", "100 100 90", 1), R("R2", "133.81 100 90", 2)]
    const without = nets(schematic({ libs: [LIB_R], symbols, wires }))
    expect(without.mine).toEqual(without.theirs)
    // R1's pin 1 at (96.19,100) and pin 2 at (103.81,100) are both on the wire's body: neither is joined without a junction; R2.1 (130,100) is the wire's end.
    expect(without.mine).toEqual([])
    const withJunctions = nets(schematic({ libs: [LIB_R], symbols, wires, junctions: ["96.19 100", "103.81 100"] }))
    expect(withJunctions.mine).toEqual(withJunctions.theirs)
    expect(withJunctions.mine).toEqual(sorted([["R1.1", "R1.2", "R2.1"]]))
  })

  it("a label on the body of a wire names the wire", () => {
    expectNets(
      { symbols: [R("R1", "100 100 0", 1), R("R2", "100 130 0", 2)], wires: ["100 103.81 100 126.19"], labels: ["SIG 100 115 0", "SIG 140 140 0", "OTHER 140 150 0"] },
      [["R1.2", "R2.1"]],
    )
  })

  it("two labels of one name on a sheet are one net, and a local label of a power net's name joins it", () => {
    expectNets(
      { symbols: [R("R1", "100 100 0", 1), R("R2", "130 100 0", 2), P("power:GND", "#PWR01", "160 100", 3), R("R3", "160 90 0", 4)], wires: ["100 103.81 100 110", "130 103.81 130 110", "160 100 160 93.81"], labels: ["N 100 110 0", "N 130 110 0", "GND 140 120 0"] },
      [
        ["R1.2", "R2.2"],
        ["#PWR01.1", "R3.2"],
      ],
    )
  })

  it("a local label of the power net's name joins that net: GND on a wire to R1 and a GND symbol are one net", () => {
    expectNets(
      { symbols: [R("R1", "100 100 0", 1), P("power:GND", "#PWR01", "160 100", 2)], wires: ["100 103.81 100 110"], labels: ["GND 100 110 0"] },
      [["#PWR01.1", "R1.2"]],
    )
  })

  it("a pin of the type no connect is on no net, whatever is drawn to it", () => {
    // U1's no-connect pin 3 at (100,106.35) is wired to R1's pin 1; R1 pin 2 goes on to GND. Pin 3 is not in the net.
    expectNets(
      { symbols: [U("U1", "100 100 0", 1), R("R1", "100 114.16 0", 2), P("power:GND", "#PWR01", "100 130", 3)], wires: ["100 106.35 100 110.35", "100 117.97 100 130"] },
      [["#PWR01.1", "R1.2"]],
    )
  })

  it("a power symbol turned a quarter turn keeps its pin where KiCad has it", () => {
    expectNets(
      { symbols: [R("R1", "100 100 0", 1), P("power:VCC", "#PWR01", "100 90 90", 2), P("power:GND", "#PWR02", "100 120 180", 3), R("R2", "100 110 0", 4)], wires: ["100 90 100 96.19", "100 103.81 100 106.19", "100 113.81 100 120"] },
      [
        ["#PWR01.1", "R1.1"],
        ["R1.2", "R2.1"],
        ["#PWR02.1", "R2.2"],
      ],
    )
  })

  it("a wire that stops at a pin and a wire that starts there are one", () => {
    expectNets({ symbols: [R("R1", "100 100 0", 1), R("R2", "100 120 0", 2)], wires: ["100 103.81 100 110", "100 110 100 116.19"] }, [["R1.2", "R2.1"]])
  })
})

const LIB_QUAD = `(symbol "Test:Quad" (in_bom yes) (on_board yes)
  (property "Reference" "U" (at 0 0 0) (effects (font (size 1.27 1.27))))
  (property "Value" "Quad" (at 0 0 0) (effects (font (size 1.27 1.27))))
  (symbol "Quad_1_1" (pin input line (at -5.08 0 0) (length 2.54) (name "A1") (number "1")) (pin output line (at 5.08 0 180) (length 2.54) (name "Y1") (number "2")))
  (symbol "Quad_2_1" (pin input line (at -5.08 0 0) (length 2.54) (name "A2") (number "3")) (pin output line (at 5.08 0 180) (length 2.54) (name "Y2") (number "4")))
  (symbol "Quad_0_1" (pin power_in line (at 0 5.08 270) (length 2.54) (name "V+") (number "8")))
  (symbol "Quad_1_2" (pin input line (at -5.08 2.54 0) (length 2.54) (name "A1d") (number "1")) (pin output line (at 5.08 2.54 180) (length 2.54) (name "Y1d") (number "2"))))`

const LIB_STACK = `(symbol "Test:Stack" (in_bom yes) (on_board yes)
  (property "Reference" "J" (at 0 0 0) (effects (font (size 1.27 1.27))))
  (property "Value" "Stack" (at 0 0 0) (effects (font (size 1.27 1.27))))
  (symbol "Stack_1_1" (pin passive line (at 0 0 0) (length 2.54) (name "G") (number "[1-3]")) (pin passive line (at 0 -2.54 0) (length 2.54) (name "S") (number "4"))))`

describe("what only a part with units, a body style or stacked pins has", () => {
  it("the units of one part are placed apart, each with its own pins and the pins every unit shares", () => {
    // U1 unit 1 at (100,100): A1 (94.92,100), Y1 (105.08,100), V+ (100,94.92); unit 2 at (100,120): A2 (94.92,120), Y2 (105.08,120), V+ (100,114.92)
    expectNets(
      {
        libs: [LIB_R, LIB_QUAD],
        symbols: [
          { lib: "Test:Quad", at: "100 100", ref: "U1", unit: 1, uuid: "66666666-0000-4000-8000-000000000001" },
          { lib: "Test:Quad", at: "100 120", ref: "U1", unit: 2, uuid: "66666666-0000-4000-8000-000000000002" },
          R("R1", "120 110 0", 1),
        ],
        wires: ["105.08 100 120 100", "120 100 120 106.19", "105.08 120 120 120", "120 120 120 113.81"],
      },
      [["R1.1", "U1.2"], ["R1.2", "U1.4"]].map((g) => g),
    )
  })

  it("a symbol in its second body style has the pins of that style", () => {
    // A1d at (94.92,97.46), Y1d at (105.08,97.46) in body style 2, where body style 1 has them at y 100
    const text = schematic({
      libs: [LIB_R, LIB_QUAD],
      symbols: [{ lib: "Test:Quad", at: "100 100", ref: "U1", uuid: "66666666-0000-4000-8000-000000000001", extra: "(convert 2)" }, R("R1", "120 97.46 90", 1)],
      wires: ["105.08 97.46 116.19 97.46"],
    })
    const r = nets(text)
    expect(r.mine).toEqual(r.theirs)
    expect(r.mine).toEqual(sorted([["R1.1", "U1.2"]]))
  })

  it("stacked pins are one place with several numbers: they share a net", () => {
    // [1-3] at (100,100) and S at (100,102.54)
    const text = schematic({
      libs: [LIB_R, LIB_STACK],
      symbols: [{ lib: "Test:Stack", at: "100 100", ref: "J1", uuid: "66666666-0000-4000-8000-000000000001" }, R("R1", "130 100 90", 1)],
      wires: ["100 100 126.19 100"],
    })
    const r = nets(text)
    expect(r.mine).toEqual(r.theirs)
    expect(r.mine).toEqual(sorted([["J1.1", "J1.2", "J1.3", "R1.1"]]))
  })
})

/** What the build finds that the model cannot hold, with the extensions in `built` raised for the build only (the gate passes with all of them). */
function lossyOf(text: string, built: ReadonlySet<string>) {
  const gate = gateSchematic(text, { built: new Set(["S2", "S4", "S5", "S6", "S10"]) })
  if ("refused" in gate) throw new Error(gate.refused.message)
  return buildSchematicProject(gate.gate.tree, gate.gate.report, { built }).lossy.map((n) => [n.ext, n.why])
}

/** The name of the net each pin is on, `REF.pin` to the name: the editor's, and KiCad's by the raw file. */
function names(text: string): { mine: Record<string, string>; theirs: Record<string, string | null> } {
  const imported = importKicadSchematic(text, { built: BUILT })
  if (imported.status !== "imported") throw new Error(`not imported: ${imported.status === "refused" ? imported.message : ""}`)
  const { pinNet, nets: list } = computeConnectivity(imported.project)
  const byId = new Map(list.map((n) => [n.id, n.name]))
  const refOf = new Map(imported.project.components.map((c) => [c.id, c.ref]))
  const uuidOf = new Map([...imported.build.bySymbol].map(([sym, c]) => [c.id, sym.uuid]))
  const mine: Record<string, string> = {}
  const derived = deriveNets(write(text), { hiddenPower: true, localJoinsGlobal: "same" })
  const theirs: Record<string, string | null> = {}
  for (const [key, netId] of pinNet) {
    const at = key.lastIndexOf(":")
    const id = key.slice(0, at)
    if (!refOf.has(id) || !byId.has(netId)) continue
    const pin = `${refOf.get(id)}.${key.slice(at + 1)}`
    mine[pin] = byId.get(netId)!
    const g = ([] as number[]).concat(derived.pins.get(`/${uuidOf.get(id)}#${key.slice(at + 1)}`) ?? [])[0]
    theirs[pin] = g === undefined ? null : derived.netName(g)
  }
  return { mine, theirs }
}

describe("the names KiCad gives nets, by the driver of the highest priority", () => {
  const R1 = R("R1", "100 100 0", 1)
  const wire = ["100 103.81 100 120"]

  it("a power symbol beats a label: the net is GND, not CONN_GND and not /CONN_GND", () => {
    const text = schematic({ libs: [LIB_R, LIB_GND], symbols: [R1, P("power:GND", "#PWR01", "100 120", 2)], wires: wire, labels: ["CONN_GND 100 110 0"] })
    const r = names(text)
    expect(r.mine["R1.2"]).toBe("GND")
    expect(r.mine).toEqual(Object.fromEntries(Object.entries(r.theirs).filter(([k]) => k in r.mine)))
  })

  it("a global label beats a local one, and a local label is named with its sheet's path", () => {
    const global = `(global_label "ZG" (shape input) (at 100 115 0) (effects (font (size 1.27 1.27)) (justify left)) (uuid g1))`
    const text = schematic({ libs: [LIB_R], symbols: [R1], wires: wire, labels: ["AL 100 110 0"], body: [global] })
    const r = names(text)
    expect(r.mine["R1.2"]).toBe("ZG")
    expect(r.theirs["R1.2"]).toBe("ZG")
    const local = names(schematic({ libs: [LIB_R], symbols: [R1], wires: wire, labels: ["AL 100 110 0"] }))
    expect(local.mine["R1.2"]).toBe("/AL")
    expect(local.theirs["R1.2"]).toBe("/AL")
  })

  it("two labels of different names tie on name order: the one that sorts first", () => {
    const r = names(schematic({ libs: [LIB_R], symbols: [R1], wires: wire, labels: ["B_NET 100 110 0", "A_NET 100 115 0"] }))
    expect(r.mine["R1.2"]).toBe("/A_NET")
    expect(r.theirs["R1.2"]).toBe("/A_NET")
  })

  it("a net nothing names is named after a pin: Net-(R1-Pad2), unconnected-(R1-Pad2) for one pin alone, and a pin's own name when it has one", () => {
    const two = names(schematic({ libs: [LIB_R], symbols: [R1, R("R2", "100 120 0", 2)], wires: ["100 103.81 100 116.19"] }))
    expect(two.mine["R1.2"]).toBe("Net-(R1-Pad2)")
    expect(two.theirs["R1.2"]).toBe("Net-(R1-Pad2)")
    const lone = names(schematic({ libs: [LIB_R], symbols: [R1], wires: ["100 103.81 100 110"] }))
    expect(lone.mine["R1.2"]).toBe("unconnected-(R1-Pad2)")
    expect(lone.theirs["R1.2"]).toBe("unconnected-(R1-Pad2)")
    const named = names(schematic({ libs: [LIB_R, LIB_U], symbols: [R1, U("U1", "140 100 0", 3)], wires: ["100 103.81 100 110", "100 110 133.65 110", "133.65 110 133.65 97.46"] }))
    // pin 1 of U1 is `A`: the net is named after it (R1's pin has no name of its own, so its name has -Pad in it and loses)
    expect(Object.values(named.mine)).toContain("Net-(U1-A)")
    expect(named.mine).toEqual(Object.fromEntries(Object.entries(named.theirs).filter(([k]) => k in named.mine)))
  })

  it("KiCad 6 names every pin -PadN", () => {
    const text = schematic({ version: 20211123, libs: [LIB_R, LIB_U], symbols: [R1, U("U1", "140 100 0", 3)], wires: ["100 103.81 100 110", "100 110 133.65 110", "133.65 110 133.65 97.46"] })
    const r = names(text)
    expect(Object.values(r.mine)).toContain("Net-(R1-Pad2)")
    expect(Object.values(r.mine).some((n) => /U1-A/.test(n))).toBe(false)
    expect(importKicadSchematic(text, { built: BUILT }).status === "imported" && (importKicadSchematic(text, { built: BUILT }) as { project: { netNames?: string } }).project.netNames).toBe("kicad6")
  })

  it("an empty power Value names nothing, which KiCad shows as <NO NET>", () => {
    const r = names(schematic({ version: 20250114, libs: [LIB_R, LIB_GND], symbols: [R1, P("power:GND", "#PWR01", "100 120", 2, { value: "" })], wires: wire }))
    expect(r.mine["R1.2"]).toBe("<NO NET>")
  })
})

describe("what the editor joins that KiCad does not, or the other way, is the connectivity extension (S11) or another, never an approximation", () => {
  const refusal = (text: string, built: ReadonlySet<string> = BUILT) => {
    const r = importKicadSchematic(text, { built })
    if (r.status !== "refused") throw new Error("imported")
    return r
  }
  const S11 = "This schematic uses KiCad's rules for what a wire joins (a wire end on a wire's side, a label on a pin, points a hair apart), which are not supported yet."

  it("a wire end on another wire's side with no junction", () => {
    const text = schematic({ libs: [LIB_R], symbols: [R("R1", "100 100 0", 1)], wires: ["80 120 120 120", "100 103.81 100 120"] })
    const r = refusal(text)
    expect([r.reason, r.message]).toEqual(["unsupported", S11])
    expect(lossyOf(text, BUILT).map(([, why]) => why)).toContain("a wire end that touches another wire's side with no junction")
  })

  it("two points closer together than the editor can tell apart", () => {
    const text = schematic({ libs: [LIB_R], symbols: [R("R1", "100 100 0", 1)], wires: ["100 103.81 100 110", "100.001 103.81 100.001 120"] })
    expect(lossyOf(text, BUILT).map(([, why]) => why)).toContain("two points closer together than the editor can tell apart")
  })

  it("a label on a pin that lies on a wire's side: KiCad attaches it to the pin alone", () => {
    // R1 turned 90 at (100,100): pin 1 at (96.19,100) is on the side of a wire from 90 to 110, and the label sits on the pin.
    const text = schematic({ libs: [LIB_R], symbols: [R("R1", "100 100 90", 1)], wires: ["90 100 110 100"], labels: ["SIG 96.19 100 0"] })
    expect(lossyOf(text, BUILT).map(([, why]) => why)).toContain("a label on a pin that lies on a wire's side, which the editor joins to the wire and KiCad does not")
    // with a junction there KiCad joins the wire to the pin, and the label is with both: nothing differs
    expect(importKicadSchematic(schematic({ libs: [LIB_R], symbols: [R("R1", "100 100 90", 1)], wires: ["90 100 110 100"], junctions: ["96.19 100"], labels: ["SIG 96.19 100 0"] }), { built: BUILT }).status).toBe("imported")
  })

  it("a wire end or a label a hair's breadth from a wire, which the editor joins within 1.27 um", () => {
    const wire = schematic({ libs: [LIB_R], symbols: [R("R1", "100 100 0", 1)], wires: ["80 120 120 120", "100 103.81 100 119.9999"] })
    expect(lossyOf(wire, BUILT).map(([, why]) => why)).toContain("a wire end a hair's breadth from another wire, which the editor joins and KiCad does not")
    const label = schematic({ libs: [LIB_R], symbols: [R("R1", "100 100 0", 1)], wires: ["100 103.81 100 120"], labels: ["SIG 100.0009 110 0"] })
    expect(lossyOf(label, BUILT).map(([, why]) => why)).toContain("a label a hair's breadth from a wire, which the editor joins and KiCad does not")
  })

  const hidden = `(symbol "Test:H" (in_bom yes) (on_board yes)
      (property "Reference" "U" (at 0 0 0) (effects (font (size 1.27 1.27))))
      (property "Value" "H" (at 0 0 0) (effects (font (size 1.27 1.27))))
      (symbol "H_1_1" (pin power_in line (at 0 0 90) (length 2.54) hide (name "VDD" (effects (font (size 1.27 1.27)))) (number "1" (effects (font (size 1.27 1.27)))))))`

  it("a hidden power-input pin is on the global net of its name: the nets are KiCad's, hidden pin included", () => {
    const text = schematic({
      libs: [hidden],
      symbols: [
        { lib: "Test:H", at: "100 100 0", ref: "U1", uuid: "55555555-0000-4000-8000-000000000001" },
        { lib: "Test:H", at: "100 120 0", ref: "U2", uuid: "55555555-0000-4000-8000-000000000002" },
      ],
    })
    expect(lossyOf(text, new Set(["S2", "S5", "S6", "S10"])).filter(([ext]) => ext === "S5")).toEqual([])
    // the editor does it by the pin itself: no label is made
    expect(importKicadSchematic(text, { built: BUILT }).status === "imported" && (importKicadSchematic(text, { built: BUILT }) as { project: { labels: unknown[] } }).project.labels).toEqual([])
    const r2 = nets(text, { hiddenPower: true })
    expect(r2.theirs).toEqual([["U1.1", "U2.1"]])
    expect(r2.mine).toEqual(r2.theirs)
  })
})

describe("the unit of a use, and the name of a power symbol, are KiCad's", () => {
  const LIB_QUAD2 = `(symbol "Test:Dual" (in_bom yes) (on_board yes)
    (property "Reference" "U" (at 0 0 0) (effects (font (size 1.27 1.27))))
    (property "Value" "Dual" (at 0 0 0) (effects (font (size 1.27 1.27))))
    (symbol "Dual_1_1" (pin input line (at -5.08 0 0) (length 2.54) (name "A1") (number "1")))
    (symbol "Dual_2_1" (pin input line (at -5.08 0 0) (length 2.54) (name "A2") (number "2")))
    (symbol "Dual_3_1" (pin input line (at -5.08 0 0) (length 2.54) (name "A3") (number "3"))))`

  it("a symbol whose own (unit 1) says one thing and whose instance says unit 3 has the pins of unit 3, in the importer and in the derivation", () => {
    const text = schematic({
      libs: [LIB_R, LIB_QUAD2],
      symbols: [{ lib: "Test:Dual", at: "100 100 0", ref: "U1", unit: 1, instanceUnit: 3, uuid: "66666666-0000-4000-8000-000000000001" }, R("R1", "130 100 90", 1)],
      wires: ["94.92 100 126.19 100"],
    })
    // pin 3 is at (94.92,100) and R1's pin 1 at (126.19,100)
    for (const version of [20211123, 20230121]) {
      const r = nets(text.replace(/\(version \d+\)/, `(version ${version})`).replace(/^/, ""))
      expect(r.theirs).toEqual([["R1.1", "U1.3"]])
      expect(r.mine).toEqual(r.theirs)
    }
  })

  it("a global power symbol is named by its hidden pin before 20230221, and by its Value from it, and an empty Value stays empty", () => {
    const name = (version: number, value: string) => {
      const text = schematic({ version, libs: [LIB_VCC], symbols: [P("power:VCC", "#PWR01", "100 100", 1, { value })] })
      const r = importKicadSchematic(text, { built: new Set(["S5", "S6", "S10"]) })
      return r.status === "imported" ? r.project.components[0].props.net : r.report.entries.map((e) => e.why).join(" ")
    }
    expect(name(20211123, "FOO")).toBe("VCC")
    expect(name(20221004, "FOO")).toBe("VCC")
    expect(name(20230221, "FOO")).toBe("FOO")
    expect(name(20250114, "FOO")).toBe("FOO")
    // the derivation agrees at both ends
    for (const [version, expected] of [[20211123, "VCC"], [20230221, "FOO"]] as const) {
      const text = schematic({ version, libs: [LIB_VCC], symbols: [P("power:VCC", "#PWR01", "100 100", 1, { value: "FOO" })] })
      expect([...deriveNets(write(text), {}).driver.values()].map((d) => d.name)).toEqual([expected])
    }
    // from 20230221 an empty Value is an empty name, not the pin's
    expect(name(20250114, "")).toBe("")
  })
})

describe("the parts the build makes", () => {
  it("every pin the editor draws is where KiCad has it, and the power symbols are the editor's own ports", () => {
    const imported = importKicadSchematic(divider(), { built: BUILT })
    if (imported.status !== "imported") throw new Error("not imported")
    const power = imported.project.components.filter((c) => findPart(c.partId)?.powerNet)
    expect(power.map((c) => c.props.net).sort()).toEqual(["GND", "VCC"])
    const r1 = imported.project.components.find((c) => c.ref === "R1")!
    const pins = schematicPins(r1).map((p) => [p.pin, p.pos.x, p.pos.y])
    // R1 at (50.8, 50.8) mm: pin 1 3.81 mm above, pin 2 3.81 mm below; 12.7 mm is one editor unit and y is up.
    expect(pins).toEqual([
      ["1", 4, -3.7],
      ["2", 4, -4.3],
    ])
  })
})

describe("a local power symbol (KiCad 9 `(power local)`) is a net of its sheet, written with the sheet's path", () => {
  const LIB_VCC_LOCAL = LIB_VCC.replace("(power)", "(power local)")
  const flat = () => schematic({ version: 20250318, libs: [LIB_R, LIB_VCC_LOCAL], symbols: [R("R1", "100 100 0", 1), P("power:VCC", "#PWR01", "100 96.19", 2)] })

  it("a flat sheet: the pins are on one net in both readings, and the name is `/VCC`, not `VCC`", () => {
    const text = flat()
    expect(nets(text).mine).toEqual(nets(text).theirs)
    const r = names(text)
    expect(r.mine["R1.1"]).toBe("/VCC")
    expect(r.theirs["R1.1"]).toBe("/VCC")
    // the same symbol as a global power symbol is named VCC in both
    const global = schematic({ version: 20250318, libs: [LIB_R, LIB_VCC], symbols: [R("R1", "100 100 0", 1), P("power:VCC", "#PWR01", "100 96.19", 2)] })
    expect(names(global).mine["R1.1"]).toBe("VCC")
  })

  it("two sheets that each have a local VCC are two nets; with global VCC they are one", () => {
    const groups = (lib: string) => {
      const sheet = `(sheet (at 10 10) (size 20 10) (uuid 77777777-0000-4000-8000-000000000001) (property "Sheetname" "Child" (at 0 0 0)) (property "Sheetfile" "child.kicad_sch" (at 0 0 0)))`
      const root = schematic({ version: 20250318, libs: [LIB_R, lib], symbols: [R("R1", "100 100 0", 1), P("power:VCC", "#PWR01", "100 96.19", 2)], body: [sheet] })
      const child = schematic({ version: 20250318, libs: [LIB_R, lib], uuid: "77777777-0000-4000-8000-000000000001", symbols: [R("R2", "100 100 0", 3), P("power:VCC", "#PWR02", "100 96.19", 4)] })
      const file = write(root)
      writeFileSync(join(dirname(file), "child.kicad_sch"), child)
      const d = deriveNets(file, { hiddenPower: true, localJoinsGlobal: "same" })
      const of = (uuid: string) => [...d.pins].find(([k]) => k.includes(`${uuid}#1`))![1]
      return [of("22222222-0000-4000-8000-000000000001"), of("22222222-0000-4000-8000-000000000003")]
    }
    const [a, b] = groups(LIB_VCC_LOCAL)
    expect(a).not.toEqual(b)
    const [c, d] = groups(LIB_VCC)
    expect(c).toEqual(d)
  })
})
