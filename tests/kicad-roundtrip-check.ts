import { computeConnectivity } from "../src/model/connectivity"
import { outlinePaths, PROVENANCE_PROPERTIES } from "../src/export/kicadBoard"
import { dimensionDrawing } from "../src/model/dimensions"
import { flattenPath, shapePaths } from "../src/model/shapes"
import type { BoardDimension, Project } from "../src/model/types"

// The round trip's oracle for the board writer (X16): two projects, the one a board was imported as and the one its written file imports as,
// compared item for item. Ids are random, so each is replaced by what the item is (a part by its reference, any other by its kind and place
// in its list); the generated schematic (wires, labels, where parts sit on the sheet) is left out and the nets are compared instead, pin by pin,
// since the schematic is made from the board's nets and a board that is the same makes the same one. The two properties the import adds about
// the file it read (its release and stamp) describe the file, not the board, and are left out.

type Json = unknown

/** The project as plain data with every id replaced and the generated schematic taken out. */
export function canonicalProject(project: Project): Json {
  const plain = JSON.parse(JSON.stringify(project)) as Record<string, any>
  const ids = new Map<string, string>()
  const name = (list: any[] | undefined, kind: string, by?: (x: any, i: number) => string) => list?.forEach((x, i) => x?.id && ids.set(x.id, `${kind}:${by ? by(x, i) : i}`))
  name(plain.components, "c", (x) => x.ref)
  for (const k of ["traces", "vias", "zones", "texts", "graphics", "dimensions", "groups", "images"]) name(plain[k], k)
  const lands = new Map<string, string>()
  const partIds = new Map<string, string>()
  for (const c of plain.components ?? []) {
    if (!lands.has(c.footprint)) lands.set(c.footprint, `land:${c.ref}`)
    if (!partIds.has(c.partId)) partIds.set(c.partId, `part:${c.ref}`)
  }
  const all = [...ids.keys()].sort((a, b) => b.length - a.length)
  const idRe = all.length ? new RegExp(all.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "g") : null
  const walk = (v: any): any => {
    // A drawn arc whose middle point is within 0.0002 mm of the chord (a legacy `fp_arc` of a few thousandths of a degree) is a straight line at the precision of the file: it is written with its
    // three points and read again as the line it is, so both are compared as that line.
    if (v && typeof v === "object" && !Array.isArray(v) && v.type === "arc" && v.start && v.mid && v.end) {
      const dx = v.end.x - v.start.x
      const dy = v.end.y - v.start.y
      const len = Math.hypot(dx, dy)
      const off = len > 0 ? Math.abs((v.mid.x - v.start.x) * dy - (v.mid.y - v.start.y) * dx) / len : Math.hypot(v.mid.x - v.start.x, v.mid.y - v.start.y)
      if (off < 2e-4) {
        const { start, mid, end, ...rest } = v
        v = { ...rest, type: "line", a: start, b: end }
      }
    }
    if (v && typeof v === "object" && !Array.isArray(v) && v.type === "polygon" && Array.isArray(v.pts)) v = { ...v, pts: dedupeCorners(v.pts) }
    if (typeof v === "string") {
      if (lands.has(v)) return lands.get(v)
      if (partIds.has(v)) return partIds.get(v)
      return idRe ? v.replace(idRe, (m) => ids.get(m)!) : v
    }
    if (Array.isArray(v)) return v.map(walk)
    if (v && typeof v === "object") {
      const out: Record<string, any> = {}
      for (const [k, x] of Object.entries(v)) {
        if (k === "id" || k === "createdAt" || k === "updatedAt") continue
        // The members of a group are a set: KiCad writes them sorted by id, which is not the order the file the project was imported from had.
        out[walk(k)] = k === "members" && Array.isArray(x) ? walk(x).slice().sort() : walk(x)
      }
      return out
    }
    return v
  }
  const nets = (() => {
    const conn = computeConnectivity(project)
    const name = new Map(conn.nets.map((n) => [n.id, n.name]))
    const out: string[] = []
    for (const c of project.components) for (const [key, net] of conn.pinNet) if (key.startsWith(`${c.id}:`) || key.startsWith(`${c.id}\u0000`)) out.push(`${c.ref}.${key.slice(c.id.length + 1)}=${name.get(net) ?? net}`)
    return out.sort()
  })()
  // The outline is compared as what is drawn: pieces of no length are left out, consecutive straight pieces on one line are one, a closed path starts at its lowest corner, and the paths are in order of where they start.
  // A board whose outline is a plain rectangle is held as its box and one with any other as paths; both are the same geometry, so both are compared as paths and the box (which follows from them) is left out.
  if (plain.board) {
    const drawn = outlinePaths(project)
    const { outline: _o, width: _w1, height: _h1, x: _x1, y: _y1, cornerRadius: _r1, ...board } = plain.board
    plain.board = { ...board, outlineDrawn: drawn.length ? normalizeOutline(JSON.parse(JSON.stringify(drawn))) : null }
  }
  // A pad that is the same turned half a turn (a plain rectangle, a circle, a pill) has no turn of its own whatever angle a file gave it a millionth off.
  for (const f of plain.footprints ?? []) for (const pad of f.pads ?? []) if (pad.rot !== undefined && ((((pad.rot % 180) + 180) % 180) < 1e-6 || Math.abs((((pad.rot % 180) + 180) % 180) - 180) < 1e-6) && !pad.custom && !pad.holeOffset && !(pad.chamfer?.corners) && pad.shape !== "polygon") delete pad.rot
  // A dimension's text is where KiCad's rules put it unless the text is placed by hand: what is drawn is compared, not the stored place.
  for (const d of plain.dimensions ?? []) {
    if (d.textMode === 2) continue
    const t = dimensionDrawing(d as BoardDimension).text
    d.drawnText = t ? { x: t.x, y: t.y, rot: (((t.rot % 180) + 180) % 180), content: t.content } : null
    delete d.x
    delete d.y
    delete d.rot
  }
  // A pad that is the same turned by a quarter turn (a plain rectangle, a circle, a pill) is the same pad with its sides swapped: a file may give such a turn a millionth off a quarter, which a second reading takes for the quarter.
  for (const f of plain.footprints ?? []) {
    for (const pad of f.pads ?? []) {
      if (pad.rot === undefined || pad.custom || pad.holeOffset || pad.chamfer?.corners || pad.shape === "polygon") continue
      const q = (((pad.rot % 180) + 180) % 180)
      if (Math.abs(q - 90) < 1e-6) {
        const w = pad.width
        pad.width = pad.height
        pad.height = w
        delete pad.rot
      }
    }
  }
  // An arc of no size (three equal points) is the line of no length KiCad draws it as, and a second reading says so.
  const flatten = (list: any[] | undefined) => list?.forEach((sh, i) => {
    if (sh.type === "arc" && Math.hypot(sh.start.x - sh.end.x, sh.start.y - sh.end.y) < 1e-5 && Math.hypot(sh.start.x - sh.mid.x, sh.start.y - sh.mid.y) < 1e-5) {
      const { start, mid: _m, end: _e, ...rest } = sh
      list[i] = { ...rest, type: "line", a: start, b: start }
    }
  })
  flatten(plain.graphics)
  for (const f of plain.footprints ?? []) flatten(f.shapes)
  // KiCad 9's rectangle has no corner radius, so a rounded one is written as the polygon with arc corners it is: both are compared as that outline, a ring turned the same way
  // and started at its lowest corner (the polygon and the rectangle do not start at the same one).
  const ringOf = (path: any) => {
    let pts = flattenPath(path).map((q) => ({ x: Math.round(q.x * 1e5) / 1e5, y: Math.round(q.y * 1e5) / 1e5 }))
    const area = pts.reduce((sum, q, k) => sum + (q.x * pts[(k + 1) % pts.length].y - pts[(k + 1) % pts.length].x * q.y), 0)
    if (area < 0) pts = pts.reverse()
    const first = pts.reduce((best, q, k) => (q.y < pts[best].y || (q.y === pts[best].y && q.x < pts[best].x) ? k : best), 0)
    return { closed: path.closed, pts: [...pts.slice(first), ...pts.slice(0, first)] }
  }
  const outlined = (list: any[] | undefined) => list?.forEach((sh, i) => {
    if (!((sh.type === "rect" && sh.radius > 0) || (sh.type === "polygon" && sh.pts?.some((p: any) => p.mid)))) return
    const { type: _t, a: _a, b: _b, radius: _r, pts: _p, holes: _h, ...rest } = sh
    list[i] = { ...rest, outline: shapePaths(sh).map(ringOf) }
  })
  outlined(plain.graphics)
  for (const f of plain.footprints ?? []) outlined(f.shapes)
  // Tracks are compared as the segments they hold: where the import joins two segments (or breaks a chain) depends on a millionth of a millimetre the first import rounded away, and the copper is the same either way.
  // A via stack that lists a layer at the via's own diameter says the same as one that does not list it: the writer lists every layer, as KiCad does.
  for (const v of plain.vias ?? []) {
    const layers = v.stack?.layers
    if (!layers) continue
    for (const [k, d] of Object.entries(layers)) if (Math.abs((d as number) - v.diameter) < 1e-6) delete layers[k]
  }
  plain.traces = (plain.traces ?? [])
    .flatMap((t: any) => {
      // An arc track is one item, held by its three points; an arc that runs the other way round between the same ends is the same arc.
      if (t.arc) {
        const [a, m, b] = t.points as Pt[]
        const [first, last] = ptKey(a) <= ptKey(b) ? [a, b] : [b, a]
        return [{ layer: t.layer, width: t.width, net: t.net, locked: t.locked, arc: [first, m, last] }]
      }
      return t.points.slice(1).flatMap((q: Pt, i: number) => {
        const p = t.points[i] as Pt
        if (Math.hypot(p.x - q.x, p.y - q.y) < 1e-5) return []
        const [a, b] = ptKey(p) <= ptKey(q) ? [p, q] : [q, p]
        return [{ layer: t.layer, width: t.width, net: t.net, locked: t.locked, a, b }]
      })
    })
    .sort((x: any, y: any) => (JSON.stringify([x.layer, ptKey(x.a ?? x.arc[0]), ptKey(x.b ?? x.arc[2]), x.width, x.net]) < JSON.stringify([y.layer, ptKey(y.a ?? y.arc[0]), ptKey(y.b ?? y.arc[2]), y.width, y.net]) ? -1 : 1))
  const { wires: _w, labels: _l, parts, footprints, components, properties, ...rest } = plain
  const sortBy = (list: any[] | undefined, key: (x: any) => string) => [...(list ?? [])].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0))
  return walk({
    ...rest,
    properties: (properties ?? []).filter((p: { key: string }) => !PROVENANCE_PROPERTIES.has(p.key)),
    components: sortBy(components, (c) => c.ref).map((c) => {
      const { sch: _s, ...r } = c
      return r
    }),
    parts: sortBy(parts, (p) => walk(p.id)),
    footprints: sortBy(footprints, (f) => walk(f.name)),
    nets,
  })
}

type Pt = { x: number; y: number }
const ptKey = (p: Pt) => `${Math.round(p.x * 1e5)},${Math.round(p.y * 1e5)}`
const startOf = (s: any): Pt => s.a ?? s.start ?? s.p0 ?? s.c
const endOf = (s: any): Pt => s.b ?? s.end ?? s.p1 ?? s.c

/** A polygon's corners without a corner repeated (a file may close its ring by naming the first corner again, a millionth off, which a second reading takes for the same corner). */
function dedupeCorners(pts: any[]): any[] {
  const out: any[] = []
  for (const p of pts) {
    const last = out[out.length - 1]
    if (last && Math.abs(last.x - p.x) < 1e-5 && Math.abs(last.y - p.y) < 1e-5 && !p.mid) continue
    out.push(p)
  }
  const first = out[0]
  const end = out[out.length - 1]
  if (out.length > 3 && Math.abs(first.x - end.x) < 1e-5 && Math.abs(first.y - end.y) < 1e-5 && !end.mid) out.pop()
  return out
}

/** The area a closed path's corners enclose, signed by its direction. */
function signedArea(segs: any[]): number {
  let a = 0
  for (const g of segs) {
    const p = startOf(g)
    const q = endOf(g)
    a += p.x * q.y - q.x * p.y
  }
  return a / 2
}

function normalizeOutline(paths: any[]): any[] {
  const out = paths.map((path) => {
    let segs: any[] = path.segs.filter((s: any) => {
      if (s.kind === "line") return Math.hypot(s.a.x - s.b.x, s.a.y - s.b.y) > 1e-5
      if (s.kind === "arc") return Math.hypot(s.start.x - s.end.x, s.start.y - s.end.y) > 1e-5 || Math.hypot(s.start.x - s.mid.x, s.start.y - s.mid.y) > 1e-5
      return true
    })
    // A curve of the importer's path may be held backwards (its end is where the previous piece ends); it is the same curve either way round, so each is turned to follow the one before.
    const gap = (p: Pt, q: Pt) => Math.hypot(p.x - q.x, p.y - q.y)
    const turn = (g: any) => (g.kind === "bezier" ? { ...g, p0: g.p1, p1: g.p0, c1: g.c2, c2: g.c1 } : g)
    for (let i = 0; i < segs.length; i++) {
      const g = segs[i]
      if (g.kind !== "bezier") continue
      if (i > 0) {
        const prev = endOf(segs[i - 1])
        if (gap(g.p1, prev) < gap(g.p0, prev)) segs[i] = turn(g)
      } else if (segs.length > 1) {
        const next = startOf(segs[1])
        if (gap(g.p0, next) < gap(g.p1, next)) segs[i] = turn(g)
      }
    }
    const merge = (list: any[]) => {
      const r: any[] = []
      for (const s of list) {
        const last = r[r.length - 1]
        if (last && last.kind === "line" && s.kind === "line") {
          const d1 = { x: last.b.x - last.a.x, y: last.b.y - last.a.y }
          const d2 = { x: s.b.x - s.a.x, y: s.b.y - s.a.y }
          const cross = d1.x * d2.y - d1.y * d2.x
          const dot = d1.x * d2.x + d1.y * d2.y
          if (Math.abs(cross) < 1e-5 * Math.hypot(d1.x, d1.y) * Math.hypot(d2.x, d2.y) && dot > 0) {
            r[r.length - 1] = { ...last, b: s.b }
            continue
          }
        }
        r.push(s)
      }
      return r
    }
    segs = merge(segs)
    if (path.closed && segs.length > 1) {
      const wrap = merge([segs[segs.length - 1], segs[0]])
      if (wrap.length === 1) segs = [wrap[0], ...segs.slice(1, -1)]
      let best = 0
      segs.forEach((s, i) => {
        const a = startOf(s)
        const b = startOf(segs[best])
        if (a.x < b.x - 1e-5 || (Math.abs(a.x - b.x) <= 1e-5 && a.y < b.y - 1e-5)) best = i
      })
      segs = [...segs.slice(best), ...segs.slice(0, best)]
    }
    if (path.closed && segs.length > 1 && signedArea(segs) < 0) {
      // Every closed path runs the same way round: the reverse of a path has its pieces in the other order with their ends swapped.
      const flipped = segs.slice().reverse().map((g: any) => (g.kind === "line" ? { ...g, a: g.b, b: g.a } : g.kind === "arc" ? { ...g, start: g.end, end: g.start } : turn(g)))
      const first = flipped.findIndex(() => true)
      void first
      segs = flipped
      let best = 0
      segs.forEach((g, i) => {
        const a = startOf(g)
        const b = startOf(segs[best])
        if (a.x < b.x - 1e-5 || (Math.abs(a.x - b.x) <= 1e-5 && a.y < b.y - 1e-5)) best = i
      })
      segs = [...segs.slice(best), ...segs.slice(0, best)]
    }
    return { ...path, segs }
  })
  return out.filter((x) => x.segs.length).sort((x, y) => (ptKey(startOf(x.segs[0])) < ptKey(startOf(y.segs[0])) ? -1 : 1))
}

export interface Difference {
  /** The path with every list place and part reference taken out: what kind of thing differs. */
  kind: string
  path: string
  first: string
  second: string
}

const short = (v: unknown) => (JSON.stringify(v) ?? "undefined").slice(0, 90)

export const TENT_UNSET = " (unset in the first project)"
export const KEPT_ONLY_IN_FIRST = " (unset in the second project)"

/** Every difference of two canonical projects, at most `limit`. */
export function diffCanonical(a: any, b: any, limit = 200): Difference[] {
  const out: Difference[] = []
  const kindOf = (path: string) => path.replace(/\[\d+\]/g, "[]").replace(/^(components|parts|footprints)\[[^\]]*\]/, "$1[]").replace(/(noConnect|netWidths)\.[^.]+/, "$1.*")
  const walk = (x: any, y: any, path: string) => {
    if (out.length >= limit || x === y) return
    if (typeof x === "number" && typeof y === "number" && Math.abs(x - y) < 1.5e-6) return
    if (typeof x !== "object" || typeof y !== "object" || x === null || y === null || Array.isArray(x) !== Array.isArray(y)) {
      // A tenting side the first project leaves unset is its own kind: KiCad 10 writes `none` for it and the 9.0 file says it by words for both sides, so it comes back not tented (by design); a side that was set and changed is a finding.
      const unsetTent = x === undefined && /\.tent\.(front|back|top|bottom)$/.test(path)
      // The same for what the writer leaves out because KiCad 9 has no words for it (a hatch position, a shape at a line's end), which the second project then lacks, and for the grid of a KiCad 10 hatch, which the 9.0 file makes the
      // second project lay from the corner of the copper; a value that is set in both and changed is a finding.
      const keptOnlyInFirst = y === undefined && /\.(hatchAt|ends)$/.test(path)
      const gridUnset = x === undefined && /\.hatch\.fromFill$/.test(path)
      out.push({ kind: kindOf(path) + (unsetTent || gridUnset ? TENT_UNSET : "") + (keptOnlyInFirst ? KEPT_ONLY_IN_FIRST : ""), path, first: short(x), second: short(y) })
      return
    }
    if (Array.isArray(x)) {
      if (x.length !== y.length) out.push({ kind: `${kindOf(path)}.length`, path: `${path}.length`, first: String(x.length), second: String(y.length) })
      for (let i = 0; i < Math.min(x.length, y.length); i++) walk(x[i], y[i], `${path}[${i}]`)
      return
    }
    for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) walk(x[k], y[k], `${path}.${k}`)
  }
  walk(a, b, "project")
  return out
}

// ---------- the design rules, which a KiCad 9 board keeps in its project file ----------

/** The rules a `.kicad_pro` carries and the importer does not read back yet, so they are compared with what the project had by reading the written JSON here, with no code of the writer. */
export const RULES_IN_PROJECT_FILE = ["traceWidth", "clearance", "viaDiameter", "viaDrill", "minTraceWidth", "minAnnularRing", "holeClearance", "edgeClearance", "minDrill", "preferredWidths", "viaSizes", "netClasses"] as const

/** The rules the board file itself carries (its `setup`), which the importer reads back. */
export const RULES_IN_BOARD_FILE = ["maskExpansion", "pasteExpansion", "maskMinWidth", "pasteRatio", "maskBridgesInParts", "tentVias", "tentSides"]

const near = (a: number | undefined, b: number | undefined) => (a === undefined && b === undefined) || (a !== undefined && b !== undefined && Math.abs(a - b) < 6e-7)
const unescape = (p: string) => p.split("\\").join("")

export function proRulesDifferences(project: Project, proText: string): Difference[] {
  const out: Difference[] = []
  const say = (field: string, first: unknown, second: unknown) => out.push({ kind: `rules in the project file: ${field}`, path: `project.rules.${field}`, first: short(first), second: short(second) })
  const pro = JSON.parse(proText) as any
  const rules = project.rules
  const design = pro.board?.design_settings
  const classes: any[] = pro.net_settings?.classes ?? []
  const def = classes.find((c) => c.name === "Default") ?? {}
  const check = (field: string, want: number | undefined, got: number | undefined) => {
    if (!near(want, got)) say(field, want, got)
  }
  check("traceWidth", rules.traceWidth, def.track_width)
  check("clearance", rules.clearance, def.clearance)
  check("viaDiameter", rules.viaDiameter, def.via_diameter)
  check("viaDrill", rules.viaDrill, def.via_drill)
  check("minTraceWidth", rules.minTraceWidth, design?.rules?.min_track_width)
  check("minAnnularRing", rules.minAnnularRing, design?.rules?.min_via_annular_width)
  check("holeClearance", rules.holeClearance, design?.rules?.min_hole_to_hole)
  check("edgeClearance", rules.edgeClearance, design?.rules?.min_copper_edge_clearance)
  // KiCad 9 has one smallest drill for vias and through holes: the smaller of the two.
  check("minDrill", Math.min(rules.minDrill, rules.minViaDrill ?? rules.minDrill), design?.rules?.min_through_hole_diameter)
  const widths = ((design?.defaults?.track_widths ?? []) as number[]).filter((w) => w > 0)
  const wantWidths = [...new Set([rules.traceWidth, ...rules.preferredWidths])].sort((a, b) => a - b)
  if (widths.length !== wantWidths.length || widths.some((w, i) => !near(w, wantWidths[i]))) say("preferredWidths", wantWidths, widths)
  const vias = ((design?.defaults?.via_dimensions ?? []) as { diameter: number; drill: number }[]).slice(2)
  const wantVias = (rules.viaSizes ?? []).filter((v) => !(v.diameter === rules.viaDiameter && v.drill === rules.viaDrill))
  if (vias.length !== wantVias.length || vias.some((v, i) => !near(v.diameter, wantVias[i].diameter) || !near(v.drill, wantVias[i].drill))) say("viaSizes", wantVias, vias)
  const patterns = ((pro.net_settings?.netclass_patterns ?? []) as { netclass: string; pattern: string }[])
  for (const c of rules.netClasses ?? []) {
    const got = classes.find((x) => x.name === c.name)
    if (!got) {
      say(`netClasses ${c.name}`, c.name, undefined)
      continue
    }
    const fields: [string, number | undefined, number | undefined][] = [
      ["clearance", c.clearance, got.clearance],
      ["traceWidth", c.traceWidth, got.track_width],
      ["viaDiameter", c.viaDiameter, got.via_diameter],
      ["viaDrill", c.viaDrill, got.via_drill],
      ["diffPairWidth", c.diffPairWidth, got.diff_pair_width],
      ["diffPairGap", c.diffPairGap, got.diff_pair_gap],
    ]
    // A size the class leaves to the Default class is written with the Default class's value.
    const dflt: Record<string, number | undefined> = { clearance: def.clearance, traceWidth: def.track_width, viaDiameter: def.via_diameter, viaDrill: def.via_drill, diffPairWidth: def.diff_pair_width, diffPairGap: def.diff_pair_gap }
    for (const [f, want, have] of fields) if (!near(want ?? dflt[f], have)) say(`netClasses ${c.name} ${f}`, want, have)
    const mine = patterns.filter((p) => p.netclass === c.name).map((p) => p.pattern)
    const exact = mine.filter((p) => c.nets.includes(unescape(p)))
    if (exact.length !== c.nets.length || mine.length !== c.nets.length + (c.patterns?.length ?? 0)) say(`netClasses ${c.name} nets`, { nets: c.nets.length, patterns: c.patterns?.length ?? 0 }, { patterns: mine.length })
  }
  return out
}

/** The project with the rules the project file carries taken out, so that the rest is compared with what the board file alone reads back. */
export function withoutProjectFileRules(canonical: any): any {
  const keep = new Set(RULES_IN_BOARD_FILE)
  const rules: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(canonical.rules ?? {})) if (keep.has(k)) rules[k] = v
  // What the import keeps for the export (`Project.kicad`: the page, the origins, the plot settings, the layer table, the project file) is not the project the editor edits, and the file the writer
  // makes adds rows to the layer table for the layers it uses: the KiCad-judged corpus test (`kicad-judge-corpus.test.ts`) checks that it is written back.
  const { kicad: _kicad, ...rest } = canonical
  return { ...rest, rules }
}

// ---------- the whole comparison ----------

/** The most the outline repair may move a piece (`JOIN_TOLERANCE` of the importer): the repair runs again on what the writer wrote. */
const REPAIR_TOLERANCE = 0.1

function samples(paths: any[]): Pt[][] {
  return paths.map((p) => flattenPath({ closed: p.closed, segs: p.segs }, 0.002))
}

const near2 = (p: Pt, ring: Pt[], closed: boolean) => {
  let best = Infinity
  const n = ring.length
  for (let i = 0; i < (closed ? n : n - 1); i++) {
    const a = ring[i]
    const b = ring[(i + 1) % n]
    const dx = b.x - a.x
    const dy = b.y - a.y
    const l2 = dx * dx + dy * dy
    const t = l2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0
    best = Math.min(best, Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy)))
  }
  return best
}

/** How far apart two outlines are: the most any point of one is from the other, both ways. */
export function outlineDistance(a: any[], b: any[]): number {
  const sa = samples(a)
  const sb = samples(b)
  const reach = (from: Pt[][], to: Pt[][], toPaths: any[]) => {
    let worst = 0
    for (const ring of from) for (const p of ring) {
      let best = Infinity
      to.forEach((r, i) => (best = Math.min(best, near2(p, r, toPaths[i].closed))))
      worst = Math.max(worst, best)
    }
    return worst
  }
  return Math.max(reach(sa, sb, b), reach(sb, sa, a))
}

/**
 * Every difference between a project and the one its written file imports as. An outline that differs by less than the repair's own tolerance, with the
 * same number of paths, is one named difference (`outline repair runs again`), not a list of moved pieces.
 */
export function diffProjects(first: Project, second: Project, limit = 200): Difference[] {
  // The rules the project file carries are checked against the written project file (`proRulesDifferences`), not against what the board alone reads back.
  const a = withoutProjectFileRules(canonicalProject(first))
  const b = withoutProjectFileRules(canonicalProject(second))
  const extra: Difference[] = []
  // KiCad's stored fill of a zone (`Zone.kept`): the second import keeps a fill the first had not when the file had none for the zone (the export wrote the editor's fill of it, which a KiCad file
  // stores); where both have one it is the same rings, layers, island marks and pen flag, and the signature is not compared (it is of a zone whose uuid and gaps differ by design).
  const zonesA = (a as any).zones as any[] | undefined
  const zonesB = (b as any).zones as any[] | undefined
  zonesA?.forEach((z, i) => {
    const o = zonesB?.[i]
    if (!o) return
    if (z.kept === undefined && o.kept !== undefined) delete o.kept
    if (z.kept && o.kept) {
      delete z.kept.sig
      delete o.kept.sig
    }
  })
  // A footprint's and its pads' KiCad uuids (`ComponentInstance.fpUuid`, `padUuids`): the second import reads the ones the export wrote where the first had none
  // (a part drawn here, a file that gave none); where the first had them they are compared, and must have come back as they were.
  const partsA = (a as any).components as any[] | undefined
  const partsB = (b as any).components as any[] | undefined
  partsA?.forEach((c, i) => {
    const o = partsB?.[i]
    if (!o) return
    if (c.fpUuid === undefined) delete o.fpUuid
    if (c.padUuids === undefined) delete o.padUuids
  })
  const oa = a.board?.outlineDrawn
  const ob = b.board?.outlineDrawn
  if (oa && ob && JSON.stringify(oa) !== JSON.stringify(ob) && oa.length === ob.length) {
    // exact to the tolerance of a number first; only a real difference is measured
    if (diffCanonical(oa, ob, 1).length) {
      const d = outlineDistance(oa, ob)
      if (d <= REPAIR_TOLERANCE + 1e-6) {
        extra.push({ kind: "project.board.outlineDrawn: the outline repair runs again on its own output", path: "project.board.outlineDrawn", first: `${oa.length} path(s)`, second: `within ${d.toFixed(4)} mm` })
        b.board.outlineDrawn = oa
      }
    }
  }
  return [...diffCanonical(a, b, limit), ...extra]
}

/**
 * What differs on purpose, because a KiCad 9 file cannot say it: a zone of a board of KiCad 5 or earlier has no uuid and is not ordered by one (a file of
 * KiCad 9 gives every zone a uuid, which orders zones of equal priority), and its fill keeps that release's distances to the edge and to a hole; KiCad 9 has no
 * `virtual` attribute (it reads it as "not in the BOM" and "not in the position file"), and jumper pad groups and a text's hyperlink are KiCad 10's, which the 9.0
 * parser refuses (they stay in the project and are not written). Copper the file put on no net that touches a net is written on that net (the editor cannot tell it from copper added in it). Everything else that differs is a finding.
 */
export const BY_DESIGN = [
  /^project\.zones\[\]\.(edgeGap|holeGap|unordered|uuid)$/,
  /^project\.components\[\]\.flags\.(virtual|excludeFromBom|excludeFromPos)$/,
  /^project\.components\[\]\.flags\.(jumperDuplicates|jumperGroups)$/,
  /^project\.(texts|components\[\]\.texts)\[\]\.href$/,
  /^project\.(traces\[\]\.net|vias\[\]\.routedNet)$/,
  // X1: a stackup's `castellated_pads` is a word of later KiCad releases than 9.0, whose parser stops at a node it does not have, so it is kept in the project and not written
  /^project\.board\.stack\.castellated$/,
  // X22 and X21: via protection, backdrills and post-machining, a pad's `die_delay`, a via stack or via stitching, and net chains are KiCad 10's (and 11's) words, which the 9.0 parser refuses (the
  // written file has none: `unknownNodes`), so they stay in the project. A tuning pattern and a pad's `die_length` are KiCad 9's and are written; a pattern that goes missing shows as
  // `project.groups[].gen.props...` or, when the whole pattern is gone, is caught by the `tuning pattern` check below.
  /^project\.vias\[\]\.(protect|backdrill|tertiary|post)(\.|$)/,
  /^project\.footprints\[\]\.pads\[\]\.(backdrill|tertiary|post|dieDelay)(\.|$)/,
  /^project\.groups\[\]\.gen$/,
  /^project\.netChains(\[\]|\.length)?(\.|$)/,
  // X23: a board's variants, what they change on a footprint, a footprint's units and the PCB points (a part's and the board's) are KiCad 10's words, which the 9.0 parser refuses, so they stay in the
  // project and are not written; with a variant shown, the footprints are written as it makes them.
  /^project\.(variants|points)(\.|\[|$)/,
  /^project\.components\[\]\.(variants|units|points)(\.|\[|$)/,
  // KiCad 11's dielectric model and frequency of a stackup row are not in a KiCad 9 file (the writer says so), and KiCad 9 says a via's or pad's tenting by words for both sides together, so a side the file left
  // unset (KiCad 10 writes `none`) is written not tented (the writer's note says so).
  /^project\.board\.stack\.rows\[\](\.sub\[\])?\.(model|specFreq)$/,
  /^project\.(vias\[\]|footprints\[\]\.pads\[\])\.tent\.(front|back|top|bottom) \(unset in the first project\)$/,
  // X24: a hatch position is KiCad 10's word and the shapes at a line's ends KiCad 11 development's, which the 9.0 parser refuses (they stay in the project and are not written); a hatched pour of a KiCad 10 file lays its grid from the
  // origin, and the KiCad 9 file the writer makes is read as one that lays it from the corner of its copper.
  /^project\.(zones\[\]|footprints\[\]\.zones\[\])\.hatchAt \(unset in the second project\)$/,
  /^project\.(zones\[\]|footprints\[\]\.zones\[\])\.hatch\.fromFill \(unset in the first project\)$/,
  /^project\.(graphics\[\]|footprints\[\]\.shapes\[\])\.ends \(unset in the second project\)$/,
]

/** The outline repair of the importer runs again on the outline the writer wrote, and moves a piece it had joined by its tolerance (never more than 0.1 mm; `diffProjects` names it). */
export const REPAIRED = [/^project\.board\.outlineDrawn: /]
