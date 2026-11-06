import { PanelLeftClose, Tag } from "lucide-react"
import { useEffect, useState } from "react"
import { changeLines, versionBy, versionLabel, versionTime, type HistoryState, type VersionInfo, type VersionPerson } from "../store/history"
import { leavePreview, previewVersion } from "../store/historyActions"
import { projectStorage, useProjectStore } from "../store/projectStore"
import { uiApi } from "../store/uiStore"
import { Avatar } from "../ui/Avatar"
import { Button, IconButton } from "../ui/controls"

// Version history as a column on the left, like the sheet tree: the project as it is now, then the copies kept as it was edited, newest first, each with
// when, who and what changed since the one before. A click shows a version in the canvas, read-only (`PreviewBanner` is the way back, and the restore).
// Editors can name the current state, or any version, and a named version is kept for good. A checkpoint Sakura or the user's own AI assistant saved
// (`save_version`), or kept before restoring one (`restore_version`), says so under its time.

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
  too_many: "A project can have 50 named versions. Remove the name of one to add another.",
  forbidden: "Only people who can edit can name a version.",
  not_found: "The project is gone.",
} as const

export function HistoryPanel() {
  const projectId = useProjectStore((s) => s.project?.id)
  const preview = useProjectStore((s) => s.preview)
  const [limit, setLimit] = useState(PAGE)
  const { state, error } = useHistory(projectId, limit)
  const source = projectStorage()?.history
  const [note, setNote] = useState<string | null>(null)
  const [draft, setDraft] = useState("")
  /** The name being typed for the selected version. */
  const [rename, setRename] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const canName = !!state && state.role !== "viewer"
  const now = Date.now()

  // A different project starts the list over.
  useEffect(() => setLimit(PAGE), [projectId])
  useEffect(() => setRename(null), [preview?.version.id])
  if (!source || !projectId) return null

  const show = async (v: VersionInfo) => {
    setNote(null)
    const result = await previewVersion(v)
    if (!result.ok) setNote(result.message)
  }
  const nameIt = async (name: string, versionId?: string) => {
    setBusy(true)
    try {
      const outcome = await source.name(projectId, name, versionId)
      if (outcome.ok) {
        setNote(null)
        if (versionId) setRename(null)
        else setDraft("")
      } else setNote(NAME_REFUSED[outcome.reason])
    } catch {
      setNote("Couldn't save the name. Check the connection and try again.")
    }
    setBusy(false)
  }
  const unname = async (v: VersionInfo) => {
    const outcome = await source.unname(projectId, v.id).catch(() => null)
    if (!outcome?.ok) setNote("Couldn't take the name off.")
  }

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
      {note && (
        <p role="alert" className="mx-2.5 mb-2 rounded-[6px] bg-danger-soft px-2 py-1.5 text-[12px] text-danger">
          {note}
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
          return (
            <li key={v.id} className="mt-0.5">
              <button
                type="button"
                aria-current={selected ? "true" : undefined}
                onClick={() => void show(v)}
                className={`flex w-full flex-col gap-1 rounded-[6px] px-2 py-1.5 text-left ${selected ? "bg-active text-on-active" : "text-ink hover:bg-hover"}`}
              >
                <span className="flex min-w-0 items-center gap-1.5 font-[600]">
                  {v.kind === "named" && <Tag size={12} className="shrink-0 text-brand" aria-label="Named version" />}
                  <span className="min-w-0 truncate">{versionLabel(v)}</span>
                </span>
                {(v.name || v.kind === "restore") && (
                  <span className={`text-[11.5px] ${selected ? "opacity-80" : "text-ink-3"}`}>
                    {versionTime(v.at, now)}
                    {v.via && ` · ${versionBy(v)}`}
                  </span>
                )}
                <Changes version={v} />
                <People people={v.kind === "restore" && v.by ? [v.by] : v.editors} />
              </button>
              {selected && canName && (
                <div className="flex gap-1.5 px-2 pb-1 pt-1">
                  {v.kind === "named" ? (
                    <Button className="h-7 text-[12px]" onClick={() => void unname(v)}>
                      Remove name
                    </Button>
                  ) : rename === null ? (
                    <Button className="h-7 text-[12px]" onClick={() => setRename("")}>
                      Name this version
                    </Button>
                  ) : (
                    <form
                      className="flex min-w-0 flex-1 gap-1.5"
                      onSubmit={(e) => {
                        e.preventDefault()
                        void nameIt(rename, v.id)
                      }}
                    >
                      <input
                        autoFocus
                        aria-label="Name for this version"
                        maxLength={80}
                        value={rename}
                        onChange={(e) => setRename(e.target.value)}
                        className="h-7 min-w-0 flex-1 rounded-[var(--radius-ctl)] border border-line bg-field px-2 text-[12px] text-ink outline-none focus:border-select"
                      />
                      <Button type="submit" className="h-7 text-[12px]" disabled={busy || !rename.trim()}>
                        Save
                      </Button>
                    </form>
                  )}
                </div>
              )}
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
