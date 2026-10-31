import { ChevronRight, PanelLeftClose, Pencil, Search, Sparkles, Trash2, Upload, X } from "lucide-react"
import { useEffect, useMemo, useRef, useState, type DragEvent } from "react"
import { SymbolPreview } from "../editor/schematic/SymbolView"
import { projectPartDefs } from "../model/customParts"
import { BASIC_PARTS, CATEGORIES } from "../model/library"
import { unusedParts } from "../model/projectParts"
import { searchLibrary, type PartHit } from "../model/search"
import type { PartDef } from "../model/types"
import { askCopilot, useCopilot } from "../store/copilotStore"
import { useProjectStore } from "../store/projectStore"
import { PART_MIME, PRESET_MIME, useUi } from "../store/uiStore"
import { IconButton } from "../ui/controls"
import { Tooltip } from "../ui/Tooltip"
import { ImportNotice, useKicadImport } from "./ImportKicad"
import { IndexNotice, IndexResults, indexPicker, useIndexSearch } from "./IndexResults"
import { KICAD_IMPORT_ACCEPT } from "./kicadImport"
import { removeProjectParts } from "./partActions"
import { usePartPlace, wantsSupplier } from "./partSearch"
import { SupplierResults, supplierPicker, useSupplierSearch } from "./SupplierResults"

export function LibraryPanel() {
  const [query, setQuery] = useState("")
  const [active, setActive] = useState(0)
  const placing = useUi((s) => s.placing)
  const startPlacing = useUi((s) => s.startPlacing)
  const projectParts = useProjectStore((s) => s.project?.parts)
  const viewer = useProjectStore((s) => s.role === "viewer")
  const projectSymbols = useProjectStore((s) => s.project?.symbols)
  const own = useMemo(() => projectPartDefs({ parts: projectParts, symbols: projectSymbols }), [projectParts, projectSymbols])
  // The parts placed in the project, as one string: a drag changes the components, not which parts they are, and must not redraw the panel.
  const placed = useProjectStore((s) => [...new Set(s.project?.components.map((c) => c.partId))].sort().join("\n"))
  // The project's parts nothing is placed from: marked in the list, and removed at once from their row.
  const unused = useMemo(
    () => new Set(unusedParts({ parts: projectParts, components: placed.split("\n").map((partId) => ({ partId })) }).map((s) => s.id)),
    [projectParts, placed],
  )
  /** What a project part's row offers besides placing it: its details, and taking it out of the project. */
  const ownActions = (part: PartDef): PartActions | undefined =>
    part.custom && projectParts?.some((s) => s.id === part.id)
      ? {
          unused: unused.has(part.id),
          onEdit: () => useUi.getState().openPartEditor(part.id),
          // A part nothing is placed from goes at once (undo brings it back); one that is placed asks first, in the part editor.
          onRemove: viewer ? undefined : () => (unused.has(part.id) ? removeProjectParts([part.id]) : useUi.getState().openPartEditor(part.id, { remove: true })),
        }
      : undefined
  const searching = query.trim().length > 0
  // The panel's library is the basic parts: a specific chip or module comes from the parts database below.
  const matched = useMemo(() => (searching ? searchLibrary(query, own, BASIC_PARTS) : []), [query, own, searching])
  const partial = !!matched[0]?.partial
  // The parts database's answer, after the library's: KiCad parts the library doesn't have.
  const index = useIndexSearch(searching ? query : "", partial ? [] : matched.map((h) => h.part.name))
  const stored = index.found
  const storedHits = stored?.hits ?? []
  // Basic parts that match only some of the words ("op amp" finding a push button) give way to the database's real hits.
  const hits = partial && storedHits.length ? [] : matched
  // The supplier's catalogue, for a part number the library and the database don't have.
  // Enter on a part number asks LCSC as soon as the database has answered (tens of milliseconds)
  // instead of after the pause: the database is free, and a part it has never costs a lookup.
  const [pushed, setPushed] = useState<{ q: string; n: number } | null>(null)
  // Not for a viewer, who can't place what it finds: each search spends one of their lookups.
  const supplierWanted =
    !viewer && searching && wantsSupplier({ query, databaseSettled: index.settled, hits: index.hits, libraryHasIt: matched.length > 0 && !partial })
  const supplier = useSupplierSearch(query, supplierWanted, pushed)
  const total = hits.length + storedHits.length + supplier.candidates.length
  const indexPlace = usePartPlace(indexPicker)
  const supplierPlace = usePartPlace(supplierPicker)
  const groups = useMemo(() => {
    if (searching) return []
    return [
      { title: "This project", parts: own, own: true },
      ...CATEGORIES.map((category) => ({ title: category, parts: BASIC_PARTS.filter((p) => p.category === category), own: false })),
    ].filter((g) => g.parts.length)
  }, [own, searching])
  const listRef = useRef<HTMLDivElement>(null)
  // Categories folded away, so a long one (Connectors) doesn't push the rest out of reach.
  const [folded, setFolded] = useState<ReadonlySet<string>>(() => new Set())
  const toggleFold = (title: string) =>
    setFolded((prev) => {
      const next = new Set(prev)
      if (!next.delete(title)) next.add(title)
      return next
    })

  // Imported parts show under This project: the search is cleared and the group opened for them.
  const kicad = useKicadImport((ids) => {
    if (!ids.length) return
    setQuery("")
    setFolded((prev) => {
      const next = new Set(prev)
      next.delete("This project")
      return next
    })
  })
  const importInput = useRef<HTMLInputElement>(null)
  const [dropping, setDropping] = useState(false)
  const dragDepth = useRef(0)
  const hasFiles = (e: DragEvent) => e.dataTransfer.types.includes("Files")

  useEffect(() => setActive(0), [query])
  const { clearError } = indexPlace
  useEffect(clearError, [query, clearError])
  const clearSupplierError = supplierPlace.clearError
  useEffect(clearSupplierError, [query, clearSupplierError])
  useEffect(() => {
    listRef.current?.querySelector(`[data-hit="${active}"]`)?.scrollIntoView({ block: "nearest" })
  }, [active])

  // A viewer browses the library but places nothing, and reads no part it could only fail to place.
  const place = (hit: PartHit) => {
    if (!viewer) startPlacing(hit.part.id, { props: hit.props, footprint: hit.footprint })
  }
  /** The result at a keyboard position: the library's first, then the database's, then LCSC's. */
  const pick = (i: number) => {
    if (viewer) return
    if (i < hits.length) place(hits[i])
    else if (i < hits.length + storedHits.length) void indexPlace.place(storedHits[i - hits.length])
    else if (supplier.candidates[i - hits.length - storedHits.length]) void supplierPlace.place(supplier.candidates[i - hits.length - storedHits.length])
  }

  return (
    <aside
      aria-label="Parts library"
      className={`relative flex w-[252px] shrink-0 flex-col border-r border-line bg-chrome ${dropping ? "shadow-[inset_0_0_0_2px_var(--color-select)]" : ""}`}
      // KiCad files dropped on the panel are imported as the button's are; a viewer adds nothing.
      onDragEnter={(e) => {
        if (viewer || !hasFiles(e)) return
        dragDepth.current++
        setDropping(true)
      }}
      onDragLeave={(e) => {
        if (hasFiles(e) && --dragDepth.current <= 0) setDropping(false)
      }}
      onDragOver={(e) => !viewer && hasFiles(e) && e.preventDefault()}
      onDrop={(e) => {
        if (viewer || !hasFiles(e)) return
        e.preventDefault()
        dragDepth.current = 0
        setDropping(false)
        void kicad.run([...e.dataTransfer.files])
      }}
    >
      <div className="flex h-11 shrink-0 items-center justify-between pl-3.5 pr-1.5">
        <h2 className="text-[13px] font-[650] text-ink">Parts</h2>
        <span className="flex items-center">
          <IconButton
            label="Import KiCad part"
            hint="Symbol, footprint and 3D model files, or a zip of them"
            disabled={kicad.busy || viewer}
            onClick={() => importInput.current?.click()}
          >
            <Upload size={15} />
          </IconButton>
          <IconButton label="Hide parts library" shortcut="[" onClick={() => useUi.getState().toggleLibrary()}>
            <PanelLeftClose size={16} />
          </IconButton>
        </span>
        <input
          ref={importInput}
          type="file"
          multiple
          accept={KICAD_IMPORT_ACCEPT}
          className="hidden"
          aria-label="KiCad files to import"
          onChange={(e) => {
            void kicad.run([...(e.target.files ?? [])])
            e.target.value = ""
          }}
        />
      </div>
      <div className="px-3 pb-2">
        <label className="relative block">
          <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-3" />
          <input
            className="field h-8 pl-8 pr-7"
            placeholder="Search parts or values"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault()
                if (total) setActive((i) => (i + (e.key === "ArrowDown" ? 1 : total - 1)) % total)
              }
              if (e.key === "Enter" && !viewer) {
                // Nothing to place: Enter asks LCSC once the database has answered, not after the pause (and not twice for one answer).
                const q = query.trim()
                if (active < total) pick(active)
                else if (!(supplier.state && supplier.state.status !== "failed")) setPushed((p) => ({ q, n: (p?.n ?? 0) + 1 }))
              }
              if (e.key === "Escape") setQuery("")
            }}
            aria-label="Search parts"
            role="combobox"
            aria-expanded={searching}
            aria-controls="part-results"
            aria-activedescendant={searching && active < total ? `part-hit-${active}` : undefined}
          />
          {query && (
            <Tooltip label="Clear search">
              <button aria-label="Clear search" className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-ink-3 hover:text-ink" onClick={() => setQuery("")}>
                <X size={14} />
              </button>
            </Tooltip>
          )}
        </label>
      </div>
      {viewer && (
        <p className="mx-3 mb-2 rounded-[8px] bg-chrome px-2.5 py-2 text-[12px] text-ink-2">You can view this project, not add to it. Ask its owner for edit access.</p>
      )}
      {kicad.state && <ImportNotice state={kicad.state} onDismiss={kicad.dismiss} />}
      <div ref={listRef} aria-disabled={viewer} className={`scroll-thin min-h-0 flex-1 overflow-y-auto px-2 pb-4 ${viewer ? "opacity-60" : ""}`}>
        {searching ? (
          <>
            {hits.length > 0 && (
              <p className="px-1.5 pb-1 pt-1 text-[11.5px] text-ink-3">
                {hits[0].partial ? "No exact match. Closest parts:" : `${hits.length} ${hits.length === 1 ? "part" : "parts"}`}
              </p>
            )}
            <ul id="part-results" role="listbox" aria-label="Parts">
              {hits.map((hit, i) => (
                <PartRow
                  key={hit.part.id}
                  id={`part-hit-${i}`}
                  index={i}
                  part={hit.part}
                  hit={hit}
                  focused={i === active}
                  active={placing?.partId === hit.part.id}
                  onHover={() => setActive(i)}
                  onPlace={() => place(hit)}
                  actions={ownActions(hit.part)}
                />
              ))}
            </ul>
            {stored && (
              <IndexResults
                found={stored}
                offset={hits.length}
                active={active}
                busy={indexPlace.busy}
                error={indexPlace.error}
                onHover={setActive}
                onPlace={(h) => {
                  if (!viewer) void indexPlace.place(h)
                }}
              />
            )}
            {index.failure && <IndexNotice line={index.failure} />}
            {supplier.state && (
              <SupplierResults
                query={query.trim()}
                state={supplier.state}
                offset={hits.length + storedHits.length}
                active={active}
                busy={supplierPlace.busy}
                error={supplierPlace.error}
                onHover={setActive}
                onPlace={(c) => {
                  if (!viewer) void supplierPlace.place(c)
                }}
              />
            )}
            <NotFound
              query={query.trim()}
              prominent={(!hits.length || !!hits[0].partial) && !storedHits.length && !supplier.candidates.length}
              onImport={viewer || kicad.busy ? undefined : () => importInput.current?.click()}
            />
          </>
        ) : (
          groups.map((g) => {
            const open = !folded.has(g.title)
            return (
              <section key={g.title} className={open ? "mb-3" : "mb-0.5"}>
                <h3>
                  <button
                    aria-expanded={open}
                    onClick={() => toggleFold(g.title)}
                    className="flex w-full min-w-0 items-center gap-1 rounded-[6px] px-1.5 pb-1 pt-2 text-left text-[12px] font-[650] text-ink-2 transition-colors hover:text-ink"
                  >
                    <ChevronRight size={12} className={`shrink-0 text-ink-3 transition-transform ${open ? "rotate-90" : ""}`} />
                    <span className="flex-1 truncate">{g.title}</span>
                    <span className="text-[11px] font-normal text-ink-3">{g.parts.length}</span>
                  </button>
                </h3>
                {open && (
                  <ul>
                    {g.parts.map((p) => (
                      <PartRow
                        key={p.id}
                        part={p}
                        active={placing?.partId === p.id}
                        onPlace={() => {
                          if (!viewer) startPlacing(p.id)
                        }}
                        actions={g.own ? ownActions(p) : undefined}
                      />
                    ))}
                  </ul>
                )}
              </section>
            )
          })
        )}
      </div>
      <p className="border-t border-line px-3 py-2 text-[11px] leading-snug text-ink-3">
        {dropping
          ? "Drop KiCad symbol, footprint and 3D model files, or a zip of them, to import the part."
          : searching
            ? "We look in the basic parts first, then in our parts database (KiCad's libraries and the LCSC parts we keep), then at LCSC for a part number neither has."
            : 'These are the basic parts. Search finds any other by name or number, like "NE555", or by value and package, like "10k 0603". Click a part, then the schematic, to place it.'}
      </p>
    </aside>
  )
}

/**
 * What to do about a part no search found: hand it to Sakura, the copilot, which can make it from
 * supplier data or the datasheet, or import the part's own KiCad files. `onImport` is absent for a
 * viewer, who adds nothing, and while an import runs.
 */
function NotFound({ query, prominent, onImport }: { query: string; prominent: boolean; onImport?: () => void }) {
  const busy = useCopilot((s) => s.runningProject !== null)
  const ask = () => askCopilot(`Add a ${query.slice(0, 80)} to the schematic. If the parts library doesn't have it, create the part.`)
  if (!prominent) {
    const row = "flex w-full items-center gap-1.5 rounded-[8px] px-1.5 py-1.5 text-left text-[12px] text-ink-2 transition-colors hover:bg-surface hover:text-ink disabled:opacity-50"
    return (
      <div className="mt-2">
        <button disabled={busy} onClick={ask} className={row}>
          <Sparkles size={13} className="shrink-0 text-brand" />
          <span className="truncate">Not here? Ask Sakura to create it</span>
        </button>
        {onImport && (
          <button onClick={onImport} className={row}>
            <Upload size={13} className="shrink-0 text-ink-3" />
            <span className="truncate">Or import its KiCad files</span>
          </button>
        )}
      </div>
    )
  }
  return (
    <div className="mx-1 mt-3 rounded-[var(--radius-panel)] border border-line bg-surface p-3 text-center">
      <p className="text-[12px] text-ink-2">Can't find "{query}"?</p>
      <button
        disabled={busy}
        onClick={ask}
        className="mx-auto mt-2 inline-flex h-7 items-center gap-1.5 rounded-full bg-brand px-3 text-[12px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
      >
        <Sparkles size={13} />
        Create it with Sakura
      </button>
      <p className="mt-2 text-[11px] leading-snug text-ink-3">
        {busy ? "Sakura is busy. Try again when it finishes." : "It builds the symbol and footprint from supplier data or the datasheet."}
      </p>
      {onImport && (
        <button
          onClick={onImport}
          className="mx-auto mt-2.5 inline-flex h-7 items-center gap-1.5 rounded-full border border-line px-3 text-[12px] font-medium text-ink-2 transition-colors hover:bg-chrome-2 hover:text-ink"
        >
          <Upload size={13} />
          Import KiCad files
        </button>
      )}
    </div>
  )
}

interface PartActions {
  /** Nothing in the project is placed from it. */
  unused: boolean
  onEdit: () => void
  /** Absent for a viewer, who removes nothing. */
  onRemove?: () => void
}

interface PartRowProps {
  part: PartDef
  hit?: PartHit
  /** Position in the search results, for keyboard focus. */
  index?: number
  id?: string
  focused?: boolean
  active: boolean
  onHover?: () => void
  onPlace: () => void
  /** A project part's: open it in the part editor, or take it out of the project. */
  actions?: PartActions
}

function PartRow({ part, hit, index, id, focused, active, onHover, onPlace, actions }: PartRowProps) {
  const chips = [...Object.values(hit?.props ?? {}), ...(hit?.footprint ? [hit.footprint] : [])]
  return (
    <li id={id} role={hit ? "option" : undefined} aria-selected={hit ? focused : undefined} data-hit={index} className={actions ? "group relative" : undefined}>
      <button
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData(PART_MIME, part.id)
          if (hit) e.dataTransfer.setData(PRESET_MIME, JSON.stringify({ props: hit.props, footprint: hit.footprint }))
          e.dataTransfer.effectAllowed = "copy"
        }}
        onClick={onPlace}
        onMouseEnter={onHover}
        // Altium's double-click on a library component: its properties.
        onDoubleClick={
          actions
            ? () => {
                useUi.getState().stopPlacing()
                actions.onEdit()
              }
            : undefined
        }
        title={part.description}
        className={`flex w-full items-center gap-2.5 rounded-[8px] px-1.5 py-1.5 text-left transition-colors ${
          active ? "bg-surface shadow-[inset_0_0_0_1.5px_var(--color-select)]" : focused ? "bg-surface" : "hover:bg-surface"
        }`}
      >
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[6px] bg-paper">
          <SymbolPreview part={part} size={34} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1">
            <span className="truncate text-[13px] font-[600] text-ink">{part.name}</span>
            {part.custom && <span className="shrink-0 rounded-[4px] bg-brand-soft px-1 text-[10px] font-medium text-brand">Project</span>}
            {actions?.unused && (
              <span className="shrink-0 rounded-[4px] bg-chrome-2 px-1 text-[10px] text-ink-2" title="Nothing in the project is placed from this part">
                Unused
              </span>
            )}
          </span>
          <span className="block truncate text-[11.5px] text-ink-2">{part.description}</span>
          {chips.length > 0 && (
            <span className="mt-0.5 flex flex-wrap gap-1">
              {chips.map((c) => (
                <span key={c} className="mono rounded-[4px] bg-chrome-2 px-1 text-[10.5px] text-ink">
                  {c}
                </span>
              ))}
            </span>
          )}
        </span>
      </button>
      {actions && (
        // Over the row's right end while it is hovered or a control in it has focus.
        <span className="absolute right-1 top-1/2 flex -translate-y-1/2 items-center gap-0.5 rounded-[6px] bg-surface opacity-0 shadow-chip transition-opacity focus-within:opacity-100 group-hover:opacity-100">
          <Tooltip label={actions.onRemove ? "Edit part" : "View part"} hint="Its symbol, pins, footprint and parameters">
            <button aria-label={`${actions.onRemove ? "Edit" : "View"} ${part.name}`} onClick={actions.onEdit} className="rounded-[5px] p-1 text-ink-2 hover:bg-chrome-2 hover:text-ink">
              <Pencil size={13} />
            </button>
          </Tooltip>
          {actions.onRemove && (
            <Tooltip label="Remove from project" hint={actions.unused ? "Nothing is placed from it. Undo brings it back" : "Asks first: the components placed from it go too"}>
              <button aria-label={`Remove ${part.name} from the project`} onClick={actions.onRemove} className="rounded-[5px] p-1 text-ink-2 hover:bg-danger-soft hover:text-danger">
                <Trash2 size={13} />
              </button>
            </Tooltip>
          )}
        </span>
      )}
    </li>
  )
}
