import { describe, expect, it } from "vitest"
import { KicadSchematicReadError, readArc, readKicadSchematic, readSchematicTree, schEraOf, sheetFields, symbolRecords, type SchematicTree } from "../src/model/kicad/schematic"
import { MAX_SHEET_DEPTH, MAX_SHEET_INSTANCES } from "../src/model/kicad/schematic/tree"
import { ROOT_UUID, LIB_GND, LIB_R, divider, schematic } from "./kicad-schematic-fixtures"

// The schematic reader: every switch of section 6 of docs/kicad-import-schematic.md has a file here
// that needs it, written in the spelling of the release that has the switch; and every way a file
// can be damaged is a named error, never a crash or a hang.

const read = (text: string) => readKicadSchematic(text).schematic

describe("the reader's switches", () => {
  it("switch 1, instances: KiCad 6 lists them at the root, KiCad 7 and later keep them in each symbol; both give the same path", () => {
    const sym = { lib: "Device:R", at: "50.8 50.8", ref: "R1", uuid: "aaaaaaaa-0000-4000-8000-000000000001" }
    const v6 = readKicadSchematic(schematic({ version: 20211123, libs: [LIB_R], symbols: [sym] })).schematic
    const v7 = readKicadSchematic(schematic({ version: 20230121, libs: [LIB_R], symbols: [sym] })).schematic
    expect(v6.rootInstances.map((i) => [i.path, i.reference])).toEqual([[`/${sym.uuid}`, "R1"]])
    expect(v6.symbols[0].instances).toEqual([])
    expect(v7.rootInstances).toEqual([])
    expect(v7.symbols[0].instances.map((i) => [i.path, i.reference])).toEqual([[`/${ROOT_UUID}`, "R1"]])
    const paths = (text: string) => {
      const tree = readSchematicTree(new Map([["a.kicad_sch", text]]), "a.kicad_sch")
      return symbolRecords(tree).map((r) => [r.path, r.reference, r.from])
    }
    expect(paths(schematic({ version: 20211123, libs: [LIB_R], symbols: [sym] }))).toEqual([[`/${sym.uuid}`, "R1", "root-list"]])
    expect(paths(schematic({ version: 20230121, libs: [LIB_R], symbols: [sym] }))).toEqual([[`/${sym.uuid}`, "R1", "symbol"]])
  })

  it("switch 2, the no-connect pin type: `unconnected` is read as `no_connect`", () => {
    const lib = (type: string) => `(symbol "T:X" (symbol "X_1_1" (pin ${type} line (at 0 0 0) (length 2.54) (name "A") (number "1"))))`
    expect(read(schematic({ version: 20201218, libs: [lib("unconnected")] })).libSymbols[0].pins[0].type).toBe("no_connect")
    expect(read(schematic({ version: 20230121, libs: [lib("no_connect")] })).libSymbols[0].pins[0].type).toBe("no_connect")
  })

  it("switch 3, booleans: a bare `hide` and `(hide yes)` both hide a pin, and `(hide no)` does not", () => {
    const lib = (hide: string) => `(symbol "T:X" (pin_names ${hide ? `(offset 0) ${hide}` : "(offset 0)"}) (symbol "X_1_1" (pin passive line (at 0 0 0) (length 2.54) ${hide} (name "A") (number "1"))))`
    expect(read(schematic({ version: 20230121, libs: [lib("hide")] })).libSymbols[0].pins[0].hidden).toBe(true)
    expect(read(schematic({ version: 20241004, libs: [lib("(hide yes)")] })).libSymbols[0].pins[0].hidden).toBe(true)
    expect(read(schematic({ version: 20241004, libs: [lib("(hide no)")] })).libSymbols[0].pins[0].hidden).toBe(false)
    expect(read(schematic({ version: 20241004, libs: [lib("(hide yes)")] })).libSymbols[0].pinNamesHidden).toBe(true)
    expect(read(schematic({ version: 20230121, libs: [lib("")] })).libSymbols[0].pinNamesHidden).toBe(false)
  })

  it("switch 4, the overbar: `~RST~` is `~{RST}` in a pin name before 20210606 and in a label before 20210615, and left alone after", () => {
    const lib = `(symbol "T:X" (symbol "X_1_1" (pin input line (at 0 0 0) (length 2.54) (name "~RST~") (number "1"))))`
    expect(read(schematic({ version: 20210501, libs: [lib] })).libSymbols[0].pins[0].name).toBe("~{RST}")
    expect(read(schematic({ version: 20211123, libs: [lib] })).libSymbols[0].pins[0].name).toBe("~RST~")
    const label = (version: number) => read(schematic({ version, labels: ["~CS~ 10 10 0"] })).labels[0].text
    expect(label(20210605)).toBe("~{CS}")
    expect(label(20210606)).toBe("~CS~")
    expect(label(20210616)).toBe("~CS~")
    // a power symbol's Value is a net name and follows the same switch
    const power = (version: number) => read(schematic({ version, libs: [LIB_GND], symbols: [{ lib: "power:GND", at: "50.8 76.2", ref: "#PWR01", value: "~OE~", uuid: "aaaaaaaa-0000-4000-8000-000000000001" }] })).symbols[0].props.find((x) => x.name === "Value")?.value
    expect(power(20210605)).toBe("~{OE}")
    expect(power(20210606)).toBe("~OE~")
    // a name that already says ~{ is left alone (a file converted twice)
    expect(read(schematic({ version: 20210501, labels: ["~{CS} 10 10 0"] })).labels[0].text).toBe("~{CS}")
  })

  it("switch 5, net names: `{slash}` is `/`, and the raw text is kept", () => {
    const l = read(schematic({ labels: ["A{slash}B 10 10 0"] })).labels[0]
    expect(l.text).toBe("A/B")
    expect(l.raw).toBe("A{slash}B")
  })

  it("switch 6, the `host` list of old files is read and not needed", () => {
    const text = schematic({ version: 20200310, body: ["(host eeschema 5.99)"] })
    expect(read(text).others.host).toEqual([["host", "eeschema", "5.99"]])
  })

  it("switch 7, power: `(power)` and `(power global)` are global, `(power local)` is local", () => {
    const lib = (power: string) => `(symbol "power:X" ${power} (symbol "X_1_1" (pin power_in line (at 0 0 90) (length 0) (name "X") (number "1"))))`
    expect(read(schematic({ libs: [lib("(power)")] })).libSymbols[0].power).toBe("global")
    expect(read(schematic({ version: 20250114, libs: [lib("(power global)")] })).libSymbols[0].power).toBe("global")
    expect(read(schematic({ version: 20250227, libs: [lib("(power local)")] })).libSymbols[0].power).toBe("local")
    expect(read(schematic({ libs: [lib("")] })).libSymbols[0].power).toBeNull()
  })

  it("switch 8, a sheet's file and name: `Sheetfile`, `Sheet file`, `File`, and by position in files up to 20200310", () => {
    const sheet = (names: [string, string]) => `(sheet (at 10 10) (size 20 20) (uuid s1) (property "${names[0]}" "Power" (id 0) (at 10 9 0)) (property "${names[1]}" "power.kicad_sch" (id 1) (at 10 31 0)))`
    for (const [version, names] of [
      [20230121, ["Sheetname", "Sheetfile"]],
      [20211123, ["Sheet name", "Sheet file"]],
      [20210123, ["Name", "File"]],
    ] as const) {
      const s = read(schematic({ version, body: [sheet([names[0], names[1]])] })).sheets[0]
      expect([s.name, s.file], `${version}`).toEqual(["Power", "power.kicad_sch"])
    }
    // up to 20200310 the ids and names are wrong: the first property is the name and the second the file
    const old = read(schematic({ version: 20200310, body: [sheet(["Wrong", "Names"])] })).sheets[0]
    expect([old.name, old.file]).toEqual(["Power", "power.kicad_sch"])
    expect(sheetFields([], 20230121)).toEqual({ name: null, file: null })
  })

  it("switch 9, a lone `~` is empty in a property, a pin name and a pin number before 20250318, and the text `~` from it", () => {
    const text = (version: number) =>
      schematic({
        version,
        libs: [`(symbol "T:X" (property "Datasheet" "~" (at 0 0 0)) (symbol "X_1_1" (pin passive line (at 0 0 0) (length 2.54) (name "~") (number "~"))))`],
      })
    const old = read(text(20250114)).libSymbols[0]
    expect([old.props[0].value, old.pins[0].name, old.pins[0].number]).toEqual(["", "", ""])
    const now = read(text(20250318)).libSymbols[0]
    expect([now.props[0].value, now.pins[0].name, now.pins[0].number]).toEqual(["~", "~", "~"])
  })

  it("switch 10, a symbol arc of more than a half turn is replaced by its complement in files up to 20230121", () => {
    // A circle of radius 5 at the origin; the arc from (5,0) through (-5,1) ... a 200 degree arc counter-clockwise from 0 degrees.
    const at = (deg: number) => `${(5 * Math.cos((deg * Math.PI) / 180)).toFixed(4)} ${(5 * Math.sin((deg * Math.PI) / 180)).toFixed(4)}`
    const arc = (a: number, b: number) => ["arc", ["start", ...at(0).split(" ")], ["mid", ...at((a + b) / 2).split(" ")], ["end", ...at(b).split(" ")]] as never
    void arc
    const node = (from: number, mid: number, to: number): string[] | unknown[] => ["arc", ["start", ...at(from).split(" ")], ["mid", ...at(mid).split(" ")], ["end", ...at(to).split(" ")]]
    const big = readArc(node(0, 100, 200) as never, 20230121)!
    expect(big.complemented).toBe(true)
    // the complement runs the other way round from 0 to 200 degrees: its middle is at 280 degrees (through the bottom), 160 degrees of arc
    const m = Math.atan2(big.mid.y, big.mid.x) * (180 / Math.PI)
    expect(((m % 360) + 360) % 360).toBeCloseTo(280, 1)
    expect(big.start.x).toBeCloseTo(5, 3)
    expect(big.end.x).toBeCloseTo(5 * Math.cos((200 * Math.PI) / 180), 3)
    // from 20230122 on it is left as it is
    expect(readArc(node(0, 100, 200) as never, 20231120)!.complemented).toBe(false)
    expect(readArc(node(0, 100, 200) as never, 20231120)!.mid.y).toBeCloseTo(5 * Math.sin((100 * Math.PI) / 180), 3)
    // an arc of less than a half turn is never replaced
    expect(readArc(node(0, 40, 80) as never, 20211123)!.complemented).toBe(false)
    // exactly a half turn is avoided too
    expect(readArc(node(0, 90, 180) as never, 20211123)!.complemented).toBe(true)
  })

  it("the old arc form, with a radius and angles, is read to the same arc", () => {
    const arc = readArc(["arc", ["start", "5", "0"], ["end", "0", "5"], ["radius", ["at", "0", "0"], ["length", "5"], ["angles", "0", "90"]]] as never, 20230121)!
    expect(arc.center).toEqual({ x: 0, y: 0 })
    expect(arc.radius).toBe(5)
    expect(arc.mid.x).toBeCloseTo(5 * Math.SQRT1_2, 3)
    expect(arc.mid.y).toBeCloseTo(5 * Math.SQRT1_2, 3)
  })

  it("the stamp says the release", () => {
    expect([20210123, 20211123, 20230121, 20231120, 20250114, 20250829, 20260306, 20261018, null].map(schEraOf)).toEqual(["pre6-nightly", "kicad6", "kicad7", "kicad8", "kicad9", "kicad10", "kicad11-dev", "kicad11-dev", "unknown"])
  })

  it("every node of the file is kept as the file has it, and what the typed fields leave out is in `others`", () => {
    const s = read(
      schematic({
        libs: [LIB_R, LIB_GND],
        body: [`(text "hello" (at 1 2 0) (effects (font (size 1.27 1.27))))`, `(rectangle (start 0 0) (end 5 5) (stroke (width 0) (type default)) (fill (type none)))`, `(bus (pts (xy 0 0) (xy 5 0)) (stroke (width 0) (type default)) (uuid b))`],
      }),
    )
    expect(Object.keys(s.others).sort()).toEqual(["rectangle", "text"])
    expect(s.buses).toHaveLength(1)
    expect(s.libSymbols.map((l) => l.name)).toEqual(["Device:R", "power:GND"])
    expect(s.libSymbols[0].node[0]).toBe("symbol")
    expect(s.tree[0]).toBe("kicad_sch")
  })

  it("reads stacked pin numbers, units and body styles of a library symbol", () => {
    const lib = `(symbol "T:Q" (symbol "Q_0_1" (rectangle (start -1 -1) (end 1 1) (stroke (width 0) (type default)) (fill (type none)))) (symbol "Q_1_1" (pin passive line (at 0 0 0) (length 1) (name "A") (number "[1-3]"))) (symbol "Q_2_2" (pin passive line (at 5 0 0) (length 1) (name "B") (number "4"))))`
    const l = read(schematic({ libs: [lib] })).libSymbols[0]
    expect(l.units).toBe(2)
    expect(l.bodyStyles).toBe(2)
    expect(l.pins.map((p) => [p.number, p.unit, p.bodyStyle])).toEqual([
      ["[1-3]", 1, 1],
      ["4", 2, 2],
    ])
    expect(l.graphics.map((g) => [g.kind, g.unit, g.bodyStyle])).toEqual([["rectangle", 0, 1]])
  })
})

describe("a file that is damaged is a named error", () => {
  const code = (input: string | Uint8Array) => {
    try {
      readKicadSchematic(input)
    } catch (e) {
      if (e instanceof KicadSchematicReadError) return `${e.code}: ${e.message}`
      throw e
    }
    return "no error"
  }

  it("empty, blank, cut short, unbalanced, too deep", () => {
    expect(code("")).toMatch(/^empty:/)
    expect(code("  \n ")).toMatch(/^empty:/)
    expect(code(divider().slice(0, 900))).toMatch(/^(truncated|unbalanced):.*cut short/)
    expect(code(`(kicad_sch (version 20230121) (generator "eeschema`)).toMatch(/^truncated:.*quoted text/)
    expect(code(`${schematic()})`)).toMatch(/^unbalanced:.*closing bracket/)
    expect(code(`(kicad_sch ${"(a ".repeat(300)}${")".repeat(300)})`)).toMatch(/^too-deep:/)
  })

  it("a file that is not a schematic says what it is", () => {
    expect(code(`(kicad_pcb (version 20240108))`)).toMatch(/^not-a-schematic: This is a KiCad board/)
    expect(code(`(kicad_symbol_lib (version 20231120))`)).toMatch(/^not-a-schematic: This is a KiCad symbol library/)
    expect(code(`(footprint "R" (layer "F.Cu"))`)).toMatch(/^not-a-schematic: This is a single KiCad footprint/)
    expect(code(`(something_else (version 1))`)).toMatch(/^not-a-schematic: This file has no \(kicad_sch/)
    expect(code("just some text")).toMatch(/^not-a-schematic:/)
  })

  it("switch 11, a KiCad 5 schematic is named and its release said, and refused until the legacy reader is built", () => {
    expect(code("EESchema Schematic File Version 4\nLIBS:power\n")).toMatch(/^legacy-schematic: This is a KiCad 5 or older schematic \(EESchema Schematic File Version 4\)/)
  })

  it("binary noise and a file with a byte order mark and UTF-16 text", () => {
    expect(code(new Uint8Array([0, 1, 2, 3, 250, 251, 252]))).toMatch(/^(not-a-schematic|not-sexpr|unbalanced|truncated):/)
    const text = schematic()
    const bom = new TextEncoder().encode(`﻿${text}`)
    expect(code(bom)).toBe("no error")
    const utf16 = new Uint8Array(2 + text.length * 2)
    utf16.set([0xff, 0xfe])
    for (let i = 0; i < text.length; i++) {
      utf16[2 + i * 2] = text.charCodeAt(i) & 0xff
      utf16[3 + i * 2] = text.charCodeAt(i) >> 8
    }
    const r = readKicadSchematic(utf16)
    expect(r.schematic.version).toBe(20230121)
    expect(r.report.entries.some((e) => e.code === "encoding" && /UTF-16/.test(e.why))).toBe(true)
  })

  it("a bad byte is named and the file is read as it is", () => {
    const bytes = new TextEncoder().encode(schematic({ labels: ["A 1 1 0"] }))
    const bad = new Uint8Array([...bytes.slice(0, 40), 0xff, ...bytes.slice(40)])
    const r = readKicadSchematic(bad)
    expect(r.report.entries.some((e) => e.code === "encoding" && /not valid UTF-8/.test(e.why))).toBe(true)
  })

  it("a stamp newer than the reader's and a file with none are notes, not errors", () => {
    expect(readKicadSchematic(schematic({ version: 20990101 })).report.entries.map((e) => e.code)).toContain("newer-format")
    expect(readKicadSchematic(`(kicad_sch (uuid x) (lib_symbols))`).report.entries.map((e) => e.code)).toContain("no-version")
  })
})

// ---------- the hierarchy ----------

const sheetNode = (name: string, file: string, uuid: string, v6 = false) =>
  `(sheet (at 10 10) (size 20 10) (uuid ${uuid}) (property "${v6 ? "Sheet name" : "Sheetname"}" "${name}" (at 10 9 0)) (property "${v6 ? "Sheet file" : "Sheetfile"}" "${file}" (at 10 21 0)))`

const files = (entries: Record<string, string>) => new Map(Object.entries(entries))

describe("the sheets of a schematic are read, whether or not hierarchy is built", () => {
  const tree = (f: Record<string, string>, root = "root.kicad_sch"): SchematicTree => readSchematicTree(files(f), root)

  it("follows a sheet file and the sheets below it, with the instance path of each", () => {
    const t = tree({
      "root.kicad_sch": schematic({ uuid: "r", body: [sheetNode("A", "a.kicad_sch", "sa")] }),
      "a.kicad_sch": schematic({ uuid: "a", body: [sheetNode("B", "sub/b.kicad_sch", "sb")] }),
      "sub/b.kicad_sch": schematic({ uuid: "b" }),
    })
    expect([...t.files.keys()]).toEqual(["root.kicad_sch", "a.kicad_sch", "sub/b.kicad_sch"])
    expect(t.instances.map((i) => [i.path, i.file])).toEqual([
      ["/r", "root.kicad_sch"],
      ["/r/sa", "a.kicad_sch"],
      ["/r/sa/sb", "sub/b.kicad_sch"],
    ])
    expect(t.errors).toEqual([])
    expect(t.uses.map((u) => [u.parent, u.file, u.found])).toEqual([
      ["root.kicad_sch", "a.kicad_sch", true],
      ["a.kicad_sch", "sub/b.kicad_sch", true],
    ])
  })

  it("KiCad 6 names a sheet's file `Sheet file`", () => {
    const t = tree({ "root.kicad_sch": schematic({ version: 20211123, uuid: "r", body: [sheetNode("A", "a.kicad_sch", "sa", true)] }), "a.kicad_sch": schematic({ version: 20211123, uuid: "a" }) })
    expect(t.files.size).toBe(2)
    expect(t.errors).toEqual([])
  })

  it("a file used by two sheets is read once and has two instances", () => {
    const t = tree({
      "root.kicad_sch": schematic({ uuid: "r", body: [sheetNode("Left", "ch.kicad_sch", "s1"), sheetNode("Right", "ch.kicad_sch", "s2")] }),
      "ch.kicad_sch": schematic({ uuid: "c" }),
    })
    expect(t.files.size).toBe(2)
    expect(t.instances.filter((i) => i.file === "ch.kicad_sch").map((i) => i.path)).toEqual(["/r/s1", "/r/s2"])
    expect(t.uses).toHaveLength(2)
  })

  it("finds a file whatever the case and the slashes it is named with", () => {
    const t = tree({ "root.kicad_sch": schematic({ uuid: "r", body: [sheetNode("A", "Sub\\\\A.KICAD_SCH", "sa")] }), "sub/a.kicad_sch": schematic({ uuid: "a" }) })
    expect(t.errors).toEqual([])
    expect(t.files.has("sub/a.kicad_sch")).toBe(true)
  })

  it("a missing sheet file is a named error, and the rest of the tree is read", () => {
    const t = tree({ "root.kicad_sch": schematic({ uuid: "r", body: [sheetNode("Gone", "gone.kicad_sch", "sg"), sheetNode("Here", "here.kicad_sch", "sh")] }), "here.kicad_sch": schematic({ uuid: "h" }) })
    expect(t.errors.map((e) => [e.code, e.file, e.sheet])).toEqual([["missing", "gone.kicad_sch", "Gone"]])
    expect(t.errors[0].message).toBe(`the sheet "Gone" (gone.kicad_sch) is not among the files, so its pages are missing.`)
    expect(t.files.has("here.kicad_sch")).toBe(true)
    expect(t.uses.find((u) => u.file === "gone.kicad_sch")?.found).toBe(false)
  })

  it("a sheet with no file name is a named error", () => {
    const t = tree({ "root.kicad_sch": schematic({ uuid: "r", body: [`(sheet (at 1 1) (size 5 5) (uuid s))`] }) })
    expect(t.errors.map((e) => e.code)).toEqual(["missing"])
    expect(t.errors[0].message).toMatch(/has no file name/)
  })

  it("a truncated or damaged sheet file is a named error, not a crash", () => {
    const good = schematic({ uuid: "a" })
    for (const [what, text, re] of [
      ["truncated", good.slice(0, 120), /could not be read: The file stops/],
      ["empty", "", /could not be read: The file is empty/],
      ["a board", `(kicad_pcb (version 1))`, /could not be read: This is a KiCad board/],
      ["a KiCad 5 sheet", "EESchema Schematic File Version 4\n", /KiCad 5 or older schematic/],
    ] as const) {
      const t = tree({ "root.kicad_sch": schematic({ uuid: "r", body: [sheetNode("A", "a.kicad_sch", "sa")] }), "a.kicad_sch": text })
      expect(t.errors.map((e) => e.code), what).toEqual(["unreadable"])
      expect(t.errors[0].message, what).toMatch(re)
    }
  })

  it("a sheet that contains itself, directly or through others, is a named error and does not hang", () => {
    const self = tree({ "root.kicad_sch": schematic({ uuid: "r", body: [sheetNode("Me", "root.kicad_sch", "sm")] }) })
    expect(self.errors.map((e) => e.code)).toEqual(["cycle"])
    const loop = tree({
      "root.kicad_sch": schematic({ uuid: "r", body: [sheetNode("A", "a.kicad_sch", "sa")] }),
      "a.kicad_sch": schematic({ uuid: "a", body: [sheetNode("B", "b.kicad_sch", "sb")] }),
      "b.kicad_sch": schematic({ uuid: "b", body: [sheetNode("A again", "a.kicad_sch", "sc")] }),
    })
    expect(loop.errors.map((e) => e.code)).toEqual(["cycle"])
    expect(loop.errors[0].message).toMatch(/contains itself/)
    expect(loop.files.size).toBe(3)
  })

  it("a hierarchy nested deeper than any project is a named error", () => {
    const f: Record<string, string> = { "root.kicad_sch": schematic({ uuid: "r", body: [sheetNode("L1", "l1.kicad_sch", "s1")] }) }
    for (let i = 1; i <= MAX_SHEET_DEPTH + 5; i++) f[`l${i}.kicad_sch`] = schematic({ uuid: `u${i}`, body: [sheetNode(`L${i + 1}`, `l${i + 1}.kicad_sch`, `s${i + 1}`)] })
    const t = tree(f)
    expect(t.errors.map((e) => e.code)).toEqual(["too-deep"])
    expect(t.instances.length).toBeLessThanOrEqual(MAX_SHEET_DEPTH + 1)
  })

  it("a hierarchy that expands to more uses than any project has is a named error", () => {
    // 150 uses of one file, each of which uses 150 uses of another: 22,650 instances.
    const many = (file: string, n: number) => Array.from({ length: n }, (_, i) => sheetNode(`S${i}`, file, `u${file}${i}`))
    const t = tree({
      "root.kicad_sch": schematic({ uuid: "r", body: many("mid.kicad_sch", 150) }),
      "mid.kicad_sch": schematic({ uuid: "m", body: many("leaf.kicad_sch", 150) }),
      "leaf.kicad_sch": schematic({ uuid: "l" }),
    })
    expect(t.errors.some((e) => e.code === "too-many")).toBe(true)
    expect(t.instances.length).toBeLessThanOrEqual(MAX_SHEET_INSTANCES + 1)
  })

  it("a root that is missing or unreadable is thrown as a named error", () => {
    expect(() => readSchematicTree(files({}), "root.kicad_sch")).toThrow(/is not among the files/)
    expect(() => readSchematicTree(files({ "root.kicad_sch": "(kicad_sch" }), "root.kicad_sch")).toThrow(KicadSchematicReadError)
  })
})
