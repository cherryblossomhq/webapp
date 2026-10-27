import { describe, expect, it } from "vitest"
import { kicadFiles } from "../src/export/kicad"
import { qrCode, type QrLevel } from "../src/lib/qrCode"
import { BUILT_EXTENSIONS, importKicadBoard, needsOf, outlineOf, readKicadBoard } from "../src/model/kicad/board"
import { countPaths } from "../src/model/kicad/board/account"
import { parseProjectFile, serializeProject } from "../src/model/projectFile"
import { shapeBox } from "../src/model/shapes"
import type { Project } from "../src/model/types"
import { board, footprint, pad } from "./kicad-board-fixtures"
import { diffProjects } from "./kicad-roundtrip-check"
import { unknownNodes } from "./kicad9-nodes"

// X25: tables, drill charts, barcodes, text boxes inside parts and boxes that are outlines of points, and text KiCad works out, brought in as the plain drawings and text they are drawn as. The QR code is the
// standard's own (`lib/qrCode.ts`), checked here against the standard: capacities, function patterns, format information, and for a version 1 symbol its codewords' error correction.

const LEVELS: QrLevel[] = ["L", "M", "Q", "H"]
// The bytes a QR code holds in byte mode, by version and level (ISO/IEC 18004 table 7).
const CAPACITY: Record<number, number[]> = { 1: [17, 14, 11, 7], 2: [32, 26, 20, 14], 3: [53, 42, 32, 24], 4: [78, 62, 46, 34], 5: [106, 84, 60, 44], 7: [154, 122, 86, 64], 10: [271, 213, 151, 119], 20: [858, 666, 482, 382], 30: [1732, 1370, 982, 742], 40: [2953, 2331, 1663, 1273] }

describe("the QR code", () => {
  it("holds what the standard says at every level, in the smallest version, and no more", () => {
    for (const [v, caps] of Object.entries(CAPACITY)) {
      const version = Number(v)
      caps.forEach((cap, i) => {
        const full = qrCode("a".repeat(cap), LEVELS[i])
        expect(full?.length, `version ${version} ${LEVELS[i]}`).toBe(4 * version + 17)
        const over = qrCode("a".repeat(cap + 1), LEVELS[i])
        expect(over?.length ?? 0).toBe(version === 40 ? 0 : 4 * (version + 1) + 17)
      })
    }
  })

  /** The format information of a symbol read from its first copy: the level and the mask, or null when it is not a codeword of the code. */
  function format(g: boolean[][]) {
    const at = [[8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8], [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8]]
    let bits = 0
    at.forEach(([x, y], i) => (bits |= (g[y][x] ? 1 : 0) << i))
    // the second copy says the same
    const n = g.length
    let second = 0
    for (let i = 0; i < 8; i++) second |= (g[8][n - 1 - i] ? 1 : 0) << i
    for (let i = 8; i < 15; i++) second |= (g[n - 15 + i][8] ? 1 : 0) << i
    expect(second).toBe(bits)
    const data = (bits ^ 0x5412) >> 10
    let rem = data
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537)
    return (((data << 10) | rem) ^ 0x5412) === bits ? { level: data >> 3, mask: data & 7 } : null
  }

  it("has the three finder patterns, the timing patterns, the dark module and format information that is a code word", () => {
    const g = qrCode("hello", "M")!
    const n = g.length
    const finder = (x0: number, y0: number) => {
      for (let y = 0; y < 7; y++) for (let x = 0; x < 7; x++) expect(g[y0 + y][x0 + x], `${x0},${y0} ${x},${y}`).toBe(Math.max(Math.abs(x - 3), Math.abs(y - 3)) !== 2)
    }
    finder(0, 0)
    finder(n - 7, 0)
    finder(0, n - 7)
    for (let i = 8; i < n - 8; i++) {
      expect(g[6][i]).toBe(i % 2 === 0)
      expect(g[i][6]).toBe(i % 2 === 0)
    }
    expect(g[n - 8][8]).toBe(true)
    expect(format(g)).toMatchObject({ level: 0 })
    for (const [i, level] of LEVELS.entries()) expect(format(qrCode("x", level)!)?.level).toBe([1, 0, 3, 2][i])
  })

  it("reads back as the text it was made for: mode, length and bytes in the first codewords, after the mask the format says", () => {
    for (const text of ["hello", "abc.com/x?y=1", "café"]) {
      const g = qrCode(text, "L")!
      const mask = format(g)!.mask
      const MASKS = [(x: number, y: number) => (x + y) % 2 === 0, (_: number, y: number) => y % 2 === 0, (x: number) => x % 3 === 0, (x: number, y: number) => (x + y) % 3 === 0, (x: number, y: number) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x: number, y: number) => ((x * y) % 2) + ((x * y) % 3) === 0, (x: number, y: number) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0, (x: number, y: number) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0]
      const bytes = [...new TextEncoder().encode(text)]
      const n = g.length
      // version 1: the first 12 rows of the two rightmost columns hold 24 bits, zigzag upward from the lower right corner
      const bits: number[] = []
      for (let i = 0; i < 24; i++) {
        const x = n - 1 - (i % 2)
        const y = n - 1 - Math.floor(i / 2)
        bits.push(g[y][x] !== MASKS[mask](x, y) ? 1 : 0)
      }
      expect(n).toBe(21)
      const word = (from: number, len: number) => parseInt(bits.slice(from, from + len).join(""), 2)
      expect(word(0, 4)).toBe(0b0100)
      expect(word(4, 8)).toBe(bytes.length)
      expect(word(12, 8)).toBe(bytes[0])
    }
  })

  /** A product in GF(256) modulo 0x11D, from tables. */
  const gf = (() => {
    const exp: number[] = []
    const log: number[] = new Array(256).fill(0)
    let x = 1
    for (let i = 0; i < 255; i++) {
      exp.push(x)
      log[x] = i
      x <<= 1
      if (x & 0x100) x ^= 0x11d
    }
    return { exp, mul: (a: number, b: number) => (a && b ? exp[(log[a] + log[b]) % 255] : 0) }
  })()

  it("a version 1 symbol's codewords have no error: the codeword polynomial is zero at every root of the generator, at each level", () => {
    const ECC = { L: 7, M: 10, Q: 13, H: 17 }
    const MASKS = [(x: number, y: number) => (x + y) % 2 === 0, (_: number, y: number) => y % 2 === 0, (x: number) => x % 3 === 0, (x: number, y: number) => (x + y) % 3 === 0, (x: number, y: number) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x: number, y: number) => ((x * y) % 2) + ((x * y) % 3) === 0, (x: number, y: number) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0, (x: number, y: number) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0]
    for (const level of LEVELS) {
      const g = qrCode("ab", level)!
      const n = 21
      const mask = format(g)!.mask
      // Every module that is not a function pattern: not in a finder with its separator and format area, not a timing module, not the dark module.
      const data = (x: number, y: number) => !((x < 9 && y < 9) || (x > n - 9 && y < 9) || (x < 9 && y > n - 9) || x === 6 || y === 6)
      const bits: number[] = []
      for (let right = n - 1; right >= 1; right -= 2) {
        if (right === 6) right = 5
        for (let v = 0; v < n; v++) {
          for (let j = 0; j < 2; j++) {
            const x = right - j
            const y = ((right + 1) & 2) === 0 ? n - 1 - v : v
            if (data(x, y)) bits.push(g[y][x] !== MASKS[mask](x, y) ? 1 : 0)
          }
        }
      }
      // 26 codewords of version 1, and the 7 remainder bits no codeword holds
      const words: number[] = []
      for (let i = 0; i < 26; i++) words.push(parseInt(bits.slice(8 * i, 8 * i + 8).join(""), 2))
      expect(bits.length).toBe(26 * 8)
      for (let root = 0; root < ECC[level]; root++) {
        let sum = 0
        for (const w of words) sum = gf.mul(sum, gf.exp[root]) ^ w
        expect(sum, `${level} root ${root}`).toBe(0)
      }
    }
  })

  it("is not made for a text too long for any version", () => {
    expect(qrCode("a".repeat(2954), "L")).toBeNull()
  })
})

const fx = `(effects (font (size 1 1) (thickness 0.15)) (justify left))`
const cell = (text: string, a: string, b: string, layer = "F.SilkS", span = "1 1") => `(table_cell "${text}" (start ${a}) (end ${b}) (margins 0.5 0.5 0.5 0.5) (span ${span}) (layer "${layer}") (uuid "00000000-0000-4000-8000-000000000c01") ${fx})`
const tableFor = (cells: string[], opts: { layer?: string; columns?: number; widths?: string; heights?: string; border?: string; separators?: string } = {}) =>
  `(table (column_count ${opts.columns ?? 2}) (uuid "00000000-0000-4000-8000-000000000d01") (layer "${opts.layer ?? "F.SilkS"}") (border ${opts.border ?? "(external yes) (header yes) (stroke (width 0.2) (type solid))"}) (separators ${opts.separators ?? "(rows yes) (cols yes) (stroke (width 0.1) (type dash))"}) (column_widths ${opts.widths ?? "6 4"}) (row_heights ${opts.heights ?? "2 2"}) (cells ${cells.join(" ")}))`
const grid = [cell("a", "10 3", "16 5"), cell("b", "16 3", "20 5"), cell("c", "10 5", "16 7"), cell("d", "16 5", "20 7")]

const imp = (body: string[], extra: Parameters<typeof board>[0] = {}) => {
  const r = importKicadBoard(board({ body, ...extra }))
  if (r.status !== "imported") throw new Error(`${r.status}: ${r.message}`)
  return r
}
const pcbOf = async (p: Project) => Object.entries((await kicadFiles(p)).files).find(([k]) => k.endsWith(".kicad_pcb"))![1]
const lines = (p: Project) => (p.graphics ?? []).filter((g) => g.type === "line")

describe("X25 is built, and the gate still names it", () => {
  it("is in BUILT_EXTENSIONS, and the board that uses it says X25", () => {
    expect(BUILT_EXTENSIONS.has("X25")).toBe(true)
    const read = readKicadBoard(board({ body: [tableFor(grid)] })).board
    expect(needsOf(read, { paths: countPaths(read.tree) }, outlineOf(read)).map((n) => n.ext)).toContain("X25")
  })
})

describe("a table", () => {
  it("is the lines of its border and separators, and a text box for each cell, in the same place and layer", () => {
    const r = imp([tableFor(grid)])
    const l = lines(r.project)
    // the border (4), the line between the columns (1) and the one between the rows (1); the header line is the row separator
    expect(l).toHaveLength(6)
    const ends = (g: (typeof l)[number]) => [g.a, g.b].map((p) => `${p.x},${p.y}`).join(" ")
    expect(l.map(ends)).toEqual(["10,-3 20,-3", "20,-3 20,-7", "20,-7 10,-7", "10,-7 10,-3", "10,-5 20,-5", "16,-3 16,-7"])
    expect(l.slice(0, 4).every((g) => g.width === 0.2 && g.dash === undefined && g.layer === "F.SilkS")).toBe(true)
    expect(l.slice(4).every((g) => g.width === 0.1 && g.dash === "dash")).toBe(true)
    const texts = r.project.texts.filter((t) => t.box)
    expect(texts.map((t) => t.text)).toEqual(["a", "b", "c", "d"])
    expect(texts[0]).toMatchObject({ layer: "F.SilkS", x: 13, y: -4, rot: 0, hj: "left", box: { w: 6, h: 2, margins: [0.5, 0.5, 0.5, 0.5] } })
    expect(texts[3]).toMatchObject({ x: 18, y: -6, box: { w: 4, h: 2 } })
    expect(texts[0].box!.border).toBeUndefined()
    expect(r.report.entries.find((e) => e.code === "tables-flattened")).toMatchObject({ severity: "changed", count: 1 })
  })

  it("draws only what the table says: no border, no separators, the header line alone", () => {
    const plain = imp([tableFor(grid, { border: "(external no) (header no) (stroke (width 0.2) (type solid))", separators: "(rows no) (cols no) (stroke (width 0.1) (type solid))" })])
    expect(lines(plain.project)).toHaveLength(0)
    expect(plain.project.texts.filter((t) => t.box)).toHaveLength(4)
    const header = imp([tableFor(grid, { border: "(external no) (header yes) (stroke (width 0.3) (type solid))", separators: "(rows no) (cols no) (stroke (width 0.1) (type solid))" })])
    expect(lines(header.project).map((g) => [g.a, g.b, g.width])).toEqual([[{ x: 10, y: -5 }, { x: 20, y: -5 }, 0.3]])
  })

  it("does not draw a separator through a cell that spans it", () => {
    const merged = [cell("top", "10 3", "20 5", "F.SilkS", "2 1"), cell("c", "10 5", "16 7"), cell("d", "16 5", "20 7")]
    const r = imp([tableFor(merged)])
    // the line between the columns is below the merged cell only: from y 5 to 7
    const col = lines(r.project).find((g) => g.a.x === 16 && g.b.x === 16)!
    expect([col.a.y, col.b.y]).toEqual([-5, -7])
    // the line between the rows is whole
    expect(lines(r.project).some((g) => g.a.y === -5 && g.b.y === -5 && g.a.x === 10 && g.b.x === 20)).toBe(true)
  })

  it("reads a cell that is the four corners of a rectangle, as a table inside a part that was turned has them", () => {
    const corners = (cell: string, pts: string) => cell.replace(/\(start [^)]*\) \(end [^)]*\)/, `(pts ${pts})`)
    const cells = [
      corners(cell("a", "10 3", "16 5"), "(xy 10 3) (xy 16.000001 2.999999) (xy 16 4.999999) (xy 10 5)"),
      corners(cell("b", "16 3", "20 5"), "(xy 16 3) (xy 20.000001 2.999999) (xy 20 4.999999) (xy 16 5)"),
    ]
    const r = imp([tableFor(cells, { heights: "2" })])
    // the grid starts at the corners' box, not at the origin the missing `start` would give
    const round = (v: number) => Math.round(v * 1e4) / 1e4
    expect(lines(r.project).slice(0, 4).map((g) => `${round(g.a.x)},${round(g.a.y)} ${round(g.b.x)},${round(g.b.y)}`)).toEqual(["10,-3 20,-3", "20,-3 20,-5", "20,-5 10,-5", "10,-5 10,-3"])
    expect(r.project.texts.filter((t) => t.box).map((t) => [t.text, round(t.box!.w)])).toEqual([["a", 6], ["b", 4]])
  })

  it("keeps the cell's own look: the size, bold, mirror and knockout of its text", () => {
    const styled = `(table_cell "x" (start 10 3) (end 20 7) (margins 1 1 1 1) (span 1 1) (layer "F.Cu") (uuid "00000000-0000-4000-8000-000000000c02") (effects (font (size 2 1.5) (thickness 0.3) bold) (justify right mirror)) (knockout yes))`
    const r = imp([tableFor([styled], { columns: 1, widths: "10", heights: "4", layer: "F.Cu" })])
    expect(r.project.texts[0]).toMatchObject({ layer: "F.Cu", size: 2, w: 1.5, bold: true, mirror: true, knockout: true, hj: "right", box: { w: 10, h: 4, margins: [1, 1, 1, 1] } })
  })

  it("inside a part is the part's: its lines are in the land and its cells the part's texts, turned with the part", () => {
    const withTable = (at: string, layer = "F.Cu") => footprint({ ref: "U1", at, layer, pads: [pad({ at: "0 0" })], extra: tableFor([cell("hi", "-2 3", "4 5"), cell("yo", "4 3", "8 5")], { widths: "6 4", heights: "2", layer: layer === "B.Cu" ? "B.SilkS" : "F.SilkS" }) })
    const r = imp([withTable("10 5")])
    const land = r.project.footprints![0]
    expect(land.shapes!.filter((s) => s.type === "line").length).toBeGreaterThanOrEqual(5)
    expect(land.shapes![0]).toMatchObject({ type: "line", layer: "F.SilkS", a: { x: -2, y: -3 }, b: { x: 8, y: -3 } })
    const texts = r.project.components[0].texts!.filter((t) => t.box)
    expect(texts.map((t) => [t.text, t.x, t.y, t.rot])).toEqual([["hi", 1, -4, 0], ["yo", 6, -4, 0]])
    expect(texts[0].box).toMatchObject({ w: 6, h: 2 })
    // a part turned by a quarter turn takes the table with it: the text keeps its angle in the land
    const turned = imp([withTable("10 5 90")])
    expect(turned.project.components[0].texts!.filter((t) => t.box).map((t) => t.rot)).toEqual([0, 0])
    expect(turned.project.components[0].pcb.rot).toBe(90)
    expect(turned.project.footprints![0].shapes![0]).toMatchObject({ a: { x: -2, y: -3 } })
  })

  it("is written as KiCad 9 writes drawings and text boxes, and read back as the same project", async () => {
    const a = imp([tableFor(grid)])
    const text = await pcbOf(a.project)
    expect(unknownNodes(text)).toEqual([])
    expect(text).not.toMatch(/\(table/)
    const b = importKicadBoard(text)
    expect(b.status).toBe("imported")
    if (b.status === "imported") expect(diffProjects(a.project, b.project)).toEqual([])
  })

  it("is kept by a save and a load", () => {
    const a = imp([tableFor(grid), footprint({ ref: "U1", at: "10 5", pads: [pad({ at: "0 0" })], extra: tableFor([cell("hi", "-2 3", "4 5")], { columns: 1, widths: "6", heights: "2" }) })])
    const back = parseProjectFile(serializeProject(a.project), { id: "x" })
    expect(back.graphics).toEqual(a.project.graphics)
    expect(back.texts).toEqual(a.project.texts)
    expect(back.footprints).toEqual(a.project.footprints)
    expect(back.components[0].texts).toEqual(a.project.components[0].texts)
  })
})

describe("a drill chart and a drill map", () => {
  const chart = `(drill_chart (uuid "00000000-0000-4000-8000-000000000e01") (layer "F.SilkS") (precision 2) (column (id symbol) (width 6)) (column (id drill_diameter) (name "Drill") (width 4)) (row_keys (key 1 "v1|d300000")) (filter (plated yes)) (totals no) (row_shapes (column 0) (shape 1 0)) (column_count 2) (border (external yes) (header yes) (stroke (width 0.15) (type default))) (separators (rows yes) (cols yes) (stroke (width 0.15) (type default))) (column_widths 6 4) (row_heights 2 2) (cells ${[cell("SYM", "10 3", "16 5"), cell("Drill", "16 3", "20 5"), cell("", "10 5", "16 7"), cell("0.30", "16 5", "20 7")].join(" ")}))`
  const map = `(drill_map (uuid "00000000-0000-4000-8000-000000000e02") (layer "F.SilkS") (offset 50 0) (size 1.5) (span "F.Cu" "B.Cu") (outline_slots yes) (guide_cross no))`

  it("the chart is its table as the file has it, the map is named as not brought", () => {
    const r = imp([chart, map])
    expect(r.project.texts.filter((t) => t.box).map((t) => t.text)).toEqual(["SYM", "Drill", "", "0.30"])
    expect(lines(r.project).length).toBeGreaterThan(4)
    const e = r.report.entries.find((x) => x.code === "tables-flattened")!
    expect(e.object).toMatch(/1 table \(1 drill chart\)/)
    expect(e.why).toMatch(/no symbols in its first column/)
    expect(r.report.entries.find((x) => x.code === "not-representable" && /drill_map/.test(x.object))).toMatchObject({ severity: "not-brought" })
  })
})

describe("a barcode", () => {
  const code = (extra = "", text = "hello", at = "10 5 0", size = "8 8") => `(barcode (at ${at}) (layer "F.SilkS") (size ${size}) (text "${text}") (text_height 1) (type qr) (ecc_level M) ${extra} (uuid "00000000-0000-4000-8000-000000000f01"))`
  const filled = (p: Project) => (p.graphics ?? []).filter((g) => g.type === "polygon" && g.fill)

  it("is the QR code of its text as filled squares, centred on its point and as large as its smaller side", () => {
    const r = imp([code("(hide no) (knockout no)")])
    const g = filled(r.project)
    expect(g.length).toBeGreaterThan(10)
    const n = qrCode("hello", "M")!.length
    const dark = qrCode("hello", "M")!.flat().filter(Boolean).length
    const cellMm = 8 / n
    const area = g.reduce((s, x) => s + Math.abs(shapeArea(x)), 0)
    expect(area).toBeCloseTo(dark * cellMm * cellMm, 3)
    const box = g.map(shapeBox).reduce((b, c) => ({ minX: Math.min(b.minX, c.minX), maxX: Math.max(b.maxX, c.maxX), minY: Math.min(b.minY, c.minY), maxY: Math.max(b.maxY, c.maxY) }))
    expect([box.minX, box.maxX, box.minY, box.maxY].map((v) => Math.round(v * 1000) / 1000)).toEqual([6, 14, -9, -1])
    expect(g.every((x) => x.layer === "F.SilkS" && x.width === 0)).toBe(true)
    expect(r.report.entries.find((e) => e.code === "barcodes-flattened")?.count).toBe(1)
  })

  it("a knockout is the box with the symbol cut out of it, and a barcode that is turned is turned about its point", () => {
    const n = qrCode("hello", "M")!.length
    const dark = qrCode("hello", "M")!.flat().filter(Boolean).length
    const cellMm = 8 / n
    const ko = filled(imp([code("(knockout yes)")]).project)
    expect(ko.reduce((s, x) => s + Math.abs(shapeArea(x)), 0)).toBeCloseTo(64 - dark * cellMm * cellMm, 3)
    const turned = filled(imp([code("", "hello", "10 5 90")]).project)
    const box = turned.map(shapeBox).reduce((b, c) => ({ minX: Math.min(b.minX, c.minX), maxX: Math.max(b.maxX, c.maxX), minY: Math.min(b.minY, c.minY), maxY: Math.max(b.maxY, c.maxY) }))
    expect([box.minX, box.maxX].map((v) => Math.round(v * 1000) / 1000)).toEqual([6, 14])
    const side = filled(imp([code("", "hello", "10 5 33")]).project)
    expect(side.reduce((s, x) => s + Math.abs(shapeArea(x)), 0)).toBeCloseTo(dark * cellMm * cellMm, 3)
  })

  it("a hidden barcode draws nothing and says so, a kind the editor cannot draw is refused in words", () => {
    const hidden = imp([code("(hide yes)")])
    expect(filled(hidden.project)).toHaveLength(0)
    expect(hidden.report.entries.find((e) => e.code === "barcodes-hidden")?.count).toBe(1)
    const other = importKicadBoard(board({ body: [code().replace("(type qr)", "(type datamatrix)")] }))
    expect(other.status === "refused" && other.reason).toBe("inexact")
    expect(other.status === "refused" && other.message).toMatch(/a datamatrix barcode, which the editor cannot draw yet/)
    const long = importKicadBoard(board({ body: [code("", "a".repeat(3000))] }))
    expect(long.status === "refused" && long.message).toMatch(/more text than version 40 holds/)
  })

  it("is written as KiCad 9 writes drawings, and read back as the same project", async () => {
    const a = imp([code()])
    const text = await pcbOf(a.project)
    expect(unknownNodes(text)).toEqual([])
    const b = importKicadBoard(text)
    expect(b.status).toBe("imported")
    if (b.status === "imported") expect(diffProjects(a.project, b.project)).toEqual([])
  })
})

/** The area of a polygon drawing's outline. */
function shapeArea(s: Project["graphics"] extends (infer G)[] | undefined ? G : never): number {
  if (s.type !== "polygon") return 0
  const area = (ring: { x: number; y: number }[]) => ring.reduce((a, p, i) => a + p.x * ring[(i + 1) % ring.length].y - ring[(i + 1) % ring.length].x * p.y, 0) / 2
  return area(s.pts) - (s.holes ?? []).reduce((a, h) => a + Math.abs(area(h)), 0)
}

describe("text boxes", () => {
  const fxFull = `(effects (font (size 1 1) (thickness 0.15)) (justify left top))`

  it("a box that is an outline of points is the rectangle its corners make, turned by the text's angle", () => {
    // a 6 by 2 rectangle turned 30 degrees about (10, 5): corners as KiCad writes them, in the file's y-down frame
    const a = (30 * Math.PI) / 180
    const corner = (x: number, y: number) => `(xy ${(10 + x * Math.cos(a) + y * Math.sin(a)).toFixed(9)} ${(5 - x * Math.sin(a) + y * Math.cos(a)).toFixed(9)})`
    const text = `(gr_text_box "turned" (pts ${corner(-3, -1)} ${corner(3, -1)} ${corner(3, 1)} ${corner(-3, 1)}) (angle 30) (layer "F.SilkS") (margins 0.5 0.5 0.5 0.5) (border yes) (stroke (width 0.1) (type solid)) ${fxFull})`
    const r = imp([text])
    expect(r.project.texts[0]).toMatchObject({ text: "turned", rot: 30, box: { w: 6, h: 2, border: 0.1 } })
    expect(r.project.texts[0].x).toBeCloseTo(10, 5)
    expect(r.project.texts[0].y).toBeCloseTo(-5, 5)
    // a polygon that is not the rectangle of the text's angle is not held
    const off = importKicadBoard(board({ body: [text.replace("(angle 30)", "(angle 10)")] }))
    expect(off.status === "refused" && off.message).toMatch(/outline of points but not the rectangle of its text's angle/)
  })

  it("a text box inside a part is the part's text with its box, in the part's frame", () => {
    const fp = footprint({ ref: "U1", at: "10 5", pads: [pad({ at: "0 0" })], extra: `(fp_text_box "note" (start -2 3) (end 4 5) (angle 0) (layer "F.SilkS") (margins 0.5 0.5 0.5 0.5) (border no) ${fxFull})` })
    const r = imp([fp])
    const t = r.project.components[0].texts!.find((x) => x.box)!
    expect(t).toMatchObject({ kind: "user", text: "note", x: 1, y: -4, rot: 0, box: { w: 6, h: 2 } })
    expect(t.box!.border).toBeUndefined()
  })

  it("a text box inside a part, and a table inside a part turned or on the bottom, are written and read back as the same project", async () => {
    const box = (at: string, layer = "F.Cu", angle = 0) => footprint({ ref: "U1", at, layer, pads: [pad({ at: "0 0", layers: layer === "B.Cu" ? '"B.Cu" "B.Paste" "B.Mask"' : undefined })], extra: `(fp_text_box "note" (start -2 3) (end 4 5) (angle ${angle}) (layer "${layer === "B.Cu" ? "B.SilkS" : "F.SilkS"}") (margins 0.5 0.5 0.5 0.5) (border no) ${fxFull}) ${tableFor([cell("hi", "-2 6", "4 8")], { columns: 1, widths: "6", heights: "2", layer: layer === "B.Cu" ? "B.SilkS" : "F.SilkS" })}` })
    for (const [at, layer, angle] of [["10 5", "F.Cu", 0], ["10 5 90", "F.Cu", 90], ["10 5 33", "F.Cu", 33]] as const) {
      const a = imp([box(at, layer, angle)])
      const text = await pcbOf(a.project)
      expect(unknownNodes(text)).toEqual([])
      const b = importKicadBoard(text)
      expect(b.status, `${at} ${layer}`).toBe("imported")
      if (b.status === "imported") expect(diffProjects(a.project, b.project), `${at} ${layer}`).toEqual([])
    }
  })

  it("text KiCad works out is kept as it is typed, and the report lists it", () => {
    const text = (s: string) => `(gr_text "${s}" (at 3 3) (layer "F.SilkS") (effects (font (size 1 1) (thickness 0.15))))`
    const r = imp([footprint({ ref: "U1", at: "10 5", pads: [pad({ at: "0 0" })], extra: `(property "Datasheet" "http://x" (at 0 0 0) (layer "F.Fab") (hide yes) ${fxFull}) (fp_text user "\${Datasheet}" (at 0 2) (layer F.SilkS) ${fxFull})` }), text("@{1+1}"), text("${NET_NAME(1)}"), text("${CURRENT_DATE}"), text("plain")])
    expect(r.project.texts.map((t) => t.text)).toEqual(["@{1+1}", "${NET_NAME(1)}", "${CURRENT_DATE}", "plain"])
    const e = r.report.entries.find((x) => x.code === "text-as-typed")!
    expect(e).toMatchObject({ severity: "changed", count: 4 })
    expect(e.items!.join(" ")).toMatch(/@\{1\+1\}.*NET_NAME.*CURRENT_DATE.*Datasheet/)
    // and kept by the file the export writes
    expect(r.project.components[0].texts!.some((t) => t.text === "${Datasheet}")).toBe(true)
  })
})
