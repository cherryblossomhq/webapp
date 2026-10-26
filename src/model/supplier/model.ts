import type { SupplierLand, SupplierModel3D, SupplierPart } from "@cherryblossom/api-contract"
import { getFootprint } from "../footprints"
import { supplierModel } from "../models3d"
import type { Model3D, Vec2 } from "../types"

// The supplier's 3D model of a part, on the footprint a component actually uses. The supplier
// places its model on its own land; a part built on the footprinter's 0603, or on a land the
// copilot drew and the supplier's pads were checked against, sits on pads that are the same but
// may be numbered from another corner or turned a quarter. The model has to follow the pads.

/** Pads by number, a number drawn as several pads (a shield) taken at their middle. */
function padsByNumber(pads: { number: string | null; x: number; y: number }[]): Map<string, Vec2> {
  const sums = new Map<string, { x: number; y: number; n: number }>()
  for (const p of pads) {
    if (!p.number) continue
    const s = sums.get(p.number) ?? { x: 0, y: 0, n: 0 }
    s.x += p.x
    s.y += p.y
    s.n++
    sums.set(p.number, s)
  }
  return new Map([...sums].map(([k, s]) => [k, { x: s.x / s.n, y: s.y / s.n }]))
}

const turn = (p: Vec2, q: number): Vec2 => (q === 1 ? { x: -p.y, y: p.x } : q === 2 ? { x: -p.x, y: -p.y } : q === 3 ? { x: p.y, y: -p.x } : p)

/** How far apart two lands' matching pads may be and still be one land (mm). */
const LAND_TOLERANCE = 0.15

/**
 * The quarter turn and move that put one land's pads on another's, number by number, or null when
 * no quarter turn does (another package, or pads numbered the other way round).
 */
export function landTransform(from: { number: string | null; x: number; y: number }[], to: { number: string | null; x: number; y: number }[]): { quarter: number; dx: number; dy: number } | null {
  const a = padsByNumber(from)
  const b = padsByNumber(to)
  const pairs = [...a].filter(([k]) => b.has(k)).map(([k, p]) => [p, b.get(k)!] as const)
  if (pairs.length < 2 || pairs.length !== a.size || pairs.length !== b.size) return null
  const spread = Math.max(...pairs.map(([p]) => Math.hypot(p.x - pairs[0][0].x, p.y - pairs[0][0].y)))
  if (spread < 1e-3) return null
  const mean = (pts: Vec2[]) => ({ x: pts.reduce((s, p) => s + p.x, 0) / pts.length, y: pts.reduce((s, p) => s + p.y, 0) / pts.length })
  const target = mean(pairs.map(([, q]) => q))
  let best: { quarter: number; dx: number; dy: number; error: number } | null = null
  for (let q = 0; q < 4; q++) {
    const turned = pairs.map(([p]) => turn(p, q))
    const c = mean(turned)
    const dx = target.x - c.x
    const dy = target.y - c.y
    const error = Math.max(...turned.map((p, i) => Math.hypot(p.x + dx - pairs[i][1].x, p.y + dy - pairs[i][1].y)))
    if (!best || error < best.error) best = { quarter: q, dx, dy, error }
  }
  return best && best.error <= LAND_TOLERANCE ? { quarter: best.quarter, dx: best.dx, dy: best.dy } : null
}

/** A model moved with its land: turned by quarter turns about the land's origin, then moved. */
export function moveModel(m: Model3D, t: { quarter: number; dx: number; dy: number }): Model3D {
  const o = turn({ x: m.offset.x, y: m.offset.y }, t.quarter)
  const round = (v: number) => Math.round(v * 1e4) / 1e4
  return {
    ...m,
    offset: { x: round(o.x + t.dx), y: round(o.y + t.dy), z: m.offset.z },
    rotation: { ...m.rotation, z: (((m.rotation.z + t.quarter * 90) % 360) + 360) % 360 },
  }
}

/** A supplier's model, placed on its own `land`, moved onto `footprint`; null when it has no pads or the footprint isn't that land. */
export function supplierModelOnLand(model3d: SupplierModel3D, land: SupplierLand | null, attribution: string | undefined, footprint: string): Model3D | null {
  if (!land?.pads.length) return null
  const model = supplierModel(model3d, attribution)
  const vendor = land.pads.map((p) => ({ number: p.number || null, x: p.x, y: p.y }))
  const mine = getFootprint(footprint).pads.map((p) => ({ number: p.pin, x: p.x, y: p.y }))
  const t = landTransform(vendor, mine)
  if (!t) return null
  return t.quarter === 0 && Math.abs(t.dx) < 1e-4 && Math.abs(t.dy) < 1e-4 ? model : moveModel(model, t)
}

/** The supplier's model of a part placed on `footprint`, or null when it has none or the footprint isn't its land. */
export function supplierModelOn(part: SupplierPart, footprint: string): Model3D | null {
  return part.model3d ? supplierModelOnLand(part.model3d, part.land, part.provenance.attribution, footprint) : null
}
