// Tables for the files beside the board, from `census-sch.mjs`.
//
//   node tests/kicad-census/aggregate-sch.mjs <out-dir>

import { readFileSync } from "node:fs"
import { join } from "node:path"

const [, , dir] = process.argv
const all = JSON.parse(readFileSync(join(dir, "sidecars.json"), "utf8"))
const groupOf = (f, r) => r.group
const eraOfSch = (v) => (v === null || Number.isNaN(v) ? "?" : v <= 20211123 ? "kicad6 (<=20211123)" : v <= 20230121 ? "kicad7 (<=20230121)" : v <= 20231120 ? "kicad8 (<=20231120)" : v <= 20250114 ? "kicad9 (<=20250114)" : "kicad10 or later")

for (const set of ["real", "targeted", "kicad-qa"]) {
  const pick = (r) => (set === "real" ? ["pcbench", "github", "kicad-demos"].includes(r.group) : set === "targeted" ? r.group === "github-targeted" : r.group === "kicad-qa")
  const rs = all.filter(pick)
  console.log(`\n# Sidecar census, set ${set}`)
  const kinds = {}
  for (const r of rs) kinds[r.kind] = (kinds[r.kind] ?? 0) + 1
  console.log("files:", JSON.stringify(kinds))

  const sch = rs.filter((r) => r.kind === "kicad_sch")
  const N = sch.length
  console.log(`\n## .kicad_sch (${N})`)
  const era = {}
  for (const r of sch) era[eraOfSch(r.version)] = (era[eraOfSch(r.version)] ?? 0) + 1
  console.log("by release:", JSON.stringify(era))
  const ver = {}
  for (const r of sch) ver[r.version] = (ver[r.version] ?? 0) + 1
  console.log("by stamp:", JSON.stringify(ver))
  const feat = (label, f) => console.log(`| ${label} | ${sch.filter(f).length} | ${N ? ((100 * sch.filter(f).length) / N).toFixed(1) : 0}% |`)
  console.log("\n| feature | files | % |\n|---|---|---|")
  feat("symbols", (r) => r.d.symbols > 0)
  feat("power symbols (lib_id power:)", (r) => r.d.powerSymbols > 0)
  feat("sub-sheets (sheet)", (r) => r.d.sheets > 0)
  feat("wires", (r) => r.d.wires > 0)
  feat("buses", (r) => r.d.buses > 0)
  feat("bus entries", (r) => r.d.busEntries > 0)
  feat("junctions", (r) => r.d.junctions > 0)
  feat("no_connect", (r) => r.d.noConnects > 0)
  feat("local labels", (r) => r.d.labels > 0)
  feat("global labels", (r) => r.d.globalLabels > 0)
  feat("hierarchical labels", (r) => r.d.hierarchicalLabels > 0)
  feat("directive labels", (r) => r.d.directiveLabels > 0)
  feat("text", (r) => r.d.texts > 0)
  feat("text boxes", (r) => r.d.textBoxes > 0)
  feat("graphics (polyline, rectangle, circle, arc, bezier)", (r) => r.d.graphics > 0)
  feat("images", (r) => r.d.images > 0)
  feat("tables", (r) => r.d.tables > 0)
  feat("rule areas", (r) => r.d.ruleAreas > 0)
  feat("bus aliases", (r) => r.d.busAliases > 0)
  feat("root symbol_instances block (KiCad 6 style)", (r) => r.d.symbolInstancesBlock)
  feat("instances inside symbols (KiCad 7+ style)", (r) => r.d.instancesInSymbols > 0)
  feat("a Footprint field on a symbol", (r) => r.d.withFootprintField > 0)
  feat("DNP symbols", (r) => r.d.dnp > 0)
  feat("embedded files", (r) => r.d.embeddedFiles > 0)
  console.log(`\nsymbols total ${sch.reduce((s, r) => s + r.d.symbols, 0)}, wires ${sch.reduce((s, r) => s + r.d.wires, 0)}, labels ${sch.reduce((s, r) => s + r.d.labels + r.d.globalLabels + r.d.hierarchicalLabels, 0)}`)

  const leg = rs.filter((r) => r.kind === "sch")
  console.log(`
## legacy .sch (${leg.length}); ${rs.filter((r) => r.kind === "sch-foreign").length} more .sch files are not KiCad's (Eagle, PADS) and are left out`)
  const lv = {}
  for (const r of leg) lv[r.version] = (lv[r.version] ?? 0) + 1
  console.log("by 'EESchema Schematic File Version':", JSON.stringify(lv))
  console.log(`not UTF-8 (read as Latin-1): ${leg.filter((r) => r.latin1).length}`)
  const lines = {}
  for (const r of leg) for (const k of Object.keys(r.lines)) lines[k] = (lines[k] ?? 0) + 1
  console.log("files having each line type:", JSON.stringify(lines))
  const sumL = (k) => leg.reduce((a, r) => a + (r[k] ?? 0), 0)
  console.log(`$Comp blocks ${sumL("comps")}; with AR Path lines ${sumL("compsWithAR")} in ${leg.filter((r) => r.compsWithAR).length} files; with several AR lines ${sumL("compsWithSeveralAR")}; components of a multi-unit symbol (U n, n > 1) ${sumL("multiUnitComps")} in ${leg.filter((r) => r.multiUnitComps).length} files; several $Comp for one reference ${sumL("severalComponentsOneReference")}; library-prefixed L lines ${sumL("libPrefixed")} of ${sumL("comps")}; $Sheet ${sumL("sheets")}, sheet files used twice ${sumL("reusedSheetFiles")}`)
  // each folder with legacy schematics, and whether a symbol library sits beside them
  const dirs = new Map()
  for (const r of rs) {
    const d = r.file.slice(0, r.file.lastIndexOf("/"))
    const e = dirs.get(d) ?? { sch: 0, lib: 0 }
    if (r.kind === "sch") e.sch++
    if (r.kind === "cache.lib" || r.kind === "lib") e.lib++
    dirs.set(d, e)
  }
  const legDirs = [...dirs.values()].filter((e) => e.sch)
  console.log(`folders with legacy schematics: ${legDirs.length}; with a .lib or -cache.lib beside them: ${legDirs.filter((e) => e.lib).length}`)
  const libs = rs.filter((r) => r.kind === "cache.lib" || r.kind === "lib")
  console.log(`## symbol libraries (.lib, -cache.lib, .cache.lib): ${libs.length}, symbols ${libs.reduce((a, r) => a + r.symbols, 0)}, multi-unit ${libs.reduce((a, r) => a + (r.multiUnit ?? 0), 0)}, aliases ${libs.reduce((a, r) => a + (r.aliases ?? 0), 0)}`)
  const lvv = {}
  for (const r of libs) lvv[r.version] = (lvv[r.version] ?? 0) + 1
  console.log("library versions:", JSON.stringify(lvv))
  const brd = rs.filter((r) => r.kind === "brd")
  console.log(`## legacy .brd boards (not s-expressions): ${brd.length}`, JSON.stringify(brd.map((r) => `${r.file.split("/").pop()} v${r.version} ${r.modules} modules`)))
  console.log(`## .cmp ${rs.filter((r) => r.kind === "cmp").length}, .net ${rs.filter((r) => r.kind === "net").length}`)

  const pro = rs.filter((r) => r.kind === "kicad_pro")
  console.log(`\n## .kicad_pro (${pro.length})`)
  const pf = (label, f) => console.log(`| ${label} | ${pro.filter(f).length} |`)
  console.log("| feature | files |\n|---|---|")
  pf("more than one net class", (r) => r.netClasses > 1)
  pf("net class patterns", (r) => r.netClassPatterns > 0)
  pf("net class assignments", (r) => r.netClassAssignments > 0)
  pf("text variables", (r) => r.textVariables > 0)
  pf("custom rules object", (r) => r.customRules > 0)
  pf("design settings", (r) => r.hasDesignSettings)
  pf("sheets list", (r) => r.sheets > 0)
  const keys = {}
  for (const r of pro) for (const k of r.keys) keys[k] = (keys[k] ?? 0) + 1
  console.log("top-level keys:", JSON.stringify(keys))
  const mv = {}
  for (const r of pro) mv[r.metaVersion] = (mv[r.metaVersion] ?? 0) + 1
  console.log("meta.version:", JSON.stringify(mv))
  const secs = {}
  for (const r of pro) for (const k of r.boardSections) secs[k] = (secs[k] ?? 0) + 1
  console.log("board sections:", JSON.stringify(secs))

  const legacyPro = rs.filter((r) => r.kind === "pro")
  console.log(`\n## legacy .pro (${legacyPro.length})`)
  const ps = {}
  for (const r of legacyPro) for (const s of r.sections) ps[s] = (ps[s] ?? 0) + 1
  console.log("sections:", JSON.stringify(ps))
  const dru = rs.filter((r) => r.kind === "kicad_dru")
  console.log(`\n## .kicad_dru (${dru.length}), rules total ${dru.reduce((s, r) => s + r.rules, 0)}`)

}
