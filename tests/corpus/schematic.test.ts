import { existsSync, readFileSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, relative, sep } from "node:path"
import { describe, expect, it } from "vitest"
import { computeConnectivity, pinKey } from "../../src/model/connectivity"
import { EXTENSION_NAMES as BOARD_EXTENSION_NAMES, readKicadBoard } from "../../src/model/kicad/board"
import { accountNodes, countPaths } from "../../src/model/kicad/schematic/account"
import { buildSchematicProject } from "../../src/model/kicad/schematic/build"
import { plainnessOf, settleFor } from "../../src/model/kicad/schematic/carried"
import { schematicPins } from "../../src/model/instances"
import { gateSchematic, importKicadSchematic } from "../../src/model/kicad/schematic/import"
import { linkFootprints } from "../../src/model/kicad/schematic/link"
import { needsOfFile } from "../../src/model/kicad/schematic/needs"
import { readKicadSchematic } from "../../src/model/kicad/schematic/read"
import { readSchematicTree } from "../../src/model/kicad/schematic/tree"
import { accountPro, readKicadPro } from "../../src/model/kicad/project/pro"
import { accountRules, readKicadRules } from "../../src/model/kicad/project/dru"
import { importKicadProject, type ProjectFile } from "../../src/model/kicad/project"
import { drawingFromLib, resolveLibSymbol } from "../../src/model/kicad/schematic/symbols"
import { rawSymbols, type RawSymbol } from "../kicad-census/drawing-sch.mjs"
import { boxCorners, boxTextAt, directiveShape, kicadOnlyBox } from "../../src/model/sheetItems"
import { parseProjectFile, serializeProject } from "../../src/model/projectFile"
import { isDeepStrictEqual } from "node:util"
import { labelNetClasses } from "../../src/model/directives"
import { rawBuses, rawItems } from "../kicad-census/items-sch.mjs"
import { kid, kids, numAt, parseSexpr, type Sexpr } from "../kicad-census/sexpr.mjs"
import { boardPadNets, busMembers, deriveNets } from "../kicad-census/netlist-sch.mjs"
import { parseBusName } from "../../src/model/busNames"
import { needsSch } from "../kicad-census/needs-sch.mjs"
import { CORPUS, walkCorpus as walk, writeReport } from "./shared"

// The per-file pass or fail table of slice 3a over a local corpus (not in the repo):
//
//   KICAD_CORPUS=<corpus dir> KICAD_CENSUS=<corpus dir>/census \
//     KICAD_CORPUS_OUT=<dir> npx vitest run tests/corpus/schematic.test.ts
//
// It reads every `.kicad_sch`, `.kicad_pro` and `.kicad_dru` under the corpus, and every project
// (a board with its schematic beside it), and compares them with the census (`tests/kicad-census`,
// which shares no code with the importer): node counts, unknown nodes and words, the extensions
// each file needs, the footprint links, the nets of the flat schematics the build can hold (the
// editor's own `computeConnectivity` against `netlist-sch.mjs`, pin by pin), and the nets of every
// project against the nets the board itself carries. With no corpus the test is skipped.

const CENSUS = process.env.KICAD_CENSUS ?? (CORPUS ? join(CORPUS, "census") : "")
const OUT = process.env.KICAD_CORPUS_OUT ?? join(tmpdir(), "kicad-schematic-corpus")
const ONLY = process.env.KICAD_ONLY?.split(",").filter(Boolean) ?? []

/**
 * S3: the buses of one imported sheet against its raw file. Each raw bus is covered, to a thousandth of a millimetre, by segments of the model that
 * lie on it (the importer cuts a bus at a junction on its body, so one raw bus may be several segments), and no segment of the model lies off the
 * raw buses; each entry is where the file has it with the size the file gives; each alias has the members the file lists. Only a project of one sheet
 * is compared here (a sheet with a sheet symbol is read with its folder and has others' buses too), the rest is compared in `tests/kicad-sch-s3.test.ts`.
 */
function compareBuses(file: string, raw: ReturnType<typeof rawBuses>, project: { drawings?: { type: string; sheet?: string; points?: { x: number; y: number }[]; x?: number; y?: number; dx?: number; dy?: number; toBus?: boolean }[]; busAliases?: { name: string; members: string[] }[]; sheetSymbols?: unknown[] }): string[] {
  const out: string[] = []
  if (project.sheetSymbols?.length) return out
  const MMU = 12.7
  const segs = (project.drawings ?? []).filter((d) => d.type === "bus").flatMap((d) => d.points!.slice(1).map((p, i) => [d.points![i].x * MMU, -d.points![i].y * MMU, p.x * MMU, -p.y * MMU]))
  const onSeg = (s: number[], a: number[]) => {
    // `a` is a raw bus [x1, y1, x2, y2]; `s` lies on it when both its ends do
    const len = Math.hypot(a[2] - a[0], a[3] - a[1])
    if (len === 0) return null
    const ux = (a[2] - a[0]) / len
    const uy = (a[3] - a[1]) / len
    const t = (x: number, y: number) => {
      const along = (x - a[0]) * ux + (y - a[1]) * uy
      const off = Math.abs(-(x - a[0]) * uy + (y - a[1]) * ux)
      return off < 0.002 && along > -0.002 && along < len + 0.002 ? along : null
    }
    const t1 = t(s[0], s[1])
    const t2 = t(s[2], s[3])
    return t1 === null || t2 === null ? null : Math.abs(t2 - t1)
  }
  for (const a of raw.buses) {
    const len = Math.hypot(a[2] - a[0], a[3] - a[1])
    let covered = 0
    for (const s of segs) covered += onSeg(s, a) ?? 0
    // a point (zero length) bus is no segment
    if (len > 0.002 && Math.abs(covered - len) > 0.004) out.push(`${file}: a bus of ${len.toFixed(3)} mm is covered by ${covered.toFixed(3)} mm`)
  }
  for (const s of segs) if (!raw.buses.some((a) => onSeg(s, a) !== null)) out.push(`${file}: a bus segment lies on no bus of the file`)
  const entries = (project.drawings ?? []).filter((d) => d.type === "busentry")
  if (entries.length !== raw.entries.length) out.push(`${file}: ${entries.length} bus entries against ${raw.entries.length}`)
  raw.entries.forEach((r, i) => {
    const e = entries[i]
    if (!e) return
    const got = [e.x! * MMU, -e.y! * MMU, e.dx! * MMU, -e.dy! * MMU]
    const want = [r.at[0], r.at[1], r.size[0], r.size[1]]
    got.forEach((v, k) => {
      if (Math.abs(v - want[k]) > 0.002) out.push(`${file}: bus entry ${i} number ${k}: ${v} against ${want[k]}`)
    })
    if (!!e.toBus !== r.toBus) out.push(`${file}: bus entry ${i} bus-to-bus`)
  })
  const aliases = project.busAliases ?? []
  if (aliases.length !== raw.aliases.length) out.push(`${file}: ${aliases.length} bus aliases against ${raw.aliases.length}`)
  raw.aliases.forEach((r, i) => {
    const a = aliases[i]
    if (a && (a.name !== r.name.replace(/\{slash\}/g, "/") || a.members.join("\u0001") !== r.members.map((m) => m.replace(/\{slash\}/g, "/")).join("\u0001"))) out.push(`${file}: bus alias ${i} differs`)
  })
  return out
}

/**
 * S3: every name of a label, hierarchical label, global label or sheet pin of a file that has a bracket or a brace, read by `src/model/busNames.ts` and by
 * the oracle's own small reader (`busMembers` in `netlist-sch.mjs`): the same kind, the same members and the same member names without their prefix.
 */
function compareBusNames(file: string, text: string): string[] {
  const out: string[] = []
  const aliases = new Map<string, string[]>()
  for (const a of rawBuses(text).aliases) aliases.set(a.name, a.members)
  const lookup = (n: string) => aliases.get(n)
  const seen = new Set<string>()
  for (const m of text.matchAll(/\((?:label|global_label|hierarchical_label|pin) "((?:[^"\\]|\\.)*)"/g)) {
    const t = m[1].replace(/\{slash\}/g, "/")
    if ((!t.includes("[") && !t.includes("{")) || seen.has(t)) continue
    seen.add(t)
    // a pin of a symbol (`[1-5]`, `[6,7,9-11]`) is a number, not a name: only the names that parse as a bus in either reader count
    const mine = parseBusName(t, lookup, "kicad9")
    const theirs = busMembers(t, aliases)
    if (!mine && !theirs) continue
    if (!mine || !theirs) out.push(`${file}: "${t}" is ${mine ? "a bus" : "no bus"} to the importer and ${theirs ? "a bus" : "no bus"} to the oracle`)
    else if (mine.kind !== theirs.kind || mine.names.join("\u0001") !== theirs.names.join("\u0001") || mine.locals.join("\u0001") !== theirs.locals.join("\u0001")) out.push(`${file}: "${t}" has other members`)
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

const MEASURE = new Set(["S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8", "S9", "S10", "S11", "X19"])

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
  /** What `importKicadSchematic` does with the file with S2 (net names) raised as well: the extensions still missing, or it imports. */
  withNames: string
  ms: number
  error?: string
}

interface ProjectRow {
  /** A sheet used by more than one sheet symbol. */
  reusedSheets?: boolean
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
  /** The size of the project as it would be stored, when the raised import made one. */
  bytes?: number
  differences: number
  /** The project import alone, plain and raised: read, account, link, build, compare. */
  importMs: number
  status: string
  ms: number
  error?: string
}

const MM = 12.7
const near = (units: number, mm: number) => Math.abs(units * MM - mm)

/** A drawing the importer keeps against the raw cache, number by number: the differences, and the largest, in millimetres. */
function compareDrawing(d: ReturnType<typeof drawingFromLib>["drawing"], raw: RawSymbol): { problems: string[]; worst: number } {
  const problems: string[] = []
  let worst = 0
  const check = (what: string, units: number, mm: number) => {
    const e = near(units, mm)
    worst = Math.max(worst, e)
    if (e > 0.001) problems.push(`${what}: ${units * MM} against ${mm}`)
  }
  if (d.items.length !== raw.shapes.length) problems.push(`${d.items.length} items against ${raw.shapes.length}`)
  d.items.forEach((item, i) => {
    const r = raw.shapes[i]
    if (!r) return
    const kind = r.kind === "ellipse_arc" ? "ellipse" : r.kind
    if (item.kind !== kind) {
      problems.push(`item ${i}: ${item.kind} against ${r.kind}`)
      return
    }
    if ((item.unit ?? 0) !== r.unit || (item.body ?? 0) !== r.body) problems.push(`item ${i}: unit and style`)
    if (!!item.private !== r.private) problems.push(`item ${i}: private`)
    if (item.kind !== "text" && (item.fill ?? "none") !== r.fill) problems.push(`item ${i}: fill ${item.fill ?? "none"} against ${r.fill}`)
    check(`item ${i} width`, item.width ?? 0, r.width)
    const flat =
      item.kind === "polyline" || item.kind === "bezier"
        ? item.points.flatMap((q) => [q.x, q.y])
        : item.kind === "rectangle"
          ? [item.a.x, item.a.y, item.b.x, item.b.y]
          : item.kind === "circle"
            ? [item.c.x, item.c.y, item.r]
            : item.kind === "arc"
              ? [item.start.x, item.start.y, item.mid.x, item.mid.y, item.end.x, item.end.y]
              : item.kind === "text"
                ? [item.at.x, item.at.y]
                : [item.c.x, item.c.y, item.rx, item.ry]
    if (flat.length !== r.nums.length) {
      problems.push(`item ${i}: ${flat.length} numbers against ${r.nums.length}`)
      return
    }
    flat.forEach((v, k) => {
      // A symbol arc of more than a half turn in a file up to stamp 20230121 is replaced by KiCad's parser: its middle point is not the file's.
      if (item.kind === "arc" && (k === 2 || k === 3) && raw.version <= 20230121) return
      check(`item ${i} number ${k}`, v, r.nums[k])
    })
  })
  if (d.pins.length !== raw.pins.length) problems.push(`${d.pins.length} pins against ${raw.pins.length}`)
  d.pins.forEach((p, i) => {
    const r = raw.pins[i]
    if (!r) return
    if (p.type !== r.type || p.shape !== r.shape || p.number !== r.number.replace(/ /g, "_") || (p.unit ?? 0) !== r.unit || (p.body ?? 0) !== r.body || !!p.hidden !== r.hidden || p.angle !== (((Math.round(r.angle) % 360) + 360) % 360)) problems.push(`pin ${i}: ${p.number} fields`)
    // names are KiCad's as written from stamp 20250318; before, a lone ~ is empty and an old overbar is converted
    if (raw.version >= 20250318 && p.name !== r.name) problems.push(`pin ${i}: name ${p.name} against ${r.name}`)
    check(`pin ${i} x`, p.x, r.at[0])
    check(`pin ${i} y`, p.y, r.at[1])
    check(`pin ${i} length`, p.length, r.length)
    if ((p.alternates?.length ?? 0) !== r.alternates.length) problems.push(`pin ${i}: alternates`)
  })
  const fields = d.fields.filter((f) => !/^ki_/.test(f.name))
  const rawFields = raw.fields.filter((f) => !/^ki_/.test(f.name))
  if (fields.length !== rawFields.length) problems.push(`${fields.length} fields against ${rawFields.length}`)
  fields.forEach((f, i) => {
    const r = rawFields[i]
    if (!r) return
    if (f.name !== r.name) problems.push(`field ${i}: ${f.name} against ${r.name}`)
    check(`field ${r.name} x`, f.place.x, r.at[0])
    check(`field ${r.name} y`, f.place.y, r.at[1])
  })
  return { problems, worst }
}

function samePaths(a: Map<string, number>, b: Record<string, number>) {
  const keys = new Set([...a.keys(), ...Object.keys(b)])
  for (const k of keys) if ((a.get(k) ?? 0) !== (b[k] ?? 0)) return false
  return true
}

const boxOfCorners = (at: { x: number; y: number }, w: number, h: number, rot: 0 | 90 | 180 | 270) => {
  const c = boxCorners(at, w, h, rot)
  return { minX: Math.min(...c.map((p) => p.x)), minY: Math.min(...c.map((p) => p.y)), maxX: Math.max(...c.map((p) => p.x)), maxY: Math.max(...c.map((p) => p.y)) }
}

describe.skipIf(!CORPUS)("the KiCad schematic corpus", () => {
  it(
    "reads, accounts for, links and checks every schematic and project, and agrees with the census",
    () => {
      let itemsCompared = 0
      let itemWorst = 0
      const itemProblems: string[] = []
      const busProblems: string[] = []
      let savedAndLoaded = 0
      const saveProblems: string[] = []
      const sidecars = JSON.parse(readFileSync(join(CENSUS, "sidecars.json"), "utf8")) as Record<string, any>[]
      const censusSch = new Map(sidecars.filter((r) => r.kind === "kicad_sch").map((r) => [r.file as string, r]))
      const links = JSON.parse(readFileSync(join(CENSUS, "links.json"), "utf8")) as Record<string, any>[]
      const linkOf = new Map(links.filter((l) => l.kind === "kicad_sch").map((l) => [l.file as string, l]))
      const files = walk(CORPUS!).sort()
      const rows: FileRow[] = []
      const t0 = Date.now()
      let drawingCount = 0
      let drawingBytes = 0
      let drawingWorst = 0
      const drawingProblems: string[] = []

      // ---------- every .kicad_sch ----------
      for (const path of files.filter((f) => f.endsWith(".kicad_sch") && (!ONLY.length || ONLY.some((o) => f.includes(o))))) {
        const file = rel(path)
        const c = censusSch.get(file)
        const row: FileRow = { file, group: groupOf(file), stamp: null, era: "", bytes: statSync(path).size, parse: false, nodes: false, unknown: 0, needs: [], census: [], needsDiff: "", needsWhy: [], nets: "-", import: "", lossy: [], withNames: "", ms: 0 }
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
          busProblems.push(...compareBusNames(file, text))
          if (imp.status === "imported") {
            // saved and loaded back: the project file keeps what the import built, every list of it, exactly (a drawing a KiCad sheet gave that the reader would drop is a loss)
            const back = parseProjectFile(serializeProject(imp.project), { id: imp.project.id })
            savedAndLoaded++
            for (const k of ["components", "wires", "labels", "drawings", "blocks", "netNames", "parts", "symbols", "footprints", "properties", "sheets", "sheetSymbols"] as const) {
              if (!isDeepStrictEqual(back[k], imp.project[k])) saveProblems.push(`${file}: ${k} differ after a save and a load${k === "drawings" ? ` (${imp.project.drawings?.length ?? 0} drawings, ${back.drawings?.length ?? 0} after)` : ""}`)
            }
            // S4: every item of the sheet against the raw file, number by number, by a reader that shares no code with `src`
            const raw = rawItems(text)
            const mine = (imp.project.drawings ?? []).filter((i) => i.type !== "junction" && i.type !== "noconnect" && i.type !== "bus" && i.type !== "busentry")
            itemsCompared += raw.length
            // S3: the buses, entries and aliases against the raw file, by a reader that shares no code with `src` (only for a sheet that is the whole project: a sheet used twice or a child is read on its own here too, so it is the same).
            busProblems.push(...compareBuses(file, rawBuses(text), imp.project))
            if (raw.length !== mine.length) itemProblems.push(`${file}: ${mine.length} items against ${raw.length}`)
            raw.forEach((r, i) => {
              const it = mine[i]
              // A polyline is a line and a rectangle a box in the one model of the sheet's drawings.
              const kind = it?.type === "line" ? (it.ruleArea ? "rule_area" : "polyline") : it?.type === "rect" ? "rectangle" : it?.type
              if (!it || kind !== r.kind) {
                itemProblems.push(`${file} item ${i}: ${kind} against ${r.kind}`)
                return
              }
              // A rectangle is kept by its lower-left corner and size, so the file's start and end are compared as the box they make.
              const rawNums = it.type === "rect" ? [Math.min(r.nums[0], r.nums[2]), Math.min(r.nums[1], r.nums[3]), Math.max(r.nums[0], r.nums[2]), Math.max(r.nums[1], r.nums[3])] : r.nums
              const nums =
                it.type === "text" ? [it.x, -it.y]
                : it.type === "textbox" ? [it.x, -it.y, it.w, it.h]
                : it.type === "line" || it.type === "bezier" ? it.points.flatMap((p) => [p.x, -p.y])
                : it.type === "rect" ? [it.x, -(it.y + it.height), it.x + it.width, -it.y]
                : it.type === "circle" ? [it.x, -it.y, it.radius]
                : it.type === "arc" ? [it.start.x, -it.start.y, it.mid.x, -it.mid.y, it.end.x, -it.end.y]
                : it.type === "image" ? [it.x, -it.y]
                : it.type === "table" ? it.cells.flatMap((c) => [c.x, -c.y, c.w, c.h])
                : it.type === "directive" ? [it.x, -it.y, it.rot / MM, it.length]
                : []
              if (nums.length !== rawNums.length) itemProblems.push(`${file} item ${i}: ${nums.length} numbers against ${rawNums.length}`)
              nums.forEach((v, k) => {
                const e = Math.abs(v * MM - rawNums[k])
                itemWorst = Math.max(itemWorst, e)
                if (e > 0.001) itemProblems.push(`${file} item ${i} number ${k}: ${v * MM} against ${rawNums[k]}`)
              })
              if ((it.type === "text" || it.type === "textbox") && it.text !== r.text) itemProblems.push(`${file} item ${i}: text`)
              // S8: a directive label's shape word, its properties (name and value, in file order and at their places) and the end of its pin and the box of its flag as the raw file's turn gives them;
              // a rule area's flags, each as the raw file says it.
              if (it.type === "directive" && r.kind === "directive") {
                if (it.shape !== r.shape) itemProblems.push(`${file} item ${i}: shape ${it.shape} against ${r.shape}`)
                if (JSON.stringify(it.fields.map((f) => [f.name, f.value])) !== JSON.stringify(r.fields)) itemProblems.push(`${file} item ${i}: fields`)
                it.fields.forEach((f, k) => {
                  const e = Math.max(Math.abs((it.x + f.place.x) * MM - r.fieldAt![k][0]), Math.abs(-(it.y + f.place.y) * MM - r.fieldAt![k][1]))
                  itemWorst = Math.max(itemWorst, e)
                  if (e > 0.001) itemProblems.push(`${file} item ${i} field ${k} place: ${e} mm off`)
                })
                const g = directiveShape(it)
                const gotEnd = [g.pin[1].x * MM, -g.pin[1].y * MM]
                const box = kicadOnlyBox(it)
                const gotBox = [box.minX * MM, -box.maxY * MM, box.maxX * MM, -box.minY * MM]
                const wantBox = r.rects![0]
                ;[...gotEnd.map((v, q) => [v, r.anchors![0][q]]), ...gotBox.map((v, q) => [v, wantBox[q]])].forEach(([v, w], q) => {
                  const e = Math.abs(v - w)
                  itemWorst = Math.max(itemWorst, e)
                  if (e > 0.001) itemProblems.push(`${file} item ${i} flag geometry ${q}: ${v} against ${w}`)
                })
              }
              if (it.type === "line" && it.ruleArea && r.flags) {
                const f = it.ruleArea
                if (!!f.dnp !== r.flags.dnp || !!f.excludeFromBom !== r.flags.noBom || !!f.notOnBoard !== r.flags.noBoard || !!f.excludeFromSim !== r.flags.noSim) itemProblems.push(`${file} item ${i}: rule area flags`)
              }
              // the drawn box, not only the stored numbers: the rectangle from `at` to `at + size`, never turned
              if (r.rects && (it.type === "textbox" || it.type === "table")) {
                const drawn = it.type === "textbox" ? [boxOfCorners(it, it.w, it.h, it.rot)] : it.cells.map((c) => boxOfCorners(c, c.w, c.h, c.rot))
                if (drawn.length !== r.rects.length) itemProblems.push(`${file} item ${i}: ${drawn.length} drawn boxes against ${r.rects.length}`)
                const boxes = it.type === "textbox" ? [it] : it.cells
                boxes.forEach((b, k) => {
                  const want = r.anchors?.[k]
                  if (!want) return
                  const at = boxTextAt(b, b.margins, b.look)
                  const e = Math.max(Math.abs(at.x * MM - want[0]), Math.abs(-at.y * MM - want[1]))
                  itemWorst = Math.max(itemWorst, e)
                  if (e > 0.001) itemProblems.push(`${file} item ${i} text anchor ${k}: (${at.x * MM}, ${-at.y * MM}) against (${want[0]}, ${want[1]})`)
                })
                drawn.forEach((d, k) => {
                  const rr = r.rects![k]
                  if (!rr) return
                  const want = [Math.min(rr[0], rr[2]), Math.min(-rr[1], -rr[3]), Math.max(rr[0], rr[2]), Math.max(-rr[1], -rr[3])]
                  const got = [d.minX * MM, d.minY * MM, d.maxX * MM, d.maxY * MM]
                  got.forEach((v, q) => {
                    const e = Math.abs(v - want[q])
                    itemWorst = Math.max(itemWorst, e)
                    if (e > 0.001) itemProblems.push(`${file} item ${i} drawn box ${k} edge ${q}: ${v} against ${want[q]}`)
                  })
                })
              }
            })
          }
          const named = importKicadSchematic(new Uint8Array(bytes))
          row.withNames = named.status === "imported" ? "imported" : named.needs.length ? `needs ${named.needs.map((n) => n.ext).join(" ")}` : `refused, ${named.reason}`
          // the drawings of every cached symbol against the raw cache
          const raws = rawSymbols(text)
          const cache = new Map(schematic.libSymbols.map((l) => [l.name, l]))
          for (const lib of schematic.libSymbols) {
            let resolved
            try {
              resolved = resolveLibSymbol(lib, (n) => cache.get(n))
            } catch {
              continue
            }
            const drawing = drawingFromLib(resolved).drawing
            const cmp = compareDrawing(drawing, raws.get(lib.name)!)
            drawingCount++
            drawingBytes += JSON.stringify(drawing).length
            drawingWorst = Math.max(drawingWorst, cmp.worst)
            if (cmp.problems.length) drawingProblems.push(`${file} ${lib.name}: ${cmp.problems.slice(0, 2).join("; ")}`)
          }
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

      /** The files with sheet symbols whose nets are compared with the oracle's, whole hierarchy at once. */
      const hierNets: FileRow[] = []
      const netNameProblems: string[] = []
      /** S8: the net classes of the labels against the raw file's, by the derivation that shares no code with `src`. */
      const classProblems: string[] = []
      let classNetsCompared = 0
      let classNetsInClass = 0
      /** S11: per file, the sheets built with KiCad's joining rules, what the oracle finds, and whether the nets agree. */
      const joinRows: { file: string; flagged: number; oracle: string[]; partitionEqual: boolean }[] = []
      const sheetProblems: string[] = []
      let sheetsCompared = 0
      // ---------- the nets of the schematics (a hierarchy whole, with every use of a reused sheet) ----------
      // Every pin the editor has a port for, in the groups of the editor's own connectivity and of the derivation from the raw file:
      // single pins included, and the names of the nets where the build is exact. A build that needs an extension is not counted as equal:
      // one that needs only S2 (KiCad's own net names) has its partition compared and says so.
      for (const row of rows) {
        if (row.error || !row.parse) continue
        const path = join(CORPUS!, row.file)
        try {
          const bytes = new Uint8Array(readFileSync(path))
          const { schematic } = readKicadSchematic(bytes)
          // A file with sheet symbols is read with every file of its folder, as a project is.
          const folder = path.slice(0, path.lastIndexOf(sep))
          const input = schematic.sheets.length ? { files: new Map([...walk(folder)].filter((f) => f.endsWith(".kicad_sch") || f.endsWith(".sch")).map((f) => [relative(folder, f).split(sep).join("/"), new Uint8Array(readFileSync(f))] as const)), root: path.slice(folder.length + 1) } : bytes
          const gate = gateSchematic(input, { built: MEASURE })
          if ("refused" in gate) {
            row.nets = `not built: ${gate.refused.message.slice(0, 80)}`
            continue
          }
          const built = buildSchematicProject(gate.gate.tree, gate.gate.report, { built: MEASURE })
          row.lossy = built.lossy.map((n) => n.ext)
          const exts = new Set(row.lossy)
          const { pinNet, nets } = computeConnectivity(built.project)
          const symOf = new Map([...built.byRecord].map(([r, c]) => [c.id, r]))
          const universe: string[] = []
          const netOf = new Map<string, string | undefined>()
          const members = new Map<string, string[]>()
          for (const c of built.project.components) {
            const sym = symOf.get(c.id)
            if (!sym) continue
            for (const pin of schematicPins(c)) {
              const key = `${sym.path}#${pin.pin}`
              const net = pinNet.get(pinKey(c.id, pin.pin))
              universe.push(key)
              netOf.set(key, net)
              if (net) (members.get(net) ?? members.set(net, []).get(net)!).push(key)
            }
          }
          // a pin's group: the sorted pins of its net, or itself alone
          const mine = (k: string) => (netOf.get(k) ? [...members.get(netOf.get(k)!)!].sort().join(" ") : k)
          const derived = deriveNets(path, { hiddenPower: true, localJoinsGlobal: "same" })
          if (derived.unsupported.size) {
            row.nets = `not compared: ${[...derived.unsupported].join(", ")}`
            continue
          }
          if (schematic.sheets.length) {
            hierNets.push(row)
            // The root's sheet symbols against the raw file, number by number (a reader that shares no code with `src`): the rectangle and each pin's place, name and shape.
            const rawRoot = parseSexpr(new TextDecoder().decode(bytes)).find((n) => Array.isArray(n) && n[0] === "kicad_sch") as Sexpr[]
            const rawSheets = kids(rawRoot, "sheet")
            const mine = built.project.sheetSymbols?.filter((x) => x.sheet === "root") ?? []
            if (rawSheets.length !== mine.length) sheetProblems.push(`${row.file}: ${mine.length} sheet symbols against ${rawSheets.length}`)
            rawSheets.forEach((r, i) => {
              const m = mine[i]
              if (!m) return
              sheetsCompared++
              const at = kid(r, "at")
              const size = kid(r, "size")
              const want = [numAt(at, 1), numAt(at, 2) + numAt(size, 2), numAt(size, 1), numAt(size, 2)]
              // the lower-left corner is at y + h in KiCad's frame (y down), which the editor holds negated
              const gotRect = [m.x * MM, -m.y * MM, m.w * MM, m.h * MM]
              const wantRect = want
              gotRect.forEach((v, k) => {
                if (Math.abs(v - wantRect[k]) > 0.001) sheetProblems.push(`${row.file} sheet ${i} number ${k}: ${v} against ${wantRect[k]}`)
              })
              const pins = kids(r, "pin")
              if (pins.length !== m.pins.length) sheetProblems.push(`${row.file} sheet ${i}: ${m.pins.length} pins against ${pins.length}`)
              pins.forEach((pin, j) => {
                const q = m.pins[j]
                if (!q) return
                const pat = kid(pin, "at")
                const name = String(pin[1]).split("{slash}").join("/")
                if (Math.abs(q.x * MM - numAt(pat, 1)) > 0.001 || Math.abs(-q.y * MM - numAt(pat, 2)) > 0.001 || q.name !== name || q.shape !== (pin[2] === "unconnected" ? "passive" : pin[2]) || ((q.rot - numAt(pat, 3) + 720) % 360) % 360 !== 0) sheetProblems.push(`${row.file} sheet ${i} pin ${j} (${name})`)
              })
            })
          }
          const inUniverse = new Set(universe)
          const byGroup = new Map<number, string[]>()
          for (const [key, g] of derived.pins) for (const x of ([] as number[]).concat(g)) if (inUniverse.has(key)) (byGroup.get(x) ?? byGroup.set(x, []).get(x)!).push(key)
          const theirs = (k: string) => {
            const g = ([] as number[]).concat(derived.pins.get(k) ?? [])[0]
            return g === undefined ? k : [...new Set(byGroup.get(g)!)].sort().join(" ")
          }
          const partitionEqual = universe.every((k) => mine(k) === theirs(k))
          // S11: the sheets the importer joined by KiCad's rules, against the sheets where the oracle (which shares no code with `src`) finds the editor's rules and KiCad's part.
          const flaggedSheets = built.project.sheets?.filter((x) => x.kicadRules).length ?? 0
          const oracleCases = [...new Set(derived.cases.map((c) => c.kind))].sort()
          joinRows.push({ file: row.file, flagged: flaggedSheets, oracle: oracleCases, partitionEqual })
          // names: the editor's net name against the driver KiCad picks, wherever either has one
          let namesEqual = true
          for (const net of nets) {
            const keys = members.get(net.id)
            if (!keys?.length) continue
            const g = ([] as number[]).concat(derived.pins.get(keys[0]) ?? [])[0]
            // KiCad's name of the net, from the raw file: its driver's, or a pin's `Net-(R1-Pad2)`; the editor's own name for it is the same
            const rawName = g === undefined ? null : derived.netName(g)
            // KiCad names a net of an unannotated symbol (`U?`) by the symbol's uuid, which neither the importer nor the derivation writes: those are not compared.
            if (/\?[A-Z]?-/.test(rawName ?? "") || /^Net-\(-Pad/.test(net.name)) continue
            if (rawName !== net.name) {
              namesEqual = false
              if (netNameProblems.length < 40) netNameProblems.push(`${row.file}: ${net.name} (importer) against ${rawName} (raw file)`)
            }
          }
          // S8: the classes each net is in. The oracle's are the Netclass fields of the labels on the net (and of a rule area's directive labels, for what the area holds); the importer's, by net name.
          {
            const mineClasses = labelNetClasses(built.project)
            for (const net of nets) {
              const keys = members.get(net.id)
              if (!keys?.length) continue
              const g = ([] as number[]).concat(derived.pins.get(keys[0]) ?? [])[0]
              const rawName = g === undefined ? null : derived.netName(g)
              if (rawName === null || /\?[A-Z]?-/.test(rawName) || /^Net-\(-Pad/.test(net.name)) continue
              const want = [...(derived.netClasses.get(rawName) ?? [])].sort()
              const got = [...(mineClasses.get(net.name) ?? [])].sort()
              classNetsCompared++
              if (want.length) classNetsInClass++
              if (want.join("|") !== got.join("|")) classProblems.push(`${row.file}: ${net.name}: ${got.join(",") || "no class"} (importer) against ${want.join(",") || "no class"} (raw file)`)
            }
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
                if (boardName !== null && !/^(?:Net-\(|unconnected-\()/.test(boardName) && !(driver && boardName === driver.full)) {
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
                detail.push(`board net ${net} is on ${v.size} nets of the schematic (${[...v].map((g) => `${(padsOf.get(g) ?? []).slice(0, 1).join("")} as ${derived.driver.get(([] as number[]).concat(g)[0])?.name ?? "an unnamed net"}`).join(", ")})`)
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
          const raised = importKicadProject(projectFiles, { built: new Set([...Object.keys(BOARD_EXTENSION_NAMES), "S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8", "S9", "S10"]), allowLossyBoard: true, limitBytes: Number.MAX_SAFE_INTEGER })
          row.importMs = Date.now() - tImport
          const word = (r: typeof plainRun) => (r.status === "imported" ? "imported" : `refused, ${r.reason}${r.needs.length ? ` (${r.needs.map((n) => n.ext).join(" ")})` : r.reason === "inexact" ? ` (${r.message.replace(/^This (board|schematic) cannot be imported exactly: /, "").split(";")[0].slice(0, 60)})` : ""}`)
          row.status = `${word(plainRun)} / ${word(raised)}`
          if (raised.status === "imported") {
            // a project with sheets is saved and loaded back with its sheets, sheet symbols, uses and copies exactly
            if (raised.project.sheetSymbols?.length) {
              const back = parseProjectFile(serializeProject(raised.project), { id: raised.project.id })
              for (const k of ["components", "wires", "labels", "blocks", "sheets", "sheetSymbols"] as const) if (!isDeepStrictEqual(back[k], raised.project[k])) saveProblems.push(`${name}: ${k} differ after a save and a load`)
              row.reusedSheets = new Set(raised.project.sheetSymbols.map((x) => x.child)).size < raised.project.sheetSymbols.length
            }
            // the project's own comparison must agree with the independent one
            // a pad the symbol has no pin for is a real difference the independent comparison (which walks the symbols' pins) cannot see, so it is counted on its own
            const mine = raised.differences.filter((d) => !/the symbol has no pin/.test(d.why)).length
            row.padsWithoutPin = raised.differences.length - mine
            row.imported = true
            row.bytes = raised.bytes
            row.differences = mine
            if (mine) row.detail = raised.differences.slice(0, 2).map((d) => d.why).join(" | ")
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
      const real = rows.filter((r) => REAL.includes(r.group))
      const lines: string[] = []
      lines.push(`# Schematic corpus, ${rows.length} files, ${projects.length} projects, ${Date.now() - t0} ms\n`)
      lines.push("| file | group | stamp | read | nodes | unknown | needs (importer) | needs (census) | difference | why | nets | now | with S2 | ms |", "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|")
      for (const r of rows) lines.push(`| ${r.file} | ${r.group} | ${r.stamp ?? ""} | ${r.error ? `ERROR ${r.error}` : r.parse ? "ok" : "no"} | ${r.nodes ? "ok" : "NO"} | ${r.unknown} | ${r.needs.join(" ")} | ${r.census.join(" ")} | ${r.needsDiff} | ${r.needsWhy.join("; ")} | ${r.nets}${r.lossy.length ? ` (${r.lossy.join("; ")})` : ""} | ${r.import} | ${r.withNames} | ${r.ms} |`)
      lines.push("", "| project | group | stamp | sheets | footprints | by path | by reference | none | links as link.mjs | nets of board and schematic | pads | import (plain / raised) | ms |", "|---|---|---|---|---|---|---|---|---|---|---|---|---|")
      for (const p of projects) lines.push(`| ${p.project} | ${p.group} | ${p.stamp ?? ""} | ${p.sheets} | ${p.footprints} | ${p.linkPath} | ${p.linkReference} | ${p.linkNone} | ${p.error ? `ERROR ${p.error}` : p.linkOk ? "yes" : "NO"} | ${p.boardNets}${p.detail ? ` (${p.detail})` : ""} | ${p.pads} | ${p.status} | ${p.ms} |`)
      writeReport(OUT, "schematic-corpus.md", lines.join("\n"))

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
        importedWithNames: sum((r) => r.withNames === "imported"),
        importedRealWithNames: real.filter((r) => r.withNames === "imported").length,
        stillNeeding: Object.fromEntries([...new Set(rows.map((r) => r.withNames))].filter((k) => k && k !== "imported").map((k) => [k, rows.filter((r) => r.withNames === k).length])),
        itemsCompared,
        itemWorstMm: Number(itemWorst.toFixed(6)),
        itemProblems: itemProblems.length,
        savedAndLoaded,
        saveProblems: saveProblems.length,
        drawingSymbols: drawingCount,
        drawingBytes,
        drawingWorstMm: Number(drawingWorst.toFixed(6)),
        drawingProblems: drawingProblems.length,
        needsEqualCensus: sum((r) => !r.needsDiff),
        needsDiffering: rows.filter((r) => r.needsDiff).length,
        netsEqual: sum((r) => r.nets === "equal"),
        // S11: sheets built with KiCad's joining rules; files where the oracle finds a case; files where the two disagree; and whether the nets of every file with one equal KiCad's
        joinFlaggedFiles: joinRows.filter((r) => r.flagged > 0).length,
        joinOracleCaseFiles: joinRows.filter((r) => r.oracle.length > 0).map((r) => `${r.file}: ${r.oracle.join(", ")}`),
        // a pin the editor's four digits put 1.27 um off is not a case for the flag: the wire end is put on the pin (`kicad-pins-snapped`)
        joinFlagDisagreements: joinRows.filter((r) => (r.flagged > 0) !== r.oracle.some((k) => k !== "pin-rounding")).map((r) => `${r.file}: flagged ${r.flagged}, oracle ${r.oracle.join(", ") || "none"}`),
        joinNetsDiffer: joinRows.filter((r) => (r.flagged > 0 || r.oracle.length > 0) && !r.partitionEqual).map((r) => r.file),
        netNameProblems,
        classNetsCompared,
        classNetsInClass,
        classProblems: classProblems.slice(0, 20),
        sheetsCompared,
        sheetProblems: sheetProblems.slice(0, 20),
        hierarchicalNetsCompared: hierNets.length,
        hierarchicalNetsEqual: hierNets.filter((r) => r.nets === "equal").length,
        hierarchicalNetsOther: Object.fromEntries([...new Set(hierNets.filter((r) => r.nets !== "equal").map((r) => r.nets))].map((k) => [k, hierNets.filter((r) => r.nets === k).length])),
        netsDiffer: sum((r) => r.nets === "differs"),
        netsDifferInNames: sum((r) => r.nets === "differs in names"),
        netsPartitionOnly: sum((r) => r.nets.startsWith("partition equal")),
        netsNotCompared: sum((r) => r.nets.startsWith("not compared")),
        netsOutOfScope: sum((r) => r.nets === "-"),
        projects: projects.length,
        linksAsCensus: projects.filter((p) => p.linkOk).length,
        hierarchicalProjects: projects.filter((p) => p.sheets > 1).length,
        hierarchicalProjectsImported: projects.filter((p) => p.sheets > 1 && p.status.startsWith("imported")).length,
        hierarchicalProjectsRefused: Object.fromEntries([...new Set(projects.filter((p) => p.sheets > 1 && !p.status.startsWith("imported")).map((p) => p.status))].map((k) => [k, projects.filter((p) => p.sheets > 1 && p.status === k).length])),
        hierarchicalBoardAgree: projects.filter((p) => p.sheets > 1 && p.boardNets === "agree").length,
        hierarchicalBoardStale: projects.filter((p) => p.sheets > 1 && p.boardNets.startsWith("stale")).length,
        hierarchicalReusedSheets: projects.filter((p) => p.reusedSheets).length,
        hierarchicalMeasured: projects.filter((p) => p.sheets > 1 && p.imported).length,
        hierarchicalNoDifference: projects.filter((p) => p.sheets > 1 && p.imported && p.differences === 0).length,
        hierarchicalPads: projects.filter((p) => p.sheets > 1 && p.imported).reduce((n, p) => n + p.pads, 0),
        boardAgree: projects.filter((p) => p.boardNets === "agree").length,
        boardStale: projects.filter((p) => p.boardNets.startsWith("stale")).length,
        boardSkipped: projects.filter((p) => p.boardNets.startsWith("skipped")).length,
        projectsImportedForMeasurement: projects.filter((p) => p.imported).length,
        projectsMeasuredNamesNeedS2: projects.filter((p) => p.imported && p.lossyMeasured).length,
        projectsMeasuredPadsWithoutPin: projects.filter((p) => p.imported && (p.padsWithoutPin ?? 0) > 0).length,
        largestProjectBytes: Math.max(0, ...projects.map((p) => p.bytes ?? 0)),
        projectsOver900KiB: projects.filter((p) => (p.bytes ?? 0) > 900 * 1024).length,
        projectsMeasuredNoDifference: projects.filter((p) => p.imported && p.differences === 0).length,
        pros,
        drus,
        proProblems,
        largest,
      }
      writeReport(OUT, "schematic-corpus-summary.json", JSON.stringify(summary, null, 1))
      console.log(JSON.stringify(summary))

      expect(summary.crashes).toBe(0)
      expect(summary.read).toBe(summary.files)
      expect(summary.nodesEqual).toBe(summary.files)
      expect(summary.unknown).toBe(0)
      expect(proProblems).toEqual([])
      expect(sheetProblems.slice(0, 5)).toEqual([])
      expect(drawingProblems.slice(0, 5)).toEqual([])
      expect(summary.drawingWorstMm).toBeLessThanOrEqual(0.001)
      expect(itemProblems.slice(0, 5)).toEqual([])
      expect(busProblems.slice(0, 5)).toEqual([])
      expect(saveProblems.slice(0, 5)).toEqual([])
      expect(savedAndLoaded).toBe(summary.imported3a)
      expect(itemWorst).toBeLessThanOrEqual(0.001)
      expect(itemsCompared).toBeGreaterThan(300)
      // the real gate: with S2, S4 and S7 built, the files slices-sch.mjs puts in slice 3b import (71 of the 184 real files, 38.6%)
      expect(summary.imported3a).toBe(summary.importedWithNames)
      expect(summary.importedReal3a).toBeGreaterThanOrEqual(71)
      expect(classProblems.slice(0, 5)).toEqual([])
      expect(summary.netsDiffer).toBe(0)
      expect(summary.netsDifferInNames).toBe(0)
      // S11: the importer flags a sheet exactly where the independent oracle finds the editor's rules and KiCad's apart, and those nets are KiCad's
      expect(summary.joinFlagDisagreements).toEqual([])
      expect(summary.joinNetsDiffer).toEqual([])
      expect(summary.linksAsCensus).toBe(summary.projects)
      // the project import's own comparison agrees with the independent one wherever it ran
      expect(projects.filter((p) => p.imported && !p.lossyMeasured && ((p.boardNets === "agree") !== (p.differences === 0)) && !p.boardNets.startsWith("skipped"))).toEqual([])
    },
    900_000,
  )
})
