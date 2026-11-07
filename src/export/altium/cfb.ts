// A Compound File Binary writer (MS-CFB, version 3: 512-byte sectors, 64-byte mini sectors), the container every Altium document is in: a `.PcbDoc`
// and a `.SchDoc` are a tree of storages (folders) and streams (files) in one. Altium opens them with Windows' structured storage, which finds a
// stream by walking each storage's red-black tree of names, so the children of a storage are a tree ordered as the specification orders names
// (shorter first, then by their upper case) and coloured so that every path has as many black nodes. A stream under 4096 bytes is in the mini
// stream, as the specification requires of a reader too.

const SECTOR = 512
const MINI = 64
const CUTOFF = 4096
const FREE = 0xffffffff
const END = 0xfffffffe
const FATSECT = 0xfffffffd
const DIFSECT = 0xfffffffc
const NONE = 0xffffffff

/** A storage's children by name: a nested object is a storage, bytes a stream. */
export interface CfbTree {
  [name: string]: CfbTree | Uint8Array
}

interface Entry {
  name: string
  type: 1 | 2 | 5
  data?: Uint8Array
  children: number[]
  left: number
  right: number
  child: number
  black: boolean
  start: number
  size: number
}

/** The specification's order of two names in one storage: the shorter first, then by their upper case, code unit by code unit. */
export function compareNames(a: string, b: string): number {
  if (a.length !== b.length) return a.length - b.length
  const ua = a.toUpperCase()
  const ub = b.toUpperCase()
  return ua < ub ? -1 : ua > ub ? 1 : 0
}

/** The bytes of a compound file holding `tree` under its root. */
export function writeCfb(tree: CfbTree): Uint8Array {
  const entries: Entry[] = [{ name: "Root Entry", type: 5, children: [], left: NONE, right: NONE, child: NONE, black: true, start: END, size: 0 }]
  const add = (node: CfbTree, parent: number) => {
    for (const name of Object.keys(node).sort(compareNames)) {
      if (name.length > 31) throw new Error(`A compound file name has at most 31 characters: ${name}`)
      const value = node[name]
      const index = entries.length
      if (value instanceof Uint8Array) entries.push({ name, type: 2, data: value, children: [], left: NONE, right: NONE, child: NONE, black: true, start: END, size: value.length })
      else entries.push({ name, type: 1, children: [], left: NONE, right: NONE, child: NONE, black: true, start: 0, size: 0 })
      entries[parent].children.push(index)
      if (!(value instanceof Uint8Array)) add(value, index)
    }
  }
  add(tree, 0)
  for (const e of entries) e.child = balance(entries, e.children)

  // The mini stream: every short stream in turn, each from a mini sector of its own.
  const miniChunks: Uint8Array[] = []
  let miniSectors = 0
  for (const e of entries) {
    if (e.type !== 2 || e.size >= CUTOFF) continue
    if (e.size === 0) continue
    e.start = miniSectors
    miniChunks.push(e.data!)
    miniSectors += Math.ceil(e.size / MINI)
  }
  const miniFat = new Uint32Array(miniSectors).fill(FREE)
  for (const e of entries) {
    if (e.type !== 2 || e.size >= CUTOFF || e.size === 0) continue
    const n = Math.ceil(e.size / MINI)
    for (let i = 0; i < n; i++) miniFat[e.start + i] = i + 1 < n ? e.start + i + 1 : END
  }
  const miniStreamSize = miniSectors * MINI

  const sectorsOf = (bytes: number) => Math.ceil(bytes / SECTOR)
  const dirSectors = sectorsOf(entries.length * 128)
  const miniFatSectors = sectorsOf(miniSectors * 4)
  const miniStreamSectors = sectorsOf(miniStreamSize)
  const big = entries.filter((e) => e.type === 2 && e.size >= CUTOFF)
  const bigSectors = big.reduce((n, e) => n + sectorsOf(e.size), 0)
  const content = dirSectors + miniFatSectors + miniStreamSectors + bigSectors
  // The FAT covers every sector, its own and the DIFAT's included; the header holds the first 109 FAT sector numbers and each DIFAT sector 127 more.
  let fatSectors = 1
  let difatSectors = 0
  for (;;) {
    const difat = Math.max(0, Math.ceil((fatSectors - 109) / 127))
    const need = sectorsOf((content + fatSectors + difat) * 4)
    if (need === fatSectors && difat === difatSectors) break
    fatSectors = Math.max(need, fatSectors)
    difatSectors = difat
  }
  const total = fatSectors + difatSectors + content
  const fat = new Uint32Array(fatSectors * (SECTOR / 4)).fill(FREE)
  let next = 0
  const chain = (count: number, mark?: number) => {
    const first = next
    for (let i = 0; i < count; i++) fat[next + i] = mark ?? (i + 1 < count ? next + i + 1 : END)
    next += count
    return count ? first : END
  }
  const fatStart = chain(fatSectors, FATSECT)
  const difatStart = chain(difatSectors, DIFSECT)
  const dirStart = chain(dirSectors)
  const miniFatStart = chain(miniFatSectors)
  const miniStreamStart = chain(miniStreamSectors)
  for (const e of big) e.start = chain(sectorsOf(e.size))
  entries[0].start = miniStreamSectors ? miniStreamStart : END
  entries[0].size = miniStreamSize

  const out = new Uint8Array(SECTOR * (1 + total))
  const view = new DataView(out.buffer)
  const at = (sector: number) => SECTOR * (1 + sector)

  // The header.
  out.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], 0)
  view.setUint16(24, 0x003e, true)
  view.setUint16(26, 0x0003, true)
  view.setUint16(28, 0xfffe, true)
  view.setUint16(30, 9, true)
  view.setUint16(32, 6, true)
  view.setUint32(44, fatSectors, true)
  view.setUint32(48, dirStart, true)
  view.setUint32(56, CUTOFF, true)
  view.setUint32(60, miniFatSectors ? miniFatStart : END, true)
  view.setUint32(64, miniFatSectors, true)
  view.setUint32(68, difatSectors ? difatStart : END, true)
  view.setUint32(72, difatSectors, true)
  for (let i = 0; i < 109; i++) view.setUint32(76 + i * 4, i < fatSectors ? fatStart + i : FREE, true)
  // The DIFAT sectors: 127 FAT sector numbers each, then the next DIFAT sector.
  for (let d = 0; d < difatSectors; d++) {
    const base = at(difatStart + d)
    for (let i = 0; i < 127; i++) {
      const k = 109 + d * 127 + i
      view.setUint32(base + i * 4, k < fatSectors ? fatStart + k : FREE, true)
    }
    view.setUint32(base + 508, d + 1 < difatSectors ? difatStart + d + 1 : END, true)
  }
  for (let i = 0; i < fat.length; i++) view.setUint32(at(fatStart) + i * 4, fat[i], true)

  // The directory.
  entries.forEach((e, i) => {
    const base = at(dirStart) + i * 128
    for (let k = 0; k < e.name.length; k++) view.setUint16(base + k * 2, e.name.charCodeAt(k), true)
    view.setUint16(base + 64, (e.name.length + 1) * 2, true)
    out[base + 66] = e.type
    out[base + 67] = e.black ? 1 : 0
    view.setUint32(base + 68, e.left, true)
    view.setUint32(base + 72, e.right, true)
    view.setUint32(base + 76, e.child, true)
    view.setUint32(base + 116, e.type === 1 ? 0 : e.size === 0 && e.type === 2 ? END : e.start, true)
    view.setUint32(base + 120, e.size, true)
  })
  // Unused directory slots are empty entries with no siblings.
  for (let i = entries.length; i < dirSectors * 4; i++) {
    const base = at(dirStart) + i * 128
    view.setUint32(base + 68, NONE, true)
    view.setUint32(base + 72, NONE, true)
    view.setUint32(base + 76, NONE, true)
  }
  for (let i = 0; i < miniFat.length; i++) view.setUint32(at(miniFatStart) + i * 4, miniFat[i], true)
  for (let i = miniFat.length; i < miniFatSectors * (SECTOR / 4); i++) view.setUint32(at(miniFatStart) + i * 4, FREE, true)
  let mini = 0
  for (const chunk of miniChunks) {
    out.set(chunk, at(miniStreamStart) + mini * MINI)
    mini += Math.ceil(chunk.length / MINI)
  }
  for (const e of big) out.set(e.data!, at(e.start))
  return out
}

/**
 * The root of a balanced tree of `sorted` (already in name order), with each node's left and right set. Every node above the last level is black
 * and those on the last level are red, which keeps a red-black tree's rules: the same number of black nodes on every path, and no red node under a red one.
 */
function balance(entries: Entry[], sorted: number[]): number {
  if (!sorted.length) return NONE
  const depth = Math.floor(Math.log2(sorted.length + 1))
  const build = (lo: number, hi: number, level: number): number => {
    if (lo > hi) return NONE
    const mid = (lo + hi + 1) >> 1
    const e = entries[sorted[mid]]
    e.left = build(lo, mid - 1, level + 1)
    e.right = build(mid + 1, hi, level + 1)
    e.black = level < depth
    return sorted[mid]
  }
  return build(0, sorted.length - 1, 0)
}
