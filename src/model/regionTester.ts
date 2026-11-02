import { Clipper, PointInPolygonResult, type Path64 } from "@countertype/clipper2-ts"

// Whether a point is in a ring, or in a region of an outline and its holes, for pours of thousands of corners and holes: the pour engines
// (`pour.ts`, `zoneFill.ts`) and the checks that ask whether a pad or a via is in a fill (`fillTester`).

/** Holes fewer than this are each asked in turn; more are found by their boxes first. */
const INDEXED_HOLES = 16

/**
 * Whether a point, in Clipper's units, is in the region an outline and its holes make: a point on the outline counts as in it, and one on the edge of a hole is not in
 * the hole. The outline is a `ringTester`; the holes are kept in the order of their left sides with the widest one's width, so a point asks only the holes whose boxes
 * hold it. A pour round thousands of pads has a hole for each, and asking every hole for every point took minutes on a board of 12,000 pads.
 */
export function regionTester(paths: Path64[]): (q: { x: number; y: number }) => boolean {
  if (!paths.length) return () => false
  const outer = ringTester(paths[0])
  const holes = paths.slice(1)
  if (holes.length < INDEXED_HOLES) {
    const testers = holes.map(ringTester)
    return (q) => outer(q) !== PointInPolygonResult.IsOutside && !testers.some((t) => t(q) === PointInPolygonResult.IsInside)
  }
  const boxes = holes.map((h) => {
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const q of h) {
      if (q.x < minX) minX = q.x
      if (q.x > maxX) maxX = q.x
      if (q.y < minY) minY = q.y
      if (q.y > maxY) maxY = q.y
    }
    return { minX, minY, maxX, maxY }
  })
  const order = holes.map((_, i) => i).sort((i, j) => boxes[i].minX - boxes[j].minX)
  const lefts = order.map((i) => boxes[i].minX)
  const span = boxes.reduce((m, b) => Math.max(m, b.maxX - b.minX), 0)
  const testers: (Place | undefined)[] = []
  return (q) => {
    if (outer(q) === PointInPolygonResult.IsOutside) return false
    // The first hole whose left side is past q less the widest hole: none before it reaches q.
    let lo = 0
    let hi = lefts.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (lefts[mid] < q.x - span) lo = mid + 1
      else hi = mid
    }
    for (let k = lo; k < lefts.length && lefts[k] <= q.x; k++) {
      const i = order[k]
      const b = boxes[i]
      if (q.x > b.maxX || q.y < b.minY || q.y > b.maxY) continue
      const t = (testers[i] ??= ringTester(holes[i]))
      if (t(q) === PointInPolygonResult.IsInside) return false
    }
    return true
  }
}

export type Place = (q: { x: number; y: number }) => PointInPolygonResult

/**
 * Where a point is against one ring, as `Clipper.pointInPolygon` says it. A ring of many corners (a big pour's outline, or the copper
 * round its pads) is held with its edges sorted into bands of y, so a point is tested against the edges of its band and not all of them,
 * and with the box of the ring, so a point that is far from it costs nothing. The sums are exact (whole micrometres).
 */
function ringTester(path: Path64): Place {
  const n = path.length
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const q of path) {
    if (q.x < minX) minX = q.x
    if (q.x > maxX) maxX = q.x
    if (q.y < minY) minY = q.y
    if (q.y > maxY) maxY = q.y
  }
  // A short ring is walked whole, but a point outside its box is outside it: a pour with thousands of small holes asks each one for every point.
  if (n < 48) return (q) => (q.x < minX || q.x > maxX || q.y < minY || q.y > maxY ? PointInPolygonResult.IsOutside : Clipper.pointInPolygon(q, path))
  const bands = Math.min(2048, Math.max(8, n >> 2))
  const height = (maxY - minY) / bands || 1
  const band = (y: number) => Math.min(bands - 1, Math.max(0, Math.floor((y - minY) / height)))
  const edges: number[][] = Array.from({ length: bands }, () => [])
  for (let i = 0; i < n; i++) {
    const a = path[i]
    const b = path[(i + 1) % n]
    for (let k = band(Math.min(a.y, b.y)); k <= band(Math.max(a.y, b.y)); k++) edges[k].push(i)
  }
  return (q) => {
    if (q.x < minX || q.x > maxX || q.y < minY || q.y > maxY) return PointInPolygonResult.IsOutside
    let crossings = 0
    for (const i of edges[band(q.y)]) {
      const a = path[i]
      const b = path[(i + 1) % n]
      const cross = (b.x - a.x) * (q.y - a.y) - (q.x - a.x) * (b.y - a.y)
      // On the edge: collinear and between its ends.
      if (cross === 0 && q.x >= Math.min(a.x, b.x) && q.x <= Math.max(a.x, b.x) && q.y >= Math.min(a.y, b.y) && q.y <= Math.max(a.y, b.y)) return PointInPolygonResult.IsOn
      // A crossing of the ray to the right, the half-open way so a corner on the ray counts once.
      if (a.y > q.y !== b.y > q.y && (b.y > a.y ? cross > 0 : cross < 0)) crossings++
    }
    return crossings & 1 ? PointInPolygonResult.IsInside : PointInPolygonResult.IsOutside
  }
}
