// A QR code (ISO/IEC 18004) for a text, as the grid of its dark modules, chosen as zint chooses (backend/qr.c, the library KiCad draws barcodes with): the cheapest mix of numeric,
// alphanumeric and byte segments (`qr_define_mode`, after Nayuki), a UTF-8 ECI for a text that is not ASCII, the smallest version that holds it at the error correction level asked
// for, and the mask with the lowest penalty by zint's reading of the standard's four rules. The rest is the standard's own procedure (data and error correction codewords,
// Reed-Solomon over GF(256) with the polynomial 0x11D, the function patterns and the eight masks); any reader decodes the grid to the text.

export type QrLevel = "L" | "M" | "Q" | "H"

const LEVELS: Record<QrLevel, { index: number; format: number }> = { L: { index: 0, format: 1 }, M: { index: 1, format: 0 }, Q: { index: 2, format: 3 }, H: { index: 3, format: 2 } }

// Error correction codewords per block and blocks, by level then version (the standard's table 9), index 0 unused.
const ECC_PER_BLOCK = [
  [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
]
const BLOCKS = [
  [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
]

/** The modules of a version that hold data: all of them but the function patterns. */
function rawModules(version: number): number {
  let n = (16 * version + 128) * version + 64
  if (version >= 2) {
    const align = Math.floor(version / 7) + 2
    n -= (25 * align - 10) * align - 55
    if (version >= 7) n -= 36
  }
  return n
}

/** The data codewords a version holds at a level. */
const dataCodewords = (version: number, level: QrLevel) => Math.floor(rawModules(version) / 8) - ECC_PER_BLOCK[LEVELS[level].index][version] * BLOCKS[LEVELS[level].index][version]

/** The product of two numbers of GF(256) modulo 0x11D. */
function gfMultiply(x: number, y: number): number {
  let z = 0
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d)
    z ^= ((y >>> i) & 1) * x
  }
  return z
}

/** The error correction codewords of some data: the remainder of the data over the generator polynomial of that degree. */
function remainder(data: number[], degree: number): number[] {
  const generator: number[] = new Array(degree).fill(0)
  generator[degree - 1] = 1
  let root = 1
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < generator.length; j++) {
      generator[j] = gfMultiply(generator[j], root)
      if (j + 1 < generator.length) generator[j] ^= generator[j + 1]
    }
    root = gfMultiply(root, 0x02)
  }
  const result: number[] = new Array(degree).fill(0)
  for (const b of data) {
    const factor = b ^ (result.shift() as number)
    result.push(0)
    generator.forEach((coef, i) => (result[i] ^= gfMultiply(coef, factor)))
  }
  return result
}

const utf8 = (text: string): number[] => [...new TextEncoder().encode(text)]

type Mode = "N" | "A" | "B"

const MODES: Mode[] = ["N", "A", "B"]
const ALPHANUMERIC = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:"
const isDigit = (c: number) => c >= 0x30 && c <= 0x39
const isAlpha = (c: number) => c < 0x80 && ALPHANUMERIC.includes(String.fromCharCode(c))
/** ECI 26, UTF-8: what zint writes before the data of a text that is not ASCII. */
const ECI_UTF8 = 26

/** The bits of a segment's character count, by mode and the version's size class (the standard's table 3). */
const countBits = (version: number, mode: Mode) => [[10, 12, 14], [9, 11, 13], [8, 16, 16]][MODES.indexOf(mode)][version < 10 ? 0 : version < 27 ? 1 : 2]

/**
 * The mode of each character that costs the fewest bits, as zint finds it (`qr_define_mode`): a dynamic programme over the modes the text can be in, costs in sixths of a
 * bit so that numeric's 10 bits for 3 digits and alphanumeric's 11 for 2 are whole numbers. A segment starts at the cost of its header, and the cost of a digit or a
 * letter is that of the group of three or two it starts, which zint works out where the group begins (so the last letter of an odd run costs a whole 6 bits).
 */
function modesOf(codes: number[], version: number): Mode[] {
  const head = MODES.map((m) => (countBits(version, m) + 4) * 6)
  const length = codes.length
  const chosen: (Mode | "")[][] = []
  let prev = head.slice()
  let numericEnd = 0
  let numericCost = 0
  let alphaEnd = 0
  let alphaCost = 0
  for (let i = 0; i < length; i++) {
    const cur = [0, 0, 0]
    const at: (Mode | "")[] = ["", "", ""]
    if (i >= numericEnd) {
      let j = i
      while (j < length && j < i + 3 && isDigit(codes[j])) j++
      numericEnd = j === i ? 0 : j
      numericCost = j - i === 1 ? 24 : j - i === 2 ? 21 : 20
    }
    if (i < numericEnd) {
      cur[0] = prev[0] + numericCost
      at[0] = "N"
    }
    const last = i + 1 === length
    if (i < alphaEnd) alphaCost = last ? 36 : 33
    else if (isAlpha(codes[i])) {
      const two = !last && isAlpha(codes[i + 1])
      alphaEnd = two ? i + 2 : i + 1
      alphaCost = two ? 33 : 36
    } else alphaEnd = 0
    if (i < alphaEnd) {
      cur[1] = prev[1] + alphaCost
      at[1] = "A"
    }
    cur[2] = prev[2] + 48
    at[2] = "B"
    for (let j = 0; j < 3; j++) {
      for (let k = 0; k < 3; k++) {
        if (j !== k && at[k]) {
          const cost = cur[k] + head[j]
          if (!at[j] || cost < cur[j]) {
            cur[j] = cost
            at[j] = MODES[k]
          }
        }
      }
    }
    chosen.push(at)
    prev = cur
  }
  let mode = MODES[prev.indexOf(Math.min(...prev))]
  const out: Mode[] = new Array(length)
  for (let i = length - 1; i >= 0; i--) {
    mode = chosen[i][MODES.indexOf(mode)] as Mode
    out[i] = mode
  }
  return out
}

/** The runs of one mode among the characters, and the bits they take at a version (`qr_calc_binlen`): the ECI, then for each run its indicator, count and data. */
function segmentsOf(codes: number[], modes: Mode[]): { mode: Mode; codes: number[] }[] {
  const out: { mode: Mode; codes: number[] }[] = []
  codes.forEach((c, i) => {
    if (out.length && out[out.length - 1].mode === modes[i]) out[out.length - 1].codes.push(c)
    else out.push({ mode: modes[i], codes: [c] })
  })
  return out
}

function bitLength(segments: { mode: Mode; codes: number[] }[], version: number, eci: boolean): number {
  let bits = eci ? 12 : 0
  for (const { mode, codes } of segments) {
    const n = codes.length
    bits += 4 + countBits(version, mode)
    bits += mode === "B" ? n * 8 : mode === "A" ? Math.floor(n / 2) * 11 + (n % 2) * 6 : Math.floor(n / 3) * 10 + [0, 4, 7][n % 3]
  }
  return bits
}

/** The text as bits: the ECI, each segment's mode indicator, count and characters, a terminator and padding, as codewords of the version. */
function codewordsOf(segments: { mode: Mode; codes: number[] }[], eci: boolean, version: number, level: QrLevel): number[] {
  const bits: number[] = []
  const push = (value: number, length: number) => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1)
  }
  if (eci) {
    push(0b0111, 4)
    push(ECI_UTF8, 8)
  }
  for (const { mode, codes } of segments) {
    push({ N: 0b0001, A: 0b0010, B: 0b0100 }[mode], 4)
    push(codes.length, countBits(version, mode))
    if (mode === "B") for (const c of codes) push(c, 8)
    else if (mode === "A") for (let i = 0; i < codes.length; i += 2) i + 1 < codes.length ? push(ALPHANUMERIC.indexOf(String.fromCharCode(codes[i])) * 45 + ALPHANUMERIC.indexOf(String.fromCharCode(codes[i + 1])), 11) : push(ALPHANUMERIC.indexOf(String.fromCharCode(codes[i])), 6)
    else for (let i = 0; i < codes.length; i += 3) push(Number(String.fromCharCode(...codes.slice(i, i + 3))), [0, 4, 7, 10][Math.min(3, codes.length - i)])
  }
  const capacity = dataCodewords(version, level) * 8
  push(0, Math.min(4, capacity - bits.length))
  push(0, (8 - (bits.length % 8)) % 8)
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) push(pad, 8)
  const out: number[] = []
  for (let i = 0; i < bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8).join(""), 2))
  return out
}

/** The data split into blocks, each with its own error correction, and the codewords interleaved. */
function interleaved(data: number[], version: number, level: QrLevel): number[] {
  const blocks = BLOCKS[LEVELS[level].index][version]
  const eccLength = ECC_PER_BLOCK[LEVELS[level].index][version]
  const raw = Math.floor(rawModules(version) / 8)
  const shortBlocks = blocks - (raw % blocks)
  const shortLength = Math.floor(raw / blocks)
  const pieces: { data: number[]; ecc: number[] }[] = []
  for (let i = 0, k = 0; i < blocks; i++) {
    const part = data.slice(k, k + shortLength - eccLength + (i < shortBlocks ? 0 : 1))
    k += part.length
    pieces.push({ data: part, ecc: remainder(part, eccLength) })
  }
  const out: number[] = []
  for (let i = 0; i < pieces[pieces.length - 1].data.length; i++) for (const p of pieces) if (i < p.data.length) out.push(p.data[i])
  for (let i = 0; i < eccLength; i++) for (const p of pieces) out.push(p.ecc[i])
  return out
}

/** The centres of a version's alignment patterns along one side. */
function alignmentPositions(version: number): number[] {
  if (version === 1) return []
  const count = Math.floor(version / 7) + 2
  const step = version === 32 ? 26 : Math.ceil((version * 4 + 4) / (count * 2 - 2)) * 2
  const out = [6]
  for (let pos = version * 4 + 10; out.length < count; pos -= step) out.splice(1, 0, pos)
  return out
}

/** The modules of a symbol as it is built: `dark` and `function` (which no data goes in and no mask touches). */
class Grid {
  readonly dark: boolean[][]
  readonly fixed: boolean[][]
  constructor(readonly size: number) {
    this.dark = Array.from({ length: size }, () => new Array<boolean>(size).fill(false))
    this.fixed = Array.from({ length: size }, () => new Array<boolean>(size).fill(false))
  }
  set(x: number, y: number, dark: boolean) {
    this.dark[y][x] = dark
    this.fixed[y][x] = true
  }
}

function functionPatterns(version: number): Grid {
  const size = version * 4 + 17
  const g = new Grid(size)
  for (let i = 0; i < size; i++) {
    g.set(6, i, i % 2 === 0)
    g.set(i, 6, i % 2 === 0)
  }
  const finder = (cx: number, cy: number) => {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx
        const y = cy + dy
        if (x < 0 || x >= size || y < 0 || y >= size) continue
        const d = Math.max(Math.abs(dx), Math.abs(dy))
        g.set(x, y, d !== 2 && d !== 4)
      }
    }
  }
  finder(3, 3)
  finder(size - 4, 3)
  finder(3, size - 4)
  const align = alignmentPositions(version)
  for (let i = 0; i < align.length; i++) {
    for (let j = 0; j < align.length; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === align.length - 1) || (i === align.length - 1 && j === 0)) continue
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) g.set(align[i] + dx, align[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1)
    }
  }
  // The format areas are reserved now and written with the mask.
  formatBits(g, 0, 0)
  if (version >= 7) versionBits(g, version)
  return g
}

function versionBits(g: Grid, version: number) {
  let rem = version
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25)
  const bits = (version << 12) | rem
  for (let i = 0; i < 18; i++) {
    const dark = ((bits >>> i) & 1) !== 0
    const a = g.size - 11 + (i % 3)
    const b = Math.floor(i / 3)
    g.set(a, b, dark)
    g.set(b, a, dark)
  }
}

function formatBits(g: Grid, level: number, mask: number) {
  const data = (level << 3) | mask
  let rem = data
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537)
  const bits = ((data << 10) | rem) ^ 0x5412
  const bit = (i: number) => ((bits >>> i) & 1) !== 0
  for (let i = 0; i <= 5; i++) g.set(8, i, bit(i))
  g.set(8, 7, bit(6))
  g.set(8, 8, bit(7))
  g.set(7, 8, bit(8))
  for (let i = 9; i < 15; i++) g.set(14 - i, 8, bit(i))
  for (let i = 0; i < 8; i++) g.set(g.size - 1 - i, 8, bit(i))
  for (let i = 8; i < 15; i++) g.set(8, g.size - 15 + i, bit(i))
  g.set(8, g.size - 8, true)
}

const MASKS: ((x: number, y: number) => boolean)[] = [
  (x, y) => (x + y) % 2 === 0,
  (_, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
]

/**
 * zint's penalty for a masked symbol (`qr_evaluate`): runs of five or more in a row or column, 2 by 2 blocks, the 1:1:3:1:1 pattern with four light modules before it or after it
 * (the edge counts as light), and the share of dark modules in steps of 5%.
 */
function penalty(dark: boolean[][]): number {
  const size = dark.length
  let result = 0
  // each row, then each column: `get(a, b)` is the module b along line a
  for (const get of [(a: number, b: number) => dark[a][b], (a: number, b: number) => dark[b][a]]) {
    for (let a = 0; a < size; a++) {
      let run = 0
      let state = false
      for (let b = 0; b < size; b++) {
        if (get(a, b) === state) run++
        else {
          if (run >= 5) result += run - 2
          run = 1
          state = get(a, b)
        }
      }
      if (run >= 5) result += run - 2
      for (let b = 0; b <= size - 7; b++) {
        if (!(get(a, b) && !get(a, b + 1) && get(a, b + 2) && get(a, b + 3) && get(a, b + 4) && !get(a, b + 5) && get(a, b + 6))) continue
        const light = (from: number, step: number) => {
          for (let k = 0; k < 4; k++) {
            const c = from + k * step
            if (c < 0 || c >= size) return true
            if (get(a, c)) return false
          }
          return true
        }
        if (light(b - 1, -1) || light(b + 7, 1)) result += 40
        b += 3
      }
    }
  }
  for (let y = 0; y < size - 1; y++) for (let x = 0; x < size - 1; x++) if (dark[y][x] === dark[y][x + 1] && dark[y][x] === dark[y + 1][x] && dark[y][x] === dark[y + 1][x + 1]) result += 3
  const count = dark.reduce((n, row) => n + row.filter(Boolean).length, 0)
  return result + 10 * Math.floor(Math.abs((100 * count) / (size * size) - 50) / 5)
}

/**
 * The QR code of a text at an error correction level: the grid of its modules, `true` for a dark one, with no quiet zone. A text too long for version 40 at that level is `null`.
 */
export function qrCode(text: string, level: QrLevel = "L"): boolean[][] | null {
  const codes = utf8(text)
  // zint sets the UTF-8 ECI for any text that is not ASCII, and none for one that is.
  const eci = codes.some((c) => c >= 0x80)
  const plan = (version: number) => {
    const segments = segmentsOf(codes, modesOf(codes, version))
    return { segments, bits: bitLength(segments, version, eci) }
  }
  const capacity = (version: number) => dataCodewords(version, level) * 8
  if (plan(40).bits > capacity(40)) return null
  // The smallest version the version 40 costing fits, then smaller while the costing for that version still fits.
  let version = 1
  while (version < 40 && capacity(version) < plan(40).bits) version++
  let best = plan(version)
  while (version > 1) {
    const smaller = plan(version - 1)
    if (capacity(version - 1) < smaller.bits) break
    version--
    best = smaller
  }
  const all = interleaved(codewordsOf(best.segments, eci, version, level), version, level)
  const base = functionPatterns(version)
  // The codewords' bits go in zigzag columns of two from the lower right, skipping the vertical timing pattern, over every module no function pattern holds.
  const place = (g: Grid) => {
    let i = 0
    for (let right = g.size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5
      for (let v = 0; v < g.size; v++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j
          const y = ((right + 1) & 2) === 0 ? g.size - 1 - v : v
          if (!g.fixed[y][x] && i < all.length * 8) {
            g.dark[y][x] = ((all[i >>> 3] >>> (7 - (i & 7))) & 1) !== 0
            i++
          }
        }
      }
    }
  }
  let masked: { dark: boolean[][]; score: number } | null = null
  for (let mask = 0; mask < 8; mask++) {
    const g = new Grid(base.size)
    for (let y = 0; y < base.size; y++) {
      g.dark[y] = [...base.dark[y]]
      g.fixed[y] = [...base.fixed[y]]
    }
    place(g)
    for (let y = 0; y < g.size; y++) for (let x = 0; x < g.size; x++) if (!g.fixed[y][x] && MASKS[mask](x, y)) g.dark[y][x] = !g.dark[y][x]
    formatBits(g, LEVELS[level].format, mask)
    const score = penalty(g.dark)
    if (!masked || score < masked.score) masked = { dark: g.dark, score }
  }
  return masked!.dark
}
