import { describe, expect, it } from "vitest"
import { importKicadSchematic } from "../src/model/kicad/schematic"
import { schematic } from "./kicad-schematic-fixtures"

// Words of KiCad schematics, from KiCad 6's nightlies to KiCad 9, that 1,146 open-source projects found the importer refusing.

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
