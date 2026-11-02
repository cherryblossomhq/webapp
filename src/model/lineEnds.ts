import type { LineEnd, Vec2 } from "./types"

// The shapes KiCad draws at the ends of a line, an arc or a curve (X24), as `LINE_ENDING` (include/line_ending.h and common/line_ending.cpp of KiCad's master) makes them: the board file's "Line ending
// shapes", stamp 20260818, KiCad 11 development (KiCad 10 and 9 have none). An arrow is anchored at the line's end by its tip and a circle or a square is centred on it; the line stops short
// under a closed one (the whole arrow's length, half of a circle's or a square's) so that the line's own width does not show through, and an open arrow does not shorten it. All sizes are mm, y up
// (KiCad's rotation by minus the tangent in its y-down frame is a turn by the tangent in this one; every shape is symmetrical about its axis, so a mirror does not show).

/** The styles KiCad has (`LINE_ENDING_STYLE`); any other word is none. */
export type EndingStyle = "arrow" | "arrow_open" | "circle" | "square"

/** An unset length or width is this many line widths (`DEFAULT_RATIO_LENGTH` and `DEFAULT_RATIO_WIDTH`). */
const AUTO_RATIO = 5
/** The corners of a circle's polygon. */
const CIRCLE_SEGMENTS = 32

export function endingStyle(end: LineEnd | undefined): EndingStyle | null {
  return end && (end.style === "arrow" || end.style === "arrow_open" || end.style === "circle" || end.style === "square") ? end.style : null
}

/** The size an ending is drawn at (`GetEffectiveSize`): length along the line and width across it, an unset one the other's, both unset five line widths. */
function endingSize(end: LineEnd, lineWidth: number): { length: number; width: number } {
  const auto = lineWidth * AUTO_RATIO
  const length = end.length && end.length > 0 ? end.length : end.width && end.width > 0 ? end.width : auto
  const width = end.width && end.width > 0 ? end.width : end.length && end.length > 0 ? end.length : auto
  return { length, width }
}

/** How far the line stops short of the end (`GetShortenDepth`): an arrow's length, half a circle's or a square's, nothing for an open arrow, less half the outline's width where it has one. */
function shortenDepth(end: LineEnd | undefined, lineWidth: number): number {
  const style = endingStyle(end)
  if (!end || !style) return 0
  const { length } = endingSize(end, lineWidth)
  const raw = style === "arrow" ? length : style === "arrow_open" ? 0 : length / 2
  return end.stroke && end.stroke.width > 0 ? Math.max(0, raw - end.stroke.width / 2) : raw
}

/** How far along a curve to look to turn an ending to it (`GetCurveOrientationDepth`): an open arrow's whole length, though it does not shorten the line. */
function orientationDepth(end: LineEnd, lineWidth: number): number {
  return endingStyle(end) === "arrow_open" ? endingSize(end, lineWidth).length : shortenDepth(end, lineWidth)
}

/** The outline of an ending at `at` turned to `tangent` (the direction out of the line, radians): three points for an open arrow, the corners of a closed shape otherwise (`GetShapes`). */
export function endingOutline(end: LineEnd, at: Vec2, tangent: number, lineWidth: number): Vec2[] {
  const style = endingStyle(end)
  if (!style) return []
  const { length, width } = endingSize(end, lineWidth)
  const half = width / 2
  let local: Vec2[]
  switch (style) {
    case "arrow":
      local = [{ x: 0, y: 0 }, { x: -length, y: half }, { x: -length, y: -half }]
      break
    case "arrow_open":
      local = [{ x: -length, y: -half }, { x: 0, y: 0 }, { x: -length, y: half }]
      break
    case "circle":
      local = Array.from({ length: CIRCLE_SEGMENTS }, (_, i) => ({ x: (length / 2) * Math.cos((2 * Math.PI * i) / CIRCLE_SEGMENTS), y: half * Math.sin((2 * Math.PI * i) / CIRCLE_SEGMENTS) }))
      break
    case "square":
      local = [{ x: length / 2, y: half }, { x: length / 2, y: -half }, { x: -length / 2, y: -half }, { x: -length / 2, y: half }]
      break
  }
  const [cos, sin] = [Math.cos(tangent), Math.sin(tangent)]
  return local.map((p) => ({ x: at.x + p.x * cos - p.y * sin, y: at.y + p.x * sin + p.y * cos }))
}

/** A straight line shortened for its ends (`ShortenSegmentForEndings`); null when they take all of it. */
export function shortenSegment(a: Vec2, b: Vec2, start: LineEnd | undefined, end: LineEnd | undefined, lineWidth: number): [Vec2, Vec2] | null {
  const [dx, dy] = [b.x - a.x, b.y - a.y]
  const len = Math.hypot(dx, dy)
  if (len === 0) return [a, b]
  const [s, e] = [shortenDepth(start, lineWidth), shortenDepth(end, lineWidth)]
  if (s + e <= 0) return [a, b]
  if (s + e >= len) return null
  return [{ x: a.x + (dx / len) * s, y: a.y + (dy / len) * s }, { x: b.x - (dx / len) * e, y: b.y - (dy / len) * e }]
}

/** An arc's sweep shortened for its ends (`ShortenArcForEndings`), by length along it: the angle the start moves by and the sweep left, null when they take all of it. `sweep` is signed. */
export function shortenArc(radius: number, sweep: number, start: LineEnd | undefined, end: LineEnd | undefined, lineWidth: number): { startBy: number; sweep: number } | null {
  const [s, e] = [shortenDepth(start, lineWidth), shortenDepth(end, lineWidth)]
  if (radius <= 0 || s + e <= 0) return { startBy: 0, sweep }
  if (s + e >= Math.abs(radius * sweep)) return null
  const sign = sweep > 0 ? 1 : -1
  return { startBy: (sign * s) / radius, sweep: sweep - (sign * (s + e)) / radius }
}

// ---------- curves ----------

export interface Bezier {
  p0: Vec2
  c1: Vec2
  c2: Vec2
  p1: Vec2
}

const at = (b: Bezier, t: number): Vec2 => {
  const u = 1 - t
  return {
    x: u * u * u * b.p0.x + 3 * u * u * t * b.c1.x + 3 * u * t * t * b.c2.x + t * t * t * b.p1.x,
    y: u * u * u * b.p0.y + 3 * u * u * t * b.c1.y + 3 * u * t * t * b.c2.y + t * t * t * b.p1.y,
  }
}

const speed = (b: Bezier, t: number): number => {
  const u = 1 - t
  const d = (k: "x" | "y") => 3 * u * u * (b.c1[k] - b.p0[k]) + 6 * u * t * (b.c2[k] - b.c1[k]) + 3 * t * t * (b.p1[k] - b.c2[k])
  return Math.hypot(d("x"), d("y"))
}

const GAUSS_NODES = [0.0950125098376374, 0.281603550779259, 0.4580167776572274, 0.6178762444026438, 0.755404408355003, 0.8656312023878318, 0.9445750230732326, 0.9894009349916499]
const GAUSS_WEIGHTS = [0.1894506104550685, 0.1826034150449236, 0.1691565193950025, 0.1495959888165767, 0.1246289712555339, 0.0951585116824928, 0.0622535239386479, 0.0271524594117541]

/** The length of a curve between two parameters, by 16-point Gauss-Legendre integration as KiCad does. */
function length(b: Bezier, t0: number, t1: number): number {
  if (t1 <= t0) return 0
  const [half, centre] = [(t1 - t0) / 2, (t0 + t1) / 2]
  let sum = 0
  GAUSS_NODES.forEach((node, i) => {
    const offset = half * node
    sum += GAUSS_WEIGHTS[i] * (speed(b, centre - offset) + speed(b, centre + offset))
  })
  return half * sum
}

/** The parameter at which a curve has the length `target` (`findBezierTAtLength`: 24 bisections). */
function parameterAt(b: Bezier, target: number, total: number): number {
  if (target <= 0) return 0
  if (target >= total) return 1
  let [low, high] = [0, 1]
  for (let i = 0; i < 24; i++) {
    const mid = (low + high) / 2
    if (length(b, 0, mid) < target) low = mid
    else high = mid
  }
  return (low + high) / 2
}

/** The part of a curve between two parameters, as a curve (`BEZIER::SubCurve`). */
function subCurve(b: Bezier, t0: number, t1: number): Bezier {
  // split at t1, then the first piece at t0 / t1
  const lerp = (p: Vec2, q: Vec2, t: number): Vec2 => ({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t })
  const split = (c: Bezier, t: number): [Bezier, Bezier] => {
    const [a, bb, cc] = [lerp(c.p0, c.c1, t), lerp(c.c1, c.c2, t), lerp(c.c2, c.p1, t)]
    const [d, e] = [lerp(a, bb, t), lerp(bb, cc, t)]
    const f = lerp(d, e, t)
    return [{ p0: c.p0, c1: a, c2: d, p1: f }, { p0: f, c1: e, c2: cc, p1: c.p1 }]
  }
  const head = t1 >= 1 ? b : split(b, t1)[0]
  return t0 <= 0 ? head : split(head, t0 / (t1 >= 1 ? 1 : t1))[1]
}

/** A curve shortened for its ends (`ShortenedBezierCurve`), by length along it; null when they take all of it. */
export function shortenCurve(b: Bezier, start: LineEnd | undefined, end: LineEnd | undefined, lineWidth: number): Bezier | null {
  const [s, e] = [shortenDepth(start, lineWidth), shortenDepth(end, lineWidth)]
  if (s <= 0 && e <= 0) return b
  const total = length(b, 0, 1)
  if (total <= 0 || s + e >= total) return null
  const [t0, t1] = [parameterAt(b, s, total), parameterAt(b, total - e, total)]
  return t1 <= t0 ? null : subCurve(b, t0, t1)
}

/** The direction out of each end of a curve (`GetEndingTangents`, a curve): from where the shortened curve starts to the end, from where the end of an open arrow's own length along the curve is. */
export function curveTangents(b: Bezier, start: LineEnd | undefined, end: LineEnd | undefined, lineWidth: number): [number, number] {
  const shortened = shortenCurve(b, start, end, lineWidth)
  const angle = (from: Vec2, to: Vec2) => Math.atan2(to.y - from.y, to.x - from.x)
  const same = (p: Vec2, q: Vec2) => p.x === q.x && p.y === q.y
  const fallbackStart = same(b.p0, b.c1) ? (same(b.p0, b.c2) ? 0 : angle(b.c2, b.p0)) : angle(b.c1, b.p0)
  const fallbackEnd = same(b.p1, b.c2) ? (same(b.p1, b.c1) ? 0 : angle(b.c1, b.p1)) : angle(b.c2, b.p1)
  let startTangent = shortened && !same(shortened.p0, b.p0) ? angle(shortened.p0, b.p0) : fallbackStart
  let endTangent = shortened && !same(shortened.p1, b.p1) ? angle(shortened.p1, b.p1) : fallbackEnd
  // an open arrow does not shorten the curve but is turned to it as far along it as it is long
  const total = length(b, 0, 1)
  const flex = (ending: LineEnd | undefined, first: boolean): number | null => {
    if (!ending || endingStyle(ending) !== "arrow_open") return null
    const depth = orientationDepth(ending, lineWidth)
    if (depth <= 0 || total <= 0) return null
    const along = Math.min(depth, total)
    const sample = at(b, parameterAt(b, first ? along : total - along, total))
    const endpoint = first ? b.p0 : b.p1
    return same(sample, endpoint) ? null : angle(sample, endpoint)
  }
  startTangent = flex(start, true) ?? startTangent
  endTangent = flex(end, false) ?? endTangent
  return [startTangent, endTangent]
}
