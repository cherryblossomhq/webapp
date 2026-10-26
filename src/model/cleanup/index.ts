import { isArranged } from "../tidy/nets"
import { keptNotes, netlistChanges, tidyNotes, tidySchematic, type TidyResult } from "../tidy"
import type { Project } from "../types"
import { groupLooseParts, type Grouping } from "./group"

// Clean up: the parts in no block grouped by how they are wired (`group.ts`), then Tidy on the whole
// sheet. It is the free version of "Clean up"; Sakura's version (`ai/cleanupAi.ts`) groups by
// function instead and finishes with the same Tidy.
//
// The user sees what it will do before it does it (`planCleanup`, `cleanupSummary`), and what it
// does is one new project: the grouping is only a list of parts, and every Tidy is checked against
// the netlist. `finishCleanup` checks the whole of it once more, so a sheet that would come out
// with a different connection is refused and left as it was.

export interface CleanupPlan extends Grouping {
  /** The project as it was. */
  before: Project
}

export interface CleanupResult {
  /** The sheet to keep: the cleaned one, or the one given when nothing was done. */
  project: Project
  /** False when the sheet is left as it was. */
  changed: boolean
  /** False when it was refused; `message` says why. */
  ok: boolean
  /** One or two sentences for the user. */
  message: string
  plan: CleanupPlan
  tidy: TidyResult | null
}

/** Whether there is anything on the sheet to clean up. */
export const hasParts = (project: Project) => project.components.some((c) => isArranged(c.partId))

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`

/** What cleaning up would group, without changing the sheet. */
export function planCleanup(project: Project): CleanupPlan {
  return { ...groupLooseParts(project), before: project }
}

type Counts = Pick<CleanupPlan, "grouped" | "created" | "joined">

/** "5 blocks", or "5 new blocks, adding 2 to blocks you made" when some parts joined blocks that were there. */
function intoBlocks({ grouped, created, joined }: Counts): string {
  if (!joined) return plural(created, "block")
  if (joined === grouped) return "your blocks"
  return `${plural(created, "new block")}, adding ${joined} to blocks you made,`
}

/** The question the preview asks: "Group 31 parts into 5 blocks and tidy the sheet?" */
export function cleanupSummary(plan: Counts): string {
  if (!plan.grouped) return "Every part is already in a block. Tidy the sheet?"
  return `Group ${plural(plan.grouped, "part")} into ${intoBlocks(plan)} and tidy the sheet?`
}

/** The sentence after a cleanup: what was grouped and that the sheet is tidy. */
export function cleanupDone(plan: Counts): string {
  if (!plan.grouped) return "Tidied the sheet."
  return `Grouped ${plural(plan.grouped, "part")} into ${intoBlocks(plan)} and tidied the sheet.`
}

const refused = (plan: CleanupPlan, message: string, tidy: TidyResult | null = null): CleanupResult => ({
  project: plan.before,
  changed: false,
  ok: false,
  message,
  plan,
  tidy,
})

/**
 * Take Tidy's answer for the grouped sheet and decide what to keep: the tidied sheet; the grouped
 * one when it was tidy already; nothing, with the reason, when Tidy refused or any connection
 * differs from the sheet as it was.
 */
export function finishCleanup(plan: CleanupPlan, tidy: TidyResult): CleanupResult {
  // Tidy's own sentence says it left the sheet as it was.
  if (!tidy.ok) return refused(plan, tidy.message, tidy)
  const project = tidy.changed ? tidy.project : plan.project
  const problems = netlistChanges(plan.before, project, tidy.renamed)
  if (problems.length) return refused(plan, "Clean up would have changed a connection, so nothing was changed.", tidy)
  const changed = project !== plan.before
  if (!changed) return { project: plan.before, changed: false, ok: true, message: "Already clean.", plan, tidy }
  const extras = tidy.changed ? tidyNotes(tidy.renamed, tidy.dropped, tidy.loose) : []
  // One sentence for each block Tidy kept as it was drawn.
  extras.push(...keptNotes(tidy.kept))
  return { project, changed, ok: true, message: [cleanupDone(plan), ...extras].join(" "), plan, tidy }
}

/** The whole of it on this thread: group, tidy the sheet, check. */
export function cleanupSheet(project: Project): CleanupResult {
  const plan = planCleanup(project)
  return finishCleanup(plan, tidySchematic(plan.project))
}
