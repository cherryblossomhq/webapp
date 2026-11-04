import type { AssistantActivity, AssistantClient } from "../ai/managedAi"
import { toolPhase } from "../ai/tools"

// What Sakura's panel says about the user's own assistant (`AssistantChip`): which one it is, from
// the name it gave when it connected, and whether it is at work here, elsewhere, or idle.

/**
 * A call this recent means the assistant is at work. One working calls a tool every few seconds,
 * thinking in between; a minute without one is a turn that ended. The server never hears it end.
 */
export const WORKING_MS = 60_000

/**
 * The client it is, from MCP's `clientInfo`, which each one names its own way (`claude-ai`,
 * `claude-code`, `openai-mcp`, `codex-mcp-client`, `cursor-vscode`). Null for one we don't know.
 */
export function assistantClient(activity: Pick<AssistantActivity, "client" | "clientTitle">): AssistantClient | null {
  const said = `${activity.client ?? ""} ${activity.clientTitle ?? ""}`
  if (/claude[\s_-]?code/i.test(said)) return "claudeCode"
  if (/codex/i.test(said)) return "codex"
  if (/claude|anthropic/i.test(said)) return "claude"
  if (/chatgpt|openai/i.test(said)) return "chatgpt"
  if (/cursor/i.test(said)) return "cursor"
  return null
}

export type AssistantState =
  /** At work on the project open here; `phase` is its latest tool's ("Routing"). */
  | { kind: "here"; phase: string }
  /** At work on another project, or on the account's list (`project` false). */
  | { kind: "elsewhere"; project: boolean }
  /** Not at work: last seen at `since`, connecting (`connected`) or calling a tool. */
  | { kind: "idle"; since: number; connected: boolean }

/** What the assistant is doing at `now`, for the project `projectId` open here. */
export function assistantState(activity: AssistantActivity, projectId: string | null, now: number): AssistantState | null {
  const { calledAt, connectedAt } = activity
  if (calledAt !== null && now - calledAt < WORKING_MS) {
    if (activity.projectId && activity.projectId === projectId) return { kind: "here", phase: toolPhase(activity.tool ?? "") }
    return { kind: "elsewhere", project: !!activity.projectId }
  }
  const since = Math.max(calledAt ?? 0, connectedAt ?? 0)
  if (!since) return null
  return { kind: "idle", since, connected: (connectedAt ?? 0) > (calledAt ?? 0) }
}

/** "just now", "5 min ago", "3 h ago", "2 d ago", then the date. The host's clock may run ahead of this one. */
export function ago(ts: number, now: number): string {
  const s = Math.max(0, Math.round((now - ts) / 1000))
  if (s < 60) return "just now"
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} h ago`
  const d = Math.round(h / 24)
  if (d < 30) return `${d} d ago`
  return new Date(ts).toLocaleDateString()
}

/** What the chip says after the assistant's name. */
export function stateText(state: AssistantState, now: number): string {
  switch (state.kind) {
    case "here":
      return `${state.phase} in this project`
    case "elsewhere":
      return state.project ? "Working on another project" : "Looking through your projects"
    case "idle":
      return `${state.connected ? "Connected" : "Last used"} ${ago(state.since, now)}`
  }
}
