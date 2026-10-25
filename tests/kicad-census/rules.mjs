// The net classes and design rules of a raw board, read with the census's own reader and none of `src`'s code: what the corpus
// test holds the importer's `DesignRules` against (X10). The shapes below are what KiCad 4 and 5 write; KiCad 6 and later keep
// their classes in the project file, so such a board has none here.

import { parseSexpr, kid, kids, numAt } from "./sexpr.mjs"
import { overbarOf } from "./pads.mjs"

/** KiCad's own micro via size for a class that does not say (`DEFAULT_UVIASDIA`, `DEFAULT_UVIASDRILL`) and its English text for the Default class. */
export const KICAD_DEFAULTS = { uviaDia: 0.3, uviaDrill: 0.1, description: "This is the default net class.", maxError: 0.005 }

const text = (node, i) => (typeof node?.[i] === "string" ? node[i] : undefined)

/**
 * `{ stamp, classes: [{ name, description, nodes: { clearance, trace_width, via_dia, via_drill, uvia_dia, uvia_drill, diff_pair_width?, diff_pair_gap? },
 * members: [raw net name] }], setup: { userVias, userDiffPairs, ... }, nets: [raw net name] }`; numbers are NaN where the node is absent.
 */
export function rulesOracle(source) {
  const root = parseSexpr(source)
  const board = root.find((n) => Array.isArray(n) && n[0] === "kicad_pcb")
  const stamp = numAt(kid(board, "version"), 1, null)
  // the board parser of KiCad before stamp 20210606 converts an old overbar in every net name and every net class member
  const name = (raw) => (stamp !== null && stamp < 20210606 ? overbarOf(raw ?? "") : (raw ?? ""))
  const classes = kids(board, "net_class").map((c) => {
    const nodes = {}
    for (const key of ["clearance", "trace_width", "via_dia", "via_drill", "uvia_dia", "uvia_drill", "diff_pair_width", "diff_pair_gap"]) {
      const n = kid(c, key)
      if (n) nodes[key] = Number(n[1])
    }
    return { name: text(c, 1) ?? "", description: text(c, 2) ?? "", nodes, members: kids(c, "add_net").map((a) => name(text(a, 1))) }
  })
  const setup = kid(board, "setup")
  const num = (key) => {
    const n = kid(setup, key)
    return n ? Number(n[1]) : undefined
  }
  const word = (key) => text(kid(setup, key), 1)
  const nets = kids(board, "net").map((n) => name(n.length >= 3 ? text(n, 2) : text(n, 1)))
  return {
    stamp,
    classes,
    nets,
    setup: {
      userVias: kids(setup, "user_via").map((v) => [Number(v[1]), Number(v[2])]),
      userDiffPairs: kids(setup, "user_diff_pair").map((v) => v.slice(1).map(Number)),
      maskMin: num("solder_mask_min_width"),
      pasteRatio: num("pad_to_paste_clearance_ratio"),
      maxError: num("max_error"),
      clearanceMin: num("clearance_min"),
      creepage: num("creepage"),
      bridges: word("allow_soldermask_bridges_in_footprints"),
      throughHoleMin: num("through_hole_min"),
      viaMinDrill: num("via_min_drill"),
      viaSize: num("via_size"),
      viaDrill: num("via_drill"),
      traceClearance: num("trace_clearance"),
    },
  }
}

/** A net's name as the user reads it: KiCad writes `/` in a net name as `{slash}`. */
export const readable = (raw) => raw.replace(/\{slash\}/g, "/")

/** The class a net is in, by the file's own spelling of its name: the class that lists it, or Default. */
export function classOf(oracleRules, rawNet) {
  const hit = oracleRules.classes.find((c) => c.name !== "Default" && c.members.includes(rawNet))
  return hit ? hit.name : "Default"
}
