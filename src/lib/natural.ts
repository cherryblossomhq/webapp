// One collator each, made once: `localeCompare` with options builds a new one on every call, which
// is slow in a sort. In one fixed language, so a sheet sorts, and so tidies, the same in every
// browser whatever its language.

/** Plain string order, as `a.localeCompare(b)`. */
export const plain = new Intl.Collator("en")

/** As people sort designators and net names: R2 before R10. */
export const numeric = new Intl.Collator("en", { numeric: true })

/** `numeric.compare`, for a sort. */
export const naturalCompare = numeric.compare
