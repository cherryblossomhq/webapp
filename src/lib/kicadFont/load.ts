import { setStrokeFont, type StrokeFontData, type StrokeGlyph } from "../kicadText"

// KiCad's own stroke font (`common/newstroke_font.cpp` of KiCad, GPL-2.0-or-later with the SIL OFL 1.1 notice of its
// CJK glyphs; the licence header stays at the top of each data file). The data is in two modules that are only
// imported when a project has KiCad text, so the editor's own bundle does not carry them: `glyphsBase` (U+0020 to
// U+2FFF: Latin, Greek, Cyrillic, symbols; 231 KB, about 26 KB compressed) and `glyphsCjk` (U+3000 to U+FFEE;
// 2.25 MB, about 800 KB compressed), which is imported only when a text uses a character from it.
//
// A glyph is KiCad's string: `<left><right>` then pairs of letters, ` R` lifting the pen. Every letter is the code of
// `R` plus a number (`stroke_font.cpp`, `STROKE_FONT::loadNewStrokeFont`): the advance is `right - left`, a point is
// `(x - left, y + FONT_OFFSET)` with `FONT_OFFSET` -8. The glyph of code point c is entry `c - 0x20` of the whole table.

const R = 82
const FONT_OFFSET = -8
const CJK_FROM = 0x3000
const TABLE_END = 0x10000

function decode(s: string): StrokeGlyph {
  const left = s.charCodeAt(0) - R
  const right = s.charCodeAt(1) - R
  const strokes: number[][] = []
  let run: number[] = []
  for (let i = 2; i + 1 < s.length; i += 2) {
    if (s[i] === " " && s[i + 1] === "R") {
      if (run.length) strokes.push(run)
      run = []
      continue
    }
    run.push(s.charCodeAt(i) - R - left, s.charCodeAt(i + 1) - R + FONT_OFFSET)
  }
  if (run.length) strokes.push(run)
  return { width: right - left, strokes }
}

let base: string[] | null = null
let cjk: string[] | null = null
let loading: Promise<void> | null = null
let loadingCjk: Promise<void> | null = null
let current: StrokeFontData | null = null

/** KiCad's font over the glyph tables that are loaded; a code point whose table is not loaded has no glyph (the layout then draws `?`, as KiCad does for a code outside its table). */
function build(): StrokeFontData {
  const cache = new Map<number, StrokeGlyph>()
  const haveBase = base
  const haveCjk = cjk
  return {
    name: "newstroke",
    glyph(code: number) {
      if (code < 0x20 || code >= TABLE_END) return undefined
      let g = cache.get(code)
      if (g) return g
      const entry = code < CJK_FROM ? haveBase?.[code - 0x20] : haveCjk?.[code - CJK_FROM]
      if (entry === undefined) return undefined
      g = decode(entry)
      cache.set(code, g)
      return g
    },
  }
}

/** KiCad's font as loaded (null before `loadKicadFont`), for a caller that puts the editor's font back and wants KiCad's again. */
export const kicadFont = () => current

/** Whether KiCad's font is loaded (the Latin tables at least). */
export const kicadFontLoaded = () => base !== null

/** Whether the CJK tables are loaded. */
export const kicadCjkLoaded = () => cjk !== null

/** Whether a text needs glyphs of the CJK table. */
export const needsCjk = (text: string) => {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (c >= CJK_FROM && c <= 0xffee) return true
  }
  return false
}

/**
 * Load KiCad's font (and its CJK glyphs when `cjk` says so) and make it the font KiCad texts are laid out with. Safe to call
 * again; the data is fetched once. Every cache that holds ink is keyed on the font object, so the new one redraws them.
 */
export async function loadKicadFont(options: { cjk?: boolean } = {}): Promise<void> {
  const had = [base, cjk]
  if (!base) {
    loading ??= import("./glyphsBase").then((m) => {
      base = m.default.split("\n")
    })
    await loading
  }
  if (options.cjk && !cjk) {
    loadingCjk ??= import("./glyphsCjk").then((m) => {
      cjk = m.default.split("\n")
    })
    await loadingCjk
  }
  if (base !== had[0] || cjk !== had[1] || !current) {
    current = build()
    setStrokeFont(current)
  }
}
