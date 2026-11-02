import { lcscNumberOf, matchLcsc, type LcscEntry, type LcscLookup, type LcscStats } from "../model/lcscMatch"
import type { Project } from "../model/types"
import type { ImportOutcome } from "./protocol"
import type { EntryLine } from "./summary"

// The step after an import that needs the network: the parts of the board that carry an LCSC number are looked up and what is found is attached (`model/lcscMatch.ts`
// says what and how). It is the page's, never the importer's: the importer is pure and runs in a worker, and a lookup is a request. It never fails an import: what cannot
// be looked up is a line of the report, and the project is the one the importer built.

/** Whether the project has a part with an LCSC number, which is whether there is anything to look up. */
export const hasLcscNumbers = (project: Project | null | undefined) => !!project?.components.some((c) => lcscNumberOf(c))

const line = (e: LcscEntry): EntryLine => ({ code: e.code, object: e.object, why: e.why, count: e.count })

export interface LcscResult {
  outcome: ImportOutcome
  /** Null when no lookup ran (no source, or nothing to look up). */
  stats: LcscStats | null
}

/**
 * The outcome with the LCSC parts attached and the report saying what was found. With no `lookup` (a host without a parts source) the parts are left as they are and the
 * report says they were not looked up.
 */
export async function attachLcsc(outcome: ImportOutcome, lookup: LcscLookup | null, options: { signal?: AbortSignal; onProgress?: (done: number, total: number) => void } = {}): Promise<LcscResult> {
  const { project, summary } = outcome
  if (!project || summary.status !== "imported" || !hasLcscNumbers(project)) return { outcome, stats: null }
  if (!lookup) {
    const n = project.components.filter((c) => lcscNumberOf(c)).length
    const entries: LcscEntry[] = [{ code: "lcsc-not-looked-up", object: `${n} part${n > 1 ? "s" : ""} with an LCSC number`, why: "The parts database is not available here, so they were not looked up and stay as the file has them.", count: n }]
    return { outcome: { ...outcome, summary: { ...summary, notes: [...summary.notes, ...entries.map(line)] } }, stats: null }
  }
  const matched = await matchLcsc(project, lookup, options)
  return { outcome: { ...outcome, project: await rehashed(matched.project), summary: { ...summary, notes: [...summary.notes, ...matched.entries.map(line)] } }, stats: matched.stats }
}

/**
 * What the lookup attached is part of the project as imported: the hash the export compares with (`kicad.original.content`) is taken again, or the first export
 * of a board with an LCSC part would find the project changed and write the user's files again instead of giving them back as they were.
 */
async function rehashed(project: Project): Promise<Project> {
  const original = project.kicad?.original
  if (!original) return project
  const { contentHash } = await import("../export/keep/pack")
  return { ...project, kicad: { ...project.kicad, original: { ...original, content: await contentHash(project) } } }
}
