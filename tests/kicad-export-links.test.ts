import { describe, expect, it } from "vitest"
import { applyFootprintLinks } from "../src/export/kicadLinks"
import { applyLibraryIdentity } from "../src/export/kicadLibNames"
import { kicadNetName } from "../src/model/netNames"
import type { SymbolDrawing } from "../src/model/types"

// The three small rewrites that put a KiCad project's identity back into the files the export writes: the footprints' links to their symbols (`path`), the library name and library fields of
// a symbol, and a net name as KiCad writes it. (`kicad-judge-corpus.test.ts` checks them with KiCad itself: "Update PCB from Schematic" must find nothing to change.)

const SYMBOL = (uuid: string, ref: string, lib = "Device:U_chip_schematic_component_1") => `
  (symbol
    (lib_id "${lib}")
    (at 10 10 0)
    (unit 1)
    (uuid ${uuid})
    (property "Reference" "${ref}"
      (id 0)
    )
    (instances
      (project "demo"
        (path "/aaaaaaaa-0000-4000-8000-000000000001"
          (reference "${ref}")
          (unit 1)
        )
      )
    )
  )`

const SHEET = `(kicad_sch
  (version 20250114)
  (lib_symbols
  )${SYMBOL("11111111-0000-4000-8000-000000000001", "R1")}${SYMBOL("11111111-0000-4000-8000-000000000002", "C1")}
)`

const FOOTPRINT = (ref: string) => `
  (footprint "Local:R"
    (layer "F.Cu")
    (uuid 00000000-0000-4000-8000-000000000009)
    (at 1 2)
    (property "Reference" "${ref}"
      (at 0 0 0)
    )
    (attr smd)
    (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu"))
  )`

describe("a footprint's link to its symbol", () => {
  it("is the path of the symbol, and the file of its sheet", () => {
    const pcb = `(kicad_pcb\n  (version 20241229)${FOOTPRINT("R1")}${FOOTPRINT("U9")}\n)`
    const out = applyFootprintLinks(pcb, [{ file: "demo.kicad_sch", text: SHEET }])
    const r1 = out.slice(out.indexOf('"R1"'), out.indexOf('"U9"'))
    expect(r1).toContain('(path "/11111111-0000-4000-8000-000000000001")')
    expect(r1).toContain('(sheetfile "demo.kicad_sch")')
    // a footprint with no symbol is left as it is
    expect(out.slice(out.indexOf('"U9"'))).not.toContain("(path ")
  })

  it("is the path through the sheet symbols for a symbol of a sub-sheet", () => {
    const sub = SHEET.replace("/aaaaaaaa-0000-4000-8000-000000000001", "/aaaaaaaa-0000-4000-8000-000000000001/bbbbbbbb-0000-4000-8000-000000000002")
    const out = applyFootprintLinks(`(kicad_pcb${FOOTPRINT("R1")}\n)`, [{ file: "sub.kicad_sch", text: sub }])
    expect(out).toContain('(path "/bbbbbbbb-0000-4000-8000-000000000002/11111111-0000-4000-8000-000000000001")')
    expect(out).toContain('(sheetfile "sub.kicad_sch")')
  })
})

const LIB = `
    (symbol "Device:U_chip_schematic_component_1"
      (pin_numbers
        (hide yes)
      )
      (property "Reference" "U"
        (id 0)
        (at 0 0 0)
      )
      (property "ki_keywords" "U IC chip"
        (id 5)
        (at 0 0 0)
      )
      (property "ki_fp_filters" "*"
        (id 6)
        (at 0 0 0)
      )
      (symbol "U_chip_schematic_component_1_0_1"
      )
      (symbol "U_chip_schematic_component_1_1_1"
      )
    )`

describe("a symbol that came from KiCad", () => {
  const drawing = { name: "Device:C", items: [], pins: [], fields: [{ name: "Reference", value: "C", place: { x: 0, y: 0, angle: 0 } }], ki: [{ name: "ki_keywords", value: "cap capacitor" }] } as unknown as SymbolDrawing
  const text = SHEET.replace("  (lib_symbols\n  )", `  (lib_symbols${LIB}\n  )`)

  it("keeps its library name and what its library entry said of itself", () => {
    const out = applyLibraryIdentity(text, (ref) => (ref === "R1" ? drawing : undefined))
    expect(out).toContain('(lib_id "Device:C")')
    expect(out).toContain('(symbol "Device:C"')
    expect(out).toContain('(symbol "C_0_1"')
    expect(out).toContain('(symbol "C_1_1"')
    expect(out).toContain('(property "Reference" "C"')
    expect(out).toContain('(property "ki_keywords" "cap capacitor"')
    // the converter's own words for what the entry did not say are gone
    expect(out).not.toContain("ki_fp_filters")
    expect(out).not.toContain("U IC chip")
    // every symbol placed from that library symbol follows its name
    expect(out.match(/\(lib_id "Device:C"\)/g)).toHaveLength(2)
  })
})

describe("a net name as KiCad writes it", () => {
  it("escapes the slash of a label's own text and keeps the sheet's path", () => {
    expect(kicadNetName({ name: "/VPP/MCLR", named: true, label: { text: "VPP/MCLR", kind: "local" } })).toBe("/VPP{slash}MCLR")
    expect(kicadNetName({ name: "VPP/MCLR", named: true, label: { text: "VPP/MCLR", kind: "global" } })).toBe("VPP{slash}MCLR")
    expect(kicadNetName({ name: "/Sub/NAME", named: true, label: { text: "NAME", kind: "local" } })).toBe("/Sub/NAME")
    expect(kicadNetName({ name: "/VBATT", named: true }, true)).toBe("/VBATT")
    expect(kicadNetName({ name: "A/B", named: true }, true)).toBe("A{slash}B")
    expect(kicadNetName({ name: "Net-(R1-Pad2)", named: false }, true)).toBe("Net-(R1-Pad2)")
  })
})
