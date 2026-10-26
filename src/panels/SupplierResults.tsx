import type { PartCandidate } from "@cherryblossom/api-contract"
import { Loader2, Store } from "lucide-react"
import { useEffect, useState } from "react"
import { supplierParts } from "../ai/supplierParts"
import { projectApi } from "../store/projectStore"
import { addSupplierPart, cachedSupplierSearch, packageLabel, searchSupplier, stockLine, supplierFailureLine, type Picker } from "./partSearch"

// The supplier's catalogue (LCSC) in the library panel's search, for a part number neither the
// library nor the parts database has. Looking it up spends one of the account's supplier lookups,
// so it waits for a pause in typing (or Enter) and asks each query once; a search once sent is
// never abandoned, so the answer is kept and found again. Picking a candidate reads
// it whole and adds a project part built from the supplier's pins and land, as Sakura's
// `create_part` with an LCSC number does.

/** How long the query has to sit still before the supplier is asked. Longer than the database's pause: this one costs. */
const PAUSE_MS = 700

export type SupplierState =
  | { q: string; status: "loading" }
  | { q: string; status: "done"; candidates: PartCandidate[] }
  | { q: string; status: "failed"; line: string }

/**
 * The supplier's candidates for `query` once `wanted` (the query looks like a part number and
 * nothing else has it), after a pause, or at once when `pushed` is Enter for this query. A query
 * asked before is answered from memory at once. A search already sent keeps running when the query
 * moves on (the lookup is paid for): only what the panel shows follows the query.
 */
export function useSupplierSearch(query: string, wanted: boolean, pushed: { q: string; n: number } | null) {
  const source = supplierParts()
  const q = query.trim()
  const [state, setState] = useState<SupplierState | null>(null)

  useEffect(() => {
    if (!source || !wanted) {
      setState(null)
      return
    }
    const cached = cachedSupplierSearch(source, q)
    if (cached) {
      setState({ q, status: "done", candidates: cached })
      return
    }
    setState(null)
    let live = true
    const timer = setTimeout(
      () => {
        setState({ q, status: "loading" })
        searchSupplier(source, q).then(
          (candidates) => {
            if (live) setState({ q, status: "done", candidates })
          },
          (e) => {
            if (live) setState({ q, status: "failed", line: supplierFailureLine(e) })
          },
        )
      },
      pushed?.q === q ? 0 : PAUSE_MS,
    )
    return () => {
      clearTimeout(timer)
      live = false
    }
  }, [source, q, wanted, pushed])

  const current = state && state.q === q ? state : null
  return { state: current, candidates: current?.status === "done" ? current.candidates : [] }
}

/** How a supplier candidate is picked in the panel: read by its LCSC number, built from the supplier's pins and land. */
export const supplierPicker: Picker<PartCandidate> = {
  key: (c) => c.lcsc,
  add: async (c) => {
    const source = supplierParts()
    return source ? addSupplierPart(source, c.lcsc, projectApi().commit) : null
  },
}

interface SupplierResultsProps {
  query: string
  state: SupplierState
  /** Where these rows start in the panel's keyboard order: after the library's and the database's. */
  offset: number
  active: number
  busy: string | null
  error: string | null
  onHover: (i: number) => void
  onPlace: (candidate: PartCandidate) => void
}

export function SupplierResults({ query, state, offset, active, busy, error, onHover, onPlace }: SupplierResultsProps) {
  const candidates = state.status === "done" ? state.candidates : []
  return (
    <section className="mt-2" aria-label="From LCSC">
      <h3 className="flex items-center gap-1 px-1.5 pb-1 pt-2 text-[12px] font-[650] text-ink-2">
        <Store size={12} className="shrink-0 text-ink-3" />
        From LCSC
      </h3>
      {state.status === "loading" && (
        <p className="flex items-center gap-1.5 px-1.5 text-[11.5px] text-ink-3">
          <Loader2 size={12} className="animate-spin" />
          Looking for {query} at LCSC
        </p>
      )}
      {state.status === "failed" && <p className="px-1.5 text-[11px] leading-snug text-ink-3">{state.line}</p>}
      {state.status === "done" && !candidates.length && <p className="px-1.5 text-[11.5px] leading-snug text-ink-3">LCSC has no {query} with a named pinout and a land pattern.</p>}
      {candidates.length > 0 && (
        <ul role="listbox" aria-label="From LCSC">
          {candidates.map((c, i) => {
            const at = offset + i
            const focused = at === active
            const pkg = packageLabel(c.package)
            return (
              <li key={c.lcsc} id={`part-hit-${at}`} role="option" aria-selected={focused} data-hit={at}>
                <button
                  onClick={() => onPlace(c)}
                  onMouseEnter={() => onHover(at)}
                  disabled={busy !== null}
                  title={c.description ?? c.mpn}
                  className={`flex w-full items-center gap-2.5 rounded-[8px] px-1.5 py-1.5 text-left transition-colors disabled:opacity-60 ${focused ? "bg-surface" : "hover:bg-surface"}`}
                >
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[6px] bg-paper text-ink-3">
                    {busy === c.lcsc ? <Loader2 size={16} className="animate-spin" /> : <Store size={16} />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-[600] text-ink">{c.mpn}</span>
                    <span className="block truncate text-[11.5px] text-ink-2">
                      {c.lcsc} · {stockLine(c.stock)}
                    </span>
                    <span className="mt-0.5 flex flex-wrap gap-1">
                      {pkg && <span className="mono rounded-[4px] bg-chrome-2 px-1 text-[10.5px] text-ink">{pkg}</span>}
                      {c.pinCount !== null && <span className="mono rounded-[4px] bg-chrome-2 px-1 text-[10.5px] text-ink">{c.pinCount} pins</span>}
                    </span>
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      )}
      {error && (
        <p role="alert" className="px-1.5 pt-1 text-[11.5px] leading-snug text-danger">
          {error}
        </p>
      )}
    </section>
  )
}
