import { Bot } from "lucide-react"
import { useEffect, useState } from "react"
import { managedAiHost, type AssistantActivity } from "../ai/managedAi"
import { assistantClient, assistantState, stateText } from "./assistantActivity"
import { ASSISTANTS } from "./assistantLogos"

/** How often the chip reads the clock, so a finished turn stops reading as work and the minutes count on. */
const TICK_MS = 15_000

/**
 * The user's own assistant, connected through MCP, above Sakura's composer: which one, and what it
 * is doing ("Claude Code · Routing in this project", "Claude · Last used 5 min ago"). Nothing until
 * one has connected, or in a host that doesn't say (`ManagedAiHost.watchAssistant`).
 */
export function AssistantChip({ projectId }: { projectId: string }) {
  const watch = managedAiHost()?.watchAssistant
  const [activity, setActivity] = useState<AssistantActivity | null>(null)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!watch) return
    const stop = watch((next) => {
      setActivity(next)
      setNow(Date.now())
    })
    return () => {
      stop()
      setActivity(null)
    }
  }, [watch])

  useEffect(() => {
    if (!activity) return
    const timer = setInterval(() => setNow(Date.now()), TICK_MS)
    return () => clearInterval(timer)
  }, [activity])

  const state = activity && assistantState(activity, projectId, now)
  if (!activity || !state) return null
  const known = ASSISTANTS.find((a) => a.id === assistantClient(activity))
  const name = known?.name ?? (activity.clientTitle || activity.client || "Your AI assistant")
  const working = state.kind !== "idle"
  return (
    <div
      data-assistant-chip={state.kind}
      title={`${name}, connected through MCP on your own subscription. Its edits land in your open projects live.`}
      className="mb-2 flex h-6 w-fit max-w-full items-center gap-1.5 rounded-full border border-line bg-chrome pl-2 pr-2.5 text-[11.5px] leading-none text-ink-2"
    >
      <span className={`size-1.5 shrink-0 rounded-full ${working ? "animate-pulse bg-ok" : "bg-ink-3"}`} aria-hidden />
      {known?.logo ?? <Bot size={13} className="shrink-0 text-ink-3" aria-hidden />}
      <span className="max-w-[45%] shrink-0 truncate font-[600] text-ink">{name}</span>
      <span className="truncate">{stateText(state, now)}</span>
    </div>
  )
}
