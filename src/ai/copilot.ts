import { copilotAccess, copilotModel, limitOffer, useAccount, type LimitOffer } from "../store/accountStore"
import { useProjectStore } from "../store/projectStore"
import { useUi } from "../store/uiStore"
import { ManagedAiError, streamChat, type ChatMessage, type FailureKind } from "./managedAi"
import type { Project } from "../model/types"
import { acquireBoard, wholeBoardAction, type BoardLease } from "../store/boardLease"
import { supplierParts } from "./supplierParts"
import { createRepeatGuard } from "./repeatGuard"
import { executeTool, TOOL_DEFINITIONS, type FunctionTool, type ToolContext, type ToolOutcome } from "./tools"
import type { LookImage } from "./vision/encode"
import { KEEP_IMAGES, MAX_LOOKS_PER_REQUEST, newLookBudget } from "./vision/limits"
import { LOOK_LIMIT_SUMMARY } from "./lookTool"
import { pictureMessage, pruneImages } from "./vision/messages"
import { DESIGN_GUIDE, designNotes, LOOKING_GUIDE } from "./designGuide"

export { hasKicadSymbols, KICAD_NET_NOTE, SHEETS_NOTE, UNITS_NOTE } from "./designGuide"

// A lookup is three or four rounds on its own (find_part, get_part_data, create_part, add_component),
// so a board with a few specific parts spends a dozen before it is wired, placed and checked.
export const MAX_ITERATIONS = 32
const MAX_TOKENS = 32000
/** Thinking before acting pays off on circuits; medium keeps a tool round quick. */
const REASONING_EFFORT = "medium"

const SYSTEM_PROMPT = `You are Sakura, the design copilot inside Cherry Blossom, a browser-based schematic and PCB editor. You change the user's open project only through the tools; every tool call is applied immediately and can be undone by the user.

${DESIGN_GUIDE}

${LOOKING_GUIDE}

Replies are shown in a narrow side panel: keep them short and concrete. Say what you changed and any assumptions, as a sentence or two or a short list. No preamble.`

/** The static prompt carries a cache breakpoint: tools and system are the same on every request. */
const SYSTEM_MESSAGE: Extract<ChatMessage, { role: "system" }> = {
  role: "system",
  content: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
}

/**
 * The system message for a design: the static prompt as it always was (the same bytes, so its cache
 * holds), and after it a note about units when the design has parts that need it, and a note about KiCad's net names
 * when the design came from KiCad.
 */
export function systemMessageFor(project: Project): Extract<ChatMessage, { role: "system" }> {
  const notes = designNotes(project)
  if (!notes.length) return SYSTEM_MESSAGE
  return {
    role: "system",
    content: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }, ...notes.map((text) => ({ type: "text" as const, text }))],
  }
}

export type CopilotEvent =
  | { type: "text"; delta: string }
  | { type: "tool_start"; id: string; name: string; input: unknown }
  | { type: "tool_end"; id: string; name: string; summary: string; isError: boolean; changed: boolean }
  | { type: "error"; message: string; kind?: FailureKind; offer?: LimitOffer }
  | { type: "done"; stopReason: string | null }

interface Conversation {
  messages: ChatMessage[]
  /** Groups the conversation's requests into one trace; also the provider's cache affinity key. */
  id: string
}

const conversations = new Map<string, Conversation>()

export function clearHistory(projectId: string) {
  conversations.delete(projectId)
}

function parseArguments(raw: string): { input: unknown } | { error: string } {
  if (!raw.trim()) return { input: {} }
  try {
    return { input: JSON.parse(raw) as unknown }
  } catch {
    return { error: "The tool arguments weren't valid JSON. Retry with a smaller change." }
  }
}

/**
 * The tools one request may use, when it isn't the whole kit: Clean up with AI plans with some and
 * applies with others. They work on the project alone, with no lookups, so they run at once.
 */
export interface ToolSet {
  definitions: FunctionTool[]
  run: (project: Project, name: string, input: unknown, context: ToolContext) => ToolOutcome
  /**
   * Every change of the request is one undo step, committed when it ends well. A request that is
   * stopped or fails commits nothing, and one that finds the sheet edited meanwhile stops there.
   */
  oneUndoStep?: boolean
  /**
   * With `oneUndoStep`: asked before the changes are committed, with the sheet they make. A message
   * means the request did not finish what it was for: it is shown and nothing is committed, so the
   * outcome is all of it or none.
   */
  check?: (project: Project) => string | null
  /** Asked after each round of tool calls: a message ends the request there, and is shown. */
  halt?: () => string | null
}

export interface RunOptions {
  signal?: AbortSignal
  onEvent: (e: CopilotEvent) => void
  /** The tools on offer; all of them when absent. */
  tools?: ToolSet
}

/** Send one user message and run the tool loop until the model finishes, errors or is stopped. */
export async function runCopilot(prompt: string, { signal, onEvent, tools }: RunOptions): Promise<void> {
  const finish = (stopReason: string | null) => onEvent({ type: "done", stopReason })
  const project = useProjectStore.getState().project
  if (!project) {
    onEvent({ type: "error", message: "Open a project first." })
    return finish(null)
  }

  const accountState = useAccount.getState()
  const account = await accountState.load()
  if (!account) {
    const { status, error } = useAccount.getState()
    if (status === "signedOut") onEvent({ type: "error", message: "Sign in to use Sakura.", kind: "signin" })
    else onEvent({ type: "error", message: error ?? "Couldn't load your plan. Try again.", kind: "error" })
    return finish(null)
  }
  const access = copilotAccess(account)
  const model = copilotModel(account, useUi.getState().settings.model)
  if (access !== "ready" || !model) {
    onEvent({
      type: "error",
      message: access === "upgrade" ? "Sakura is included from the Pro plan up." : "Managed AI isn't enabled for your account yet.",
      kind: "plan",
    })
    return finish(null)
  }

  const projectId = project.id
  const conversation = conversations.get(projectId) ?? { messages: [], id: crypto.randomUUID() }
  conversations.set(projectId, conversation)
  const history = conversation.messages
  const startLength = history.length
  history.push({ role: "user", content: prompt })
  // The pictures this request may take; a new request starts with a full allowance.
  const looks = newLookBudget()

  // One undo step: the changes pile up here and are committed together at the end.
  const together = !!tools?.oneUndoStep
  let working = project
  let failed = false
  /** The last step was used and the model still had calls to make. */
  let outOfSteps = false
  let stoppedShown = false
  const stopped = () => {
    if (stoppedShown) return
    stoppedShown = true
    onEvent({ type: "error", message: `Stopped after ${MAX_ITERATIONS} steps. Send a message to continue.` })
  }
  let stopReason: string | null = null
  // Per request: an identical call that keeps failing is refused after its second failure.
  const repeats = createRepeatGuard()
  // The board leases this request holds for the whole-board tool it is running; every one is let go of when its call ends, and any left when the request does.
  const leases = new Set<BoardLease & { ok: true }>()
  try {
    for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
      if (signal?.aborted) {
        stopReason = "aborted"
        break
      }
      // The conversation keeps its pictures between requests. Whatever the history holds, a
      // request the proxy would refuse for its pictures is never sent: the oldest are left out.
      pruneImages(history, MAX_LOOKS_PER_REQUEST)
      const turn = await streamChat(
        {
          model,
          messages: [systemMessageFor(working), ...history],
          tools: tools?.definitions ?? TOOL_DEFINITIONS,
          tool_choice: "auto",
          max_tokens: MAX_TOKENS,
          reasoning: { effort: REASONING_EFFORT },
          // Caches the conversation so far on every round of the tool loop.
          cache_control: { type: "ephemeral" },
          session_id: conversation.id,
        },
        { signal, traceId: conversation.id, onText: (delta) => onEvent({ type: "text", delta }) },
      )
      stopReason = turn.finishReason

      if (turn.finishReason === "content_filter") {
        // A declined first turn is dropped so the next message starts clean; later turns
        // keep their tool history because those changes were already applied.
        if (iteration === 0) history.length = startLength
        onEvent({ type: "error", message: "Sakura declined this request. Try rephrasing it." })
        break
      }

      if (!turn.text && !turn.toolCalls.length) break
      history.push({
        role: "assistant",
        content: turn.text || null,
        ...(turn.toolCalls.length && { tool_calls: turn.toolCalls }),
        ...(turn.reasoningDetails.length && { reasoning_details: turn.reasoningDetails }),
      })
      if (!turn.toolCalls.length) break

      // Every tool call needs a result in the next request, so each one gets one, run or not.
      const truncated = turn.finishReason === "length"
      const pictures: LookImage[] = []
      for (const call of turn.toolCalls) {
        const name = call.function.name
        const parsed = parseArguments(call.function.arguments)
        const input = "input" in parsed ? parsed.input : {}
        onEvent({ type: "tool_start", id: call.id, name, input })
        const shown = useProjectStore.getState().project
        const current = together ? working : shown
        let reason: string | null = null
        // Stop means stop: nothing after it runs, though every call still gets its result.
        if (signal?.aborted) reason = "Stopped by the user before this ran."
        else if (truncated) reason = "The tool input was cut off. Retry with a smaller change."
        else if (!shown || shown.id !== projectId) reason = "The project was closed, so this change was not applied."
        else if (together && shown !== project) {
          reason = "The sheet was edited while Sakura worked, so this change was not applied."
          failed = true
        } else if ("error" in parsed) reason = parsed.error
        // A request's own tool set has its own way to stop (`halt`), which counts every call that
        // fails; refusing a repeat before it runs would hide it from that count.
        else if (!tools) reason = repeats.refusal(name, input)
        if (reason || !current) {
          reason ??= "The project was closed, so this change was not applied."
          history.push({ role: "tool", tool_call_id: call.id, content: `Error: ${reason}` })
          onEvent({ type: "tool_end", id: call.id, name, summary: reason, isError: true, changed: false })
          continue
        }
        // A tool that rewrites much of the board or sheet takes the board lease first. Another tab (a
        // collaborator's Sakura, or this user's other tab) holding it means the tool does not run:
        // Sakura is told who and what, and says so; nothing is queued.
        let held: (BoardLease & { ok: true }) | null = null
        const boardAction = wholeBoardAction(name, input)
        if (boardAction) {
          const lease = await acquireBoard(boardAction, true)
          if (!lease.ok) {
            history.push({ role: "tool", tool_call_id: call.id, content: `Error: ${lease.message}` })
            onEvent({ type: "tool_end", id: call.id, name, summary: lease.message.split(". ")[0] + ".", isError: true, changed: false })
            continue
          }
          held = lease
          leases.add(lease)
        }
        const context: ToolContext = { parts: supplierParts(), signal, looks, selection: () => useUi.getState().selection, start: project, sheet: { shown: () => useUi.getState().sheet, show: (path) => useUi.getState().setSheet(path) } }
        // A request's own tool set works on the project alone and runs at once; the whole kit's tools
        // with lookups await them first, then make their change to the project as it is then: an
        // edit the user made meanwhile stays.
        const latest = () => {
          const p = useProjectStore.getState().project
          return p && p.id === projectId ? p : null
        }
        const outcome: ToolOutcome & { base: Project | null } = tools
          ? { ...tools.run(current, name, input, context), base: current }
          : await executeTool(current, latest, name, input, context)
        // A refused look is the picture cap talking, not a call that keeps failing: it says what to
        // do already, so it does not count toward the repeat guard. A look that failed does.
        if (!tools && !(name === "look" && outcome.summary === LOOK_LIMIT_SUMMARY)) repeats.record(name, input, outcome.isError, outcome.empty === true)
        if (outcome.images?.length && !outcome.isError) pictures.push(...outcome.images)
        let changed = outcome.base !== null && outcome.project !== outcome.base
        if (changed && together) working = outcome.project
        else if (changed) {
          const base = outcome.base
          // Commit only onto the project the change was made to; a newer edit can't be overwritten.
          useProjectStore.getState().commit((p) => (p === base ? outcome.project : p))
          if (useProjectStore.getState().project !== outcome.project) {
            changed = false
            outcome.result = "Error: The project changed while this ran, so the change was not applied. Call the tool again."
            outcome.summary = "Not applied: the project changed meanwhile"
            outcome.isError = true
          }
        }
        history.push({ role: "tool", tool_call_id: call.id, content: outcome.result })
        onEvent({ type: "tool_end", id: call.id, name, summary: outcome.summary, isError: outcome.isError, changed })
        held?.release()
        if (held) leases.delete(held)
      }
      // A tool result is text, so what a look drew comes as a user message after all the results.
      if (pictures.length) {
        history.push(pictureMessage(pictures))
        // The newest two stay, or all of this turn's if it made more: the model just asked for them.
        pruneImages(history, Math.max(KEEP_IMAGES, pictures.length))
      }

      if (useProjectStore.getState().project?.id !== projectId) {
        onEvent({ type: "error", message: "The project changed, so Sakura stopped." })
        break
      }
      const halted = tools?.halt?.()
      if (halted) {
        onEvent({ type: "error", message: halted })
        break
      }
      if (iteration === MAX_ITERATIONS - 1) outOfSteps = true
    }
  } catch (err) {
    failed = true
    if (signal?.aborted) {
      stopReason = "aborted"
    } else if (err instanceof ManagedAiError) {
      // A limit offers what the plan and pay-as-you-go are now, not what they were when the panel
      // opened: pay-as-you-go may have been turned on in another tab since.
      const offer = err.kind === "limit" ? limitOffer((await useAccount.getState().load(true)) ?? useAccount.getState().account, err.limit) : null
      onEvent({ type: "error", message: err.message, kind: err.kind, ...(offer && { offer }) })
      // The plan or session changed under the panel: show what it is now.
      if (err.kind === "signin" || err.kind === "plan") void useAccount.getState().load(true)
    } else {
      onEvent({ type: "error", message: err instanceof Error ? err.message : String(err), kind: "error" })
    }
  }
  for (const lease of leases) lease.release()
  if (stopReason === "aborted") failed = true
  if (together && !failed) {
    // All of it or none: a sheet edited meanwhile, or work that is not finished, is not committed, and the user is told.
    const edited = working !== project && useProjectStore.getState().project !== project
    const problem = edited ? "The sheet was edited while Sakura worked, so nothing was changed." : (tools?.check?.(working) ?? null)
    if (problem) {
      failed = true
      if (outOfSteps) stopped()
      onEvent({ type: "error", message: problem })
    } else if (working !== project) {
      useProjectStore.getState().commit(() => working)
    }
  }
  // Said to the model as well as to the user: its tool results above say the changes happened, and
  // without this it goes on to look for blocks and moves that were never kept.
  if (together && working !== project && failed) {
    history.push({
      role: "user",
      content:
        "Editor note, not from the user: nothing from your last request was kept. The changes were rolled back and the sheet is exactly as it was before the request, so the blocks you grouped and the parts you moved do not exist. Do not rely on your earlier tool results for them; read the design again first.",
    })
  }
  // Work that is complete is kept even when the last step left no room for the report, and then there is nothing to apologise for.
  if (outOfSteps && !(together && !failed)) stopped()
  // A prompt nothing answered (stopped, or the request failed) is dropped, or the next message
  // would carry it along and the copilot would act on both.
  if (history.length === startLength + 1) history.length = startLength
  finish(stopReason)
}
