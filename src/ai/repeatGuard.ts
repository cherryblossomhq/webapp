// A confused model sometimes sends the same failing tool call again and again, each time with the
// same input and the same error back, until the turn runs out of rounds (and, for a part lookup,
// spends the user's lookups). One request may fail an identical call twice; the third is refused
// with a plain message that says what to change. A call that works but comes back empty (a datasheet
// section that isn't there) counts the same way, since asking again gets the same nothing.

/** Failures of one call allowed in a request before it is refused: the call after this many is not run. */
export const REPEAT_LIMIT = 2

/**
 * Failures in a row of one tool on one thing (the same pins, part, net or name), whatever else
 * changes, before the next is refused. The identical-call limit above almost never fired in
 * production: a model flailing at a refusal moves its points half a millimetre each time, and one
 * request drew the same trace 24 times over (November 2026). A success on that thing clears it.
 */
export const STREAK_LIMIT = 4

/** The fields that say what a call is about, as against how it goes about it. */
const TARGET_FIELDS = ["from", "to", "net", "nets", "ref", "refs", "pins", "name", "lcsc", "part_id", "block", "url"]

const targetOf = (name: string, input: unknown) => {
  const o = input && typeof input === "object" ? (input as Record<string, unknown>) : {}
  const picked = Object.fromEntries(TARGET_FIELDS.filter((f) => o[f] !== undefined).map((f) => [f, o[f]]))
  return `${name}:${stable(picked)}`
}

const stable = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`)
      .join(",")}}`
  }
  return JSON.stringify(value) ?? "null"
}

export function createRepeatGuard() {
  const failures = new Map<string, { count: number; empty: boolean }>()
  const streaks = new Map<string, number>()
  const keyOf = (name: string, input: unknown) => `${name}:${stable(input ?? {})}`
  return {
    /** The sentence to answer with instead of running the call, or null when it may run. */
    refusal(name: string, input: unknown): string | null {
      const seen = failures.get(keyOf(name, input))
      if (seen && seen.count >= REPEAT_LIMIT) {
        const what = seen.empty ? "come back empty" : "failed"
        return `${name} has already ${what} ${REPEAT_LIMIT} times with exactly this input, so it was not run again. Change what you pass (a different lcsc, name, section, page, pins or footprint), use another tool, or tell the user what is blocking it.`
      }
      if ((streaks.get(targetOf(name, input)) ?? 0) >= STREAK_LIMIT) {
        return `${name} has failed ${STREAK_LIMIT} times in a row on this in this request, with different inputs each time, so it was not run again. Small variations of the same approach won't get past it: do something different (another tool, another layer, move what is in the way, route_pcb nets for a connection), or stop and tell the user what blocks it, quoting the last error.`
      }
      return null
    },
    /** Remember how a call that ran ended: a failure or an empty answer counts against it, a success clears it. */
    record(name: string, input: unknown, isError: boolean, empty = false) {
      const target = targetOf(name, input)
      if (isError) streaks.set(target, (streaks.get(target) ?? 0) + 1)
      else if (!empty) streaks.delete(target)
      const key = keyOf(name, input)
      if (isError || empty) {
        const before = failures.get(key)
        failures.set(key, { count: (before?.count ?? 0) + 1, empty: !isError && (before?.empty ?? true) })
      } else failures.delete(key)
    },
  }
}
