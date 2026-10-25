import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { resolveRule, ruleFor, tokenRule } from "../src/model/kicad/schematic/account"
import { ATOMS_SCH, TOKENS_SCH, decisionForSch } from "./kicad-census/decisions-sch.mjs"
import { OUT, render } from "./kicad-census/emit-decisions-sch-ts.mjs"

// The schematic reader's decision table is a generated copy of the census's
// (`tests/kicad-census/decisions-sch.mjs`), so the table the census was judged against is the table
// the importer runs on.

describe("the schematic decision table", () => {
  it("the generated copy is the census's table: regenerate it with node tests/kicad-census/emit-decisions-sch-ts.mjs", () => {
    expect(readFileSync(OUT, "utf8").replace(/\r\n/g, "\n")).toBe(render().replace(/\r\n/g, "\n"))
  })

  it("answers every path as the census's does", () => {
    const paths = [
      "version",
      "generator",
      "uuid",
      "paper",
      "title_block>comment",
      "lib_symbols>symbol>symbol>pin>alternate",
      "lib_symbols>symbol>property>effects>font>size",
      "symbol>mirror",
      "symbol>instances>project>path>reference",
      "symbol>instances>project>path>variant>dnp",
      "symbol_instances>path>footprint",
      "wire>pts>xy",
      "wire>stroke>color",
      "junction>diameter",
      "no_connect>at",
      "label>effects>font>size",
      "global_label>shape",
      "hierarchical_label>at",
      "netclass_flag>length",
      "sheet>pin>at",
      "sheet_instances>path>page",
      "text>effects>justify",
      "rectangle>fill>type",
      "image>data",
      "table>cells>table_cell>ij",
      "rule_area>polyline",
      "group>members",
      "embedded_files>file>name",
      "embedded_fonts",
      "net_chain>nets",
      "no_such_node",
      "symbol>frobnicate",
    ]
    for (const p of paths) {
      const mine = ruleFor(p)
      const theirs = decisionForSch(p)
      expect(mine?.decision ?? null, p).toBe(theirs?.decision ?? null)
      expect(mine?.ext ?? null, p).toBe(theirs?.ext ?? null)
    }
  })

  it("has the census's atoms and keywords", () => {
    expect(ATOMS_SCH.length).toBeGreaterThan(20)
    expect(TOKENS_SCH.every((t) => t.names.every((n) => tokenRule(n) !== null))).toBe(true)
    expect(tokenRule("unconnected")?.decision).toBe("native")
  })

  it("a rule never matches half a path, and an unknown path has no row", () => {
    expect(ruleFor("symbol>frobnicate")).toBeNull()
    expect(ruleFor("lib_symbols>symbol>symbol>pin>frobnicate")).toBeNull()
    expect(ruleFor("wire")?.decision).toBe("native")
    expect(ruleFor("wire>stroke")?.ext).toBe("S4")
  })

  it("a node KiCad has a keyword for and no corpus file uses takes the keyword's row, and a keyword the table calls native is no fallback", () => {
    // the KiCad 6 and 7 spelling of a placed symbol's body style
    expect(ruleFor("symbol>convert")).toBeNull()
    expect(resolveRule("symbol>convert")).toMatchObject({ decision: "extend", ext: "S5" })
    expect(resolveRule("wire>hatch")).toMatchObject({ decision: "extend", ext: "S6" })
    expect(resolveRule("symbol>host")?.decision).toBe("not-needed")
    expect(resolveRule("symbol>extends")).toBeNull()
    expect(resolveRule("symbol>frobnicate")).toBeNull()
    // a row of the table is not replaced by a keyword's
    expect(resolveRule("symbol>mirror")).toBe(ruleFor("symbol>mirror"))
  })

  it("a hidden pin or a bare flag is a value of the table, and a word it does not list is not", () => {
    const pin = ATOMS_SCH.find((a) => a.path.test("lib_symbols>symbol>symbol>pin"))!
    expect(pin.values.has("hide")).toBe(true)
    expect(pin.values.has("passive")).toBe(true)
    expect(pin.values.has("frobnicate")).toBe(false)
  })
})
