/*
 * Reader of KiCad's legacy symbol libraries (`EESchema-LIBRARY Version 2.3` and `2.4`: the `.lib`
 * files of KiCad 4 and 5, and the `-cache.lib` and `.cache.lib` a schematic keeps beside it), and
 * the symbols they hold as the KiCad 6 symbols KiCad converts them to. It is a port of
 * `SCH_LEGACY_PLUGIN_CACHE::Load`, `loadPart`, `loadAliases`, `loadField`, `loadDrawEntries`,
 * `loadArc`, `loadCircle`, `loadText`, `loadRectangle`, `loadPin`, `loadPolyLine`, `loadBezier`
 * and `loadFootprintFilters` of KiCad's `sch_legacy_plugin.cpp` (KiCad 5.1 and 6.0), and of
 * `TRANSFORM::MapAngles` (`transform.cpp`), which decides which way round a legacy arc is drawn.
 *
 * As the schematic reader, it refuses every line it does not know, where KiCad skips them.
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

import { convertOverbar } from "../../board/read"
import { Cursor, LegacyParseError, linesOf, milToMm, tokensOf } from "./text"

export type LegacyFill = "none" | "outline" | "background"

export interface LegacyLibField {
  /** 0 reference, 1 value, 2 footprint, 3 datasheet, then the user's. */
  index: number
  text: string
  x: number
  y: number
  size: number
  /** `H` or `V`. */
  orient: string
  visible: boolean
  hjust: string
  vjust: string
  italic: boolean
  bold: boolean
  name: string | null
}

export interface LegacyLibPin {
  name: string
  number: string
  x: number
  y: number
  length: number
  /** `R`, `L`, `U` or `D`: the way the pin points from its connection point toward the body. */
  orient: string
  numSize: number
  nameSize: number
  unit: number
  convert: number
  /** The type letter of the file. */
  type: string
  shape: string
  hidden: boolean
}

export type LegacyLibShape =
  | { kind: "arc"; cx: number; cy: number; r: number; a1: number; a2: number; unit: number; convert: number; width: number; fill: LegacyFill; start: [number, number]; end: [number, number] }
  | { kind: "circle"; cx: number; cy: number; r: number; unit: number; convert: number; width: number; fill: LegacyFill }
  | { kind: "rect"; x1: number; y1: number; x2: number; y2: number; unit: number; convert: number; width: number; fill: LegacyFill }
  | { kind: "poly" | "bezier"; points: [number, number][]; unit: number; convert: number; width: number; fill: LegacyFill }
  | { kind: "text"; orient: number; x: number; y: number; size: number; hidden: boolean; unit: number; convert: number; text: string; italic: boolean; bold: boolean; hjust: string; vjust: string }

export interface LegacyPart {
  name: string
  prefix: string
  pinNameOffset: number
  showPinNumbers: boolean
  showPinNames: boolean
  unitCount: number
  /** `L`: the units are not interchangeable. */
  unitsLocked: boolean
  power: boolean
  /** The name began with `~`: the value field is not shown. */
  valueHidden: boolean
  aliases: string[]
  fields: LegacyLibField[]
  /** The drawing's shapes and pins, in file order. */
  items: ({ item: "shape"; shape: LegacyLibShape } | { item: "pin"; pin: LegacyLibPin })[]
  footprints: string[]
}

export interface LegacyLibrary {
  /** The format version, `[2, 4]`. */
  version: [number, number]
  /** `EESchema-LIB` files (`.sym`: one symbol to reuse shapes) rather than `EESchema-LIBRARY`. */
  isSymbolFile: boolean
  parts: LegacyPart[]
  /** Every name a symbol can be found by: the symbols' own, and their aliases (a name used twice in a library is renamed `name1`, `name12`... as 5.1's `checkForDuplicates` does). */
  byName: Map<string, LegacyPart>
  /** Every record of the file by path with its count. */
  records: Map<string, number>
}

const PIN_TYPES: Record<string, string> = { I: "input", O: "output", B: "bidirectional", T: "tri_state", P: "passive", U: "unspecified", W: "power_in", w: "power_out", C: "open_collector", E: "open_emitter", N: "no_connect" }

const INVERTED = 1
const CLOCK = 2
const LOWLEVEL_IN = 4
const LOWLEVEL_OUT = 8
const FALLING_EDGE = 16
const NONLOGIC = 32
const PIN_SHAPES: Record<number, string> = {
  0: "line",
  [INVERTED]: "inverted",
  [CLOCK]: "clock",
  [INVERTED | CLOCK]: "inverted_clock",
  [LOWLEVEL_IN]: "input_low",
  [LOWLEVEL_IN | CLOCK]: "clock_low",
  [LOWLEVEL_OUT]: "output_low",
  [FALLING_EDGE]: "edge_clock_high",
  [NONLOGIC]: "non_logic",
}

/** `NORMALIZE_ANGLE_POS` in tenths of a degree. */
const norm = (a: number) => ((a % 3600) + 3600) % 3600

/** `TRANSFORM::MapAngles` with KiCad's own default transform (1, 0, 0, -1): whether the arc's two ends are swapped when it is drawn. The angles are in tenths of a degree. */
export function mapAnglesSwaps(angle1: number, angle2: number): boolean {
  let a1 = angle1
  let a2 = angle2
  const delta = a2 - a1
  if (delta >= 1800) {
    a1 -= 1
    a2 += 1
  }
  const map = (a: number) => {
    const x = Math.cos((a / 10) * (Math.PI / 180))
    const y = Math.sin((a / 10) * (Math.PI / 180))
    const t = x * 1 + y * 0
    const yy = x * 0 + y * -1
    return Math.round((Math.atan2(yy, t) * 180 * 10) / Math.PI)
  }
  a1 = norm(map(a1))
  a2 = norm(map(a2))
  if (a2 < a1) a2 += 3600
  return a2 - a1 > 1800
}

export function readLegacyLibraryText(text: string): LegacyLibrary {
  if (!text.trim()) throw new LegacyParseError("empty", "The library is empty.")
  const lines = linesOf(text.replace(/^﻿/, ""))
  const records = new Map<string, number>()
  const count = (path: string) => records.set(path, (records.get(path) ?? 0) + 1)
  let n = 0
  const cursorAt = (i: number, path: string, s?: string) => new Cursor(s ?? lines[i] ?? "", 0, i + 1, path)
  const next = (path: string, what: string): string => {
    if (n >= lines.length) throw new LegacyParseError("truncated", `The library ends inside ${what}; it looks cut short.`, lines.length, path)
    return lines[n++]
  }

  const head = cursorAt(0, "header", lines[n++])
  let isSymbolFile = false
  if (!head.compare("EESchema-LIBRARY Version")) {
    if (!head.compare("EESchema-LIB Version")) throw new LegacyParseError("not-legacy", "This file does not begin with `EESchema-LIBRARY Version`, so it is not a KiCad 4 or 5 symbol library.", 1, "header")
    isSymbolFile = true
  }
  // The version is `major.minor`; the date after it is not read.
  const m = /^(\d+)\.(\d+)(?:[ 	]|$)/.exec(head.rest())
  if (!m) throw new LegacyParseError("bad-line", "Line 1: the version in the header is not written `major.minor`.", 1, "header")
  const version: [number, number] = [Number(m[1]), Number(m[2])]
  const minor = version[1]
  if (version[0] < 1 || minor < 0 || minor > 99) throw new LegacyParseError("bad-value", `Line 1: the library version ${version.join(".")} is not one KiCad has written.`, 1, "header")
  count("header")
  const after = (maj: number, min: number) => version[0] * 100 + version[1] > maj * 100 + min

  const parts: LegacyPart[] = []
  const byName = new Map<string, LegacyPart>()

  while (n < lines.length) {
    const at = n
    const raw = lines[n++]
    if (raw[0] === "#" || raw.trim() === "") {
      count("comment")
      continue
    }
    const c = cursorAt(at, "?", raw)
    if (!isSymbolFile && c.compare("$HEADER")) {
      // Headers were only in older library formats.
      for (;;) {
        const l = next("header", "the library header")
        const lc = cursorAt(n - 1, "header", l)
        if (lc.compare("TimeStamp")) continue
        if (lc.compare("$ENDHEADER")) break
        throw new LegacyParseError("unknown-record", `Line ${n}: the library header has a line this importer does not know (${JSON.stringify(l.slice(0, 60))}).`, n, "header>?")
      }
      count("$HEADER")
    } else if (c.compare("DEF")) parts.push(readPart(c, at + 1))
    else throw new LegacyParseError("unknown-record", `Line ${at + 1}: a line of the library this importer does not know (${JSON.stringify(raw.slice(0, 60))}).`, at + 1, "?")
  }

  // Register the names: the symbols' own, then their aliases, a name already taken is renamed as 5.1 renames it: `name1`, then `name12`...
  for (const part of parts) {
    for (const alias of part.aliases) {
      if (!byName.has(alias)) {
        byName.set(alias, part)
        continue
      }
      // 5.1 `checkForDuplicates` (`sch_legacy_plugin.cpp:2792`): the counter is appended to the name being tried, so the tries are `A1`, `A12`, `A123`...
      let cur = alias
      let counter = 1
      let renamed = alias
      while (byName.has(renamed)) {
        cur += String(counter++)
        renamed = cur
      }
      if (alias === part.name) part.name = renamed
      else part.aliases[part.aliases.indexOf(alias)] = renamed
      byName.set(renamed, part)
    }
  }
  return { version, isSymbolFile, parts, byName, records }

  function readPart(c: Cursor, startLine: number): LegacyPart {
    count("DEF")
    const t = tokensOf(c.rest())
    if (t.length < 8) c.fail("bad-line", "invalid symbol definition")
    const [name, prefix, , offset, showNum, showName, units, lock, power] = t
    const pinOffset = Number(offset)
    if (!/^[+-]?\d+$/.test(offset)) c.fail("bad-number", "invalid pin offset")
    if (showNum !== "Y" && showNum !== "N") c.fail("bad-value", "expected Y or N")
    if (showName !== "Y" && showName !== "N") c.fail("bad-value", "expected Y or N")
    if (!/^[+-]?\d+$/.test(units)) c.fail("bad-number", "invalid unit count")
    let unitsLocked = false
    // In version 2.2 and earlier this was a placeholder 0 for units that are never interchangeable.
    if (!after(2, 2)) {
      /* the token is skipped */
    } else if (lock === "L") unitsLocked = true
    else if (lock !== "F" && lock !== "0") c.fail("bad-value", "expected L, F or 0")
    let isPower = false
    if (power !== undefined) {
      if (power === "P") isPower = true
      else if (power !== "N") c.fail("bad-value", "expected P or N")
    }
    if (t.length > 9) c.fail("bad-line", "unexpected text at the end of the definition")
    const valueHidden = name.startsWith("~") && name.length > 0
    const partName = name === "" ? "~" : valueHidden ? name.slice(1) : name
    const part: LegacyPart = {
      name: partName,
      prefix,
      pinNameOffset: pinOffset,
      showPinNumbers: showNum !== "N",
      showPinNames: showName !== "N",
      unitCount: Math.max(1, Number(units)),
      unitsLocked,
      power: isPower,
      valueHidden,
      aliases: [partName],
      fields: [],
      items: [],
      footprints: [],
    }
    for (;;) {
      const at = n
      const raw = next("DEF", `the symbol ${partName}`)
      const l = raw
      const lc = cursorAt(at, "DEF>?", l)
      if (l[0] === "#") count("DEF>comment")
      else if (lc.compare("Ti")) count("DEF>Ti")
      else if (lc.compare("ALIAS")) {
        for (const a of tokensOf(lc.rest())) part.aliases.push(a)
        count("DEF>ALIAS")
      } else if (l[0] === "F") readField(part, lc)
      else if (lc.compare("DRAW")) readDraw(part)
      else if (lc.compare("$FPLIST")) {
        for (;;) {
          const fAt = n
          const f = next("$FPLIST", "a footprint filter list")
          const fc = cursorAt(fAt, "DEF>$FPLIST", f)
          if (fc.compare("$ENDFPLIST")) break
          part.footprints.push(fc.unquoted())
        }
        count("DEF>$FPLIST")
      } else if (lc.compare("ENDDEF")) {
        count("DEF>ENDDEF")
        break
      } else if (l.trim() === "") count("DEF>blank")
      else throw new LegacyParseError("unknown-record", `Line ${at + 1}: a line of the symbol ${partName} this importer does not know (${JSON.stringify(l.slice(0, 60))}).`, at + 1, "DEF>?")
    }
    void startLine
    return part
  }

  function readField(part: LegacyPart, c: Cursor) {
    const idm = /^F(\d+)/.exec(c.s)
    if (!idm) c.fail("bad-number", "invalid field ID")
    const index = Number(idm[1])
    c.i = c.s.indexOf('"')
    if (c.i < 0) c.fail("bad-line", "unexpected end of line")
    let text = c.quoted(true)
    // The `.lib` files of old doctors blank fields with a `~`.
    if (text === "~") text = ""
    const x = c.int()
    const y = c.int()
    const size = c.int()
    const orient = c.char()
    if (orient !== "H" && orient !== "V") c.fail("bad-value", "invalid field text orientation parameter")
    const vis = c.char()
    if (vis !== "V" && vis !== "I") c.fail("bad-value", "invalid field text visibility parameter")
    const f: LegacyLibField = { index, text, x, y, size, orient, visible: vis === "V", hjust: "C", vjust: "C", italic: false, bold: false, name: null }
    // The attributes are in the file when it has anything but the name left.
    if (!c.eol && c.s[c.i] !== '"') {
      const hj = c.char()
      if (hj !== "C" && hj !== "L" && hj !== "R") c.fail("bad-value", "invalid field text horizontal justification")
      f.hjust = hj
      const attrs = c.unquoted()
      if (!(attrs.length === 3 || attrs.length === 1)) c.fail("bad-value", "invalid field text attributes size")
      if (attrs[0] !== "C" && attrs[0] !== "B" && attrs[0] !== "T") c.fail("bad-value", "invalid field text vertical justification")
      f.vjust = attrs[0]
      if (attrs.length === 3) {
        if (attrs[1] === "I") f.italic = true
        else if (attrs[1] !== "N") c.fail("bad-value", "invalid field text italic parameter")
        if (attrs[2] === "B") f.bold = true
        else if (attrs[2] !== "N") c.fail("bad-value", "invalid field text bold parameter")
      }
    }
    if (index >= 4) f.name = c.quoted(true) || null
    if (!c.eol) c.fail("bad-line", `unexpected text "${c.rest().slice(0, 30)}" at the end of the line`)
    // The first four slots always exist; a field of a slot the file gives twice is replaced, as in KiCad.
    const had = part.fields.findIndex((q) => q.index === index)
    if (had >= 0) part.fields[had] = f
    else part.fields.push(f)
    count("DEF>F")
  }

  function fillOf(c: Cursor): LegacyFill {
    const ch = c.char()
    if (ch === "F") return "outline"
    if (ch === "f") return "background"
    if (ch === "N") return "none"
    return c.fail("bad-value", "invalid fill type, expected f, F, or N")
  }
  function end(c: Cursor) {
    if (!c.eol) c.fail("bad-line", `unexpected text "${c.rest().slice(0, 30)}" at the end of the line`)
  }

  function readDraw(part: LegacyPart) {
    count("DEF>DRAW")
    for (;;) {
      const at = n
      const l = next("DRAW", "a symbol's drawing")
      const kind = l[0]
      const c = cursorAt(at, `DRAW>${kind ?? "?"}`, l)
      if (c.compare("ENDDRAW")) {
        count("DRAW>ENDDRAW")
        return
      }
      if (kind === "A") {
        c.compare("A")
        const cx = c.int()
        const cy = c.int()
        const r = c.int()
        let a1 = c.int()
        let a2 = c.int()
        a1 = norm(a1)
        a2 = norm(a2)
        const unit = c.int()
        const convert = c.int()
        const width = c.int()
        let fill: LegacyFill = "none"
        // Old libraries (version 2.2 and before) do not always have the fill mode when it is none.
        if (!c.eol) fill = fillOf(c)
        let start: [number, number]
        let endPt: [number, number]
        if (!c.eol) {
          start = [c.int(), c.int()]
          endPt = [c.int(), c.int()]
        } else {
          // The ends are not in the file (an old library): from the centre, the radius and the angles.
          const rot = (angle: number): [number, number] => {
            const t = (-angle / 10) * (Math.PI / 180)
            return [Math.round(cx + r * Math.cos(t)), Math.round(cy - r * Math.sin(t) * -1)]
          }
          // RotatePoint( &p, -angle ) of the point (r, 0): counter-clockwise on a y-down screen is clockwise in the library's y-up, so the library point is (r cos a, r sin a).
          void rot
          const pt = (angle: number): [number, number] => [Math.round(cx + r * Math.cos((angle / 10) * (Math.PI / 180))), Math.round(cy + r * Math.sin((angle / 10) * (Math.PI / 180)))]
          start = pt(a1)
          endPt = pt(a2)
        }
        end(c)
        part.items.push({ item: "shape", shape: { kind: "arc", cx, cy, r, a1, a2, unit, convert, width, fill, start, end: endPt } })
        count("DRAW>A")
      } else if (kind === "C") {
        c.compare("C")
        const cx = c.int()
        const cy = c.int()
        const r = c.int()
        const unit = c.int()
        const convert = c.int()
        const width = c.int()
        const fill = c.eol ? "none" : fillOf(c)
        end(c)
        part.items.push({ item: "shape", shape: { kind: "circle", cx, cy, r, unit, convert, width, fill } })
        count("DRAW>C")
      } else if (kind === "T") {
        c.compare("T")
        const orient = c.int()
        const x = c.int()
        const y = c.int()
        const size = c.int()
        const hidden = c.int() !== 0
        const unit = c.int()
        const convert = c.int()
        let str: string
        if (c.s[c.i] === '"') str = c.quoted()
        else {
          // In old libraries a space in an unquoted text is a `~`.
          str = c.unquoted().replace(/~/g, " ")
        }
        // Two apostrophes are a double quote.
        if (str !== "") str = str.replace(/''/g, '"')
        let italic = false
        let bold = false
        let hjust = "C"
        let vjust = "C"
        if (after(2, 0) && !c.eol) {
          if (c.compare("Italic")) italic = true
          else if (!c.compare("Normal")) c.fail("bad-value", "invalid text style, expected `Normal` or `Italic`")
          if (c.int() > 0) bold = true
          if (!c.eol) {
            hjust = c.char()
            if (hjust !== "L" && hjust !== "C" && hjust !== "R") c.fail("bad-value", "invalid horizontal text justification; expected L, C, or R")
            vjust = c.char()
            if (vjust !== "T" && vjust !== "C" && vjust !== "B") c.fail("bad-value", "invalid vertical text justification; expected T, C, or B")
          }
        }
        end(c)
        part.items.push({ item: "shape", shape: { kind: "text", orient, x, y, size, hidden, unit, convert, text: str, italic, bold, hjust, vjust } })
        count("DRAW>T")
      } else if (kind === "S") {
        c.compare("S")
        const x1 = c.int()
        const y1 = c.int()
        const x2 = c.int()
        const y2 = c.int()
        const unit = c.int()
        const convert = c.int()
        const width = c.int()
        const fill = c.eol ? "none" : fillOf(c)
        end(c)
        part.items.push({ item: "shape", shape: { kind: "rect", x1, y1, x2, y2, unit, convert, width, fill } })
        count("DRAW>S")
      } else if (kind === "X") {
        c.compare("X")
        part.items.push({ item: "pin", pin: readPin(c) })
        count("DRAW>X")
      } else if (kind === "P" || kind === "B") {
        c.compare(kind)
        const np = c.int()
        if (np < 0 || np > 100000) c.fail("bad-value", "an unreasonable number of points")
        const unit = c.int()
        const convert = c.int()
        const width = c.int()
        const points: [number, number][] = []
        for (let i = 0; i < np; i++) points.push([c.int(), c.int()])
        const fill = c.eol ? "none" : fillOf(c)
        end(c)
        part.items.push({ item: "shape", shape: { kind: kind === "P" ? "poly" : "bezier", points, unit, convert, width, fill } })
        count(`DRAW>${kind}`)
      } else if (kind === "#") count("DRAW>comment")
      else if (l.trim() === "") count("DRAW>blank")
      else throw new LegacyParseError("unknown-record", `Line ${at + 1}: an undefined DRAW entry (${JSON.stringify(l.slice(0, 60))}).`, at + 1, "DRAW>?")
    }
  }

  function readPin(c: Cursor): LegacyLibPin {
    const t = tokensOf(c.rest())
    if (t.length < 11) c.fail("bad-line", "invalid pin definition")
    const int = (s: string, what: string) => {
      if (!/^[+-]?\d+$/.test(s)) c.fail("bad-number", `invalid pin ${what}`)
      return Number(s)
    }
    const [name, number, x, y, length, orient, numSize, nameSize, unit, convert, type] = t
    if (orient.length > 1) c.fail("bad-value", "invalid pin orientation")
    if (type.length !== 1 || PIN_TYPES[type] === undefined) c.fail("bad-value", "unknown pin type")
    const pin: LegacyLibPin = {
      name,
      number,
      x: int(x, "X coordinate"),
      y: int(y, "Y coordinate"),
      length: int(length, "length"),
      orient,
      numSize: int(numSize, "number text size"),
      nameSize: int(nameSize, "name text size"),
      unit: int(unit, "unit"),
      convert: int(convert, "alternate body type"),
      type,
      shape: "line",
      hidden: false,
    }
    if (t.length > 12) c.fail("bad-line", "unexpected text at the end of the pin")
    if (t.length === 12) {
      let flags = 0
      for (const ch of [...t[11]].reverse()) {
        if (ch === "~") continue
        else if (ch === "N") pin.hidden = true
        else if (ch === "I") flags |= INVERTED
        else if (ch === "C") flags |= CLOCK
        else if (ch === "L") flags |= LOWLEVEL_IN
        else if (ch === "V") flags |= LOWLEVEL_OUT
        else if (ch === "F") flags |= FALLING_EDGE
        else if (ch === "X") flags |= NONLOGIC
        else c.fail("bad-value", "invalid pin attribute")
      }
      const shape = PIN_SHAPES[flags]
      if (shape === undefined) c.fail("bad-value", "the pin attributes do not define a valid pin shape")
      pin.shape = shape
    }
    return pin
  }
}

// ---------- the symbol as KiCad 6 has it ----------

const q = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\t/g, "\\t")}"`
const num = (mil: number) => String(milToMm(mil) + 0)
const numMm = (mm: number) => String(Math.round(mm * 1e6) / 1e6 + 0)
const ANGLE_ORIENT: Record<string, number> = { R: 0, U: 90, L: 180, D: 270 }

/** A text of the old format as KiCad 6 reads it: the old overbar notation converted, and a lone `~` taken as it is. */
const text6 = (s: string) => convertOverbar(s)

const justifyOf = (h: string, v: string) => {
  const words = [h === "L" ? "left" : h === "R" ? "right" : "", v === "T" ? "top" : v === "B" ? "bottom" : ""].filter(Boolean)
  return words.length ? ` (justify ${words.join(" ")})` : ""
}

const effects = (sizeMil: number, italic: boolean, bold: boolean, h: string, v: string, hide: boolean) => `(effects (font (size ${num(sizeMil)} ${num(sizeMil)})${italic ? " italic" : ""}${bold ? " bold" : ""})${justifyOf(h, v)}${hide ? " hide" : ""})`

function arcText(s: Extract<LegacyLibShape, { kind: "arc" }>): string {
  // KiCad draws a legacy arc by the ends, not the angles: it swaps them as `MapAngles` does, so the arc is the one of at most half a turn.
  const swap = mapAnglesSwaps(s.a1, s.a2)
  const start = swap ? s.end : s.start
  const endPt = swap ? s.start : s.end
  // The middle: from the arc's end, by half the sweep, at the distance of that end from the centre (what KiCad 6 writes).
  const ang = (p: [number, number]) => Math.atan2(p[1] - s.cy, p[0] - s.cx)
  const aStart = ang(start)
  const aEnd = ang(endPt)
  // The sweep from the end counter-clockwise (y up) to the start, which is the arc drawn.
  let sweep = aStart - aEnd
  sweep = ((sweep % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)
  const radius = Math.hypot(endPt[0] - s.cx, endPt[1] - s.cy)
  const mid: [number, number] = [s.cx + radius * Math.cos(aEnd + sweep / 2), s.cy + radius * Math.sin(aEnd + sweep / 2)]
  return `(arc (start ${num(start[0])} ${num(start[1])}) (mid ${numMm(milToMm(mid[0]))} ${numMm(milToMm(mid[1]))}) (end ${num(endPt[0])} ${num(endPt[1])}) (stroke (width ${num(s.width)}) (type default)) (fill (type ${s.fill})))`
}

function shapeText(s: LegacyLibShape): string {
  const look = (width: number, fill: LegacyFill) => `(stroke (width ${num(width)}) (type default)) (fill (type ${fill}))`
  switch (s.kind) {
    case "arc":
      return arcText(s)
    case "circle":
      return `(circle (center ${num(s.cx)} ${num(s.cy)}) (radius ${num(s.r)}) ${look(s.width, s.fill)})`
    case "rect":
      return `(rectangle (start ${num(s.x1)} ${num(s.y1)}) (end ${num(s.x2)} ${num(s.y2)}) ${look(s.width, s.fill)})`
    case "poly":
      return `(polyline (pts ${s.points.map((p) => `(xy ${num(p[0])} ${num(p[1])})`).join(" ")}) ${look(s.width, s.fill)})`
    case "bezier":
      return `(bezier (pts ${s.points.map((p) => `(xy ${num(p[0])} ${num(p[1])})`).join(" ")}) ${look(s.width, s.fill)})`
    case "text":
      return `(text ${q(text6(s.text))} (at ${num(s.x)} ${num(s.y)} ${s.orient}) ${effects(s.size, s.italic, s.bold, s.hjust, s.vjust, s.hidden)})`
  }
}

function pinText(p: LegacyLibPin): string {
  const at = ANGLE_ORIENT[p.orient]
  if (at === undefined) throw new LegacyParseError("bad-value", `The pin ${p.name} (${p.number}) has the orientation "${p.orient}", which is none of R, L, U and D.`, null, "DRAW>X")
  // A name of `~` is no name (the same word KiCad 6 writes for it).
  const name = p.name
  return `(pin ${PIN_TYPES[p.type]} ${p.shape} (at ${num(p.x)} ${num(p.y)} ${at}) (length ${num(p.length)})${p.hidden ? " hide" : ""} (name ${q(text6(name))} (effects (font (size ${num(p.nameSize)} ${num(p.nameSize)})))) (number ${q(text6(p.number))} (effects (font (size ${num(p.numSize)} ${num(p.numSize)})))))`
}

/** One part of a library as the text of the KiCad 6 symbol named `name`, with every field, shape and pin it has. */
export function legacyPartToSymbolText(part: LegacyPart, name: string): string {
  const out: string[] = [`(symbol ${q(name)}`]
  if (part.power) out.push("(power)")
  if (!part.showPinNumbers) out.push("(pin_numbers hide)")
  out.push(`(pin_names (offset ${num(part.pinNameOffset)})${part.showPinNames ? "" : " hide"})`)
  out.push("(in_bom yes) (on_board yes)")
  // The four fields every symbol has, then the user's. The value is the symbol's own name.
  const by = new Map(part.fields.map((f) => [f.index, f]))
  const slots = [0, 1, 2, 3, ...part.fields.filter((f) => f.index >= 4).map((f) => f.index)]
  for (const index of slots) {
    const f = by.get(index)
    if (!f && index >= 4) continue
    const names = ["Reference", "Value", "Footprint", "Datasheet"]
    const fname = index < 4 ? names[index] : (f?.name ?? `Field${index}`)
    let text = f?.text ?? ""
    if (index === 0 && f === undefined) text = part.prefix === "~" ? "" : part.prefix
    // The value field is the symbol's name, whatever the file's field says (KiCad: "Ensure the VALUE field = the part name").
    if (index === 1) text = part.name
    const visible = f ? f.visible : index !== 1 || !part.valueHidden
    if (!f && index > 1) continue
    out.push(
      `(property ${q(fname)} ${q(text6(text))} (at ${num(f?.x ?? 0)} ${num(f?.y ?? 0)} ${f?.orient === "V" ? 90 : 0}) ${effects(f?.size ?? 50, f?.italic ?? false, f?.bold ?? false, f?.hjust ?? "C", f?.vjust ?? "C", !visible)})`,
    )
  }
  if (part.footprints.length) out.push(`(property "ki_fp_filters" ${q(part.footprints.join(" "))} (at 0 0 0) (effects (font (size 1.27 1.27)) hide))`)
  // Items by unit and body style: `_u_c`, 0 for all.
  const groups = new Map<string, string[]>()
  const key = (unit: number, convert: number) => `${unit}_${convert}`
  for (let u = 1; u <= part.unitCount; u++) groups.set(key(u, 1), [])
  for (const it of part.items) {
    const unit = it.item === "pin" ? it.pin.unit : it.shape.unit
    const convert = it.item === "pin" ? it.pin.convert : it.shape.convert
    const k = key(unit, convert)
    const list = groups.get(k) ?? []
    list.push(it.item === "pin" ? pinText(it.pin) : shapeText(it.shape))
    groups.set(k, list)
  }
  for (const [k, list] of [...groups].sort((a, b) => {
    const [au, ac] = a[0].split("_").map(Number)
    const [bu, bc] = b[0].split("_").map(Number)
    return au - bu || ac - bc
  })) {
    out.push(`(symbol ${q(`${name}_${k}`)} ${list.join(" ")})`)
  }
  return `${out.join(" ")})`
}
