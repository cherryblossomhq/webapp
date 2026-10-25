import { uid } from "../lib/id"
import { pointInBox, pointSegmentDistance, round, type Box } from "../lib/geometry"
import { computeConnectivity } from "./connectivity"
import { classIndex, classValues } from "./netClasses"
import { boardTextStrokes, ownTexts } from "./board"
import { textsOnLayer } from "./texts"
import { pcbCourtyard, pcbSilk } from "./instances"
import type { AutorouteResult } from "./autoroute"
import { analyzePcb, pointPadDistance } from "./pcb"
import { fillTester } from "./pour"
import { placeDesignators } from "./silk"
import type { BoardDef, Project, Vec2, Via } from "./types"

export const DEFAULT_STITCH_PITCH = 4

/** Via grid pitches (mm) offered in the inspector. */
export const STITCH_PITCHES = [3, 4, 6, 8]

/** Grid pitch for a board: 4 mm on small boards, opening up to 8 mm on large ones, always one of STITCH_PITCHES. */
export const stitchPitch = (b: BoardDef) => {
  const ideal = Math.sqrt(b.width * b.height) / 12
  return STITCH_PITCHES.filter((p) => p >= DEFAULT_STITCH_PITCH).reduce((best, p) => (Math.abs(p - ideal) < Math.abs(best - ideal) ? p : best))
}

/** Pour copper kept around a stitching via, beyond its own radius. */
const RING = 0.2
const SAMPLES = 12
/** Search step inside a pour island for a via that joins it to the other layer. */
const ISLAND_STEP = 0.25
const ISLAND_SAMPLES = 6000
/**
 * An island-saving via only needs its middle in both pours: the pours are refilled around it
 * as same-net copper, so a strip narrower than the via still joins it.
 */
const ISLAND_RING = 0.1

/**
 * Tie the top and bottom pours of `net` together with vias on a regular grid, wherever both
 * pours are solid around the via and it stays clear of pads, traces, part bodies and
 * silkscreen. Pour islands the grid misses get a via of their own when one fits, so they
 * stay instead of being removed as floating copper. Earlier stitching vias of the net are
 * replaced.
 */
export function stitchVias(project: Project, net: string, pitch = stitchPitch(project.board)): { project: Project; added: number } {
  const base: Project = { ...project, vias: project.vias.filter((v) => v.net !== net) }
  const sch = computeConnectivity(base)
  // Plan against every pour region, including ones only the new vias will connect.
  const pcb = analyzePcb(base, sch, { keepIslands: true })
  const testers = (layer: "top" | "bottom") =>
    pcb.zoneFills.filter((f) => f.layer === layer && f.netName === net).flatMap((f) => f.polygons.map(fillTester))
  const top = testers("top")
  const bottom = testers("bottom")
  if (!top.length || !bottom.length) return { project: base, added: 0 }

  // The via is its net's class's size, and keeps the larger of its class's clearance and the other copper's from that copper (a board with no classes: the rules').
  const { viaDiameter, viaDrill } = classValues(base.rules, net)
  const index = classIndex(base.rules)
  const clearance = index.clearanceOf(net)
  const netNames = new Map(sch.nets.map((n) => [n.id, n.name]))
  const gapTo = (netId: string | null | undefined) => index.pair(net, netId ? (netNames.get(netId) ?? null) : null)
  const r = viaDiameter / 2
  const ring = r + RING
  const pads = pcb.items.flatMap((it) => (it.kind === "pad" ? [{ pad: it.pad, keep: r + gapTo(it.netId) }] : []))
  const segments = pcb.items.flatMap((it) => (it.kind === "segment" ? [{ ...it, keep: r + gapTo(pcb.islandNet.get(pcb.island.get(it.id)!)) }] : []))
  // The grid stays off part bodies; no via goes through designators, board text or part
  // outlines, so the silkscreen is not broken up by drill holes.
  const bodies = base.components.flatMap((c) => {
    const cy = c.pcb.placed ? pcbCourtyard(c) : null
    return cy ? [cy] : []
  })
  const silk: Box[] = []
  for (const d of placeDesignators(base).values()) {
    silk.push({ minX: d.box.minX - r, maxX: d.box.maxX + r, minY: d.box.minY - r, maxY: d.box.maxY + r })
  }
  const outlines = base.components.flatMap((c) => (c.pcb.placed ? pcbSilk(c).flatMap((path) => path.slice(1).map((b, i) => [path[i], b] as const)) : []))
  for (const side of ["F.SilkS", "B.SilkS"]) for (const t of textsOnLayer(base, side)) silk.push({ minX: t.box.minX - r, maxX: t.box.maxX + r, minY: t.box.minY - r, maxY: t.box.maxY + r })
  for (const t of ownTexts(base)) {
    const pts = boardTextStrokes(t).flat()
    if (!pts.length) continue
    silk.push({
      minX: Math.min(...pts.map((p) => p.x)) - r,
      maxX: Math.max(...pts.map((p) => p.x)) + r,
      minY: Math.min(...pts.map((p) => p.y)) - r,
      maxY: Math.max(...pts.map((p) => p.y)) + r,
    })
  }
  const others = base.vias.map((v) => ({ at: { x: v.x, y: v.y }, r: v.diameter / 2, keep: r + gapTo(pcb.viaNet.get(v.id)) }))

  const solid = (p: Vec2, around = ring) => {
    for (let i = 0; i <= SAMPLES; i++) {
      const a = (i / SAMPLES) * Math.PI * 2
      const q = i === SAMPLES ? p : { x: p.x + Math.cos(a) * around, y: p.y + Math.sin(a) * around }
      if (!top.some((t) => t(q)) || !bottom.some((t) => t(q))) return false
    }
    return true
  }
  // Under a part only where nothing else fits: a via that saves a pour island.
  const clear = (p: Vec2, underParts = false) =>
    (underParts ? outlines.every(([a, b]) => pointSegmentDistance(p, a, b) >= r + 0.1) : !bodies.some((b) => pointInBox(p, b))) &&
    !silk.some((b) => pointInBox(p, b)) &&
    pads.every((o) => pointPadDistance(p, o.pad) >= o.keep) &&
    segments.every((s) => pointSegmentDistance(p, s.a, s.b) >= s.keep + s.width / 2) &&
    others.every((o) => Math.hypot(p.x - o.at.x, p.y - o.at.y) >= o.r + o.keep)

  // Grid centred on the board so the pattern sits symmetrically.
  const b = base.board
  const nx = Math.floor(b.width / pitch)
  const ny = Math.floor(b.height / pitch)
  const x0 = b.x - ((nx - 1) * pitch) / 2
  const y0 = b.y - ((ny - 1) * pitch) / 2
  let added: Via[] = []
  for (let iy = 0; iy < ny; iy++) {
    for (let ix = 0; ix < nx; ix++) {
      const p = { x: round(x0 + ix * pitch, 3), y: round(y0 + iy * pitch, 3) }
      if (!clear(p) || !solid(p)) continue
      added.push({ id: uid("v"), x: p.x, y: p.y, diameter: viaDiameter, drill: viaDrill, net })
    }
  }
  const netId = sch.nets.find((n) => n.name === net)?.id
  added.push(...islandVias({ ...base, vias: [...base.vias, ...added] }, net, netId, (p) => clear(p, true) && solid(p, ISLAND_RING) && added.every((v) => Math.hypot(p.x - v.x, p.y - v.y) >= viaDiameter + clearance)))
  // Vias that only join pour islands no pin reaches would leave floating copper; drop them
  // until every remaining via sits on the real net.
  for (let pass = 0; pass < 3 && added.length; pass++) {
    const check = analyzePcb({ ...base, vias: [...base.vias, ...added] }, sch)
    const kept = added.filter((v) => check.viaNet.get(v.id) === netId)
    if (kept.length === added.length) break
    added = kept
  }
  return { project: { ...base, vias: [...base.vias, ...added], updatedAt: Date.now() }, added: added.length }
}

/**
 * One via for each pour island of `net` that isn't connected to the net yet, at the free spot
 * nearest the island's middle. Islands with no such spot are left to be removed.
 */
function islandVias(project: Project, net: string, netId: string | undefined, fits: (p: Vec2) => boolean): Via[] {
  if (!netId) return []
  const pcb = analyzePcb(project, computeConnectivity(project), { keepIslands: true })
  const zones = new Set(project.zones.filter((z) => z.net === net).map((z) => z.id))
  const { viaDiameter, viaDrill } = classValues(project.rules, net)
  const out: Via[] = []
  const zoneItems = pcb.items.flatMap((it) => (it.kind === "zone" && zones.has(it.zoneId) ? [it] : []))
  const onNet = (it: (typeof zoneItems)[number]) => pcb.islandNet.get(pcb.island.get(it.id)!) === netId
  // Copper of the other layer that already reaches the net, where a via saves the island.
  const linked = zoneItems.filter(onNet)
  const linkedAt = (layer: string, p: Vec2) => linked.some((z) => z.layers[0] === layer && pointInBox(p, z.box) && z.contains(p))
  for (const it of zoneItems) {
    if (onNet(it)) continue
    const other = it.layers[0] === "top" ? "bottom" : "top"
    const b = it.box
    const w = b.maxX - b.minX
    const h = b.maxY - b.minY
    const step = Math.max(ISLAND_STEP, Math.sqrt((w * h) / ISLAND_SAMPLES))
    const mid = { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 }
    const spots: Vec2[] = []
    for (let y = b.minY + step / 2; y < b.maxY; y += step) {
      for (let x = b.minX + step / 2; x < b.maxX; x += step) {
        const p = { x: round(x, 3), y: round(y, 3) }
        if (it.contains(p)) spots.push(p)
      }
    }
    spots.sort((p, q) => Math.hypot(p.x - mid.x, p.y - mid.y) - Math.hypot(q.x - mid.x, q.y - mid.y))
    const free = (p: Vec2) => fits(p) && out.every((v) => Math.hypot(p.x - v.x, p.y - v.y) >= viaDiameter * 2)
    // Over connected copper if possible; otherwise into another island that may get saved.
    const at = spots.find((p) => linkedAt(other, p) && free(p)) ?? spots.find(free)
    if (at) out.push({ id: uid("v"), x: at.x, y: at.y, diameter: viaDiameter, drill: viaDrill, net })
  }
  return out
}

export function removeStitching(project: Project, net: string): Project {
  return { ...project, vias: project.vias.filter((v) => v.net !== net), updatedAt: Date.now() }
}

export const stitchCount = (project: Project, net: string) => project.vias.filter((v) => v.net === net).length

/**
 * Route with the pours' stitching vias out of the way, then stitch the pours again around the new
 * copper. Left in, the vias are obstacles in the channels between parts, and a board that routes
 * fully without them can come out a connection short; a grid fitted after routing never blocks a
 * trace. Nothing changes when the router adds nothing. Locked stitching vias stay where they are.
 */
export function routeAroundStitching(project: Project, route: (p: Project) => AutorouteResult): AutorouteResult {
  const nets = new Set(project.vias.filter((v) => v.net && !v.locked).map((v) => v.net!))
  if (!nets.size) return route(project)
  const res = route({ ...project, vias: project.vias.filter((v) => !(v.net && nets.has(v.net) && !v.locked)) })
  if (!res.addedTraces && !res.addedVias) return { ...res, project }
  let next = res.project
  for (const net of nets) if (next.zones.some((z) => z.net === net)) next = stitchVias(next, net).project
  return { ...res, project: next }
}
