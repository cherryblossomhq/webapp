import { normalizeOutline, packOutline, unpackOutline } from "./outlineCodec"
import { segStart, type ShapePath } from "./shapes"
import { isOtherZoneLayer, orderedOtherLayers } from "./zoneLayers"
import { isCopperLayerId } from "./stack"
import type { CopperLayer, KeptFill, Vec2, Zone, ZoneConnection, ZoneKeepout } from "./types"
import { finite, isObject } from "../lib/guards"

// Zones stored compactly and exactly (X3). A zone of the editor's own whole-board kind is stored as it always was. A zone with a polygon
// stores it as `ol`: one array per ring, `["p", x, y, x, y, ...]` for a ring of straight pieces (ten bytes a corner), or the outline
// codec's form (`outlineCodec.ts`) for a ring with arcs or curves. The first ring is the outline and the others are holes. Every number is
// as the zone has it, so a round trip gives the same zone.

type Json = Record<string, unknown>
const CONNECTIONS = new Set<ZoneConnection>(["thermal", "tht", "solid", "none"])
const FLAGS = ["tracks", "vias", "pads", "pour", "footprints"] as const

/** The corners of a ring that has only straight pieces, one after the other and closing: null if it is not one. */
function straightRing(p: ShapePath): number[] | null {
  const out: number[] = []
  for (let i = 0; i < p.segs.length; i++) {
    const s = p.segs[i]
    if (s.kind !== "line") return null
    out.push(s.a.x, s.a.y)
    const n = segStart(p.segs[(i + 1) % p.segs.length])
    if (n.x !== s.b.x || n.y !== s.b.y) return null
  }
  return out.length >= 6 ? out : null
}

export function packRings(rings: ShapePath[]): (string | number)[][] {
  return rings.map((p) => {
    const flat = p.closed ? straightRing(p) : null
    return flat ? ["p", ...flat] : packOutline({ paths: [p] })[0]
  })
}

export function unpackRings(raw: unknown): ShapePath[] | null {
  if (!Array.isArray(raw)) return null
  const out: ShapePath[] = []
  for (const r of raw) {
    if (!Array.isArray(r) || !r.length) continue
    if (r[0] === "p") {
      const v = r.slice(1)
      if (v.length < 6 || v.length % 2 || !v.every(finite)) continue
      const pts: { x: number; y: number }[] = []
      for (let i = 0; i < v.length; i += 2) pts.push({ x: v[i] as number, y: v[i + 1] as number })
      out.push({ closed: true, segs: pts.map((a, i) => ({ kind: "line" as const, a, b: pts[(i + 1) % pts.length] })) })
    } else {
      const o = unpackOutline([r])
      if (o?.paths[0]) out.push({ ...o.paths[0], closed: true })
    }
  }
  return out.length ? out : null
}

// KiCad's stored fill of a zone (`Zone.kept`) is stored as `ff`: `{ g: signature, s?: 1, l: [[layer, [ring, ...], islandIndexes?], ...] }`. A ring whose points are all
// whole nanometres (a KiCad file's are) is `["d", x0, y0, dx, dy, ...]`: the first point and then each step from the one before, in nanometres, which keeps a fill that is
// megabytes as KiCad's text a few bytes a point; any other ring is `["p", x, y, ...]` as it is. Every number reads back as it was.

const NM = 1e6
const wholeNm = (v: number) => Math.abs(v) < 8e9 && Math.round(v * NM) / NM === v

function packFillRing(ring: Vec2[]): (string | number)[] {
  if (!ring.every((p) => wholeNm(p.x) && wholeNm(p.y))) return ["p", ...ring.flatMap((p) => [p.x, p.y])]
  const out: (string | number)[] = ["d"]
  let px = 0
  let py = 0
  for (const p of ring) {
    const x = Math.round(p.x * NM)
    const y = Math.round(p.y * NM)
    out.push(x - px, y - py)
    px = x
    py = y
  }
  return out
}

function unpackFillRing(r: unknown): Vec2[] | null {
  if (!Array.isArray(r) || (r[0] !== "d" && r[0] !== "p")) return null
  const v = r.slice(1)
  if (v.length < 6 || v.length % 2 || !v.every(finite)) return null
  const out: Vec2[] = []
  if (r[0] === "p") {
    for (let i = 0; i < v.length; i += 2) out.push({ x: v[i] as number, y: v[i + 1] as number })
    return out
  }
  let x = 0
  let y = 0
  for (let i = 0; i < v.length; i += 2) {
    x += v[i] as number
    y += v[i + 1] as number
    out.push({ x: x / NM + 0, y: y / NM + 0 })
  }
  return out
}

function packKept(k: KeptFill): Json {
  return { g: k.sig, ...(k.stroked ? { s: 1 } : {}), l: k.layers.map((l) => [l.layer, l.rings.map(packFillRing), ...(l.islands?.length ? [l.islands] : [])]) }
}

/** The kept fill a stored zone holds, or nothing when it does not read (the zone is then filled by the editor, as one with no stored fill). */
function unpackKept(raw: unknown): KeptFill | null {
  if (!isObject(raw) || typeof raw.g !== "string" || !Array.isArray(raw.l)) return null
  const layers: KeptFill["layers"] = []
  for (const l of raw.l) {
    const layer = Array.isArray(l) ? layerOf(l[0]) : null
    if (!Array.isArray(l) || !layer || !Array.isArray(l[1])) return null
    const rings: Vec2[][] = []
    for (const r of l[1]) {
      const ring = unpackFillRing(r)
      if (!ring) return null
      rings.push(ring)
    }
    const islands = Array.isArray(l[2]) ? l[2].filter((i): i is number => Number.isInteger(i) && i >= 0 && i < rings.length) : []
    if (layers.some((x) => x.layer === layer)) return null
    layers.push({ layer, rings, ...(islands.length ? { islands } : {}) })
  }
  return layers.length ? { layers, ...(raw.s === 1 ? { stroked: true as const } : {}), sig: raw.g } : null
}

const legacyKeys = new Set(["id", "net", "layer", "clearance"])

/**
 * The zones as they are written: each as it is, but its polygon and its kept fill compact under their own keys (`outline`, `kept`), which an edit only ever replaces
 * or takes off whole. Written before, they were `ol` and `ff`, which a live edit of either (by its own key) did not reach; both are still read.
 */
export function packZones(zones: Zone[]): unknown[] {
  return zones.map((z) => (z.outline || z.kept ? { ...z, ...(z.outline ? { outline: packRings(z.outline) } : {}), ...(z.kept ? { kept: packKept(z.kept) } : {}) } : z))
}

/** A zone's kept fill as stored: compact (`packKept`), or an object an edit wrote (read through the compact form, so it is checked the same way). */
function readKept(raw: unknown): KeptFill | null {
  if (isObject(raw) && Array.isArray(raw.layers)) {
    try {
      return unpackKept(packKept(raw as unknown as KeptFill))
    } catch {
      return null
    }
  }
  return unpackKept(raw)
}

const layerOf = (v: unknown): CopperLayer | null => (isCopperLayerId(v) ? v : null)

/** The zones a stored project holds: an old-style zone as it is, one with X3 fields read field by field, anything damaged dropped or repaired. */
export function normalizeZones(raw: unknown): Zone[] {
  const out: Zone[] = []
  for (const item of Array.isArray(raw) ? raw : []) {
    if (!isObject(item)) continue
    const x3 = Object.keys(item).some((k) => !legacyKeys.has(k))
    if (!x3) {
      out.push(item as unknown as Zone)
      continue
    }
    const layer = layerOf(item.layer)
    if (typeof item.id !== "string" || !item.id || !layer) continue
    const z: Zone = { id: item.id, net: typeof item.net === "string" ? item.net : "", layer }
    const num = (k: keyof Zone) => {
      const v = item[k as string]
      if (finite(v) && v >= 0) (z as unknown as Json)[k] = v
    }
    num("clearance")
    num("minWidth")
    num("thermalGap")
    num("spokeWidth")
    num("edgeGap")
    num("holeGap")
    if (finite(item.priority) && Number.isInteger(item.priority) && item.priority > 0) z.priority = item.priority
    if (typeof item.name === "string" && item.name) z.name = item.name
    if (typeof item.uuid === "string" && /^[0-9a-f]{32}$/.test(item.uuid)) z.uuid = item.uuid
    if (item.unordered === true) z.unordered = true
    const oh = item.outlineHatch
    if (isObject(oh) && (oh.style === "none" || oh.style === "edge" || oh.style === "full") && finite(oh.pitch) && oh.pitch > 0) z.outlineHatch = { style: oh.style, pitch: oh.pitch }
    // The polygon: compact under its own key (`packRings`), or the paths an edit wrote there (`[{ closed, segs }]`); or `ol`, where it was written before, which either replaces.
    const outline = item.outline
    const rings = Array.isArray(outline)
      ? Array.isArray(outline[0])
        ? unpackRings(outline)
        : (normalizeOutline({ paths: outline })?.paths.map((p) => ({ ...p, closed: true })) ?? null)
      : item.ol !== undefined
        ? unpackRings(item.ol)
        : null
    // A polygon that was stored and does not read is a zone lost, not a zone over the whole board.
    if ((item.ol !== undefined || item.outline !== undefined) && !rings?.length) continue
    if (rings?.length) z.outline = rings
    const layers = Array.isArray(item.layers) ? item.layers.map(layerOf).filter((l): l is CopperLayer => l !== null) : []
    if (layers.length > 1 && layers[0] === layer && new Set(layers).size === layers.length) z.layers = layers
    // X29: the layers that are not copper, each once and in the table's order; a zone with them and no copper layer says `layers: []`. A pour is on one kind or the other, so a pour that
    // says both keeps its copper (a rule area may be on both).
    const other = Array.isArray(item.other) ? [...new Set(item.other.filter(isOtherZoneLayer))] : []
    // `layers: []` says no copper layer at all; a zone with `layer` alone (or `layers` of several) is on copper.
    const noCopper = Array.isArray(item.layers) && item.layers.length === 0
    if (other.length && (isObject(item.keepout) || noCopper)) {
      z.other = orderedOtherLayers(other)
      if (noCopper) z.layers = []
    }
    if (typeof item.connect === "string" && CONNECTIONS.has(item.connect as ZoneConnection)) z.connect = item.connect as ZoneConnection
    const sm = item.smoothing
    if (isObject(sm) && (sm.kind === "chamfer" || sm.kind === "fillet") && finite(sm.radius) && sm.radius > 0) z.smoothing = { kind: sm.kind, radius: sm.radius }
    if (item.islands === "never" || (finite(item.islands) && item.islands >= 0)) z.islands = item.islands as Zone["islands"]
    // X24: a hatched pour's grid, and where it starts on each layer. A grid that does not read (no positive line width or hole) is a solid pour, which is what the zone would be without it.
    const h = item.hatch
    if (isObject(h) && finite(h.thickness) && h.thickness > 0 && finite(h.gap) && h.gap > 0) {
      const sh = h.smooth
      z.hatch = {
        thickness: h.thickness,
        gap: h.gap,
        ...(finite(h.angle) && h.angle !== 0 ? { angle: h.angle } : {}),
        ...(finite(h.minHole) && h.minHole >= 0 ? { minHole: h.minHole } : {}),
        ...(h.thinBorder === true ? { thinBorder: true as const } : {}),
        ...(h.fromFill === true ? { fromFill: true as const } : {}),
        ...(isObject(sh) && (sh.level === 1 || sh.level === 2 || sh.level === 3) && finite(sh.value) && sh.value > 0 ? { smooth: { level: sh.level, value: sh.value } } : {}),
      }
    }
    if (isObject(item.hatchAt)) {
      const at: Partial<Record<CopperLayer, { x: number; y: number }>> = {}
      for (const [l, p] of Object.entries(item.hatchAt)) if (isCopperLayerId(l) && isObject(p) && finite(p.x) && finite(p.y)) at[l] = { x: p.x, y: p.y }
      if (Object.keys(at).length) z.hatchAt = at
    }
    if (isObject(item.keepout)) {
      const k: ZoneKeepout = {}
      for (const f of FLAGS) if (item.keepout[f] === true) k[f] = true
      z.keepout = k
      // X20: what a placement rule area picks; only a rule area has one, and one that does not read is a rule area that places nothing.
      const pl = item.placement
      if (isObject(pl) && (pl.by === "sheet" || pl.by === "class" || pl.by === "group") && typeof pl.name === "string") z.placement = { by: pl.by, name: pl.name, ...(pl.off === true ? { off: true as const } : {}) }
      // A rule area has no net and is its polygon; one without a polygon is nothing.
      z.net = ""
      if (!z.outline) continue
    }
    if (item.teardrop === "padvia" || item.teardrop === "track_end") z.teardrop = item.teardrop
    if (item.locked === true) z.locked = true
    // KiCad's stored fill: only on a pour with a polygon, on layers the zone is on. `ff` is where it was written before.
    const fill = item.kept !== undefined ? item.kept : item.ff
    if (fill !== undefined && !z.keepout && z.outline) {
      const kept = readKept(fill)
      if (kept && kept.layers.every((l) => (z.layers ?? [z.layer]).includes(l.layer))) z.kept = kept
    }
    out.push(z)
  }
  return out
}
