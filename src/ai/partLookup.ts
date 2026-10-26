import type { PartCandidate, SupplierPart, SupplierPin } from "@cherryblossom/api-contract"
import { isValidFootprint } from "../model/footprints"
import { comparePins, type DrawnPin } from "../model/supplier/pinmap"
import { canonicalPin, couldBe, isPlaceholderName, isRail, pinRole } from "../model/supplier/roles"
import { partNumberKey } from "../model/supplier/partNumber"
import { candidateLine, checkAgainstSupplier, footprintFamily, supplierFamily } from "../model/supplier/verify"
import { lookupFailure, type SupplierPartsSource } from "./supplierParts"

// Finding the supplier record a part name means, without guessing.
//
// A name is rarely a number a supplier sells under: TPS61023 is sold as TPS61023DRLR, ADS1115 as
// ADS1115IDGSR, SHT31-DIS as SHT31-DIS-F2.5kS. The tail is an ordering suffix (package, grade,
// reel), so a longer number that goes on from the name is a VARIANT of it, and what makes variants
// one part is what a drawing can check: the same package and the same function on every pin number,
// by pin number (SDA and SCL swapped is another part, not a spelling). So:
//
// - The records that are the name itself (exact), or when none has a named pinout the variants,
//   are grouped by package and pinout. One group is one resolvable part: the best stocked of its
//   members is chosen, and the answer says which LCSC number and part number that was.
// - More than one group is a real choice (ADS1115 in VSSOP-10 and X2QFN-10; INA219 in SOT-23-8
//   and SOIC-8; WS2812B in 3535 and 5050): a short list with what differs, never a pick. What the
//   drawing already says narrows it first: its footprint's family and size, its pin count, and the
//   records its pins don't contradict. Best stocked first; when stock is unknown for all of them,
//   the most common package first, and the text says the stock is unknown.
// - A longer number that is another part in the same package (WS2812B-2020 for WS2812B) has other
//   pin roles or another size, so it never joins the name's group.
// - A drawing's pins are compared with the candidates whenever there are candidates. Pins that
//   contradict every one of them are a wrong part, whatever the name is called, and are said so.
//   The drawing is only left unchecked when no supplier part has its pin count (the number is
//   another part's) or the supplier has nothing at all. That includes a name whose own records
//   name no pins: its pinned ordering variants in the same package still check the drawing, but
//   never stand in for the name (they build nothing, they only refuse a wrong pin map).
//
// A record the supplier couldn't be read for is unknown, not empty: a name whose only candidates
// are unknown is a failed lookup ("couldn't check"), never "none with a pinout".

export type Resolution =
  | {
      kind: "found"
      part: SupplierPart
      candidate: PartCandidate
      /** The supplier part numbers that share its package and pins; the best stocked was chosen. */
      family: PartCandidate[]
      /** A sentence saying which of them was chosen and why; null when the name is its number. */
      chosen: string | null
    }
  /** Several packages or pinouts: the sentence lists them with their LCSC numbers and what differs. */
  | { kind: "ambiguous"; text: string; candidates: PartCandidate[] }
  /** The drawing's pins contradict every supplier part the name could mean: a wrong part. */
  | { kind: "contradicted"; text: string; briefs: string[]; part: SupplierPart; candidate: PartCandidate; candidates: PartCandidate[] }
  /** Longer part numbers exist, but none has the drawing's pin count: other parts, listed. */
  | { kind: "different"; text: string; /** One line for a note stored with a part. */ note: string; candidates: PartCandidate[] }
  /** No supplier part, or none with a named pinout. */
  | { kind: "none"; text: string }
  | { kind: "failed"; text: string }

/** A record worth building from: a named pinout, or a two-pin part's land (its pins are just ends). */
export const usable = (c: PartCandidate) => c.hasVendorPinout === true || (c.hasVendorLand === true && (c.pinCount ?? 0) > 0 && (c.pinCount ?? 0) <= 2)

const failure = lookupFailure

// ---------- packages ----------

/** Body length, width and pitch from a supplier's package string: `SOT-563_L1.6-W1.2-P0.50-LS1.6-BR`. */
function packageDims(pkg: string | null): { size: [number, number]; pitch: number | null } | null {
  const m = String(pkg ?? "").match(/L(\d+(?:\.\d+)?)-W(\d+(?:\.\d+)?)/)
  if (!m) return null
  const pitch = String(pkg).match(/-P(\d+(?:\.\d+)?)/)
  return { size: [Number(m[1]), Number(m[2])], pitch: pitch ? Number(pitch[1]) : null }
}

/** The package name a person reads: the supplier's string up to its first underscore. */
const packageName = (pkg: string | null) => (pkg ?? "package unknown").split("_")[0]

/** How far apart two drawings of one package may be in size: 0.15 mm across names, 0.35 mm within a name (SOT-223 is drawn 6.5 and 6.7 mm long). */
const SIZE_TOLERANCE_MM = 0.15
const SAME_NAME_TOLERANCE_MM = 0.35

/**
 * One package. Suppliers name the same one many ways (SOT-23-5, SOT-25-5, "SENSOR-SMD_8P"), so
 * when both strings carry a size the size and pitch decide, and a name only when they don't.
 */
function samePackage(a: PartCandidate, b: PartCandidate): boolean {
  if (a.pinCount !== b.pinCount) return false
  const da = packageDims(a.package)
  const db = packageDims(b.package)
  if (da && db) {
    const tolerance = supplierFamily(a.package) === supplierFamily(b.package) ? SAME_NAME_TOLERANCE_MM : SIZE_TOLERANCE_MM
    const near = (x: number, y: number) => Math.abs(x - y) <= tolerance
    const sizes = (near(da.size[0], db.size[0]) && near(da.size[1], db.size[1])) || (near(da.size[0], db.size[1]) && near(da.size[1], db.size[0]))
    const pitches = da.pitch === null || db.pitch === null || Math.abs(da.pitch - db.pitch) < 0.06
    return sizes && pitches
  }
  return supplierFamily(a.package) === supplierFamily(b.package)
}

/** Leads a package's name promises (`SOIC-8`), when it says. A symbol with fewer pins is an unfinished drawing. */
function leadsNamed(pkg: string | null): number | null {
  const family = supplierFamily(pkg)
  const m = family.match(/^(?:soic|ssop|tssop|vssop|qfn|dfn|lqfp)(\d+)$/) ?? family.match(/^sot23_(\d)$/)
  return m ? Number(m[1]) : null
}

/** A size such as 5050 or w3_h3 in a footprint name, in mm, to pick among sizes of one family. */
function footprintSize(footprint: string): [number, number] | null {
  const fp = footprint.toLowerCase()
  const wh = fp.match(/_w(\d+(?:\.\d+)?)_h(\d+(?:\.\d+)?)/)
  if (wh) return [Number(wh[1]), Number(wh[2])]
  // 5050 and 3535 for LEDs and 2016 for crystals; chip sizes (0402) are the family's business.
  const four = fp.match(/(?:^|[^0-9.])([1-9]\d)([1-9]\d)(?![0-9.])/)
  return four ? [Number(four[1]) / 10, Number(four[2]) / 10] : null
}

const sizeMatches = (hint: [number, number], pkg: string | null) => {
  const dims = packageDims(pkg)
  if (!dims) return false
  const near = (x: number, y: number) => Math.abs(x - y) <= 0.25
  return (near(hint[0], dims.size[0]) && near(hint[1], dims.size[1])) || (near(hint[0], dims.size[1]) && near(hint[1], dims.size[0]))
}

// ---------- ranking and grouping ----------

const stockOf = (c: PartCandidate) => c.stock ?? -1

/** Best first: reviewed records before a user's upload, then the best stocked, then one with a land. */
const better = (a: PartCandidate, b: PartCandidate) =>
  Number(!!a.userUpload) - Number(!!b.userUpload) ||
  stockOf(b) - stockOf(a) ||
  Number(b.hasVendorLand === true) - Number(a.hasVendorLand === true) ||
  a.lcsc.localeCompare(b.lcsc, "en", { numeric: true })

interface Pinned {
  candidate: PartCandidate
  pins: SupplierPin[] | null
}

/** Two names, at least one a rail, that are one pin: agreeing roles, or one read generously as the other's role. */
const sameRail = (a: string, b: string) => {
  const ra = pinRole(a)
  const rb = pinRole(b)
  if (isRail(ra) && isRail(rb)) return ra === rb || couldBe(ra, b) || couldBe(rb, a)
  return (isRail(ra) && couldBe(ra, b)) || (isRail(rb) && couldBe(rb, a))
}

const spellings = (p: SupplierPin) => [p.name, ...p.aliases].map(canonicalPin)

/**
 * The pins on which two records of one package put something else, by pin number. What counts:
 * - a pin number one has and the other doesn't;
 * - a rail that is another rail or not a rail (VIN and VOUT, GND and a signal), however spelled:
 *   `VDD` and `VCC` agree, so do `VEE/GND` and `VEE`, and a regulator's tab drawn as `TAB` in one
 *   record and as the output it is wired to in another;
 * - a signal that is one record's name for another pin: SDA and SCL swapped, an enable moved.
 * What doesn't: a signal two records spell differently without either name being another pin's
 * (`OD` and `DOUT`, `TEMP` and `TS`, `BAT` and `VBAT`): that is one pin with two names, and a drawing
 * can't tell them apart either.
 */
function pinDifferences(a: Pinned, b: Pinned): string[] {
  if (!a.pins || !b.pins) return a.pins || b.pins ? ["one has a named pinout and the other has none"] : []
  const out: string[] = []
  const bn = new Map(b.pins.map((p) => [p.number, p]))
  const an = new Map(a.pins.map((p) => [p.number, p]))
  // The names each record puts on exactly one pin, to see whether a name moved to another pin
  // (a name on several pins, like GND or NC, can't have moved).
  const place = (pins: SupplierPin[]) => {
    const at = new Map<string, Set<string>>()
    for (const p of pins) if (!isPlaceholderName(p.name, p.number)) for (const k of spellings(p)) at.set(k, (at.get(k) ?? new Set()).add(p.number))
    return new Map([...at].filter(([, numbers]) => numbers.size === 1).map(([k, numbers]) => [k, [...numbers][0]]))
  }
  const placeA = place(a.pins)
  const placeB = place(b.pins)
  const movedTo = (at: Map<string, string>, p: SupplierPin) => spellings(p).some((k) => at.has(k) && at.get(k) !== p.number)
  const differ = (p: SupplierPin, q: SupplierPin) => out.push(`pin ${p.number} is ${q.name} on ${b.candidate.lcsc} but ${p.name} on ${a.candidate.lcsc}`)
  for (const p of a.pins) {
    const q = bn.get(p.number)
    if (!q) {
      out.push(`pin ${p.number} (${p.name}) exists on ${a.candidate.lcsc} only`)
      continue
    }
    if (isPlaceholderName(p.name, p.number) || isPlaceholderName(q.name, q.number)) continue
    if (spellings(p).some((k) => spellings(q).includes(k))) continue
    const ra = pinRole(p.name)
    const rb = pinRole(q.name)
    // A tab or pad is whatever the other record wires it to (a regulator's TAB is its output); two
    // unconnected pins are one.
    if (ra === "exposed_pad" || rb === "exposed_pad" || (ra === "nc" && rb === "nc")) continue
    if (isRail(ra) || isRail(rb)) {
      if (!sameRail(p.name, q.name)) differ(p, q)
    } else if (movedTo(placeB, p) || movedTo(placeA, q)) {
      differ(p, q)
    }
  }
  for (const q of b.pins) if (!an.has(q.number)) out.push(`pin ${q.number} (${q.name}) exists on ${b.candidate.lcsc} only`)
  return out
}

/** The same name or role on every pin number, so the drawn symbol is one for both. */
const samePinout = (a: Pinned, b: Pinned): boolean => pinDifferences(a, b).length === 0

/** Candidates that are one part: the same package and the same pins, best first. */
function group(items: Pinned[]): Pinned[][] {
  const groups: Pinned[][] = []
  for (const item of [...items].sort((a, b) => better(a.candidate, b.candidate))) {
    const home = groups.find((g) => samePackage(g[0].candidate, item.candidate) && samePinout(g[0], item))
    if (home) home.push(item)
    else groups.push([item])
  }
  return groups
}

/** What tells two groups apart, in words. */
function difference(a: Pinned, b: Pinned): string {
  const pa = packageName(a.candidate.package)
  const pb = packageName(b.candidate.package)
  if (a.candidate.pinCount !== b.candidate.pinCount) return `${pa} has ${a.candidate.pinCount ?? "?"} pins, ${pb} has ${b.candidate.pinCount ?? "?"}`
  if (!samePackage(a.candidate, b.candidate)) return pa === pb ? `${pa} in another size (${a.candidate.lcsc} vs ${b.candidate.lcsc})` : `${pa} vs ${pb}`
  const pins = pinDifferences(a, b)
  if (pins.length) return `pin names or roles (${pins.slice(0, 3).join("; ")}${pins.length > 3 ? `; and ${pins.length - 3} more` : ""})`
  return "pin names or roles"
}

const stockWords = (c: PartCandidate) => (c.stock === null ? ", stock unknown" : "")

const groupLine = (g: Pinned[]) => {
  const best = g[0].candidate
  return `${candidateLine(best)}${stockWords(best)}${g.length > 1 ? ` (${g.length - 1} more part number${g.length > 2 ? "s" : ""} with the same package and the same function on every pin number)` : ""}`
}

/** No stock is known for any of them: nothing says which is the better stocked. */
const stockUnknown = (list: PartCandidate[]) => list.every((c) => c.stock === null)

/**
 * How common a package is, for ranking choices when no stock is known: a package the library or
 * the footprinter draws (a part Sakura can place on a known land), then the package family most of
 * the candidates come in, then fewer leads. A hint to order a list by, never an answer.
 */
function commonness(groups: Pinned[][]): (g: Pinned[]) => [number, number, number] {
  const familyCount = new Map<string, number>()
  for (const g of groups) {
    const family = supplierFamily(g[0].candidate.package)
    familyCount.set(family, (familyCount.get(family) ?? 0) + g.length)
  }
  return (g) => {
    const c = g[0].candidate
    const family = supplierFamily(c.package)
    return [family !== "land" && isValidFootprint(family) ? 1 : 0, familyCount.get(family) ?? 0, -(c.pinCount ?? 99)]
  }
}

/** Packages in the order a person would expect when stock can't say: the most common first. */
function byCommonness(groups: Pinned[][]): Pinned[][] {
  const score = commonness(groups)
  const sorted = groups.map((g) => ({ g, s: score(g) }))
  sorted.sort((x, y) => y.s[0] - x.s[0] || y.s[1] - x.s[1] || y.s[2] - x.s[2])
  return sorted.map((x) => x.g)
}

/** Whether two package strings could be one body: size and pitch when both say, else the family, else unknown (kept). */
function sameBody(a: PartCandidate, b: PartCandidate): boolean {
  const da = packageDims(a.package)
  const db = packageDims(b.package)
  if (da && db) {
    const tolerance = supplierFamily(a.package) === supplierFamily(b.package) ? SAME_NAME_TOLERANCE_MM : SIZE_TOLERANCE_MM
    const near = (x: number, y: number) => Math.abs(x - y) <= tolerance
    const sizes = (near(da.size[0], db.size[0]) && near(da.size[1], db.size[1])) || (near(da.size[0], db.size[1]) && near(da.size[1], db.size[0]))
    return sizes && (da.pitch === null || db.pitch === null || Math.abs(da.pitch - db.pitch) < 0.06)
  }
  const fa = supplierFamily(a.package)
  const fb = supplierFamily(b.package)
  return fa === "land" || fb === "land" || fa === fb
}

/** Pins per candidate: sent with the search, or read from the part when they weren't. */
const readPins = (source: SupplierPartsSource, set: PartCandidate[], signal?: AbortSignal) =>
  Promise.all(
    set.map(async (candidate): Promise<Pinned> => {
      if (candidate.pins) return { candidate, pins: candidate.pins }
      if (candidate.hasVendorPinout !== true) return { candidate, pins: null }
      return { candidate, pins: (await source.part(candidate.lcsc, signal))?.pins ?? null }
    }),
  )

/**
 * The drawn pins against every pinned candidate: when they contradict all of them it is a wrong
 * part, whichever package was meant. `before` opens the sentence (what the pins were checked
 * against); null when the drawing isn't contradicted by all of them.
 */
async function contradiction(source: SupplierPartsSource, drawn: DrawnPin[], reps: Pinned[], before: string, signal?: AbortSignal): Promise<Resolution | null> {
  if (!reps.length || !reps.every((r) => r.pins && comparePins(drawn, r.pins).verdict === "contradicted")) return null
  const best = reps[0].candidate
  const part = await source.part(best.lcsc, signal)
  if (!part) return null
  const check = checkAgainstSupplier({ pins: drawn, footprint: null }, part)
  if (!check.refusals.length) return null
  const others = reps.length > 1 ? ` The same is true against the other ${reps.length - 1} package${reps.length > 2 ? "s" : ""} numbered like it (${reps.slice(1, 4).map((r) => r.candidate.lcsc).join(", ")}).` : ""
  return { kind: "contradicted", part, candidate: best, candidates: reps.map((r) => r.candidate), briefs: check.briefs, text: `${before}${check.refusals.join(" ")}${others}` }
}

// ---------- the lookup ----------

export async function resolvePartName(
  source: SupplierPartsSource,
  name: string,
  hints: { pins?: DrawnPin[]; footprint?: string },
  signal?: AbortSignal,
): Promise<Resolution> {
  let candidates: PartCandidate[]
  try {
    candidates = (await source.search(name, signal)).candidates
  } catch (e) {
    return { kind: "failed", text: failure(e) }
  }
  const exactAll = candidates.filter((c) => c.match === "exact")
  const variantsAll = candidates.filter((c) => c.match === "prefix")
  const exact = exactAll.filter(usable)
  const variants = variantsAll.filter(usable)
  const reviewed = (list: PartCandidate[]) => list.filter((c) => !c.userUpload)
  // The name itself outranks its variants: they are only the part when it has no drawing of its
  // own, or when the footprint the drawing names is a family only they come in (NE555 is sold in
  // SOIC-8, and as NE555P in DIP-8).
  const inFamily = (list: PartCandidate[]) => (hints.footprint ? list.some((c) => supplierFamily(c.package) === footprintFamily(hints.footprint!)) : true)
  let asExact = exact.length > 0 && (inFamily(exact) || !inFamily(variants))
  // A name with records of its own, none of which names its pins, is not answered by a variant
  // (WS2812B's own records have no pins; WS2812B-2020 has, and is another part).
  let set = asExact ? exact : exactAll.length && !exact.length ? [] : variants
  // What outranks the exact name:
  // - An EasyEDA user upload is the part only when nothing reviewed is: a reviewed, stocked
  //   variant beats an upload that happens to be spelled exactly like the name.
  // - An exact record nobody knows the stock of (not sold, or not looked up) is not better than
  //   the name's stocked variants: they join it, and a package with stock comes first.
  let uploads: PartCandidate[] = []
  if (asExact && !reviewed(exact).length && reviewed(variants).length) {
    asExact = false
    uploads = exact
    set = reviewed(variants)
  } else if (asExact && exact.every((c) => c.stock === null) && variants.some((c) => (c.stock ?? 0) > 0 && !c.userUpload)) {
    asExact = false
    set = [...exact, ...reviewed(variants)]
  }
  // An upload is a lower-confidence fallback: kept only when there is nothing reviewed beside it.
  const inSet = set.filter((c) => c.userUpload)
  if (inSet.length && inSet.length < set.length) {
    uploads = [...uploads, ...inSet]
    set = reviewed(set)
  }

  if (!set.length) {
    // Records that couldn't be read might have been the one: that is a failed lookup, not a part
    // with no pinout.
    const unread = (exactAll.length ? exactAll : variantsAll).filter((c) => c.hasVendorPinout === null).length
    if (unread) {
      return { kind: "failed", text: `Couldn't check ${name}: ${unread} supplier record${unread === 1 ? "" : "s"} couldn't be read. Try again in a moment.` }
    }
    if (exactAll.length && variants.length) {
      // The records numbered exactly like the name name no pins, but its ordering variants in the
      // same package do. They don't stand in for the name (nothing confirms they are it), but
      // they still say what the pins of this package are, so a wrong drawing is refused.
      const blank = await blankExact(source, name, exactAll, variants, hints, signal)
      if (blank) return blank
    }
    if (exactAll.length) {
      return { kind: "none", text: `No supplier record for ${name} names its pins (${exactAll.length} found, none with a pinout).` }
    }
    if (variantsAll.length) {
      return { kind: "none", text: `${variantsAll.length} supplier part number${variantsAll.length === 1 ? " is" : "s are"} listed under ${name} but none names its pins.` }
    }
    return { kind: "none", text: `No supplier record for ${name}.` }
  }

  // A symbol drawn with fewer pins than its package has leads is unfinished: kept only when it is all there is.
  const finished = set.filter((c) => {
    const leads = leadsNamed(c.package)
    return leads === null || (c.pinCount ?? 0) >= leads
  })
  if (finished.length) set = finished

  const drawn = hints.pins?.length ? hints.pins : null
  if (drawn && !asExact) {
    // Variants with another pin count (one more is the exposed pad a drawing left out) are other parts.
    const fits = set.filter((c) => c.pinCount === drawn.length || c.pinCount === drawn.length + 1)
    if (!fits.length) {
      return {
        kind: "different",
        candidates: set,
        note: `no supplier part is numbered exactly ${name}, and those numbered like it have another pin count than the ${drawn.length} drawn (${set.slice(0, 3).map((c) => `${c.lcsc} ${c.mpn}, ${c.pinCount} pins`).join("; ")}${set.length > 3 ? "; ..." : ""})`,
        text:
          `No supplier part is numbered exactly ${name}, and none of those numbered like it has the ${drawn.length} pins you drew, so they are other parts: ` +
          `${set.slice(0, 6).map(candidateLine).join("; ")}${set.length > 6 ? `; and ${set.length - 6} more` : ""}. ` +
          `Pass lcsc for the one the user means, after checking it is that part.`,
      }
    }
    set = fits
  }

  // What the drawing already says: its footprint's family and size, its pin count.
  if (hints.footprint) {
    const family = footprintFamily(hints.footprint)
    const same = set.filter((c) => supplierFamily(c.package) === family)
    if (same.length) set = same
    const size = footprintSize(hints.footprint)
    if (size) {
      const sized = set.filter((c) => sizeMatches(size, c.package))
      if (sized.length) set = sized
    }
  }
  if (drawn) {
    const fits = set.filter((c) => c.pinCount === drawn.length || c.pinCount === drawn.length + 1)
    if (fits.length) set = fits
  }

  let pinned: Pinned[]
  try {
    pinned = await readPins(source, set, signal)
  } catch (e) {
    return { kind: "failed", text: failure(e) }
  }

  // Drawings that number one part differently (a U.FL connector's signal pin is 1 in one and 2 in
  // another, each with its own land to match), or sizes of one part (WS2812B in 5050 and 3535):
  // the records the drawn pins don't contradict, when there are some and not all.
  if (drawn) {
    const agreeing = pinned.filter((p) => p.pins && comparePins(drawn, p.pins).verdict !== "contradicted")
    if (agreeing.length && agreeing.length < pinned.length) pinned = agreeing
  }

  let groups = group(pinned)
  // A package nobody has in stock isn't a choice while another is: NE555's DIP-8 listed with no
  // stock would otherwise make every NE555 a question. They are said, not offered.
  let unsold: Pinned[][] = []
  if (groups.length > 1 && groups.some((g) => stockOf(g[0].candidate) > 0)) {
    unsold = groups.filter((g) => stockOf(g[0].candidate) <= 0)
    groups = groups.filter((g) => stockOf(g[0].candidate) > 0)
  }
  // With no stock known anywhere, the most common package comes first, and the text says so.
  const unknownStock = groups.length > 1 && groups.every((g) => stockUnknown(g.map((m) => m.candidate)))
  if (unknownStock) groups = byCommonness(groups)
  if (groups.length === 1) {
    const [family] = groups
    const best = family[0].candidate
    let part: SupplierPart | null
    try {
      part = await source.part(best.lcsc, signal)
    } catch (e) {
      return { kind: "failed", text: failure(e) }
    }
    if (!part) return { kind: "none", text: `No supplier record for ${name} could be read.` }
    const members = family.map((f) => f.candidate)
    const same = partNumberKey(best.mpn) === partNumberKey(name)
    const unknown = stockUnknown(members)
    const skipped = uploads.length
      ? ` ${uploads.length === 1 ? "An EasyEDA user upload" : `${uploads.length} EasyEDA user uploads`} spelled like the name (${uploads.slice(0, 2).map((u) => u.lcsc).join(", ")}) ${uploads.length === 1 ? "was" : "were"} not used: a reviewed record outranks ${uploads.length === 1 ? "it" : "them"}.`
      : ""
    const chosen =
      same && members.length === 1 && !best.userUpload && !unsold.length && !uploads.length
        ? null
        : `${name} resolved to ${best.lcsc} ${best.mpn} (${packageName(best.package)}, ${stockOf(best) < 0 ? "stock unknown" : `${best.stock} in stock`}${best.userUpload ? ", an EasyEDA user upload: lower confidence" : ""})` +
          `${members.length > 1 ? `, ${unknown ? "the first of" : "the best stocked of"} ${members.length} supplier part numbers with the same package and the same function on every pin number (${members.slice(0, 4).map((m) => m.mpn).join(", ")}${members.length > 4 ? ", ..." : ""})${unknown ? "; stock is unknown for all of them" : ""}` : ""}.` +
          `${unsold.length ? ` Also listed, with no stock: ${unsold.slice(0, 3).map((g) => `${g[0].candidate.lcsc} ${packageName(g[0].candidate.package)}`).join(", ")}.` : ""}` +
          skipped
    return { kind: "found", part, candidate: best, family: members, chosen }
  }

  const reps = groups.map((g) => g[0])
  const ambiguous = (): Resolution => {
    const total = pinned.length
    // Each against the first, and two in one package that differ only in their pins (the list is
    // long enough without every pair): the pins that differ, spelled out.
    const pairs = reps.flatMap((r, i) => reps.slice(i + 1).filter((o) => i === 0 || samePackage(r.candidate, o.candidate)).map((o) => difference(r, o)))
    const differences = [...new Set(pairs)].slice(0, 4)
    return {
      kind: "ambiguous",
      candidates: reps.map((r) => r.candidate),
      text:
        `${name} is sold as ${total} supplier part numbers in ${groups.length} packages or pinouts, so it isn't one part: ` +
        `${groups.slice(0, 6).map(groupLine).join("; ")}${groups.length > 6 ? `; and ${groups.length - 6} more` : ""}. ` +
        `They differ in: ${differences.join("; ")}. ` +
        `Pass lcsc for the one the user means (ask if the package matters to them); ` +
        (unknownStock
          ? `the stock of none of them is known, so the first listed is only the most common package, not the best stocked.`
          : `the first listed is the best stocked.`),
    }
  }

  // Several groups and a drawing: if its pins contradict every one of them, it is a wrong part,
  // whichever package was meant.
  if (drawn) {
    try {
      const wrong = await contradiction(source, drawn, reps, "", signal)
      if (wrong) return wrong
    } catch (e) {
      return { kind: "failed", text: failure(e) }
    }
  }
  return ambiguous()
}

/**
 * Records numbered exactly like the name that name no pins, and ordering variants that do. The
 * variants in the same package (by size, so WS2812B-2020 is out for a 5050) and with the drawn
 * pin count check the drawing: all of them contradicting it is `contradicted`. Otherwise it says
 * the truth, "no record numbered exactly like it names its pins, but these do", and builds nothing.
 */
async function blankExact(
  source: SupplierPartsSource,
  name: string,
  exactAll: PartCandidate[],
  variants: PartCandidate[],
  hints: { pins?: DrawnPin[]; footprint?: string },
  signal?: AbortSignal,
): Promise<Resolution | null> {
  const drawn = hints.pins?.length ? hints.pins : null
  let near = variants.filter((v) => exactAll.some((e) => sameBody(e, v)))
  if (drawn) near = near.filter((c) => c.pinCount === drawn.length || c.pinCount === drawn.length + 1)
  if (!near.length) return null
  let pinned: Pinned[]
  try {
    pinned = (await readPins(source, near, signal)).filter((p) => p.pins)
  } catch (e) {
    return { kind: "failed", text: failure(e) }
  }
  if (!pinned.length) return null
  const reps = group(pinned).map((g) => g[0])
  const before = `The ${exactAll.length} supplier record${exactAll.length === 1 ? "" : "s"} numbered exactly ${name} name${exactAll.length === 1 ? "s" : ""} no pins, so the pins you drew were checked against ${reps.length === 1 ? "its ordering variant" : `its ${reps.length} ordering variants`} in the same package. `
  if (drawn) {
    try {
      const wrong = await contradiction(source, drawn, reps, before, signal)
      if (wrong) return wrong
    } catch (e) {
      return { kind: "failed", text: failure(e) }
    }
  }
  const lines = reps.slice(0, 4).map((r) => `${candidateLine(r.candidate)}${stockWords(r.candidate)}`)
  const verdict = drawn ? ` The pins you drew do not contradict ${reps.length === 1 ? "it" : "all of them"}, but that doesn't make ${name} resolve to one.` : ""
  return {
    kind: "none",
    text:
      `No supplier record numbered exactly ${name} names its pins (${exactAll.length} found), but ${reps.length === 1 ? "an ordering variant does" : `${reps.length} ordering variants in the same package do`}: ${lines.join("; ")}${reps.length > 4 ? "; ..." : ""}.${verdict} ` +
      `Pass lcsc of the one the user means after checking it is the same part.`,
  }
}
