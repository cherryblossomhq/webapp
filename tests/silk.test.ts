import { describe, expect, it } from "vitest"
import { boxesOverlap } from "../src/lib/geometry"
import { pcbPads } from "../src/model/instances"
import { placeDesignators } from "../src/model/silk"
import { TEMPLATES } from "../src/model/templates"
import { built } from "./built"

describe("designators", () => {
  it.each(TEMPLATES.map((t) => t.id))("%s: every part's designator is clear of pads, the edge and the others", (id) => {
    const p = built(id)
    const placed = placeDesignators(p)
    const parts = p.components.filter((c) => pcbPads(c).length > 0)
    expect([...placed.keys()].sort()).toEqual(parts.map((c) => c.id).sort())
    const all = [...placed.values()]
    const b = p.board
    for (const d of all) {
      expect(d.box.minX).toBeGreaterThanOrEqual(b.x - b.width / 2)
      expect(d.box.maxX).toBeLessThanOrEqual(b.x + b.width / 2)
      expect(d.box.minY).toBeGreaterThanOrEqual(b.y - b.height / 2)
      expect(d.box.maxY).toBeLessThanOrEqual(b.y + b.height / 2)
      for (const c of parts) {
        for (const pad of pcbPads(c)) {
          const box = { minX: pad.x - pad.width / 2, maxX: pad.x + pad.width / 2, minY: pad.y - pad.height / 2, maxY: pad.y + pad.height / 2 }
          expect(boxesOverlap(box, d.box), `${d.text} on a pad of ${c.ref}`).toBe(false)
        }
      }
      for (const o of all) if (o !== d && o.side === d.side) expect(boxesOverlap(o.box, d.box), `${d.text} on ${o.text}`).toBe(false)
    }
  })

  it("turns the designator of an upright part to run beside it", () => {
    const p = built("esp32-robot")
    const r6 = p.components.find((c) => c.ref === "R6")!
    expect(r6.pcb.rot).toBe(270)
    expect(placeDesignators(p).get(r6.id)!.rot).toBe(90)
  })
})
