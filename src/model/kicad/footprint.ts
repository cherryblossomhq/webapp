import type { SupplierLand, SupplierPad } from "@cherryblossom/api-contract"
import { round } from "../../lib/geometry"
import { all, first, num, parseSexpr, str, type SNode } from "./sexpr"

// KiCad footprints (`.kicad_mod`) as the editor's land patterns: millimetres, y up (KiCad draws
// y down, so every y is flipped and a rotation stays counter-clockwise), pads one per copper
// pad, silkscreen as polylines, the courtyard as a box.
//
// What a pad becomes, because the editor's pads have no rotation and a few shapes:
// - rect, roundrect (corners dropped; at half the short side it is a pill), oval (a pill), circle;
// - turned by a quarter turn: the width and height swap; turned any other way: a polygon of the
//   rotated outline;
// - a custom pad (an anchor and `gr_poly`, `gr_rect` and `gr_circle` primitives): the anchor and
//   each primitive are separate pads of the same number, which join into one piece of copper
//   exactly as they do in KiCad. A filled primitive drawn with a line width has that width on its
//   edge (KiCad's chamfered pad 1 does: a 0.09 mm line round a polygon), so its outline is grown
//   by half of it;
// - holes: a round or oval drill; an oval one is a slot along the pad's longer side. A drill
//   with an offset, a slot across its pad's long side, a trapezoid, a bottom-side pad and an
//   unsupported custom primitive have no representation here and refuse the footprint, with the
//   reason, rather than draw something else.
// - non-plated holes keep no copper and no pin; pads with no copper layer (paste and mask
//   openings) are not pads.
//
// Not kept: the fabrication layer and text (the fab outline stands in for a missing courtyard),
// 3D models, and silkscreen on the back.

export interface FootprintStats {
  /** Where the courtyard came from: its own layer, the fabrication outline, or the copper's bounds. */
  courtyard: "courtyard" | "fab" | "none"
  /** Pads whose rounded corners were drawn square. */
  roundedCorners: number
}

export type FootprintResult =
  | { ok: true; land: SupplierLand; stats: FootprintStats }
  | { ok: false; reason: string }

const ROTATION_EPS = 0.01

interface Pt {
  x: number
  y: number
}

interface Box {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

const emptyBox = (): Box => ({ minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity })
const grow = (b: Box, p: Pt) => {
  b.minX = Math.min(b.minX, p.x)
  b.minY = Math.min(b.minY, p.y)
  b.maxX = Math.max(b.maxX, p.x)
  b.maxY = Math.max(b.maxY, p.y)
}
const isEmpty = (b: Box) => b.minX > b.maxX

/** A footprint point (y down) as the editor's (y up). */
const flip = (x: number, y: number): Pt => ({ x: round(x), y: round(-y) })

class Refusal extends Error {}
const refuse = (reason: string): never => {
  throw new Refusal(reason)
}

// ---------- pads ----------

interface PadGeometry {
  shape: SupplierPad["shape"]
  width: number
  height: number
  points?: Pt[]
}

/** Points given in a pad's own frame (y down, before its turn) placed on the board: turned counter-clockwise, then flipped. */
function place(local: Pt, cx: number, cy: number, degrees: number): Pt {
  const a = (degrees * Math.PI) / 180
  const c = Math.cos(a)
  const s = Math.sin(a)
  return flip(cx + local.x * c + local.y * s, cy - local.x * s + local.y * c)
}

const quarterTurns = (degrees: number): number | null => {
  const q = degrees / 90
  return Math.abs(q - Math.round(q)) * 90 < ROTATION_EPS ? ((Math.round(q) % 4) + 4) % 4 : null
}

function rectCorners(w: number, h: number): Pt[] {
  return [
    { x: -w / 2, y: -h / 2 },
    { x: w / 2, y: -h / 2 },
    { x: w / 2, y: h / 2 },
    { x: -w / 2, y: h / 2 },
  ]
}

/** A pill's outline: half circles on the short side's ends, six segments each. */
function pillCorners(w: number, h: number): Pt[] {
  const horizontal = w >= h
  const r = Math.min(w, h) / 2
  const half = Math.max(w, h) / 2 - r
  const points: Pt[] = []
  for (const [centre, start] of [
    [half, -90],
    [-half, 90],
  ] as const) {
    for (let i = 0; i <= 6; i++) {
      const a = ((start + i * 30) * Math.PI) / 180
      const p = { x: centre + r * Math.cos(a), y: r * Math.sin(a) }
      points.push(horizontal ? p : { x: p.y, y: p.x })
    }
  }
  return points
}

function circleCorners(d: number): Pt[] {
  return Array.from({ length: 24 }, (_, i) => {
    const a = (i / 24) * 2 * Math.PI
    return { x: (d / 2) * Math.cos(a), y: (d / 2) * Math.sin(a) }
  })
}

/** A polygon pad: placed outline, and its bounds as the pad's size and centre. */
function polygonPad(local: Pt[], cx: number, cy: number, degrees: number): PadGeometry & { x: number; y: number } {
  const points = local.map((p) => place(p, cx, cy, degrees))
  const b = emptyBox()
  for (const p of points) grow(b, p)
  return {
    shape: "polygon",
    x: round((b.minX + b.maxX) / 2),
    y: round((b.minY + b.maxY) / 2),
    width: round(b.maxX - b.minX),
    height: round(b.maxY - b.minY),
    points,
  }
}

/**
 * A polygon grown outward by `d` at every edge, which is what a filled shape drawn with a line
 * width covers. Corners are mitred, with the length capped for a very sharp one.
 */
function inflate(points: Pt[], d: number): Pt[] {
  if (d <= 0 || points.length < 3) return points
  let area = 0
  for (let i = 0; i < points.length; i++) {
    const a = points[i]
    const b = points[(i + 1) % points.length]
    area += a.x * b.y - b.x * a.y
  }
  const side = area >= 0 ? 1 : -1
  const unit = (a: Pt, b: Pt) => {
    const l = Math.hypot(b.x - a.x, b.y - a.y) || 1
    return { x: (b.x - a.x) / l, y: (b.y - a.y) / l }
  }
  return points.map((p, i) => {
    const u1 = unit(points[(i + points.length - 1) % points.length], p)
    const u2 = unit(p, points[(i + 1) % points.length])
    const n1 = { x: u1.y * side, y: -u1.x * side }
    const n2 = { x: u2.y * side, y: -u2.x * side }
    const k = Math.min(d / Math.max(1 + n1.x * n2.x + n1.y * n2.y, 0.15), d * 3)
    return { x: p.x + (n1.x + n2.x) * k, y: p.y + (n1.y + n2.y) * k }
  })
}

/** One of the pads a KiCad pad makes, in the footprint's frame. */
type Shaped = PadGeometry & { x: number; y: number }

/** A plain shape (rect, oval, circle) turned by `degrees`, as a pad with its own size and centre. */
function shapePad(kind: "rect" | "oval" | "circle", w: number, h: number, cx: number, cy: number, degrees: number): Shaped {
  const centre = flip(cx, cy)
  if (kind === "circle" || (kind === "oval" && Math.abs(w - h) < 1e-6)) {
    return { shape: "circle", x: centre.x, y: centre.y, width: round(w), height: round(w) }
  }
  const turns = quarterTurns(degrees)
  if (turns !== null) {
    const swap = turns % 2 === 1
    return { shape: kind === "oval" ? "oval" : "rect", x: centre.x, y: centre.y, width: round(swap ? h : w), height: round(swap ? w : h) }
  }
  return polygonPad(kind === "oval" ? pillCorners(w, h) : rectCorners(w, h), cx, cy, degrees)
}

interface RawPad {
  number: string
  type: string
  shape: string
  x: number
  y: number
  rot: number
  w: number
  h: number
  layers: string[]
  rratio: number
  drill: { w: number; h: number } | null
  node: SNode[]
}

function readPad(node: SNode[]): RawPad {
  const at = first(node, "at")
  const size = first(node, "size")
  const drillNode = first(node, "drill")
  let drill: RawPad["drill"] = null
  if (drillNode) {
    if (first(drillNode, "offset") && (num(first(drillNode, "offset"), 1) !== 0 || num(first(drillNode, "offset"), 2) !== 0)) {
      refuse(`pad ${str(node, 1) || "(unnumbered)"} has an off-centre hole`)
    }
    drill = drillNode[1] === "oval" ? { w: num(drillNode, 2), h: num(drillNode, 3) } : { w: num(drillNode, 1), h: num(drillNode, 1) }
    if (drill.w <= 0 || drill.h <= 0) drill = null
  }
  return {
    number: str(node, 1) ?? "",
    type: str(node, 2) ?? "",
    shape: str(node, 3) ?? "",
    x: num(at, 1),
    y: num(at, 2),
    rot: num(at, 3),
    w: num(size, 1),
    h: num(size, 2),
    layers: (first(node, "layers") ?? []).slice(1).filter((l): l is string => typeof l === "string"),
    rratio: num(first(node, "roundrect_rratio"), 1),
    drill,
    node,
  }
}

const hasCopper = (layers: string[], which: "F" | "B") => layers.some((l) => l === `${which}.Cu` || l === "*.Cu")

/** The primitives of a custom pad as pads of their own, in the pad's frame before its turn. */
function customPads(p: RawPad): Shaped[] {
  const out: Shaped[] = []
  const options = first(p.node, "options")
  const anchor = str(first(options ?? [], "anchor"), 1) ?? "rect"
  out.push(anchor === "circle" ? shapePad("circle", p.w, p.w, p.x, p.y, p.rot) : shapePad("rect", p.w, p.h, p.x, p.y, p.rot))
  const primitives = first(p.node, "primitives")
  for (const prim of primitives ? primitives.slice(1) : []) {
    if (!Array.isArray(prim)) continue
    const width = num(first(prim, "width"), 1)
    const fill = first(prim, "fill")
    const filled = !fill || fill[1] === "yes" || fill[1] === "solid"
    // An unfilled primitive is an outline of copper, and a line wider than a pad's own edge is a stroke, not a pad.
    if (!filled || width > 0.5) refuse(`custom pad ${p.number || "(unnumbered)"} has a stroked or unfilled ${prim[0]} primitive`)
    if (prim[0] === "gr_poly") {
      const pts = first(prim, "pts") ?? []
      const local = all(pts, "xy").map((xy) => ({ x: num(xy, 1), y: num(xy, 2) }))
      if (local.length < 3) refuse(`custom pad ${p.number || "(unnumbered)"} has a polygon with fewer than 3 points`)
      out.push(polygonPad(inflate(local, width / 2), p.x, p.y, p.rot))
    } else if (prim[0] === "gr_rect") {
      const a = first(prim, "start")
      const b = first(prim, "end")
      const [x0, y0, x1, y1] = [num(a, 1), num(a, 2), num(b, 1), num(b, 2)]
      const box = [{ x: Math.min(x0, x1), y: Math.min(y0, y1) }, { x: Math.max(x0, x1), y: Math.min(y0, y1) }, { x: Math.max(x0, x1), y: Math.max(y0, y1) }, { x: Math.min(x0, x1), y: Math.max(y0, y1) }]
      out.push(polygonPad(inflate(box, width / 2), p.x, p.y, p.rot))
    } else if (prim[0] === "gr_circle") {
      const c = first(prim, "center")
      const e = first(prim, "end")
      const r = Math.hypot(num(e, 1) - num(c, 1), num(e, 2) - num(c, 2)) + width / 2
      out.push(polygonPad(circleCorners(r * 2).map((q) => ({ x: q.x + num(c, 1), y: q.y + num(c, 2) })), p.x, p.y, p.rot))
    } else {
      refuse(`custom pad ${p.number || "(unnumbered)"} has a ${prim[0]} primitive, which isn't supported`)
    }
  }
  return out
}

function convertPad(p: RawPad, stats: FootprintStats): SupplierPad[] {
  const label = p.number || "(unnumbered)"
  const npth = p.type === "np_thru_hole"
  if (!npth) {
    if (!hasCopper(p.layers, "F") && !hasCopper(p.layers, "B")) return [] // a paste or mask opening, not a pad
    if (!hasCopper(p.layers, "F")) refuse(`pad ${label} is on the bottom copper layer only`)
  }
  const turns = quarterTurns(p.rot)

  // A hole: round, or a slot along the pad's longer side.
  const hole = (width: number, height: number): Pick<SupplierPad, "holeDiameter" | "slotLength"> => {
    if (!p.drill) return {}
    let { w: dw, h: dh } = p.drill
    if (Math.abs(dw - dh) < 1e-6) return { holeDiameter: round(dw) }
    if (turns === null) refuse(`pad ${label} has a slot and a turn that isn't a quarter turn`)
    if (turns! % 2 === 1) [dw, dh] = [dh, dw]
    const alongX = dw > dh
    if (alongX !== (width >= height)) refuse(`pad ${label} has a slot across its longer side`)
    return { holeDiameter: round(Math.min(dw, dh)), slotLength: round(Math.max(dw, dh)) }
  }

  if (npth) {
    if (!p.drill) return []
    let { w, h } = p.drill
    if (turns === null && Math.abs(w - h) >= 1e-6) refuse(`hole ${label} is a slot at an angle`)
    if (turns !== null && turns % 2 === 1) [w, h] = [h, w]
    const centre = flip(p.x, p.y)
    const round_ = Math.abs(w - h) < 1e-6
    return [
      {
        number: "",
        shape: round_ ? "circle" : "oval",
        x: centre.x,
        y: centre.y,
        width: round(w),
        height: round(h),
        holeDiameter: round(Math.min(w, h)),
        ...(round_ ? {} : { slotLength: round(Math.max(w, h)) }),
        layer: "through",
        plated: false,
      },
    ]
  }

  let shaped: Shaped[]
  switch (p.shape) {
    case "rect":
      shaped = [shapePad("rect", p.w, p.h, p.x, p.y, p.rot)]
      break
    case "roundrect": {
      // At half the short side the corners are full circles: a pill.
      const pill = p.rratio >= 0.4999
      if (!pill && p.rratio > 0) stats.roundedCorners++
      shaped = [shapePad(pill ? "oval" : "rect", p.w, p.h, p.x, p.y, p.rot)]
      break
    }
    case "oval":
      shaped = [shapePad("oval", p.w, p.h, p.x, p.y, p.rot)]
      break
    case "circle":
      shaped = [shapePad("circle", p.w, p.w, p.x, p.y, p.rot)]
      break
    case "custom":
      shaped = customPads(p)
      // Every through-hole pad the editor builds is drilled, so each extra piece would get a hole.
      if (p.type === "thru_hole" && shaped.length > 1) refuse(`through-hole pad ${label} is a custom shape in ${shaped.length} pieces`)
      break
    case "trapezoid":
      return refuse(`pad ${label} is a trapezoid`)
    default:
      return refuse(`pad ${label} has the shape ${p.shape || "(none)"}`)
  }

  const through = p.type === "thru_hole"
  if (through && !p.drill) refuse(`through-hole pad ${label} has no drill`)
  return shaped.map((s, i) => {
    // The hole belongs to the anchor, the first of a custom pad's pieces.
    const h = through && i === 0 ? hole(s.width, s.height) : {}
    return {
      number: p.number,
      shape: s.shape,
      x: s.x,
      y: s.y,
      width: s.width,
      height: s.height,
      ...(s.points ? { points: s.points } : {}),
      ...h,
      layer: through ? ("through" as const) : ("top" as const),
    }
  })
}

// ---------- graphics ----------

/** The points of an arc through three points, every 15 degrees or so. */
function arcPoints(a: Pt, m: Pt, b: Pt): Pt[] {
  const d = 2 * (a.x * (m.y - b.y) + m.x * (b.y - a.y) + b.x * (a.y - m.y))
  if (Math.abs(d) < 1e-9) return [a, b]
  const ux = ((a.x ** 2 + a.y ** 2) * (m.y - b.y) + (m.x ** 2 + m.y ** 2) * (b.y - a.y) + (b.x ** 2 + b.y ** 2) * (a.y - m.y)) / d
  const uy = ((a.x ** 2 + a.y ** 2) * (b.x - m.x) + (m.x ** 2 + m.y ** 2) * (a.x - b.x) + (b.x ** 2 + b.y ** 2) * (m.x - a.x)) / d
  const r = Math.hypot(a.x - ux, a.y - uy)
  const angle = (p: Pt) => Math.atan2(p.y - uy, p.x - ux)
  const start = angle(a)
  let mid = angle(m) - start
  let end = angle(b) - start
  // Walk the way that passes through the middle point.
  const norm = (t: number) => ((t % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)
  mid = norm(mid)
  end = norm(end)
  const sweep = mid <= end ? end : end - 2 * Math.PI
  const steps = Math.max(2, Math.ceil(Math.abs(sweep) / ((15 * Math.PI) / 180)))
  return Array.from({ length: steps + 1 }, (_, i) => {
    const t = start + (sweep * i) / steps
    return { x: round(ux + r * Math.cos(t)), y: round(uy + r * Math.sin(t)) }
  })
}

const xy = (node: SNode[] | undefined): Pt => flip(num(node, 1), num(node, 2))

/** One graphic as a polyline (closed shapes repeat their first point), or null when it isn't drawable. */
function strokes(g: SNode[]): Pt[][] {
  switch (g[0]) {
    case "fp_line":
      return [[xy(first(g, "start")), xy(first(g, "end"))]]
    case "fp_rect": {
      const a = xy(first(g, "start"))
      const b = xy(first(g, "end"))
      return [[a, { x: b.x, y: a.y }, b, { x: a.x, y: b.y }, a]]
    }
    case "fp_circle": {
      const c = xy(first(g, "center"))
      const e = xy(first(g, "end"))
      const r = Math.hypot(e.x - c.x, e.y - c.y)
      const ring = Array.from({ length: 33 }, (_, i) => ({ x: round(c.x + r * Math.cos((i / 32) * 2 * Math.PI)), y: round(c.y + r * Math.sin((i / 32) * 2 * Math.PI)) }))
      return [ring]
    }
    case "fp_arc":
      return [arcPoints(xy(first(g, "start")), xy(first(g, "mid")), xy(first(g, "end")))]
    case "fp_poly": {
      const pts = all(first(g, "pts") ?? [], "xy").map((p) => flip(num(p, 1), num(p, 2)))
      return pts.length >= 2 ? [[...pts, pts[0]]] : []
    }
    default:
      return []
  }
}

/** Segments that meet end to end are one polyline: silkscreen drawn as separate lines is mostly outlines. */
function chain(lines: Pt[][]): Pt[][] {
  const same = (a: Pt, b: Pt) => Math.abs(a.x - b.x) < 1e-4 && Math.abs(a.y - b.y) < 1e-4
  const out: Pt[][] = []
  for (const line of lines) {
    let current = [...line]
    for (let merged = true; merged; ) {
      merged = false
      for (let i = 0; i < out.length; i++) {
        const other = out[i]
        if (same(other[other.length - 1], current[0])) {
          current = [...other, ...current.slice(1)]
        } else if (same(current[current.length - 1], other[0])) {
          current = [...current, ...other.slice(1)]
        } else {
          continue
        }
        out.splice(i, 1)
        merged = true
        break
      }
    }
    out.push(current)
  }
  return out
}

// ---------- the footprint ----------

/** A footprint file as a land pattern; `from` names it in the result (`Package_QFP:TQFP-32_7x7mm_P0.8mm`). */
export function convertFootprint(text: string, from: string): FootprintResult {
  let root: SNode[] | undefined
  try {
    root = parseSexpr(text).find((n): n is SNode[] => Array.isArray(n) && (n[0] === "footprint" || n[0] === "module"))
  } catch (e) {
    return { ok: false, reason: `unreadable footprint file: ${e instanceof Error ? e.message : String(e)}` }
  }
  if (!root) return { ok: false, reason: "not a KiCad footprint: no (footprint ...)" }
  const stats: FootprintStats = { courtyard: "none", roundedCorners: 0 }
  try {
    const pads: SupplierPad[] = []
    for (const node of all(root, "pad")) pads.push(...convertPad(readPad(node), stats))
    if (!pads.some((p) => p.number)) return { ok: false, reason: "the footprint has no numbered copper pad" }

    const silk: Pt[][] = []
    const courtyard = emptyBox()
    const fab = emptyBox()
    for (const child of root) {
      if (!Array.isArray(child)) continue
      const layer = str(first(child, "layer"), 1)
      if (layer !== "F.SilkS" && layer !== "F.CrtYd" && layer !== "F.Fab") continue
      const drawn = strokes(child)
      if (layer === "F.SilkS") silk.push(...drawn)
      else for (const line of drawn) for (const p of line) grow(layer === "F.CrtYd" ? courtyard : fab, p)
    }

    // The courtyard: its own layer; failing that the fabrication outline with the copper, a quarter millimetre out.
    let box: Box | undefined
    const copper = emptyBox()
    for (const p of pads) {
      grow(copper, { x: p.x - p.width / 2, y: p.y - p.height / 2 })
      grow(copper, { x: p.x + p.width / 2, y: p.y + p.height / 2 })
    }
    if (!isEmpty(courtyard)) {
      stats.courtyard = "courtyard"
      box = courtyard
    } else if (!isEmpty(fab)) {
      stats.courtyard = "fab"
      grow(fab, { x: copper.minX, y: copper.minY })
      grow(fab, { x: copper.maxX, y: copper.maxY })
      box = { minX: fab.minX - 0.25, minY: fab.minY - 0.25, maxX: fab.maxX + 0.25, maxY: fab.maxY + 0.25 }
    }
    return {
      ok: true,
      stats,
      land: {
        pads,
        silk: chain(silk.filter((l) => l.length >= 2)),
        ...(box ? { courtyard: { minX: round(box.minX), minY: round(box.minY), maxX: round(box.maxX), maxY: round(box.maxY) } } : {}),
        from,
      },
    }
  } catch (e) {
    if (e instanceof Refusal) return { ok: false, reason: e.message }
    throw e
  }
}
