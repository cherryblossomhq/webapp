// Ported from KiCad (https://gitlab.com/kicad/code/kicad): `PCB_IO_KICAD_SEXPR::format` of dimensions, groups and reference images (pcbnew/pcb_io/kicad_sexpr/pcb_io_kicad_sexpr.cpp of
// 9.0.7, lines 841, 1056 and 2164) and the format the 9.0.7 parser reads (pcb_io_kicad_sexpr_parser.cpp: `parseDIMENSION`, `parsePCB_REFERENCE_IMAGE`, `parseGROUP`).
// Copyright The KiCad Developers, see AUTHORS.txt for contributors. This program source code file is part of KiCad, a free EDA CAD application. This program is free
// software; you can redistribute it and/or modify it under the terms of the GNU General Public License as published by the Free Software Foundation; either version 2
// of the License, or (at your option) any later version. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the
// implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU General Public License for more details. You should have received a copy of
// the GNU General Public License along with this program; if not, see <https://www.gnu.org/licenses/>.

import { round } from "../lib/geometry"
import { encodeBase64, imageFacts } from "../lib/imageFacts"
import { dimensionDrawing } from "../model/dimensions"
import { dimensionWorldText } from "../model/texts"
import type { BoardDimension, PcbGroup, Project, ReferenceImage, Vec2 } from "../model/types"
import { effects, quote } from "./kicadTexts"
import { KICAD_PAGE_ORIGIN, userLayerNumber } from "./kicadShapes"

// The dimensions, reference images and groups of a board brought in from KiCad, written into the board file the converter made, as KiCad 9 writes them (stamp 20241229):
// a dimension with its points, height, format, style and text (the text it shows and where KiCad puts it, as KiCad saves a dimension), an image with its
// picture, and a group with the ids of what it holds, sorted as KiCad sorts them. A group's members are the ids the items were written with: a part's by its
// reference in the converter's file, a drawing's and a text's from the writers of those, a track's and a via's from the converter's own, found again by their
// place. The file KiCad 9 reads has no node for a group's design block (KiCad 10) or for a custom property, so those are left out and a note says so.
// A board with none of these is written byte for byte as before.

const mm6 = (n: number) => String(round(n, 6) || 0)
const xy = (p: Vec2) => `${mm6(p.x)} ${mm6(p.y)}`
const toBoard = (p: Vec2): Vec2 => ({ x: KICAD_PAGE_ORIGIN + p.x, y: KICAD_PAGE_ORIGIN - p.y })
const key = (n: number) => n.toFixed(4)
const uuidAt = (kind: string, n: number) => `00000000-0000-4000-${kind}-${n.toString(16).padStart(12, "0")}`

export interface KicadObjects {
  text: string
  notes: string[]
}

/** KiCad's `%g`: six significant digits. */
const formatG = (n: number) => String(Number(n.toPrecision(6)))

function dimensionBlock(d: BoardDimension, uuid: string): string[] {
  const a = toBoard(d.a)
  const b = toBoard(d.b)
  const aligned = d.kind === "aligned" || d.kind === "orthogonal"
  const draw = dimensionDrawing(d)
  const lines: string[] = ["(dimension", `  (type ${d.kind})`]
  if (d.locked) lines.push("  (locked yes)")
  lines.push(`  (layer ${quote(d.layer)})`, `  (uuid ${uuid})`, `  (pts (xy ${xy(a)}) (xy ${xy(b)}))`)
  if (aligned) lines.push(`  (height ${mm6(d.height ?? 0)})`)
  if (d.kind === "radial") lines.push(`  (leader_length ${mm6(d.leaderLength ?? 3.81)})`)
  if (d.kind === "orthogonal") lines.push(`  (orientation ${d.vertical ? 1 : 0})`)
  if (d.kind !== "center") {
    lines.push(`  (format (prefix ${quote(d.prefix ?? "")}) (suffix ${quote(d.suffix ?? "")}) (units ${d.units}) (units_format ${d.format}) (precision ${d.precision})${d.override !== undefined ? ` (override_value ${quote(d.override)})` : ""}${d.zeros ? " (suppress_zeroes yes)" : ""})`)
  }
  lines.push(`  (style (thickness ${mm6(d.thickness)}) (arrow_length ${mm6(d.arrow)}) (text_position_mode ${d.textMode ?? 0})${aligned ? ` (arrow_direction ${d.inward ? "inward" : "outward"}) (extension_height ${mm6(d.extHeight)})` : ""}${d.kind === "leader" ? ` (text_frame ${d.frame ?? 0})` : ""} (extension_offset ${mm6(d.extOffset)})${d.keep ? " (keep_text_aligned yes)" : ""})`)
  // The text as KiCad saves it: what the dimension shows, where its rules put it, at the angle they give it.
  const wt = d.kind === "center" ? null : dimensionWorldText(d, true)
  if (wt && draw.text) {
    const at = toBoard({ x: draw.text.x, y: draw.text.y })
    const rot = round(draw.text.rot, 6)
    lines.push(`  (gr_text ${quote(draw.text.content)}`, `    (at ${xy(at)}${rot ? ` ${mm6(rot)}` : ""})`, `    (layer ${quote(d.layer)})`, `    (uuid ${uuid})`, ...effects(wt, d.mirror === true, false).map((l) => `    ${l}`), "  )")
  }
  lines.push(")")
  return lines
}

function imageBlock(m: ReferenceImage, bytes: Uint8Array, uuid: string): string[] {
  // KiCad 9 (and 10) derive the resolution without the fix of 20260623, so a file whose scale was made with the exact one is written with the scale that draws the same size there.
  const legacy = imageFacts(bytes).legacyPpi
  const scale = (m.scale * m.ppi) / legacy
  const data = encodeBase64(bytes)
  const chunks: string[] = []
  for (let i = 0; i < data.length; i += 76) chunks.push(`      "${data.slice(i, i + 76)}"`)
  return ["(image", `  (at ${xy(toBoard({ x: m.x, y: m.y }))})`, `  (layer ${quote(m.layer)})`, ...(scale !== 1 ? [`  (scale ${formatG(scale)})`] : []), ...(m.locked ? ["  (locked yes)"] : []), "  (data", ...chunks, "  )", `  (uuid ${uuid})`, ")"]
}

function groupBlock(g: PcbGroup, uuid: string, members: string[]): string[] {
  return [`(group ${quote(g.name)}`, `  (uuid ${uuid})`, ...(g.locked ? ["  (locked yes)"] : []), `  (members ${[...members].sort().map(quote).join(" ")})`, ")"]
}

const indent = (lines: string[], by: string) => lines.map((l) => `${by}${l}`).join("\n")

/** The footprints of the converter's file by reference: where each is in the text, and its id. */
function footprintIds(pcb: string): Map<string, { uuid: string; pads: { number: string; uuid: string }[] }> {
  const out = new Map<string, { uuid: string; pads: { number: string; uuid: string }[] }>()
  for (const m of pcb.matchAll(/\n {2}\(footprint\b[\s\S]*?(?=\n {2}\(|\n\)\s*$)/g)) {
    const block = m[0]
    const ref = block.match(/\(property "Reference" "([^"]*)"/)?.[1]
    const uuid = block.match(/\n {4}\(uuid ([0-9a-f-]+)\)/)?.[1]
    if (ref === undefined || !uuid) continue
    const pads = [...block.matchAll(/\n {4}\(pad "((?:[^"\\]|\\.)*)"[\s\S]*?\n {6}\(uuid ([0-9a-f-]+)\)/g)].map((p) => ({ number: p[1], uuid: p[2] }))
    out.set(ref, { uuid, pads })
  }
  return out
}

/** The converter's tracks and vias with their ids, to be found again by where they are. */
function copperIds(pcb: string) {
  const segments = new Map<string, string[]>()
  for (const m of pcb.matchAll(/\n {2}\(segment\n\s+\(start ([-\d.e]+) ([-\d.e]+)\)\n\s+\(end ([-\d.e]+) ([-\d.e]+)\)[\s\S]*?\(layer ([^\s)]+)\)[\s\S]*?\(uuid ([0-9a-f-]+)\)/g)) {
    const [x1, y1, x2, y2, layer, uuid] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), m[5].replace(/"/g, ""), m[6]]
    for (const k of [`${layer}|${key(x1)},${key(y1)}|${key(x2)},${key(y2)}`, `${layer}|${key(x2)},${key(y2)}|${key(x1)},${key(y1)}`]) {
      const list = segments.get(k)
      if (list) list.push(uuid)
      else segments.set(k, [uuid])
    }
  }
  const vias = new Map<string, string[]>()
  for (const m of pcb.matchAll(/\n {2}\(via\n\s+\(at ([-\d.e]+) ([-\d.e]+)\)[\s\S]*?\(uuid ([0-9a-f-]+)\)/g)) {
    const k = `${key(Number(m[1]))},${key(Number(m[2]))}`
    const list = vias.get(k)
    if (list) list.push(m[3])
    else vias.set(k, [m[3]])
  }
  return { segments, vias }
}

/**
 * The board file with the project's dimensions, reference images and groups added: dimensions and images at the top level, groups last (KiCad writes them at the
 * end), a part's own groups inside its footprint, and the user layers they are on in the layer table. `drawings` and `texts` are the ids the drawing and text writers
 * gave their items, and `pictures` the bytes of each image by the id the project holds it by.
 */
export function applyBoardObjects(pcb: string, project: Project, drawings: Map<string, string[]>, texts: Map<string, string[]>, pictures: Map<string, Uint8Array>): KicadObjects {
  const dims = project.dimensions ?? []
  const images = project.images ?? []
  const groups = project.groups ?? []
  const partGroups = project.components.filter((c) => c.groups?.length)
  if (!dims.length && !images.length && !groups.length && !partGroups.length) return { text: pcb, notes: [] }
  const notes: string[] = []
  const layers = new Set<string>()
  const ids = new Map<string, string[]>()
  const body: string[] = []

  dims.forEach((d, i) => {
    const uuid = uuidAt("b000", i + 1)
    layers.add(d.layer)
    ids.set(d.id, [uuid])
    body.push(indent(dimensionBlock(d, uuid), "  "))
  })
  let missingPictures = 0
  images.forEach((m, i) => {
    const bytes = pictures.get(m.file)
    if (!bytes) {
      missingPictures++
      return
    }
    const uuid = uuidAt("c000", i + 1)
    layers.add(m.layer)
    ids.set(m.id, [uuid])
    body.push(indent(imageBlock(m, bytes, uuid), "  "))
  })
  if (missingPictures) notes.push(`${missingPictures} reference ${missingPictures === 1 ? "image was" : "images were"} left out: ${missingPictures === 1 ? "its picture is" : "their pictures are"} not in this account's files, so there is nothing to write.`)
  if (images.some((m) => m.scale !== 1 || m.ppi !== 300)) notes.push("A reference image's scale is written with six digits, as KiCad writes it.")

  // What each member of a group is in the file.
  const footprints = footprintIds(pcb)
  const copper = copperIds(pcb)
  const members = new Map<string, string[]>()
  for (const c of project.components) {
    const u = footprints.get(c.ref)?.uuid
    if (u) members.set(c.id, [u])
  }
  for (const g of project.graphics ?? []) members.set(g.id, drawings.get(`g:${g.id}`) ?? [])
  for (const t of project.texts) if (t.layer !== undefined) members.set(t.id, texts.get(`x:${t.id}`) ?? [])
  for (const [id, list] of ids) members.set(id, list)
  let lost = 0
  for (const t of project.traces) {
    const layer = t.layer === "top" ? "F.Cu" : "B.Cu"
    const found: string[] = []
    for (let i = 1; i < t.points.length; i++) {
      const a = toBoard(t.points[i - 1])
      const b = toBoard(t.points[i])
      const list = copper.segments.get(`${layer}|${key(a.x)},${key(a.y)}|${key(b.x)},${key(b.y)}`)
      const u = list?.shift()
      if (u) {
        found.push(u)
        // The same segment is listed under both ends.
        const other = copper.segments.get(`${layer}|${key(b.x)},${key(b.y)}|${key(a.x)},${key(a.y)}`)
        const at = other?.indexOf(u) ?? -1
        if (at >= 0) other!.splice(at, 1)
      } else lost++
    }
    members.set(t.id, found)
  }
  for (const v of project.vias) {
    const p = toBoard(v)
    const u = copper.vias.get(`${key(p.x)},${key(p.y)}`)?.shift()
    members.set(v.id, u ? [u] : [])
    if (!u) lost++
  }

  const groupUuid = new Map(groups.map((g, i) => [g.id, uuidAt("d000", i + 1)]))
  for (const [id, u] of groupUuid) members.set(id, [u])
  const groupBlocks = groups.flatMap((g) => {
    const uuids = g.members.flatMap((m) => members.get(m) ?? [])
    if (g.members.length && uuids.length < g.members.length) lost += g.members.length - uuids.length
    return uuids.length ? [indent(groupBlock(g, groupUuid.get(g.id)!, uuids), "  ")] : []
  })
  if (lost) notes.push(`${lost} group ${lost === 1 ? "member" : "members"} could not be found in the file the converter wrote, so ${lost === 1 ? "it is" : "they are"} not in ${lost === 1 ? "its" : "their"} group there.`)
  if (groups.some((g) => g.lib !== undefined)) notes.push("A group made from a design block keeps no link to it: KiCad 9's file has no node for one.")

  let text = pcb
  // A part's own groups, inside its footprint, naming its pads, drawings and texts.
  const partBlocks = new Map<string, string[]>()
  let partLost = 0
  for (const c of partGroups) {
    const fp = footprints.get(c.ref)
    if (!fp) continue
    const padsOf = (number: string) => fp.pads.filter((p) => p.number === number).map((p) => p.uuid)
    const land = project.footprints?.find((f) => f.name === c.footprint)
    const resolve = (m: string): string[] => {
      const i = Number(m.slice(1))
      if (m[0] === "p") {
        // A pad is found by its number, when the file has one pad of it.
        const number = land?.pads[i]?.pin ?? undefined
        const list = number === undefined || number === null ? [] : padsOf(number)
        return list.length === 1 ? list : []
      }
      if (m[0] === "s") return drawings.get(`s:${c.id}:${i}`) ?? []
      if (m[0] === "t") return texts.get(`p:${c.id}:${i}`) ?? []
      return []
    }
    const uuids = c.groups!.map((_, i) => uuidAt("e000", (partBlocks.size + 1) * 4096 + i + 1))
    const blocks = c.groups!.flatMap((g, i) => {
      const list = g.members.flatMap((m) => (m[0] === "g" ? [uuids[Number(m.slice(1))]] : resolve(m)))
      partLost += g.members.length - g.members.filter((m) => m[0] === "g").length - list.filter((u) => !uuids.includes(u)).length
      return list.length ? [indent(groupBlock(g, uuids[i], list), "    ")] : []
    })
    if (blocks.length) partBlocks.set(c.ref, blocks)
  }
  if (partLost > 0) notes.push(`${partLost} ${partLost === 1 ? "member" : "members"} of the groups inside parts could not be found in the file the converter wrote (a pad is found by its number, when the part has only one pad of it).`)
  if (partBlocks.size) {
    text = text.replace(/\n {2}\(footprint\b[\s\S]*?(?=\n {2}\(|\n\)\s*$)/g, (block) => {
      const ref = block.match(/\(property "Reference" "([^"]*)"/)?.[1]
      const blocks = ref === undefined ? undefined : partBlocks.get(ref)
      return blocks?.length ? block.replace(/\n {2}\)$/, () => `\n${blocks.join("\n")}\n  )`) : block
    })
  }

  const all = [...body, ...groupBlocks]
  if (all.length) {
    const end = text.lastIndexOf("\n)")
    if (end >= 0) text = `${text.slice(0, end)}\n${all.join("\n")}${text.slice(end)}`
  }
  const extra = [...layers]
    .flatMap((name) => {
      const n = userLayerNumber(name)
      return n === null || text.includes(`(${n} "${name}" user)`) ? [] : [{ n, name }]
    })
    .sort((a, b) => a.n - b.n)
  if (extra.length) text = text.replace(/(\n {4}\(49 "F\.Fab" user\))/, (m) => `${m}${extra.map((e) => `\n    (${e.n} "${e.name}" user)`).join("")}`)
  if (dims.length) notes.push("Dimensions are written as KiCad's own dimension items, with the text and where KiCad puts it; their lines and arrows are KiCad's to draw, by its rules, as they are here.")
  return { text, notes }
}
