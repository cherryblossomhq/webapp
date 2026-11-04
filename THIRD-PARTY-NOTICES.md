# Third-Party Notices

Cherry Blossom's own source is licensed under the AGPL-3.0-or-later — see
[LICENSE](LICENSE). It also bundles and builds on open source software owned by
others. This file carries the attribution those licenses require; it is a legal
notice, not an endorsement or a statement of affiliation.

## Bundled into the app

| Package | Used for | License |
|---|---|---|
| [React](https://github.com/facebook/react) | The UI | MIT |
| [three.js](https://github.com/mrdoob/three.js) | The 3D view | MIT |
| [occt-import-js](https://github.com/kovacsv/occt-import-js) (OpenCascade) | Reading STEP models | LGPL-2.1 |
| [Clipper2](https://github.com/AngusJohnson/Clipper2), as [`@countertype/clipper2-ts`](https://www.npmjs.com/package/@countertype/clipper2-ts) | Copper pours | BSL-1.0 |
| [polygon-clipping](https://github.com/mfogel/polygon-clipping) | Board and pour geometry | MIT |
| [earcut](https://github.com/mapbox/earcut) | Triangulating the 3D board | ISC |
| [tscircuit](https://github.com/tscircuit) packages: `@tscircuit/footprinter`, `@tscircuit/circuit-json-util`, `circuit-json`, `circuit-json-to-kicad`, `kicadts`, `schematic-symbols`, `format-si-unit` | Footprints, Circuit JSON, the KiCad export | MIT / ISC |
| [JSZip](https://github.com/Stuk/jszip) | Zipped exports | MIT (dual MIT / GPL-3.0, used under MIT) |
| [Zustand](https://github.com/pmndrs/zustand) | Editor state | MIT |
| [Lucide](https://github.com/lucide-icons/lucide) | Icons | ISC |
| [transformation-matrix](https://github.com/chrvadala/transformation-matrix) | Canvas transforms | MIT |
| [Geist and Geist Mono](https://github.com/vercel/geist-font), via Fontsource | The UI typefaces | SIL OFL 1.1 |

**occt-import-js is LGPL-2.1.** It ships as its own WebAssembly file, loaded in
a worker only when a STEP model is first drawn, and is never inlined into the
editor's bundle — so it stays a separate, replaceable library, as the LGPL asks.
Its source is at <https://github.com/kovacsv/occt-import-js>.

## From KiCad

The KiCad import and export draw text and read files exactly as KiCad does, so
some of this repository is KiCad's own work, ported or carried over. It is used
under its licence, the GPL-2.0-or-later, here under version 3, which allows its
combination with this repository's AGPL-3.0-or-later (GPL-3.0, section 13).
Each file keeps its original notice at its head.

| Files | From | License |
|---|---|---|
| `src/lib/kicadFont/glyphsBase.ts` | KiCad's stroke font, `common/newstroke_font.cpp`: Copyright (C) 2010 vladimir uryvaev and the KiCad Developers | GPL-2.0-or-later |
| `src/lib/kicadFont/glyphsCjk.ts` | The same font's CJK glyphs: KiCad's, drawn with code by Lingdong Huang (MIT) from [Source Han Sans](https://github.com/adobe-fonts/source-han-sans), Copyright 2014-2019 Adobe | GPL-2.0-or-later; the glyph outlines SIL OFL 1.1 |
| `src/model/kicad/schematic/legacy/` | Ports of KiCad's legacy schematic and library readers (`sch_legacy_plugin.cpp`, `transform.cpp`): Copyright (C) 2016 CERN and the KiCad Developers | GPL-2.0-or-later |
| `src/lib/kicadText.ts`, `src/model/texts.ts`, `src/model/dimensions.ts`, `src/model/kicad/board/` (texts, dimensions, groups, images), `src/export/kicadTexts.ts`, `src/export/kicadObjects.ts`, and the test oracles `tests/kicad-census/texts.mjs` and `dimensions.mjs` | Ports of KiCad's text layout, dimensions, groups and reference images: the KiCad Developers | GPL-2.0-or-later |

The KiCad source these follow is at <https://gitlab.com/kicad/code/kicad>.
`src/model/kicad/board/stockModels.ts` lists the names of the STEP models in
KiCad's 3D library, which a host serves; no model is bundled here.

## Test data

`tests/fixtures/kicad/` holds unmodified files from the
[KiCad libraries](https://www.kicad.org/libraries/license/), under CC BY-SA 4.0
with the KiCad libraries exception — see the
[`LICENSE.md`](tests/fixtures/kicad/LICENSE.md) beside them. They are test data:
nothing there is served or bundled.

## MIT License text

The MIT-licensed packages above require their copyright notice and this
permission notice to be reproduced in any distribution that includes them. Each
package's own copyright line is in its `LICENSE` file under `node_modules/`.

```
Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

For the full breakdown of an installed tree:

```bash
npx license-checker --summary
```

Trademarks referenced here belong to their respective owners. Their use in this
file is for attribution only.
