import type { Box } from "../../lib/geometry"
import { nodeX, nodeY } from "./space"
import { DIRS, VEC, type Dir } from "./shapes"

// Shortest orthogonal wire on the grid, by A*, with a cost for every bend: what a person draws
// between two pins. The caller says which grid points are taken; a wire never crosses another
// net's, never touches another net's pin, and leaves and enters pins straight along them.

/** A bend costs as much as this many grid steps. */
export const BEND = 2

export interface RouteTarget {
  /** Which way the last step may go: any way, or only across ("h") or up and down ("v"). */
  arrive: "any" | "h" | "v"
  /** A pin to step into after reaching this point, and the way that step goes. */
  then?: { x: number; y: number; dir: Dir }
}

/** Where a wire may leave from: a pin's end or a point on a wire, and the way its first step goes. */
export interface RouteStart {
  x: number
  y: number
  dir: Dir
}

export interface RouteQuery {
  from: RouteStart[]
  targets: Map<number, RouteTarget>
  /** True for a grid point the wire may not pass. Targets are never asked. */
  blocked: (x: number, y: number) => boolean
  /** Extra cost for passing a point, e.g. next to another wire. */
  penalty?: (x: number, y: number) => number
  /** The wire stays inside this box. */
  limit: Box
  /** Give up past this cost. */
  maxCost: number
}

export interface Route {
  /** Every grid point it runs through, in order, from where it leaves to where it lands. */
  nodes: [number, number][]
  cost: number
}

export class Heap {
  private f: number[] = []
  private id: number[] = []
  private less(i: number, j: number) {
    return this.f[i] < this.f[j] || (this.f[i] === this.f[j] && this.id[i] < this.id[j])
  }
  private swap(i: number, j: number) {
    ;[this.f[i], this.f[j]] = [this.f[j], this.f[i]]
    ;[this.id[i], this.id[j]] = [this.id[j], this.id[i]]
  }
  push(f: number, id: number) {
    this.f.push(f)
    this.id.push(id)
    let i = this.f.length - 1
    while (i > 0) {
      const p = (i - 1) >> 1
      if (!this.less(i, p)) break
      this.swap(i, p)
      i = p
    }
  }
  pop(): [number, number] | undefined {
    if (!this.f.length) return undefined
    const top: [number, number] = [this.f[0], this.id[0]]
    const lf = this.f.pop()!
    const lid = this.id.pop()!
    if (this.f.length) {
      this.f[0] = lf
      this.id[0] = lid
      let i = 0
      for (;;) {
        const l = 2 * i + 1
        const r = l + 1
        let m = i
        if (l < this.f.length && this.less(l, m)) m = l
        if (r < this.f.length && this.less(r, m)) m = r
        if (m === i) break
        this.swap(i, m)
        i = m
      }
    }
    return top
  }
  get size() {
    return this.f.length
  }
}

const MAX_EXPANSIONS = 3000

/**
 * Search state kept between searches, grown as needed, rather than allocated and filled for each:
 * Tidy asks for thousands of short searches. A cell or state counts as unseen unless stamped with
 * the current search's number.
 */
const pool = {
  size: 0,
  gen: 0,
  blockedAt: new Uint8Array(0),
  extra: new Float32Array(0),
  cellSeen: new Uint32Array(0),
  g: new Float64Array(0),
  parent: new Int32Array(0),
  stateSeen: new Uint32Array(0),
}

function buffers(cells: number) {
  if (cells > pool.size) {
    const size = Math.max(cells, pool.size * 2, 1024)
    pool.size = size
    pool.blockedAt = new Uint8Array(size)
    pool.extra = new Float32Array(size)
    pool.cellSeen = new Uint32Array(size)
    pool.g = new Float64Array(size * 4)
    pool.parent = new Int32Array(size * 4)
    pool.stateSeen = new Uint32Array(size * 4)
    pool.gen = 0
  }
  pool.gen++
  if (pool.gen >= 0xffffffff) {
    pool.cellSeen.fill(0)
    pool.stateSeen.fill(0)
    pool.gen = 1
  }
  return pool
}
export const routeStats = { calls: 0, found: 0, expansions: 0, failedExpansions: 0, byCost: 0, byLimit: 0, byEmpty: 0, maxCostSum: 0 }

/** The cheapest wire from any start to any target, or null. */
export function route(q: RouteQuery): Route | null {
  // Everything is kept in flat arrays over the window the wire may use.
  const minX = Math.floor(q.limit.minX)
  const minY = Math.floor(q.limit.minY)
  const W = Math.floor(q.limit.maxX) - minX + 1
  const H = Math.floor(q.limit.maxY) - minY + 1
  if (W <= 0 || H <= 0) return null
  const inLimit = (x: number, y: number) => x >= minX && x < minX + W && y >= minY && y < minY + H
  const cell = (x: number, y: number) => (y - minY) * W + (x - minX)

  // Admissible heuristic: distance to the box around the targets.
  let tMinX = Infinity
  let tMinY = Infinity
  let tMaxX = -Infinity
  let tMaxY = -Infinity
  const target = new Map<number, RouteTarget>()
  for (const [k, t] of q.targets) {
    const x = nodeX(k)
    const y = nodeY(k)
    if (!inLimit(x, y)) continue
    target.set(cell(x, y), t)
    tMinX = Math.min(tMinX, x)
    tMaxX = Math.max(tMaxX, x)
    tMinY = Math.min(tMinY, y)
    tMaxY = Math.max(tMaxY, y)
  }
  if (!target.size) return null
  const h = (x: number, y: number) => Math.max(0, tMinX - x, x - tMaxX) + Math.max(0, tMinY - y, y - tMaxY)

  const { blockedAt, extra, g, parent, cellSeen, stateSeen, gen } = buffers(W * H)
  /** What is known of a cell this search: 0 unknown, 1 free, 2 blocked; its penalty, or -1. */
  const seeCell = (c: number) => {
    if (cellSeen[c] === gen) return
    cellSeen[c] = gen
    blockedAt[c] = 0
    extra[c] = -1
  }
  const isBlocked = (x: number, y: number) => {
    if (!inLimit(x, y)) return true
    const c = cell(x, y)
    if (target.has(c)) return false
    seeCell(c)
    let b = blockedAt[c]
    if (!b) blockedAt[c] = b = q.blocked(x, y) ? 2 : 1
    return b === 2
  }
  const penalty = (x: number, y: number) => {
    if (!q.penalty) return 0
    const c = cell(x, y)
    seeCell(c)
    if (extra[c] < 0) extra[c] = q.penalty(x, y)
    return extra[c]
  }
  // A state is a grid point and the way the wire last moved into it; one not reached this search
  // costs infinity.
  const cost = (st: number) => (stateSeen[st] === gen ? g[st] : Infinity)
  const reach = (st: number, value: number, from: number) => {
    stateSeen[st] = gen
    g[st] = value
    parent[st] = from
  }
  /** States a wire starts in, and the point it left from. */
  const origin = new Map<number, [number, number]>()
  const heap = new Heap()
  for (const s of q.from) {
    const [dx, dy] = VEC[s.dir]
    const x = s.x + dx
    const y = s.y + dy
    if (isBlocked(x, y)) continue
    const st = cell(x, y) * 4 + DIRS.indexOf(s.dir)
    if (cost(st) <= 1) continue
    reach(st, 1, -1)
    origin.set(st, [s.x, s.y])
    heap.push(1 + h(x, y), st)
  }
  let best: { s: number; cost: number } | null = null
  let expansions = 0

  while (heap.size) {
    const [f, s] = heap.pop()!
    const sofar = g[s]
    const c = s >> 2
    const d = s & 3
    const x = (c % W) + minX
    const y = Math.floor(c / W) + minY
    if (f > sofar + h(x, y) + 1e-9) continue
    if (best && f >= best.cost) break
    if (sofar > q.maxCost) {
      if (!best) routeStats.byCost++
      break
    }
    if (++expansions > MAX_EXPANSIONS) {
      if (!best) routeStats.byLimit++
      break
    }
    const t = target.get(c)
    if (t) {
      const axis = d === 0 || d === 2 ? "h" : "v"
      if (t.arrive === "any" || t.arrive === axis) {
        // The step into a pin, plus a bend when the wire doesn't already run that way.
        const total = sofar + (t.then ? 1 + (DIRS.indexOf(t.then.dir) === d ? 0 : BEND) : 0)
        if (!best || total < best.cost) best = { s, cost: total }
      }
      continue
    }
    for (let nd = 0; nd < 4; nd++) {
      if (nd === (d + 2) % 4) continue
      const [vx, vy] = VEC[DIRS[nd]]
      const nx = x + vx
      const ny = y + vy
      if (isBlocked(nx, ny)) continue
      const ns = cell(nx, ny) * 4 + nd
      const ng = sofar + 1 + (nd === d ? 0 : BEND) + penalty(nx, ny)
      if (ng < cost(ns)) {
        reach(ns, ng, s)
        heap.push(ng + h(nx, ny), ns)
      }
    }
  }
  routeStats.calls++
  routeStats.maxCostSum += q.maxCost
  if (!best && !heap.size) routeStats.byEmpty++
  routeStats.expansions += expansions
  if (!best) routeStats.failedExpansions += expansions
  if (!best) return null
  routeStats.found++

  const nodes: [number, number][] = []
  let s = best.s
  for (;;) {
    const c = s >> 2
    nodes.push([(c % W) + minX, Math.floor(c / W) + minY])
    if (parent[s] < 0) break
    s = parent[s]
  }
  nodes.push(origin.get(s)!)
  nodes.reverse()
  const last = nodes[nodes.length - 1]
  const t = target.get(cell(last[0], last[1]))!
  if (t.then) nodes.push([t.then.x, t.then.y])
  return { nodes, cost: best.cost }
}

/** The corners of a run of grid points: its ends and where it turns. */
export function corners(nodes: [number, number][]): [number, number][] {
  const out: [number, number][] = []
  for (let i = 0; i < nodes.length; i++) {
    if (i === 0 || i === nodes.length - 1) {
      out.push(nodes[i])
      continue
    }
    const [ax, ay] = nodes[i - 1]
    const [bx, by] = nodes[i]
    const [cx, cy] = nodes[i + 1]
    if ((ax === bx && bx === cx) || (ay === by && by === cy)) continue
    out.push(nodes[i])
  }
  return out
}

/** Every grid point along a run of corners. */
export function along(points: [number, number][]): [number, number][] {
  const out: [number, number][] = []
  for (let i = 0; i < points.length; i++) {
    const [x, y] = points[i]
    if (i === 0) {
      out.push([x, y])
      continue
    }
    const [px, py] = points[i - 1]
    const sx = Math.sign(x - px)
    const sy = Math.sign(y - py)
    let cx = px
    let cy = py
    while (cx !== x || cy !== y) {
      cx += sx
      cy += sy
      out.push([cx, cy])
    }
  }
  return out
}
