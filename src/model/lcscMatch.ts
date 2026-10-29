import type { PartIndexPart, SupplierLand, SupplierModel3D, SupplierPart } from "@cherryblossom/api-contract"
import type { PartsIndexSource, SupplierPartsSource } from "../ai/supplierParts"
import { registerProjectFootprints } from "./footprints"
import { modelAssignment, setModel } from "./models3d"
import { supplierModelOnLand } from "./supplier/model"
import type { ComponentInstance, FootprintDef, Project } from "./types"

// Real parts for the parts of a board that came from KiCad. A part that carries an LCSC number (the field KiCad boards use for the
// JLCPCB assembly service: "LCSC", "LCSC Part", "JLCPCB Part #" and the like) is looked up in the parts database and the supplier's
// records, and what they know is attached to the part: its manufacturer, part number and datasheet where the file has none, its
// package, and the supplier's 3D model placed on the pads the file's footprint has.
//
// One rule holds throughout: the file's footprint is never changed. The traces were routed to its pads, so its pads, drawings and
// place stay exactly as the file has them. The record's land is only compared with them: if it has the same pads (the same count and
// numbers, each place within 0.01 mm) the land is that package, and says so (`FootprintDef.package`, which the 3D view reads the body
// from); if it has them in another place or turned a quarter, the 3D model is moved onto the file's pads; if it is another land, only
// the part's data is attached and the report says that the land differs. The symbol is never replaced: the wires meet its pins.
//
// The lookup is the host's (a network call), so it is this module's argument, never something the importer does itself.

/** The names KiCad boards give the field an LCSC number is in, as `normalizedName` reads them. */
const LCSC_FIELDS = new Set(["lcsc", "lcscpart", "lcscpartnumber", "lcscpartno", "lcscnumber", "lcscno", "lcsccode", "jlcpcb", "jlcpcbpart", "jlcpcbpartnumber", "jlcpcbpartno", "jlcpart", "jlcpartnumber", "jlc", "jlcnumber", "supplierpartnumber", "suppliernumber", "supplierpart", "lcscid"])

const normalizedName = (key: string) => key.toLowerCase().replace(/[^a-z0-9]/g, "")

/** The LCSC number a part carries (`C25804`), or null. Only a value that is one counts: "Supplier Part Number" is also where other suppliers' numbers are. */
export function lcscNumberOf(c: Pick<ComponentInstance, "props">): string | null {
  for (const [key, value] of Object.entries(c.props)) {
    if (!LCSC_FIELDS.has(normalizedName(key))) continue
    const m = /^\s*(C\d{2,})\s*$/i.exec(value)
    if (m) return m[1].toUpperCase()
  }
  return null
}

/** What a part's records say, from either source: the parts database's stored record or the supplier's own. */
export interface LcscRecord {
  lcsc: string
  mpn: string
  manufacturer: string | null
  package: string | null
  description: string | null
  datasheet: string | null
  land: SupplierLand | null
  model3d: SupplierModel3D | null
  attribution: string
}

/** Looks a number up; null when nothing has it, an Error when the lookup itself failed (its message is a sentence for the user). */
export type LcscLookup = (lcsc: string, signal?: AbortSignal) => Promise<LcscRecord | null>

export function recordOfSupplierPart(p: SupplierPart): LcscRecord {
  return { lcsc: p.lcsc, mpn: p.mpn, manufacturer: p.manufacturer, package: p.package, description: p.description, datasheet: p.datasheet, land: p.land, model3d: p.model3d ?? null, attribution: p.provenance.attribution }
}

function recordOfIndexPart(p: PartIndexPart, lcsc: string): LcscRecord {
  return { lcsc, mpn: p.mpn, manufacturer: p.manufacturer, package: p.package, description: p.description, datasheet: p.datasheet, land: p.land, model3d: p.model3d?.source === "easyeda" ? p.model3d.model : null, attribution: p.provenance.attribution }
}

/**
 * The lookup a host's parts source gives: the parts database first (it stores supplier records, answers at once and costs none of the account's supplier lookups), then the
 * supplier's own record. Failures throw the source's own sentence.
 */
export function lookupFromSource(source: Pick<SupplierPartsSource, "part"> & { index?: Pick<PartsIndexSource, "search" | "part"> }): LcscLookup {
  return async (lcsc, signal) => {
    if (source.index) {
      try {
        const found = await source.index.search(lcsc, { limit: 5, full: true }, signal)
        const hit = found.hits.find((h) => h.source === "easyeda" && h.hasRecord && (h.lcsc ?? h.sourceKey).toUpperCase() === lcsc)
        const stored = hit ? await source.index.part(hit.id, signal) : null
        if (stored?.land.pads.length) return recordOfIndexPart(stored, lcsc)
      } catch {
        // The database is a shortcut: when it does not answer, the supplier's record does.
      }
    }
    const part = await source.part(lcsc, signal)
    return part ? recordOfSupplierPart(part) : null
  }
}

export interface LcscEntry {
  code: "lcsc-matched" | "lcsc-no-match" | "lcsc-lookup-failed" | "lcsc-land-differs" | "lcsc-not-looked-up"
  object: string
  why: string
  count: number
}

export interface LcscStats {
  /** Parts that carry an LCSC number, and how many different numbers that is. */
  withNumber: number
  numbers: number
  /** Parts a record was found for, and parts it was not (nothing at the supplier), and parts whose lookup failed. */
  matched: number
  noMatch: number
  failed: number
  /** What was attached: parts that got data they lacked, lands that are the record's package, parts that got the supplier's 3D model. */
  metadata: number
  packages: number
  models: number
  /** Parts whose land is not the record's, so the 3D model and package were left alone. */
  landDiffers: number
}

export interface LcscOutcome {
  project: Project
  entries: LcscEntry[]
  stats: LcscStats
}

/** How many different numbers one board may look up: a big board has a few hundred, and each is a request. The rest are reported, not looked up. */
export const MAX_LOOKUPS = 150

/** Whether two lands have the same pads: the same count, each of the file's pads with a record pad of its number within 0.01 mm. */
export function sameLand(pads: FootprintDef["pads"], land: SupplierLand): boolean {
  if (!pads.length || pads.length !== land.pads.length) return false
  const used = new Set<number>()
  for (const p of pads) {
    const i = land.pads.findIndex((q, k) => !used.has(k) && (q.number || "") === (p.pin ?? "") && Math.abs(q.x - p.x) <= 0.01 && Math.abs(q.y - p.y) <= 0.01)
    if (i < 0) return false
    used.add(i)
  }
  return true
}

const refs = (list: string[]) => `${list.slice(0, 6).join(", ")}${list.length > 6 ? `, and ${list.length - 6} more` : ""}`

/** Looks every LCSC number of the project up (a few at a time) and attaches what is found. Never throws: a lookup that fails is a line of the report. */
export async function matchLcsc(project: Project, lookup: LcscLookup, options: { signal?: AbortSignal; concurrency?: number; onProgress?: (done: number, total: number) => void } = {}): Promise<LcscOutcome> {
  const numbers = [...new Set(project.components.map((c) => lcscNumberOf(c)).filter((n): n is string => !!n))]
  const records = new Map<string, LcscRecord | null | Error>()
  const wanted = numbers.slice(0, MAX_LOOKUPS)
  let done = 0
  let next = 0
  const worker = async () => {
    while (next < wanted.length && !options.signal?.aborted) {
      const number = wanted[next++]
      try {
        records.set(number, await lookup(number, options.signal))
      } catch (e) {
        records.set(number, e instanceof Error ? e : new Error(String(e)))
      }
      options.onProgress?.(++done, wanted.length)
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(options.concurrency ?? 4, wanted.length)) }, worker))
  return applyRecords(project, records, numbers.length - wanted.length)
}

/** What the records say, attached to the project (pure: the lookups are done). A number with no record in the map was not looked up. */
export function applyRecords(project: Project, records: ReadonlyMap<string, LcscRecord | null | Error>, skipped = 0): LcscOutcome {
  registerProjectFootprints(project)
  const stats: LcscStats = { withNumber: 0, numbers: 0, matched: 0, noMatch: 0, failed: 0, metadata: 0, packages: 0, models: 0, landDiffers: 0 }
  const noMatch = new Map<string, string[]>()
  const failed = new Map<string, string[]>()
  const differs: string[] = []
  const notLooked: string[] = []
  const matchedRefs: string[] = []
  const seen = new Set<string>()
  const packaged = new Map<string, string>()
  let next = project

  const components = project.components.map((c) => {
    const number = lcscNumberOf(c)
    if (!number) return c
    stats.withNumber++
    if (!seen.has(number)) {
      seen.add(number)
      stats.numbers++
    }
    const record = records.get(number)
    if (record === undefined) {
      notLooked.push(c.ref)
      return c
    }
    if (record instanceof Error) {
      stats.failed++
      failed.set(record.message, [...(failed.get(record.message) ?? []), c.ref])
      return c
    }
    if (!record) {
      stats.noMatch++
      noMatch.set(number, [...(noMatch.get(number) ?? []), c.ref])
      return c
    }
    stats.matched++
    matchedRefs.push(c.ref)

    // The part's data, where the file has none of its own (the file's own fields are never overwritten).
    const has = (...keys: string[]) => Object.entries(c.props).some(([k, v]) => keys.includes(normalizedName(k)) && v.trim() !== "")
    const props = { ...c.props }
    let added = false
    const give = (key: string, value: string | null | undefined, ...names: string[]) => {
      if (value && value.trim() && !has(...names)) {
        props[key] = value.trim()
        added = true
      }
    }
    give("lcsc", number, "lcsc")
    give("mpn", record.mpn, "mpn", "manufacturerpartnumber", "mfrpartnumber", "partnumber")
    give("manufacturer", record.manufacturer, "manufacturer", "mfr", "mfg")
    give("datasheet", record.datasheet, "datasheet")
    if (added) stats.metadata++

    // Its land: the same pads are the record's package; the same pads moved or turned carry the model onto them; any other land is left alone.
    const def = project.footprints?.find((f) => f.name === c.footprint) ?? null
    const land = record.land
    if (def && land) {
      if (sameLand(def.pads, land)) {
        if (record.package && !def.package && !packaged.has(def.name)) {
          packaged.set(def.name, record.package)
          stats.packages++
        }
      }
      if (record.model3d && !modelAssignment(next, c.partId, c.footprint)) {
        const model = supplierModelOnLand(record.model3d, land, record.attribution, c.footprint)
        if (model) {
          next = setModel(next, c.partId, c.footprint, model)
          stats.models++
        } else {
          stats.landDiffers++
          differs.push(c.ref)
        }
      }
    }
    return added ? { ...c, props } : c
  })

  const footprints = project.footprints?.map((f) => (packaged.has(f.name) ? { ...f, package: packaged.get(f.name)!.slice(0, 120) } : f))
  next = { ...next, components, ...(footprints ? { footprints } : {}) }
  if (packaged.size) registerProjectFootprints(next)

  const entries: LcscEntry[] = []
  if (matchedRefs.length) {
    const bits = [stats.metadata ? `data the file lacked on ${stats.metadata}` : "", stats.packages ? `the package of ${stats.packages} land${stats.packages > 1 ? "s" : ""}` : "", stats.models ? `${stats.models} 3D model${stats.models > 1 ? "s" : ""}` : ""].filter(Boolean)
    entries.push({ code: "lcsc-matched", object: `${matchedRefs.length} part${matchedRefs.length > 1 ? "s" : ""} with an LCSC number (${refs(matchedRefs)})`, why: `Found in the parts database or at the supplier${bits.length ? `, and attached: ${bits.join(", ")}` : ""}. The footprints, their pads and the symbols are exactly as the file has them.`, count: matchedRefs.length })
  }
  for (const [number, list] of noMatch) entries.push({ code: "lcsc-no-match", object: `no LCSC match for ${number} (${refs(list)})`, why: "Neither the parts database nor the supplier has a part of this number, so the part stays as the file has it.", count: list.length })
  for (const [message, list] of failed) entries.push({ code: "lcsc-lookup-failed", object: `LCSC lookup failed for ${refs(list)}`, why: `${message} The parts stay as the file has them.`, count: list.length })
  if (differs.length) entries.push({ code: "lcsc-land-differs", object: `${differs.length} part${differs.length > 1 ? "s" : ""} (${refs(differs)})`, why: "The footprint in the file is not the land of the LCSC record (other pads, or numbered another way), so the 3D model was not attached: it would not sit on these pads. The footprint is kept as the file has it, because the traces are routed to its pads.", count: differs.length })
  const left = notLooked.length + skipped
  if (left) entries.push({ code: "lcsc-not-looked-up", object: `${left} part${left > 1 ? "s" : ""} with an LCSC number`, why: skipped ? `A board looks up at most ${MAX_LOOKUPS} different numbers; the rest were not looked up.` : "They were not looked up.", count: left })
  return { project: next, entries, stats }
}

