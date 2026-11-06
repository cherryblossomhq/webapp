import { EllipsisVertical, ExternalLink, PanelLeftClose, Pencil, Split, Tag, Trash2 } from "lucide-react"
import { useEffect, useRef, useState, type ReactNode } from "react"
import { projectLink } from "../App"
import { useEditorAccount } from "../store/account"
import { changeLines, versionLabel, versionTime, type HistoryState, type VersionInfo, type VersionPerson } from "../store/history"
import { deleteVersion, forkVersion, leavePreview, previewVersion } from "../store/historyActions"
import { projectStorage, useProjectStore } from "../store/projectStore"
import { uiApi } from "../store/uiStore"
import { Avatar } from "../ui/Avatar"
import { Button, IconButton, useDismiss } from "../ui/controls"

// Version history as a column on the left, like the sheet tree: the project as it is now, then the copies kept as it was edited, newest first, each with
// when, who and what changed since the one before. A click shows a version in the canvas, read-only (`PreviewBanner` is the way back, and the restore).
// Editors can name the current state; each version's ⋮ menu renames it (a named version is kept for good), forks it into a new project of the user's own
// (viewers too, signed in), or deletes it.

const PAGE = 50

const names = (people: VersionPerson[]) => people.map((p) => p.name || p.email || "Someone").join(", ")

function People({ people }: { people: VersionPerson[] }) {
  if (!people.length) return null
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-[11.5px] text-ink-3">
      <span className="flex shrink-0 -space-x-1.5">
        {people.slice(0, 4).map((p) => (
          <Avatar key={p.userId} person={p} size="xs" className="ring-2 ring-chrome" />
        ))}
      </span>
      <span className="min-w-0 truncate">{names(people)}</span>
    </span>
  )
}

const SIGN_CLASS = { added: "text-ok", removed: "text-danger", changed: "text-ink-2" } as const

function Changes({ version }: { version: VersionInfo }) {
  const lines = changeLines(version.summary)
  if (!lines.length) return <span className="text-[11.5px] text-ink-3">No changes to parts, wires or traces</span>
  return (
    <span className="flex flex-wrap gap-x-2 text-[11.5px]">
      {lines.map((l) => (
        <span key={l.kind + l.sign} className={SIGN_CLASS[l.sign]}>
          {l.text}
        </span>
      ))}
    </span>
  )
}

/** The history, live, for the newest `limit` versions. `undefined` while loading, `null` when the project can not be read. */
function useHistory(projectId: string | undefined, limit: number) {
  const [state, setState] = useState<HistoryState | null | undefined>(undefined)
  const [error, setError] = useState<string | null>(null)
  const source = projectStorage()?.history
  useEffect(() => {
    if (!source || !projectId) return
    return source.watch(
      projectId,
      limit,
      (next) => {
        setState(next)
        setError(null)
      },
      (e) => setError(e.message),
    )
  }, [source, projectId, limit])
  return { state, error }
}

const NAME_REFUSED = {
  invalid: "Give the version a name.",
  too_many: "A project can have 50 named versions. Delete one, or take its name off, to name another.",
  forbidden: "Only people who can edit can name a version.",
  not_found: "That version, or the project, is gone.",
} as const

/** In-place rename over a version's title; Enter or leaving the field keeps the name, Escape drops it. */
function RenameField({ name, onDone }: { name: string; onDone: (name: string | null) => void }) {
  const [draft, setDraft] = useState(name)
  const cancelled = useRef(false)
  return (
    <input
      autoFocus
      aria-label="Version name"
      placeholder="Name this version"
      maxLength={80}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onFocus={(e) => e.target.select()}
      onBlur={() => onDone(cancelled.current ? null : draft)}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur()
        if (e.key === "Escape") {
          cancelled.current = true
          e.currentTarget.blur()
        }
      }}
      className="h-7 w-full rounded-[var(--radius-ctl)] border border-select bg-field px-2 text-[12.5px] font-[600] text-ink outline-none"
    />
  )
}

function MenuItem({ icon, danger, onClick, children }: { icon: ReactNode; danger?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={`flex h-8 w-full items-center gap-2.5 rounded-[7px] px-2.5 text-left text-[13px] ${danger ? "text-danger hover:bg-danger-soft" : "text-ink hover:bg-chrome"}`}
    >
      <span className={danger ? "" : "text-ink-2"}>{icon}</span>
      {children}
    </button>
  )
}

interface VersionActions {
  /** Absent for someone who can't edit. */
  rename?: () => void
  fork: () => void
  remove?: () => void
}

/** A version's ⋮ menu. Delete asks once more inside it, since a deleted version can't be brought back. */
function VersionMenu({ label, selected, actions }: { label: string; selected: boolean; actions: VersionActions }) {
  const [open, setOpen] = useState(false)
  const [confirming, setConfirming] = useState(false)
  // Near the bottom of the list the menu opens upwards, so it isn't cut off.
  const [up, setUp] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const close = () => {
    setOpen(false)
    setConfirming(false)
  }
  useDismiss(ref, open, close)
  const run = (fn: () => void) => () => {
    close()
    fn()
  }
  return (
    <div ref={ref} className={`absolute right-1 top-1 ${open || selected ? "" : "opacity-0 focus-within:opacity-100 group-hover:opacity-100"}`}>
      <IconButton
        label={`More actions for ${label}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(e) => {
          // The list scrolls, and clips what hangs below it.
          const bottom = e.currentTarget.closest("ul")?.getBoundingClientRect().bottom ?? window.innerHeight
          setUp(e.currentTarget.getBoundingClientRect().bottom + 160 > bottom)
          setConfirming(false)
          setOpen(!open)
        }}
        className={`!h-6 !w-6 ${selected ? "!text-on-active hover:!bg-white/15" : open ? "bg-chrome-2 !text-ink" : "!text-ink-3"}`}
      >
        <EllipsisVertical size={15} />
      </IconButton>
      {open && (
        <div
          role="menu"
          aria-label={`Actions for ${label}`}
          className={`absolute right-0 z-30 w-[220px] animate-pop-in rounded-[10px] border border-line bg-surface p-1 shadow-menu ${up ? "bottom-7 origin-bottom-right" : "top-7 origin-top-right"}`}
        >
          {confirming && actions.remove ? (
            <div className="p-1.5">
              <p className="text-[12.5px] text-ink">Delete this version? It can&apos;t be brought back. The project stays as it is.</p>
              <div className="mt-2 flex justify-end gap-1.5">
                <Button className="h-7 px-2.5 text-[12px]" onClick={() => setConfirming(false)}>
                  Cancel
                </Button>
                <Button variant="danger" className="h-7 px-2.5 text-[12px]" onClick={run(actions.remove)}>
                  Delete
                </Button>
              </div>
            </div>
          ) : (
            <>
              {actions.rename && (
                <MenuItem icon={<Pencil size={15} />} onClick={run(actions.rename)}>
                  Rename
                </MenuItem>
              )}
              <MenuItem icon={<Split size={15} />} onClick={run(actions.fork)}>
                Fork to a new project
              </MenuItem>
              {actions.remove && (
                <>
                  <div className="mx-1 my-1 h-px bg-line" />
                  <MenuItem icon={<Trash2 size={15} />} danger onClick={() => setConfirming(true)}>
                    Delete…
                  </MenuItem>
                </>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}

type Note = { text: string; error: true } | { text: string; error: false; link?: string }

export function HistoryPanel() {
  const projectId = useProjectStore((s) => s.project?.id)
  const preview = useProjectStore((s) => s.preview)
  const signedOut = !!useEditorAccount()?.signIn
  const [limit, setLimit] = useState(PAGE)
  const { state, error } = useHistory(projectId, limit)
  const source = projectStorage()?.history
  const [note, setNote] = useState<Note | null>(null)
  const [draft, setDraft] = useState("")
  /** The version whose name is being typed. */
  const [renaming, setRenaming] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const canName = !!state && state.role !== "viewer"
  const now = Date.now()

  // A different project starts the list over.
  useEffect(() => setLimit(PAGE), [projectId])
  if (!source || !projectId) return null

  const fail = (text: string) => setNote({ text, error: true })
  const show = async (v: VersionInfo) => {
    setNote(null)
    const result = await previewVersion(v)
    if (!result.ok) fail(result.message)
  }
  const nameIt = async (name: string, versionId?: string) => {
    setBusy(true)
    try {
      const outcome = await source.name(projectId, name, versionId)
      if (outcome.ok) {
        setNote(null)
        if (!versionId) setDraft("")
      } else fail(NAME_REFUSED[outcome.reason])
    } catch {
      fail("Couldn't save the name. Check the connection and try again.")
    }
    setBusy(false)
  }
  /** A rename typed over a version's title: an empty one takes a name off. */
  const renamed = async (v: VersionInfo, typed: string | null) => {
    setRenaming(null)
    const name = typed?.trim() ?? null
    if (name === null || name === (v.name ?? "")) return
    if (name) return nameIt(name, v.id)
    const outcome = await source.unname(projectId, v.id).catch(() => null)
    if (!outcome?.ok) fail("Couldn't take the name off.")
  }
  const fork = async (v: VersionInfo) => {
    setNote({ text: "Forking the version into a new project…", error: false })
    const result = await forkVersion(v)
    setNote(result.ok ? { text: `Forked as “${result.name}”.`, error: false, link: projectLink(result.id) } : { text: result.message, error: true })
  }
  const remove = async (v: VersionInfo) => {
    setNote(null)
    const result = await deleteVersion(v.id)
    if (!result.ok) fail(result.message)
  }
  const actionsFor = (v: VersionInfo): VersionActions => ({
    ...(canName && { rename: () => setRenaming(v.id), remove: () => void remove(v) }),
    fork: () => void fork(v),
  })

  return (
    <aside aria-label="Version history" className="flex w-[300px] shrink-0 flex-col border-r border-line bg-chrome">
      <div className="flex h-11 shrink-0 items-center justify-between pl-3.5 pr-1.5">
        <h2 className="text-[13px] font-[650] text-ink">Version history</h2>
        <IconButton label="Hide version history" onClick={() => uiApi().toggleHistory()}>
          <PanelLeftClose size={16} />
        </IconButton>
      </div>
      {canName && (
        <form
          className="flex shrink-0 gap-1.5 px-2.5 pb-2"
          onSubmit={(e) => {
            e.preventDefault()
            void nameIt(draft)
          }}
        >
          <input
            aria-label="Name the current version"
            placeholder="Name this version"
            maxLength={80}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            className="h-8 min-w-0 flex-1 rounded-[var(--radius-ctl)] border border-line bg-field px-2 text-[12.5px] text-ink outline-none focus:border-select"
          />
          <Button type="submit" disabled={busy || !draft.trim()}>
            Save
          </Button>
        </form>
      )}
      {note?.error && (
        <p role="alert" className="mx-2.5 mb-2 rounded-[6px] bg-danger-soft px-2 py-1.5 text-[12px] text-danger">
          {note.text}
        </p>
      )}
      {note && !note.error && (
        <p role="status" className="mx-2.5 mb-2 flex items-center justify-between gap-2 rounded-[6px] bg-hover px-2 py-1.5 text-[12px] text-ink">
          <span className="min-w-0">{note.text}</span>
          {note.link && (
            <a href={note.link} target="_blank" rel="noreferrer" className="flex shrink-0 items-center gap-1 font-[600] text-brand hover:underline">
              Open
              <ExternalLink size={12} />
            </a>
          )}
        </p>
      )}
      <ul className="scroll-thin min-h-0 flex-1 overflow-y-auto px-1.5 pb-2 text-[12.5px]">
        {error && <li className="px-2 py-2 text-danger">Could not load the history. {error}</li>}
        {state === undefined && !error && <li className="px-2 py-2 text-ink-3">Loading…</li>}
        {state === null && <li className="px-2 py-2 text-ink-3">The history is not available for this project.</li>}
        {state && (
          <li>
            <button
              type="button"
              aria-current={preview ? undefined : "true"}
              onClick={leavePreview}
              className={`flex w-full flex-col gap-0.5 rounded-[6px] px-2 py-1.5 text-left ${preview ? "text-ink-2 hover:bg-hover hover:text-ink" : "bg-active font-[600] text-on-active"}`}
            >
              <span>Current version</span>
              <span className={`text-[11.5px] font-normal ${preview ? "text-ink-3" : "opacity-80"}`}>
                {state.current.edits ? `${state.current.edits} ${state.current.edits === 1 ? "edit" : "edits"} since the last version` : "No edits since the last version"}
                {state.current.editors.length ? `, by ${names(state.current.editors)}` : ""}
              </span>
            </button>
          </li>
        )}
        {state?.versions.map((v) => {
          const selected = preview?.version.id === v.id
          const label = versionLabel(v)
          return (
            <li key={v.id} className={`group relative mt-0.5 rounded-[6px] ${selected ? "bg-active text-on-active" : "text-ink hover:bg-hover"}`}>
              {renaming === v.id && (
                <div className="px-1 pt-1">
                  <RenameField name={v.name ?? ""} onDone={(typed) => void renamed(v, typed)} />
                </div>
              )}
              <button type="button" aria-current={selected ? "true" : undefined} onClick={() => void show(v)} className="flex w-full flex-col gap-1 px-2 py-1.5 pr-8 text-left">
                {renaming !== v.id && (
                  <span className="flex min-w-0 items-center gap-1.5 font-[600]">
                    {v.kind === "named" && <Tag size={12} className="shrink-0 text-brand" aria-label="Named version" />}
                    <span className="min-w-0 truncate">{label}</span>
                  </span>
                )}
                {(v.name || v.kind === "restore") && <span className={`text-[11.5px] ${selected ? "opacity-80" : "text-ink-3"}`}>{versionTime(v.at, now)}</span>}
                <Changes version={v} />
                <People people={v.kind === "restore" && v.by ? [v.by] : v.editors} />
              </button>
              {!signedOut && renaming !== v.id && <VersionMenu label={label} selected={selected} actions={actionsFor(v)} />}
            </li>
          )
        })}
        {state?.more && (
          <li className="px-2 pt-2">
            <Button className="w-full justify-center" onClick={() => setLimit((n) => n + PAGE)}>
              Show older versions
            </Button>
          </li>
        )}
        {state && !state.versions.length && <li className="px-2 py-2 text-ink-3">Versions are kept as you edit. The first one appears after your next change.</li>}
      </ul>
    </aside>
  )
}
