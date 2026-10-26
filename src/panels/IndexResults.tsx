import type { PartIndexHit } from "@cherryblossom/api-contract"
import { Database, Loader2 } from "lucide-react"
import { useEffect, useMemo, useState } from "react"
import { withPartChecks } from "../ai/partTools"
import { supplierParts, type PartsIndexSource } from "../ai/supplierParts"
import { draftFromIndexPart } from "../model/indexPart"
import { checkPlacedPart, type PlacedPartCheck } from "../model/placedPartCheck"
import { partNumberKey } from "../model/supplier/partNumber"
import { projectApi } from "../store/projectStore"
import { addPart, indexFailureLine, isWildcardOf, matchNote, packageLabel, panelChecks, worthChecking, type Picker } from "./partSearch"

// The parts index in the library panel's search: parts our database stores whole (KiCad's
// libraries) that the built-in library doesn't have. Picking one reads it whole, makes it a project
// part that says where it came from ("KiCad library"), and places it like any other part.

/** What `GET /api/v1/parts/index/search` takes; anything else it refuses, so it isn't sent. */
const QUERY = /^[\p{L}\p{N} .,+\-/#()_]{2,64}$/u
/** The index answers in tens of milliseconds, so it can follow typing closely. */
const DEBOUNCE_MS = 150
const SHOWN = 8

export interface IndexFound {
  hits: PartIndexHit[]
  attribution: string[]
  /** The query these hits answer, which a wildcard hit is read against. */
  query: string
}

/** What the library panel knows of the database's answer to the query being typed. */
export interface IndexSearch {
  /** The hits to show: what the library doesn't already have by the same number. */
  found: IndexFound | null
  /** Every hit the database gave, whatever the library shows, for deciding whether the supplier is worth asking. */
  hits: PartIndexHit[]
  /** The database has answered this query, or has nothing to answer with (no database here, or a query it won't take). */
  settled: boolean
  /** One line for a search that really failed; null when it worked, or the deployment simply has no database. */
  failure: string | null
}

interface Answer {
  q: string
  hits: PartIndexHit[]
  attribution: string[]
  failure: string | null
}

/**
 * Stored parts for the query, after a pause in typing, leaving out what the library already shows
 * by the same number. The last answer stays up while the next is on its way, so the list doesn't
 * flicker as someone types. A search that failed says so in one muted line, and the library's own
 * results are still there; a deployment with no database says nothing.
 */
export function useIndexSearch(query: string, libraryNames: string[]): IndexSearch {
  const index = supplierParts()?.index
  const q = query.trim()
  const valid = !!index && QUERY.test(q)
  const [answer, setAnswer] = useState<Answer | null>(null)

  useEffect(() => {
    if (!index || !valid) {
      setAnswer(null)
      return
    }
    const controller = new AbortController()
    const timer = setTimeout(() => {
      index.search(q, { limit: SHOWN * 2, full: true }, controller.signal).then(
        (res) => {
          if (!controller.signal.aborted) setAnswer({ q, hits: res.hits, attribution: res.attribution, failure: null })
        },
        (e) => {
          if (!controller.signal.aborted) setAnswer({ q, hits: [], attribution: [], failure: indexFailureLine(e, false) })
        },
      )
    }, DEBOUNCE_MS)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [index, q, valid])

  const library = libraryNames.join("\n")
  return useMemo(() => {
    const current = valid && answer?.q === q ? answer : null
    const have = new Set(library.split("\n").map(partNumberKey))
    const shown = (valid && answer ? answer.hits : []).filter((h) => !have.has(partNumberKey(h.mpn))).slice(0, SHOWN)
    return {
      found: shown.length && answer ? { hits: shown, attribution: answer.attribution, query: answer.q } : null,
      hits: current?.hits ?? [],
      settled: !valid || current !== null,
      failure: current?.failure ?? null,
    }
  }, [valid, answer, q, library])
}

/** The line that says the database couldn't be searched. */
export function IndexNotice({ line }: { line: string }) {
  return (
    <p className="mt-2 px-1.5 text-[11px] leading-snug text-ink-3" role="status">
      {line}
    </p>
  )
}

/**
 * Reads a stored part whole and adds it to the open project, as one undo step. Answers its part
 * id, or what stopped it. A KiCad part new to the project is then compared with the supplier's
 * record in the background (one at a time, a few at most: each spends the account's lookups), and
 * the verdict is kept without an undo step, in the snapshots Undo and Redo go back to as well.
 */
export async function addIndexPart(index: PartsIndexSource, hit: PartIndexHit, signal?: AbortSignal) {
  const added = await addPart((s) => index.part(hit.id, s), draftFromIndexPart, `${hit.mpn} isn't stored whole any more.`, projectApi().commit, signal)
  if ("error" in added || !added.placed || !worthChecking(added.placed.spec)) return added
  const { spec, projectId } = added.placed
  // Without a check the part is as it was; a snapshot with it gets the verdict.
  const record: PlacedPartCheck["record"] = (edit) => projectApi().patch((p) => (p.parts?.some((s) => s.id === spec.id) ? edit(p) : p))
  const queued = panelChecks.push(() => {
    const now = projectApi().project?.parts?.find((s) => s.id === spec.id)
    if (now?.source?.check) return Promise.resolve(null)
    return checkPlacedPart({ source: supplierParts(), spec, projectId, open: () => projectApi().project, record })
  })
  // Too many waiting: the part is left pending rather than unchecked, so verify_parts takes it later.
  if (!queued) {
    const pending = { at: new Date().toISOString(), verdict: "pending" as const, findings: ["Too many parts were placed at once to compare this one with the supplier."] }
    record((p) => withPartChecks(p, new Map([[spec.id, pending]])))
  }
  return added
}

/** How a stored part is picked in the panel. */
export const indexPicker: Picker<PartIndexHit> = {
  key: (hit) => hit.id,
  add: async (hit) => {
    const index = supplierParts()?.index
    return index ? addIndexPart(index, hit) : null
  },
}

interface IndexResultsProps {
  found: IndexFound
  /** Where these rows start in the panel's keyboard order: after the library's. */
  offset: number
  active: number
  busy: string | null
  error: string | null
  onHover: (i: number) => void
  onPlace: (hit: PartIndexHit) => void
}

export function IndexResults({ found, offset, active, busy, error, onHover, onPlace }: IndexResultsProps) {
  return (
    <section className="mt-2" aria-label="Parts database">
      <h3 className="flex items-center gap-1 px-1.5 pb-1 pt-2 text-[12px] font-[650] text-ink-2">
        <Database size={12} className="shrink-0 text-ink-3" />
        From the parts database
      </h3>
      <ul role="listbox" aria-label="Parts database">
        {found.hits.map((h, i) => {
          const at = offset + i
          const focused = at === active
          const note = matchNote(h.match, isWildcardOf(found.query, h.mpn))
          return (
            <li key={h.id} id={`part-hit-${at}`} role="option" aria-selected={focused} data-hit={at}>
              <button
                onClick={() => onPlace(h)}
                onMouseEnter={() => onHover(at)}
                disabled={busy !== null}
                title={h.description ?? h.mpn}
                className={`flex w-full items-center gap-2.5 rounded-[8px] px-1.5 py-1.5 text-left transition-colors disabled:opacity-60 ${focused ? "bg-surface" : "hover:bg-surface"}`}
              >
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[6px] bg-paper text-ink-3">
                  {busy === h.id ? <Loader2 size={16} className="animate-spin" /> : <Database size={16} />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-[600] text-ink">{h.mpn}</span>
                  <span className="block truncate text-[11.5px] text-ink-2">{h.description ?? h.package ?? ""}</span>
                  <span className="mt-0.5 flex flex-wrap gap-1">
                    <span className="rounded-[4px] bg-brand-soft px-1 text-[10px] font-medium text-brand">{h.source === "kicad" ? "KiCad library" : "Supplier record"}</span>
                    {note && <span className="rounded-[4px] bg-chrome-2 px-1 text-[10px] font-medium text-warn">{note}</span>}
                    {h.package && <span className="mono rounded-[4px] bg-chrome-2 px-1 text-[10.5px] text-ink">{packageLabel(h.package)}</span>}
                    {h.pinCount !== null && <span className="mono rounded-[4px] bg-chrome-2 px-1 text-[10.5px] text-ink">{h.pinCount} pins</span>}
                  </span>
                </span>
              </button>
            </li>
          )
        })}
      </ul>
      {error && (
        <p role="alert" className="px-1.5 pt-1 text-[11.5px] leading-snug text-danger">
          {error}
        </p>
      )}
      {found.attribution.map((line) => (
        <p key={line} className="px-1.5 pt-1 text-[10.5px] leading-snug text-ink-3">
          {line}{" "}
          <a href="/credits" target="_blank" rel="noreferrer" className="underline hover:text-ink-2">
            Credits
          </a>
        </p>
      ))}
    </section>
  )
}
