// How numbers and strings are spelled in a Part 21 file (ISO 10303-21).

/**
 * A real to `digits` decimals with the trailing zeros dropped. Part 21 wants a decimal point in
 * every real, so a whole number keeps it ("1.", "-0.25", "0.").
 */
export function real(x: number, digits: number): string {
  if (!Number.isFinite(x)) return "0."
  if (Math.abs(x) >= 1e15) return exponent(x)
  const s = x.toFixed(digits)
  let end = s.length
  while (s.charCodeAt(end - 1) === 48) end--
  const t = end === s.length ? s : s.slice(0, end)
  return t === "-0." ? "0." : t
}

/** 1.5e21 is "1.5E21": a decimal point in the mantissa, as Part 21 requires. */
function exponent(x: number): string {
  const [m, e] = x.toExponential().split("e")
  return `${m.includes(".") ? m : `${m}.`}E${Number(e)}`
}

/** A length in millimetres, to 0.1 nm. */
export const len = (x: number) => real(x, 7)

/** A direction component or a colour channel. */
export const unit = (x: number) => real(x, 10)

const HEX = "0123456789ABCDEF"

function hex(n: number, width: number): string {
  let s = ""
  for (let i = width - 1; i >= 0; i--) s += HEX[(n >> (i * 4)) & 15]
  return s
}

/**
 * The characters of a string's body that Part 21 can't carry as they are, spelled with its
 * escapes: printable ASCII stays, other characters become `\X2\` (UTF-16) or `\X4\` (UCS-4)
 * groups, and line breaks are dropped. Quotes and backslashes are the caller's business.
 */
function wide(body: string): string {
  let out = ""
  let group = ""
  let groupKind = ""
  const flush = () => {
    if (group) out += `\\${groupKind}\\${group}\\X0\\`
    group = ""
  }
  for (const ch of body) {
    const c = ch.codePointAt(0)!
    if (c >= 0x20 && c <= 0x7e) {
      flush()
      out += ch
    } else if (c === 0x0a || c === 0x0d) {
      flush()
    } else {
      const kind = c > 0xffff ? "X4" : "X2"
      if (kind !== groupKind) flush()
      groupKind = kind
      group += hex(c, kind === "X4" ? 8 : 4)
    }
  }
  flush()
  return out
}

const PRINTABLE = /^[\x20-\x7e]*$/

/** A Part 21 string literal for any text: quoted, with `'` and `\` doubled and the rest escaped. */
export function str(s: string): string {
  const body = s.replace(/\\/g, "\\\\").replace(/'/g, "''")
  return `'${PRINTABLE.test(body) ? body : wide(body)}'`
}

/**
 * A string token copied from another file (quotes included), made safe to write: printable ASCII
 * is kept byte for byte, which is every string a conforming file has; other characters, from a
 * file that wasn't plain ASCII, are escaped.
 */
export function rawString(token: string): string {
  return PRINTABLE.test(token) ? token : wide(token)
}
