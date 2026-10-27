import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { join, relative } from "node:path"
import { isDeepStrictEqual } from "node:util"
import { describe, expect, it } from "vitest"
import { buildFabricationFiles } from "../src/export/bundle"
import { kicadFiles } from "../src/export/kicad"
import { loadKicadFont } from "../src/lib/kicadFont/load"
import { importKicadBoard } from "../src/model/kicad/board"
import { OutlineNotClosedError } from "../src/export/outlineGuard"
import { parseProjectFile, serializeProject } from "../src/model/projectFile"
import { textFontState, textInk, worldTexts } from "../src/model/texts"
import { outlineState } from "../src/model/outline"
import { rememberImage } from "../src/store/imageFiles"
import { parseSexpr } from "./kicad-census/sexpr.mjs"
import { diffProjects } from "./kicad-roundtrip-check"
import { unknownNodes } from "./kicad9-nodes"

// X19 over the corpus: every board that has a `render_cache`, an `embedded_fonts` node or a font's `face` (the boards that needed X19), imported, drawn, plotted, saved,
// loaded and exported to KiCad again, against an oracle that reads the raw file with the census's own reader (`tests/kicad-census/sexpr.mjs`) and shares no code with `src`.
//
//   KICAD_CORPUS=<corpus dir> NODE_OPTIONS=--max-old-space-size=10240 KICAD_X19_OUT=<file> \
//     npx vitest run tests/kicad-x19-corpus.test.ts
//
// What is compared, per board:
//  - every text that has a cache is drawn from it (`textFontState` is `outline`);
//  - the letters as drawn against the file's polygons: points sampled in each text's box, inside or outside by the non-zero winding of the file's own rings (the oracle) and
//    by the editor's polygon groups (outer rings less holes), which must agree except within a nanometre of an edge (the Hausdorff measure of the two shapes is
//    then at most that, sampled), and the areas of the two (shoelace sums against the polygons' areas) to a part in 10^9 of the ink;
//  - the Gerber files hold a region of the same area for every polygon the letters make (Gerber coordinates are whole nanometres);
//  - a save and a load give the same project, and the KiCad export read again gives the same texts, the same fonts and the same outlines.
// With no corpus the test is skipped.

const CORPUS = process.env.KICAD_CORPUS
const OUT = process.env.KICAD_X19_OUT

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) {
      if (name !== "census") walk(p, out)
    } else if (name.endsWith(".kicad_pcb")) out.push(p)
  }
  return out
}

type Ring = [number, number][]
interface RawText {
  text: string
  rings: Ring[]
  /** Whether the text that owns the cache is mirrored (`(justify ... mirror)`): a text and its mirror image at one anchor have the same box, so the box alone cannot tell their caches apart. */
  mirror: boolean
}

/** The render caches of a raw file, each as its text and rings (the file's frame, y down, millimetres). */
function rawCaches(tree: unknown[]): RawText[] {
  const out: RawText[] = []
  const isMirrored = (parent: unknown[]) => parent.some((e) => Array.isArray(e) && e[0] === "effects" && e.some((j) => Array.isArray(j) && j[0] === "justify" && j.includes("mirror")))
  const visit = (n: unknown, parent: unknown[] = []) => {
    if (!Array.isArray(n)) return
    if (n[0] === "render_cache") {
      const rings: Ring[] = []
      for (const poly of n.slice(3)) for (const pts of (poly as unknown[]).slice(1)) rings.push((pts as unknown[]).slice(1).map((p) => [Number((p as string[])[1]), Number((p as string[])[2])] as [number, number]))
      out.push({ text: String(n[1]), rings, mirror: isMirrored(parent) })
      return
    }
    for (const c of n) visit(c, n)
  }
  visit(tree)
  return out
}

/** The non-zero winding number of a point in a set of rings. */
function winding(rings: Ring[], x: number, y: number): number {
  let w = 0
  for (const r of rings) {
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const [x1, y1] = r[j]
      const [x2, y2] = r[i]
      if (y1 <= y) {
        if (y2 > y && (x2 - x1) * (y - y1) - (x - x1) * (y2 - y1) > 0) w++
      } else if (y2 <= y && (x2 - x1) * (y - y1) - (x - x1) * (y2 - y1) < 0) w--
    }
  }
  return w
}

const shoelace = (r: { x: number; y: number }[] | Ring) => {
  const p = r.map((q) => (Array.isArray(q) ? { x: q[0], y: q[1] } : q))
  let s = 0
  for (let i = 0; i < p.length; i++) s += p[i].x * p[(i + 1) % p.length].y - p[(i + 1) % p.length].x * p[i].y
  return s / 2
}

/** Whether a point is inside an editor polygon group: inside its outer ring and in none of its holes. */
function insideGroup(g: { x: number; y: number }[][], x: number, y: number): boolean {
  const inRing = (r: { x: number; y: number }[]) => winding([r.map((p) => [p.x, p.y] as [number, number])], x, y) !== 0
  return inRing(g[0]) && !g.slice(1).some(inRing)
}

/** The distance from a point to the nearest edge of a set of rings. */
function edgeDistance(rings: Ring[], x: number, y: number): number {
  let d = Infinity
  for (const r of rings) {
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const [x1, y1] = r[j]
      const [x2, y2] = r[i]
      const dx = x2 - x1
      const dy = y2 - y1
      const t = dx || dy ? Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy))) : 0
      d = Math.min(d, Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy)))
    }
  }
  return d
}

/** The area inside a set of rings by the non-zero rule, by scanlines: the length of each line's inside, midpoint rule. */
function scanArea(rings: Ring[], lines: number): number {
  let y0 = Infinity
  let y1 = -Infinity
  for (const r of rings) for (const [, y] of r) (y0 = Math.min(y0, y)), (y1 = Math.max(y1, y))
  if (!(y1 > y0)) return 0
  const h = (y1 - y0) / lines
  const edges: [number, number, number, number][] = []
  for (const r of rings) for (let i = 0, j = r.length - 1; i < r.length; j = i++) if (r[j][1] !== r[i][1]) edges.push([r[j][0], r[j][1], r[i][0], r[i][1]])
  edges.sort((a, b) => Math.min(a[1], a[3]) - Math.min(b[1], b[3]))
  let total = 0
  for (let k = 0; k < lines; k++) {
    const y = y0 + (k + 0.5) * h
    const hits: [number, number][] = []
    for (const [x1, ya, x2, yb] of edges) {
      if (Math.min(ya, yb) > y) break
      if ((ya <= y && yb > y) || (yb <= y && ya > y)) hits.push([x1 + ((y - ya) / (yb - ya)) * (x2 - x1), yb > ya ? 1 : -1])
    }
    hits.sort((a, b) => a[0] - b[0])
    let w = 0
    for (let i = 0; i + 1 < hits.length; i++) {
      w += hits[i][1]
      if (w !== 0) total += (hits[i + 1][0] - hits[i][0]) * h
    }
  }
  return total
}

/** Every `G36` region of a Gerber file by its area in square millimetres (the file's coordinates are whole nanometres). */
function gerberRegionAreas(text: string): number[] {
  const out: number[] = []
  for (const m of text.matchAll(/G36\*([\s\S]*?)G37\*/g)) {
    const pts = [...m[1].matchAll(/X(-?\d+)Y(-?\d+)D0[12]\*/g)].map((p) => [Number(p[1]) / 1e6, Number(p[2]) / 1e6] as [number, number])
    out.push(Math.abs(shoelace(pts)))
  }
  return out
}

describe.skipIf(!CORPUS || !existsSync(CORPUS ?? ""))("X19 over the corpus", () => {
  it("imports, draws, plots, saves and writes every board that needed X19", async () => {
    await loadKicadFont({ cjk: true })
    const files = walk(CORPUS!).sort()
    const rows: Record<string, unknown>[] = []
    const problems: string[] = []
    const total = { boards: 0, imported: 0, refused: new Map<string, number>(), withCache: 0, caches: 0, points: 0, samples: 0, sampleWrong: 0, nearEdge: 0, areaWorst: 0, hausdorffWorst: 0, regions: 0, regionMissing: 0, saveLoadWrong: 0, roundTripWrong: 0, fonts: 0, onlyFlag: 0, bytesWorst: 0 }
    for (const file of files) {
      const text = readFileSync(file, "utf8")
      if (!/\(render_cache|\(embedded_fonts|\(face /.test(text)) continue
      total.boards++
      const name = relative(CORPUS!, file).split("\\").join("/")
      const hasCache = /\(render_cache/.test(text)
      if (!hasCache && !/\(face /.test(text)) total.onlyFlag++
      const r = importKicadBoard(new Uint8Array(readFileSync(file)))
      if (r.status !== "imported") {
        // A refusal is for another extension or the size limit: never for a font.
        total.refused.set(r.reason === "unsupported" ? r.needs.map((n) => n.ext).join("+") : r.reason, (total.refused.get(r.reason === "unsupported" ? r.needs.map((n) => n.ext).join("+") : r.reason) ?? 0) + 1)
        if (/font|outline|X19/i.test(r.message) || r.needs.some((n) => n.ext === "X19")) problems.push(`${name}: refused for a font: ${r.message}`)
        rows.push({ board: name, status: r.status, reason: r.reason, message: r.message.slice(0, 160) })
        continue
      }
      total.imported++
      const p = r.project
      const row: Record<string, unknown> = { board: name, status: "imported", projectBytes: r.bytes }
      total.bytesWorst = Math.max(total.bytesWorst, r.bytes)
      // 1. every text with a cache is drawn from it, and every cache the file has was kept
      const raw = rawCaches(parseSexpr(text) as unknown[])
      const wts = worldTexts(p).filter((t) => t.face !== undefined)
      const outlined = wts.filter((t) => textFontState(p, t) === "outline")
      const others = wts.filter((t) => textFontState(p, t) !== "outline")
      row.rawCaches = raw.length
      row.outlined = outlined.length
      row.notOutlined = others.length
      if (outlined.length !== raw.length) problems.push(`${name}: the file has ${raw.length} caches and ${outlined.length} texts are drawn from one`)
      if (others.length) problems.push(`${name}: ${others.length} text(s) of a named font are not drawn from outlines`)
      if (raw.length) total.withCache++
      total.caches += raw.length
      total.points += raw.reduce((n, t) => n + t.rings.reduce((m, q) => m + q.length, 0), 0)
      // 2. the letters against the file's polygons: points sampled in each text's box
      const rawBy = new Map<string, RawText[]>()
      for (const t of raw) rawBy.set(t.text, [...(rawBy.get(t.text) ?? []), t])
      let samples = 0
      let hausdorffWrong = 0
      let hausdorffWorst = 0
      let wrong = 0
      let near = 0
      let areaWorst = 0
      for (const wt of outlined) {
        // the letters themselves (a knockout's box and a text box's border are not letters)
        const ink = textInk(p, wt)
        const lt = { box: ink.box! }
        const shownRaw = raw.find((q) => q.text === (wt.outline!.text))
        const mine = ink.outlines!
        // the oracle's rings for this text: those of the raw cache with the text's own text and the same first point (cache polygons are unique to a text's place)
        const first = wt.outline!.rings
        void first
        const cands = (rawBy.get(wt.outline!.text) ?? []).filter((q) => q.rings.length)
        const rings = cands.find((q) => {
          if (q.mirror !== !!wt.mirror) return false
          const xs = q.rings.flatMap((rg) => rg.map((pt) => pt[0]))
          const ys = q.rings.flatMap((rg) => rg.map((pt) => -pt[1]))
          return Math.abs(Math.min(...xs) - lt.box.minX) < 1e-6 && Math.abs(Math.max(...xs) - lt.box.maxX) < 1e-6 && Math.abs(Math.min(...ys) - lt.box.minY) < 1e-6 && Math.abs(Math.max(...ys) - lt.box.maxY) < 1e-6
        })?.rings
        if (!rings) {
          if (shownRaw) problems.push(`${name}: no cache of the file matches the box of the text "${wt.outline!.text}"`)
          continue
        }
        // areas: the file's rings integrated by scanlines (the length of every line that is inside by the non-zero rule, midpoint rule on 24000 lines), against the editor's
        // polygons (outlines less holes). Letters may overlap and wind either way, so neither a signed sum nor a nesting depth is an area.
        const oracleArea = scanArea(rings, 24000)
        const myArea = mine.reduce((s, g) => s + Math.abs(shoelace(g[0])) - g.slice(1).reduce((t, h) => t + Math.abs(shoelace(h)), 0), 0)
        areaWorst = Math.max(areaWorst, Math.abs(oracleArea - myArea) / Math.max(oracleArea, 1e-9))
        // Hausdorff, both ways, on up to 300 vertices of each: a vertex of the file is on the editor's boundary or inside its letters (letters that overlap hide vertices), and a vertex
        // of the editor's letters is on an edge of the file's rings (to 2 nm: Clipper rounds where two contours cross to a whole nanometre)
        const mineRings: Ring[] = mine.flatMap((g) => g.map((rg) => rg.map((q) => [q.x, -q.y] as [number, number])))
        const every = (n: number) => Math.max(1, Math.floor(n / 300))
        const rawVerts = rings.flat()
        for (let k = 0; k < rawVerts.length; k += every(rawVerts.length)) {
          const [vx, vy] = rawVerts[k]
          const d = edgeDistance(mineRings, vx, vy)
          if (d > 2e-6 && !mine.some((g) => insideGroup(g, vx, -vy))) {
            hausdorffWrong++
            hausdorffWorst = Math.max(hausdorffWorst, d)
          }
        }
        const myVerts = mineRings.flat()
        for (let k = 0; k < myVerts.length; k += every(myVerts.length)) {
          const d = edgeDistance(rings, myVerts[k][0], myVerts[k][1])
          hausdorffWorst = Math.max(hausdorffWorst, d)
          if (d > 2e-6) hausdorffWrong++
        }
        // samples, in the file's frame
        const w = lt.box.maxX - lt.box.minX
        const h = lt.box.maxY - lt.box.minY
        let seed = 12345
        const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296
        for (let k = 0; k < 400; k++) {
          const x = lt.box.minX + rnd() * w
          const y = lt.box.minY + rnd() * h
          samples++
          const theirs = winding(rings, x, -y) !== 0
          const ours = mine.some((g) => insideGroup(g, x, y))
          if (theirs !== ours) {
            if (edgeDistance(rings, x, -y) < 2e-6) near++
            else wrong++
          }
        }
      }
      row.samples = samples
      row.sampleWrong = wrong
      row.areaWorst = areaWorst
      row.hausdorffWorstMm = hausdorffWorst
      total.hausdorffWorst = Math.max(total.hausdorffWorst, hausdorffWorst)
      if (hausdorffWrong) problems.push(`${name}: ${hausdorffWrong} sampled vertices are further than 2 nm from the other shape's edge (worst ${hausdorffWorst} mm)`)
      total.samples += samples
      total.sampleWrong += wrong
      total.nearEdge += near
      total.areaWorst = Math.max(total.areaWorst, areaWorst)
      if (wrong) problems.push(`${name}: ${wrong} of ${samples} sampled points are inside the file's letters and not the editor's, or the other way`)
      if (areaWorst > 2e-4) problems.push(`${name}: the letters' area differs from the file's by ${areaWorst}`)
      // 3. the Gerber files hold a region of the same area for every polygon of the letters
      const outline = outlineState(p.board)
      const outlineProblem = outline !== "closed"
      try {
        const gerbers = buildFabricationFiles(p)
        if (outlineProblem) problems.push(`${name}: the Gerbers were made for a board whose outline does not close`)
        const pool: number[] = []
        for (const content of Object.values(gerbers)) if (content.includes("%FSLAX46Y46*%")) pool.push(...gerberRegionAreas(content))
        pool.sort((a, b) => a - b)
        let missing = 0
        let expected = 0
        const used = new Set<number>()
        for (const wt of outlined) {
          if (wt.hidden || !wt.placed || wt.knockout) continue
          for (const g of textInk(p, wt).outlines ?? []) {
            expected++
            const a = Math.abs(shoelace(g[0])) - g.slice(1).reduce((s, hh) => s + Math.abs(shoelace(hh)), 0)
            // a region in the pool of that area (to a part in 10^6 and a square micrometre: Gerber rounds each point to a nanometre)
            let found = -1
            for (let i = 0; i < pool.length; i++) {
              if (!used.has(i) && Math.abs(pool[i] - a) <= Math.max(1e-6 * a, 1e-6)) {
                found = i
                break
              }
            }
            if (found < 0) missing++
            else used.add(found)
          }
        }
        row.gerberExpected = expected
        row.gerberMissing = missing
        total.regions += expected
        total.regionMissing += missing
        if (missing) problems.push(`${name}: ${missing} of ${expected} letter polygons have no Gerber region of their area`)
      } catch (e) {
        if (!(outlineProblem && e instanceof OutlineNotClosedError)) problems.push(`${name}: the Gerbers failed: ${e instanceof Error ? e.message : String(e)}`)
        row.gerber = "refused: outline"
      }
      // 4. a save and a load give the same project
      const back = parseProjectFile(serializeProject(p), { id: p.id })
      const keys = ["components", "texts", "graphics", "footprints", "traces", "vias", "labels", "wires", "board", "rules", "properties", "zones", "dimensions", "groups", "images", "fonts"] as const
      const bad = keys.filter((k) => !isDeepStrictEqual(back[k], p[k]))
      row.saveLoad = bad.length ? bad.join(",") : "same"
      if (bad.length) {
        total.saveLoadWrong++
        problems.push(`${name}: ${bad.join(", ")} differ after a save and a load`)
      }
      // 5. the KiCad export read again has the same texts, fonts and outlines
      try {
        const k = await kicadFiles(p)
        const pcb = Object.entries(k.files).find(([key]) => key.endsWith(".kicad_pcb"))![1]
        const un = unknownNodes(pcb)
        if (un.length) problems.push(`${name}: the written board has nodes KiCad 9 does not: ${un.join(", ")}`)
        const again = importKicadBoard(pcb)
        if (again.status !== "imported") {
          problems.push(`${name}: the written board is refused: ${again.message}`)
        } else {
          const diffs = diffProjects(p, again.project).filter((d) => /^project.(texts|fonts)|^project.components[].texts/.test(d.path))
          row.roundTripTextDiffs = diffs.length
          if (diffs.length) {
            total.roundTripWrong++
            problems.push(`${name}: the KiCad export read again differs in its texts: ${diffs.slice(0, 3).map((d) => d.path).join("; ")}`)
          }
        }
      } catch (e) {
        problems.push(`${name}: the KiCad export failed: ${e instanceof Error ? e.message : String(e)}`)
      }
      if (p.fonts?.files.length) total.fonts += p.fonts.files.length
      rows.push(row)
      void rememberImage
    }
    const summary = { ...total, refused: Object.fromEntries(total.refused), problems }
    if (OUT) writeFileSync(OUT, JSON.stringify({ summary, rows }, null, 1))
    expect(total.boards).toBeGreaterThan(100)
    expect(problems).toEqual([])
  }, 3_600_000)
})
