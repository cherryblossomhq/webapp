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
