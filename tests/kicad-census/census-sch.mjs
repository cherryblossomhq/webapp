// The census of everything beside the board: `.kicad_sch`, KiCad 5's `.sch`, `.kicad_pro`,
// KiCad 5's `.pro`, `.kicad_dru` and `-cache.lib`. One JSON record per file.
//
//   node tests/kicad-census/census-sch.mjs <corpus-root> <out-dir>
//
// Phase 3 and 4 of the importer (schematics and projects) are sized from this.

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from "node:fs"
import { join, relative, sep } from "node:path"
import { parseSexpr, kid, kids, numAt } from "./sexpr.mjs"
import { collectAtoms } from "./atoms.mjs"
import { ATOMS_SCH } from "./decisions-sch.mjs"

const [, , root, outDir] = process.argv
if (!root || !outDir) {
  console.error("usage: node census-sch.mjs <corpus-root> <out-dir>")
  process.exit(2)
}

// Same grouping as census.mjs: projects found by searching for a feature are kept apart.
const targetedFile = join(root, "projects", "_targeted.txt")
const targeted = new Set(existsSync(targetedFile) ? readFileSync(targetedFile, "utf8").split(/\r?\n/).filter(Boolean) : [])
const groupOf = (rel) => (rel.startsWith("pcbench/") ? "pcbench" : rel.startsWith("kicad-source/demos") ? "kicad-demos" : rel.startsWith("kicad-source") ? "kicad-qa" : targeted.has(rel.split("/")[1]) ? "github-targeted" : "github")

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}
const bump = (o, k, n = 1) => {
  o[k] = (o[k] ?? 0) + n
}

function kicadSch(text, rel, bytes) {
  const root = parseSexpr(text)
  const sch = root.find((n) => Array.isArray(n) && n[0] === "kicad_sch")
  if (!sch) throw new Error("no (kicad_sch ...) root")
  const rec = { file: rel, kind: "kicad_sch", bytes, version: Number(kid(sch, "version")?.[1] ?? NaN), generator: kid(sch, "generator")?.[1] ?? null, nodes: {}, d: {} }
  // every node by its whole path from the root, `symbol>property>effects>font`
  const stack = [[sch, ""]]
  while (stack.length) {
    const [n, path] = stack.pop()
    for (let i = 1; i < n.length; i++) {
      const c = n[i]
      if (Array.isArray(c) && typeof c[0] === "string") {
        const next = path ? `${path}>${c[0]}` : c[0]
        bump(rec.nodes, next)
        stack.push([c, next])
      }
    }
  }
  rec.atoms = collectAtoms(text, ATOMS_SCH, "kicad_sch")
  const top = (name) => kids(sch, name)
  const libSyms = kid(sch, "lib_symbols")
  const symbols = top("symbol")
  const power = symbols.filter((s) => /^power:/.test(kid(s, "lib_id")?.[1] ?? "")).length
  rec.d = {
    symbols: symbols.length,
    powerSymbols: power,
    libSymbols: libSyms ? kids(libSyms, "symbol").length : 0,
    sheets: top("sheet").length,
    wires: top("wire").length,
    buses: top("bus").length,
    busEntries: top("bus_entry").length,
    junctions: top("junction").length,
    noConnects: top("no_connect").length,
    labels: top("label").length,
    globalLabels: top("global_label").length,
    hierarchicalLabels: top("hierarchical_label").length,
    directiveLabels: top("directive_label").length + top("netclass_flag").length,
    texts: top("text").length,
    textBoxes: top("text_box").length,
    graphics: ["polyline", "rectangle", "circle", "arc", "bezier"].reduce((s, k) => s + top(k).length, 0),
    images: top("image").length,
    tables: top("table").length,
    ruleAreas: top("rule_area").length,
    symbolInstancesBlock: top("symbol_instances").length > 0,
    instancesInSymbols: symbols.filter((s) => kid(s, "instances")).length,
    sheetInstancesBlock: top("sheet_instances").length > 0,
    busAliases: top("bus_alias").length,
    withFootprintField: symbols.filter((s) => kids(s, "property").some((p) => p[1] === "Footprint" && p[2])).length,
    dnp: symbols.filter((s) => kid(s, "dnp")?.[1] === "yes").length,
    notInBom: symbols.filter((s) => kid(s, "in_bom")?.[1] === "no").length,
    embeddedFiles: top("embedded_files").length,
    multiUnitSymbols: symbols.filter((s) => numAt(kid(s, "unit"), 1, 1) > 1 || numAt(kid(s, "body_style"), 1, 1) > 1).length,
    mirroredSymbols: symbols.filter((s) => kid(s, "mirror")).length,
    alternatePins: symbols.reduce((n, s) => n + kids(s, "pin").filter((p) => kid(p, "alternate")).length, 0),
    flaggedSymbols: symbols.filter((s) => kid(s, "dnp")?.[1] === "yes" || kid(s, "in_bom")?.[1] === "no" || kid(s, "on_board")?.[1] === "no" || kid(s, "exclude_from_sim")?.[1] === "yes").length,
    variants: Object.keys(rec.nodes).filter((k) => /variant$/.test(k)).length,
    libSymbolsWithUnits: libSyms ? kids(libSyms, "symbol").filter((s) => kids(s, "symbol").some((u) => Number(/_(\d+)_\d+$/.exec(u[1] ?? "")?.[1] ?? 0) > 1)).length : 0,
  }
  return rec
}

/** A text file as KiCad 5 wrote it: UTF-8, or Latin-1 from older versions (`latin1` says which). */
function readText(f) {
  const buf = readFileSync(f)
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(buf), latin1: false }
  } catch {
    return { text: buf.toString("latin1"), latin1: true }
  }
}

function legacySch(text, rel, bytes, latin1) {
  const lines = text.split(/\r?\n/)
  const m = /^EESchema Schematic File Version (\d+)/.exec(lines[0] ?? "")
  if (!m) return { file: rel, kind: "sch-foreign", bytes, header: (lines[0] ?? "").slice(0, 40) }
  const rec = { file: rel, kind: "sch", bytes, version: Number(m[1]), latin1, lines: {}, comps: 0, multiUnitComps: 0, compsWithAR: 0, compsWithSeveralAR: 0, arLines: 0, powerComps: 0, libPrefixed: 0, sheets: 0, sheetPins: 0, sheetFiles: [], fieldsPerComp: 0 }
  let inComp = null
  const refUnits = new Map()
  for (const l of lines) {
    if (l.startsWith("$Comp")) {
      inComp = { ar: 0, unit: 1, ref: null }
      rec.comps++
    } else if (l.startsWith("$EndComp")) {
      if (inComp) {
        if (inComp.unit > 1) rec.multiUnitComps++
        if (inComp.ar) rec.compsWithAR++
        if (inComp.ar > 1) rec.compsWithSeveralAR++
        if (inComp.ref) refUnits.set(inComp.ref, (refUnits.get(inComp.ref) ?? 0) + 1)
      }
      inComp = null
    } else if (inComp) {
      if (l.startsWith("L ")) {
        const lib = l.split(/\s+/)[1] ?? ""
        if (lib.includes(":")) rec.libPrefixed++
        if (/^power:|^#PWR/.test(lib) || /#PWR/.test(l)) rec.powerComps++
        inComp.ref = l.split(/\s+/)[2] ?? null
      } else if (l.startsWith("U ")) inComp.unit = Number(l.split(/\s+/)[1]) || 1
      else if (l.startsWith("AR ")) {
        inComp.ar++
        rec.arLines++
      } else if (/^F \d/.test(l)) rec.fieldsPerComp++
    } else if (l.startsWith("$Sheet")) rec.sheets++
    else if (/^F1 "/.test(l)) rec.sheetFiles.push(l.split('"')[1])
    else if (/^F\d+ "[^"]*" [IOBT] /.test(l) && !/^F[01] /.test(l)) rec.sheetPins++
    if (l.startsWith("Wire ")) bump(rec.lines, l.split(/\s+/).slice(0, 3).join(" "))
    else if (l.startsWith("Entry ")) bump(rec.lines, l.split(/\s+/).slice(0, 3).join(" "))
    else if (l.startsWith("Text ")) bump(rec.lines, l.split(/\s+/).slice(0, 2).join(" "))
    else if (l.startsWith("Connection ")) bump(rec.lines, "Connection")
    else if (l.startsWith("NoConn ")) bump(rec.lines, "NoConn")
    else if (l.startsWith("$Bitmap")) bump(rec.lines, "$Bitmap")
    else if (/^(Polyline|Line|Rect|Circle|Arc)\b/.test(l)) bump(rec.lines, l.split(/\s+/)[0])
  }
  rec.severalComponentsOneReference = [...refUnits.values()].filter((n) => n > 1).length
  rec.reusedSheetFiles = rec.sheetFiles.length - new Set(rec.sheetFiles).size
  rec.fieldsPerComp = rec.comps ? +(rec.fieldsPerComp / rec.comps).toFixed(1) : 0
  return rec
}

function legacyBrd(text, rel, bytes) {
  const m = /^PCBNEW-BOARD Version (\d+)/.exec(text.split(/\r?\n/)[0] ?? "")
  return { file: rel, kind: "brd", bytes, version: m ? Number(m[1]) : null, modules: (text.match(/^\$MODULE/gm) ?? []).length, tracks: (text.match(/^\$TRACK/gm) ?? []).length, zones: (text.match(/^\$CZONE_OUTLINE/gm) ?? []).length }
}

function legacyLib(text, rel, bytes, kind) {
  const m = /^EESchema-LIBRARY Version ([\d.]+)/.exec(text.split(/\r?\n/)[0] ?? "")
  const defs = text.split(/\r?\n/).filter((l) => l.startsWith("DEF "))
  // DEF name reference unused pin-name-offset show-pin-numbers show-pin-names unit-count flags type
  const multiUnit = defs.filter((l) => Number(l.split(/\s+/)[7]) > 1).length
  return { file: rel, kind, bytes, version: m ? m[1] : null, symbols: defs.length, aliases: (text.match(/^ALIAS /gm) ?? []).length, multiUnit }
}

function proJson(text, rel, bytes) {
  const j = JSON.parse(text)
  const rec = { file: rel, kind: "kicad_pro", bytes, keys: Object.keys(j), metaVersion: j.meta?.version ?? null }
  const ns = j.net_settings
  rec.netClasses = Array.isArray(ns?.classes) ? ns.classes.length : 0
  rec.netClassNames = Array.isArray(ns?.classes) ? ns.classes.map((c) => c.name) : []
  rec.netClassPatterns = Array.isArray(ns?.netclass_patterns) ? ns.netclass_patterns.length : 0
  rec.netClassAssignments = ns?.netclass_assignments ? Object.keys(ns.netclass_assignments).length : 0
  rec.textVariables = j.text_variables ? Object.keys(j.text_variables).length : 0
  rec.customRules = j.board?.design_settings?.rules ? Object.keys(j.board.design_settings.rules).length : 0
  rec.hasDesignSettings = !!j.board?.design_settings
  rec.sheets = Array.isArray(j.sheets) ? j.sheets.length : 0
  rec.boardSections = Object.keys(j.board ?? {})
  rec.erc = !!j.erc
  rec.drcSeverities = j.board?.design_settings?.rule_severities ? Object.keys(j.board.design_settings.rule_severities).length : 0
  return rec
}

function proLegacy(text, rel, bytes) {
  const sections = [...text.matchAll(/^\[([^\]]+)\]/gm)].map((m) => m[1])
  return { file: rel, kind: "pro", bytes, sections }
}

mkdirSync(outDir, { recursive: true })
const out = []
const failures = []
for (const f of walk(root)) {
  const rel = relative(root, f).split(sep).join("/")
  const bytes = statSync(f).size
  try {
    if (f.endsWith(".kicad_sch")) out.push(kicadSch(readFileSync(f, "utf8"), rel, bytes))
    else if (f.endsWith(".sch")) {
      const { text, latin1 } = readText(f)
      out.push(legacySch(text, rel, bytes, latin1))
    } else if (f.endsWith(".kicad_pro")) out.push(proJson(readFileSync(f, "utf8"), rel, bytes))
    else if (f.endsWith(".pro")) out.push(proLegacy(readText(f).text, rel, bytes))
    else if (f.endsWith(".kicad_dru")) out.push({ file: rel, kind: "kicad_dru", bytes, rules: (readFileSync(f, "utf8").match(/\(rule\b/g) ?? []).length })
    else if (f.endsWith("-cache.lib") || f.endsWith(".cache.lib")) out.push(legacyLib(readText(f).text, rel, bytes, "cache.lib"))
    else if (f.endsWith(".lib")) out.push(legacyLib(readText(f).text, rel, bytes, "lib"))
    else if (f.endsWith(".brd")) out.push(legacyBrd(readText(f).text, rel, bytes))
    else if (f.endsWith(".cmp")) out.push({ file: rel, kind: "cmp", bytes, components: (readText(f).text.match(/^BeginCmp/gm) ?? []).length })
    else if (f.endsWith(".net")) {
      const t = readText(f).text
      out.push({ file: rel, kind: "net", bytes, legacy: t.startsWith("# EESchema Netlist"), components: (t.match(/^ \( \d|^\s*\(comp /gm) ?? []).length })
    }
  } catch (e) {
    failures.push({ file: rel, error: String(e.message ?? e).slice(0, 160) })
  }
}
for (const r of out) r.group = groupOf(r.file)
writeFileSync(join(outDir, "sidecars.json"), JSON.stringify(out))
writeFileSync(join(outDir, "sidecar-failures.json"), JSON.stringify(failures, null, 1))
const byKind = {}
for (const r of out) bump(byKind, r.kind)
console.log(`${out.length} files`, JSON.stringify(byKind), `${failures.length} failed`)
