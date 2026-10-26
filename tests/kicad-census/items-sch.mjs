// The items of a sheet (S4) as the raw file has them, read with the census's own s-expression reader and no
// code of `src`: for each kind, its numbers in KiCad's millimetres (y down), in file order. The corpus test
// compares them with the importer's items, to a thousandth of a millimetre.

import { parseSexpr, kid, kids, numAt } from "./sexpr.mjs"

const pair = (n) => (n ? [numAt(n, 1), numAt(n, 2)] : [0, 0])

/** @returns {{ kind: string, nums: number[], rects?: number[][], anchors?: number[][], text?: string }[]} */
export function rawItems(text) {
  const root = parseSexpr(text).find((n) => Array.isArray(n) && n[0] === "kicad_sch")
  if (!root) return []
  const out = []
  const points = (n) => kids(kid(n, "pts"), "xy").flatMap(pair)
  // S8: a directive label (`netclass_flag`, or `directive_label` in the files that spell it so): where it is attached, the turn the file gives it and its pin's length, its shape word and its
  // properties. The end of its pin and the box KiCad draws its flag in come from `CreateGraphicShape` (sch_label.cpp): the shape is laid out for a pin that runs down the page and turned by the
  // label's spin, which the file's angle 0, 90, 180, 270 names as RIGHT, UP, LEFT, BOTTOM. The columns below are what the pin's direction and the flag's width are in the file's frame (y down).
  const AXES = { 0: [[-1, 0], [0, -1]], 90: [[0, 1], [-1, 0]], 180: [[1, 0], [0, 1]], 270: [[0, -1], [1, 0]] }
  for (const n of [...kids(root, "netclass_flag"), ...kids(root, "directive_label")]) {
    const [x, y] = pair(kid(n, "at"))
    const angle = ((numAt(kid(n, "at"), 3, 0) % 360) + 360) % 360
    const L = numAt(kid(n, "length"), 1, 0)
    const shape = kid(n, "shape")?.[1]
    const S0 = 0.508
    const [ax, ay] = AXES[angle]
    const at = (u, v) => [x + ax[0] * u + ay[0] * v, y + ax[1] * u + ay[1] * v]
    let pts
    let end
    if (shape === "dot" || shape === "round") {
      const S = shape === "dot" ? S0 * 0.7 : S0
      end = at(0, L - S)
      pts = [at(0, 0), at(0, L - S), at(0, L), at(-S0, L), at(S0, L + S)]
    } else if (shape === "diamond") {
      end = at(0, L - S0)
      pts = [at(0, 0), at(0, L - S0), at(-2 * S0, L), at(0, L + S0), at(2 * S0, L)]
    } else {
      const S = S0 * 0.8
      end = at(0, L - S)
      pts = [at(0, 0), at(0, L - S), at(-2 * S, L - S), at(-2 * S, L + S), at(2 * S, L + S), at(2 * S, L - S)]
    }
    const props = kids(n, "property")
    out.push({
      kind: "directive",
      nums: [x, y, angle, L],
      shape,
      fields: props.map((p) => [p[1], p[2]]),
      fieldAt: props.map((p) => pair(kid(p, "at"))),
      anchors: [end],
      rects: [[Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))]],
    })
  }
  for (const n of kids(root, "text")) out.push({ kind: "text", nums: pair(kid(n, "at")), text: n[1] })
  // `rects` is the drawn box as KiCad draws it, [x0, y0, x1, y1] in the file's own frame (y down): the axis-aligned
  // rectangle from `at` to `at + size`, whatever the angle of `at` says (the angle turns only the text).
  const rect = (n) => {
    const [x, y] = pair(kid(n, "at"))
    const [w, h] = pair(kid(n, "size"))
    return [x, y, x + w, y + h]
  }
  // `anchors` is where `SCH_TEXTBOX::GetDrawPos` puts the text, in the file's frame (y down): the justification names the
  // edge. Across the box (angle 0 or 180): h sets x, v sets y. Vertical text (90 or 270): h sets y (left is the bottom edge
  // minus the bottom margin, right the top edge plus the top margin) and v sets x (top is the left edge plus the left margin,
  // bottom the right edge minus the right margin); centre is the middle. A box with no margins node has margins of 0.
  const anchor = (n) => {
    const [x, y, angle] = [...pair(kid(n, "at")), numAt(kid(n, "at"), 3, 0)]
    const [w, h] = pair(kid(n, "size"))
    const m = kid(n, "margins")
    const [ml, mt, mr, mb] = m ? [numAt(m, 1), numAt(m, 2), numAt(m, 3), numAt(m, 4)] : [0, 0, 0, 0]
    const eff = kid(n, "effects")
    const just = ((eff && kid(eff, "justify")) || []).slice(1)
    const hj = just.includes("left") ? "left" : just.includes("right") ? "right" : "centre"
    const vj = just.includes("top") ? "top" : just.includes("bottom") ? "bottom" : "centre"
    const [left, top, right, bottom] = [x, y, x + w, y + h]
    if (Math.abs(angle) === 90 || Math.abs(angle) === 270) {
      return [vj === "top" ? left + ml : vj === "bottom" ? right - mr : (left + right) / 2, hj === "left" ? bottom - mb : hj === "right" ? top + mt : (top + bottom) / 2]
    }
    return [hj === "left" ? left + ml : hj === "right" ? right - mr : (left + ml + right - mr) / 2, vj === "top" ? top + mt : vj === "bottom" ? bottom - mb : (top + mt + bottom - mb) / 2]
  }
  for (const n of kids(root, "text_box")) out.push({ kind: "textbox", nums: [...pair(kid(n, "at")), ...pair(kid(n, "size"))], rects: [rect(n)], anchors: [anchor(n)], text: n[1] })
  for (const n of kids(root, "polyline")) out.push({ kind: "polyline", nums: points(n) })
  // S8: a rule area is the polygon of the polyline it holds (KiCad closes it; a first point written again at the end is the same corner), and its flags as the file says them.
  for (const n of kids(root, "rule_area")) {
    const poly = kid(n, "polyline")
    const pts = poly ? points(poly) : []
    if (pts.length > 6 && pts[0] === pts[pts.length - 2] && pts[1] === pts[pts.length - 1]) pts.length -= 2
    const yes = (name) => kid(n, name)?.[1] === "yes"
    out.push({ kind: "rule_area", nums: pts, flags: { dnp: yes("dnp"), noBom: kid(n, "in_bom")?.[1] === "no", noBoard: kid(n, "on_board")?.[1] === "no", noSim: yes("exclude_from_sim") } })
  }
  for (const n of kids(root, "rectangle")) out.push({ kind: "rectangle", nums: [...pair(kid(n, "start")), ...pair(kid(n, "end"))] })
  for (const n of kids(root, "circle")) out.push({ kind: "circle", nums: [...pair(kid(n, "center")), numAt(kid(n, "radius"), 1)] })
  for (const n of kids(root, "arc")) out.push({ kind: "arc", nums: [...pair(kid(n, "start")), ...pair(kid(n, "mid")), ...pair(kid(n, "end"))] })
  for (const n of kids(root, "bezier")) out.push({ kind: "bezier", nums: points(n) })
  for (const n of kids(root, "image")) out.push({ kind: "image", nums: pair(kid(n, "at")) })
  for (const t of kids(root, "table")) out.push({ kind: "table", nums: kids(kid(t, "cells"), "table_cell").flatMap((c) => [...pair(kid(c, "at")), ...pair(kid(c, "size"))]), rects: kids(kid(t, "cells"), "table_cell").map(rect), anchors: kids(kid(t, "cells"), "table_cell").map(anchor) })
  return out
}

/**
 * The buses of a sheet (S3) as the raw file has them, in KiCad's millimetres (y down): each `(bus ...)` as `[x1, y1, x2, y2]`, each
 * `(bus_entry ...)` as `{ at, size, toBus }`, and each `(bus_alias ...)` as `{ name, members }`, in file order.
 */
export function rawBuses(text) {
  const root = parseSexpr(text).find((n) => Array.isArray(n) && n[0] === "kicad_sch")
  if (!root) return { buses: [], entries: [], aliases: [] }
  const buses = kids(root, "bus").map((n) => kids(kid(n, "pts"), "xy").flatMap(pair))
  const entries = kids(root, "bus_entry").map((n) => ({ at: pair(kid(n, "at")), size: pair(kid(n, "size")), toBus: !!kid(n, "bus_to_bus") }))
  const aliases = kids(root, "bus_alias").map((n) => ({ name: n[1], members: (kid(n, "members") ?? []).slice(1) }))
  return { buses, entries, aliases }
}
