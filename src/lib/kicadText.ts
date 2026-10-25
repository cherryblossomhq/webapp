import { editorGlyphStrokes, EDITOR_GLYPH_CELL } from "./strokeFont"

// This file is ported from KiCad (https://gitlab.com/kicad/code/kicad), the text layout of these files at the commit
// recorded in docs/kicad-import.md section 10: common/font/stroke_font.cpp, common/font/font.cpp, common/font/glyph.cpp,
// common/eda_text.cpp, common/gr_text.cpp, common/string_utils.cpp, include/markup_parser.h (the markup grammar) and
// pcbnew/pcb_text.cpp, pcbnew/pcb_textbox.cpp and pcbnew/plot_brditems_plotter.cpp (how a board's plot lays text out).
//
// Copyright The KiCad Developers, see AUTHORS.txt for contributors. This program source code file is part of KiCad, a
// free EDA CAD application. This program is free software; you can redistribute it and/or modify it under the terms of
// the GNU General Public License as published by the Free Software Foundation; either version 2 of the License, or (at
// your option) any later version. This program is distributed in the hope that it will be useful, but WITHOUT ANY
// WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
// General Public License for more details. You should have received a copy of the GNU General Public License along with
// this program; if not, see <https://www.gnu.org/licenses/>.
//
// What it does: KiCad's text layout, as its source lays text out: the stroke font's glyph placement, character
// spacing, italic slant, the overbar `~{...}`, sub and superscripts, tabs, line spacing and justification. It works in
// KiCad's own frame (y down, a positive angle turns counter-clockwise on screen) and in its own unit, the nanometre,
// where KiCad uses integers: `KiROUND`, the integer cursor and the truncations of `int x = double` are kept, so a text
// lands where KiCad's plot puts it.
//
// The glyph shapes are KiCad's too: its font (`common/newstroke_font.cpp`, GPL-2.0-or-later with the SIL OFL 1.1 notice of
// its CJK glyphs) is in `lib/kicadFont/`, with its licence header, and `loadKicadFont` plugs it in through `setStrokeFont`
// when a project has KiCad text. `editorStrokeFont`, the editor's own letters on KiCad's cell, is what text is laid out
// with until it is loaded.

/** A glyph: its advance and its strokes, in 1/21 of the text size, y down with the baseline at 1 (as KiCad's data has them). */
export interface StrokeGlyph {
  /** Advance, in 1/21 of the glyph width: the cell the next character starts after. */
  width: number
  /** Polylines as flat runs of x, y, x, y... */
  strokes: number[][]
}

export interface StrokeFontData {
  name: string
  /** The glyph of a code point, or undefined when the font has none (the layout then draws `?`). */
  glyph(code: number): StrokeGlyph | undefined
}

const UNITS = 21

/** The editor's glyphs on KiCad's cell: cap height 21 units (y from 1 to -20), every character 20 wide, the space 16, as KiCad's space is. */
export const editorStrokeFont: StrokeFontData = (() => {
  const cache = new Map<number, StrokeGlyph>()
  const s = UNITS / EDITOR_GLYPH_CELL.cap
  const margin = (20 - EDITOR_GLYPH_CELL.width * s) / 2
  return {
    name: "editor",
    glyph(code: number) {
      let g = cache.get(code)
      if (g) return g
      if (code === 32) g = { width: 16, strokes: [] }
      else if (code < 32 || code > 0x2fff) return undefined
      else g = { width: 20, strokes: editorGlyphStrokes(String.fromCodePoint(code)).map((st) => st.flatMap(([x, y]) => [margin + x * s, 1 - y * s])) }
      cache.set(code, g)
      return g
    },
  }
})()

let current: StrokeFontData = editorStrokeFont

/** The font text is laid out with. */
export const strokeFont = (): StrokeFontData => current

/** Plug in another stroke font (`loadKicadFont` plugs in KiCad's); `null` goes back to the editor's glyphs. */
export function setStrokeFont(font: StrokeFontData | null) {
  current = font ?? editorStrokeFont
}

// ---------- numbers as KiCad has them ----------

/** `KiROUND`: round half away from zero. */
export const kiRound = (v: number) => Math.trunc(v < 0 ? v - 0.5 : v + 0.5)

/** Millimetres to board units (nanometres), as KiCad reads a number in a file. */
export const mmToIu = (mm: number) => kiRound(mm * 1e6)

export const iuToMm = (iu: number) => iu / 1e6

interface P {
  x: number
  y: number
}

const D2R = Math.PI / 180

/** `RotatePoint` about a centre: a positive angle turns counter-clockwise on screen (y down), the quarter turns exact. `integer` rounds as the integer version does. */
function rotate(p: P, c: P, deg: number, integer = false): P {
  let a = deg % 360
  if (a < 0) a += 360
  if (a === 0) return { x: p.x, y: p.y }
  const ox = p.x - c.x
  const oy = p.y - c.y
  let x: number
  let y: number
  if (a === 90) [x, y] = [oy, -ox]
  else if (a === 180) [x, y] = [-ox, -oy]
  else if (a === 270) [x, y] = [-oy, ox]
  else {
    const sin = Math.sin(a * D2R)
    const cos = Math.cos(a * D2R)
    x = oy * sin + ox * cos
    y = oy * cos - ox * sin
    if (integer) [x, y] = [kiRound(x), kiRound(y)]
  }
  return { x: x + c.x, y: y + c.y }
}

// ---------- pen width ----------

/** A bold stroke font's width is its base width times this (`BOLD_STROKE_MULTIPLIER`, include/gr_text.h). */
export const BOLD_STROKE_MULTIPLIER = 1.6

/** What KiCad draws a text's strokes with (`EDA_TEXT::GetEffectiveTextPenWidth`, 10.0.0 eda_text.cpp:479): the thickness, or a width and a bold or normal default when there is none, never more than a quarter of the smaller size. Everything in nanometres. */
export function effectivePenWidth(thickness: number, bold: boolean, w: number, h: number): number {
  let pen = thickness
  if (pen <= 1) {
    pen = 0
    if (bold) pen = kiRound(w / 5)
    else pen = kiRound(w / 8)
  } else if (bold) pen = kiRound(pen * BOLD_STROKE_MULTIPLIER)
  return Math.min(pen, kiRound(Math.min(Math.abs(w), Math.abs(h)) * 0.25))
}

/** Margin of a knockout text's box (`GetKnockoutTextMargin`, include/gr_text.h). */
export const knockoutMargin = (h: number, pen: number) => Math.max(kiRound(pen / 2), kiRound(h / 9))

// ---------- markup ----------

type MarkupType = "root" | "text" | "sub" | "sup" | "over"

interface MarkupNode {
  type: MarkupType
  text?: string
  children: MarkupNode[]
}

const isIdentFirst = (c: string) => /[A-Za-z_]/.test(c)
const isIdent = (c: string) => /[A-Za-z0-9_]/.test(c)

/**
 * KiCad's markup grammar (`markup_parser.h`): `~{overbar}`, `_{subscript}` and `^{superscript}`, nested; an
 * `{identifier}` inside the braces is kept whole (`{slash}`); a run of `http://` or `https://` up to a space is a
 * link, drawn as text; a marker with no closing brace is plain text. The returned tree is what the PEG parse tree
 * keeps: text nodes carry content, a marker with nothing in it is dropped.
 */
export function parseMarkup(source: string): MarkupNode {
  const s = [...source]
  const n = s.length

  const markerAt = (i: number): MarkupType | null => (s[i + 1] === "{" ? (s[i] === "_" ? "sub" : s[i] === "^" ? "sup" : s[i] === "~" ? "over" : null) : null)

  /** Where a marker that opens at i ends and what it holds, or null when it never closes. */
  const braces = (i: number): { end: number; node: MarkupNode } | null => {
    const type = markerAt(i)
    if (!type) return null
    const node: MarkupNode = { type, children: [] }
    let p = i + 2
    for (;;) {
      if (p >= n) return null
      if (s[p] === "}") return { end: p + 1, node: node.children.length ? node : { type, children: [] } }
      // anyStringWithinBraces: characters that do not start a marker that parses, `{identifier}` kept whole
      const start = p
      while (p < n && s[p] !== "}") {
        if (markerAt(p) && braces(p)) break
        if (s[p] === "{" && p + 1 < n && isIdentFirst(s[p + 1])) {
          let q = p + 2
          while (q < n && isIdent(s[q])) q++
          if (s[q] === "}") {
            p = q + 1
            continue
          }
        }
        p++
      }
      if (p > start) {
        node.children.push({ type: "text", text: s.slice(start, p).join(""), children: [] })
        continue
      }
      const nested = markerAt(p) ? braces(p) : null
      if (!nested) return null
      if (nested.node.children.length) node.children.push(nested.node)
      p = nested.end
    }
  }

  const urlAt = (i: number): boolean => {
    const rest = s.slice(i, i + 8).join("")
    const len = rest.startsWith("https://") ? 8 : rest.startsWith("http://") ? 7 : 0
    return len > 0 && i + len < n && s[i + len] !== " "
  }

  const root: MarkupNode = { type: "root", children: [] }
  let p = 0
  while (p < n) {
    if (markerAt(p)) {
      const b = braces(p)
      if (b) {
        if (b.node.children.length) root.children.push(b.node)
        p = b.end
        continue
      }
    }
    if (urlAt(p)) {
      let q = p
      while (q < n && s[q] !== " ") q++
      root.children.push({ type: "text", text: s.slice(p, q).join(""), children: [] })
      p = q
      continue
    }
    // anyString: up to the next marker that parses or link
    const start = p
    p++
    while (p < n && !(markerAt(p) && braces(p)) && !urlAt(p)) p++
    root.children.push({ type: "text", text: s.slice(start, p).join(""), children: [] })
  }
  return root
}

// ---------- layout ----------

const ITALIC = 1
const SUBSCRIPT = 4
const SUPERSCRIPT = 8
const OVERBAR_STYLE = 16

/** Italic slant (`ITALIC_TILT`, font.h:58), sub and superscript size and baseline shifts (stroke_font.h:108-110), the overbar height and the interline of KiCad's metrics (font_metrics.h) with the stroke font's legacy factor (stroke_font.cpp). */
export const TEXT_RULES = { italicTilt: 1 / 8, superSubSize: 0.8, subscriptShift: 0.15, superscriptShift: -0.35, overbarHeight: 1.23, interline: 1.68, legacyInterline: 0.9583, tab: 4, interChar: 0.2 } as const

type Polyline = P[]

interface Draw {
  font: StrokeFontData
  size: P
  angle: number
  mirror: boolean
  origin: P
  out: Polyline[] | null
}

function glyphOf(font: StrokeFontData, code: number): StrokeGlyph {
  return font.glyph(code) ?? font.glyph(63) ?? { width: 20, strokes: [] }
}

/** `STROKE_FONT::GetTextAsGlyphs` (stroke_font.cpp): the strokes of one run of text, and the cursor after it. */
function textAsGlyphs(d: Draw, text: string, aSize: P, aPos: P, style: number): P {
  const cursor = { x: aPos.x, y: aPos.y }
  let gs: P = { x: aSize.x, y: aSize.y }
  const tilt = style & ITALIC ? TEXT_RULES.italicTilt : 0
  const spaceW = glyphOf(d.font, 32).width / UNITS
  let count = 0
  if (style & (SUBSCRIPT | SUPERSCRIPT)) {
    gs = { x: gs.x * TEXT_RULES.superSubSize, y: gs.y * TEXT_RULES.superSubSize }
    cursor.y = Math.trunc(cursor.y + gs.y * (style & SUBSCRIPT ? TEXT_RULES.subscriptShift : TEXT_RULES.superscriptShift))
  }
  for (const ch of text) {
    const c = ch.codePointAt(0)!
    if (c === 9) {
      count = (Math.trunc(count / TEXT_RULES.tab) + 1) * TEXT_RULES.tab - 1
      let next = Math.trunc(aPos.x + aSize.x * count + aSize.x * spaceW)
      while (next <= cursor.x) {
        count += TEXT_RULES.tab
        next += aSize.x * TEXT_RULES.tab
      }
      cursor.x = next
    } else if (c === 32) {
      cursor.x += kiRound(gs.x * spaceW)
    } else {
      const g = glyphOf(d.font, c)
      if (d.out) {
        for (const st of g.strokes) {
          const line: Polyline = []
          for (let i = 0; i + 1 < st.length; i += 2) {
            let x = (st[i] / UNITS) * gs.x
            const y = (st[i + 1] / UNITS) * gs.y
            if (tilt) x -= y * tilt
            let pt: P = { x: x + cursor.x, y: y + cursor.y }
            if (d.mirror) pt = { x: d.origin.x - (pt.x - d.origin.x), y: pt.y }
            if (d.angle) pt = rotate(pt, d.origin, d.angle)
            line.push(pt)
          }
          if (line.length) d.out.push(line)
        }
      }
      cursor.x += kiRound((g.width / UNITS) * gs.x)
    }
    count++
  }
  return { x: cursor.x, y: aPos.y }
}

/** `drawMarkup` (font.cpp): a node and its children from a position, with the overbar drawn over what the marker holds. Returns the cursor after it. */
function drawNode(d: Draw, node: MarkupNode, aPos: P, style: number): P {
  let next = aPos
  let overbar = false
  let st = style
  if (node.type !== "root") {
    if (node.type === "sub") st |= SUBSCRIPT
    else if (node.type === "sup") st |= SUPERSCRIPT
    if (node.type === "over") overbar = true
    if (node.type === "text") next = textAsGlyphs(d, node.text!, d.size, next, st)
  }
  for (const child of node.children) next = drawNode(d, child, next, st)
  if (overbar && d.out) {
    const trim = d.size.x * 0.1
    const offset = d.size.y * TEXT_RULES.overbarHeight
    const a: P = { x: aPos.x + trim, y: aPos.y - offset }
    const b: P = { x: next.x - trim, y: aPos.y - offset }
    const bar = [a, b].map((pt) => {
      let q = pt
      if (d.mirror) q = { x: d.origin.x - (q.x - d.origin.x), y: q.y }
      if (d.angle) q = rotate(q, d.origin, d.angle)
      return q
    })
    d.out.push(bar)
  }
  return next
}

/** The advance of a line of text (`boundingBoxSingleLine`, font.cpp): where the cursor ends, as a distance from the start. */
function lineExtent(font: StrokeFontData, text: string, size: P, italic: boolean): number {
  const d: Draw = { font, size, angle: 0, mirror: false, origin: { x: 0, y: 0 }, out: null }
  return drawNode(d, parseMarkup(text), { x: 0, y: 0 }, italic ? ITALIC : 0).x
}

/**
 * The size of a text's box as KiCad measures it (`FONT::StringBoundaryLimits` with the stroke font, font.cpp:451 of 10.0.0): the line's advance
 * less the gap after the last character, and the glyph height, each grown by one and a half pens on both sides. Nanometres; a line of
 * plain text (a marker's own box is not measured separately).
 */
export function stringBoundaryLimits(text: string, a: { w: number; h: number; italic: boolean }, pen: number, font: StrokeFontData = current): { w: number; h: number } {
  const size: P = { x: a.w, y: a.h }
  const grow = kiRound(pen * 1.5)
  const width = Math.abs(lineExtent(font, text, size, a.italic) - kiRound(a.w * TEXT_RULES.interChar))
  return { w: width + 2 * grow, h: Math.abs(a.h) + 2 * grow }
}

/** The distance between the baselines of two lines at a glyph height (`STROKE_FONT::GetInterline`, with `EDA_TEXT::GetInterline`'s rounding, line spacing 1). */
export const interlineAt = (h: number) => interlineOf(h, 1)

/** `wxStringSplit`: split at a newline, a trailing empty line dropped. */
export function splitLines(text: string): string[] {
  const out: string[] = []
  let tmp = ""
  for (const ch of text) {
    if (ch === "\n") {
      out.push(tmp)
      tmp = ""
    } else tmp += ch
  }
  if (tmp) out.push(tmp)
  return out
}

export interface TextAttrsIu {
  /** Glyph width and height. */
  w: number
  h: number
  /** The stored thickness; 0 or 1 is automatic. */
  thickness: number
  bold: boolean
  italic: boolean
  mirror: boolean
  /** -1 left, 0 centre, 1 right. */
  hAlign: -1 | 0 | 1
  /** -1 top, 0 centre, 1 bottom. */
  vAlign: -1 | 0 | 1
  lineSpacing: number
}

/** The distance between two lines' baselines (`STROKE_FONT::GetInterline` times `EDA_TEXT::GetInterline`'s rounding). */
const interlineOf = (h: number, spacing: number) => kiRound(h * TEXT_RULES.interline * TEXT_RULES.legacyInterline * spacing)

/** `FONT::getLinePositions` and `drawSingleLineText` for a text laid out from `position`: its lines' strokes, rotated about `position`. */
function fontDraw(font: StrokeFontData, text: string, position: P, a: TextAttrsIu, angle: number, pen: number, out: Polyline[]) {
  const size: P = { x: a.w, y: a.h }
  const lines = splitLines(text)
  const interline = Math.trunc(h2(a.h) * a.lineSpacing)
  let height = 0
  const extents: number[] = []
  lines.forEach((line, i) => {
    extents.push(lineExtent(font, line, size, a.italic))
    if (i === 0) height = Math.trunc(height + a.h * 1.17)
    else height += interline
  })
  const off: P = { x: 0, y: a.h }
  // Fudge factors to match KiCad 6's positioning (font.cpp getLinePositions)
  off.x = Math.trunc(off.x + pen / 1.52)
  off.y = Math.trunc(off.y - pen * 0.052)
  if (a.vAlign === 0) off.y -= Math.trunc(height / 2)
  else if (a.vAlign === 1) off.y -= height
  lines.forEach((line, i) => {
    const lineOff: P = { x: off.x, y: off.y + i * interline }
    if (a.hAlign === 0) lineOff.x = -Math.trunc(extents[i] / 2)
    else if (a.hAlign === 1) lineOff.x = -(extents[i] + off.x)
    const at: P = { x: position.x + lineOff.x, y: position.y + lineOff.y }
    // Each line is drawn from its own place and turned about the position the text was given.
    const d: Draw = { font, size, angle, mirror: a.mirror, origin: position, out }
    drawNode(d, parseMarkup(line), at, a.italic ? ITALIC : 0)
  })
}

const h2 = (h: number) => h * TEXT_RULES.interline * TEXT_RULES.legacyInterline

export interface TextStrokes {
  /** The strokes, in nanometres in KiCad's frame. */
  polylines: { x: number; y: number }[][]
  /** The pen they are drawn with, in nanometres. */
  pen: number
}

export interface TextPlace {
  /** The anchor: the point the justification refers to. */
  x: number
  y: number
  /** The angle the text is drawn at (`GetDrawRotation`), degrees. */
  angle: number
}

/**
 * What KiCad plots for a text (`BRDITEMS_PLOTTER::PlotText`, pcbnew/plot_brditems_plotter.cpp:767 of 10.0.0): the strokes of
 * every line, at the pen the thickness and boldness give. Text with `multiline` (board text, a text box) takes the
 * lines' places from `EDA_TEXT::GetLinePositions`; a part's own text lets the font split it. Everything in nanometres.
 */
export function layoutText(shown: string, place: TextPlace, a: TextAttrsIu, multiline: boolean, font: StrokeFontData = current): TextStrokes {
  const pen = effectivePenWidth(a.thickness, a.bold, a.w, a.h)
  const out: Polyline[] = []
  if (!shown) return { polylines: out, pen }
  const pos: P = { x: place.x, y: place.y }
  if (multiline) {
    const lines = splitLines(shown)
    // `EDA_TEXT::GetInterline` of KiCad 9 and 10 (eda_text.cpp:715-717 in 9.0.0, 749-751 in 10.0.0) has no line spacing in it: the
    // lines of a board text or a text box are placed one interline apart whatever the file's `line_spacing` says (master multiplies by it).
    const step: P = { x: 0, y: interlineOf(a.h, 1) }
    let first = { ...pos }
    if (lines.length > 1) {
      if (a.vAlign === 0) first.y -= Math.trunc(((lines.length - 1) * step.y) / 2)
      else if (a.vAlign === 1) first.y -= (lines.length - 1) * step.y
    }
    first = rotate(first, pos, place.angle, true)
    const turned = rotate(step, { x: 0, y: 0 }, place.angle, true)
    lines.forEach((line, i) => {
      const at = { x: first.x + i * turned.x, y: first.y + i * turned.y }
      fontDraw(font, line, at, a, place.angle, pen, out)
    })
  } else fontDraw(font, shown, pos, a, place.angle, pen, out)
  return { polylines: out, pen }
}

/** Text with its lines broken to a column (`FONT::LinebreakText`, font.cpp): what a text box shows. */
export function linebreakText(text: string, columnWidth: number, a: Pick<TextAttrsIu, "w" | "h" | "italic" | "bold">, thickness: number, font: StrokeFontData = current): string {
  const size: P = { x: a.w, y: a.h }
  const style = a.italic ? ITALIC : 0
  const d = (t: string) => lineExtent(font, t, size, a.italic)
  const spaceWidth = d(" ")
  let result = ""
  const lines = splitLines(text)
  lines.forEach((line, li) => {
    const markup: [string, number][] = []
    wordbreak(markup, parseMarkup(line), size, style, font, false)
    const words: [string, number][] = []
    for (const [run, w] of markup) {
      if (words.length && !words[words.length - 1][0].endsWith(" ")) {
        words[words.length - 1][0] += run
        words[words.length - 1][1] += w
      } else words.push([run, w])
    }
    let bury = false
    let lineWidth = 0
    let pending = ""
    for (const [word, wordWidth] of words) {
      let pendingWidth = pending.length * spaceWidth
      const overflow = lineWidth + pendingWidth + wordWidth > columnWidth - thickness
      if (overflow && pending.length > 0) {
        result += "\n"
        lineWidth = 0
        pending = ""
        pendingWidth = 0
        bury = true
      }
      if (word === " ") pending += word
      else {
        if (bury) bury = false
        else {
          result += pending
          lineWidth += pendingWidth
        }
        if (word.endsWith(" ")) {
          result += word.slice(0, -1)
          pending = " "
        } else {
          result += word
          pending = ""
        }
        lineWidth += wordWidth
      }
    }
    if (li !== lines.length - 1) result += "\n"
  })
  return result
}

/** `wordbreakMarkup` (font.cpp): the words of a marked-up line, each with its width. */
function wordbreak(words: [string, number][], node: MarkupNode, size: P, style: number, font: StrokeFontData, inside: boolean) {
  let st = style
  const width = (t: string, s: number) => {
    const d: Draw = { font, size, angle: 0, mirror: false, origin: { x: 0, y: 0 }, out: null }
    return textAsGlyphs(d, t, size, { x: 0, y: 0 }, s).x
  }
  if (node.type !== "root") {
    let escape = ""
    if (node.type === "sub") {
      escape = "_"
      st = SUBSCRIPT
    } else if (node.type === "sup") {
      escape = "^"
      st = SUPERSCRIPT
    }
    if (node.type === "over") {
      escape = "~"
      st |= OVERBAR_STYLE
    }
    if (escape) {
      let word = `${escape}{`
      let w = 0
      if (node.text !== undefined) {
        word += node.text
        w += width(node.text, st)
      }
      const child: [string, number][] = []
      for (const c of node.children) wordbreak(child, c, size, st, font, true)
      for (const [t, cw] of child) {
        word += t
        w += cw
      }
      word += "}"
      words.push([word, w])
      return
    } else if (inside) {
      words.push([node.text ?? "", width(node.text ?? "", st)])
    } else {
      // A run of text: its words, each keeping the space that ends it (wxTOKEN_RET_DELIMS).
      const run = node.text ?? ""
      const tokens = run.match(/[^ ]* ?/g)?.filter((t) => t.length) ?? []
      for (const word of tokens) {
        const chars = word.replace(/\s+$/, "")
        words.push([word, width(chars === "" ? word : chars, st)])
      }
    }
  }
  for (const c of node.children) wordbreak(words, c, size, st, font, inside)
}

// ---------- boxes ----------

export interface IuBox {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

/** The box of strokes grown by half the pen: the ink of a text. */
export function inkBox(strokes: TextStrokes): IuBox | null {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const line of strokes.polylines) {
    for (const p of line) {
      minX = Math.min(minX, p.x)
      minY = Math.min(minY, p.y)
      maxX = Math.max(maxX, p.x)
      maxY = Math.max(maxY, p.y)
    }
  }
  if (!Number.isFinite(minX)) return null
  const r = strokes.pen / 2
  return { minX: minX - r, minY: minY - r, maxX: maxX + r, maxY: maxY + r }
}
