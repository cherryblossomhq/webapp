// Ported from KiCad (https://gitlab.com/kicad/code/kicad): the end of `PCB_IO_KICAD_SEXPR_PARSER::parsePCB_REFERENCE_IMAGE`
// (pcbnew/pcb_io/kicad_sexpr/pcb_io_kicad_sexpr_parser.cpp, master line 4418), where an image of a file older than 20260623 is rescaled by the ratio of the two
// resolutions KiCad has derived from the embedded picture, and `REFERENCE_IMAGE`'s size (common/reference_image.cpp, common/bitmap_base.cpp).
// Copyright The KiCad Developers, see AUTHORS.txt for contributors. This program source code file is part of KiCad, a free EDA CAD application. This program is free
// software; you can redistribute it and/or modify it under the terms of the GNU General Public License as published by the Free Software Foundation; either version 2
// of the License, or (at your option) any later version. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the
// implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU General Public License for more details. You should have received a copy of
// the GNU General Public License along with this program; if not, see <https://www.gnu.org/licenses/>.

import type { ReferenceImage } from "../../types"
import { isTextLayer } from "../../texts"
import { resolveLayer } from "./graphics"
import { sha256Hex } from "../../../lib/imageFacts"
import type { KicadBoard, KicadImage } from "./types"

const r6 = (n: number) => {
  const v = Math.round(n * 1e6) / 1e6
  return Object.is(v, -0) ? 0 : v
}

/** From this stamp KiCad derives an image's resolution without truncating pixels per centimetre; an older file's scale was made for the truncated one. */
export const IMAGE_PPI_FIX_FROM = 20260623

export interface ImageConversion {
  board: KicadBoard
  lose: (what: string) => void
}

/** The bytes of an image the project holds, kept by their SHA-256 (what the host's model file store names them by). */
export interface KeptFile {
  id: string
  name: string
  bytes: Uint8Array
}

/**
 * A reference image as the editor's: where its centre is, its layer, KiCad's scale of it and the resolution it is drawn at. Every KiCad draws an image the same size for
 * a file: pixels over the resolution it derives, times the scale. A file older than the fix has a scale made for the truncated resolution, which KiCad 10 (and 9) still derive,
 * so the project's resolution is that one and the scale is the file's, exactly. A newer file's resolution is the exact one. Returns the image and the file to keep.
 */
export function convertImage(k: KicadImage, cx: ImageConversion, id: string): { image: ReferenceImage; file: KeptFile } | null {
  if (k.format === null) {
    cx.lose("a reference image that is neither a PNG nor a JPEG")
    return null
  }
  const r = resolveLayer(cx.board, k.layer)
  if (r.kind === "unknown" || r.kind === "inner" || !isTextLayer(r.name)) {
    cx.lose(`a reference image on the layer "${k.layer}", which the editor does not draw on`)
    return null
  }
  const old = cx.board.version !== null && cx.board.version < IMAGE_PPI_FIX_FROM
  const sha = sha256Hex(k.data)
  return {
    image: {
      id,
      x: r6(k.at.x),
      y: r6(-k.at.y),
      layer: r.name,
      scale: k.scale,
      file: sha,
      format: k.format,
      px: k.px,
      py: k.py,
      ppi: old ? k.legacyPpi : k.ppi,
      ...(k.locked ? { locked: true as const } : {}),
    },
    file: { id: sha, name: `reference-image.${k.format}`, bytes: k.data },
  }
}
