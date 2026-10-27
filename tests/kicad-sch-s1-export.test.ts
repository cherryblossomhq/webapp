import { describe, expect, it } from "vitest"
import { computeConnectivity } from "../src/model/connectivity"
import { importKicadSchematic } from "../src/model/kicad/schematic"
import { kicadFiles } from "../src/export/kicad"
import { flattenHierarchy } from "../src/export/flatten"
import type { Project } from "../src/model/types"
import { LIB_GND, LIB_R, ROOT_UUID, schematic } from "./kicad-schematic-fixtures"

// S1 export blockers: a hierarchy drawn in the editor (no `netNames`) keeps its hierarchical labels and its local power symbols.

const CHILD = "00000000-0000-4000-8000-0000000000c1"
const UA = "00000000-0000-4000-8000-0000000000a1"
const UB = "00000000-0000-4000-8000-0000000000a2"
const VERSION = 20250318
const LIB_GNDL = LIB_GND.replace('"power:GND" (power)', '"power:GNDL" (power local)').replace(/"GND_/g, '"GNDL_').replace('"Value" "GND"', '"Value" "GNDL"')

const sheet = (uuid: string, name: string, y: number, page: string) =>
  `(sheet (at 60.96 ${y}) (size 20.32 10.16) (fields_autoplaced yes) (stroke (width 0.1524) (type solid)) (fill (color 0 0 0 0.0000)) (uuid ${uuid})
    (property "Sheetname" "${name}" (at 60.96 ${y - 0.7} 0) (effects (font (size 1.27 1.27)) (justify left bottom)))
    (property "Sheetfile" "child.kicad_sch" (at 60.96 ${y + 11} 0) (effects (font (size 1.27 1.27)) (justify left top)))
    (pin "VIN" input (at 60.96 ${y + 5.08} 180) (effects (font (size 1.27 1.27)) (justify left)) (uuid p-${name}))
    (instances (project "demo" (path "/${ROOT_UUID}" (page "${page}")))))`

/** A root with R1 wired to the VIN pin of sheet A, and a child with R9 (VIN on its pin 1, a local GNDL on its pin 2) used as A and B. */
function hierarchy(childLabel: "hierarchical" | "local" = "hierarchical", withGlobal = false) {
  const root = schematic({
    version: VERSION,
    libs: [LIB_R, LIB_GND],
    symbols: [{ lib: "Device:R", at: "50.8 50.8", ref: "R1", uuid: "aaaaaaaa-0000-4000-8000-000000000001" }],
    wires: ["50.8 54.61 50.8 66.04", "50.8 66.04 60.96 66.04"],
    body: [sheet(UA, "A", 60.96, "2"), sheet(UB, "B", 90, "3")],
  })
  const label = childLabel === "hierarchical" ? `(hierarchical_label "VIN" (shape input) (at 50.8 46.99 0) (effects (font (size 1.27 1.27)) (justify left)) (uuid hl1))` : `(label "VIN" (at 50.8 46.99 0) (effects (font (size 1.27 1.27)) (justify left bottom)) (uuid hl1))`
  const child = schematic({
    version: VERSION,
    uuid: CHILD,
    libs: [LIB_R, LIB_GNDL, LIB_GND],
    symbols: [
      { lib: "Device:R", at: "50.8 50.8", ref: "R9", uuid: "bbbbbbbb-0000-4000-8000-000000000001", instances: [`/${ROOT_UUID}/${UA}|R2`, `/${ROOT_UUID}/${UB}|R3`] },
      { lib: "power:GNDL", at: "50.8 54.61", ref: "#PWR01", uuid: "bbbbbbbb-0000-4000-8000-000000000002", instances: [`/${ROOT_UUID}/${UA}|#PWR01`, `/${ROOT_UUID}/${UB}|#PWR02`] },
      ...(withGlobal ? [{ lib: "power:GND", at: "76.2 54.61", ref: "#PWR03", uuid: "bbbbbbbb-0000-4000-8000-000000000003", instances: [`/${ROOT_UUID}/${UA}|#PWR03`, `/${ROOT_UUID}/${UB}|#PWR04`] }] : []),
    ],
    body: [label],
  })
  return new Map([["root.kicad_sch", root], ["child.kicad_sch", child]])
}

function load(files: Map<string, string>, root = "root.kicad_sch"): Project {
  const r = importKicadSchematic({ files, root })
  if (r.status !== "imported") throw new Error(`refused: ${r.message}\n${r.report.entries.map((e) => `${e.code}: ${e.why}`).join("\n")}`)
  return r.project
}

/** What the editor makes of a hierarchy: no `netNames`, which only a KiCad import sets. */
function drawnInEditor(files: Map<string, string>): Project {
  const { netNames: _gone, ...rest } = load(files)
  void _gone
  return rest as Project
}

const netNamesOf = (p: Project) => computeConnectivity(p).nets.map((n) => n.name).filter((n) => /GNDL/.test(n)).sort()
const schFiles = (out: Awaited<ReturnType<typeof kicadFiles>>) => new Map(Object.entries(out.files).filter(([n]) => n.endsWith(".kicad_sch")))
// The sheet used as A and B is written to a file named after its first use.
const rootOf = (m: Map<string, string>) => [...m.keys()].find((n) => n !== "A.kicad_sch")!

describe("S1 export: a hierarchy drawn in the editor keeps its hierarchy", () => {
  it("the project has no netNames and two local GNDL nets, one per use", () => {
    const p = drawnInEditor(hierarchy())
    expect(p.netNames).toBeUndefined()
    expect(netNamesOf(p)).toEqual(["/A/GNDL", "/B/GNDL"])
  })

  it("writes the child's VIN as a hierarchical_label, never a global_label, and re-imports with the sheet pin joined to R1", async () => {
    const p = drawnInEditor(hierarchy())
    const files = schFiles(await kicadFiles(p))
    const child = files.get("A.kicad_sch")!
    expect(child).toMatch(/\(hierarchical_label "VIN"/)
    for (const [, text] of files) expect(text).not.toMatch(/\(global_label/)
    const back = load(files, rootOf(files))
    expect(back.labels.map((l) => l.kind)).toEqual(["hierarchical"])
    const { nets } = computeConnectivity(back)
    const vin = nets.find((n) => n.name === "/A/VIN")!
    expect(vin.pins.map((x) => back.components.find((c) => c.id === x.componentId)!.ref).sort()).toEqual(["R1", "R2"])
  })

  it("writes a local label as a local label", async () => {
    const files = schFiles(await kicadFiles(drawnInEditor(hierarchy("local"))))
    const child = files.get("A.kicad_sch")!
    expect(child).toMatch(/\n {2}\(label "VIN"/)
    expect(child).not.toMatch(/hierarchical_label|global_label/)
  })
})

describe("S1 export: a local power symbol stays local", () => {
  it("writes (power local) for the lib symbol, and the uses stay two nets after a re-import", async () => {
    const p = drawnInEditor(hierarchy())
    const files = schFiles(await kicadFiles(p))
    const child = files.get("A.kicad_sch")!
    expect(child).toMatch(/\(power local\)/)
    expect(child).not.toMatch(/\(power global\)/)
    // KiCad 10 is the first version with (power local), so every sheet file carries its stamp, and the globals are bare.
    for (const text of files.values()) expect(text).toMatch(/\(version 20250227\)/)
    expect([...files.values()].join("").match(/\(power[^)]*\)/g)!.every((t) => t === "(power)" || t === "(power local)")).toBe(true)
    expect((await kicadFiles(p)).notes.some((n) => /needs KiCad 10|only KiCad 10/.test(n))).toBe(true)
    const back = load(files, rootOf(files))
    expect(netNamesOf(back)).toEqual(["/A/GNDL", "/B/GNDL"])
    // the board does not merge the uses either
    const pcb = (await kicadFiles(p)).files
    const boardNets = [...Object.entries(pcb).find(([n]) => n.endsWith(".kicad_pcb"))![1].matchAll(/\(net \d+ "([^"]*GNDL[^"]*)"\)/g)].map((m) => m[1]).sort()
    expect(boardNets).toEqual(["/A/GNDL", "/B/GNDL"])
  })

  it("with a global power symbol too, the globals are bare, the locals local, every sheet is stamped KiCad 10, and the uses stay two nets", async () => {
    const files = schFiles(await kicadFiles(drawnInEditor(hierarchy("hierarchical", true))))
    const all = [...files.values()].join("")
    for (const text of files.values()) expect(text).toMatch(/\(version 20250227\)/)
    expect(all).toMatch(/\(power local\)/)
    expect(all).toMatch(/\(power\)/)
    expect(all).not.toMatch(/\(power global\)/)
    expect(netNamesOf(load(files, rootOf(files)))).toEqual(["/A/GNDL", "/B/GNDL"])
  })

  it("a global power symbol is written bare, and a flat project with only globals keeps KiCad 9's stamp", async () => {
    const { files: flat } = await kicadFiles(drawnInEditor(new Map([["root.kicad_sch", schematic({ version: VERSION, libs: [LIB_R, LIB_GND], symbols: [{ lib: "Device:R", at: "50.8 50.8", ref: "R1", uuid: "aaaaaaaa-0000-4000-8000-000000000001" }, { lib: "power:GND", at: "50.8 54.61", ref: "#PWR01", uuid: "aaaaaaaa-0000-4000-8000-000000000002" }] })]])))
    const all = Object.values(flat).join("")
    expect(all).toMatch(/\(power\)/)
    expect(all).not.toMatch(/\(power (?:global|local)\)/)
    expect(Object.entries(flat).find(([n]) => n.endsWith(".kicad_sch"))![1]).toMatch(/\(version 20250114\)/)
  })
})

describe("S1 export: the board's nets are the schematic's, pin by pin", () => {
  /** The net name of every pin, by reference and pin number. */
  const pinNets = (p: Project) => {
    const c = computeConnectivity(p)
    const name = new Map(c.nets.map((n) => [n.id, n.name]))
    return Object.fromEntries(p.components.filter((x) => !x.ref.startsWith("#")).flatMap((x) => ["1", "2"].map((pin) => [`${x.ref}.${pin}`, name.get(c.pinNet.get(`${x.id}:${pin}`) ?? "") ?? null])))
  }
  for (const withGlobal of [false, true]) {
    for (const reversed of [false, true]) {
      it(`a sheet used twice with a local power symbol${withGlobal ? " and a global GND" : ""}${reversed ? ", created in reverse order" : ""}: the flat project the board is written from has each pin on the net the sheets give it`, async () => {
        const drawn = drawnInEditor(hierarchy("hierarchical", withGlobal))
        const p = reversed ? { ...drawn, components: [...drawn.components].reverse() } : drawn
        const want = pinNets(p)
        expect(want["R2.2"]).toBe("/A/GNDL")
        expect(want["R3.2"]).toBe("/B/GNDL")
        expect(want["R3.1"]).toBe("/B/VIN")
        expect(pinNets(flattenHierarchy(p).project)).toEqual(want)
        const pcb = Object.entries((await kicadFiles(p)).files).find(([n]) => n.endsWith(".kicad_pcb"))![1]
        const rows = [...pcb.matchAll(/\(net \d+ "([^"]*)"\)/g)].map((m) => m[1])
        for (const n of ["/A/GNDL", "/B/GNDL", "/A/VIN", "/B/VIN"]) expect(rows).toContain(n)
      })
    }
  }
})
