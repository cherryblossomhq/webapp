import { AlertTriangle, Info, X } from "lucide-react"
import { useEffect } from "react"
import { uiApi, useUi } from "../store/uiStore"

const SHOWN_FOR = 8000

/**
 * Why an edit was refused, over the canvas: a turn, move or paste that would have changed what the
 * sheet's pins are connected to. The edit did not happen, and this says what it would have done.
 * An `info` notice says what an edit did besides, as a port's entry added with it, in plain colours.
 */
export function CanvasNotice() {
  const notice = useUi((s) => s.notice)
  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => uiApi().clearNotice(), SHOWN_FOR)
    return () => clearTimeout(timer)
  }, [notice])
  if (!notice) return null
  const Icon = notice.info ? Info : AlertTriangle
  return (
    <div
      role={notice.info ? "status" : "alert"}
      className={`absolute left-1/2 top-3 z-20 flex max-w-[min(640px,calc(100%-24px))] -translate-x-1/2 animate-fade-in items-start gap-2 rounded-[8px] border px-3 py-2 text-[12.5px] shadow-float ${
        notice.info ? "border-line bg-surface text-ink-2" : "border-danger/25 bg-danger-soft text-danger"
      }`}
    >
      <Icon size={14} className="mt-[2px] shrink-0" />
      <span className="min-w-0 flex-1">{notice.text}</span>
      <button className={`shrink-0 rounded-[4px] p-0.5 ${notice.info ? "hover:bg-chrome" : "hover:bg-danger/10"}`} aria-label="Dismiss" onClick={() => uiApi().clearNotice()}>
        <X size={13} />
      </button>
    </div>
  )
}
