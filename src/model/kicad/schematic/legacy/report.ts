import type { ReportEntry } from "../../board/report"
import type { PlacedSymbol } from "../types"
import type { SchematicTree } from "../tree"

// What the import report says about the KiCad 5 side of a project: where each symbol came from,
// the libraries that could not be read, and what was found beside them and not read.

const list = (names: string[], max = 4) => `${names.slice(0, max).join(", ")}${names.length > max ? ", ..." : ""}`

/** The report entries for the legacy sheets and libraries of a tree; none for a project with none. */
export function legacyEntries(tree: SchematicTree): ReportEntry[] {
  const sources = tree.legacy
  if (!sources) return []
  const out: ReportEntry[] = []
  if (sources.proError) {
    out.push({ code: "legacy-pro-unreadable", severity: "refused", object: sources.proFile ?? "the project file", why: `The project file cannot be read (${sources.proError}), so the libraries it lists are not known.` })
  }
  // Where every symbol of every sheet came from.
  const from = new Map<string, number>()
  const missing = new Set<string>()
  let symbols = 0
  for (const f of tree.files.values()) {
    for (const s of f.schematic.legacy?.symbolSources ?? []) {
      symbols++
      if (s.from === "missing") missing.add(s.libId)
      else {
        const k = `${s.from === "cache" ? "the cache" : "the library"} ${s.file}`
        from.set(k, (from.get(k) ?? 0) + 1)
      }
    }
  }
  if (from.size) {
    out.push({
      code: "legacy-symbol-sources",
      severity: "note",
      object: `${symbols - missing.size} symbol${symbols - missing.size === 1 ? "" : "s"} of the sheets`,
      why: `Each was taken from ${[...from].map(([k, n]) => `${k} (${n})`).join(", ")}: the cache first, then the project's libraries in the order its .pro lists them. The cache holds the symbols as the schematic was last saved with them. KiCad 5 would first try the libraries installed with it, which the importer does not have; a symbol from a library of the project has not been through the cache.`,
      count: symbols - missing.size,
    })
  }
  const fromLibrary = librarySymbols(tree)
  if (fromLibrary.length) {
    const libs = new Set<string>()
    for (const f of tree.files.values()) for (const x of f.schematic.legacy?.symbolSources ?? []) if (x.from === "library" && x.file) libs.add(x.file)
    out.push({
      code: "symbol-from-library",
      severity: "changed",
      object: `${fromLibrary.length} symbol${fromLibrary.length > 1 ? "s" : ""} (${list(fromLibrary.map(symbolRef))}) from ${list([...libs], 3)}`,
      why: "These symbols come from a library of the project, not from the drawing the sheet was saved with (the schematic's own cache has no entry for them), and the library may have changed since: its pin numbers may differ from the drawing, which would put the nets on other pins without a sign in the schematic.",
      count: fromLibrary.length,
    })
  }
  const broken = sources.broken()
  if (missing.size) {
    const tried = sources.list.map((s) => s.file)
    out.push({
      code: "symbol-not-found",
      severity: "refused",
      object: `${missing.size} symbol${missing.size > 1 ? "s" : ""} (${list([...missing])})`,
      why: `No library of the project has them (looked in ${tried.length ? list(tried, 6) : "no library: the project has no cache and lists none that is among the files"}${sources.missing.length ? `; the project lists ${list(sources.missing, 6)}, which ${sources.missing.length > 1 ? "are" : "is"} not among the files` : ""}). KiCad takes such symbols from the libraries installed with it, which the importer does not have yet (S12): nothing is guessed.`,
      count: missing.size,
    })
    for (const b of broken) out.push({ code: "library-unreadable", severity: "refused", object: b.source.file, why: `The library cannot be read: ${b.error}` })
  } else {
    for (const b of broken) out.push({ code: "library-unreadable", severity: "note", object: b.source.file, why: `The library cannot be read (${b.error}); no symbol of the sheets needed it.` })
  }
  for (const o of sources.opened()) {
    for (const why of o.notes) out.push({ code: "encoding", severity: "note", object: o.source.file, why })
  }
  if (sources.docFiles.length) {
    out.push({ code: "legacy-docs-not-read", severity: "note", object: `${sources.docFiles.length} library documentation file${sources.docFiles.length > 1 ? "s" : ""} (${list(sources.docFiles)})`, why: "The descriptions, keywords and datasheet links of library symbols are not read; the drawings, pins and fields are." })
  }
  return out
}

export const symbolRef = (s: PlacedSymbol) => s.props.find((p) => p.name === "Reference")?.value || s.libId

/** The placed symbols of the sheets that were taken from a library of the project and not from the schematic's cache. */
export function librarySymbols(tree: SchematicTree): PlacedSymbol[] {
  const out: PlacedSymbol[] = []
  for (const f of tree.files.values()) {
    const ids = new Set((f.schematic.legacy?.symbolSources ?? []).filter((x) => x.from === "library").map((x) => x.libId))
    if (ids.size) for (const s of f.schematic.symbols) if (ids.has(s.libId)) out.push(s)
  }
  return out
}

/**
 * The warnings an import of a legacy project carries: the symbols taken from a library of the project that nothing compared with a board. With a board, the pad against pin
 * comparison names a renumbered part (`compared` holds the symbols it covered); with none, nothing checks the library's pin numbers against the drawing the wires were made for.
 */
export function legacyWarnings(tree: SchematicTree, compared: ReadonlySet<object> | null): string[] {
  const open = librarySymbols(tree).filter((s) => !compared?.has(s))
  if (!open.length) return []
  return [
    `${open.length} symbol${open.length > 1 ? "s" : ""} (${list(open.map(symbolRef))}) come${open.length > 1 ? "" : "s"} from a library of the project, not from the drawing the sheet was saved with, and ${compared ? "no board footprint is linked to check" : "there is no board to check"} the pin numbers against. If the library numbers the pins differently, the nets are wrong without a sign.`,
  ]
}
