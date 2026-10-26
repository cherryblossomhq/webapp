import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, relative, sep } from "node:path"
import { describe, expect, it } from "vitest"
import { computeConnectivity, pinKey } from "../src/model/connectivity"
import { schematicPins } from "../src/model/instances"
import { EXTENSION_NAMES as BOARD_EXTENSION_NAMES, readKicadBoard } from "../src/model/kicad/board"
import { importKicadProject, type ProjectFile } from "../src/model/kicad/project"
import { accountLegacyPro, readLegacyPro } from "../src/model/kicad/project/legacyPro"
import { countPaths } from "../src/model/kicad/schematic/account"
import { buildSchematicProject } from "../src/model/kicad/schematic/build"
import { plainnessOf } from "../src/model/kicad/schematic/carried"
import { needsOfFile, needsOfProject } from "../src/model/kicad/schematic/needs"
import { gateSchematic, importKicadSchematic } from "../src/model/kicad/schematic/import"
import { isLegacySchematic } from "../src/model/kicad/schematic/legacy/read"
import { legacyPartToSymbolText, readLegacyLibraryText } from "../src/model/kicad/schematic/legacy/lib"
import { linkFootprints } from "../src/model/kicad/schematic/link"
import { readKicadSchematic } from "../src/model/kicad/schematic/read"
import { drawingFromLib } from "../src/model/kicad/schematic/symbols"
import { readSchematicTree } from "../src/model/kicad/schematic/tree"
import { legacyNeeds, legacyRecordCounts, rawLegacySymbols, type RawLegacySymbol } from "./kicad-census/census-legacy.mjs"
import { deriveLegacyNets, newOverbar } from "./kicad-census/netlist-legacy.mjs"
import { boardPadNets } from "./kicad-census/netlist-sch.mjs"

// The pass or fail table of slice 3e (KiCad 4 and 5 schematics) over a local corpus (not in the repo):
//
//   KICAD_CORPUS=<corpus dir> KICAD_CENSUS=<corpus dir>/census \
//     KICAD_CORPUS_OUT=<dir> npx vitest run tests/kicad-schematic-legacy-corpus.test.ts
//
// Every legacy `.sch` of the corpus with the files beside it: every record accounted for against the raw
// census (`census-legacy.mjs`), the extensions each needs against the census's rules, the import with the
// real gate and with the unbuilt-but-measurable extensions raised, the nets of the importable flat sheets
// against `netlist-legacy.mjs` (KiCad 5.1's rules from the raw files, sharing no code with `src`), the
// footprint links against `link.mjs`, the nets of each project against the nets its board carries, and
// every symbol of every legacy library against the raw `.lib` to 0.001 mm. With no corpus it is skipped.

const CORPUS = process.env.KICAD_CORPUS
const CENSUS = process.env.KICAD_CENSUS ?? (CORPUS ? join(CORPUS, "census") : "")
const ONLY = process.env.KICAD_ONLY?.split(",").filter(Boolean) ?? []
const OUT = process.env.KICAD_CORPUS_OUT ?? join(tmpdir(), "kicad-schematic-legacy-corpus")

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) {
      if (name === "census") continue
      walk(p, out)
    } else out.push(p)
  }
  return out
}

const rel = (path: string) => relative(CORPUS!, path).split(sep).join("/")
const targeted = new Set(existsSync(join(CORPUS ?? "", "projects", "_targeted.txt")) ? readFileSync(join(CORPUS!, "projects", "_targeted.txt"), "utf8").split("\n").map((l) => l.trim()).filter(Boolean) : [])
const groupOf = (r: string) => (r.startsWith("pcbench/") ? "pcbench" : r.startsWith("kicad-source/demos") ? "kicad-demos" : r.startsWith("kicad-source") ? "kicad-qa" : targeted.has(r.split("/")[1]) ? "github-targeted" : "github")
const REAL = ["pcbench", "github", "kicad-demos"]
/** The extensions raised to measure the nets of a file the real gate refuses for S2 and the rest of what is built. */
const MEASURE = new Set(["S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8", "S9", "S10", "X19"])
/** The paths the census counts that are not records the parser accounts one by one. */
const normPath = (p: string) => p.toUpperCase().replace(/\/0{8}-0{4}-0{4}-0{4}-0*([0-9A-F]+)/g, "/$1").replace(/\/0+(?=[0-9A-F])/g, "/")

interface Row {
  file: string
  group: string
  version: number
  bytes: number
  parse: string
  recordsEqual: boolean
  recordDiff: string
  needs: string[]
  census: string[]
  needsDiff: string
  /** The extensions the importer found on top of the census's rules (each with its source) that are not explained. */
  needsUnexplained: string[]
  import: string
  raised: string
  nets: string
  sources: string
}

/** A symbol's key: its timestamp path, or its reference when the timestamp is 0 (several symbols have it). */
const keyOfSymbol = (path: string, ref: string) => (path === "/0" ? `/0@${ref}` : path)
const dirFiles = (dir: string) => {
  const m = new Map<string, Uint8Array>()
  for (const f of readdirSync(dir)) {
    const p = join(dir, f)
    if (statSync(p).isFile()) m.set(f, new Uint8Array(readFileSync(p)))
  }
  return m
}

const MM = 12.7
const near = (units: number, mm: number) => Math.abs(units * MM - mm)

describe.skipIf(!CORPUS)("the KiCad 5 schematic corpus", () => {
  it(
    "reads, accounts for, links and checks every legacy schematic, project and library, and agrees with the census",
    () => {
      const t0 = Date.now()
      const all = walk(CORPUS!).sort()
      const links = JSON.parse(readFileSync(join(CENSUS, "links.json"), "utf8")) as Record<string, any>[]
      const linkOf = new Map(links.filter((l) => l.kind === "sch").map((l) => [l.file as string, l]))
      const rows: Row[] = []
      const problems: string[] = []
      const namedErrors: string[] = []
      let unknown = 0
      let crashes = 0

      // ---------- every legacy .sch ----------
      for (const path of all.filter((f) => f.endsWith(".sch"))) {
        const bytes = new Uint8Array(readFileSync(path))
        if (!isLegacySchematic(bytes)) continue
        if (ONLY.length && !ONLY.some((o) => path.includes(o))) continue
        const file = rel(path)
        const dir = path.slice(0, path.lastIndexOf(sep))
        const name = path.slice(dir.length + 1)
        const row: Row = { file, group: groupOf(file), version: 0, bytes: bytes.length, parse: "", recordsEqual: false, recordDiff: "", needs: [], census: [], needsDiff: "", needsUnexplained: [], import: "", raised: "", nets: "-", sources: "" }
        rows.push(row)
        try {
          const files = dirFiles(dir)
          const tree = readSchematicTree(files, name)
          const sf = tree.files.get(tree.root)!
          row.version = sf.schematic.legacy!.version
          row.parse = "ok"
          // every record against the raw census
          const raw = legacyRecordCounts(Buffer.from(bytes).toString(sf.schematic.legacy!.encoding === "utf-8" ? "utf8" : "latin1"))
          const mine = sf.schematic.legacy!.records
          const skip = new Set(["header", "header>EELAYER", "header>EELAYER END", "header>LIBS", "header>blank", "blank", "$EndSCHEMATC", "$Comp>F>ignored", "Text>ignored"])
          const diffs: string[] = []
          for (const k of new Set([...Object.keys(raw), ...Object.keys(mine)])) {
            if (skip.has(k) || k.endsWith("$EndComp") || k.endsWith("$EndSheet") || k.endsWith("$EndBitmap") || k.endsWith("$EndDescr")) continue
            if ((raw[k] ?? 0) !== (mine[k] ?? 0)) diffs.push(`${k} ${mine[k] ?? 0} against ${raw[k] ?? 0}`)
          }
          row.recordsEqual = diffs.length === 0
          row.recordDiff = diffs.slice(0, 3).join("; ")
          const imp = importKicadSchematic({ files, root: name })
          const gate = gateSchematic({ files, root: name })
          // every extension the sheets need, built or not: the importer's rules over each file of the tree
          const plain = plainnessOf([...tree.files.values()], sf.schematic.uuid, tree.root)
          const needs = needsOfProject([...tree.files.values()].map((f) => needsOfFile(f.schematic, countPaths(f.schematic.tree), plain)))
          void gate
          row.import = imp.status === "imported" ? "imported" : `refused, ${imp.reason}`
          unknown += imp.report.entries.filter((e) => e.code === "unknown-node" || e.code === "unknown-value").length
          row.needs = needs.map((n) => n.ext)
          // an extension on top of the census's rules is explained when it is the importer's own finding (a no-connect flag off a pin, a label's own look, a page number) or a symbol no library has (S12)
          const union0 = new Set<string>()
          for (const [p, f] of tree.files) for (const x of legacyNeeds(Buffer.from(files.get(p)!).toString(f.schematic.legacy!.encoding === "utf-8" ? "utf8" : "latin1"))) union0.add(x)
          const missingSymbols = [...tree.files.values()].some((f) => f.schematic.legacy!.symbolSources.some((x) => x.from === "missing"))
          row.needsUnexplained = needs.filter((n) => !union0.has(n.ext) && !(n.source === "importer" || (n.ext === "S12" && missingSymbols))).map((n) => `${n.ext}: ${n.why}`)
          // the census's rules over every sheet of the project, as the importer's needs are
          const union = new Set<string>()
          for (const [p, f] of tree.files) for (const x of legacyNeeds(Buffer.from(files.get(p)!).toString(f.schematic.legacy!.encoding === "utf-8" ? "utf8" : "latin1"))) union.add(x)
          row.census = [...union].sort()
          const src = new Map<string, number>()
          for (const f of tree.files.values()) for (const s of f.schematic.legacy?.symbolSources ?? []) src.set(s.from, (src.get(s.from) ?? 0) + 1)
          row.sources = [...src].map(([k, v]) => `${k} ${v}`).join(", ")
          const raisedImp = importKicadSchematic({ files, root: name }, { built: MEASURE })
          row.raised = raisedImp.status === "imported" ? "imported" : `refused, ${raisedImp.reason}: ${raisedImp.message.slice(0, 80)}`
        } catch (e) {
          row.parse = e instanceof Error ? e.message.slice(0, 120) : String(e)
          if (!/EELAYER END/.test(row.parse)) crashes++
          namedErrors.push(`${file}: ${row.parse}`)
        }
      }
      // the needs the importer finds against the census, a file by file: the importer's extra needs are named
      for (const r of rows) {
        if (r.parse !== "ok") continue
        const extra = r.needs.filter((x) => !r.census.includes(x))
        const missing = r.census.filter((x) => !r.needs.includes(x))
        r.needsDiff = [...extra.map((x) => `+${x}`), ...missing.map((x) => `-${x}`)].join(" ")
      }

      // ---------- the nets of the flat sheets ----------
      let netsEqual = 0
      let netsDiffer = 0
      let netsCompared = 0
      for (const row of rows) {
        if (row.parse !== "ok") continue
        const path = join(CORPUS!, row.file)
        const dir = path.slice(0, path.lastIndexOf(sep))
        try {
          const files = dirFiles(dir)
          const name = path.slice(dir.length + 1)
          const gate = gateSchematic({ files, root: name }, { built: MEASURE })
          if ("refused" in gate) {
            row.nets = `not built: ${gate.refused.message.slice(0, 60)}`
            continue
          }
          const built = buildSchematicProject(gate.gate.tree, gate.gate.report, { built: MEASURE })
          const exts = built.lossy.map((n) => n.ext)
          if (exts.some((x) => x !== "S2")) {
            row.nets = `not compared: needs ${exts.join(" ")}`
            continue
          }
          const { pinNet, nets } = computeConnectivity(built.project)
          const symOf = new Map([...built.byRecord].map(([r, c]) => [c.id, r]))
          const derived = deriveLegacyNets(path)
          // The legacy derivation has no buses (KiCad 5's rules for them are not written): a file with buses is not compared, as before S3 was built it was not imported.
          if (derived.unsupported.size) {
            row.nets = `not compared: ${[...derived.unsupported].join(", ")}`
            continue
          }
          const universe: string[] = []
          const netOf = new Map<string, string | undefined>()
          const members = new Map<string, string[]>()
          for (const c of built.project.components) {
            const sym = symOf.get(c.id)
            if (!sym) continue
            const ts = keyOfSymbol(normPath(sym.path), c.ref)
            for (const pin of schematicPins(c)) {
              const k = `${ts}#${pin.pin}`
              const net = pinNet.get(pinKey(c.id, pin.pin))
              universe.push(k)
              netOf.set(k, net)
              if (net) (members.get(net) ?? members.set(net, []).get(net)!).push(k)
            }
          }
          const mine = (k: string) => (netOf.get(k) ? [...members.get(netOf.get(k)!)!].sort().join(" ") : k)
          const inUniverse = new Set(universe)
          const byGroup = new Map<number, string[]>()
          for (const [k, g] of derived.pins) for (const x of ([] as number[]).concat(g)) if (inUniverse.has(k)) (byGroup.get(x) ?? byGroup.set(x, []).get(x)!).push(k)
          const theirs = (k: string) => {
            const g = ([] as number[]).concat(derived.pins.get(k) ?? [])[0]
            return g === undefined ? k : [...new Set(byGroup.get(g)!)].sort().join(" ")
          }
          const bad = universe.filter((k) => mine(k) !== theirs(k))
          netsCompared++
          // a net with a name KiCad 5 gives it (a label or a power pin): the importer's name against the oracle's
          let nameBad = 0
          for (const net of nets) {
            const keys = members.get(net.id)
            // a net no label or power pin names, of two pins or more: KiCad 5 names it after the first of its pins by name, `Net-(R1-Pad2)`
            if (keys && keys.length >= 2 && !net.named) {
              const g0 = ([] as number[]).concat(derived.pins.get(keys[0]) ?? [])[0]
              const theirName = g0 === undefined ? null : derived.netName(g0)
              if (theirName !== null && theirName !== net.name) {
                nameBad++
                problems.push(`${row.file}: the net ${net.name} is ${theirName} in KiCad 5`)
              }
              continue
            }
            if (!keys?.length || !net.named) continue
            const g = ([] as number[]).concat(derived.pins.get(keys[0]) ?? [])[0]
            const d = g === undefined ? undefined : derived.driver.get(g)
            if (!d || d.name !== net.name) nameBad++
          }
          if (bad.length || nameBad) {
            row.nets = `differs ${bad.length} pins, ${nameBad} names`
            netsDiffer++
            const why = nets.flatMap((net) => {
              const keys = members.get(net.id)
              if (!keys?.length || !net.named) return []
              const g = ([] as number[]).concat(derived.pins.get(keys[0]) ?? [])[0]
              const d = g === undefined ? undefined : derived.driver.get(g)
              return !d || d.name !== net.name ? [`${net.name} against ${d?.name ?? "none"}`] : []
            })
            problems.push(`nets ${row.file}: ${bad.slice(0, 2).map((k) => { const a = mine(k).split(" "); const b = theirs(k).split(" "); return `${k}: only the importer has ${a.filter((x) => !b.includes(x)).slice(0, 4).join(",")}; only the derivation has ${b.filter((x) => !a.includes(x)).slice(0, 4).join(",")}` }).join(" | ")} ${why.slice(0, 3).join("; ")}`)
          } else {
            row.nets = "equal"
            netsEqual++
          }
        } catch (e) {
          row.nets = `error: ${e instanceof Error ? e.message : String(e)}`
          problems.push(`nets ${row.file}: ${row.nets}`)
        }
      }

      // ---------- every project: a board with its KiCad 5 schematic ----------
      interface Prow {
        project: string
        footprints: number
        linkOk: boolean
        linkPath: number
        linkReference: number
        linkNone: number
        boardNets: string
        detail: string
        plain: string
        raised: string
        differences: number
        error?: string
      }
      const projects: Prow[] = []
      for (const boardPath of all.filter((f) => f.endsWith(".kicad_pcb"))) {
        const base = boardPath.slice(0, -".kicad_pcb".length)
        if (!existsSync(`${base}.sch`) || existsSync(`${base}.kicad_sch`)) continue
        if (!isLegacySchematic(new Uint8Array(readFileSync(`${base}.sch`)))) continue
        if (ONLY.length && !ONLY.some((o) => boardPath.includes(o))) continue
        const name = rel(boardPath)
        const row: Prow = { project: name, footprints: 0, linkOk: false, linkPath: 0, linkReference: 0, linkNone: 0, boardNets: "", detail: "", plain: "", raised: "", differences: 0 }
        projects.push(row)
        try {
          const folder = boardPath.slice(0, boardPath.lastIndexOf(sep))
          const files = dirFiles(folder)
          const rootName = `${base.slice(folder.length + 1)}.sch`
          const tree = readSchematicTree(files, rootName)
          const board = readKicadBoard(readFileSync(boardPath)).board
          const result = linkFootprints(tree, board.footprints.map((f) => ({ ref: f.ref, path: f.path })))
          row.footprints = result.counts.footprints
          row.linkPath = result.counts.path + result.counts.timestamp
          row.linkReference = result.counts.reference
          row.linkNone = result.counts.none
          const l = linkOf.get(name)
          if (l) {
            // link.mjs reads a re-encoded timestamp (`00000000-0000-0000-0000-000054d213ea`, a KiCad 6 board over a KiCad 5 schematic) without dropping its leading zeros, so it never matches
            // by path and counts the footprint by reference: the importer links it by timestamp. Everything else is the census's number.
            const c = result.counts
            row.linkOk = l.footprints === c.footprints && c.none === l.none && c.path + c.timestamp + c.reference === l.path + l.reference && c.path + c.timestamp >= l.path
          }
          // the board's own nets against the nets of the schematic KiCad 5 derives
          const derived = deriveLegacyNets(`${base}.sch`)
          if (derived.unsupported.size) row.boardNets = `skipped: ${[...derived.unsupported].join(", ")}`
          else if (derived.missing.size) row.boardNets = `skipped: ${derived.missing.size} symbols in no library`
          else {
            const fps = boardPadNets(boardPath)
            const bn = new Map<string, Set<number>>()
            const gn = new Map<number, Set<string>>()
            let nameBad = 0
            const detail: string[] = []
            for (const fp of fps) {
              if (/\*/.test(fp.ref)) continue
              const nets = new Map<string, Set<string | null>>()
              for (const p of fp.pads) (nets.get(p.number) ?? nets.set(p.number, new Set()).get(p.number)!).add(p.net)
              for (const p of fp.pads) {
                if (!p.number || (nets.get(p.number)?.size ?? 0) > 1) continue
                const g = derived.pins.get(`${normPath(fp.path)}#${p.number}`)
                if (g === undefined) continue
                const gg = ([] as number[]).concat(g)[0]
                const driver = derived.driver.get(gg)
                const bname = p.net === null ? null : newOverbar(p.net.split("{slash}").join("/"))
                if (bname !== null && !/^(?:Net-\(|unconnected-\(|N-\d+$)/.test(bname) && !(driver && (bname === driver.name || bname.endsWith(`/${driver.bare}`)))) {
                  nameBad++
                  if (detail.length < 2) detail.push(`${fp.ref}.${p.number} board ${bname}, schematic ${driver?.name ?? "none"}`)
                }
                const unconnected = p.net === null || /^unconnected-\(/.test(p.net)
                for (const x of ([] as number[]).concat(g)) {
                  if (!unconnected) (bn.get(p.net!) ?? bn.set(p.net!, new Set()).get(p.net!)!).add(x)
                  ;(gn.get(x) ?? gn.set(x, new Set()).get(x)!).add(unconnected ? "<none>" : p.net!)
                }
              }
            }
            let stale = 0
            for (const v of bn.values()) if (v.size > 1) stale++
            for (const v of gn.values()) if (v.size > 1) stale++
            row.detail = detail.join("; ")
            row.boardNets = stale || nameBad ? `stale ${stale}${nameBad ? ` (${nameBad} pads named differently)` : ""}` : "agree"
          }
          // the project's own board only: a folder may hold more than one
          const projectFiles: ProjectFile[] = [...files].filter(([path]) => !path.endsWith(".kicad_pcb") || path === boardPath.slice(folder.length + 1)).map(([path, data]) => ({ path, data }))
          const plain = importKicadProject(projectFiles)
          const raised = importKicadProject(projectFiles, { built: new Set([...Object.keys(BOARD_EXTENSION_NAMES), "S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8", "S9", "S10"]), allowLossyBoard: true })
          const word = (r: typeof plain) => (r.status === "imported" ? "imported" : `refused, ${r.reason}${r.needs.length ? ` (${r.needs.map((n) => n.ext).join(" ")})` : ""}`)
          row.plain = word(plain)
          row.raised = word(raised)
          if (raised.status === "imported") {
            row.differences = raised.differences.filter((d) => !/the symbol has no pin/.test(d.why)).length
            row.raised += `, ${row.differences} difference${row.differences === 1 ? "" : "s"}`
            if (row.differences) row.detail = raised.differences.slice(0, 2).map((d) => d.why).join(" | ")
          }
        } catch (e) {
          row.error = e instanceof Error ? e.message : String(e)
          // a schematic that is a header and nothing else is a named error, and the project is not a project this can read
          if (/EELAYER END/.test(row.error)) projects.splice(projects.indexOf(row), 1)
          else crashes++
        }
      }

      // ---------- the legacy project files ----------
      const proProblems: string[] = []
      let pros = 0
      for (const path of all.filter((f) => f.endsWith(".pro"))) {
        const text = readFileSync(path)
        if (text.subarray(0, 1).toString() === "{") continue
        pros++
        try {
          const { legacy } = readLegacyPro(new Uint8Array(text))
          const a = accountLegacyPro(legacy)
          if (a.unknownPaths.size) proProblems.push(`${rel(path)}: unknown ${[...a.unknownPaths.keys()].slice(0, 3).join(", ")}`)
          const sum = [...a.notNeeded.values(), ...a.pending.values()].reduce((x, y) => x + y, 0) + a.imported + [...a.unknownPaths.values()].reduce((x, y) => x + y, 0)
          if (sum !== a.total) proProblems.push(`${rel(path)}: accounting does not add up`)
        } catch (e) {
          proProblems.push(`${rel(path)}: ${e instanceof Error ? e.message : String(e)}`)
        }
      }

      // ---------- every legacy library: every symbol against the raw file ----------
      let libs = 0
      let symbols = 0
      let worstMm = 0
      const libProblems: string[] = []
      const libErrors: string[] = []
      for (const path of all.filter((f) => /\.lib$/i.test(f))) {
        const buf = readFileSync(path)
        let text: string
        try {
          text = new TextDecoder("utf-8", { fatal: true }).decode(buf)
        } catch {
          text = buf.toString("latin1")
        }
        if (!/^EESchema-LIB/i.test(text)) continue
        let lib
        try {
          lib = readLegacyLibraryText(text)
        } catch (e) {
          libErrors.push(`${rel(path)}: ${e instanceof Error ? e.message : String(e)}`)
          continue
        }
        libs++
        const raws = rawLegacySymbols(text)
        for (const part of lib.parts) {
          symbols++
          const raw = raws.get(part.name) ?? raws.get(part.aliases[0])
          if (!raw) {
            libProblems.push(`${rel(path)} ${part.name}: no raw symbol`)
            continue
          }
          try {
            const doc = readKicadSchematic(`(kicad_sch (version 20230221) (lib_symbols ${legacyPartToSymbolText(part, part.name)}))`)
            const d = drawingFromLib({ ...doc.schematic.libSymbols[0], source: doc.schematic.libSymbols[0] }).drawing
            const bad = compareDrawing(d, raw)
            worstMm = Math.max(worstMm, bad.worst)
            if (bad.problems.length) libProblems.push(`${rel(path)} ${part.name}: ${bad.problems.slice(0, 2).join("; ")}`)
          } catch (e) {
            libProblems.push(`${rel(path)} ${part.name}: ${e instanceof Error ? e.message : String(e)}`)
          }
        }
      }

      // ---------- the table ----------
      mkdirSync(OUT, { recursive: true })
      const lines: string[] = [`# Legacy schematic corpus, ${rows.length} files, ${projects.length} projects, ${Date.now() - t0} ms\n`, "| file | group | version | read | records | needs (importer) | needs (census) | difference | sources | now | raised | nets |", "|---|---|---|---|---|---|---|---|---|---|---|---|"]
      for (const r of rows) lines.push(`| ${r.file} | ${r.group} | ${r.version} | ${r.parse} | ${r.recordsEqual ? "ok" : `NO ${r.recordDiff}`} | ${r.needs.join(" ")} | ${r.census.join(" ")} | ${r.needsDiff} | ${r.sources} | ${r.import} | ${r.raised} | ${r.nets} |`)
      lines.push("", "| project | footprints | by path | by reference | none | links as link.mjs | nets of board and schematic | import (plain / raised) |", "|---|---|---|---|---|---|---|---|")
      for (const p of projects) lines.push(`| ${p.project} | ${p.footprints} | ${p.linkPath} | ${p.linkReference} | ${p.linkNone} | ${p.error ? `ERROR ${p.error}` : p.linkOk ? "yes" : "NO"} | ${p.boardNets}${p.detail ? ` (${p.detail})` : ""} | ${p.plain} / ${p.raised} |`)
      writeFileSync(join(OUT, "legacy-corpus.md"), lines.join("\n"))

      const ok = rows.filter((r) => r.parse === "ok")
      const real = ok.filter((r) => REAL.includes(r.group))
      const sum = {
        files: rows.length,
        read: ok.length,
        namedErrors,
        crashes,
        unknown,
        recordsEqual: ok.filter((r) => r.recordsEqual).length,
        needsEqual: ok.filter((r) => !r.needsDiff).length,
        needsDiffering: ok.filter((r) => r.needsDiff).map((r) => `${r.file}: ${r.needsDiff}`),
        needsMissing: ok.filter((r) => r.needsDiff.includes("-")).map((r) => `${r.file}: ${r.needsDiff}`),
        needsUnexplained: ok.filter((r) => r.needsUnexplained.length).map((r) => `${r.file}: ${r.needsUnexplained.join("; ")}`),
        imported: ok.filter((r) => r.import === "imported").length,
        importedReal: real.filter((r) => r.import === "imported").length,
        realFiles: real.length,
        netsEqual,
        netsDiffer,
        netsCompared,
        projects: projects.length,
        linksAsCensus: projects.filter((p) => p.linkOk).length,
        boardAgree: projects.filter((p) => p.boardNets === "agree").length,
        boardStale: projects.filter((p) => p.boardNets.startsWith("stale")).map((p) => `${p.project}: ${p.boardNets} ${p.detail}`),
        boardSkipped: projects.filter((p) => p.boardNets.startsWith("skipped")).length,
        projectsImportedRaised: projects.filter((p) => p.raised.startsWith("imported")).length,
        projectsDifferences: projects.filter((p) => p.differences > 0).map((p) => `${p.project}: ${p.detail}`),
        pros,
        libs,
        symbols,
        worstMm: Number(worstMm.toFixed(6)),
        libErrors,
      }
      writeFileSync(join(OUT, "legacy-corpus-summary.json"), JSON.stringify(sum, null, 1))
      writeFileSync(join(OUT, "legacy-corpus-problems.txt"), [...problems, ...libProblems, ...proProblems].join("\n"))
      console.log(JSON.stringify(sum))

      expect(sum.crashes).toBe(0)
      // what the census's rules ask for, the importer asks for too; what it asks for on top is explained
      expect(sum.needsMissing).toEqual([])
      expect(sum.needsUnexplained).toEqual([])
      expect(sum.unknown).toBe(0)
      expect(proProblems).toEqual([])
      expect(libProblems.slice(0, 5)).toEqual([])
      expect(worstMm).toBeLessThanOrEqual(0.001)
      expect(problems.slice(0, 5)).toEqual([])
      expect(sum.recordsEqual).toBe(sum.read)
      expect(sum.linksAsCensus).toBe(sum.projects)
      // the project import's own comparison agrees with the independent one wherever both ran
      expect(projects.filter((p) => p.raised.startsWith("imported") && !p.boardNets.startsWith("skipped") && (p.boardNets === "agree") !== (p.differences === 0)).map((p) => p.project)).toEqual([])
    },
    900_000,
  )
})

type Drawing = ReturnType<typeof drawingFromLib>["drawing"]

/** A drawing the importer keeps against the raw `.lib`, number by number: the differences, and the largest, in millimetres. */
function compareDrawing(d: Drawing, raw: RawLegacySymbol): { problems: string[]; worst: number } {
  const problems: string[] = []
  let worst = 0
  const check = (what: string, units: number, mm: number) => {
    const e = near(units, mm)
    worst = Math.max(worst, e)
    if (e > 0.001) problems.push(`${what}: ${units * MM} against ${mm}`)
  }
  // KiCad 6 groups a symbol's items by unit and body style (0 for all of them first); inside a group the file's order stays.
  const grouped = <T extends { unit: number; convert: number }>(list: T[]) => list.map((x, i) => ({ x, i })).sort((a, b) => a.x.unit - b.x.unit || a.x.convert - b.x.convert || a.i - b.i).map((e) => e.x)
  const shapes = grouped(raw.shapes)
  const rawPins = grouped(raw.pins)
  if (d.items.length !== shapes.length) problems.push(`${d.items.length} items against ${shapes.length}`)
  d.items.forEach((item, i) => {
    const r = shapes[i]
    if (!r) return
    const kind = r.kind === "rect" ? "rectangle" : r.kind === "poly" ? "polyline" : r.kind
    if (item.kind !== kind) return void problems.push(`item ${i}: ${item.kind} against ${r.kind}`)
    if ((item.unit ?? 0) !== r.unit || (item.body ?? 0) !== r.convert) problems.push(`item ${i}: unit and style`)
    if (item.kind !== "text" && r.kind !== "text" && (item.fill ?? "none") !== r.fill) problems.push(`item ${i}: fill ${item.fill ?? "none"} against ${r.fill}`)
    if (item.kind !== "text" && r.kind !== "text") check(`item ${i} width`, item.width ?? 0, r.width)
    if (item.kind === "polyline" || item.kind === "bezier") {
      const pts = (r as { pts: number[][] }).pts
      if (item.points.length !== pts.length) problems.push(`item ${i}: ${item.points.length} points against ${pts.length}`)
      item.points.forEach((p, k) => {
        check(`item ${i} point ${k} x`, p.x, pts[k][0])
        check(`item ${i} point ${k} y`, p.y, pts[k][1])
      })
    } else if (item.kind === "rectangle") {
      const q = r as { a: number[]; b: number[] }
      check(`item ${i} a.x`, item.a.x, q.a[0])
      check(`item ${i} a.y`, item.a.y, q.a[1])
      check(`item ${i} b.x`, item.b.x, q.b[0])
      check(`item ${i} b.y`, item.b.y, q.b[1])
    } else if (item.kind === "circle") {
      const q = r as { c: number[]; r: number }
      check(`item ${i} c.x`, item.c.x, q.c[0])
      check(`item ${i} c.y`, item.c.y, q.c[1])
      check(`item ${i} r`, item.r, q.r)
    } else if (item.kind === "arc") {
      const q = r as { c: number[]; r: number; ends: number[] | null }
      // the arc passes through the two ends the file gives, in either order, and the circle through them has the file's centre and radius to the precision of the ends
      if (q.ends) {
        const ends = [[q.ends[0], q.ends[1]], [q.ends[2], q.ends[3]]]
        const mine = [[item.start.x * MM, item.start.y * MM], [item.end.x * MM, item.end.y * MM]]
        const direct = Math.max(Math.hypot(mine[0][0] - ends[0][0], mine[0][1] - ends[0][1]), Math.hypot(mine[1][0] - ends[1][0], mine[1][1] - ends[1][1]))
        const swapped = Math.max(Math.hypot(mine[0][0] - ends[1][0], mine[0][1] - ends[1][1]), Math.hypot(mine[1][0] - ends[0][0], mine[1][1] - ends[0][1]))
        const e = Math.min(direct, swapped)
        worst = Math.max(worst, e)
        if (e > 0.001) problems.push(`item ${i}: arc ends ${e} mm off`)
      }
    } else if (item.kind === "text") {
      const q = r as { at: number[] }
      check(`item ${i} x`, item.at.x, q.at[0])
      check(`item ${i} y`, item.at.y, q.at[1])
    }
  })
  if (d.pins.length !== rawPins.length) problems.push(`${d.pins.length} pins against ${rawPins.length}`)
  const TYPES: Record<string, string> = { I: "input", O: "output", B: "bidirectional", T: "tri_state", P: "passive", U: "unspecified", W: "power_in", w: "power_out", C: "open_collector", E: "open_emitter", N: "no_connect" }
  const ANGLE: Record<string, number> = { R: 0, U: 90, L: 180, D: 270 }
  d.pins.forEach((p, i) => {
    const r = rawPins[i]
    if (!r) return
    if (p.type !== TYPES[r.type] || p.number !== r.number || (p.unit ?? 0) !== r.unit || (p.body ?? 0) !== r.convert || !!p.hidden !== r.attrs.includes("N") || p.angle !== ANGLE[r.orient]) problems.push(`pin ${i}: ${p.number} fields`)
    check(`pin ${i} x`, p.x, r.at[0])
    check(`pin ${i} y`, p.y, r.at[1])
    check(`pin ${i} length`, p.length, r.length)
  })
  return { problems, worst }
}
