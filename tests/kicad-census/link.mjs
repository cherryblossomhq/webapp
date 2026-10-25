// How a board's footprints find their schematic symbols, measured over the corpus.
//
//   node tests/kicad-census/link.mjs <corpus-root> <out-dir>
//
// For every board that has a schematic beside it (`.kicad_sch` from KiCad 6, `.sch` from KiCad 5) it
// follows the sheets, collects the symbols with their instance paths and references, and tries the
// matching the importer will use, in this order:
//
//   1. path: the footprint's `(path "/<sheet uuids>/<symbol uuid>")` against each symbol's instance
//      paths. A board path leaves out the root sheet's uuid that an instance path starts with.
//      KiCad 5 writes `(path /5A1B2C3D)` with the symbol's timestamp, and KiCad 6 re-encodes a
//      timestamp as the uuid `00000000-0000-0000-0000-00005a1b2c3d`.
//   2. the symbol uuid alone, the last segment of the path.
//   3. the reference designator, taken from the instance of the sheet the symbol is on.
//
// and counts what each step matched, plus the cases that break a one-to-one link: a sheet used
// several times (one symbol, several footprints), a multi-unit symbol (several symbols, one
// footprint), and a footprint no symbol claims.

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from "node:fs"
import { dirname, join, relative, sep, basename } from "node:path"
import { parseSexpr, kid, kids, numAt } from "./sexpr.mjs"

const [, , root, outDir] = process.argv
if (!root || !outDir) {
  console.error("usage: node link.mjs <corpus-root> <out-dir>")
  process.exit(2)
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}

const read = (f) => {
  const buf = readFileSync(f)
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf)
  } catch {
    return buf.toString("latin1")
  }
}
const bump = (o, k, n = 1) => {
  o[k] = (o[k] ?? 0) + n
}
const prop = (node, name) => kids(node, "property").find((p) => p[1] === name)?.[2]
/** KiCad 5's timestamp as KiCad 6 writes it. */
const tsToUuid = (ts) => `00000000-0000-0000-0000-${ts.toLowerCase().padStart(12, "0")}`

// ---------- KiCad 6 and later ----------

/** Symbols of a schematic and its sheets: { uuid, reference, unit, footprint, paths: [instance path without the root uuid] } */
function readSheets(file, chain, seen, out, sheetUses, v6) {
  const text = read(file)
  const sch = parseSexpr(text).find((n) => Array.isArray(n) && n[0] === "kicad_sch")
  if (!sch) return
  const rootUuid = kid(sch, "uuid")?.[1]
  const symbols = kids(sch, "symbol").filter((s) => kid(s, "lib_id"))
  for (const s of symbols) {
    const uuid = kid(s, "uuid")?.[1]
    const entry = { uuid, unit: numAt(kid(s, "unit"), 1, 1), footprint: prop(s, "Footprint") || "", refs: [], file }
    // KiCad 7 and later: instances inside the symbol, one per use of the sheet
    for (const project of kids(kid(s, "instances") ?? [], "project")) {
      for (const path of kids(project, "path")) {
        entry.refs.push({ path: path[1], reference: kid(path, "reference")?.[1] ?? "", unit: numAt(kid(path, "unit"), 1, 1) })
      }
    }
    entry.fallbackReference = prop(s, "Reference") ?? ""
    out.push(entry)
  }
  // KiCad 6: one list at the end of the root sheet, naming symbols of every sheet below it, so it
  // is applied after all the sheets are read (`applyV6Instances`)
  for (const inst of kids(kid(sch, "symbol_instances") ?? [], "path")) v6.push(inst)
  for (const sheet of kids(sch, "sheet")) {
    // KiCad 6 writes "Sheet file" and "Sheet name" and KiCad 5-era files "File" and "Name"; the
    // parser maps them (sch_io_kicad_sexpr_parser.cpp:2807-2811) and in files up to 20200310
    // goes by position: the first property is the name and the second the file (:4329-4337).
    const props = kids(sheet, "property")
    const f = prop(sheet, "Sheetfile") ?? prop(sheet, "Sheet file") ?? prop(sheet, "File") ?? props[1]?.[2]
    if (!f) continue
    const child = join(dirname(file), f)
    sheetUses[child] = (sheetUses[child] ?? 0) + 1
    if (existsSync(child) && !seen.has(`${child}|${kid(sheet, "uuid")?.[1]}`)) {
      seen.add(`${child}|${kid(sheet, "uuid")?.[1]}`)
      readSheets(child, [...chain, kid(sheet, "uuid")?.[1]], seen, out, sheetUses, v6)
    }
  }
  return rootUuid
}

function boardFootprints(text) {
  const board = parseSexpr(text).find((n) => Array.isArray(n) && n[0] === "kicad_pcb")
  if (!board) return []
  return board
    .filter((n, i) => i > 0 && Array.isArray(n) && (n[0] === "footprint" || n[0] === "module"))
    .map((fp) => {
      const refNode = kids(fp, "fp_text").find((t) => t[1] === "reference") ?? kids(fp, "property").find((t) => t[1] === "Reference")
      return { path: kid(fp, "path")?.[1] ?? "", reference: refNode?.[2] ?? "", uuid: kid(fp, "uuid")?.[1] ?? kid(fp, "tstamp")?.[1] ?? "" }
    })
}

function linkModern(boardFile, schFile) {
  const out = []
  const sheetUses = {}
  const v6 = []
  readSheets(schFile, [], new Set(), out, sheetUses, v6)
  for (const inst of v6) {
    const full = inst[1]
    const tail = full.slice(full.lastIndexOf("/") + 1)
    const owner = out.find((e) => e.uuid === tail)
    if (owner) owner.refs.push({ path: full.slice(0, full.lastIndexOf("/")) || "/", reference: kid(inst, "reference")?.[1] ?? "", unit: numAt(kid(inst, "unit"), 1, 1), v6: true })
  }
  const fps = boardFootprints(read(boardFile)).filter((f) => !/\*/.test(f.reference))
  const byPath = new Map()
  const byUuid = new Map()
  const byRef = new Map()
  for (const s of out) {
    const refs = s.refs.length ? s.refs : [{ path: "/", reference: s.fallbackReference, unit: s.unit }]
    for (const r of refs) {
      // an instance path starts with the root sheet's uuid, a board path does not
      const parts = r.path.split("/").filter(Boolean)
      const stripped = "/" + [...parts.slice(1), s.uuid].join("/")
      byPath.set(stripped, s)
      byPath.set("/" + [...parts, s.uuid].join("/"), s)
      if (!byRef.has(r.reference)) byRef.set(r.reference, [])
      byRef.get(r.reference).push(s)
    }
    byUuid.set(s.uuid, s)
  }
  const rootVersion = numAt(kid(parseSexpr(read(schFile)).find((n) => Array.isArray(n) && n[0] === "kicad_sch") ?? [], "version"), 1, 0)
  const res = { schVersion: rootVersion, footprints: fps.length, path: 0, pathRootKept: 0, uuidOnly: 0, timestampUuid: 0, reference: 0, none: 0 }
  for (const f of fps) {
    if (!f.path) {
      // a footprint with no path was never linked: placed by hand on the board (mounting holes, logos, fiducials)
      if (byRef.has(f.reference)) res.reference++
      else {
        res.none++
        res.noneNoPath = (res.noneNoPath ?? 0) + 1
      }
      continue
    }
    const stripped = f.path
    const tail = f.path.slice(f.path.lastIndexOf("/") + 1)
    if (byPath.has(stripped)) {
      const withRoot = out.some((s) => s.refs.some((r) => "/" + [...r.path.split("/").filter(Boolean), s.uuid].join("/") === stripped))
      withRoot ? res.pathRootKept++ : res.path++
    } else if (byUuid.has(tail)) res.uuidOnly++
    else if (/^00000000-0000-0000-0000-[0-9a-f]{12}$/.test(tail)) res.timestampUuid++
    else if (byRef.has(f.reference)) res.reference++
    else {
      res.none++
      res.noneWithPath = (res.noneWithPath ?? 0) + 1
    }
    if (!byPath.has(stripped) && !byUuid.has(tail) && byRef.has(f.reference) && /^00000000-0000-0000-0000-[0-9a-f]{12}$/.test(tail)) {
      res.timestampUuid--
      res.reference++
    }
  }
  const refCount = new Map()
  for (const s of out) for (const r of s.refs) refCount.set(r.reference, (refCount.get(r.reference) ?? 0) + 1)
  res.symbols = out.length
  res.multiUnitReferences = [...refCount.entries()].filter(([ref, n]) => ref && n > 1 && out.filter((s) => s.refs.some((r) => r.reference === ref)).length > 1).length
  res.reusedSheetFiles = Object.values(sheetUses).filter((n) => n > 1).length
  res.symbolsOnSeveralPaths = out.filter((s) => s.refs.length > 1).length
  res.symbolsWithoutFootprintField = out.filter((s) => !s.footprint).length
  return res
}

// ---------- KiCad 5 ----------

function legacyComps(file, chain, seen, comps, sheetUses) {
  const lines = read(file).split(/\r?\n/)
  let comp = null
  let sheet = null
  for (const l of lines) {
    if (l.startsWith("$Comp")) comp = { ref: "", ts: "", ar: [], file }
    else if (l.startsWith("$EndComp")) {
      if (comp) comps.push({ ...comp, chain })
      comp = null
    } else if (comp) {
      if (l.startsWith("L ")) comp.ref = l.split(/\s+/)[2] ?? ""
      else if (l.startsWith("U ")) comp.ts = (l.split(/\s+/)[3] ?? "").toUpperCase()
      else if (l.startsWith("AR ")) {
        const path = /Path="([^"]*)"/.exec(l)?.[1]
        const ref = /Ref="([^"]*)"/.exec(l)?.[1]
        if (path) comp.ar.push({ path, ref })
      }
    } else if (l.startsWith("$Sheet")) sheet = { ts: "", file: "" }
    else if (l.startsWith("$EndSheet")) {
      if (sheet?.file) {
        const child = join(dirname(file), sheet.file)
        sheetUses[child] = (sheetUses[child] ?? 0) + 1
        if (existsSync(child) && !seen.has(`${child}|${sheet.ts}`)) {
          seen.add(`${child}|${sheet.ts}`)
          legacyComps(child, [...chain, sheet.ts], seen, comps, sheetUses)
        }
      }
      sheet = null
    } else if (sheet) {
      if (l.startsWith("U ")) sheet.ts = (l.split(/\s+/)[1] ?? "").toUpperCase()
      else if (l.startsWith("F1 ")) sheet.file = l.split('"')[1] ?? ""
    }
  }
}

function linkLegacy(boardFile, schFile) {
  const comps = []
  const sheetUses = {}
  legacyComps(schFile, [], new Set(), comps, sheetUses)
  const fps = boardFootprints(read(boardFile)).filter((f) => !/\*/.test(f.reference))
  const byPath = new Set()
  const byRef = new Set()
  for (const c of comps) {
    byPath.add("/" + [...c.chain, c.ts].join("/"))
    for (const a of c.ar) byPath.add(a.path)
    byRef.add(c.ref)
    for (const a of c.ar) byRef.add(a.ref)
  }
  const res = { footprints: fps.length, path: 0, reference: 0, none: 0 }
  for (const f of fps) {
    if (f.path && byPath.has(f.path.toUpperCase().replace(/^\/00000000-0000-0000-0000-/, "/"))) res.path++
    else if (f.path && byPath.has(f.path)) res.path++
    else if (byRef.has(f.reference)) res.reference++
    else res.none++
  }
  const refs = new Map()
  for (const c of comps) refs.set(c.ref, (refs.get(c.ref) ?? 0) + 1)
  res.symbols = comps.length
  res.multiUnitReferences = [...refs.values()].filter((n) => n > 1).length
  res.reusedSheetFiles = Object.values(sheetUses).filter((n) => n > 1).length
  res.compsWithARPaths = comps.filter((c) => c.ar.length).length
  return res
}

// ---------- the run ----------

mkdirSync(outDir, { recursive: true })
const results = []
const failures = []
for (const f of walk(root)) {
  if (!f.endsWith(".kicad_pcb")) continue
  const rel = relative(root, f).split(sep).join("/")
  const group = rel.startsWith("pcbench/") ? "pcbench" : rel.startsWith("kicad-source/demos") ? "kicad-demos" : rel.startsWith("kicad-source") ? "kicad-qa" : "github"
  const base = f.slice(0, -".kicad_pcb".length)
  try {
    if (existsSync(`${base}.kicad_sch`)) results.push({ file: rel, group, kind: "kicad_sch", ...linkModern(f, `${base}.kicad_sch`) })
    else if (existsSync(`${base}.sch`)) results.push({ file: rel, group, kind: "sch", ...linkLegacy(f, `${base}.sch`) })
  } catch (e) {
    failures.push({ file: rel, error: String(e.message ?? e).slice(0, 160) })
  }
}
writeFileSync(join(outDir, "links.json"), JSON.stringify(results))
writeFileSync(join(outDir, "link-failures.json"), JSON.stringify(failures, null, 1))

const sum = (rows, k) => rows.reduce((a, r) => a + (r[k] ?? 0), 0)
for (const kind of ["kicad_sch", "sch"]) {
  const rs = results.filter((r) => r.kind === kind && r.group !== "kicad-qa")
  if (!rs.length) continue
  const total = sum(rs, "footprints")
  console.log(`\n${kind} projects (not KiCad's regression boards): ${rs.length} boards, ${total} footprints with a reference not containing *`)
  for (const k of ["path", "pathRootKept", "uuidOnly", "timestampUuid", "reference", "none", "noneNoPath", "noneWithPath"]) if (rs.some((r) => k in r)) console.log(`  ${k}: ${sum(rs, k)} (${((100 * sum(rs, k)) / total).toFixed(1)}%)`)
  for (const k of ["symbols", "multiUnitReferences", "reusedSheetFiles", "symbolsOnSeveralPaths", "symbolsWithoutFootprintField", "compsWithARPaths"]) if (rs.some((r) => k in r)) console.log(`  ${k}: ${sum(rs, k)} in ${rs.filter((r) => r[k] > 0).length} boards`)
}
const eraOf = (v) => (v <= 20211123 ? "KiCad 6" : v <= 20230121 ? "KiCad 7" : v <= 20231120 ? "KiCad 8" : v <= 20250114 ? "KiCad 9" : "KiCad 10 and later")
console.log("\nper release of the root schematic (real and targeted, not KiCad's regression boards):")
console.log("| release | boards | footprints | by path | by reference | none, no path | none, path unmatched |\n|---|---|---|---|---|---|---|")
const modern = results.filter((r) => r.kind === "kicad_sch" && r.group !== "kicad-qa")
for (const era of ["KiCad 6", "KiCad 7", "KiCad 8", "KiCad 9", "KiCad 10 and later"]) {
  const rs = modern.filter((r) => eraOf(r.schVersion) === era)
  const n = sum(rs, "footprints")
  const path = sum(rs, "path") + sum(rs, "pathRootKept") + sum(rs, "uuidOnly")
  console.log(`| ${era} | ${rs.length} | ${n} | ${path} (${n ? ((100 * path) / n).toFixed(1) : 0}%) | ${sum(rs, "reference")} | ${sum(rs, "noneNoPath")} | ${sum(rs, "noneWithPath")} |`)
}
const worst = modern.filter((r) => r.noneWithPath > 0).sort((a, b) => b.noneWithPath - a.noneWithPath).slice(0, 6)
console.log("boards with a path no symbol claims:", worst.map((r) => `${r.file.split("/").slice(-2).join("/")} ${r.noneWithPath}/${r.footprints}`).join("; "))
console.log(`\nfailures: ${failures.length}`)
void basename
