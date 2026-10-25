import { ellipsePoint, segEnd, segStart, type PathSeg, type ShapePath } from "./shapes"
import type { BoardOutline, Vec2 } from "./types"

// A board outline stored compactly. A board brought in from KiCad can have thousands of edges, and as objects each costs 100 to 200
// bytes against the project's 900 KB limit. The stored form is one flat array per path: `"c"` (closed) or `"o"` (open), the first
// point, then each piece as a letter and the numbers it needs after its start, which is where the piece before it ended:
//
//   L x y                          a straight piece
//   A mx my x y                    an arc through (mx, my) to (x, y)
//   B c1x c1y c2x c2y x y          a cubic curve
//   E cx cy rx ry rot t0 t1        an elliptical arc (radians), whose start is the point before it
//
// Every number is as the outline has it, so a round trip gives the same outline.

export type PackedOutline = (string | number)[][]

export function packOutline(outline: BoardOutline): PackedOutline {
  return outline.paths.map((p) => {
    const out: (string | number)[] = [p.closed ? "c" : "o"]
    if (!p.segs.length) return out
    const s0 = segStart(p.segs[0])
    out.push(s0.x, s0.y)
    for (const s of p.segs) {
      switch (s.kind) {
        case "line":
          out.push("L", s.b.x, s.b.y)
          break
        case "arc":
          out.push("A", s.mid.x, s.mid.y, s.end.x, s.end.y)
          break
        case "bezier":
          out.push("B", s.c1.x, s.c1.y, s.c2.x, s.c2.y, s.p1.x, s.p1.y)
          break
        case "ellipse":
          out.push("E", s.c.x, s.c.y, s.rx, s.ry, s.rot, s.t0, s.t1)
          break
      }
    }
    return out
  })
}

const NUMBERS: Record<string, number> = { L: 2, A: 4, B: 6, E: 7 }

/** The outline a stored form describes, or null when it is not one (a damaged path is dropped, the rest kept). */
export function unpackOutline(raw: unknown): BoardOutline | null {
  if (!Array.isArray(raw)) return null
  const paths: ShapePath[] = []
  for (const item of raw) {
    if (!Array.isArray(item) || (item[0] !== "c" && item[0] !== "o")) continue
    const segs: PathSeg[] = []
    let ok = true
    let i = 1
    let cur: Vec2 | null = null
    if (item.length > 1) {
      if (typeof item[1] !== "number" || typeof item[2] !== "number" || !Number.isFinite(item[1]) || !Number.isFinite(item[2])) continue
      cur = { x: item[1], y: item[2] }
      i = 3
    }
    while (i < item.length && ok && cur) {
      const op = item[i]
      const n = typeof op === "string" ? NUMBERS[op] : undefined
      if (n === undefined || i + n > item.length - 1) {
        ok = false
        break
      }
      const v = item.slice(i + 1, i + 1 + n)
      if (v.length !== n || v.some((x) => typeof x !== "number" || !Number.isFinite(x))) {
        ok = false
        break
      }
      const q = v as number[]
      let seg: PathSeg
      switch (op) {
        case "L":
          seg = { kind: "line", a: cur, b: { x: q[0], y: q[1] } }
          break
        case "A":
          seg = { kind: "arc", start: cur, mid: { x: q[0], y: q[1] }, end: { x: q[2], y: q[3] } }
          break
        case "B":
          seg = { kind: "bezier", p0: cur, c1: { x: q[0], y: q[1] }, c2: { x: q[2], y: q[3] }, p1: { x: q[4], y: q[5] } }
          break
        default:
          seg = { kind: "ellipse", c: { x: q[0], y: q[1] }, rx: q[2], ry: q[3], rot: q[4], t0: q[5], t1: q[6] }
          if (!(q[2] > 0 && q[3] > 0)) ok = false
      }
      segs.push(seg)
      cur = seg.kind === "ellipse" ? ellipsePoint(seg.c, seg.rx, seg.ry, seg.rot, seg.t1) : segEnd(seg)
      i += 1 + n
    }
    if (!ok || !segs.length) continue
    paths.push({ closed: item[0] === "c", segs })
  }
  return { paths }
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v)
const point = (v: unknown): Vec2 | null => (v && typeof v === "object" && finite((v as Vec2).x) && finite((v as Vec2).y) ? { x: (v as Vec2).x, y: (v as Vec2).y } : null)

/** The outline of a hand-written file, `{ paths: [{ closed, segs: [...] }] }`: each piece that reads is kept, a path with a piece that does not is dropped. */
export function normalizeOutline(raw: unknown): BoardOutline | null {
  const list = (raw as { paths?: unknown } | null)?.paths
  if (!Array.isArray(list)) return null
  const paths: ShapePath[] = []
  for (const p of list) {
    const segsRaw = (p as { segs?: unknown } | null)?.segs
    if (!Array.isArray(segsRaw) || !segsRaw.length) continue
    const segs: PathSeg[] = []
    for (const s of segsRaw) {
      const o = s as Record<string, unknown>
      if (o?.kind === "line") {
        const a = point(o.a)
        const b = point(o.b)
        if (a && b) segs.push({ kind: "line", a, b })
      } else if (o?.kind === "arc") {
        const a = point(o.start)
        const m = point(o.mid)
        const b = point(o.end)
        if (a && m && b) segs.push({ kind: "arc", start: a, mid: m, end: b })
      } else if (o?.kind === "bezier") {
        const p0 = point(o.p0)
        const c1 = point(o.c1)
        const c2 = point(o.c2)
        const p1 = point(o.p1)
        if (p0 && c1 && c2 && p1) segs.push({ kind: "bezier", p0, c1, c2, p1 })
      } else if (o?.kind === "ellipse") {
        const c = point(o.c)
        if (c && finite(o.rx) && finite(o.ry) && o.rx > 0 && o.ry > 0 && finite(o.rot) && finite(o.t0) && finite(o.t1)) segs.push({ kind: "ellipse", c, rx: o.rx, ry: o.ry, rot: o.rot, t0: o.t0, t1: o.t1 })
      }
    }
    if (segs.length === segsRaw.length) paths.push({ closed: (p as { closed?: unknown }).closed === true, segs })
  }
  return { paths }
}
