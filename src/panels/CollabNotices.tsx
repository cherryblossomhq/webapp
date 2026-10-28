import { Download, X } from "lucide-react"
import { useCallback, useEffect, useRef, useState } from "react"
import { goHome } from "../App"
import { downloadText, projectFileName } from "../export/bundle"
import { resolveDesignatorClashes } from "../model/designators"
import { serializeProject } from "../model/projectFile"
import type { Project } from "../model/types"
import { usePresence } from "../store/presence"
import { isCreatedHere, onRemoteChanges, projectApi, useProjectStore } from "../store/projectStore"
import type { RemoteBatch } from "../store/storage"
import { uiApi } from "../store/uiStore"
import { Button } from "../ui/controls"

/**
 * What working on a project with other people needs saying, as it happens: someone deleted what
 * you had selected, two of you took the same designator, someone joined, you were made a viewer,
 * and the project going away under you. Short notes that leave on their own, at the bottom of the
 * canvas, except the last, which asks what to do with the copy on screen.
 */

interface Toast {
  id: number
  text: string
  color?: string
}

const TOAST_MS = 4_500
let nextToast = 1

/** Who sent a batch, as the faces in the top bar name them. */
function senderName(batches: RemoteBatch[]): { name: string; color?: string } {
  const userId = batches[batches.length - 1]?.userId
  const peer = usePresence.getState().peers.find((p) => p.userId === userId || p.sessionId === batches[batches.length - 1]?.clientId)
  return { name: peer?.name || "Someone", color: peer?.color }
}

const COLLECTION: Record<string, keyof Pick<Project, "components" | "wires" | "labels" | "traces" | "vias">> = {
  c: "components",
  w: "wires",
  l: "labels",
  t: "traces",
  v: "vias",
}

/** Whether a selection id still names something in the project. */
function exists(project: Project, key: string): boolean {
  const id = key.slice(2)
  if (key.startsWith("b:")) return !!project.blocks?.some((b) => b.id === id)
  const list = COLLECTION[key[0]]
  return !list || (project[list] as { id: string }[]).some((x) => x.id === id)
}

const listOf = (items: string[]) => (items.length <= 2 ? items.join(" and ") : `${items.slice(0, 3).join(", ")}${items.length > 3 ? ` and ${items.length - 3} more` : ""}`)

export function CollabNotices() {
  const [toasts, setToasts] = useState<Toast[]>([])
  const say = useCallback((text: string, color?: string) => {
    const id = nextToast++
    setToasts((all) => [...all.filter((t) => t.text !== text), { id, text, color }].slice(-3))
    setTimeout(() => setToasts((all) => all.filter((t) => t.id !== id)), TOAST_MS)
  }, [])

  // An edit refused because the user may only look.
  const refused = useProjectStore((s) => s.refusedEdits)
  useEffect(() => {
    if (refused) say("You can view this project, not change it. Ask its owner for edit access.")
  }, [refused, say])

  // Made an editor or a viewer while it was open.
  const role = useProjectStore((s) => s.role)
  const lastRole = useRef(role)
  useEffect(() => {
    if (lastRole.current === role) return
    if (role === "viewer") say("You can only view this project now.")
    else if (lastRole.current === "viewer") say("You can edit this project now.")
    lastRole.current = role
  }, [role, say])

  // Someone else's edit landed.
  useEffect(
    () =>
      onRemoteChanges((batches, before, after) => {
        const who = senderName(batches)
        const ui = uiApi()
        const gone = ui.selection.filter((key) => !exists(after, key))
        if (gone.length) {
          ui.select(ui.selection.filter((key) => exists(after, key)))
          const refs = gone.filter((k) => k.startsWith("c:")).map((k) => before.components.find((c) => c.id === k.slice(2))?.ref).filter((r): r is string => !!r)
          say(refs.length ? `${who.name} deleted ${listOf(refs)}, which you had selected.` : `${who.name} deleted something you had selected.`, who.color)
        }
        const arrived = new Set(
          batches.flatMap((b) => (b.changes ?? []).flatMap((c) => (c.kind === "put" && c.collection === "components" ? [String(c.item.id)] : []))),
        )
        if (!arrived.size || projectApi().role === "viewer") return
        const { renumbered } = resolveDesignatorClashes(after, arrived, isCreatedHere)
        if (!renumbered.length) return
        projectApi().patch((p) => resolveDesignatorClashes(p, arrived, isCreatedHere).project)
        const r = renumbered[0]
        say(
          renumbered.length === 1
            ? `${who.name} added a ${r.from} at the same moment, so yours is now ${r.to}.`
            : `${who.name} added parts at the same moment, so ${renumbered.length} of yours were renumbered (${listOf(renumbered.map((x) => `${x.from} → ${x.to}`))}).`,
          who.color,
        )
      }),
    [say],
  )

  // Someone arrived.
  useEffect(() => {
    let seen = new Set<string>()
    let ready = false
    return usePresence.subscribe((s) => {
      // Another project, or its list not in yet: those there when it comes are in the top bar already.
      if (!s.loaded) {
        seen = new Set()
        ready = false
        return
      }
      const self = s.selfUserId
      for (const p of s.peers) {
        if (p.userId === self || seen.has(p.userId)) continue
        seen.add(p.userId)
        if (ready) say(`${p.name || "A guest"} joined.`, p.color)
      }
      ready = true
    })
  }, [say])

  return (
    <>
      <div aria-live="polite" className="pointer-events-none absolute bottom-14 left-1/2 z-30 flex -translate-x-1/2 flex-col items-center gap-1.5">
        {toasts.map((t) => (
          <div key={t.id} role="status" className="pointer-events-auto flex max-w-[460px] animate-pop-in items-center gap-2 rounded-[9px] bg-ink py-1.5 pl-3 pr-1.5 text-[12.5px] text-surface shadow-menu">
            {t.color && <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: t.color }} />}
            <span className="min-w-0">{t.text}</span>
            <button aria-label="Dismiss" className="rounded-[5px] p-1 text-surface/60 hover:text-surface" onClick={() => setToasts((all) => all.filter((x) => x.id !== t.id))}>
              <X size={12} />
            </button>
          </div>
        ))}
      </div>
      <GoneDialog />
    </>
  )
}

/**
 * The project was deleted, or stopped being shared with the user, while it was open. What is on
 * screen is still theirs to keep: a download of it opens anywhere.
 */
function GoneDialog() {
  const gone = useProjectStore((s) => s.gone)
  const project = useProjectStore((s) => s.project)
  if (!gone || !project) return null
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div role="alertdialog" aria-modal="true" aria-labelledby="gone-title" className="w-full max-w-[420px] rounded-[var(--radius-panel)] border border-line bg-surface p-5 shadow-dialog">
        <h2 id="gone-title" className="text-[15px] font-[650] text-ink">
          This project is no longer available
        </h2>
        <p className="mt-2 text-[13px] leading-[1.5] text-ink-2">It was deleted, or it is no longer shared with you. Download a copy to keep what's on screen; it opens as a new project from your projects page.</p>
        <div className="mt-5 flex justify-end gap-2">
          <Button onClick={() => downloadText(serializeProject(project, { pretty: true }), projectFileName(project, "json"), "application/json")}>
            <Download size={14} />
            Download a copy
          </Button>
          <Button variant="primary" onClick={goHome}>
            Back to projects
          </Button>
        </div>
      </div>
    </div>
  )
}
