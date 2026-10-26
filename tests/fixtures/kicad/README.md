# KiCad library fixtures

Unmodified copies of files from the KiCad Official Libraries, release 10.0.7
([kicad-symbols](https://gitlab.com/kicad/libraries/kicad-symbols) and
[kicad-footprints](https://gitlab.com/kicad/libraries/kicad-footprints)), kept in KiCad's own
layout (`symbols/<Library>.kicad_symdir/<Symbol>.kicad_sym`, `footprints/<Library>.pretty/<Footprint>.kicad_mod`)
so the converter reads them as it reads the full libraries. Symbols that `extend` another come with
their base.

They are CC BY-SA 4.0 with the KiCad libraries exception, as `LICENSE.md` says. They are test
data: nothing here is served or bundled.

What each is for is in `tests/kicad-convert.test.ts`: an LDO with a tab, a TQFP and a QFN with
exposed pads, multi-unit op-amps, a wildcard-named STM32, DIP through-hole parts, a castellated
module, a BGA numbered A1 to C3, a connector with slots and non-plated holes, a land with turned
pads, and symbols that are skipped for each reason a symbol can be.
