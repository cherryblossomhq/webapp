import { AlertTriangle, Loader2 } from "lucide-react"
import type { ReactNode } from "react"
import { useProjectStore } from "../store/projectStore"

const ACTION = "h-6 shrink-0 rounded-[6px] px-2 text-[12px] font-[600] hover:bg-danger/10"

/**
 * Saving is silent while it works. This is the strip under the top bar for when it doesn't:
 * what happened to the user's edits, and the way forward when there is one. A project deleted or
 * unshared while open is `CollabNotices`'s dialog instead.
 */
export function SaveNotice() {
  const save = useProjectStore((s) => s.save)
  if (save.state === "saved" || save.state === "saving") return null
  if (save.state === "refused" && save.reason === "not_found") return null
  const reload = () => window.location.reload()
  let text: string
  let actions: ReactNode = null
  if (save.state === "retrying") {
    text = "Your latest changes aren't saved yet. Trying again…"
  } else if (save.reason === "outdated") {
    text = "A newer version of Cherry Blossom saved this project. Reload to update before editing it here."
    actions = (
      <button className={ACTION} onClick={reload}>
        Reload
      </button>
    )
  } else if (save.reason === "forbidden") {
    text = "This project is now shared with you to view, so your last changes weren't saved."
  } else {
    text = "That change would make the project too large to save, so it was undone."
  }
  return (
    <div
      role="status"
      title={save.state === "retrying" ? save.message : undefined}
      className="flex h-9 shrink-0 animate-fade-in items-center gap-2 border-b border-danger/25 bg-danger-soft px-3 text-[12.5px] text-danger"
    >
      {save.state === "retrying" ? <Loader2 size={14} className="shrink-0 animate-spin" /> : <AlertTriangle size={14} className="shrink-0" />}
      <span className="min-w-0 flex-1 truncate">{text}</span>
      {actions}
    </div>
  )
}
