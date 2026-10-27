import { Clipper64, ClipType, FillRule, PolyTree64, type Path64, type PolyPath64 } from "@countertype/clipper2-ts"
import { decodeBase64, encodeBase64 } from "../lib/imageFacts"
import type { TextBox, TextOutline, Vec2 } from "./types"

// Text drawn in a TrueType font (X19). KiCad draws such a text with the outlines of the font's letters and writes them into the board
// (`render_cache`): the polygons are the exact shape KiCad plots, so they are what this editor keeps, draws and plots, for as long as the text is
// still what they were drawn for. The editor has no TrueType rasteriser: a text whose content, size, weight, slant, justification, spacing or font
// is changed has lost its outlines (KiCad throws its cache away on the same edits), is drawn in the stroke font instead, and says so.
//
// The polygons are stored once, in the frame of the board, in whole nanometres, with the pose of the text they were drawn at (`TextOutline.at`). The
// text's pose now maps them (a move, a turn of any angle, a mirror, a part moved or flipped: `outlineRings`), the identity when nothing moved, so what
// the file gave is what comes back, to the nanometre.

/** Where a text is and how it is drawn: its anchor (mm, y up), the angle it is drawn at (degrees counter-clockwise) and whether it is mirrored. */
export interface Pose {
  x: number
  y: number
  rot: number
  mirror: boolean
}

/** What a cached outline was drawn for, besides the text it shows and its pose. */
export interface OutlineLook {
  face: string
  size: number
  w: number
  bold: boolean
  italic: boolean
  hj: number
  vj: number
  spacing: number
  box?: TextBox
}

/** The signature of what a text's outlines depend on (`TextOutline.sig`): equal signatures draw the same letters. */
/**
 * The font a text is said to be in when the file caches its outlines and names no font. It only lets the outlines be kept and the report name them: the writer never writes it
 * as a `face` (the user's board has no such font), only the outlines.
 */
export const UNNAMED_FONT = "a font the file does not name"

export const textOutlineSignature = (l: OutlineLook): string => [l.face, l.size, l.w, l.bold ? 1 : 0, l.italic ? 1 : 0, l.hj, l.vj, l.spacing, ...(l.box ? [l.box.w, l.box.h, ...l.box.margins] : [])].join("|")

// ---------- the packed rings ----------

/** A ring: x, y, x, y... in whole nanometres. */
export type Ring = number[]

/** What KiCad's file calls one `polygon`: a glyph's outline and its holes, as the file groups them. */
export type Polygon = Ring[]

const zig = (n: number) => (n >= 0 ? 2 * n : -2 * n - 1)
const unzig = (n: number) => (n % 2 === 0 ? n / 2 : -(n + 1) / 2)

function pushVarint(out: number[], n: number) {
  let v = n
  while (v >= 128) {
    out.push((v % 128) + 128)
    v = Math.floor(v / 128)
  }
  out.push(v)
}

/**
 * The polygons as one string: base64 of a byte stream of variable length integers (7 bits a byte, the sign folded in): the number of polygons, then for each
 * its number of rings, and for each ring its number of points, the first point whole and every other as its step from the one before. The steps along a
 * letter's curve are small, so a point costs 3 to 6 bytes where the file's own text costs 25.
 */
export function packRings(polygons: Polygon[]): string {
  const bytes: number[] = []
  pushVarint(bytes, polygons.length)
  for (const poly of polygons) {
    pushVarint(bytes, poly.length)
    for (const r of poly) {
      const n = r.length / 2
      pushVarint(bytes, n)
      let px = 0
      let py = 0
      for (let i = 0; i < n; i++) {
        pushVarint(bytes, zig(r[2 * i] - px))
        pushVarint(bytes, zig(r[2 * i + 1] - py))
        px = r[2 * i]
        py = r[2 * i + 1]
      }
    }
  }
  return encodeBase64(Uint8Array.from(bytes))
}

/** The polygons a string holds, or null when it is not one. */
export function unpackRings(packed: string): Polygon[] | null {
  const bytes = decodeBase64(packed)
  if (!bytes) return null
  let at = 0
  const next = (): number | null => {
    let v = 0
    let scale = 1
    for (;;) {
      if (at >= bytes.length || scale > 2 ** 49) return null
      const b = bytes[at++]
      v += (b % 128) * scale
      if (b < 128) return v
      scale *= 128
    }
  }
  const count = next()
  if (count === null || count > bytes.length) return null
  const polygons: Polygon[] = []
  for (let i = 0; i < count; i++) {
    const rings = next()
    if (rings === null || rings > bytes.length - at) return null
    const poly: Polygon = []
    for (let j = 0; j < rings; j++) {
      const n = next()
      if (n === null || n * 2 > bytes.length - at + 2) return null
      const r: Ring = []
      let x = 0
      let y = 0
      for (let k = 0; k < n; k++) {
        const dx = next()
        const dy = next()
        if (dx === null || dy === null) return null
        x += unzig(dx)
        y += unzig(dy)
        r.push(x, y)
      }
      poly.push(r)
    }
    polygons.push(poly)
  }
  return at === bytes.length ? polygons : null
}

// ---------- placing them ----------

const cache = new WeakMap<TextOutline, { polygons: Polygon[] | null }>()

/** The polygons of an outline as stored, unpacked once. */
export function storedRings(o: TextOutline): Polygon[] {
  let hit = cache.get(o)
  if (!hit) {
    hit = { polygons: unpackRings(o.rings) }
    cache.set(o, hit)
  }
  return hit.polygons ?? []
}

const NM = 1e6

/**
 * The outline's rings where the text is now: the pose it was drawn at taken back, then the pose it has. A text that has not moved gets the stored
 * rings themselves; any other pose maps each point as a rigid motion (a turn of any angle, a mirror, a move), rounded to a nanometre.
 */
export function outlineRings(o: TextOutline, now: Pose): Polygon[] {
  const rings = storedRings(o)
  const was = o.at
  if (was.x === now.x && was.y === now.y && was.rot === now.rot && (was.mirror === true) === now.mirror) return rings
  const flip = (was.mirror === true) !== now.mirror
  const a = (-was.rot * Math.PI) / 180
  const b = (now.rot * Math.PI) / 180
  const ca = Math.cos(a)
  const sa = Math.sin(a)
  const cb = Math.cos(b)
  const sb = Math.sin(b)
  return rings.map((poly) =>
    poly.map((r) => {
      const out: Ring = new Array(r.length)
      for (let i = 0; i < r.length; i += 2) {
        const dx = r[i] / NM - was.x
        const dy = r[i + 1] / NM - was.y
        let qx = dx * ca - dy * sa
        const qy = dx * sa + dy * ca
        if (flip) qx = -qx
        out[i] = Math.round((now.x + qx * cb - qy * sb) * NM)
        out[i + 1] = Math.round((now.y + qx * sb + qy * cb) * NM)
      }
      return out
    }),
  )
}

// ---------- as polygons ----------

/** The outer rings with their holes of a polygon tree, each ring first and its holes after. */
export function collect(node: PolyPath64, out: Path64[][]) {
  for (let i = 0; i < node.count; i++) {
    const outer = node.child(i)
    if (!outer.poly) continue
    const group: Path64[] = [outer.poly]
    for (let j = 0; j < outer.count; j++) {
      const hole = outer.child(j)
      if (hole.poly) group.push(hole.poly)
      collect(hole, out)
    }
    out.push(group)
  }
}

/**
 * The letters as polygons, each its outer ring and then its holes (millimetres, y up): the rings are KiCad's glyph outlines, a hole being a ring wound the other
 * way, so the filled shape is their union by the non-zero rule, which is what a letter is.
 */
export function ringsToPolygons(rings: Ring[]): Vec2[][][] {
  const paths: Path64[] = rings.filter((r) => r.length >= 6).map((r) => Array.from({ length: r.length / 2 }, (_, i) => ({ x: r[2 * i], y: r[2 * i + 1] })))
  if (!paths.length) return []
  const tree = new PolyTree64()
  const c = new Clipper64()
  c.addSubject(paths)
  c.execute(ClipType.Union, FillRule.NonZero, tree)
  const groups: Path64[][] = []
  collect(tree, groups)
  return groups.map((g) => g.map((ring) => ring.map((p) => ({ x: p.x / NM, y: p.y / NM }))))
}
