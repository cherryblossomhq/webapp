import { createHash } from "node:crypto"
import { makeBuilder, ModelMaterials } from "../src/editor/three/models"
import { getFootprint } from "../src/model/footprints"
import { PARTS } from "../src/model/library"
import type { ComponentInstance } from "../src/model/types"

// What the 3D view draws for each library part on each of its footprints, as a short signature:
// the whole body's size and a hash of every piece's bounds and vertex count. The library's own
// footprint strings carry no package name, so these must not change when bodies are read from
// package names (`library-models.test.ts` holds the signatures from before that was added).

export interface BodySignature {
  /** Width, length and height of everything drawn, in millimetres. */
  size: [number, number, number]
  pieces: number
  hash: string
}

const r = (v: number) => Math.round(v * 1000) / 1000

export function bodySignature(partId: string, footprint: string): BodySignature {
  const part = PARTS.find((p) => p.id === partId)!
  const fp = getFootprint(footprint)
  const component: ComponentInstance = {
    id: "c1",
    partId,
    ref: "U1",
    props: { ...part.defaultProps },
    footprint,
    sch: { x: 0, y: 0, rot: 0 },
    pcb: { x: 0, y: 0, rot: 0, side: "top", placed: true },
  }
  const spec = makeBuilder({
    component,
    part,
    footprint,
    pads: fp.pads.filter((p) => p.plated !== false),
    holes: fp.pads.filter((p) => p.plated === false),
    courtyard: fp.courtyard,
    boardThickness: 1.6,
    materials: new ModelMaterials(),
  }).build()
  const lo = [Infinity, Infinity, Infinity]
  const hi = [-Infinity, -Infinity, -Infinity]
  const parts: string[] = []
  for (const key of [...spec.geoms.keys()].sort()) {
    const g = spec.geoms.get(key)!
    g.computeBoundingBox()
    const b = g.boundingBox!
    const min = [b.min.x, b.min.y, b.min.z]
    const max = [b.max.x, b.max.y, b.max.z]
    for (let i = 0; i < 3; i++) (lo[i] = Math.min(lo[i], min[i])), (hi[i] = Math.max(hi[i], max[i]))
    parts.push(`${key}:${g.getAttribute("position").count}:${[...min, ...max].map(r).join(",")}`)
  }
  for (const m of spec.markings) parts.push(`mark:${m.lines.join("/")}:${r(m.x)},${r(m.y)},${r(m.z)}:${r(m.width)}x${r(m.height)}`)
  return {
    size: [r(hi[0] - lo[0]), r(hi[1] - lo[1]), r(hi[2] - lo[2])],
    pieces: spec.geoms.size,
    hash: createHash("sha1").update(parts.join("\n")).digest("hex").slice(0, 12),
  }
}

export const libraryCases = PARTS.filter((p) => p.footprints.length).flatMap((p) => p.footprints.map((f) => [p.id, f] as const))
