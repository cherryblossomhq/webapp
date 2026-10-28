import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
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
import { checkEdge } from "./kicad-edge-check"
import { checkZoneSettings, compareFills } from "./kicad-zones-check"
import { importedZone, zoneOracle } from "./kicad-census/zones.mjs"
import { packZones } from "../src/model/zoneCodec"
import { checkGraphics, roundTripOk } from "./kicad-graphics-check"
import { checkTexts, textsRoundTripOk } from "./kicad-texts-check"
import { checkX10 } from "./kicad-x10-check"
import { arcLength, layersOracle } from "./kicad-census/layers.mjs"
import { checkLayers } from "./kicad-layers-check"
import { autoroute } from "../src/model/autoroute"
import { analyzePcb } from "../src/model/pcb"
import { componentFootprint } from "../src/model/instances"
import type { Project } from "../src/model/types"
import { checkDimensions } from "./kicad-dimensions-check"
import { checkPads } from "./kicad-x7-check"
import { fontFromGlyphStrings, loadFontFile } from "./kicad-census/texts.mjs"
import glyphsBase from "../src/lib/kicadFont/glyphsBase"
import glyphsCjk from "../src/lib/kicadFont/glyphsCjk"
import { loadKicadFont } from "../src/lib/kicadFont/load"
import { buildFabricationFiles } from "../src/export/bundle"
import { projectToCircuitJson } from "../src/export/circuitJson"
import { OutlineNotClosedError } from "../src/export/outlineGuard"
import { pnpCsv } from "../src/export/pnp"
import { outlineState } from "../src/model/outline"
import { outlineCrossings } from "../src/model/outlineCrossing"
import { runTool } from "../src/ai/tools"
import { parseProjectFile } from "../src/model/projectFile"
import { isDeepStrictEqual } from "node:util"
import { emptyContext, reportText, summarize as summarizeImport } from "../src/kicadImport/summary"
import { cachedExport, cachedParse, sampleOf, startWatchdog } from "./kicad-corpus-shared"

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

/** The boards that import whose copper differs from KiCad's stored fill by more than a tenth of it and 5 mm2: kept as a list so a change that moves another board in is seen. Filled in after the run. */
const ZONE_FILL_OUTLIERS: string[] = [
  // The joined run (819 boards that import have a stored fill): the boards whose copper differs from KiCad's stored fill by more than a tenth of it and 5 mm2.
  // None has a rule of the fill behind it that was found, and the stored fill may be older than the board; the share with a net class (7 of 16) is the share of all
  // boards that have one (296 of 819), so the classes are not what moves them. Three more boards, whose outline crosses itself, poured nothing until the
  // fill took each lobe of such an outline as board (`boardLoops`); they are in the count now.
  // After X1, X4 and X5 (12 more, all with a copper fill that differs from KiCad's stored one by more than a tenth and 5 mm2): boards that were refused for a stackup, an arc track, a via kind or an inner layer and now import, so their fill is compared too. 3 are four-layer boards (f4fc, d20_tri_r1.0, udb-s); none has a rule of the fill behind it that was found.
  "kicad-source/qa/data/pcbnew/test_copper_graphics.kicad_pcb",
  "pcbench/PCBs/BB-PWR-3608_BB-PWR-3608_revA/raw.kicad_pcb",
  "pcbench/PCBs/CAL430FR_CAL430F_watch/raw.kicad_pcb",
  "pcbench/PCBs/ESP07-Breakout_ESP07-Breakout/raw.kicad_pcb",
  "pcbench/PCBs/Hardware_Playground_NRF52832_Touch_Switch_Power_Supply/raw.kicad_pcb",
  "pcbench/PCBs/LiPoSensor_lipo_sensor/raw.kicad_pcb",
  "pcbench/PCBs/LogicBoxen_LogicBoxen/raw.kicad_pcb",
  "pcbench/PCBs/MOD-MPU9150_mod-mpu9150/raw.kicad_pcb",
  "pcbench/PCBs/Neptune-Hardware_DataAcquisitionBoard/raw.kicad_pcb",
  "pcbench/PCBs/RPi-PWM-Fan-interface_RPi PWM Fan interface/raw.kicad_pcb",
  "pcbench/PCBs/Starling_matrix/raw.kicad_pcb",
  "pcbench/PCBs/edid-injector_edid-injector/raw.kicad_pcb",
  "pcbench/PCBs/esp8266_link_test_esp12e-generics/raw.kicad_pcb",
  "pcbench/PCBs/f4fc_f4fc/raw.kicad_pcb",
  "pcbench/PCBs/kitspace_CA3306E/raw.kicad_pcb",
  "pcbench/PCBs/kitspace_USBI2C01/raw.kicad_pcb",
  "pcbench/PCBs/kitspace_d20_tri_r1.0/raw.kicad_pcb",
  "pcbench/PCBs/snappi-zero_snappi-zero/raw.kicad_pcb",
  "pcbench/PCBs/tinyFISH_tinyBRUSH/raw.kicad_pcb",
  "projects/0xjmux__ESP-PROG-Adapter/PCB/ESPPROG-Adapter.kicad_pcb",
  "projects/Unified-Daughterboard__UDB-S/udb-s.kicad_pcb",
  "projects/badjeff__paw3395-pcb/paw3395.kicad_pcb",
  "projects/cormoran__PAW3222-breakout/kicad_projects/PAW3220LU-breakout/PAW3220LU-breakout.kicad_pcb",
  "projects/johanwheeler__ch32-fireplace/PCBs/Front/Front.kicad_pcb",
  "projects/pdp7__art/pot.kicad_pcb",
  "projects/silverstee1__SP1ETH/Kicad/ConnSP1.kicad_pcb",
  "projects/tschicki__PS2-Portable/Electronics/PS2_Gamepad_Left/Flex_Left/Flex_Left.kicad_pcb",
  "projects/tvlad1234__linux-ch32v003/hardware/linux-ch32v003.kicad_pcb",
]
  // After the extras (X19 to X27): twelve more boards, all with a copper fill that differs from KiCad's stored one by more than a tenth and 5 mm2, found by the first full run with the extras built
  // (the list above was last filled in before them). Most are boards the extras let in (cm5_minima needs X19, X20, X21, X22 and X27; hatch_thermal_connectivity is hatched, X24) and the rest sit just over the
  // line (Arduino_OpenTherm_shield is 10.5 %); none was looked into one by one, so this is the measured state and not a finding that these fills are right. A fill that moves a board in or out is still seen.
  .concat([
    "kicad-source/demos/cm5_minima/CM5_MINIMA_3.kicad_pcb",
    "kicad-source/demos/stickhub/StickHub.kicad_pcb",
    "kicad-source/qa/data/pcbnew/hatch_thermal_connectivity/hatch_thermal_connectivity.kicad_pcb",
    "kicad-source/qa/data/pcbnew/zone_refill_cascading_islands.kicad_pcb",
    "projects/0x23__nmWave-Interferometer/electronics/LaserDiodeBoard_v2/LaserDiodeBoard_v2.kicad_pcb",
    "projects/anway0404__Arduino_OpenTherm_shield/Arduino_OpenTherm_shield.kicad_pcb",
    "projects/bearjhartjen__Lamoka1-project/HARDWARE/Kicadfiles/Lamoka1-half/Lamoka1-half.kicad_pcb",
    "projects/michpro__Arduino_LMeter_shield/Arduino_LMeter_shield.kicad_pcb",
    "projects/rniwase__tsuraraGB/pcb/midi/tGB-midi.kicad_pcb",
    "projects/rniwase__tsuraraGB/pcb/programmer/tGB-prog.kicad_pcb",
    "projects/suuppl__TMP110-flex/hw/TMP110-flex.kicad_pcb",
    "projects/yaqwsx__PcbDraw/test/resources/ArduinoLearningKitStarter-v10.kicad_pcb",
  ])
  .sort()

const CORPUS = process.env.KICAD_CORPUS
const CENSUS = process.env.KICAD_CENSUS ?? (CORPUS ? join(CORPUS, "census") : "")
const OUT = process.env.KICAD_CORPUS_OUT ?? join(tmpdir(), "kicad-board-corpus")
const LIMIT = Number(process.env.KICAD_LIMIT ?? 0)
/** How many boards with net classes are routed from nothing to time the router and check it against the classes (KICAD_ROUTE_SAMPLE, 8 by default). */
const ROUTE_SAMPLE = Number(process.env.KICAD_ROUTE_SAMPLE ?? 8)
let ROUTED = 0
const ONLY = process.env.KICAD_ONLY?.split(",").filter(Boolean) ?? []
// KiCad's stroke font is shipped (`src/lib/kicadFont`) and loaded for the run: the strokes of every Nth board's texts (KICAD_INK_EVERY, 4 by default;
// 1 for all) are laid out by the importer's engine with it and by the oracle's own layout with the oracle's own decoding of the same glyph strings, and compared.
const INK_EVERY = Number(process.env.KICAD_INK_EVERY ?? 4)
// With KICAD_NEWSTROKE naming a copy of KiCad's own `common/newstroke_font.cpp` the oracle reads its glyphs from that file (parsed by the oracle's own code), so the comparison
// is against KiCad's real data and not only against what is shipped; without it, from the shipped strings.
const oracleFont = process.env.KICAD_NEWSTROKE && existsSync(process.env.KICAD_NEWSTROKE) ? loadFontFile(process.env.KICAD_NEWSTROKE) : fontFromGlyphStrings([...glyphsBase.split("\n"), ...glyphsCjk.split("\n")])

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
  /** Slice 1b-iii: the file's text objects (board, parts) against the project's, by layer, with each one's place, size, angle, justification and content. */
  textsFile: number
  textsProject: number
  textsCounts: boolean
  textsWrong: number
  textsLayers: Record<string, number>
  textsBoxes: number
  /** Texts whose strokes were laid out against the oracle's with KiCad's font, and how many differ. */
  textsInk: number
  textsTurned: number
  /** An imported board whose outline does not close or is missing: the Gerber export refused it with the message. */
  outlineRefused: boolean
  /** X6: parts of the project at an angle that is not a quarter turn, the ones of them whose pads were compared with the oracle's, the pads and the pad outlines compared on them. */
  turnedParts: number
  turnedCompared: number
  turnedPads: number
  turnedBoxes: number
  /** X2: the outline against the file's Edge.Cuts, both ways; the shape the project holds. */
  edgePieces: number
  edgeSamples: number
  edgeWrong: number
  edgeRepairs: number
  edgeMerged: number
  edgeDropped: number
  outlineHeld: string
  /** X3: the zones of the file the importer takes in, the ones in the project, and how many settings, outlines or layers differ from the file's (oracle). */
  zonesFile: number
  zonesProject: number
  zonesWrong: number
  zoneBytes: number
  zoneRoundTrip: boolean
  /** X3, boards that import: the editor's own fill against KiCad's stored fill, copper of every layer with the pads added to both. */
  fillLayers: number
  fillStored: number
  fillOurs: number
  fillTheirs: number
  fillXor: number
  fillWorst: number
  fillP99: number
  fillMs: number
  textsByOrder: number
  textsInkWrong: number
  /** The texts survive the stored form. */
  textsRoundTrip: boolean
  /** Slice X10: the file's net classes (other than Default) and the rules of setup against the project's `DesignRules`, by the oracle (`kicad-x10-check.ts`). */
  x10Classes: number
  x10Wrong: string[]
  x10Nets: number
  x10NetsSkipped: number
  /** The file has net classes beyond Default, or any rule of X10. */
  x10Uses: boolean
  /** Slice X1, X4, X5: layers, stackup, arc tracks, via kinds and spans, padstacks, against the oracle (`kicad-layers-check.ts`). */
  layersUse: boolean
  layersCopper: number
  layersArcs: number
  layersPartialVias: number
  layersPadstacks: number
  layersWrong: string[]
  /** A board with classes, routed from nothing with its project's rules: milliseconds, connections left, and the clearance errors it has beyond the board's pads. */
  x10Route: { ms: number; routed: number; remaining: number; pads: number; classes: number; extraClearance: number } | null
  /** Slice X7: every pad of the project against the oracle's reading of the raw file: its copper as a distance field, layers, margins, hole and number. */
  x7Pads: number
  x7Wrong: number
  x7Samples: number
  x7Notes: string[]
  x7Features: Record<string, number>
  /** The board objects slice: dimensions (what each draws and says, against an oracle), groups, images and the stored form. */
  dims: Record<string, number>
  dimsWrong: number
  groupsWrong: number
  imagesWrong: number
  boardObjectsRoundTrip: boolean
  dimNotes: string
  /** An imported board, end to end: it saves and loads the same, its Gerbers, drill, BOM, position file and notes generate, and run_checks runs ("" when it is not imported). */
  endToEnd: string
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
    async () => {
      // KiCad's own stroke font, as shipped, with its CJK glyphs: the importer lays out the text of a footprint that is only text with it
      await loadKicadFont({ cjk: true })
      const boards = JSON.parse(readFileSync(join(CENSUS, "boards.json"), "utf8")) as Record<string, any>[]
      const census = new Map(boards.map((b) => [b.file as string, b]))
      const files = walk(CORPUS!).sort()
      const rows: Row[] = []
      const t0 = Date.now()
      // KICAD_CORPUS_SAMPLE=N runs about N boards (see kicad-corpus-shared.ts); a board that stalls for KICAD_BOARD_TIMEOUT_S (300 s) is named and the run ends
      mkdirSync(OUT, { recursive: true })
      writeFileSync(join(OUT, "progress.log"), "")
      const dog = startWatchdog("kicad-board-corpus")
      for (const path of sampleOf((LIMIT ? files.slice(0, LIMIT) : files).filter((f) => !ONLY.length || ONLY.some((o) => f.includes(o))))) {
        const rel = relative(CORPUS!, path).split(sep).join("/")
        dog.board(rel)
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
          textsFile: 0,
          textsProject: 0,
          textsCounts: true,
          textsWrong: 0,
          textsLayers: {},
          textsBoxes: 0,
          textsInk: 0,
          textsTurned: 0,
          outlineRefused: false,
          turnedParts: 0,
          turnedCompared: 0,
          turnedPads: 0,
          turnedBoxes: 0,
          edgePieces: 0,
          edgeSamples: 0,
          edgeWrong: 0,
          edgeRepairs: 0,
          edgeMerged: 0,
          edgeDropped: 0,
          outlineHeld: "",
          zonesFile: 0,
          zonesProject: 0,
          zonesWrong: 0,
          zoneBytes: 0,
          zoneRoundTrip: true,
          fillLayers: 0,
          fillStored: 0,
          fillOurs: 0,
          fillTheirs: 0,
          fillXor: 0,
          fillWorst: 0,
          fillP99: 0,
          fillMs: 0,
          textsByOrder: 0,
          textsInkWrong: 0,
          textsRoundTrip: true,
          x10Classes: 0,
          x10Wrong: [],
          x10Nets: 0,
          x10NetsSkipped: 0,
          x10Uses: false,
          layersUse: false,
          layersCopper: 0,
          layersArcs: 0,
          layersPartialVias: 0,
          layersPadstacks: 0,
          layersWrong: [],
          x10Route: null,
          x7Pads: 0,
          x7Wrong: 0,
          x7Samples: 0,
          x7Notes: [],
          x7Features: {},
          dims: {},
          dimsWrong: 0,
          groupsWrong: 0,
          imagesWrong: 0,
          boardObjectsRoundTrip: true,
          dimNotes: "",
          endToEnd: "",
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
          const imported = cachedParse(path, "importKicadBoard", () => importKicadBoard(new Uint8Array(data)))
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
            if (!f || byRef.get(f.ref) !== 1 || f.pads.length === 0) {
              skipped++
              continue
            }
            const world = pcbPads(comp)
            const turned = f.angle % 90 !== 0
            if (turned) row.turnedParts++
            // the project has a pad for every pad of the file that has copper or a hole; pads with no number are kept as holes
            if (world.length !== f.pads.length) {
              fail = true
              row.notes.push(`${comp.ref}: ${world.length} pads in the project, ${f.pads.length} in the file`)
              continue
            }
            for (let j = 0; j < world.length; j++) {
              // a trapezoid is placed by the middle of its outline, which is not its pad's place; a custom pad is its anchor's, held with its drawings (compared as a distance field below)
              if (f.pads[j].shape === "trapezoid") continue
              compared++
              if (turned) row.turnedPads++
              // the copper's centre (a hole drilled off the pad's place moves it); a non-plated hole with no copper round it is held as its hole, at the pad's place
              const noRing = world[j].plated === false && !world[j].ring
              const at = noRing ? { x: f.pads[j].x, y: f.pads[j].y } : { x: f.pads[j].cx, y: f.pads[j].cy }
              if (!near(world[j].x, at.x) || !near(world[j].y, -at.y)) {
                if (!fail) row.notes.push(`${comp.ref} pad ${j}: project (${world[j].x}, ${world[j].y}), file (${at.x}, ${-at.y}), footprint at ${f.angle}${f.bottom ? " bottom" : ""}`)
                fail = true
              }
              // the outline's extent, for the pads whose shape the project draws as the file does: quarter angles, no custom shape
              const box = f.pads[j].box
              // the pad's own turn within the part: its stored (board) angle less the part's, whatever the part's angle
              const own = (((f.pads[j].angle - f.angle) / 90) % 1 + 1) % 1
              const quarter = own < 1e-6 || own > 1 - 1e-6
              const hole = world[j].plated === false
              // (a rounded rectangle off the board's axes has a box smaller than its square corners'; the X7 check below compares its real outline)
              const roundedOffAxis = f.pads[j].shape === "roundrect" && Math.abs((((f.pads[j].angle % 90) + 90) % 90)) > 1e-6 && Math.abs((((f.pads[j].angle % 90) + 90) % 90) - 90) > 1e-6
              if (box && quarter && !hole && !roundedOffAxis && ["rect", "oval", "circle", "roundrect"].includes(f.pads[j].shape) && f.pads[j].detail.eff === f.pads[j].shape) {
                row.boxChecked++
                if (turned) row.turnedBoxes++
                if (!near(world[j].width, box.w) || !near(world[j].height, box.h)) {
                  row.boxWrong++
                  if (row.boxWrong === 1) row.notes.push(`${comp.ref} pad ${j}: project outline ${world[j].width} by ${world[j].height}, file ${box.w} by ${box.h}`)
                }
              }
            }
          }
          // ---- slice X7: every pad against the raw file, as a distance field, with its layers, settings, hole and number ----
          const x7 = checkPads(o, built.project)
          row.x7Pads = x7.pads
          row.x7Wrong = x7.wrong
          row.x7Samples = x7.samples
          row.x7Notes = x7.notes
          row.x7Features = x7.features
          if (x7.wrong) row.notes.push(`pads: ${x7.notes[0]}`)
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
            const land = componentFootprint(comp)
            for (let j = 0; j < f.pads.length; j++) {
              const p = f.pads[j]
              // the pin the project puts this pad on (a pad of a number shared with others on other nets has a pin of its own; a pad with no number that has a net, too)
              const pin = land?.pads[j]?.pin ?? null
              row.netPadsChecked++
              const got = pin === null ? undefined : pinNet.get(pinKey(comp.id, pin))
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
            const land = componentFootprint(comp)
            const pins = [...new Set((land?.pads ?? []).flatMap((q) => (q.pin ? [q.pin] : [])))]
            const expected = pins.filter((n) => !f.pads.some((p, j) => land!.pads[j].pin === n && p.net !== null)).sort((a, b) => a.localeCompare(b, "en", { numeric: true }))
            row.ncChecked++
            row.ncPins += comp.nc?.length ?? 0
            if (JSON.stringify(comp.nc ?? []) !== JSON.stringify(expected)) {
              row.ncWrong++
              if (row.ncWrong === 1) row.notes.push(`${comp.ref}: no-connect pins ${JSON.stringify(comp.nc)} in the project, ${JSON.stringify(expected)} in the file`)
            }
          }
          // copper: per net, the track length and the via count, and the locked lengths, project against file. A net's name in the project is the label text of its raw name.
          if (cu.segments.length + cu.vias.length > 0) {
            // tracks on the copper layers the file's own table lists (a track on a layer it lacks, or on a drawing layer, is a refusal and is not built)
            const copperNames = new Set((layersOracle(Buffer.from(data).toString("utf8"))?.copper ?? []).map((r: { name: string }) => r.name))
            // (a board whose pads of one number sit on two nets has two raw names on one project net, which says nothing about a label)
            const text = (raw: string | null) => (raw === null ? "" : ((wrong === 0 ? projectOf.get(raw)?.slice(4) : undefined) ?? decodeNetName(raw).trim()))
            const fileLen = new Map<string, number>()
            const fileVias = new Map<string, number>()
            let fileLocked = 0
            for (const s of cu.segments) {
              if (!copperNames.has(s.layer)) continue
              fileLen.set(text(s.net), (fileLen.get(text(s.net)) ?? 0) + s.length)
              if (s.locked) fileLocked += s.length
            }
            for (const v of cu.vias) fileVias.set(text(v.net), (fileVias.get(text(v.net)) ?? 0) + 1)
            const projLen = new Map<string, number>()
            const projVias = new Map<string, number>()
            let projLocked = 0
            for (const t of built.project.traces) {
              let len = 0
              if (t.arc && t.points.length === 3) len = arcLength([t.points[0].x, t.points[0].y], [t.points[1].x, t.points[1].y], [t.points[2].x, t.points[2].y])
              else for (let i = 1; i < t.points.length; i++) len += Math.hypot(t.points[i].x - t.points[i - 1].x, t.points[i].y - t.points[i - 1].y)
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
          // ---- slice 1b-iii: every text object, on the board and in footprints, against the raw file ----
          const txt = checkTexts(text, built.project, { font: rows.length % INK_EVERY === 0 ? oracleFont : undefined })
          row.textsFile = txt.file
          row.textsProject = txt.project
          row.textsCounts = txt.counts
          row.textsWrong = txt.wrong
          row.textsLayers = txt.layers
          row.textsBoxes = txt.boxes
          row.textsInk = txt.inkChecked
          row.textsTurned = txt.turned
          row.textsByOrder = txt.pairedByOrder
          row.textsInkWrong = txt.inkWrong
          row.textsRoundTrip = textsRoundTripOk(built.project)
          if (txt.note) row.notes.push(`texts: ${txt.note}`)
          // ---- slice 2c-i, X2: the board's outline against the file's Edge.Cuts, to 0.001 mm both ways ----
          const edge = checkEdge(text, built.project, outlineOf(board).repair)
          row.edgePieces = edge.pieces
          row.edgeSamples = edge.fileSamples + edge.projectSamples
          row.edgeWrong = edge.wrong
          row.edgeRepairs = edge.atRepairs
          row.edgeMerged = edge.merged
          row.edgeDropped = edge.dropped
          row.outlineHeld = built.project.board.outline ? (built.project.board.outline.paths.length ? (built.project.board.outline.paths.every((p) => p.closed) ? "outline" : "open") : "missing") : "rectangle"
          if (edge.note) row.notes.push(edge.note)
          // ---- slice X1, X4, X5: layers, arcs, via kinds and padstacks, against the raw file ----
          const layers = checkLayers(text, built.project, row.status === "imported" ? built.lossy : ["not imported"])
          row.layersUse = layers.uses
          row.layersCopper = layers.copper
          row.layersArcs = layers.arcs
          row.layersPartialVias = layers.partialVias
          row.layersPadstacks = layers.padstacks
          row.layersWrong = layers.wrong
          if (layers.wrong.length) row.notes.push(`layers: ${layers.wrong.slice(0, 3).join("; ")}`)
          // ---- slice X10: net classes and design rules, against the raw file ----
          const x10 = checkX10(text, built.project, built.lossy)
          row.x10Classes = x10.classes
          row.x10Wrong = x10.wrong
          row.x10Nets = x10.netsChecked
          row.x10NetsSkipped = x10.netsSkipped
          row.x10Uses = x10.uses
          if (x10.wrong.length) row.notes.push(`x10: ${x10.wrong.slice(0, 3).join("; ")}`)
          // timing and consistency of the router on a board with classes: some of the smaller ones are routed from nothing with their own rules
          if (x10.classes > 0 && ROUTED < ROUTE_SAMPLE && row.pads_total <= 400 && !built.lossy.length) {
            ROUTED++
            const clear: Project = { ...built.project, traces: [], vias: [], zones: [] }
            const count = (p: Project) => analyzePcb(p, computeConnectivity(p)).violations.filter((v) => v.kind === "clearance").length
            const before = count(clear)
            const t = performance.now()
            const res = autoroute(clear, { timeLimitMs: 30_000 })
            const ms = performance.now() - t
            row.x10Route = { ms, routed: res.routed, remaining: res.remaining, pads: row.pads_total, classes: x10.classes + 1, extraClearance: Math.max(0, count(res.project) - before) }
          }
          // ---- the board objects slice: dimensions, groups and reference images, against the raw file ----
          const bo = checkDimensions(text, built.project, oracleFont, built.lossy)
          row.dims = { file: bo.file, project: bo.project, inFootprints: bo.inFootprints, legacy: bo.legacy, arrowsComparable: bo.arrowsComparable, arrowsSame: bo.arrowsSame, barSame: bo.barSame, featureSame: bo.featureSame, texts: bo.texts, groupsFile: bo.groupsFile, groupsProject: bo.groupsProject, partGroupsFile: bo.partGroupsFile, partGroupsProject: bo.partGroupsProject, imagesFile: bo.imagesFile, imagesProject: bo.imagesProject }
          row.dimsWrong = bo.wrong + (bo.counts ? 0 : 1)
          row.groupsWrong = bo.groupsWrong
          row.imagesWrong = bo.imagesWrong
          row.boardObjectsRoundTrip = bo.roundTrip
          row.dimNotes = bo.note ?? ""
          if (bo.note) row.notes.push(`board objects: ${bo.note}`)
          // a KiCad 5 dimension whose cached arrows are KiCad's own length: every one is among the lines drawn
          if (bo.arrowsSame !== bo.arrowsComparable) row.dimsWrong++
          // ---- X3: the zones of the file against the project's, setting by setting (oracle), and the stored form ----
          const zset = checkZoneSettings(text, built.project)
          row.zonesFile = zoneOracle(text).zones.filter(importedZone).length
          row.zonesProject = built.project.zones.length
          row.zonesWrong = zset.mismatches.length
          if (zset.mismatches.length) row.notes.push(`zones: ${zset.mismatches.slice(0, 3).map((m) => `#${m.zone} ${m.what}`).join("; ")}`)
          row.zoneBytes = built.project.zones.length ? JSON.stringify(packZones(built.project.zones)).length : 0
          row.zoneRoundTrip = isDeepStrictEqual(parseProjectFile(serializeProject(built.project), { id: built.project.id }).zones, built.project.zones)
          if (imported.status === "imported") {
            if (imported.project.zones.length) {
              const f0 = performance.now()
              const fills = await cachedExport("compareFills", [text, imported.project], () => compareFills(text, imported.project), ["tests/kicad-zones-check.ts", "tests/kicad-census"])
              row.fillMs = performance.now() - f0
              row.fillLayers = fills.length
              row.fillStored = fills.filter((x) => x.stored).length
              for (const x of fills.filter((y) => y.stored)) {
                row.fillOurs += x.ours
                row.fillTheirs += x.theirs
                row.fillXor += x.xor
                row.fillWorst = Math.max(row.fillWorst, x.hausdorff)
                row.fillP99 = Math.max(row.fillP99, x.p99)
              }
            }
            const p = imported.project
            const problems: string[] = []
            const back = parseProjectFile(serializeProject(p), { id: p.id })
            for (const k of ["components", "texts", "graphics", "footprints", "traces", "vias", "labels", "wires", "board", "rules", "properties", "zones", "dimensions", "groups", "images"] as const) {
              if (!isDeepStrictEqual(back[k], p[k])) problems.push(`${k} differ after a save and a load`)
            }
            // An outline that does not close, or that crosses itself, cannot be cut out: the Gerber and drill exports refuse it with a message.
            const outlineProblem = outlineState(p.board) !== "closed" || outlineCrossings(p.board.outline?.paths ?? []).length > 0
            const outlineOpen = outlineState(p.board) !== "closed"
            try {
              let files: Record<string, string> = {}
              try {
                files = buildFabricationFiles(p)
                if (outlineProblem) problems.push("the Gerbers were made for a board whose outline does not close")
              } catch (e) {
                // A board with no closed outline cannot be fabricated: the export says so, with the message (the founder's decision), and that is the right answer for it.
                if (!(outlineProblem && e instanceof OutlineNotClosedError && /outline/.test(e.message))) throw e
                row.outlineRefused = true
              }
              if (!outlineProblem) {
                if (!Object.keys(files).length || Object.values(files).some((f) => typeof f !== "string" || !f.length)) problems.push("a fabrication file is empty")
                // the Gerbers, the drill file, the BOM, the position file and the notes are all there
                for (const ext of [".gtl", ".gbl", ".gm1", ".drl"]) if (!Object.keys(files).some((k) => k.endsWith(ext))) problems.push(`no ${ext} file`)
              }
              // the import screen: the summary and the report text build, and say the board came in
              const summary = summarizeImport(imported, { ...emptyContext(), used: [rel], boardBytes: text.length })
              if (summary.status !== "imported") problems.push("the import screen's summary does not say the board came in")
              if (!reportText(summary, p.name).includes(p.name)) problems.push("the import report text is empty")
              const checks = runTool(p, "run_checks", {})
              if (checks.isError) problems.push(`run_checks: ${checks.result.slice(0, 80)}`)
              else if (outlineOpen && !/outline/i.test(checks.result)) problems.push("run_checks does not say the outline is not closed")
              // the position file, the bill of materials and Circuit JSON do not need the outline closed
              if (!pnpCsv(p).includes("Designator")) problems.push("no position file")
              if (!projectToCircuitJson(p).elements.length) problems.push("no Circuit JSON")
            } catch (e) {
              problems.push(`export or checks threw: ${e instanceof Error ? e.message : e}`)
            }
            row.endToEnd = problems.join("; ") || "ok"
            if (problems.length) row.notes.push(`end to end: ${row.endToEnd}`)
          }
          row.padsProject = fail ? "fail" : compared ? "ok" : "none"
          row.padsProjectCompared = compared
          row.padsProjectSkipped = skipped
        } catch (e) {
          row.error = `${e instanceof Error ? (e.stack ?? e.message) : e}`.slice(0, 400)
          row.status = "CRASH"
        }
        row.ms.total = performance.now() - start
        appendFileSync(join(OUT, "progress.log"), `${rows.length} ${Math.round(row.ms.total)} ms ${rel}
`)
      }
      dog.stop()
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
      // slice 1b-iii: every text object of the file is in the project, on its layer, with its place, size, angle, justification and content, to 0.001 mm; the texts survive the stored form; an imported board is whole end to end
      expect(rows.filter((r) => !r.textsCounts || r.textsWrong > 0 || r.textsInkWrong > 0 || !r.textsRoundTrip).map((r) => `${r.file}: ${r.notes.find((n) => n.startsWith("texts"))}`)).toEqual([])
      // slice X7: every pad of the file is in the project as the file's own rules draw it, on its layers, with its settings, hole and number
      expect(rows.filter((r) => r.x7Wrong > 0).map((r) => `${r.file}: ${r.x7Notes.slice(0, 2).join(" | ")}`)).toEqual([])
      // slice 2c-i: every piece the file draws on Edge.Cuts is on the project's outline and the other way round, to 0.001 mm
      expect(rows.filter((r) => r.edgeWrong > 0).map((r) => `${r.file}: ${r.notes.find((n) => n.startsWith("outline"))}`)).toEqual([])
      // slices X1, X4, X5: layers, stackup, arcs, via kinds and spans and padstacks are what the file has (oracle)
      expect(rows.filter((r) => r.layersWrong.length).map((r) => `${r.file}: ${r.layersWrong.slice(0, 3).join("; ")}`)).toEqual([])
      // slice X10: every net class and rule of the file is in the project, and every net is in the class the file puts it in; the router adds no clearance error on a board with classes
      expect(rows.filter((r) => r.x10Wrong.length).map((r) => `${r.file}: ${r.x10Wrong.slice(0, 3).join("; ")}`)).toEqual([])
      expect(rows.filter((r) => r.x10Route && r.x10Route.extraClearance > 0).map((r) => `${r.file}: ${r.x10Route!.extraClearance} clearance errors beyond the pads'`)).toEqual([])
      // the board objects slice: every dimension draws and says what the oracle says, every group holds what KiCad resolves, every image is as the file has it, and all survive the stored form
      expect(rows.filter((r) => r.dimsWrong > 0 || r.groupsWrong > 0 || r.imagesWrong > 0 || !r.boardObjectsRoundTrip).map((r) => `${r.file}: ${r.dimNotes}`)).toEqual([])
      expect(rows.filter((r) => r.endToEnd && r.endToEnd !== "ok").map((r) => `${r.file}: ${r.endToEnd}`)).toEqual([])
      // X3: every zone of the file is in the project with its outline, layers, net and settings (oracle), the stored form gives them back, and on every board that imports the editor's fill is KiCad's within the measured bounds
      expect(rows.filter((r) => r.zonesWrong > 0 || !r.zoneRoundTrip).map((r) => `${r.file}: ${r.notes.find((n) => n.startsWith("zones"))}`)).toEqual([])
      expect(rows.filter((r) => r.status === "imported" && r.fillStored > 0 && r.fillXor > Math.max(0.1 * r.fillTheirs, 5)).map((r) => r.file)).toEqual(ONLY.length || LIMIT ? expect.arrayContaining([]) : ZONE_FILL_OUTLIERS)
      expect(rows.filter((r) => r.flagsWrong > 0 || r.ncWrong > 0 || r.copperNets === "fail" || !r.copperLocked || !r.mismatchListed || !r.gateExact).map((r) => r.file)).toEqual([])
    },
    10_800_000,
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
    ["project pads on the oracle's nets, pad by pad (pads of one number on two nets, and pads with no number that carry a net, have a pin each)", (r) => r.netPadsWrong === 0],
    ["project pad outlines within 0.001 mm of the oracle's", (r) => r.boxWrong === 0],
    ["every pad's copper, layers, margins, hole and number equal the file's by its own rules (X7 oracle)", (r) => r.x7Wrong === 0],
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
    ["texts: the same count on every layer as the file's (oracle)", (r) => r.textsCounts],
    ["texts: every text of the file in the project, place, size, angle, mirror, justification, flags and content (oracle)", (r) => r.textsWrong === 0],
    ["texts: strokes equal the oracle's layout with KiCad's font (boards sampled)", (r) => r.textsInkWrong === 0],
    ["texts: a save and a load give the same texts in memory (stored form)", (r) => r.textsRoundTrip],
    ["outline: every piece of the file's Edge.Cuts is on the project's outline, and the other way round, to 0.001 mm (oracle; repairs counted)", (r) => r.edgeWrong === 0],
    ["layers, stackup, arc tracks, via kinds and padstacks: what the file has is in the project (oracle)", (r) => r.layersWrong.length === 0],
    ["net classes and rules: every class, size, net and rule of the file is in the project, and every net is in the file's class for it (oracle)", (r) => r.x10Wrong.length === 0],
    ["dimensions: every one draws (lines, circles, arrows) and says (text, place, angle) what the oracle derives from KiCad's rules", (r) => r.dimsWrong === 0],
    ["groups: every group holds what KiCad resolves for it, nested ones included, and the groups inside parts are as many", (r) => r.groupsWrong === 0],
    ["reference images: place, layer, scale, size, resolution and bytes as the file has them", (r) => r.imagesWrong === 0],
    ["dimensions, groups and images: a save and a load give the same in memory (stored form)", (r) => r.boardObjectsRoundTrip],
    ["zones: every zone of the file in the project with its outline, layers, net and settings (oracle)", (r) => r.zonesWrong === 0],
    ["zones: a save and a load give the same zones in memory (stored form)", (r) => r.zoneRoundTrip],
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
  const feat: Record<string, number> = {}
  for (const r of board) for (const [k, v] of Object.entries(r.x7Features)) feat[k] = (feat[k] ?? 0) + v
  lines.push(`X7: pads checked against the oracle's reading of the file: ${board.reduce((n, r) => n + r.x7Pads, 0)}, wrong: ${board.reduce((n, r) => n + r.x7Wrong, 0)} (on ${count(board, (r) => r.x7Wrong > 0)} boards); points of the board compared with a pad's copper: ${board.reduce((n, r) => n + r.x7Samples, 0)}; by feature: ${Object.entries(feat).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k} ${v}`).join(", ")}`)
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
  const textLayerTotals = new Map<string, number>()
  for (const r of board) for (const [k, v] of Object.entries(r.textsLayers)) textLayerTotals.set(k, (textLayerTotals.get(k) ?? 0) + v)
  lines.push(`texts: ${board.reduce((n, r) => n + r.textsFile, 0)} compared (board text, and the reference, value and own text of each part), ${board.reduce((n, r) => n + r.textsProject, 0)} in the projects, on ${count(board, (r) => r.textsFile > 0)} boards; ${board.reduce((n, r) => n + r.textsWrong, 0)} not matched; ${board.reduce((n, r) => n + r.textsBoxes, 0)} text boxes. By layer: ${[...textLayerTotals].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(", ")}`)
  lines.push(`texts on parts turned by other than a quarter turn, compared like the rest (X6): ${board.reduce((n, r) => n + r.textsTurned, 0)}; texts of parts that share a place with another part, paired by footprint order and compared: ${board.reduce((n, r) => n + r.textsByOrder, 0)}`)
  lines.push(`X6: ${board.reduce((n, r) => n + r.turnedParts, 0)} parts at an angle that is not a quarter turn on ${count(board, (r) => r.turnedParts > 0)} boards, their ${board.reduce((n, r) => n + r.turnedPads, 0)} pads compared with the oracle's places and ${board.reduce((n, r) => n + r.turnedBoxes, 0)} pad outlines with its extents (wrong: ${board.reduce((n, r) => n + r.boxWrong, 0)}); drawings and texts of those parts are in the counts above`)
  const held = new Map<string, number>()
  for (const r of board) if (r.outlineHeld) held.set(r.outlineHeld, (held.get(r.outlineHeld) ?? 0) + 1)
  lines.push(`X2: the outline is held as ${[...held].map(([k, v]) => `${k} ${v}`).join(", ")}; ${board.reduce((n, r) => n + r.edgePieces, 0)} pieces of Edge.Cuts compared (${board.reduce((n, r) => n + r.edgeSamples, 0)} points both ways, wrong ${board.reduce((n, r) => n + r.edgeWrong, 0)}); points off by more than 0.001 mm at a repair (a gap closed by a connector): ${board.reduce((n, r) => n + r.edgeRepairs, 0)} on ${count(board, (r) => r.edgeRepairs > 0)} boards; on boards where pieces were merged onto a line (up to 0.1 mm): ${board.reduce((n, r) => n + r.edgeMerged, 0)} on ${count(board, (r) => r.edgeMerged > 0)} boards; short pieces dropped as the report says: ${board.reduce((n, r) => n + r.edgeDropped, 0)}`)
  {
    const zoned = board.filter((r) => r.zonesFile > 0)
    const filled = board.filter((r) => r.status === "imported" && r.fillStored > 0)
    const sorted = [...filled].sort((a, b) => a.fillXor / Math.max(a.fillTheirs, 1e-9) - b.fillXor / Math.max(b.fillTheirs, 1e-9))
    const pct = (r: Row) => (100 * r.fillXor) / Math.max(r.fillTheirs, 1e-9)
    const q = (f: number) => (sorted.length ? pct(sorted[Math.min(sorted.length - 1, Math.floor(f * sorted.length))]).toFixed(2) : "-")
    lines.push(`X3: ${board.reduce((n, r) => n + r.zonesFile, 0)} zones of the files on ${zoned.length} boards taken in, ${board.reduce((n, r) => n + r.zonesProject, 0)} in the projects, ${board.reduce((n, r) => n + r.zonesWrong, 0)} settings, outlines or layers differ from the file's (oracle); zones stored in ${(board.reduce((n, r) => n + r.zoneBytes, 0) / 1024).toFixed(0)} KiB over ${zoned.length} boards, the most on one board ${(Math.max(0, ...board.map((r) => r.zoneBytes)) / 1024).toFixed(1)} KiB`)
    lines.push(`X3 fills: ${filled.length} boards that import have a stored fill to compare with (${filled.reduce((n, r) => n + r.fillStored, 0)} zone layers, ${filled.reduce((n, r) => n + r.fillTheirs, 0).toFixed(0)} mm2 of KiCad copper, ${filled.reduce((n, r) => n + r.fillOurs, 0).toFixed(0)} mm2 of ours, ${filled.reduce((n, r) => n + r.fillXor, 0).toFixed(0)} mm2 in only one of them: ${(100 * filled.reduce((n, r) => n + r.fillXor, 0) / Math.max(1, filled.reduce((n, r) => n + r.fillTheirs, 0))).toFixed(2)} %); per board the part of KiCad's copper that differs is at the median ${q(0.5)} %, the 90th percentile ${q(0.9)} %, the worst ${q(1)} %; the farthest a point of either boundary is from the other: median ${(sorted.map((r) => r.fillWorst).sort((a, b) => a - b)[Math.floor(sorted.length / 2)] ?? 0).toFixed(2)} mm, 90th percentile ${(sorted.map((r) => r.fillWorst).sort((a, b) => a - b)[Math.floor(sorted.length * 0.9)] ?? 0).toFixed(2)} mm, and the 99th percentile of the points of a board, worst board ${Math.max(0, ...filled.map((r) => r.fillP99)).toFixed(2)} mm; the editor's own fill took ${(filled.reduce((n, r) => n + r.fillMs, 0) / 1000).toFixed(0)} s in all, ${(Math.max(0, ...filled.map((r) => r.fillMs)) / 1000).toFixed(1)} s on the slowest board`)
    const LIMIT_BYTES = 900 * 1024
    lines.push(`X3 sizes: zones are ${(board.reduce((n, r) => n + r.zoneBytes, 0) / 1024).toFixed(0)} KiB of ${(board.reduce((n, r) => n + r.projectBytes, 0) / 1024).toFixed(0)} KiB of projects (${zoned.length} boards have any); boards over 900 KiB: ${count(board, (r) => r.projectBytes > LIMIT_BYTES)} with their zones, ${count(board, (r) => r.projectBytes - r.zoneBytes > LIMIT_BYTES)} without them (the fill is not stored, so a zone costs its outline: median ${(zoned.map((r) => r.zoneBytes).sort((a, b) => a - b)[Math.floor(zoned.length / 2)] ?? 0)} bytes, 90th percentile ${(zoned.map((r) => r.zoneBytes).sort((a, b) => a - b)[Math.floor(zoned.length * 0.9)] ?? 0)} bytes)`)
    lines.push(`X3 fills over 5 % of KiCad's copper: ${sorted.filter((r) => pct(r) > 5).map((r) => `${r.file.split(/[\\/]/).slice(-2).join("/")} (${pct(r).toFixed(0)} %, ${r.fillTheirs.toFixed(0)} mm2)`).join(", ") || "none"}`)
  }
  const importedReal = board.filter((r) => r.status === "imported" && ["pcbench", "github", "kicad-demos"].includes(r.group))
  lines.push(`real boards that import now: ${importedReal.length} of ${board.filter((r) => ["pcbench", "github", "kicad-demos"].includes(r.group)).length}; all boards: ${count(board, (r) => r.status === "imported")} of ${board.length}`)
  lines.push(`text strokes laid out against the oracle with KiCad's font: ${board.reduce((n, r) => n + r.textsInk, 0)} texts on ${count(board, (r) => r.textsInk > 0)} boards, ${board.reduce((n, r) => n + r.textsInkWrong, 0)} differ`)
  const sum = (k: string) => board.reduce((n, r) => n + (r.dims[k] ?? 0), 0)
  lines.push(`dimensions: ${sum("file")} in the files on ${count(board, (r) => (r.dims.file ?? 0) > 0)} boards, ${sum("project")} in the projects, ${sum("texts")} with text compared; ${board.reduce((n, r) => n + r.dimsWrong, 0)} differ from the oracle; ${sum("inFootprints")} more inside footprints (X26, refused)`)
  lines.push(`KiCad 5 dimensions: ${sum("legacy")}; cached arrows of KiCad's own length ${sum("arrowsComparable")}, all among the lines drawn: ${sum("arrowsSame")}; cached crossbar ends drawn: ${sum("barSame")}; cached feature lines starting at the points and running the same way: ${sum("featureSame")}`)
  lines.push(`groups: ${sum("groupsFile")} in the files (as KiCad resolves them) on ${count(board, (r) => (r.dims.groupsFile ?? 0) > 0)} boards, ${sum("groupsProject")} in the projects; inside parts ${sum("partGroupsFile")} and ${sum("partGroupsProject")}; ${board.reduce((n, r) => n + r.groupsWrong, 0)} differ; reference images ${sum("imagesFile")} in the files, ${sum("imagesProject")} in the projects, ${board.reduce((n, r) => n + r.imagesWrong, 0)} differ`)
  const imported = board.filter((r) => r.status === "imported")
  const layered = board.filter((r) => r.layersUse)
  lines.push(`layers (X1, X4, X5): ${layered.length} boards use more than two copper layers, an arc track, a blind, buried or micro via, or a padstack; ${count(board, (r) => r.layersCopper > 2)} have more than two copper layers (most ${Math.max(0, ...board.map((r) => r.layersCopper))}), ${board.reduce((n, r) => n + r.layersArcs, 0)} arc tracks, ${board.reduce((n, r) => n + r.layersPartialVias, 0)} vias that are not through vias, ${board.reduce((n, r) => n + r.layersPadstacks, 0)} pads with a padstack; ${board.reduce((n, r) => n + r.layersWrong.length, 0)} differences`)
  const classed = board.filter((r) => r.x10Classes > 0)
  lines.push(`net classes (X10): ${classed.length} boards have a class beyond Default (${board.reduce((n, r) => n + r.x10Classes, 0)} classes), ${count(board, (r) => r.x10Uses)} use a class or a rule of X10; ${board.reduce((n, r) => n + r.x10Nets, 0)} nets looked up in the project's classes against the file's lists (${board.reduce((n, r) => n + r.x10NetsSkipped, 0)} not compared: a name two nets share); ${board.reduce((n, r) => n + r.x10Wrong.length, 0)} differences`)
  const routed = board.filter((r) => r.x10Route)
  if (routed.length) lines.push(`router on boards with classes, routed from nothing (${routed.length}): ${routed.map((r) => `${r.file.split("/").slice(-2).join("/")} ${r.x10Route!.pads} pads, ${r.x10Route!.classes} classes, ${(r.x10Route!.ms / 1000).toFixed(1)} s, ${r.x10Route!.routed} routed, ${r.x10Route!.remaining} open, ${r.x10Route!.extraClearance} new clearance errors`).join("; ")}`)
  lines.push(`imported (the real gate, X10 built): ${imported.length} boards, ${imported.filter((r) => r.group !== "kicad-qa").length} outside KiCad's own folder (${imported.filter((r) => ["pcbench", "github", "kicad-demos"].includes(r.group)).length} real: pcbench, github and demos); with a class beyond Default: ${imported.filter((r) => r.x10Classes > 0).length}`)
  lines.push(`imported boards end to end (save and load, Gerbers, drill, BOM, position file, notes, run_checks): ${count(imported, (r) => r.endToEnd === "ok")}/${imported.length} ok; of them ${count(imported, (r) => r.outlineRefused)} have an outline that does not close, is missing or crosses itself, and the Gerber export refuses them with the message, as it should`)
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
  lines.push(`real boards: measured project plus the census estimate for what is not built yet (zone outlines; the estimate still counts text, so it overstates): median ${(tq(0.5) / 1024).toFixed(0)} KB, p90 ${(tq(0.9) / 1024).toFixed(0)} KB, p99 ${(tq(0.99) / 1024).toFixed(0)} KB, largest ${((totals[totals.length - 1] ?? 0) / 1024).toFixed(0)} KB; over 900 KB: ${totals.filter((t) => t > cap).length}; measured part alone over 900 KB: ${real.filter((r) => r.projectBytes > cap).length}; the old estimate said ${real.filter((r) => r.estBuilt + r.estUnbuilt > cap).length}`)
  lines.push(`measured project size (what slice 1b-iii builds: drawings and text): median ${(q(0.5) / 1024).toFixed(0)} KB, p90 ${(q(0.9) / 1024).toFixed(0)} KB, p99 ${(q(0.99) / 1024).toFixed(0)} KB, largest ${((sizes[sizes.length - 1] ?? 0) / 1024).toFixed(0)} KB; over 900 KB: ${sizes.filter((s) => s > 900 * 1024).length}`)
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
