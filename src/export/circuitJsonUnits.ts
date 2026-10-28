import { round } from "../lib/geometry"

/** A length in millimetres as circuit JSON has it: to a tenth of a micrometre. */
export const mm = (n: number) => round(n, 4)
