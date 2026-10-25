// Pins the decisions that matter most, and checks that every path a census saw has one.
//
//   node --test tests/kicad-census/decisions.check.mjs
//   CENSUS=<corpus dir>/census node --test tests/kicad-census/decisions.check.mjs
//
// It is not a vitest file (the census runs over a corpus that is not in the repo), and it needs
// no install. A rule that matched on a name alone once made a zone's outline (`polygon>pts`)
// "not needed"; these are the paths that must never go that way again.

import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { test } from "node:test"
import { ATOMS, RULES, TOKENS, decisionFor } from "./decisions.mjs"

const is = (path, decision, ext) => {
  const d = decisionFor(path)
  assert.ok(d, `no decision for ${path}`)
  assert.equal(d.decision, decision, `${path}: ${d.decision}`)
  if (ext !== undefined) assert.equal(d.ext ?? "", ext, `${path}: ${d.ext}`)
}

test("a zone's outline is copper geometry, not something to drop", () => {
  is("zone>polygon", "native")
  is("zone>polygon>pts", "native")
  is("zone>polygon>pts>xy", "native")
  is("zone>polygon>pts>arc>mid", "native")
  is("footprint>zone>polygon>pts>xy", "native")
  is("zone>keepout>vias", "native")
  is("zone>fill>hatch_gap", "extend", "X24")
})

test("only KiCad's own fill result is dropped from a zone", () => {
  is("zone>filled_polygon", "not-needed")
  is("zone>filled_polygon>pts>xy", "not-needed")
  is("zone>fill_segments>pts>xy", "not-needed")
})

test("the same name means what its place says", () => {
  is("footprint>pad>at", "extend", "X7")
  is("module>pad>at", "extend", "X7")
  is("footprint>at", "extend", "X6")
  is("footprint>model>at>xyz", "native")
  is("footprint>model>offset>xyz", "native")
  is("dimension>arrow1a>pts>xy", "extend", "X11")
  is("footprint>dimension>pts>xy", "extend", "X11")
  is("footprint>table>cells>table_cell>effects>justify", "extend", "X9")
  is("table>cells>table_cell", "extend", "X9")
  is("zone>placement", "extend", "X20")
  is("zone>placement>component_class", "extend", "X20")
  is("footprint>zone>placement>enabled", "extend", "X20")
})

test("text outlines and fonts are kept, because they decide silkscreen shapes", () => {
  is("footprint>fp_text>render_cache", "extend", "X19")
  is("footprint>fp_text>render_cache>polygon>pts>xy", "extend", "X19")
  is("gr_text>render_cache>polygon", "extend", "X19")
  is("embedded_fonts", "extend", "X19")
  is("footprint>embedded_fonts", "extend", "X19")
})

test("embedded files are reported, named per file, never dropped (founder decision, 24 October 2026)", () => {
  is("embedded_files", "report")
  is("embedded_files>file", "report")
  is("embedded_files>file>name", "report")
  is("footprint>embedded_files", "report")
  is("footprint>embedded_files>file>checksum", "report")
  assert.match(decisionFor("embedded_files>file").note, /named per file/)
})

test("what used to be reported is built", () => {
  is("footprint>pad>die_length", "extend", "X21")
  is("footprint>pad>die_delay", "extend", "X21")
  is("generated>base_line>pts>xy", "extend", "X21")
  is("via>capping>front", "extend", "X22")
  is("via>backdrill>layers", "extend", "X22")
  is("footprint>pad>front_post_machining>angle", "extend", "X22")
  is("footprint>variant>field>name", "extend", "X23")
  is("footprint>units>unit>pins", "extend", "X23")
  is("footprint>component_classes>class", "extend", "X20")
  is("general>legacy_teardrops", "not-needed")
})

test("the legacy forms are read, not ignored", () => {
  // a legacy arc's sweep is read (into start, mid and end), and carried only as part of the outline, so it is the arc's own extension and not "native"
  is("gr_arc>angle", "extend", "X8")
  is("footprint>fp_arc>angle", "extend", "X8")
  is("gr_line>angle", "not-needed")
  is("segment>status", "native")
  is("via>status", "native")
  is("module>fp_text>effects>justify", "extend", "X9")
})

test("tracks, vias and pads keep what the file says", () => {
  is("segment>net", "extend", "X13")
  is("via>layers", "extend", "X5")
  is("via>padstack>layer", "extend", "X5")
  is("footprint>pad>net", "native")
  is("footprint>pad>padstack>layer>size", "extend", "X7")
  is("footprint>pad>drill>offset", "extend", "X7")
  is("footprint>pad>primitives>gr_poly>pts>xy", "extend", "X7")
})

test("a path no rule covers has no decision", () => {
  assert.equal(decisionFor("zone>some_future_token"), null)
})

test("the atom table knows a buried via and a thieving fill", () => {
  const known = (path, atom) => ATOMS.find((a) => a.path.test(path))?.values.has(atom)
  assert.ok(known("via", "buried"))
  assert.ok(known("zone>fill>mode", "thieving"))
  assert.ok(!known("via", "teleporting"))
})

test("a token the table says is extended or native has a path rule or an atom list that names it", () => {
  // `kicad_pcb` is the root list and `module` the old spelling of footprint, which paths normalise
  const exempt = new Set(["kicad_pcb", "module"])
  const missing = []
  for (const t of TOKENS) {
    if (t.decision === "not-needed") continue
    for (const name of t.names) {
      if (exempt.has(name)) continue
      const word = new RegExp(`(^|[^a-z_])${name}([^a-z_]|$)`)
      if (!RULES.some((r) => word.test(r.path.source)) && !ATOMS.some((a) => a.values.has(name))) missing.push(name)
    }
  }
  assert.deepEqual(missing, [])
})

test("the paths that once had no rule have one", () => {
  is("footprint>fp_text_box", "extend", "X9")
  is("footprint>fp_text_box>effects>font>size", "extend", "X9")
  is("footprint>private_layers", "report")
  is("footprint>private_layers><layer number>", "report")
  is("point", "extend", "X23")
  is("point>at", "extend", "X23")
  is("gr_ellipse>major_radius", "extend", "X8")
  is("grid_item>affects>cursor", "report")
})

test("every path in a census has a decision", { skip: !process.env.CENSUS || !existsSync(join(process.env.CENSUS ?? "", "boards.json")) }, () => {
  const boards = JSON.parse(readFileSync(join(process.env.CENSUS, "boards.json"), "utf8"))
  const missing = new Set()
  for (const b of boards) for (const path of Object.keys(b.nodes)) if (!decisionFor(path)) missing.add(path)
  assert.deepEqual([...missing], [])
})
