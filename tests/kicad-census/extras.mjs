// The extras oracle (X21, X22): what a KiCad board file says about via protection, backdrills, post-machining, the lengths inside packages, generated items and net chains, read straight
// from the text with the census's own s-expression reader. It shares no code with `src`: the importer's answers are compared with these in `tests/kicad-extras-check.ts`.
//
// KiCad's own grammar (pcb_io_kicad_sexpr_parser.cpp, the 10.0 line): a protection word is `yes`, `no` or `none` (no choice); a side node is `(front X)` or `(back X)`; a drill is
// `(backdrill (size S) (layers A B))` and means something only with a size above zero and two layer names; a post-machining is `(front_post_machining MODE (size) (depth) (angle))`.

import { parseSexpr } from "./sexpr.mjs"

const kids = (n, name) => n.filter((c) => Array.isArray(c) && c[0] === name)
const kid = (n, name) => n.find((c) => Array.isArray(c) && c[0] === name)
const choice = (w) => (w === "yes" ? true : w === "no" ? false : null)

function sides(node) {
  const out = { front: null, back: null }
  if (!node) return out
  for (const c of node.slice(1)) if (Array.isArray(c) && (c[0] === "front" || c[0] === "back")) out[c[0]] = choice(c[1])
  return out
}

function drill(node) {
  if (!node) return null
  const size = Number(kid(node, "size")?.[1])
  const layers = kid(node, "layers")
  if (!(size > 0) || !layers || typeof layers[1] !== "string" || typeof layers[2] !== "string") return null
  return { size, start: layers[1], end: layers[2] }
}

function post(node) {
  if (!node || (node[1] !== "counterbore" && node[1] !== "countersink")) return null
  const n = (name) => (kid(node, name) ? Number(kid(node, name)[1]) : null)
  return { mode: node[1], size: n("size"), depth: n("depth"), angle: n("angle") }
}

/** Everything a board file says of X21 and X22. */
export function extrasOracle(text) {
  const root = parseSexpr(text)[0]
  if (!Array.isArray(root) || root[0] !== "kicad_pcb") return null
  const copper = []
  for (const r of kid(root, "layers")?.slice(1) ?? []) if (Array.isArray(r) && ["signal", "power", "mixed", "jumper"].includes(r[2])) copper.push(r[1])
  const setup = kid(root, "setup") ?? []
  const cover = sides(kid(setup, "covering"))
  const plug = sides(kid(setup, "plugging"))
  const board = {
    cap: kid(setup, "capping")?.[1] === "yes",
    fill: kid(setup, "filling")?.[1] === "yes",
    coverFront: cover.front === true,
    coverBack: cover.back === true,
    plugFront: plug.front === true,
    plugBack: plug.back === true,
  }
  const vias = kids(root, "via").map((v) => {
    const c = sides(kid(v, "covering"))
    const p = sides(kid(v, "plugging"))
    return {
      at: [Number(kid(v, "at")[1]), Number(kid(v, "at")[2])],
      cap: choice(kid(v, "capping")?.[1]),
      fill: choice(kid(v, "filling")?.[1]),
      coverFront: c.front,
      coverBack: c.back,
      plugFront: p.front,
      plugBack: p.back,
      backdrill: drill(kid(v, "backdrill")),
      tertiary: drill(kid(v, "tertiary_drill")),
      front: post(kid(v, "front_post_machining")),
      back: post(kid(v, "back_post_machining")),
    }
  })
  const pads = []
  const refs = []
  for (const fp of [...kids(root, "footprint"), ...kids(root, "module")]) {
    const ref = kid(fp, "property")?.[0] === "property" ? (kids(fp, "property").find((p) => p[1] === "Reference")?.[2] ?? "") : ""
    const layer = kid(fp, "layer")?.[1] ?? "F.Cu"
    refs.push(ref)
    kids(fp, "pad").forEach((p, index) => {
      const bd = drill(kid(p, "backdrill"))
      const td = drill(kid(p, "tertiary_drill"))
      const f = post(kid(p, "front_post_machining"))
      const b = post(kid(p, "back_post_machining"))
      const die = Number(kid(p, "die_length")?.[1] ?? 0)
      const delay = Number(kid(p, "die_delay")?.[1] ?? 0)
      if (bd || td || f || b || die > 0 || delay > 0) pads.push({ ref, bottom: layer === "B.Cu", index, backdrill: bd, tertiary: td, front: f, back: b, die, delay })
    })
  }
  const segments = new Set()
  for (const t of [...kids(root, "segment"), ...kids(root, "arc")]) segments.add(kid(t, "uuid")?.[1] ?? kid(t, "tstamp")?.[1])
  const viaIds = new Set(kids(root, "via").map((v) => kid(v, "uuid")?.[1] ?? kid(v, "tstamp")?.[1]))
  const generated = kids(root, "generated").map((g) => {
    const members = []
    for (const m of kids(g, "members")) for (const x of m.slice(1)) if (typeof x === "string") members.push(x)
    const props = {}
    for (const c of g.slice(1)) {
      if (!Array.isArray(c) || ["uuid", "id", "type", "name", "layer", "locked", "members", "templates", "custom_property"].includes(c[0])) continue
      props[c[0]] = c[1]
    }
    return {
      type: kid(g, "type")?.[1],
      name: kid(g, "name")?.[1] ?? "",
      layer: kid(g, "layer")?.[1] ?? "F.Cu",
      locked: kid(g, "locked")?.[1] === "yes",
      members: members.length,
      trackMembers: members.filter((m) => segments.has(m)).length,
      viaMembers: members.filter((m) => viaIds.has(m)).length,
      keys: Object.keys(props).sort(),
      props,
    }
  })
  const chains = kids(kid(root, "net_chains") ?? [], "net_chain").map((c) => ({ name: kid(c, "name")?.[1] ?? "", nets: (kid(c, "members") ?? []).filter((x) => Array.isArray(x) && x[0] === "net").map((x) => x[1]), terminals: kids(c, "terminal_pad").length }))
  return { copper, board, vias, pads, refs, generated, chains }
}
