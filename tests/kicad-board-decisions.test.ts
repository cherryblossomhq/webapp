import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { ruleFor, tokenRule } from "../src/model/kicad/board/account"
import { ATOMS, TOKENS, decisionFor } from "./kicad-census/decisions.mjs"
import { OUT, render } from "./kicad-census/emit-decisions-ts.mjs"

// The reader's decision table is a generated copy of the census's (`tests/kicad-census/decisions.mjs`),
// so the table the census was judged against is the table the importer runs on.

describe("the decision table", () => {
  it("the generated copy is the census's table: regenerate it with node tests/kicad-census/emit-decisions-ts.mjs", () => {
    expect(readFileSync(OUT, "utf8").replace(/\r\n/g, "\n")).toBe(render().replace(/\r\n/g, "\n"))
  })

  it("answers every path as the census's does", () => {
    const paths = [
      "version",
      "footprint>pad>at",
      "module>pad>at",
      "module>pad>drill>offset",
      "zone>polygon>pts>xy",
      "zone>filled_polygon>pts>xy",
      "gr_arc>angle",
      "layers><layer number>",
      "setup>pcbplotparams>layerselection",
      "segment>net",
      "embedded_files>file>name",
      "footprint>embedded_files",
      "footprint>model>offset>xyz",
      "dimension>arrow1a>pts>xy",
      "grid_item>at",
      "no_such_node",
      "footprint>pad>frobnicate",
    ]
    for (const p of paths) {
      const mine = ruleFor(p)
      const theirs = decisionFor(p)
      expect(mine?.decision ?? null, p).toBe(theirs?.decision ?? null)
      expect(mine?.ext ?? null, p).toBe(theirs?.ext ?? null)
    }
  })

  it("has the census's atoms and keywords", () => {
    expect(ATOMS.length).toBeGreaterThan(40)
    expect(tokenRule("module")?.decision).toBe("native")
    expect(TOKENS.every((t) => t.names.every((n) => tokenRule(n) !== null))).toBe(true)
  })

  it("native means the project builder writes the node: what it does not write is an extension need, not needed with a reason, or reported", () => {
    const rows: [string, string, string?][] = [
      ["setup>via_min_size", "native"],
      ["setup>user_via", "extend", "X10"],
      ["setup>zone_45_only", "not-needed"],
      ["setup>last_trace_width", "not-needed"],
      ["setup>via_size", "not-needed"],
      ["setup>hole_to_hole_min", "native"],
      ["setup>through_hole_min", "native"],
      ["net_class>diff_pair_gap", "extend", "X10"],
      ["net_class>diff_pair_width", "extend", "X10"],
      ["net_class>uvia_dia", "extend", "X10"],
      ["setup>creepage", "extend", "X26"],
      ["setup>user_diff_pair", "extend", "X10"],
      ["net_class>trace_width", "extend", "X10"],
      ["footprint>pad>pintype", "native"],
      ["footprint>pad>pinfunction", "native"],
      ["footprint>descr", "native"],
      ["footprint>tags", "native"],
      ["footprint>placed", "not-needed"],
      ["footprint>path", "not-needed"],
      ["footprint>model>opacity", "report"],
      ["footprint>model>uuid", "not-needed"],
      ["footprint>model>offset", "native"],
      ["host", "not-needed"],
      ["generator", "not-needed"],
      ["gr_arc>angle", "extend", "X8"],
    ]
    for (const [path, decision, ext] of rows) {
      expect([path, ruleFor(path)?.decision, ruleFor(path)?.ext ?? undefined]).toEqual([path, decision, ext])
    }
  })

  it("an unknown path has no row, and a rule never matches half a path", () => {
    expect(ruleFor("footprint>pad>frobnicate")).toBeNull()
    expect(ruleFor("zone>polygon>pts")?.decision).toBe("extend")
    expect(ruleFor("zone>filled_polygon")?.decision).toBe("not-needed")
  })
})
