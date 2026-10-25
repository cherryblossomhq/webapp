import { existsSync, readFileSync } from "node:fs"
import { afterEach, beforeAll, describe, expect, it } from "vitest"
import glyphsBase from "../src/lib/kicadFont/glyphsBase"
import glyphsCjk from "../src/lib/kicadFont/glyphsCjk"
import { kicadFont, loadKicadFont } from "../src/lib/kicadFont/load"
import { effectivePenWidth, kiRound, knockoutMargin, layoutText, linebreakText, mmToIu, parseMarkup, setStrokeFont, splitLines, strokeFont, TEXT_RULES, type StrokeFontData, type TextAttrsIu } from "../src/lib/kicadText"
import { drawRotation } from "../src/model/texts"
import { drawAngle, fontFromGlyphStrings, glyphStringsOf, inkOf, markupRuns, newOverbar, penWidth } from "./kicad-census/texts.mjs"

// KiCad's text layout against the source: the pen, the justification, the overbar, line spacing, italic, mirror and the
// turn, first with a font made for the test (so the answers are known by arithmetic), then glyph by glyph with KiCad's own
// stroke font as shipped (`src/lib/kicadFont`, GPL-2.0-or-later with the SIL OFL 1.1 notice of its CJK glyphs) against the
// oracle in `tests/kicad-census/texts.mjs`, which lays text out again on its own and decodes the glyph strings by its own code.
// When KICAD_NEWSTROKE names a copy of KiCad's `common/newstroke_font.cpp`, the shipped data is also compared with that file.

afterEach(() => setStrokeFont(null))

/** A font for the test: every glyph one vertical bar at its left edge, `I` 10 wide and any other letter 20, the space 16. */
const bars: StrokeFontData = {
  name: "bars",
  glyph: (code) => (code === 32 ? { width: 16, strokes: [] } : { width: code === 73 ? 10 : 20, strokes: [[0, 1, 0, -20]] }),
}

const attrs = (over: Partial<TextAttrsIu> = {}): TextAttrsIu => ({ w: 1_000_000, h: 1_000_000, thickness: 150_000, bold: false, italic: false, mirror: false, hAlign: 0, vAlign: 0, lineSpacing: 1, ...over })
const at = (x = 0, y = 0, angle = 0) => ({ x, y, angle })

describe("pen width (EDA_TEXT::GetEffectiveTextPenWidth)", () => {
  it("is the thickness, or an eighth of the width, a fifth when bold, never more than a quarter of the size", () => {
    expect(effectivePenWidth(150_000, false, 1_000_000, 1_000_000)).toBe(150_000)
    expect(effectivePenWidth(0, false, 1_000_000, 1_000_000)).toBe(125_000)
    expect(effectivePenWidth(0, true, 1_000_000, 1_000_000)).toBe(200_000)
    expect(effectivePenWidth(1, false, 2_000_000, 1_000_000)).toBe(250_000)
    // bold multiplies a stored width by 1.6
    expect(effectivePenWidth(100_000, true, 1_000_000, 1_000_000)).toBe(160_000)
    // clamped to a quarter of the smaller size
    expect(effectivePenWidth(900_000, false, 1_000_000, 2_000_000)).toBe(250_000)
    expect(effectivePenWidth(900_000, true, 1_000_000, 2_000_000)).toBe(250_000)
  })
  it("agrees with the oracle", () => {
    for (const [thickness, bold, w, h] of [[0.15, false, 1, 1], [0, true, 1.27, 1], [0.1, true, 1, 1.5], [0.8, false, 0.5, 0.5], [0, false, 3, 2]] as const) {
      const iu = effectivePenWidth(mmToIu(thickness), bold, mmToIu(w), mmToIu(h))
      expect(Math.abs(iu / 1e6 - penWidth({ thickness, bold, w, h }))).toBeLessThan(2e-6)
    }
  })
  it("knockout margin is half the pen or a ninth of the height, the larger", () => {
    expect(knockoutMargin(1_000_000, 150_000)).toBe(111_111)
    expect(knockoutMargin(1_000_000, 400_000)).toBe(200_000)
  })
  it("KiROUND rounds half away from zero", () => {
    expect([kiRound(2.5), kiRound(-2.5), kiRound(2.4), kiRound(-2.4)]).toEqual([3, -3, 2, -2])
  })
})

describe("the angle a text is drawn at (PCB_TEXT::GetDrawRotation)", () => {
  it("keeps a part's text that keeps upright in ]-90, 90]", () => {
    expect([0, 45, 90, 91, 180, 270, 359, -90, -91].map((a) => drawRotation(a, true))).toEqual([0, 45, 90, -89, 0, 90, -1, 90, 89])
  })
  it("brings any other text into [0, 360)", () => {
    expect([0, 90, 180, 270, -90, 450].map((a) => drawRotation(a, false))).toEqual([0, 90, 180, 270, 270, 90])
  })
  it("agrees with the oracle", () => {
    for (const a of [-720, -271, -180, -90, -45, 0, 30, 90, 91, 135, 180, 225, 270, 315, 360, 450, 1000]) {
      for (const keep of [true, false]) expect(drawRotation(a, keep)).toBeCloseTo(drawAngle(a, keep), 9)
    }
  })
})

describe("markup (KiCad's markup_parser.h)", () => {
  const shape = (s: string) => JSON.stringify(parseMarkup(s).children.map(function show(n: ReturnType<typeof parseMarkup>): unknown {
    return n.type === "text" ? n.text : { [n.type]: n.children.map(show) }
  }))
  it("reads an overbar, a subscript and a superscript, nested", () => {
    expect(shape("A~{B}C")).toBe('["A",{"over":["B"]},"C"]')
    expect(shape("x_{1}^{2}")).toBe('["x",{"sub":["1"]},{"sup":["2"]}]')
    expect(shape("~{A_{b}}")).toBe('[{"over":["A",{"sub":["b"]}]}]')
  })
  it("keeps a marker with no closing brace as text, and an empty marker as nothing", () => {
    expect(shape("~{AB")).toBe('["~{AB"]')
    expect(shape("a~{}b")).toBe('["a","b"]')
  })
  it("keeps an {identifier} whole inside a marker, so its brace does not close it", () => {
    expect(shape("~{A{slash}B}C")).toBe('[{"over":["A{slash}B"]},"C"]')
  })
  it("keeps a link as text", () => {
    expect(shape("see https://x.y/z ok")).toBe('["see ","https://x.y/z"," ok"]')
  })
  it("agrees with the oracle's runs on a sample", () => {
    const flat = (s: string) => {
      const out: string[] = []
      const walk = (n: ReturnType<typeof parseMarkup>, sub: boolean, sup: boolean) => {
        const sb = sub || n.type === "sub"
        const sp = sup || n.type === "sup"
        if (n.type === "text") out.push(`${n.text}|${sb ? "s" : ""}${sp ? "p" : ""}`)
        n.children.forEach((c) => walk(c, sb, sp))
      }
      walk(parseMarkup(s), false, false)
      return out
    }
    for (const s of ["plain", "A~{B}C", "x_{1}^{2}", "~{A_{b}}", "~{AB", "a~{}b", "~{A{slash}B}C", "http://a.b/c d", "_{~{x}}y", "{x}~{y", "U1~{RST}", "~{~{a}}"]) {
      const o = markupRuns(s).runs.map((r) => `${r.s}|${r.sub ? "s" : ""}${r.sup ? "p" : ""}`)
      expect(flat(s), s).toEqual(o)
    }
  })
  it("converts the old overbar notation as KiCad does", () => {
    expect(newOverbar("~DSS~")).toBe("~{DSS}")
    expect(newOverbar("~~x")).toBe("~x")
    expect(newOverbar("~{x}")).toBe("~{x}")
    expect(newOverbar("~")).toBe("~")
  })
  it("splits lines as wxStringSplit does: a trailing empty line is dropped", () => {
    expect(splitLines("a\nb\n")).toEqual(["a", "b"])
    expect(splitLines("a\n\nb")).toEqual(["a", "", "b"])
    expect(splitLines("")).toEqual([])
  })
})

describe("layout with a font whose answers are known (stroke_font.cpp, font.cpp)", () => {
  const xs = (t: ReturnType<typeof layoutText>) => t.polylines.map((l) => l[0].x).sort((a, b) => a - b)
  it("advances by each glyph's width and a space by the space glyph's", () => {
    const r = layoutText("MI M", { x: 0, y: 0, angle: 0 }, attrs({ hAlign: -1, vAlign: -1 }), true, bars)
    // M at 0, I at 20/21, space 16/21, M at (20 + 10 + 16)/21; the text is left aligned, a little in from the anchor (pen / 1.52)
    const base = Math.trunc(150_000 / 1.52)
    expect(xs(r).map((x) => Math.round(x - base))).toEqual([0, 952_381, 2_190_476])
  })
  it("centres and right-aligns on the advance of the line", () => {
    const left = layoutText("MM", at(), attrs({ hAlign: -1 }), true, bars)
    const centre = layoutText("MM", at(), attrs({ hAlign: 0 }), true, bars)
    const right = layoutText("MM", at(), attrs({ hAlign: 1 }), true, bars)
    const advance = Math.round((40 / 21) * 1_000_000)
    expect(Math.abs(xs(centre)[0] + Math.trunc(advance / 2))).toBeLessThan(3)
    expect(Math.abs(xs(right)[0] + (advance + Math.trunc(150_000 / 1.52)))).toBeLessThan(3)
    expect(Math.round(xs(left)[0])).toBe(Math.trunc(150_000 / 1.52))
  })
  it("puts the glyph's origin one height below a top-aligned anchor, less a twentieth of the pen", () => {
    const top = layoutText("M", at(), attrs({ vAlign: -1 }), true, bars)
    const ys = top.polylines[0].map((p) => p.y)
    const oy = 1_000_000 - Math.trunc(150_000 * 0.052)
    // the bar runs from y = 1/21 to -20/21 of the height from the glyph's origin
    expect(Math.abs(Math.max(...ys) - (oy + 1_000_000 / 21))).toBeLessThan(2)
    expect(Math.abs(Math.min(...ys) - (oy - 20_000_000 / 21))).toBeLessThan(2)
  })
  it("slants an italic text by an eighth of the height, to the right above the baseline", () => {
    const plain = layoutText("M", at(), attrs({ italic: false }), true, bars)
    const slant = layoutText("M", at(), attrs({ italic: true }), true, bars)
    const [a, b] = plain.polylines[0]
    const [c, d] = slant.polylines[0]
    // the bottom point (y > 0 below the origin) leans left by y / 8 times the height, the top point (y < 0) right
    expect(Math.abs(d.x - b.x - (20_000_000 / 21) * TEXT_RULES.italicTilt)).toBeLessThan(2)
    expect(Math.abs(c.x - a.x + (1_000_000 / 21) * TEXT_RULES.italicTilt)).toBeLessThan(2)
  })
  it("mirrors about the anchor, so a left-aligned mirrored text lies to the left of it", () => {
    const m = layoutText("MM", at(), attrs({ hAlign: -1, mirror: true }), true, bars)
    expect(xs(m).every((x) => x <= 0)).toBe(true)
  })
  it("turns the text about its anchor, counter-clockwise on screen (y down)", () => {
    const r = layoutText("M", at(1_000_000, 2_000_000, 90), attrs({ hAlign: 0, vAlign: 0 }), true, bars)
    // turned a quarter turn, the bar that was vertical is horizontal
    const [a, b] = r.polylines[0]
    expect(Math.abs(a.y - b.y)).toBeLessThan(2)
    expect(Math.abs(a.x - b.x)).toBeGreaterThan(900_000)
  })
  it("draws an overbar over what the marker holds, 1.23 heights above the baseline, trimmed a tenth of the width each end", () => {
    const r = layoutText("M~{MM}", at(), attrs({ hAlign: -1, vAlign: -1 }), true, bars)
    const bar = r.polylines.find((l) => Math.abs(l[0].y - l[1].y) < 2 && l[0].x !== l[1].x)!
    expect(bar).toBeTruthy()
    const base = Math.trunc(150_000 / 1.52)
    const oy = 1_000_000 - Math.trunc(150_000 * 0.052)
    expect(Math.abs(bar[0].y - (oy - 1_230_000))).toBeLessThan(2)
    expect(Math.abs(bar[0].x - (base + (20 / 21) * 1_000_000 + 100_000))).toBeLessThan(2)
    expect(Math.abs(bar[1].x - (base + (60 / 21) * 1_000_000 - 100_000))).toBeLessThan(2)
  })
  it("sets sub and superscripts 0.8 of the size, shifted down 0.15 and up 0.35 of their height", () => {
    const sub = layoutText("_{M}", at(), attrs({ hAlign: -1, vAlign: -1 }), true, bars)
    const sup = layoutText("^{M}", at(), attrs({ hAlign: -1, vAlign: -1 }), true, bars)
    const plain = layoutText("M", at(), attrs({ hAlign: -1, vAlign: -1 }), true, bars)
    const len = (l: { y: number }[]) => Math.abs(l[0].y - l[1].y)
    expect(len(sub.polylines[0])).toBeCloseTo(len(plain.polylines[0]) * 0.8, -1)
    // the subscript sits lower (larger y), the superscript higher
    expect(sub.polylines[0][1].y).toBeGreaterThan(plain.polylines[0][1].y)
    expect(sup.polylines[0][1].y).toBeLessThan(plain.polylines[0][1].y)
  })
  it("spaces lines by 1.68 heights times 0.9583 and the line spacing, and justifies the block from its first line", () => {
    const two = layoutText("M\nM", at(), attrs({ hAlign: -1, vAlign: -1 }), true, bars)
    const ys = two.polylines.map((l) => l[0].y)
    expect(Math.abs(ys[1] - ys[0] - 1_000_000 * 1.68 * 0.9583)).toBeLessThan(2)
    const spaced = layoutText("M\nM", at(), attrs({ hAlign: -1, vAlign: -1, lineSpacing: 1.5 }), true, bars)
    // KiCad 9 and 10 lay a board text's or a text box's lines out without the line spacing (EDA_TEXT::GetInterline); the font itself uses it for a part's text
    expect(Math.abs(spaced.polylines[1][0].y - spaced.polylines[0][0].y - 1_000_000 * 1.68 * 0.9583)).toBeLessThan(2)
    const footprint = layoutText("M\nM", at(), attrs({ hAlign: -1, vAlign: -1, lineSpacing: 1.5 }), false, bars)
    const plain = layoutText("M\nM", at(), attrs({ hAlign: -1, vAlign: -1 }), false, bars)
    expect(footprint.polylines[1][0].y - footprint.polylines[0][0].y).toBeGreaterThan((plain.polylines[1][0].y - plain.polylines[0][0].y) * 1.4)
    // a block centred vertically has its middle on the anchor: the first line is half the extra lines' height higher than for a single line
    const one = layoutText("M", at(), attrs({ hAlign: -1, vAlign: 0 }), true, bars)
    const mid = layoutText("M\nM", at(), attrs({ hAlign: -1, vAlign: 0 }), true, bars)
    expect(Math.abs(mid.polylines[0][0].y - (one.polylines[0][0].y - Math.trunc((1_000_000 * 1.68 * 0.9583) / 2)))).toBeLessThan(3)
  })
  it("sets a tab on the next fourth column", () => {
    const r = layoutText("M\tM", at(), attrs({ hAlign: -1 }), true, bars)
    const [a, b] = xs(r)
    // M advances 20/21; the tab goes to column 4 = 4 widths on, with the space's width added by KiCad's own formula
    expect(Math.abs(b - a - Math.trunc(1_000_000 * 3 + 1_000_000 * (16 / 21)))).toBeLessThan(2)
  })
  it("a glyph the font lacks is drawn as `?`", () => {
    const font: StrokeFontData = { name: "q", glyph: (c) => (c === 63 ? { width: 20, strokes: [[0, 1, 0, -20]] } : undefined) }
    const r = layoutText("\u2603", at(), attrs(), true, font)
    expect(r.polylines).toHaveLength(1)
  })
  it("a part's own text lets the font split its lines; board text takes its line places from the text object: the same ink for one line", () => {
    const a = layoutText("MM", at(5_000_000, 5_000_000, 30), attrs({ hAlign: 1, vAlign: 1 }), true, bars)
    const b = layoutText("MM", at(5_000_000, 5_000_000, 30), attrs({ hAlign: 1, vAlign: 1 }), false, bars)
    a.polylines.forEach((l, i) => l.forEach((p, j) => expect(Math.abs(p.x - b.polylines[i][j].x) + Math.abs(p.y - b.polylines[i][j].y)).toBeLessThan(3)))
  })
  it("wraps a text box's text at the column width, only at spaces", () => {
    const text = "MM MM MM"
    // each word is 40/21 high (1.9 mm); a column of 5 mm holds two words with their space
    const wrapped = linebreakText(text, 5_000_000, { w: 1_000_000, h: 1_000_000, italic: false, bold: false }, 150_000, bars)
    expect(wrapped).toBe("MM MM\nMM")
    expect(linebreakText("MMMMMM", 1_000_000, { w: 1_000_000, h: 1_000_000, italic: false, bold: false }, 0, bars)).toBe("MMMMMM")
    expect(linebreakText("MM MM", 100_000_000, { w: 1_000_000, h: 1_000_000, italic: false, bold: false }, 0, bars)).toBe("MM MM")
  })
})

describe("the editor's own letters on KiCad's cell", () => {
  it("is the font until KiCad's own may be shipped, and is as high as KiCad's caps", () => {
    expect(strokeFont().name).toBe("editor")
    const r = layoutText("H", at(), attrs({ hAlign: -1, vAlign: -1 }), true)
    const ys = r.polylines.flat().map((p) => p.y)
    // the cap height is 21/21 of the text height, the baseline one unit below the glyph origin
    expect((Math.max(...ys) - Math.min(...ys)) / 1_000_000).toBeGreaterThan(0.9)
    expect((Math.max(...ys) - Math.min(...ys)) / 1_000_000).toBeLessThan(1.1)
  })
})

describe("KiCad's stroke font, as shipped", () => {
  beforeAll(() => loadKicadFont({ cjk: true }))
  const strings = () => [...glyphsBase.split("\n"), ...glyphsCjk.split("\n")]

  it("has a glyph for each code point of KiCad's table, from the space to U+FFEE", () => {
    expect(glyphsBase.split("\n")).toHaveLength(0x3000 - 0x20)
    expect(strings()).toHaveLength(0xffee - 0x20 + 1)
  })
  it("keeps KiCad's licence header beside the data", () => {
    for (const file of ["glyphsBase.ts", "glyphsCjk.ts"]) {
      const text = readFileSync(`src/lib/kicadFont/${file}`, "utf8")
      expect(text).toMatch(/GNU General Public License/)
      expect(text).toMatch(/vladimir uryvaev/)
      expect(text).toMatch(/SIL OPEN FONT LICENSE Version 1\.1/)
    }
  })
  it("decodes known glyphs as KiCad's loader does: the advance, and y with the baseline at 1", () => {
    const f = kicadFont()!
    const space = f.glyph(32)!
    expect(space.width).toBe(16)
    expect(space.strokes).toEqual([])
    const cap = (c: string) => f.glyph(c.charCodeAt(0))!
    const ys = cap("H").strokes.flat().filter((_, i) => i % 2 === 1)
    expect(Math.max(...ys)).toBe(1)
    expect(Math.min(...ys)).toBe(-20)
    expect(cap("I").width).toBeLessThan(cap("W").width)
    expect(f.glyph(0x3042)?.strokes.length).toBeGreaterThan(0)
    expect(f.glyph(0x10000)).toBeUndefined()
  })
  it("agrees with the oracle's own decoding of the same strings, glyph by glyph", () => {
    const f = kicadFont()!
    const o = fontFromGlyphStrings(strings())
    for (let c = 0x20; c < 0x20 + o.glyphs.length; c += 7) {
      const g = f.glyph(c)!
      expect(g.width).toBe(o.glyphs[c - 0x20].width)
      expect(g.strokes).toEqual(o.glyphs[c - 0x20].strokes.map((st: number[][]) => st.flat()))
    }
  })
  it.skipIf(!process.env.KICAD_NEWSTROKE || !existsSync(process.env.KICAD_NEWSTROKE))("is KiCad's newstroke_font.cpp, entry for entry (KICAD_NEWSTROKE)", () => {
    const theirs = glyphStringsOf(readFileSync(process.env.KICAD_NEWSTROKE!, "utf8"))
    expect(strings()).toEqual(theirs)
  })
})

describe("against the oracle, glyph by glyph, with KiCad's stroke font", () => {
  beforeAll(() => loadKicadFont({ cjk: true }))
  const font = fontFromGlyphStrings([...glyphsBase.split("\n"), ...glyphsCjk.split("\n")])
  const asData = (): StrokeFontData => kicadFont()!

  function same(a: { x: number; y: number }[][], b: number[][][], eps = 0.001) {
    expect(a.length).toBe(b.length)
    const used = new Array(b.length).fill(false)
    for (const line of a) {
      let hit = -1
      for (let i = 0; i < b.length && hit < 0; i++) {
        if (used[i] || b[i].length !== line.length) continue
        if (line.every((p, k) => Math.abs(p.x / 1e6 - b[i][k][0]) <= eps && Math.abs(p.y / 1e6 - b[i][k][1]) <= eps)) hit = i
      }
      expect(hit, JSON.stringify(line[0])).toBeGreaterThanOrEqual(0)
      used[hit] = true
    }
  }

  const cases: { text: string; over?: Partial<TextAttrsIu>; angle?: number; multiline?: boolean }[] = [
    { text: "R1" },
    { text: "Hello, World 0123456789 ~!@#$%^&*()_+-=[]{}|;:'\",./<>?" },
    { text: "abcdefghijklmnopqrstuvwxyz ABCDEFGHIJKLMNOPQRSTUVWXYZ" },
    { text: "GND", over: { hAlign: -1, vAlign: -1 } },
    { text: "GND", over: { hAlign: 1, vAlign: 1 } },
    { text: "GND", over: { hAlign: 0, vAlign: -1, mirror: true } },
    { text: "GND", over: { hAlign: -1, vAlign: 1, mirror: true }, angle: 33.5 },
    { text: "RESET\u0305 ~{RESET} ~{A}B~{CD}", over: { italic: true } },
    { text: "H_{2}O x^{2} ~{a_{b}}", over: { bold: true, thickness: 0 } },
    { text: "line one\nline two\n\nline four", over: { hAlign: 0, vAlign: 0 }, multiline: true },
    { text: "line one\nline two", over: { hAlign: 1, vAlign: 1, lineSpacing: 1.3 }, angle: 90, multiline: false },
    { text: "line one\nline two\nthree", over: { hAlign: -1, vAlign: 1, mirror: true, italic: true }, angle: 217, multiline: true },
    { text: "tab\there\tx", over: { hAlign: -1 } },
    { text: "wide", over: { w: 2_000_000, h: 1_000_000 } },
    { text: "tall", over: { w: 1_000_000, h: 3_000_000, thickness: 200_000 }, angle: 180 },
    { text: "\u00e9\u00e8\u00fc\u00df\u00b1\u00b0\u00b5\u03a9" },
    { text: "\u4e2d\u6587" },
  ]
  cases.forEach((c, i) => {
    it(`case ${i + 1}: ${JSON.stringify(c.text).slice(0, 36)}`, () => {
      setStrokeFont(asData())
      const a = attrs(c.over)
      const angle = c.angle ?? 0
      const x = 12_345_678
      const y = -7_654_321
      const mine = layoutText(c.text, { x, y, angle }, a, c.multiline ?? true)
      const theirs = inkOf(font, c.text, { x: x / 1e6, y: y / 1e6, w: a.w / 1e6, h: a.h / 1e6, thickness: a.thickness / 1e6, bold: a.bold, italic: a.italic, mirror: a.mirror, hj: a.hAlign, vj: a.vAlign, spacing: a.lineSpacing }, angle, c.multiline ?? true)
      same(mine.polylines, theirs.strokes)
      expect(Math.abs(mine.pen / 1e6 - theirs.pen)).toBeLessThan(2e-6)
    })
  })
})
