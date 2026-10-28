// An independent oracle for a board's drawings: every `gr_*`, `fp_*` and `target` of the raw file as
// geometry on the board (KiCad's frame, y down, millimetres), with the census's own reader
// (`sexpr.mjs`) and no code from `src/model`. The importer's project is compared with it drawing by
// drawing, to 0.001 mm: the same shapes on the same layers, the same circles, arcs, curves and
// ellipses, in the same places.
//
// A footprint's drawings are in the footprint's own frame, unturned, and the file stores a bottom
// footprint already flipped, so a point of a drawing is on the board at `at + R(angle) * local` as a
// pad's place is (pads.mjs, docs/kicad-import.md section 10). Layers are the file's own, mapped to
// KiCad's names by this file's own list (the board's table for copper; the Italian, Polish and
// French names KiCad translates in an old file).
//
// Curves are read as exact descriptions where there is one (a circle's centre and radius, an arc's
// circle and ends) and as a dense polyline otherwise (a Bezier curve by its definition, an ellipse by
// its parameterisation), and compared by the greatest distance from either to the other.

import { parseSexpr, kid, kids, numAt } from "./sexpr.mjs"

const D2R = Math.PI / 180

const TRANSLATED = {
  "Adesivo.Retro": "B.Adhes", "Adesivo.Fronte": "F.Adhes", "Pasta.Retro": "B.Paste", "Pasta.Fronte": "F.Paste",
  "Serigrafia.Retro": "B.SilkS", "Serigrafia.Fronte": "F.SilkS", "Maschera.Retro": "B.Mask", "Maschera.Fronte": "F.Mask",
  Grafica: "Dwgs.User", Commenti: "Cmts.User", Eco1: "Eco1.User", Eco2: "Eco2.User", "Contorno.scheda": "Edge.Cuts",
  Kleju_Dolna: "B.Adhes", Kleju_Gorna: "F.Adhes", Pasty_Dolna: "B.Paste", Pasty_Gorna: "F.Paste",
  Opisowa_Dolna: "B.SilkS", Opisowa_Gorna: "F.SilkS", Maski_Dolna: "B.Mask", Maski_Gorna: "F.Mask",
  Rysunkowa: "Dwgs.User", Komentarzy: "Cmts.User", ECO1: "Eco1.User", ECO2: "Eco2.User", Krawedziowa: "Edge.Cuts",
  "Dessous.Adhes": "B.Adhes", "Dessus.Adhes": "F.Adhes", "Dessous.Pate": "B.Paste", "Dessus.Pate": "F.Paste",
  "Dessous.SilkS": "B.SilkS", "Dessus.SilkS": "F.SilkS", "Dessous.Masque": "B.Mask", "Dessus.Masque": "F.Mask",
  "Dessin.User": "Dwgs.User", "Contours.Ci": "Edge.Cuts",
}
const DRAWING = /^(?:[FB]\.(?:SilkS|Mask|Paste|Fab|CrtYd|Adhes)|Dwgs\.User|Cmts\.User|Eco[12]\.User|Margin|User\.\d+)$/

/** The layer a file's name stands for, by this file's list: a KiCad drawing layer, `F.Cu`/`B.Cu`, `Edge.Cuts`, `inner`, or `unknown`. */
function canon(name, front, back, copperNames) {
  if (name === front) return "F.Cu"
  if (name === back) return "B.Cu"
  if (name === "Edge.Cuts") return "Edge.Cuts"
  if (DRAWING.test(name)) return name
  // an inner copper layer is told by its place in the table (X1): the first inner layer is In1.Cu, whatever the file calls it
  if (copperNames.includes(name) && copperNames.length > 2) return `In${copperNames.indexOf(name)}.Cu`
  if (/^In\d+\.Cu$/.test(name)) return "inner"
  const t = TRANSLATED[name]
  if (t) return t
  return "unknown"
}

const turn = (deg, [x, y]) => {
  const c = Math.cos(deg * D2R)
  const s = Math.sin(deg * D2R)
  return [x * c + y * s, -x * s + y * c]
}

/** The circle through three points, or null on a line. */
export function circleThrough(a, b, c) {
  const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]))
  if (Math.abs(d) < 1e-12) return null
  const a2 = a[0] ** 2 + a[1] ** 2
  const b2 = b[0] ** 2 + b[1] ** 2
  const c2 = c[0] ** 2 + c[1] ** 2
  const x = (a2 * (b[1] - c[1]) + b2 * (c[1] - a[1]) + c2 * (a[1] - b[1])) / d
  const y = (a2 * (c[0] - b[0]) + b2 * (a[0] - c[0]) + c2 * (b[0] - a[0])) / d
  return { c: [x, y], r: Math.hypot(a[0] - x, a[1] - y) }
}

/** Points along the arc a to c through b, dense enough that a chord is within 1e-5 mm of the circle. */
function arcPolyline(a, b, c) {
  // An arc that ends where it starts is a whole circle through its middle point (the circle's centre is halfway between the two).
  if (Math.hypot(a[0] - c[0], a[1] - c[1]) < 1e-9 && Math.hypot(a[0] - b[0], a[1] - b[1]) > 1e-9) {
    const ce = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
    const r = Math.hypot(a[0] - ce[0], a[1] - ce[1])
    const a0 = Math.atan2(a[1] - ce[1], a[0] - ce[0])
    return Array.from({ length: 721 }, (_, i) => (i === 0 || i === 720 ? a : [ce[0] + r * Math.cos(a0 + (i / 720) * 2 * Math.PI), ce[1] + r * Math.sin(a0 + (i / 720) * 2 * Math.PI)]))
  }
  const k = circleThrough(a, b, c)
  if (!k) return [a, c]
  const ang = (p) => Math.atan2(p[1] - k.c[1], p[0] - k.c[0])
  const a0 = ang(a)
  const am = ang(b)
  const a1 = ang(c)
  const norm = (x) => ((x % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)
  // The way round that passes through b.
  const ccw = norm(am - a0) < norm(a1 - a0)
  const sweep = ccw ? norm(a1 - a0) || 2 * Math.PI : -(norm(a0 - a1) || 2 * Math.PI)
  const n = Math.max(8, Math.ceil(Math.abs(sweep) / (2 * Math.acos(Math.max(-1, 1 - 1e-5 / k.r)))))
  const out = []
  for (let i = 0; i <= n; i++) out.push([k.c[0] + k.r * Math.cos(a0 + (sweep * i) / n), k.c[1] + k.r * Math.sin(a0 + (sweep * i) / n)])
  out[0] = a
  out[n] = c
  return out
}

function bezierPolyline(p0, p1, p2, p3) {
  const out = []
  const n = 2000
  for (let i = 0; i <= n; i++) {
    const t = i / n
    const u = 1 - t
    out.push([0, 1].map((k) => u ** 3 * p0[k] + 3 * u * u * t * p1[k] + 3 * u * t * t * p2[k] + t ** 3 * p3[k]))
  }
  return out
}

function ellipsePolyline(c, a, b, rotDeg, t0, t1) {
  const out = []
  const n = 4000
  const rot = rotDeg * D2R
  for (let i = 0; i <= n; i++) {
    const t = t0 + ((t1 - t0) * i) / n
    const lx = a * Math.cos(t)
    const ly = b * Math.sin(t)
    out.push([c[0] + lx * Math.cos(rot) - ly * Math.sin(rot), c[1] + lx * Math.sin(rot) + ly * Math.cos(rot)])
  }
  return out
}

const pt = (n) => [numAt(n, 1, NaN), numAt(n, 2, NaN)]

/**
 * The drawings of a board, in the board's frame. Each: `{ type, layer, layers, width, filled, dash, net, analytic?, lines }` where `lines` are
 * polylines (a closed outline repeats its first point) and `analytic` is `{ c, r }` for a circle or an arc.
 */
export function graphicsOracle(text) {
  const root = parseSexpr(text).find((n) => Array.isArray(n) && n[0] === "kicad_pcb")
  const version = numAt(kid(root, "version"), 1, NaN)
  const legacyArcs = Number.isFinite(version) && version <= 20210925
  const rows = (kid(root, "layers")?.slice(1) ?? []).filter(Array.isArray)
  const copperNames = rows.filter((r) => ["signal", "power", "mixed", "jumper"].includes(r[2])).map((r) => r[1])
  const front = copperNames[0] ?? "F.Cu"
  const back = copperNames[copperNames.length - 1] ?? "B.Cu"
  const out = { board: [], footprints: [], targets: [], skipped: { degenerate: 0 }, front, back }

  const shapesOf = (node, place, privateLayers, quarter = true) => {
    const list = []
    for (const c of node.slice(1)) {
      if (!Array.isArray(c)) continue
      let m = /^(?:gr|fp)_(line|arc|circle|rect|bbox|poly|curve|ellipse|ellipse_arc)$/.exec(c[0])
      // A KiCad 4 `segment` on a layer that is not copper, on no net and with no mask opening is a line on that layer (KiCad draws and plots it there).
      if (!m && c[0] === "segment" && !kid(c, "layers") && !kid(c, "solder_mask_margin") && !numAt(kid(c, "net"), 1, 0) && !/\.Cu$/.test(strOf(kid(c, "layer"))) && !copperNames.includes(strOf(kid(c, "layer"))) && strOf(kid(c, "layer")) !== "Edge.Cuts") m = ["", "line"]
      if (!m) continue
      const type = m[1]
      const layerNames = kid(c, "layers") ? kid(c, "layers").slice(1).filter((x) => typeof x === "string") : [strOf(kid(c, "layer"))]
      const layers = layerNames.map((n) => canon(n, front, back, copperNames))
      const stroke = kid(c, "stroke")
      let width = stroke ? numAt(kid(stroke, "width"), 1, 0) : numAt(kid(c, "width"), 1, 0)
      const dashWord = stroke ? kid(stroke, "type")?.[1] : undefined
      const fillNode = kid(c, "fill")
      const fillWord = fillNode ? (typeof fillNode[1] === "string" ? fillNode[1] : kid(fillNode, "type")?.[1]) : undefined
      let filled = fillNode ? ["solid", "yes", "true"].includes(fillWord) : type === "poly" ? !layerNames.includes("Edge.Cuts") : (type === "rect" || type === "circle") && width === 0
      if (width <= 0 && !filled) width = 0.1
      const P = (p) => place(p)
      const get = (name) => P(pt(kid(c, name)))
      let lines = []
      let analytic
      let ok = true
      if (type === "line") lines = [[get("start"), get("end")]]
      else if (type === "arc") {
        let s, mid, e
        if (legacyArcs && !kid(c, "mid")) {
          // The centre, the first end and a sweep that is clockwise on screen when positive (a y-down frame turns the end by -sweep).
          const centre = pt(kid(c, "start"))
          const first = pt(kid(c, "end"))
          const sweep = numAt(kid(c, "angle"), 1, 0)
          const turnAbout = (deg) => {
            const d = [first[0] - centre[0], first[1] - centre[1]]
            const r = turn(-deg, d)
            return [centre[0] + r[0], centre[1] + r[1]]
          }
          s = P(first)
          mid = P(turnAbout(sweep / 2))
          e = P(turnAbout(sweep))
        } else {
          s = get("start")
          mid = get("mid")
          e = get("end")
        }
        lines = [arcPolyline(s, mid, e)]
        analytic = circleThrough(s, mid, e)
        if (analytic) analytic = { ...analytic, ends: [s, e] }
      } else if (type === "circle") {
        const ce = get("center")
        const en = get("end")
        const r = Math.hypot(en[0] - ce[0], en[1] - ce[1])
        analytic = { c: ce, r }
        // A circle is compared by its centre and radius; its four extremes give the box.
        lines = [[[ce[0] + r, ce[1]], [ce[0], ce[1] + r], [ce[0] - r, ce[1]], [ce[0], ce[1] - r]]]
      } else if (type === "rect" || type === "bbox") {
        const a = pt(kid(c, "start"))
        const b = pt(kid(c, "end"))
        const radius = numAt(kid(c, "radius"), 1, 0)
        const x0 = Math.min(a[0], b[0])
        const x1 = Math.max(a[0], b[0])
        const y0 = Math.min(a[1], b[1])
        const y1 = Math.max(a[1], b[1])
        const r = Math.max(0, Math.min(radius, (x1 - x0) / 2, (y1 - y0) / 2))
        // Written for a footprint in its own frame, then placed: the corners of the rectangle in that frame.
        const loop = r < 1e-9
          ? [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]
          : [
              ...arcPolyline([x1 - r, y0], [x1 - r + r * Math.SQRT1_2, y0 + r - r * Math.SQRT1_2], [x1, y0 + r]),
              ...arcPolyline([x1, y1 - r], [x1 - r + r * Math.SQRT1_2, y1 - r + r * Math.SQRT1_2], [x1 - r, y1]),
              ...arcPolyline([x0 + r, y1], [x0 + r - r * Math.SQRT1_2, y1 - r + r * Math.SQRT1_2], [x0, y1 - r]),
              ...arcPolyline([x0, y0 + r], [x0 + r - r * Math.SQRT1_2, y0 + r - r * Math.SQRT1_2], [x0 + r, y0]),
              [x0 + r, y0],
            ]
        lines = [loop.map(P)]
      } else if (type === "poly") {
        const pts = kid(c, "pts")
        const items = (pts ?? []).slice(1).filter(Array.isArray)
        const ring = []
        for (const it of items) {
          if (it[0] === "xy") ring.push(P(pt(it)))
          else if (it[0] === "arc") {
            const s = P(pt(kid(it, "start")))
            const mid = P(pt(kid(it, "mid")))
            const e = P(pt(kid(it, "end")))
            const last = ring[ring.length - 1]
            if (!last || Math.hypot(last[0] - s[0], last[1] - s[1]) > 1e-7) ring.push(s)
            ring.push(...arcPolyline(s, mid, e).slice(1))
          }
        }
        if (ring.length < 3) {
          out.skipped.degenerate++
          ok = false
        } else lines = [[...ring, ring[0]]]
      } else if (type === "curve") {
        const p = kids(kid(c, "pts"), "xy").map((n) => P(pt(n)))
        lines = [bezierPolyline(p[0], p[1], p[2], p[3])]
      } else {
        // KiCad's parametric ellipse (shape_ellipse.cpp): (a cos t, b sin t) turned by the rotation in the file's own frame.
        const cx = pt(kid(c, "center"))
        const a = numAt(kid(c, "major_radius"), 1, NaN)
        const b = numAt(kid(c, "minor_radius"), 1, NaN)
        const rot = numAt(kid(c, "rotation_angle"), 1, 0)
        const arc = type === "ellipse_arc"
        const t0 = arc ? numAt(kid(c, "start_angle"), 1, 0) * D2R : 0
        let t1 = arc ? numAt(kid(c, "end_angle"), 1, 0) * D2R : 2 * Math.PI
        while (arc && t1 <= t0) t1 += 2 * Math.PI
        lines = [ellipsePolyline(cx, a, b, rot, t0, t1).map(P)]
      }
      if (!ok) continue
      for (const layer of layers) {
        if (privateLayers?.includes(layer)) continue
        list.push({
          type: type === "bbox" ? "rect" : type === "ellipse_arc" ? "ellipse" : type,
          layer,
          layers,
          width,
          filled: filled && ["circle", "rect", "bbox", "poly", "ellipse"].includes(type),
          dash: dashWord && !["default", "solid"].includes(dashWord) ? dashWord : null,
          net: kid(c, "net") ? (kid(c, "net")[2] ?? kid(c, "net")[1]) : null,
          quarter,
          analytic,
          lines,
        })
      }
    }
    return list
  }

  out.board = shapesOf(root, (p) => p)
  for (const t of kids(root, "target")) {
    const at = pt(kid(t, "at"))
    const size = numAt(kid(t, "size"), 1, 0)
    const width = numAt(kid(t, "width"), 1, 0)
    const layer = canon(strOf(kid(t, "layer")), front, back, copperNames)
    out.targets.push({ at, size, width, layer, x: t.includes("x") })
  }
  for (const f of [...kids(root, "footprint"), ...kids(root, "module")]) {
    // From stamp 20260616 a footprint has `(transform (translate x y) (rotate a))` for `(at x y a)`.
    const atNode = kid(f, "at")
    const tf = kid(f, "transform")
    const at = atNode ? pt(atNode) : pt(kid(tf, "translate"))
    const angle = atNode ? numAt(atNode, 3, 0) : numAt(kid(tf, "rotate"), 1, 0)
    const place = (p) => {
      const r = turn(angle, p)
      return [at[0] + r[0], at[1] + r[1]]
    }
    const props = kids(f, "property")
    const refProp = props.find((p) => p[1] === "Reference")?.[2]
    const refText = kids(f, "fp_text").find((t) => t[1] === "reference")?.[2]
    out.footprints.push({
      ref: refProp ?? refText ?? "",
      name: f[1],
      shapes: shapesOf(f, place, kid(f, "private_layers")?.slice(1).filter((x) => typeof x === "string").map((n) => canon(n, front, back, copperNames)), Math.abs(angle / 90 - Math.round(angle / 90)) * 90 < 1e-9),
    })
  }
  return out
}

const strOf = (n) => (Array.isArray(n) && typeof n[1] === "string" ? n[1] : "")

/** The greatest distance from a point to a polyline. */
function pointToLine(p, line) {
  let best = Infinity
  for (let i = 0; i + 1 < line.length; i++) {
    const a = line[i]
    const b = line[i + 1]
    const dx = b[0] - a[0]
    const dy = b[1] - a[1]
    const l2 = dx * dx + dy * dy
    const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2))
    best = Math.min(best, Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy)))
  }
  return line.length === 1 ? Math.hypot(p[0] - line[0][0], p[1] - line[0][1]) : best
}

/** The Hausdorff distance between two polylines (each sampled at its vertices, so densely drawn ones are compared well). */
export function lineDistance(a, b) {
  let worst = 0
  for (const p of a) worst = Math.max(worst, pointToLine(p, b))
  for (const p of b) worst = Math.max(worst, pointToLine(p, a))
  return worst
}

/** The distance from a point to a segment. */
function pointToSegment(p, a, b) {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const l2 = dx * dx + dy * dy
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2))
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy))
}

/** Every point of `a` is within `eps` of some segment of `b`: found through a grid of `b`'s segments, so a polyline of a hundred thousand points costs no more than its length. */
function pointsNear(a, b, eps) {
  if (b.length < 2) return a.every((p) => b.length === 1 && Math.hypot(p[0] - b[0][0], p[1] - b[0][1]) <= eps)
  const CELL = Math.max(eps * 20, 0.02)
  const grid = new Map()
  const cellOf = (v) => Math.floor(v / CELL)
  for (let i = 0; i + 1 < b.length; i++) {
    const x0 = cellOf(Math.min(b[i][0], b[i + 1][0]) - eps)
    const x1 = cellOf(Math.max(b[i][0], b[i + 1][0]) + eps)
    const y0 = cellOf(Math.min(b[i][1], b[i + 1][1]) - eps)
    const y1 = cellOf(Math.max(b[i][1], b[i + 1][1]) + eps)
    // A long diagonal would fill its whole box: test each cell of the box against the segment instead.
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        if ((x1 - x0 + 1) * (y1 - y0 + 1) > 64) {
          const c = [(x + 0.5) * CELL, (y + 0.5) * CELL]
          if (pointToSegment(c, b[i], b[i + 1]) > CELL * 0.75 + eps) continue
        }
        const k = `${x},${y}`
        const list = grid.get(k)
        if (list) list.push(i)
        else grid.set(k, [i])
      }
    }
  }
  return a.every((p) => (grid.get(`${cellOf(p[0])},${cellOf(p[1])}`) ?? []).some((i) => pointToSegment(p, b[i], b[i + 1]) <= eps))
}

/** The Hausdorff distance between two polylines is at most `eps` (each sampled at its vertices, as `lineDistance` does). */
export function lineWithin(a, b, eps) {
  return pointsNear(a, b, eps) && pointsNear(b, a, eps)
}
