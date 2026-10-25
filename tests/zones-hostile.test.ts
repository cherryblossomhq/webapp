import { describe, expect, it } from "vitest"
import { parseProjectFile, PROJECT_FILE_FORMAT, PROJECT_FILE_VERSION } from "../src/model/projectFile"
import { polygonPath } from "../src/model/zones"
import { analyze, twoResistors, withZone } from "./zones-fixtures"

describe("zones that are not what they should be", () => {
  it("a polygon that crosses itself is filled as the area it encloses, with no crash", () => {
    const bow = [{ x: -10, y: -8 }, { x: 10, y: 4 }, { x: 10, y: -8 }, { x: -10, y: 4 }]
    const p = withZone(twoResistors(), [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 4 }], { net: "GND" })
    const crossing = { ...p, zones: p.zones.map((z) => ({ ...z, outline: [polygonPath(bow)] })) }
    const f = analyze(crossing).zoneFills[0]
    expect(f.polygons.length).toBeGreaterThan(0)
  })

  it("a polygon of 20,000 corners fills in seconds, not minutes", () => {
    const n = 20000
    const ring = Array.from({ length: n }, (_, i) => ({ x: Math.round(Math.cos((i / n) * Math.PI * 2) * 12000) / 1000, y: Math.round(Math.sin((i / n) * Math.PI * 2) * 9000) / 1000 - 4 }))
    const start = Date.now()
    const f = analyze(withZone(twoResistors(), ring, { net: "GND" })).zoneFills[0]
    expect(f.polygons.length).toBeGreaterThan(0)
    expect(Date.now() - start).toBeLessThan(20_000)
  })

  it("a zone far off the board, or of no area, fills nothing", () => {
    expect(analyze(withZone(twoResistors(), [{ x: 1e6, y: 1e6 }, { x: 1e6 + 5, y: 1e6 }, { x: 1e6, y: 1e6 + 5 }], { net: "GND" })).zoneFills[0].polygons).toEqual([])
    const p = withZone(twoResistors(), [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 5 }], { net: "GND" })
    const flat = { ...p, zones: p.zones.map((z) => ({ ...z, outline: [polygonPath([{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 10, y: 0 }])] })) }
    expect(analyze(flat).zoneFills[0].polygons).toEqual([])
  })

  it("a stored zone with NaN, a missing layer, a ring of two points or the wrong type is repaired or dropped, never thrown", () => {
    const doc = {
      format: PROJECT_FILE_FORMAT,
      version: PROJECT_FILE_VERSION,
      project: {
        name: "x",
        description: "",
        components: [],
        wires: [],
        labels: [],
        zones: [
          { id: "a", net: "GND", layer: "top", ol: [["p", 0, 0, "x", 1, 1, 0]], priority: 1 },
          { id: "b", net: "GND", layer: "top", ol: [["p", 0, 0, 1, 0]], priority: 1 },
          { id: "c", net: 5, layer: "top", ol: [["p", 0, 0, 4, 0, 4, 4]], minWidth: Number.NaN, clearance: "wide", keepout: "yes" },
          null,
          "text",
          { id: "d", layer: "top", ol: "no", priority: 1 },
        ],
      },
    }
    const read = parseProjectFile(JSON.parse(JSON.stringify(doc)), { id: "p" })
    expect(read.zones.map((z) => z.id)).toEqual(["c"])
    expect(read.zones[0]).toEqual({ id: "c", net: "", layer: "top", outline: [polygonPath([{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 4 }])] })
    expect(analyze({ ...twoResistors(), zones: read.zones })).toBeTruthy()
  })
})
