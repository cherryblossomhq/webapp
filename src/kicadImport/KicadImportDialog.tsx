import { CheckCircle2, CircuitBoard, Loader2 } from "lucide-react"
import { useEffect, useRef, type ReactNode } from "react"
import { Button } from "../ui/controls"
import type { KicadImportController, ImportState } from "./controller"
import { useModal } from "./focus"
import { markJustImported } from "./justImported"
import { PHASE_LABELS, type Phase } from "./protocol"
import { sizeText } from "./save"
import { ReportView } from "./ReportView"

// The import's one dialog: it works through choosing a board, the progress with cancel, and the
// report, in the same place, so the page behind it does not change under the user.

/**
 * The dialog's box. `onDismiss` is what Escape and a click outside do; a running import gives none,
 * since only its Cancel button ends it. Focus moves in, Tab stays in, and keys do not reach the editor.
 */
export function Shell({ onDismiss, label, children }: { onDismiss?: () => void; label: string; children: ReactNode }) {
  const ref = useModal(onDismiss)
  return (
    <div
      className="fixed inset-0 z-50 flex animate-fade-in items-center justify-center bg-black/40 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onDismiss?.()
      }}
    >
      <div ref={ref} role="dialog" aria-modal="true" aria-label={label} className="flex max-h-[85vh] w-full max-w-[560px] animate-pop-in flex-col rounded-[var(--radius-panel)] border border-line bg-surface p-5 shadow-dialog outline-none">
        {children}
      </div>
    </div>
  )
}

const STEPS: (Phase | "matching" | "saving")[] = ["reading", "building", "saving"]
/** The steps while the LCSC numbers are being looked up, which only a board that has any does. */
const STEPS_WITH_LOOKUP: (Phase | "matching" | "saving")[] = ["reading", "building", "matching", "saving"]

function Progress({ phase, slow, onCancel }: { phase: Phase | "matching" | "saving"; slow: boolean; onCancel: () => void }) {
  const steps = phase === "matching" ? STEPS_WITH_LOOKUP : STEPS
  const at = steps.indexOf(phase)
  return (
    <>
      <h2 className="text-[15px] font-[650] text-ink">Importing from KiCad</h2>
      <ol className="mt-3 space-y-2" aria-live="polite">
        {steps.map((step, i) => (
          <li key={step} className={`flex items-center gap-2 text-[13px] ${i > at ? "text-ink-3" : "text-ink"}`}>
            {i < at ? <CheckCircle2 size={15} className="text-ok" /> : i === at ? <Loader2 size={15} className="animate-spin" /> : <span className="size-[15px]" />}
            {PHASE_LABELS[step]}
          </li>
        ))}
      </ol>
      {slow ? (
        <p role="status" className="mt-3 text-[12.5px] text-ink-2">
          Still saving: it will finish when your connection is back. Check your projects list.
        </p>
      ) : (
        <p className="mt-3 text-[12.5px] text-ink-3">A big board can take about 15 seconds. You can cancel at any time before saving.</p>
      )}
      <div className="mt-5 flex justify-end">
        <Button onClick={onCancel} disabled={phase === "saving" && !slow} data-autofocus>
          {slow ? "Close" : "Cancel"}
        </Button>
      </div>
    </>
  )
}

export function KicadImportDialog({ state, controller, onOpen }: { state: ImportState; controller: KicadImportController; onOpen: (projectId: string) => void }) {
  // A project the import saved opens at once, and says it was imported in one line there (`ImportedNote`); the report is a click away in the
  // project. Only a refusal or a save that failed stays on this screen.
  const saved = state.step === "report" && state.projectId && !state.saveError ? state.projectId : null
  const open = useRef(onOpen)
  open.current = onOpen
  useEffect(() => {
    if (!saved) return
    markJustImported(saved)
    open.current(saved)
  }, [saved])
  if (state.step === "idle" || saved) return null
  const close = () => controller.close()
  if (state.step === "working") {
    // No dismiss: a click outside or Escape must not end an import that may be minutes of work. A
    // save that has gone slow may be closed: it finishes on its own when the connection is back.
    return (
      <Shell key="working" label="Importing from KiCad" onDismiss={state.slow ? close : undefined}>
        <Progress phase={state.phase} slow={!!state.slow} onCancel={() => controller.cancel()} />
      </Shell>
    )
  }
  if (state.step === "choose") {
    // With no board among the files the choice is between schematics.
    const what = state.boards.every((b) => b.schematic) ? "schematic" : "board"
    return (
      <Shell key="choose" label={`Choose a ${what}`} onDismiss={close}>
        <h2 className="text-[15px] font-[650] text-ink">Which {what}?</h2>
        <p className="mt-1 text-[13px] text-ink-2">
          These files hold {state.boards.length} {what}s. Pick the one to import.
        </p>
        {/* ph-no-capture: PostHog records the text of a clicked button, and these show file paths. */}
        <div className="ph-no-capture mt-3 min-h-0 flex-1 space-y-1.5 overflow-y-auto scroll-thin">
          {state.boards.map((b) => (
            <button key={b.id} type="button" onClick={() => controller.choose(b.id)} className="flex w-full items-center gap-2.5 rounded-[var(--radius-ctl)] border border-line bg-surface px-3 py-2 text-left hover:bg-chrome">
              <CircuitBoard size={16} className="shrink-0 text-ink-2" />
              <span className="min-w-0 flex-1 break-all text-[13px] text-ink">{b.path}</span>
              {b.size !== null && <span className="shrink-0 text-[12px] text-ink-3">{sizeText(b.size)}</span>}
            </button>
          ))}
        </div>
        <div className="mt-4 flex justify-end">
          <Button onClick={close}>Cancel</Button>
        </div>
      </Shell>
    )
  }
  return (
    <Shell key="report" label="KiCad import report" onDismiss={close}>
      <div className="min-h-0 flex-1 overflow-y-auto pr-1 scroll-thin">
        <ReportView summary={state.summary} name={state.name} saveError={state.saveError} saveKind={state.saveKind} />
      </div>
      <div className="mt-4 flex flex-wrap justify-end gap-2">
        <Button onClick={close}>Close</Button>
        {state.saveError && state.saveKind !== "uncertain" && state.saveKind !== "final" && (
          <Button variant="primary" data-autofocus onClick={() => controller.retry()}>
            Try again
          </Button>
        )}
      </div>
    </Shell>
  )
}
