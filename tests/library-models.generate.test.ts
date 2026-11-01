import { writeFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { getFootprint } from "../src/model/footprints"
import { all, first, num, parseSexpr, str, type SNode } from "../src/model/kicad/sexpr"
import { LIBRARY_MODEL_SOURCES, KICAD_LIBRARY_RELEASE, type LibraryModelSource } from "../src/model/libraryModelSources"
import { kicadModel } from "../src/model/models3d"
import { moveModel } from "../src/model/supplier/model"
import type { Model3D, Vec2 } from "../src/model/types"

// Writes `src/model/libraryModels.json`: each built-in part's KiCad model, placed on our footprint;
// and `library-model-pads.json`, where KiCad's pads land on ours, which `library-models.test.ts`
// checks our footprints against without fetching anything.
// It reads KiCad's footprint at the release, puts KiCad's pads on ours number by number (a pad
// numbered the other way round, a diode's cathode, through the source's `pads`), and moves the
// footprint's model with them, as `supplierModelOnLand` does a supplier's. A footprint whose pads
// don't land on ours within `TOLERANCE` gets no model, and the run fails naming it.
//
//   KICAD_FETCH=1 npx vitest run tests/library-models.generate.test.ts   (npm run library-models)

const RUN = process.env.KICAD_FETCH === "1"
const RAW = "https://gitlab.com/kicad/libraries"
/** How far a KiCad pad may land from ours (mm): a land's toe and heel differ between generators, its pitch and rows don't. */
const TOLERANCE = 0.35
const MODEL_DIR = /^\$\{KICAD\d*_3DMODEL_DIR\}\//

type Pad = { number: string; x: number; y: number }

const turn = (p: Vec2, q: number): Vec2 => (q === 1 ? { x: -p.y, y: p.x } : q === 2 ? { x: -p.x, y: -p.y } : q === 3 ? { x: p.y, y: -p.x } : p)
const round = (v: number) => Math.round(v * 1e4) / 1e4
/** The middle of the box around some points: two lands' pads agree on it where their toes don't. */
const centre = (pts: Vec2[]) => {
  const xs = pts.map((p) => p.x)
  const ys = pts.map((p) => p.y)
  return { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 }
}

/** KiCad's copper pads with a number, in our frame (y up). */
function kicadPads(root: SNode[]): Pad[] {
  return all(root, "pad")
    .filter((p) => str(p, 1) && str(p, 2) !== "np_thru_hole")
    .map((p) => {
      const at = first(p, "at")
      return { number: str(p, 1)!, x: num(at, 1), y: -num(at, 2) }
    })
}

/** The worst distance from a pad of `a` to the nearest of `b`. */
const worst = (a: Vec2[], b: Vec2[]) => Math.max(...a.map((p) => Math.min(...b.map((q) => Math.hypot(p.x - q.x, p.y - q.y)))))

/**
 * The quarter turn and move that put KiCad's pads on ours: by the numbers both have once (`numbers`),
 * or by where the pads are (`positions`, for a land numbered another way), then checked pad by pad.
 */
function fit(kicad: Pad[], ours: Pad[], source: LibraryModelSource) {
  const once = (pads: Pad[]) => {
    const counts = new Map<string, number>()
    for (const p of pads) counts.set(p.number, (counts.get(p.number) ?? 0) + 1)
    return new Map(pads.filter((p) => counts.get(p.number) === 1).map((p) => [p.number, p]))
  }
  const a = once(kicad)
  const b = once(ours)
  const pairs = [...a].filter(([k]) => b.has(k)).map(([k, p]) => [p, b.get(k)!] as const)
  const byPosition = source.match === "positions"
  if (!byPosition && pairs.length < 2) return { error: `fewer than two pad numbers in common (ours ${[...b.keys()].join(",")})` }
  if (byPosition && kicad.length !== ours.length) return { error: `${kicad.length} pads against our ${ours.length}` }
  let best: { quarter: number; dx: number; dy: number; miss: number } | null = null
  for (let q = 0; q < 4; q++) {
    const from = byPosition ? kicad.map((p) => turn(p, q)) : pairs.map(([p]) => turn(p, q))
    const to = byPosition ? ours : pairs.map(([, p]) => p)
    const c = centre(from)
    const t = centre(to)
    const dx = t.x - c.x
    const dy = t.y - c.y
    const moved = kicad.map((p) => {
      const r = turn(p, q)
      return { x: r.x + dx, y: r.y + dy }
    })
    const numbered = byPosition ? 0 : Math.max(...pairs.map(([p, o]) => { const r = turn(p, q); return Math.hypot(r.x + dx - o.x, r.y + dy - o.y) }))
    const miss = Math.max(numbered, worst(moved, ours), worst(ours, moved))
    if (!best || miss < best.miss) best = { quarter: q, dx, dy, miss }
  }
  return best!
}

const xyz = (node: SNode[], name: string) => {
  const v = first(first(node, name) ?? [], "xyz")
  return { x: num(v, 1), y: num(v, 2), z: num(v, 3) }
}

async function text(url: string): Promise<string> {
  const r = await fetch(url)
  if (!r.ok) throw new Error(`${r.status} for ${url}`)
  return r.text()
}

async function exists(url: string): Promise<boolean> {
  const r = await fetch(url, { method: "HEAD" })
  return r.ok
}

interface Placed {
  part: string
  footprint: string
  kicad: string
  model: Model3D
  /** KiCad's pads where the model puts them on our footprint, for the test that keeps the two in step. */
  pads: [string, number, number][]
}

async function place(source: LibraryModelSource): Promise<Placed | string> {
  const [lib, name] = source.kicad.split(":")
  const file = await text(`${RAW}/kicad-footprints/-/raw/${KICAD_LIBRARY_RELEASE}/${encodeURIComponent(`${lib}.pretty`)}/${encodeURIComponent(`${name}.kicad_mod`)}`)
  const root = parseSexpr(file).find((n): n is SNode[] => Array.isArray(n) && (n[0] === "footprint" || n[0] === "module"))!
  const refs = all(root, "model").filter((m) => MODEL_DIR.test(str(m, 1) ?? ""))
  if (refs.length !== 1) return `${refs.length} models in the footprint`
  const ref = refs[0]
  const path = str(ref, 1)!.replace(MODEL_DIR, "").replace(/\.wrl$/i, ".step")
  if (!(await exists(`${RAW}/kicad-packages3D/-/raw/${KICAD_LIBRARY_RELEASE}/${path.split("/").map(encodeURIComponent).join("/")}`))) return `no ${path} in KiCad's 3D library`
  const id = `${KICAD_LIBRARY_RELEASE}/${path}`
  const model = kicadModel({ source: "kicad", id, name: path.slice(path.indexOf("/") + 1).replace(/\.[^.]+$/, ""), offset: xyz(ref, "offset"), rotate: xyz(ref, "rotate"), scale: { x: 1, y: 1, z: 1 } })
  if (!model) return "the model is scaled"

  const rename = source.pads ?? {}
  const compared = (p: Pad) => !source.ignore?.includes(p.number)
  const theirs = kicadPads(root)
    .filter(compared)
    .map((p) => ({ ...p, number: rename[p.number] ?? p.number }))
  const ours = getFootprint(source.footprint)
    .pads.filter((p) => p.pin && p.plated !== false)
    .map((p) => ({ number: p.pin!, x: p.x, y: p.y }))
    .filter(compared)
  if (!ours.length) return `no footprint ${source.footprint}`
  const t = fit(theirs, ours, source)
  if ("error" in t) return t.error
  if (t.miss > (source.tolerance ?? TOLERANCE)) return `pads miss by ${t.miss.toFixed(3)} mm`
  const moved = t.quarter === 0 && Math.abs(t.dx) < 1e-4 && Math.abs(t.dy) < 1e-4 ? model : moveModel(model, t)
  const pads = theirs.map((p) => {
    const q = turn(p, t.quarter)
    return [p.number, round(q.x + t.dx), round(q.y + t.dy)] as [string, number, number]
  })
  return { part: source.part, footprint: source.footprint, kicad: source.kicad, model: moved, pads }
}

describe.skipIf(!RUN)("library models from KiCad", () => {
  it("places every source's model on its footprint", async () => {
    const placed: Placed[] = []
    const failed: string[] = []
    for (const source of LIBRARY_MODEL_SOURCES) {
      const got = await place(source)
      if (typeof got === "string") failed.push(`${source.part} on ${source.footprint} (${source.kicad}): ${got}`)
      else placed.push(got)
    }
    // One entry a line, so a change to one reads as one line in a diff.
    const lines = (rows: unknown[]) => rows.map((r) => `  ${JSON.stringify(r)}`).join(",\n")
    writeFileSync(
      new URL("../src/model/libraryModels.json", import.meta.url),
      `{\n "release": "${KICAD_LIBRARY_RELEASE}",\n "models": [\n${lines(placed.map(({ pads: _, ...entry }) => entry))}\n ]\n}\n`,
    )
    writeFileSync(new URL("./library-model-pads.json", import.meta.url), `[\n${lines(placed.map((p) => ({ part: p.part, footprint: p.footprint, pads: p.pads })))}\n]\n`)
    expect(failed).toEqual([])
  })
})
