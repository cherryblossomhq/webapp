// A tolerant reader for Part 21 (ISO 10303-21) files, and the writer that puts their entities
// back out under new numbers. Tokens are kept as they were spelled, so a string, a number or an
// enumeration comes out exactly as it went in; only instance references are renumbered.

/**
 * A parameter: an instance reference (a number: `#12` is 12; negative numbers are references
 * already in the output's numbering), a token as spelled (`'text'`, `1.5E-3`, `.T.`, `$`, `*`,
 * `"0FF"`), a list, or a typed parameter (`LENGTH_MEASURE(1.)`).
 */
export type Value = number | string | Value[] | Typed

export class Typed {
  constructor(
    public type: string,
    public params: Value[],
  ) {}
}

export interface Instance {
  id: number
  /** Written as `(A(...)B(...))`, a complex instance of several types. */
  complex: boolean
  parts: Typed[]
}

export interface Part21 {
  /** FILE_DESCRIPTION, FILE_NAME, FILE_SCHEMA and the rest of the header, in order. */
  header: Typed[]
  instances: Instance[]
  /** Statements that couldn't be read and were skipped. */
  errors: number
}

const enum C {
  Tab = 9,
  Lf = 10,
  Cr = 13,
  Space = 32,
  Bang = 33,
  DQuote = 34,
  Hash = 35,
  Dollar = 36,
  Quote = 39,
  LParen = 40,
  RParen = 41,
  Star = 42,
  Plus = 43,
  Comma = 44,
  Minus = 45,
  Dot = 46,
  Slash = 47,
  D0 = 48,
  D9 = 57,
  Semi = 59,
  Eq = 61,
  A = 65,
  Z = 90,
  Under = 95,
  a = 97,
  z = 122,
}

const isDigit = (c: number) => c >= C.D0 && c <= C.D9
const isLetter = (c: number) => (c >= C.A && c <= C.Z) || (c >= C.a && c <= C.z) || c === C.Under
const isKeyword = (c: number) => isLetter(c) || isDigit(c) || c === C.Minus || c === C.Bang

class Malformed extends Error {}

class Scanner {
  pos = 0
  constructor(readonly s: string) {}

  /** Skips spaces, line breaks and comments. */
  skip(): void {
    const s = this.s
    for (;;) {
      const c = s.charCodeAt(this.pos)
      if (c === C.Space || c === C.Lf || c === C.Cr || c === C.Tab || (c < C.Space && c > 0) || c === 0xfeff) {
        this.pos++
      } else if (c === C.Slash && s.charCodeAt(this.pos + 1) === C.Star) {
        const end = s.indexOf("*/", this.pos + 2)
        this.pos = end < 0 ? s.length : end + 2
      } else {
        return
      }
    }
  }

  peek(): number {
    this.skip()
    return this.s.charCodeAt(this.pos)
  }

  expect(c: number): void {
    if (this.peek() !== c) throw new Malformed()
    this.pos++
  }

  keyword(): string {
    this.skip()
    const start = this.pos
    while (isKeyword(this.s.charCodeAt(this.pos))) this.pos++
    if (this.pos === start) throw new Malformed()
    return this.s.slice(start, this.pos).toUpperCase()
  }

  /** `'...'`, where `''` is a quote inside the string. */
  string(): string {
    const s = this.s
    const start = this.pos
    let i = start + 1
    for (;;) {
      const q = s.indexOf("'", i)
      if (q < 0) throw new Malformed()
      if (s.charCodeAt(q + 1) === C.Quote) {
        i = q + 2
        continue
      }
      this.pos = q + 1
      return s.slice(start, this.pos)
    }
  }

  value(): Value {
    const c = this.peek()
    const s = this.s
    if (c === C.Quote) return this.string()
    if (c === C.Hash) {
      const start = ++this.pos
      while (isDigit(s.charCodeAt(this.pos))) this.pos++
      if (this.pos === start) throw new Malformed()
      return Number(s.slice(start, this.pos))
    }
    if (c === C.LParen) return this.list()
    if (c === C.Dollar || c === C.Star) {
      this.pos++
      return c === C.Dollar ? "$" : "*"
    }
    if (c === C.DQuote) {
      const end = s.indexOf('"', this.pos + 1)
      if (end < 0) throw new Malformed()
      const token = s.slice(this.pos, end + 1)
      this.pos = end + 1
      return token
    }
    if (c === C.Dot && isLetter(s.charCodeAt(this.pos + 1))) {
      const end = s.indexOf(".", this.pos + 1)
      if (end < 0) throw new Malformed()
      const token = s.slice(this.pos, end + 1).toUpperCase()
      this.pos = end + 1
      return token
    }
    if (isDigit(c) || c === C.Plus || c === C.Minus || c === C.Dot) {
      const start = this.pos
      for (;;) {
        const d = s.charCodeAt(this.pos)
        if (isDigit(d) || d === C.Dot || d === C.Plus || d === C.Minus || d === 69 || d === 101) this.pos++
        else break
      }
      return s.slice(start, this.pos)
    }
    if (isLetter(c) || c === C.Bang) {
      const type = this.keyword()
      return new Typed(type, this.list())
    }
    // `@12`, a value instance name from edition 3, or anything else: kept as spelled.
    if (c === 64) {
      const start = this.pos++
      while (isDigit(s.charCodeAt(this.pos))) this.pos++
      return s.slice(start, this.pos)
    }
    throw new Malformed()
  }

  list(): Value[] {
    this.expect(C.LParen)
    const items: Value[] = []
    if (this.peek() === C.RParen) {
      this.pos++
      return items
    }
    for (;;) {
      items.push(this.value())
      const c = this.peek()
      this.pos++
      if (c === C.RParen) return items
      if (c !== C.Comma) throw new Malformed()
    }
  }

  /** Moves past the next `;` that isn't inside a string or a comment. */
  recover(): void {
    const s = this.s
    while (this.pos < s.length) {
      const c = s.charCodeAt(this.pos)
      if (c === C.Quote) {
        try {
          this.string()
        } catch {
          this.pos = s.length
        }
      } else if (c === C.Slash && s.charCodeAt(this.pos + 1) === C.Star) {
        this.skip()
      } else {
        this.pos++
        if (c === C.Semi) return
      }
    }
  }
}

/** Reads a whole Part 21 file, skipping (and counting) statements it can't make sense of. */
export function parsePart21(text: string): Part21 {
  const sc = new Scanner(text)
  const header: Typed[] = []
  const instances: Instance[] = []
  let errors = 0
  let section: "none" | "header" | "data" = "none"
  for (;;) {
    sc.skip()
    if (sc.pos >= text.length) break
    const start = sc.pos
    try {
      const c = sc.peek()
      if (c === C.Hash && section === "data") {
        sc.pos++
        const digits = sc.pos
        while (isDigit(text.charCodeAt(sc.pos))) sc.pos++
        if (sc.pos === digits) throw new Malformed()
        const id = Number(text.slice(digits, sc.pos))
        sc.expect(C.Eq)
        if (sc.peek() === C.LParen) {
          sc.pos++
          const parts: Typed[] = []
          while (sc.peek() !== C.RParen) {
            const type = sc.keyword()
            parts.push(new Typed(type, sc.list()))
          }
          sc.pos++
          instances.push({ id, complex: true, parts })
        } else {
          const type = sc.keyword()
          instances.push({ id, complex: false, parts: [new Typed(type, sc.list())] })
        }
        sc.expect(C.Semi)
        continue
      }
      const word = sc.keyword()
      if (word === "HEADER") section = "header"
      else if (word === "DATA") section = "data"
      else if (word === "ENDSEC") section = "none"
      else if (word === "END-ISO-10303-21") break
      else if (word === "ISO-10303-21") {
        // the file's first line
      } else if (section === "header") {
        header.push(new Typed(word, sc.list()))
      } else {
        throw new Malformed()
      }
      // DATA may carry a name and schemas in edition 3: DATA('name',('SCHEMA'));
      if (word === "DATA" && sc.peek() === C.LParen) sc.list()
      sc.expect(C.Semi)
    } catch (e) {
      if (!(e instanceof Malformed)) throw e
      errors++
      sc.pos = start
      sc.recover()
      if (sc.pos === start) sc.pos++
    }
  }
  return { header, instances, errors }
}

/**
 * Writes a value back out. `ref` gives the output number for an instance of the file, or
 * undefined for a reference to nothing, which becomes `$` (or is left out of a list).
 */
export function writeValue(v: Value, ref: (id: number) => number | undefined, raw: (token: string) => string): string {
  if (typeof v === "number") {
    const id = v < 0 ? -v : ref(v)
    return id === undefined ? "$" : `#${id}`
  }
  if (typeof v === "string") return v.charCodeAt(0) === C.Quote ? raw(v) : v
  if (Array.isArray(v)) return writeList(v, ref, raw, true)
  return `${v.type}${writeList(v.params, ref, raw, false)}`
}

/** A list, or (`aggregate` false) an entity's parameters, where a reference to nothing stays as `$`. */
function writeList(
  items: Value[],
  ref: (id: number) => number | undefined,
  raw: (token: string) => string,
  aggregate: boolean,
): string {
  let s = "("
  let n = 0
  for (const item of items) {
    if (aggregate && typeof item === "number" && item > 0 && ref(item) === undefined) continue
    if (n) s += n % 32 === 0 ? ",\n" : ","
    s += writeValue(item, ref, raw)
    n++
  }
  return `${s})`
}

/** An instance's body, after `#n=` and before `;`. */
export function writeInstance(inst: Instance, ref: (id: number) => number | undefined, raw: (token: string) => string): string {
  if (!inst.complex) return writeValue(inst.parts[0], ref, raw)
  let s = "("
  for (const part of inst.parts) s += writeValue(part, ref, raw)
  return `${s})`
}

/** Whether an instance is of a type (or, for a complex instance, has it among its parts). */
export function isA(inst: Instance, type: string): boolean {
  for (const p of inst.parts) if (p.type === type) return true
  return false
}

/** The params of an instance's part of a type. */
export function partOf(inst: Instance, type: string): Value[] | undefined {
  for (const p of inst.parts) if (p.type === type) return p.params
  return undefined
}

/** A string token's text, with `''` read as a quote; Part 21's other escapes are left as they are. */
export function stringText(v: Value | undefined): string | undefined {
  return typeof v === "string" && v.charCodeAt(0) === C.Quote ? v.slice(1, -1).replace(/''/g, "'") : undefined
}

/** A number token's value. */
export function numberValue(v: Value | undefined): number | undefined {
  if (typeof v !== "string") return undefined
  const c = v.charCodeAt(0)
  if (!(isDigit(c) || c === C.Plus || c === C.Minus || c === C.Dot)) return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}
