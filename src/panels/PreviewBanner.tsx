import { History } from "lucide-react"
import { useState } from "react"
import { leavePreview, restorePreview } from "../store/historyActions"
import { useProjectStore } from "../store/projectStore"
import { Button } from "../ui/controls"

/**
 * Over the canvas while an older version is shown: says so, says it is read-only and not the
 * project, and offers the way back, and (to people who can edit) the restore.
 */
export function PreviewBanner() {
  const preview = useProjectStore((s) => s.preview)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (!preview) return null
  const canRestore = preview.liveRole !== "viewer"
  const restore = async () => {
    setBusy(true)
    setError(null)
    const result = await restorePreview()
    setBusy(false)
    if (!result.ok) setError(result.message)
  }
  return (
    <div
      role="status"
      aria-label="Viewing an older version"
      className="absolute left-1/2 top-3 z-20 flex max-w-[min(720px,calc(100%-24px))] -translate-x-1/2 flex-col gap-1.5 rounded-[10px] border border-line bg-surface px-3 py-2 text-[12.5px] shadow-float"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <History size={15} className="shrink-0 text-brand" />
        <span className="min-w-0 flex-1 text-ink">
          Viewing <b className="font-[650]">{preview.version.label}</b>
          <span className="text-ink-2"> (read only, the project itself hasn't changed)</span>
        </span>
        <Button disabled={busy} onClick={leavePreview}>
          Back to current
        </Button>
        {canRestore && (
          <Button variant="primary" disabled={busy} onClick={restore}>
            {busy ? "Restoring…" : "Restore this version"}
          </Button>
        )}
      </div>
      {error && (
        <p role="alert" className="text-danger">
          {error}
        </p>
      )}
    </div>
  )
}
