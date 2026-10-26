import type { PartIndexHit, PartIndexPart, SupplierPart } from "@cherryblossom/api-contract"
import { packageFamily } from "../model/supplier/build"
import { partNumberKey, relateName } from "../model/supplier/partNumber"
import { comparePins, type DrawnPin } from "../model/supplier/pinmap"
import { footprintFamily, supplierFamily } from "../model/supplier/verify"
import { lookupFailure, type PartsIndexSource } from "./supplierParts"

// The parts database in the copilot's lookups: parts our own database stores whole (KiCad's
// libraries, and the supplier records the server kept as people looked them up). It costs none
// of the account's supplier lookups and answers when the supplier is down or busy, so a part it
// has is built from data where it would otherwise be written from memory.
//
// What a stored part is trusted to be, by how its name relates to the one asked for:
//
// - `exact`: the same part number. It is the part.
// - `family` by KiCad's wildcard (`STM32F103C8Tx` for `STM32F103C8T6`): the symbol and footprint
//   are drawn for every number the x's stand for, so it is the part too.
// - `prefix` on a stored LCSC record (`TPS61023DRLR` for `TPS61023`): an orderable number of the
//   name, the part when its drawings agree and nothing nearer is stored.
// - `family` by ordering letters (`NE555P` for `NE555PW`, `ATmega328P-A` for `ATmega328P-AU`):
//   the letters often name the package (P is DIP, PW is TSSOP), so it is the part only when
//   nothing nearer is stored and the footprint the drawing names is the same package. Otherwise it
//   is offered, never built.
//
// Several stored parts that are different parts (packages, sizes, pin maps) are a choice, listed
// with their ids, as the supplier's are; KiCad's drawing and a supplier record of one part are one.

/** A family match by KiCad's wildcard: the stored name ends in one or two x's the asked name fills in. */
export function isWildcardOf(name: string, storedMpn: string): boolean {
  const m = storedMpn.trim().match(/^(.*[A-Z0-9])(x{1,2})$/)
  if (!m) return false
  const stem = partNumberKey(m[1])
  const key = partNumberKey(name)
  return key.length === stem.length + m[2].length && key.startsWith(stem)
}

/** What a stored part's package is, in `packageFamily`'s terms; null when its name doesn't say. */
export function storedFamily(hit: Pick<PartIndexHit, "package">): string | null {
  const f = packageFamily(hit.package)
  return f === "land" ? null : f === "sot23" ? "sot23_3" : f
}

/** One stored part as a line for the copilot: its id to build from, what it is and where it came from. */
export function storedLine(hit: PartIndexHit): string {
  const from = hit.source === "kicad" ? `KiCad library ${hit.sourceKey}` : `stored LCSC record ${hit.lcsc ?? hit.sourceKey}${hit.verification === "consensus" ? ", drawings agree" : ""}`
  const pins = hit.pinCount !== null ? `, ${hit.pinCount} pins` : ""
  return `database_id ${hit.id}: ${hit.mpn}${hit.manufacturer ? ` (${hit.manufacturer})` : ""}, ${hit.package ?? "package unknown"}${pins}, ${from} [${hit.match}]`
}

/** The order to prefer stored parts in: a record the supplier's drawings agree on, KiCad's, then the rest. */
const rank = (h: PartIndexHit) => (h.verification === "curated" || h.verification === "consensus" ? 0 : h.source === "kicad" ? 1 : 2)

export type StoredResolution =
  /**
   * One stored part is the name: build it. `note` says which and why, for the result; `wildcard` is
   * set when it is a KiCad symbol drawn for a family of numbers, so the part takes the asked name as
   * its part number (`STM32F103C8Tx` can't be ordered, `STM32F103C8T6` can).
   */
  | { kind: "found"; part: PartIndexPart; hit: PartIndexHit; note: string; wildcard: boolean }
  /** Stored parts that could be the name but aren't settled: other packages, or ordering letters unconfirmed. */
  | { kind: "offered"; text: string; hits: PartIndexHit[] }
  /** The drawing's pins contradict the stored part the name is. */
  | { kind: "contradicted"; text: string; hit: PartIndexHit }
  | { kind: "none" }
  | { kind: "failed"; text: string }

/** Stored parts read whole to tell them apart; more than this many candidates is a list, not a pick. */
const READ_AT_MOST = 4

/** A package's body, length and width sorted, from a KiCad name (`3.9x4.9mm`) or a supplier's (`L4.9-W3.9`). */
function bodySize(pkg: string | null): [number, number] | null {
  const s = String(pkg ?? "")
  const m = s.match(/(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)mm/) ?? s.match(/L(\d+(?:\.\d+)?)-W(\d+(?:\.\d+)?)/)
  if (!m) return null
  const [a, b] = [Number(m[1]), Number(m[2])].sort((x, y) => x - y)
  return [a, b]
}

/**
 * Whether two stored parts are one part: the same package family, bodies of the same size where
 * both names say (a QFN-16 is 3 by 3 or 4 by 4 mm), and the same pin count with no pin of one
 * contradicting the other. KiCad's drawing and a supplier record of one part pass; two packages of
 * a name don't.
 */
function samePart(a: PartIndexPart, b: PartIndexPart): boolean {
  if (storedFamily(a) !== storedFamily(b) || a.pins.length !== b.pins.length) return false
  const sa = bodySize(a.package)
  const sb = bodySize(b.package)
  if (sa && sb && (Math.abs(sa[0] - sb[0]) > 0.3 || Math.abs(sa[1] - sb[1]) > 0.3)) return false
  return comparePins(a.pins.map((p) => ({ number: p.number, name: p.name })), b.pins).verdict !== "contradicted"
}

/**
 * The stored part a name is, if one is, in this order:
 *
 * 1. **The name itself**: the same number, or a KiCad wildcard that covers it.
 * 2. **An orderable number of it the supplier gave**: a stored LCSC record that goes on from the
 *    name with an ordering suffix (`TPS61023DRLR` for `TPS61023`; `INA2191` is another part), and
 *    only one whose drawings agree, since nothing else will look at it.
 * 3. **The name less its ordering letters** (`NE555P` for `NE555PW`): only when the drawing's
 *    footprint names the same package, and offered otherwise.
 *
 * The drawing's footprint narrows a choice and never overrides the name: an exact part in another
 * package is still the part, and the note says its package. Candidates that are different parts
 * (other packages, sizes or pin maps) are a list to choose from, never a pick.
 */
export async function resolveStored(
  index: PartsIndexSource,
  name: string,
  hints: { pins?: DrawnPin[]; footprint?: string },
  signal?: AbortSignal,
): Promise<StoredResolution> {
  let hits: PartIndexHit[]
  try {
    hits = (await index.search(name, { limit: 20, full: true }, signal)).hits
  } catch (e) {
    return { kind: "failed", text: lookupFailure(e) }
  }
  const drawn = hints.footprint ? footprintFamily(hints.footprint) : null
  const named = hits.filter((h) => h.hasRecord && (h.match === "exact" || (h.match === "family" && isWildcardOf(name, h.mpn))))
  const ordered = hits.filter(
    (h) =>
      h.hasRecord &&
      h.source === "easyeda" &&
      h.match === "prefix" &&
      (h.verification === "consensus" || h.verification === "curated") &&
      relateName(name, h.mpn) === "variant",
  )
  const lettered = hits.filter((h) => h.hasRecord && h.match === "family" && !isWildcardOf(name, h.mpn))
  const inDrawn = (h: PartIndexHit) => !!drawn && drawn !== "land" && storedFamily(h) === drawn

  let set = named.length ? named : ordered.length ? ordered : lettered.filter(inDrawn)
  if (!set.length) {
    if (!lettered.length) return { kind: "none" }
    return {
      kind: "offered",
      hits: lettered,
      text: `The parts database has ${lettered.length === 1 ? "a part" : "parts"} whose number ${name} starts with, which may be ${lettered.length === 1 ? "another package" : "other packages"} of it:\n${lettered.slice(0, 4).map(storedLine).join("\n")}\nBuild one with create_part database_id only if its package is the one the user means.`,
    }
  }
  if (set.some(inDrawn)) set = set.filter(inDrawn)
  set = [...set].sort((a, b) => rank(a) - rank(b) || (b.stock ?? -1) - (a.stock ?? -1)).slice(0, READ_AT_MOST)

  let parts: (PartIndexPart | null)[]
  try {
    parts = await Promise.all(set.map((h) => index.part(h.id, signal)))
  } catch (e) {
    return { kind: "failed", text: lookupFailure(e) }
  }
  const read = set.map((hit, i) => ({ hit, part: parts[i] })).filter((x): x is { hit: PartIndexHit; part: PartIndexPart } => !!x.part)
  if (!read.length) return { kind: "none" }
  const groups: (typeof read)[] = []
  for (const x of read) {
    const group = groups.find((g) => samePart(g[0].part, x.part))
    if (group) group.push(x)
    else groups.push([x])
  }
  if (groups.length > 1) {
    return {
      kind: "offered",
      hits: groups.map((g) => g[0].hit),
      text: `${name} is stored as ${groups.length} different parts (packages, sizes or pin maps):\n${groups.map((g) => storedLine(g[0].hit)).join("\n")}\nBuild the one the user means with create_part database_id.`,
    }
  }
  const { hit, part } = groups[0][0]
  if (hints.pins?.length) {
    const cmp = comparePins(hints.pins, part.pins)
    if (cmp.verdict === "contradicted") {
      const fatal = cmp.fatal.slice(0, 6).map((f) => f.text).join("; ")
      return { kind: "contradicted", hit, text: `${cmp.fatal.length} pin${cmp.fatal.length === 1 ? "" : "s"} contradict ${storedName(part)}: ${fatal}.` }
    }
  }
  const wildcard = hit.match === "family" && isWildcardOf(name, hit.mpn)
  const how = hit.match === "exact" ? "" : wildcard ? `, whose symbol covers ${name}` : hit.match === "prefix" ? `, an orderable number of ${name}` : `, the same package as the one named`
  const other = drawn && drawn !== "land" && !inDrawn(hit) && storedFamily(hit) ? ` It is ${part.package}, not the ${hints.footprint} named: the stored part's land is used.` : ""
  return { kind: "found", part, hit, wildcard, note: `Built from ${storedName(part)}${how}.${other}` }
}

/** A stored part's name and source in a phrase: "KiCad's Regulator_Linear:AMS1117-3.3". */
export const storedName = (part: Pick<PartIndexPart, "source" | "sourceKey" | "mpn" | "lcsc">) =>
  part.source === "kicad" ? `the KiCad library part ${part.sourceKey}` : `the stored LCSC record ${part.lcsc ?? part.sourceKey} (${part.mpn})`

/**
 * KiCad's drawing of a part beside the supplier's: a second opinion on the pins. Null when they
 * agree, or can't be compared (another package, no named pins); else one sentence for the result.
 */
export function secondOpinion(kicad: PartIndexPart, supplier: SupplierPart): string | null {
  if (!supplier.pins?.length || kicad.source !== "kicad") return null
  const ours = storedFamily({ package: kicad.package })
  const theirs = supplierFamily(supplier.package)
  if (!ours || theirs === "land" || ours !== theirs) return null
  const cmp = comparePins(
    kicad.pins.map((p) => ({ number: p.number, name: p.name })),
    supplier.pins,
  )
  if (cmp.verdict !== "contradicted") return null
  return `KiCad's library draws ${kicad.mpn} differently from LCSC ${supplier.lcsc}: ${cmp.fatal
    .slice(0, 3)
    .map((f) => f.text)
    .join("; ")}. The supplier's pins were used; tell the user to check those pins against the datasheet.`
}
