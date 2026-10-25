/*
 * Reader of KiCad's legacy schematic format (`EESchema Schematic File Version 1` to `5`, the
 * `.sch` files of KiCad 4 and 5): every record of the file into a typed object, strictly. It is a
 * port of the `loadFile`, `loadHeader`, `loadPageSettings`, `loadSheet`, `loadBitmap`,
 * `loadJunction`, `loadNoConnect`, `loadWire`, `loadBusEntry`, `loadText` and `loadComponent` of
 * KiCad's `sch_legacy_plugin.cpp` (KiCad 5.1 and 6.0).
 *
 * One difference, on purpose: KiCad 5.1 skips any line it does not know. KiCad 6.0 refuses a
 * top level line it does not know ("unrecognized token"); this reader refuses every line it does
 * not know, inside a record as well, naming the record: nothing in a file is silently dropped.
 *
 * This program source code file is part of KiCad, a free EDA CAD application.
 *
 * Copyright (C) 2016 CERN
 * Copyright (C) 2016-2021 KiCad Developers, see AUTHORS.txt for contributors.
 *
 * @author Wayne Stambaugh <stambaughw@gmail.com>
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

import { Cursor, LegacyParseError, linesOf, tokensOf } from "./text"

/** The newest legacy schematic version: KiCad 5.1 writes 4, the 5.99 development builds 5. */
export const NEWEST_LEGACY_SCH_VERSION = 5

export interface LegacyField {
  /** The slot: 0 reference, 1 value, 2 footprint, 3 datasheet, then the user's fields in file order (the file's own number is not kept, as KiCad does not). */
  index: number
  text: string
  /** `H` or `V`. */
  orient: string
  x: number
  y: number
  size: number
  /** The file's attribute bits: any bit set means the field is not shown. */
  attrs: number
  /** `L`, `R` or `C`; `C` when the file (version 1) gives none. */
  hjust: string
  /** The vertical justification `T`, `B` or `C`. */
  vjust: string
  italic: boolean
  bold: boolean
  /** The field's own name, or null for the default of its slot. */
  name: string | null
}

export interface LegacyAr {
  path: string
  reference: string
  part: number
}

export interface LegacyComp {
  /** The library name as the `L` line writes it, with `~` read as a space. */
  libName: string
  /** The reference of the `L` line, with `~` read as a space. */
  refDesignator: string
  unit: number
  convert: number
  /** The timestamp as the `U` line writes it, upper case, 8 digits. */
  ts: string
  x: number
  y: number
  ar: LegacyAr[]
  fields: LegacyField[]
  /** The transform matrix: `x1 y1 x2 y2`. */
  matrix: [number, number, number, number]
  line: number
}

export interface LegacySheetPin {
  name: string
  /** `I`, `O`, `B`, `T` or `U`. */
  shape: string
  /** `R`, `T`, `B` or `L`. */
  side: string
  x: number
  y: number
  size: number
}

export interface LegacySheet {
  x: number
  y: number
  w: number
  h: number
  ts: string
  name: string
  nameSize: number
  file: string
  fileSize: number
  pins: LegacySheetPin[]
}

export interface LegacyBitmap {
  x: number
  y: number
  scale: number
  /** The picture's bytes (a PNG). */
  data: Uint8Array
}

export interface LegacyWire {
  /** `Wire`, `Bus` or `Notes`. */
  layer: "Wire" | "Bus" | "Notes"
  x1: number
  y1: number
  x2: number
  y2: number
  /** A line width, a style and a colour: only a value that is not the default is in the file. */
  width: number | null
  style: string | null
  color: [number, number, number, number] | null
}

export interface LegacyEntry {
  /** `Wire` (a wire to a bus) or `Bus` (a bus to a bus). */
  kind: "Wire" | "Bus"
  x: number
  y: number
  /** The other end, as the file gives it. */
  x2: number
  y2: number
}

export interface LegacyText {
  /** `Notes`, `Label`, `HLabel` or `GLabel`. */
  kind: "Notes" | "Label" | "HLabel" | "GLabel"
  x: number
  y: number
  /** The orientation as the file writes it (0 to 3; for local labels and notes, 0 is text to the right, for global and hierarchical labels, 0 is text to the left). */
  spin: number
  size: number
  /** The shape of a global or hierarchical label: `Input`, `Output`, `BiDi`, `3State`, `UnSpc`. */
  shape: string | null
  italic: boolean
  /** The pen width of the file: bold when not 0. */
  thickness: number
  /** The text, `\n` read as a line break. */
  text: string
}

export interface LegacyPage {
  type: string
  /** The size in mils, for the `User` type. */
  w: number
  h: number
  portrait: boolean
  /** `Sheet n m`. */
  sheet: [number, number] | null
  title: string
  date: string
  rev: string
  company: string
  /** Comments 1 to 9, `""` for the ones the file does not have. */
  comments: string[]
  encoding: string | null
}

export interface LegacySchematic {
  version: number
  /** The `LIBS:` lines of the header: the libraries the schematic was last saved with. */
  libs: string[]
  page: LegacyPage | null
  comps: LegacyComp[]
  sheets: LegacySheet[]
  bitmaps: LegacyBitmap[]
  junctions: { x: number; y: number }[]
  noConnects: { x: number; y: number }[]
  wires: LegacyWire[]
  entries: LegacyEntry[]
  texts: LegacyText[]
  /** The ERC markers old KiCad versions saved in the schematic (`Kmarq`): KiCad recomputes them. */
  markers: { type: string; x: number; y: number; text: string }[]
  /** What the file says that KiCad does not read or reads another way, each with the line: said in the import report, never dropped silently. */
  notes: { code: "ignored-v1" | "comma-decimal"; text: string }[]
  /** Every record of the file by its path, with its count: what the accounting shows. */
  records: Map<string, number>
}

const PAGE_TYPES = new Set(["A5", "A4", "A3", "A2", "A1", "A0", "A", "B", "C", "D", "E", "GERBER", "USLETTER", "USLEDGER", "USLEGAL", "USER"])
const LABEL_SHAPES = ["Input", "Output", "BiDi", "3State", "UnSpc"]
const SHEET_PIN_SHAPES = new Set(["I", "O", "B", "T", "U"])
const SHEET_SIDES = new Set(["R", "T", "B", "L"])

/** The default name of a field's slot (`TEMPLATE_FIELDNAME::GetDefaultFieldName`). */
export const defaultFieldName = (index: number) => (index === 0 ? "Reference" : index === 1 ? "Value" : index === 2 ? "Footprint" : index === 3 ? "Datasheet" : `Field${index}`)

const MANDATORY_FIELDS = 4
const MAX_UNIT_COUNT_PER_PACKAGE = 26

/** Whether text looks like a legacy schematic, and its version. */
export function legacySchematicVersion(text: string): number | null {
  const head = text.slice(0, 200).replace(/^﻿/, "")
  const m = /^EESchema Schematic File Version[ \t]+(\d+)/i.exec(head)
  return m ? Number(m[1]) : null
}

export function readLegacySchematicText(text: string): LegacySchematic {
  if (!text.trim()) throw new LegacyParseError("empty", "The file is empty.")
  const lines = linesOf(text.replace(/^﻿/, ""))
  let n = 0
  const records = new Map<string, number>()
  const count = (path: string) => records.set(path, (records.get(path) ?? 0) + 1)
  const cursorAt = (i: number, path: string, s?: string) => new Cursor(s ?? lines[i] ?? "", 0, i + 1, path)
  /** The next line, or a truncation error naming what was open. */
  const next = (path: string, what: string): string => {
    if (n >= lines.length) throw new LegacyParseError("truncated", `The file ends inside ${what}; it looks cut short.`, lines.length, path)
    return lines[n++]
  }
  const trimLeft = (s: string) => s.replace(/^ +/, "")

  // ---------- header ----------
  n++
  const hc = cursorAt(0, "header")
  if (!hc.compare("EESchema Schematic File Version")) throw new LegacyParseError("not-legacy", "This file does not begin with `EESchema Schematic File Version`, so it is not a KiCad schematic of KiCad 5 or before.", 1, "header")
  const version = hc.int()
  if (version < 1) throw new LegacyParseError("bad-value", `The file's version ${version} is not one KiCad has written.`, 1, "header")
  if (version > NEWEST_LEGACY_SCH_VERSION) throw new LegacyParseError("newer-version", `This schematic is version ${version}, newer than the newest legacy version this importer knows (${NEWEST_LEGACY_SCH_VERSION}).`, 1, "header")
  count("header")
  if (!hc.eol) hc.fail("bad-line", "unexpected text after the version")
  const libs: string[] = []
  let sawLayerEnd = false
  while (n < lines.length) {
    const raw = lines[n++]
    const line = trimLeft(raw)
    const c = cursorAt(n - 1, "header>?", line)
    if (c.compare("EELAYER END")) {
      count("header>EELAYER END")
      sawLayerEnd = true
      break
    }
    if (/^LIBS:/i.test(line)) {
      libs.push(line.slice(5).trim())
      count("header>LIBS")
    } else if (/^EELAYER[ \t]+-?\d+[ \t]+-?\d+[ \t]*$/i.test(line)) count("header>EELAYER")
    else if (line.trim() === "") count("header>blank")
    else throw new LegacyParseError("unknown-record", `Line ${n}: the header has a line this importer does not know (${JSON.stringify(line.slice(0, 60))}).`, n, "header>?")
  }
  if (!sawLayerEnd) throw new LegacyParseError("truncated", "The header has no `EELAYER END` line; the file looks cut short.", lines.length, "header")

  const out: LegacySchematic = { version, libs, page: null, comps: [], sheets: [], bitmaps: [], junctions: [], noConnects: [], wires: [], entries: [], texts: [], markers: [], notes: [], records }

  // ---------- the body ----------
  let ended = false
  while (n < lines.length) {
    const lineNo = n
    const raw = lines[n++]
    const line = trimLeft(raw)
    const c = cursorAt(lineNo, "?", line)
    if (line === "") {
      count("blank")
      continue
    }
    if (c.compare("$Descr")) out.page = readPage(c)
    else if (c.compare("$Comp")) out.comps.push(readComp(lineNo + 1))
    else if (c.compare("$Sheet")) out.sheets.push(readSheet())
    else if (c.compare("$Bitmap")) out.bitmaps.push(readBitmap())
    else if (c.compare("Connection")) {
      count("Connection")
      c.unquoted()
      out.junctions.push({ x: c.int(), y: c.int() })
      endOfLine(c)
    } else if (c.compare("NoConn")) {
      count("NoConn")
      c.unquoted()
      out.noConnects.push({ x: c.int(), y: c.int() })
      endOfLine(c)
    } else if (c.compare("Wire")) out.wires.push(readWire(c))
    else if (c.compare("Entry")) out.entries.push(readEntry(c))
    else if (c.compare("Text")) out.texts.push(readText(c))
    else if (c.compare("Kmarq")) {
      // An ERC marker, as KiCad 2 to 4 saved them: `Kmarq B 3100 2150 "Warning ..." F=1`.
      const type = c.unquoted()
      const x = c.int()
      const y = c.int()
      const text = c.quoted(true)
      const flag = c.unquoted()
      if (!/^F=\d+$/.test(flag)) c.fail("bad-line", "an ERC marker's `F=` was expected")
      endOfLine(c)
      out.markers.push({ type, x, y, text })
      count("Kmarq")
    }
    else if (c.compare("$EndSCHEMATC")) {
      count("$EndSCHEMATC")
      ended = true
      break
    } else throw new LegacyParseError("unknown-record", `Line ${lineNo + 1}: a record this importer does not know (${JSON.stringify(line.slice(0, 60))}).`, lineNo + 1, "?")
  }
  // Schematic files before version 2 are not ended by `$EndSCHEMATC`.
  if (!ended && version > 1) throw new LegacyParseError("truncated", "The file has no `$EndSCHEMATC` line; it looks cut short.", lines.length, "$EndSCHEMATC")
  if (ended) {
    // Nothing follows the end mark in a file KiCad wrote.
    while (n < lines.length) {
      if (lines[n].trim() !== "") throw new LegacyParseError("unknown-record", `Line ${n + 1}: text after \`$EndSCHEMATC\` (${JSON.stringify(lines[n].slice(0, 60))}).`, n + 1, "?")
      n++
    }
  }
  return out

  /** Leftover text at the end of a record's line is damage: KiCad ignores it, this reader does not. */
  function endOfLine(c: Cursor) {
    if (!c.eol) c.fail("bad-line", `unexpected text "${c.rest().slice(0, 30)}" at the end of the line`)
  }

  // ---------- $Descr ----------
  function readPage(c: Cursor): LegacyPage {
    const type = c.unquoted()
    if (!PAGE_TYPES.has(type.toUpperCase())) c.fail("bad-value", `"${type}" is not a page size`)
    const w = c.int()
    const h = c.int()
    let portrait = false
    if (type.toUpperCase() !== "USER") {
      const orientation = c.unquoted(true)
      if (orientation === "portrait") portrait = true
      else if (orientation !== "") c.fail("bad-value", `"${orientation}" is not a page orientation`)
    } else endOfLine(c)
    const page: LegacyPage = { type, w, h, portrait, sheet: null, title: "", date: "", rev: "", company: "", comments: Array(9).fill(""), encoding: null }
    count("$Descr")
    for (;;) {
      const at = n
      const l = trimLeft(next("$Descr", "the page description"))
      const lc = cursorAt(at, "$Descr>?", l)
      if (lc.compare("Sheet")) {
        page.sheet = [lc.int(), lc.int()]
        endOfLine(lc)
        count("$Descr>Sheet")
      } else if (lc.compare("Title")) {
        page.title = lc.quoted(true)
        count("$Descr>Title")
      } else if (lc.compare("Date")) {
        page.date = lc.quoted(true)
        count("$Descr>Date")
      } else if (lc.compare("Rev")) {
        page.rev = lc.quoted(true)
        count("$Descr>Rev")
      } else if (lc.compare("Comp")) {
        page.company = lc.quoted(true)
        count("$Descr>Comp")
      } else if (/^Comment[1-9][ \t]/i.test(l) || /^Comment[1-9]$/i.test(l)) {
        const k = Number(l[7])
        lc.compare(`Comment${k}`)
        page.comments[k - 1] = lc.quoted(true)
        count("$Descr>Comment")
      } else if (lc.compare("encoding")) {
        page.encoding = lc.unquoted()
        count("$Descr>encoding")
      } else if (lc.compare("$EndDescr")) {
        count("$Descr>$EndDescr")
        return page
      } else throw new LegacyParseError("unknown-record", `Line ${at + 1}: the page description has a line this importer does not know (${JSON.stringify(l.slice(0, 60))}).`, at + 1, "$Descr>?")
    }
  }

  // ---------- $Comp ----------
  function readComp(startLine: number): LegacyComp {
    count("$Comp")
    const comp: LegacyComp = { libName: "", refDesignator: "", unit: 1, convert: 1, ts: "00000000", x: 0, y: 0, ar: [], fields: [], matrix: [1, 0, 0, -1], line: startLine }
    let sawL = false
    let sawU = false
    let sawP = false
    let sawMatrix = false
    const fields: LegacyField[] = []
    for (;;) {
      const at = n
      const raw = next("$Comp", "a symbol");
      const l = trimLeft(raw)
      const c = cursorAt(at, "$Comp>?", l)
      if (c.compare("L")) {
        const t = tokensOf(c.rest())
        if (t.length < 2) c.fail("bad-line", "invalid symbol library definition")
        comp.libName = t[0].replace(/~/g, " ")
        comp.refDesignator = t[1].replace(/~/g, " ")
        sawL = true
        count("$Comp>L")
      } else if (c.compare("U")) {
        let unit = c.int()
        if (unit === 0) unit = 1
        let convert = c.int()
        if (convert === 0) convert = 1
        comp.unit = unit
        comp.convert = convert
        comp.ts = c.hex().toString(16).toUpperCase().padStart(8, "0")
        endOfLine(c)
        sawU = true
        count("$Comp>U")
      } else if (c.compare("P")) {
        comp.x = c.int()
        comp.y = c.int()
        endOfLine(c)
        sawP = true
        count("$Comp>P")
      } else if (c.compare("AR")) {
        const must = (token: string) => {
          if (c.s.slice(c.i, c.i + token.length).toLowerCase() !== token.toLowerCase()) c.fail("bad-line", `the \`${token}\` token is missing`)
          c.i += token.length
        }
        must("Path=")
        const path = c.quoted()
        must("Ref=")
        const reference = c.quoted()
        must("Part=")
        const part = c.quoted()
        if (!/^[+-]?\d+$/.test(part)) c.fail("bad-number", "an integer was expected for Part")
        const k = Number(part)
        if (k < 0 || k > MAX_UNIT_COUNT_PER_PACKAGE) c.fail("bad-value", "the unit value is out of range")
        endOfLine(c)
        comp.ar.push({ path, reference, part: k })
        count("$Comp>AR")
      } else if (c.compare("F")) {
        let index = c.int()
        const text = c.quoted(true)
        const orient = c.char()
        const x = c.int()
        const y = c.int()
        const size = c.int()
        const attrs = c.hex()
        // The file's slot is only a hint for a user field: it takes the next free slot.
        if (index >= MANDATORY_FIELDS) index = MANDATORY_FIELDS + fields.filter((f) => f.index >= MANDATORY_FIELDS).length
        const f: LegacyField = { index, text, orient, x, y, size, attrs, hjust: "C", vjust: "C", italic: false, bold: false, name: null }
        if (version > 1) {
          const hjust = c.char()
          const textAttrs = c.unquoted()
          const name = c.quoted(true)
          if (hjust !== "L" && hjust !== "R" && hjust !== "C") c.fail("bad-value", "the horizontal justification of a field must be L, R or C")
          f.hjust = hjust
          const v = textAttrs[0]
          if (v !== "T" && v !== "B" && v !== "C") c.fail("bad-value", "the vertical justification of a field must be B, T or C")
          f.vjust = v
          if (textAttrs.length > 1) {
            if (textAttrs.length !== 3) c.fail("bad-value", "the text attributes of a field must be 3 characters wide")
            if (textAttrs[1] === "I") f.italic = true
            else if (textAttrs[1] !== "N") c.fail("bad-value", "the italic indicator of a field must be I or N")
            if (textAttrs[2] === "B") f.bold = true
            else if (textAttrs[2] !== "N") c.fail("bad-value", "the bold indicator of a field must be B or N")
          }
          f.name = name === "" ? null : name
        } else if (!c.eol) {
          // KiCad does not read the justification of a version 1 field, and draws it centred; some version 1 files carry it all the same.
          const rest = c.rest().trim()
          if (!/^C[ 	]+C[ 	]*$/.test(rest)) out.notes.push({ code: "ignored-v1", text: `line ${at + 1}: "${rest}" after a field of a version 1 file` })
          c.i = c.s.length
          count("$Comp>F>ignored")
        }
        if (orient !== "H" && orient !== "V") c.fail("bad-value", "the orientation of a field must be H or V")
        endOfLine(c)
        // A field of a slot that the file gives twice: the later one wins, as in KiCad.
        const had = fields.findIndex((q) => q.index === f.index)
        if (had >= 0) fields[had] = f
        else fields.push(f)
        count("$Comp>F")
      } else if (c.compare("$EndComp")) {
        count("$Comp>$EndComp")
        break
      } else {
        // The position line `1 x y` and the matrix line `a b c d`: KiCad reads whatever line is not one of the above this way.
        if (!/^[ \t]*\d+[ \t]+-?\d+[ \t]+-?\d+[ \t]*$/.test(l)) throw new LegacyParseError("unknown-record", `Line ${at + 1}: a line of a symbol this importer does not know (${JSON.stringify(l.slice(0, 60))}).`, at + 1, "$Comp>?")
        if (sawMatrix) throw new LegacyParseError("bad-line", `Line ${at + 1}: a symbol with two orientation matrices.`, at + 1, "$Comp>?")
        c.int()
        c.int()
        c.int()
        const mAt = n
        const mc = cursorAt(mAt, "$Comp>matrix", trimLeft(next("$Comp", "a symbol")))
        const m: number[] = []
        for (let k = 0; k < 4; k++) {
          const v = mc.int()
          if (v < -1 || v > 1) mc.fail("bad-value", "a transform value must be -1, 0 or 1")
          m.push(v)
        }
        endOfLine(mc)
        comp.matrix = m as [number, number, number, number]
        sawMatrix = true
        count("$Comp>orientation")
      }
    }
    if (!sawL) throw new LegacyParseError("bad-line", `Line ${startLine}: a symbol with no \`L\` line.`, startLine, "$Comp")
    if (!sawP) throw new LegacyParseError("bad-line", `Line ${startLine}: a symbol with no \`P\` line.`, startLine, "$Comp")
    if (!sawU) throw new LegacyParseError("bad-line", `Line ${startLine}: a symbol with no \`U\` line.`, startLine, "$Comp")
    if (!sawMatrix) throw new LegacyParseError("bad-line", `Line ${startLine}: a symbol with no orientation matrix.`, startLine, "$Comp")
    comp.fields = fields.sort((a, b) => a.index - b.index)
    return comp
  }

  // ---------- $Sheet ----------
  function readSheet(): LegacySheet {
    count("$Sheet")
    const s: LegacySheet = { x: 0, y: 0, w: 0, h: 0, ts: "00000000", name: "", nameSize: 0, file: "", fileSize: 0, pins: [] }
    let sawS = false
    for (;;) {
      const at = n
      const l = trimLeft(next("$Sheet", "a sheet"))
      const c = cursorAt(at, "$Sheet>?", l)
      if (c.compare("S")) {
        s.x = c.int()
        s.y = c.int()
        s.w = c.int()
        s.h = c.int()
        endOfLine(c)
        sawS = true
        count("$Sheet>S")
      } else if (c.compare("U")) {
        s.ts = c.unquoted().toUpperCase()
        if (!/^[0-9A-F]{1,8}$/.test(s.ts)) c.fail("bad-value", "a sheet timestamp is up to 8 hexadecimal digits")
        s.ts = s.ts.padStart(8, "0")
        endOfLine(c)
        count("$Sheet>U")
      } else if (l[0] === "F" || l[0] === "f") {
        c.i = 1
        const id = c.int()
        if (id === 0 || id === 1) {
          const text = c.quoted()
          const size = c.int()
          endOfLine(c)
          if (id === 0) {
            s.name = text
            s.nameSize = size
            count("$Sheet>F0")
          } else {
            s.file = text
            s.fileSize = size
            count("$Sheet>F1")
          }
        } else {
          const name = c.quoted(true)
          if (c.eol) c.fail("bad-line", "unexpected end of line")
          const shape = c.char()
          if (!SHEET_PIN_SHAPES.has(shape)) c.fail("bad-value", "invalid sheet pin type")
          const side = c.char()
          if (!SHEET_SIDES.has(side)) c.fail("bad-value", "invalid sheet pin side")
          const x = c.int()
          const y = c.int()
          const size = c.int()
          endOfLine(c)
          s.pins.push({ name, shape, side, x, y, size })
          count("$Sheet>Fn")
        }
      } else if (c.compare("$EndSheet")) {
        count("$Sheet>$EndSheet")
        break
      } else throw new LegacyParseError("unknown-record", `Line ${at + 1}: a line of a sheet this importer does not know (${JSON.stringify(l.slice(0, 60))}).`, at + 1, "$Sheet>?")
    }
    if (!sawS) throw new LegacyParseError("bad-line", "A sheet has no `S` line for its place and size.", n, "$Sheet")
    return s
  }

  // ---------- $Bitmap ----------
  function readBitmap(): LegacyBitmap {
    count("$Bitmap")
    const b = { x: 0, y: 0, scale: 1, data: new Uint8Array(0) }
    let sawPos = false
    for (;;) {
      const at = n
      const l = trimLeft(next("$Bitmap", "a picture"))
      const c = cursorAt(at, "$Bitmap>?", l)
      if (c.compare("Pos")) {
        b.x = c.int()
        b.y = c.int()
        endOfLine(c)
        sawPos = true
        count("$Bitmap>Pos")
      } else if (c.compare("Scale")) {
        // A file written in a language that has a decimal comma has `1,000000`; KiCad reads such a number up to the comma. It is read as the number it says.
        const raw = c.unquoted()
        const comma = /^[+-]?\d+,\d+$/.test(raw)
        if (comma) out.notes.push({ code: "comma-decimal", text: `the picture's scale ${raw}` })
        const v = Number(comma ? raw.replace(",", ".") : raw)
        if (!Number.isFinite(v)) c.fail("bad-number", "a number was expected")
        // Prevent scale factors that cannot be displayed (KiCad takes 1 for them).
        b.scale = Number.isFinite(v) && v !== 0 && Math.abs(v) >= 2.2250738585072014e-308 ? v : 1
        count("$Bitmap>Scale")
      } else if (c.compare("Data")) {
        const bytes: number[] = []
        for (;;) {
          const dAt = n
          const d = next("$Bitmap>Data", "a picture's data")
          const dc = cursorAt(dAt, "$Bitmap>Data", d)
          if (dc.compare("EndData")) {
            b.data = Uint8Array.from(bytes)
            count("$Bitmap>Data")
            break
          }
          // Each byte is two hexadecimal digits and a space. Some KiCad 4 files have a stray `$EndBitmap` after the data of the last line, which is dropped.
          let i = 0
          while (i < d.length && !isWhite(d[i]) && d[i] !== "$") {
            const pair = d.slice(i, i + 2)
            if (!/^[0-9A-Fa-f]{1,2}$/.test(pair)) throw new LegacyParseError("bad-value", `Line ${dAt + 1}: invalid picture data.`, dAt + 1, "$Bitmap>Data")
            bytes.push(Number.parseInt(pair, 16))
            i += 3
          }
        }
      } else if (c.compare("$EndBitmap")) {
        count("$Bitmap>$EndBitmap")
        break
      } else throw new LegacyParseError("unknown-record", `Line ${at + 1}: a line of a picture this importer does not know (${JSON.stringify(l.slice(0, 60))}).`, at + 1, "$Bitmap>?")
    }
    if (!sawPos) throw new LegacyParseError("bad-line", "A picture has no `Pos` line.", n, "$Bitmap")
    if (!b.data.length) throw new LegacyParseError("bad-line", "A picture has no data.", n, "$Bitmap")
    return b
  }

  // ---------- wires, entries, texts ----------
  function readWire(c: Cursor): LegacyWire {
    let layer: LegacyWire["layer"]
    if (c.compare("Wire")) layer = "Wire"
    else if (c.compare("Bus")) layer = "Bus"
    else if (c.compare("Notes")) layer = "Notes"
    else c.fail("bad-line", "invalid line type")
    if (!c.compare("Line")) c.fail("bad-line", "invalid wire definition")
    const w: LegacyWire = { layer, x1: 0, y1: 0, x2: 0, y2: 0, width: null, style: null, color: null }
    // Since September 2017 a line style is allowed after `Line`: width, style, colour. Only a value that is not the default is written.
    while (!c.eol) {
      const buf = c.unquoted()
      if (buf === ")") continue
      if (buf === "width") w.width = c.int()
      else if (buf === "style") w.style = c.unquoted()
      else {
        // `rgb(150, 40, 191)` or `rgba(...)`: the first number is stuck to the keyword.
        const open = buf.lastIndexOf("(")
        const keyword = open >= 0 ? buf.slice(0, open) : buf
        if (keyword !== "rgb" && keyword !== "rgba") c.fail("unknown-record", `the line style "${buf}" is not one this importer knows`)
        const all = buf.slice(open + 1) + (c.eol ? "" : ` ${c.rest()}`)
        const close = all.indexOf(")")
        const nums = (close >= 0 ? all.slice(0, close) : all).split(/[ ,]+/).filter((t) => t !== "")
        const want = keyword === "rgba" ? 4 : 3
        const color = [0, 0, 0, 255]
        nums.slice(0, want).forEach((t, k) => {
          if (!/^[+-]?\d+$/.test(t)) c.fail("bad-number", "a colour value must be an integer")
          color[k] = Number(t)
        })
        // The cursor goes past the closing bracket.
        c.i = close >= 0 ? c.s.length - all.slice(close + 1).length : c.s.length
        c.skipSpace()
        w.color = [color[0], color[1], color[2], color[3]]
      }
    }
    const at = n
    const pc = cursorAt(at, "Wire", trimLeft(next("Wire", "a wire")))
    w.x1 = pc.int()
    w.y1 = pc.int()
    w.x2 = pc.int()
    w.y2 = pc.int()
    endOfLine(pc)
    count(`Wire>${layer}`)
    if (w.width !== null || w.style !== null || w.color !== null) count("Wire>style")
    return w
  }

  function readEntry(c: Cursor): LegacyEntry {
    let kind: LegacyEntry["kind"]
    if (c.compare("Wire")) {
      kind = "Wire"
      if (!c.compare("Line")) c.fail("bad-line", "invalid bus entry definition: `Line` was expected")
    } else if (c.compare("Bus")) {
      kind = "Bus"
      if (!c.compare("Bus")) c.fail("bad-line", "invalid bus entry definition: `Bus` was expected")
    } else c.fail("bad-line", "invalid bus entry type")
    endOfLine(c)
    const at = n
    const pc = cursorAt(at, "Entry", trimLeft(next("Entry", "a bus entry")))
    const e: LegacyEntry = { kind, x: pc.int(), y: pc.int(), x2: pc.int(), y2: pc.int() }
    endOfLine(pc)
    count(`Entry>${kind}`)
    return e
  }

  function readText(c: Cursor): LegacyText {
    let kind: LegacyText["kind"]
    if (c.compare("Notes")) kind = "Notes"
    else if (c.compare("Label")) kind = "Label"
    else if (c.compare("HLabel")) kind = "HLabel"
    else if (c.compare("GLabel")) kind = "GLabel"
    else c.fail("unknown-record", "an unknown Text type")
    const x = c.int()
    const y = c.int()
    const spin = c.int()
    if (spin < 0 || spin > 3) c.fail("bad-value", "a label orientation is 0 to 3")
    const size = c.int()
    let shape: string | null = null
    // Prior to version 2 a GLabel was a hierarchical label: `GLabel` stays one in the model (`shape` and no flag) and is read as a global label from version 2.
    const hasShape = kind === "HLabel" || kind === "GLabel"
    if (hasShape) {
      shape = LABEL_SHAPES.find((s) => c.compare(s)) ?? null
      if (shape === null) c.fail("bad-value", "invalid label type")
    }
    let italic = false
    let thickness = 0
    // These tokens do not exist in version 1 files, and not always in version 2 for HLabels and GLabels.
    if (version > 1) {
      if (version > 2 || !c.eol) {
        if (c.compare("Italic")) italic = true
        else if (!c.compare("~")) c.fail("bad-value", "`Italic` or `~` was expected")
      }
      // The pen width does not exist in older files.
      if (!c.eol) thickness = c.int()
    }
    if (version === 1 && !c.eol) {
      // The style tokens do not exist in version 1 files, and KiCad does not read them there; newer KiCad versions write a `~` and a pen width all the same.
      const rest = c.rest().trim()
      if (!/^~(?:[ 	]+0)?$/.test(rest)) out.notes.push({ code: "ignored-v1", text: `line ${n}: "${rest}" after a text of a version 1 file` })
      c.i = c.s.length
      count("Text>ignored")
    }
    endOfLine(c)
    const at = n
    const text = next(`Text>${kind}`, "a text").replace(/[\r\n].*$/s, "")
    void at
    count(`Text>${kind}`)
    return { kind, x, y, spin, size, shape, italic, thickness, text: text.split("\\n").join("\n") }
  }
}

const isWhite = (c: string) => c === " " || c === "\t" || c === "\r" || c === "\n"
