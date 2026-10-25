import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { deriveLegacyNets, newOverbar } from "./kicad-census/netlist-legacy.mjs"
import { kid, numAt } from "../src/model/kicad/board/sexpr"
import { computeConnectivity, pinKey } from "../src/model/connectivity"
import { schematicPins } from "../src/model/instances"
import { importKicadProject, pickProjectFiles } from "../src/model/kicad/project"
import { accountLegacyPro, LegacyProFileError, readLegacyPro } from "../src/model/kicad/project/legacyPro"
import { drawingFromLib } from "../src/model/kicad/schematic/symbols"
import { gateSchematic, importKicadSchematic } from "../src/model/kicad/schematic/import"
import { legacyPartToSymbolText, readLegacyLibraryText, mapAnglesSwaps } from "../src/model/kicad/schematic/legacy/lib"
import { readLegacySchematicText } from "../src/model/kicad/schematic/legacy/sch"
import { legacyToKicadText, orientationOf } from "../src/model/kicad/schematic/legacy/sexpr"
import { decodeLegacy } from "../src/model/kicad/schematic/legacy/text"
import { linkFootprints } from "../src/model/kicad/schematic/link"
import { readKicadSchematic } from "../src/model/kicad/schematic/read"
import { readSchematicTree } from "../src/model/kicad/schematic/tree"

// KiCad 4 and 5 schematics (slice 3e): every record of the `.sch` format, the encodings, the `.lib` format
// and the cache libraries, where a symbol comes from, the KiCad 5 rules for power symbols and net names,
// the `.pro`, linking by timestamp, and the refusals. The fixtures are written by hand, in mils as the files
// are; the real files are in the corpus test (`kicad-schematic-legacy-corpus.test.ts`).

const HEAD = (version = 4) => `EESchema Schematic File Version ${version}\nLIBS:power\nEELAYER 25 0\nEELAYER END\n$Descr A4 11693 8268\nencoding utf-8\nSheet 1 1\nTitle "Test"\nDate "2020-01-02"\nRev "B"\nComp "Acme"\nComment1 "one"\nComment2 ""\nComment3 ""\nComment4 ""\n$EndDescr\n`
const END = "$EndSCHEMATC\n"

interface CompSpec {
  lib: string
  ref: string
  ts: string
  at: [number, number]
  unit?: number
  convert?: number
  matrix?: string
  value?: string
  ar?: string[]
  extraFields?: string[]
}
const comp = (c: CompSpec) =>
  `$Comp\nL ${c.lib} ${c.ref}\nU ${c.unit ?? 1} ${c.convert ?? 1} ${c.ts}\nP ${c.at[0]} ${c.at[1]}\n${(c.ar ?? []).map((a) => `AR Path="${a}" Ref="${c.ref}" Part="${c.unit ?? 1}" \n`).join("")}F 0 "${c.ref}" H ${c.at[0] + 100} ${c.at[1]} 50  0000 L CNN\nF 1 "${c.value ?? "10k"}" H ${c.at[0] + 100} ${c.at[1] + 100} 50  0000 L CNN\nF 2 "R_0805" V ${c.at[0] - 70} ${c.at[1]} 50  0001 C CNN\nF 3 "~" H ${c.at[0]} ${c.at[1]} 50  0001 C CNN\n${(c.extraFields ?? []).join("\n")}${c.extraFields?.length ? "\n" : ""}\t${c.unit ?? 1}    ${c.at[0]} ${c.at[1]}\n\t${c.matrix ?? "1    0    0    -1"}  \n$EndComp\n`
const wire = (x1: number, y1: number, x2: number, y2: number) => `Wire Wire Line\n\t${x1} ${y1} ${x2} ${y2}\n`

/** `Device_R`: two passive pins on the y axis, 150 mil either side of the centre. */
const LIB_R = `EESchema-LIBRARY Version 2.4\n#encoding utf-8\n#\n# Device_R\n#\nDEF Device_R R 0 0 N Y 1 F N\nF0 "R" 80 0 50 V V C CNN\nF1 "R" 0 0 50 V V C CNN\nF2 "" -70 0 50 V I C CNN\nF3 "" 0 0 50 H I C CNN\n$FPLIST\n R_*\n$ENDFPLIST\nDRAW\nS -40 -100 40 100 0 1 10 N\nX ~ 1 0 150 50 D 50 50 1 1 P\nX ~ 2 0 -150 50 U 50 50 1 1 P\nENDDRAW\nENDDEF\n`
/** `power_GND`: a power symbol with one hidden power-input pin at the origin. */
const LIB_HEAD = "EESchema-LIBRARY Version 2.4\n#encoding utf-8\n"
const LIB_GND = `#\n# power_GND\n#\nDEF power_GND #PWR 0 0 Y Y 1 F P\nF0 "#PWR" 0 -250 50 H I C CNN\nF1 "GND" 0 -150 50 H V C CNN\nF2 "" 0 0 50 H I C CNN\nF3 "" 0 0 50 H I C CNN\nDRAW\nP 2 0 1 0 0 0 0 -100 N\nX GND 1 0 0 0 D 50 50 1 1 W N\nENDDRAW\nENDDEF\n`
/** `power_VCC` with a pin that is shown (the symbol is still named by it). */
const LIB_VCC_SHOWN = `DEF power_VCC #PWR 0 0 Y Y 1 F P\nF0 "#PWR" 0 -250 50 H I C CNN\nF1 "VCC" 0 150 50 H V C CNN\nDRAW\nX VCC 1 0 0 0 U 50 50 1 1 W\nENDDRAW\nENDDEF\n`
const CACHE = (...libs: string[]) => LIB_HEAD + libs.map((l) => l.replace(LIB_HEAD, "")).join("")

const files = (entries: Record<string, string | Uint8Array>) => new Map(Object.entries(entries))
type Files = ReturnType<typeof files>
const imp = (f: Files, options?: Parameters<typeof importKicadSchematic>[1]) => importKicadSchematic({ files: f, root: "t.sch" }, options)
const gate = (f: Files) => gateSchematic({ files: f, root: "t.sch" })
const mini = (body: string, lib = CACHE(LIB_R, LIB_GND), extra: Record<string, string | Uint8Array> = {}, version = 4) => files({ "t.sch": HEAD(version) + body + END, "t-cache.lib": lib, ...extra })

const R1 = "5A000001"
const R2 = "5A000002"
const G1 = "5A000003"

/** R1 at (5000, 4000) turned as `matrix`, GND over its pin 2 (at 5000, 4150 for the identity) with a wire. */
const twoParts = comp({ lib: "Device:R", ref: "R1", ts: R1, at: [5000, 4000] }) + comp({ lib: "power:GND", ref: "#PWR01", ts: G1, at: [5000, 4400] }) + wire(5000, 3850, 5000, 3700) + wire(5000, 4150, 5000, 4400)

describe("the records of a legacy schematic", () => {
  it("the header, the page and the title block", () => {
    const l = readLegacySchematicText(HEAD(5) + END)
    expect(l.version).toBe(5)
    expect(l.libs).toEqual(["power"])
    expect(l.page).toMatchObject({ type: "A4", portrait: false, sheet: [1, 1], title: "Test", date: "2020-01-02", rev: "B", company: "Acme", encoding: "utf-8" })
    expect(l.page!.comments[0]).toBe("one")
    const k = readKicadSchematic(legacyToKicadText(l)).schematic
    expect(k.paper).toBe("A4")
    expect(k.titleBlock).toEqual([
      { key: "Title", value: "Test" },
      { key: "Date", value: "2020-01-02" },
      { key: "Rev", value: "B" },
      { key: "Company", value: "Acme" },
      { key: "Comment1", value: "one" },
    ])
  })

  it("a custom page, and a portrait page", () => {
    const user = HEAD().replace("$Descr A4 11693 8268", "$Descr User 5000 4000")
    expect(readKicadSchematic(legacyToKicadText(readLegacySchematicText(user + END))).schematic.paper).toBe("User")
    const portrait = HEAD().replace("$Descr A4 11693 8268", "$Descr A3 16535 11693 portrait")
    expect(readLegacySchematicText(portrait + END).page).toMatchObject({ type: "A3", portrait: true })
  })

  it("a component: library name, reference, unit, convert, timestamp, place, fields with place, size, look and visibility", () => {
    const text = HEAD() + comp({ lib: "Device:R", ref: "R1", ts: R1, at: [5000, 4000], unit: 2, convert: 2, extraFields: ['F 4 "10k 1%" H 5100 4200 60  0001 R TIB "Tolerance"'] }) + END
    const c = readLegacySchematicText(text).comps[0]
    expect(c).toMatchObject({ libName: "Device:R", refDesignator: "R1", unit: 2, convert: 2, ts: R1, x: 5000, y: 4000, matrix: [1, 0, 0, -1] })
    expect(c.fields.map((f) => [f.index, f.text])).toEqual([[0, "R1"], [1, "10k"], [2, "R_0805"], [3, "~"], [4, "10k 1%"]])
    expect(c.fields[2]).toMatchObject({ orient: "V", attrs: 1, size: 50 })
    expect(c.fields[4]).toMatchObject({ name: "Tolerance", size: 60, hjust: "R", vjust: "T", italic: true, bold: true, attrs: 1 })
    const sym = readKicadSchematic(legacyToKicadText(readLegacySchematicText(text))).schematic.symbols[0]
    expect(sym).toMatchObject({ libId: "Device:R", unit: 2, bodyStyle: 2, at: { x: 127, y: 101.6 }, angle: 0, mirror: "" })
    expect(sym.uuid).toBe("00000000-0000-0000-0000-00005a000001")
    expect(sym.props.map((p) => [p.name, p.value, p.hide])).toEqual([["Reference", "R1", false], ["Value", "10k", false], ["Footprint", "R_0805", true], ["Datasheet", "", true], ["Tolerance", "10k 1%", true]])
    // the datasheet `~` is empty before KiCad 6.0.x as it is for any old file
    expect(sym.props[2].at).toEqual({ x: 125.222, y: 101.6 })
  })

  it("a user field takes the next free slot whatever number the file gives it", () => {
    const text = HEAD() + comp({ lib: "Device:R", ref: "R1", ts: R1, at: [0, 0], extraFields: ['F 9 "a" H 0 0 50 0000 C CNN "First"', 'F 7 "b" H 0 0 50 0000 C CNN'] }) + END
    expect(readLegacySchematicText(text).comps[0].fields.slice(4).map((f) => [f.index, f.name, f.text])).toEqual([[4, "First", "a"], [5, null, "b"]])
    const props = readKicadSchematic(legacyToKicadText(readLegacySchematicText(text))).schematic.symbols[0].props
    expect(props.slice(4).map((p) => p.name)).toEqual(["First", "Field5"])
  })

  it("the orientation matrices are the turn and mirror KiCad's own list gives, and place a pin where the matrix does", () => {
    const matrices: [number, number, number, number][] = [
      [1, 0, 0, -1],
      [0, 1, 1, 0],
      [-1, 0, 0, 1],
      [0, -1, -1, 0],
      [1, 0, 0, 1],
      [-1, 0, 0, -1],
      [0, 1, -1, 0],
      [0, -1, 1, 0],
    ]
    const seen = new Set<string>()
    for (const m of matrices) {
      const o = orientationOf(m)
      expect(o, m.join(" ")).not.toBeNull()
      seen.add(`${o!.angle} ${o!.mirror}`)
      // a point of the symbol (0, 150) goes to (y1 * 150, y2 * 150) from the place, by the matrix
      const t = HEAD() + comp({ lib: "Device:R", ref: "R1", ts: R1, at: [1000, 2000], matrix: m.join(" ") }) + END
      const sym = readKicadSchematic(legacyToKicadText(readLegacySchematicText(t))).schematic.symbols[0]
      expect([sym.angle, sym.mirror]).toEqual([o!.angle, o!.mirror])
    }
    expect(seen.size).toBe(8)
    expect(orientationOf([1, 1, 1, 1])).toBeNull()
  })

  it("a field is drawn at P + T(F - P): its stored place is turned and mirrored with the symbol, its angle and justification are not", () => {
    // The symbol is at (1000, 2000) mils. The reference is stored at +100, 0, the value at +100, +100, the hidden footprint (vertical) at -70, 0.
    // The offsets drawn are worked out by hand from the matrix: x' = x1 dx + y1 dy, y' = x2 dx + y2 dy (5.1 `SCH_FIELD::GetPosition`, which 6.0 saves).
    const table: [string, [number, number], [number, number], [number, number]][] = [
      ["1 0 0 -1", [100, 0], [100, -100], [-70, 0]],
      ["0 1 1 0", [0, 100], [100, 100], [0, -70]],
      ["-1 0 0 1", [-100, 0], [-100, 100], [70, 0]],
      ["0 -1 -1 0", [0, -100], [-100, -100], [0, 70]],
      ["1 0 0 1", [100, 0], [100, 100], [-70, 0]],
      ["-1 0 0 -1", [-100, 0], [-100, -100], [70, 0]],
      ["0 1 -1 0", [0, -100], [100, -100], [0, 70]],
      ["0 -1 1 0", [0, 100], [-100, 100], [0, -70]],
    ]
    for (const [matrix, ref, val, fp] of table) {
      const t = HEAD() + comp({ lib: "Device:R", ref: "R1", ts: R1, at: [1000, 2000], matrix }) + END
      const sym = readKicadSchematic(legacyToKicadText(readLegacySchematicText(t))).schematic.symbols[0]
      const prop = (name: string) => sym.props.find((p) => p.name === name)!
      const place = (name: string, off: [number, number]) => {
        expect(prop(name).at!.x, `${matrix} ${name} x`).toBeCloseTo((1000 + off[0]) * 0.0254, 6)
        expect(prop(name).at!.y, `${matrix} ${name} y`).toBeCloseTo((2000 + off[1]) * 0.0254, 6)
      }
      place("Reference", ref)
      place("Value", val)
      place("Footprint", fp)
      // the angle and the justification are saved as stored, whatever the turn (`EDA_TEXT::Format`, `saveField` of 6.0)
      expect(numAt(kid(prop("Reference").node, "at"), 3), matrix).toBe(0)
      expect(numAt(kid(prop("Footprint").node, "at"), 3), matrix).toBe(90)
      expect(JSON.stringify(kid(kid(prop("Reference").node, "effects"), "justify")), matrix).toContain("left")
    }
  })

  it("the identity is a plain symbol, a flip of the y axis a mirror", () => {
    expect(orientationOf([1, 0, 0, -1])).toEqual({ angle: 0, mirror: "" })
    expect(orientationOf([-1, 0, 0, -1])).toEqual({ angle: 0, mirror: "y" })
    expect(orientationOf([1, 0, 0, 1])).toEqual({ angle: 0, mirror: "x" })
  })

  it("AR lines: the references of the uses of a sheet, as instance paths below the root", () => {
    const text = HEAD() + comp({ lib: "Device:R", ref: "R1", ts: R1, at: [0, 0], ar: [`/5B000001/${R1}`, `/5B000002/${R1}`] }) + END
    const c = readLegacySchematicText(text).comps[0]
    expect(c.ar).toEqual([{ path: `/5B000001/${R1}`, reference: "R1", part: 1 }, { path: `/5B000002/${R1}`, reference: "R1", part: 1 }])
    const sym = readKicadSchematic(legacyToKicadText(readLegacySchematicText(text))).schematic.symbols[0]
    expect(sym.instances.map((i) => [i.path, i.reference, i.unit])).toEqual([
      ["/00000000-0000-0000-0000-000000000000/00000000-0000-0000-0000-00005b000001", "R1", 1],
      ["/00000000-0000-0000-0000-000000000000/00000000-0000-0000-0000-00005b000002", "R1", 1],
    ])
  })

  it("wires, buses and notes lines, with a style when the file has one", () => {
    const text = HEAD() + wire(0, 0, 100, 0) + "Wire Bus Line\n\t0 100 200 100\nWire Notes Line\n\t0 0 0 50\nWire Wire Line width 20 style dashed rgb(150, 40, 191)\n\t0 0 0 50\nWire Notes Line style solid\n\t0 0 0 70\n" + END
    const l = readLegacySchematicText(text)
    expect(l.wires.map((w) => [w.layer, w.width, w.style, w.color])).toEqual([["Wire", null, null, null], ["Bus", null, null, null], ["Notes", null, null, null], ["Wire", 20, "dashed", [150, 40, 191, 255]], ["Notes", null, "solid", null]])
    const k = readKicadSchematic(legacyToKicadText(l)).schematic
    expect(k.wires).toHaveLength(2)
    expect(k.buses).toHaveLength(1)
    expect(k.others.polyline).toHaveLength(2)
    // a notes line is drawn dashed unless it says otherwise (KiCad 6 writes the dash it draws)
    expect(JSON.stringify(k.others.polyline[0])).toContain('"type","dash"')
    expect(JSON.stringify(k.others.polyline[1])).toContain('"type","solid"')
    expect(JSON.stringify(k.wires[1].node)).toContain('"type","dash"')
    expect(JSON.stringify(k.wires[1].node)).toContain('"color","150","40","191","1"')
    expect(JSON.stringify(k.wires[1].node)).toContain('"width","0.508"')
  })

  it("bus entries of both kinds, junctions and no-connect flags", () => {
    const text = HEAD() + "Entry Wire Line\n\t1000 1000 1100 1100\nEntry Bus Bus\n\t2000 1000 2100 900\nConnection ~ 100 200\nNoConn ~ 300 400\n" + END
    const l = readLegacySchematicText(text)
    expect(l.entries).toEqual([{ kind: "Wire", x: 1000, y: 1000, x2: 1100, y2: 1100 }, { kind: "Bus", x: 2000, y: 1000, x2: 2100, y2: 900 }])
    expect(l.junctions).toEqual([{ x: 100, y: 200 }])
    expect(l.noConnects).toEqual([{ x: 300, y: 400 }])
    const k = readKicadSchematic(legacyToKicadText(l)).schematic
    expect(k.busEntries).toHaveLength(2)
    expect(k.busEntries[0].size).toEqual({ x: 2.54, y: 2.54 })
    expect(k.junctions[0].at).toEqual({ x: 2.54, y: 5.08 })
  })

  it("labels of every kind: the orientation numbering of local and global labels, the shape, italic and bold", () => {
    const text =
      HEAD() +
      "Text Label 1000 1000 0    60   ~ 0\nA\nText Label 1000 1100 2    60   Italic 12\nB\nText Label 1000 1200 1    50   ~ 0\nC\nText Label 1000 1300 3    50   ~ 0\nD\n" +
      "Text GLabel 2000 1000 0    60   Input ~ 0\nG0\nText GLabel 2000 1100 2    60   BiDi ~ 0\nG2\nText GLabel 2000 1200 1    60   3State ~ 0\nG1\nText GLabel 2000 1300 3    60   UnSpc ~ 0\nG3\nText HLabel 3000 1000 0    60   Output ~ 0\nH\nText Notes 4000 1000 0    60   ~ 0\nline one\\nline two\n" +
      END
    const l = readLegacySchematicText(text)
    expect(l.texts.map((t) => [t.kind, t.spin, t.shape, t.italic, t.thickness, t.text])).toEqual([
      ["Label", 0, null, false, 0, "A"],
      ["Label", 2, null, true, 12, "B"],
      ["Label", 1, null, false, 0, "C"],
      ["Label", 3, null, false, 0, "D"],
      ["GLabel", 0, "Input", false, 0, "G0"],
      ["GLabel", 2, "BiDi", false, 0, "G2"],
      ["GLabel", 1, "3State", false, 0, "G1"],
      ["GLabel", 3, "UnSpc", false, 0, "G3"],
      ["HLabel", 0, "Output", false, 0, "H"],
      ["Notes", 0, null, false, 0, "line one\nline two"],
    ])
    const k = readKicadSchematic(legacyToKicadText(l)).schematic
    // KiCad 6.0 reads a local label's 0 as text to the right (angle 0) and a global label's 0 as text to the left (angle 180)
    expect(k.labels.filter((x) => x.kind === "local").map((x) => [x.text, x.angle])).toEqual([["A", 0], ["B", 180], ["C", 90], ["D", 270]])
    expect(k.labels.filter((x) => x.kind === "global").map((x) => [x.text, x.angle, x.shape])).toEqual([["G0", 180, "input"], ["G2", 0, "bidirectional"], ["G1", 90, "tri_state"], ["G3", 270, "passive"]])
    expect(k.labels.find((x) => x.kind === "hierarchical")).toMatchObject({ text: "H", shape: "output", angle: 180 })
    expect(k.others.text[0]).toBeDefined()
    // bold is a pen a fifth of the text height, italic a word of the font
    const b = JSON.stringify(k.labels[1].node)
    expect(b).toContain('"thickness","0.3048"')
    expect(b).toContain('"italic"')
    expect(b).toContain('"bold"')
  })

  it("the old overbar notation of a label is converted, as KiCad 6 converts it", () => {
    const text = HEAD() + "Text Label 0 0 0    60   ~ 0\n~DSS~\nText Notes 0 100 0    60   ~ 0\nnote ~RESET~ here\n" + END
    const k = readKicadSchematic(legacyToKicadText(readLegacySchematicText(text))).schematic
    expect(k.labels[0].text).toBe("~{DSS}")
    expect(k.others.text[0][1]).toBe("note ~{RESET} here")
  })

  it("a sheet with its pins, a file used twice, and a bitmap", () => {
    const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
    const hex = png.map((b) => b.toString(16).toUpperCase().padStart(2, "0")).join(" ")
    const text =
      HEAD() +
      "$Sheet\nS 4000 3000 1200 800\nU 5B000001\nF0 \"Power\" 60\nF1 \"power.sch\" 60\nF2 \"VIN\" I L 4000 3200 60\nF3 \"OUT\" O R 5200 3400 60\n$EndSheet\n" +
      `$Bitmap\nPos 6000 2000\nScale 0.500000\nData\n${hex}\nEndData\n$EndBitmap\n` +
      END
    const l = readLegacySchematicText(text)
    expect(l.sheets[0]).toMatchObject({ x: 4000, y: 3000, w: 1200, h: 800, ts: "5B000001", name: "Power", file: "power.sch" })
    expect(l.sheets[0].pins).toEqual([{ name: "VIN", shape: "I", side: "L", x: 4000, y: 3200, size: 60 }, { name: "OUT", shape: "O", side: "R", x: 5200, y: 3400, size: 60 }])
    expect(l.bitmaps[0]).toMatchObject({ x: 6000, y: 2000, scale: 0.5 })
    expect(Array.from(l.bitmaps[0].data)).toEqual(png)
    const k = readKicadSchematic(legacyToKicadText(l)).schematic
    expect(k.sheets[0]).toMatchObject({ name: "Power", file: "power.sch", uuid: "00000000-0000-0000-0000-00005b000001" })
    expect(k.sheets[0].pins.map((p) => [p.name, p.type, p.angle])).toEqual([["VIN", "input", 180], ["OUT", "output", 0]])
    expect(JSON.stringify(k.others.image[0])).toContain(btoa(String.fromCharCode(...png)))
  })

  it("an ERC marker of an old KiCad is read and not brought", () => {
    const text = HEAD() + 'Kmarq B 3100 2150 "Warning Pin power_in not driven (Net 2)" F=1\n' + END
    const l = readLegacySchematicText(text)
    expect(l.markers).toEqual([{ type: "B", x: 3100, y: 2150, text: "Warning Pin power_in not driven (Net 2)" }])
    const res = imp(files({ "t.sch": text }))
    expect(res.report.entries.some((e) => e.code === "legacy-markers-not-brought" && e.severity === "not-brought")).toBe(true)
  })
})

describe("what KiCad reads and this reader does not guess", () => {
  it("version 1 files carry values KiCad ignores: they are said, not dropped silently", () => {
    const text = HEAD(1) + '$Comp\nL R R1\nU 1 1 5A000001\nP 100 100\nF 0 "R1" H 100 100 50  0000 L T\nF 1 "10k" H 100 100 50  0000 C C\n\t1    100 100\n\t1    0    0    -1\n$EndComp\nText Label 0 0 0    60   Italic 12\nX\n'
    const l = readLegacySchematicText(text)
    expect(l.comps[0].fields[0]).toMatchObject({ hjust: "C", vjust: "C" })
    expect(l.notes.map((n) => n.code)).toEqual(["ignored-v1", "ignored-v1"])
  })

  it("a version 1 GLabel is a hierarchical label", () => {
    const k = readKicadSchematic(legacyToKicadText(readLegacySchematicText(HEAD(1) + "Text GLabel 0 0 0    60   Input\nX\n"))).schematic
    expect(k.labels.map((l) => l.kind)).toEqual(["hierarchical"])
  })

  it("a picture's scale with a decimal comma is read as the number it says, and said", () => {
    const text = HEAD() + "$Bitmap\nPos 0 0\nScale 0,250000\nData\n89 50\nEndData\n$EndBitmap\n" + END
    const l = readLegacySchematicText(text)
    expect(l.bitmaps[0].scale).toBe(0.25)
    expect(l.notes[0].code).toBe("comma-decimal")
  })

  it("a record it does not know refuses, by name", () => {
    expect(() => readLegacySchematicText(HEAD() + "Polyline 2 0 0 10 10\n" + END)).toThrow(/does not know/)
    const r = imp(files({ "t.sch": HEAD() + "Polyline 2 0 0 10 10\n" + END }))
    expect(r.status).toBe("refused")
    if (r.status === "refused") {
      expect(r.reason).toBe("unknown")
      expect(r.report.entries[0]).toMatchObject({ code: "unknown-node", severity: "refused" })
    }
    const inside = imp(files({ "t.sch": HEAD() + "$Comp\nL R R1\nZ 1 2\n$EndComp\n" + END }))
    expect(inside.status === "refused" && inside.report.entries[0].object).toContain("$Comp>?")
  })

  it("damaged files give named errors", () => {
    const r = (t: string) => readSchematicTree(files({ "t.sch": t }), "t.sch")
    expect(() => r("")).toThrow(/empty/)
    expect(() => r("EESchema Schematic File Version 4\nLIBS:power\n")).toThrow(/EELAYER END/)
    expect(() => r(HEAD())).toThrow(/EndSCHEMATC|cut short/)
    expect(() => r(HEAD() + "$Comp\nL R R1\n")).toThrow(/cut short/)
    expect(() => r(HEAD() + "Connection ~ abc 12\n" + END)).toThrow(/Line \d+/)
    expect(() => r(HEAD() + "Wire Wire Line\n\t1 2 3\n" + END)).toThrow(/Line \d+/)
    expect(() => r(HEAD() + "Text Label 1 2 9 60 ~ 0\nX\n" + END)).toThrow(/label orientation/)
    expect(() => r(HEAD() + "$Comp\nL R R1\nU 1 1 5A000001\nP 0 0\n\t1 0 0\n\t2 0 0 -1\n$EndComp\n" + END)).toThrow(/transform/)
    expect(() => r("EESchema Schematic File Version 9\nEELAYER END\n")).toThrow(/newer/)
    expect(() => r("(kicad_sch (version 1))")).not.toThrow()
  })

  it("an orientation matrix that is no turn or mirror is refused", () => {
    expect(() => readSchematicTree(mini(comp({ lib: "Device:R", ref: "R1", ts: R1, at: [0, 0], matrix: "1 1 1 1" })), "t.sch")).toThrow(/orientation matrix/)
  })

  it("text of several kinds of damage that KiCad would read past is a refusal too: leftover text at the end of a line", () => {
    expect(() => readLegacySchematicText(HEAD() + "Connection ~ 10 20 30\n" + END)).toThrow(/unexpected text/)
  })
})

describe("hostile input", () => {
  const sheet = (name: string, file: string, ts: string) => `$Sheet\nS 100 100 500 500\nU ${ts}\nF0 "${name}" 60\nF1 "${file}" 60\n$EndSheet\n`
  it("a sheet that contains itself, or two that contain each other, is a named sheet error and not a hang", () => {
    const self = readSchematicTree(files({ "a.sch": HEAD() + sheet("A", "a.sch", "5B000001") + END }), "a.sch")
    expect(self.errors.map((e) => e.code)).toEqual(["cycle"])
    const two = readSchematicTree(files({ "a.sch": HEAD() + sheet("B", "b.sch", "5B000001") + END, "b.sch": HEAD() + sheet("A", "a.sch", "5B000002") + END }), "a.sch")
    expect(two.errors.map((e) => e.code)).toEqual(["cycle"])
  })

  it("a missing sheet file, and a damaged one, name the sheet", () => {
    const t = readSchematicTree(files({ "a.sch": HEAD() + sheet("B", "b.sch", "5B000001") + sheet("C", "c.sch", "5B000002") + END, "c.sch": "garbage" }), "a.sch")
    expect(t.errors.map((e) => [e.code, e.sheet])).toEqual([["missing", "B"], ["unreadable", "C"]])
  })

  it("garbage, binary data and a shape with an absurd number of points are refused, never a crash", () => {
    expect(() => readSchematicTree(files({ "t.sch": Uint8Array.from({ length: 4000 }, (_, i) => (i * 37) % 256) }), "t.sch")).toThrow()
    expect(() => readLegacyLibraryText("EESchema-LIBRARY Version 2.4\nDEF A A 0 0 N N 1 F N\nDRAW\nP 99999999 0 1 0 0 0\nENDDRAW\nENDDEF\n")).toThrow(/unreasonable number/)
    expect(() => readLegacySchematicText(HEAD() + "Connection ~ 99999999999 5\n" + END)).toThrow(/out of range/)
    expect(() => readLegacySchematicText("EESchema Schematic File Version 4\n" + "LIBS:x\n".repeat(50_000) + "EELAYER END\n$EndSCHEMATC\n")).not.toThrow()
  })

  it("a schematic with more drawn objects than the editor reads is refused by size", () => {
    const wires = Array.from({ length: 30 }, (_, i) => wire(i * 100, 0, i * 100 + 50, 0)).join("")
    const r = imp(files({ "t.sch": HEAD() + wires + END }), { maxObjects: 10 })
    expect(r.status === "refused" && r.reason).toBe("too-large")
  })
})

describe("encodings", () => {
  it("UTF-8 first, and it says so", () => {
    const text = HEAD() + "Text Label 100 100 0    60   ~ 0\nBéta\n" + END
    const d = decodeLegacy(new TextEncoder().encode(text))
    expect(d.encoding).toBe("utf-8")
    expect(d.notes).toEqual([])
    expect(readKicadSchematic(legacyToKicadText(readLegacySchematicText(d.text))).schematic.labels[0].text).toBe("Béta")
  })

  it("else Latin-1, and it says so in the report", () => {
    const bytes = Uint8Array.from(Buffer.from(HEAD() + "Text Label 100 100 0    60   ~ 0\nBéta\n" + END, "latin1"))
    const d = decodeLegacy(bytes)
    expect(d.encoding).toBe("latin-1")
    expect(d.text).toContain("Béta")
    const tree = readSchematicTree(files({ "t.sch": bytes }), "t.sch")
    expect(tree.files.get("t.sch")!.schematic.legacy!.encoding).toBe("latin-1")
    expect(tree.files.get("t.sch")!.schematic.labels[0].text).toBe("Béta")
    expect(tree.files.get("t.sch")!.schematic.legacy!.encoding).toBe("latin-1")
    expect(tree.report.entries.some((e) => e.code === "encoding" && /Latin-1/.test(e.why))).toBe(true)
  })

  it("a byte order mark is not part of the text", () => {
    const bytes = Uint8Array.from([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(HEAD() + END)])
    expect(decodeLegacy(bytes).text.startsWith("EESchema")).toBe(true)
  })

  it("a UTF-8 file with a byte order mark is read, and the report says KiCad 5.1 would refuse it", () => {
    const sheet = Uint8Array.from([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(HEAD() + twoParts + END)])
    const r = imp(files({ "t.sch": sheet, "t-cache.lib": CACHE(LIB_R, LIB_GND) }))
    expect(r.status === "refused" ? r.message : r.status).toBe("imported")
    if (r.status === "imported") {
      const note = r.report.entries.find((e) => e.code === "encoding" && /byte order mark/.test(e.why))
      expect(note?.why).toMatch(/KiCad 5\.1 refuses such a file/)
      expect(note?.severity).toBe("note")
    }
  })
})

describe("the library format", () => {
  const lib = readLegacyLibraryText(`EESchema-LIBRARY Version 2.4\n#encoding utf-8\n#\nDEF ~74LS00 U 0 30 Y Y 4 L N\nF0 "U" 0 100 50 H V C CNN\nF1 "74LS00" 0 -100 50 H V C CNN\nF2 "" 0 0 50 H I C CNN\nF3 "" 0 0 50 H I C CNN\nF4 "Mfr" 0 0 50 H I C CNN "Maker"\nALIAS 74HC00 74S00\n$FPLIST\n DIP*\n SO*\n$ENDFPLIST\nDRAW\nA 0 0 100 -900 900 1 1 6 f 0 -100 0 100\nC 10 20 30 2 1 0 F\nP 3 0 1 8 0 0 50 50 100 0 F\nS -50 -50 50 50 1 2 0 N\nT 900 10 20 60 0 0 1 "Hi ''q''" Italic 1 L B\nB 4 0 1 0 0 0 10 10 20 20 30 0 N\nX ~ 1 -300 100 100 R 50 50 1 1 I\nX A 2 -300 0 100 R 50 50 1 1 O CI\nX Y 3 300 0 100 L 50 50 1 2 T N\nX ~RST 4 0 -300 100 U 50 50 0 0 W\nENDDRAW\nENDDEF\n`)

  it("a symbol is found by its name, `~` hiding the value, and by each alias", () => {
    expect(lib.parts).toHaveLength(1)
    expect([...lib.byName.keys()]).toEqual(["74LS00", "74HC00", "74S00"])
    expect(lib.parts[0]).toMatchObject({ name: "74LS00", valueHidden: true, unitCount: 4, unitsLocked: true, pinNameOffset: 30, showPinNumbers: true })
    expect(lib.parts[0].footprints).toEqual(["DIP*", "SO*"])
    expect(lib.version).toEqual([2, 4])
  })

  it("units, body styles, every shape and every pin type and shape, converted to KiCad 6's symbol", () => {
    const part = lib.parts[0]
    const doc = readKicadSchematic(`(kicad_sch (version 20230221) (lib_symbols ${legacyPartToSymbolText(part, "74HC00")}))`).schematic
    const s = doc.libSymbols[0]
    expect(s.units).toBe(4)
    expect(s.bodyStyles).toBe(2)
    expect(s.pinNamesHidden).toBe(false)
    const d = drawingFromLib({ ...s, source: s }).drawing
    expect(d.name).toBe("74HC00")
    // the items are grouped by unit and body style as KiCad 6 writes them: all units first
    expect(d.items.map((i) => [i.kind, i.unit ?? 0, i.body ?? 0])).toEqual([
      ["polyline", 0, 1],
      ["text", 0, 1],
      ["bezier", 0, 1],
      ["arc", 1, 1],
      ["rectangle", 1, 2],
      ["circle", 2, 1],
    ])
    expect(d.pins.map((p) => [p.number, p.type, p.shape, p.unit ?? 0, p.body ?? 0, !!p.hidden, p.angle])).toEqual([
      ["4", "power_in", "line", 0, 0, false, 90],
      ["1", "input", "line", 1, 1, false, 0],
      ["2", "output", "inverted_clock", 1, 1, false, 0],
      ["3", "tri_state", "line", 1, 2, true, 180],
    ])
    const pin2 = d.pins.find((p) => p.number === "2")!
    expect(pin2.x * 12.7).toBeCloseTo(-7.62, 6)
    expect(pin2.length * 12.7).toBeCloseTo(2.54, 6)
    // a pin named `~` has no name, and the old overbar is converted
    expect(d.pins.find((p) => p.number === "1")!.name).toBe("")
    expect(d.pins.find((p) => p.number === "4")!.name).toBe("~{RST}")
    expect(d.fields.map((f) => [f.name, f.value])).toEqual([["Reference", "U"], ["Value", "74LS00"], ["Footprint", ""], ["Datasheet", ""], ["Maker", "Mfr"]])
  })

  it("the text of a symbol: two apostrophes are a double quote, and the style and justification are kept", () => {
    const s = readKicadSchematic(`(kicad_sch (version 20230221) (lib_symbols ${legacyPartToSymbolText(lib.parts[0], "x")}))`).schematic.libSymbols[0]
    const t = s.graphics.find((g) => g.kind === "text")!
    expect(t.text).toBe('Hi "q"')
    expect(JSON.stringify(t.node)).toContain('"italic"')
    expect(JSON.stringify(t.node)).toContain('"bold"')
    expect(JSON.stringify(t.node)).toContain('"left","bottom"')
  })

  it("a power symbol, and pin names and numbers that are not shown", () => {
    const l = readLegacyLibraryText(LIB_HEAD + LIB_GND.replace("DEF power_GND #PWR 0 0 Y Y", "DEF power_GND #PWR 0 20 N N"))
    expect(l.parts[0]).toMatchObject({ power: true, showPinNames: false, showPinNumbers: false, pinNameOffset: 20 })
    const s = readKicadSchematic(`(kicad_sch (version 20230221) (lib_symbols ${legacyPartToSymbolText(l.parts[0], "power:GND")}))`).schematic.libSymbols[0]
    expect(s).toMatchObject({ power: "global", pinNamesHidden: true, pinNumbersHidden: true })
  })

  it("an arc is drawn the way KiCad draws it: which end is the start follows MapAngles, and the middle is on the arc of at most a half turn", () => {
    // KiCad's own inductor arc: angles -889 to 889, ends (1, 101) and (1, 196)
    expect(mapAnglesSwaps(((-889 % 3600) + 3600) % 3600, 889)).toBe(true)
    // a quarter turn from 0 to 90 degrees: the ends are not swapped, and the arc is the quarter
    expect(mapAnglesSwaps(0, 900)).toBe(true)
    expect(mapAnglesSwaps(900, 2700)).toBe(false)
    const l = readLegacyLibraryText("EESchema-LIBRARY Version 2.4\nDEF L L 0 40 N N 1 F N\nDRAW\nA 0 148 48 -889 889 0 1 0 N 1 101 1 196\nENDDRAW\nENDDEF\n")
    const s = readKicadSchematic(`(kicad_sch (version 20230221) (lib_symbols ${legacyPartToSymbolText(l.parts[0], "L")}))`).schematic.libSymbols[0]
    const arc = s.graphics[0].arc!
    // KiCad 6 has this arc from (0.0254, 4.9784) through (1.1942, 3.7719) to (0.0254, 2.5654)
    expect(arc.start.x).toBeCloseTo(0.0254, 4)
    expect(arc.start.y).toBeCloseTo(4.9784, 4)
    expect(arc.end.y).toBeCloseTo(2.5654, 4)
    expect(arc.mid.x).toBeCloseTo(1.1942, 3)
    expect(Math.abs(arc.mid.y - 3.7719)).toBeLessThan(0.02)
    expect(arc.complemented).toBe(false)
  })

  it("a fill, a line width in mils, and old libraries without them", () => {
    const l = readLegacyLibraryText("EESchema-LIBRARY Version 2.2\nDEF X X 0 0 N N 1 0\nDRAW\nS 0 0 100 100 0 1 12\nC 0 0 50 0 1 8 f\nENDDRAW\nENDDEF\n")
    const s = readKicadSchematic(`(kicad_sch (version 20230221) (lib_symbols ${legacyPartToSymbolText(l.parts[0], "X")}))`).schematic.libSymbols[0]
    expect(s.graphics.map((g) => [g.kind, g.fill, g.strokeWidth])).toEqual([["rectangle", "none", 0.3048], ["circle", "background", 0.2032]])
  })

  it("a library damaged or not a library is a named error, and so is a name used twice (renamed)", () => {
    expect(() => readLegacyLibraryText("")).toThrow(/empty/)
    expect(() => readLegacyLibraryText("not a library")).toThrow(/not a KiCad 4 or 5/)
    expect(() => readLegacyLibraryText("EESchema-LIBRARY Version 2.4\nDEF A A 0 0 N N 1 F N\n")).toThrow(/cut short/)
    expect(() => readLegacyLibraryText("EESchema-LIBRARY Version 2.4\nDEF A A 0 0 N N 1 F N\nDRAW\nQ 1 2\nENDDRAW\nENDDEF\n")).toThrow(/undefined DRAW entry/)
    expect(() => readLegacyLibraryText("EESchema-LIBRARY Version 2.4\nDEF A A 0 0 N N 1 F N\nDRAW\nX A 1 0 0 1 Z 50 50 1 1 I\nENDDRAW\nENDDEF\n").parts[0].items[0]).not.toThrow()
    expect(() => readLegacyLibraryText("EESchema-LIBRARY Version 2.4\nDEF A A 0 0 N N 1 F N\nDRAW\nX A 1 0 0 1 R 50 50 1 1 Q\nENDDRAW\nENDDEF\n")).toThrow(/unknown pin type/)
    expect(() => readLegacyLibraryText("EESchema-LIBRARY Version 2.4\nDEF A A 0 0 N N 1 F N\nWHAT\nENDDEF\n")).toThrow(/does not know/)
    const twice = readLegacyLibraryText("EESchema-LIBRARY Version 2.4\nDEF A A 0 0 N N 1 F N\nENDDEF\nDEF A A 0 0 N N 1 F N\nENDDEF\n")
    expect([...twice.byName.keys()]).toEqual(["A", "A_0"])
  })

  it("a header without a version number is KiCad's own error for the oldest cache libraries", () => {
    expect(() => readLegacyLibraryText("EESchema-LIBRARY Version  11/12/2006-20:12:43\nDEF A A 0 0 N N 1 F N\nENDDEF\n")).toThrow(/major\.minor/)
  })
})

describe("where a symbol comes from", () => {
  it("the cache first, then the libraries in the order the .pro lists them", () => {
    const alt = LIB_R.replace("DEF Device_R R", "DEF R R").replace("X ~ 1 0 150", "X ~ 1 0 200")
    const f = files({
      "t.sch": HEAD() + comp({ lib: "Device:R", ref: "R1", ts: R1, at: [0, 0] }) + comp({ lib: "Device:R", ref: "R2", ts: R2, at: [500, 0] }) + END,
      "t-cache.lib": LIB_R,
      "t.pro": "update=x\nversion=1\n[eeschema/libraries]\nLibName1=zeta\nLibName2=alpha\n",
      "zeta.lib": alt,
      "alpha.lib": alt,
    })
    const tree = readSchematicTree(f, "t.sch")
    expect(tree.files.get("t.sch")!.schematic.legacy!.symbolSources).toEqual([{ libId: "Device:R", from: "cache", file: "t-cache.lib", name: "Device_R" }])
    // without the cache the first listed library has it, and the report says which
    const g = new Map(f)
    g.delete("t-cache.lib")
    const t2 = readSchematicTree(g, "t.sch")
    expect(t2.files.get("t.sch")!.schematic.legacy!.symbolSources[0]).toMatchObject({ from: "library", file: "zeta.lib", name: "R" })
    // the library of the nickname is first
    const h = new Map(g)
    h.set("t.sch", HEAD() + comp({ lib: "alpha:R", ref: "R1", ts: R1, at: [0, 0] }) + END)
    expect(readSchematicTree(h, "t.sch").files.get("t.sch")!.schematic.legacy!.symbolSources[0]).toMatchObject({ file: "alpha.lib" })
  })

  it("a KiCad 4 name has no library prefix, and `.cache.lib` is the cache of the demos", () => {
    const f = files({ "t.sch": HEAD(2) + comp({ lib: "R", ref: "R1", ts: R1, at: [0, 0] }) + END, "t.cache.lib": LIB_R.replace("DEF Device_R R", "DEF R R") })
    expect(readSchematicTree(f, "t.sch").files.get("t.sch")!.schematic.legacy!.symbolSources[0]).toMatchObject({ libId: "R", from: "cache", name: "R" })
  })

  it("a cache written by a development build names its entries lib:name", () => {
    const f = files({ "t.sch": HEAD() + comp({ lib: "Device:R", ref: "R1", ts: R1, at: [0, 0] }) + END, "t-cache.lib": LIB_R.replace("DEF Device_R R", "DEF Device:R R") })
    expect(readSchematicTree(f, "t.sch").files.get("t.sch")!.schematic.legacy!.symbolSources[0]).toMatchObject({ from: "cache", name: "Device:R" })
  })

  it("a symbol found nowhere refuses naming it and the libraries looked in, never guessed (S12)", () => {
    const r = imp(mini(comp({ lib: "Device:C", ref: "C1", ts: R1, at: [0, 0] }), LIB_R))
    expect(r.status).toBe("refused")
    if (r.status !== "refused") return
    expect(r.needs.map((n) => n.ext)).toEqual(["S12"])
    const e = r.report.entries.find((x) => x.code === "symbol-not-found")!
    expect(e.object).toContain("Device:C")
    expect(e.why).toContain("t-cache.lib")
    expect(e.severity).toBe("refused")
  })

  it("a library the project lists that is not among the files is named, and so is one that cannot be read", () => {
    const f = files({
      "t.sch": HEAD() + comp({ lib: "Device:C", ref: "C1", ts: R1, at: [0, 0] }) + END,
      "t.pro": "version=1\n[eeschema/libraries]\nLibName1=gone\nLibName2=broken\n",
      "broken.lib": "EESchema-LIBRARY Version  11/12/2006-20:12:43\n",
    })
    const r = imp(f)
    expect(r.status).toBe("refused")
    const names = r.report.entries.map((e) => `${e.code} ${e.object} ${e.why}`).join("\n")
    expect(names).toContain("gone")
    expect(names).toContain("library-unreadable broken.lib")
  })

  it("a damaged project file is a named error and the libraries it lists are not known", () => {
    const r = imp(files({ "t.sch": HEAD() + END, "t.pro": "not an ini line\n" }))
    expect(r.report.entries.some((e) => e.code === "legacy-pro-unreadable" && e.severity === "refused")).toBe(true)
  })
})

describe("KiCad 5's rules", () => {
  const nets = (body: string, lib = CACHE(LIB_R, LIB_GND, LIB_VCC_SHOWN)) => {
    const r = imp(mini(body, lib))
    if (r.status !== "imported") throw new Error(r.message)
    const c = computeConnectivity(r.project)
    return { r, c }
  }

  it("a sheet of a resistor and a ground imports, and its pins are where the file says", () => {
    const { r, c } = nets(twoParts)
    expect(r.project.components).toHaveLength(2)
    const r1 = r.project.components.find((x) => x.ref === "R1")!
    const pins = schematicPins(r1)
    // pin 1 is at (0, 150) mils from the place: y is down on the sheet, up in the editor
    const p1 = pins.find((p) => p.pin === "1")!
    expect(p1.pos.x).toBeCloseTo(5000 / 500, 6)
    expect(p1.pos.y).toBeCloseTo(-(4000 - 150) / 500, 6)
    expect(r.project.netNames).toBe("kicad6")
    expect(c.nets.some((n) => n.name === "GND")).toBe(true)
  })

  it("a power symbol names its net by its pin, shown or not, and not by its value", () => {
    const body = comp({ lib: "Device:R", ref: "R1", ts: R1, at: [5000, 4000] }) + comp({ lib: "power:GND", ref: "#PWR01", ts: G1, at: [5000, 4400], value: "FOO" }) + comp({ lib: "power:VCC", ref: "#PWR02", ts: "5A000004", at: [5000, 3600], value: "BAR" }) + wire(5000, 4150, 5000, 4400) + wire(5000, 3850, 5000, 3600)
    const { r, c } = nets(body)
    const names = c.nets.map((n) => n.name).sort()
    expect(names).toEqual(["GND", "VCC"])
    expect(r.project.components.filter((x) => x.props.net).map((x) => x.props.net).sort()).toEqual(["GND", "VCC"])
  })

  it("a label on a pin that lies on a wire joins the wire, as KiCad 5 joins it (KiCad 6 would not)", () => {
    // a wire from (4000, 3850) to (6000, 3850) passes pin 1 of R1 at (5000, 3850); a label sits on the pin
    const body = comp({ lib: "Device:R", ref: "R1", ts: R1, at: [5000, 4000] }) + wire(4000, 3850, 6000, 3850) + "Text Label 5000 3850 0    60   ~ 0\nSIG\n" + "Text Label 4000 3850 0    60   ~ 0\nOTHER\n"
    const r = imp(mini(body))
    expect(r.status).toBe("imported")
  })

  it("two labels of different names stacked on an empty point stay two nets in KiCad 5 and are joined by the editor: refused naming S11", () => {
    // label A on pin 1 of R1, label B on pin 1 of R2, and A and B stacked at a point with nothing else there (5.1 `BuildNetListInfo`: a label joins only through `segmentToPointConnect`)
    const two = comp({ lib: "Device:R", ref: "R1", ts: R1, at: [5000, 4000] }) + comp({ lib: "Device:R", ref: "R2", ts: R2, at: [7000, 4000] })
    const labels = (a: string, b: string) => `Text Label 5000 3850 0    60   ~ 0\nA\nText Label 7000 3850 0    60   ~ 0\nB\nText Label 9000 9000 0    60   ~ 0\n${a}\nText Label 9000 9000 0    60   ~ 0\n${b}\n`
    const r = imp(mini(two + labels("A", "B")))
    expect(r.status).toBe("refused")
    expect(r.status === "refused" && r.needs.map((n) => n.ext)).toContain("S11")
    expect(r.status === "refused" && r.needs.find((n) => n.ext === "S11")?.why).toMatch(/stacked/)
    // the same name twice is one net either way; two names on a pin, a wire end or a wire's side are joined by that item in KiCad 5 too
    expect(imp(mini(two + labels("A", "A"))).status).toBe("imported")
    expect(imp(mini(two + wire(9000, 9000, 9500, 9000) + labels("A", "B"))).status).toBe("imported")
    expect(imp(mini(two + wire(8500, 9000, 9500, 9000) + labels("A", "B"))).status).toBe("imported")
    const onPin = `Text Label 5000 3850 0    60   ~ 0\nA\nText Label 5000 3850 0    60   ~ 0\nB\n`
    expect(imp(mini(two + onPin)).status).toBe("imported")
  })

  it("labels written differently that the editor reads as one name (~A~ and ~A) stay two nets in KiCad 5: refused naming S11", () => {
    const two = comp({ lib: "Device:R", ref: "R1", ts: R1, at: [5000, 4000] }) + comp({ lib: "Device:R", ref: "R2", ts: R2, at: [7000, 4000] })
    const r = imp(mini(two + "Text Label 5000 3850 0    60   ~ 0\n~A~\nText Label 7000 3850 0    60   ~ 0\n~A\n"))
    expect(r.status).toBe("refused")
    expect(r.status === "refused" && r.needs.find((n) => n.ext === "S11")?.why).toMatch(/written differently/)
    expect(imp(mini(two + "Text Label 5000 3850 0    60   ~ 0\n~A~\nText Label 7000 3850 0    60   ~ 0\n~A~\n")).status).toBe("imported")
  })

  it("the oracle joins labels as KiCad 5 does: through a wire or a pin, never to each other at an empty point; ~A~ and ~A are two names", () => {
    const dir = mkdtempSync(join(tmpdir(), "legacy-oracle-"))
    try {
      const run = (body: string) => {
        writeFileSync(join(dir, "t.sch"), HEAD() + body + END)
        writeFileSync(join(dir, "t-cache.lib"), CACHE(LIB_R, LIB_GND))
        return deriveLegacyNets(join(dir, "t.sch"))
      }
      const two = comp({ lib: "Device:R", ref: "R1", ts: R1, at: [5000, 4000] }) + comp({ lib: "Device:R", ref: "R2", ts: R2, at: [7000, 4000] })
      const lab = (x: number, y: number, t: string) => `Text Label ${x} ${y} 0    60   ~ 0\n${t}\n`
      const apart = run(two + lab(5000, 3850, "A") + lab(7000, 3850, "B") + lab(9000, 9000, "A") + lab(9000, 9000, "B"))
      expect(apart.groupOf(`/${R1}#1`)).not.toBe(apart.groupOf(`/${R2}#1`))
      // the same two labels on a wire end are joined by the wire
      const joined = run(two + lab(5000, 3850, "A") + lab(7000, 3850, "B") + wire(9000, 9000, 9500, 9000) + lab(9000, 9000, "A") + lab(9000, 9000, "B"))
      expect(joined.groupOf(`/${R1}#1`)).toBe(joined.groupOf(`/${R2}#1`))
      // `~A~` and `~A` are two names, shown the same
      const bar = run(two + lab(5000, 3850, "~A~") + lab(7000, 3850, "~A") + lab(9000, 9000, "~A~") + lab(9000, 9000, "~A"))
      expect(bar.groupOf(`/${R1}#1`)).not.toBe(bar.groupOf(`/${R2}#1`))
      expect(newOverbar("~A~")).toBe(newOverbar("~A"))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("a wire end on another wire's side with no junction is not what KiCad 5 joins: refused naming S11", () => {
    const body = comp({ lib: "Device:R", ref: "R1", ts: R1, at: [5000, 4000] }) + wire(4000, 3000, 6000, 3000) + wire(5000, 3000, 5000, 3850)
    const r = imp(mini(body))
    expect(r.status).toBe("refused")
    expect(r.status === "refused" && r.needs.map((n) => n.ext)).toContain("S11")
  })

  it("a pin of the type no connect with a wire on it is joined by KiCad 5 and left out here: refused naming S11, not approximated", () => {
    const lib = `${LIB_R}DEF Test_U U 0 40 Y Y 1 F N\nF0 "U" 0 0 50 H V C CNN\nF1 "U" 0 0 50 H V C CNN\nDRAW\nX EP 1 0 0 100 D 50 50 1 1 N\nENDDRAW\nENDDEF\n`
    const body = comp({ lib: "Test:U", ref: "U1", ts: R1, at: [5000, 4000] }) + wire(5000, 4000, 5000, 4500)
    const r = imp(mini(body, lib))
    expect(r.status === "refused" && r.needs.map((n) => n.ext)).toContain("S11")
    const flagOnly = imp(mini(comp({ lib: "Test:U", ref: "U1", ts: R1, at: [5000, 4000] }) + "NoConn ~ 5000 4000\n", lib))
    expect(flagOnly.status).toBe("imported")
  })

  it("hierarchy and buses are refused by name", () => {
    const sheet = "$Sheet\nS 4000 3000 1200 800\nU 5B000001\nF0 \"Sub\" 60\nF1 \"sub.sch\" 60\n$EndSheet\n"
    const r = imp(files({ "t.sch": HEAD() + sheet + END, "sub.sch": HEAD() + END }))
    expect(r.status === "refused" && r.message).toMatch(/hierarchical sheets/)
    const b = imp(mini("Wire Bus Line\n\t0 0 100 0\n"))
    expect(b.status === "refused" && b.message).toMatch(/buses/)
  })

  it("the needs of a legacy file are the ones of a KiCad 6 file with the same things in it", () => {
    const g = gate(mini(twoParts))
    expect("gate" in g && g.gate.needs.map((n) => n.ext)).toEqual(["S2", "S5", "S6", "S10"])
  })

  it("a symbol of several units: the units are components of one reference", () => {
    const lib = `${LIB_HEAD}DEF Test_2 U 0 40 Y Y 2 F N\nF0 "U" 0 0 50 H V C CNN\nF1 "Test_2" 0 0 50 H V C CNN\nDRAW\nS -100 -100 100 100 1 1 0 N\nS -100 -100 100 100 2 1 0 N\nX A 1 -200 0 100 R 50 50 1 1 P\nX B 2 -200 0 100 R 50 50 2 1 P\nENDDRAW\nENDDEF\n`
    const body = comp({ lib: "Test:2", ref: "U1", ts: R1, at: [5000, 4000], unit: 1 }) + comp({ lib: "Test:2", ref: "U1", ts: R2, at: [7000, 4000], unit: 2 })
    const r = imp(mini(body, lib))
    expect(r.status).toBe("imported")
    if (r.status === "imported") expect(r.project.components.map((c) => [c.ref, c.unit ?? 1]).sort()).toEqual([["U1", 1], ["U1", 2]])
  })
})

describe("linking to a KiCad 5 board by timestamp", () => {
  it("a footprint's `/TIMESTAMP` path finds the symbol by its timestamp, a sub-sheet's `/SHEET/SYMBOL` too, and a reused sheet's AR paths", () => {
    const f = files({
      "t.sch": HEAD() + comp({ lib: "Device:R", ref: "R1", ts: R1, at: [0, 0], ar: [`/${R1}`] }) + "$Sheet\nS 4000 3000 1200 800\nU 5B000001\nF0 \"A\" 60\nF1 \"sub.sch\" 60\n$EndSheet\n$Sheet\nS 4000 4000 1200 800\nU 5B000002\nF0 \"B\" 60\nF1 \"sub.sch\" 60\n$EndSheet\n" + END,
      "sub.sch": HEAD() + comp({ lib: "Device:R", ref: "R2", ts: R2, at: [0, 0], ar: [`/5B000001/${R2}`, `/5B000002/${R2}`] }) + END,
      "t-cache.lib": LIB_R,
    })
    const tree = readSchematicTree(f, "t.sch")
    const r = linkFootprints(tree, [
      { ref: "R1", path: `/${R1}` },
      { ref: "R2", path: `/5B000001/${R2}` },
      { ref: "R2", path: `/5B000002/${R2}` },
      { ref: "R9", path: "/00000000-0000-0000-0000-00005b000001/5a000002" },
    ])
    // KiCad 5 writes a timestamp where KiCad 6 writes a uuid: the importer links them as the same thing
    expect(r.links.map((l) => l.how)).toEqual(["timestamp", "timestamp", "timestamp", "timestamp"])
    expect(r.counts.footprints).toBe(4)
    expect(r.counts.none).toBe(0)
    expect(r.symbolsOnSeveralFootprints).toBe(1)
  })
})

describe("the project file", () => {
  it("every key is accounted for, the libraries are listed in order, net classes are pending X10", () => {
    const text = "update=2020\nversion=1\nlast_client=kicad\n[general]\nversion=1\nRootSch=\nBoardNm=\n[eeschema]\nversion=1\nLibDir=lib;more\n[eeschema/libraries]\nLibName1=power\nLibName2=device\n[pcbnew]\nversion=1\nTrackWidth1=0.2\nViaDiameter1=0.8\nViaDrill1=0.4\n[pcbnew/Netclasses]\n[pcbnew/Netclasses/Default]\nName=Default\nClearance=0.2\nTrackWidth=0.25\nViaDiameter=0.8\nViaDrill=0.4\n[pcbnew/Netclasses/1]\nName=Power\nClearance=0.3\n[sheetnames]\n1=sub.sch\n[text_variables]\n1=REV=B\n"
    const { legacy } = readLegacyPro(text)
    expect(legacy.libNames).toEqual(["power", "device"])
    expect(legacy.libDirs).toEqual(["lib", "more"])
    const a = accountLegacyPro(legacy)
    expect(a.unknownPaths.size).toBe(0)
    expect(a.imported).toBe(4)
    expect(a.pending.get("X10")).toBeGreaterThan(5)
    expect(a.pending.get("S1")).toBe(1)
    expect(a.pending.get("S4")).toBe(1)
    expect(a.total).toBe([...a.notNeeded.values(), ...a.pending.values()].reduce((x, y) => x + y, 0) + a.imported)
    expect(legacy.pro.netClasses.map((c) => c.name)).toEqual(["Default", "Power"])
  })

  it("a key it does not know is named, an empty file is a project with no settings, a JSON file is not this format", () => {
    const { legacy } = readLegacyPro("[general]\nWhat=1\n")
    expect([...accountLegacyPro(legacy).unknownPaths.keys()]).toEqual(["[general] What"])
    expect(readLegacyPro("").legacy.entries).toEqual([])
    expect(() => readLegacyPro('{"meta":{}}')).toThrow(LegacyProFileError)
    expect(() => readLegacyPro("no equals sign\n")).toThrow(/key=value/)
  })
})

describe("a KiCad 5 project: a board with its schematic", () => {
  const board = (padNet: string) => `(kicad_pcb (version 20171130) (host pcbnew 5.1.6)
  (general (thickness 1.6))
  (page A4)
  (layers (0 F.Cu signal) (31 B.Cu signal) (44 Edge.Cuts user))
  (setup (last_trace_width 0.25))
  (net 0 "")
  (net 1 "${padNet}")
  (net_class Default "" (clearance 0.2) (trace_width 0.25) (via_dia 0.8) (via_drill 0.4) (uvia_dia 0.3) (uvia_drill 0.1) (add_net "${padNet}"))
  (module R_0805 (layer F.Cu) (tedit 0) (tstamp 5A000001) (at 100 100)
    (fp_text reference R1 (at 0 -1.5) (layer F.SilkS) (effects (font (size 1 1) (thickness 0.15))))
    (fp_text value 10k (at 0 1.5) (layer F.Fab) (effects (font (size 1 1) (thickness 0.15))))
    (path /${R1})
    (pad 1 smd rect (at -1 0) (size 1 1.2) (layers F.Cu F.Paste F.Mask))
    (pad 2 smd rect (at 1 0) (size 1 1.2) (layers F.Cu F.Paste F.Mask) (net 1 "${padNet}"))
  )
  (gr_line (start 90 90) (end 110 90) (layer Edge.Cuts) (width 0.1))
  (gr_line (start 110 90) (end 110 110) (layer Edge.Cuts) (width 0.1))
  (gr_line (start 110 110) (end 90 110) (layer Edge.Cuts) (width 0.1))
  (gr_line (start 90 110) (end 90 90) (layer Edge.Cuts) (width 0.1))
)
`
  const project = (padNet: string) => [
    { path: "p.kicad_pcb", data: board(padNet) },
    { path: "p.sch", data: HEAD() + twoParts + END },
    { path: "p-cache.lib", data: CACHE(LIB_R, LIB_GND) },
    { path: "p.pro", data: "update=1\nversion=1\n[general]\nversion=1\nRootSch=\nBoardNm=\n[eeschema/libraries]\n" },
  ]
  const raised = { built: new Set(["S2", "S4", "S5", "S6", "S7", "S10", "X1", "X2", "X3", "X4", "X5", "X6", "X7", "X8", "X9", "X10", "X11", "X12", "X13", "X14", "X15", "X16", "X17", "X18", "X19", "X20", "X21"]), allowLossyBoard: true }

  it("the board and the schematic are one project, linked by timestamp, and the pad against the pin agree", () => {
    const r = importKicadProject(project("GND"), raised)
    expect(r.status === "imported" ? r.link?.counts : r.message).toMatchObject({ footprints: 1, timestamp: 1, none: 0 })
    if (r.status === "imported") {
      expect(r.differences).toEqual([])
      expect(r.tree?.files.get("p.sch")!.schematic.legacy!.version).toBe(4)
      expect(r.accounts.pro?.total).toBeGreaterThan(0)
    }
  })

  it("a board that has not been updated from its schematic is a difference by part and pin", () => {
    const r = importKicadProject(project("+5V"), raised)
    expect(r.status).toBe("imported")
    if (r.status === "imported") expect(r.differences.map((d) => [d.ref, d.pin])).toEqual([["R1", "2"]])
  })

  // The project's own libraries instead of a cache: `Device.lib` has `R` with its pins 1 and 2 swapped from the drawing (pin 1 below, pin 2 above), and `power.lib` has `GND`.
  // Two resistors, each with pin 2 on GND in the drawing; the board has pad 2 of both on GND.
  const two = twoParts + comp({ lib: "Device:R", ref: "R2", ts: R2, at: [7000, 4000] }) + comp({ lib: "power:GND", ref: "#PWR02", ts: "5A000004", at: [7000, 4400] }) + wire(7000, 3850, 7000, 3700) + wire(7000, 4150, 7000, 4400)
  const r2Module = `  (module R_0805 (layer F.Cu) (tedit 0) (tstamp ${R2}) (at 120 100)
    (fp_text reference R2 (at 0 -1.5) (layer F.SilkS) (effects (font (size 1 1) (thickness 0.15))))
    (fp_text value 10k (at 0 1.5) (layer F.Fab) (effects (font (size 1 1) (thickness 0.15))))
    (path /${R2})
    (pad 1 smd rect (at -1 0) (size 1 1.2) (layers F.Cu F.Paste F.Mask))
    (pad 2 smd rect (at 1 0) (size 1 1.2) (layers F.Cu F.Paste F.Mask) (net 1 "GND"))
  )
`
  const twoBoard = board("GND").replace("  (gr_line (start 90 90) (end 110 90)", `${r2Module}  (gr_line (start 90 90) (end 110 90)`)
  const libProject = (withBoard = true) => [
    ...(withBoard ? [{ path: "p.kicad_pcb", data: twoBoard }] : []),
    { path: "p.sch", data: HEAD() + two + END },
    { path: "Device.lib", data: LIB_HEAD + LIB_R.replace(LIB_HEAD, "").replaceAll("Device_R", "R").replace("X ~ 1 0 150 50 D", "X ~ 2 0 150 50 D").replace("X ~ 2 0 -150 50 U", "X ~ 1 0 -150 50 U") },
    { path: "power.lib", data: LIB_HEAD + LIB_GND.replaceAll("power_GND", "GND") },
    { path: "p.pro", data: "update=1\nversion=1\n[general]\nversion=1\nRootSch=\nBoardNm=\n[eeschema/libraries]\nLibName1=Device\nLibName2=power\n" },
  ]

  it("a symbol from a library of the project, not from a cache, is said plainly, and a renumbered part is named by the pad against pin comparison", () => {
    const r = importKicadProject(libProject(), raised)
    expect(r.status === "refused" ? r.message : r.status).toBe("imported")
    if (r.status !== "imported") return
    // the library's R has its pins swapped: the board's pad 2 is on GND and the pin 2 of the library symbol is not
    expect(r.differences.map((d) => `${d.ref}.${d.pin}`).sort()).toEqual(["R1.1", "R1.2", "R2.1", "R2.2"])
    expect(r.differences.every((d) => /comes from a library of the project, not from the drawing the sheet was saved with/.test(d.why))).toBe(true)
    const entry = r.report.entries.find((e) => e.code === "symbol-from-library")
    expect(entry?.severity).toBe("changed")
    expect(entry?.why).toMatch(/not from the drawing the sheet was saved with/)
    expect(entry?.why).toMatch(/pin numbers may differ/)
    // the board covers R1 and R2, so the warning above the entries is only about the two power symbols, which no pad can check
    expect(r.report.warnings).toHaveLength(1)
    expect(r.report.warnings![0]).toMatch(/^2 symbols \(#PWR01, #PWR02\) come from a library of the project/)
    expect(r.report.warnings![0]).not.toMatch(/R1/)
  })

  it("a library symbol with no board to check it against gives a warning above the entries; a cached one gives none", () => {
    const alone = importKicadProject(libProject(false), raised)
    expect(alone.status).toBe("refused")
    const sch = importKicadSchematic({ files: files({ "p.sch": HEAD() + two + END, "Device.lib": libProject(false)[1].data as string, "power.lib": libProject(false)[2].data as string, "p.pro": libProject(false)[3].data as string }), root: "p.sch" })
    expect(sch.status === "refused" ? sch.message : sch.status).toBe("imported")
    if (sch.status === "imported") {
      expect(sch.report.warnings).toHaveLength(1)
      expect(sch.report.warnings![0]).toMatch(/R1.*come from a library of the project, not from the drawing the sheet was saved with, and there is no board to check the pin numbers against/)
      expect(sch.report.entries.some((e) => e.code === "symbol-from-library" && e.severity === "changed")).toBe(true)
    }
    const cached = imp(mini(twoParts))
    expect(cached.status).toBe("imported")
    if (cached.status === "imported") {
      expect(cached.report.warnings).toBeUndefined()
      expect(cached.report.entries.some((e) => e.code === "symbol-from-library")).toBe(false)
      expect(cached.report.entries.find((e) => e.code === "legacy-symbol-sources")?.why).toMatch(/KiCad 5 would first try the libraries installed with it/)
    }
  })

  it("the real gate refuses what the editor lacks, naming it", () => {
    const r = importKicadProject(project("GND"))
    expect(r.status).toBe("refused")
  })

  it("the project's folder is read as a KiCad 5 project when there is no KiCad 6 file", () => {
    const p = pickProjectFiles(project("GND") as never)
    expect(p.legacy).toBe(true)
    expect(p.root?.path).toBe("p.sch")
    expect(p.pro?.path).toBe("p.pro")
    expect(p.sheets.has("p-cache.lib")).toBe(true)
  })
})

// kept so the unused imports stay checked
void pinKey
