import { flattenPath, FLATTEN_TOLERANCE, type ShapePath } from "./shapes"
import type { Vec2 } from "./types"

// Whether the loops of a board outline cross themselves or each other (X2). A loop that crosses itself (a bow tie) or two loops that cross
// (overlapping cutouts, a second shape over the first) are no board a fab can cut, and KiCad's own checks flag them. Only closed paths are
// looked at: a piece still being drawn may cross anything until it closes. Edges are the flattened loops; two edges that only share an end
// (neighbours in a loop) or touch at a point do not count, only a crossing does.

export interface OutlineCrossing {
  /** `self`: loop `path` crosses itself. `cross`: loop `path` crosses loop `other`. */
  kind: "self" | "cross"
  path: number
  other?: number
  at: Vec2
}

interface E {
  a: Vec2
  b: Vec2
  path: number
  i: number
  n: number
  minX: number
  maxX: number
  minY: number
  maxY: number
}

const EPS = 1e-9

/** The crossing point of two segments when they cross at a point inside both (not at an end of either), else null. */
function properCrossing(p: Vec2, p2: Vec2, q: Vec2, q2: Vec2): Vec2 | null {
  const r = { x: p2.x - p.x, y: p2.y - p.y }
  const s = { x: q2.x - q.x, y: q2.y - q.y }
  const den = r.x * s.y - r.y * s.x
  if (Math.abs(den) < 1e-14) return null
  const t = ((q.x - p.x) * s.y - (q.y - p.y) * s.x) / den
  const u = ((q.x - p.x) * r.y - (q.y - p.y) * r.x) / den
  // The tolerance is relative to each segment's length, so an end that meets another edge (a T) is not a crossing.
  const lr = Math.hypot(r.x, r.y)
  const ls = Math.hypot(s.x, s.y)
  const et = Math.max(EPS, 1e-7 / Math.max(lr, 1e-12))
  const eu = Math.max(EPS, 1e-7 / Math.max(ls, 1e-12))
  if (t <= et || t >= 1 - et || u <= eu || u >= 1 - eu) return null
  return { x: p.x + t * r.x, y: p.y + t * r.y }
}

const cache = new WeakMap<ShapePath[], OutlineCrossing[]>()

/** Every pair of loops that cross, and every loop that crosses itself: one entry each, with a point where it happens. */
export function outlineCrossings(paths: ShapePath[]): OutlineCrossing[] {
  const hit = cache.get(paths)
  if (hit) return hit
  const edges: E[] = []
  paths.forEach((path, pi) => {
    if (!path.closed) return
    const pts = flattenPath(path, FLATTEN_TOLERANCE)
    if (pts.length < 3) return
    const n = pts.length
    for (let i = 0; i < n; i++) {
      const a = pts[i]
      const b = pts[(i + 1) % n]
      edges.push({ a, b, path: pi, i, n, minX: Math.min(a.x, b.x), maxX: Math.max(a.x, b.x), minY: Math.min(a.y, b.y), maxY: Math.max(a.y, b.y) })
    }
  })
  edges.sort((x, y) => x.minX - y.minX)
  const found = new Map<string, OutlineCrossing>()
  for (let k = 0; k < edges.length; k++) {
    const e = edges[k]
    for (let m = k + 1; m < edges.length && edges[m].minX <= e.maxX; m++) {
      const f = edges[m]
      if (f.minY > e.maxY || f.maxY < e.minY) continue
      const same = e.path === f.path
      if (same) {
        const d = Math.abs(e.i - f.i)
        if (d === 1 || d === e.n - 1) continue
      }
      const key = same ? `${e.path}` : `${Math.min(e.path, f.path)}:${Math.max(e.path, f.path)}`
      if (found.has(key)) continue
      const at = properCrossing(e.a, e.b, f.a, f.b)
      if (at) found.set(key, same ? { kind: "self", path: e.path, at } : { kind: "cross", path: Math.min(e.path, f.path), other: Math.max(e.path, f.path), at })
    }
  }
  const out = [...found.values()].sort((x, y) => x.path - y.path || (x.other ?? -1) - (y.other ?? -1))
  cache.set(paths, out)
  return out
}

/** The sentence that says what crosses, for a refusal or an error. */
export function crossingSentence(c: OutlineCrossing): string {
  const at = `near (${c.at.x.toFixed(2)}, ${c.at.y.toFixed(2)}) mm`
  return c.kind === "self" ? `The board outline crosses itself ${at}` : `Two shapes of the board outline cross each other ${at}`
}

/** The first crossing of these paths as a sentence, or null when there is none. */
export function outlineCrossingProblem(paths: ShapePath[]): string | null {
  const [first] = outlineCrossings(paths)
  return first ? `${crossingSentence(first)}. A board edge may not cross itself or another edge: move one of them so they do not meet.` : null
}
