import { describe, expect, it } from "vitest"
import { importKicadSchematic } from "../src/model/kicad/schematic"
import { LIB_R, schematic } from "./kicad-schematic-fixtures"

// Words of KiCad schematics, from KiCad 6's nightlies to KiCad 9, that 1,146 open-source projects found the importer refusing.

const R1 = "aaaaaaaa-0000-4000-8000-000000000001"

const imp = (text: string) => {
  const r = importKicadSchematic(text)
  if (r.status !== "imported") throw new Error(`refused: ${r.message}\n${r.report.entries.map((e) => e.why).join("\n")}`)
  return r
}

describe("a hierarchical label's own fields (KiCad 9)", () => {
  it("are read as any label's", () => {
    const label = `(hierarchical_label "IN" (shape input) (at 30.48 20.32 180) (effects (font (size 1.27 1.27)) (justify right)) (uuid h1) (property "Intersheetrefs" "\${INTERSHEET_REFS}" (at 20 20.32 0) (effects (font (size 1.27 1.27)) (justify left) (hide yes))))`
    const { project } = imp(schematic({ version: 20250114, body: [label] }))
    const l = project.labels.find((x) => x.name === "IN")!
    expect(l.kind).toBe("hierarchical")
    expect(l.fields?.[0]).toMatchObject({ name: "Intersheetrefs", place: { hidden: true, h: "left" } })
  })
})

describe("a sheet's page number and count (KiCad 6 nightlies, 2020)", () => {
  it("is passed over: the export numbers the pages in tree order", () => {
    const r = imp(schematic({ version: 20200828, head: "(page 2 20)", libs: [LIB_R], symbols: [{ lib: "Device:R", at: "50.8 50.8", ref: "R1", uuid: R1 }] }))
    expect(r.project.components.map((c) => c.ref)).toEqual(["R1"])
  })
})

describe("the pin type unconnected (KiCad 6 nightlies, before 20210123)", () => {
  it("is read as no_connect, the name KiCad gave it later", () => {
    const lib = LIB_R.replace(`(pin passive line (at 0 -3.81 90)`, `(pin unconnected line (at 0 -3.81 90)`)
    const r = imp(schematic({ version: 20201015, libs: [lib], symbols: [{ lib: "Device:R", at: "50.8 50.8", ref: "R1", uuid: R1 }] }))
    const pins = Object.values(r.project.symbols ?? {}).flatMap((d) => d.pins)
    expect(pins.map((p) => p.type).sort()).toEqual(["no_connect", "passive"])
  })
})

describe("a symbol's default instance (a KiCad 7 nightly, 2022)", () => {
  it("is passed over: the symbol's fields and the instance list hold the same", () => {
    const extra = `(default_instance (reference "R?") (unit 1) (value "10k") (footprint ""))`
    const r = imp(schematic({ version: 20220904, libs: [LIB_R], symbols: [{ lib: "Device:R", at: "50.8 50.8", ref: "R1", value: "4k7", uuid: R1, extra }] }))
    expect(r.project.components.map((c) => [c.ref, c.props.value])).toEqual([["R1", "4k7"]])
  })
})

describe("files a symbol packs inside the schematic (KiCad 9)", () => {
  it("are left out, each named in the report with its symbol", () => {
    const lib = LIB_R.replace(/\)$/, ` (embedded_files (file (name "R_datasheet.pdf") (type datasheet) (data |KLUv/QBYAQAA|))))`)
    const r = imp(schematic({ version: 20250114, libs: [lib], symbols: [{ lib: "Device:R", at: "50.8 50.8", ref: "R1", uuid: R1 }] }))
    const entry = r.report.entries.find((e) => e.code === "embedded-file-not-brought")
    expect(entry?.object).toContain("R_datasheet.pdf (datasheet) of the symbol Device:R")
  })
})

describe("a symbol's text box (KiCad 7 and later)", () => {
  const box = (extra: string) => `(text_box "RF\nrcv" (at -1 2 0) (size 2 -1) ${extra} (fill (type none)) (effects (font (size 0.762 0.762)) (justify top)))`
  const drawing = (extra: string) => {
    const lib = LIB_R.replace(`(fill (type none))))`, `(fill (type none))) ${box(extra)})`)
    const r = imp(schematic({ version: 20231120, libs: [lib], symbols: [{ lib: "Device:R", at: "50.8 50.8", ref: "R1", uuid: R1 }] }))
    return Object.values(r.project.symbols ?? {})[0]
  }

  it("is drawn as its border and its text, inside KiCad's margins for a symbol's box", () => {
    const d = drawing("(stroke (width 0) (type default))")
    const rect = d.items.find((i) => i.kind === "rectangle" && i.a.y > 0.1)!
    if (rect.kind !== "rectangle") throw new Error("no box")
    expect([rect.a.x, rect.a.y, rect.b.x, rect.b.y].map((v) => v * 12.7)).toEqual([-1, 2, 1, 1].map((v) => expect.closeTo(v, 3)))
    const text = d.items.find((i) => i.kind === "text")!
    if (text.kind !== "text") throw new Error("no text")
    expect(text.text).toBe("RF\nrcv")
    expect(text.v).toBe("top")
    expect(text.h).toBeUndefined()
    expect(text.at.x).toBeCloseTo(0, 6)
    // Without margins of its own, a symbol's box keeps 0.8 of the text's height from each side.
    expect(text.at.y).toBeCloseTo((2 - 0.762 * 0.8) / 12.7, 4)
  })

  it("keeps the margins the file gives, and draws no border where its width is negative", () => {
    const d = drawing("(margins 0.2 0.3 0.2 0.3) (stroke (width -0.0001) (type default))")
    expect(d.items.filter((i) => i.kind === "rectangle" && i.a.y > 0.1)).toHaveLength(0)
    const text = d.items.find((i) => i.kind === "text")!
    if (text.kind !== "text") throw new Error("no text")
    expect(text.at.y).toBeCloseTo((2 - 0.3) / 12.7, 4)
  })
})
