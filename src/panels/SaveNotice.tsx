import { AlertTriangle, Loader2 } from "lucide-react"
import type { ReactNode } from "react"
import { downloadProjectFile } from "../export/bundle"
import { reloadKeepingEdits, useProjectStore } from "../store/projectStore"

const ACTION = "h-6 shrink-0 rounded-[6px] px-2 text-[12px] font-[600] hover:bg-danger/10"

/**
 * Saving is silent while it works. This is the strip under the top bar for when it doesn't:
 * what happened to the user's edits, and the way forward when there is one. A project deleted or
 * unshared while open is `CollabNotices`'s dialog instead.
 */
export function SaveNotice() {
  const save = useProjectStore((s) => s.save)
  const dismiss = useProjectStore((s) => s.dismissSaveNotice)
  // Editing waits for the connection (`editingPaused`); a viewer edits nothing, and the top bar says they're offline.
  const offline = useProjectStore((s) => !s.online && s.role !== "viewer")
  if (save.state === "refused" && save.reason === "not_found") return null
  // While edits can't land, the way out is the file: what is on screen (the live project, under a preview), queued edits and all.
  const download = (
    <button className={ACTION} onClick={() => downloadProjectFile(useProjectStore.getState().preview?.live ?? useProjectStore.getState().project!)}>
      Download a copy
    </button>
  )
  if (save.state === "saved" || save.state === "saving") {
    if (!offline) return null
    return <Strip waiting text="You're offline. Editing is paused until the connection is back." actions={download} />
  }
  const reload = () => window.location.reload()
  let text: string
  let actions: ReactNode = null
  if (save.state === "retrying") {
    // What is queued lives in this tab only, so no more is made until it lands. A reload takes it along (`reloadKeepingEdits`),
    // and loads the page with a fresh session, or asks to sign in when there is none.
    text = "Your latest changes aren't saved yet, so editing is paused. Reloading keeps them; closing the tab doesn't."
    actions = (
      <>
        <button className={ACTION} onClick={reloadKeepingEdits}>
          Reload
        </button>
        {download}
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
  return <Strip waiting={save.state === "retrying"} title={save.state === "retrying" ? save.message : undefined} text={text} actions={actions} />
}

function Strip({ waiting, title, text, actions }: { waiting: boolean; title?: string; text: string; actions?: ReactNode }) {
  return (
    <div
      role="status"
      title={title}
      className="flex h-9 shrink-0 animate-fade-in items-center gap-2 border-b border-danger/25 bg-danger-soft px-3 text-[12.5px] text-danger"
    >
      {waiting ? <Loader2 size={14} className="shrink-0 animate-spin" /> : <AlertTriangle size={14} className="shrink-0" />}
      <span className="min-w-0 flex-1 truncate">{text}</span>
      {actions}
    </div>
  )
}
