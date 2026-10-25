import { dist, pointSegmentDistance, round } from "../lib/geometry"
import { arcCircle, flattenSeg, pathsBox, segEnd, segStart, shapePaths, type PathSeg, type ShapePath } from "./shapes"
import { outlineGeometry } from "./outline"
import type { BoardDef, Project, ShapeGeometry, Vec2 } from "./types"

// Edits of a board's outline (X2), as pure functions that return a new project: drawing pieces on Edge.Cuts, joining them into
// loops, moving a vertex, turning an edge into an arc and back, cutting a hole or a slot, and going back to the rectangle. The
// board's box (`width`, `height`, `x`, `y`) follows the outline here, so nothing else has to keep the two in step.

/** Two ends this close are one point when pieces are joined (mm): drawn pieces are snapped, so this is only float noise. */
export const JOIN_EPS = 1e-4

const near = (a: Vec2, b: Vec2, eps = JOIN_EPS) => Math.abs(a.x - b.x) <= eps && Math.abs(a.y - b.y) <= eps

/** The board with its box following its outline: a board with paths has `cornerRadius` 0 and the box of everything drawn. */
export function syncOutlineBox(board: BoardDef): BoardDef {
  const paths = board.outline?.paths
  if (!paths?.length) return board
  const b = pathsBox(paths)
  const next = { ...board, width: round(b.maxX - b.minX), height: round(b.maxY - b.minY), x: round((b.minX + b.maxX) / 2), y: round((b.minY + b.maxY) / 2), cornerRadius: 0 }
  return next.width === board.width && next.height === board.height && next.x === board.x && next.y === board.y && board.cornerRadius === 0 ? board : next
}

const withPaths = (project: Project, paths: ShapePath[]): Project => ({ ...project, board: syncOutlineBox({ ...project.board, outline: { paths } }) })

/** The board's rectangle as an outline path: its corners, and quarter arcs where `cornerRadius` rounds them. */
export function rectPath(b: Pick<BoardDef, "x" | "y" | "width" | "height" | "cornerRadius">): ShapePath {
  const a = { x: b.x - b.width / 2, y: b.y - b.height / 2 }
  const c = { x: b.x + b.width / 2, y: b.y + b.height / 2 }
  const r = Math.max(0, Math.min(b.cornerRadius, b.width / 2, b.height / 2))
  const [path] = shapePaths({ type: "rect", a, b: c, ...(r > 1e-9 ? { radius: r } : {}) })
  return path
}

/** The paths the board is made of: its outline's, or its rectangle when it has none drawn. */
export const outlinePaths = (b: BoardDef): ShapePath[] => (b.outline?.paths.length ? b.outline.paths : [rectPath(b)])

// ---------- one path's pieces ----------

export function reverseSeg(s: PathSeg): PathSeg | null {
  switch (s.kind) {
    case "line":
      return { kind: "line", a: s.b, b: s.a }
    case "arc":
      return { kind: "arc", start: s.end, mid: s.mid, end: s.start }
    case "bezier":
      return { kind: "bezier", p0: s.p1, c1: s.c2, c2: s.c1, p1: s.p0 }
    case "ellipse":
      return null
  }
}

/** A path run the other way, or null when one of its pieces cannot be (an elliptical arc is only held counter-clockwise). */
export function reversePath(p: ShapePath): ShapePath | null {
  const segs: PathSeg[] = []
  for (let i = p.segs.length - 1; i >= 0; i--) {
    const r = reverseSeg(p.segs[i])
    if (!r) return null
    segs.push(r)
  }
  return { closed: p.closed, segs }
}

/** A seg with its start moved to `to` (an elliptical arc has no start of its own to move: it is left). */
function withStart(s: PathSeg, to: Vec2): PathSeg {
  switch (s.kind) {
    case "line":
      return { ...s, a: to }
    case "arc":
      return { ...s, start: to }
    case "bezier":
      return { ...s, p0: to, c1: { x: s.c1.x + to.x - s.p0.x, y: s.c1.y + to.y - s.p0.y } }
    case "ellipse":
      return s
  }
}

function withEnd(s: PathSeg, to: Vec2): PathSeg {
  switch (s.kind) {
    case "line":
      return { ...s, b: to }
    case "arc":
      return { ...s, end: to }
    case "bezier":
      return { ...s, p1: to, c2: { x: s.c2.x + to.x - s.p1.x, y: s.c2.y + to.y - s.p1.y } }
    case "ellipse":
      return s
  }
}

const isFullCircle = (s: PathSeg) => s.kind === "arc" && s.start.x === s.end.x && s.start.y === s.end.y

// ---------- joining pieces into loops ----------

/**
 * The pieces joined end to end into as long paths as they make, a path whose ends meet closed. Pieces already closed stay as they
 * are. A piece that cannot be run the other way (an elliptical arc) is joined only where it already runs the right way.
 */
export function joinPaths(paths: ShapePath[], eps = JOIN_EPS): ShapePath[] {
  const done: ShapePath[] = paths.filter((p) => p.closed)
  let open = paths.filter((p) => !p.closed && p.segs.length)
  const start = (p: ShapePath) => segStart(p.segs[0])
  const end = (p: ShapePath) => segEnd(p.segs[p.segs.length - 1])
  for (let guard = 0; guard < 100000; guard++) {
    let merged = false
    outer: for (let i = 0; i < open.length; i++) {
      const p = open[i]
      if (near(start(p), end(p), eps) && p.segs.length >= 2 - (isFullCircle(p.segs[0]) ? 1 : 0)) {
        // A path that returns to its start is a loop; the last piece is made to end exactly where the first begins.
        const segs = [...p.segs]
        const last = segs.length - 1
        if (start(p).x !== end(p).x || start(p).y !== end(p).y) segs[last] = withEnd(segs[last], start(p))
        done.push({ closed: true, segs })
        open = open.filter((_, k) => k !== i)
        merged = true
        break
      }
      for (let j = 0; j < open.length; j++) {
        if (j === i) continue
        const q = open[j]
        const forms: [ShapePath, ShapePath][] = []
        if (near(end(p), start(q), eps)) forms.push([p, q])
        const pr = near(start(p), start(q), eps) || near(end(p), end(q), eps) ? reversePath(p) : null
        const qr = near(end(p), end(q), eps) ? reversePath(q) : null
        if (near(end(p), end(q), eps) && qr) forms.push([p, qr])
        if (near(start(p), start(q), eps) && pr) forms.push([pr, q])
        if (near(start(p), end(q), eps)) forms.push([q, p])
        const f = forms[0]
        if (!f) continue
        const [a, b] = f
        const segs = [...a.segs, ...b.segs.map((s, k) => (k === 0 ? withStart(s, end(a)) : s))]
        open = open.filter((_, k) => k !== i && k !== j)
        open.push({ closed: false, segs })
        merged = true
        break outer
      }
    }
    if (!merged) break
  }
  return [...done, ...open]
}

// ---------- editing ----------

/** The paths of a board with its rectangle written out as a loop, for edits that add to it. */
export function explicitPaths(project: Project): ShapePath[] {
  return outlinePaths(project.board)
}

/** Whether a board has no outline drawn: it is the rectangle `width` by `height` (an outline with no paths is a board missing its outline, which is a rectangle in the box too). */
export const isPlainBoard = (b: BoardDef) => !b.outline?.paths.length

function ringOf(p: ShapePath): Vec2[] {
  const out: Vec2[] = []
  for (const s of p.segs) out.push(segStart(s))
  return out
}

function pathInsidePath(inner: ShapePath, outer: ShapePath): boolean {
  const g = outlineGeometry({ outline: { paths: [outer] } })
  if (!g) return false
  const pts = [...ringOf(inner)]
  const b = pathsBox([inner])
  pts.push({ x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 })
  return pts.every((q) => g.contains(q) || g.nearest(q) < 1e-9)
}

/**
 * Add drawn pieces to the outline. They join with the open pieces already there and with each other; a path that closes becomes a loop.
 * On a board with no outline drawn, a closed piece that lies inside the rectangle is a cutout of it, and one that does not replaces the
 * rectangle (the board is the drawn shape); an open piece keeps the rectangle and waits to be closed. Returns the project and what happened.
 */
export function addOutlinePaths(project: Project, drawn: ShapePath[]): { project: Project; replacedRectangle: boolean; closedLoops: number; open: number } {
  const plain = isPlainBoard(project.board)
  const existing = plain ? [rectPath(project.board)] : project.board.outline!.paths
  const before = existing.filter((p) => p.closed).length
  let base = existing
  let replaced = false
  if (plain) {
    const closedNew = drawn.filter((p) => p.closed)
    const rect = existing[0]
    const outside = closedNew.filter((p) => !pathInsidePath(p, rect))
    if (outside.length) {
      // The drawn shape is the board now: the rectangle goes, and so do the pieces that would have been cut from it.
      base = []
      replaced = true
    }
  }
  const joined = joinPaths([...base, ...drawn])
  const closedLoops = joined.filter((p) => p.closed).length - (replaced ? 0 : before)
  return { project: withPaths(project, joined), replacedRectangle: replaced, closedLoops: Math.max(0, closedLoops), open: joined.filter((p) => !p.closed).length }
}

/** A drawing's geometry as outline pieces: a line or arc is one open piece; a circle, rectangle or polygon a loop; a polygon with holes, a loop each. */
export function pathsOfShape(shape: ShapeGeometry): ShapePath[] {
  return shapePaths(shape).filter((p) => p.segs.length)
}

export function addOutlineShape(project: Project, shape: ShapeGeometry) {
  return addOutlinePaths(project, pathsOfShape(shape))
}

/** The outline with one path removed (a loop is a hole or the board, as its nesting says); the last path removed leaves the rectangle of the box. */
export function removeOutlinePath(project: Project, index: number): Project {
  const paths = explicitPaths(project)
  if (index < 0 || index >= paths.length) return project
  const rest = paths.filter((_, i) => i !== index)
  if (!rest.length) return resetOutline(project)
  return withPaths(project, rest)
}

/** Back to the rectangle: the outline goes and the board is the box it had. */
export function resetOutline(project: Project, radius = 0): Project {
  const { outline: _outline, ...board } = project.board
  return { ...project, board: { ...board, cornerRadius: radius } }
}

/** A stadium: the slot of `width` between two centres, as a closed loop of two lines and two half circles. */
export function slotPath(a: Vec2, b: Vec2, width: number): ShapePath {
  const r = width / 2
  const L = dist(a, b)
  if (L < 1e-9) {
    const [c] = shapePaths({ type: "circle", c: a, r })
    return c
  }
  const ux = (b.x - a.x) / L
  const uy = (b.y - a.y) / L
  const nx = -uy
  const ny = ux
  const p = (c: Vec2, s: number, t: number): Vec2 => ({ x: c.x + nx * r * s + ux * r * t, y: c.y + ny * r * s + uy * r * t })
  const a1 = p(a, 1, 0)
  const b1 = p(b, 1, 0)
  const b2 = p(b, -1, 0)
  const a2 = p(a, -1, 0)
  return {
    closed: true,
    segs: [
      { kind: "line", a: a2, b: b2 },
      { kind: "arc", start: b2, mid: p(b, 0, 1), end: b1 },
      { kind: "line", a: b1, b: a1 },
      { kind: "arc", start: a1, mid: p(a, 0, -1), end: a2 },
    ],
  }
}

/** Cut a slot into the board. A board with no outline drawn gets its rectangle written out first. */
export function addSlot(project: Project, a: Vec2, b: Vec2, width: number): Project {
  return addOutlinePaths(project, [slotPath(a, b, width)]).project
}

/**
 * The slots the outline holds: cutouts that are a stadium, two parallel lines joined by two half circles (as `slotPath` makes them, or as a
 * footprint draws one on Edge.Cuts), with the centres of their ends and their width. These are what the drill file routes.
 */
export function outlineSlots(paths: ShapePath[]): { path: number; a: Vec2; b: Vec2; width: number }[] {
  const out: { path: number; a: Vec2; b: Vec2; width: number }[] = []
  const g = outlineGeometry({ outline: { paths } })
  paths.forEach((p, i) => {
    if (!p.closed || p.segs.length !== 4 || !g?.rings.find((r) => r.path === i)?.hole) return
    // The pattern is line, arc, line, arc from either piece the path starts at.
    const segs = p.segs[0].kind === "line" ? p.segs : [...p.segs.slice(1), p.segs[0]]
    const [s0, s1, s2, s3] = segs
    if (s0.kind !== "line" || s1.kind !== "arc" || s2.kind !== "line" || s3.kind !== "arc") return
    const c1 = arcCircle(s1.start, s1.mid, s1.end)
    const c2 = arcCircle(s3.start, s3.mid, s3.end)
    if (!c1 || !c2) return
    const tol = 1e-4
    if (Math.abs(c1.r - c2.r) > tol || Math.abs(Math.abs(c1.sweep) - Math.PI) > 1e-4 || Math.abs(Math.abs(c2.sweep) - Math.PI) > 1e-4) return
    // The lines are parallel and run opposite ways, and each end's centre is the middle of the line ends beside it.
    const d0 = { x: s0.b.x - s0.a.x, y: s0.b.y - s0.a.y }
    const d2 = { x: s2.b.x - s2.a.x, y: s2.b.y - s2.a.y }
    if (Math.abs(d0.x * d2.y - d0.y * d2.x) > 1e-6 * Math.hypot(d0.x, d0.y) * Math.hypot(d2.x, d2.y) || d0.x * d2.x + d0.y * d2.y >= 0) return
    const mid = (p: Vec2, q: Vec2): Vec2 => ({ x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 })
    if (dist(c1.c, mid(s0.b, s2.a)) > tol || dist(c2.c, mid(s2.b, s0.a)) > tol) return
    out.push({ path: i, a: c2.c, b: c1.c, width: 2 * c1.r })
  })
  return out
}

// ---------- vertices and arcs ----------

/** The vertices of a path: where one piece ends and the next begins, in order (a closed path has as many as pieces, an open one one more). */
export function pathVertices(p: ShapePath): Vec2[] {
  const v = p.segs.map(segStart)
  if (!p.closed && p.segs.length) v.push(segEnd(p.segs[p.segs.length - 1]))
  return v
}

/** Move one vertex of a path, and with it the ends of the two pieces that meet there. An arc keeps its middle point, so its curve changes. Null when a piece cannot follow (an elliptical arc). */
export function moveOutlineVertex(project: Project, pathIndex: number, vertex: number, to: Vec2): Project | null {
  const paths = explicitPaths(project)
  const p = paths[pathIndex]
  if (!p) return null
  const n = p.segs.length
  const before = p.closed ? (vertex + n - 1) % n : vertex - 1
  const after = vertex < n ? vertex : -1
  if (vertex < 0 || vertex > n || (p.closed && vertex >= n)) return null
  const segs = [...p.segs]
  if (after >= 0) {
    if (segs[after].kind === "ellipse") return null
    segs[after] = withStart(segs[after], to)
  }
  if (before >= 0) {
    if (segs[before].kind === "ellipse") return null
    segs[before] = withEnd(segs[before], to)
  }
  return withPaths(project, paths.map((q, i) => (i === pathIndex ? { ...p, segs } : q)))
}

/** Move an arc's middle point, which is how its curve is dragged. */
export function moveOutlineArcMid(project: Project, pathIndex: number, seg: number, to: Vec2): Project | null {
  const paths = explicitPaths(project)
  const s = paths[pathIndex]?.segs[seg]
  if (!s || s.kind !== "arc" || !arcCircle(s.start, to, s.end)) return null
  return withPaths(project, paths.map((q, i) => (i === pathIndex ? { ...q, segs: q.segs.map((x, k) => (k === seg ? { ...s, mid: to } : x)) } : q)))
}

/** A straight edge turned into an arc bulging a quarter of its length to the left of its direction, or an arc made straight. */
export function toggleOutlineArc(project: Project, pathIndex: number, seg: number): Project | null {
  const paths = explicitPaths(project)
  const p = paths[pathIndex]
  const s = p?.segs[seg]
  if (!p || !s) return null
  let next: PathSeg
  if (s.kind === "line") {
    const L = dist(s.a, s.b)
    if (L < 1e-9) return null
    const m = { x: (s.a.x + s.b.x) / 2 - ((s.b.y - s.a.y) / L) * L * 0.25, y: (s.a.y + s.b.y) / 2 + ((s.b.x - s.a.x) / L) * L * 0.25 }
    next = { kind: "arc", start: s.a, mid: m, end: s.b }
  } else if (s.kind === "arc") next = { kind: "line", a: s.start, b: s.end }
  else return null
  return withPaths(project, paths.map((q, i) => (i === pathIndex ? { ...p, segs: p.segs.map((x, k) => (k === seg ? next : x)) } : q)))
}

/** A piece split in two at the point of it nearest `at` (lines and arcs). */
export function splitOutlineSeg(project: Project, pathIndex: number, seg: number, at: Vec2): Project | null {
  const paths = explicitPaths(project)
  const p = paths[pathIndex]
  const s = p?.segs[seg]
  if (!p || !s) return null
  let pieces: [PathSeg, PathSeg]
  if (s.kind === "line") {
    const dx = s.b.x - s.a.x
    const dy = s.b.y - s.a.y
    const t = Math.max(0.0001, Math.min(0.9999, ((at.x - s.a.x) * dx + (at.y - s.a.y) * dy) / (dx * dx + dy * dy)))
    const m = { x: s.a.x + dx * t, y: s.a.y + dy * t }
    pieces = [{ kind: "line", a: s.a, b: m }, { kind: "line", a: m, b: s.b }]
  } else if (s.kind === "arc") {
    const c = arcCircle(s.start, s.mid, s.end)
    if (!c) return null
    const a = Math.atan2(at.y - c.c.y, at.x - c.c.x)
    let d = (c.ccw ? a - c.a0 : c.a0 - a) % (2 * Math.PI)
    if (d < 0) d += 2 * Math.PI
    const span = Math.abs(c.sweep)
    const u = Math.max(0.0001, Math.min(0.9999, d / span))
    const at1 = (f: number): Vec2 => {
      const ang = c.a0 + Math.sign(c.sweep) * span * f
      return { x: c.c.x + c.r * Math.cos(ang), y: c.c.y + c.r * Math.sin(ang) }
    }
    const m = at1(u)
    pieces = [{ kind: "arc", start: s.start, mid: at1(u / 2), end: m }, { kind: "arc", start: m, mid: at1((1 + u) / 2), end: s.end }]
  } else return null
  const segs = [...p.segs.slice(0, seg), ...pieces, ...p.segs.slice(seg + 1)]
  return withPaths(project, paths.map((q, i) => (i === pathIndex ? { ...p, segs } : q)))
}

/** A circle as a closed outline path (a round board, or a round cutout). */
export function circlePath(c: Vec2, r: number): ShapePath {
  return shapePaths({ type: "circle", c, r })[0]
}

/** Replace the whole outline. */
export function setOutlinePaths(project: Project, paths: ShapePath[]): Project {
  if (!paths.length) return resetOutline(project)
  return withPaths(project, paths)
}

const flatCache = new WeakMap<PathSeg, Vec2[]>()
const flatOf = (s: PathSeg): Vec2[] => {
  let f = flatCache.get(s)
  if (!f) flatCache.set(s, (f = flattenSeg(s, 0.01)))
  return f
}

/** Which piece of which path is nearest `at`, and how far: for picking. Flattened coarsely and kept per piece, so it is cheap on every pointer move. */
export function nearestOutlineSeg(paths: ShapePath[], at: Vec2): { path: number; seg: number; distance: number } | null {
  let best: { path: number; seg: number; distance: number } | null = null
  paths.forEach((p, pi) => {
    p.segs.forEach((s, si) => {
      const pts = flatOf(s)
      for (let i = 1; i < pts.length; i++) {
        const d = pointSegmentDistance(at, pts[i - 1], pts[i])
        if (!best || d < best.distance) best = { path: pi, seg: si, distance: d }
      }
    })
  })
  return best
}

/** A path moved by (dx, dy): a cutout or a piece of board dragged. */
export function translateOutlinePath(project: Project, pathIndex: number, dx: number, dy: number): Project {
  const paths = explicitPaths(project)
  const p = paths[pathIndex]
  if (!p) return project
  const mv = (q: Vec2): Vec2 => ({ x: q.x + dx, y: q.y + dy })
  const segs = p.segs.map((s): PathSeg => {
    switch (s.kind) {
      case "line":
        return { kind: "line", a: mv(s.a), b: mv(s.b) }
      case "arc":
        return { kind: "arc", start: mv(s.start), mid: mv(s.mid), end: mv(s.end) }
      case "bezier":
        return { kind: "bezier", p0: mv(s.p0), c1: mv(s.c1), c2: mv(s.c2), p1: mv(s.p1) }
      case "ellipse":
        return { ...s, c: mv(s.c) }
    }
  })
  return withPaths(project, paths.map((q, i) => (i === pathIndex ? { ...p, segs } : q)))
}

/** The selection id of a piece of the outline: `o:<path>:<piece>`. */
export const outlineSelectionId = (path: number, seg: number) => `o:${path}:${seg}`

/** The path and piece an outline selection id names, or null. */
export function parseOutlineSelectionId(id: string): { path: number; seg: number } | null {
  const m = /^o:(\d+):(\d+)$/.exec(id)
  return m ? { path: Number(m[1]), seg: Number(m[2]) } : null
}
