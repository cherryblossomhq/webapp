// The pad in full, from the raw file and KiCad's rules, sharing no code with `src`: its copper as a signed distance, its hole, its layers and
// its settings. Used by `pads.mjs` (the oracle of a board's pads) and the corpus test.
//
// Everything is read in the file's own frame (y down, the stored state of a part on the bottom, a pad's angle absolute): the shape is the stored
// shape turned by the pad's angle about its centre, so how the importer takes a part on the bottom back to the library's frame (the pad's own turn,
// its flipped corners and drawings) is checked by this and not assumed. The rules are KiCad's: the pad's shape word and what makes it a chamfered
// rectangle, a rounded rectangle's ratio, a custom pad's anchor, a pad of no size, the zero of an old file, what a footprint gives its pads, and the
// layers a non-plated hole is flashed on (pad.cpp 10.0.0 `:440-475`).

import { kid, kids, numAt } from "./sexpr.mjs"

// KiCad's own translated layer names of old boards (Italian, Polish, French; `createOldLayerMapping`), as the pad layer lists of such a board use them
const TRANSLATED_LAYER_NAMES = {
  "Adesivo.Retro": "B.Adhes",
  "Adesivo.Fronte": "F.Adhes",
  "Pasta.Retro": "B.Paste",
  "Pasta.Fronte": "F.Paste",
  "Serigrafia.Retro": "B.SilkS",
  "Serigrafia.Fronte": "F.SilkS",
  "Maschera.Retro": "B.Mask",
  "Maschera.Fronte": "F.Mask",
  Grafica: "Dwgs.User",
  Commenti: "Cmts.User",
  Eco1: "Eco1.User",
  Eco2: "Eco2.User",
  "Contorno.scheda": "Edge.Cuts",
  Kleju_Dolna: "B.Adhes",
  Kleju_Gorna: "F.Adhes",
  Pasty_Dolna: "B.Paste",
  Pasty_Gorna: "F.Paste",
  Opisowa_Dolna: "B.SilkS",
  Opisowa_Gorna: "F.SilkS",
  Maski_Dolna: "B.Mask",
  Maski_Gorna: "F.Mask",
  Rysunkowa: "Dwgs.User",
  Komentarzy: "Cmts.User",
  ECO1: "Eco1.User",
  ECO2: "Eco2.User",
  Krawedziowa: "Edge.Cuts",
  "Dessous.Adhes": "B.Adhes",
  "Dessus.Adhes": "F.Adhes",
  "Dessous.Pate": "B.Paste",
  "Dessus.Pate": "F.Paste",
  "Dessous.SilkS": "B.SilkS",
  "Dessus.SilkS": "F.SilkS",
  "Dessous.Masque": "B.Mask",
  "Dessus.Masque": "F.Mask",
  "Dessin.User": "Dwgs.User",
  "Contours.Ci": "Edge.Cuts",
}


const D2R = Math.PI / 180

/** A vector turned counter-clockwise on screen in a y-down frame. */
const rot = ([x, y], deg) => {
  const c = Math.cos(deg * D2R)
  const s = Math.sin(deg * D2R)
  return [x * c + y * s, -x * s + y * c]
}

const segDist = (q, a, b) => {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const l = dx * dx + dy * dy
  const t = l === 0 ? 0 : Math.max(0, Math.min(1, ((q[0] - a[0]) * dx + (q[1] - a[1]) * dy) / l))
  return Math.hypot(q[0] - (a[0] + t * dx), q[1] - (a[1] + t * dy))
}

const sdBox = (q, hx, hy) => {
  const dx = Math.abs(q[0]) - hx
  const dy = Math.abs(q[1]) - hy
  return Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0)
}

const sdStadium = (q, w, h) => {
  const r = Math.min(w, h) / 2
  const half = Math.max(w, h) / 2 - r
  return (w >= h ? segDist(q, [-half, 0], [half, 0]) : segDist(q, [0, -half], [0, half])) - r
}

/** Signed distance to a polygon (negative inside). */
const sdPoly = (q, pts) => {
  let best = Infinity
  let inside = false
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    best = Math.min(best, segDist(q, pts[i], pts[j]))
    if (pts[i][1] > q[1] !== pts[j][1] > q[1] && q[0] < ((pts[j][0] - pts[i][0]) * (q[1] - pts[i][1])) / (pts[j][1] - pts[i][1]) + pts[i][0]) inside = !inside
  }
  return inside ? -best : best
}

const polyline = (q, pts) => {
  let best = Infinity
  for (let i = 0; i + 1 < pts.length; i++) best = Math.min(best, segDist(q, pts[i], pts[i + 1]))
  return best
}

/** Points along the arc of the circle through three points that passes through the middle one, half a degree apart at most. */
const arcPoints = (a, m, b) => {
  const d = 2 * (a[0] * (m[1] - b[1]) + m[0] * (b[1] - a[1]) + b[0] * (a[1] - m[1]))
  if (Math.abs(d) < 1e-12) return [a, b]
  const a2 = a[0] ** 2 + a[1] ** 2
  const m2 = m[0] ** 2 + m[1] ** 2
  const b2 = b[0] ** 2 + b[1] ** 2
  const cx = (a2 * (m[1] - b[1]) + m2 * (b[1] - a[1]) + b2 * (a[1] - m[1])) / d
  const cy = (a2 * (b[0] - m[0]) + m2 * (a[0] - b[0]) + b2 * (m[0] - a[0])) / d
  const r = Math.hypot(a[0] - cx, a[1] - cy)
  const t0 = Math.atan2(a[1] - cy, a[0] - cx)
  const tm = Math.atan2(m[1] - cy, m[0] - cx)
  const t1 = Math.atan2(b[1] - cy, b[0] - cx)
  const norm = (t) => ((t % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)
  const ccw = norm(tm - t0) < norm(t1 - t0)
  const sweep = ccw ? norm(t1 - t0) : -norm(t0 - t1)
  const n = Math.max(2, Math.ceil(Math.abs(sweep) / (Math.PI / 360)))
  return Array.from({ length: n + 1 }, (_, i) => [cx + r * Math.cos(t0 + (sweep * i) / n), cy + r * Math.sin(t0 + (sweep * i) / n)])
}

/** A drawing of a custom pad as a signed distance (negative inside what it covers), in the pad's frame. */
function primitiveSd(g, stamp) {
  const num = (name, i) => numAt(kid(g, name), i, 0)
  const pt = (name) => [num(name, 1), num(name, 2)]
  const stroke = kid(g, "stroke")
  const widthNode = stroke ? kid(stroke, "width") : kid(g, "width")
  let width = numAt(widthNode, 1, 0)
  const fillNode = kid(g, "fill")
  const fillWord = fillNode ? (fillNode[1] ?? kid(fillNode, "type")?.[1]) : undefined
  const kind = g[0].slice(3)
  // KiCad: with no fill word a polygon is filled, and so is a rectangle or circle of no width; a shape of no width that is not filled has the default one (parsePCB_SHAPE 10.0.0 `:3561`)
  const filled = fillNode ? ["solid", "yes", "true"].includes(fillWord) : kind === "poly" ? true : (kind === "rect" || kind === "circle") && width === 0
  if (width <= 0 && !filled) width = 0.1
  const half = width / 2
  switch (kind) {
    case "line":
      return (q) => segDist(q, pt("start"), pt("end")) - half
    case "arc": {
      let pts
      if (stamp !== null && stamp <= 20210925 && !kid(g, "mid")) {
        const c = pt("start")
        const first = pt("end")
        const sweep = numAt(kid(g, "angle"), 1, 0)
        const v = [first[0] - c[0], first[1] - c[1]]
        const n = Math.max(2, Math.ceil(Math.abs(sweep) / 0.5))
        // a legacy arc sweeps clockwise on screen for a positive angle
        pts = Array.from({ length: n + 1 }, (_, i) => {
          const t = rot(v, (-sweep * i) / n)
          return [c[0] + t[0], c[1] + t[1]]
        })
      } else pts = arcPoints(pt("start"), pt("mid"), pt("end"))
      return (q) => polyline(q, pts) - half
    }
    case "circle": {
      const c = pt("center")
      const r = Math.hypot(num("end", 1) - c[0], num("end", 2) - c[1])
      return filled ? (q) => Math.hypot(q[0] - c[0], q[1] - c[1]) - r - half : (q) => Math.abs(Math.hypot(q[0] - c[0], q[1] - c[1]) - r) - half
    }
    case "rect": {
      const a = pt("start")
      const b = pt("end")
      const box = [a, [b[0], a[1]], b, [a[0], b[1]]]
      return filled ? (q) => sdPoly(q, box) - half : (q) => Math.abs(sdPoly(q, box)) - half
    }
    case "poly": {
      const pts = []
      for (const n of (kid(g, "pts") ?? []).slice(1)) {
        if (!Array.isArray(n)) continue
        if (n[0] === "xy") pts.push([numAt(n, 1), numAt(n, 2)])
        else if (n[0] === "arc") pts.push(...arcPoints([numAt(kid(n, "start"), 1), numAt(kid(n, "start"), 2)], [numAt(kid(n, "mid"), 1), numAt(kid(n, "mid"), 2)], [numAt(kid(n, "end"), 1), numAt(kid(n, "end"), 2)]))
      }
      return filled ? (q) => sdPoly(q, pts) - half : (q) => polyline(q, [...pts, pts[0]]) - half
    }
    case "curve": {
      const p = kids(kid(g, "pts"), "xy").map((n) => [numAt(n, 1), numAt(n, 2)])
      const pts = Array.from({ length: 401 }, (_, i) => {
        const t = i / 400
        const u = 1 - t
        return [u ** 3 * p[0][0] + 3 * u * u * t * p[1][0] + 3 * u * t * t * p[2][0] + t ** 3 * p[3][0], u ** 3 * p[0][1] + 3 * u * u * t * p[1][1] + 3 * u * t * t * p[2][1] + t ** 3 * p[3][1]]
      })
      return (q) => polyline(q, pts) - half
    }
    default:
      // gr_bbox and gr_vector are proxy items: never copper
      return () => Infinity
  }
}

/** The corners of a (rounded, chamfered) rectangle in the pad's frame, y down, as KiCad cuts them (convert_basic_shapes_to_polygon.cpp 10.0.0 `:459`). */
function roundChamferCorners(w, h, radius, chamferRatio, bits) {
  const hx = w / 2
  const hy = h / 2
  const base = [
    [-hx, -hy],
    [hx, -hy],
    [hx, hy],
    [-hx, hy],
  ]
  const r = Math.max(0, Math.min(radius, hx, hy))
  const cut = Math.max(0, chamferRatio * Math.min(w, h))
  // corners in order top left, top right, bottom right, bottom left; KiCad's bits for them: 1, 2, 8, 4 (RECT_CHAMFER_TOP_LEFT, TOP_RIGHT, BOTTOM_RIGHT, BOTTOM_LEFT)
  const bitOf = [1, 2, 8, 4]
  const sign = [0, 1, -1, 0, 0, -1, 1, 0]
  const out = []
  base.forEach(([x, y], cc) => {
    if (bits & bitOf[cc]) {
      if (cut === 0) {
        out.push([x, y])
        return
      }
      out.push([x + sign[(2 * cc) & 7] * cut, y + sign[(2 * cc - 2) & 7] * cut])
      out.push([x + sign[(2 * cc + 1) & 7] * cut, y + sign[(2 * cc - 1) & 7] * cut])
    } else if (r > 0) {
      const sx = x < 0 ? -1 : 1
      const sy = y < 0 ? -1 : 1
      const c = [x - sx * r, y - sy * r]
      // the outline runs top left, top right, bottom right, bottom left: it arrives at the odd corners (top right, bottom left) along a horizontal side and leaves along a vertical one, and at the others the other way
      const odd = cc % 2 === 1
      const a0 = odd ? Math.atan2(sy, 0) : Math.atan2(0, sx)
      const a1 = odd ? Math.atan2(0, sx) : Math.atan2(sy, 0)
      let d = a1 - a0
      while (d > Math.PI) d -= 2 * Math.PI
      while (d < -Math.PI) d += 2 * Math.PI
      const n = 90
      for (let i = 0; i <= n; i++) out.push([c[0] + r * Math.cos(a0 + (d * i) / n), c[1] + r * Math.sin(a0 + (d * i) / n)])
    } else out.push([x, y])
  })
  return out
}

/** A trapezoid's corners in the pad's frame (`TransformTrapezoidToPolygon`, convert_basic_shapes_to_polygon.cpp 10.0.0 `:386`). */
function trapezoidCorners(w, h, delta) {
  const hx = w / 2
  const hy = h / 2
  const dx = (delta?.[0] ?? 0) / 2
  const dy = (delta?.[1] ?? 0) / 2
  return [
    [-hx + dy, -hy - dx],
    [hx - dy, -hy + dx],
    [hx + dy, hy - dx],
    [-hx - dy, hy + dx],
  ]
}

/**
 * What the raw file says of one pad, on the board: `{ eff, cx, cy, sd(x, y), hole, holeSd, faces, margins, property, numberKicad, size }`
 * with `sd` the signed distance from a point of the board (y down) to the pad's copper, `hole` (or null) its drill, and `faces` the sides it
 * is on (`F` and `B`: copper as listed, `flashed` as KiCad plots it, mask, paste, silk).
 */
export function padDetail(p, { stamp, copper, px, py, padAngle, kw, kh, fp }) {
  const type = p[2]
  const word = p[3]
  const chamferNode = kid(p, "chamfer")
  // KiCad's own bit values: top left 1, top right 2, bottom left 4, bottom right 8 (`RECT_CHAMFER_*`); the corner function above names them by position
  const bits = chamferNode ? (chamferNode.includes("top_left") ? 1 : 0) | (chamferNode.includes("top_right") ? 2 : 0) | (chamferNode.includes("bottom_left") ? 4 : 0) | (chamferNode.includes("bottom_right") ? 8 : 0) : 0
  const chamferRatioNode = kid(p, "chamfer_ratio")
  const chamferRatio = chamferRatioNode ? numAt(chamferRatioNode, 1, 0) : 0.2
  const eff = (chamferRatioNode && chamferRatio > 0) || bits ? "chamfered" : word
  const ratioNode = kid(p, "roundrect_rratio")
  const ratio = Math.max(0, Math.min(0.5, ratioNode ? numAt(ratioNode, 1, 0.25) : 0.25))
  const drillNode = kid(p, "drill")
  const drillWords = drillNode ? drillNode.slice(1).filter((x) => typeof x === "string") : []
  const nums = drillWords.map(Number).filter(Number.isFinite)
  const drillOval = drillWords.includes("oval")
  const offsetNode = drillNode ? kid(drillNode, "offset") : undefined
  const offset = offsetNode ? [numAt(offsetNode, 1), numAt(offsetNode, 2)] : [0, 0]
  const noHoleType = type === "smd" || type === "connect"
  const drillW = noHoleType ? 0 : drillNode ? (nums[0] ?? 0) : type === "np_thru_hole" ? 0.762 : 0
  const drillH = noHoleType ? 0 : drillNode ? (drillOval ? (nums[1] ?? drillW) : drillW) : type === "np_thru_hole" ? 0.762 : 0
  const hasHole = drillW > 0 && drillH > 0
  // the copper's centre: the pad's place moved by the shape offset, turned with the pad (ShapePos, pad.cpp `:1536`)
  const shift = rot(offset, padAngle)
  const cx = px + shift[0]
  const cy = py + shift[1]
  const toPad = (x, y) => rot([x - cx, y - cy], -padAngle)
  const rd = kid(p, "rect_delta")
  const small = Math.min(kw, kh)
  let shapeSd
  if (eff === "circle") shapeSd = (q) => Math.hypot(q[0], q[1]) - kw / 2
  else if (eff === "oval") shapeSd = Math.abs(kw - kh) < 1e-9 ? (q) => Math.hypot(q[0], q[1]) - kw / 2 : (q) => sdStadium(q, kw, kh)
  else if (eff === "rect") shapeSd = (q) => sdBox(q, kw / 2, kh / 2)
  else if (eff === "trapezoid") {
    const pts = trapezoidCorners(kw, kh, rd ? [numAt(rd, 1), numAt(rd, 2)] : null)
    shapeSd = (q) => sdPoly(q, pts)
  } else if (eff === "roundrect") shapeSd = (q) => sdBox(q, kw / 2 - ratio * small, kh / 2 - ratio * small) - ratio * small
  else if (eff === "chamfered") {
    const pts = roundChamferCorners(kw, kh, ratio * small, chamferRatio, bits)
    shapeSd = (q) => sdPoly(q, pts)
  } else if (eff === "custom") {
    const anchor = kid(kid(p, "options"), "anchor")?.[1] ?? "circle"
    const parts = [anchor === "rect" ? (q) => sdBox(q, kw / 2, kh / 2) : (q) => Math.hypot(q[0], q[1]) - kw / 2]
    for (const g of kid(p, "primitives")?.slice(1) ?? []) if (Array.isArray(g) && typeof g[0] === "string" && g[0].startsWith("gr_")) parts.push(primitiveSd(g, stamp))
    shapeSd = (q) => Math.min(...parts.map((f) => f(q)))
  } else shapeSd = () => Infinity
  const sd = (x, y) => shapeSd(toPad(x, y))
  // the hole, at the pad's place, along the pad's x axis turned by its angle (y when the drill is taller than wide)
  let hole = null
  if (hasHole) {
    const slot = drillOval && Math.abs(drillW - drillH) > 1e-9
    const len = Math.max(drillW, drillH)
    const d = Math.min(drillW, drillH)
    const half = (len - d) / 2
    const e = slot ? rot(drillW >= drillH ? [half, 0] : [0, half], padAngle) : [0, 0]
    hole = { x: px, y: py, d, slot: slot ? len : null, ends: slot ? [[px - e[0], py - e[1]], [px + e[0], py + e[1]]] : null, plated: type !== "np_thru_hole" }
  }
  const holeSd = hole ? (x, y) => (hole.ends ? segDist([x, y], hole.ends[0], hole.ends[1]) : Math.hypot(x - px, y - py)) - hole.d / 2 : null
  // the layers: copper's front is the first copper layer of the board's table, its back the last
  const front = copper[0] ?? "F.Cu"
  const back = copper[copper.length - 1] ?? "B.Cu"
  const faces = { copper: new Set(), mask: new Set(), paste: new Set(), silk: new Set() }
  const both = (set) => {
    set.add("F")
    set.add("B")
  }
  for (const named of (kid(p, "layers") ?? []).slice(1)) {
    if (typeof named !== "string") continue
    const n = TRANSLATED_LAYER_NAMES[named] ?? named
    if (n === front || n === "F.Cu") faces.copper.add("F")
    else if (n === back || n === "B.Cu") faces.copper.add("B")
    else if (n === "*.Cu" || n === "F&B.Cu") both(faces.copper)
    else if (n === "F.Mask") faces.mask.add("F")
    else if (n === "B.Mask") faces.mask.add("B")
    else if (n === "*.Mask") both(faces.mask)
    else if (n === "F.Paste") faces.paste.add("F")
    else if (n === "B.Paste") faces.paste.add("B")
    else if (n === "*.Paste") both(faces.paste)
    else if (n === "F.SilkS") faces.silk.add("F")
    else if (n === "B.SilkS") faces.silk.add("B")
    else if (n === "*.SilkS") both(faces.silk)
  }
  // a non-plated hole is flashed on a copper layer unless the hole swallows the pad
  let flashed = new Set(faces.copper)
  if (type === "np_thru_hole" && hasHole) {
    const centred = offset[0] === 0 && offset[1] === 0
    if (eff === "circle" && !drillOval && centred && drillW >= kw) flashed = new Set()
    else if (eff === "oval" && drillOval && centred && drillW >= kw && drillH >= kh) flashed = new Set()
  }
  // what the pad sets for itself, else its footprint; a zero in an old file is no setting
  const zeroInherits = ["solder_mask_margin", "solder_paste_margin", "solder_paste_margin_ratio", "clearance"]
  const read = (name, node) => {
    const v = node ? numAt(node, 1, NaN) : NaN
    if (!Number.isFinite(v)) return undefined
    return v === 0 && stamp !== null && stamp <= 20240201 && zeroInherits.includes(name) ? undefined : v
  }
  const mine = (name) => read(name, kid(p, name)) ?? read(name, kid(fp, name))
  const zv = kid(p, "zone_connect") ? numAt(kid(p, "zone_connect"), 1, -1) : -1
  const zf = kid(fp, "zone_connect") ? numAt(kid(fp, "zone_connect"), 1, -1) : -1
  const zone = zv >= 0 ? zv : zf >= 0 ? zf : undefined
  const margins = {
    mask: mine("solder_mask_margin"),
    paste: mine("solder_paste_margin"),
    ratio: mine("solder_paste_margin_ratio") ?? read("solder_paste_margin_ratio", kid(p, "solder_paste_ratio")) ?? read("solder_paste_margin_ratio", kid(fp, "solder_paste_ratio")),
    clearance: mine("clearance"),
    zone: zone !== undefined && zone <= 3 ? zone : undefined,
    thermalGap: kid(p, "thermal_gap") ? numAt(kid(p, "thermal_gap"), 1) : undefined,
    thermalWidth: kid(p, "thermal_bridge_width") ? numAt(kid(p, "thermal_bridge_width"), 1) : kid(p, "thermal_width") ? numAt(kid(p, "thermal_width"), 1) : undefined,
    thermalAngle: kid(p, "thermal_bridge_angle") ? numAt(kid(p, "thermal_bridge_angle"), 1) : undefined,
  }
  const propNode = kid(p, "property")
  return {
    eff,
    cx,
    cy,
    sd,
    hole,
    holeSd,
    faces: { ...faces, flashed },
    margins,
    property: propNode ? propNode.slice(1).find((x) => typeof x === "string" && x.startsWith("pad_prop_")) : undefined,
    // KiCad clears the number of a non-plated hole (`CanHaveNumber`, parser `:6403`)
    numberKicad: type === "np_thru_hole" ? "" : String(p[1] ?? ""),
    size: [kw, kh],
  }
}
