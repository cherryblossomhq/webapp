import { describe, expect, it } from "vitest"
import { circleD, fadedPaths, mergedPaths, padPaths, roundRectD } from "../src/editor/pcb/boardPaths"
import { hitShape, pointShapeInkDistance, shapeShown, type ShapeVisibility } from "../src/editor/pcb/shapeEditing"
import { hitText, textBox, textShownOnScreen } from "../src/editor/pcb/textEditing"
import { CellGrid } from "../src/lib/cellGrid"
import { computeConnectivity } from "../src/model/connectivity"
import { EXTENSION_NAMES, importKicadBoard } from "../src/model/kicad/board"
import { analyzePcb, openingAnalysis } from "../src/model/pcb"
import { pcbCourtyard, type WorldPad } from "../src/model/instances"
import { shapeInkBox } from "../src/model/shapes"
import { worldShapes } from "../src/model/shapeItems"
import { textLayerKind, worldTexts } from "../src/model/texts"
import type { Project } from "../src/model/types"
import { board, footprint, pad } from "./kicad-board-fixtures"
import { rectangle, twoResistors, withZone } from "./zones-fixtures"

// What keeps a big board quick (CERN's Macbeth: 1,566 parts, 5,798 tracks, 5,215 vias): picking by a grid, the copper drawn as few paths, the
// board opened before its connections are found, and a pour with no fill yet leaving its net's connections out rather than counting them all.

/** A KiCad board of 48 parts, each with its texts on the silkscreen and fabrication layers and drawings on those and its courtyard, and board text and lines. */
function textBoard(): Project {
  const parts: string[] = []
  for (let i = 0; i < 48; i++) {
    const at = `${5 + (i % 8) * 7} ${5 + Math.floor(i / 8) * 6}`
    parts.push(
      footprint({
        ref: `R${i + 1}`,
        at: i % 3 ? at : `${at} 90`,
        layer: i % 5 ? "F.Cu" : "B.Cu",
        pads: [pad({ number: "1", at: "-0.8 0" }), pad({ number: "2", at: "0.8 0" })],
        extra:
          '(fp_line (start -1.2 -0.6) (end 1.2 -0.6) (stroke (width 0.1) (type solid)) (layer "F.Fab")) (fp_circle (center 0 0) (end 0.3 0) (stroke (width 0.12) (type solid)) (fill none) (layer "F.SilkS")) (fp_rect (start -1.6 -1) (end 1.6 1) (stroke (width 0.05) (type default)) (fill none) (layer "F.CrtYd"))',
      }),
    )
  }
  const notes = Array.from({ length: 12 }, (_, i) => `(gr_text "NOTE ${i}" (at ${4 + i * 4.5} 42) (layer "F.SilkS") (effects (font (size 1 1) (thickness 0.15))))`)
  const lines = Array.from({ length: 12 }, (_, i) => `(gr_line (start ${i * 5} 44) (end ${i * 5 + 4} 46) (stroke (width 0.2) (type default)) (layer "F.Fab"))`)
  const text = board({
    layers: '(layers (0 "F.Cu" signal) (31 "B.Cu" signal) (36 "B.SilkS" user) (37 "F.SilkS" user) (44 "Edge.Cuts" user) (46 "B.CrtYd" user) (47 "F.CrtYd" user) (48 "B.Fab" user) (49 "F.Fab" user))',
    outline: '(gr_rect (start 0 0) (end 60 48) (stroke (width 0.1) (type default)) (fill none) (layer "Edge.Cuts"))',
    body: [...parts, ...notes, ...lines],
  })
  const r = importKicadBoard(text, { built: new Set(Object.keys(EXTENSION_NAMES)) })
  if (r.status !== "imported") throw new Error(`refused: ${r.message}`)
  return r.project
}

/** A seeded pseudo-random number in [0, 1), so a failure comes back the same. */
function random(seed: number) {
  let s = seed >>> 0
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32)
}

describe("the grid that picking asks", () => {
  it("gives every box that meets the asked box, once each and in order", () => {
    const r = random(3)
    const boxes = Array.from({ length: 400 }, () => {
      const x = r() * 100 - 50
      const y = r() * 100 - 50
      // Most small, some longer than the grid takes in its cells (a long track).
      const w = r() < 0.1 ? r() * 300 : r() * 6
      const h = r() < 0.1 ? r() * 300 : r() * 6
      return { minX: x, minY: y, maxX: x + w, maxY: y + h }
    })
    const grid = new CellGrid()
    boxes.forEach((b, i) => grid.add(i, b))
    for (let k = 0; k < 300; k++) {
      const x = r() * 120 - 60
      const y = r() * 120 - 60
      const q = { minX: x, minY: y, maxX: x + r() * 3, maxY: y + r() * 3 }
      const near = grid.near(q)
      expect(near).toEqual([...new Set(near)].sort((a, b) => a - b))
      const meets = boxes.flatMap((b, i) => (b.maxX >= q.minX && b.minX <= q.maxX && b.maxY >= q.minY && b.minY <= q.maxY ? [i] : []))
      for (const i of meets) expect(near).toContain(i)
    }
  })

  // The indexed picking against going through every drawing and text, as it did: the same answer at a thousand points of a routed board.
  it("picks the drawing and the text that going through all of them picks", () => {
    const p = textBoard()
    const vis: ShapeVisibility = { hidden: {}, layers: { top: true, bottom: true, silk: true } }
    const shapes = worldShapes(p)
    const texts = worldTexts(p)
    expect(shapes.length).toBeGreaterThan(50)
    expect(texts.length).toBeGreaterThan(50)
    const plainShape = (at: { x: number; y: number }, tol: number) => {
      for (let i = shapes.length - 1; i >= 0; i--) {
        const s = shapes[i]
        if (!shapeShown(s, vis)) continue
        const b = shapeInkBox(s.shape)
        if (at.x < b.minX - tol || at.x > b.maxX + tol || at.y < b.minY - tol || at.y > b.maxY + tol) continue
        if (pointShapeInkDistance(at, s.shape) <= tol) return s
      }
      return null
    }
    // `hitText` as it was: every text shown, the last first, a part's documentation text passed over where a part's body is under the point.
    const isDocumentation = (t: (typeof texts)[number]) => t.owner !== "#board" && textLayerKind(t.layer) !== "silk" && textLayerKind(t.layer) !== "copper"
    const plainText = (at: { x: number; y: number }, tol: number) => {
      const all = texts.filter((t) => textShownOnScreen(t, vis))
      const body =
        all.some(isDocumentation) &&
        p.components.some((c) => {
          const cy = c.pcb.placed ? pcbCourtyard(c) : null
          return !!cy && at.x >= cy.minX && at.x <= cy.maxX && at.y >= cy.minY && at.y <= cy.maxY
        })
      for (let i = all.length - 1; i >= 0; i--) {
        if (body && isDocumentation(all[i])) continue
        const b = textBox(p, all[i])
        if (b && at.x >= b.minX - tol && at.x <= b.maxX + tol && at.y >= b.minY - tol && at.y <= b.maxY + tol) return all[i]
      }
      return null
    }
    const r = random(7)
    const b = p.board
    let shapeHits = 0
    let textHits = 0
    for (let k = 0; k < 1000; k++) {
      const at = { x: b.x - b.width / 2 + r() * b.width, y: b.y - b.height / 2 + r() * b.height }
      const tol = 0.05 + r() * 0.5
      const s = hitShape(shapes, at, tol, vis)
      expect(s).toBe(plainShape(at, tol))
      if (s) shapeHits++
      const t = hitText(p, at, tol, vis)
      expect(t).toBe(plainText(at, tol))
      if (t) textHits++
    }
    expect(shapeHits).toBeGreaterThan(10)
    expect(textHits).toBeGreaterThan(10)
  })
})

describe("the copper drawn as few paths", () => {
  it("joins the pieces of each style into one path, in the order the styles come, the fainter groups first", () => {
    const paths = mergedPaths([
      { style: "a", props: { fill: "red" }, d: "M0,0Z" },
      { style: "b", props: { fill: "blue" }, d: "M1,1Z" },
      { style: "a", props: { fill: "red" }, d: "M2,2Z" },
    ]) as unknown as { key: string; props: { d: string; fill: string } }[]
    expect(paths.map((e) => [e.key, e.props.d, e.props.fill])).toEqual([
      ["a", "M0,0ZM2,2Z", "red"],
      ["b", "M1,1Z", "blue"],
    ])
    const groups = fadedPaths([
      [1, { style: "a", props: {}, d: "M0,0Z" }],
      [0.3, { style: "a", props: {}, d: "M1,1Z" }],
    ]) as unknown as { key: string; props: { opacity?: number } }[]
    expect(groups.map((g) => [g.key, g.props.opacity])).toEqual([
      ["0.3", 0.3],
      ["1", undefined],
    ])
  })

  it("draws a pad's rounded rectangle and a via's circle as the elements did", () => {
    expect(roundRectD(0, 0, 4, 2, 0)).toBe("M0,0H4V2H0Z")
    // Corners no rounder than half the short side, as an SVG rect has them.
    expect(roundRectD(0, 0, 4, 2, 5)).toBe("M1,0H3A1,1 0 0 1 4,1V1A1,1 0 0 1 3,2H1A1,1 0 0 1 0,1V1A1,1 0 0 1 1,0Z")
    expect(circleD(1, 2, 0.5)).toBe("M0.5,2a0.5,0.5 0 1 1 1,0a0.5,0.5 0 1 1 -1,0Z")
  })

  // In one path, filled by the non-zero rule, two shapes wound opposite ways cancel where they overlap: a circle pad over a polygon pad drawn the
  // other way round showed the board through them.
  it("winds every pad the same way, a polygon pad given the other way round reversed", () => {
    const pad = (shape: WorldPad["shape"], extra: Partial<WorldPad> = {}): WorldPad => ({ componentId: "c", pin: "1", padNumber: "1", shape, x: 0, y: 0, width: 1, height: 1, layers: ["top"], ...extra })
    const square = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
      { x: 0, y: 1 },
    ]
    const d = (p: WorldPad) => ((padPaths([{ opacity: 1, pad: p, id: "p", color: "red", highlight: false }], 0.1)[0] as unknown as { props: { children: { props: { d: string } }[] } }).props.children[0].props.d)
    expect(d(pad("polygon", { points: square }))).toBe("M0,0L1,0L1,1L0,1Z")
    expect(d(pad("polygon", { points: [...square].reverse() }))).toBe("M0,0L1,0L1,1L0,1Z")
    // The rectangle and the circle go the same way round as the polygon: right along the bottom, then up.
    expect(d(pad("rect", { x: 0.5, y: 0.5 }))).toMatch(/^M0\.12,0H0\.88A/)
    expect(circleD(0, 0, 1)).toMatch(/0 1 1 /)
  })
})

describe("a big board as it opens", () => {
  it("has its copper and KiCad's kept fills at once, and nothing that needs its connections", () => {
    const base = withZone(twoResistors(), rectangle(-19, -13, 19, 13), { net: "GND" })
    const ring = rectangle(-18, -12, 18, 12)
    const p: Project = { ...base, zones: base.zones.map((z) => ({ ...z, kept: { layers: [{ layer: "top" as const, rings: [ring] }], sig: "" } })) }
    const sch = computeConnectivity(p)
    const open = openingAnalysis(p, sch)
    expect(open.opening).toBe(true)
    expect(open.checksPending).toBe(true)
    expect(open.ratsnest).toEqual([])
    expect(open.violations).toEqual([])
    expect(open.zoneFills.map((f) => [f.zoneId, f.layer, f.netName, f.polygons])).toEqual([["z1", "top", "GND", [[ring]]]])
    expect(open.zoneFills[0].netId).toBe(sch.nets.find((n) => n.name === "GND")!.id)
    // The copper is the analysis's own, by id: a worker's analysis of the board takes it as it is (`analysisWithItems`).
    const full = analyzePcb(p, sch)
    expect(open.items.map((it) => it.id)).toEqual(full.items.filter((it) => it.kind !== "zone").map((it) => it.id))
  })
})

describe("a pour being filled with no earlier fill to show", () => {
  // Without a fill a pour joins nothing: every pad of a ground plane counted as a connection to make, about 4,000 on CERN's Macbeth where it has 220.
  it("leaves its net's connections out of the ratsnest and the checks, and says which net, while every other net's are counted", () => {
    const p = { ...withZone(twoResistors(), rectangle(-19, -13, 19, 13), { net: "GND" }), traces: [] }
    const sch = computeConnectivity(p)
    const gnd = sch.nets.find((n) => n.name === "GND")!.id
    const sig = sch.nets.find((n) => n.name === "SIG")!.id
    const waiting = analyzePcb(p, sch, { reuseOnly: { stale: [] } })
    expect(waiting.zonesPending).toHaveLength(1)
    expect(waiting.connectionsPending).toEqual([gnd])
    expect(waiting.ratsnest.map((l) => l.netId)).toEqual([sig])
    expect(waiting.violations.filter((v) => v.kind === "unrouted").map((v) => v.message)).toEqual(["Unrouted connection on SIG"])
    // Filled, the pour joins the ground pads: there is nothing to leave out, and the ratsnest is as it was.
    const full = analyzePcb(p, sch)
    expect(full.connectionsPending).toBeUndefined()
    expect(full.ratsnest.map((l) => l.netId)).toEqual([sig])
    // With the last fill to stand in for it, the net's connections are counted from that fill.
    const stood = analyzePcb(p, sch, { reuseOnly: { stale: full.zoneFills } })
    expect(stood.connectionsPending).toBeUndefined()
    expect(stood.ratsnest.map((l) => l.netId)).toEqual([sig])
  })
})
