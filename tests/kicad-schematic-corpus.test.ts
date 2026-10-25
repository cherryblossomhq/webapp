import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, relative, sep } from "node:path"
import { describe, expect, it } from "vitest"
import { computeConnectivity, pinKey } from "../src/model/connectivity"
import { EXTENSION_NAMES as BOARD_EXTENSION_NAMES, readKicadBoard } from "../src/model/kicad/board"
import { accountNodes, countPaths } from "../src/model/kicad/schematic/account"
import { buildSchematicProject } from "../src/model/kicad/schematic/build"
import { plainnessOf, settleFor } from "../src/model/kicad/schematic/carried"
import { schematicPins } from "../src/model/instances"
import { gateSchematic, importKicadSchematic } from "../src/model/kicad/schematic/import"
import { linkFootprints } from "../src/model/kicad/schematic/link"
import { needsOfFile } from "../src/model/kicad/schematic/needs"
import { readKicadSchematic } from "../src/model/kicad/schematic/read"
import { readSchematicTree } from "../src/model/kicad/schematic/tree"
import { accountPro, readKicadPro } from "../src/model/kicad/project/pro"
import { accountRules, readKicadRules } from "../src/model/kicad/project/dru"
import { importKicadProject, type ProjectFile } from "../src/model/kicad/project"
import { boardPadNets, deriveNets } from "./kicad-census/netlist-sch.mjs"
import { needsSch } from "./kicad-census/needs-sch.mjs"

// The per-file pass or fail table of slice 3a over a local corpus (not in the repo):
//
//   KICAD_CORPUS=<corpus dir> KICAD_CENSUS=<corpus dir>/census \
//     KICAD_CORPUS_OUT=<dir> npx vitest run tests/kicad-schematic-corpus.test.ts
//
// It reads every `.kicad_sch`, `.kicad_pro` and `.kicad_dru` under the corpus, and every project
// (a board with its schematic beside it), and compares them with the census (`tests/kicad-census`,
// which shares no code with the importer): node counts, unknown nodes and words, the extensions
// each file needs, the footprint links, the nets of the flat schematics the build can hold (the
// editor's own `computeConnectivity` against `netlist-sch.mjs`, pin by pin), and the nets of every
// project against the nets the board itself carries. With no corpus the test is skipped.

const CORPUS = process.env.KICAD_CORPUS
const CENSUS = process.env.KICAD_CENSUS ?? (CORPUS ? join(CORPUS, "census") : "")
const OUT = process.env.KICAD_CORPUS_OUT ?? join(tmpdir(), "kicad-schematic-corpus")
const ONLY = process.env.KICAD_ONLY?.split(",").filter(Boolean) ?? []

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
/** The census's grouping: projects found by searching for a feature are kept apart. */
const groupOf = (r: string) => (r.startsWith("pcbench/") ? "pcbench" : r.startsWith("kicad-source/demos") ? "kicad-demos" : r.startsWith("kicad-source") ? "kicad-qa" : targeted.has(r.split("/")[1]) ? "github-targeted" : "github")
const REAL = ["pcbench", "github", "kicad-demos"]

/** The extensions the nets check raises: all but the three that change what is connected to what. */
/** Projects whose sheets carry the references of another KiCad project too: link.mjs takes those for a match by reference, the importer does not. */
const FOREIGN_REFERENCES = ["ESP32_S3_PCB_TEMPLATE", "USB Module/USB Switch"]

const MEASURE = new Set(["S2", "S4", "S5", "S6", "S7", "S8", "S9", "S10", "X19"])

interface FileRow {
  file: string
  group: string
  stamp: number | null
  era: string
  bytes: number
  parse: boolean
  nodes: boolean
  unknown: number
  needs: string[]
  census: string[]
  needsDiff: string
  needsWhy: string[]
  /** `equal`, `differs`, or `-` when the file is outside what the build holds (it needs S1, S2 or S3). */
  nets: string
  /** What `importKicadSchematic` does with the file as slice 3a is: it imports it, or refuses it for a reason. */
  import: string
  lossy: string[]
  ms: number
  error?: string
}

interface ProjectRow {
  project: string
  group: string
  stamp: number | null
  sheets: number
  footprints: number
  linkOk: boolean
  linkPath: number
  linkReference: number
  linkNone: number
  /** `agree`, `stale N` (pads whose board net is not the pin's in the schematic), or `skipped: why`. */
  boardNets: string
  detail: string
  pads: number
  imported: boolean
  /** The raised build is not exact by its own account (it names extensions built that it cannot hold), so its differences are not counted against the board. */
  lossyMeasured?: boolean
  padsWithoutPin?: number
  differences: number
  /** The project import alone, plain and raised: read, account, link, build, compare. */
  importMs: number
  status: string
  ms: number
  error?: string
}

function samePaths(a: Map<string, number>, b: Record<string, number>) {
  const keys = new Set([...a.keys(), ...Object.keys(b)])
  for (const k of keys) if ((a.get(k) ?? 0) !== (b[k] ?? 0)) return false
  return true
}

describe.skipIf(!CORPUS)("the KiCad schematic corpus", () => {
  it(
    "reads, accounts for, links and checks every schematic and project, and agrees with the census",
    () => {
      const sidecars = JSON.parse(readFileSync(join(CENSUS, "sidecars.json"), "utf8")) as Record<string, any>[]
      const censusSch = new Map(sidecars.filter((r) => r.kind === "kicad_sch").map((r) => [r.file as string, r]))
      const links = JSON.parse(readFileSync(join(CENSUS, "links.json"), "utf8")) as Record<string, any>[]
      const linkOf = new Map(links.filter((l) => l.kind === "kicad_sch").map((l) => [l.file as string, l]))
      const files = walk(CORPUS!).sort()
      const rows: FileRow[] = []
      const t0 = Date.now()

      // ---------- every .kicad_sch ----------
      for (const path of files.filter((f) => f.endsWith(".kicad_sch") && (!ONLY.length || ONLY.some((o) => f.includes(o))))) {
        const file = rel(path)
        const c = censusSch.get(file)
        const row: FileRow = { file, group: groupOf(file), stamp: null, era: "", bytes: statSync(path).size, parse: false, nodes: false, unknown: 0, needs: [], census: [], needsDiff: "", needsWhy: [], nets: "-", import: "", lossy: [], ms: 0 }
        rows.push(row)
        const t1 = Date.now()
        try {
          const bytes = readFileSync(path)
          const { schematic, text } = readKicadSchematic(bytes)
          row.parse = true
          row.stamp = schematic.version
          row.era = schematic.era
          const paths = countPaths(schematic.tree)
          row.nodes = c ? samePaths(paths, c.nodes) : false
          const sf = { path: file, schematic, text }
          const plain = plainnessOf([sf], schematic.uuid, file)
          const needs = needsOfFile(schematic, paths, plain)
          row.needs = needs.map((n) => n.ext)
          row.census = c ? [...needsSch(c.d)].sort() : []
          const extra = row.needs.filter((x) => !row.census.includes(x))
          const missing = row.census.filter((x) => !row.needs.includes(x))
          row.needsWhy = needs.filter((n) => extra.includes(n.ext)).map((n) => `${n.ext}: ${n.why}`)
          row.needsDiff = extra.length || missing.length ? [...extra.map((x) => `+${x}`), ...missing.map((x) => `-${x}`)].join(" ") : ""
          const imp = importKicadSchematic(new Uint8Array(bytes))
          row.import = imp.status === "imported" ? "imported" : `refused, ${imp.reason}`
          const account = accountNodes(schematic.tree, text, new Set(row.needs), paths, settleFor(plain))
          row.unknown = account.unknownPaths.size + account.unknownAtoms.size
          // the totals add up: every node is in exactly one state
          const states = account.imported + [...account.notNeeded.values()].reduce((a, b) => a + b, 0) + [...account.pending.values()].reduce((a, b) => a + b, 0) + account.reported + [...account.unknownPaths.values()].reduce((a, b) => a + b, 0)
          if (states !== account.total) throw new Error(`the accounting does not add up: ${states} of ${account.total}`)
        } catch (e) {
          row.error = e instanceof Error ? e.message : String(e)
        }
        row.ms = Date.now() - t1
      }

      // ---------- the nets of the flat schematics ----------
      // Every pin the editor has a port for, in the groups of the editor's own connectivity and of the derivation from the raw file:
      // single pins included, and the names of the nets where the build is exact. A build that needs an extension is not counted as equal:
      // one that needs only S2 (KiCad's own net names) has its partition compared and says so.
      for (const row of rows) {
        if (row.error || !row.parse) continue
        const path = join(CORPUS!, row.file)
        try {
          const bytes = new Uint8Array(readFileSync(path))
          const { schematic } = readKicadSchematic(bytes)
          if (schematic.sheets.length || schematic.buses.length || schematic.busEntries.length || schematic.labels.some((l) => l.kind === "global" || l.kind === "hierarchical")) continue
          const gate = gateSchematic(bytes, { built: MEASURE })
          if ("refused" in gate) {
            row.nets = `not built: ${gate.refused.message.slice(0, 80)}`
            continue
          }
          const built = buildSchematicProject(gate.gate.tree, gate.gate.report, { built: MEASURE })
          row.lossy = built.lossy.map((n) => n.ext)
          const exts = new Set(row.lossy)
          const { pinNet, nets } = computeConnectivity(built.project)
          const symOf = new Map([...built.bySymbol].map(([s, c]) => [c.id, s]))
          const universe: string[] = []
          const netOf = new Map<string, string | undefined>()
          const members = new Map<string, string[]>()
          for (const c of built.project.components) {
            const sym = symOf.get(c.id)
            if (!sym) continue
            for (const pin of schematicPins(c)) {
              const key = `/${sym.uuid}#${pin.pin}`
              const net = pinNet.get(pinKey(c.id, pin.pin))
              universe.push(key)
              netOf.set(key, net)
              if (net) (members.get(net) ?? members.set(net, []).get(net)!).push(key)
            }
          }
          // a pin's group: the sorted pins of its net, or itself alone
          const mine = (k: string) => (netOf.get(k) ? [...members.get(netOf.get(k)!)!].sort().join(" ") : k)
          const derived = deriveNets(path, { hiddenPower: true, localJoinsGlobal: "same" })
          const inUniverse = new Set(universe)
          const byGroup = new Map<number, string[]>()
          for (const [key, g] of derived.pins) for (const x of ([] as number[]).concat(g)) if (inUniverse.has(key)) (byGroup.get(x) ?? byGroup.set(x, []).get(x)!).push(key)
          const theirs = (k: string) => {
            const g = ([] as number[]).concat(derived.pins.get(k) ?? [])[0]
            return g === undefined ? k : [...new Set(byGroup.get(g)!)].sort().join(" ")
          }
          const partitionEqual = universe.every((k) => mine(k) === theirs(k))
          // names: the editor's net name against the driver KiCad picks, wherever either has one
          let namesEqual = true
          for (const net of nets) {
            const keys = members.get(net.id)
            if (!keys?.length) continue
            const g = ([] as number[]).concat(derived.pins.get(keys[0]) ?? [])[0]
            const d = g === undefined ? undefined : derived.driver.get(g)
            if (net.named ? d?.name !== net.name : !!d) namesEqual = false
          }
          const other = [...exts].filter((x) => x !== "S2")
          if (other.length) row.nets = `not compared: needs ${[...exts].sort().join(" ")}${partitionEqual ? " (partition equal)" : " (partition differs)"}`
          else if (!partitionEqual) row.nets = "differs"
          else if (exts.has("S2")) row.nets = "partition equal, names need S2"
          else row.nets = namesEqual ? "equal" : "differs in names"
        } catch (e) {
          row.nets = `error: ${e instanceof Error ? e.message : String(e)}`
        }
      }

      // ---------- every project: a board with its schematic beside it ----------
      const projects: ProjectRow[] = []
      const boards = files.filter((f) => f.endsWith(".kicad_pcb") && existsSync(`${f.slice(0, -".kicad_pcb".length)}.kicad_sch`) && (!ONLY.length || ONLY.some((o) => f.includes(o))))
      let largest = { name: "", bytes: 0, ms: 0 }
      for (const boardPath of boards) {
        const name = rel(boardPath)
        const base = boardPath.slice(0, -".kicad_pcb".length)
        const row: ProjectRow = { project: name, group: groupOf(name), stamp: null, sheets: 0, footprints: 0, linkOk: false, linkPath: 0, linkReference: 0, linkNone: 0, boardNets: "", detail: "", pads: 0, imported: false, differences: 0, importMs: 0, status: "", ms: 0 }
        projects.push(row)
        const t1 = Date.now()
        try {
          const dirOf = (p: string) => p.slice(0, p.lastIndexOf(sep))
          const folder = dirOf(base)
          // every .kicad_sch in the folder tree under the root's folder, by path relative to the corpus folder of the project
          const sheetFiles = new Map<string, Uint8Array>()
          for (const f of walk(folder)) if (f.endsWith(".kicad_sch")) sheetFiles.set(relative(folder, f).split(sep).join("/"), new Uint8Array(readFileSync(f)))
          const rootName = `${base.slice(folder.length + 1)}.kicad_sch`
          const tree = readSchematicTree(sheetFiles, rootName)
          row.sheets = tree.files.size
          row.stamp = tree.files.get(tree.root)!.schematic.version
          const board = readKicadBoard(readFileSync(boardPath)).board
          const result = linkFootprints(tree, board.footprints.map((f) => ({ ref: f.ref, path: f.path })))
          row.footprints = result.counts.footprints
          row.linkPath = result.counts.path + result.counts.timestamp
          row.linkReference = result.counts.reference
          row.linkNone = result.counts.none
          const l = linkOf.get(name)
          if (l) {
            // link.mjs counts a path with the root sheet's uuid kept and a symbol uuid alone as paths. It does not link by timestamp (it only counts a re-encoded timestamp apart), so what it
            // counts as a reference or as such a timestamp is what the importer links by timestamp or by reference. And it takes a reference from every project that shares a sheet,
            // where the importer takes this project's own: `FOREIGN_REFERENCES` are the projects where that makes the difference.
            const mine = result.counts
            const theirs = { path: l.path + l.pathRootKept + l.uuidOnly, rest: l.reference + l.timestampUuid, none: l.none }
            const sameFootprints = l.footprints === mine.footprints && theirs.path === mine.path
            const foreign = FOREIGN_REFERENCES.some((f) => name.includes(f))
            row.linkOk = sameFootprints && (foreign ? mine.timestamp + mine.reference + mine.none === theirs.rest + theirs.none && mine.reference <= theirs.rest : mine.timestamp + mine.reference === theirs.rest && mine.none === theirs.none)
          }
          // the board's own nets against the nets of the schematic, derived from the raw files
          const derived = deriveNets(`${base}.kicad_sch`, { hiddenPower: true, localJoinsGlobal: "same" })
          if (derived.unsupported.size) row.boardNets = `skipped: ${[...derived.unsupported].join(", ")}`
          else {
            const fps = boardPadNets(boardPath)
            const bn = new Map<string, Set<number>>()
            const gn = new Map<number, Set<string>>()
            let pads = 0
            let nameBad = 0
            const nameDetail: string[] = []
            const padsOf = new Map<number, string[]>()
            const add = <K, V>(m: Map<K, Set<V>>, k: K, v: V) => (m.get(k) ?? m.set(k, new Set()).get(k)!).add(v)
            for (const lk of result.links) {
              if (!lk.record) continue
              const fp = fps[lk.footprint]
              const seen = new Set(fp.pads.map((p) => p.number).filter(Boolean))
              void seen
              // pads that share a number but not a net are the board's own affair (X7)
              const nets = new Map<string, Set<string | null>>()
              for (const p of fp.pads) (nets.get(p.number) ?? nets.set(p.number, new Set()).get(p.number)!).add(p.net)
              for (const p of fp.pads) {
                if (!p.number || (nets.get(p.number)?.size ?? 0) > 1) continue
                const g = derived.pins.get(`${lk.record.path}#${p.number}`)
                if (g === undefined) continue
                pads++
                // a net the user named has the name on the board (`/NAME` on a sheet below the root, `NAME` for a power symbol)
                const driver = derived.driver.get(([] as number[]).concat(g)[0])
                const boardName = p.net === null ? null : p.net.split("{slash}").join("/")
                if (boardName !== null && !/^(?:Net-\(|unconnected-\()/.test(boardName) && !(driver && (boardName === driver.name || boardName.endsWith(`/${driver.name}`)))) {
                  nameBad++
                  if (nameDetail.length < 3) nameDetail.push(`${fp.ref}.${p.number} board ${boardName}, schematic ${driver ? driver.name : "none"}`)
                }
                const unconnected = p.net === null || /^unconnected-\(/.test(p.net)
                for (const x of ([] as number[]).concat(g)) {
                  if (!unconnected) add(bn, p.net!, x)
                  add(gn, x, unconnected ? "<none>" : p.net!)
                  ;(padsOf.get(x) ?? padsOf.set(x, []).get(x)!).push(`${fp.ref}.${p.number}`)
                }
              }
            }
            let bad = 0
            const detail: string[] = []
            for (const [net, v] of bn) {
              if (v.size > 1) {
                bad++
                detail.push(`${net} is on ${v.size} nets of the schematic (${[...v].flatMap((g) => (padsOf.get(g) ?? []).slice(0, 1)).join(", ")})`)
              }
            }
            for (const [g, v] of gn) {
              if (v.size > 1) {
                bad++
                detail.push(`${(padsOf.get(g) ?? []).slice(0, 2).join(", ")} on ${[...v].join(" and ")} on the board, one net in the schematic`)
              }
            }
            row.detail = [...detail.slice(0, 2), ...nameDetail].join("; ")
            row.pads = pads
            row.boardNets = bad || nameBad ? `stale ${bad}${nameBad ? ` (${nameBad} pads named differently)` : ""}` : "agree"
          }
          // the project import never crashes: refused for what the editor lacks, or imported with the extensions raised
          const projectFiles: ProjectFile[] = [...sheetFiles].map(([path, data]) => ({ path, data }))
          projectFiles.push({ path: `${base.slice(folder.length + 1)}.kicad_pcb`, data: new Uint8Array(readFileSync(boardPath)) })
          for (const ext of [".kicad_pro", ".kicad_dru"]) if (existsSync(base + ext)) projectFiles.push({ path: `${base.slice(folder.length + 1)}${ext}`, data: new Uint8Array(readFileSync(base + ext)) })
          const tImport = Date.now()
          const plainRun = importKicadProject(projectFiles)
          const raised = importKicadProject(projectFiles, { built: new Set([...Object.keys(BOARD_EXTENSION_NAMES), "S2", "S4", "S5", "S6", "S7", "S8", "S9", "S10"]), allowLossyBoard: true })
          row.importMs = Date.now() - tImport
          const word = (r: typeof plainRun) => (r.status === "imported" ? "imported" : `refused, ${r.reason}${r.needs.length ? ` (${r.needs.map((n) => n.ext).join(" ")})` : r.reason === "inexact" ? ` (${r.message.replace(/^This (board|schematic) cannot be imported exactly: /, "").split(";")[0].slice(0, 60)})` : ""}`)
          row.status = `${word(plainRun)} / ${word(raised)}`
          if (raised.status === "imported") {
            // the project's own comparison must agree with the independent one
            // a pad the symbol has no pin for is a real difference the independent comparison (which walks the symbols' pins) cannot see, so it is counted on its own
            const mine = raised.differences.filter((d) => !/the symbol has no pin/.test(d.why)).length
            row.padsWithoutPin = raised.differences.length - mine
            row.imported = true
            row.differences = mine
            row.lossyMeasured = raised.report.entries.some((e) => e.code === "lossy-measured")
            row.status += `, ${mine} difference${mine === 1 ? "" : "s"}`
          }
          if (tree.files.size) {
            const bytes = [...tree.files.values()].reduce((a, f) => a + f.text.length, 0)
            row.ms = Date.now() - t1
            if (bytes > largest.bytes) largest = { name, bytes, ms: row.importMs }
          }
        } catch (e) {
          row.error = e instanceof Error ? e.message : String(e)
        }
        row.ms = Date.now() - t1
      }

      // ---------- project files and rules ----------
      let pros = 0
      let drus = 0
      const proProblems: string[] = []
      for (const path of files) {
        if (ONLY.length) break
        if (path.endsWith(".kicad_pro")) {
          pros++
          try {
            const { pro } = readKicadPro(new Uint8Array(readFileSync(path)))
            const a = accountPro(pro.json)
            if (a.unknownPaths.size) proProblems.push(`${rel(path)}: unknown ${[...a.unknownPaths.keys()].slice(0, 3).join(", ")}`)
            const total = [...a.notNeeded.values(), ...a.pending.values()].reduce((x, y) => x + y, 0) + a.imported + [...a.unknownPaths.values()].reduce((x, y) => x + y, 0)
            if (total !== a.total) proProblems.push(`${rel(path)}: accounting does not add up`)
          } catch (e) {
            proProblems.push(`${rel(path)}: ${e instanceof Error ? e.message : String(e)}`)
          }
        } else if (path.endsWith(".kicad_dru")) {
          drus++
          try {
            const { rules } = readKicadRules(new Uint8Array(readFileSync(path)))
            const a = accountRules(rules.tree)
            if (a.unknownPaths.size) proProblems.push(`${rel(path)}: unknown ${[...a.unknownPaths.keys()].slice(0, 3).join(", ")}`)
          } catch (e) {
            proProblems.push(`${rel(path)}: ${e instanceof Error ? e.message : String(e)}`)
          }
        }
      }

      // ---------- the table ----------
      mkdirSync(OUT, { recursive: true })
      const real = rows.filter((r) => REAL.includes(r.group))
      const lines: string[] = []
      lines.push(`# Schematic corpus, ${rows.length} files, ${projects.length} projects, ${Date.now() - t0} ms\n`)
      lines.push("| file | group | stamp | read | nodes | unknown | needs (importer) | needs (census) | difference | why | nets | 3a | ms |", "|---|---|---|---|---|---|---|---|---|---|---|---|---|")
      for (const r of rows) lines.push(`| ${r.file} | ${r.group} | ${r.stamp ?? ""} | ${r.error ? `ERROR ${r.error}` : r.parse ? "ok" : "no"} | ${r.nodes ? "ok" : "NO"} | ${r.unknown} | ${r.needs.join(" ")} | ${r.census.join(" ")} | ${r.needsDiff} | ${r.needsWhy.join("; ")} | ${r.nets}${r.lossy.length ? ` (${r.lossy.join("; ")})` : ""} | ${r.import} | ${r.ms} |`)
      lines.push("", "| project | group | stamp | sheets | footprints | by path | by reference | none | links as link.mjs | nets of board and schematic | pads | import (plain / raised) | ms |", "|---|---|---|---|---|---|---|---|---|---|---|---|---|")
      for (const p of projects) lines.push(`| ${p.project} | ${p.group} | ${p.stamp ?? ""} | ${p.sheets} | ${p.footprints} | ${p.linkPath} | ${p.linkReference} | ${p.linkNone} | ${p.error ? `ERROR ${p.error}` : p.linkOk ? "yes" : "NO"} | ${p.boardNets}${p.detail ? ` (${p.detail})` : ""} | ${p.pads} | ${p.status} | ${p.ms} |`)
      writeFileSync(join(OUT, "schematic-corpus.md"), lines.join("\n"))

      const sum = (f: (r: FileRow) => boolean) => rows.filter(f).length
      const summary = {
        files: rows.length,
        real: real.length,
        crashes: rows.filter((r) => r.error).length + projects.filter((p) => p.error).length,
        read: sum((r) => r.parse),
        nodesEqual: sum((r) => r.nodes),
        unknown: rows.reduce((a, r) => a + r.unknown, 0),
        imported3a: sum((r) => r.import === "imported"),
        importedReal3a: real.filter((r) => r.import === "imported").length,
        needsEqualCensus: sum((r) => !r.needsDiff),
        needsDiffering: rows.filter((r) => r.needsDiff).length,
        netsEqual: sum((r) => r.nets === "equal"),
        netsDiffer: sum((r) => r.nets === "differs"),
        netsDifferInNames: sum((r) => r.nets === "differs in names"),
        netsPartitionOnly: sum((r) => r.nets.startsWith("partition equal")),
        netsNotCompared: sum((r) => r.nets.startsWith("not compared")),
        netsOutOfScope: sum((r) => r.nets === "-"),
        projects: projects.length,
        linksAsCensus: projects.filter((p) => p.linkOk).length,
        boardAgree: projects.filter((p) => p.boardNets === "agree").length,
        boardStale: projects.filter((p) => p.boardNets.startsWith("stale")).length,
        boardSkipped: projects.filter((p) => p.boardNets.startsWith("skipped")).length,
        projectsImportedForMeasurement: projects.filter((p) => p.imported).length,
        projectsMeasuredNamesNeedS2: projects.filter((p) => p.imported && p.lossyMeasured).length,
        projectsMeasuredPadsWithoutPin: projects.filter((p) => p.imported && (p.padsWithoutPin ?? 0) > 0).length,
        projectsMeasuredNoDifference: projects.filter((p) => p.imported && p.differences === 0).length,
        pros,
        drus,
        proProblems,
        largest,
      }
      writeFileSync(join(OUT, "schematic-corpus-summary.json"), JSON.stringify(summary, null, 1))
      console.log(JSON.stringify(summary))

      expect(summary.crashes).toBe(0)
      expect(summary.read).toBe(summary.files)
      expect(summary.nodesEqual).toBe(summary.files)
      expect(summary.unknown).toBe(0)
      expect(proProblems).toEqual([])
      expect(summary.netsDiffer).toBe(0)
      expect(summary.netsDifferInNames).toBe(0)
      expect(summary.linksAsCensus).toBe(summary.projects)
      // the project import's own comparison agrees with the independent one wherever it ran
      expect(projects.filter((p) => p.imported && !p.lossyMeasured && ((p.boardNets === "agree") !== (p.differences === 0)) && !p.boardNets.startsWith("skipped"))).toEqual([])
    },
    900_000,
  )
})
