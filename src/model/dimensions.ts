// Ported from KiCad (https://gitlab.com/kicad/code/kicad): what a dimension draws and says, from `pcbnew/pcb_dimension.cpp` of 10.0.0 (the
// aligned, orthogonal, leader, radial and centre rules of `updateGeometry` and `updateText`, `drawAnArrow`, `CollectKnockedOutSegments`,
// `GetValueText`), the text box of `EDA_TEXT::GetTextBox` (common/eda_text.cpp) with `FONT::StringBoundaryLimits` (common/font/font.cpp),
// `SEG::Intersect` (libs/kimath/src/geometry/seg.cpp), `VECTOR2::Resize` (libs/kimath/include/math/vector2d.h), `RotatePoint` (libs/kimath/src/trigo.cpp)
// and `EDA_ANGLE` (libs/kimath/include/geometry/eda_angle.h).
//
// Copyright The KiCad Developers, see AUTHORS.txt for contributors. This program source code file is part of KiCad, a free EDA CAD application.
// This program is free software; you can redistribute it and/or modify it under the terms of the GNU General Public License as published by
// the Free Software Foundation; either version 2 of the License, or (at your option) any later version. This program is distributed in the hope
// that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See
// the GNU General Public License for more details. You should have received a copy of the GNU General Public License along with this program; if
// not, see <https://www.gnu.org/licenses/>.
//
// A dimension is stored as KiCad stores it (`BoardDimension`: the points, the height, the style and the text's own place) and what it draws
// is worked out here, never stored: the extension lines, the crossbar, the arrows, and the text that says the measured value. The work is done
// in KiCad's own frame and unit (y down, nanometres, with its `KiROUND` and its integer divisions), so a dimension lands where KiCad draws it;
// the result is mapped to the editor's frame (y up, millimetres). The rules are the same in 9.0.7, 10.0.0 and master (pcb_dimension.cpp); KiCad 6
// and 7 drew the text box and the text's offset a little differently, and KiCad draws every file with the rules of the release that opens it.

import { effectivePenWidth, interlineAt, kiRound, mmToIu, splitLines, stringBoundaryLimits, TEXT_RULES } from "../lib/kicadText"
import type { BoardDimension, BoardShape, Vec2 } from "./types"

interface P {
  x: number
  y: number
}

const D2R = Math.PI / 180
const ARROW_ANGLE = 27.5
const INWARD_ARROW_LENGTH_TO_HEAD_RATIO = 2

/** KiCad's default arrow length, 50 mils, in nanometres (`PCB_DIMENSION_BASE`'s constructor). */
export const DEFAULT_ARROW_IU = 1_270_000
/** The extension height of a dimension whose file gives none: KiCad starts it at the arrow's length times the sine of the arrow's angle. */
export const DEFAULT_EXTENSION_HEIGHT_IU = Math.trunc(DEFAULT_ARROW_IU * Math.sin(ARROW_ANGLE * D2R))

const sign = (n: number) => (n > 0 ? 1 : n < 0 ? -1 : 0)
const add = (a: P, b: P): P => ({ x: a.x + b.x, y: a.y + b.y })
const sub = (a: P, b: P): P => ({ x: a.x - b.x, y: a.y - b.y })
const same = (a: P, b: P) => a.x === b.x && a.y === b.y
const neg0 = (n: number) => (Object.is(n, -0) ? 0 : n)

/** `VECTOR2I::EuclideanNorm`: the nearest integer to the length. */
const norm = (v: P) => Math.round(Math.hypot(v.x, v.y))

/** `VECTOR2I::Resize`: the vector's direction at another length (a negative length turns it round). */
function resize(v: P, length: number): P {
  if (v.x === 0 && v.y === 0) return { x: 0, y: 0 }
  let nx: number
  let ny: number
  if (Math.abs(v.x) === Math.abs(v.y)) nx = ny = Math.abs(length) * Math.SQRT1_2
  else {
    const l = Math.hypot(v.x, v.y)
    nx = (Math.abs(v.x) * Math.abs(length)) / l
    ny = (Math.abs(v.y) * Math.abs(length)) / l
  }
  const s = sign(length)
  return { x: neg0((v.x < 0 ? -kiRound(nx) : kiRound(nx)) * s), y: neg0((v.y < 0 ? -kiRound(ny) : kiRound(ny)) * s) }
}

/** `EDA_ANGLE( vector )` in degrees: the angle of a vector in KiCad's frame (y down), so that a vector pointing down is 90. */
function angleOf(v: P): number {
  if (v.x === 0 && v.y === 0) return 0
  if (v.y === 0) return v.x >= 0 ? 0 : -180
  if (v.x === 0) return v.y >= 0 ? 90 : -90
  if (v.x === v.y) return v.x >= 0 ? 45 : -135
  if (v.x === -v.y) return v.x >= 0 ? -45 : 135
  return (Math.atan2(v.y, v.x) * 180) / Math.PI
}

const normalize360 = (a: number) => {
  let v = a % 360
  while (v < 0) v += 360
  while (v >= 360) v -= 360
  return v
}

const sinOf = (deg: number) => {
  const t = normalize360(deg)
  if (t === 0 || t === 180) return 0
  if (t === 45 || t === 135) return Math.SQRT1_2
  if (t === 225 || t === 315) return -Math.SQRT1_2
  if (t === 90) return 1
  if (t === 270) return -1
  return Math.sin(deg * D2R)
}
const cosOf = (deg: number) => {
  const t = normalize360(deg)
  if (t === 0) return 1
  if (t === 180) return -1
  if (t === 90 || t === 270) return 0
  if (t === 45 || t === 315) return Math.SQRT1_2
  if (t === 135 || t === 225) return -Math.SQRT1_2
  return Math.cos(deg * D2R)
}

/** `RotatePoint( VECTOR2I&, EDA_ANGLE )`: a positive angle turns counter-clockwise on screen (y down), the quarter turns exact. */
function rotate(p: P, deg: number): P {
  const a = normalize360(deg)
  if (a === 0) return { x: p.x, y: p.y }
  if (a === 90) return { x: p.y, y: neg0(-p.x) }
  if (a === 180) return { x: neg0(-p.x), y: neg0(-p.y) }
  if (a === 270) return { x: neg0(-p.y), y: p.x }
  const s = sinOf(a)
  const c = cosOf(a)
  return { x: kiRound(p.y * s + p.x * c), y: kiRound(p.y * c - p.x * s) }
}
const rotateAbout = (p: P, c: P, deg: number): P => add(rotate(sub(p, c), deg), c)

interface Seg {
  a: P
  b: P
}

/** `SEG::Intersect` of two finite segments: the point where they cross, or null (parallel segments have none). */
function intersect(s: Seg, t: Seg): P | null {
  const e = sub(s.b, s.a)
  const f = sub(t.b, t.a)
  const ac = sub(t.a, s.a)
  const cross = (u: P, v: P) => u.x * v.y - u.y * v.x
  const d = cross(f, e)
  const p = cross(f, ac)
  const q = cross(e, ac)
  if (d === 0) return null
  if (d > 0) {
    if (p < 0 || p > d || q < 0 || q > d) return null
  } else if (p > 0 || p < d || q > 0 || q < d) return null
  return { x: t.a.x + kiRound((q * f.x) / d), y: t.a.y + kiRound((q * f.y) / d) }
}

/** A box as KiCad holds one: an origin and a size. */
interface Box {
  x: number
  y: number
  w: number
  h: number
}

/** `BOX2::Inflate( dx, dy )`: a box that would shrink past nothing becomes a line through its middle. */
function inflate(b: Box, dx: number, dy: number): Box {
  const out = { ...b }
  if (out.w < -2 * dx) {
    out.x += Math.trunc(out.w / 2)
    out.w = 0
  } else {
    out.x -= dx
    out.w += 2 * dx
  }
  if (out.h < -2 * dy) {
    out.y += Math.trunc(out.h / 2)
    out.h = 0
  } else {
    out.y -= dy
    out.h += 2 * dy
  }
  return out
}

const centreOf = (b: Box): P => ({ x: Math.trunc(b.x + b.w / 2), y: Math.trunc(b.y + b.h / 2) })

/** A convex polygon, as `SHAPE_POLY_SET` of one outline: the rotated box a text is knocked out of a line with. */
type Poly = P[]

/** `SHAPE_POLY_SET::Contains`: the even-odd ray test. */
function polyContains(poly: Poly, pt: P): boolean {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]
    const b = poly[j]
    if (a.y > pt.y !== b.y > pt.y && pt.x < ((b.x - a.x) * (pt.y - a.y)) / (b.y - a.y) + a.x) inside = !inside
  }
  return inside
}

const polySegments = (poly: Poly): Seg[] => poly.map((a, i) => ({ a, b: poly[(i + 1) % poly.length] }))
const squared = (v: P) => v.x * v.x + v.y * v.y

/** `segPolyIntersection`: where a segment first meets the polygon's outline coming from one end, or null when that end is inside or it never does. */
function segPolyIntersection(poly: Poly, seg: Seg, fromStart = true): P | null {
  const start = fromStart ? seg.a : seg.b
  let end = fromStart ? seg.b : seg.a
  if (polyContains(poly, start)) return null
  for (const s of polySegments(poly)) {
    const hit = intersect(s, seg)
    if (hit && squared(sub(hit, start)) < squared(sub(end, start))) end = hit
  }
  return same(start, end) ? null : end
}

/** `segCircleIntersection`: the same for a circle, by the nearest point of the segment on the circle. */
function segCircleIntersection(c: P, radius: number, seg: Seg, fromStart = true): P | null {
  const start = fromStart ? seg.a : seg.b
  let end = fromStart ? seg.b : seg.a
  if (Math.hypot(start.x - c.x, start.y - c.y) <= radius) return null
  const d = sub(seg.b, seg.a)
  const f = sub(seg.a, c)
  const A = d.x * d.x + d.y * d.y
  if (A === 0) return null
  const B = 2 * (f.x * d.x + f.y * d.y)
  const C = f.x * f.x + f.y * f.y - radius * radius
  const disc = B * B - 4 * A * C
  if (disc < 0) return null
  const root = Math.sqrt(disc)
  for (const t of [(-B - root) / (2 * A), (-B + root) / (2 * A)]) {
    if (t < 0 || t > 1) continue
    const hit = { x: kiRound(seg.a.x + t * d.x), y: kiRound(seg.a.y + t * d.y) }
    if (squared(sub(hit, start)) < squared(sub(end, start))) end = hit
  }
  return same(start, end) ? null : end
}

/** `CollectKnockedOutSegments`: a segment less the part inside a polygon, as 0, 1 or 2 segments. */
function knockOut(poly: Poly, seg: Seg, out: Seg[]) {
  const containsA = polyContains(poly, seg.a)
  const containsB = polyContains(poly, seg.b)
  const endA = segPolyIntersection(poly, seg)
  const endB = segPolyIntersection(poly, seg, false)
  if (endA) out.push({ a: seg.a, b: endA })
  if (endB) {
    let can = true
    if (endA && ((same(endB, seg.a) && same(endA, seg.b)) || (same(endA, endB) && same(seg.a, seg.b)))) can = false
    if (can) out.push({ a: endB, b: seg.b })
  }
  if (!containsA && !containsB && !endA && !endB) out.push({ a: seg.a, b: seg.b })
}

// ---------- the value, and the text it makes ----------

const UNIT_LABEL = [" in", " mils", " mm"]

/** The unit the units mode stands for: automatic is taken as millimetres, KiCad's own default (it follows the user's display units, which a board file does not say). */
export const unitOf = (mode: number): 0 | 1 | 2 => (mode === 0 || mode === 1 || mode === 2 ? mode : 2)

/** `PCB_DIMENSION_BASE::GetValueText`: the measured value (nanometres) with the digits and units asked for. */
export function valueText(measured: number, units: number, precision: number, suppressZeros: boolean): string {
  const unit = unitOf(units)
  let digits = precision
  if (digits >= 6) digits = unit === 0 ? digits - 4 : unit === 1 ? Math.max(0, digits - 7) : digits - 5
  digits = Math.max(0, Math.min(100, digits))
  const value = unit === 2 ? measured / 1e6 : unit === 1 ? measured / 25_400 : measured / 25_400_000
  let text = value.toFixed(digits)
  if (suppressZeros && digits > 0) {
    while (text.endsWith("0")) {
      text = text.slice(0, -1)
      if (text.endsWith(".")) {
        text = text.slice(0, -1)
        break
      }
    }
  }
  return text
}

/** The text of a dimension (`PCB_DIMENSION_BASE::updateText`): the measured value or the text that replaces it, with its units, then the prefix and the suffix. */
export function dimensionText(d: BoardDimension, measured: number): string {
  let text = d.override !== undefined ? d.override : valueText(measured, d.units, d.precision, d.zeros === true)
  const label = UNIT_LABEL[unitOf(d.units)]
  if (d.format === 1) text += label
  else if (d.format === 2) text += ` (${label.trimStart()})`
  return `${d.prefix ?? ""}${text}${d.suffix ?? ""}`
}

// ---------- the text's box ----------

interface TextState {
  text: string
  pos: P
  /** Degrees counter-clockwise on screen. */
  angle: number
  w: number
  h: number
  /** The stored pen width in nanometres (0 for automatic). */
  thickness: number
  bold: boolean
  italic: boolean
  mirror: boolean
  hj: -1 | 0 | 1
  vj: -1 | 0 | 1
}

const penOf = (t: TextState) => effectivePenWidth(t.thickness, t.bold, t.w, t.h)

/** `EDA_TEXT::GetTextBox`: the box of the text before it is turned, from its anchor and its justification. */
function textBox(t: TextState): Box {
  const pen = penOf(t)
  const lines = splitLines(t.text)
  const first = lines.length ? lines[0] : t.text
  const a = { w: t.w, h: t.h, italic: t.italic }
  const extents = stringBoundaryLimits(first, a, pen)
  const fudge = kiRound(extents.h * 0.17)
  let w = extents.w
  let h = extents.h + fudge
  let overbar = 0
  if (first.includes("~{")) overbar = Math.trunc(extents.h / 6)
  if (lines.length > 1) {
    for (const line of lines.slice(1)) w = Math.max(w, stringBoundaryLimits(line, a, pen).w)
    h += kiRound((lines.length - 1) * interlineAt(t.h))
  }
  h += overbar
  const box: Box = { x: t.pos.x, y: t.pos.y, w, h }
  const italicOffset = t.italic ? kiRound(t.h * TEXT_RULES.italicTilt) : 0
  if (t.hj === -1) {
    if (t.mirror) box.x -= box.w - italicOffset
  } else if (t.hj === 0) box.x -= Math.trunc((box.w - italicOffset) / 2)
  else if (!t.mirror) box.x -= box.w - italicOffset
  if (t.vj === -1) box.y -= fudge
  else if (t.vj === 0) box.y -= Math.trunc(box.h / 2)
  else {
    box.y -= box.h
    box.y += fudge
  }
  return box
}

/** The rotated box a line is knocked out of: the text's box grown by `dx` and `dy`, turned about its centre by the text's angle. */
function knockoutPolygon(t: TextState, dx: number, dy: number): { box: Box; poly: Poly } {
  const box = inflate(textBox(t), dx, dy)
  const o = { x: box.x, y: box.y }
  const e = { x: box.x + box.w, y: box.y + box.h }
  const centre = centreOf(box)
  const poly = [o, { x: o.x, y: e.y }, e, { x: e.x, y: o.y }].map((p) => rotateAbout(p, centre, t.angle))
  return { box, poly }
}

// ---------- the dimension in KiCad's frame ----------

interface Ki {
  d: BoardDimension
  start: P
  end: P
  height: number
  extensionHeight: number
  extensionOffset: number
  arrow: number
  inward: boolean
  leaderLength: number
  frame: number
  textMode: number
  keep: boolean
  vertical: boolean
  text: TextState
  measured: number
  shapes: Seg[]
  circles: { c: P; r: number }[]
  crossBarStart: P
  crossBarEnd: P
}

const toIu = (v: Vec2): P => ({ x: mmToIu(v.x), y: mmToIu(-v.y) })

function state(d: BoardDimension): Ki {
  const text: TextState = {
    text: "",
    pos: toIu({ x: d.x, y: d.y }),
    angle: d.rot,
    w: mmToIu(d.w ?? d.size),
    h: mmToIu(d.size),
    thickness: d.tw !== undefined ? mmToIu(d.tw) : 0,
    bold: d.bold === true,
    italic: d.italic === true,
    mirror: d.mirror === true,
    hj: d.hj === "left" ? -1 : d.hj === "right" ? 1 : 0,
    vj: d.vj === "top" ? -1 : d.vj === "bottom" ? 1 : 0,
  }
  return {
    d,
    start: toIu(d.a),
    end: toIu(d.b),
    height: mmToIu(d.height ?? 0),
    extensionHeight: mmToIu(d.extHeight),
    extensionOffset: mmToIu(d.extOffset),
    arrow: mmToIu(d.arrow),
    inward: d.inward === true,
    leaderLength: mmToIu(d.leaderLength ?? 0),
    frame: d.frame ?? 0,
    textMode: d.textMode ?? 0,
    keep: d.keep === true,
    vertical: d.vertical === true,
    text,
    measured: 0,
    shapes: [],
    circles: [],
    crossBarStart: { x: 0, y: 0 },
    crossBarEnd: { x: 0, y: 0 },
  }
}

/** `drawAnArrow`: the two barbs of an arrowhead at a point, and a tail when it has a length. `angle` is an `EDA_ANGLE( vector )`, the way the arrow points. */
function drawArrow(k: Ki, at: P, angle: number, length: number) {
  if (length) k.shapes.push({ a: at, b: add(at, rotate({ x: length, y: 0 }, -angle)) })
  const pos = rotate({ x: k.arrow, y: 0 }, -angle + ARROW_ANGLE)
  const negative = rotate({ x: k.arrow, y: 0 }, -angle - ARROW_ANGLE)
  k.shapes.push({ a: at, b: add(at, pos) })
  k.shapes.push({ a: at, b: add(at, negative) })
}

/** The text's own angle to set, in the half open range KiCad's `SetTextAngle` keeps. */
const fullCircleMinus = (deg: number) => normalize360(360 - deg)

function alignedText(k: Ki) {
  const half = { x: Math.trunc((k.crossBarEnd.x - k.crossBarStart.x) / 2), y: Math.trunc((k.crossBarEnd.y - k.crossBarStart.y) / 2) }
  const t = k.text
  if (k.textMode === 0) {
    const distance = penOf(t) + t.h
    const rotation = half.x === 0 ? 90 * sign(-half.y) : half.x < 0 ? -90 : 90
    const turned = rotate(half, rotation)
    t.pos = add(k.crossBarStart, add(half, resize(turned, distance)))
  } else if (k.textMode === 1) t.pos = add(k.crossBarStart, half)
  if (k.keep) {
    let angle = fullCircleMinus(angleOf(half))
    if (angle > 90 && angle <= 270) angle -= 180
    t.angle = angle
  }
  t.text = dimensionText(k.d, k.measured)
}

/**
 * `PCB_DIM_ORTHOGONAL::updateText` places the text along its axis and then calls `PCB_DIM_ALIGNED::updateText`, which places it again by the
 * aligned rule and turns it by the crossbar's angle, so what KiCad draws is the aligned rule's (this is the order of the 10.0.0 source).
 */
const orthogonalText = alignedText

function alignedGeometry(k: Ki) {
  const start = k.start
  const end = k.end
  const dimension = sub(end, start)
  k.measured = Math.round(Math.hypot(dimension.x, dimension.y))
  const extension: P = k.height > 0 ? { x: -dimension.y, y: dimension.x } : { x: dimension.y, y: -dimension.x }
  const extensionHeight = Math.abs(k.height) - k.extensionOffset + k.extensionHeight
  let from = add(start, resize(extension, k.extensionOffset))
  k.shapes.push({ a: from, b: add(from, resize(extension, extensionHeight)) })
  from = add(end, resize(extension, k.extensionOffset))
  k.shapes.push({ a: from, b: add(from, resize(extension, extensionHeight)) })
  const crossBarDistance = (() => {
    const r = resize(extension, k.height)
    const s = sign(k.height)
    return { x: neg0(s * r.x), y: neg0(s * r.y) }
  })()
  k.crossBarStart = add(start, crossBarDistance)
  k.crossBarEnd = add(end, crossBarDistance)
  alignedText(k)
  const { poly } = knockoutPolygon(k.text, Math.trunc(k.text.w / 2), -penOf(k.text))
  knockOut(poly, { a: k.crossBarStart, b: k.crossBarEnd }, k.shapes)
  if (k.inward) {
    drawArrow(k, k.crossBarStart, angleOf(dimension) + 180, k.arrow * INWARD_ARROW_LENGTH_TO_HEAD_RATIO)
    drawArrow(k, k.crossBarEnd, angleOf(dimension), k.arrow * INWARD_ARROW_LENGTH_TO_HEAD_RATIO)
  } else {
    drawArrow(k, k.crossBarStart, angleOf(dimension), 0)
    drawArrow(k, k.crossBarEnd, angleOf(dimension) + 180, 0)
  }
}

function orthogonalGeometry(k: Ki) {
  const start = k.start
  const end = k.end
  const measurement = k.vertical ? end.y - start.y : end.x - start.x
  k.measured = Math.abs(measurement)
  let extension: P = k.vertical ? { x: k.height, y: 0 } : { x: 0, y: k.height }
  let extensionHeight = Math.abs(k.height) - k.extensionOffset + k.extensionHeight
  let from = add(start, resize(extension, k.extensionOffset))
  k.shapes.push({ a: from, b: add(from, resize(extension, extensionHeight)) })
  const crossBarDistance = (() => {
    const r = resize(extension, k.height)
    const s = sign(k.height)
    return { x: neg0(s * r.x), y: neg0(s * r.y) }
  })()
  k.crossBarStart = add(start, crossBarDistance)
  k.crossBarEnd = k.vertical ? { x: k.crossBarStart.x, y: end.y } : { x: end.x, y: k.crossBarStart.y }
  extension = k.vertical ? { x: end.x - k.crossBarEnd.x, y: 0 } : { x: 0, y: end.y - k.crossBarEnd.y }
  extensionHeight = norm(extension) - k.extensionOffset + k.extensionHeight
  from = sub(k.crossBarEnd, resize(extension, k.extensionHeight))
  k.shapes.push({ a: from, b: add(from, resize(extension, extensionHeight)) })
  orthogonalText(k)
  const { poly } = knockoutPolygon(k.text, Math.trunc(k.text.w / 2), penOf(k.text))
  knockOut(poly, { a: k.crossBarStart, b: k.crossBarEnd }, k.shapes)
  const angle = angleOf(sub(k.crossBarEnd, k.crossBarStart))
  if (k.inward) {
    drawArrow(k, k.crossBarStart, angle + 180, k.arrow * INWARD_ARROW_LENGTH_TO_HEAD_RATIO)
    drawArrow(k, k.crossBarEnd, angle, k.arrow * INWARD_ARROW_LENGTH_TO_HEAD_RATIO)
  } else {
    drawArrow(k, k.crossBarStart, angle, 0)
    drawArrow(k, k.crossBarEnd, angle + 180, 0)
  }
}

function leaderGeometry(k: Ki) {
  k.text.text = dimensionText(k.d, 0)
  const { box, poly } = knockoutPolygon(k.text, Math.trunc(k.text.w / 2), penOf(k.text) * 2)
  const first = sub(k.end, k.start)
  const start = add(k.start, resize(first, k.extensionOffset))
  const arrowSeg = { a: k.start, b: k.end }
  const textSeg = { a: k.end, b: k.text.pos }
  let arrowEnd: P | null
  let textEnd: P | null
  const circleRadius = Math.trunc(box.w / 2 - penOf(k.text) / 2)
  const centre = centreOf(box)
  if (k.frame === 2) {
    arrowEnd = segCircleIntersection(centre, circleRadius, arrowSeg)
    textEnd = segCircleIntersection(centre, circleRadius, textSeg)
  } else {
    arrowEnd = segPolyIntersection(poly, arrowSeg)
    textEnd = segPolyIntersection(poly, textSeg)
  }
  if (!arrowEnd) arrowEnd = k.end
  k.shapes.push({ a: start, b: arrowEnd })
  drawArrow(k, start, angleOf(first), 0)
  if (k.text.text !== "") {
    if (k.frame === 1) for (const s of polySegments(poly)) k.shapes.push(s)
    else if (k.frame === 2) k.circles.push({ c: centre, r: circleRadius })
  }
  if (textEnd && same(arrowEnd, k.end)) k.shapes.push({ a: k.end, b: textEnd })
}

function radialGeometry(k: Ki) {
  const centre = k.start
  let arm: P = { x: 0, y: k.arrow }
  k.shapes.push({ a: sub(centre, arm), b: add(centre, arm) })
  arm = rotate(arm, -90)
  k.shapes.push({ a: sub(centre, arm), b: add(centre, arm) })
  const radius = sub(k.end, k.start)
  k.measured = norm(radius)
  // `PCB_DIM_RADIAL::updateText`: keep aligned turns the text along the line from the knee to it, to the nearest degree.
  const radial = resize(radius, k.leaderLength)
  if (k.keep) {
    const knee = add(k.end, radial)
    let angle = fullCircleMinus(angleOf(sub(k.text.pos, knee)))
    if (angle > 90 && angle <= 270) angle -= 180
    k.text.angle = kiRound(angle)
  }
  k.text.text = dimensionText(k.d, k.measured)
  const { poly } = knockoutPolygon(k.text, Math.trunc(k.text.w / 2), penOf(k.text))
  const arrowSeg = { a: k.end, b: add(k.end, radial) }
  const textSeg = { a: arrowSeg.b, b: k.text.pos }
  knockOut(poly, arrowSeg, k.shapes)
  knockOut(poly, textSeg, k.shapes)
  drawArrow(k, k.end, angleOf(radial), 0)
}

function centreGeometry(k: Ki) {
  const centre = k.start
  let arm = sub(k.end, k.start)
  k.shapes.push({ a: sub(centre, arm), b: add(centre, arm) })
  arm = rotate(arm, -90)
  k.shapes.push({ a: sub(centre, arm), b: add(centre, arm) })
  k.text.pos = k.start
}

/** What a dimension draws: its lines and circles and its text, in millimetres in the dimension's own frame (y up), with the width the lines are drawn at. */
export interface DimensionDrawing {
  lines: { a: Vec2; b: Vec2 }[]
  circles: { c: Vec2; r: number }[]
  /** The text as KiCad shows it: its content, where it is anchored and the angle it is drawn at (a centre mark has none). */
  text: { content: string; x: number; y: number; rot: number } | null
  /** The measured value, in nanometres. */
  measured: number
}

const toMm = (p: P): Vec2 => ({ x: neg0(p.x / 1e6), y: neg0(-p.y / 1e6) })

const drawings = new WeakMap<BoardDimension, DimensionDrawing>()

/** The drawing of a dimension by KiCad's rules, kept for as long as the dimension object lives (a dimension is replaced, never edited). */
export function dimensionDrawing(d: BoardDimension): DimensionDrawing {
  const cached = drawings.get(d)
  if (cached) return cached
  const k = state(d)
  switch (d.kind) {
    case "aligned":
      alignedGeometry(k)
      break
    case "orthogonal":
      orthogonalGeometry(k)
      break
    case "leader":
      leaderGeometry(k)
      break
    case "radial":
      radialGeometry(k)
      break
    case "center":
      centreGeometry(k)
      break
  }
  const out: DimensionDrawing = {
    lines: k.shapes.map((s) => ({ a: toMm(s.a), b: toMm(s.b) })),
    circles: k.circles.map((c) => ({ c: toMm(c.c), r: c.r / 1e6 })),
    text: d.kind === "center" ? null : { content: k.text.text, x: toMm(k.text.pos).x, y: toMm(k.text.pos).y, rot: normalize360(k.text.angle) },
    measured: k.measured,
  }
  drawings.set(d, out)
  return out
}

/** The lines and circles of a dimension as drawings of its layer, each with the dimension's line width (KiCad plots each as a stroked line or an unfilled circle). */
export function dimensionShapes(d: BoardDimension): BoardShape[] {
  const draw = dimensionDrawing(d)
  const style = { layer: d.layer, width: d.thickness }
  return [...draw.lines.map((l): BoardShape => ({ type: "line", a: l.a, b: l.b, ...style })), ...draw.circles.map((c): BoardShape => ({ type: "circle", c: c.c, r: c.r, ...style }))]
}
