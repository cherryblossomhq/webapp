/*
 * A legacy schematic as the KiCad 6 schematic it becomes: the same list of items a `.kicad_sch`
 * file has, written as text, so that the reader, the accounting, the needs, the link and the build
 * that read a `.kicad_sch` read a legacy file the same way, with nothing a legacy file says lost.
 *
 * The mapping follows what KiCad 6.0 does when it loads a legacy file and saves it
 * (`SCH_LEGACY_PLUGIN::load*` and `SCH_SEXPR_PLUGIN::save*` of 6.0), checked against the demos KiCad
 * ships in both forms (`tests/kicad-schematic-legacy.test.ts`). Lengths are mils in the legacy file
 * and millimetres here, exactly (a mil is 0.0254 mm); KiCad 6 rounds to 0.0001 mm.
 *
 * This program source code file is part of KiCad, a free EDA CAD application.
 *
 * Copyright (C) 2016 CERN
 * Copyright (C) 2016-2021 KiCad Developers, see AUTHORS.txt for contributors.
 *
 * This program is free software; you can redistribute it and/or
 * modify it under the terms of the GNU General Public License
 * as published by the Free Software Foundation; either version 2
 * of the License, or (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License along
 * with this program.  If not, see <http://www.gnu.org/licenses/>.
 */

import { toSheet } from "../symbols"
import { LegacyParseError, milToIu, milToMm } from "./text"
import type { LegacyComp, LegacyEntry, LegacyField, LegacySchematic, LegacyText, LegacyWire } from "./sch"
import { defaultFieldName } from "./sch"
import { convertOverbar } from "../../board/read"

/** The uuid KiCad 6 gives an item whose legacy file has a timestamp: `00000000-0000-0000-0000-0000` and the 8 digits. */
export const timestampUuid = (ts: string) => `00000000-0000-0000-0000-${ts.toLowerCase().padStart(12, "0")}`

/** The root sheet of a legacy project has no id of its own in the file. */
export const LEGACY_ROOT_UUID = "00000000-0000-0000-0000-000000000000"

const q = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\t/g, "\\t")}"`
const n = (mil: number) => String(milToMm(mil) + 0)
const nn = (v: number) => String(Math.round(v * 1e6) / 1e6 + 0)
const xy = (xMil: number, yMil: number) => `${n(xMil)} ${n(yMil)}`

const STROKE_DEFAULT = "(stroke (width 0) (type default) (color 0 0 0 0))"

/** The turn and mirror a legacy transform matrix is, found the way KiCad's `SCH_SYMBOL::GetOrientation` finds them: the first of its list of orientations that gives the matrix. */
export function orientationOf(matrix: readonly [number, number, number, number]): { angle: number; mirror: "" | "x" | "y" } | null {
  const [x1, y1, x2, y2] = matrix
  const candidates: { angle: number; mirror: "" | "x" | "y" }[] = [
    { angle: 0, mirror: "" },
    { angle: 90, mirror: "" },
    { angle: 180, mirror: "" },
    { angle: 270, mirror: "" },
    { angle: 0, mirror: "x" },
    { angle: 90, mirror: "x" },
    { angle: 270, mirror: "x" },
    { angle: 0, mirror: "y" },
    { angle: 90, mirror: "y" },
    { angle: 180, mirror: "y" },
    { angle: 270, mirror: "y" },
  ]
  for (const c of candidates) {
    const at = { x: 0, y: 0 }
    // The point (1, 0) of the symbol goes to (x1, x2) and (0, 1) to (y1, y2), as `TRANSFORM::TransformCoordinate` has it.
    const a = toSheet({ x: 1, y: 0 }, { at, ...c })
    const b = toSheet({ x: 0, y: 1 }, { at, ...c })
    if (Math.abs(a.x - x1) < 1e-9 && Math.abs(a.y - x2) < 1e-9 && Math.abs(b.x - y1) < 1e-9 && Math.abs(b.y - y2) < 1e-9) return c
  }
  return null
}

/** `GetPenSizeForBold`: a fifth of the text height, in 100 nm units (KiCad 6). */
const boldPen = (sizeMil: number) => Math.round(milToIu(sizeMil) / 5) / 10000

const font = (sizeMil: number, italic: boolean, bold: boolean) => {
  const s = n(sizeMil)
  return `(font (size ${s} ${s})${bold ? ` (thickness ${boldPen(sizeMil)})` : ""}${italic ? " italic" : ""}${bold ? " bold" : ""})`
}

/** A symbol's field as a property, as KiCad 6 writes it. */
function property(f: LegacyField): string {
  const name = f.name !== null && f.index >= 4 ? f.name : defaultFieldName(f.index)
  const just = [f.hjust === "L" ? "left" : f.hjust === "R" ? "right" : "", f.vjust === "T" ? "top" : f.vjust === "B" ? "bottom" : ""].filter(Boolean)
  return `(property ${q(name)} ${q(f.text)} (at ${xy(f.x, f.y)} ${f.orient === "V" ? 90 : 0}) (effects ${font(f.size, f.italic, f.bold)}${just.length ? ` (justify ${just.join(" ")})` : ""}${f.attrs ? " hide" : ""}))`
}

/** The angle of a text and its justification, from a legacy orientation (`SetLabelSpinStyle` of KiCad 6.0, with `loadText`'s change of numbering for local labels). */
function spinOf(t: LegacyText): { angle: number; h: "left" | "right" } {
  // KiCad 6's spin: 0 text to the left of the anchor, 1 up, 2 to the right, 3 down. Local labels and notes number 0 and 2 the other way.
  const local = t.kind === "Notes" || t.kind === "Label"
  const spin = local ? (t.spin === 0 ? 2 : t.spin === 2 ? 0 : t.spin) : t.spin
  switch (spin) {
    case 0:
      return { angle: 180, h: "right" }
    case 1:
      return { angle: 90, h: "left" }
    case 2:
      return { angle: 0, h: "left" }
    default:
      return { angle: 270, h: "right" }
  }
}

const SHAPES: Record<string, string> = { Input: "input", Output: "output", BiDi: "bidirectional", "3State": "tri_state", UnSpc: "passive" }
const PIN_SHAPES: Record<string, string> = { I: "input", O: "output", B: "bidirectional", T: "tri_state", U: "passive" }
const SIDE_ANGLE: Record<string, number> = { R: 0, T: 90, L: 180, B: 270 }
const STYLES: Record<string, string> = { default: "default", solid: "solid", dashed: "dash", dotted: "dot", dash_dot: "dash_dot" }

function stroke(w: Pick<LegacyWire, "width" | "style" | "color"> & { layer?: string }): string {
  if (w.width === null && w.style === null && w.color === null) return w.layer === "Notes" ? "(stroke (width 0) (type dash) (color 0 0 0 0))" : STROKE_DEFAULT
  const style = w.style === null ? (w.layer === "Notes" ? "dash" : "default") : STYLES[w.style]
  if (style === undefined) throw new LegacyParseError("unknown-record", `The line style "${w.style}" is not one KiCad 5 writes.`, null, "Wire>style")
  const c = w.color
  return `(stroke (width ${n(w.width ?? 0)}) (type ${style}) (color ${c ? `${c[0]} ${c[1]} ${c[2]} ${nn(c[3] / 255)}` : "0 0 0 0"}))`
}

/** A path as KiCad 6 keeps an instance path: `/` and the root sheet's id, then the sheets from the root down. An `AR` path names the sheets and ends with the symbol itself. */
function instancePath(arPath: string): string {
  const parts = arPath.split("/").filter((s) => s !== "")
  const sheets = parts.slice(0, -1)
  return `/${[LEGACY_ROOT_UUID, ...sheets.map((s) => timestampUuid(s.toUpperCase()))].join("/")}`
}

function symbolNode(c: LegacyComp): string {
  const o = orientationOf(c.matrix)
  if (!o) throw new LegacyParseError("bad-value", `Line ${c.line}: the symbol ${c.libName} has an orientation matrix (${c.matrix.join(" ")}) that is no turn or mirror of KiCad's.`, c.line, "$Comp>orientation")
  const parts = [
    `(symbol (lib_id ${q(c.libName)}) (at ${xy(c.x, c.y)} ${o.angle})${o.mirror ? ` (mirror ${o.mirror})` : ""} (unit ${c.unit}) (body_style ${c.convert}) (uuid ${q(timestampUuid(c.ts))})`,
    ...c.fields.map(property),
  ]
  if (c.ar.length) {
    parts.push(`(instances (project "" ${c.ar.map((a) => `(path ${q(instancePath(a.path))} (reference ${q(a.reference)}) (unit ${a.part}))`).join(" ")}))`)
  }
  return `${parts.join(" ")})`
}

function textNode(t: LegacyText, version: number): string {
  const { angle, h } = spinOf(t)
  // Version 1 files have no global labels: the `GLabel` is a hierarchical one.
  const token = t.kind === "Notes" ? "text" : t.kind === "Label" ? "label" : t.kind === "HLabel" || (t.kind === "GLabel" && version === 1) ? "hierarchical_label" : "global_label"
  const shape = t.shape !== null ? ` (shape ${SHAPES[t.shape]})` : ""
  const bold = t.thickness !== 0
  // KiCad's old overbar notation (`~DSS~`) is converted in a note here; a label's is converted by the reader, by the file's version.
  const body = t.kind === "Notes" ? convertOverbar(t.text) : t.text
  const justify = t.kind === "Label" || t.kind === "Notes" ? `(justify ${h} bottom)` : `(justify ${h})`
  return `(${token} ${q(body)}${shape} (at ${xy(t.x, t.y)} ${angle}) (effects ${font(t.size, t.italic, bold)} ${justify}))`
}

function entryNode(e: LegacyEntry): string {
  return `(bus_entry (at ${xy(e.x, e.y)}) (size ${n(e.x2 - e.x)} ${n(e.y2 - e.y)})${e.kind === "Bus" ? " (bus_to_bus yes)" : ""} ${STROKE_DEFAULT})`
}

function toBase64(bytes: Uint8Array): string {
  let bin = ""
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(bin)
}

const PAPER: Record<string, string> = { A5: "A5", A4: "A4", A3: "A3", A2: "A2", A1: "A1", A0: "A0", A: "A", B: "B", C: "C", D: "D", E: "E", GERBER: "GERBER", USLETTER: "USLetter", USLEDGER: "USLedger", USLEGAL: "USLegal" }

/** The legacy schematic as the text of a `.kicad_sch` (without its `lib_symbols`, which come from the libraries). */
export function legacyToKicadText(l: LegacySchematic): string {
  const out: string[] = [`(kicad_sch (version ${l.version}) (generator "legacy_eeschema") (uuid ${q(LEGACY_ROOT_UUID)})`]
  const page = l.page
  if (page) {
    const type = page.type.toUpperCase()
    out.push(type === "USER" ? `(paper "User" ${n(page.w)} ${n(page.h)})` : `(paper ${q(PAPER[type])}${page.portrait ? " portrait" : ""})`)
    const tb: string[] = []
    if (page.title) tb.push(`(title ${q(page.title)})`)
    if (page.date) tb.push(`(date ${q(page.date)})`)
    if (page.rev) tb.push(`(rev ${q(page.rev)})`)
    if (page.company) tb.push(`(company ${q(page.company)})`)
    page.comments.forEach((c, i) => {
      if (c) tb.push(`(comment ${i + 1} ${q(c)})`)
    })
    if (tb.length) out.push(`(title_block ${tb.join(" ")})`)
  }
  for (const j of l.junctions) out.push(`(junction (at ${xy(j.x, j.y)}) (diameter 0) (color 0 0 0 0))`)
  for (const c of l.noConnects) out.push(`(no_connect (at ${xy(c.x, c.y)}))`)
  for (const w of l.wires) {
    const token = w.layer === "Wire" ? "wire" : w.layer === "Bus" ? "bus" : "polyline"
    out.push(`(${token} (pts (xy ${xy(w.x1, w.y1)}) (xy ${xy(w.x2, w.y2)})) ${stroke(w)})`)
  }
  for (const e of l.entries) out.push(entryNode(e))
  for (const t of l.texts) out.push(textNode(t, l.version))
  for (const b of l.bitmaps) out.push(`(image (at ${xy(b.x, b.y)}) (scale ${nn(b.scale)}) (data ${q(toBase64(b.data))}))`)
  for (const s of l.sheets) {
    const pins = s.pins.map((p) => `(pin ${q(p.name)} ${PIN_SHAPES[p.shape]} (at ${xy(p.x, p.y)} ${SIDE_ANGLE[p.side]}) (effects ${font(p.size, false, false)}))`)
    // KiCad 5 does not keep the places of a sheet's name and file; the name comes first and the file second, as in files of the oldest KiCad 6 versions.
    out.push(
      `(sheet (at ${xy(s.x, s.y)}) (size ${n(s.w)} ${n(s.h)}) (uuid ${q(timestampUuid(s.ts))}) (property "Sheet name" ${q(s.name)} (at ${xy(s.x, s.y)} 0) (effects ${font(s.nameSize, false, false)})) (property "Sheet file" ${q(s.file)} (at ${xy(s.x, s.y)} 0) (effects ${font(s.fileSize, false, false)})) ${pins.join(" ")})`,
    )
  }
  for (const c of l.comps) out.push(symbolNode(c))
  if (page?.sheet) out.push(`(sheet_instances (path "/" (page ${q(String(page.sheet[0]))})))`)
  return `${out.join("\n")}\n)\n`
}
