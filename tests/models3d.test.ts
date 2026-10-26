import { describe, expect, it } from "vitest"
import { makeBuilder, ModelMaterials } from "../src/editor/three/models"
import { getFootprint } from "../src/model/footprints"
import { PARTS } from "../src/model/library"
import type { ComponentInstance } from "../src/model/types"

const cases = PARTS.filter((p) => p.footprints.length).flatMap((p) => p.footprints.map((f) => [p.id, f, p] as const))

describe("3D part models", () => {
  it.each(cases)("%s on %s builds finite geometry", (_, footprint, part) => {
    const fp = getFootprint(footprint)
    const component: ComponentInstance = {
      id: "c1",
      partId: part.id,
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
    expect(spec.geoms.size).toBeGreaterThan(0)
    for (const [key, g] of spec.geoms) {
      g.computeBoundingBox()
      const b = g.boundingBox!
      for (const v of [b.min.x, b.min.y, b.min.z, b.max.x, b.max.y, b.max.z]) expect(Number.isFinite(v), `${key} bounds`).toBe(true)
      // Nothing floats far off the footprint.
      expect(b.min.x, key).toBeGreaterThan(fp.courtyard.minX - 8)
      expect(b.max.x, key).toBeLessThan(fp.courtyard.maxX + 8)
      expect(b.min.y, key).toBeGreaterThan(fp.courtyard.minY - 8)
      expect(b.max.y, key).toBeLessThan(fp.courtyard.maxY + 8)
      g.dispose()
    }
  })
})
