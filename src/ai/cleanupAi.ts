import { cleanBlockName, findBlock, groupOf } from "../model/blocks"
import { findPart } from "../model/library"
import { isArranged } from "../model/tidy/nets"
import type { ComponentInstance, Project } from "../model/types"
import type { ToolSet } from "./copilot"
import { runTool, TOOL_DEFINITIONS, validateInput, type FunctionTool, type JsonSchema, type ToolOutcome } from "./tools"

// Clean up with AI (Pro and up). Two requests in one conversation, with the user between them:
//
// 1. Plan. Sakura reads the design (`get_design`) and proposes functional blocks with
//    `propose_blocks`. That tool only checks the plan and records it; the plan is shown in the
//    Sakura panel with Apply and Cancel, and nothing on the sheet has changed. `get_design` and
//    `propose_blocks` are the only tools on offer.
// 2. Apply, once the user confirmed. Sakura groups with `group_parts` and tidies the whole sheet
//    with `tidy_schematic` (whole_sheet is allowed: the user asked for it), then reports. Only
//    those two tools are on offer, and a call that isn't in the confirmed plan is refused, so what
//    is done is what was shown. All of it is one undo step.
//
// The apply request does not take a look at the tidied sheet before the report: the look tool exists
// (`lookTool.ts`), but only the two tools above are on offer in it.

/** What the toolbar's button says in the Sakura panel. */
export const CLEANUP_REQUEST = "Clean up the schematic with AI"

/** The fixed request that starts the plan. */
export const CLEANUP_PROMPT = `Clean up this schematic. For now you only propose a plan: change nothing.

1. Call get_design to read the design.
2. Call propose_blocks once, with functional blocks for every part that is in no block yet. Name each block by what it does, short and in capitals, like "USB INPUT", "3.3V POWER", "MCU", "SENSOR" or "LED BAR". Keep each part with the circuit it serves: a regulator with its input and output capacitors and protection diode, a chip with its decoupling capacitors, crystal, load capacitors, reset and pull-up parts, a connector with the small parts beside it, an LED with its resistor. Aim for 3 to 8 blocks, and no block of one small passive part.
3. Parts already in a block stay in it. To add loose parts to a block that exists, use its exact name. Power and ground symbols are not parts: leave them out.
4. If propose_blocks reports a problem, fix the plan and call it again.

When propose_blocks succeeds, stop: the user sees the plan and confirms it. Do not group or tidy yet, and do not repeat the plan: at most one short sentence.`

/** The fixed request that applies a confirmed plan. */
export const CLEANUP_APPLY_PROMPT = `The user confirmed the plan. Apply it exactly as proposed: call group_parts once for each block in the plan, then call tidy_schematic with whole_sheet true (the user asked for the whole sheet to be tidied). Do not change the plan or add parts to it. Then reply with a short report: how many blocks and parts were grouped, and anything the tidy said that the user should know.`

export interface PlanBlock {
  /** As Sakura named it, cleaned up. */
  name: string
  /** Designators, in the order given, without the parts the block already holds. */
  refs: string[]
  /** True when the block exists: these parts are added to it. */
  existing: boolean
}

/** What Sakura proposed, and checked against the sheet it was proposed for. */
export interface ProposedPlan {
  blocks: PlanBlock[]
  /** Parts in no block that the plan leaves out: they end up in OTHER. */
  left: string[]
}

const MAX_NAME = 32
/** Plans that don't fit the sheet in a row, after which the request stops instead of spending its remaining steps. */
const MAX_BAD_PLANS = 3

const SCHEMA: JsonSchema & { type: "object" } = {
  type: "object",
  properties: {
    blocks: {
      type: "array",
      minItems: 1,
      description: "The blocks, each with a name and the designators of its parts",
      items: {
        type: "object",
        properties: {
          name: { type: "string", description: `Block name by function, short and in capitals, at most ${MAX_NAME} characters. The exact name of an existing block adds to it.` },
          refs: { type: "array", minItems: 1, items: { type: "string" }, description: "Designators, e.g. [\"U2\", \"C3\", \"C4\"]" },
        },
        required: ["name", "refs"],
      },
    },
  },
  required: ["blocks"],
}

const PROPOSE: FunctionTool = {
  type: "function",
  function: {
    name: "propose_blocks",
    description:
      "Propose the functional blocks for the schematic, for the user to confirm. It checks the plan and records it; the sheet is not changed. Every part is in at most one block; parts that are in a block stay in it.",
    parameters: SCHEMA,
  },
}

const byRef = (project: Project, ref: string): ComponentInstance | undefined =>
  project.components.find((c) => c.ref.toLowerCase() === ref.trim().toLowerCase())

const sameName = (a: string, b: string) => cleanBlockName(a).toLowerCase() === cleanBlockName(b).toLowerCase()

/** Loose parts: physical, in no block (or only in the OTHER block Tidy makes for them). */
export const loosePartRefs = (project: Project) => project.components.filter((c) => isArranged(c.partId) && !groupOf(project, c.id)).map((c) => c.ref)

/**
 * Check a plan against the sheet: every designator is a part, in one block of the plan only, and
 * not in a block that exists under another name. Returns the plan, or what is wrong with it.
 */
export function checkPlan(project: Project, input: { blocks: { name: string; refs: string[] }[] }): { plan: ProposedPlan } | { problems: string[] } {
  const problems: string[] = []
  const placed = new Map<string, string>()
  const names = new Set<string>()
  const blocks: PlanBlock[] = []
  for (const raw of input.blocks) {
    const name = cleanBlockName(raw.name)
    if (!name) {
      problems.push("A block has no name.")
      continue
    }
    if (name.length > MAX_NAME) problems.push(`"${name}" is longer than ${MAX_NAME} characters.`)
    if (names.has(name.toLowerCase())) problems.push(`Two blocks are named "${name}".`)
    names.add(name.toLowerCase())
    const existing = findBlock(project, name)
    if (existing?.leftover) problems.push(`"${name}" is where Tidy puts parts it could not place: name the block by what it does.`)
    const refs: string[] = []
    for (const r of raw.refs) {
      const c = byRef(project, r)
      if (!c) {
        problems.push(`There is no part ${r.trim()}.`)
        continue
      }
      if (!isArranged(c.partId) || !findPart(c.partId)) {
        problems.push(`${c.ref} is a power or ground symbol, not a part: leave it out.`)
        continue
      }
      const holder = groupOf(project, c.id)
      if (holder && holder.id !== existing?.id) {
        problems.push(`${c.ref} is already in the block ${holder.name}, and parts in a block stay in it.`)
        continue
      }
      const other = placed.get(c.id)
      if (other) {
        problems.push(`${c.ref} is in both ${other} and ${name}.`)
        continue
      }
      placed.set(c.id, name)
      // A part the block already holds needs no move.
      if (!holder) refs.push(c.ref)
    }
    if (refs.length) blocks.push({ name: existing?.name ?? name, refs, existing: !!existing })
  }
  if (problems.length) return { problems }
  if (!blocks.length) return { problems: ["The plan puts no loose part in a block."] }
  const inPlan = new Set(blocks.flatMap((b) => b.refs.map((r) => r.toLowerCase())))
  return { plan: { blocks, left: loosePartRefs(project).filter((r) => !inPlan.has(r.toLowerCase())) } }
}

const fail = (project: Project, message: string): ToolOutcome => ({ project, result: `Error: ${message}`, summary: message, isError: true })

export interface PlanningSession {
  tools: ToolSet
  /** The plan Sakura proposed last, if it proposed one that checked out. */
  plan: () => ProposedPlan | null
}

/** The tools for the planning request: read the design, propose blocks. Nothing changes the sheet. */
export function planningSession(): PlanningSession {
  let proposed: ProposedPlan | null = null
  let bad = 0
  const read = TOOL_DEFINITIONS.filter((t) => t.function.name === "get_design")
  return {
    plan: () => proposed,
    tools: {
      definitions: [...read, PROPOSE],
      halt: () =>
        bad < MAX_BAD_PLANS ? null : `Sakura's plan did not fit this sheet after ${MAX_BAD_PLANS} tries${proposed ? ", so the earlier plan is shown" : ", so no plan was made"}. Nothing was changed.`,
      run: (project, name, input, context) => {
        if (name === "get_design") return runTool(project, name, input, context)
        if (name !== "propose_blocks") return fail(project, `${name} isn't available while the plan is made. Read the design with get_design, then call propose_blocks.`)
        const invalid = validateInput(SCHEMA, input ?? {})
        if (invalid) {
          bad++
          return fail(project, `Invalid input: ${invalid}`)
        }
        const checked = checkPlan(project, input as { blocks: { name: string; refs: string[] }[] })
        if ("problems" in checked) {
          bad++
          return fail(project, `The plan has problems. ${checked.problems.slice(0, 8).join(" ")} Fix them and call propose_blocks again.`)
        }
        bad = 0
        proposed = checked.plan
        const parts = checked.plan.blocks.reduce((n, b) => n + b.refs.length, 0)
        const left = checked.plan.left.length ? ` ${checked.plan.left.length} loose parts are not in the plan and will go to OTHER.` : ""
        const summary = `Proposed ${checked.plan.blocks.length} blocks for ${parts} parts`
        return {
          project,
          result: `Plan recorded: ${checked.plan.blocks.length} blocks, ${parts} parts.${left} The user will see it and confirm. Stop now with one short sentence; do not group or tidy yet.`,
          summary,
          isError: false,
        }
      },
    },
  }
}

export interface ApplySession {
  tools: ToolSet
}

/** Why the sheet does not hold the whole plan, or null when it does: every part of every block is in a block of that name. */
export function planProblem(project: Project, plan: ProposedPlan): string | null {
  const missing = plan.blocks.filter((b) => {
    const block = findBlock(project, b.name)
    return !block || b.refs.some((r) => !block.components.includes(byRef(project, r)?.id ?? ""))
  })
  if (missing.length) return `Sakura did not group ${missing.map((b) => b.name).join(", ")} as planned, so nothing was changed.`
  return null
}

/**
 * The tools for the apply request: group_parts and tidy_schematic, held to the confirmed plan. A
 * group_parts call must be a block of the plan with parts of it, and tidy_schematic must be the
 * whole sheet. All the changes are one undo step.
 */
export function applySession(plan: ProposedPlan): ApplySession {
  let tidied = false
  const definitions = TOOL_DEFINITIONS.filter((t) => ["group_parts", "tidy_schematic"].includes(t.function.name))
  return {
    tools: {
      definitions,
      oneUndoStep: true,
      label: "Grouped and tidied the schematic (Clean up with AI)",
      // The plan is applied whole, grouped and tidied, or not at all.
      check: (project) => planProblem(project, plan) ?? (tidied ? null : "Sakura did not tidy the sheet, so nothing was changed."),
      run: (project, name, input, context) => {
        const i = (input ?? {}) as { block?: unknown; refs?: unknown; blocks?: unknown; whole_sheet?: unknown }
        if (name === "group_parts") {
          const block = plan.blocks.find((b) => typeof i.block === "string" && sameName(b.name, i.block))
          if (!block) return fail(project, `${String(i.block)} isn't a block of the plan the user confirmed. Blocks: ${plan.blocks.map((b) => b.name).join(", ")}.`)
          const refs = Array.isArray(i.refs) ? i.refs.map((r) => String(r).trim()) : []
          const stray = refs.filter((r) => !block.refs.some((x) => x.toLowerCase() === r.toLowerCase()))
          if (stray.length) return fail(project, `${stray.join(", ")} isn't in ${block.name} in the confirmed plan. Its parts: ${block.refs.join(", ")}.`)
          const moving = refs.map((r) => byRef(project, r)).filter((c): c is ComponentInstance => !!c)
          const taken = moving.find((c) => {
            const holder = groupOf(project, c.id)
            return holder && !sameName(holder.name, block.name)
          })
          if (taken) return fail(project, `${taken.ref} is in the block ${groupOf(project, taken.id)!.name} now, so it stays there.`)
          // Under the plan's own name, whatever case the model wrote it in.
          const out = runTool(project, name, { ...(input as object), block: block.name }, context)
          // Grouping after the tidy leaves the sheet untidy.
          if (!out.isError && out.project !== project) tidied = false
          return out
        }
        if (name === "tidy_schematic") {
          if (i.whole_sheet !== true || (Array.isArray(i.blocks) && i.blocks.length)) return fail(project, "Tidy the whole sheet: call tidy_schematic with whole_sheet true and no blocks.")
          const out = runTool(project, name, input, context)
          if (!out.isError) tidied = true
          return out
        }
        return fail(project, `${name} isn't part of applying the plan. Use group_parts for each block, then tidy_schematic with whole_sheet true.`)
      },
    },
  }
}
