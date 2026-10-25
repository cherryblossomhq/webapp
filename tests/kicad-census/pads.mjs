// An independent oracle for a board's pads: where every pad is on the board and which net it is
// on, from the raw file, with the census's own reader (`sexpr.mjs`) and no code from
// `src/model/kicad`. The importer's reader and its projects are compared against it, pad by pad,
// to 0.001 mm.
//
// It computes places a different way from the importer. The importer composes angles and mirrors
// as numbers; this builds KiCad's own transform as matrices in the board frame (y down, a positive
// angle counter-clockwise on screen): the library footprint is flipped about its x axis when it is
// on the bottom, then turned by the footprint's angle, then moved to its position
// (`FOOTPRINT::Flip`, footprint.cpp line 3504; docs/kicad-import.md section 10), and the stored
// (already flipped) pad position is taken back to the library frame first. A pad's outline is its
// own corners turned by its absolute angle (`PAD::GetOrientation`, pad.cpp line 1795) about its
// place, the trapezoid's corners as `TransformTrapezoidToPolygon` has them.
//
// Net names are the file's own text, as KiCad's parser would hold them: before stamp 20210606 an
// overbar written `~DSS~` is `~{DSS}` (this file has its own port of that conversion, not the
// importer's), and nothing else is decoded or trimmed.

import { parseSexpr, kid, kids, numAt } from "./sexpr.mjs"
import { padDetail } from "./pad-detail.mjs"

const D2R = Math.PI / 180

// ---- 3 by 3 matrices on (x, y, 1), applied to column vectors; row-major arrays ----
const mul = (a, b) => {
  const out = new Array(9).fill(0)
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) out[i * 3 + j] += a[i * 3 + k] * b[k * 3 + j]
  return out
}
const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1]
const translate = (x, y) => [1, 0, x, 0, 1, y, 0, 0, 1]
/** Counter-clockwise on screen in a y-down frame: x' = x cos + y sin, y' = -x sin + y cos. */
const turn = (deg) => {
  const c = Math.cos(deg * D2R)
  const s = Math.sin(deg * D2R)
  return [c, s, 0, -s, c, 0, 0, 0, 1]
}
/** Flip about the x axis: y becomes -y. */
const FLIP = [1, 0, 0, 0, -1, 0, 0, 0, 1]
const apply = (m, [x, y]) => [m[0] * x + m[1] * y + m[2], m[3] * x + m[4] * y + m[5]]

/** KiCad's `ConvertToNewOverbarNotation`, ported again here from string_utils.cpp lines 87 to 143. */
export function overbarOf(text) {
  if (text === "~") return text
  // a tilde, then what follows it: `~~{`, `~~`, `~{` and a lone `~` are the four cases
  let out = ""
  let open = false
  let i = 0
  while (i < text.length) {
    const here = text[i]
    const rest = text.slice(i + 1, i + 3)
    if (here === "~") {
      if (rest[0] === "~" && rest[1] === "{") {
        out += "~~{}"
        i += 1
        continue
      }
      if (rest[0] === "~") {
        out += "~"
        i += 2
        continue
      }
      if (rest[0] === "{") return text
      out += open ? "}" : "~{"
      open = !open
      i += 1
      continue
    }
    if (open && (here === " " || here === "}" || here === ")")) {
      out += "}"
      open = false
    }
    out += here
    i += 1
  }
  return open ? out + "}" : out
}

/** The corners of a pad's outline in its own frame (y down, before its turn), as KiCad draws it. */
function corners(shape, w, h, delta) {
  const hx = w / 2
  // a circle's diameter is the size's x, whatever the size's y says (pad.cpp lines 1482 and 3126)
  const hy = shape === "circle" ? w / 2 : h / 2
  if (shape === "trapezoid") {
    const dx = (delta?.[0] ?? 0) / 2
    const dy = (delta?.[1] ?? 0) / 2
    return [
      [-hx + dy, -hy - dx],
      [hx - dy, -hy + dx],
      [hx + dy, hy - dx],
      [-hx - dy, hy + dx],
    ]
  }
  return [
    [-hx, -hy],
    [hx, -hy],
    [hx, hy],
    [-hx, hy],
  ]
}

/**
 * Every footprint with its pads, in file order: `{ ref, x, y, angle, bottom, pads: [{ number, type, shape, x, y, angle, w, h, net, box }] }`
 * with the pads' x and y on the board, in KiCad's frame (y down), `box` the extent of the outline
 * on the board (`{ w, h }`, null for a custom pad, whose outline is its primitives), and `net` the
 * file's own name for the pad's net or null.
 */
export function oracle(text) {
  const root = parseSexpr(text)
  const board = root.find((n) => Array.isArray(n) && n[0] === "kicad_pcb")
  const stamp = numAt(kid(board, "version"), 1, null)
  const layers = kid(board, "layers")
  const copper = (layers ? layers.slice(1) : []).filter((l) => Array.isArray(l) && ["signal", "power", "mixed", "jumper"].includes(l[2])).map((l) => l[1])
  const back = copper.length ? copper[copper.length - 1] : "B.Cu"
  const old = stamp !== null && stamp < 20210606
  const named = (name) => (old ? overbarOf(name) : name)
  const names = new Map()
  for (const n of kids(board, "net")) names.set(n[1], named(n[2] ?? ""))
  const netOf = (pad) => {
    const k = kid(pad, "net")
    if (!k) return null
    const name = k.length >= 3 ? named(k[2]) : stamp !== null && stamp >= 20251028 ? named(k[1]) : names.get(k[1])
    return name ? name : null
  }
  const fps = []
  for (const fp of board.slice(1)) {
    if (!Array.isArray(fp) || (fp[0] !== "footprint" && fp[0] !== "module")) continue
    const at = kid(fp, "at")
    const tf = kid(fp, "transform")
    const t = tf ? kid(tf, "translate") : null
    const x = at ? numAt(at, 1) : numAt(t, 1)
    const y = at ? numAt(at, 2) : numAt(t, 2)
    const angle = at ? numAt(at, 3) : numAt(kid(tf, "rotate"), 1)
    const layer = kid(fp, "layer")?.[1] ?? ""
    const bottom = layer === back || layer === "B.Cu"
    // library to board: flip (bottom only), then turn, then move
    const toBoard = mul(translate(x, y), mul(turn(angle), bottom ? FLIP : IDENTITY))
    const refNode = kids(fp, "fp_text").find((q) => q[1] === "reference") ?? kids(fp, "property").find((q) => q[1] === "Reference")
    const pads = kids(fp, "pad").map((p) => {
      const pa = kid(p, "at")
      const size = kid(p, "size")
      const stored = [numAt(pa, 1), numAt(pa, 2)]
      // the file stores the flipped state; the library's place is the flip of it
      const lib = bottom ? apply(FLIP, stored) : stored
      const [px, py] = apply(toBoard, lib)
      const padAngle = numAt(pa, 3, 0)
      const w = numAt(size, 1)
      const h = numAt(size, 2)
      const rd = kid(p, "rect_delta")
      // a pad of no size (either way) is a micron square, as KiCad's parser makes it (parsePAD, 9.0.0 `:5485`, 10.0.0 `:6412`)
      const kw = w <= 0 || h <= 0 ? 0.001 : w
      const kh = w <= 0 || h <= 0 ? 0.001 : h
      const own = p[3] === "custom" ? null : corners(p[3], kw, kh, rd ? [numAt(rd, 1), numAt(rd, 2)] : null)
      let box = null
      if (p[3] === "circle") {
        // a circle is as wide as its size's x whatever its turn (KiCad's pad.cpp), and as high
        box = { w: kw, h: kw }
      } else if (p[3] === "oval") {
        // a stadium: its centre line of length (long - short) turned by the pad's angle, grown by the short side's half, in each axis
        const long = Math.max(kw, kh)
        const short = Math.min(kw, kh)
        const axis = ((padAngle + (kw >= kh ? 0 : 90)) * Math.PI) / 180
        box = { w: (long - short) * Math.abs(Math.cos(axis)) + short, h: (long - short) * Math.abs(Math.sin(axis)) + short }
      } else if (own) {
        const placed = own.map((c) => apply(mul(translate(px, py), turn(padAngle)), c))
        const xs = placed.map((c) => c[0])
        const ys = placed.map((c) => c[1])
        box = { w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) }
      }
      const detail = padDetail(p, { stamp, copper, px, py, padAngle, kw, kh, fp })
      return {
        number: String(p[1] ?? ""),
        type: p[2],
        shape: p[3],
        x: px,
        y: py,
        // where the copper's centre is on the board: the pad's place moved by the shape offset, turned with the pad (ShapePos)
        cx: detail.cx,
        cy: detail.cy,
        angle: padAngle,
        w,
        h,
        net: netOf(p),
        box,
        detail,
      }
    })
    fps.push({ ref: refNode ? (refNode[2] ?? "") : "", x, y, angle, bottom, pads })
  }
  return fps
}

/**
 * What the file says about footprint flags and the nets of tracks and vias, read again from the raw
 * text for the corpus test to compare the importer's project with: every footprint with its `attr`
 * words, whether it has an `attr` node, its `tags`, its net tie and jumper groups and its pad numbers,
 * and every segment and via with the file's own net name, its length and whether it is locked
 * (`locked`, or bit 0x40000 of a KiCad 4 or 5 `status`). Segments are counted whole: arcs are another
 * extension.
 */
export function copperOracle(text) {
  const root = parseSexpr(text)
  const board = root.find((n) => Array.isArray(n) && n[0] === "kicad_pcb")
  const stamp = numAt(kid(board, "version"), 1, null)
  const old = stamp !== null && stamp < 20210606
  const named = (name) => (old ? overbarOf(name) : name)
  const names = new Map()
  for (const n of kids(board, "net")) names.set(n[1], named(n[2] ?? ""))
  // `(net 1 "A")`, `(net 1)` through the table, or `(net "A")` from stamp 20251028 (a development file may still write a number there)
  const netOf = (node) => {
    const k = kid(node, "net")
    if (!k) return null
    const name = k.length >= 3 ? named(k[2]) : names.has(k[1]) ? names.get(k[1]) : stamp !== null && stamp >= 20251028 ? named(k[1]) : undefined
    return name ? name : null
  }
  const locked = (node) => {
    if (node.some((c, i) => i > 0 && c === "locked")) return true
    const l = kid(node, "locked")
    if (l && (l[1] === undefined || l[1] === "yes" || l[1] === "true")) return true
    const st = kid(node, "status")
    const v = st ? parseInt(st[1], 16) : NaN
    return Number.isFinite(v) && (v & 0x40000) !== 0
  }
  const footprints = []
  for (const fp of board.slice(1)) {
    if (!Array.isArray(fp) || (fp[0] !== "footprint" && fp[0] !== "module")) continue
    const attr = kid(fp, "attr")
    const refNode = kids(fp, "fp_text").find((q) => q[1] === "reference") ?? kids(fp, "property").find((q) => q[1] === "Reference")
    const ties = []
    for (const g of kids(fp, "net_tie_pad_groups")) for (const s of g.slice(1)) if (typeof s === "string") ties.push(s.split(",").map((x) => x.trim()).filter(Boolean))
    const jumpers = []
    for (const g of kids(fp, "jumper_pad_groups")) for (const s of g.slice(1)) if (Array.isArray(s)) jumpers.push(s.filter((x) => typeof x === "string"))
    const dup = kid(fp, "duplicate_pad_numbers_are_jumpers")
    footprints.push({
      ref: refNode ? (refNode[2] ?? "") : "",
      attr: attr ? attr.slice(1).filter((a) => typeof a === "string") : [],
      hasAttr: !!attr,
      tags: kid(fp, "tags")?.[1] ?? "",
      ties,
      jumpers,
      jumperDuplicates: !!dup && (dup[1] === undefined || dup[1] === "yes" || dup[1] === "true"),
      padNumbers: kids(fp, "pad").map((p) => String(p[1] ?? "")),
    })
  }
  const segments = kids(board, "segment").map((s) => {
    const a = kid(s, "start")
    const b = kid(s, "end")
    return { net: netOf(s), length: Math.hypot(numAt(a, 1) - numAt(b, 1), numAt(a, 2) - numAt(b, 2)), locked: locked(s), layer: kid(s, "layer")?.[1] ?? "" }
  })
  const vias = kids(board, "via").map((v) => ({ net: netOf(v), locked: locked(v) }))
  return { stamp, footprints, segments, vias }
}
