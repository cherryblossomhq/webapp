// An independent oracle for a board's dimensions, groups and reference images: the raw file read with the census's own reader (`sexpr.mjs`), the dimensions
// read the way KiCad's parser reads them and drawn the way KiCad draws them, and no code from `src/model` or `src/lib`. The importer's project is compared with it
// dimension by dimension (what each draws, to a micrometre, and what it says), group by group (what each holds), and image by image.
//
// KiCad's rules are written here again from its source (pcbnew/pcb_dimension.cpp, pcb_io_kicad_sexpr_parser.cpp `parseDIMENSION`, `parseGROUP`, `resolveGroups`,
// `parsePCB_REFERENCE_IMAGE`, common/eda_text.cpp `GetTextBox`, common/font/font.cpp `StringBoundaryLimits`, common/bitmap_base.cpp), but in a different shape from the
// importer's: floating point in millimetres where KiCad and the importer work in integer nanometres, directions as angles (`atan2`) where the importer rotates vectors
// with KiCad's `RotatePoint`, and a parametric clip of the crossbar against the text's box where the importer intersects segments with polygon edges. Where the two could
// share a mistake (what a rule means), the oracle's reading is the source's text, not the importer's code. They agree to a few nanometres, not exactly; the tests compare to a micrometre.
//
// For a KiCad 5 dimension the oracle also gives the file's own cached geometry (its arrows, crossbar and feature lines) which KiCad does not read: the arrows and the crossbar
// are the same lines KiCad now draws, and are compared; the feature lines are longer in the file, and are compared by where they start and which way they go.
//
// Ported from KiCad as the importer's is (Copyright The KiCad Developers, GNU General Public License, version 2 or (at your option) any later version).

import { readFileSync } from "node:fs"
import { kid, kids, numAt, parseSexpr } from "./sexpr.mjs"
import { penWidth } from "./texts.mjs"

const D2R = Math.PI / 180
const sign = (v) => (v > 0 ? 1 : v < 0 ? -1 : 0)
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]]
const add = (a, b) => [a[0] + b[0], a[1] + b[1]]
const mul = (a, k) => [a[0] * k, a[1] * k]
const len = (a) => Math.hypot(a[0], a[1])
const unit = (a) => (len(a) === 0 ? [0, 0] : mul(a, 1 / len(a)))
const at = (node, i, d = 0) => numAt(node, i, d)

// ---------- the file ----------

const TRANSLATED = {
  "Adesivo.Retro": "B.Adhes", "Adesivo.Fronte": "F.Adhes", "Pasta.Retro": "B.Paste", "Pasta.Fronte": "F.Paste", "Serigrafia.Retro": "B.SilkS", "Serigrafia.Fronte": "F.SilkS",
  "Maschera.Retro": "B.Mask", "Maschera.Fronte": "F.Mask", Grafica: "Dwgs.User", Commenti: "Cmts.User", Eco1: "Eco1.User", Eco2: "Eco2.User", "Contorno.scheda": "Edge.Cuts",
  Kleju_Dolna: "B.Adhes", Kleju_Gorna: "F.Adhes", Pasty_Dolna: "B.Paste", Pasty_Gorna: "F.Paste", Opisowa_Dolna: "B.SilkS", Opisowa_Gorna: "F.SilkS", Maski_Dolna: "B.Mask",
  Maski_Gorna: "F.Mask", Rysunkowa: "Dwgs.User", Komentarzy: "Cmts.User", ECO1: "Eco1.User", ECO2: "Eco2.User", Krawedziowa: "Edge.Cuts", "Dessous.Adhes": "B.Adhes",
  "Dessus.Adhes": "F.Adhes", "Dessous.Pate": "B.Paste", "Dessus.Pate": "F.Paste", "Dessous.SilkS": "B.SilkS", "Dessus.SilkS": "F.SilkS", "Dessous.Masque": "B.Mask",
  "Dessus.Masque": "F.Mask", "Dessin.User": "Dwgs.User", "Contours.Ci": "Edge.Cuts",
}

/** The layer a file's name stands for: the front and back copper of the file's own table become `F.Cu` and `B.Cu`. */
function canonLayer(name, front, back) {
  if (name === front) return "F.Cu"
  if (name === back) return "B.Cu"
  return TRANSLATED[name] ?? name
}

const uuidOf = (n) => {
  const u = kid(n, "uuid") ?? kid(n, "tstamp")
  return u ? u[1] : null
}

const yes = (n, name) => {
  for (let i = 1; i < n.length; i++) {
    if (n[i] === name) return true
    if (Array.isArray(n[i]) && n[i][0] === name) return n[i][1] === undefined || n[i][1] === "yes" || n[i][1] === "true"
  }
  return false
}

// ---------- the text a dimension says ----------

const UNIT_LABEL = [" in", " mils", " mm"]

function valueText(measured, units, precision, zeros) {
  const u = units === 0 || units === 1 || units === 2 ? units : 2
  let digits = precision
  if (digits >= 6) digits = u === 0 ? digits - 4 : u === 1 ? Math.max(0, digits - 7) : digits - 5
  const v = u === 2 ? measured : u === 1 ? measured / 0.0254 : measured / 25.4
  let t = v.toFixed(digits)
  if (zeros && digits > 0) {
    while (t.endsWith("0")) {
      t = t.slice(0, -1)
      if (t.endsWith(".")) {
        t = t.slice(0, -1)
        break
      }
    }
  }
  return t
}

function shownText(d, measured) {
  let t = d.override !== null ? d.override : valueText(measured, d.units, d.precision, d.zeros)
  if (d.format === 1) t += UNIT_LABEL[d.units === 0 || d.units === 1 || d.units === 2 ? d.units : 2]
  else if (d.format === 2) t += ` (${UNIT_LABEL[d.units === 0 || d.units === 1 || d.units === 2 ? d.units : 2].trimStart()})`
  return `${d.prefix}${t}${d.suffix}`
}

/** What the file's own text unit names (KiCad's `FetchUnitsFromString`): 0 inches, 1 mils, 2 millimetres, 3 none named, 4 another unit. */
function unitsOfString(text) {
  const t = text.trim()
  let i = 0
  while (i < t.length && /[0-9.,+-]/.test(t[i])) i++
  const u = t.slice(i).trimStart().slice(0, 2).toLowerCase()
  if (["um", "µm", "μm", "cm", "de", "ra", "fs", "ps"].includes(u)) return 4
  if (u === "mm") return 2
  if (u === "mi" || u === "th") return 1
  if (u === "in" || u === '"') return 0
  return 3
}

// ---------- the dimension, as the parser reads it ----------

function readDimension(n, front, back) {
  let i = 1
  let locked = false
  if (n[i] === "locked") {
    locked = true
    i++
  }
  if (typeof n[i] === "string") i++
  const first = n[i]
  const legacy = Array.isArray(first) && first[0] === "width"
  const type = legacy ? "aligned" : (kid(n, "type")?.[1] ?? "aligned")
  const kind = ["aligned", "orthogonal", "leader", "center", "radial"].includes(type) ? type : "aligned"
  const d = {
    legacy,
    kind,
    layer: "Dwgs.User",
    uuid: uuidOf(n),
    locked,
    a: [0, 0],
    b: [0, 0],
    height: 0,
    vertical: false,
    extH: null,
    extOff: 0,
    leaderLen: null,
    frame: 0,
    thick: 0.2,
    arrow: 1.27,
    inward: false,
    mode: 0,
    keep: kind === "aligned" || kind === "orthogonal" || kind === "radial",
    units: 0,
    format: kind === "aligned" || kind === "orthogonal" ? 1 : 0,
    precision: 4,
    zeros: false,
    prefix: kind === "radial" ? "R " : "",
    suffix: "",
    override: kind === "leader" ? "Leader" : kind === "center" ? "" : null,
    text: null,
    cached: null,
  }
  if (legacy) d.thick = at(first, 1)
  let f1 = null
  let f2 = null
  let bar = null
  const cached = { arrows: [], feature1: null, feature2: null }
  for (let k = legacy ? i + 1 : i; k < n.length; k++) {
    const c = n[k]
    if (!Array.isArray(c)) continue
    const xy = (node) => kids(node, "xy").map((p) => [at(p, 1), at(p, 2)])
    switch (c[0]) {
      case "layer":
        d.layer = canonLayer(c[1], front, back)
        break
      case "uuid":
      case "tstamp":
        d.uuid = c[1]
        break
      case "gr_text": {
        const eff = kid(c, "effects")
        const font = kid(eff, "font")
        const size = kid(font, "size")
        const justify = (kid(eff, "justify") ?? []).slice(1)
        const atn = kid(c, "at")
        d.text = {
          raw: c[1],
          x: at(atn, 1),
          y: at(atn, 2),
          angle: at(atn, 3),
          h: size ? at(size, 1) : 1.524,
          w: size ? at(size, 2) : 1.524,
          thickness: at(kid(font, "thickness"), 1),
          bold: yes(font ?? [], "bold"),
          italic: yes(font ?? [], "italic"),
          mirror: justify.includes("mirror"),
          hj: justify.includes("left") ? -1 : justify.includes("right") ? 1 : 0,
          vj: justify.includes("top") ? -1 : justify.includes("bottom") ? 1 : 0,
        }
        d.layer = canonLayer(kid(c, "layer")?.[1] ?? d.layer, front, back)
        d.uuid = uuidOf(c) ?? d.uuid
        if (yes(c, "locked")) d.locked = true
        if (legacy) d.units = unitsOfString(c[1])
        break
      }
      case "pts": {
        const p = xy(c)
        if (p[0]) d.a = p[0]
        if (p[1]) d.b = p[1]
        break
      }
      case "height":
        if (kind === "aligned" || kind === "orthogonal") d.height = at(c, 1)
        break
      case "leader_length":
        if (kind === "radial") d.leaderLen = at(c, 1)
        break
      case "orientation":
        if (kind === "orthogonal") d.vertical = Math.min(1, Math.max(0, Math.trunc(at(c, 1)))) === 1
        break
      case "format":
        for (const f of c.slice(1)) {
          if (!Array.isArray(f)) continue
          if (f[0] === "prefix") d.prefix = f[1] ?? ""
          else if (f[0] === "suffix") d.suffix = f[1] ?? ""
          else if (f[0] === "units") {
            const m = Math.max(0, Math.min(4, Math.trunc(at(f, 1))))
            if (m !== 4) d.units = m
          } else if (f[0] === "units_format") d.format = Math.max(0, Math.min(3, Math.trunc(at(f, 1))))
          else if (f[0] === "precision") d.precision = Math.trunc(at(f, 1))
          else if (f[0] === "override_value") d.override = f[1] ?? ""
          else if (f[0] === "suppress_zeroes") d.zeros = f[1] === undefined || f[1] === "yes" || f[1] === "true"
        }
        break
      case "style":
        d.keep = false
        for (const s of c.slice(1)) {
          // a bare `keep_text_aligned` is the flag on (the file's own spelling in the first typed format)
          if (s === "keep_text_aligned") d.keep = true
          if (!Array.isArray(s)) continue
          if (s[0] === "thickness") d.thick = at(s, 1)
          else if (s[0] === "arrow_direction") d.inward = s[1] === "inward"
          else if (s[0] === "arrow_length") d.arrow = at(s, 1)
          else if (s[0] === "text_position_mode") d.mode = Math.min(2, Math.max(0, Math.trunc(at(s, 1))))
          else if (s[0] === "extension_height") d.extH = at(s, 1)
          else if (s[0] === "extension_offset") d.extOff = at(s, 1)
          else if (s[0] === "keep_text_aligned") d.keep = s[1] === undefined || s[1] === "yes" || s[1] === "true"
          else if (s[0] === "text_frame") d.frame = Math.max(0, Math.min(3, Math.trunc(at(s, 1))))
        }
        break
      case "feature1":
        f1 = xy(kid(c, "pts"))
        cached.feature1 = f1
        break
      case "feature2":
        f2 = xy(kid(c, "pts"))
        cached.feature2 = f2
        break
      case "crossbar":
        bar = xy(kid(c, "pts"))
        cached.crossbar = bar
        break
      case "arrow1a":
      case "arrow1b":
      case "arrow2a":
      case "arrow2b":
        cached.arrows.push(xy(kid(c, "pts")))
        break
      case "locked":
        d.locked = c[1] === undefined || c[1] === "yes" || c[1] === "true"
        break
      default:
        break
    }
  }
  if (legacy) {
    if (f1?.[0]) d.a = f1[0]
    if (f2?.[0]) d.b = f2[0]
    if (bar && bar.length >= 2) {
      // `UpdateHeight`: the distance from the first feature point to the crossbar's second end, signed by which side the bar runs.
      const h = sub(bar[1], d.a)
      const cb = sub(bar[0], bar[1])
      d.height = (h[0] * cb[1] - h[1] * cb[0] > 0 ? -1 : 1) * Math.trunc(len(h) * 1e6) / 1e6
    }
    d.keep = true
    d.mode = 0
    d.cached = cached
  }
  return d
}

// ---------- the text's box ----------

/** The box of the text before it is turned, as `EDA_TEXT::GetTextBox` makes it: [x, y, w, h] in millimetres. */
function textBox(font, d, shown, pos) {
  const t = d.text
  const pen = penWidth({ thickness: t.thickness, bold: t.bold, w: t.w, h: t.h })
  const glyph = (code) => font.glyphs[code - 32 >= 0 && code - 32 < font.glyphs.length ? code - 32 : "?".charCodeAt(0) - 32]
  const line = shown.split("\n")[0]
  let adv = 0
  for (const ch of line) adv += (glyph(ch.codePointAt(0)).width / 21) * t.w
  const ew = Math.abs(adv - 0.2 * t.w) + 2 * 1.5 * pen
  const eh = t.h + 2 * 1.5 * pen
  const fudge = 0.17 * eh
  const w = ew
  const h = eh + fudge
  let x = pos[0]
  let y = pos[1]
  const italicOff = t.italic ? t.h / 8 : 0
  if (t.hj === -1) {
    if (t.mirror) x -= w - italicOff
  } else if (t.hj === 0) x -= (w - italicOff) / 2
  else if (!t.mirror) x -= w - italicOff
  if (t.vj === -1) y -= fudge
  else if (t.vj === 0) y -= h / 2
  else y = y - h + fudge
  return { x, y, w, h, pen }
}

/** The text's box grown by (dx, dy) and turned by `angle` degrees (KiCad's positive angle turns counter-clockwise on screen, y down), as the four corners. */
function knockoutCorners(box, dx, dy, angle) {
  let { x, y, w, h } = box
  if (w < -2 * dx) {
    x += w / 2
    w = 0
  } else {
    x -= dx
    w += 2 * dx
  }
  if (h < -2 * dy) {
    y += h / 2
    h = 0
  } else {
    y -= dy
    h += 2 * dy
  }
  const c = [x + w / 2, y + h / 2]
  const a = angle * D2R
  const turn = (p) => {
    const v = sub(p, c)
    // a positive angle moves (1, 0) to (cos a, -sin a) on screen (y down)
    return add(c, [v[0] * Math.cos(a) + v[1] * Math.sin(a), -v[0] * Math.sin(a) + v[1] * Math.cos(a)])
  }
  return [turn([x, y]), turn([x, y + h]), turn([x + w, y + h]), turn([x + w, y])]
}

/** The parts of the segment a-b that lie outside a convex polygon, by clipping along the segment. */
function outside(poly, a, b) {
  const dir = sub(b, a)
  let t0 = 0
  let t1 = 1
  // Cyrus-Beck against the polygon's edges, whichever way it winds.
  let area = 0
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i]
    const q = poly[(i + 1) % poly.length]
    area += p[0] * q[1] - q[0] * p[1]
  }
  const s = area >= 0 ? 1 : -1
  let degenerate = false
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i]
    const q = poly[(i + 1) % poly.length]
    const edge = sub(q, p)
    // inward normal
    const nrm = [-edge[1] * s, edge[0] * s]
    const num = nrm[0] * (a[0] - p[0]) + nrm[1] * (a[1] - p[1])
    const den = nrm[0] * dir[0] + nrm[1] * dir[1]
    if (Math.abs(den) < 1e-12) {
      if (num < 0) degenerate = true
    } else {
      const t = -num / den
      if (den > 0) t0 = Math.max(t0, t)
      else t1 = Math.min(t1, t)
    }
  }
  const inside = !degenerate && t0 < t1
  if (!inside || (t0 >= 1 && t1 >= 1)) return [[a, b]]
  const pt = (t) => add(a, mul(dir, t))
  const out = []
  if (t0 > 1e-9) out.push([a, pt(t0)])
  if (t1 < 1 - 1e-9) out.push([pt(t1), b])
  return out
}

// ---------- what it draws ----------

const ARROW = 27.5

/** The barbs of an arrowhead at p whose shaft runs along `dirDeg` (an `atan2` angle in a y-down frame), with a tail of `tail` mm when it has one. */
function arrowAt(p, dirDeg, arrow, tail) {
  const segs = []
  const along = (deg, l) => add(p, [l * Math.cos(deg * D2R), l * Math.sin(deg * D2R)])
  if (tail) segs.push([p, along(dirDeg, tail)])
  segs.push([p, along(dirDeg - ARROW, arrow)])
  segs.push([p, along(dirDeg + ARROW, arrow)])
  return segs
}

const deg = (v) => (v[0] === 0 && v[1] === 0 ? 0 : (Math.atan2(v[1], v[0]) * 180) / Math.PI)
const norm360 = (a) => ((a % 360) + 360) % 360

/** What a dimension draws, from KiCad's rules: its lines, its circles and its text. */
export function drawDimension(d, font) {
  const lines = []
  const circles = []
  let measured = 0
  const text = d.text ? { ...d.text } : { x: d.a[0], y: d.a[1], angle: 0, h: 1.524, w: 1.524, thickness: 0, bold: false, italic: false, mirror: false, hj: 0, vj: 0 }
  let pos = [text.x, text.y]
  let angle = text.angle
  const extH = d.extH ?? 0.586
  const pen = penWidth({ thickness: text.thickness, bold: text.bold, w: text.w, h: text.h })
  const content = () => shownText(d, measured)
  if (d.kind === "aligned" || d.kind === "orthogonal") {
    let cs
    let ce
    const ortho = d.kind === "orthogonal"
    if (!ortho) {
      const v = sub(d.b, d.a)
      measured = len(v)
      const n = unit(d.height > 0 ? [-v[1], v[0]] : [v[1], -v[0]])
      const reach = Math.abs(d.height) - d.extOff + extH
      lines.push([add(d.a, mul(n, d.extOff)), add(d.a, mul(n, d.extOff + reach))])
      lines.push([add(d.b, mul(n, d.extOff)), add(d.b, mul(n, d.extOff + reach))])
      cs = add(d.a, mul(n, Math.abs(d.height)))
      ce = add(d.b, mul(n, Math.abs(d.height)))
    } else {
      measured = Math.abs(d.vertical ? d.b[1] - d.a[1] : d.b[0] - d.a[0])
      const dirv = d.vertical ? [sign(d.height), 0] : [0, sign(d.height)]
      cs = add(d.a, mul(dirv, Math.abs(d.height)))
      ce = d.vertical ? [cs[0], d.b[1]] : [d.b[0], cs[1]]
      const reach1 = Math.abs(d.height) - d.extOff + extH
      lines.push([add(d.a, mul(dirv, d.extOff)), add(d.a, mul(dirv, d.extOff + reach1))])
      const back = d.vertical ? [d.b[0] - ce[0], 0] : [0, d.b[1] - ce[1]]
      const reach2 = len(back) - d.extOff + extH
      const bu = unit(back)
      const from = sub(ce, mul(bu, extH))
      lines.push([from, add(from, mul(bu, reach2))])
    }
    // the text: KiCad places it by the aligned rule for both (the orthogonal one calls it last)
    const half = mul(sub(ce, cs), 0.5)
    if (d.mode === 0) {
      const dist = pen + text.h
      const rot = half[0] === 0 ? 90 * sign(-half[1]) : half[0] < 0 ? -90 : 90
      const v = rot === 90 ? [half[1], -half[0]] : rot === -90 ? [-half[1], half[0]] : [half[0], half[1]]
      pos = add(cs, add(half, mul(unit(v), dist)))
    } else if (d.mode === 1) pos = add(cs, half)
    if (d.keep) {
      let a = norm360(360 - deg(half))
      if (a > 90 && a <= 270) a -= 180
      angle = a
    }
    const shown = content()
    const box = textBox(font, { ...d, text }, shown, pos)
    const poly = knockoutCorners(box, text.w / 2, ortho ? pen : -pen, angle)
    for (const s of outside(poly, cs, ce)) lines.push(s)
    const dim = ortho ? deg(sub(ce, cs)) : deg(sub(d.b, d.a))
    if (d.inward) {
      lines.push(...arrowAt(cs, dim + 180, d.arrow, d.arrow * 2))
      lines.push(...arrowAt(ce, dim, d.arrow, d.arrow * 2))
    } else {
      lines.push(...arrowAt(cs, dim, d.arrow, 0))
      lines.push(...arrowAt(ce, dim + 180, d.arrow, 0))
    }
    return { lines, circles, text: { content: shown, x: pos[0], y: pos[1], angle: norm360(angle) }, measured }
  }
  if (d.kind === "center") {
    const arm = sub(d.b, d.a)
    lines.push([sub(d.a, arm), add(d.a, arm)])
    const perp = [-arm[1], arm[0]]
    lines.push([sub(d.a, perp), add(d.a, perp)])
    return { lines, circles, text: null, measured: 0 }
  }
  if (d.kind === "radial") {
    lines.push([[d.a[0], d.a[1] - d.arrow], [d.a[0], d.a[1] + d.arrow]])
    lines.push([[d.a[0] - d.arrow, d.a[1]], [d.a[0] + d.arrow, d.a[1]]])
    const r = sub(d.b, d.a)
    measured = len(r)
    const ll = d.leaderLen ?? 3 * 1.27
    const run = mul(unit(r), ll)
    const knee = add(d.b, run)
    if (d.keep) {
      let a = norm360(360 - deg(sub(pos, knee)))
      if (a > 90 && a <= 270) a -= 180
      angle = Math.round(a)
    }
    const shown = content()
    const box = textBox(font, { ...d, text }, shown, pos)
    const poly = knockoutCorners(box, text.w / 2, pen, angle)
    for (const s of outside(poly, d.b, knee)) lines.push(s)
    for (const s of outside(poly, knee, pos)) lines.push(s)
    lines.push(...arrowAt(d.b, deg(run), d.arrow, 0))
    return { lines, circles, text: { content: shown, x: pos[0], y: pos[1], angle: norm360(angle) }, measured }
  }
  // leader
  const shown = shownText({ ...d }, 0)
  const box = textBox(font, { ...d, text }, shown, pos)
  const poly = knockoutCorners(box, text.w / 2, pen * 2, angle)
  const first = sub(d.b, d.a)
  const start = add(d.a, mul(unit(first), d.extOff))
  const centre = [box.x - text.w / 2 + (box.w + text.w) / 2, box.y - pen * 2 + (box.h + 4 * pen) / 2]
  const radius = Math.trunc(((box.w + text.w) / 2 - pen / 2) * 1e6) / 1e6
  const clipFrom = (p, q, fromA) => {
    // where the segment p-q first meets the frame, coming from p (or from q), or null when that end is inside it
    const pieces = d.frame === 2 ? circleOutside(centre, radius, p, q) : outside(poly, p, q)
    if (pieces.length === 1 && pieces[0][0] === p && pieces[0][1] === q) return null
    const mine = fromA ? pieces.find((s) => s[0] === p) : pieces.find((s) => s[1] === q)
    return mine ? (fromA ? mine[1] : mine[0]) : null
  }
  const arrowEnd = clipFrom(d.a, d.b, true) ?? d.b
  lines.push([start, arrowEnd])
  lines.push(...arrowAt(start, deg(first), d.arrow, 0))
  if (shown !== "") {
    if (d.frame === 1) for (let i = 0; i < 4; i++) lines.push([poly[i], poly[(i + 1) % 4]])
    else if (d.frame === 2) circles.push({ c: centre, r: radius })
  }
  const textEnd = clipFrom(d.b, pos, true)
  if (textEnd && arrowEnd[0] === d.b[0] && arrowEnd[1] === d.b[1]) lines.push([d.b, textEnd])
  return { lines, circles, text: { content: shown, x: pos[0], y: pos[1], angle: norm360(angle) }, measured: 0 }
}

function circleOutside(c, r, a, b) {
  const d = sub(b, a)
  const f = sub(a, c)
  const A = d[0] * d[0] + d[1] * d[1]
  const B = 2 * (f[0] * d[0] + f[1] * d[1])
  const C = f[0] * f[0] + f[1] * f[1] - r * r
  const disc = B * B - 4 * A * C
  if (A === 0 || disc < 0) return [[a, b]]
  const t0 = (-B - Math.sqrt(disc)) / (2 * A)
  const t1 = (-B + Math.sqrt(disc)) / (2 * A)
  if (t1 < 0 || t0 > 1 || (t0 <= 0 && t1 >= 1)) return t0 <= 0 && t1 >= 1 ? [] : [[a, b]]
  const pt = (t) => add(a, mul(d, t))
  const out = []
  if (t0 > 0) out.push([a, pt(t0)])
  if (t1 < 1) out.push([pt(t1), b])
  return out
}

// ---------- the board ----------

/** Every dimension of the board file, as the parser reads it, with what each draws. */
export function dimensionOracle(text, font) {
  const root = parseSexpr(text)[0]
  const layers = kid(root, "layers") ?? []
  const copper = layers.slice(1).filter((l) => Array.isArray(l) && ["signal", "power", "mixed", "jumper"].includes(l[2])).map((l) => l[1])
  const front = copper[0] ?? "F.Cu"
  const back = copper[copper.length - 1] ?? "B.Cu"
  const stamp = kid(root, "version") ? at(kid(root, "version"), 1) : null
  const dims = kids(root, "dimension").map((n) => {
    const d = readDimension(n, front, back)
    return { ...d, drawn: drawDimension(d, font) }
  })
  const inFootprints = kids(root, "footprint").concat(kids(root, "module")).reduce((n, f) => n + kids(f, "dimension").length, 0)
  return { stamp, dims, inFootprints, front, back }
}

// ---------- groups ----------

/** A short signature of what a node of the file is, to say what a group holds without the importer's ids. */
function signature(node, front, back) {
  const head = node[0]
  const xy = (n, k) => [at(kid(n, k), 1), at(kid(n, k), 2)]
  const layer = canonLayer(kid(node, "layer")?.[1] ?? "", front, back)
  const r = (v) => Math.round(v * 1000) / 1000
  if (head === "footprint" || head === "module") return { kind: "part", at: [r(at(kid(node, "at"), 1)), r(at(kid(node, "at"), 2))], layer }
  if (head === "segment") return { kind: "segment", layer, a: xy(node, "start").map(r), b: xy(node, "end").map(r) }
  if (head === "via") return { kind: "via", at: xy(node, "at").map(r) }
  if (head === "gr_text" || head === "gr_text_box") return { kind: "text", layer, text: node[1] }
  if (head === "dimension") return { kind: "dimension" }
  if (head === "image") return { kind: "image", at: xy(node, "at").map(r), layer }
  if (head === "target") return { kind: "target" }
  if (head === "zone") return { kind: "zone" }
  if (head === "arc") return { kind: "arctrack" }
  if (head.startsWith("gr_") || head.startsWith("fp_")) return { kind: "shape", shape: head.slice(3), layer }
  if (head === "group") return { kind: "group" }
  if (head === "pad") return { kind: "pad", number: node[1] }
  return { kind: head }
}

/**
 * The groups of the board file as KiCad resolves them (`resolveGroups` and `EDA_GROUP::AddItem`): in the file's order, an id that names nothing is skipped, an
 * item is in one group (a later group takes it), a group never goes into itself or into a group it is inside of. Each group is its name, its lock and what it
 * holds by signature; nested groups are listed by their place in the survivors. Groups with nothing in them are left out, as KiCad writes none.
 */
export function groupOracle(text) {
  const root = parseSexpr(text)[0]
  const layers = kid(root, "layers") ?? []
  const copper = layers.slice(1).filter((l) => Array.isArray(l) && ["signal", "power", "mixed", "jumper"].includes(l[2])).map((l) => l[1])
  const front = copper[0] ?? "F.Cu"
  const back = copper[copper.length - 1] ?? "B.Cu"
  /** `scope` is the footprint node the group is in, or null for the board. */
  const resolveIn = (groupNodes, items) => {
    const byId = new Map()
    for (const [id, node] of items) if (id && !byId.has(id)) byId.set(id, node)
    const gid = (g) => kid(g, "uuid")?.[1] ?? kid(g, "id")?.[1] ?? null
    const index = new Map()
    groupNodes.forEach((g, i) => gid(g) && !index.has(gid(g)) && index.set(gid(g), i))
    const parent = new Map()
    const held = groupNodes.map(() => [])
    const inside = (inner, outer) => {
      for (let p = parent.get(`g${inner}`); p !== undefined; p = parent.get(`g${p}`)) if (p === outer) return true
      return false
    }
    groupNodes.forEach((g, i) => {
      const members = (kid(g, "members") ?? []).slice(1).filter((x) => typeof x === "string")
      for (const m of members) {
        let key
        let member
        if (index.has(m)) {
          const c = index.get(m)
          if (c === i || inside(i, c)) continue
          key = `g${c}`
          member = { group: c }
        } else if (byId.has(m)) {
          key = `i${m}`
          member = { item: m }
        } else continue
        const was = parent.get(key)
        if (was !== undefined) held[was] = held[was].filter((x) => ("group" in x ? `g${x.group}` : `i${x.item}`) !== key)
        held[i].push(member)
        parent.set(key, i)
      }
    })
    const alive = []
    const lives = (i) => (alive[i] ??= held[i].some((m) => ("item" in m ? true : lives(m.group))))
    const kept = groupNodes.map((_, i) => i).filter((i) => lives(i))
    const place = new Map(kept.map((g, p) => [g, p]))
    return kept.map((i) => {
      const g = groupNodes[i]
      return {
        name: g[0] === "generated" ? (kid(g, "name")?.[1] ?? "") : typeof g[1] === "string" && g[1] !== "locked" ? g[1] : "",
        locked: g.slice(1).includes("locked") || yes(g, "locked"),
        items: held[i].filter((m) => "item" in m).map((m) => signature(byId.get(m.item), front, back)),
        groups: held[i].filter((m) => "group" in m && place.has(m.group)).map((m) => place.get(m.group)),
        lib: kid(g, "lib_id")?.[1] ?? null,
      }
    })
  }
  const board = []
  // KiCad's PCB_GENERATOR (a tuning pattern, a via stack, via stitching: the file's `(generated` node) is a PCB_GROUP, and the parser resolves it with the groups, after the plain ones.
  // Its name is the node's `(name "...")`, not a bare string. KiCad treats both as groups (they select and move as one), so both count here.
  const generated = []
  const rootItems = []
  for (const c of root.slice(1)) {
    if (!Array.isArray(c)) continue
    if (c[0] === "group") board.push(c)
    else if (c[0] === "generated") generated.push(c)
    else rootItems.push([uuidOf(c), c])
  }
  board.push(...generated)
  const partGroups = []
  const footprints = kids(root, "footprint").concat(kids(root, "module"))
  const parts = footprints.map((fp, i) => {
    const children = []
    for (const c of fp.slice(1)) if (Array.isArray(c) && c[0] !== "group") children.push([uuidOf(c), c])
    const nodes = kids(fp, "group")
    return { i, groups: resolveIn(nodes, children), padCount: kids(fp, "pad").length }
  })
  for (const p of parts) if (p.groups.length) partGroups.push(p)
  return { board: resolveIn(board, rootItems), parts: partGroups }
}

// ---------- images ----------

/** Every reference image of the board file: where, on which layer, how big (pixels and resolution as KiCad reads them), and its bytes. */
export function imageOracle(text) {
  const root = parseSexpr(text)[0]
  const layers = kid(root, "layers") ?? []
  const copper = layers.slice(1).filter((l) => Array.isArray(l) && ["signal", "power", "mixed", "jumper"].includes(l[2])).map((l) => l[1])
  const front = copper[0] ?? "F.Cu"
  const back = copper[copper.length - 1] ?? "B.Cu"
  const stamp = kid(root, "version") ? at(kid(root, "version"), 1) : null
  return kids(root, "image").map((n) => {
    const data = (kid(n, "data") ?? []).slice(1).filter((x) => typeof x === "string").join("")
    const bytes = Buffer.from(data.replace(/\s+/g, ""), "base64")
    const png = bytes.length > 33 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    let px = 0
    let py = 0
    let perMetre = 0
    if (png) {
      px = bytes.readUInt32BE(16)
      py = bytes.readUInt32BE(20)
      for (let o = 33; o + 8 <= bytes.length; ) {
        const length = bytes.readUInt32BE(o)
        const type = bytes.toString("latin1", o + 4, o + 8)
        if (type === "IDAT" || type === "IEND") break
        if (type === "pHYs" && bytes[o + 16] === 1) perMetre = bytes.readUInt32BE(o + 8)
        o += 12 + length
      }
    }
    // pixels per inch as KiCad rounds it from pixels per centimetre, with and without the truncation older files were made for
    const cm = perMetre / 100
    const exact = cm > 1 ? Math.round(cm * 2.54) : 300
    const legacy = Math.trunc(cm) > 1 ? Math.round(Math.trunc(cm) * 2.54) : exact
    const scaleNode = kid(n, "scale")
    const scale = scaleNode ? at(scaleNode, 1, 1) : 1
    return {
      at: [at(kid(n, "at"), 1), at(kid(n, "at"), 2)],
      layer: canonLayer(kid(n, "layer")?.[1] ?? "", front, back),
      scale: Number.isFinite(scale) && scale !== 0 ? scale : 1,
      locked: yes(n, "locked"),
      bytes,
      png,
      px,
      py,
      ppi: stamp !== null && stamp < 20260623 ? legacy : exact,
      uuid: uuidOf(n),
    }
  })
}

export const readText = (path) => readFileSync(path, "utf8")
