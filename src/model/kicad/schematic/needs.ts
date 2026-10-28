import { settledFor, symbolFlagged, symbolFlaggedByCensus, type Plainness } from "./carried"
import { resolveRule } from "./account"
import type { KicadSchematic } from "./types"

// What a schematic needs from the editor's model that the model does not have, extension by
// extension (S1 to S10 of docs/kicad-import-schematic.md). A file that needs an extension that is
// not built is refused with "this schematic uses X, which is not supported yet", never imported
// partly. The rules are the ones of `tests/kicad-census/slices-sch.mjs`, which the census judged
// the plan by, with the differences named in `Need.source` and listed in the doc.

/**
 * The extensions the editor has built. Each slice adds its own. Slice 3a built none: it read, linked and
 * checked. Slice 3b-i built the three that every symbol needs: S5 (units, body styles, alternates, mirror,
 * fields with a place of their own, hidden power pins, repeated pin numbers), S6 (the shapes, fills and
 * strokes of a symbol's drawing) and S10 (the drawings kept in the project). Slice 3b-ii built S2 (labels,
 * their shapes, sizes and styles, and the net names KiCad gives), S4 (text, text boxes, drawings,
 * pictures, tables, wire strokes, junction dots and no-connect flags of their own, locked groups) and
 * S7 (the flags of a symbol: do not populate, not in the BOM, not on the board, not simulated). S1 is the sheets, S3 the buses, bus entries and bus aliases, S8 directive labels and rule areas, S9 schematic variants,
 * S11 KiCad's rules for what a wire joins (on the sheets that need them), S12 the symbols a
 * schematic's cache lacks, taken from the project's own libraries and the parts database (a symbol found in neither is still refused, naming the libraries looked in).
 */
export const BUILT_EXTENSIONS: ReadonlySet<string> = new Set(["S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8", "S9", "S10", "S11", "S12"])

/** What each extension is, for the sentence "This schematic uses ..., which is not supported yet." */
export const EXTENSION_NAMES: Record<string, string> = {
  S1: "hierarchical sheets",
  S1T: "several top level sheets (a KiCad 10 project with more than one root sheet)",
  S2: "labels and net names as KiCad has them",
  S3: "buses",
  S3B: "bus names the importer cannot read exactly (a bus name on a wire, a name KiCad 9 and 10 read differently, a bus too large)",
  S4: "annotations and styled wires",
  S5: "symbols as KiCad draws them (units, mirrors, hidden power pins, repeated pin numbers)",
  S6: "symbol drawings beyond lines and circles",
  S7: "symbol flags such as do not populate",
  S8: "directive labels and rule areas",
  S9: "schematic variants",
  S10: "symbols kept in the project",
  S9X: "symbol overrides and custom properties (KiCad 11 development files)",
  S11: "KiCad's rules for what a wire joins (a wire end on a wire's side, a label on a pin, points a hair apart)",
  S11L: "KiCad 5's rules for a no-connect pin and for label names, and for a label on a pin on a wire in a sheet that also needs KiCad 6's rules",
  S12: "symbols from a project's own libraries or the parts database",
  X19: "text outlines or embedded fonts",
}

export interface Need {
  ext: string
  /** What in the schematic needs it, in words. */
  why: string
  /** `slices` when the census's rule found it; `importer` when the importer found it on top of those rules. */
  source: "slices" | "importer"
}

const extNumber = (ext: string) => (ext === "S1T" ? 1.5 : ext === "S3B" ? 3.5 : ext === "S9X" ? 9.5 : ext === "S11L" ? 11.5 : Number(ext.slice(1)) + (ext.startsWith("X") ? 100 : 0))

const GRAPHICS = ["polyline", "rectangle", "circle", "arc", "bezier"]

/**
 * Every extension one file needs that the model does not have, with the reason, by the census's
 * rules (`slices-sch.mjs`) first. `plain` is the plainness of the project the file is in, and
 * decides which of the file's `extend` nodes say nothing the editor does not already.
 */
export function needsOfFile(s: KicadSchematic, paths: ReadonlyMap<string, number>, plain: Plainness, covered?: (libId: string) => boolean): Need[] {
  const out = new Map<string, Need>()
  const need = (ext: string, why: string, source: Need["source"] = "slices") => {
    if (!out.has(ext)) out.set(ext, { ext, why, source })
  }
  const other = (token: string) => s.others[token]?.length ?? 0

  if (s.symbols.length > 0) for (const ext of ["S5", "S6", "S10"]) need(ext, "symbols on the sheet")
  else if (s.libSymbols.length > 0) for (const ext of ["S5", "S6", "S10"]) need(ext, "cached symbols that no symbol is placed from", "importer")
  const hier = s.labels.filter((l) => l.kind === "hierarchical").length
  if (s.sheets.length > 0 || hier > 0) need("S1", s.sheets.length ? "sheets" : "hierarchical labels")
  if (s.labels.some((l) => l.kind === "global")) need("S2", "global labels")
  // KiCad's own net names (`/NAME`, `Net-(R1-Pad2)`) are in the netlist of every board a symbol has pads on.
  if (s.symbols.some((sym) => !/^power:/.test(sym.libId))) need("S2", "net names as KiCad writes them, on the nets of symbols")
  if (s.buses.length > 0 || s.busEntries.length > 0 || s.busAliases.length > 0) need("S3", "buses, bus entries or bus aliases")
  if (other("text") > 0 || other("text_box") > 0 || GRAPHICS.some((g) => other(g) > 0) || other("image") > 0 || other("table") > 0) need("S4", "text, drawings, images or tables")
  if (s.symbols.some(symbolFlaggedByCensus)) need("S7", "symbols marked do not populate, not in the BOM, not on the board or left out of simulation")
  if (s.labels.some((l) => l.kind === "directive") || other("rule_area") > 0) need("S8", "directive labels or rule areas")
  if ([...paths.keys()].some((p) => /variant$/.test(p))) need("S9", "schematic variants")

  // A KiCad 5 schematic whose symbols are in no library the project gives (its own, a `sym-lib-table` library or the parts database): they are in KiCad's own libraries, which the importer does not have.
  // (S12: a symbol that a library of the project or the parts database has is not missing.)
  const missing = s.legacy?.symbolSources.filter((x) => x.from === "missing" && !covered?.(x.libId)) ?? []
  if (missing.length) need("S12", `symbols that no library of the project has (${missing.slice(0, 4).map((x) => x.libId).join(", ")}${missing.length > 4 ? ", ..." : ""})`, "importer")

  // The importer's own additions: what the model cannot hold that the census rules did not list.
  if (s.symbols.some((sym) => symbolFlagged(sym) && !symbolFlaggedByCensus(sym))) need("S7", "a symbol left out of the position files", "importer")

  // Every other `extend` node of the table stands for something the model must grow to hold; a file with one is not imported until it has.
  for (const path of paths.keys()) {
    const rule = resolveRule(path)
    if (rule?.decision !== "extend" || !rule.ext || out.has(rule.ext)) continue
    if (settledFor(path, plain)) continue
    need(rule.ext, `the node "${path}"`, "importer")
  }
  return [...out.values()].sort((a, b) => extNumber(a.ext) - extNumber(b.ext))
}

/** The needs of a project: the union of the needs of its files, each with its first reason. */
export function needsOfProject(perFile: Need[][]): Need[] {
  const out = new Map<string, Need>()
  for (const needs of perFile) for (const n of needs) if (!out.has(n.ext)) out.set(n.ext, n)
  return [...out.values()].sort((a, b) => extNumber(a.ext) - extNumber(b.ext))
}

/** The extensions a schematic needs that are not built. */
export const unbuilt = (needs: Need[], built: ReadonlySet<string> = BUILT_EXTENSIONS) => needs.filter((n) => !built.has(n.ext))

/** "This schematic uses A, B and C, which are not supported yet." `subject` is what comes before the list and says "uses"/"use" itself. */
export function refusalMessage(needs: Need[], subject = "This schematic uses", names: Record<string, string> = EXTENSION_NAMES): string {
  const list = needs.map((n) => names[n.ext] ?? n.ext)
  const text = list.length <= 1 ? list.join("") : `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`
  // Every name is a plural noun (sheets, labels, buses), so it is "are" for one extension as for several.
  return `${subject} ${text}, which are not supported yet.`
}
