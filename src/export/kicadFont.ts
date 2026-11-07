// KiCad's stroke font (newstroke), as far as the export needs it: how wide a line of text is and how far apart its
// lines are, so a text drawn in the editor can be written to take the room it takes on the editor's sheet.

/**
 * The advance of each printable ASCII character (space to `~`), in 21sts of the font's width, which is how newstroke
 * spaces its glyphs. Measured from kicad-cli 10's SVG plot: the width of 30 of a character less the width of 10.
 */
const ASCII_ADVANCE = [
  16, 10, 16, 21, 20, 24, 26, 10, 14, 14, 16, 26, 10, 26, 10, 22, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 10, 10, 26, 26, 26, 18, 27, 18, 21, 21, 21, 19, 18, 21, 22, 10, 16, 21, 17, 24, 22, 22, 21, 22, 21, 20, 16, 22, 18, 24,
  20, 18, 20, 14, 14, 14, 12, 16, 8, 19, 19, 18, 19, 18, 12, 19, 19, 10, 10, 17, 11, 28, 19, 19, 19, 19, 13, 17, 12, 19, 16, 22, 17, 16, 17, 14, 20, 14, 15,
]

/** Ideographs and full-width forms, which newstroke draws 31 wide (中, 文). */
const WIDE = /[⺀-鿿가-힯豈-﫿＀-￯]/

/** The distance between the baselines of two lines, as a share of the text's height (KiCad's `INTERLINE_PITCH_RATIO`). */
export const KICAD_LINE_PITCH = 1.61

function advance(ch: string): number {
  const code = ch.codePointAt(0) ?? 0
  if (code >= 32 && code <= 126) return ASCII_ADVANCE[code - 32]
  // An accented letter is as wide as its letter (é as e); anything else the size of a capital.
  const base = ch.normalize("NFD")[0]
  if (base !== ch) return advance(base)
  return WIDE.test(ch) ? 31 : 21
}

/** How wide KiCad draws a line of text whose glyphs are `width` wide (the second number of a font's `size`). */
export function kicadTextWidth(line: string, width: number): number {
  let units = 0
  for (const ch of line) units += advance(ch)
  return (units / 21) * width
}
