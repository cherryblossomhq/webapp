import type { PartCandidate, PartIndexHit, PartIndexMatch, PartSearchResponse } from "@cherryblossom/api-contract"
import { useCallback, useState } from "react"
import { lookupFailure, type SupplierPartsSource } from "../ai/supplierParts"
import { addDraftToProject, type IndexDraft } from "../model/indexPart"
import { draftFromSupplierPart } from "../model/supplierPart"
import { partNumberKey } from "../model/supplier/partNumber"
import type { CustomPartSpec, Project } from "../model/types"
import { useUi } from "../store/uiStore"

// The library panel's search beyond the built-in library: what to say about a database hit, when
// the database failed, and when and how the supplier's catalogue (LCSC) is searched. A supplier
// search spends one of the account's lookups (60 a minute, 800 a day), so it is never made on a
// keystroke, never for a number the database already answers, and never twice for one query.

// ---------- the database's hits ----------

/**
 * KiCad's wildcard names: a stored number that ends in one or two lowercase x after a capital or a
 * digit (`STM32F103C8Tx`) stands for every ordering letter or digit there. Answers what comes
 * before the x's and how many there are.
 */
function wildcardOf(mpn: string): { prefix: string; fill: number } | null {
  const m = /^(.*[A-Z0-9])(x{1,2})$/.exec(mpn.trim())
  return m ? { prefix: partNumberKey(m[1]), fill: m[2].length } : null
}

/** A stored wildcard that the query fills exactly: `STM32F103C8Tx` is the part `STM32F103C8T6`, not a cousin of it. */
export function isWildcardOf(query: string, mpn: string): boolean {
  const w = wildcardOf(mpn)
  const key = partNumberKey(query)
  return !!w && key.length === w.prefix.length + w.fill && key.startsWith(w.prefix)
}

/**
 * What a hit's chip says about how it matches: nothing for a hit that is the number or starts with
 * it. A family hit says to check the package, except a wildcard the query fills (`wildcard`), which
 * is the part itself.
 */
export function matchNote(match: PartIndexMatch, wildcard = false): string | null {
  if (match === "typo") return "Close match"
  if (match === "family" && !wildcard) return "Same family, check the package"
  return null
}

/** The sentence the server gives when a deployment has no parts database: not a failure, just no database. */
const NOT_CONFIGURED = "The parts index is not configured on this deployment."

/**
 * What to say when the database search failed, or null when there is nothing to say: the
 * deployment has no database, or the request was aborted because the query moved on.
 */
export function indexFailureLine(error: unknown, aborted: boolean): string | null {
  if (aborted || (error instanceof Error && error.name === "AbortError")) return null
  const sentence = lookupFailure(error)
  if (sentence.includes(NOT_CONFIGURED)) return null
  return `The parts database couldn't be searched: ${sentence}`
}

// ---------- when to offer the supplier ----------

/** A value (10k, 4k7, 100nF, 16MHz, 3V3), which the library answers and no part number looks like. 74F00 is a logic chip, not a value. */
const VALUE = /^(?!(?:74|54)[a-z]{1,2}\d)\d+(?:[.,]\d+)?(?:meg|[pnuµmkgr])?(?:hz|ohm|[fhrvaw])?\d{0,2}$/i
/** A number and a unit, maybe with a size after it (12mm, 100nF, 10uF0805). */
const UNIT_LIKE = /^(?!(?:74|54)[a-z]{1,2}\d)\d+(?:[.,]\d+)?(?:mm|cm|um|µm|mils?|inch|in|k?ohm|%|meg|[pnuµmkg]?hz|[pnuµmkg]?[fhvaw]|[kmgr])\d*$/i
/** A size (M3x10, 2x5, 0.5x3mm). */
const DIMENSION = /^[a-z]{0,2}\d+(?:[.,]\d+)?x\d+(?:[.,]\d+)?(?:x\d+(?:[.,]\d+)?)?(?:mm|in)?$/i
/** A reference or a resistor code (R1, C12, R010): a letter and up to three digits. */
const LETTER_DIGITS = /^[a-z]\d{1,3}$/i
/** A package, which is a land and not a part (SOT-23, SOIC8, TO-220, QFN-16). */
const PACKAGE = /^(?:sot|sod|soic|sop|ssop|tssop|msop|qfn|dfn|qfp|tqfp|lqfp|bga|dip|lga|to|sma|smb|smc)-?\d+(?:-\d+)?[a-z]?$/i

/** Letters and digits with at least one of each, no spaces, three or more, and not a value, size or package: how a part number looks. */
export function looksLikePartNumber(query: string): boolean {
  const q = query.trim()
  if (q.length > 64 || !/^[\p{L}\p{N}][\p{L}\p{N}._\-/+]*$/u.test(q)) return false
  const key = partNumberKey(q)
  return key.length >= 3 && /[A-Z]/.test(key) && /\d/.test(key) && ![VALUE, UNIT_LIKE, DIMENSION, LETTER_DIGITS, PACKAGE].some((re) => re.test(q))
}

export interface SupplierOffer {
  query: string
  /** The database's answer to this query has come (or it has none to give), so what it knows is settled. */
  databaseSettled: boolean
  /** Every hit the database gave, before the panel left out those the library shows. */
  hits: Pick<PartIndexHit, "match" | "mpn">[]
  /** The library already has the part by this name, so there is nothing to look for. */
  libraryHasIt: boolean
}

/**
 * Whether the panel may offer to search the supplier for this query, after the pause or on Enter.
 * An exact or prefix hit, or a KiCad wildcard the query fills, is the part, so the supplier is left
 * alone. A family hit that only shares the number less its ordering letters (`NE555P` for
 * `NE555PW`) may be another package, so the supplier's part is still offered beside it.
 */
export function wantsSupplier({ query, databaseSettled, hits, libraryHasIt }: SupplierOffer): boolean {
  if (!databaseSettled || libraryHasIt || !looksLikePartNumber(query)) return false
  return !hits.some((h) => h.match === "exact" || h.match === "prefix" || (h.match === "family" && isWildcardOf(query, h.mpn)))
}

// ---------- the supplier's candidates ----------

/** How many candidates the panel lists. */
export const SUPPLIER_SHOWN = 6

/** Candidates that can become a part: a named pinout and a land, and not an EasyEDA user's upload. */
export function supplierCandidates(res: PartSearchResponse): PartCandidate[] {
  return res.candidates.filter((c) => c.hasVendorPinout === true && c.hasVendorLand === true && !c.userUpload).slice(0, SUPPLIER_SHOWN)
}

/** "1,200 in stock", or what we don't know. */
export const stockLine = (stock: number | null) => (stock === null ? "Stock unknown" : stock === 0 ? "Out of stock" : `${stock.toLocaleString("en-US")} in stock`)

/** The package a person reads: the supplier's string up to its first underscore. */
export const packageLabel = (pkg: string | null) => (pkg ? pkg.split("_")[0] : null)

/**
 * What the supplier has answered this session, by query, per source, and the searches still on
 * their way. A query is asked once: it costs a lookup, and the answer doesn't change in a session.
 * A search that has been sent is never abandoned, even when the query has moved on (the lookup is
 * paid for), so typing past a pause and back finds the answer waiting. Failures aren't kept, so
 * Enter tries again.
 */
const answered = new WeakMap<SupplierPartsSource, Map<string, PartCandidate[]>>()
const asking = new WeakMap<SupplierPartsSource, Map<string, Promise<PartCandidate[]>>>()

const queryKey = (query: string) => query.trim().toUpperCase()

export const cachedSupplierSearch = (source: SupplierPartsSource, query: string) => answered.get(source)?.get(queryKey(query)) ?? null

/** The candidates for the query, from the session's memory or the search already sent for it. Throws as `search` does. */
export function searchSupplier(source: SupplierPartsSource, query: string): Promise<PartCandidate[]> {
  const key = queryKey(query)
  const cached = cachedSupplierSearch(source, query)
  if (cached) return Promise.resolve(cached)
  const pending = asking.get(source) ?? new Map<string, Promise<PartCandidate[]>>()
  asking.set(source, pending)
  const sent = pending.get(key)
  if (sent) return sent
  const search = source.search(query.trim()).then(
    (res) => {
      const found = supplierCandidates(res)
      const memory = answered.get(source) ?? new Map<string, PartCandidate[]>()
      memory.set(key, found)
      answered.set(source, memory)
      pending.delete(key)
      return found
    },
    (e: unknown) => {
      pending.delete(key)
      throw e
    },
  )
  pending.set(key, search)
  return search
}

/** The line under the LCSC rows when the search failed. */
export const supplierFailureLine = (error: unknown) => `LCSC couldn't be searched: ${lookupFailure(error)}`

// ---------- picking one ----------

/** What picking a part gives: its id (and, when the part was new to the project, the spec to check in the background), or what stopped it. */
export type PlaceResult = { partId: string; placed?: { spec: CustomPartSpec; projectId: string } } | { error: string }

/**
 * Reads one part whole (`read`: null when it has gone), builds a project part from it (`build`)
 * and adds it to the open project as one undo step. The database's parts and the supplier's are
 * the same walk with another reader and another builder.
 */
export async function addPart<T>(
  read: (signal?: AbortSignal) => Promise<T | null>,
  build: (part: T) => IndexDraft | { error: string },
  gone: string,
  commit: (edit: (p: Project) => Project) => void,
  signal?: AbortSignal,
): Promise<PlaceResult> {
  let part
  try {
    part = await read(signal)
  } catch (e) {
    if (signal?.aborted) throw e
    return { error: lookupFailure(e) }
  }
  if (!part) return { error: gone }
  const built = build(part)
  if ("error" in built) return built
  let outcome: PlaceResult = { error: "No project is open." }
  commit((p) => {
    const added = addDraftToProject(p, built)
    if ("error" in added) {
      outcome = added
      return p
    }
    // Placed again or new, the part is offered for a check: one with a verdict already is passed over.
    outcome = { partId: added.spec.id, placed: { spec: added.spec, projectId: p.id } }
    return added.project
  })
  return outcome
}

/** A supplier part: read by its LCSC number, built from the supplier's pins and land. */
export const addSupplierPart = (source: SupplierPartsSource, lcsc: string, commit: (edit: (p: Project) => Project) => void, signal?: AbortSignal) =>
  addPart((s) => source.part(lcsc, s), draftFromSupplierPart, `LCSC has no record for ${lcsc} any more.`, commit, signal)

/** How a result row is picked: its key, and how it is read and added (null when there is nothing to read it from). */
export interface Picker<T> {
  key: (item: T) => string
  add: (item: T) => Promise<PlaceResult | null>
}

/** Picking a result: it is read and added, then placed. One at a time. */
export function usePartPlace<T>({ key, add }: Picker<T>) {
  const startPlacing = useUi((s) => s.startPlacing)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const place = async (item: T) => {
    if (busy) return
    setBusy(key(item))
    setError(null)
    try {
      const added = await add(item)
      if (!added) return
      if ("error" in added) setError(added.error)
      else startPlacing(added.partId)
    } finally {
      setBusy(null)
    }
  }
  const clearError = useCallback(() => setError(null), [])
  return { busy, error, place, clearError }
}

// ---------- checking a placed part ----------

/** Checks that may wait behind the one running; past this many, a newly placed part goes unchecked. */
export const CHECK_BACKLOG = 5

/**
 * Runs background checks one at a time: each spends the supplier lookups of the account, so a
 * burst of placements must not become a burst of lookups. At most one is in flight, and past
 * `backlog` waiting a job is dropped (`push` answers false): that part is simply not checked.
 */
export function createCheckQueue(backlog = CHECK_BACKLOG) {
  const waiting: (() => Promise<unknown>)[] = []
  let running = false
  const drain = async () => {
    if (running) return
    running = true
    for (let job = waiting.shift(); job; job = waiting.shift()) {
      try {
        await job()
      } catch {
        // A check that fails says nothing; the next one goes on.
      }
    }
    running = false
  }
  return {
    push(job: () => Promise<unknown>): boolean {
      if (waiting.length >= backlog) return false
      waiting.push(job)
      void drain()
      return true
    },
  }
}

/** The panel's one queue. */
export const panelChecks = createCheckQueue()

/**
 * Whether a placed part is worth a lookup: it has no verdict yet, and its name is a number a
 * supplier could sell. A KiCad wildcard (`STM32F103C8Tx`) is never a supplier's number, so asking
 * for it finds nothing and still costs.
 */
export const worthChecking = (spec: CustomPartSpec) => !spec.source?.check && !wildcardOf(spec.props.mpn || spec.name)
