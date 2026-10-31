/**
 * State the model keeps beside the projects it works on, where a function isn't handed the project:
 * the parts and land patterns a project defines, which `findPart` and `getFootprint` resolve by id
 * and name (`registerPart`, `registerProjectFootprints`), and caches of what is worked out from them.
 * A browser tab holds one set of it, as it always has.
 *
 * A server runs many people's projects in one process, at once, and a land pattern one project
 * names `0603` must never be what another project's `0603` draws, nor a part one registers under an
 * id be what another reads by it. There each piece of work runs in a scope of its own (`inScope`,
 * as the MCP server's every call does), carried across `await` by the host's `AsyncLocalStorage`
 * (`useScopeStorage`): what it registers and caches is its own and goes when it ends. What modules
 * registered as they loaded, outside any scope (the examples' parts), is the process's (`base`),
 * and a scope reads it only where it has nothing of its own.
 *
 * Module state that depends on what a project defines is declared with `scoped`, never as a bare
 * module-level `Map`.
 */

export interface Scope {
  readonly values: Map<object, unknown>
}

/** `AsyncLocalStorage`'s shape, so a Node host hands one in and the model imports nothing of Node's. */
export interface ScopeStorage {
  getStore(): Scope | undefined
  run<R>(store: Scope, fn: () => R): R
}

const base: Scope = { values: new Map() }
let storage: ScopeStorage | null = null

/** Carry scopes across `await` with this (a Node `AsyncLocalStorage`). Without it there is only the base. */
export function useScopeStorage(next: ScopeStorage): void {
  storage = next
}

/** Run `fn`, and everything it awaits, in a fresh scope: it registers and caches nothing anyone else reads. */
export function inScope<R>(fn: () => R): R {
  if (!storage) throw new Error("inScope needs a ScopeStorage (useScopeStorage) to carry the scope across await.")
  return storage.run({ values: new Map() }, fn)
}

export interface Scoped<T> {
  /** The current scope's value, made on first use. */
  (): T
  /** The process's value: what was set outside any scope. */
  readonly base: T
}

/** Declare module state held per scope: each scope gets its own value from `create`, on first use. */
export function scoped<T>(create: () => T): Scoped<T> {
  const key = {}
  const of = (scope: Scope): T => {
    const value = scope.values.get(key) as T | undefined
    if (value !== undefined || scope.values.has(key)) return value as T
    const made = create()
    scope.values.set(key, made)
    return made
  }
  const current = (() => of(storage?.getStore() ?? base)) as Scoped<T>
  Object.defineProperty(current, "base", { get: () => of(base) })
  return current
}
