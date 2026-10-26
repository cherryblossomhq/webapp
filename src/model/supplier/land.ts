// Comparing two land patterns: the one a part is drawn on and the supplier's.
//
// Neither origin means anything on its own (the footprinter centres a land on the body, a supplier
// on whatever its author drew), so both are moved to their own centroid first, which makes the
// test one of shape. A footprint can be placed at any quarter turn, so all four are tried. Mirror
// images are not: a land whose numbering runs the other way puts every pin but the symmetric ones
// on the wrong lead, and that is the failure this exists to find (the footprinter's `msop10`
// numbers its second row top to bottom).
//
// The question per pad is whether the lead lands on copper: the supplier's pad centre, which is
// where its land puts the lead, has to fall inside the drawn pad. That passes a footprinter SOT-23
// against a supplier's (0.05 mm apart) and refuses a DFN drawn on a SOIC land (1.2 mm).

export interface LandPad {
  /** Pad number; empty or null for a pad that belongs to no pin. */
  number: string | null
  x: number
  y: number
  width: number
  height: number
  through?: boolean
}

export interface LandSummary {
  /** Pads that carry a number, the exposed pad included. */
  pads: number
  /** A large pad in the middle of the part, numbered or not. */
  exposed: number
  /** Centre to centre of neighbouring pads in a row, the commonest such distance. */
  pitch: number | null
  /** Centre to centre across the part, between its two outermost rows. */
  span: number | null
  /** Overall copper extent, x by y. */
  extent: { x: number; y: number }
}

const r2 = (n: number) => Math.round(n * 100) / 100
const area = (p: LandPad) => p.width * p.height

/** The exposed (thermal) pads: much bigger than the median pad and near the middle. */
export function exposedPads<T extends LandPad>(pads: T[]): T[] {
  if (pads.length < 3) return []
  const areas = pads.map(area).sort((a, b) => a - b)
  const median = areas[Math.floor(areas.length / 2)]
  const xs = pads.map((p) => p.x)
  const ys = pads.map((p) => p.y)
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2
  const cy = (Math.min(...ys) + Math.max(...ys)) / 2
  const hx = Math.max(0.01, (Math.max(...xs) - Math.min(...xs)) / 2)
  const hy = Math.max(0.01, (Math.max(...ys) - Math.min(...ys)) / 2)
  return pads.filter((p) => !p.through && area(p) >= 3 * median && Math.abs(p.x - cx) <= hx * 0.35 && Math.abs(p.y - cy) <= hy * 0.35)
}

/** Most common nearest-neighbour distance, the pitch of a row of leads. */
function pitchOf(pads: LandPad[]): number | null {
  if (pads.length < 2) return null
  const counts = new Map<number, number>()
  for (const p of pads) {
    let best = Infinity
    for (const q of pads) if (q !== p) best = Math.min(best, Math.hypot(p.x - q.x, p.y - q.y))
    if (Number.isFinite(best)) counts.set(r2(best), (counts.get(r2(best)) ?? 0) + 1)
  }
  let pitch: number | null = null
  let n = 0
  for (const [d, c] of counts) if (c > n || (c === n && pitch !== null && d < pitch)) [pitch, n] = [d, c]
  return pitch
}

export function summarizeLand(pads: LandPad[]): LandSummary {
  const numbered = pads.filter((p) => p.number)
  const ep = exposedPads(numbered.length ? numbered : pads)
  const leads = numbered.filter((p) => !ep.includes(p))
  const xs = leads.map((p) => p.x)
  const ys = leads.map((p) => p.y)
  const spanX = xs.length ? Math.max(...xs) - Math.min(...xs) : 0
  const spanY = ys.length ? Math.max(...ys) - Math.min(...ys) : 0
  const lo = { x: Infinity, y: Infinity }
  const hi = { x: -Infinity, y: -Infinity }
  for (const p of pads) {
    lo.x = Math.min(lo.x, p.x - p.width / 2)
    lo.y = Math.min(lo.y, p.y - p.height / 2)
    hi.x = Math.max(hi.x, p.x + p.width / 2)
    hi.y = Math.max(hi.y, p.y + p.height / 2)
  }
  // Two pads have no row to pitch along: their distance is the span.
  const pitch = leads.length > 2 ? pitchOf(leads) : null
  // The span is across the rows: the axis the pitch doesn't run along.
  let span: number | null = null
  if (leads.length === 2) span = r2(Math.hypot(leads[0].x - leads[1].x, leads[0].y - leads[1].y))
  else if (leads.length > 2) {
    const rowsAlongY = new Set(xs.map(r2)).size <= new Set(ys.map(r2)).size
    span = r2(rowsAlongY ? spanX : spanY) || r2(Math.max(spanX, spanY))
  }
  return {
    pads: numbered.length,
    exposed: ep.length,
    pitch,
    span,
    extent: { x: Number.isFinite(lo.x) ? r2(hi.x - lo.x) : 0, y: Number.isFinite(lo.y) ? r2(hi.y - lo.y) : 0 },
  }
}

export const describeLand = (s: LandSummary) =>
  `${s.pads} pad${s.pads === 1 ? "" : "s"}${s.exposed ? ` (${s.exposed} exposed)` : ""}` +
  `${s.pitch ? `, ${s.pitch} mm pitch` : ""}${s.span ? `, rows ${s.span} mm apart` : ""}, ${s.extent.x} x ${s.extent.y} mm of copper`

export interface LandComparison {
  ok: boolean
  /** Sentences, each with the numbers that differ. */
  problems: string[]
  /** The same in a phrase, for a list: "3 of 4 pads miss the supplier's leads, pad 4 by 1.25 mm". */
  brief: string
  drawn: LandSummary
  vendor: LandSummary
  /** The pad furthest from the supplier's, after the best quarter turn. */
  worst: { number: string; offBy: number } | null
}

type Pt = { x: number; y: number }
const turn = (p: Pt, q: number): Pt => (q === 1 ? { x: -p.y, y: p.x } : q === 2 ? { x: -p.x, y: -p.y } : q === 3 ? { x: p.y, y: -p.x } : p)

function centred<T extends LandPad>(pads: T[], about: T[]): T[] {
  const cx = about.reduce((s, p) => s + p.x, 0) / about.length
  const cy = about.reduce((s, p) => s + p.y, 0) / about.length
  return pads.map((p) => ({ ...p, x: p.x - cx, y: p.y - cy }))
}

/** Pads grouped by number; a number can own several pads (a module's ground grid). */
function byNumber<T extends LandPad>(pads: T[]): Map<string, T[]> {
  const out = new Map<string, T[]>()
  for (const p of pads) if (p.number) out.set(p.number, [...(out.get(p.number) ?? []), p])
  return out
}

/** Whether a point is on a pad's copper, with a little slack for rounding between libraries. */
const inside = (pt: Pt, pad: LandPad, slack: number) =>
  Math.abs(pt.x - pad.x) <= pad.width / 2 + slack && Math.abs(pt.y - pad.y) <= pad.height / 2 + slack

/**
 * Whether `drawn` puts copper where the supplier's land does, pad number for pad number.
 * Problems carry the numbers that differ: pad counts, pitch, row span and the worst pad.
 */
export function compareLands(drawn: LandPad[], vendor: LandPad[]): LandComparison {
  const d = summarizeLand(drawn)
  const v = summarizeLand(vendor)
  const problems: string[] = []
  const briefs: string[] = []
  const vNums = byNumber(vendor)
  const dNums = byNumber(drawn)
  const missing = [...vNums.keys()].filter((n) => !dNums.has(n))
  const extra = [...dNums.keys()].filter((n) => !vNums.has(n))
  const vEp = exposedPads(vendor.filter((p) => p.number))
  if (missing.length || extra.length) {
    const what: string[] = []
    if (missing.length) {
      const epMissing = missing.filter((n) => vEp.some((p) => p.number === n))
      what.push(
        epMissing.length && epMissing.length === missing.length
          ? `has no pad ${epMissing.join(", ")}, the supplier's exposed pad (${vEp.map((p) => `${r2(p.width)} x ${r2(p.height)} mm`).join(", ")})`
          : `has no pad ${missing.slice(0, 10).join(", ")}`,
      )
    }
    if (extra.length) what.push(`has pad ${extra.slice(0, 10).join(", ")} the supplier's land doesn't`)
    problems.push(`It ${what.join(" and ")}: ${describeLand(d)}, against the supplier's ${describeLand(v)}.`)
    briefs.push(`${d.pads} pads against the supplier's ${v.pads}${missing.some((n) => vEp.some((p) => p.number === n)) ? " (no exposed pad)" : ""}`)
  }

  // Align on the pads both number, then try each quarter turn.
  const shared = [...vNums.keys()].filter((n) => dNums.has(n))
  let worst: LandComparison["worst"] = null
  if (shared.length >= 2) {
    const vShared = vendor.filter((p) => p.number && shared.includes(p.number))
    const dShared = drawn.filter((p) => p.number && shared.includes(p.number))
    const vc = centred(vendor, vShared)
    const dc = centred(drawn, dShared)
    const dGroups = byNumber(dc)
    let best: { misses: { number: string; offBy: number }[]; worst: { number: string; offBy: number }; q: number } | null = null
    for (const q of [0, 1, 2, 3]) {
      const misses: { number: string; offBy: number }[] = []
      let w = { number: shared[0], offBy: 0 }
      for (const vp of vc) {
        if (!vp.number || !dGroups.has(vp.number)) continue
        const mine = dGroups.get(vp.number)!
        const at = turn(vp, q)
        const off = Math.min(...mine.map((p) => Math.hypot(at.x - p.x, at.y - p.y)))
        if (off > w.offBy) w = { number: vp.number, offBy: off }
        if (!padFits(vp, q, false, mine)) misses.push({ number: vp.number, offBy: off })
      }
      if (!best || misses.length < best.misses.length || (misses.length === best.misses.length && w.offBy < best.worst.offBy)) best = { misses, worst: w, q }
    }
    worst = best ? { number: best.worst.number, offBy: r2(best.worst.offBy) } : null
    if (best && best.misses.length) {
      const sorted = [...best.misses].sort((a, b) => b.offBy - a.offBy)
      const numbering = mirroredFits(vc, dc) ? " The pads are in the right places but numbered the other way round, so the pins on that side land on the wrong leads." : ""
      const geometry: string[] = []
      if (d.pitch && v.pitch && Math.abs(d.pitch - v.pitch) > 0.02) geometry.push(`pitch ${d.pitch} mm against the supplier's ${v.pitch} mm`)
      if (d.span && v.span && Math.abs(d.span - v.span) > 0.1) geometry.push(`rows ${d.span} mm apart against ${v.span} mm`)
      problems.push(
        `${best.misses.length} of ${shared.length} pads miss the supplier's leads${geometry.length ? ` (${geometry.join(", ")})` : ""}; ` +
          `worst is pad ${sorted[0].number}, ${r2(sorted[0].offBy)} mm out.${numbering}`,
      )
      briefs.push(
        `${best.misses.length} of ${shared.length} pads miss the supplier's leads, pad ${sorted[0].number} by ${r2(sorted[0].offBy)} mm${numbering ? ", numbered the other way round" : ""}`,
      )
    }
  }
  return { ok: problems.length === 0, problems, brief: briefs.join("; "), drawn: d, vendor: v, worst }
}

/**
 * Whether a supplier pad, turned by `q` quarter turns (and mirrored first), sits on one of `mine`:
 * its lead position on the drawn pad's copper, and the drawn pad's middle on its copper. A land
 * drawn for a bigger package (0402 pads under a 0.6 mm diode) passes the first and fails the second.
 */
function padFits(vp: LandPad, q: number, mirror: boolean, mine: LandPad[]): boolean {
  const at = turn({ x: mirror ? -vp.x : vp.x, y: vp.y }, q)
  const theirs = { ...at, width: q % 2 ? vp.height : vp.width, height: q % 2 ? vp.width : vp.height, number: vp.number }
  return mine.some((p) => inside(at, p, 0.05) && inside(p, theirs, 0.05))
}

/** Whether the shapes agree once one land is mirrored: numbering that runs the wrong way. */
function mirroredFits(vendor: LandPad[], drawn: LandPad[]): boolean {
  const vs = vendor.filter((p) => p.number)
  const groups = byNumber(drawn)
  return [0, 1, 2, 3].some((q) => vs.every((vp) => padFits(vp, q, true, groups.get(vp.number!) ?? [])))
}
