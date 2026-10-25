// An independent oracle for a board's outline: every piece the raw file draws on Edge.Cuts (the board's own and each footprint's, a
// footprint's turned and moved by its own angle and place), as a polyline dense enough that a chord is within 1e-5 mm of the true curve, read
// by the census's own reader (`graphics.mjs`, `sexpr.mjs`) and with no code from `src/model`. The importer's outline is compared with it
// both ways: every point of the file's edge is on the project's, and every point of the project's is on the file's, to 0.001 mm, except at
// the places the importer says it repaired (a gap it closed with a straight piece, pieces it merged, pieces under a tenth of a millimetre
// that touched nothing it dropped), which the check counts.

import { graphicsOracle } from "./graphics.mjs"

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1])

/** The file's Edge.Cuts pieces on the board (KiCad's frame, y down): each `{ type, closed, line }`. */
export function edgeOracle(text) {
  const g = graphicsOracle(text)
  const out = []
  const take = (s) => {
    if (s.layer !== "Edge.Cuts") return
    for (const line of s.lines) {
      let pts = line
      if (s.type === "circle" && s.analytic) {
        // The oracle gives a circle's four extremes for its box; the edge is the whole circle.
        const { c, r } = s.analytic
        pts = Array.from({ length: 3601 }, (_, i) => [c[0] + r * Math.cos((i / 3600) * 2 * Math.PI), c[1] + r * Math.sin((i / 3600) * 2 * Math.PI)])
      }
      if (pts.length < 2) continue
      const closed = dist(pts[0], pts[pts.length - 1]) < 1e-9 && pts.length > 2
      out.push({ type: s.type, closed, line: pts })
    }
  }
  for (const s of g.board) take(s)
  for (const f of g.footprints) for (const s of f.shapes) take(s)
  return out
}

/** Points along a polyline every `step` mm, its vertices included. */
export function sample(line, step = 0.02) {
  const out = [line[0]]
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1]
    const b = line[i]
    const n = Math.max(1, Math.ceil(dist(a, b) / step))
    for (let k = 1; k <= n; k++) out.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n])
  }
  return out
}

export const length = (line) => line.slice(1).reduce((s, p, i) => s + dist(line[i], p), 0)

function segmentDistance(p, a, b) {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const l2 = dx * dx + dy * dy
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2))
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy))
}

/** A grid of the segments of some polylines, to ask how far a point is from the nearest (up to `reach`; beyond it, Infinity). */
export function nearestIndex(lines, reach = 0.2) {
  const CELL = Math.max(reach, 0.5)
  const grid = new Map()
  const segs = []
  for (const line of lines) {
    for (let i = 1; i < line.length; i++) {
      const id = segs.length
      segs.push([line[i - 1], line[i]])
      const a = line[i - 1]
      const b = line[i]
      const x0 = Math.floor((Math.min(a[0], b[0]) - reach) / CELL)
      const x1 = Math.floor((Math.max(a[0], b[0]) + reach) / CELL)
      const y0 = Math.floor((Math.min(a[1], b[1]) - reach) / CELL)
      const y1 = Math.floor((Math.max(a[1], b[1]) + reach) / CELL)
      for (let x = x0; x <= x1; x++) {
        for (let y = y0; y <= y1; y++) {
          if ((x1 - x0 + 1) * (y1 - y0 + 1) > 64) {
            const c = [(x + 0.5) * CELL, (y + 0.5) * CELL]
            if (segmentDistance(c, a, b) > CELL * 0.75 + reach) continue
          }
          const k = `${x},${y}`
          const list = grid.get(k)
          if (list) list.push(id)
          else grid.set(k, [id])
        }
      }
    }
  }
  return (p) => {
    let best = Infinity
    for (const id of grid.get(`${Math.floor(p[0] / CELL)},${Math.floor(p[1] / CELL)}`) ?? []) best = Math.min(best, segmentDistance(p, segs[id][0], segs[id][1]))
    return best
  }
}
