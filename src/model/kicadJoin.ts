import { pointOnSegment, samePoint } from "../lib/geometry"
import { uid } from "../lib/id"
import { ROOT_SHEET, useAt } from "./sheets"
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
