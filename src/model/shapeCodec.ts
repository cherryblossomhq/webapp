import { isShapeLayer } from "./shapeLayers"
import { normalizeShape } from "./shapes"
import type { BoardGraphic, BoardShape, ShapeDash, ShapePoint } from "./types"

// How drawings are written in a stored project. A board can have a million of them, and as objects
// (`{"type":"line","a":{"x":..,"y":..},"b":{...},"layer":..}`) each costs 150 to 300 bytes. Stored, they
// are grouped by style, and each drawing is one letter and a flat run of numbers with no id:
//
//     { "g": [ { "l": "F.SilkS", "w": 0.15, "s": ["L", 1, 2, 3, 4, "A", 0, 0, 1, 1, 2, 0] } ],
//       "o": [0, 2],               // the order: group, how many, group, how many...
//       "ids": { "7": "g-abc" } }  // only a drawing whose id is not the default for its place
//
// Only this stored form is compact. In memory a drawing is the object it always was, and reading
// gives back exactly what was written: every number as it was (nothing is rounded here), the
// order, and the ids. A drawing's id is `g<place + 1>` unless the stored form says otherwise, so a
// board brought in from KiCad, whose drawings nothing refers to, stores none; a drawing that something
// refers to (a group of the PCB, in time) or one drawn in the editor keeps its own in `ids`.
//
// Letters (the numbers after each): L line (x1 y1 x2 y2), A arc (start, mid, end: 6), C circle (cx cy r),
// R rectangle (x1 y1 x2 y2), Q rounded rectangle (R and the radius), B curve (4 points: 8), E ellipse
// (cx cy rx ry rot), F elliptical arc (E and from, to), P polygon (rings, then for each ring its
// corner count n, the count k of corners that are arcs, 2n numbers, and k times: the corner's place, mx, my).

export interface ShapeGroup {
  l: string
  w: number
  d?: ShapeDash
  f?: 1
  n?: string
  k?: 1
  s: (string | number)[]
}

export interface CompactShapes {
  g: ShapeGroup[]
  /** Run lengths of the order the drawings were in: a group's number, how many in a row, and so on. Absent for one group. */
  o?: number[]
  /** Stored ids by place, only where the id is not the default. */
  ids?: Record<string, string>
}

/** The id a drawing has when none is stored. */
export const defaultGraphicId = (place: number) => `g${place + 1}`

function tokens(s: BoardShape): (string | number)[] {
  switch (s.type) {
    case "line":
      return ["L", s.a.x, s.a.y, s.b.x, s.b.y]
    case "arc":
      return ["A", s.start.x, s.start.y, s.mid.x, s.mid.y, s.end.x, s.end.y]
    case "circle":
      return ["C", s.c.x, s.c.y, s.r]
    case "rect":
      return s.radius ? ["Q", s.a.x, s.a.y, s.b.x, s.b.y, s.radius] : ["R", s.a.x, s.a.y, s.b.x, s.b.y]
    case "curve":
      return ["B", s.p0.x, s.p0.y, s.c1.x, s.c1.y, s.c2.x, s.c2.y, s.p1.x, s.p1.y]
    case "ellipse":
      return s.from !== undefined && s.to !== undefined ? ["F", s.c.x, s.c.y, s.rx, s.ry, s.rot, s.from, s.to] : ["E", s.c.x, s.c.y, s.rx, s.ry, s.rot]
    case "polygon": {
      const rings = [s.pts, ...(s.holes ?? [])]
      const out: (string | number)[] = ["P", rings.length]
      for (const ring of rings) {
        const arcs = ring.flatMap((p, i) => (p.mid ? [i] : []))
        out.push(ring.length, arcs.length)
        for (const p of ring) out.push(p.x, p.y)
        for (const i of arcs) out.push(i, ring[i].mid!.x, ring[i].mid!.y)
      }
      return out
    }
  }
}

const styleKey = (s: BoardShape) => `${s.layer}|${s.width}|${s.dash ?? ""}|${s.fill ? 1 : 0}|${s.net ?? ""}|${s.locked ? 1 : 0}`

function pack(shapes: BoardShape[], ids?: (place: number) => string | undefined): CompactShapes {
  const groups = new Map<string, { index: number; group: ShapeGroup }>()
  const order: number[] = []
  for (const s of shapes) {
    const key = styleKey(s)
    let g = groups.get(key)
    if (!g) {
      g = { index: groups.size, group: { l: s.layer, w: s.width, ...(s.dash ? { d: s.dash } : {}), ...(s.fill ? { f: 1 as const } : {}), ...(s.net ? { n: s.net } : {}), ...(s.locked ? { k: 1 as const } : {}), s: [] } }
      groups.set(key, g)
    }
    order.push(g.index)
    for (const t of tokens(s)) g.group.s.push(t)
  }
  const out: CompactShapes = { g: [...groups.values()].map((v) => v.group) }
  if (out.g.length > 1) {
    const runs: number[] = []
    for (const gi of order) {
      if (runs.length && runs[runs.length - 2] === gi) runs[runs.length - 1]++
      else runs.push(gi, 1)
    }
    out.o = runs
  }
  if (ids) {
    const stored: Record<string, string> = {}
    for (let place = 0; place < shapes.length; place++) {
      const id = ids(place)
      if (id !== undefined) stored[String(place)] = id
    }
    if (Object.keys(stored).length) out.ids = stored
  }
  return out
}

/** A land's drawings as stored. */
export const packShapes = (shapes: BoardShape[]): CompactShapes => pack(shapes)

/** The board's drawings as stored: an id is kept only where it is not `g<place + 1>`. */
export const packGraphics = (graphics: BoardGraphic[]): CompactShapes =>
  pack(graphics, (place) => (graphics[place].id === defaultGraphicId(place) ? undefined : graphics[place].id))

const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v)

/** One drawing's geometry from the numbers at `at` (a letter first), or null when the run is cut short; and how far it read. */
function read(t: (string | number)[], at: number): { geometry: Record<string, unknown>; next: number } | null {
  const letter = t[at]
  const take = (n: number): number[] | null => {
    const v = t.slice(at + 1, at + 1 + n)
    return v.length === n && v.every(num) ? (v as number[]) : null
  }
  const pt = (x: number, y: number) => ({ x, y })
  switch (letter) {
    case "L": {
      const v = take(4)
      return v && { geometry: { type: "line", a: pt(v[0], v[1]), b: pt(v[2], v[3]) }, next: at + 5 }
    }
    case "A": {
      const v = take(6)
      return v && { geometry: { type: "arc", start: pt(v[0], v[1]), mid: pt(v[2], v[3]), end: pt(v[4], v[5]) }, next: at + 7 }
    }
    case "C": {
      const v = take(3)
      return v && { geometry: { type: "circle", c: pt(v[0], v[1]), r: v[2] }, next: at + 4 }
    }
    case "R": {
      const v = take(4)
      return v && { geometry: { type: "rect", a: pt(v[0], v[1]), b: pt(v[2], v[3]) }, next: at + 5 }
    }
    case "Q": {
      const v = take(5)
      return v && { geometry: { type: "rect", a: pt(v[0], v[1]), b: pt(v[2], v[3]), radius: v[4] }, next: at + 6 }
    }
    case "B": {
      const v = take(8)
      return v && { geometry: { type: "curve", p0: pt(v[0], v[1]), c1: pt(v[2], v[3]), c2: pt(v[4], v[5]), p1: pt(v[6], v[7]) }, next: at + 9 }
    }
    case "E": {
      const v = take(5)
      return v && { geometry: { type: "ellipse", c: pt(v[0], v[1]), rx: v[2], ry: v[3], rot: v[4] }, next: at + 6 }
    }
    case "F": {
      const v = take(7)
      return v && { geometry: { type: "ellipse", c: pt(v[0], v[1]), rx: v[2], ry: v[3], rot: v[4], from: v[5], to: v[6] }, next: at + 8 }
    }
    case "P": {
      const rings = t[at + 1]
      if (!num(rings) || rings < 1) return null
      let i = at + 2
      const out: ShapePoint[][] = []
      for (let r = 0; r < rings; r++) {
        const n = t[i]
        const k = t[i + 1]
        if (!num(n) || !num(k)) return null
        const coords = t.slice(i + 2, i + 2 + 2 * n)
        if (coords.length !== 2 * n || !coords.every(num)) return null
        const ring: ShapePoint[] = []
        for (let c = 0; c < n; c++) ring.push({ x: coords[2 * c] as number, y: coords[2 * c + 1] as number })
        i += 2 + 2 * n
        for (let a = 0; a < k; a++) {
          const [pos, mx, my] = [t[i], t[i + 1], t[i + 2]]
          if (!num(pos) || !num(mx) || !num(my) || pos < 0 || pos >= n) return null
          ring[pos] = { ...ring[pos], mid: pt(mx, my) }
          i += 3
        }
        out.push(ring)
      }
      return { geometry: { type: "polygon", pts: out[0], ...(out.length > 1 ? { holes: out.slice(1) } : {}) }, next: i }
    }
  }
  return null
}

/**
 * The drawings in a stored form, as the objects they were, in their order; a group or a drawing that does not read is dropped (what is damaged is not drawn wrong).
 * `compact` is what `pack` made; `ids` says whether an id is wanted (a board drawing) and how to name the rest.
 */
function unpack(raw: unknown, withIds: boolean): (BoardShape & { id?: string })[] | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null
  const c = raw as Partial<CompactShapes>
  if (!Array.isArray(c.g)) return null
  const lists: BoardShape[][] = c.g.map((g) => {
    const out: BoardShape[] = []
    if (!g || typeof g !== "object" || typeof g.l !== "string" || !Array.isArray(g.s)) return out
    const style = { layer: g.l, width: g.w, ...(g.d ? { dash: g.d } : {}), ...(g.f === 1 ? { fill: true } : {}), ...(typeof g.n === "string" && g.n ? { net: g.n } : {}), ...(g.k === 1 ? { locked: true } : {}) }
    let at = 0
    while (at < g.s.length) {
      const r = read(g.s, at)
      if (!r) break
      const shape = normalizeShape({ ...r.geometry, ...style }, isShapeLayer)
      if (shape) out.push(shape)
      at = r.next
    }
    return out
  })
  // The order: the stored runs, or the groups one after the other when there are none.
  const runs = Array.isArray(c.o) ? c.o : lists.flatMap((_, gi) => [gi, Number.MAX_SAFE_INTEGER])
  const cursor = lists.map(() => 0)
  const shapes: BoardShape[] = []
  for (let i = 0; i + 1 < runs.length; i += 2) {
    const gi = runs[i]
    const n = runs[i + 1]
    if (typeof gi !== "number" || typeof n !== "number" || !lists[gi]) continue
    const take = Math.min(n, lists[gi].length - cursor[gi])
    for (let k = 0; k < take; k++) shapes.push(lists[gi][cursor[gi] + k])
    cursor[gi] += take
  }
  if (!withIds) return shapes
  const ids = c.ids && typeof c.ids === "object" ? c.ids : {}
  return shapes.map((s, place) => ({ ...s, id: typeof ids[String(place)] === "string" && ids[String(place)] ? ids[String(place)] : defaultGraphicId(place) }))
}

/** A land's stored drawings, or null when the field is not in the compact form. */
export const unpackShapes = (raw: unknown): BoardShape[] | null => unpack(raw, false)

/** The board's stored drawings, or null when the field is not in the compact form. */
export const unpackGraphics = (raw: unknown): BoardGraphic[] | null => unpack(raw, true) as BoardGraphic[] | null

/** Whether a stored field is the compact form (an object with groups) rather than a list of drawing objects. */
export const isCompactShapes = (raw: unknown): raw is CompactShapes => !!raw && typeof raw === "object" && !Array.isArray(raw) && Array.isArray((raw as { g?: unknown }).g)
