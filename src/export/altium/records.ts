// What every part of the Altium writer shares: a growable little-endian byte buffer, Altium's text encoding (Windows-1252, with a `%UTF8%` copy of a
// value it cannot hold), its property lists (`|KEY=VALUE|...`) and the unique ids it gives objects.

/** A little-endian byte buffer that grows as it is written. */
export class Bytes {
  private buf = new Uint8Array(256)
  private view = new DataView(this.buf.buffer)
  length = 0

  private room(n: number) {
    if (this.length + n <= this.buf.length) return
    let size = this.buf.length * 2
    while (size < this.length + n) size *= 2
    const next = new Uint8Array(size)
    next.set(this.buf.subarray(0, this.length))
    this.buf = next
    this.view = new DataView(next.buffer)
  }

  u8(v: number) {
    this.room(1)
    this.buf[this.length++] = v & 0xff
    return this
  }
  u16(v: number) {
    this.room(2)
    this.view.setUint16(this.length, v & 0xffff, true)
    this.length += 2
    return this
  }
  u32(v: number) {
    this.room(4)
    this.view.setUint32(this.length, v >>> 0, true)
    this.length += 4
    return this
  }
  i32(v: number) {
    this.room(4)
    this.view.setInt32(this.length, v | 0, true)
    this.length += 4
    return this
  }
  f64(v: number) {
    this.room(8)
    this.view.setFloat64(this.length, v, true)
    this.length += 8
    return this
  }
  bytes(b: Uint8Array | readonly number[]) {
    this.room(b.length)
    this.buf.set(b, this.length)
    this.length += b.length
    return this
  }
  zeros(n: number) {
    this.room(n)
    this.buf.fill(0, this.length, this.length + n)
    this.length += n
    return this
  }
  /** A block: its length as a u32 (with `flags` in the top byte), then what `fill` writes. */
  block(fill: (w: Bytes) => void, flags = 0) {
    const at = this.length
    this.u32(0)
    fill(this)
    this.view.setUint32(at, ((this.length - at - 4) | (flags << 24)) >>> 0, true)
    return this
  }
  done(): Uint8Array {
    return this.buf.slice(0, this.length)
  }
}

// Windows-1252's characters 0x80 to 0x9f; every other byte is the Latin-1 character of its number.
const CP1252_HIGH = "€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008dŽ\u008f\u0090‘’“”•–—˜™š›œ\u009džŸ"
const CP1252 = new Map<string, number>([...CP1252_HIGH].map((c, i) => [c, 0x80 + i]))

/** Whether Windows-1252 holds every character of `s`. */
export const fitsCp1252 = (s: string) => [...s].every((c) => c.charCodeAt(0) < 0x80 || (c.charCodeAt(0) >= 0xa0 && c.charCodeAt(0) <= 0xff) || CP1252.has(c))

/** `s` in Windows-1252, with `?` for a character it has none for. */
export function cp1252(s: string): Uint8Array {
  const out: number[] = []
  for (const c of s) {
    const n = c.charCodeAt(0)
    if (n < 0x80 || (n >= 0xa0 && n <= 0xff && c.length === 1)) out.push(n)
    else out.push(CP1252.get(c) ?? 0x3f)
  }
  return Uint8Array.from(out)
}

const utf8 = (s: string) => new TextEncoder().encode(s)

/** A value as a property list may hold it: no `|`, which ends a value, and no line break. */
const clean = (v: string) => v.replace(/\|/g, "¦").replace(/\r?\n/g, " ")

export type PropValue = string | number | boolean | undefined | null

/**
 * A property list, `|KEY=VALUE` after `|KEY=VALUE`, as bytes: Windows-1252, and for a text value it cannot hold a `%UTF8%KEY` with the value in UTF-8 first,
 * as Altium writes one. A value of `undefined` or `null` is left out; a boolean is `T`/`F` or `TRUE`/`FALSE` by `bools`.
 */
export function props(pairs: [string, PropValue][], bools: "short" | "long" = "short", lead = "|"): Uint8Array {
  const parts: Uint8Array[] = []
  let first = true
  for (const [key, raw] of pairs) {
    if (raw === undefined || raw === null) continue
    const value = typeof raw === "boolean" ? (bools === "short" ? (raw ? "T" : "F") : raw ? "TRUE" : "FALSE") : typeof raw === "number" ? String(raw) : clean(raw)
    const sep = first ? lead : "|"
    first = false
    if (typeof raw === "string" && !fitsCp1252(value)) parts.push(cp1252(`${sep}%UTF8%${key}=`), utf8(value), cp1252(`|${key}=`))
    else parts.push(cp1252(`${sep}${key}=`))
    parts.push(cp1252(value))
  }
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

/** A property record of a schematic or of a PCB's text streams: its length (with the closing null) as a u32 with `type` in the top byte, the list, a null. */
export function propRecord(w: Bytes, list: Uint8Array, type = 0) {
  w.u32((list.length + 1) | (type << 24))
  w.bytes(list)
  w.u8(0)
}

/** A number as Altium writes a real in a property list: no exponent, at most `digits` decimals, no trailing zeros. */
export function real(n: number, digits = 4): string {
  if (!Number.isFinite(n)) return "0"
  const s = n.toFixed(digits).replace(/\.?0+$/, "")
  return s === "-0" || s === "" ? "0" : s
}

/** Millimetres as Altium's text of a length on a PCB, `12.5mil`. */
export const mil = (mm: number) => `${real(mm / 0.0254, 4)}mil`

/** Millimetres in Altium's PCB unit, a ten-thousandth of a mil, as the binary records hold a coordinate or a size. */
export const pcbUnits = (mm: number) => Math.round((mm / 0.0254) * 10000)

/** Delphi's way of writing a real in a PCB property list (`ROTATION= 9.00000000000000E+0001`), which Altium writes and reads. */
export function delphiReal(n: number): string {
  if (n === 0 || !Number.isFinite(n)) return " 0.00000000000000E+0000"
  const e = Math.floor(Math.log10(Math.abs(n)))
  const mantissa = n / 10 ** e
  const [m, ex] = Math.abs(mantissa) >= 9.999999999999995 ? [mantissa / 10, e + 1] : [mantissa, e]
  const sign = m < 0 ? "-" : " "
  return `${sign}${Math.abs(m).toFixed(14)}E${ex < 0 ? "-" : "+"}${String(Math.abs(ex)).padStart(4, "0")}`
}

/**
 * Altium's unique id of an object: eight capitals from A to Y, made from `seed` (FNV-1a), so the same project gives the same ids and the board's parts
 * name the schematic's by them. `taken` keeps them distinct within one export.
 */
export function uniqueId(seed: string, taken: Set<string>): string {
  for (let salt = 0; ; salt++) {
    let h = 0x811c9dc5
    const text = salt ? `${seed}#${salt}` : seed
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i)
      h = Math.imul(h, 0x01000193) >>> 0
    }
    let id = ""
    let x = h
    let y = Math.imul(h ^ 0x9e3779b9, 0x85ebca6b) >>> 0
    for (let i = 0; i < 8; i++) {
      const src = i < 4 ? x : y
      id += String.fromCharCode(65 + (src % 25))
      if (i < 4) x = Math.floor(x / 25)
      else y = Math.floor(y / 25)
    }
    if (!taken.has(id)) {
      taken.add(id)
      return id
    }
  }
}

/** A GUID in Altium's braces, made from `seed`, for the records that carry one. */
export function guid(seed: string): string {
  const hex: string[] = []
  for (let k = 0; k < 4; k++) {
    let h = 0x811c9dc5 ^ k
    for (let i = 0; i < seed.length; i++) {
      h ^= seed.charCodeAt(i)
      h = Math.imul(h, 0x01000193) >>> 0
    }
    hex.push(h.toString(16).toUpperCase().padStart(8, "0"))
  }
  const s = hex.join("")
  return `{${s.slice(0, 8)}-${s.slice(8, 12)}-4${s.slice(13, 16)}-8${s.slice(17, 20)}-${s.slice(20, 32)}}`
}

/** The 16 bytes of a GUID in braces, as Windows lays one out (the first three groups little-endian). */
export function guidBytes(g: string): Uint8Array {
  const h = g.replace(/[{}-]/g, "")
  const b = (i: number) => parseInt(h.slice(i * 2, i * 2 + 2), 16)
  return Uint8Array.from([b(3), b(2), b(1), b(0), b(5), b(4), b(7), b(6), b(8), b(9), b(10), b(11), b(12), b(13), b(14), b(15)])
}

/** KiCad's overbar, `~{RESET}`, as Altium writes one: a backslash after each character under the bar. */
export const overbar = (s: string) => s.replace(/~\{([^}]*)\}/g, (_m, inner: string) => [...inner].map((c) => `${c}\\`).join(""))
