import { isCopperLayerId } from "./stack"
import type { Backdrill, PostMachining, Via, ViaProtection } from "./types"

// X22 in the stored project: via protection, backdrills and post-machining, on vias and on pads. A KiCad 10 board that sets them lists the same few values on
// hundreds of vias (every via of a board saved by KiCad 10 with its protection dialog open says `capping no`, `covering`, `plugging`, `filling no`), so a via
// is not given an object for them: the vias that share a setting are written once, as the setting and the places of the vias in the list of vias,
//
//   "vx": [ { "s": { "protect": { "cap": false, "fill": false, "cover": { "front": false, "back": false }, "plug": { "front": false, "back": false } } }, "v": [0, 1, 2, 5] } ]
//
// and read back onto the vias before they are checked. Nothing is rounded: reading gives what was written. A project with no such via has no `vx`.

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v)
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v)

/** The X22 fields of a via, which the stored form keeps apart from the via. */
const VIA_X22_KEYS = ["protect", "backdrill", "tertiary", "post"] as const

/** A via protection as it reads: each part a boolean where it says one; null when it is not an object of that shape, `undefined` when it says nothing at all. */
export function readProtection(raw: unknown): ViaProtection | undefined | null {
  if (raw === undefined) return undefined
  if (!isObject(raw)) return null
  const out: ViaProtection = {}
  for (const k of ["cap", "fill"] as const) {
    if (raw[k] === undefined) continue
    if (typeof raw[k] !== "boolean") return null
    out[k] = raw[k] as boolean
  }
  for (const k of ["cover", "plug"] as const) {
    const side = raw[k]
    if (side === undefined) continue
    if (!isObject(side)) return null
    const s: { front?: boolean; back?: boolean } = {}
    for (const f of ["front", "back"] as const) {
      if (side[f] === undefined) continue
      if (typeof side[f] !== "boolean") return null
      s[f] = side[f] as boolean
    }
    if (Object.keys(s).length) out[k] = s
  }
  return Object.keys(out).length ? out : undefined
}

/** The board's rule for via protection as it is kept: only what is switched on (an absent part is off); undefined when none is. */
export function boardProtection(p: ViaProtection): ViaProtection | undefined {
  const out: ViaProtection = {}
  if (p.cap === true) out.cap = true
  if (p.fill === true) out.fill = true
  for (const k of ["cover", "plug"] as const) {
    const side = p[k]
    if (!side) continue
    const on: { front?: boolean; back?: boolean } = {}
    if (side.front === true) on.front = true
    if (side.back === true) on.back = true
    if (Object.keys(on).length) out[k] = on
  }
  return Object.keys(out).length ? out : undefined
}

/** A backdrill as it reads: a size above zero between two copper layers of the board. Null when it does not. */
export function readBackdrill(raw: unknown, known: (l: unknown) => boolean = isCopperLayerId): Backdrill | undefined | null {
  if (raw === undefined) return undefined
  if (!isObject(raw) || !finite(raw.size) || !(raw.size > 0) || !known(raw.from) || !known(raw.to)) return null
  return { size: raw.size, from: raw.from as Backdrill["from"], to: raw.to as Backdrill["to"] }
}

/** A counterbore or countersink as it reads. Null when it does not. */
function readPostMachining(raw: unknown): PostMachining | undefined | null {
  if (raw === undefined) return undefined
  if (!isObject(raw) || (raw.mode !== "counterbore" && raw.mode !== "countersink")) return null
  const out: PostMachining = { mode: raw.mode }
  for (const k of ["size", "depth", "angle"] as const) {
    if (raw[k] === undefined) continue
    if (!finite(raw[k]) || (raw[k] as number) < 0) return null
    out[k] = raw[k] as number
  }
  return out
}

/** A pad's or via's two post-machinings as they read. Null when one does not; `undefined` when there is none. */
export function readPost(raw: unknown): { front?: PostMachining; back?: PostMachining } | undefined | null {
  if (raw === undefined) return undefined
  if (!isObject(raw)) return null
  const out: { front?: PostMachining; back?: PostMachining } = {}
  for (const k of ["front", "back"] as const) {
    const p = readPostMachining(raw[k])
    if (p === null) return null
    if (p) out[k] = p
  }
  return out.front || out.back ? out : undefined
}

/** The X22 fields of a stored via, each repaired or left out when it does not read, so a via is never half of a backdrill. */
function readViaX22(item: Record<string, unknown>, known?: (l: unknown) => boolean): Partial<Pick<Via, (typeof VIA_X22_KEYS)[number]>> {
  const out: Partial<Pick<Via, (typeof VIA_X22_KEYS)[number]>> = {}
  const protect = readProtection(item.protect)
  if (protect) out.protect = protect
  const backdrill = readBackdrill(item.backdrill, known)
  if (backdrill) out.backdrill = backdrill
  const tertiary = readBackdrill(item.tertiary, known)
  if (tertiary) out.tertiary = tertiary
  const post = readPost(item.post)
  if (post) out.post = post
  return out
}

type Spec = Partial<Pick<Via, (typeof VIA_X22_KEYS)[number]>>

/** Whether any via has a field of X22. */
export const hasViaX22 = (vias: readonly Via[]) => vias.some((v) => v.protect || v.backdrill || v.tertiary || v.post)

/** The vias with X22's fields taken off, and the table that gives them back (`vx`). The same array when none has any. */
export function packVias(vias: Via[]): { vias: Via[]; vx?: { s: Spec; v: number[] }[] } {
  if (!hasViaX22(vias)) return { vias }
  const bySpec = new Map<string, { s: Spec; v: number[] }>()
  const stripped = vias.map((via, i) => {
    if (!via.protect && !via.backdrill && !via.tertiary && !via.post) return via
    const { protect, backdrill, tertiary, post, ...rest } = via
    const s: Spec = { ...(protect ? { protect } : {}), ...(backdrill ? { backdrill } : {}), ...(tertiary ? { tertiary } : {}), ...(post ? { post } : {}) }
    const key = JSON.stringify(s)
    const entry = bySpec.get(key)
    if (entry) entry.v.push(i)
    else bySpec.set(key, { s, v: [i] })
    return rest as Via
  })
  return { vias: stripped, vx: [...bySpec.values()] }
}

/**
 * The raw vias of a stored project with the table `vx` they were written with before put back on them: an entry that does not read, or names a via that is not
 * there, is left out, and a field a via has of its own (an edit since wrote it there) stands over the table's.
 */
export function unpackVias(raw: unknown, vx: unknown): unknown {
  if (!Array.isArray(raw) || !Array.isArray(vx)) return raw
  const out = raw.slice()
  for (const entry of vx) {
    if (!isObject(entry) || !isObject(entry.s) || !Array.isArray(entry.v)) continue
    for (const i of entry.v) {
      if (!Number.isInteger(i) || i < 0 || i >= out.length || !isObject(out[i])) continue
      out[i] = { ...entry.s, ...(out[i] as Record<string, unknown>) }
    }
  }
  return out
}

type Json = Record<string, unknown>

const VIA_KINDS = new Set(["blind", "buried", "micro"])
const UNUSED = new Set(["remove", "keepEnds", "startEnd"])

/** A via's X5 fields as they read: a kind needs both its ends, and every other field is dropped when it does not read, so a via is never half of a blind one. */
export function normalizeVia(item: Json): Json {
  if (!("kind" in item || "from" in item || "to" in item || "tent" in item || "unused" in item || "zoneLayers" in item || "free" in item || "stack" in item || "protect" in item || "backdrill" in item || "tertiary" in item || "post" in item)) return item
  const { kind, from, to, tent, unused, zoneLayers, free, stack, protect: _protect, backdrill: _backdrill, tertiary: _tertiary, post: _post, ...rest } = item
  const out: Json = { ...rest, ...readViaX22(item) }
  if (typeof kind === "string" && VIA_KINDS.has(kind) && isCopperLayerId(from) && isCopperLayerId(to) && from !== to) Object.assign(out, { kind, from, to })
  if (isObject(tent)) {
    const t: Json = {}
    if (typeof tent.front === "boolean") t.front = tent.front
    if (typeof tent.back === "boolean") t.back = tent.back
    if (Object.keys(t).length) out.tent = t
  }
  if (typeof unused === "string" && UNUSED.has(unused)) out.unused = unused
  if (Array.isArray(zoneLayers) && zoneLayers.every(isCopperLayerId)) out.zoneLayers = zoneLayers
  if (free === true) out.free = true
  if (isObject(stack)) {
    const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0
    if (num(stack.inner) && num(stack.back)) out.stack = { inner: stack.inner, back: stack.back }
    else if (isObject(stack.layers)) {
      const layers: Json = {}
      for (const [k, v] of Object.entries(stack.layers)) if (isCopperLayerId(k) && num(v)) layers[k] = v
      if (Object.keys(layers).length) out.stack = { layers }
    }
  }
  return out
}

