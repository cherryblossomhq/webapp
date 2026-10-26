// An independent oracle for a board's zones: what the raw file says of every zone of the board (its outline with holes and arcs, layers,
// net, priority, clearance, minimum width, how its pads join, thermal gap and spoke width, smoothing, island rule, keepout flags, teardrop
// attribute) and the copper KiCad stored for it (`filled_polygon`), read by the census's own reader (`sexpr.mjs`) and with no code from
// `src/model`. The importer's zones are compared with the first, and the editor's own fill of them with the second.
// Points are in the file's frame (millimetres, y down). A zone's fill is as KiCad 6 and later read it: a file with no
// `filled_areas_thickness` has fills drawn with a pen as wide as the minimum width, so its copper is the stored polygon grown by half of it.

import { kid, kids, numAt, parseSexpr } from "./sexpr.mjs"

const TAU = Math.PI * 2

/** An arc through three points as a polyline whose chords are within `err` of the circle. */
export function arcPoints(a, m, b, err = 2e-5) {
  const [ax, ay] = a
  const [mx, my] = m
  const [bx, by] = b
  const d = 2 * (ax * (my - by) + mx * (by - ay) + bx * (ay - my))
  if (Math.abs(d) < 1e-12) return [a, b]
  const ux = ((ax * ax + ay * ay) * (my - by) + (mx * mx + my * my) * (by - ay) + (bx * bx + by * by) * (ay - my)) / d
  const uy = ((ax * ax + ay * ay) * (bx - mx) + (mx * mx + my * my) * (ax - bx) + (bx * bx + by * by) * (mx - ax)) / d
  const r = Math.hypot(ax - ux, ay - uy)
  const a0 = Math.atan2(ay - uy, ax - ux)
  const am = Math.atan2(my - uy, mx - ux)
  const a1 = Math.atan2(by - uy, bx - ux)
  const norm = (x) => ((x % TAU) + TAU) % TAU
  // Counter-clockwise from a to b passes through m, or the other way round does.
  const ccwToM = norm(am - a0)
  const ccwToB = norm(a1 - a0)
  const ccw = ccwToM <= ccwToB
  const sweep = ccw ? ccwToB : -norm(a0 - a1)
  const full = Math.abs(sweep) < 1e-12 ? (ccw ? TAU : -TAU) : sweep
  const n = Math.max(2, Math.ceil(Math.abs(full) / (2 * Math.acos(Math.max(0, 1 - err / r)))))
  const out = []
  for (let i = 0; i <= n; i++) out.push([ux + r * Math.cos(a0 + (full * i) / n), uy + r * Math.sin(a0 + (full * i) / n)])
  return out
}

/** One `(pts ...)` as a flat ring of points, arcs flattened. */
function ringOf(pts) {
  const out = []
  if (!Array.isArray(pts)) return out
  for (const c of pts.slice(1)) {
    if (!Array.isArray(c)) continue
    if (c[0] === "xy") out.push([Number(c[1]), Number(c[2])])
    else if (c[0] === "arc") {
      const p = (n) => [numAt(kid(c, n), 1), numAt(kid(c, n), 2)]
      const flat = arcPoints(p("start"), p("mid"), p("end"))
      const last = out[out.length - 1]
      for (let i = 0; i < flat.length; i++) {
        if (i === 0 && last && Math.hypot(last[0] - flat[0][0], last[1] - flat[0][1]) < 1e-9) continue
        out.push(flat[i])
      }
    }
  }
  return out
}

const word = (node, name) => {
  const k = kid(node, name)
  return k && typeof k[1] === "string" ? k[1] : undefined
}

/** The zones of a board as the file has them: those of the board (`inFootprint` false) and those inside footprints. */
export function zoneOracle(text) {
  const tree = parseSexpr(text)[0]
  const layerRows = kids(tree, "layers")[0]?.slice(1) ?? []
  const copperNames = layerRows.filter((r) => Array.isArray(r) && ["signal", "power", "mixed", "jumper"].includes(r[2])).map((r) => r[1])
  const front = copperNames[0] ?? "F.Cu"
  const back = copperNames[copperNames.length - 1] ?? "B.Cu"
  const ids = copperNames.map((_, i) => (i === 0 ? "top" : i === copperNames.length - 1 ? "bottom" : `in${i}`))
  const zones = []
  const table = new Map(kids(tree, "net").filter((n) => n.length >= 3).map((n) => [String(n[1]), String(n[2])]))
  // `(net 3 "GND")`, `(net 3)` with the table's name, or (KiCad 10) `(net "GND")`.
  const netByNumber = (k) => (!k ? "" : k.length >= 3 ? String(k[2]) : /^-?\d+$/.test(String(k[1])) ? table.get(String(k[1])) ?? "" : String(k[1]))
  const read = (z, inFootprint) => {
    const layerNames = kid(z, "layers") ? kid(z, "layers").slice(1).filter((x) => typeof x === "string") : kid(z, "layer") ? [kid(z, "layer")[1]] : []
    const keepoutNode = kid(z, "keepout")
    const fill = kid(z, "fill")
    const connect = kid(z, "connect_pads")
    const connectWord = connect ? connect.slice(1).find((x) => x === "yes" || x === "no" || x === "thru_hole_only") ?? "thermal" : "thermal"
    const polygons = kids(z, "polygon").map((p) => ringOf(kid(p, "pts")))
    const fills = new Map()
    for (const f of kids(z, "filled_polygon")) {
      const layer = word(f, "layer") ?? layerNames[0]
      const pts = ringOf(kid(f, "pts"))
      if (!fills.has(layer)) fills.set(layer, [])
      fills.get(layer).push(pts)
    }
    const at = (name) => (kid(fill, name) ? numAt(kid(fill, name), 1) : null)
    const copperLayer = (n) => n === "*.Cu" || n === "F&B.Cu" || copperNames.includes(n) || /\.Cu$/.test(n)
    zones.push({
      inFootprint,
      layers: layerNames,
      onlyCopper: layerNames.length > 0 && layerNames.every(copperLayer),
      /** Which copper layers of the stack it is on (top, in1.., bottom, by position); `*.Cu` is all of them and `F&B.Cu` the two outer ones. */
      surface: [...new Set(layerNames.flatMap((n) => (n === "*.Cu" ? ids : n === "F&B.Cu" ? ["top", "bottom"] : copperNames.includes(n) ? [ids[copperNames.indexOf(n)]] : n === "F.Cu" ? ["top"] : n === "B.Cu" ? ["bottom"] : [])))],
      // A `placement` node that is switched off (KiCad 9 writes one on every rule area) places nothing.
      kind: kid(z, "placement") && word(kid(z, "placement"), "enabled") === "yes" ? "placement" : keepoutNode ? (["tracks", "vias", "pads", "copperpour", "footprints"].some((k) => word(keepoutNode, k) === "not_allowed") ? "keepout" : "rule-area") : kid(z, "placement") ? "rule-area" : kid(z, "attr") && kid(kid(z, "attr"), "teardrop") ? "teardrop" : "copper",
      // The zone's own `net_name`, as KiCad reads it; a zone without one is on the net its number has in the table.
      netName: keepoutNode || kid(z, "placement") ? "" : kid(z, "net_name") ? word(z, "net_name") ?? "" : netByNumber(kid(z, "net")),
      priority: kid(z, "priority") ? numAt(kid(z, "priority"), 1) : 0,
      /** The zone's identity as the file writes it: `uuid` since KiCad 7, `tstamp` in KiCad 6 and before. */
      uuid: word(z, "uuid") ?? word(z, "tstamp") ?? null,
      name: word(z, "name") ?? "",
      locked: kid(z, "locked") ? word(z, "locked") !== "no" : z.includes("locked"),
      clearance: connect && kid(connect, "clearance") ? numAt(kid(connect, "clearance"), 1) : null,
      minThickness: kid(z, "min_thickness") ? numAt(kid(z, "min_thickness"), 1) : null,
      connect: connectWord,
      thermalGap: at("thermal_gap"),
      thermalBridge: at("thermal_bridge_width"),
      smoothing: word(fill, "smoothing") ?? "none",
      radius: at("radius") ?? 0,
      islandMode: at("island_removal_mode") ?? 0,
      islandArea: at("island_area_min"),
      mode: word(fill, "mode") ?? "polygon",
      teardrop: word(kid(kid(z, "attr"), "teardrop"), "type") ?? null,
      keepout: keepoutNode ? Object.fromEntries(["tracks", "vias", "pads", "copperpour", "footprints"].map((k) => [k, word(keepoutNode, k) === "not_allowed"])) : null,
      strokedFill: !["no", "false"].includes(word(z, "filled_areas_thickness") ?? ""),
      filled: kids(z, "filled_polygon").length > 0,
      /** The outline then its holes, flattened. */
      rings: polygons,
      /** Stored fill by layer name: each polygon as a ring (holes joined to the outline by KiCad). */
      fills,
    })
  }
  for (const z of kids(tree, "zone")) read(z, false)
  for (const fp of tree) if (Array.isArray(fp) && (fp[0] === "footprint" || fp[0] === "module")) for (const z of kids(fp, "zone")) read(z, true)
  return { zones, front, back }
}

/** Whether the importer takes a zone in: the zones the file has on copper, with an outline of three corners or more, that are not placement areas. */
export const importedZone = (z) => !z.inFootprint && z.kind !== "placement" && z.onlyCopper && z.surface.length > 0 && z.rings.length > 0 && z.rings[0].length >= 3
