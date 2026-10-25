// What a reference image's bytes say about it, as KiCad reads them (`BITMAP_BASE::ReadImageFile` and `updatePPI`, common/bitmap_base.cpp, with
// wxWidgets' PNG and JPEG handlers for the resolution): its size in pixels, and the resolution KiCad draws it at. KiCad lets an image be as
// big as its pixels at that resolution, times the scale the file gives. The header is all that is read; the pixels are the browser's.
//
// A PNG's `pHYs` chunk says pixels per metre; wxWidgets turns that into pixels per centimetre (a decimal number, "37.8") and KiCad turns
// that into pixels per inch, rounding (`KiROUND( dpiX * 2.54 )`), when it is more than 1. Before stamp 20260623 KiCad truncated the pixels per
// centimetre to a whole number first (`GetOptionInt`), so the same file had a different resolution, which `legacyPpi` is. A JPEG's JFIF
// density gives pixels per inch (units 1) or per centimetre (units 2). No resolution is 300 pixels per inch.

export interface ImageFacts {
  format: "png" | "jpg" | null
  px: number
  py: number
  /** The resolution KiCad now derives, and the one it derived before stamp 20260623. */
  ppi: number
  legacyPpi: number
}

const DEFAULT_PPI = 300
const kiRound = (v: number) => Math.trunc(v < 0 ? v - 0.5 : v + 0.5)

const u32 = (b: Uint8Array, at: number) => ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0

/** The ppi KiCad gets from a resolution in pixels per centimetre, as a decimal (`updatePPI`) and as the whole number it used to be (`GetLegacyPPI`). */
function fromPerCm(perCm: number): { ppi: number; legacy: number } {
  const ppi = perCm > 1 ? kiRound(perCm * 2.54) : DEFAULT_PPI
  const whole = Math.trunc(perCm)
  return { ppi, legacy: whole > 1 ? kiRound(whole * 2.54) : ppi }
}

function pngFacts(b: Uint8Array): ImageFacts | null {
  if (b.length < 33 || u32(b, 8) !== 13 || String.fromCharCode(b[12], b[13], b[14], b[15]) !== "IHDR") return null
  const px = u32(b, 16)
  const py = u32(b, 20)
  if (!px || !py) return null
  let ppi = DEFAULT_PPI
  let legacyPpi = DEFAULT_PPI
  let at = 33
  while (at + 8 <= b.length) {
    const length = u32(b, at)
    const type = String.fromCharCode(b[at + 4], b[at + 5], b[at + 6], b[at + 7])
    if (type === "IDAT" || type === "IEND") break
    if (type === "pHYs" && length >= 9 && at + 8 + 9 <= b.length) {
      const perMetre = u32(b, at + 8)
      const unit = b[at + 16]
      if (unit === 1) {
        const r = fromPerCm(perMetre / 100)
        ppi = r.ppi
        legacyPpi = r.legacy
      }
      break
    }
    at += 12 + length
  }
  return { format: "png", px, py, ppi, legacyPpi }
}

function jpegFacts(b: Uint8Array): ImageFacts | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null
  let ppi = DEFAULT_PPI
  let legacyPpi = DEFAULT_PPI
  let at = 2
  while (at + 4 <= b.length) {
    if (b[at] !== 0xff) return null
    const marker = b[at + 1]
    if (marker === 0xff) {
      at++
      continue
    }
    const length = (b[at + 2] << 8) | b[at + 3]
    if (marker === 0xe0 && length >= 16 && String.fromCharCode(b[at + 4], b[at + 5], b[at + 6], b[at + 7]) === "JFIF") {
      const units = b[at + 11]
      const density = (b[at + 12] << 8) | b[at + 13]
      if (units === 1 && density > 1) ppi = legacyPpi = density
      else if (units === 2) {
        const r = fromPerCm(density)
        ppi = r.ppi
        legacyPpi = r.legacy
      }
    }
    // A start of frame: the size.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const py = (b[at + 5] << 8) | b[at + 6]
      const px = (b[at + 7] << 8) | b[at + 8]
      return px && py ? { format: "jpg", px, py, ppi, legacyPpi } : null
    }
    if (marker === 0xda) return null
    at += 2 + length
  }
  return null
}

/** The facts of an image's bytes; `format` is null (and the size 0) for bytes that are neither a PNG nor a JPEG this can read. */
export function imageFacts(bytes: Uint8Array): ImageFacts {
  return pngFacts(bytes) ?? jpegFacts(bytes) ?? { format: null, px: 0, py: 0, ppi: DEFAULT_PPI, legacyPpi: DEFAULT_PPI }
}

/** Base64 as `wxBase64Decode` reads it: the characters of the alphabet, with whitespace between them skipped. Null when it does not decode. */
export function decodeBase64(text: string): Uint8Array | null {
  const clean = text.replace(/\s+/g, "")
  if (!clean || /[^A-Za-z0-9+/=]/.test(clean)) return null
  try {
    const bin = atob(clean)
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
  } catch {
    return null
  }
}

/** Base64 of some bytes, on one line. */
export function encodeBase64(bytes: Uint8Array): string {
  let bin = ""
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode(...bytes.subarray(i, i + chunk))
  return btoa(bin)
}

/** The SHA-256 of some bytes as lowercase hex: a model file's id (`store/modelFiles.ts`), synchronously, which an import builds its project with. */
export function sha256Hex(bytes: Uint8Array): string {
  const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ])
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19])
  const length = bytes.length
  const padded = new Uint8Array(((length + 9 + 63) >> 6) << 6)
  padded.set(bytes)
  padded[length] = 0x80
  const view = new DataView(padded.buffer)
  view.setUint32(padded.length - 8, Math.floor((length * 8) / 0x100000000))
  view.setUint32(padded.length - 4, (length * 8) >>> 0)
  const w = new Uint32Array(64)
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n))
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4)
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3)
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10)
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0
    }
    let [a, b, c, d, e, f, g, hh] = h
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)
      const ch = (e & f) ^ (~e & g)
      const t1 = (hh + S1 + ch + K[i] + w[i]) >>> 0
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)
      const maj = (a & b) ^ (a & c) ^ (b & c)
      const t2 = (S0 + maj) >>> 0
      hh = g
      g = f
      f = e
      e = (d + t1) >>> 0
      d = c
      c = b
      b = a
      a = (t1 + t2) >>> 0
    }
    h[0] += a
    h[1] += b
    h[2] += c
    h[3] += d
    h[4] += e
    h[5] += f
    h[6] += g
    h[7] += hh
  }
  return [...h].map((x) => x.toString(16).padStart(8, "0")).join("")
}
