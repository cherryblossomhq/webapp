import type { ReportEntry } from "../../board/report"
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
      why: `Each was taken from ${[...from].map(([k, n]) => `${k} (${n})`).join(", ")}: the cache first, then the project's libraries in the order its .pro lists them.`,
      count: symbols - missing.size,
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
