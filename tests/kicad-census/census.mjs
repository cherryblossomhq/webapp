// The KiCad census: reads every `.kicad_pcb` under a corpus folder and writes what each board
// contains, one JSON record per board, for the gap list in `docs/kicad-import.md`.
//
//   node tests/kicad-census/census.mjs <corpus-root> <out-dir>
//   node tests/kicad-census/aggregate.mjs <out-dir>
//
// It is a plain script rather than a vitest file because it runs over a local corpus that is not in
// the repo, and it is not part of `src` because it is the oracle the importer is judged against:
// its reader (`sexpr.mjs`) and its geometry share no code with `src/model/kicad`. Phase 1 grows
// it into the per-board pass/fail table (object counts, pad positions, nets, round trip).
//
// Corpus layout it understands: `pcbench/PCBs/<name>/raw.kicad_pcb` (+ `metadata.json`),
// `projects/<owner>__<repo>/...` and `kicad-source/{demos,qa}/...`.

import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync, existsSync } from "node:fs"
import { join, dirname, basename, relative, sep } from "node:path"
import { parseSexpr, kid, kids, atoms, numAt, hasAtom } from "./sexpr.mjs"
import { ATOMS } from "./decisions.mjs"
import { collectAtoms } from "./atoms.mjs"

const [, , root, outDir] = process.argv
if (!root || !outDir) {
  console.error("usage: node census.mjs <corpus-root> <out-dir>")
  process.exit(2)
}

// ---------- files ----------

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const s = statSync(p)
    if (s.isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}

// `projects/_targeted.txt` lists the projects found by searching GitHub for a feature (blind vias,
// arc tracks, keepouts, curves) instead of by chance; they are kept out of the unbiased numbers.
const targetedFile = join(root, "projects", "_targeted.txt")
const targeted = new Set(existsSync(targetedFile) ? readFileSync(targetedFile, "utf8").split(/\r?\n/).filter(Boolean) : [])
const groupOf = (rel) => {
  if (rel.startsWith("pcbench/")) return "pcbench"
  if (rel.startsWith("kicad-source/demos")) return "kicad-demos"
  if (rel.startsWith("kicad-source")) return "kicad-qa"
  return targeted.has(rel.split("/")[1]) ? "github-targeted" : "github"
}

// ---------- versions ----------

/** KiCad's release for a board file's `(version N)` stamp, from the version history in pcb_io_kicad_sexpr.h. */
export function eraOf(stamp) {
  if (stamp === null) return "unknown"
  if (stamp <= 4) return "kicad4-or-older"
  if (stamp <= 20171130) return "kicad5"
  if (stamp < 20211014) return "pre6-nightly"
  if (stamp <= 20211014) return "kicad6"
  if (stamp <= 20221018) return "kicad7"
  if (stamp <= 20240108) return "kicad8"
  if (stamp <= 20241229) return "kicad9"
  if (stamp <= 20260206) return "kicad10"
  return "kicad11-dev"
}

// ---------- geometry ----------

const D2R = Math.PI / 180
/** KiCad's rotation: positive is counter-clockwise on screen, and y runs down. `sgn` -1 tries the other way. */
const rot = (x, y, deg, sgn = 1) => {
  const c = Math.cos(deg * D2R)
  const s = Math.sin(deg * D2R) * sgn
  return [x * c + y * s, -x * s + y * c]
}
const isQuarter = (deg) => {
  const q = deg / 90
  return Math.abs(q - Math.round(q)) * 90 < 0.01
}
const mod360 = (d) => ((d % 360) + 360) % 360

function xy(node, name) {
  const k = kid(node, name)
  return k ? [numAt(k, 1), numAt(k, 2)] : null
}

/**
 * A footprint's own placement: x, y, angle and side. The side is read from the layer table's last
 * copper row (`backName`), never from a layer's name, because KiCad 5 boards name theirs "Back" and
 * "Bottom". From stamp 20260616 a footprint has `(transform (translate x y) (rotate a) (scale ..))`
 * instead of `(at x y a)`.
 */
function placement(fp, backName) {
  const at = kid(fp, "at")
  const transform = kid(fp, "transform")
  const layer = kid(fp, "layer")?.[1] ?? ""
  const bottom = layer === backName || layer === "B.Cu"
  if (!at && transform) {
    const t = kid(transform, "translate")
    return { x: numAt(t, 1), y: numAt(t, 2), a: numAt(kid(transform, "rotate"), 1), bottom, transformed: true }
  }
  return { x: numAt(at, 1), y: numAt(at, 2), a: numAt(at, 3), bottom, transformed: false }
}

// ---------- the board ----------

const GFX = new Set(["line", "arc", "circle", "rect", "poly", "curve", "text", "text_box", "bbox"])
function layerClass(name) {
  if (!name) return "none"
  if (name === "Edge.Cuts") return "edge"
  if (copperSet.has(name)) return "copper"
  if (/Silk/.test(name)) return "silk"
  if (/\.Fab$/.test(name)) return "fab"
  if (/CrtYd|Courtyard/.test(name)) return "court"
  if (/\.Mask$/.test(name)) return "mask"
  if (/\.Paste$/.test(name)) return "paste"
  if (/\.Cu$/.test(name)) return "copper"
  if (/Adhes/.test(name)) return "adhes"
  if (/User|Eco|Margin/.test(name)) return "user"
  return "other"
}

/** The current board's copper layer names, so a layer called "Front" is still copper. */
let copperSet = new Set()

const bump = (o, k, n = 1) => {
  o[k] = (o[k] ?? 0) + n
}

class UF {
  constructor(n) {
    this.p = Array.from({ length: n }, (_, i) => i)
  }
  find(i) {
    while (this.p[i] !== i) {
      this.p[i] = this.p[this.p[i]]
      i = this.p[i]
    }
    return i
  }
  union(a, b) {
    this.p[this.find(a)] = this.find(b)
  }
}

const dist2 = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1])

/** The pieces of one closed loop in order, each oriented so that one ends where the next begins. */
function orderLoop(ps, tol) {
  const left = ps.slice()
  const first = left.shift()
  const seq = [{ p: first, a: first.a, b: first.b }]
  let end = first.b
  while (left.length) {
    let idx = -1
    let flip = false
    for (let i = 0; i < left.length; i++) {
      if (dist2(left[i].a, end) <= tol) {
        idx = i
        break
      }
      if (dist2(left[i].b, end) <= tol) {
        idx = i
        flip = true
        break
      }
    }
    if (idx < 0) return null
    const q = left.splice(idx, 1)[0]
    const piece = flip ? { p: q, a: q.b, b: q.a } : { p: q, a: q.a, b: q.b }
    seq.push(piece)
    end = piece.b
  }
  return seq
}

/** Neighbouring straight lines on one line become one: a rectangle drawn in eight pieces is a rectangle. */
function mergeCollinear(seq) {
  const straight = (s) => s.p.kind === "line"
  const same = (u, v) => {
    const ux = u.b[0] - u.a[0]
    const uy = u.b[1] - u.a[1]
    const vx = v.b[0] - v.a[0]
    const vy = v.b[1] - v.a[1]
    const cross = Math.abs(ux * vy - uy * vx) / (Math.hypot(ux, uy) * Math.hypot(vx, vy))
    return cross < 0.01 && ux * vx + uy * vy > 0
  }
  const out = []
  for (const s of seq) {
    const last = out[out.length - 1]
    if (last && straight(last) && straight(s) && same(last, s)) out[out.length - 1] = { p: last.p, a: last.a, b: s.b }
    else out.push({ ...s })
  }
  while (out.length > 2 && straight(out[0]) && straight(out[out.length - 1]) && same(out[out.length - 1], out[0])) {
    const tail = out.pop()
    out[0] = { p: out[0].p, a: tail.a, b: out[0].b }
  }
  return out
}

/**
 * The repair the importer applies to hand-drawn outlines before it looks for loops: straight pieces
 * on one line that overlap or touch (within the tolerance) become one, and a straight piece
 * shorter than the tolerance is dropped. KiCad 5 never checked an outline, so boards have doubled
 * lines, a side drawn in overlapping pieces, and 0.09 mm stubs. `stats` counts what was done.
 */
function repairPieces(pieces, tol, stats) {
  const lines = pieces.filter((p) => p.kind === "line")
  const others = pieces.filter((p) => p.kind !== "line")
  const clusters = []
  for (const l of lines) {
    const len = Math.hypot(l.b[0] - l.a[0], l.b[1] - l.a[1])
    let ux = (l.b[0] - l.a[0]) / len
    let uy = (l.b[1] - l.a[1]) / len
    if (ux < 0 || (ux === 0 && uy < 0)) {
      ux = -ux
      uy = -uy
    }
    const c = clusters.find((k) => Math.abs(k.ux * uy - k.uy * ux) < 0.01 && Math.abs(k.uy * (l.a[0] - k.p0[0]) - k.ux * (l.a[1] - k.p0[1])) <= tol && Math.abs(k.uy * (l.b[0] - k.p0[0]) - k.ux * (l.b[1] - k.p0[1])) <= tol)
    const t = (pt, k) => (pt[0] - k.p0[0]) * k.ux + (pt[1] - k.p0[1]) * k.uy
    if (c) {
      const t0 = t(l.a, c)
      const t1 = t(l.b, c)
      c.spans.push([Math.min(t0, t1), Math.max(t0, t1)])
    } else {
      const k = { ux, uy, p0: l.a, spans: [] }
      const t0 = t(l.a, k)
      const t1 = t(l.b, k)
      k.spans.push([Math.min(t0, t1), Math.max(t0, t1)])
      clusters.push(k)
    }
  }
  const out = [...others]
  for (const k of clusters) {
    k.spans.sort((a, b) => a[0] - b[0])
    const merged = []
    for (const sp of k.spans) {
      const last = merged[merged.length - 1]
      if (last && sp[0] <= last[1] + tol) last[1] = Math.max(last[1], sp[1])
      else merged.push([...sp])
    }
    stats.merged += k.spans.length - merged.length
    for (const [t0, t1] of merged) {
      if (t1 - t0 < tol) {
        stats.dropped++
        continue
      }
      const a = [k.p0[0] + k.ux * t0, k.p0[1] + k.uy * t0]
      const b = [k.p0[0] + k.ux * t1, k.p0[1] + k.uy * t1]
      const slack = Math.max(0.05, 0.005 * (t1 - t0))
      out.push({ kind: "line", a, b, pts: [a, b], axis: Math.abs(a[1] - b[1]) <= slack || Math.abs(a[0] - b[0]) <= slack })
    }
  }
  return out
}

/** Edge.Cuts items as pieces with end points, and the closed ones as loops. */
function outlineOf(rawPieces, tol = 0.1) {
  const repair = { merged: 0, dropped: 0 }
  const pieces = repairPieces(rawPieces, tol, repair)
  // pieces: { kind, a, b, pts, axis } ; closed pieces (circle, rect, poly) have a === null
  const open = pieces.filter((p) => p.a)
  const loops = []
  for (const p of pieces) if (!p.a) loops.push({ kinds: [p.kind], pts: p.pts, pieces: [p], merged: null })
  const ends = []
  open.forEach((p, i) => {
    ends.push({ p: i, e: 0, x: p.a[0], y: p.a[1] })
    ends.push({ p: i, e: 1, x: p.b[0], y: p.b[1] })
  })
  const cell = Math.max(0.05, tol)
  const grid = new Map()
  const uf = new UF(open.length)
  const key = (cx, cy) => `${cx},${cy}`
  for (const e of ends) {
    const cx = Math.floor(e.x / cell)
    const cy = Math.floor(e.y / cell)
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const o of grid.get(key(cx + dx, cy + dy)) ?? []) {
          if (Math.hypot(o.x - e.x, o.y - e.y) <= tol) uf.union(o.p, e.p)
        }
      }
    }
    const k = key(cx, cy)
    if (!grid.has(k)) grid.set(k, [])
    grid.get(k).push(e)
  }
  const comps = new Map()
  open.forEach((p, i) => {
    const r = uf.find(i)
    if (!comps.has(r)) comps.set(r, [])
    comps.get(r).push(p)
  })
  let openChains = 0
  for (const ps of comps.values()) {
    // closed when every end point meets exactly one other end
    const ce = []
    for (const p of ps) ce.push(p.a, p.b)
    let closed = ps.length >= 2 || ps.some((p) => p.kind === "arc" && p.fullCircle)
    for (const e of ce) {
      let n = 0
      for (const f of ce) if (Math.hypot(e[0] - f[0], e[1] - f[1]) <= tol) n++
      if (n !== 2) closed = false
    }
    const pts = ps.flatMap((p) => p.pts)
    if (closed) {
      const seq = ps.length >= 2 ? orderLoop(ps, tol) : null
      loops.push({ kinds: ps.map((p) => p.kind), pts, pieces: ps, merged: seq ? mergeCollinear(seq) : null })
    } else openChains++
  }
  const box = (pts) => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const [x, y] of pts) {
      if (x < minX) minX = x
      if (y < minY) minY = y
      if (x > maxX) maxX = x
      if (y > maxY) maxY = y
    }
    return { minX, minY, maxX, maxY, area: (maxX - minX) * (maxY - minY) }
  }
  for (const l of loops) {
    l.box = box(l.pts)
    l.shape = classifyLoop(l)
  }
  loops.sort((a, b) => b.box.area - a.box.area)
  const inside = (a, b) => a.minX >= b.minX - 0.01 && a.maxX <= b.maxX + 0.01 && a.minY >= b.minY - 0.01 && a.maxY <= b.maxY + 0.01
  const outer = loops.filter((l, i) => !loops.some((o, j) => j < i && inside(l.box, o.box)))
  const cutouts = loops.length - outer.length
  return { loops, outer, cutouts, openChains, repair }
}

/**
 * rect: four straight axis-aligned sides (after merging collinear pieces); roundrect: four of them
 * and four quarter arcs of one radius, which is what BoardDef.cornerRadius draws;
 * roundrect-unequal: the same with different radii; polygon: straight sides only; circle; curve; arcs.
 */
function classifyLoop(l) {
  const ks = l.kinds
  if (ks.includes("curve")) return "curve"
  if (ks.length === 1 && ks[0] === "circle") return "circle"
  if (ks.length === 1 && ks[0] === "rect") return "rect"
  if (ks.length === 1 && ks[0] === "poly") return l.pieces[0].rectLike ? "rect" : "polygon"
  const seq = l.merged ?? l.pieces.map((p) => ({ p, a: p.a, b: p.b }))
  const lines = seq.filter((x) => x.p.kind === "line")
  const arcs = seq.filter((x) => x.p.kind === "arc")
  const axis = (x) => {
    const len = Math.hypot(x.b[0] - x.a[0], x.b[1] - x.a[1])
    const slack = Math.max(0.05, 0.005 * len)
    return Math.abs(x.b[1] - x.a[1]) <= slack || Math.abs(x.b[0] - x.a[0]) <= slack
  }
  if (!arcs.length) return lines.length === 4 && lines.every(axis) ? "rect" : "polygon"
  if (!lines.length && arcs.every((x) => x.p.fullCircle)) return "circle"
  if (arcs.length === 4 && arcs.every((x) => x.p.quarter) && lines.length <= 4 && lines.every(axis)) {
    const radii = arcs.map((x) => x.p.radius)
    const max = Math.max(...radii)
    return Math.max(...radii) - Math.min(...radii) <= 0.01 * max + 0.01 ? "roundrect" : "roundrect-unequal"
  }
  return "arcs"
}

/** One Edge.Cuts graphic as a piece, with the placement of the footprint it is in (or none). */
function edgePiece(node, kind, fpPlace, legacyArcs, arcSign) {
  const tf = (x, y) => {
    if (!fpPlace) return [x, y]
    const [rx, ry] = rot(x, y, fpPlace.a)
    return [fpPlace.x + rx, fpPlace.y + ry]
  }
  const P = (name) => {
    const v = xy(node, name)
    return v ? tf(v[0], v[1]) : null
  }
  if (kind === "line") {
    const a = P("start")
    const b = P("end")
    if (!a || !b) return null
    const len = Math.hypot(a[0] - b[0], a[1] - b[1])
    if (len < 0.001) return null
    const slack = Math.max(0.05, 0.005 * len)
    return { kind, a, b, pts: [a, b], axis: Math.abs(a[1] - b[1]) <= slack || Math.abs(a[0] - b[0]) <= slack }
  }
  if (kind === "circle") {
    const c = P("center")
    const e = P("end")
    if (!c || !e) return null
    const r = Math.hypot(e[0] - c[0], e[1] - c[1])
    return { kind, a: null, pts: [[c[0] - r, c[1] - r], [c[0] + r, c[1] + r]] }
  }
  if (kind === "rect") {
    const a = P("start")
    const b = P("end")
    if (!a || !b) return null
    return { kind, a: null, pts: [a, b] }
  }
  if (kind === "poly") {
    const pts = kids(kid(node, "pts"), "xy").map((p) => tf(numAt(p, 1), numAt(p, 2)))
    if (pts.length < 3) return null
    const rectLike = pts.length === 4 && pts.every((p, i) => Math.abs(p[0] - pts[(i + 1) % 4][0]) < 0.01 || Math.abs(p[1] - pts[(i + 1) % 4][1]) < 0.01)
    return { kind, a: null, pts, rectLike }
  }
  if (kind === "curve") {
    const pts = kids(kid(node, "pts"), "xy").map((p) => tf(numAt(p, 1), numAt(p, 2)))
    if (pts.length < 2) return null
    return { kind, a: pts[0], b: pts[pts.length - 1], pts }
  }
  if (kind === "arc") {
    let s, m, e, sweep, radius
    if (legacyArcs) {
      // start = centre, end = first end, angle = sweep
      const c = xy(node, "start")
      const f = xy(node, "end")
      const ang = numAt(kid(node, "angle"), 1)
      if (!c || !f) return null
      const [dx, dy] = rot(f[0] - c[0], f[1] - c[1], ang * arcSign)
      s = [f[0], f[1]]
      e = [c[0] + dx, c[1] + dy]
      const [mx, my] = rot(f[0] - c[0], f[1] - c[1], (ang * arcSign) / 2)
      m = [c[0] + mx, c[1] + my]
      sweep = Math.abs(ang)
      radius = Math.hypot(f[0] - c[0], f[1] - c[1])
    } else {
      s = xy(node, "start")
      m = xy(node, "mid")
      e = xy(node, "end")
      if (!s || !m || !e) return null
      sweep = null
    }
    const S = tf(...s)
    const M = tf(...m)
    const E = tf(...e)
    const fullCircle = Math.hypot(S[0] - E[0], S[1] - E[1]) < 0.01
    // sweep of a three point arc: from the circle through them
    if (sweep === null) [sweep, radius] = arcSweep(S, M, E)
    return { kind, a: S, b: E, pts: [S, M, E], quarter: Math.abs(sweep - 90) < 3, fullCircle, radius }
  }
  return null
}

function arcSweep(s, m, e) {
  // circumcentre
  const ax = s[0], ay = s[1], bx = m[0], by = m[1], cx = e[0], cy = e[1]
  const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by))
  if (Math.abs(d) < 1e-12) return [0, 0]
  const ux = ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) + (cx * cx + cy * cy) * (ay - by)) / d
  const uy = ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) + (cx * cx + cy * cy) * (bx - ax)) / d
  const ang = (p) => Math.atan2(p[1] - uy, p[0] - ux)
  let a1 = ang(s), a2 = ang(m), a3 = ang(e)
  const norm = (x) => ((x % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)
  const d12 = norm(a2 - a1)
  const d13 = norm(a3 - a1)
  // m lies between s and e going counter-clockwise when d12 < d13
  const sweep = d12 < d13 ? d13 : 2 * Math.PI - d13
  return [(sweep * 180) / Math.PI, Math.hypot(ax - ux, ay - uy)]
}

// ---------- board census ----------

export function censusBoard(text, rel, size) {
  const root = parseSexpr(text)
  const board = root.find((n) => Array.isArray(n) && n[0] === "kicad_pcb")
  if (!board) throw new Error("no (kicad_pcb ...) root")
  const stamp = (() => {
    const v = kid(board, "version")
    return v ? numAt(v, 1, null) : null
  })()
  const rec = {
    file: rel,
    bytes: size,
    version: stamp,
    era: eraOf(stamp),
    generator: kid(board, "generator")?.[1] ?? (kid(board, "host") ? `host:${kid(board, "host")[1]}` : null),
    generatorVersion: kid(board, "generator_version")?.[1] ?? null,
    nodes: {},
    gfx: {},
    pads: { total: 0, byType: {}, byShape: {}, drill: {}, layers: {}, angle: {}, flags: {} },
    fps: { total: 0, top: 0, bottom: 0, angle: { quarter: 0, other: 0 }, attr: {}, noPads: 0, withModels: 0, locked: 0, zones: 0, groups: 0, padless: 0 },
    tracks: { segments: 0, arcs: 0, vias: 0, statusLocked: 0, viaKinds: {}, widths: {}, layers: {} },
    zones: { total: 0, kinds: {}, filled: 0, unfilled: 0, priorities: 0, multiLayer: 0, hatched: 0, polyArcs: 0, teardrop: 0, noNet: 0, vertices: 0, fillVertices: 0 },
    nets: { declared: 0, unnamed: 0, hierarchical: 0, autoUnconnected: 0, classes: 0 },
    evidence: {},
    _zoneShapes: [],
    outline: null,
    copperLayersDeclared: 0,
    copperLayersUsed: 0,
    innerUsed: [],
    boardThickness: null,
    stackup: false,
    companions: [],
  }

  // every node, by its whole path from the root: `zone>polygon>pts`, `module>pad>at`. A layer table
  // row is `(0 F.Cu signal)`: its name is the layer's number.
  {
    const stack = [[board, ""]]
    while (stack.length) {
      const [n, path] = stack.pop()
      for (let i = 1; i < n.length; i++) {
        const c = n[i]
        if (Array.isArray(c) && typeof c[0] === "string") {
          const name = /^\d+$/.test(c[0]) ? "<layer number>" : c[0]
          const next = path ? `${path}>${name}` : name
          bump(rec.nodes, next)
          stack.push([c, next])
        }
      }
    }
  }
  rec.atoms = collectAtoms(text, ATOMS, "kicad_pcb")

  // layers: copper layers are the ones typed signal, power, mixed or jumper. Their names are the
  // user's to change (KiCad 5 boards have "Front" and "Back"), so nothing here goes by ".Cu".
  const layerTable = kid(board, "layers")
  const copperNames = []
  const copperOrd = new Map()
  if (layerTable) {
    for (const l of layerTable.slice(1)) {
      if (!Array.isArray(l)) continue
      const name = l[1]
      if (typeof name === "string" && ["signal", "power", "mixed", "jumper"].includes(l[2])) {
        copperNames.push(name)
        copperOrd.set(name, Number(l[0]))
      }
    }
  }
  // Front and back are the first and the last copper row of the table, whatever they are called
  // and however the ordinals run: version 3 lists (15 Front) then (0 Back), versions 4 to 8 write
  // F.Cu 0 ... B.Cu 31, newer ones F.Cu 0 ... B.Cu 2, and in all of them the rows go front to back.
  // (Deciding by stamp is wrong: a 20240108 board writes B.Cu as 31, a 20241229 one as 2.)
  const frontName = copperNames[0] ?? "F.Cu"
  const backName = copperNames[copperNames.length - 1] ?? "B.Cu"
  copperSet = new Set(copperNames)
  const undeclared = new Set()
  const isCopper = (n) => n === "*.Cu" || n === "F&B.Cu" || copperOrd.has(n)
  rec.customCopperNames = copperNames.some((n) => !/\.Cu$/.test(n))
  rec.copperLayersDeclared = copperNames.length || (copperLayersFromGeneral(board) ?? 0)
  rec.copperLayerNames = copperNames.length
  rec.boardThickness = (() => {
    const g = kid(board, "general")
    const t = g ? kid(g, "thickness") : null
    return t ? numAt(t, 1) : null
  })()
  const setup = kid(board, "setup")
  rec.stackup = !!(setup && kid(setup, "stackup"))

  // nets
  const netName = new Map()
  for (const n of kids(board, "net")) {
    rec.nets.declared++
    const code = n[1]
    const name = n[2] ?? ""
    netName.set(code, name)
    if (/^Net-\(/.test(name) || /^\/?Net-\(/.test(name)) rec.nets.unnamed++
    if (name.startsWith("/")) rec.nets.hierarchical++
    if (/^unconnected-\(/.test(name)) rec.nets.autoUnconnected++
  }
  rec.nets.classes = kids(board, "net_class").length
  const netOf = (node) => {
    const k = kid(node, "net")
    if (!k) return null
    if (k.length >= 3) return k[2]
    return netName.get(k[1]) ?? k[1]
  }

  // outline pieces, tracks, vias, zones, footprints
  const legacyArcs = stamp !== null && stamp <= 20210925
  const pieces = []
  const gfxPieces = (node, fpPlace, arcSign) => {
    for (const c of node.slice(1)) {
      if (!Array.isArray(c)) continue
      const m = /^(gr|fp)_(.+)$/.exec(c[0] ?? "")
      if (!m || !GFX.has(m[2])) continue
      const layer = kid(c, "layer")?.[1] ?? kid(c, "layers")?.[1] ?? ""
      const cls = layerClass(layer)
      bump(rec.gfx, `${m[1] === "gr" ? "board" : "fp"}:${m[2]}@${cls}`)
      if (cls === "edge") {
        const p = edgePiece(c, m[2], fpPlace, legacyArcs, arcSign)
        if (p) pieces.push(p)
      }
    }
  }

  const copperUsed = new Set()
  const markLayers = (names) => {
    for (const n of names) {
      if (n === "*.Cu" || n === "F&B.Cu") {
        copperUsed.add(frontName)
        copperUsed.add(backName)
        if (n === "*.Cu") for (const c of copperNames) copperUsed.add(c)
      } else if (isCopper(n)) copperUsed.add(n)
      else if (/\.Cu$/.test(n) || /^Inner\d+\.Cu$/.test(n)) undeclared.add(n)
    }
  }

  // tracks and vias
  const endpoints = [] // [x, y, net]
  for (const c of board.slice(1)) {
    if (!Array.isArray(c)) continue
    switch (c[0]) {
      case "segment": {
        rec.tracks.segments++
        const layer = kid(c, "layer")?.[1] ?? ""
        bump(rec.tracks.layers, layer)
        markLayers([layer])
        const w = numAt(kid(c, "width"), 1)
        bump(rec.tracks.widths, String(w))
        if (statusLocked(c)) rec.tracks.statusLocked++
        const net = netOf(c)
        const s = xy(c, "start")
        const e = xy(c, "end")
        if (s && e) endpoints.push([s[0], s[1], net], [e[0], e[1], net])
        break
      }
      case "arc": {
        rec.tracks.arcs++
        const layer = kid(c, "layer")?.[1] ?? ""
        bump(rec.tracks.layers, layer)
        markLayers([layer])
        if (statusLocked(c)) rec.tracks.statusLocked++
        const net = netOf(c)
        const s = xy(c, "start")
        const e = xy(c, "end")
        if (s && e) endpoints.push([s[0], s[1], net], [e[0], e[1], net])
        break
      }
      case "via": {
        rec.tracks.vias++
        if (statusLocked(c)) rec.tracks.statusLocked++
        const ls = kid(c, "layers")
        const names = ls ? atoms(ls) : []
        markLayers(names)
        const type = kid(c, "type")?.[1]
        let kind = hasAtom(c, "blind") ? "blind" : hasAtom(c, "buried") ? "buried" : hasAtom(c, "micro") ? "micro" : type ?? "through"
        if (kind === "through" && names.length === 2 && !(names.includes(frontName) && names.includes(backName))) kind = "through-but-partial-span"
        bump(rec.tracks.viaKinds, kind)
        if (kid(c, "padstack")) bump(rec.tracks.viaKinds, "padstack-node")
        if (kid(c, "teardrops")) bump(rec.tracks.viaKinds, "has-teardrops")
        const a = xy(c, "at")
        if (a) endpoints.push([a[0], a[1], netOf(c)])
        break
      }
      case "zone": {
        zoneInfo(c, rec, markLayers, false)
        break
      }
      case "dimension": {
        const type = kid(c, "type")?.[1] ?? "legacy-aligned"
        bump(rec.gfx, `board:dimension:${type}@${layerClass(kid(c, "layer")?.[1] ?? "")}`)
        break
      }
      default:
        break
    }
  }

  // footprints
  const fpNodes = board.filter((n, i) => i > 0 && Array.isArray(n) && (n[0] === "footprint" || n[0] === "module"))
  const padCenters = []
  const refs = []
  for (const fp of fpNodes) {
    rec.fps.total++
    const pl = placement(fp, backName)
    pl.bottom ? rec.fps.bottom++ : rec.fps.top++
    if (pl.transformed) rec.fps.transformed = (rec.fps.transformed ?? 0) + 1
    isQuarter(pl.a) ? rec.fps.angle.quarter++ : rec.fps.angle.other++
    if (fp.includes("locked") || kid(fp, "locked")) rec.fps.locked++
    {
      // The reference designator: `(fp_text reference R1 ...)` before KiCad 6, `(property "Reference" "R1")` after.
      const refNode = kids(fp, "fp_text").find((t) => t[1] === "reference") ?? kids(fp, "property").find((t) => t[1] === "Reference")
      const ref = refNode ? refNode[2] ?? "" : ""
      refs.push(ref)
      if (ref === "") rec.fps.emptyRef = (rec.fps.emptyRef ?? 0) + 1
      else if (/\*/.test(ref)) rec.fps.starRef = (rec.fps.starRef ?? 0) + 1
    }
    const attr = kid(fp, "attr")
    for (const a of attr ? atoms(attr) : []) bump(rec.fps.attr, a)
    if (!attr) bump(rec.fps.attr, "(none)")
    if (kids(fp, "model").length) rec.fps.withModels++
    rec.fps.zones += kids(fp, "zone").length
    rec.fps.groups += kids(fp, "group").length
    for (const z of kids(fp, "zone")) zoneInfo(z, rec, markLayers, true)
    gfxPieces(fp, pl, -1)
    for (const t of kids(fp, "fp_text")) bump(rec.gfx, `fp_text:${t[1]}${t.includes("hide") || kid(t, "hide") ? "(hidden)" : ""}`)
    for (const t of kids(fp, "property")) bump(rec.gfx, `fp_property:${t[1] === "Reference" || t[1] === "Value" ? t[1] : "other"}`)
    const pads = kids(fp, "pad")
    if (!pads.length) rec.fps.padless++
    {
      const nums = pads.map((q) => q[1]).filter((v) => v !== "")
      if (new Set(nums).size < nums.length) bump(rec.pads.flags, "footprint-with-repeated-pad-numbers")
      if (pads.some((q) => q[1] === "")) bump(rec.pads.flags, "footprint-with-unnumbered-pad")
    }
    const fpPads = []
    for (const p of pads) {
      rec.pads.total++
      const type = p[2]
      const shape = p[3]
      bump(rec.pads.byType, type)
      bump(rec.pads.byShape, `${type}:${shape}`)
      const at = kid(p, "at")
      const local = at ? [numAt(at, 1), numAt(at, 2)] : [0, 0]
      const angle = at && at.length > 3 ? numAt(at, 3) : null
      const size = kid(p, "size")
      if (angle !== null && !isQuarter(angle)) bump(rec.pads.flags, "non-quarter-angle")
      if (angle !== null && !isQuarter(angle - pl.a)) bump(rec.pads.flags, "non-quarter-relative-angle")
      // what the pad's angle means: the footprint's own, nothing, or something else
      if (Math.min(mod360(pl.a), 360 - mod360(pl.a)) > 0.01) {
        const cls = angle === null ? "missing" : Math.abs(mod360(angle - pl.a)) < 0.01 || Math.abs(mod360(angle - pl.a) - 360) < 0.01 ? "equals-fp-angle" : Math.abs(mod360(angle)) < 0.01 ? "zero" : "other"
        bump(rec.pads.angle, `${rec.era}:${pl.bottom ? "bottom" : "top"}:${cls}`)
      }
      const drill = kid(p, "drill")
      if (drill) {
        const a = atoms(drill)
        const oval = a[0] === "oval"
        const offset = !!kid(drill, "offset")
        bump(rec.pads.drill, `${oval ? "oval" : "round"}${offset ? "+offset" : ""}`)
      }
      const layers = kid(p, "layers")
      const ln = layers ? atoms(layers) : []
      markLayers(ln)
      bump(rec.pads.layers, ln.join(" "))
      {
        const hasF = ln.some((n) => n === frontName || n === "*.Cu" || n === "F&B.Cu")
        const hasB = ln.some((n) => n === backName || n === "*.Cu" || n === "F&B.Cu")
        const side = hasF && hasB ? "both" : hasF ? "F" : hasB ? "B" : "none"
        if (type === "smd" && side !== "none" && side !== (pl.bottom ? "B" : "F")) bump(rec.pads.flags, "smd-on-the-other-side-of-its-footprint")
        if (type === "thru_hole" && side !== "both") bump(rec.pads.flags, `thru-hole-copper-${side}-only`)
        if (type === "smd" && side === "both") bump(rec.pads.flags, "smd-copper-both-sides")
        if (type !== "np_thru_hole" && side === "none") bump(rec.pads.flags, "no-copper-layer")
        
      }
      for (const f of ["roundrect_rratio", "chamfer", "chamfer_ratio", "rect_delta", "primitives", "options", "padstack", "thermal_bridge_width", "thermal_gap", "zone_connect", "solder_mask_margin", "solder_paste_margin", "solder_paste_margin_ratio", "clearance", "die_length", "pinfunction", "remove_unused_layers", "keep_end_layers", "zone_layer_connections", "teardrops", "drill_backdrill", "backdrill"]) {
        if (kid(p, f)) bump(rec.pads.flags, f)
      }
      if (shape === "custom") {
        const prim = kid(p, "primitives")
        for (const g of prim ? prim.slice(1).filter(Array.isArray) : []) bump(rec.pads.flags, `custom-primitive:${g[0]}`)
      }
      if (size && (numAt(size, 1) <= 0 || numAt(size, 2) <= 0)) bump(rec.pads.flags, "zero-size")
      const net = netOf(p)
      if (net) bump(rec.pads.flags, "has-net")
      padCenters.push({ net, local, bottom: pl.bottom, fp: pl, angle })
      {
        const [dx, dy] = rot(local[0], local[1], pl.a)
        fpPads.push({ x: pl.x + dx, y: pl.y + dy, a: angle ?? 0, w: numAt(size, 1), h: numAt(size, 2), shape })
      }
    }
    padAxisEvidence(fpPads, pl, rec)
  }

  {
    const seen = new Set()
    let dup = 0
    for (const r of refs) {
      if (r === "" || r.includes("*")) continue
      if (seen.has(r)) dup++
      seen.add(r)
    }
    rec.fps.duplicateRefs = dup
  }
  rec.copperLayersUsed = copperUsed.size
  rec.undeclaredCopperLayers = [...undeclared].sort()
  rec.innerUsed = [...copperUsed].filter((n) => n !== frontName && n !== backName).sort()

  // board-level graphics
  gfxPieces(board, null, -1)
  let outline = pieces.length ? outlineOf(pieces) : null
  let usedPieces = pieces
  if (outline && outline.openChains && legacyArcs && pieces.some((p) => p.kind === "arc")) {
    // Old arcs sweep clockwise on screen (positive angle, y down), which is what the sign above does; try the other one for a board that was drawn the other way.
    const flipped = []
    rec.gfx = rec.gfx // unchanged
    const redo = (node, fpPlace) => {
      for (const c of node.slice(1)) {
        if (!Array.isArray(c)) continue
        const m = /^(gr|fp)_(.+)$/.exec(c[0] ?? "")
        if (!m || !GFX.has(m[2])) continue
        const layer = kid(c, "layer")?.[1] ?? ""
        if (layerClass(layer) === "edge") {
          const p = edgePiece(c, m[2], fpPlace, legacyArcs, 1)
          if (p) flipped.push(p)
        }
      }
    }
    for (const fp of fpNodes) redo(fp, placement(fp, backName))
    redo(board, null)
    const alt = outlineOf(flipped)
    if (alt.openChains < outline.openChains) {
      outline = alt
      usedPieces = flipped
      rec.arcSignFlipped = true
    }
  }
  if (outline) {
    const biggest = outline.outer[0]
    rec.outline = {
      pieces: pieces.length,
      loops: outline.loops.length,
      outerLoops: outline.outer.length,
      cutouts: outline.cutouts,
      openChains: outline.openChains,
      repair: outline.repair,
      // closed: at least one closed loop and no chain left open after the repair. Anything else is refused.
      status: biggest && outline.openChains === 0 ? "closed" : biggest ? "open chain left" : "no closed loop",
      openChainsAt: Object.fromEntries([0.01, 0.1, 1].map((t) => [t, outlineOf(usedPieces, t).openChains])),
      shape: biggest ? biggest.shape : "open",
      // What BoardDef can hold today: one closed loop that is a rectangle, or a rectangle with four
      // equal corner radii (BoardDef.cornerRadius), and nothing cut out of it.
      representable: !!biggest && outline.outer.length === 1 && outline.cutouts === 0 && outline.openChains === 0 && (biggest.shape === "rect" || biggest.shape === "roundrect"),
      kinds: [...new Set(pieces.map((p) => p.kind))].sort(),
      cutoutShapes: outline.loops.filter((l) => !outline.outer.includes(l)).map((l) => l.shape),
      width: biggest ? +(biggest.box.maxX - biggest.box.minX).toFixed(3) : null,
      height: biggest ? +(biggest.box.maxY - biggest.box.minY).toFixed(3) : null,
    }
  } else {
    rec.outline = { pieces: 0, loops: 0, outerLoops: 0, cutouts: 0, openChains: 0, openChainsAt: { 0.01: 0, 0.1: 0, 1: 0 }, shape: "none", status: "no outline", repair: { merged: 0, dropped: 0 }, representable: false, kinds: [], cutoutShapes: [], width: null, height: null }
  }

  // How much of the board each zone covers: a copper zone with a few corners over the whole
  // board is what the editor's pour is today; anything else is not.
  {
    const ob = outline?.outer[0]?.box
    const Z = rec.zones
    Z.wholeBoardLike = 0
    Z.partial = 0
    Z.keepoutsPartial = 0
    for (const z of rec._zoneShapes) {
      const cover = ob && ob.area > 0 ? ((z.maxX - z.minX) * (z.maxY - z.minY)) / ob.area : 0
      const whole = cover >= 0.9 && z.n <= 8
      if (z.kind === "copper") whole ? Z.wholeBoardLike++ : Z.partial++
      else Z.keepoutsPartial++
    }
    delete rec._zoneShapes
  }

  // Pad frame evidence: tracks end on pad centres. Which way a footprint's angle turns its pads,
  // and what a bottom footprint does to them, is read from the board itself, not assumed.
  const byNet = new Map()
  for (const pc of padCenters) {
    if (!pc.net) continue
    if (!byNet.has(pc.net)) byNet.set(pc.net, [])
    byNet.get(pc.net).push(pc)
  }
  const variants = {
    plus: (pc) => rot(pc.local[0], pc.local[1], pc.fp.a, 1),
    minus: (pc) => rot(pc.local[0], pc.local[1], pc.fp.a, -1),
    mirrorPlus: (pc) => rot(-pc.local[0], pc.local[1], pc.fp.a, 1),
    mirrorMinus: (pc) => rot(-pc.local[0], pc.local[1], pc.fp.a, -1),
  }
  const cls = (pc) => {
    const q = mod360(pc.fp.a)
    const sym = Math.abs(q) < 0.01 || Math.abs(q - 180) < 0.01 || Math.abs(q - 360) < 0.01
    return `${pc.fp.bottom ? "bottom" : "top"}:${sym ? "angle0or180" : "turned"}`
  }
  const tol = 0.006
  const ev = {}
  for (const [x, y, net] of endpoints) {
    if (!net) continue
    for (const pc of byNet.get(net) ?? []) {
      const hits = []
      for (const [name, f] of Object.entries(variants)) {
        const [dx, dy] = f(pc)
        if (Math.abs(pc.fp.x + dx - x) < tol && Math.abs(pc.fp.y + dy - y) < tol) hits.push(name)
      }
      if (hits.length) {
        const k = cls(pc)
        ev[k] = ev[k] ?? { landed: 0 }
        ev[k].landed++
        for (const h of hits) ev[k][h] = (ev[k][h] ?? 0) + 1
        if (hits.length === 1) ev[k][`only_${hits[0]}`] = (ev[k][`only_${hits[0]}`] ?? 0) + 1
        break
      }
    }
  }
  rec.evidence = ev

  // derived counts for the summary
  rec.hasModernFootprintToken = fpNodes.some((n) => n[0] === "footprint")
  rec.hasLegacyModuleToken = fpNodes.some((n) => n[0] === "module")
  return rec
}

/** KiCad 4 and 5 lock a track with bit 0x40000 of its `status`, which KiCad 6 and later read and ignore. */
function statusLocked(node) {
  const st = kid(node, "status")
  if (!st || typeof st[1] !== "string") return false
  const v = parseInt(st[1], 16)
  return Number.isFinite(v) && (v & 0x40000) !== 0
}

/**
 * Which way a pad's long side lies, to tell what the stored angle means: on a pad longer than
 * twice its width in a footprint of at least four pads, the long side is across the row the pad is
 * in, so it is perpendicular to the line to the nearest other pad. Three readings of the stored
 * angle are tried (it is the board angle; it is relative to the footprint; it is minus relative)
 * on footprints turned off 0 and 180, where they differ.
 */
function padAxisEvidence(list, pl, rec) {
  const q = mod360(pl.a)
  if (Math.abs(q) < 0.01 || Math.abs(q - 180) < 0.01 || Math.abs(q - 360) < 0.01) return
  if (list.length < 4 || list.length > 300) return
  const key = pl.bottom ? "bottom" : "top"
  for (const p of list) {
    if (!["rect", "oval", "roundrect"].includes(p.shape)) continue
    const long = Math.max(p.w, p.h)
    const short = Math.min(p.w, p.h)
    if (short <= 0 || long < 1.8 * short) continue
    let best = null
    for (const o of list) {
      if (o === p) continue
      const d = Math.hypot(o.x - p.x, o.y - p.y)
      if (d > 0.05 && (!best || d < best.d)) best = { d, dx: (o.x - p.x) / d, dy: (o.y - p.y) / d }
    }
    if (!best) continue
    const ev = (rec.padAxis ??= {})
    const e = (ev[key] ??= { pads: 0, board: 0, relative: 0, minusRelative: 0 })
    e.pads++
    const across = (alpha) => {
      const [vx, vy] = p.w >= p.h ? rot(1, 0, alpha) : rot(0, 1, alpha)
      return Math.abs(vx * best.dx + vy * best.dy) < 0.2
    }
    if (across(p.a)) e.board++
    if (across(p.a + pl.a)) e.relative++
    if (across(p.a - pl.a)) e.minusRelative++
  }
}

function copperLayersFromGeneral(board) {
  const g = kid(board, "general")
  const l = g ? kid(g, "layers") : null
  return l ? numAt(l, 1, null) : null
}

function zoneInfo(z, rec, markLayers, inFootprint) {
  const Z = rec.zones
  Z.total++
  const keepout = kid(z, "keepout")
  const placementArea = kid(z, "placement")
  const teardrop = kid(z, "teardrop")
  let kind
  if (placementArea) kind = "placement-rule-area"
  else if (keepout) {
    const restricted = ["tracks", "vias", "pads", "copperpour", "footprints"].some((k) => kid(keepout, k)?.[1] === "not_allowed")
    kind = restricted ? "keepout" : "rule-area"
    if (restricted) bump(Z.kinds, `keepout:${["tracks", "vias", "pads", "copperpour", "footprints"].filter((k) => kid(keepout, k)?.[1] === "not_allowed").join("+")}`)
  } else if (teardrop) kind = "teardrop"
  else kind = "copper"
  if (inFootprint) kind = `fp-${kind}`
  bump(Z.kinds, kind)
  const layers = kid(z, "layers")
  const layer = kid(z, "layer")
  const names = layers ? atoms(layers) : layer ? [layer[1]] : []
  markLayers(names)
  if (names.length > 1 || names.some((n) => n === "*.Cu" || n === "F&B.Cu")) Z.multiLayer++
  const pri = kid(z, "priority")
  if (pri && numAt(pri, 1) > 0) Z.priorities++
  const hatch = kid(z, "hatch")
  if (hatch && hatch[1] !== "none") bump(Z.kinds, `outline-hatch:${hatch[1]}`)
  const fill = kid(z, "fill")
  const fillMode = fill ? kid(fill, "mode")?.[1] : null
  if (fillMode === "hatch") Z.hatched++
  const filled = kids(z, "filled_polygon")
  const isFilled = filled.length > 0
  if (kind === "copper" || kind === "fp-copper") isFilled ? Z.filled++ : Z.unfilled++
  for (const f of filled) Z.fillVertices += kids(kid(f, "pts"), "xy").length
  const poly = kid(z, "polygon")
  const pts = poly ? kid(poly, "pts") : null
  if (pts && !inFootprint && (kind === "copper" || kind === "keepout")) {
    const xs = kids(pts, "xy").map((p) => [numAt(p, 1), numAt(p, 2)])
    if (xs.length) rec._zoneShapes.push({ kind, n: xs.length, minX: Math.min(...xs.map((p) => p[0])), maxX: Math.max(...xs.map((p) => p[0])), minY: Math.min(...xs.map((p) => p[1])), maxY: Math.max(...xs.map((p) => p[1])), layers: names.length })
  }
  if (pts) {
    Z.vertices += kids(pts, "xy").length
    if (kids(pts, "arc").length) Z.polyArcs++
  }
  if (teardrop) Z.teardrop++
  if (!kid(z, "net") || numAt(kid(z, "net"), 1, 0) === 0) {
    if (kind === "copper" || kind === "fp-copper") Z.noNet++
  }
  const conn = kid(z, "connect_pads")
  bump(Z.kinds, `connect:${conn ? (atoms(conn)[0] ?? "thermal") : "default"}`)
  if (kid(z, "island")) bump(Z.kinds, "island-flag")
  if (kid(z, "smoothing")) bump(Z.kinds, `smoothing:${kid(z, "smoothing")[1]}`)
  if (kid(z, "locked")) bump(Z.kinds, "locked")
  if (kid(z, "name")) bump(Z.kinds, "named")
}

// ---------- the run ----------

mkdirSync(outDir, { recursive: true })
const all = walk(root)
const boards = []
const failures = []
const dirCache = new Map()
const filesIn = (d) => dirCache.get(d) ?? (dirCache.set(d, readdirSync(d)), dirCache.get(d))
const t0 = Date.now()
for (const f of all) {
  if (!f.endsWith(".kicad_pcb")) continue
  const rel = relative(root, f).split(sep).join("/")
  const size = statSync(f).size
  try {
    const text = readFileSync(f, "utf8")
    const rec = censusBoard(text, rel, size)
    rec.group = groupOf(rel)
    const dir = dirname(f)
    const base = basename(f, ".kicad_pcb")
    const sib = filesIn(dir)
    rec.companions = sib.filter((n) => /\.(kicad_pro|kicad_sch|sch|pro|kicad_dru|net)$|-cache\.lib$|^(fp|sym)-lib-table$/.test(n)).map((n) => (n.startsWith(base) ? n.slice(base.length) || n : n))
    if (rec.group === "pcbench") {
      try {
        const meta = JSON.parse(readFileSync(join(dir, "metadata.json"), "utf8"))
        rec.pcbenchMeta = { cad: meta["CAD version"], layers: meta.layers, licenses: meta.licenses ?? null, source: meta.source ?? null }
      } catch {}
    }
    boards.push(rec)
  } catch (e) {
    failures.push({ file: rel, size, error: String(e.message ?? e).slice(0, 200) })
  }
}
writeFileSync(join(outDir, "boards.json"), JSON.stringify(boards))
writeFileSync(join(outDir, "failures.json"), JSON.stringify(failures, null, 1))
console.log(`${boards.length} boards, ${failures.length} failed to read, ${((Date.now() - t0) / 1000).toFixed(1)} s`)
