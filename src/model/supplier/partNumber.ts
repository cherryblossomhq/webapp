// Is this supplier part number the one the user named?
//
// A name is rarely the number a supplier sells under: TPS61023 is sold as TPS61023DRLR, ADS1115
// as ADS1115IDGSR, SHT31-DIS as SHT31-DIS-F2.5kS, and the datasheet's MPU-6050 is catalogued as
// MPU6050. The tail is an ordering suffix (package, grade, reel), which says nothing about the
// pinout, so a longer number that goes on from the name is a variant of it, to be told apart by
// its package and its pin roles, not by its spelling. A number that goes on with more digits
// (INA2191 for INA219) is another part.

/** The part number without a packaging note: `U.FL-R-SMT-1(01)` and `ESD101-B1-02ELS E6327` reduce to their first word. */
export function mpnWord(mpn: string): string {
  return mpn.toUpperCase().trim().split(/[\s(（]/)[0] ?? ""
}

/** Letters and digits only, so `MPU-6050`, `MPU6050` and `mpu 6050` compare equal. */
export const partNumberKey = (mpn: string) => mpnWord(mpn).replace(/[^A-Z0-9]/g, "")

export type NameMatch = "exact" | "variant" | "related"

/**
 * How `mpn` relates to the name `query`: the same number, an ordering-suffix variant of it, or
 * something else. Variants are not assumed to be the part: the caller compares their package and
 * pins before treating them as one.
 */
export function relateName(query: string, mpn: string): NameMatch {
  const q = partNumberKey(query)
  const m = partNumberKey(mpn)
  if (!q || !m) return "related"
  if (m === q) return "exact"
  if (!m.startsWith(q)) return "related"
  // The number goes on: INA2191 is not an INA219, LM3580 is not an LM358. A separator ends it:
  // ATTINY85-20PU is an ATtiny85 and WS2812B-2020 starts as one (its size says what it is).
  if (/\d$/.test(q) && /^\d/.test(m.slice(q.length)) && !separated(query, mpn)) return "related"
  return "variant"
}

/** Whether a punctuation mark stands between the name and the rest of `mpn`. */
function separated(query: string, mpn: string): boolean {
  const raw = mpnWord(mpn)
  const want = partNumberKey(query).length
  let seen = 0
  let i = 0
  while (i < raw.length && seen < want) {
    if (/[A-Z0-9]/.test(raw[i])) seen++
    i++
  }
  return i < raw.length && !/[A-Z0-9]/.test(raw[i])
}

/** An EasyEDA user's own upload (a `C99...` number): LCSC doesn't sell it and nobody reviewed it. */
export const isUserUploadId = (lcsc: string) => /^C99\d{8,}$/.test(lcsc)
