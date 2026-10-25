import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, relative, sep } from "node:path"
import { describe, expect, it } from "vitest"
import { computeConnectivity, pinKey } from "../src/model/connectivity"
import { pcbPads } from "../src/model/instances"
import { serializeProject } from "../src/model/projectFile"
import { buildKicadProject, BUILT_EXTENSIONS, importKicadBoard, needsOf, outlineOf, padWorld, readKicadBoard, type ImportReport } from "../src/model/kicad/board"
import { countPaths } from "../src/model/kicad/board/account"
import { planModels } from "../src/model/kicad/board/models"
import { needs as censusNeeds } from "./kicad-census/needs.mjs"
import { copperOracle, oracle } from "./kicad-census/pads.mjs"
import { decodeNetName } from "../src/model/kicad/board"
import { cleanFlags } from "../src/model/partFlags"
import { checkGraphics, roundTripOk } from "./kicad-graphics-check"

// The per-board pass or fail table of slice 1a over a local corpus (not in the repo):
//
//   KICAD_CORPUS=<corpus dir> KICAD_CENSUS=<corpus dir>/census \
//     KICAD_CORPUS_OUT=<dir> npx vitest run tests/kicad-board-corpus.test.ts
//
// It reads every `.kicad_pcb` and `.brd` under the corpus, runs the importer's reader, accounting,
// needs and project build over each, and compares them with the census (`tests/kicad-census`,
// which shares no code with the importer): node counts, object counts, nets, every pad's place to
// 0.001 mm against an oracle computed from the raw file (by a different method: matrices for the
// flip, turn and move, the file's own net names), every pad's outline extent, every pad's net
// through the project's own connectivity (pad by pad, not pin by pin), and the extensions each
// board needs. Slice 1b-i adds two checks of its own, each against the raw file read again by the
// census's own reader (`copperOracle`): the flags and net ties of every footprint, and the net, the
// lock and the length of every segment and via of every net. With no corpus the test is skipped.

const CORPUS = process.env.KICAD_CORPUS
const CENSUS = process.env.KICAD_CENSUS ?? (CORPUS ? join(CORPUS, "census") : "")
const OUT = process.env.KICAD_CORPUS_OUT ?? join(tmpdir(), "kicad-board-corpus")
const LIMIT = Number(process.env.KICAD_LIMIT ?? 0)
const ONLY = process.env.KICAD_ONLY?.split(",").filter(Boolean) ?? []

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) {
      if (name === "census") continue
      walk(p, out)
    } else if (name.endsWith(".kicad_pcb") || name.endsWith(".brd")) out.push(p)
  }
  return out
}

interface Row {
  file: string
  group: string
  bytes: number
  stamp: number | null
  era: string
  parse: boolean
  nodes: boolean
  counts: boolean
  unknown: number
  netsFile: boolean
  pads: boolean
  padError: number
  padsProject: "ok" | "fail" | "none"
  padsProjectCompared: number
  padsProjectSkipped: number
  netsProject: "ok" | "fail" | "refused"
  /** Codes of the refusals the forced build raised (a pad number on two nets, a part that cannot be drawn...). */
  buildRefusals: string[]
  /** Pads checked against the oracle's nets through the project's own connectivity, and how many differ; `netPadsWrongX7` counts the differences on a board that needs X7 (pads that share a number cannot be on two nets in a part with one pin). */
  netPadsChecked: number
  netPadsWrong: number
  netPadsWrongX7: number
  /** Pad outlines in the project against the oracle's extent of each, to 0.001 mm. */
  boxChecked: number
  boxWrong: number
  /** Footprints with a reference of their own: their flags and net ties against the file's, and how many differ. */
  flagsChecked: number
  flagsWrong: number
  /** Footprints whose no-connect pins are the pins the file puts on no net, and how many are not. */
  ncChecked: number
  ncWrong: number
  ncPins: number
  /** Footprints in the project with any flag, and with a net tie. */
  flagged: number
  tied: number
  /** Track length and via count per net against the file's: whether they agree, and the lengths compared. */
  copperNets: "ok" | "fail" | "none"
  copperLocked: boolean
  /** Items the importer says the editor derives another net for, and the pins whose KiCad type was folded, and the single-pad nets accepted. */
  copperMismatches: number
  /** Every mismatch is an item of the report entry, and no item is listed that is not one. */
  mismatchListed: boolean
  foldedPins: number
  loneLabels: number
  /** Slice 1b-ii: the file's drawings (board, footprints, targets as three each) against the project's. */
  gfxFile: number
  gfxProject: number
  /** The same count on every layer in both. */
  gfxCounts: boolean
  /** Drawings of the file with no match in the project to 0.001 mm. */
  gfxWrong: number
  gfxLayers: Record<string, number>
  /** The drawings survive the stored form: the same project in memory after a save and a load. */
  gfxRoundTrip: boolean
  /** The 3D models of the board: held, and not held by reason. */
  modelsKept: number
  modelsDropped: Record<string, number>
  needs: string[]
  /** What the importer really needs (a zero margin in an old file is no setting), against `needs`, which is the census's reading of zero. */
  needsActual: string[]
  censusNeeds: string[]
  needsMissing: string[]
  /** The outline as read: status, shape and whether the model holds it, against the census's. */
  outline: string
  outlineCensus: string
  /** X7 is needed by the census's rule but not once a zero margin in an old file is read as none. */
  switch8: boolean
  needsExtra: string[]
  status: string
  /** A refusal for what is not built names exactly the importer's needs that are not built, and never one that is. */
  gateExact: boolean
  messageNamed: boolean
  buildOk: boolean
  lossy: string[]
  projectBytes: number
  /** The census's estimate of what slice 1a builds, and of what it leaves out (graphics, text, zone outlines). */
  estBuilt: number
  estUnbuilt: number
  pads_total: number
  ms: { read: number; account: number; build: number; total: number }
  error?: string
  notes: string[]
}

const near = (a: number, b: number, eps = 0.001) => Math.abs(a - b) <= eps

function groupOf(rel: string) {
  if (rel.startsWith("pcbench/")) return "pcbench"
  if (rel.startsWith("kicad-source/demos")) return "kicad-demos"
  if (rel.startsWith("kicad-source")) return "kicad-qa"
  return "github"
}

describe.skipIf(!CORPUS)("the KiCad corpus", () => {
  it(
    "reads, accounts for and builds every board, and agrees with the census",
    () => {
      const boards = JSON.parse(readFileSync(join(CENSUS, "boards.json"), "utf8")) as Record<string, any>[]
      const census = new Map(boards.map((b) => [b.file as string, b]))
      const files = walk(CORPUS!).sort()
      const rows: Row[] = []
      const t0 = Date.now()
      for (const path of (LIMIT ? files.slice(0, LIMIT) : files).filter((f) => !ONLY.length || ONLY.some((o) => f.includes(o)))) {
        const rel = relative(CORPUS!, path).split(sep).join("/")
        const bytes = statSync(path).size
        const row: Row = {
          file: rel,
          group: census.get(rel)?.group ?? groupOf(rel),
          bytes,
          stamp: null,
          era: "",
          parse: false,
          nodes: false,
          counts: false,
          unknown: 0,
          netsFile: false,
          pads: false,
          padError: 0,
          padsProject: "none",
          padsProjectCompared: 0,
          padsProjectSkipped: 0,
          netsProject: "refused",
          buildRefusals: [],
          netPadsChecked: 0,
          netPadsWrong: 0,
          netPadsWrongX7: 0,
          boxChecked: 0,
          boxWrong: 0,
          flagsChecked: 0,
          flagsWrong: 0,
          ncChecked: 0,
          ncWrong: 0,
          ncPins: 0,
          flagged: 0,
          tied: 0,
          copperNets: "none",
          copperLocked: true,
          copperMismatches: 0,
          mismatchListed: true,
          foldedPins: 0,
          loneLabels: 0,
          gfxFile: 0,
          gfxProject: 0,
          gfxCounts: true,
          gfxWrong: 0,
          gfxLayers: {},
          gfxRoundTrip: true,
          modelsKept: 0,
          modelsDropped: {},
          needs: [],
          needsActual: [],
          censusNeeds: [],
          needsMissing: [],
          outline: "",
          outlineCensus: "",
          switch8: false,
          needsExtra: [],
          status: "",
          gateExact: true,
          messageNamed: false,
          buildOk: false,
          lossy: [],
          projectBytes: 0,
          estBuilt: 0,
          estUnbuilt: 0,
          pads_total: 0,
          ms: { read: 0, account: 0, build: 0, total: 0 },
          notes: [],
        }
        rows.push(row)
        const start = performance.now()
        const data = readFileSync(path)
        if (rel.endsWith(".brd")) {
          // A KiCad 3 and older board: refused with a message that names the version, never imported.
          const r = importKicadBoard(new Uint8Array(data))
          row.status = r.status === "refused" ? `refused:${r.reason}` : "imported"
          row.parse = r.status === "refused" && r.reason === "unreadable"
          row.messageNamed = r.status === "refused" && /PCBNEW-BOARD Version \d/.test(r.message) && /before version 4/.test(r.message)
          row.ms.total = performance.now() - start
          continue
        }
        try {
          const text = data.toString("utf8")
          const c = census.get(rel)
          let read
          try {
            read = readKicadBoard(new Uint8Array(data))
          } catch (e) {
            row.error = `read: ${e instanceof Error ? e.message : e}`
            row.status = c ? "FAIL:read" : "refused:unreadable"
            row.parse = !c
            row.messageNamed = !c
            row.ms.total = performance.now() - start
            continue
          }
          row.parse = true
          const { board } = read
          row.stamp = board.version
          row.era = board.era
          row.ms.read = performance.now() - start

          // ---- the census's counts ----
          if (c) {
            const mine = countPaths(board.tree)
            const theirs = Object.entries(c.nodes as Record<string, number>)
            row.nodes = mine.size === theirs.length && theirs.every(([k, v]) => mine.get(k) === v)
            const nets = board.nets.length
            row.counts =
              board.footprints.length === c.fps.total &&
              board.footprints.reduce((n, f) => n + f.pads.length, 0) === c.pads.total &&
              board.segments.length === c.tracks.segments &&
              board.arcTracks.length === c.tracks.arcs &&
              board.vias.length === c.tracks.vias &&
              board.zones.length + board.footprints.reduce((n, f) => n + f.zones.length, 0) === c.zones.total &&
              nets === c.nets.declared &&
              board.netClasses.length === c.nets.classes
          } else {
            row.notes.push("not in the census")
            row.nodes = true
            row.counts = true
          }

          // ---- pads and nets against the oracle ----
          const o = oracle(text)
          row.pads_total = board.footprints.reduce((n, f) => n + f.pads.length, 0)
          let padsOk = o.length === board.footprints.length
          let netsOk = padsOk
          let worst = 0
          if (padsOk) {
            for (let i = 0; i < o.length && padsOk; i++) {
              const fp = board.footprints[i]
              if (fp.pads.length !== o[i].pads.length || fp.side !== (o[i].bottom ? "bottom" : "top")) padsOk = false
              for (let j = 0; j < o[i].pads.length && padsOk; j++) {
                const w = padWorld(fp, fp.pads[j])
                const d = Math.max(Math.abs(w.x - o[i].pads[j].x), Math.abs(w.y - o[i].pads[j].y))
                worst = Math.max(worst, d)
                if (d > 0.001) padsOk = false
                if (fp.pads[j].netRaw !== o[i].pads[j].net) netsOk = false
                if (fp.pads[j].number !== o[i].pads[j].number || fp.pads[j].type !== o[i].pads[j].type) padsOk = false
                if (!near(fp.pads[j].angle, o[i].pads[j].angle, 1e-9) || !near(fp.pads[j].w, o[i].pads[j].w, 1e-9) || !near(fp.pads[j].h, o[i].pads[j].h, 1e-9)) padsOk = false
              }
            }
          }
          row.pads = padsOk
          row.padError = worst
          row.netsFile = netsOk

          // ---- needs against the census's rules ----
          const outline = outlineOf(board)
          row.outline = `${outline.status}/${outline.shape}/${outline.representable ? "fits" : "no"}`
          if (c) row.outlineCensus = `${c.outline.status}/${c.outline.shape}/${c.outline.representable ? "fits" : "no"}`
          const paths = countPaths(board.tree)
          // the census's rules count a zero margin as an override; switch 8 says it is none in a file up to stamp 20240201
          const mine = needsOf(board, { paths }, outline, { zeroMarginsAreOverrides: true })
          row.needs = mine.map((n) => n.ext)
          const actual = needsOf(board, { paths }, outline)
          row.needsActual = actual.map((n) => n.ext)
          row.switch8 = actual.some((n) => n.ext === "X7") !== row.needs.includes("X7")
          for (const f of board.footprints) {
            const plan = planModels(f)
            if (plan.kept) row.modelsKept++
            for (const d of plan.dropped) {
              const why = d.why.replace(/ \(the libraries were renamed.*$/, "").replace(/^KiCad's 3D library at release \S+ has no .*/, "not in the library at the release")
              row.modelsDropped[why] = (row.modelsDropped[why] ?? 0) + 1
            }
          }
          const sliceOnly = mine.filter((n) => n.source === "slices").map((n) => n.ext)
          if (c) {
            // The census refuses an outline that does not close; the founder's decision since is to import it, so it needs X2.
            const theirs = new Set([...censusNeeds(c).keys()].map((k) => (k === "REFUSED" ? (c.outline.status !== "closed" ? "X2" : "") : k)).filter(Boolean))
            row.censusNeeds = [...theirs].sort()
            row.needsMissing = [...theirs].filter((x) => !row.needs.includes(x)).sort()
            row.needsExtra = row.needs.filter((x) => !theirs.has(x)).sort()
            // an extension the importer found itself, on top of the census's, is named in the notes
            for (const n of mine) if (n.source === "importer" && theirs.has(n.ext) === false) row.notes.push(`${n.ext}: ${n.why}`)
            void sliceOnly
          }

          // ---- the importer, end to end ----
          const a0 = performance.now()
          const imported = importKicadBoard(new Uint8Array(data))
          row.ms.account = performance.now() - a0
          row.status = imported.status === "imported" ? "imported" : `refused:${imported.reason}`
          row.unknown = imported.report.account ? imported.report.account.unknownPaths.size + imported.report.account.unknownAtoms.size : 0
          if (imported.status === "refused" && imported.reason === "unsupported") {
            row.gateExact = JSON.stringify(imported.needs.map((n) => n.ext)) === JSON.stringify(row.needsActual.filter((x) => !BUILT_EXTENSIONS.has(x)))
          }
          if (imported.status === "refused") {
            row.messageNamed = imported.reason !== "unsupported" || /^This board uses .+, which (is|are) not supported yet\.$/.test(imported.message)
          } else row.messageNamed = true

          // ---- the project, built whatever the board needs, to measure it and to check pads and nets in it ----
          const b0 = performance.now()
          const forced: ImportReport = { entries: [], account: null }
          const built = buildKicadProject(board, outline, forced, { allowLossy: true })
          row.ms.build = performance.now() - b0
          row.buildOk = true
          row.lossy = built.lossy
          row.projectBytes = new TextEncoder().encode(serializeProject(built.project)).length
          if (c) {
            const count = (re: RegExp) =>
              Object.entries(c.nodes as Record<string, number>)
                .filter(([k]) => re.test(k.replace(/^module/, "footprint")))
                .reduce((sum, [, v]) => sum + v, 0)
            row.estBuilt = c.tracks.segments * 125 + c.tracks.vias * 80 + c.pads.total * 95 + (c.pads.flags["has-net"] ?? 0) * 170 + c.fps.total * 400
            row.estUnbuilt = c.tracks.arcs * 200 + count(/^(footprint>(fp_text|property)|gr_text)$/) * 90 + c.zones.vertices * 22
          }
          row.netsProject = forced.entries.some((e) => e.code === "net-mismatch") ? "fail" : forced.entries.some((e) => e.severity === "refused") ? "refused" : "ok"
          // pads in the project against the oracle: parts with a reference of their own, turned by a quarter turn
          const byRef = new Map<string, number>()
          for (const f of o) byRef.set(f.ref, (byRef.get(f.ref) ?? 0) + 1)
          let compared = 0
          let skipped = 0
          let fail = false
          for (const comp of built.project.components) {
            const f = o.find((q) => q.ref === comp.ref)
            if (!f || byRef.get(f.ref) !== 1 || f.angle % 90 !== 0 || f.pads.length === 0) {
              skipped++
              continue
            }
            const world = pcbPads(comp)
            // the project has a pad for every pad of the file that has copper or a hole; pads with no number are kept as holes
            if (world.length !== f.pads.length) {
              fail = true
              row.notes.push(`${comp.ref}: ${world.length} pads in the project, ${f.pads.length} in the file`)
              continue
            }
            for (let j = 0; j < world.length; j++) {
              // a trapezoid is placed by the middle of its outline, which is not its pad's position
              if (f.pads[j].shape === "trapezoid") continue
              compared++
              if (!near(world[j].x, f.pads[j].x) || !near(world[j].y, -f.pads[j].y)) {
                if (!fail) row.notes.push(`${comp.ref} pad ${j}: project (${world[j].x}, ${world[j].y}), file (${f.pads[j].x}, ${-f.pads[j].y}), footprint at ${f.angle}${f.bottom ? " bottom" : ""}`)
                fail = true
              }
              // the outline's extent, for the pads whose shape the project draws as the file does: quarter angles, no custom shape
              const box = f.pads[j].box
              const quarter = f.pads[j].angle % 90 === 0
              const hole = world[j].plated === false
              if (box && quarter && !hole && ["rect", "oval", "circle"].includes(f.pads[j].shape)) {
                row.boxChecked++
                if (!near(world[j].width, box.w) || !near(world[j].height, box.h)) {
                  row.boxWrong++
                  if (row.boxWrong === 1) row.notes.push(`${comp.ref} pad ${j}: project outline ${world[j].width} by ${world[j].height}, file ${box.w} by ${box.h}`)
                }
              }
            }
          }
          row.buildRefusals = [...new Set(forced.entries.filter((e) => e.severity === "refused").map((e) => e.code))]
          for (const code of row.buildRefusals) row.notes.push(`${code}: ${forced.entries.find((e) => e.code === code)!.why.slice(0, 200)}`)
          // nets, pad by pad: every numbered pad of a part with a reference of its own is on the project net that stands for the net the
          // oracle reads from the raw file. A net is identified by its raw name: each raw name has one project net, two raw names never
          // share one, a pad with no net is on none, and a name that needs no decoding is its own label's text.
          const { pinNet } = computeConnectivity(built.project)
          const projectOf = new Map<string, string>()
          const rawOf = new Map<string, string>()
          let wrong = 0
          for (const comp of built.project.components) {
            const f = o.find((q) => q.ref === comp.ref)
            if (!f || byRef.get(f.ref) !== 1) continue
            for (const p of f.pads) {
              if (!p.number || p.type === "np_thru_hole") continue
              row.netPadsChecked++
              const got = pinNet.get(pinKey(comp.id, p.number))
              let bad = false
              if (p.net === null) bad = got !== undefined
              else if (got === undefined) bad = true
              else {
                if (projectOf.has(p.net) && projectOf.get(p.net) !== got) bad = true
                if (rawOf.has(got) && rawOf.get(got) !== p.net) bad = true
                projectOf.set(p.net, got)
                rawOf.set(got, p.net)
                if (!/\{slash\}|^\s|\s$/.test(p.net) && got !== `net:${p.net}` && !/\{slash\}/.test(got)) bad = true
              }
              if (bad) wrong++
            }
          }
          row.netPadsWrong = wrong
          row.netPadsWrongX7 = row.needsActual.includes("X7") ? wrong : 0

          // ---- slice 1b-i: flags, net ties and the nets of copper, against the file read again ----
          const cu = copperOracle(text)
          const refCount = new Map<string, number>()
          for (const f of cu.footprints) refCount.set(f.ref, (refCount.get(f.ref) ?? 0) + 1)
          for (const comp of built.project.components) {
            if (comp.flags) row.flagged++
            if (comp.flags?.netTies?.length) row.tied++
            const f = cu.footprints.find((q) => q.ref === comp.ref)
            if (!f || refCount.get(f.ref) !== 1) continue
            const has = (a: string) => f.attr.includes(a)
            const legacyTie = cu.stamp !== null && cu.stamp <= 20220815 && f.tags.startsWith("net tie") && f.padNumbers.length > 0
            const expected = cleanFlags({
              mount: has("smd") ? "smd" : has("through_hole") || (!f.hasAttr && cu.stamp !== null && cu.stamp < 20200826) ? "through_hole" : undefined,
              virtual: has("virtual"),
              excludeFromBom: has("exclude_from_bom"),
              excludeFromPos: has("exclude_from_pos_files"),
              boardOnly: has("board_only"),
              dnp: has("dnp"),
              allowMissingCourtyard: has("allow_missing_courtyard"),
              allowMaskBridges: has("allow_soldermask_bridges"),
              jumperDuplicates: f.jumperDuplicates,
              netTies: [...f.ties, ...(legacyTie ? [f.padNumbers] : [])],
              jumperGroups: f.jumpers,
            })
            row.flagsChecked++
            if (JSON.stringify(comp.flags ?? null) !== JSON.stringify(expected ?? null)) {
              row.flagsWrong++
              if (row.flagsWrong === 1) row.notes.push(`${comp.ref}: flags ${JSON.stringify(comp.flags)} in the project, ${JSON.stringify(expected)} in the file`)
            }
          }
          // pins the file puts on no net are the no-connect pins of the part: every pad number that no pad of it gives a net, and no other
          for (const comp of built.project.components) {
            const f = o.find((q) => q.ref === comp.ref)
            if (!f || byRef.get(f.ref) !== 1) continue
            const numbers = [...new Set(f.pads.filter((p) => p.number && p.type !== "np_thru_hole").map((p) => p.number))]
            const expected = numbers.filter((n) => !f.pads.some((p) => p.number === n && p.net !== null)).sort((a, b) => a.localeCompare(b, "en", { numeric: true }))
            row.ncChecked++
            row.ncPins += comp.nc?.length ?? 0
            if (JSON.stringify(comp.nc ?? []) !== JSON.stringify(expected)) {
              row.ncWrong++
              if (row.ncWrong === 1) row.notes.push(`${comp.ref}: no-connect pins ${JSON.stringify(comp.nc)} in the project, ${JSON.stringify(expected)} in the file`)
            }
          }
          // copper: per net, the track length and the via count, and the locked lengths, project against file. A net's name in the project is the label text of its raw name.
          if (cu.segments.length + cu.vias.length > 0) {
            // (a board whose pads of one number sit on two nets has two raw names on one project net, which says nothing about a label)
            const text = (raw: string | null) => (raw === null ? "" : ((wrong === 0 ? projectOf.get(raw)?.slice(4) : undefined) ?? decodeNetName(raw).trim()))
            const fileLen = new Map<string, number>()
            const fileVias = new Map<string, number>()
            let fileLocked = 0
            for (const s of cu.segments) {
              if (s.layer !== board.copper.front && s.layer !== board.copper.back) continue
              fileLen.set(text(s.net), (fileLen.get(text(s.net)) ?? 0) + s.length)
              if (s.locked) fileLocked += s.length
            }
            for (const v of cu.vias) fileVias.set(text(v.net), (fileVias.get(text(v.net)) ?? 0) + 1)
            const projLen = new Map<string, number>()
            const projVias = new Map<string, number>()
            let projLocked = 0
            for (const t of built.project.traces) {
              let len = 0
              for (let i = 1; i < t.points.length; i++) len += Math.hypot(t.points[i].x - t.points[i - 1].x, t.points[i].y - t.points[i - 1].y)
              projLen.set(t.net ?? "", (projLen.get(t.net ?? "") ?? 0) + len)
              if (t.locked) projLocked += len
            }
            for (const v of built.project.vias) projVias.set(v.routedNet ?? "", (projVias.get(v.routedNet ?? "") ?? 0) + 1)
            const firstDiff = (a: Map<string, number>, b: Map<string, number>, eps: number) => [...new Set([...a.keys(), ...b.keys()])].find((k) => Math.abs((a.get(k) ?? 0) - (b.get(k) ?? 0)) > eps)
            const same = (a: Map<string, number>, b: Map<string, number>, eps: number) => firstDiff(a, b, eps) === undefined
            // a trace is rounded to the importer's 0.001 mm grid at each end, so a length may differ by a little per segment
            const eps = 0.002 * cu.segments.length + 1e-6
            row.copperNets = same(fileLen, projLen, eps) && same(fileVias, projVias, 0) ? "ok" : "fail"
            row.copperLocked = Math.abs(fileLocked - projLocked) <= eps
            if (row.copperNets === "fail") {
              const k = firstDiff(fileLen, projLen, eps) ?? firstDiff(fileVias, projVias, 0)
              row.notes.push(`copper nets differ at ${JSON.stringify(k)}: file ${fileLen.get(k!) ?? 0} mm and ${fileVias.get(k!) ?? 0} vias, project ${projLen.get(k!) ?? 0} mm and ${projVias.get(k!) ?? 0} vias`)
            }
          }
          row.copperMismatches = built.stats.copperNetMismatches
          const listed = forced.entries.find((e) => e.code === "copper-net-differs")
          row.mismatchListed = (listed?.items?.length ?? 0) === row.copperMismatches && (listed?.count ?? 0) === row.copperMismatches
          row.foldedPins = forced.entries.find((e) => e.code === "pin-type-folded")?.count ?? 0
          row.loneLabels = forced.entries.find((e) => e.code === "lone-labels-accepted")?.count ?? 0
          // ---- slice 1b-ii: every drawing, on the board and in footprints, against the raw file, by layer and to 0.001 mm ----
          const gfx = checkGraphics(text, built.project, built.lossy)
          row.gfxFile = gfx.file
          row.gfxProject = gfx.project
          row.gfxCounts = gfx.counts
          row.gfxWrong = gfx.wrong
          row.gfxLayers = gfx.layers
          row.gfxRoundTrip = roundTripOk(built.project)
          if (gfx.note) row.notes.push(gfx.note)
          row.padsProject = fail ? "fail" : compared ? "ok" : "none"
          row.padsProjectCompared = compared
          row.padsProjectSkipped = skipped
        } catch (e) {
          row.error = `${e instanceof Error ? (e.stack ?? e.message) : e}`.slice(0, 400)
          row.status = "CRASH"
        }
        row.ms.total = performance.now() - start
      }
      mkdirSync(OUT, { recursive: true })
      writeFileSync(join(OUT, "rows.json"), JSON.stringify(rows))
      writeFileSync(join(OUT, "table.md"), summarize(rows, (Date.now() - t0) / 1000))
      console.log(summarize(rows, (Date.now() - t0) / 1000))

      const bad = rows.filter((r) => r.status === "CRASH" || r.status.startsWith("FAIL"))
      expect(bad.map((r) => `${r.file}: ${r.error}`)).toEqual([])
      expect(rows.filter((r) => !r.file.endsWith(".brd") && r.status !== "refused:unreadable" && !(r.parse && r.nodes && r.counts)).map((r) => r.file)).toEqual([])
      // slice 1b-i: flags, no-connect pins and the nets of copper equal the file's everywhere, every mismatch is listed, and the gate names only what is not built
      // slice 1b-ii: every drawing of the file is in the project, on its layer, to 0.001 mm
      expect(rows.filter((r) => !r.gfxCounts || r.gfxWrong > 0 || !r.gfxRoundTrip).map((r) => `${r.file}: ${r.notes.find((n) => n.startsWith("drawings"))}`)).toEqual([])
      expect(rows.filter((r) => r.flagsWrong > 0 || r.ncWrong > 0 || r.copperNets === "fail" || !r.copperLocked || !r.mismatchListed || !r.gateExact).map((r) => r.file)).toEqual([])
    },
    3_600_000,
  )
})

function summarize(rows: Row[], seconds: number): string {
  const groups = ["pcbench", "github", "kicad-demos", "github-targeted", "kicad-qa"]
  const lines: string[] = []
  const board = rows.filter((r) => !r.file.endsWith(".brd"))
  const legacy = rows.filter((r) => r.file.endsWith(".brd"))
  const count = (rs: Row[], f: (r: Row) => boolean) => rs.filter(f).length
  lines.push(`corpus run: ${rows.length} files (${board.length} boards, ${legacy.length} legacy .brd) in ${seconds.toFixed(0)} s`)
  lines.push("")
  lines.push("| check | " + groups.map((g) => `${g} (${count(board, (r) => r.group === g)})`).join(" | ") + " | all |")
  lines.push("|---|" + [...groups, "all"].map(() => "---|").join(""))
  const cols: [string, (r: Row) => boolean][] = [
    ["reader parses", (r) => r.parse],
    ["node counts equal the census", (r) => r.nodes],
    ["object counts equal the census", (r) => r.counts],
    ["unknown nodes or atoms: none", (r) => r.unknown === 0],
    ["pad nets equal the file's (oracle)", (r) => r.netsFile],
    ["pad positions within 0.001 mm (oracle)", (r) => r.pads],
    ["project pad positions within 0.001 mm", (r) => r.padsProject !== "fail"],
    ["project nets equal the file's (internal check)", (r) => r.netsProject !== "fail"],
    ["project pads on the oracle's nets, pad by pad (a board that needs X7 for pads of one number may differ)", (r) => r.netPadsWrong === 0 || r.needsActual.includes("X7")],
    ["project pad outlines within 0.001 mm of the oracle's", (r) => r.boxWrong === 0],
    ["flags and net ties equal the file's, footprint by footprint (oracle)", (r) => r.flagsWrong === 0],
    ["no-connect pins are the pins the file gives no net, footprint by footprint (oracle)", (r) => r.ncWrong === 0],
    ["track length, via count and locked length per net equal the file's (oracle)", (r) => r.copperNets !== "fail" && r.copperLocked],
    ["every copper net mismatch is listed by item in the report", (r) => r.mismatchListed],
    ["outline: same status, shape and fit as the census's (which allowed 1 % and 0.5 % of slack)", (r) => r.outline === r.outlineCensus],
    ["needs: nothing the census found is missing", (r) => r.needsMissing.length === 0],
    ["needs: nothing beyond the census's", (r) => r.needsExtra.length === 0],
    ["refusal message names the cause", (r) => r.messageNamed],
    ["the gate names exactly the needs that are not built (X13 and X15 are built and never named)", (r) => r.gateExact],
    ["drawings: the same count on every layer as the file's (oracle)", (r) => r.gfxCounts],
    ["drawings: every drawing of the file in the project within 0.001 mm (oracle)", (r) => r.gfxWrong === 0],
    ["drawings: a save and a load give the same drawings in memory (stored form)", (r) => r.gfxRoundTrip],
    ["no crash", (r) => r.status !== "CRASH"],
  ]
  for (const [label, f] of cols) {
    lines.push(`| ${label} | ` + [...groups.map((g) => board.filter((r) => r.group === g)), board].map((rs) => `${count(rs, f)}/${rs.length}`).join(" | ") + " |")
  }
  lines.push("")
  const status = new Map<string, number>()
  for (const r of board) status.set(r.status, (status.get(r.status) ?? 0) + 1)
  lines.push(`outcome of the importer: ${[...status].map(([k, v]) => `${k} ${v}`).join(", ")}`)
  const refusalCodes = new Map<string, number>()
  for (const r of board) for (const c of r.buildRefusals) refusalCodes.set(c, (refusalCodes.get(c) ?? 0) + 1)
  lines.push(`pads checked against the oracle's nets: ${board.reduce((n, r) => n + r.netPadsChecked, 0)}, wrong: ${board.reduce((n, r) => n + r.netPadsWrong, 0)} (on boards that need no X7: ${board.filter((r) => !r.needsActual.includes("X7")).reduce((n, r) => n + r.netPadsWrong, 0)}); pad outlines checked: ${board.reduce((n, r) => n + r.boxChecked, 0)}, wrong: ${board.reduce((n, r) => n + r.boxWrong, 0)}`)
  lines.push(`boards whose project build raised a refusal: ${[...refusalCodes].map(([k, v]) => `${k} ${v}`).join(", ") || "none"}`)
  lines.push(
    `flags: ${board.reduce((n, r) => n + r.flagsChecked, 0)} footprints checked against the file, ${board.reduce((n, r) => n + r.flagsWrong, 0)} wrong; ${board.reduce((n, r) => n + r.flagged, 0)} footprints carry a flag, ${board.reduce((n, r) => n + r.tied, 0)} a net tie (in ${count(board, (r) => r.tied > 0)} boards)`,
  )
  lines.push(`no-connect pins (pads with no net in the file): ${board.reduce((n, r) => n + r.ncPins, 0)} on ${count(board, (r) => r.ncPins > 0)} boards, ${board.reduce((n, r) => n + r.ncChecked, 0)} footprints checked against the file, ${board.reduce((n, r) => n + r.ncWrong, 0)} wrong`)
  lines.push(
    `copper nets: ${count(board, (r) => r.copperNets === "ok")} boards agree with the file, ${count(board, (r) => r.copperNets === "fail")} differ, ${count(board, (r) => r.copperNets === "none")} have no copper; the editor derives another net for an item on ${count(board, (r) => r.copperMismatches > 0)} boards (${board.reduce((n, r) => n + r.copperMismatches, 0)} items, reported by item)`,
  )
  // Copper mismatches where the editor holds the geometry: real boards (pcbench, github, demos) with copper whose importer needs, after X13 and X15, include none of the listed extensions.
  const holds = (without: string[]) => board.filter((r) => ["pcbench", "github", "kicad-demos"].includes(r.group) && r.copperNets !== "none" && !r.needsActual.some((x) => without.includes(x)))
  for (const without of [["X1", "X2", "X4", "X5", "X6", "X7"], ["X1", "X2", "X3", "X4", "X5", "X6", "X7"]]) {
    const rs = holds(without)
    lines.push(`copper mismatches on real boards with copper that need none of ${without.join(", ")}: ${rs.length} boards, ${count(rs, (r) => r.copperMismatches > 0)} with an item the editor derives another net for, ${rs.reduce((n, r) => n + r.copperMismatches, 0)} items`)
  }
  const layerTotals = new Map<string, number>()
  for (const r of board) for (const [k, v] of Object.entries(r.gfxLayers)) layerTotals.set(k, (layerTotals.get(k) ?? 0) + v)
  lines.push(`drawings: ${board.reduce((n, r) => n + r.gfxFile, 0)} in the files (board, footprints, targets as three), ${board.reduce((n, r) => n + r.gfxProject, 0)} in the projects, on ${count(board, (r) => r.gfxFile > 0)} boards; ${board.reduce((n, r) => n + r.gfxWrong, 0)} not matched to 0.001 mm. By layer: ${[...layerTotals].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(", ")}`)
  lines.push(`pins whose KiCad type was folded into a role: ${board.reduce((n, r) => n + r.foldedPins, 0)} on ${count(board, (r) => r.foldedPins > 0)} boards; single-pad nets accepted in Checks: ${board.reduce((n, r) => n + r.loneLabels, 0)} on ${count(board, (r) => r.loneLabels > 0)} boards`)
  const realRows = board.filter((r) => ["pcbench", "github", "kicad-demos"].includes(r.group))
  const exts = [...new Set(board.flatMap((r) => [...r.censusNeeds, ...r.needsActual]))].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)))
  lines.push("")
  lines.push(`needs of the ${realRows.length} real boards, the census's rules against the importer's (the importer reads a zero margin in an old file as no setting, and finds what the census's rules do not list):`)
  lines.push("")
  lines.push("| extension | census | importer |")
  lines.push("|---|---|---|")
  for (const x of exts) lines.push(`| ${x} | ${realRows.filter((r) => r.censusNeeds.includes(x)).length} | ${realRows.filter((r) => r.needsActual.includes(x)).length} |`)
  const dropped = new Map<string, number>()
  for (const r of board) for (const [k, v] of Object.entries(r.modelsDropped)) dropped.set(k, (dropped.get(k) ?? 0) + v)
  lines.push("")
  lines.push(`3D models: ${board.reduce((n, r) => n + r.modelsKept, 0)} footprints hold one; not held, by reason: ${[...dropped].map(([k, v]) => `${v} ${k}`).join("; ") || "none"}`)
  const outlineDiffs = new Map<string, number>()
  for (const r of board) if (r.outline !== r.outlineCensus) outlineDiffs.set(`${r.outlineCensus} became ${r.outline}`, (outlineDiffs.get(`${r.outlineCensus} became ${r.outline}`) ?? 0) + 1)
  lines.push(`outlines that differ from the census's: ${[...outlineDiffs].map(([k, v]) => `${k} ${v}`).join("; ") || "none"}`)
  lines.push(`switch 8 (a zero margin in a file up to stamp 20240201 inherits): ${count(board, (r) => r.switch8)} boards need X7 by the census's rule and not by this one`)
  lines.push(`legacy .brd: ${count(legacy, (r) => r.messageNamed)}/${legacy.length} refused with a message naming the version`)
  const slow = [...rows].sort((a, b) => b.ms.total - a.ms.total).slice(0, 3)
  lines.push(`slowest: ${slow.map((r) => `${r.file.split("/").pop()} ${(r.ms.total / 1000).toFixed(1)} s`).join(", ")}`)
  const sizes = board.filter((r) => r.buildOk).map((r) => r.projectBytes).sort((a, b) => a - b)
  const q = (p: number) => sizes[Math.min(sizes.length - 1, Math.floor(p * sizes.length))] ?? 0
  const real = board.filter((r) => ["pcbench", "github", "kicad-demos"].includes(r.group) && r.buildOk && r.estBuilt > 0)
  const ratio = real.map((r) => r.projectBytes / r.estBuilt).sort((a, b) => a - b)
  const rq = (p: number) => ratio[Math.min(ratio.length - 1, Math.floor(p * ratio.length))] ?? 0
  const totals = real.map((r) => r.projectBytes + r.estUnbuilt).sort((a, b) => a - b)
  const tq = (p: number) => totals[Math.min(totals.length - 1, Math.floor(p * totals.length))] ?? 0
  const cap = 900 * 1024
  lines.push(`real boards (${real.length}): measured / estimated for what 1b-ii builds: median ${rq(0.5).toFixed(2)}, p10 ${rq(0.1).toFixed(2)}, p90 ${rq(0.9).toFixed(2)}`)
  lines.push(`real boards: measured 1b-ii project plus the estimate for what is not built yet (text, zone outlines): median ${(tq(0.5) / 1024).toFixed(0)} KB, p90 ${(tq(0.9) / 1024).toFixed(0)} KB, p99 ${(tq(0.99) / 1024).toFixed(0)} KB, largest ${((totals[totals.length - 1] ?? 0) / 1024).toFixed(0)} KB; over 900 KB: ${totals.filter((t) => t > cap).length}; measured 1b-ii part alone over 900 KB: ${real.filter((r) => r.projectBytes > cap).length}; the old estimate said ${real.filter((r) => r.estBuilt + r.estUnbuilt > cap).length}`)
  lines.push(`measured project size (what slice 1b-ii builds): median ${(q(0.5) / 1024).toFixed(0)} KB, p90 ${(q(0.9) / 1024).toFixed(0)} KB, p99 ${(q(0.99) / 1024).toFixed(0)} KB, largest ${((sizes[sizes.length - 1] ?? 0) / 1024).toFixed(0)} KB; over 900 KB: ${sizes.filter((s) => s > 900 * 1024).length}`)
  return lines.join("\n")
}

// Boards of the corpus that the round-1 fixes name, each read for the one thing it shows.
describe.skipIf(!CORPUS)("boards the fixes were made for", () => {
  const board = (rel: string) => readKicadBoard(new Uint8Array(readFileSync(join(CORPUS!, rel)))).board

  it("B5: the same board saved by KiCad 10 and by the development version has the same text angles and positions", () => {
    const a = board("kicad-source/qa/data/pcbnew/connect/connect.kicad_pcb")
    const b = board("kicad-source/qa/data/pcbnew/odbpp/pad_backdrill.kicad_pcb")
    expect([a.version, b.version]).toEqual([20260206, 20260901])
    const texts = (fps: typeof a.footprints) => new Map(fps.flatMap((f) => f.texts.filter((t) => t.kind === "reference" || t.kind === "value").map((t) => [`${f.ref}|${t.kind}`, t] as const)))
    const ta = texts(a.footprints)
    const tb = texts(b.footprints)
    expect(ta.get("D513|reference")).toMatchObject({ angle: 90, at: { x: -0.21, y: -2.39 } })
    expect(tb.get("D513|reference")).toMatchObject({ angle: 90, at: { x: -0.21, y: -2.39 } })
    let compared = 0
    for (const [ref, t] of ta) {
      const u = tb.get(ref)
      if (!u) continue
      compared++
      // the development version writes an angle between -180 and 180, the older one between 0 and 360: the same angle
      const turn = (a: number) => ((a % 360) + 360) % 360
      expect([ref, turn(u.angle), u.at.x, u.at.y]).toEqual([ref, turn(t.angle), t.at.x, t.at.y])
    }
    expect(compared).toBeGreaterThan(100)
  })

  it("B5: in the development files a text sits at its footprint's angle or at 0, so the angle is the board-frame one (not relative to it)", () => {
    let atFootprint = 0
    let atZero = 0
    let other = 0
    for (const path of walk(CORPUS!)) {
      if (!path.endsWith(".kicad_pcb")) continue
      const head = readFileSync(path, "utf8").slice(0, 300)
      const stamp = Number(/\(version (\d+)\)/.exec(head)?.[1] ?? 0)
      if (stamp < 20260616) continue
      for (const f of readKicadBoard(readFileSync(path, "utf8")).board.footprints) {
        for (const t of f.texts) {
          const off = (((t.angle - f.angle) % 360) + 360) % 360
          if (off === 0) atFootprint++
          else if (t.angle === 0) atZero++
          else other++
        }
      }
    }
    expect(atFootprint).toBeGreaterThan(20 * atZero)
    expect(atFootprint).toBeGreaterThan(20 * other)
  })

  it("B4: boards whose four quarter arcs bend into the board are arcs, not rounded rectangles", () => {
    for (const rel of ["pcbench/PCBs/BirthdayCakeKeyboard_10Key/raw.kicad_pcb", "projects/galopago__rak4200-lora-adaptable-node/RAK4200_LORA_ADAPTABLE_NODE.kicad_pcb", "projects/galopago__rak811-lora-adaptable-node/RAK811_LORA_ADAPTABLE_NODE.kicad_pcb"]) {
      const o = outlineOf(board(rel))
      expect([rel, o.shape, o.representable]).toEqual([rel, "arcs", false])
    }
  })

  it("m3: a rounded rectangle whose arcs sit 0.117 mm off is not one", () => {
    for (const rel of ["projects/microphonon__acoustic-leak-detector/KiCAD/48-pin/48pin.kicad_pcb", "projects/microphonon__acoustic-leak-detector/KiCAD/64-pin/64pin.kicad_pcb"]) {
      expect(outlineOf(board(rel)).representable, rel).toBe(false)
    }
  })

  it("B1: the pads the critic named need X7 for their layers", () => {
    const x7 = (rel: string) => needsOf(board(rel), { paths: countPaths(board(rel).tree) }, outlineOf(board(rel))).some((n) => n.ext === "X7")
    expect(x7("pcbench/PCBs/filament_extruder_sensor/raw.kicad_pcb")).toBe(true)
    expect(x7("pcbench/PCBs/tiny-8088_Computer/raw.kicad_pcb")).toBe(true)
  })
})
