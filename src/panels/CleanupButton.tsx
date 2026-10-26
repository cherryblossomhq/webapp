import { Group, LoaderCircle, Sparkles } from "lucide-react"
import { useEffect, useRef } from "react"
import { cleanupMode } from "../ai/cleanupMode"
import { managedAiHost } from "../ai/managedAi"
import { applyCleanup, cancelCleanup, openCleanup, useCleanup } from "../editor/schematic/cleanupAction"
import { cleanupSummary, hasParts, type CleanupPlan } from "../model/cleanup"
import { useAccount } from "../store/accountStore"
import { useCopilot } from "../store/copilotStore"
import { useProjectStore } from "../store/projectStore"
import { useUi } from "../store/uiStore"
import { Button, useDismiss } from "../ui/controls"

// The schematic toolbar's Clean up. Everyone gets the free version: the parts in no block grouped by
// how they are wired and the sheet tidied, after a preview that asks. A plan with managed AI gets
// "Clean up with AI" in its place: Sakura proposes blocks by function, the Sakura panel asks, and
// the same Tidy finishes. What the plan can do is only what `GET /api/v1/me` says (`cleanupMode`).

const TIP_EMPTY = "Nothing to clean up yet: add parts to the sheet first."
const TIP_FREE = "Group the parts that are in no block into blocks by how they are wired, then tidy the sheet. You see what it will do first, and connections never change."
const TIP_AI = "Sakura proposes blocks by function, such as USB INPUT, 3.3V POWER and MCU. You confirm the plan before anything changes, then the sheet is tidied."

export function CleanupButton() {
  const status = useAccount((s) => s.status)
  const account = useAccount((s) => s.account)
  const phase = useCleanup((s) => s.phase)
  const aiStep = useCopilot((s) => s.cleanup)
  const sakuraBusy = useCopilot((s) => s.runningProject !== null)
  const projectId = useProjectStore((s) => s.project?.id ?? null)
  const anyParts = useProjectStore((s) => !!s.project && hasParts(s.project))
  const wrapper = useRef<HTMLDivElement>(null)

  // What the plan is: asked once, shared with the Sakura panel.
  useEffect(() => {
    void useAccount.getState().load()
  }, [])
  const mode = cleanupMode(status, account)

  const running = phase.kind === "running"
  const busy = running || aiStep !== null
  const ai = mode.kind === "ai"
  useDismiss(wrapper, phase.kind === "preview", cancelCleanup)

  // Esc stops what is running and leaves the sheet as it was; the preview closes with Esc on its own.
  useEffect(() => {
    if (!busy) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return
      e.stopImmediatePropagation()
      if (running) cancelCleanup()
      else useCopilot.getState().stop()
    }
    window.addEventListener("keydown", onKey, true)
    return () => window.removeEventListener("keydown", onKey, true)
  }, [busy, running])

  const label = aiStep === "planning" ? "Planning..." : aiStep === "applying" ? "Applying..." : running ? "Cleaning up..." : ai ? "Clean up with AI" : "Clean up"
  const blocked = !anyParts ? TIP_EMPTY : !running && !aiStep && ai && sakuraBusy ? "Sakura is busy: wait for it to finish or stop it first." : null
  const disabled = busy || !!blocked
  const tip = busy ? "Working. Esc stops it and leaves the sheet as it was." : (blocked ?? (ai ? TIP_AI : TIP_FREE))

  const onClick = () => {
    if (disabled) return
    if (phase.kind === "preview") return cancelCleanup()
    if (ai) {
      if (!projectId) return
      useUi.getState().setCopilotOpen(true)
      useCopilot.getState().startCleanup(projectId)
    } else openCleanup()
  }

  return (
    <div ref={wrapper} className="relative" title={tip}>
      <button
        type="button"
        aria-label={label}
        aria-expanded={phase.kind === "preview"}
        aria-busy={busy}
        disabled={disabled}
        onClick={onClick}
        className="inline-flex h-8 items-center gap-1.5 rounded-[var(--radius-ctl)] px-2 text-[12.5px] font-medium text-ink-2 transition-colors hover:bg-chrome-2 hover:text-ink disabled:opacity-35"
      >
        {busy ? <LoaderCircle size={16} className="animate-spin" /> : ai ? <Sparkles size={16} className="text-brand" /> : <Group size={16} />}
        {label}
      </button>
      {phase.kind === "preview" && <CleanupPreview plan={phase.plan} proHint={mode.kind === "free" && mode.proHint} />}
    </div>
  )
}

/** What Clean up would do, and the question: Apply or Cancel. */
function CleanupPreview({ plan, proHint }: { plan: CleanupPlan; proHint: boolean }) {
  const upgradeUrl = managedAiHost()?.upgradeUrl
  const hint = (
    <>
      <Sparkles size={12} className="shrink-0 text-brand" />
      AI version on Pro: Sakura groups by function
    </>
  )
  return (
    <div role="dialog" aria-label="Clean up" className="absolute left-0 top-10 z-20 w-[300px] rounded-[10px] border border-line bg-surface p-3 shadow-menu">
      <p className="text-[13px] font-medium leading-[1.4] text-ink">{cleanupSummary(plan)}</p>
      {plan.groups.length > 0 && (
        <ul className="scroll-thin mt-2 flex max-h-[200px] flex-col gap-1 overflow-y-auto border-y border-line py-2">
          {plan.groups.map((g) => (
            <li key={g.blockId} className="flex items-baseline justify-between gap-3 text-[12px]">
              <span className="truncate font-medium text-ink">{g.name}</span>
              <span className="shrink-0 text-ink-3">{g.isNew ? `${g.parts.length} ${g.parts.length === 1 ? "part" : "parts"}` : `${g.parts.length} added`}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-2 text-[11.5px] leading-[1.4] text-ink-3">Parts already in a block stay in it. Connections never change, and one undo brings it all back.</p>
      <div className="mt-2.5 flex items-center gap-2">
        <Button variant="primary" autoFocus onClick={() => applyCleanup()}>
          Apply
        </Button>
        <Button onClick={cancelCleanup}>Cancel</Button>
      </div>
      {proHint &&
        (upgradeUrl ? (
          <a href={upgradeUrl} target="_blank" rel="noreferrer" className="mt-2.5 flex items-center gap-1.5 text-[11.5px] text-ink-2 underline-offset-2 hover:text-ink hover:underline">
            {hint}
          </a>
        ) : (
          <p className="mt-2.5 flex items-center gap-1.5 text-[11.5px] text-ink-3">{hint}</p>
        ))}
    </div>
  )
}
