import { AlertTriangle, Loader2 } from "lucide-react"
import { useState, type ReactNode } from "react"
import { downloadText, projectFileName } from "../export/bundle"
import { serializeProject } from "../model/projectFile"
import type { Project } from "../model/types"
import { useProjectStore } from "../store/projectStore"

const ACTION = "h-6 shrink-0 rounded-[6px] px-2 text-[12px] font-[600] hover:bg-danger/10"
const STRIP = "flex h-9 shrink-0 animate-fade-in items-center gap-2 border-b border-danger/25 bg-danger-soft px-3 text-[12.5px] text-danger"
const when = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })

/** The project as a file that opens as a new project from the projects page: the same file Export makes. */
const download = (project: Project) => downloadText(serializeProject(project, { pretty: true }), projectFileName(project, "json"), "application/json")

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
  const held = useProjectStore((s) => s.heldEdits)
  if (save.state === "saved" || save.state === "saving") return held ? <HeldNotice savedAt={held.savedAt} /> : null
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
          <button className={ACTION} onClick={() => download(project)}>
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
    <div role="status" title={save.state === "retrying" ? save.message : undefined} className={STRIP}>
      {save.state === "retrying" ? <Loader2 size={14} className="shrink-0 animate-spin" /> : <AlertTriangle size={14} className="shrink-0" />}
      <span className="min-w-0 flex-1 truncate">{text}</span>
      {actions}
    </div>
  )
}

/**
 * Edits this browser kept from a page that closed before they were saved, and which the project has moved on from since:
 * restored, they would win over the newer work wherever both changed a value, so the user decides, with a copy to keep
 * either way. Discarding asks once more, since it can't be undone.
 */
function HeldNotice({ savedAt }: { savedAt: number }) {
  const restore = useProjectStore((s) => s.restoreHeldEdits)
  const discard = useProjectStore((s) => s.discardHeldEdits)
  const copy = useProjectStore((s) => s.heldEditsCopy)
  const [discarding, setDiscarding] = useState(false)
  const made = when.format(savedAt)
  return (
    <div role="status" className={STRIP}>
      <AlertTriangle size={14} className="shrink-0" />
      <span className="min-w-0 flex-1 truncate">
        {discarding
          ? `Discard the edits from ${made}? They can't be brought back.`
          : `Edits from ${made} in this browser were never saved, and the project has changed since.`}
      </span>
      {discarding ? (
        <>
          <button className={ACTION} onClick={discard}>
            Discard
          </button>
          <button className={ACTION} onClick={() => setDiscarding(false)}>
            Cancel
          </button>
        </>
      ) : (
        <>
          <button className={ACTION} onClick={restore} title="Where they and a newer change touch the same thing, these edits replace it">
            Restore
          </button>
          <button
            className={ACTION}
            onClick={() => {
              const withThem = copy()
              if (withThem) download(withThem)
            }}
            title="This project with those edits, as a file that opens as a new project"
          >
            Download a copy
          </button>
          <button className={ACTION} onClick={() => setDiscarding(true)}>
            Discard…
          </button>
        </>
      )}
    </div>
  )
}
