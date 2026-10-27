import { kid, kids, numAt, strAt, type List } from "./sexpr"
import type { KicadBackdrill, KicadGenerator, KicadGenValue, KicadNetChain, KicadPost, KicadPostMachining, KicadProtection, KicadVia } from "./types"

// X21 and X22 as a KiCad file says them: via protection (IPC-4761), backdrills, post-machining, tuning patterns and the other generated items, pad lengths, and net
// chains. The reader here follows KiCad's own parser (pcb_io_kicad_sexpr_parser.cpp, the 10.0 line, commit de08734): `parseVia` for a via's `capping`, `covering`,
// `plugging`, `filling`, `backdrill`, `tertiary_drill` and the two post-machinings (`:9096-9243`), `parsePAD` for the same on a pad and for `die_length` and `die_delay`
// (`:7338-7530`, `:7752-7758`), `parsePostMachining` (`:7928`), `parseFrontBackOptBool` (`:9246`) and `parseOptBool` (`:249`), the setup's defaults (`:3190-3222`),
// `parseGENERATOR` (`:8564`) and `parseNET_CHAINS_SECTION` (`:3512`).

const yes = (w: string | List | undefined) => w === "yes" || w === "true"

/** `yes`, `no` or `none` (KiCad's `parseOptBool`): true, false, or undefined for no choice. A node with no word says nothing either. */
function optBool(w: string | List | undefined): boolean | undefined {
  if (w === "yes") return true
  if (w === "no") return false
  return undefined
}

/** `(covering (front yes) (back no))`: each side as the file says it; a side that says `none` or is not there is no choice. */
function frontBack(node: List | undefined): { front?: boolean; back?: boolean } | undefined {
  if (!node) return undefined
  const out: { front?: boolean; back?: boolean } = {}
  for (const l of node.slice(1)) {
    if (!Array.isArray(l) || (l[0] !== "front" && l[0] !== "back")) continue
    const v = optBool(l[1])
    if (v !== undefined) out[l[0]] = v
  }
  return out
}

/**
 * A via's protection from its own nodes, each part a choice where the file makes one (`capping no` is a choice: the via is not capped whatever the board says); undefined
 * when the via makes none. The later node of a kind wins, as KiCad's parser overwrites.
 */
export function viaProtectionOf(via: List): KicadProtection | undefined {
  const out: KicadProtection = {}
  for (const c of via) {
    if (!Array.isArray(c)) continue
    if (c[0] === "capping") {
      const v = optBool(c[1])
      if (v === undefined) delete out.cap
      else out.cap = v
    } else if (c[0] === "filling") {
      const v = optBool(c[1])
      if (v === undefined) delete out.fill
      else out.fill = v
    } else if (c[0] === "covering" || c[0] === "plugging") {
      const side = frontBack(c)
      const key = c[0] === "covering" ? "cover" : "plug"
      if (side && Object.keys(side).length) out[key] = side
      else delete out[key]
    }
  }
  return Object.keys(out).length ? out : undefined
}

/** The board's own protection (`setup`): covering and plugging by side, capping and filling; a side not named is off (`value_or(false)`). Undefined when nothing is switched on. */
export function setupProtectionOf(setup: List | undefined): KicadProtection | undefined {
  if (!setup) return undefined
  const out: KicadProtection = {}
  for (const c of setup) {
    if (!Array.isArray(c)) continue
    if (c[0] === "capping") out.cap = yes(c[1])
    else if (c[0] === "filling") out.fill = yes(c[1])
    else if (c[0] === "covering" || c[0] === "plugging") {
      const side = frontBack(c) ?? {}
      out[c[0] === "covering" ? "cover" : "plug"] = { front: side.front === true, back: side.back === true }
    }
  }
  const on: KicadProtection = {}
  if (out.cap) on.cap = true
  if (out.fill) on.fill = true
  for (const k of ["cover", "plug"] as const) if (out[k]?.front || out[k]?.back) on[k] = { ...(out[k]!.front ? { front: true } : {}), ...(out[k]!.back ? { back: true } : {}) }
  return Object.keys(on).length ? on : undefined
}

/**
 * A `backdrill` or `tertiary_drill` of a via or pad: the size and the two layers it runs between. A drill with no size above zero, or without both layers, does nothing in
 * KiCad (`isBackdrillSet`) and is not one here.
 */
export function backdrillOf(node: List | undefined): KicadBackdrill | undefined {
  if (!node) return undefined
  const size = kid(node, "size")
  const layers = kid(node, "layers")
  const start = strAt(layers, 1)
  const end = strAt(layers, 2)
  const s = numAt(size, 1, 0)
  if (!(s > 0) || start === undefined || end === undefined) return undefined
  return { size: s, start, end }
}

const postOf1 = (node: List | undefined): KicadPostMachining | undefined => {
  if (!node) return undefined
  const mode = strAt(node, 1)
  if (mode !== "counterbore" && mode !== "countersink") return undefined
  const out: KicadPostMachining = { mode }
  const size = kid(node, "size")
  const depth = kid(node, "depth")
  const angle = kid(node, "angle")
  if (size) out.size = numAt(size, 1, 0)
  if (depth) out.depth = numAt(depth, 1, 0)
  // KiCad keeps the angle in tenths of a degree (`KiROUND( angle * 10 )`).
  if (angle) out.angle = Math.round(numAt(angle, 1, 0) * 10) / 10
  return out
}

/** The front and back post-machining of a via or pad; a size, depth or angle that is zero is as if it were not said (the writer leaves it out and the machine has none). */
export function postMachiningOf(item: List): KicadPost | undefined {
  const front = postOf1(kid(item, "front_post_machining"))
  const back = postOf1(kid(item, "back_post_machining"))
  return front || back ? { ...(front ? { front } : {}), ...(back ? { back } : {}) } : undefined
}

// ---------- generated items ----------

const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/

/** The properties of a generated item that KiCad keeps as text, whatever they look like. */
const TEXT_PROPS = new Set(["last_netname", "last_tuning", "initial_side", "tuning_mode"])

/** One property of a generated item: `yes` and `no`, a number, a string, `(xy x y)`, `(pts (xy ...))` or `(cells (ij i j) ...)`. Null for a value KiCad's parser accepts and this one cannot hold (an arc among the points). */
function genValueOf(c: List): KicadGenValue | null | undefined {
  const v = c[1]
  // The reader does not tell a quoted word from a bare one, so the properties KiCad holds as text are named: a net called `5` or a tuning of `10` must stay text, as the writer quotes it.
  if (typeof v === "string" && TEXT_PROPS.has(c[0] as string)) return v
  if (Array.isArray(v)) {
    if (v[0] === "xy") return { xy: [Number(v[1]), Number(v[2])] }
    if (v[0] === "pts") {
      const pts: [number, number][] = []
      for (const p of v.slice(1)) {
        if (!Array.isArray(p) || p[0] !== "xy") return null
        pts.push([Number(p[1]), Number(p[2])])
      }
      return { pts }
    }
    if (v[0] === "cells") {
      const cells: [number, number][] = []
      for (const p of v.slice(1)) {
        if (!Array.isArray(p) || p[0] !== "ij") return null
        cells.push([Number(p[1]), Number(p[2])])
      }
      return { cells }
    }
    return null
  }
  if (v === undefined) return undefined
  if (v === "yes") return true
  if (v === "no") return false
  if (NUMBER.test(v)) return Number(v)
  return v
}

/** What `parseGENERATOR` makes of a `generated` node: the fixed words, every other node as a property, the templates and the members. */
export function generatorOf(c: List, viaOf: (node: List) => KicadVia): KicadGenerator {
  const props: [string, KicadGenValue][] = []
  const unreadable: string[] = []
  const templates: KicadGenerator["templates"] = []
  const members: string[] = []
  let kind = ""
  let name = ""
  let layer = "F.Cu"
  let locked = false
  const fixed = new Set(["uuid", "id", "type", "name", "locked", "layer", "members", "templates", "custom_property"])
  for (let i = 1; i < c.length; i++) {
    const n = c[i]
    if (!Array.isArray(n) || typeof n[0] !== "string") continue
    switch (n[0]) {
      case "type":
        kind = strAt(n, 1) ?? ""
        break
      case "name":
        name = strAt(n, 1) ?? ""
        break
      case "layer":
        layer = strAt(n, 1) ?? layer
        break
      case "locked":
        locked = n[1] === "yes"
        break
      case "members":
        for (const m of n.slice(1)) if (typeof m === "string") members.push(m)
        break
      case "templates":
        for (const t of kids(n, "template")) {
          const via = kid(t, "via")
          if (via) templates.push({ name: strAt(kid(t, "name"), 1) ?? "", via: viaOf(via) })
        }
        break
      default:
        if (!fixed.has(n[0])) {
          const v = genValueOf(n)
          if (v === null) unreadable.push(n[0])
          else if (v !== undefined) props.push([n[0], v])
        }
    }
  }
  return {
    uuid: strAt(kid(c, "uuid"), 1) ?? strAt(kid(c, "id"), 1) ?? null,
    kind,
    name,
    layer,
    locked,
    props,
    templates,
    members,
    ...(unreadable.length ? { unreadable } : {}),
    node: c,
  }
}

// ---------- net chains ----------

/** The `(net_chains (net_chain (name ..) (members (net "A") ...) (terminal_pad "uuid") ...))` of a board, in file order. */
export function netChainsOf(tree: List): KicadNetChain[] {
  const out: KicadNetChain[] = []
  for (const section of kids(tree, "net_chains")) {
    for (const chain of kids(section, "net_chain")) {
      const nets: string[] = []
      const members = kid(chain, "members")
      for (const m of members?.slice(1) ?? []) {
        if (!Array.isArray(m)) continue
        if (m[0] === "net" && typeof m[1] === "string") nets.push(m[1])
        // the legacy `(member (net 3))` wrapper
        else if (m[0] === "member") for (const x of kids(m, "net")) if (typeof x[1] === "string") nets.push(x[1])
      }
      const terminals: string[] = []
      for (const t of kids(chain, "terminal_pad")) if (typeof t[1] === "string" && terminals.length < 2) terminals.push(t[1])
      out.push({ name: strAt(kid(chain, "name"), 1) ?? "", nets, terminals, node: chain })
    }
  }
  return out
}
