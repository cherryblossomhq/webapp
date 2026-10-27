import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { isDeepStrictEqual } from "node:util"
import { describe, expect, it } from "vitest"
import { runTool } from "../src/ai/tools"
import { buildFabricationFiles } from "../src/export/bundle"
import { OutlineNotClosedError } from "../src/export/outlineGuard"
import { gerberLayers } from "../src/export/gerber"
import { kicadFiles } from "../src/export/kicad"
import { BUILT_EXTENSIONS, importKicadBoard, needsOf, outlineOf, readKicadBoard } from "../src/model/kicad/board"
import { countPaths } from "../src/model/kicad/board/account"
import { pcbPads } from "../src/model/instances"
import { nonCopperFills } from "../src/model/nonCopperFill"
import { outlineState } from "../src/model/outline"
import { outlineCrossings } from "../src/model/outlineCrossing"
import { worldPartZones } from "../src/model/partZones"
import { parseProjectFile, serializeProject } from "../src/model/projectFile"
import type { Project } from "../src/model/types"
import { isOtherZone } from "../src/model/zones"
import { kids, kid, parseSexpr } from "./kicad-census/sexpr.mjs"
import { checkPartZones, checkZoneSettings, compareFills } from "./kicad-zones-check"
import { ZONE_FAMILY_BOARDS } from "./kicad-zone-family-boards"
import { diffProjects } from "./kicad-roundtrip-check"
import { unknownNodes } from "./kicad9-nodes"

// The corpus proof of X29 (zones on layers that are not copper), X30 (zones inside parts) and X31 (the layers a pour joins a pad on): the boards that only these three stopped (the list in
// `kicad-zone-family-boards.ts`), imported through the real gate and checked against the raw file by oracles that share no code with `src`:
//
//   KICAD_CORPUS=<corpus dir> NODE_OPTIONS=--max-old-space-size=10240 npx vitest run tests/kicad-zone-family-corpus.test.ts
//
// For each board that imports: every zone of the board and its layers, kind, settings and outline against the file (`checkZoneSettings`); each zone inside a part against the file, where the
// board has it (`checkPartZones`); the editor's fill of each zone that is not on copper against the fill KiCad stored (`compareFills`, a few explained exceptions below); every pad's
// `zone_layer_connections` against the file; the project through the stored form and back; the Gerbers and the fabrication files; Checks; and the native KiCad writer, whose file imports as
// the same project. The table goes to KICAD_ZONE_OUT (the temp folder by default). With no corpus the test is skipped.

const CORPUS = process.env.KICAD_CORPUS
const OUT = process.env.KICAD_ZONE_OUT ?? join(tmpdir(), "kicad-zone-family-corpus.txt")
const FAMILY = new Set(["X29", "X30", "X31"])
/** The boards that imported, kept for the second test (the native writer's round trip). */
const pending: { rel: string; p: Project }[] = []

/** Boards whose fill the editor draws as KiCad 9 would and the file's own (KiCad 4 or 5) stored fill is not that, each with why. */
const FILL_EXPLAINED: Record<string, string> = {
  "pcbench/PCBs/Photodiode_dethead/raw.kicad_pcb": "KiCad 4 stored the fill of a zone with a hole grown 0.127 mm beyond its outline (the outer edge outside it, the hole smaller); KiCad 9 fills inside the outline",
  "pcbench/PCBs/card_card/raw.kicad_pcb": "a strip of the zone 0.250 mm wide, under its 0.254 mm minimum width: KiCad 5 kept it, KiCad 9 and the editor take it away",
}

/** The differences the writer's file has on purpose, as `kicad-roundtrip-corpus.test.ts` lists them (a copy: that file is a test and cannot be imported). */
const BY_DESIGN = [
  /^project\.zones\[\]\.(edgeGap|holeGap|unordered|uuid)$/,
  /^project\.components\[\]\.flags\.(virtual|excludeFromBom|excludeFromPos)$/,
  /^project\.components\[\]\.flags\.(jumperDuplicates|jumperGroups)$/,
  /^project\.(texts|components\[\]\.texts)\[\]\.href$/,
  /^project\.(traces\[\]\.net|vias\[\]\.routedNet)$/,
  /^project\.board\.stack\.castellated$/,
  /^project\.board\.outlineDrawn: /,
]

/** The copper layer names of the file's table, in order: what `zone_layer_connections` names. */
function copperNames(tree: any): string[] {
  const rows = (kids(tree, "layers")[0]?.slice(1) ?? []) as unknown[][]
  return rows.filter((r) => Array.isArray(r) && ["signal", "power", "mixed", "jumper"].includes(String(r[2]))).map((r) => String(r[1]))
}

/** Each footprint's pads that say `zone_layer_connections`, by the footprint's reference, as the file writes them (null for a pad that says none). */
function padZoneLayers(text: string): Map<string, (string[] | null)[]> {
  const tree = parseSexpr(text)[0] as any
  const out = new Map<string, (string[] | null)[]>()
  const counts = new Map<string, number>()
  const items: { ref: string; pads: (string[] | null)[] }[] = []
  for (const fp of tree) {
    if (!Array.isArray(fp) || (fp[0] !== "footprint" && fp[0] !== "module")) continue
    const refProp = (kids(fp, "property") as unknown[][]).find((p) => p[1] === "Reference")
    const refText = (kids(fp, "fp_text") as unknown[][]).find((p) => p[1] === "reference")
    const ref = String(refProp?.[2] ?? refText?.[2] ?? "")
    counts.set(ref, (counts.get(ref) ?? 0) + 1)
    items.push({
      ref,
      pads: (kids(fp, "pad") as unknown[][]).map((p) => {
        const z = kid(p as any, "zone_layer_connections") as any
        return z ? z.slice(1).map(String) : null
      }),
    })
  }
  for (const it of items) if (it.ref && counts.get(it.ref) === 1) out.set(it.ref, it.pads)
  return out
}

describe.skipIf(!CORPUS || !existsSync(CORPUS))("the zone family on the corpus", () => {
  it(
    "imports the boards X29, X30 and X31 stopped, and every check agrees with the file",
    () => {
      const rows: string[] = []
      const failures: string[] = []
      const count = { boards: 0, imported: 0, refusedOther: 0, zones: 0, otherZones: 0, partZones: 0, partZoneBoards: 0, padsWithConnections: 0, boardsWithPadConnections: 0, fills: 0, fillsStored: 0, gerbers: 0, roundTrips: 0, roundTripSkipped: 0, outlineRefused: 0 }
      let worstXor = 0
      for (const rel of ZONE_FAMILY_BOARDS) {
        count.boards++
        const path = join(CORPUS!, rel)
        const data = readFileSync(path)
        const text = data.toString("utf8")
        const bad = (what: string) => failures.push(`${rel}: ${what}`)

        // the gate: with the three built, what stops this board is not one of them
        const read = readKicadBoard(new Uint8Array(data))
        const needs = needsOf(read.board, { paths: countPaths(read.board.tree) }, outlineOf(read.board))
        const without = new Set([...BUILT_EXTENSIONS].filter((x) => !FAMILY.has(x)))
        const stoppedBy = needs.filter((n) => !without.has(n.ext)).map((n) => n.ext)
        if (!stoppedBy.length || stoppedBy.some((e) => !FAMILY.has(e))) bad(`was listed as stopped by the zone family alone, and its needs are ${stoppedBy.join(", ")}`)

        const r = importKicadBoard(new Uint8Array(data))
        if (r.status !== "imported") {
          count.refusedOther++
          rows.push(`${rel}\trefused:${r.reason}\t${r.message.slice(0, 140)}`)
          // a board that stays out stays out for something that is not a zone
          if (r.reason === "unsupported" && r.needs.some((n) => FAMILY.has(n.ext))) bad(`is still refused for the zone family: ${r.message}`)
          if (/zone|pour|keepout|footprint's|inside a part/i.test(r.message) && !/user_via|too large|needs \d/i.test(r.message)) bad(`is refused over a zone: ${r.message}`)
          continue
        }
        count.imported++
        const p: Project = r.project

        // zones of the board: every one against the file
        const s = checkZoneSettings(text, p)
        if (s.mismatches.length) bad(`zones differ from the file: ${JSON.stringify(s.mismatches.slice(0, 3))}`)
        count.zones += p.zones.length
        count.otherZones += p.zones.filter(isOtherZone).length

        // zones inside parts: where the board has each, against the file
        const parts = checkPartZones(text, p)
        if (parts.mismatches.length) bad(`zones inside parts differ from the file: ${JSON.stringify(parts.mismatches.slice(0, 3))}`)
        const inside = worldPartZones(p)
        if (inside.length) count.partZoneBoards++
        count.partZones += inside.length

        // the fill of every zone that is not on copper against the fill KiCad stored
        const fills = compareFills(text, p, 3, "other")
        let boardWorst = 0
        for (const f of fills) {
          count.fills++
          if (!f.stored) continue
          count.fillsStored++
          worstXor = Math.max(worstXor, f.xor)
          boardWorst = Math.max(boardWorst, f.xor)
          const ok = (f.xor <= 0.1 || f.xor <= 0.01 * f.theirs) && f.hausdorff <= 0.5
          if (!ok && !FILL_EXPLAINED[rel]) bad(`zone ${f.zone} on ${f.layer}: the fill differs from KiCad's stored one by ${f.xor.toFixed(4)} mm2 of ${f.theirs.toFixed(3)} (farthest ${f.hausdorff.toFixed(3)} mm)`)
        }
        if (FILL_EXPLAINED[rel] && !fills.some((f) => f.stored && !((f.xor <= 0.1 || f.xor <= 0.01 * f.theirs) && f.hausdorff <= 0.5))) bad("is listed as an explained fill difference and has none")

        // X31: every pad's layers a pour joins it on, against the file
        const fileZones = padZoneLayers(text)
        const names = copperNames(parseSexpr(text)[0])
        const idToName = (id: string) => names[id === "top" ? 0 : id === "bottom" ? names.length - 1 : Number(id.slice(2))]
        let padsHere = 0
        for (const c of p.components) {
          const filePads = fileZones.get(c.ref)
          if (!filePads) continue
          const world = pcbPads(c, names.length)
          if (world.length !== filePads.length) continue
          world.forEach((w, i) => {
            const want = filePads[i]
            if (want === null) {
              if (w.zoneLayers !== undefined) bad(`${c.ref} pad ${i + 1} has zone layers and the file has none`)
              return
            }
            padsHere++
            const got = (w.zoneLayers ?? []).map(idToName).sort().join(",")
            const expected = [...new Set(want.flatMap((n) => (n === "*.Cu" ? names : n === "F&B.Cu" ? [names[0], names[names.length - 1]] : [n])))].sort().join(",")
            if (w.zoneLayers === undefined || got !== expected) bad(`${c.ref} pad ${i + 1} joins pours on ${got || "no layer"}, the file says ${expected || "no layer"}`)
          })
        }
        count.padsWithConnections += padsHere
        if (padsHere) count.boardsWithPadConnections++

        // save and load
        const back = parseProjectFile(serializeProject(p), { id: p.id, createdAt: p.createdAt, updatedAt: p.updatedAt })
        for (const k of ["components", "texts", "graphics", "footprints", "traces", "vias", "labels", "wires", "board", "rules", "properties", "zones", "dimensions", "groups", "images"] as const) {
          if (!isDeepStrictEqual(back[k], p[k])) bad(`${k} differ after a save and a load`)
        }

        // Gerbers and the fabrication files
        const outlineProblem = outlineState(p.board) !== "closed" || outlineCrossings(p.board.outline?.paths ?? []).length > 0
        try {
          const files = buildFabricationFiles(p)
          if (outlineProblem) bad("the Gerbers were made for a board whose outline does not close")
          if (!Object.keys(files).length || Object.values(files).some((f) => typeof f !== "string" || !f.length)) bad("a fabrication file is empty")
          const g = gerberLayers(p)
          const regions = (layer: string) => (g[layer as keyof typeof g].match(/G36\*/g) ?? []).length
          const plotted: Record<string, string> = { "F.Mask": "F_Mask", "B.Mask": "B_Mask", "F.Paste": "F_Paste", "B.Paste": "B_Paste", "F.SilkS": "F_Silkscreen", "B.SilkS": "B_Silkscreen", "Edge.Cuts": "Edge_Cuts" }
          const polygons = new Map<string, number>()
          for (const f of nonCopperFills(p)) polygons.set(f.layer, (polygons.get(f.layer) ?? 0) + f.polygons.length)
          for (const [layer, n] of polygons) if (plotted[layer] && regions(plotted[layer]) < n) bad(`the Gerber of ${layer} has ${regions(plotted[layer])} regions for ${n} polygons of zones`)
          count.gerbers++
        } catch (e) {
          if (!(outlineProblem && e instanceof OutlineNotClosedError)) bad(`the Gerbers threw: ${e instanceof Error ? e.message : e}`)
          else count.outlineRefused++
        }
        const checks = runTool(p, "run_checks", {})
        if (checks.isError) bad(`run_checks: ${checks.result.slice(0, 80)}`)

        rows.push(`${rel}\timported\tzones ${p.zones.length} (${p.zones.filter(isOtherZone).length} not copper), in parts ${inside.length}, pads with zone layers ${padsHere}, fills ${fills.length} (${fills.filter((f) => f.stored).length} stored, worst ${boardWorst.toFixed(4)} mm2)`)
        pending.push({ rel, p })
      }
      mkdirSync(join(OUT, ".."), { recursive: true })
      writeFileSync(OUT, [...rows, "", JSON.stringify(count), `worst fill difference ${worstXor.toFixed(4)} mm2`].join("\n"))
      expect(failures).toEqual([])
      expect(count.imported).toBeGreaterThan(0)
    },
    3_600_000,
  )

  it(
    "the native writer's file imports as the same project, for every board",
    async () => {
      const failures: string[] = []
      let done = 0
      for (const { rel, p } of pending) {
        const out = await kicadFiles(p)
        const file = Object.entries(out.files).find(([k]) => k.endsWith(".kicad_pcb"))
        if (!file) {
          failures.push(`${rel}: no board file`)
          continue
        }
        const unknown = unknownNodes(file[1])
        if (unknown.length) failures.push(`${rel}: the written file has nodes KiCad 9 does not know: ${unknown.slice(0, 3).join(", ")}`)
        const again = importKicadBoard(file[1])
        if (again.status !== "imported") {
          failures.push(`${rel}: the written board is refused: ${again.message}`)
          continue
        }
        // What differs on purpose is what the round trip corpus says it is (`kicad-roundtrip-corpus.test.ts`): a KiCad 5 zone's missing uuid and gaps, flags KiCad 9 cannot say, copper the file put on no net.
        const diff = diffProjects(p, again.project).filter((d) => !BY_DESIGN.some((re) => re.test(d.kind)))
        if (diff.length) failures.push(`${rel}: ${diff.length} differences after the round trip, the first ${JSON.stringify(diff[0]).slice(0, 200)}`)
        done++
      }
      writeFileSync(`${OUT}.roundtrip.txt`, `${done} of ${pending.length} boards round trip with no difference\n${failures.join("\n")}`)
      expect(failures).toEqual([])
    },
    3_600_000,
  )
})
