// Ported from KiCad (https://gitlab.com/kicad/code/kicad): `PCB_IO_KICAD_SEXPR::format` of texts, text boxes and fields (pcbnew/pcb_io/kicad_sexpr/pcb_io_kicad_sexpr.cpp) and the format the parser reads (pcb_io_kicad_sexpr_parser.cpp).
// Copyright The KiCad Developers, see AUTHORS.txt for contributors. This program source code file is part of KiCad, a free EDA
// CAD application. This program is free software; you can redistribute it and/or modify it under the terms of the GNU General
// Public License as published by the Free Software Foundation; either version 2 of the License, or (at your option) any later
// version. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied
// warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU General Public License for more details. You
// should have received a copy of the GNU General Public License along with this program; if not, see
// <https://www.gnu.org/licenses/>.

import { round } from "../lib/geometry"
import { kiRound, mmToIu } from "../lib/kicadText"
import { findPart } from "../model/library"
import { isPhysical } from "../model/instances"
import type { WorldText } from "../model/texts"
import { isDimensionText, shownOf, textBoxCorners, worldTexts } from "../model/texts"
import type { Project, Vec2 } from "../model/types"
import { KICAD_PAGE_ORIGIN, localFrame } from "./kicadShapes"

// The texts of a board brought in from KiCad, written into the board file the converter made: board text as
// `gr_text` and `gr_text_box`, and each part's reference, value and own text as the footprint's `property`
// and `fp_text` items (the converter's own, which say less, are taken out for a part that has texts of its own).
// They go in as text after the converter has run, as the drawings do, so a board with no text of this kind
// is written byte for byte as before.
//
// A part's text is written in the footprint's own frame (the converter's way for pads), with the angle it has on
// the board and its layer on the board. A text box is written in the board's frame as KiCad 9 stores it: the rectangle
// as it is drawn (`start` and `end` are the corners of its box, so a box turned a quarter is its turned rectangle) and the
// text's angle, as `PCB_TEXTBOX::GetAnchorAndOppositeCorner` of 9.0.0 reads it; a box turned by any other angle is a
// polygon, `(pts)`, as KiCad 9 writes it. KiCad 9 has no knockout for a text box (its parser has no such node and refuses a
// word after the layer name, parser 9.0.0 lines 3617-3620), so a box with knockout is written without it and a note says so.
// The file is KiCad 9's (stamp 20241229), where a bold text's stored thickness is the one it is drawn with, so a bold
// text's is written multiplied by 1.6 (`BOLD_STROKE_MULTIPLIER`).

const mm6 = (n: number) => String(round(n, 6) || 0)
const xy = (p: Vec2) => `${mm6(p.x)} ${mm6(p.y)}`
export const quote = (text: string) => `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r?\n/g, "\\n").replace(/\t/g, "\\t")}"`

/** KiCad's numbers for the user layers it has to be told about (`kicadShapes.ts`). */
const userLayerNumber = (name: string): number | null => {
  const m = name.match(/^User\.(\d+)$/)
  if (!m) return null
  const n = Number(m[1])
  return n <= 9 ? 49 + n : 50 + n
}

export interface KicadTexts {
  text: string
  notes: string[]
  /** The id each text was written with, by what the editor selects it by (`x:<id>`, `p:<part>:<place>`): a group names its members by them. */
  uuids: Map<string, string[]>
}

/** The thickness a text is written with: its stored base, which a bold stroke text is multiplied from, as that file format stores it. */
function writtenThickness(t: WorldText): number | null {
  if (t.thickness <= 0) return null
  const iu = mmToIu(t.thickness)
  if (iu <= 1) return null
  return (t.bold ? kiRound(iu * 1.6) : iu) / 1e6
}

export function effects(t: WorldText, mirror: boolean, hide: boolean, href?: string): string[] {
  const thickness = writtenThickness(t)
  const justify = [t.hj === -1 ? "left" : t.hj === 1 ? "right" : "", t.vj === -1 ? "top" : t.vj === 1 ? "bottom" : "", mirror ? "mirror" : ""].filter(Boolean)
  return [
    "(effects",
    "  (font",
    `    (size ${mm6(t.size)} ${mm6(t.w)})`,
    ...(thickness !== null ? [`    (thickness ${mm6(thickness)})`] : []),
    ...(t.bold ? ["    (bold yes)"] : []),
    ...(t.italic ? ["    (italic yes)"] : []),
    ...(t.spacing !== 1 ? [`    (line_spacing ${mm6(t.spacing)})`] : []),
    "  )",
    ...(justify.length ? [`  (justify ${justify.join(" ")})`] : []),
    ...(hide ? ["  (hide yes)"] : []),
    ...(href ? [`  (href ${quote(href)})`] : []),
    ")",
  ]
}

const indent = (lines: string[], by: string) => lines.map((l) => `${by}${l}`).join("\n")

const norm = (a: number) => round(((a % 360) + 360) % 360, 6)

/**
 * The board file with the project's KiCad texts added: board text at the top level, each part's inside its footprint
 * (found by reference), and the user layers they are on in the layer table.
 */
export function applyTexts(pcb: string, project: Project): KicadTexts {
  // (A dimension's text is written with the dimension.)
  const all = worldTexts(project).filter((t) => t.placed && !isDimensionText(t))
  const uuids = new Map<string, string[]>()
  if (!all.length) return { text: pcb, notes: [], uuids }
  let serial = 0
  const uuid = () => `00000000-0000-4000-a000-${(++serial).toString(16).padStart(12, "0")}`
  const componentOf = new Map(project.components.map((c) => [c.id, c]))
  const refOf = new Map<string, string>()
  for (const c of project.components) if (isPhysical(findPart(c.partId))) refOf.set(c.id, c.ref)
  const toBoard = (p: Vec2): Vec2 => ({ x: KICAD_PAGE_ORIGIN + p.x, y: KICAD_PAGE_ORIGIN - p.y })
  const layers = new Set<string>()
  const board: string[] = []
  const byRef = new Map<string, string[]>()
  const replaced = new Set<string>()
  let boxKnockouts = 0

  for (const t of all) {
    layers.add(t.layer)
    const content = shownOfRaw(project, t)
    const layer = `(layer ${quote(t.layer)}${t.knockout ? " knockout" : ""})`
    if (t.owner === "#board") {
      if (t.box) {
        const b = t.box
        const corners = textBoxCorners(t).map(toBoard)
        const angle = norm(t.rot)
        // a quarter turn is the rectangle as drawn; any other angle is the polygon of its four corners
        const quarter = angle % 90 === 0
        const xs = corners.map((p) => p.x)
        const ys = corners.map((p) => p.y)
        const geometry = quarter
          ? [`  (start ${xy({ x: Math.min(...xs), y: Math.min(...ys) })})`, `  (end ${xy({ x: Math.max(...xs), y: Math.max(...ys) })})`]
          : [`  (pts ${corners.map((p) => `(xy ${xy(p)})`).join(" ")})`]
        if (t.knockout) boxKnockouts++
        const lines = [
          `(gr_text_box ${quote(content)}`,
          ...geometry,
          ...(angle ? [`  (angle ${mm6(angle)})`] : []),
          "  (stroke",
          `    (width ${mm6(b.border ?? 0)})`,
          "    (type solid)",
          "  )",
          `  (border ${b.border !== undefined ? "yes" : "no"})`,
          `  (margins ${b.margins.map(mm6).join(" ")})`,
          `  (layer ${quote(t.layer)})`,
          `  (uuid ${uuid()})`,
          ...effects(t, t.mirror, false).map((l) => `  ${l}`),
          ")",
        ]
        board.push(indent(lines, "  "))
        uuids.set(t.id, [`00000000-0000-4000-a000-${(serial).toString(16).padStart(12, "0")}`])
      } else {
        const at = toBoard({ x: t.x, y: t.y })
        const lines = [`(gr_text ${quote(content)}`, `  (at ${xy(at)}${norm(t.rot) ? ` ${mm6(norm(t.rot))}` : ""})`, `  ${layer}`, `  (uuid ${uuid()})`, ...effects(t, t.mirror, false).map((l) => `  ${l}`), ")"]
        board.push(indent(lines, "  "))
        uuids.set(t.id, [`00000000-0000-4000-a000-${(serial).toString(16).padStart(12, "0")}`])
      }
      continue
    }
    const c = componentOf.get(t.owner)
    const ref = refOf.get(t.owner)
    if (!c || ref === undefined) continue
    const local = localFrame(c)(t)
    const at = `(at ${xy(local)}${norm(t.rot) ? ` ${mm6(norm(t.rot))}` : ""}${t.upright ? "" : " unlocked"})`
    const list = byRef.get(ref) ?? []
    replaced.add(ref)
    if (t.kind === "reference" || t.kind === "value") {
      const name = t.kind === "reference" ? "Reference" : "Value"
      list.push(indent([`(property ${quote(name)} ${quote(content)}`, `  ${at}`, `  ${layer}`, ...(t.hidden ? ["  (hide yes)"] : []), `  (uuid ${uuid()})`, ...effects(t, t.mirror, false).map((l) => `  ${l}`), ")"], "    "))
    } else {
      list.push(indent([`(fp_text user ${quote(content)}`, `  ${at}`, `  ${layer}`, ...(t.hidden ? ["  (hide yes)"] : []), `  (uuid ${uuid()})`, ...effects(t, t.mirror, false).map((l) => `  ${l}`), ")"], "    "))
    }
    byRef.set(ref, list)
    uuids.set(t.id, [`00000000-0000-4000-a000-${serial.toString(16).padStart(12, "0")}`])
  }

  let text = pcb
  if (byRef.size) {
    text = text.replace(/\n {2}\(footprint\b[\s\S]*?(?=\n {2}\(|\n\)\s*$)/g, (block) => {
      const ref = block.match(/\(property "Reference" "([^"]*)"/)?.[1]
      const items = ref === undefined ? undefined : byRef.get(ref)
      if (!items?.length) return block
      // The converter's own reference, value and text nodes go: this part's file says where they are.
      let out = block.replace(/\n {4}\(property "(?:Reference|Value)"[\s\S]*?\n {4}\)/g, "").replace(/\n {4}\(fp_text\b[\s\S]*?\n {4}\)/g, "")
      out = out.replace(/\n {2}\)$/, () => `\n${items.join("\n")}\n  )`)
      return out
    })
  }
  if (board.length) {
    const end = text.lastIndexOf("\n)")
    if (end >= 0) text = `${text.slice(0, end)}\n${board.join("\n")}${text.slice(end)}`
  }
  const extra = [...layers].flatMap((name) => {
    const n = userLayerNumber(name)
    return n === null || text.includes(`(${n} "${name}" user)`) ? [] : [{ n, name }]
  }).sort((a, b) => a.n - b.n)
  if (extra.length) text = text.replace(/(\n {4}\(49 "F\.Fab" user\))/, (m) => `${m}${extra.map((e) => `\n    (${e.n} "${e.name}" user)`).join("")}`)

  const notes = [
    ...(boxKnockouts ? [`${boxKnockouts} text ${boxKnockouts === 1 ? "box has" : "boxes have"} knockout, which KiCad 9 has no node for (its parser refuses it), so ${boxKnockouts === 1 ? "it is" : "they are"} written without it.`] : []),
    "Text (board text, and the reference, value and own text of each part) is written as KiCad's own text items on their layers, with size, thickness, justification, angle, mirror, bold, italic and knockout. Text variables such as ${REFERENCE} are written as they are, for KiCad to resolve.",
  ]
  return { text, notes, uuids }
}

/** The content to write: a text's own content as stored (variables unresolved), the part's reference or value for a text that follows them. */
function shownOfRaw(project: Project, t: WorldText): string {
  const own = (t.source as { text?: string }).text
  if (own !== undefined) return own
  if (t.kind === "reference" || t.kind === "value") return shownOf(project, t)
  return t.content
}
