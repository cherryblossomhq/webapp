import { getFootprint, isValidFootprint } from "../footprints"
import { landPads } from "./build"
import { describeLand, summarizeLand } from "./land"

// Footprinter names that draw something other than the package they name. Each was measured
// against the footprinter itself, and each refusal says what the name draws, in millimetres,
// and the spelling that draws the real package:
//
// - `dfn8` draws a SOIC-8 land (1.27 mm pitch, rows 4.3 mm apart). A real DFN-8 is 2 to 3 mm.
// - `ssopN` draws 1.27 mm pitch; SSOP is 0.65 mm.
// - `tssopN` draws 0.5 mm pitch; TSSOP is 0.65 mm.
// - `msop8` and `msop10` number their second row top to bottom, so on `msop10` pin 6 sits
//   opposite pin 1, where pin 10 belongs: every pin on that side but the middle one lands on the
//   wrong lead. The footprinter's `vssop8` and `vssop10` draw the same pads numbered the right
//   way round.
// - `qfnN` and `sonN` with no body size draw one arbitrary size of a family that comes in many.

interface Rule {
  test: RegExp
  /** Why, with the measured land filled in, and what to write instead. */
  advice: (name: string, n: string) => string
}

const RULES: Rule[] = [
  {
    // Sized but without pad sizes it draws 1 x 0.6 mm pads on a 0.5 mm pitch, which overlap.
    test: /^dfn(\d+)(?!.*_pw\d)/,
    advice: (_name, n) =>
      `A DFN needs its body size, pitch and pad size, e.g. dfn${n}_w2.5_h2.5_p0.5mm_pl0.5mm_pw0.25mm; better, take the supplier's land (pass lcsc).`,
  },
  {
    test: /^ssop(\d+)(?!.*_p\d)/,
    advice: (_name, n) => `SSOP is 0.65 mm pitch: write ssop${n}_p0.65mm, or take the supplier's land (pass lcsc).`,
  },
  {
    test: /^tssop(\d+)(?!.*_p\d)/,
    advice: (_name, n) => `TSSOP is 0.65 mm pitch: write tssop${n}_p0.65mm, or take the supplier's land (pass lcsc).`,
  },
  {
    test: /^msop(\d+)/,
    advice: (_name, n) =>
      `Its second row is numbered top to bottom, so pin ${Number(n) / 2 + 1} sits opposite pin 1, where pin ${n} belongs: write vssop${n}, the same pads numbered the right way round.`,
  },
  {
    test: /^(qfn|son)(\d+)(?!.*_w\d)/,
    advice: (name) => {
      const n = name.match(/\d+/)?.[0] ?? ""
      return `QFN and SON come in many sizes: give the body and pitch, e.g. qfn${n}_w4_h4_p0.65mm (add _thermalpad for the exposed pad), or take the supplier's land (pass lcsc).`
    },
  },
]

/**
 * Why a footprint name can't be trusted to draw the package it names, with the land it does
 * draw in numbers, or null when the name is fine.
 */
export function footprintNameProblem(name: string): string | null {
  const fp = name.trim().toLowerCase()
  for (const rule of RULES) {
    const m = fp.match(rule.test)
    if (!m) continue
    const drawn = isValidFootprint(name) ? describeLand(summarizeLand(landPads(getFootprint(name).pads))) : "nothing"
    return `${name} draws ${drawn}. ${rule.advice(fp, m[m.length - 1])}`
  }
  return null
}
