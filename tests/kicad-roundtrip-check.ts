import { computeConnectivity } from "../src/model/connectivity"
import { outlinePaths, PROVENANCE_PROPERTIES } from "../src/export/kicadBoard"
import { dimensionDrawing } from "../src/model/dimensions"
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
        out[walk(k)] = walk(x)
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
      const flipped = segs.slice().reverse().map((g: any) => (g.kind === "line" ? { ...g, a: g.b, b: g.a } : g.kind === "arc" ? { ...g, start: g.end, end: g.start } : g))
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

/** Every difference of two canonical projects, at most `limit`. */
export function diffCanonical(a: any, b: any, limit = 200): Difference[] {
  const out: Difference[] = []
  const kindOf = (path: string) => path.replace(/\[\d+\]/g, "[]").replace(/^(components|parts|footprints)\[[^\]]*\]/, "$1[]").replace(/(noConnect|netWidths)\.[^.]+/, "$1.*")
  const walk = (x: any, y: any, path: string) => {
    if (out.length >= limit || x === y) return
    if (typeof x === "number" && typeof y === "number" && Math.abs(x - y) < 6e-7) return
    if (typeof x !== "object" || typeof y !== "object" || x === null || y === null || Array.isArray(x) !== Array.isArray(y)) {
      out.push({ kind: kindOf(path), path, first: short(x), second: short(y) })
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
export const RULES_IN_BOARD_FILE = ["maskExpansion", "pasteExpansion", "maskMinWidth", "pasteRatio", "maskBridgesInParts"]

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
  return { ...canonical, rules }
}
