// A QR code (ISO/IEC 18004) for a text, as the grid of its dark modules: byte mode, the smallest version that holds it at the error correction level asked for, and the mask with the
// lowest penalty. This is the standard's own procedure (data and error correction codewords, Reed-Solomon over GF(256) with the polynomial 0x11D, the function patterns, the eight
// masks and their four penalty rules), written out from the standard; any reader decodes the grid to the text.

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

/** The text as bits: the byte mode indicator, the length, the bytes, a terminator and padding, as codewords of the version. */
function codewordsOf(bytes: number[], version: number, level: QrLevel): number[] {
  const bits: number[] = []
  const push = (value: number, length: number) => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1)
  }
  push(0b0100, 4)
  push(bytes.length, version < 10 ? 8 : 16)
  for (const b of bytes) push(b, 8)
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

/** The standard's penalty for a masked symbol: runs of five or more, 2 by 2 blocks, finder-like patterns, and an unbalanced count of dark modules. */
function penalty(dark: boolean[][]): number {
  const size = dark.length
  let result = 0
  const finderLike = (line: boolean[]) => {
    let n = 0
    for (let i = 0; i + 11 <= line.length; i++) {
      const w = line.slice(i, i + 11).map((b) => (b ? 1 : 0)).join("")
      if (w === "10111010000" || w === "00001011101") n++
    }
    return n
  }
  const lines = [...dark, ...Array.from({ length: size }, (_, x) => dark.map((row) => row[x]))]
  for (const line of lines) {
    let run = 1
    for (let i = 1; i <= line.length; i++) {
      if (i < line.length && line[i] === line[i - 1]) run++
      else {
        if (run >= 5) result += 3 + (run - 5)
        run = 1
      }
    }
    result += finderLike(line) * 40
  }
  for (let y = 0; y < size - 1; y++) for (let x = 0; x < size - 1; x++) if (dark[y][x] === dark[y][x + 1] && dark[y][x] === dark[y + 1][x] && dark[y][x] === dark[y + 1][x + 1]) result += 3
  const total = size * size
  const count = dark.reduce((n, row) => n + row.filter(Boolean).length, 0)
  result += (Math.ceil(Math.abs(count * 20 - total * 10) / total) - 1) * 10
  return result
}

/**
 * The QR code of a text at an error correction level: the grid of its modules, `true` for a dark one, with no quiet zone. A text too long for version 40 at that level is `null`.
 */
export function qrCode(text: string, level: QrLevel = "M"): boolean[][] | null {
  const bytes = utf8(text)
  let version = 1
  for (; version <= 40; version++) {
    const countBits = version < 10 ? 8 : 16
    if (bytes.length < 2 ** countBits && 4 + countBits + bytes.length * 8 <= dataCodewords(version, level) * 8) break
  }
  if (version > 40) return null
  const all = interleaved(codewordsOf(bytes, version, level), version, level)
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
  let best: { dark: boolean[][]; score: number } | null = null
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
    if (!best || score < best.score) best = { dark: g.dark, score }
  }
  return best!.dark
}
