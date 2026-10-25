// Which schematic extensions a `.kicad_sch` file needs to import exactly, by the census's rules:
// the rule `slices-sch.mjs` judges the plan by, and the one the importer's own needs are compared
// with (`tests/kicad-schematic-corpus.test.ts`). `d` is the `d` of a record of `census-sch.mjs`.
//
// Every file with symbols needs S5 (each symbol's fields have their own place), S6 (symbol
// drawings use fills and strokes the editor's primitives lack) and S10 (a cached symbol must be
// stored somewhere), so no file passes before those three are built.

export function needsSch(d) {
  const n = new Set()
  if (d.symbols > 0) for (const x of ["S5", "S6", "S10"]) n.add(x)
  if (d.sheets > 0 || d.hierarchicalLabels > 0) n.add("S1")
  if (d.globalLabels > 0) n.add("S2")
  // KiCad's own net names (`/NAME`, `Net-(R1-Pad2)`) are on the nets of any symbol that is not a power symbol.
  if (d.symbols - d.powerSymbols > 0) n.add("S2")
  if (d.buses > 0 || d.busEntries > 0 || d.busAliases > 0) n.add("S3")
  if (d.texts > 0 || d.textBoxes > 0 || d.graphics > 0 || d.images > 0 || d.tables > 0) n.add("S4")
  if (d.flaggedSymbols > 0 || d.dnp > 0) n.add("S7")
  if (d.directiveLabels > 0 || d.ruleAreas > 0) n.add("S8")
  if (d.variants > 0) n.add("S9")
  return n
}
