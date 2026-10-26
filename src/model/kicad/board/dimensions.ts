// Ported from KiCad (https://gitlab.com/kicad/code/kicad): `PCB_IO_KICAD_SEXPR_PARSER::parseDIMENSION` and the constructors of the dimension classes
// (pcbnew/pcb_io/kicad_sexpr/pcb_io_kicad_sexpr_parser.cpp, pcbnew/pcb_dimension.cpp); the reader (`read.ts`) applies them, this turns what it read into the editor's dimension.
// Copyright The KiCad Developers, see AUTHORS.txt for contributors. This program source code file is part of KiCad, a free EDA CAD application. This program is free
// software; you can redistribute it and/or modify it under the terms of the GNU General Public License as published by the Free Software Foundation; either version 2
// of the License, or (at your option) any later version. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the
// implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU General Public License for more details. You should have received a copy of
// the GNU General Public License along with this program; if not, see <https://www.gnu.org/licenses/>.

import { DEFAULT_EXTENSION_HEIGHT_IU } from "../../dimensions"
import { isTextLayer } from "../../texts"
import type { BoardDimension } from "../../types"
import { resolveLayer } from "./graphics"
import { convertBoardText } from "./texts"
import type { KicadBoard, KicadDimension } from "./types"

const r6 = (n: number) => {
  const v = Math.round(n * 1e6) / 1e6
  return Object.is(v, -0) ? 0 : v
}

export interface DimensionConversion {
  board: KicadBoard
  /** What cannot be held, by reason. */
  lose: (what: string) => void
}

/** The size KiCad gives a text it is not given one for (60 mils), and the arrow length a radial dimension's default leader is three of (50 mils). */
const DEFAULT_TEXT_SIZE = 1.524
const DEFAULT_ARROW = 1.27

/** A dimension of the file as the editor's, or null when it cannot be one (said through `lose`). `id` is the id it gets. */
export function convertDimension(k: KicadDimension, cx: DimensionConversion, id: string): BoardDimension | null {
  const r = resolveLayer(cx.board, k.layer)
  if (r.kind === "unknown") {
    cx.lose(`a dimension on the layer "${k.layer}", which is not one of KiCad's`)
    return null
  }
  if (r.kind === "inner") {
    cx.lose(`a dimension on ${k.layer}, a copper layer the board's layer table does not list`)
    return null
  }
  if (!isTextLayer(r.name)) {
    cx.lose(`a dimension on the layer "${k.layer}", which the editor does not draw on`)
    return null
  }
  if (k.units === 4) {
    cx.lose("a KiCad 5 dimension whose text names a unit other than inches, mils or millimetres")
    return null
  }
  // The text: its own place, size and flags, by the rules of any board text (a font other than KiCad's is X19's). A centre mark has none.
  let at = { x: k.start.x, y: -k.start.y }
  let rot = 0
  let attrs: Pick<BoardDimension, "size" | "w" | "tw" | "bold" | "italic" | "mirror" | "hj" | "vj" | "spacing"> = { size: DEFAULT_TEXT_SIZE }
  if (k.text) {
    const t = convertBoardText(k.text, { board: cx.board, lose: cx.lose, where: "a dimension" }, "")
    if (!t) return null
    at = { x: t.x, y: t.y }
    rot = t.rot
    attrs = {
      size: t.size,
      ...(t.w !== undefined ? { w: t.w } : {}),
      ...(t.thickness !== undefined ? { tw: t.thickness } : {}),
      ...(t.bold ? { bold: true as const } : {}),
      ...(t.italic ? { italic: true as const } : {}),
      ...(t.mirror ? { mirror: true as const } : {}),
      ...(t.hj ? { hj: t.hj } : {}),
      ...(t.vj ? { vj: t.vj } : {}),
      ...(t.spacing !== undefined ? { spacing: t.spacing } : {}),
    }
  }
  const aligned = k.kind === "aligned" || k.kind === "orthogonal"
  const leaderLength = k.leaderLength ?? 3 * DEFAULT_ARROW
  return {
    id,
    kind: k.kind,
    layer: r.name,
    a: { x: r6(k.start.x), y: r6(-k.start.y) },
    b: { x: r6(k.end.x), y: r6(-k.end.y) },
    ...(aligned && k.height !== 0 ? { height: r6(k.height) } : {}),
    ...(k.kind === "orthogonal" && k.vertical ? { vertical: true as const } : {}),
    extHeight: r6(k.extensionHeight ?? DEFAULT_EXTENSION_HEIGHT_IU / 1e6),
    extOffset: r6(k.extensionOffset),
    ...(k.kind === "radial" ? { leaderLength: r6(leaderLength) } : {}),
    ...(k.kind === "leader" && k.frame > 0 ? { frame: k.frame as 1 | 2 | 3 } : {}),
    thickness: r6(k.thickness),
    arrow: r6(k.arrowLength),
    ...(k.inward ? { inward: true as const } : {}),
    ...(k.textMode === 1 || k.textMode === 2 ? { textMode: k.textMode } : {}),
    ...(k.keep ? { keep: true as const } : {}),
    units: k.units ?? 3,
    format: k.format,
    precision: k.precision,
    ...(k.zeros ? { zeros: true as const } : {}),
    ...(k.prefix !== "" ? { prefix: k.prefix } : {}),
    ...(k.suffix !== "" ? { suffix: k.suffix } : {}),
    ...(k.override !== null && k.kind !== "center" ? { override: k.override } : {}),
    x: r6(at.x),
    y: r6(at.y),
    rot: r6(rot),
    ...attrs,
    ...(k.locked ? { locked: true as const } : {}),
  }
}
