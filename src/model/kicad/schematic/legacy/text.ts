/*
 * The line and token readers of KiCad's legacy schematic and library formats.
 *
 * This is a port of the helpers at the top of KiCad's `sch_legacy_plugin.cpp` (the KiCad 5.1
 * and 6.0 legacy eeschema plugin): `strCompare`, `parseInt`, `parseHex`, `parseDouble`,
 * `parseChar`, `parseUnquotedString`, `parseQuotedString`.
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

/** A legacy file that cannot be read: what is wrong, in plain words, with the line it is on. */
export class LegacyParseError extends Error {
  constructor(
    readonly code: "empty" | "not-legacy" | "newer-version" | "truncated" | "bad-line" | "unknown-record" | "bad-number" | "bad-value",
    message: string,
    readonly line: number | null = null,
    /** The record path an unknown or damaged line belongs to, as the accounting names it (`$Comp>?`). */
    readonly path: string | null = null,
  ) {
    super(message)
  }
}

/** Bytes as legacy text: UTF-8 if the bytes are valid UTF-8, else Latin-1 (KiCad's own files of 2012 and before). Says which. */
export function decodeLegacy(bytes: Uint8Array): { text: string; encoding: "utf-8" | "latin-1"; notes: string[] } {
  const notes: string[] = []
  // A byte order mark is not part of the text.
  let start = 0
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) start = 3
  const body = start ? bytes.subarray(start) : bytes
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(body), encoding: "utf-8", notes }
  } catch {
    notes.push("The file is not valid UTF-8, so it was read as Latin-1 (ISO 8859-1), the encoding of KiCad's oldest files.")
    return { text: new TextDecoder("latin1").decode(body), encoding: "latin-1", notes }
  }
}

/** Lines of a text, as KiCad's `FILE_LINE_READER` gives them: split at a line feed, a trailing carriage return removed. */
export function linesOf(text: string): string[] {
  const out = text.split("\n")
  // A file that ends with a line feed has an empty last piece, which is not a line.
  if (out.length && out[out.length - 1] === "") out.pop()
  return out.map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l))
}

const isSpace = (c: string | undefined) => c === " " || c === "\t" || c === "\r" || c === "\n" || c === "\v" || c === "\f"

/** A position in one line, with the line's number for the messages. */
export class Cursor {
  constructor(
    readonly s: string,
    public i: number,
    readonly lineNo: number,
    readonly path: string,
  ) {}

  get eol(): boolean {
    return this.i >= this.s.length
  }

  rest(): string {
    return this.s.slice(this.i)
  }

  fail(code: LegacyParseError["code"], what: string): never {
    throw new LegacyParseError(code, `Line ${this.lineNo}: ${what} (${JSON.stringify(this.s.length > 80 ? `${this.s.slice(0, 80)}...` : this.s)}).`, this.lineNo, this.path)
  }

  skipSpace() {
    while (this.i < this.s.length && isSpace(this.s[this.i])) this.i++
  }

  /** `strCompare`: the token at the cursor, with no regard to case, followed by a space or the end of the line; the cursor moves past it and the spaces after it. */
  compare(token: string): boolean {
    const part = this.s.slice(this.i, this.i + token.length)
    if (part.toLowerCase() !== token.toLowerCase()) return false
    const after = this.s[this.i + token.length]
    if (after !== undefined && !isSpace(after)) return false
    this.i += token.length
    this.skipSpace()
    return true
  }

  /** `strtol` on a base 10 integer, then the spaces after it. A number that does not end at a space or the end of the line is damaged. */
  int(): number {
    if (this.eol) this.fail("bad-line", "unexpected end of line")
    const m = /^[ \t]*([+-]?\d+)/.exec(this.s.slice(this.i))
    if (!m) this.fail("bad-number", "an integer was expected")
    const end = this.i + m[0].length
    if (end < this.s.length && !isSpace(this.s[end])) this.fail("bad-number", `"${this.s.slice(this.i, end + 1).trim()}" is not an integer`)
    const v = Number(m[1])
    if (!Number.isSafeInteger(v) || Math.abs(v) > 2147483647) this.fail("bad-number", "an integer out of range")
    this.i = end
    this.skipSpace()
    return v
  }

  /** `strtoull` base 16, then the spaces after it. */
  hex(): number {
    if (this.eol) this.fail("bad-line", "unexpected end of line")
    const m = /^[ \t]*(?:0[xX])?([0-9a-fA-F]+)/.exec(this.s.slice(this.i))
    if (!m) this.fail("bad-number", "a hexadecimal number was expected")
    const end = this.i + m[0].length
    if (end < this.s.length && !isSpace(this.s[end])) this.fail("bad-number", `"${this.s.slice(this.i, end + 1).trim()}" is not a hexadecimal number`)
    this.i = end
    this.skipSpace()
    return Number.parseInt(m[1], 16)
  }

  /** `strtod`, then the spaces after it. */
  double(): number {
    if (this.eol) this.fail("bad-line", "unexpected end of line")
    const m = /^[ \t]*([+-]?(?:\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?))/.exec(this.s.slice(this.i))
    if (!m) this.fail("bad-number", "a number was expected")
    const end = this.i + m[0].length
    if (end < this.s.length && !isSpace(this.s[end])) this.fail("bad-number", `"${this.s.slice(this.i, end + 1).trim()}" is not a number`)
    this.i = end
    this.skipSpace()
    const v = Number(m[1])
    if (!Number.isFinite(v)) this.fail("bad-number", "a number out of range")
    return v
  }

  /** `parseChar`: one character that stands alone, then the spaces after it. */
  char(): string {
    this.skipSpace()
    if (this.eol) this.fail("bad-line", "unexpected end of line")
    // KiCad's lines keep their line feed, so a character at the very end of a line is followed by a space.
    const next = this.s[this.i + 1]
    if (next !== undefined && !isSpace(next)) this.fail("bad-line", "a single character was expected")
    const c = this.s[this.i]
    this.i += 2
    this.skipSpace()
    return c
  }

  /** `parseUnquotedString`: the characters up to the next space. */
  unquoted(canBeEmpty = false): string {
    this.skipSpace()
    if (this.eol) {
      if (canBeEmpty) return ""
      this.fail("bad-line", "unexpected end of line")
    }
    let j = this.i
    while (j < this.s.length && !isSpace(this.s[j])) j++
    const out = this.s.slice(this.i, j)
    this.i = j
    this.skipSpace()
    return out
  }

  /** `parseQuotedString`: a text in double quotes; a backslash before a quote or a backslash is removed, any other backslash stays. */
  quoted(canBeEmpty = false): string {
    this.skipSpace()
    if (this.eol) {
      if (canBeEmpty) return ""
      this.fail("bad-line", "unexpected end of line")
    }
    if (this.s[this.i] !== '"') this.fail("bad-line", "an opening quote was expected")
    let j = this.i + 1
    let out = ""
    let closed = false
    while (j < this.s.length) {
      const c = this.s[j]
      if (c === "\\") {
        j++
        if (j >= this.s.length) this.fail("bad-line", "unexpected end of line")
        if (this.s[j] !== '"' && this.s[j] !== "\\") out += "\\"
        out += this.s[j]
      } else if (c === '"') {
        closed = true
        break
      } else out += c
      j++
    }
    if (!closed) this.fail("bad-line", "no closing quote for a text")
    if (out === "" && !canBeEmpty) this.fail("bad-line", "a text was expected")
    this.i = j + 1
    while (this.i < this.s.length && this.s[this.i] === " ") this.i++
    return out
  }
}

/** Splits a line at spaces, tabs, carriage returns and line feeds, as `wxStringTokenizer( line, " \r\n\t" )`. */
export const tokensOf = (s: string): string[] => s.split(/[ \r\n\t]+/).filter((t) => t !== "")

/** KiCad's mil to millimetres (a mil is exactly 0.0254 mm); to four decimals, which a whole number of mils always is. */
export const milToMm = (mil: number): number => Math.round(mil * 254) / 10000

/** `Mils2Iu` of KiCad 6: a length in mils as whole 100 nm units (a mil is 254 of them), for the places KiCad rounds (the bold pen of a text). */
export const milToIu = (mil: number): number => Math.round(mil * 254)
