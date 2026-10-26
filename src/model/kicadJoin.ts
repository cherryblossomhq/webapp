import { normBox, pointOnSegment, samePoint } from "../lib/geometry"
import { uid } from "../lib/id"
import { SpatialHash, pointBox } from "../lib/spatialHash"
import { ROOT_SHEET, sheetIdOf, useAt } from "./sheets"
import type { Project, Vec2, Wire } from "./types"

// S11: what a sheet joined by KiCad's rules (`SchematicSheet.kicadRules`) is, and how it is edited. KiCad's schematic points are integers of 100 nm
// (`SCH_IU_PER_MM = 1e4`, `include/base_units.h` of 7.0 to 10.0, `convert_to_biu.h` of 6.0), which is 127,000 to the editor's 12.7 mm unit. A wire has two connection
// points, its ends (`SCH_LINE::GetConnectionPoints`, `sch_line.cpp`), so another wire's end that lies on its side joins nothing until the wire is cut there.

/** KiCad's integer units to the editor's unit. */
export const IU = 127000
export const iu = (v: number) => Math.round(v * IU)
export const pkx = (p: Vec2) => `${iu(p.x)},${iu(p.y)}`

/**
 * Whether the point lies strictly inside the segment, in KiCad's integer units (an end is the wire's own point, not its side). The products are exact in a double
 * up to 2^26 units (6.7 km of sheet); a sheet a file makes larger than that is worked out in BigInt, so a hostile coordinate costs time, not a wrong join.
 */
export function onSideExact(p: Vec2, a: Vec2, b: Vec2): boolean {
  const px = iu(p.x)
  const py = iu(p.y)
  const ax = iu(a.x)
  const ay = iu(a.y)
  const bx = iu(b.x)
  const by = iu(b.y)
  if (Math.max(Math.abs(px), Math.abs(py), Math.abs(ax), Math.abs(ay), Math.abs(bx), Math.abs(by)) > 2 ** 26) {
    const [PX, PY, AX, AY, BX, BY] = [px, py, ax, ay, bx, by].map((v) => BigInt(v))
    if ((BX - AX) * (PY - AY) - (BY - AY) * (PX - AX) !== 0n) return false
    const dot = (PX - AX) * (BX - AX) + (PY - AY) * (BY - AY)
    return dot > 0n && dot < (BX - AX) ** 2n + (BY - AY) ** 2n
  }
  if ((bx - ax) * (py - ay) - (by - ay) * (px - ax) !== 0) return false
  const dot = (px - ax) * (bx - ax) + (py - ay) * (by - ay)
  return dot > 0 && dot < (bx - ax) ** 2 + (by - ay) ** 2
}

/** Whether the sheet a project (or the view of one sheet) shows is joined by KiCad's rules. */
export function kicadRulesShown(project: Pick<Project, "sheets" | "sheetSymbols" | "name" | "scope">): boolean {
  if (!project.sheets?.some((s) => s.kicadRules)) return false
  const sheet = project.scope === undefined ? ROOT_SHEET : useAt(project, project.scope).sheet
  return project.sheets.some((s) => s.id === sheet && s.kicadRules)
}

/**
 * Whether a point drawn by hand is on a wire's side, as the editor means it (within 1.27 um, its own tolerance): a click lands on the editor's four digits, and the
 * sheet's wires are at KiCad's six, so an exact test would miss every T drawn onto a wire that is off the editor's grid. Not an end of the wire.
 */
const onSideDrawn = (p: Vec2, a: Vec2, b: Vec2) => pointOnSegment(p, a, b) && !samePoint(p, a) && !samePoint(p, b)

/** The wire cut at a point strictly inside one of its segments: two wires (the second with a new id), or null where the point is not on its side. */
function cutAt(w: Wire, at: Vec2): [Wire, Wire] | null {
  for (let i = 0; i < w.points.length - 1; i++) {
    if (!onSideDrawn(at, w.points[i], w.points[i + 1])) continue
    const first: Wire = { ...w, points: [...w.points.slice(0, i + 1), at] }
    const second: Wire = { ...w, id: uid("w"), points: [at, ...w.points.slice(i + 1)] }
    return [first, second]
  }
  return null
}

/**
 * KiCad's T for a sheet with KiCad's rules: where an end of a wire lies on the side of another wire, or another wire's end on the side of this one, the wire is cut
 * there, so the ends meet and the wires are joined (a wire end on a wire's side joins nothing in KiCad without a junction, and drawing it there in KiCad puts one).
 * Returns the wires with the new wire's neighbours cut; the same array when nothing is on a side.
 */
export function cutAtTs(wires: Wire[], added: Wire): Wire[] {
  const others = wires.filter((w) => w !== added && w.points.length >= 2)
  // 1. the new wire is cut where another wire's end lies on one of its sides
  const cuts = new Map<number, Vec2[]>()
  for (const w of others) {
    for (const e of [w.points[0], w.points[w.points.length - 1]]) {
      for (let i = 0; i < added.points.length - 1; i++) {
        if (!onSideDrawn(e, added.points[i], added.points[i + 1])) continue
        const list = cuts.get(i) ?? cuts.set(i, []).get(i)!
        if (!list.some((q) => pkx(q) === pkx(e))) list.push(e)
      }
    }
  }
  let pieces: Wire[] = [added]
  if (cuts.size) {
    const runs: Vec2[][] = []
    let cur: Vec2[] = []
    added.points.forEach((p, i) => {
      cur.push(p)
      if (i === added.points.length - 1) return
      const here = (cuts.get(i) ?? []).sort((m, n) => Math.hypot(m.x - p.x, m.y - p.y) - Math.hypot(n.x - p.x, n.y - p.y))
      for (const c of here) {
        cur.push(c)
        runs.push(cur)
        cur = [c]
      }
    })
    runs.push(cur)
    pieces = runs.map((points, k) => (k === 0 ? { ...added, points } : { ...added, id: uid("w"), points }))
  }
  // 2. another wire is cut where an end of the new wire lies on one of its sides
  let out = wires.flatMap((w) => (w === added ? pieces : [w]))
  for (const e of [added.points[0], added.points[added.points.length - 1]]) {
    for (const w of others) {
      if (!out.includes(w)) continue
      const cut = cutAt(w, e)
      if (!cut) continue
      out = out.flatMap((x) => (x === w ? cut : [x]))
      break
    }
  }
  return out
}

// ---------- settling an edit ----------

/** The signature of a wire's points in KiCad's integer units: two wires with one are the same wire for the joining rules. */
const shape = (w: Wire) => w.points.map(pkx).join(";")

/** A vertex of one wire that lies on the side of another (a T): the host wire, and where. A T is told by its place alone, so cutting wires (which gives pieces new ids) does not make an old T look new. */
interface Contact {
  key: string
  host: string
  at: Vec2
}

/**
 * Every T among the wires of one sheet that involves a wire of `focus`: a vertex of a wire lying on the side of another. A pair of wires neither of which is in
 * `focus` is not looked at, so a sheet's old T's (which KiCad leaves alone) cost nothing.
 */
function contactsOf(wires: Wire[], focus: ReadonlySet<string>): Contact[] {
  const all = new SpatialHash<{ id: string; a: Vec2; b: Vec2 }>()
  const own = new SpatialHash<{ id: string; a: Vec2; b: Vec2 }>()
  for (const w of wires) {
    for (let i = 1; i < w.points.length; i++) {
      const seg = { id: w.id, a: w.points[i - 1], b: w.points[i] }
      const box = normBox(seg.a, seg.b)
      all.insert(seg, box)
      if (focus.has(w.id)) own.insert(seg, box)
    }
  }
  const out: Contact[] = []
  for (const w of wires) {
    const hash = focus.has(w.id) ? all : own
    for (const p of w.points) {
      for (const seg of hash.query(pointBox(p, 2e-4))) {
        if (seg.id === w.id || !onSideDrawn(p, seg.a, seg.b)) continue
        out.push({ key: pkx(p), host: seg.id, at: p })
      }
    }
  }
  return out
}

/** The wire cut at each of `at` (points on its sides): the first piece keeps the wire's id, the others are new. */
function splitAt(w: Wire, at: Vec2[]): Wire[] {
  const left = [...at]
  const runs: Vec2[][] = []
  let cur: Vec2[] = []
  w.points.forEach((p, i) => {
    cur.push(p)
    if (i === w.points.length - 1) return
    const next = w.points[i + 1]
    const here: Vec2[] = []
    for (let k = left.length - 1; k >= 0; k--) if (onSideDrawn(left[k], p, next)) here.push(...left.splice(k, 1))
    here.sort((m, n) => Math.hypot(m.x - p.x, m.y - p.y) - Math.hypot(n.x - p.x, n.y - p.y))
    for (const c of here) {
      cur.push(c)
      runs.push(cur)
      cur = [c]
    }
  })
  runs.push(cur)
  return runs.map((points, k) => (k === 0 ? { ...w, points } : { ...w, id: uid("w"), points }))
}

/**
 * What an edit of a sheet joined by KiCad's rules is made to be before it is kept: a wire's vertex that the edit has put on another wire's side is cut there, as
 * KiCad does when it finishes an edit (`SCH_COMMIT`, which breaks the wires at the new T), so the edit makes the join it shows and never a T that joins nothing; and
 * a T that was there before is left as it was, since KiCad joins nothing there. A project with no sheet of KiCad's rules, or an edit that changed no wire's points,
 * is returned as it is, so a sheet drawn in the editor is edited as ever.
 *
 * `before` is the project (or view of one sheet) the edit started from and `after` what it made. Cutting is idempotent: settling a settled edit changes nothing.
 */
export function settleKicadSheet(before: Project, after: Project): Project {
  if (!after.sheets?.some((s) => s.kicadRules) || after.wires === before.wires) return after
  const flagged = new Set(after.sheets.filter((s) => s.kicadRules).map((s) => s.id))
  const was = new Map(before.wires.map((w) => [w.id, w]))
  const cuts = new Map<string, Vec2[]>()
  const bySheet = new Map<string, Wire[]>()
  for (const w of after.wires) {
    const s = sheetIdOf(w)
    if (flagged.has(s) && w.points.length >= 2) (bySheet.get(s) ?? bySheet.set(s, []).get(s)!).push(w)
  }
  for (const [sheet, wires] of bySheet) {
    const focus = new Set(wires.filter((w) => {
      const b = was.get(w.id)
      return !b || shape(b) !== shape(w)
    }).map((w) => w.id))
    if (!focus.size) continue
    const had = new Set(contactsOf(before.wires.filter((w) => sheetIdOf(w) === sheet && w.points.length >= 2), focus).map((c) => c.key))
    for (const c of contactsOf(wires, focus)) {
      if (had.has(c.key)) continue
      const list = cuts.get(c.host) ?? cuts.set(c.host, []).get(c.host)!
      if (!list.some((q) => pkx(q) === pkx(c.at))) list.push(c.at)
    }
  }
  if (!cuts.size) return after
  return { ...after, wires: after.wires.flatMap((w) => (cuts.has(w.id) ? splitAt(w, cuts.get(w.id)!) : [w])) }
}
