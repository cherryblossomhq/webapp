let counter = 0
/** Set while a build numbers its ids instead (see withStableIds). */
let stable: number | null = null

export function uid(prefix = ""): string {
  // The separator keeps "t" + 12 and "t1" + 2 apart; random ids never contain one.
  if (stable !== null) return `${prefix}_${(stable++).toString(36)}`
  counter = (counter + 1) % 1679616
  const rand = Math.random().toString(36).slice(2, 8)
  const seq = counter.toString(36).padStart(4, "0")
  return `${prefix}${Date.now().toString(36)}${seq}${rand}`
}

/**
 * Run a build with its ids numbered from zero, so it makes the same document every time: the
 * shipped examples are checked against a fresh build of their templates.
 */
export function withStableIds<T>(build: () => T): T {
  const outer = stable
  stable = 0
  try {
    return build()
  } finally {
    stable = outer
  }
}
