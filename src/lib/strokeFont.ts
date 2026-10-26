import { rotate90, round } from "./geometry"
import type { Rotation, Vec2 } from "../model/types"

// Single-stroke sans for silkscreen. Glyphs are centre lines in a 4 x 6 cell: y up, baseline 0,
// cap height 6, x-height 4.2, descenders to -1.5. Bowls are sampled superellipse arcs, which keep
// counters open under a heavy stroke; spines and tails are sampled cubic Béziers.

type Pt = [number, number]
type Stroke = Pt[]
type Glyph = Stroke[]

const CAP = 6
const WIDTH = 4
const ADVANCE = 5
const XH = 4.2
const DESC = -1.5

/** Stems of a normal-width glyph. The side bearings keep a 0.14 x size stroke clear of its neighbours. */
const L = 0.3
const R = 3.7
const MID = 2

/** Superellipse exponent of every bowl: 2 is an ellipse, higher is squarer. */
const SQUARE = 2.5

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
const rad = (deg: number) => (deg * Math.PI) / 180
const deg = (r: number) => (r * 180) / Math.PI
const dist = (a: Pt, b: Pt) => Math.hypot(b[0] - a[0], b[1] - a[1])
const pow = (v: number, k: number) => Math.sign(v) * Math.abs(v) ** k

/**
 * Superellipse arc around (cx, cy) from a0 to a1 degrees, counter-clockwise when a1 > a0.
 * Every quarter point inside the range is a sample, so bowls touch the baseline and cap height exactly.
 */
function arc(cx: number, cy: number, rx: number, ry: number, a0: number, a1: number, e = SQUARE): Stroke {
  const perQuarter = clamp(Math.round(((rx + ry) / 2) * 4), 3, 8)
  const dir = Math.sign(a1 - a0)
  const stops = [a0]
  for (let q = (dir > 0 ? Math.floor(a0 / 90) + 1 : Math.ceil(a0 / 90) - 1) * 90; dir * (a1 - q) > 1e-9; q += dir * 90) stops.push(q)
  stops.push(a1)
  const at = (a: number): Pt => [cx + rx * pow(Math.cos(rad(a)), 2 / e), cy + ry * pow(Math.sin(rad(a)), 2 / e)]
  const out: Stroke = [at(a0)]
  for (let k = 1; k < stops.length; k++) {
    const from = stops[k - 1]
    const span = stops[k] - from
    const n = Math.max(1, Math.ceil((Math.abs(span) / 90) * perQuarter))
    for (let i = 1; i <= n; i++) out.push(at(from + (span * i) / n))
  }
  return out
}

/** Angle in [0, 180] where the upper half of a superellipse arc crosses x. */
const angleAtX = (cx: number, rx: number, x: number, e = SQUARE) => deg(Math.acos(pow(clamp((x - cx) / rx, -1, 1), e / 2)))

/** Angle in [-90, 90] where the right half of a superellipse arc crosses y. */
const angleAtY = (cy: number, ry: number, y: number, e = SQUARE) => deg(Math.asin(pow(clamp((y - cy) / ry, -1, 1), e / 2)))

/** Cubic Bézier, sampled about every 0.35 units. */
function bez(p0: Pt, p1: Pt, p2: Pt, p3: Pt): Stroke {
  const n = clamp(Math.ceil((dist(p0, p1) + dist(p1, p2) + dist(p2, p3)) / 0.35), 3, 14)
  const out: Stroke = []
  for (let i = 0; i <= n; i++) {
    const t = i / n
    const a = (1 - t) ** 3
    const b = 3 * (1 - t) ** 2 * t
    const c = 3 * (1 - t) * t ** 2
    const d = t ** 3
    out.push([a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0], a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1]])
  }
  return out
}

const unit = (from: Pt, to: Pt): Pt => {
  const d = dist(from, to) || 1
  return [(to[0] - from[0]) / d, (to[1] - from[1]) / d]
}

/** Smooth curve from the end of `a` to the start of `b`, leaving and arriving along their tangents. */
function bridge(a: Stroke, b: Stroke, k0 = 0.4, k1 = k0): Stroke {
  const p0 = a[a.length - 1]
  const p3 = b[0]
  const t0 = unit(a[a.length - 2], p0)
  const t1 = unit(p3, b[1])
  const d = dist(p0, p3)
  return bez(p0, [p0[0] + t0[0] * d * k0, p0[1] + t0[1] * d * k0], [p3[0] - t1[0] * d * k1, p3[1] - t1[1] * d * k1], p3)
}

/** Smooth curve from the end of `a` to `end`, arriving along `dir`. */
function curveTo(a: Stroke, end: Pt, dir: Pt, k0 = 0.4, k1 = k0): Stroke {
  return bridge(a, [end, [end[0] + dir[0], end[1] + dir[1]]], k0, k1)
}

/** Concatenate points and point runs into one polyline, dropping repeated points. */
function path(...parts: (Pt | Stroke)[]): Stroke {
  const out: Stroke = []
  for (const part of parts) {
    for (const p of typeof part[0] === "number" ? [part as Pt] : (part as Stroke)) {
      const last = out[out.length - 1]
      if (!last || dist(last, p) > 1e-6) out.push(p)
    }
  }
  return out
}

const mapGlyph = (g: Glyph, f: (p: Pt) => Pt): Glyph => g.map((s) => s.map(f))
/** Mirror left to right within the cell. */
const flipX = (g: Glyph) => mapGlyph(g, ([x, y]) => [WIDTH - x, y])
/** Turn 180° about the centre of a cell of height h. */
const turn = (g: Glyph, h: number) => mapGlyph(g, ([x, y]) => [WIDTH - x, h - y])
/** A dot: a stroke just long enough to draw as a round blob everywhere. */
const dot = (x: number, y: number): Stroke => [
  [x, y],
  [x, y + 0.12],
]

// ---- shared shapes ----

/** Closed bowl filling the box. */
const ring = (x0: number, y0: number, x1: number, y1: number) =>
  arc((x0 + x1) / 2, (y0 + y1) / 2, (x1 - x0) / 2, (y1 - y0) / 2, 90, 450)

/** S curve: a small upper bowl, a diagonal spine and a larger lower bowl. */
function sCurve(x0: number, x1: number, y0: number, y1: number): Stroke {
  const h = y1 - y0
  const mid = y0 + h * 0.52
  const cx = (x0 + x1) / 2
  const w = (x1 - x0) / 2
  const top = arc(cx, (mid + y1) / 2, w * 0.94, (y1 - mid) / 2, 32, 202)
  const bottom = arc(cx, (y0 + mid) / 2, w, (mid - y0) / 2, 22, -148)
  return path(top, bridge(top, bottom, 0.38), bottom)
}

/** Lowercase bowl joined to a stem at x = stem, spanning y0..y1 and reaching x = far on the open side. */
function stemBowl(stem: number, far: number, y0: number, y1: number): Stroke {
  // The superellipse continues a little past the stem so the bowl meets it at an angle, like a pen stroke.
  const right = far > stem
  const span = Math.abs(far - stem) + 0.32
  const rx = span / 2
  const cx = right ? far - rx : far + rx
  const cy = (y0 + y1) / 2
  const ry = (y1 - y0) / 2
  const a = angleAtX(cx, rx, stem)
  return right ? arc(cx, cy, rx, ry, a, -a) : arc(cx, cy, rx, ry, a, 360 - a)
}

/** n-style arch from a stem at x = stem over to a leg at x = leg, top at y1, the leg straight below y = shoulder. */
function arch(stem: number, leg: number, shoulder: number, y1: number): Stroke {
  const span = leg - stem + 0.32
  const rx = span / 2
  const cx = leg - rx
  return path(arc(cx, shoulder, rx, y1 - shoulder, angleAtX(cx, rx, stem), 0), [leg, 0])
}

const O = ring(L, 0, R, CAP)

/** P: stem, flat-topped bowl down to y = 2.75. The R adds a leg. */
const P: Glyph = (() => {
  const ry = (CAP - 2.75) / 2
  const xs = R - ry * 1.08
  return [path([L, 0], [L, CAP], [xs, CAP], arc(xs, CAP - ry, R - xs, ry, 90, -90), [L, 2.75])]
})()

/** The 6, also turned to make the 9: a tall arc down the left into a closed lower bowl. */
const SIX: Glyph = (() => {
  const bowl = arc(MID, 1.95, 1.68, 1.95, 180, 530)
  const top = arc(MID, 3, 1.68, 3, 50, 180)
  return [path(top, bowl)]
})()

const QUESTION: Stroke = (() => {
  const top = arc(MID, 4.4, 1.55, 1.6, 158, -42)
  return path(top, curveTo(top, [MID, 2.0], [0, -1], 0.35, 0.3), [MID, 1.75])
})()

const TWO_TOP = arc(MID, 4.3, 1.62, 1.7, 160, -12)

const N_LOWER: Glyph = [
  [
    [L, XH],
    [L, 0],
  ],
  arch(L, R, 2.4, XH),
]
const PAREN: Glyph = [bez([2.9, CAP], [1.35, 4.7], [1.35, 0.4], [2.9, -0.9])]
const BRACKET: Glyph = [
  [
    [2.9, CAP],
    [1.55, CAP],
    [1.55, -0.9],
    [2.9, -0.9],
  ],
]
const BRACE: Glyph = [
  path(
    arc(2.9, 5.15, 0.85, 0.85, 90, 180, 2),
    arc(1.2, 3.4, 0.85, 0.85, 0, -90, 2),
    arc(1.2, 1.7, 0.85, 0.85, 90, 0, 2),
    arc(2.9, -0.05, 0.85, 0.85, 180, 270, 2),
  ),
]
const LESS: Glyph = [
  [
    [3.5, 5.3],
    [0.5, 2.95],
    [3.5, 0.6],
  ],
]
const SLASH: Glyph = [
  [
    [0.5, -0.5],
    [3.5, CAP],
  ],
]

const GLYPHS: Record<string, Glyph> = {
  " ": [],

  // ---- capitals ----
  A: [
    [
      [0.2, 0],
      [MID, CAP],
      [3.8, 0],
    ],
    [
      [0.8, 1.95],
      [3.2, 1.95],
    ],
  ],
  B: [
    path(
      [L, 3.15],
      [1.95, 3.15],
      arc(1.95, 1.575, 1.75, 1.575, 90, -90),
      [L, 0],
      [L, CAP],
      [1.9, CAP],
      arc(1.9, 4.575, 1.55, 1.425, 90, -90),
    ),
  ],
  C: [arc(2.05, 3, 1.75, 3, 44, 316)],
  D: [path([L, 0], [L, CAP], [1.35, CAP], arc(1.35, 3, R - 1.35, 3, 90, -90), [L, 0])],
  E: [
    [
      [3.55, CAP],
      [L, CAP],
      [L, 0],
      [3.6, 0],
    ],
    [
      [L, 3.1],
      [3.2, 3.1],
    ],
  ],
  F: [
    [
      [3.55, CAP],
      [L, CAP],
      [L, 0],
    ],
    [
      [L, 3.1],
      [3.2, 3.1],
    ],
  ],
  G: (() => {
    const a = arc(2.05, 3, 1.7, 3, 44, 360 + angleAtY(3, 3, 2.75))
    return [path(a, [2.2, 2.75])]
  })(),
  H: [
    [
      [L, 0],
      [L, CAP],
    ],
    [
      [R, 0],
      [R, CAP],
    ],
    [
      [L, 3.1],
      [R, 3.1],
    ],
  ],
  I: [
    [
      [1.05, CAP],
      [2.95, CAP],
    ],
    [
      [MID, CAP],
      [MID, 0],
    ],
    [
      [1.05, 0],
      [2.95, 0],
    ],
  ],
  J: [path([3.4, CAP], [3.4, 1.75], arc(1.85, 1.75, 1.55, 1.75, 0, -160))],
  K: [
    [
      [L, 0],
      [L, CAP],
    ],
    [
      [3.65, CAP],
      [L, 2.1],
    ],
    [
      [1.45, 3.4],
      [3.75, 0],
    ],
  ],
  L: [
    [
      [L, CAP],
      [L, 0],
      [3.55, 0],
    ],
  ],
  M: [
    [
      [0.2, 0],
      [0.2, CAP],
      [MID, 1.7],
      [3.8, CAP],
      [3.8, 0],
    ],
  ],
  N: [
    [
      [L, 0],
      [L, CAP],
      [R, 0],
      [R, CAP],
    ],
  ],
  O: [O],
  P,
  Q: [
    O,
    [
      [2.35, 1.35],
      [3.85, -0.35],
    ],
  ],
  R: [
    ...P,
    [
      [1.9, 2.75],
      [3.75, 0],
    ],
  ],
  S: [sCurve(0.35, 3.65, 0, CAP)],
  T: [
    [
      [0.2, CAP],
      [3.8, CAP],
    ],
    [
      [MID, CAP],
      [MID, 0],
    ],
  ],
  U: [path([L, CAP], arc(MID, 1.8, R - MID, 1.8, 180, 360), [R, CAP])],
  V: [
    [
      [0.2, CAP],
      [MID, 0],
      [3.8, CAP],
    ],
  ],
  W: [
    [
      [0.05, CAP],
      [1.0, 0],
      [MID, 4.3],
      [3.0, 0],
      [3.95, CAP],
    ],
  ],
  X: [
    [
      [0.3, 0],
      [3.7, CAP],
    ],
    [
      [0.3, CAP],
      [3.7, 0],
    ],
  ],
  Y: [
    [
      [0.2, CAP],
      [MID, 2.9],
      [3.8, CAP],
    ],
    [
      [MID, 2.9],
      [MID, 0],
    ],
  ],
  Z: [
    [
      [0.4, CAP],
      [3.6, CAP],
      [0.35, 0],
      [3.65, 0],
    ],
  ],

  // ---- figures ----
  "0": [ring(0.45, 0, 3.55, CAP)],
  "1": [
    [
      [0.8, 4.75],
      [2.4, CAP],
      [2.4, 0],
    ],
  ],
  "2": [path(TWO_TOP, curveTo(TWO_TOP, [0.35, 0], [-0.55, -0.83], 0.45, 0.35), [3.65, 0])],
  "3": [
    path(arc(1.95, 4.6, 1.5, 1.4, 152, -90), [1.2, 3.2]),
    path([1.95, 3.2], arc(1.95, 1.6, 1.72, 1.6, 90, -152)),
  ],
  "4": [
    [
      [2.85, 0],
      [2.85, CAP],
      [0.3, 1.65],
      [3.75, 1.65],
    ],
  ],
  "5": (() => {
    const bowl = arc(1.95, 1.95, 1.72, 1.95, 128, -150)
    return [path([3.45, CAP], [bowl[0][0] - 0.05, CAP], bowl)]
  })(),
  "6": SIX,
  "7": [
    [
      [0.35, CAP],
      [3.65, CAP],
      [1.35, 0],
    ],
  ],
  "8": [arc(MID, 4.6, 1.42, 1.4, -90, 270), arc(MID, 1.6, 1.68, 1.6, 90, 450)],
  "9": turn(SIX, CAP),

  // ---- lowercase ----
  a: (() => {
    const stem = 3.55
    const hood = arc(1.95, 2.9, stem - 1.95, XH - 2.9, 0, 152)
    return [path(hood.slice().reverse(), [stem, 0]), stemBowl(stem, 0.4, 0, 2.5)]
  })(),
  b: [
    [
      [L, CAP],
      [L, 0],
    ],
    stemBowl(L, R, 0, XH),
  ],
  c: [arc(2.05, XH / 2, 1.68, XH / 2, 46, 314)],
  d: [
    [
      [R, CAP],
      [R, 0],
    ],
    stemBowl(R, L, 0, XH),
  ],
  e: (() => {
    const bar = 2.2
    return [path([L, bar], [R, bar], arc(MID, XH / 2, R - MID, XH / 2, angleAtY(XH / 2, XH / 2, bar), 316))]
  })(),
  f: [
    path([1.55, 0], [1.55, 4.85], arc(2.7, 4.85, 1.15, 1.15, 180, 48)),
    [
      [0.45, XH],
      [3.25, XH],
    ],
  ],
  g: [
    path([R, XH], [R, -0.15], arc(1.95, -0.15, R - 1.95, 1.35, 0, -158)),
    stemBowl(R, L, 0.1, XH),
  ],
  h: [
    [
      [L, CAP],
      [L, 0],
    ],
    arch(L, R, 2.4, XH),
  ],
  i: [
    [
      [0.95, XH],
      [2.05, XH],
      [2.05, 0],
    ],
    [
      [0.75, 0],
      [3.35, 0],
    ],
    dot(2.05, 5.7),
  ],
  j: [path([1.25, XH], [2.6, XH], [2.6, -0.45], arc(1.55, -0.45, 1.05, 1.05, 0, -165)), dot(2.6, 5.7)],
  k: [
    [
      [L, CAP],
      [L, 0],
    ],
    [
      [3.45, XH],
      [L, 1.35],
    ],
    [
      [1.4, 2.35],
      [3.65, 0],
    ],
  ],
  l: [path([0.95, CAP], [1.85, CAP], [1.85, 1.0], arc(2.85, 1.0, 1.0, 1.0, 180, 270), [3.3, 0])],
  m: [
    [
      [0.2, XH],
      [0.2, 0],
    ],
    arch(0.2, MID, 2.8, XH),
    arch(MID, 3.8, 2.8, XH),
  ],
  n: N_LOWER,
  o: [ring(L, 0, R, XH)],
  p: [
    [
      [L, XH],
      [L, DESC],
    ],
    stemBowl(L, R, 0, XH),
  ],
  q: [
    [
      [R, XH],
      [R, DESC],
    ],
    stemBowl(R, L, 0, XH),
  ],
  r: (() => {
    const stem = 0.75
    const rx = 1.75
    const cx = stem - 0.16 + rx
    return [
      [
        [stem, XH],
        [stem, 0],
      ],
      arc(cx, 2.5, rx, XH - 2.5, angleAtX(cx, rx, stem), 62),
    ]
  })(),
  s: [sCurve(0.45, 3.55, 0, XH)],
  t: [
    path([1.55, 5.3], [1.55, 1.05], arc(2.6, 1.05, 1.05, 1.05, 180, 270), [3.35, 0]),
    [
      [0.45, XH],
      [3.25, XH],
    ],
  ],
  u: turn(N_LOWER, XH),
  v: [
    [
      [0.3, XH],
      [MID, 0],
      [3.7, XH],
    ],
  ],
  w: [
    [
      [0.05, XH],
      [1.0, 0],
      [MID, 3.0],
      [3.0, 0],
      [3.95, XH],
    ],
  ],
  x: [
    [
      [0.4, 0],
      [3.6, XH],
    ],
    [
      [0.4, XH],
      [3.6, 0],
    ],
  ],
  y: [
    [
      [0.3, XH],
      [1.9, 0],
    ],
    [
      [3.7, XH],
      [1.25, DESC],
      [0.7, DESC],
    ],
  ],
  z: [
    [
      [0.45, XH],
      [3.55, XH],
      [0.45, 0],
      [3.6, 0],
    ],
  ],

  // ---- punctuation and symbols ----
  "!": [
    [
      [MID, CAP],
      [MID, 1.8],
    ],
    dot(MID, 0),
  ],
  '"': [
    [
      [1.3, CAP],
      [1.3, 4.5],
    ],
    [
      [2.7, CAP],
      [2.7, 4.5],
    ],
  ],
  "#": [
    [
      [1.0, 0.3],
      [1.55, 5.7],
    ],
    [
      [2.45, 0.3],
      [3.0, 5.7],
    ],
    [
      [0.3, 1.95],
      [3.55, 1.95],
    ],
    [
      [0.45, 4.05],
      [3.7, 4.05],
    ],
  ],
  $: [
    sCurve(0.45, 3.55, 0.55, 5.45),
    [
      [MID, -0.4],
      [MID, CAP],
    ],
  ],
  "%": [
    ring(0.3, 3.55, 1.6, 6),
    ring(2.4, 0, 3.7, 2.45),
    [
      [0.4, 0],
      [3.6, CAP],
    ],
  ],
  "&": (() => {
    const loop = arc(1.75, 4.85, 1.0, 1.15, 222, -40)
    const bowl = arc(1.8, 1.45, 1.5, 1.45, 128, 300)
    return [path([3.8, 0], [loop[0][0] + 0.02, loop[0][1] - 0.04], loop, bridge(loop, bowl, 0.3), bowl, curveTo(bowl, [3.7, 2.3], [0.3, 1], 0.4))]
  })(),
  "'": [
    [
      [MID, CAP],
      [MID, 4.5],
    ],
  ],
  "(": PAREN,
  ")": flipX(PAREN),
  "*": [
    [
      [MID, 5.5],
      [MID, 2.5],
    ],
    [
      [0.7, 4.75],
      [3.3, 3.25],
    ],
    [
      [0.7, 3.25],
      [3.3, 4.75],
    ],
  ],
  "+": [
    [
      [0.4, 2.95],
      [3.6, 2.95],
    ],
    [
      [MID, 1.35],
      [MID, 4.55],
    ],
  ],
  ",": [
    [
      [2.15, 0.25],
      [2.15, 0],
      [1.55, -1.1],
    ],
  ],
  "-": [
    [
      [0.9, 2.95],
      [3.1, 2.95],
    ],
  ],
  ".": [dot(MID, 0)],
  "/": SLASH,
  ":": [dot(MID, 0), dot(MID, 3.6)],
  ";": [
    dot(MID, 3.6),
    [
      [2.15, 0.25],
      [2.15, 0],
      [1.55, -1.1],
    ],
  ],
  "<": LESS,
  "=": [
    [
      [0.5, 1.95],
      [3.5, 1.95],
    ],
    [
      [0.5, 3.95],
      [3.5, 3.95],
    ],
  ],
  ">": flipX(LESS),
  "?": [QUESTION, dot(MID, 0)],
  "@": (() => {
    const inner = ring(1.2, 1.75, 2.75, 4.05)
    const hook = arc(3.3, 2.0, 0.55, 0.5, 180, 360, 2)
    const outer = arc(MID, 2.7, 1.85, 3.3, 0, 305)
    return [inner, path([2.75, 4.05], [2.75, 2.0], hook, outer)]
  })(),
  "[": BRACKET,
  "\\": flipX(SLASH),
  "]": flipX(BRACKET),
  "^": [
    [
      [0.7, 3.9],
      [MID, CAP],
      [3.3, 3.9],
    ],
  ],
  _: [
    [
      [0, -1.1],
      [WIDTH, -1.1],
    ],
  ],
  "`": [
    [
      [1.5, CAP],
      [2.4, 5.0],
    ],
  ],
  "{": BRACE,
  "|": [
    [
      [MID, CAP],
      [MID, -1.0],
    ],
  ],
  "}": flipX(BRACE),
  "~": [bez([0.4, 2.5], [1.3, 3.9], [2.7, 2.0], [3.6, 3.4])],
}

/** Glyph for a character: its own, else its capital, else "?". */
const glyphFor = (ch: string): Glyph => GLYPHS[ch] ?? GLYPHS[ch.toUpperCase()] ?? GLYPHS["?"]

export interface StrokeTextOptions {
  x: number
  y: number
  /** Cap height in output units. */
  size: number
  anchor?: "center" | "left" | "right"
  rotation?: Rotation
  /** Mirror across the anchor's vertical axis (bottom-side silkscreen). */
  mirror?: boolean
}

export function strokeTextWidth(text: string, size: number): number {
  const n = [...text].length
  return n ? ((n * ADVANCE - (ADVANCE - WIDTH)) * size) / CAP : 0
}

/** Render text as polylines, vertically centred on (x, y) on the cap height. Unknown characters draw as "?". */
export function strokeText(text: string, opts: StrokeTextOptions): Vec2[][] {
  const u = opts.size / CAP
  const chars = [...text]
  const width = strokeTextWidth(text, opts.size)
  const anchor = opts.anchor ?? "center"
  const x0 = anchor === "left" ? 0 : anchor === "right" ? -width : -width / 2
  const y0 = -opts.size / 2
  const rot = opts.rotation ?? 0
  const out: Vec2[][] = []
  chars.forEach((ch, i) => {
    for (const stroke of glyphFor(ch)) {
      out.push(
        stroke.map(([gx, gy]) => {
          const lx = x0 + (i * ADVANCE + gx) * u
          const local = { x: opts.mirror ? -lx : lx, y: y0 + gy * u }
          const r = rotate90(local, rot)
          return { x: round(opts.x + r.x), y: round(opts.y + r.y) }
        }),
      )
    }
  })
  return out
}
