import { ChevronRight, PanelLeftClose, Search, Sparkles, X } from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"
import { SymbolPreview } from "../editor/schematic/SymbolView"
import { projectPartDefs } from "../model/customParts"
import { CATEGORIES, PARTS } from "../model/library"
import { searchLibrary, type PartHit } from "../model/search"
import type { PartDef } from "../model/types"
import { askCopilot, useCopilot } from "../store/copilotStore"
import { useProjectStore } from "../store/projectStore"
import { PART_MIME, PRESET_MIME, useUi } from "../store/uiStore"
import { IconButton } from "../ui/controls"
import { Tooltip } from "../ui/Tooltip"
import { IndexNotice, IndexResults, indexPicker, useIndexSearch } from "./IndexResults"
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
  const searching = query.trim().length > 0
  const hits = useMemo(() => (searching ? searchLibrary(query, own) : []), [query, own, searching])
  // The parts database's answer, after the library's: KiCad parts the library doesn't have.
  const index = useIndexSearch(searching ? query : "", hits.map((h) => h.part.name))
  const stored = index.found
  const storedHits = stored?.hits ?? []
  // The supplier's catalogue, for a part number the library and the database don't have.
  // Enter on a part number asks LCSC as soon as the database has answered (tens of milliseconds)
  // instead of after the pause: the database is free, and a part it has never costs a lookup.
  const [pushed, setPushed] = useState<{ q: string; n: number } | null>(null)
  // Not for a viewer, who can't place what it finds: each search spends one of their lookups.
  const supplierWanted =
    !viewer && searching && wantsSupplier({ query, databaseSettled: index.settled, hits: index.hits, libraryHasIt: hits.length > 0 && !hits[0].partial })
  const supplier = useSupplierSearch(query, supplierWanted, pushed)
  const total = hits.length + storedHits.length + supplier.candidates.length
  const indexPlace = usePartPlace(indexPicker)
  const supplierPlace = usePartPlace(supplierPicker)
  const groups = useMemo(() => {
    if (searching) return []
    return [
      { title: "This project", parts: own },
      ...CATEGORIES.map((category) => ({ title: category, parts: PARTS.filter((p) => p.category === category) })),
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
    <aside aria-label="Parts library" className="flex w-[252px] shrink-0 flex-col border-r border-line bg-chrome">
      <div className="flex h-11 shrink-0 items-center justify-between pl-3.5 pr-1.5">
        <h2 className="text-[13px] font-[650] text-ink">Parts</h2>
        <IconButton label="Hide parts library" shortcut="[" onClick={() => useUi.getState().toggleLibrary()}>
          <PanelLeftClose size={16} />
        </IconButton>
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
            <CreateWithCopilot query={query.trim()} prominent={(!hits.length || !!hits[0].partial) && !storedHits.length && !supplier.candidates.length} />
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
                    className="flex w-full items-center gap-1 rounded-[6px] px-1.5 pb-1 pt-2 text-left text-[12px] font-[650] text-ink-2 transition-colors hover:text-ink"
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
        Click a part, then click the schematic to place it, or drag it onto the canvas. Search for values and packages too, like "10k 0603".
      </p>
    </aside>
  )
}

/** Hand a part the library doesn't have to Sakura, the copilot, which can make it from the datasheet. */
function CreateWithCopilot({ query, prominent }: { query: string; prominent: boolean }) {
  const busy = useCopilot((s) => s.runningProject !== null)
  const ask = () => askCopilot(`Add a ${query.slice(0, 80)} to the schematic. If the parts library doesn't have it, create the part.`)
  if (!prominent) {
    return (
      <button
        disabled={busy}
        onClick={ask}
        className="mt-2 flex w-full items-center gap-1.5 rounded-[8px] px-1.5 py-1.5 text-left text-[12px] text-ink-2 transition-colors hover:bg-surface hover:text-ink disabled:opacity-50"
      >
        <Sparkles size={13} className="shrink-0 text-brand" />
        <span className="truncate">Not here? Ask Sakura to create it</span>
      </button>
    )
  }
  return (
    <div className="mx-1 mt-3 rounded-[var(--radius-panel)] border border-line bg-surface p-3 text-center">
      <p className="text-[12px] text-ink-2">"{query}" isn't in the library.</p>
      <button
        disabled={busy}
        onClick={ask}
        className="mx-auto mt-2 inline-flex h-7 items-center gap-1.5 rounded-full bg-brand px-3 text-[12px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
      >
        <Sparkles size={13} />
        Create it with Sakura
      </button>
      <p className="mt-2 text-[11px] leading-snug text-ink-3">
        {busy ? "Sakura is busy. Try again when it finishes." : "It builds the symbol and footprint from the datasheet pinout."}
      </p>
    </div>
  )
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
}

function PartRow({ part, hit, index, id, focused, active, onHover, onPlace }: PartRowProps) {
  const chips = [...Object.values(hit?.props ?? {}), ...(hit?.footprint ? [hit.footprint] : [])]
  return (
    <li id={id} role={hit ? "option" : undefined} aria-selected={hit ? focused : undefined} data-hit={index}>
      <button
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData(PART_MIME, part.id)
          if (hit) e.dataTransfer.setData(PRESET_MIME, JSON.stringify({ props: hit.props, footprint: hit.footprint }))
          e.dataTransfer.effectAllowed = "copy"
        }}
        onClick={onPlace}
        onMouseEnter={onHover}
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
    </li>
  )
}
