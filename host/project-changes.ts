/**
 * How an edit to a shared project is written down, applied and undone.
 *
 * Everyone with a project open holds a copy of it, and every edit travels as a list of
 * `Change`s: the editor works out what an edit changed (`diffDocuments`), sends that, and every
 * other copy applies it (`applyChanges`) — the server to the stored document, each other open tab to
 * its own. The same function runs everywhere, so copies that apply the same changes in the same
 * order hold the same project. The order is the server's: it numbers each batch as it lands.
 *
 * The unit of a change is the smallest thing two people could edit at once without meaning to
 * undo each other's work. A project is mostly lists of items with ids (parts, wires, traces...),
 * so an item is addressed by its id rather than by its place in the list, and within an item (or
 * the project itself) each value is addressed by its path of keys: moving a part sets `pcb.x` and
 * `pcb.y`, and someone else's edit of its value at the same moment sets `props.value`, and both
 * survive. Two edits of the same value are decided by the order they reach the server: the later
 * one wins, as in Figma. An array that isn't a list of items (a wire's points, a property list) is
 * one value.
 *
 * - **Deletion wins.** A change to an item someone deleted meanwhile does nothing; an item comes
 *   back only by being put back whole (an undo of the deletion).
 * - **A list inside an object is a collection too.** The shape names it by its path from the root
 *   (`variants.list`), and the changes that touch it carry that path as their `collection`.
 * - **Order within a list is not shared.** A new item goes where the edit put it, as far as the
 *   list as it then is allows; a list merely reordered sends nothing.
 * - **Nothing here knows what a project is.** The caller says which top-level fields are lists of
 *   items (`DocumentShape`), and the changes say which list they touch, so the server applies them
 *   without the project's model and the format can change in the editor alone.
 */

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
export type JsonObject = { [key: string]: Json }

/** Keys from a document's root (or an item's) down to a value. Never into an array: an array is one value. */
export type Path = string[]

/** Insert an item into a list, or replace the one with the same key. */
export interface PutChange {
  kind: "put"
  collection: string
  /** The field that names an item, when it isn't `id`. */
  key?: string
  item: JsonObject
  /** Where it was in the list that made it; the end when absent or past it. */
  index?: number
}

/** Delete an item from a list. Deleting one that is gone already is nothing. */
export interface RemoveChange {
  kind: "remove"
  collection: string
  key?: string
  id: string
}

/**
 * Set or delete values in the document's root, or in one item of a list (`collection` and `id`).
 * An item that is gone is left gone.
 */
export interface SetChange {
  kind: "set"
  collection?: string
  key?: string
  id?: string
  set?: [Path, Json][]
  unset?: Path[]
}

export type Change = PutChange | RemoveChange | SetChange

/** What a document's fields are, for working out what an edit changed. */
export interface DocumentShape {
  /**
   * Lists of items edited one by one, each with the field that names an item. A top-level field is named as it is; a list
   * inside objects by its path from the root, joined by dots (`variants.list`).
   */
  collections: Readonly<Record<string, string>>
  /** Top-level fields that never travel: where a copy is kept (its id, its dates), not what it is. */
  ignore?: readonly string[]
}

type Obj = Record<string, unknown>

const isObject = (value: unknown): value is Obj => typeof value === "object" && value !== null && !Array.isArray(value)

/** Keys that would reach an object's prototype rather than the object. Never written, never read. */
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"])

const hasOwn = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k)

/** Keys of `a` and `b` whose values are not undefined: what JSON would keep of them. */
function fieldsOf(a: Obj, b: Obj): string[] {
  const keys = new Set<string>()
  for (const k of Object.keys(a)) if (a[k] !== undefined && !UNSAFE_KEYS.has(k)) keys.add(k)
  for (const k of Object.keys(b)) if (b[k] !== undefined && !UNSAFE_KEYS.has(k)) keys.add(k)
  return [...keys]
}

/** Whether two values would be written the same as JSON. A field holding `undefined` is no field. */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) if (!jsonEqual(a[i] ?? null, b[i] ?? null)) return false
    return true
  }
  if (isObject(a)) {
    if (!isObject(b)) return false
    const keys = fieldsOf(a, b)
    for (const k of keys) if (!jsonEqual(a[k], b[k])) return false
    return true
  }
  return false
}

// ---------- Lists inside objects ----------

/** A collection's name as the keys from the root down to its list: null when a key is empty or would reach a prototype. */
function pathOf(name: string): Path | null {
  const segs = name.split(".")
  return segs.every((k) => k.length > 0 && !UNSAFE_KEYS.has(k)) ? segs : null
}

const NOT_THERE = Symbol("not there")

/**
 * The value at `segs` under `root`: undefined when it is not there (or an object above it is not), NOT_THERE when something
 * above it is there and is not an object (so the field is a value as a whole, not a list inside an object).
 */
function readAt(root: Obj, segs: Path): unknown {
  let at: unknown = root
  for (let i = 0; i < segs.length - 1; i++) {
    const next = (at as Obj)[segs[i]]
    // An object that is not there yet holds no list: its list is what a put makes.
    if (next === undefined) return undefined
    if (!isObject(next)) return NOT_THERE
    at = next
  }
  return (at as Obj)[segs[segs.length - 1]]
}

/** `root` with the value at `segs` made by `fn` from what is there, the objects above it made when `make` and they are missing; `root` itself when nothing changed. */
function updateAt(root: Obj, segs: Path, fn: (current: unknown) => unknown, make: boolean): Obj {
  const [k, ...rest] = segs
  if (!rest.length) {
    const was = root[k]
    const now = fn(was)
    return now === was ? root : assign(root, k, now)
  }
  const child = root[k]
  if (!isObject(child) && !make) return root
  const next = updateAt(isObject(child) ? child : {}, rest, fn, make)
  return next === child ? root : assign(root, k, next)
}

// ---------- Working out what changed ----------

/**
 * The changes that take `before` to `after`. Empty when they are the same document. Applying
 * them to `before` gives `after`, except for the order of items in a list, which isn't kept, and
 * the fields the shape ignores.
 *
 * Cheap on the edits an editor makes, which copy only what they change: items that are the same
 * object on both sides are skipped without looking inside.
 */
export function diffDocuments(before: object, after: object, shape: DocumentShape): Change[] {
  const changes: Change[] = []
  const root: Required<Pick<SetChange, "set" | "unset">> = { set: [], unset: [] }
  const ignore = new Set(shape.ignore ?? [])
  const b = before as Obj
  const a = after as Obj
  // Lists inside objects, named by path: those both sides can be read as lists of items are diffed item by item, and the walk below leaves them.
  const nested = new Set<string>()
  for (const [name, key] of Object.entries(shape.collections)) {
    if (!name.includes(".") || ignore.has(name.split(".")[0])) continue
    const segs = pathOf(name)
    if (!segs) continue
    const was = readAt(b, segs)
    const now = readAt(a, segs)
    if (was === NOT_THERE || now === NOT_THERE) continue
    if (was === now) {
      nested.add(name)
      continue
    }
    if (diffCollection(name, key, was, now, changes)) nested.add(name)
  }
  for (const field of fieldsOf(b, a)) {
    if (ignore.has(field)) continue
    const key = hasOwn(shape.collections, field) ? shape.collections[field] : undefined
    if (key !== undefined && diffCollection(field, key, b[field], a[field], changes)) continue
    diffValue(b[field], a[field], [field], root, nested)
  }
  if (root.set.length || root.unset.length) changes.unshift(setChange(undefined, undefined, undefined, root))
  return changes
}

function setChange(collection: string | undefined, key: string | undefined, id: string | undefined, values: { set: [Path, Json][]; unset: Path[] }): SetChange {
  return {
    kind: "set",
    ...(collection !== undefined && { collection }),
    ...(key !== undefined && { key }),
    ...(id !== undefined && { id }),
    ...(values.set.length && { set: values.set }),
    ...(values.unset.length && { unset: values.unset }),
  }
}

function diffValue(a: unknown, b: unknown, path: Path, out: { set: [Path, Json][]; unset: Path[] }, skip?: ReadonlySet<string>) {
  if (a === b) return
  if (skip?.size) {
    const at = path.join(".")
    if (skip.has(at)) return
    // An object that was not there and holds a list kept item by item is made field by field: its list's items are puts, so two people who
    // make it at once both keep theirs.
    if (a === undefined && isObject(b) && [...skip].some((s) => s.startsWith(`${at}.`))) return diffValue({}, b, path, out, skip)
  }
  if (isObject(a) && isObject(b)) {
    for (const k of fieldsOf(a, b)) diffValue(a[k], b[k], [...path, k], out, skip)
    return
  }
  if (b === undefined) {
    if (a !== undefined) out.unset.push(path)
    return
  }
  if (a !== undefined && jsonEqual(a, b)) return
  out.set.push([path, b as Json])
}

/** A list's items by key, or null when it isn't a list of items with unique string keys. */
function itemsByKey(list: unknown[], key: string): Map<string, Obj> | null {
  const byKey = new Map<string, Obj>()
  for (const item of list) {
    if (!isObject(item)) return null
    const id = item[key]
    if (typeof id !== "string" || byKey.has(id)) return null
    byKey.set(id, item)
  }
  return byKey
}

/**
 * A list of items, item by item. False when the field isn't one (malformed, or keys that repeat),
 * and the caller sends it as one value instead: whole, but right.
 */
function diffCollection(name: string, key: string, before: unknown, after: unknown, out: Change[]): boolean {
  const was = before === undefined ? [] : before
  const now = after === undefined ? [] : after
  if (!Array.isArray(was) || !Array.isArray(now)) return false
  const wasByKey = itemsByKey(was, key)
  const nowByKey = itemsByKey(now, key)
  if (!wasByKey || !nowByKey) return false
  const named = key === "id" ? undefined : key
  now.forEach((item: Obj, index) => {
    const id = item[key] as string
    const old = wasByKey.get(id)
    if (!old) {
      out.push({ kind: "put", collection: name, ...(named && { key: named }), item: item as JsonObject, index })
      return
    }
    if (old === item) return
    const values = { set: [] as [Path, Json][], unset: [] as Path[] }
    for (const k of fieldsOf(old, item)) if (k !== key) diffValue(old[k], item[k], [k], values)
    if (values.set.length || values.unset.length) out.push(setChange(name, named, id, values))
  })
  for (const id of wasByKey.keys()) {
    if (!nowByKey.has(id)) out.push({ kind: "remove", collection: name, ...(named && { key: named }), id })
  }
  return true
}

// ---------- Applying changes ----------

/**
 * `doc` with `changes` applied in order, as a new document: what didn't change is shared with
 * `doc`, which is never modified. A change that no longer fits (an item someone deleted, a path
 * through a value that isn't an object) does what it still can and nothing else.
 */
export function applyChanges<T extends object>(doc: T, changes: readonly Change[]): T {
  let root = doc as Obj
  for (const change of changes) root = applyChange(root, change)
  return root as T
}

const assign = (o: Obj, k: string, v: unknown): Obj => (o[k] === v && hasOwn(o, k) ? o : { ...o, [k]: v })

function applyChange(root: Obj, change: Change): Obj {
  if (change.kind === "set" && change.collection === undefined) return applyValues(root, change)
  const segs = pathOf(change.collection!)
  if (!segs) return root
  const key = change.key ?? "id"
  const id = change.kind === "put" ? change.item[key] : change.id
  if (typeof id !== "string") return root
  // The list is edited where it is: at the root, or inside the objects its path names (made by a put, left alone by anything else).
  return updateAt(root, segs, (list) => editList(list, change, key, id), change.kind === "put")
}

/** `list` with one change to one of its items applied; `list` itself when nothing changed. */
function editList(list: unknown, change: Change, key: string, id: string): unknown {
  const items: unknown[] = Array.isArray(list) ? list : []
  const at = items.findIndex((x) => isObject(x) && x[key] === id)
  if (change.kind === "put") {
    if (at >= 0) {
      const next = items.slice()
      next[at] = change.item
      return next
    }
    const index = change.index === undefined || !Number.isFinite(change.index) ? items.length : Math.min(Math.max(0, Math.floor(change.index)), items.length)
    return [...items.slice(0, index), change.item, ...items.slice(index)]
  }
  if (at < 0) return list
  if (change.kind === "remove") return items.filter((_, i) => i !== at)
  const item = items[at] as Obj
  const updated = applyValues(item, change as SetChange)
  if (updated === item) return list
  const next = items.slice()
  next[at] = updated
  return next
}

function applyValues(target: Obj, change: SetChange): Obj {
  let out = target
  for (const path of change.unset ?? []) out = unsetIn(out, path, 0)
  for (const [path, value] of change.set ?? []) out = setIn(out, path, 0, value)
  return out
}

function setIn(o: Obj, path: Path, i: number, value: unknown): Obj {
  const k = path[i]
  if (k === undefined || UNSAFE_KEYS.has(k)) return o
  if (i === path.length - 1) return assign(o, k, value)
  const child = isObject(o[k]) ? (o[k] as Obj) : {}
  return assign(o, k, setIn(child, path, i + 1, value))
}

function unsetIn(o: Obj, path: Path, i: number): Obj {
  const k = path[i]
  if (k === undefined || UNSAFE_KEYS.has(k) || !hasOwn(o, k)) return o
  if (i === path.length - 1) {
    const { [k]: _gone, ...rest } = o
    return rest
  }
  const child = o[k]
  if (!isObject(child)) return o
  const next = unsetIn(child, path, i + 1)
  return next === child ? o : assign(o, k, next)
}

// ---------- Reading changes off the wire ----------

/** The most changes one batch may carry: a whole board routed again is a few thousand. */
export const MAX_CHANGES = 20_000

const isName = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 200 && !UNSAFE_KEYS.has(v)
const isPath = (v: unknown): v is Path => Array.isArray(v) && v.length > 0 && v.length <= 32 && v.every(isName)
const isId = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 500

/** No key anywhere inside a value that would reach a prototype. JSON.parse makes them own keys, but nothing should carry one. */
function safeValue(v: unknown, depth = 0): boolean {
  if (depth > 64) return false
  if (Array.isArray(v)) return v.every((x) => safeValue(x, depth + 1))
  if (isObject(v)) return Object.keys(v).every((k) => !UNSAFE_KEYS.has(k) && safeValue(v[k], depth + 1))
  return v === null || typeof v === "string" || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v))
}

function readChange(raw: unknown): Change | null {
  if (!isObject(raw)) return null
  if (raw.key !== undefined && !isName(raw.key)) return null
  const key = raw.key as string | undefined
  if (raw.kind === "put") {
    if (!isName(raw.collection) || !isObject(raw.item) || !safeValue(raw.item)) return null
    if (!isId(raw.item[key ?? "id"])) return null
    if (raw.index !== undefined && (typeof raw.index !== "number" || !Number.isFinite(raw.index))) return null
    return { kind: "put", collection: raw.collection, ...(key && { key }), item: raw.item as JsonObject, ...(raw.index !== undefined && { index: raw.index as number }) }
  }
  if (raw.kind === "remove") {
    if (!isName(raw.collection) || !isId(raw.id)) return null
    return { kind: "remove", collection: raw.collection, ...(key && { key }), id: raw.id }
  }
  if (raw.kind === "set") {
    const inItem = raw.collection !== undefined || raw.id !== undefined
    if (inItem && (!isName(raw.collection) || !isId(raw.id))) return null
    const set = raw.set ?? []
    const unset = raw.unset ?? []
    if (!Array.isArray(set) || !Array.isArray(unset) || !unset.every(isPath)) return null
    if (!set.every((e) => Array.isArray(e) && e.length === 2 && isPath(e[0]) && safeValue(e[1]))) return null
    return {
      kind: "set",
      ...(inItem && { collection: raw.collection as string, id: raw.id as string }),
      ...(key && { key }),
      ...(set.length && { set: set as [Path, Json][] }),
      ...(unset.length && { unset: unset as Path[] }),
    }
  }
  return null
}

/**
 * Changes as another copy sent them, checked change by change: null when the text isn't a list of
 * well-formed changes, so a client that sends anything else is refused rather than half applied.
 * `max` is how many one batch may carry: a batch that was taken without being read (one uploaded
 * as a file, which every reader then applies) is read with no cap, so every reader applies what
 * its sender did.
 */
export function readChanges(text: string, max = MAX_CHANGES): Change[] | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (!Array.isArray(raw) || raw.length > max) return null
  const changes: Change[] = []
  for (const r of raw) {
    const change = readChange(r)
    if (!change) return null
    changes.push(change)
  }
  return changes
}

// ---------- What a batch touched ----------

/** The lists a batch put items in, removed them from or edited them in, and whether it set anything in the root. */
export function touched(changes: readonly Change[]): { collections: Set<string>; root: Set<string> } {
  const collections = new Set<string>()
  const root = new Set<string>()
  for (const c of changes) {
    if (c.collection !== undefined) collections.add(c.collection)
    else if (c.kind === "set") for (const path of [...(c.set ?? []).map(([p]) => p), ...(c.unset ?? [])]) root.add(path[0])
  }
  return { collections, root }
}

/** Ids a batch removed from `collection`. */
export function removedIds(changes: readonly Change[], collection: string): string[] {
  return changes.filter((c): c is RemoveChange => c.kind === "remove" && c.collection === collection).map((c) => c.id)
}
