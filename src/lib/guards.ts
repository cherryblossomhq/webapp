// Checks the file codecs share to tell what a loaded value is.

/** A number that is not NaN or infinite. */
export const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v)

/** A plain object: not null, not an array. */
export const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v)
