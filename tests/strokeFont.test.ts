import { describe, expect, it } from "vitest"
import { strokeText, strokeTextWidth } from "../src/lib/strokeFont"

const PRINTABLE = Array.from({ length: 126 - 33 + 1 }, (_, i) => String.fromCharCode(33 + i))
const LOWER = [..."abcdefghijklmnopqrstuvwxyz"]

/** Strokes of one character in glyph units: cell origin at (0, 0), cap height 6. */
const glyph = (ch: string) => strokeText(ch, { x: 0, y: 3, size: 6, anchor: "left" })

const extent = (ch: string) => {
  const pts = glyph(ch).flat()
  const xs = pts.map((p) => p.x)
  const ys = pts.map((p) => p.y)
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) }
}

describe("stroke font", () => {
  it("keeps the advance width of the original font", () => {
    // Four-unit glyphs on a five-unit advance, scaled so the cap height is `size`.
    const legacy = (text: string, size: number) => {
      const n = [...text].length
      return n ? ((n * 5 - 1) * size) / 6 : 0
    }
    for (const text of ["", "R", "R12", "ESP32 ROBOT CONTROLLER", "ENC1_ChA", "+5V S GND", "µΩ é"]) {
      for (const size of [0.8, 1, 1.5, 3]) expect(strokeTextWidth(text, size)).toBe(legacy(text, size))
    }
    expect(strokeTextWidth("A", 6)).toBe(4)
  })

  it("has its own glyph for every printable ASCII character", () => {
    const placeholder = glyph("?")
    for (const ch of PRINTABLE) {
      const strokes = glyph(ch)
      expect(strokes.length, ch).toBeGreaterThan(0)
      for (const s of strokes) {
        expect(s.length, ch).toBeGreaterThanOrEqual(2)
        for (const p of s) expect(Number.isFinite(p.x) && Number.isFinite(p.y), ch).toBe(true)
      }
      if (ch !== "?") expect(strokes, ch).not.toEqual(placeholder)
    }
    expect(glyph(" ")).toHaveLength(0)
  })

  it("draws lowercase as typed instead of as capitals", () => {
    for (const ch of LOWER) expect(glyph(ch), ch).not.toEqual(glyph(ch.toUpperCase()))
    expect(strokeText("ENC1_ChA", { x: 0, y: 0, size: 1 })).not.toEqual(strokeText("ENC1_CHA", { x: 0, y: 0, size: 1 }))
  })

  it("falls back to the capital, then to a question mark", () => {
    expect(glyph("ſ")).toEqual(glyph("S")) // long s capitalises to S
    expect(glyph("é")).toEqual(glyph("?"))
    expect(glyph("€")).toEqual(glyph("?"))
  })

  it("keeps every glyph inside its cell", () => {
    for (const ch of PRINTABLE) {
      const e = extent(ch)
      expect(e.minX, ch).toBeGreaterThanOrEqual(0)
      expect(e.maxX, ch).toBeLessThanOrEqual(4)
      expect(e.minY, ch).toBeGreaterThanOrEqual(-1.5)
      expect(e.maxY, ch).toBeLessThanOrEqual(6)
    }
  })

  it("sits capitals and figures on the baseline and cap height", () => {
    for (const ch of "ABCDEFGHIJKLMNOPRSTUVWXYZ0123456789") {
      const e = extent(ch)
      expect(e.minY, ch).toBeCloseTo(0, 3)
      expect(e.maxY, ch).toBeCloseTo(6, 3)
    }
    expect(extent("Q").minY).toBeLessThan(0)
  })

  it("gives lowercase an x-height, ascenders and descenders", () => {
    for (const ch of "acemnorsuvwxz") {
      const e = extent(ch)
      expect(e.minY, ch).toBeCloseTo(0, 3)
      expect(e.maxY, ch).toBeCloseTo(4.2, 3)
    }
    for (const ch of "bdhkl") expect(extent(ch).maxY, ch).toBeCloseTo(6, 3)
    for (const ch of "gjpqy") expect(extent(ch).minY, ch).toBeCloseTo(-1.5, 3)
  })

  it("centres text vertically on the cap height", () => {
    const ys = strokeText("HELLO", { x: 3, y: 7, size: 2 })
      .flat()
      .map((p) => p.y)
    expect(Math.min(...ys)).toBeCloseTo(6)
    expect(Math.max(...ys)).toBeCloseTo(8)
  })

  it("mirrors and rotates about the anchor", () => {
    const text = "Rg&5"
    const at = { x: 10, y: -4, size: 1.2 }
    const plain = strokeText(text, at).flat()
    const mirrored = strokeText(text, { ...at, mirror: true }).flat()
    expect(mirrored).toHaveLength(plain.length)
    mirrored.forEach((p, i) => {
      expect(p.x - at.x).toBeCloseTo(-(plain[i].x - at.x), 3)
      expect(p.y).toBeCloseTo(plain[i].y, 3)
    })
    const turns = { 90: (x: number, y: number) => [-y, x], 180: (x: number, y: number) => [-x, -y], 270: (x: number, y: number) => [y, -x] }
    for (const rot of [90, 180, 270] as const) {
      const rotated = strokeText(text, { ...at, rotation: rot }).flat()
      rotated.forEach((p, i) => {
        const [x, y] = turns[rot](plain[i].x - at.x, plain[i].y - at.y)
        expect(p.x - at.x).toBeCloseTo(x, 3)
        expect(p.y - at.y).toBeCloseTo(y, 3)
      })
    }
  })

  it("rounds output coordinates", () => {
    for (const p of strokeText("Silk 0.1mm", { x: 1 / 3, y: 2 / 7, size: 1.1, rotation: 90 }).flat()) {
      expect(p.x).toBe(Math.round(p.x * 1e4) / 1e4)
      expect(p.y).toBe(Math.round(p.y * 1e4) / 1e4)
    }
  })
})
