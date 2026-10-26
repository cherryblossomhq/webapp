import { componentFootprint } from "../src/model/instances"
import { copperLayers, viaLayers } from "../src/model/stack"
import type { Project } from "../src/model/types"
import { arcLength, layersOracle } from "./kicad-census/layers.mjs"

// X1, X4 and X5 of a built project against the oracle's reading of the raw file (`tests/kicad-census/layers.mjs`, which shares no code with `src`): the copper layers (count, names,
// types), the stackup (rows and total thickness), every arc track (count and total length), every via (kind and the two layers it joins), and the pads with a padstack.

export interface LayersCheck {
  /** The file has more than two copper layers, an arc track, a via that is not a through via, or a padstack. */
  uses: boolean
  copper: number
  arcs: number
  partialVias: number
  padstacks: number
  /** What differs, in words; empty when the project has what the file has. */
  wrong: string[]
}

const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(a), Math.abs(b))

export function checkLayers(text: string, project: Project, lossy: string[] = []): LayersCheck {
  const o = layersOracle(text)
  const out: LayersCheck = { uses: false, copper: 0, arcs: 0, partialVias: 0, padstacks: 0, wrong: [] }
  if (!o) return out
  out.copper = o.copper.length
  out.arcs = o.arcs
  out.partialVias = o.vias.filter((v: { kind: string }) => v.kind !== "through").length
  out.padstacks = o.padstacks
  out.uses = o.copper.length > 2 || o.arcs > 0 || out.partialVias > 0 || o.padstacks > 0
  // a board the build could not take exactly is refused, and its project is whatever the forced build made
  if (lossy.length) return out
  const wrong = out.wrong
  const stack = copperLayers(project.board)
  if (o.copper.length >= 2 && stack.length !== o.copper.length) {
    wrong.push(`${stack.length} copper layers, the file has ${o.copper.length}`)
    return out
  }
  if (o.copper.length >= 2) {
    o.copper.forEach((row: { name: string; type: string; label?: string }, i: number) => {
      const own = project.board.stack?.copper[i]
      const type = own?.type ?? "signal"
      if (type !== row.type && !(row.type === "user" && type === "signal")) wrong.push(`layer ${i + 1} is ${type}, the file has ${row.type}`)
    })
  }
  if (o.stackRows > 0) {
    const rows = project.board.stack?.rows ?? []
    if (rows.length !== o.stackRows) wrong.push(`${rows.length} stackup rows, the file has ${o.stackRows}`)
    else {
      const t = rows.reduce((n, r) => n + (r.thickness ?? 0) + (r.sub ?? []).reduce((m, s) => m + (s.thickness ?? 0), 0), 0)
      if (!near(t, o.thickness, 1e-6)) wrong.push(`stackup is ${t} mm thick, the file's is ${o.thickness} mm`)
    }
  }
  // arcs: the count and the total length, by the oracle's own arithmetic on the project's three points
  const arcs = project.traces.filter((t) => t.arc && t.points.length === 3)
  if (arcs.length !== o.arcs) wrong.push(`${arcs.length} arc tracks, the file has ${o.arcs}`)
  else if (arcs.length) {
    const len = arcs.reduce((n, t) => n + arcLength([t.points[0].x, t.points[0].y], [t.points[1].x, t.points[1].y], [t.points[2].x, t.points[2].y]), 0)
    if (!near(len, o.arcLen, 1e-4)) wrong.push(`arc tracks are ${len.toFixed(4)} mm long, the file's are ${o.arcLen.toFixed(4)} mm`)
  }
  // vias: the same multiset of kind and ends (the board's origin is its own, so places are not compared)
  const have = project.vias.map((v) => {
    const span = viaLayers(project.board, v)
    return `${v.kind ?? "through"}|${v.kind ? `${span[0]}>${span[span.length - 1]}` : ""}`
  })
  const want = o.vias.map((v: { key: string }) => {
    const [kind, , ends] = v.key.split("|")
    return `${kind}|${ends}`
  })
  if (have.length !== want.length) wrong.push(`${have.length} vias, the file has ${want.length}`)
  else {
    const a = have.slice().sort()
    const b = want.slice().sort()
    if (!a.every((k: string, i: number) => k === b[i])) wrong.push(`vias differ from the file's in kind or layers, for one ${b.find((k: string, i: number) => k !== a[i])}`)
  }
  // padstacks: pads of the project that carry a stack
  let stacked = 0
  for (const c of project.components) stacked += (componentFootprint(c)?.pads ?? []).filter((p) => p.stack).length
  if (o.padstacks && stacked !== o.padstacks) wrong.push(`${stacked} pads with a padstack, the file has ${o.padstacks}`)
  return out
}
