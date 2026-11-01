import { X } from "lucide-react"
import { useEffect, useState } from "react"
import { useProjectStore } from "../store/projectStore"
import { takeJustImported } from "./justImported"
import { KicadReportDialog } from "./ReportDialog"

const SHOWN_FOR = 10_000

/**
 * The one line a project a KiCad import has just made opens with, over the canvas: "Imported from KiCad. See the report." It fades after
 * a few seconds; the report stays in the Inspector's KiCad import section. Shown once, for the project the import screen marked.
 */
export function ImportedNote() {
  const projectId = useProjectStore((s) => s.project?.id)
  const file = useProjectStore((s) => s.project?.kicad?.report)
  const [shownFor, setShownFor] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (projectId && takeJustImported(projectId)) setShownFor(projectId)
  }, [projectId])
  useEffect(() => {
    if (!shownFor || open) return
    const timer = setTimeout(() => setShownFor(null), SHOWN_FOR)
    return () => clearTimeout(timer)
  }, [shownFor, open])
  if (!projectId || (shownFor !== projectId && !open)) return null
  return (
    <>
      {shownFor === projectId && !open && (
        <div role="status" className="absolute left-1/2 top-3 z-20 flex -translate-x-1/2 animate-fade-in items-center gap-2 rounded-[8px] border border-line bg-surface px-3 py-2 text-[12.5px] text-ink shadow-float">
          <span>
            Imported from KiCad.{" "}
            <button type="button" className="font-[600] text-brand underline-offset-2 hover:underline" onClick={() => setOpen(true)}>
              See the report
            </button>
          </span>
          <button type="button" className="shrink-0 rounded-[4px] p-0.5 text-ink-3 hover:bg-chrome" aria-label="Dismiss" onClick={() => setShownFor(null)}>
            <X size={13} />
          </button>
        </div>
      )}
      {open && (
        <KicadReportDialog
          projectId={projectId}
          file={file}
          onClose={() => {
            setOpen(false)
            setShownFor(null)
          }}
        />
      )}
    </>
  )
}
