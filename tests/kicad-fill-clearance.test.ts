import { describe, expect, it } from "vitest"
import { computeConnectivity } from "../src/model/connectivity"
import { npthFlashes, pcbPads } from "../src/model/instances"
import { importKicadBoard } from "../src/model/kicad/board"
import { zoneFillsOf } from "../src/model/pcb"
import type { Project, Vec2 } from "../src/model/types"
import { board, footprint, pad } from "./kicad-board-fixtures"

// A pour the editor fills on a board from KiCad is written into the KiCad file the export makes, so KiCad's DRC reads it: none of its copper may be nearer
// another net's track, or a non-plated pad with copper, than the clearance. A board's two ground pours, filled again after one part moved, were 0.5068 mm
// from tracks under a 0.508 mm clearance (the round ends cut inside the true curve) and 0.255 mm from two oval mounting holes on round drills, which KiCad
// gives copper (`PAD::FlashLayer`): 210 errors in KiCad's DRC where the board had none.

const CLEARANCE = 0.508

function project(): Project {
  const text = board({
    nets: ['(net 0 "")', '(net 1 "GND")', '(net 2 "SIG")'],
    body: [
      footprint({ ref: "R1", at: "2 8", pads: [pad({ number: "1", at: "0 0", net: '(net 1 "GND")' })] }),
      footprint({ name: "MountingHole:Hole", ref: "H1", at: "15 5", pads: [pad({ number: "", type: "np_thru_hole", shape: "oval", at: "0 0", size: "1.8 1.8", layers: '"*.Cu" "*.Mask"', extra: "(drill 1.8)" })] }),
      '(segment (start 4 2.5) (end 9.3 7.1) (width 0.25) (layer "F.Cu") (net 2) (uuid "00000000-0000-4000-8000-000000000001"))',
      `(zone (net 1) (net_name "GND") (layer "F.Cu") (uuid "00000000-0000-4000-8000-000000000002") (hatch edge 0.5) (connect_pads (clearance ${CLEARANCE})) (min_thickness 0.25) (filled_areas_thickness no) (fill yes (thermal_gap 0.5) (thermal_bridge_width 0.5)) (polygon (pts (xy 0.5 0.5) (xy 19.5 0.5) (xy 19.5 9.5) (xy 0.5 9.5))))`,
    ],
  })
  const r = importKicadBoard(text)
  if (r.status !== "imported") throw new Error(`${r.status}: ${r.message}`)
  return r.project
}

function pointToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1)))
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy))
}

/** The fill's edges, as segments. */
function edges(p: Project): [Vec2, Vec2][] {
  const fill = zoneFillsOf(p, () => computeConnectivity(p)).find((f) => f.layer === "top")!
  expect(fill.polygons.length).toBeGreaterThan(0)
  return fill.polygons.flatMap((poly) => poly.flatMap((ring) => ring.map((a, i) => [a, ring[(i + 1) % ring.length]] as [Vec2, Vec2])))
}

describe("a pour filled on a board from KiCad keeps KiCad's clearances", () => {
  it("from another net's track, round ends included", () => {
    const p = project()
    const t = p.traces[0]
    const [a, b] = [t.points[0], t.points[t.points.length - 1]]
    // Segments that do not cross are nearest at an end of one of them.
    const near = Math.min(...edges(p).map(([c, d]) => Math.min(pointToSegment(c, a, b), pointToSegment(d, a, b), pointToSegment(a, c, d), pointToSegment(b, c, d))))
    expect(near - t.width / 2).toBeGreaterThanOrEqual(CLEARANCE)
  })

  it("from a non-plated oval pad on a round drill, which has copper: the pour's clearance, not the hole's", () => {
    const p = project()
    const hole = pcbPads(p.components.find((c) => c.ref === "H1")!)[0]
    expect(npthFlashes(hole)).toBe(true)
    const near = Math.min(...edges(p).map(([c, d]) => pointToSegment(hole, c, d)))
    expect(near - hole.width / 2).toBeGreaterThanOrEqual(CLEARANCE)
  })
})

describe("which non-plated pads have copper (KiCad's PAD::FlashLayer)", () => {
  const base = { x: 0, y: 0, holeDiameter: 1.8 }
  it("a bare drill: a round pad no bigger than its round hole, an oval one no bigger than its slot", () => {
    expect(npthFlashes({ ...base, shape: "circle", width: 1.8, height: 1.8 })).toBe(false)
    expect(npthFlashes({ ...base, shape: "pill", width: 3, height: 1.8, slotLength: 3 })).toBe(false)
  })
  it("copper: a bigger pad, a round oval on a round drill, any other shape, a hole off its centre", () => {
    expect(npthFlashes({ ...base, shape: "circle", width: 2.5, height: 2.5 })).toBe(true)
    expect(npthFlashes({ ...base, shape: "pill", width: 1.8, height: 1.8 })).toBe(true)
    expect(npthFlashes({ ...base, shape: "rect", width: 1.8, height: 1.8 })).toBe(true)
    expect(npthFlashes({ ...base, shape: "circle", width: 1.8, height: 1.8, hole: { x: 0.2, y: 0 } })).toBe(true)
  })
})
