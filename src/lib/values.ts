// Component values as written on schematics and in BOMs, read as numbers.

const SI: Record<string, number> = { p: 1e-12, n: 1e-9, u: 1e-6, µ: 1e-6, m: 1e-3, k: 1e3, K: 1e3, M: 1e6, G: 1e9, R: 1 }

/**
 * Read a value into a number in its base unit, or null when it isn't one: "100nF" is 1e-7,
 * "4k7" is 4700, "10uF" is 1e-5, "2R2" is 2.2, "1M" is 1e6, "16MHz" is 1.6e7. The unit is
 * dropped (ohm, Ω, F, H, Hz, V) and only "m" is milli, so "1M" is a million and "1m" a
 * thousandth.
 */
export function parseValue(raw: string | undefined): number | null {
  if (!raw) return null
  const s = raw.trim().replace(/(ohms?|Ω|F|H|Hz|V)$/i, "").trim()
  let m = s.match(/^(\d+)([pnuµmkKMGR])(\d+)$/)
  if (m) return Number(`${m[1]}.${m[3]}`) * SI[m[2]]
  m = s.match(/^(\d*\.?\d+)\s*([pnuµmkKMGR])?$/)
  if (m) return Number(m[1]) * (m[2] ? SI[m[2]] : 1)
  return null
}

/**
 * A capacitor's value in farads, read the ways one is written on a schematic or a bill of
 * materials: "100nF", "100NF", "0.1uF", "0,1uF", "100n", "4u7", the 3-digit code "104" (10 and 4
 * zeros, in picofarads: 100 nF), and a value with a rating or dielectric after it ("100nF 50V",
 * "100nF/16V", "100nF X7R", "100nF 10%"). Anything else that parseValue reads, it reads the same.
 */
export function parseFarads(raw: string | undefined): number | null {
  if (!raw) return null
  const text = raw.trim().replace(/(\d),(\d)/g, "$1.$2")
  // "4u7", "4n7": the prefix stands in for the decimal point.
  let m = text.match(/^(\d+)([pnuµμ])(\d+)(?:f|\s|\/|$)/i)
  if (m) return Number(`${m[1]}.${m[3]}`) * farads(m[2])
  m = text.match(/^(\d*\.?\d+)\s*([pnuµμm])?\s*f?(?![a-z0-9])/i)
  if (m?.[2]) return Number(m[1]) * farads(m[2])
  // EIA code: two digits and a power of ten, in pF.
  m = text.match(/^(\d{2})(\d)(?![\d.a-z])/i)
  if (m) return Number(`${m[1]}e${Number(m[2]) - 12}`)
  return parseValue(text.split(/[\s/]+/)[0])
}

const farads = (prefix: string) => SI[prefix.toLowerCase() === "u" || prefix === "μ" ? "u" : prefix.toLowerCase()]
