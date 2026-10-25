import { emptyBox, expandBox, pointSegmentDistance, segmentSegmentDistance, type Box } from "../lib/geometry"
import { flattenPath, FLATTEN_TOLERANCE, pathsBox, segEnd, segStart, type ShapePath } from "./shapes"
import type { BoardDef, Vec2 } from "./types"

// The board's shape when it is not the plain rectangle (X2): what the outline is as geometry, and how far a point or a
// piece of copper is from its edge. A board with no `outline` is the rounded rectangle `width` by `height`, and nothing
// here is asked about it: every caller keeps its own rectangle code for that board, so a board drawn in the editor
// behaves exactly as it always did.

/**
 * Whether the outline can cut the board out: `closed` has closed loops and no path left open, `open` has a path that
 * does not close (whatever else it has), `missing` has no path at all (a board brought in from KiCad with no Edge.Cuts).
 * A board with no `outline` is closed.
 */
export type OutlineState = "closed" | "open" | "missing"

/** A closed loop of the outline, flattened, with the role its nesting gives it. */
export interface OutlineRing {
  /** Counter-clockwise for the board's own edge, clockwise for a hole (y up). */
  pts: Vec2[]
  hole: boolean
  /** The index of its path in `outline.paths`. */
  path: number
  /** The piece of board it is the edge of, or a hole in: an index into `regions`. */
  region: number
  box: Box
  /** Unsigned area. */
  area: number
}

export interface OutlineRegion {
  outer: Vec2[]
  holes: Vec2[][]
}

export type Edge = readonly [Vec2, Vec2]

export interface OutlineGeometry {
  state: OutlineState
  rings: OutlineRing[]
  /** Each piece of board with the holes cut out of it. */
  regions: OutlineRegion[]
  /** Every edge as drawn, flattened: the closed loops and the paths left open. */
  edges: Edge[]
  /** The box of everything drawn, exact for arcs. */
  box: Box
  /** Whether a point is on the board (an odd number of loops around it). False everywhere when there is no loop. */
  contains(p: Vec2): boolean
  /** Distance from a point to the nearest edge, or `Infinity` when none is within `limit`. */
  nearest(p: Vec2, limit?: number): number
  /** Distance from the segment `a` to `b` to the nearest edge, or `Infinity` when none is within `limit`. */
  nearestToSegment(a: Vec2, b: Vec2, limit?: number): number
  /** Distance from point to the board's edge, positive on the board and negative off it (just the distance when there is no loop to say which side). */
  signedDistance(p: Vec2): number
}

const same = (p: Vec2, q: Vec2) => p.x === q.x && p.y === q.y

/** The area of a ring, positive when it runs counter-clockwise (y up). */
export function signedArea(ring: Vec2[]): number {
  let a = 0
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += (ring[j].x - ring[i].x) * (ring[j].y + ring[i].y)
  return a / 2
}

/** Whether a point is inside a ring (ray casting, edges counted by their lower end so a vertex is not counted twice). */
export function pointInRing(p: Vec2, ring: Vec2[]): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]
    const b = ring[j]
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside
  }
  return inside
}

function pathBoxOf(path: ShapePath): Box {
  return pathsBox([path])
}

/** The state of a board's outline. */
export function outlineState(b: Pick<BoardDef, "outline">): OutlineState {
  const paths = b.outline?.paths
  if (!paths) return "closed"
  if (!paths.length) return "missing"
  return paths.some((p) => !p.closed) ? "open" : "closed"
}

/** Whether the board has an outline of its own (any path), rather than being the rectangle. */
export const hasOutline = (b: Pick<BoardDef, "outline">): boolean => !!b.outline && b.outline.paths.length > 0

/** The box of a board with an outline: the box of everything drawn on it. A board with none has `width` and `height`. */
export function outlineBox(b: Pick<BoardDef, "outline">): Box | null {
  const paths = b.outline?.paths
  return paths?.length ? pathsBox(paths) : null
}

class EdgeIndex {
  private readonly cell: number
  private readonly cells = new Map<number, number[]>()
  private readonly nx: number
  private readonly x0: number
  private readonly y0: number
  private readonly ny: number
  private stamp = 0
  private readonly seen: Int32Array
  constructor(
    private readonly edges: Edge[],
    box: Box,
  ) {
    const w = Math.max(box.maxX - box.minX, 1e-6)
    const h = Math.max(box.maxY - box.minY, 1e-6)
    this.cell = Math.max(0.25, Math.max(w, h) / 128)
    this.x0 = box.minX
    this.y0 = box.minY
    this.nx = Math.floor(w / this.cell) + 1
    this.ny = Math.floor(h / this.cell) + 1
    this.seen = new Int32Array(edges.length)
    edges.forEach(([a, b], i) => {
      const ix0 = this.ix(Math.min(a.x, b.x))
      const ix1 = this.ix(Math.max(a.x, b.x))
      const iy0 = this.iy(Math.min(a.y, b.y))
      const iy1 = this.iy(Math.max(a.y, b.y))
      for (let x = ix0; x <= ix1; x++) {
        for (let y = iy0; y <= iy1; y++) {
          const k = y * this.nx + x
          const list = this.cells.get(k)
          if (list) list.push(i)
          else this.cells.set(k, [i])
        }
      }
    })
  }
  private ix(x: number) {
    return Math.max(0, Math.min(this.nx - 1, Math.floor((x - this.x0) / this.cell)))
  }
  private iy(y: number) {
    return Math.max(0, Math.min(this.ny - 1, Math.floor((y - this.y0) / this.cell)))
  }
  /** The smallest `dist` over the edges whose cells the box touches; stops looking where `limit` rules the rest out. */
  min(box: Box, limit: number, dist: (e: Edge) => number): number {
    if (!Number.isFinite(limit)) {
      let best = Infinity
      for (const e of this.edges) best = Math.min(best, dist(e))
      return best
    }
    const stamp = ++this.stamp
    let best = Infinity
    const ix0 = this.ix(box.minX - limit)
    const ix1 = this.ix(box.maxX + limit)
    const iy0 = this.iy(box.minY - limit)
    const iy1 = this.iy(box.maxY + limit)
    // A box wholly outside the grid still reaches the edge cells next to it when `limit` is long enough; clamping the cells covers that.
    for (let x = ix0; x <= ix1; x++) {
      for (let y = iy0; y <= iy1; y++) {
        for (const i of this.cells.get(y * this.nx + x) ?? []) {
          if (this.seen[i] === stamp) continue
          this.seen[i] = stamp
          const d = dist(this.edges[i])
          if (d < best) best = d
        }
      }
    }
    return best <= limit ? best : Infinity
  }
}

const cache = new WeakMap<object, OutlineGeometry>()

/** The geometry of a board's outline, kept with the outline object (an edit makes a new one). Null for a board with no outline. */
export function outlineGeometry(b: Pick<BoardDef, "outline">): OutlineGeometry | null {
  const outline = b.outline
  if (!outline || !outline.paths.length) return null
  const hit = cache.get(outline)
  if (hit) return hit
  const g = build(outline.paths)
  cache.set(outline, g)
  return g
}

function build(paths: ShapePath[]): OutlineGeometry {
  const edges: Edge[] = []
  const closed: { pts: Vec2[]; path: number; box: Box; area: number }[] = []
  paths.forEach((path, index) => {
    const pts = flattenPath(path, FLATTEN_TOLERANCE)
    if (pts.length < 2) return
    const n = path.closed ? pts.length : pts.length - 1
    for (let i = 0; i < n; i++) edges.push([pts[i], pts[(i + 1) % pts.length]])
    if (path.closed && pts.length >= 3) {
      const b = emptyBox()
      for (const p of pts) expandBox(b, p)
      closed.push({ pts, path: index, box: b, area: Math.abs(signedArea(pts)) })
    }
  })
  const box = pathsBox(paths)
  // Nesting: a loop's parent is the smallest loop that holds it; loops an even number deep are board, an odd number deep holes.
  closed.sort((a, b) => b.area - a.area)
  const depth = new Array<number>(closed.length).fill(0)
  const parent = new Array<number>(closed.length).fill(-1)
  closed.forEach((r, i) => {
    const probe = r.pts[0]
    for (let j = i - 1; j >= 0; j--) {
      if (closed[j].box.minX <= probe.x && probe.x <= closed[j].box.maxX && closed[j].box.minY <= probe.y && probe.y <= closed[j].box.maxY && pointInRing(probe, closed[j].pts)) {
        parent[i] = j
        depth[i] = depth[j] + 1
        break
      }
    }
  })
  const regions: OutlineRegion[] = []
  const regionIndex: number[] = []
  closed.forEach((_, i) => {
    if (depth[i] % 2 === 0) {
      regionIndex[i] = regions.length
      regions.push({ outer: [], holes: [] })
    } else regionIndex[i] = regionIndex[parent[i]]
  })
  const rings: OutlineRing[] = closed.map((r, i) => {
    const hole = depth[i] % 2 === 1
    const ccw = signedArea(r.pts) > 0
    const pts = ccw === !hole ? r.pts : [...r.pts].reverse()
    const region = regions[regionIndex[i]]
    if (hole) region.holes.push(pts)
    else region.outer = pts
    return { pts, hole, path: r.path, region: regionIndex[i], box: r.box, area: r.area }
  })
  const index = new EdgeIndex(edges, box)
  const state: OutlineState = paths.some((p) => !p.closed) ? "open" : "closed"
  const g: OutlineGeometry = {
    state,
    rings,
    regions,
    edges,
    box,
    contains(p) {
      if (!rings.length) return false
      let inside = false
      for (const r of rings) if (r.box.minX <= p.x && p.x <= r.box.maxX && r.box.minY <= p.y && p.y <= r.box.maxY && pointInRing(p, r.pts)) inside = !inside
      return inside
    },
    nearest(p, limit = Infinity) {
      return index.min({ minX: p.x, maxX: p.x, minY: p.y, maxY: p.y }, limit, ([a, b]) => pointSegmentDistance(p, a, b))
    },
    nearestToSegment(a, b, limit = Infinity) {
      return index.min({ minX: Math.min(a.x, b.x), maxX: Math.max(a.x, b.x), minY: Math.min(a.y, b.y), maxY: Math.max(a.y, b.y) }, limit, ([c, d]) => segmentSegmentDistance(a, b, c, d))
    },
    signedDistance(p) {
      const d = this.nearest(p)
      return rings.length && !this.contains(p) ? -d : d
    },
  }
  return g
}

/** The geometry's flattened rings as polygons for a clipping or triangulating library: each board piece's outer ring, then its holes. */
export function outlinePolygons(g: OutlineGeometry): Vec2[][][] {
  return g.regions.map((r) => [r.outer, ...r.holes])
}

/**
 * Whether each cell of a grid is on the board: cell `(i, j)` is at `(ox + i * step, oy + j * step)`. Scanline filled with the even-odd rule
 * from the loops, so it costs the cells and the edges once, not a point test per cell.
 */
export function rasterizeInside(g: OutlineGeometry, ox: number, oy: number, nx: number, ny: number, step: number): Uint8Array {
  const out = new Uint8Array(nx * ny)
  const rows: number[][] = Array.from({ length: ny }, () => [])
  for (const r of g.rings) {
    const n = r.pts.length
    for (let i = 0; i < n; i++) {
      const a = r.pts[i]
      const b = r.pts[(i + 1) % n]
      if (a.y === b.y) continue
      const lo = Math.min(a.y, b.y)
      const hi = Math.max(a.y, b.y)
      // The rows whose centre line y = oy + j * step is in [lo, hi): same half-open rule as pointInRing.
      const j0 = Math.max(0, Math.ceil((lo - oy) / step))
      const j1 = Math.min(ny - 1, Math.ceil((hi - oy) / step) - 1)
      for (let j = j0; j <= j1; j++) {
        const y = oy + j * step
        if (y < lo || y >= hi) continue
        rows[j].push(a.x + ((y - a.y) * (b.x - a.x)) / (b.y - a.y))
      }
    }
  }
  for (let j = 0; j < ny; j++) {
    const xs = rows[j].sort((p, q) => p - q)
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const i0 = Math.max(0, Math.ceil((xs[k] - ox) / step))
      const i1 = Math.min(nx - 1, Math.ceil((xs[k + 1] - ox) / step) - 1)
      for (let i = i0; i <= i1; i++) out[j * nx + i] = 1
    }
  }
  return out
}

/**
 * How far a piece of copper is from the board edge: positive on the board, negative where it is off it or the edge cuts across it
 * (`-half`). `edges` is the piece's centre lines (a point is a degenerate one) and `half` its half width. `limit` is how close the answer is
 * wanted: beyond it, `Infinity` for a piece on the board (a piece off the board is always measured).
 */
export function copperEdgeClearance(g: OutlineGeometry, edges: readonly Edge[], half: number, limit = Infinity): number {
  if (!edges.length) return Infinity
  const inside = g.rings.length ? g.contains(edges[0][0]) : true
  let d = Infinity
  for (const [a, b] of edges) {
    const m = a === b || same(a, b) ? g.nearest(a, limit + half) : g.nearestToSegment(a, b, limit + half)
    if (m < d) d = m
    if (d === 0) break
  }
  if (!inside && d === Infinity) {
    for (const [a, b] of edges) d = Math.min(d, g.nearestToSegment(a, b))
  }
  if (d === Infinity) return Infinity
  return inside ? d - half : -d - half
}

// ---------- shape queries used by the editors and the exporters ----------

/** The path a loop is, as the points of its flattened ring (clockwise or counter-clockwise as drawn). */
export const pathPoints = (path: ShapePath, tol = FLATTEN_TOLERANCE): Vec2[] => flattenPath(path, tol)

/** The two ends of an open path. */
export function pathEnds(path: ShapePath): [Vec2, Vec2] | null {
  if (!path.segs.length) return null
  return [segStart(path.segs[0]), segEnd(path.segs[path.segs.length - 1])]
}

/** The box of one path. */
export const pathBox = pathBoxOf

/** Whether a box lies on the board: its corners are on it and no edge cuts across its sides. A board with no loop to say is not asked: it holds the box. */
export function boxOnBoard(g: OutlineGeometry, box: Box): boolean {
  if (!g.rings.length) return true
  const c = [
    { x: box.minX, y: box.minY },
    { x: box.maxX, y: box.minY },
    { x: box.maxX, y: box.maxY },
    { x: box.minX, y: box.maxY },
  ]
  if (!c.every((p) => g.contains(p))) return false
  for (let i = 0; i < 4; i++) if (g.nearestToSegment(c[i], c[(i + 1) % 4], 1e-9) <= 1e-9) return false
  return true
}

/**
 * Boxes that together cover the part of the board's box a part may not stand in: off the board, in a cutout, or within `margin` of an edge.
 * The box is cut into cells (about 64 across), a cell is blocked unless the cell grown by `margin` lies wholly on the board, and a run of
 * blocked cells along a row is one box. Conservative by at most a cell, which is what placement wants.
 */
export function outsideBoxes(g: OutlineGeometry, margin: number): Box[] {
  if (!g.rings.length) return []
  const w = g.box.maxX - g.box.minX
  const h = g.box.maxY - g.box.minY
  const cell = Math.max(0.5, Math.min(2, Math.max(w, h) / 64))
  const nx = Math.max(1, Math.ceil(w / cell))
  const ny = Math.max(1, Math.ceil(h / cell))
  const out: Box[] = []
  for (let j = 0; j < ny; j++) {
    let run: Box | null = null
    for (let i = 0; i < nx; i++) {
      const c = { minX: g.box.minX + i * cell, maxX: g.box.minX + (i + 1) * cell, minY: g.box.minY + j * cell, maxY: g.box.minY + (j + 1) * cell }
      const free = boxOnBoard(g, { minX: c.minX - margin, maxX: c.maxX + margin, minY: c.minY - margin, maxY: c.maxY + margin })
      if (free) {
        if (run) out.push(run)
        run = null
      } else if (run) run.maxX = c.maxX
      else run = c
    }
    if (run) out.push(run)
  }
  return out
}

/** The regions of the board with their rings flattened to `tol` (coarser than the geometry's own), for a format with no arcs: outer counter-clockwise, holes clockwise. */
export function outlineRegionsAt(b: Pick<BoardDef, "outline">, tol: number): OutlineRegion[] {
  const g = outlineGeometry(b)
  if (!g) return []
  const paths = b.outline!.paths
  const ring = (path: number, hole: boolean) => {
    const pts = flattenPath(paths[path], tol)
    return signedArea(pts) > 0 === !hole ? pts : [...pts].reverse()
  }
  return g.regions.map((_, ri) => {
    const mine = g.rings.filter((r) => r.region === ri)
    return { outer: ring(mine.find((r) => !r.hole)!.path, false), holes: mine.filter((r) => r.hole).map((r) => ring(r.path, true)) }
  })
}

/** The area of the board in mm squared: the rectangle's, or the loops' with the cutouts taken out. A board whose outline is not closed has the area of its box. */
export function boardAreaMm2(b: Pick<BoardDef, "outline" | "width" | "height" | "cornerRadius">): number {
  const g = outlineGeometry(b)
  if (!g || !g.rings.length || g.state !== "closed") return b.width * b.height
  return g.regions.reduce((sum, r) => sum + Math.abs(signedArea(r.outer)) - r.holes.reduce((h, ring) => h + Math.abs(signedArea(ring)), 0), 0)
}

/** What a board's outline is, in words: "3 loops, 2 of them cutouts", for the UI and the fabrication notes. Null for a rectangle. */
export function describeOutline(b: Pick<BoardDef, "outline">): string | null {
  if (!b.outline) return null
  const paths = b.outline.paths
  if (!paths.length) return "no outline"
  const g = outlineGeometry(b)
  const holes = g?.rings.filter((r) => r.hole).length ?? 0
  const outers = (g?.rings.length ?? 0) - holes
  const open = paths.filter((p) => !p.closed).length
  const bits = [`${outers} piece${outers === 1 ? "" : "s"} of board`]
  if (holes) bits.push(`${holes} cutout${holes === 1 ? "" : "s"}`)
  if (open) bits.push(`${open} open edge${open === 1 ? "" : "s"}`)
  return bits.join(", ")
}

/** Whether a convex ring (a turned part's courtyard) lies on the board: its corners are on it and no edge cuts across its sides. */
export function ringOnBoard(g: OutlineGeometry, ring: Vec2[]): boolean {
  if (!g.rings.length) return true
  if (!ring.every((p) => g.contains(p))) return false
  for (let i = 0; i < ring.length; i++) if (g.nearestToSegment(ring[i], ring[(i + 1) % ring.length], 1e-9) <= 1e-9) return false
  return true
}

/**
 * How far two convex rings overlap along the direction that frees them soonest (separating axis): positive when they overlap by that much,
 * negative by the gap when they do not touch. For two boxes this is the smaller of the overlaps along x and y.
 */
export function convexOverlap(a: Vec2[], b: Vec2[]): number {
  let least = Infinity
  for (const ring of [a, b]) {
    for (let i = 0; i < ring.length; i++) {
      const p = ring[i]
      const q = ring[(i + 1) % ring.length]
      const nx = q.y - p.y
      const ny = p.x - q.x
      const len = Math.hypot(nx, ny)
      if (len < 1e-12) continue
      const range = (pts: Vec2[]) => {
        let lo = Infinity
        let hi = -Infinity
        for (const v of pts) {
          const d = (v.x * nx + v.y * ny) / len
          lo = Math.min(lo, d)
          hi = Math.max(hi, d)
        }
        return [lo, hi]
      }
      const [alo, ahi] = range(a)
      const [blo, bhi] = range(b)
      least = Math.min(least, Math.min(ahi, bhi) - Math.max(alo, blo))
    }
  }
  return least
}
