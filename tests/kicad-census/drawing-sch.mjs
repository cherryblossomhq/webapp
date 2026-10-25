// The symbols a schematic caches, read from the raw file in KiCad's units (millimetres), sharing no
// code with `src`: the census's own s-expression reader and nothing else. The corpus test compares
// the symbol drawings the importer keeps against this, number by number, to 0.001 mm.

import { parseSexpr, kid, kids, numAt } from "./sexpr.mjs"

const SHAPES = new Set(["polyline", "rectangle", "circle", "arc", "bezier", "text", "ellipse", "ellipse_arc"])
const pts = (node) => kids(kid(node, "pts"), "xy").flatMap((p) => [numAt(p, 1), numAt(p, 2)])
const xy = (node) => (node ? [numAt(node, 1), numAt(node, 2)] : [])

function numbersOf(node) {
  switch (node[0]) {
    case "polyline":
    case "bezier":
      return pts(node)
    case "rectangle":
      return [...xy(kid(node, "start")), ...xy(kid(node, "end"))]
    case "circle":
      return [...xy(kid(node, "center")), numAt(kid(node, "radius"), 1)]
    case "arc":
      return [...xy(kid(node, "start")), ...xy(kid(node, "mid")), ...xy(kid(node, "end"))]
    case "text":
      return [...xy(kid(node, "at"))]
    case "ellipse":
    case "ellipse_arc":
      return [...xy(kid(node, "center")), numAt(kid(node, "major_radius"), 1), numAt(kid(node, "minor_radius"), 1)]
    default:
      return []
  }
}

const hidden = (pin) => pin.some((c, i) => i > 0 && (c === "hide" || (Array.isArray(c) && c[0] === "hide" && (c[1] === "yes" || c[1] === "true" || c[1] === undefined))))

/** Every cached symbol of a schematic: its shapes and pins by unit and body style, as raw numbers. */
export function rawSymbols(text) {
  const root = parseSexpr(text).find((n) => Array.isArray(n) && n[0] === "kicad_sch")
  const version = numAt(kid(root, "version"), 1, 0)
  const lib = kid(root, "lib_symbols")
  const byName = new Map(kids(lib, "symbol").map((s) => [s[1], s]))
  const out = new Map()
  for (const [name, node] of byName) {
    // A symbol that extends another draws the other's shapes and pins.
    let source = node
    const seen = new Set([name])
    while (kid(source, "extends") && !kids(source, "symbol").length) {
      const base = byName.get(kid(source, "extends")[1])
      if (!base || seen.has(base[1])) break
      seen.add(base[1])
      source = base
    }
    const shapes = []
    const pins = []
    let units = 1
    let styles = 1
    for (const sub of kids(source, "symbol")) {
      const m = /_(\d+)_(\d+)$/.exec(sub[1])
      const unit = m ? Number(m[1]) : 0
      const body = m ? Number(m[2]) : 0
      units = Math.max(units, unit)
      styles = Math.max(styles, body)
      for (const c of sub.slice(2)) {
        if (!Array.isArray(c)) continue
        if (SHAPES.has(c[0])) shapes.push({ kind: c[0], unit, body, nums: numbersOf(c), fill: kid(kid(c, "fill"), "type")?.[1] ?? "none", width: numAt(kid(kid(c, "stroke"), "width"), 1, 0), private: c.includes("private") })
        else if (c[0] === "pin") {
          const at = kid(c, "at")
          pins.push({
            unit,
            body,
            type: c[1] === "unconnected" ? "no_connect" : c[1],
            shape: c[2],
            at: [numAt(at, 1), numAt(at, 2)],
            angle: numAt(at, 3),
            length: numAt(kid(c, "length"), 1),
            number: kid(c, "number")?.[1] ?? "",
            name: kid(c, "name")?.[1] ?? "",
            hidden: hidden(c),
            alternates: kids(c, "alternate").map((a) => [a[1], a[2], a[3]]),
          })
        }
      }
    }
    const fields = kids(node, "property").map((p) => ({ name: p[1], value: p[2] ?? "", at: xy(kid(p, "at")), angle: numAt(kid(p, "at"), 3) }))
    out.set(name, { shapes, pins, units, styles, fields, version })
  }
  return out
}

// ---------- the fields of the placed symbols, laid out by KiCad's own rules ----------
//
// `SCH_FIELD::GetBoundingBox` and `SCH_PAINTER::draw( SCH_FIELD )` (sch_field.cpp, sch_painter.cpp), step
// for step, in KiCad's y down sheet and with its own `TRANSFORM` matrices (sch_symbol.cpp `SetOrientation`):
// the file's `at` is where the field is drawn; its angle and justification are the symbol's. The text box is
// built unrotated at the field's own place, rotated by the text angle about it, and put through the
// symbol's transform; the text is drawn centred in the result, across or up (swapped when the transform has y1).

const mul = (a, b) => ({ x1: a.x1 * b.x1 + a.x2 * b.y1, y1: a.y1 * b.x1 + a.y2 * b.y1, x2: a.x1 * b.x2 + a.x2 * b.y2, y2: a.y1 * b.x2 + a.y2 * b.y2 })
const CCW = { x1: 0, y1: 1, x2: -1, y2: 0 }
const MIRROR_X = { x1: 1, y1: 0, x2: 0, y2: -1 }
const MIRROR_Y = { x1: -1, y1: 0, x2: 0, y2: 1 }

/** KiCad's transform of a symbol placed at `angle` with `mirror`: the turn from `(at x y angle)` first, then the mirror. */
export function kicadTransform(angle, mirror) {
  // From KiCad 9.0 the matrix of an unturned symbol is the identity (the symbol stays in its own y down frame). KiCad 7 and 8 default it to (1, 0, 0, -1) and
  // compensate with a mirror in `GetBoundingBox`, so the drawn result is the same; this check works in the identity form for every release.
  let t = { x1: 1, y1: 0, x2: 0, y2: 1 }
  for (let i = 0; i < Math.round((((angle % 360) + 360) % 360) / 90); i++) t = mul(t, CCW)
  if (mirror === "x") t = mul(t, MIRROR_X)
  else if (mirror === "y") t = mul(t, MIRROR_Y)
  return t
}
const apply = (t, p) => ({ x: t.x1 * p.x + t.y1 * p.y, y: t.x2 * p.x + t.y2 * p.y })
const invert = (t) => {
  const det = t.x1 * t.y2 - t.y1 * t.x2
  return { x1: t.y2 / det, y1: -t.y1 / det, x2: -t.x2 / det, y2: t.x1 / det }
}

/** Every visible field of every symbol placed on the sheet: its anchor, size, and a function from its text length to its drawn box. Millimetres, y down. */
export function rawFields(text) {
  const root = parseSexpr(text).find((n) => Array.isArray(n) && n[0] === "kicad_sch")
  const out = []
  for (const sym of kids(root, "symbol")) {
    const at = kid(sym, "at")
    const origin = { x: numAt(at, 1), y: numAt(at, 2) }
    const mirrorNode = kid(sym, "mirror")
    const T = kicadTransform(numAt(at, 3), mirrorNode?.[1] ?? "")
    const inv = invert(T)
    const uuid = kid(sym, "uuid")?.[1]
    for (const p of kids(sym, "property")) {
      const pat = kid(p, "at")
      const effects = kid(p, "effects")
      const hide = (effects ?? []).some((c, i) => i > 0 && (c === "hide" || (Array.isArray(c) && c[0] === "hide" && c[1] !== "no")))
      const phide = kid(p, "hide")
      if (hide || (phide && phide[1] !== "no")) continue
      const size = numAt(kid(kid(effects, "font"), "size"), 1, 1.27)
      const justify = (kid(effects, "justify") ?? []).slice(1)
      const angle = numAt(pat, 3)
      const horizontal = ((Math.round(angle) % 180) + 180) % 180 === 0
      const rel = { x: numAt(pat, 1) - origin.x, y: numAt(pat, 2) - origin.y }
      const textPos = apply(inv, rel)
      out.push({
        uuid,
        name: p[1],
        anchor: { x: numAt(pat, 1), y: numAt(pat, 2) },
        size,
        layout(length) {
          const w = length * size * 0.6
          const x0 = justify.includes("left") ? 0 : justify.includes("right") ? -w : -w / 2
          const y0 = justify.includes("top") ? 0 : justify.includes("bottom") ? -size : -size / 2
          const corners = [[x0, y0], [x0 + w, y0 + size]].map(([x, y]) => {
            // rotate by the text's angle about its place, counter-clockwise on screen, then put the point through the symbol's transform
            const r = horizontal ? { x, y } : { x: y, y: -x }
            return apply(T, { x: textPos.x + r.x, y: textPos.y + r.y })
          })
          const box = { minX: Math.min(corners[0].x, corners[1].x) + origin.x, maxX: Math.max(corners[0].x, corners[1].x) + origin.x, minY: Math.min(corners[0].y, corners[1].y) + origin.y, maxY: Math.max(corners[0].y, corners[1].y) + origin.y }
          return { box, vertical: T.y1 !== 0 ? horizontal : !horizontal }
        },
      })
    }
  }
  return out
}
