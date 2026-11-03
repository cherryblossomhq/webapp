import { CircuitBoard, Cloud, Copy, Download, Ellipsis, FileUp, FolderOpen, HardDrive, LayoutGrid, List, Loader2, Pencil, Plus, Search, Trash2, Upload, X } from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from "react"
import { openProjectRoute } from "../App"
import { EXAMPLES, type Example } from "../model/examples"
import { createProject } from "../model/ops"
import type { Project } from "../model/types"
import { entriesFromDrop, entriesFromFiles, isProjectFileDrop } from "../kicadImport/dropped"
import { KicadImportDialog } from "../kicadImport/KicadImportDialog"
import { ACCEPTED_EXTENSIONS } from "../kicadImport/pick"
import { useKicadImport } from "../kicadImport/useKicadImport"
import { ThemeButton } from "../panels/ThemeButton"
import {
  actionFailure,
  createStoredProject,
  downloadStoredProject,
  duplicateStoredProject,
  examplePreview,
  importProjectFile,
  projectPicture,
  removeStoredProject,
  renameStoredProject,
} from "../store/projectActions"
import type { ProjectStorage, StoredProjectSummary } from "../store/storage"
import { useUi } from "../store/uiStore"
import { Button, IconButton, Kbd, Segmented, useDismiss } from "../ui/controls"
import { LazyPreview } from "./BoardPreview"

function relativeTime(ts: number) {
  const s = Math.round((Date.now() - ts) / 1000)
  if (s < 60) return "just now"
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} h ago`
  const d = Math.round(h / 24)
  if (d < 30) return `${d} d ago`
  return new Date(ts).toLocaleDateString()
}

const plural = (n: number, one: string) => `${n} ${n === 1 ? one : `${one}s`}`
const partCount = (p: Project) => p.components.filter((c) => !c.ref.startsWith("#")).length
const boardSize = (p: Project) => `${Number(p.board.width.toFixed(1))} × ${Number(p.board.height.toFixed(1))} mm`

function ProjectPreview({ meta, storage }: { meta: StoredProjectSummary; storage: ProjectStorage }) {
  return <LazyPreview id={`${meta.id}@${meta.updatedAt}@${meta.thumbnail?.madeAt ?? 0}`} load={() => projectPicture(storage, meta)} className="h-full w-full animate-fade-in" />
}

const CARD =
  "flex flex-col rounded-[12px] border border-line bg-surface p-1.5 text-left transition-[border-color,box-shadow,translate] duration-200 hover:-translate-y-0.5 hover:border-ink-3/60 hover:shadow-float"

function CardText({ title, detail, meta }: { title: string; detail: string; meta: string }) {
  return (
    <div className="px-1.5 pb-1 pt-2.5">
      <div className="truncate text-[13px] font-[650] text-ink">{title}</div>
      <div className="mt-0.5 line-clamp-2 text-[12px] leading-[1.4] text-ink-2">{detail}</div>
      <div className="mt-1.5 text-[11.5px] tabular-nums text-ink-3">{meta}</div>
    </div>
  )
}

function BlankCard({ onClick }: { onClick: () => void }) {
  return (
    <button onClick={onClick} className={`group ${CARD}`}>
      <div className="flex aspect-[4/3] items-center justify-center rounded-[8px] border border-dashed border-line bg-chrome/50 transition-colors group-hover:border-ink-3 group-hover:bg-chrome">
        <span className="flex size-10 items-center justify-center rounded-full bg-surface text-ink-2 shadow-chip transition-colors group-hover:text-brand">
          <Plus size={20} />
        </span>
      </div>
      <CardText title="Blank project" detail="An empty schematic and a two-layer board." meta="Start from scratch" />
    </button>
  )
}

function ExampleCard({ example, onOpen }: { example: Example; onOpen: () => void }) {
  const p = example.project
  return (
    <button onClick={onOpen} className={`group ${CARD}`}>
      <div className="studio flex aspect-[4/3] items-center justify-center overflow-hidden rounded-[8px] p-2.5 ring-1 ring-inset ring-white/[0.06]">
        <div className="h-full w-full transition-transform duration-300 ease-out group-hover:scale-[1.04]">
          <LazyPreview id={example.id} load={() => examplePreview(example)} />
        </div>
      </div>
      <CardText title={example.name} detail={example.description} meta={`${plural(partCount(p), "part")} · ${boardSize(p)}`} />
    </button>
  )
}

interface ProjectActions {
  open: () => void
  rename: () => void
  duplicate: () => void
  download: () => void
  remove: () => void
}

function MenuItem({ icon, danger = false, onClick, children }: { icon: ReactNode; danger?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      role="menuitem"
      onClick={onClick}
      className={`flex h-8 w-full items-center gap-2.5 rounded-[7px] px-2.5 text-left text-[13px] ${danger ? "text-danger hover:bg-danger-soft" : "text-ink hover:bg-chrome"}`}
    >
      <span className={danger ? "" : "text-ink-2"}>{icon}</span>
      {children}
    </button>
  )
}

function ProjectMenu({ name, actions }: { name: string; actions: ProjectActions }) {
  const [open, setOpen] = useState(false)
  // Near the bottom of the window the menu opens upwards, so it isn't cut off.
  const [up, setUp] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useDismiss(ref, open, () => setOpen(false))
  const run = (fn: () => void) => () => {
    setOpen(false)
    fn()
  }
  return (
    <div ref={ref} className="relative shrink-0">
      <IconButton
        label={`More actions for ${name}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(e) => {
          setUp(e.currentTarget.getBoundingClientRect().bottom + 240 > window.innerHeight)
          setOpen(!open)
        }}
        className={`!h-7 !w-7 ${open ? "bg-chrome-2 !text-ink" : "!text-ink-3"}`}
      >
        <Ellipsis size={16} />
      </IconButton>
      {open && (
        <div
          role="menu"
          className={`absolute right-0 z-30 w-[208px] animate-pop-in rounded-[10px] border border-line bg-surface p-1 shadow-menu ${up ? "bottom-8 origin-bottom-right" : "top-8 origin-top-right"}`}
        >
          <MenuItem icon={<FolderOpen size={15} />} onClick={run(actions.open)}>
            Open
          </MenuItem>
          <MenuItem icon={<Pencil size={15} />} onClick={run(actions.rename)}>
            Rename
          </MenuItem>
          <MenuItem icon={<Copy size={15} />} onClick={run(actions.duplicate)}>
            Duplicate
          </MenuItem>
          <MenuItem icon={<Download size={15} />} onClick={run(actions.download)}>
            Download project file
          </MenuItem>
          <div className="mx-1 my-1 h-px bg-line" />
          <MenuItem icon={<Trash2 size={15} />} danger onClick={run(actions.remove)}>
            Delete…
          </MenuItem>
        </div>
      )}
    </div>
  )
}

/** In-place rename; Enter or leaving the field keeps the name, Escape drops it. */
function RenameField({ name, onDone }: { name: string; onDone: (name: string | null) => void }) {
  const [draft, setDraft] = useState(name)
  const cancelled = useRef(false)
  return (
    <input
      autoFocus
      aria-label="Rename project"
      className="field h-[22px] px-1.5 py-0 text-[13px] font-[650]"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onFocus={(e) => e.target.select()}
      onBlur={() => onDone(cancelled.current ? null : draft.trim() || null)}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur()
        if (e.key === "Escape") {
          cancelled.current = true
          e.currentTarget.blur()
        }
      }}
    />
  )
}

interface ItemProps {
  meta: StoredProjectSummary
  storage: ProjectStorage
  renaming: boolean
  onRenamed: (name: string | null) => void
  actions: ProjectActions
}

const edited = (m: StoredProjectSummary) => `Edited ${relativeTime(m.updatedAt)}`

function ProjectCard({ meta, storage, renaming, onRenamed, actions }: ItemProps) {
  return (
    <li className="group flex flex-col rounded-[12px] border border-line bg-surface p-1.5 transition-[border-color,box-shadow] duration-200 hover:border-ink-3/60 hover:shadow-float">
      <button onClick={actions.open} aria-label={`Open ${meta.name}`} className="studio flex aspect-[16/10] items-center justify-center overflow-hidden rounded-[8px] p-3 ring-1 ring-inset ring-white/[0.06]">
        <ProjectPreview meta={meta} storage={storage} />
      </button>
      <div className="flex items-start gap-1 pb-1 pl-1.5 pt-2">
        <div className="min-w-0 flex-1">
          {renaming ? (
            <RenameField name={meta.name} onDone={onRenamed} />
          ) : (
            <button onClick={actions.open} className="block max-w-full truncate text-left text-[13px] font-[650] text-ink">
              {meta.name}
            </button>
          )}
          <div className="mt-0.5 truncate text-[12px] text-ink-2">
            {edited(meta)} · {plural(meta.componentCount, "part")}
          </div>
        </div>
        <ProjectMenu name={meta.name} actions={actions} />
      </div>
    </li>
  )
}

function ProjectRow({ meta, storage, renaming, onRenamed, actions }: ItemProps) {
  return (
    <li className="group flex items-center gap-4 px-3 py-2 hover:bg-hover">
      <button onClick={actions.open} aria-label={`Open ${meta.name}`} className="studio flex h-11 w-[68px] shrink-0 items-center justify-center overflow-hidden rounded-[6px] p-1">
        <ProjectPreview meta={meta} storage={storage} />
      </button>
      <div className="min-w-0 flex-1">
        {renaming ? (
          <RenameField name={meta.name} onDone={onRenamed} />
        ) : (
          <button onClick={actions.open} className="block max-w-full truncate text-left text-[13px] font-[650] text-ink">
            {meta.name}
          </button>
        )}
        <div className="truncate text-[12px] text-ink-2">{meta.description || "No description"}</div>
      </div>
      <div className="mono hidden w-16 shrink-0 text-right text-[12px] text-ink-2 sm:block">{meta.componentCount}</div>
      <div className="hidden w-28 shrink-0 text-[12px] text-ink-2 md:block">{relativeTime(meta.updatedAt)}</div>
      <ProjectMenu name={meta.name} actions={actions} />
    </li>
  )
}

function ConfirmDelete({ meta, location, onCancel, onConfirm }: { meta: StoredProjectSummary; location: ProjectStorage["location"]; onCancel: () => void; onConfirm: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onCancel()
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onCancel])
  return (
    <div
      className="fixed inset-0 z-50 flex animate-fade-in items-center justify-center bg-black/40 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel()
      }}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="delete-title"
        aria-describedby="delete-detail"
        className="w-full max-w-[400px] animate-pop-in rounded-[var(--radius-panel)] border border-line bg-surface p-5 shadow-dialog"
      >
        <h2 id="delete-title" className="text-[15px] font-[650] text-ink">
          Delete “{meta.name}”?
        </h2>
        <p id="delete-detail" className="mt-1.5 text-[13px] text-ink-2">
          {location === "account"
            ? "It is deleted from your account and can't be brought back."
            : "It is only saved in this browser, so it can't be brought back."}{" "}
          Download the project file first to keep a copy.
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <Button onClick={onCancel}>Cancel</Button>
          <Button autoFocus variant="danger" onClick={onConfirm}>
            <Trash2 size={15} /> Delete project
          </Button>
        </div>
      </div>
    </div>
  )
}

function SectionTitle({ title, children }: { title: ReactNode; children?: ReactNode }) {
  return (
    <div className="mb-3 flex min-h-8 flex-wrap items-center justify-between gap-3">
      <h2 className="flex items-center gap-2 text-[14px] font-[650] text-ink">{title}</h2>
      {children}
    </div>
  )
}

export function Dashboard({ storage }: { storage: ProjectStorage }) {
  const [projects, setProjects] = useState<StoredProjectSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState("")
  const [renaming, setRenaming] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<StoredProjectSummary | null>(null)
  const [dropping, setDropping] = useState(false)
  const view = useUi((s) => s.settings.projectsView)
  const fileRef = useRef<HTMLInputElement>(null)
  const kicadRef = useRef<HTMLInputElement>(null)
  const kicad = useKicadImport(storage)
  const searchRef = useRef<HTMLInputElement>(null)
  const dragDepth = useRef(0)

  useEffect(
    () =>
      storage.watchList(
        (list) => setProjects(list),
        () => setError("Couldn't load your projects. Check your connection and reload the page."),
      ),
    [storage],
  )

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    const all = projects ?? []
    return q ? all.filter((m) => `${m.name}\n${m.description}`.toLowerCase().includes(q)) : all
  }, [projects, query])

  // "/" jumps to the search, as in most project browsers.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey) return
      if (e.target instanceof Element && e.target.closest("input, textarea, [contenteditable]")) return
      e.preventDefault()
      searchRef.current?.focus()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  /** Run a dashboard action, turning its failure into the error line. */
  const attempt = (doing: string, action: () => Promise<unknown>) => {
    setError(null)
    action().catch((e: unknown) => setError(actionFailure(e, doing)))
  }

  const importFile = (file: File) => attempt("import the project", async () => openProjectRoute(await importProjectFile(storage, file)))

  const createAndOpen = async (project: Project) => openProjectRoute(await createStoredProject(storage, project))

  const newProject = () => attempt("create the project", () => createAndOpen(createProject()))

  /** Each click on an example makes a new project from it. */
  const openExample = (e: Example) => attempt("open the example", () => createAndOpen(e.project))

  const actionsFor = (m: StoredProjectSummary): ProjectActions => ({
    open: () => openProjectRoute(m.id),
    rename: () => setRenaming(m.id),
    duplicate: () => attempt("duplicate the project", () => duplicateStoredProject(storage, m)),
    download: () => attempt("download the project", () => downloadStoredProject(storage, m)),
    remove: () => setDeleting(m),
  })

  const renamed = (m: StoredProjectSummary) => (name: string | null) => {
    setRenaming(null)
    if (!name || name === m.name) return
    attempt("rename the project", () => renameStoredProject(storage, m, name))
  }

  const cancelDelete = useCallback(() => setDeleting(null), [])
  const confirmDelete = () => {
    if (!deleting) return
    const { id } = deleting
    setDeleting(null)
    attempt("delete the project", () => removeStoredProject(storage, id))
  }

  const hasFiles = (e: DragEvent) => e.dataTransfer.types.includes("Files")

  return (
    <div
      data-scroll-root
      className="h-full overflow-y-auto bg-paper scroll-thin"
      onDragEnter={(e) => {
        if (!hasFiles(e)) return
        dragDepth.current++
        setDropping(true)
      }}
      onDragLeave={(e) => {
        if (hasFiles(e) && --dragDepth.current <= 0) setDropping(false)
      }}
      onDragOver={(e) => hasFiles(e) && e.preventDefault()}
      onDrop={(e) => {
        if (!hasFiles(e)) return
        e.preventDefault()
        dragDepth.current = 0
        setDropping(false)
        const dropped = e.dataTransfer.files
        // Project files of ours (`.json`) as they always went; anything else is KiCad's, folders included.
        if (isProjectFileDrop(dropped)) return importFile(dropped[0])
        kicad.controller.startFromDrop(entriesFromDrop(e.dataTransfer))
      }}
    >
      <header className="sticky top-0 z-20 border-b border-line bg-paper/85 backdrop-blur-md">
        <div className="mx-auto flex min-h-14 max-w-[1200px] flex-wrap items-center gap-2 px-6 py-2">
          <a href="/" className="flex items-center gap-2 text-[15px] font-[750] tracking-[-0.01em] text-ink hover:opacity-90">
            <img src="/logo.svg" alt="" className="size-[22px]" />
            Cherry Blossom
          </a>
          <span className="flex-1" />
          <ThemeButton />
          <Button onClick={() => fileRef.current?.click()}>
            <Upload size={15} /> Import
          </Button>
          <Button onClick={() => kicadRef.current?.click()}>
            <CircuitBoard size={15} /> Import KiCad
          </Button>
          <Button variant="primary" onClick={newProject}>
            <Plus size={15} /> New project
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept=".json,application/json"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) importFile(f)
              e.target.value = ""
            }}
          />
          <input
            ref={kicadRef}
            type="file"
            multiple
            accept={ACCEPTED_EXTENSIONS.join(",")}
            className="hidden"
            aria-label="KiCad files"
            onChange={(e) => {
              if (e.target.files?.length) kicad.controller.start(entriesFromFiles(e.target.files))
              e.target.value = ""
            }}
          />
        </div>
      </header>

      <main className="mx-auto max-w-[1200px] px-6 pb-12 pt-9">
        <h1 className="text-[26px] font-[720] leading-tight tracking-[-0.02em] text-ink">Projects</h1>
        <p className="mt-1 text-[13.5px] text-ink-2">Draw the schematic, lay out and route the board, and export Gerbers, all in the browser.</p>

        {error && (
          <div role="alert" className="mt-5 flex items-center gap-3 rounded-[10px] border border-danger/25 bg-danger-soft py-2 pl-3.5 pr-1.5 text-[13px] text-danger">
            <span className="flex-1">{error}</span>
            <IconButton label="Dismiss" onClick={() => setError(null)} className="!h-7 !w-7 !text-danger hover:!bg-danger/10">
              <X size={15} />
            </IconButton>
          </div>
        )}

        <section className="mt-9" aria-labelledby="start-title">
          <SectionTitle title={<span id="start-title">Start a new design</span>}>
            <span className="text-[12px] text-ink-3">Examples are routed, poured and open as your own copy.</span>
          </SectionTitle>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
            <BlankCard onClick={newProject} />
            {EXAMPLES.map((e) => (
              <ExampleCard key={e.id} example={e} onOpen={() => openExample(e)} />
            ))}
          </div>
        </section>

        <section className="mt-12" aria-labelledby="projects-title">
          <SectionTitle
            title={
              <>
                <span id="projects-title">Your projects</span>
                {!!projects?.length && <span className="mono rounded-full bg-chrome-2 px-1.5 text-[11px] font-[600] text-ink-2">{projects!.length}</span>}
              </>
            }
          >
            {!!projects?.length && (
              <div className="flex items-center gap-2">
                <label className="relative flex items-center">
                  <Search size={14} className="pointer-events-none absolute left-2.5 text-ink-3" />
                  <input
                    ref={searchRef}
                    type="search"
                    aria-label="Search projects"
                    placeholder="Search projects"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key !== "Escape") return
                      setQuery("")
                      e.currentTarget.blur()
                    }}
                    className="field peer h-8 w-[220px] pl-8 pr-8 text-[13px]"
                  />
                  <span className="pointer-events-none absolute right-2 peer-focus:hidden">
                    <Kbd>/</Kbd>
                  </span>
                </label>
                <Segmented<"grid" | "list">
                  value={view}
                  onChange={(projectsView) => useUi.getState().updateSettings({ projectsView })}
                  options={[
                    { value: "grid", label: <LayoutGrid size={15} aria-label="Grid" />, title: "Grid view" },
                    { value: "list", label: <List size={15} aria-label="List" />, title: "List view" },
                  ]}
                />
              </div>
            )}
          </SectionTitle>

          {projects === null ? (
            <div className="flex items-center justify-center gap-2 rounded-[12px] border border-line px-6 py-12 text-[13px] text-ink-3">
              <Loader2 size={15} className="animate-spin" /> Loading your projects
            </div>
          ) : projects.length === 0 ? (
            <div className="flex flex-col items-center rounded-[12px] border border-dashed border-line px-6 py-12 text-center">
              <span className="flex size-11 items-center justify-center rounded-full bg-chrome text-ink-2">
                <CircuitBoard size={20} />
              </span>
              <p className="mt-3 font-[650] text-ink">No projects yet</p>
              <p className="mt-1 max-w-[46ch] text-[13px] text-ink-2">
                Start a blank project or open an example above. To bring in a project file, use Import or drop it on this page; a KiCad board or project goes in with Import KiCad.
              </p>
            </div>
          ) : shown.length === 0 ? (
            <p className="rounded-[12px] border border-line bg-surface px-5 py-10 text-center text-ink-2">No projects match “{query.trim()}”.</p>
          ) : view === "grid" ? (
            <ul className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4">
              {shown.map((m) => (
                <ProjectCard key={m.id} meta={m} storage={storage} renaming={renaming === m.id} onRenamed={renamed(m)} actions={actionsFor(m)} />
              ))}
            </ul>
          ) : (
            <div className="rounded-[12px] border border-line bg-surface">
              <div className="flex items-center gap-4 border-b border-line px-3 py-2 text-[11.5px] font-[600] text-ink-3">
                <span className="w-[68px] shrink-0" />
                <span className="flex-1">Name</span>
                <span className="hidden w-16 shrink-0 text-right sm:block">Parts</span>
                <span className="hidden w-28 shrink-0 md:block">Edited</span>
                <span className="w-7 shrink-0" />
              </div>
              <ul className="divide-y divide-line">
                {shown.map((m) => (
                  <ProjectRow key={m.id} meta={m} storage={storage} renaming={renaming === m.id} onRenamed={renamed(m)} actions={actionsFor(m)} />
                ))}
              </ul>
            </div>
          )}
        </section>

        <footer className="mt-14 flex items-center gap-2 border-t border-line pt-5 text-[12px] text-ink-3">
          {storage.location === "account" ? (
            <>
              <Cloud size={14} className="shrink-0" />
              Projects are saved to your account as you work, and open on any computer you sign in on.
            </>
          ) : (
            <>
              <HardDrive size={14} className="shrink-0" />
              Projects are saved in this browser. Download a project file to back one up or move it to another device.
            </>
          )}
        </footer>
      </main>

      {dropping && (
        <div className="pointer-events-none fixed inset-0 z-40 flex animate-fade-in items-center justify-center bg-paper/80 p-6 backdrop-blur-sm">
          <div className="flex flex-col items-center rounded-[16px] border-2 border-dashed border-brand/60 bg-surface px-12 py-10 text-center shadow-dialog">
            <FileUp size={26} className="text-brand" />
            <p className="mt-3 text-[15px] font-[650] text-ink">Drop to import</p>
            <p className="mt-1 text-[13px] text-ink-2">A Cherry Blossom project file (.json), or a KiCad board, project or folder</p>
          </div>
        </div>
      )}
      <KicadImportDialog
        state={kicad.state}
        controller={kicad.controller}
        onOpen={(id) => {
          kicad.controller.close()
          openProjectRoute(id)
        }}
      />
      {deleting && <ConfirmDelete meta={deleting} location={storage.location} onCancel={cancelDelete} onConfirm={confirmDelete} />}
    </div>
  )
}
