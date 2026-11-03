import { AlertTriangle, Loader2 } from "lucide-react"
import type { ReactNode } from "react"
import { downloadText, projectFileName } from "../export/bundle"
import { serializeProject } from "../model/projectFile"
import { useProjectStore } from "../store/projectStore"

const ACTION = "h-6 shrink-0 rounded-[6px] px-2 text-[12px] font-[600] hover:bg-danger/10"

/**
 * Saving is silent while it works. This is the strip under the top bar for when it doesn't:
 * what happened to the user's edits, and the way forward when there is one. A project deleted or
 * unshared while open is `CollabNotices`'s dialog instead.
 */
export function SaveNotice() {
  const save = useProjectStore((s) => s.save)
  const dismiss = useProjectStore((s) => s.dismissSaveNotice)
  const retry = useProjectStore((s) => s.retrySave)
  const project = useProjectStore((s) => s.project)
  if (save.state === "saved" || save.state === "saving") return null
  if (save.state === "refused" && save.reason === "not_found") return null
  const reload = () => window.location.reload()
  let text: string
  let actions: ReactNode = null
  if (save.state === "retrying") {
    // The edits not saved yet are only in this tab, so closing or reloading it loses them. A copy
    // of what is on screen keeps them whatever happens: it opens as a new project from the
    // projects page. A user once lost hours of work to a reload here.
    text = "Your latest changes aren't saved yet. Keep this tab open while we try again."
    actions = (
      <>
        <button className={ACTION} onClick={retry}>
          Try again now
        </button>
        {project && (
          <button
            className={ACTION}
            onClick={() => downloadText(serializeProject(project, { pretty: true }), projectFileName(project, "json"), "application/json")}
          >
            Download a copy
          </button>
        )}
      </>
    )
  } else if (save.reason === "outdated") {
    text = "A newer version of Cherry Blossom saved this project. Reload to update before editing it here."
    actions = (
      <button className={ACTION} onClick={reload}>
        Reload
      </button>
    )
  } else if (save.reason === "unupgradable") {
    text = "This project is too large to update to this version of Cherry Blossom, so changes to it can't be saved."
  } else {
    text =
      save.reason === "forbidden"
        ? "This project is now shared with you to view, so your last changes weren't saved."
        : "Your latest change would make the project too large to save, so it was undone."
    // Said once: the edits are already off the screen, and nothing is waiting on the user.
    actions = (
      <button className={ACTION} onClick={dismiss}>
        Dismiss
      </button>
    )
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
